package background

import (
	"encoding/xml"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestServiceDefinitionsPreservePaths(t *testing.T) {
	_, plist, err := Definition("darwin", "/path with spaces/a&b/commonmind", "/a<b", "/Users/example")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct{ XMLName xml.Name }
	if err := xml.Unmarshal(plist, &doc); err != nil {
		t.Fatalf("invalid plist: %v", err)
	}
	if !strings.Contains(string(plist), "a&amp;b") || !strings.Contains(string(plist), "a&lt;b") {
		t.Fatal("plist paths are not escaped")
	}
	_, unit, err := Definition("linux", "/home/a %u $X/bin/commonmind", "/home/$USER/state", "/home/example")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(unit), `ExecStart="/home/a %%u $$X/bin/commonmind" daemon`) {
		t.Fatalf("systemd expands path characters: %s", unit)
	}
	if !strings.Contains(string(unit), `Environment="COMMONMIND_HOME=/home/$USER/state"`) {
		t.Fatal("environment value changed")
	}
	if _, _, err := Definition("windows", "", "", ""); err == nil {
		t.Fatal("unsupported service manager accepted")
	}
}

// TestMacServiceIsNamedUnderOurOwnDomain: a launchd label is a reverse domain
// name, and the plist is named for it. Changing either orphans the service
// every existing install has loaded.
func TestMacServiceIsNamedUnderOurOwnDomain(t *testing.T) {
	path, plist, err := Definition("darwin", "/opt/commonmind/bin/commonmind", "/Users/example/.commonmind", "/Users/example")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(path) != "security.mint.commonmind.plist" || !strings.Contains(string(plist), "<key>Label</key><string>security.mint.commonmind</string>") {
		t.Fatalf("the service is not named security.mint.commonmind: %s\n%s", path, plist)
	}
}

func TestNativeServiceSyntax(t *testing.T) {
	home := t.TempDir()
	path, data, err := Definition(runtime.GOOS, "/usr/bin/true", home, home)
	if err != nil {
		t.Fatal(err)
	}
	path = filepath.Join(home, filepath.Base(path))
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" {
		cmd = exec.Command("plutil", "-lint", path)
	} else {
		cmd = exec.Command("systemd-analyze", "verify", path)
	}
	if _, err := exec.LookPath(cmd.Path); err != nil {
		t.Skip("native service validator is unavailable")
	}
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("service definition rejected: %v %s", err, output)
	}
}
