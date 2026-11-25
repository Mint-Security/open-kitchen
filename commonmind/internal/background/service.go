package background

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
)

const label = "security.mint.commonmind"

func xmlText(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func unitText(s string) string {
	return strconv.Quote(strings.ReplaceAll(s, "%", "%%"))
}

// program and environment are the two parts of a definition that say whose
// service it is: the binary it runs, and the Commonmind home it runs for.
// Definition writes them and owns looks for them, so the two cannot drift.
func program(goos, exe string) string {
	if goos == "darwin" {
		return fmt.Sprintf("<key>ProgramArguments</key><array><string>%s</string><string>daemon</string></array>\n", xmlText(exe))
	}
	return fmt.Sprintf("ExecStart=%s daemon\n", unitText(strings.ReplaceAll(exe, "$", "$$")))
}

func environment(goos, home string) string {
	if goos == "darwin" {
		return fmt.Sprintf("<key>COMMONMIND_HOME</key><string>%s</string>", xmlText(home))
	}
	return fmt.Sprintf("Environment=%s\n", unitText("COMMONMIND_HOME="+home))
}

func Definition(goos, exe, home, userHome string) (string, []byte, error) {
	log := filepath.Join(home, "daemon.log")
	switch goos {
	case "darwin":
		path := filepath.Join(userHome, "Library", "LaunchAgents", label+".plist")
		body := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>%s</string>
%s<key>EnvironmentVariables</key><dict>%s<key>HOME</key><string>%s</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>%s</string>
</dict></plist>
`, label, program(goos, exe), environment(goos, home), xmlText(userHome), xmlText(log))
		return path, []byte(body), nil
	case "linux":
		path := filepath.Join(userHome, ".config", "systemd", "user", "commonmind.service")
		// The daemon's errors go where the macOS agent sends them, and where
		// start, status and the docs send the user to look. systemd expands
		// specifiers in this path and takes the rest of the line as it is.
		body := fmt.Sprintf(`[Unit]
Description=Commonmind session publishing and sync
After=network-online.target

[Service]
%s%sEnvironment=%s
StandardError=append:%s
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
`, program(goos, exe), environment(goos, home), unitText("HOME="+userHome), strings.ReplaceAll(log, "%", "%%"))
		return path, []byte(body), nil
	default:
		return "", nil, fmt.Errorf("managed background sync supports macOS and Linux; use shared-folder mode on %s", goos)
	}
}

// Executable is the path a service definition names for this binary: the file
// itself, however the command that started it was spelled.
func Executable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		return resolved, nil
	}
	return exe, nil
}

// spellings lists the paths a definition may name this binary by: the one
// given, the one this process was started as, and what each resolves to.
func spellings(exe string) []string {
	candidates := []string{exe}
	if started, err := os.Executable(); err == nil {
		candidates = append(candidates, started)
	}
	var paths []string
	for _, candidate := range candidates {
		for _, path := range []string{candidate, resolve(candidate)} {
			if path != "" && !slices.Contains(paths, path) {
				paths = append(paths, path)
			}
		}
	}
	return paths
}

func resolve(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return ""
	}
	return resolved
}

// owns reports whether data is a service definition for this binary and this
// home. It goes by what the definition runs, not by its exact bytes: the same
// installation reached through a symlink, or a definition an earlier release
// wrote in a slightly different form, is still ours to start, stop and replace.
func owns(goos string, data []byte, exe, home string) bool {
	if !bytes.Contains(data, []byte(environment(goos, home))) {
		return false
	}
	for _, path := range spellings(exe) {
		if bytes.Contains(data, []byte(program(goos, path))) {
			return true
		}
	}
	return false
}

func Install(exe, home string) error {
	userHome, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	path, data, err := Definition(runtime.GOOS, exe, home, userHome)
	if err != nil {
		return err
	}
	existing, readErr := os.ReadFile(path)
	if readErr == nil && !owns(runtime.GOOS, existing, exe, home) {
		return fmt.Errorf("a different Commonmind service exists at %s; stop that installation first", path)
	}
	if readErr != nil || !bytes.Equal(existing, data) {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			return err
		}
	}
	if runtime.GOOS == "darwin" {
		domain := fmt.Sprintf("gui/%d", os.Getuid())
		if exec.Command("launchctl", "print", domain+"/"+label).Run() == nil {
			return nil
		}
		return command("launchctl", "bootstrap", domain, path)
	}
	if err := command("systemctl", "--user", "daemon-reload"); err != nil {
		return err
	}
	return command("systemctl", "--user", "enable", "--now", "commonmind.service")
}

func Stop(home string) error {
	userHome, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	path, _, err := Definition(runtime.GOOS, exe, home, userHome)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !owns(runtime.GOOS, data, exe, home) {
		return fmt.Errorf("service at %s belongs to a different installation", path)
	}
	if runtime.GOOS == "darwin" {
		domain := fmt.Sprintf("gui/%d", os.Getuid())
		if exec.Command("launchctl", "print", domain+"/"+label).Run() == nil {
			if err := command("launchctl", "bootout", domain, path); err != nil {
				return err
			}
		}
	} else {
		if err := command("systemctl", "--user", "disable", "--now", "commonmind.service"); err != nil {
			return err
		}
	}
	return os.Remove(path)
}

func command(name string, args ...string) error {
	output, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %w: %s (use commonmind daemon in the foreground if no user service manager is available)", name, err, output)
	}
	return nil
}
