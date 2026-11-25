package background

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakeServiceManagerScript is a launchctl and a systemctl that only keep notes. Each
// writes its arguments to $FAKE_SERVICE_STATE/calls; launchctl also remembers
// whether the service is loaded, because Install and Stop ask it.
const fakeServiceManagerScript = `#!/bin/sh
# Shell builtins only: the tests run this with nothing else on PATH.
set -eu
state=${FAKE_SERVICE_STATE:?}
name=${0##*/}
printf '%s %s\n' "$name" "$*" >> "$state/calls"
loaded=no
if [ -e "$state/loaded" ]; then read -r loaded < "$state/loaded"; fi
case "$name ${1:-}" in
  'launchctl print') [ "$loaded" = yes ] ;;
  'launchctl bootstrap')
    if [ "$loaded" = yes ]; then echo 'Bootstrap failed: 5: Input/output error' >&2; exit 5; fi
    echo yes > "$state/loaded" ;;
  'launchctl bootout')
    if [ "$loaded" != yes ]; then echo 'Boot-out failed: 3: No such process' >&2; exit 3; fi
    echo no > "$state/loaded" ;;
  systemctl*) ;;
  *) echo "fake service manager: unsupported: $*" >&2; exit 2 ;;
esac
`

// fakeServiceManager makes this test's process find only the fakes: PATH holds
// nothing else, so a real launchctl or systemctl cannot be reached, and HOME is
// a directory of the test's own, so no real service file can be either.
func fakeServiceManager(t *testing.T) (userHome, state string) {
	t.Helper()
	userHome, state = t.TempDir(), t.TempDir()
	bin := filepath.Join(state, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"launchctl", "systemctl"} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(fakeServiceManagerScript), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin)
	t.Setenv("HOME", userHome)
	t.Setenv("FAKE_SERVICE_STATE", state)
	return userHome, state
}

func serviceCalls(t *testing.T, state string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(state, "calls"))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return string(data)
}

func TestInstallAndStopRoundTrip(t *testing.T) {
	userHome, state := fakeServiceManager(t)
	home := filepath.Join(userHome, ".commonmind")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	path, want, err := Definition(runtime.GOOS, exe, home, userHome)
	if err != nil {
		t.Skip(err)
	}

	if err := Install(exe, home); err != nil {
		t.Fatalf("install: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(want) {
		t.Fatalf("service file at %s is not the definition (read: %v)", path, err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("service file mode = %v, %v; want 0600", info.Mode().Perm(), err)
	}
	started := "systemctl --user enable --now commonmind.service"
	stopped := "systemctl --user disable --now commonmind.service"
	if runtime.GOOS == "darwin" {
		started, stopped = "launchctl bootstrap gui/", "launchctl bootout gui/"
	}
	if calls := serviceCalls(t, state); strings.Count(calls, started) != 1 {
		t.Fatalf("install did not start the service exactly once:\n%s", calls)
	}

	// `commonmind start` on a running service is a no-op, not an error.
	if err := Install(exe, home); err != nil {
		t.Fatalf("second install: %v", err)
	}
	// launchd refuses to bootstrap a loaded service; systemd's enable is idempotent.
	starts := 1
	if runtime.GOOS != "darwin" {
		starts = 2
	}
	if calls := serviceCalls(t, state); strings.Count(calls, started) != starts {
		t.Fatalf("a second install made %d start calls; want %d:\n%s", strings.Count(calls, started), starts, calls)
	}

	if err := Stop(home); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("stop left the service file behind (stat: %v)", err)
	}
	if calls := serviceCalls(t, state); strings.Count(calls, stopped) != 1 {
		t.Fatalf("stop did not stop the service exactly once:\n%s", calls)
	}

	// Stopping what is not installed is a no-op, and it can be started again.
	if err := Stop(home); err != nil {
		t.Fatalf("second stop: %v", err)
	}
	if err := Install(exe, home); err != nil {
		t.Fatalf("install after stop: %v", err)
	}
	if calls := serviceCalls(t, state); strings.Count(calls, started) != starts+1 {
		t.Fatalf("install after stop did not start the service:\n%s", calls)
	}
}

// TestInstallAndStopLeaveAnotherInstallationAlone: one user service is
// supported, so a service file that belongs to a different Commonmind home is
// neither overwritten by start nor removed by stop.
func TestInstallAndStopLeaveAnotherInstallationAlone(t *testing.T) {
	userHome, state := fakeServiceManager(t)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	theirs := filepath.Join(userHome, "their-commonmind")
	path, definition, err := Definition(runtime.GOOS, exe, theirs, userHome)
	if err != nil {
		t.Skip(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, definition, 0o600); err != nil {
		t.Fatal(err)
	}

	ours := filepath.Join(userHome, "our-commonmind")
	if err := Install(exe, ours); err == nil || !strings.Contains(err.Error(), "different Commonmind service") {
		t.Fatalf("install over another installation's service: %v", err)
	}
	if err := Stop(ours); err == nil || !strings.Contains(err.Error(), "different installation") {
		t.Fatalf("stop of another installation's service: %v", err)
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != string(definition) {
		t.Fatalf("another installation's service file changed (read: %v)", err)
	}
	if calls := serviceCalls(t, state); calls != "" {
		t.Fatalf("the service manager was called for another installation's service:\n%s", calls)
	}
}

// TestLinuxServiceErrorsReachTheLogUsersAreSentTo: start, status, the README
// and the operations guide all send a user to daemon.log, on both platforms.
// The macOS agent writes it; the Linux unit has to as well.
func TestLinuxServiceErrorsReachTheLogUsersAreSentTo(t *testing.T) {
	_, plist, err := Definition("darwin", "/opt/commonmind/bin/commonmind", "/home/dana/.commonmind", "/home/dana")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(plist), "<key>StandardErrorPath</key><string>/home/dana/.commonmind/daemon.log</string>") {
		t.Fatalf("the macOS agent does not write daemon.log:\n%s", plist)
	}
	_, unit, err := Definition("linux", "/opt/commonmind/bin/commonmind", "/home/dana/.commonmind", "/home/dana")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(unit), "/home/dana/.commonmind/daemon.log") {
		t.Fatalf("the Linux unit sends the daemon's errors to the journal only, never to daemon.log:\n%s", unit)
	}
}

// TestInstallReplacesADefinitionAnEarlierReleaseWrote: the definition's text
// changes between releases. A service file for this binary and this home is
// still this installation's, so start brings it up to date and stop removes
// it; neither may take it for somebody else's.
func TestInstallReplacesADefinitionAnEarlierReleaseWrote(t *testing.T) {
	userHome, _ := fakeServiceManager(t)
	home := filepath.Join(userHome, ".commonmind")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	path, current, err := Definition(runtime.GOOS, exe, home, userHome)
	if err != nil {
		t.Skip(err)
	}
	earlier := strings.Replace(string(current), "<integer>10</integer>", "<integer>5</integer>", 1)
	if runtime.GOOS == "linux" {
		earlier = strings.Replace(string(current), "RestartSec=5\n", "RestartSec=2\n", 1)
	}
	if earlier == string(current) {
		t.Fatal("the fixture is not an earlier form of the definition")
	}
	for _, step := range []struct {
		name string
		run  func() error
		want string
	}{
		{"start", func() error { return Install(exe, home) }, string(current)},
		{"stop", func() error { return Stop(home) }, ""},
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(earlier), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := step.run(); err != nil {
			t.Fatalf("%s refused this installation's own service in its earlier form: %v", step.name, err)
		}
		got, err := os.ReadFile(path)
		if step.want == "" && !os.IsNotExist(err) {
			t.Fatalf("stop left the earlier definition behind (read: %v)", err)
		}
		if step.want != "" && string(got) != step.want {
			t.Fatalf("start did not bring the definition up to date:\n%s", got)
		}
	}
}
