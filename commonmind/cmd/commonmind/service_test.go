package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/background"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/settings"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/syncer"
)

// A launchctl and a systemctl that only keep notes, written with shell
// builtins alone because the CLI under test runs with nothing else on PATH.
const fakeServiceManagerScript = `#!/bin/sh
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

// serviceLab is a managed Commonmind home whose sync API answers pings, on a
// machine whose only launchctl and systemctl are the fakes above. The CLI runs
// as a subprocess with its own HOME, so no real service or service file is
// within its reach.
type serviceLab struct {
	t                  *testing.T
	ctx                context.Context
	userHome, home     string
	state, servicePath string
	env                []string
}

func newServiceLab(t *testing.T) *serviceLab {
	t.Helper()
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("managed background sync supports macOS and Linux")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	lab := &serviceLab{t: t, ctx: ctx, userHome: t.TempDir(), state: t.TempDir()}
	lab.home = filepath.Join(lab.userHome, ".commonmind")
	bin := filepath.Join(lab.state, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"launchctl", "systemctl"} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(fakeServiceManagerScript), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	lab.env = []string{"HOME=" + lab.userHome, "COMMONMIND_HOME=" + lab.home, "PATH=" + bin, "FAKE_SERVICE_STATE=" + lab.state}

	// `start` waits for the sync API, so something has to answer its ping.
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/rest/system/ping" && r.Header.Get("X-API-Key") == "fixture-key" {
			w.Write([]byte(`{"ping":"pong"}`))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(api.Close)
	if err := os.MkdirAll(lab.home, 0o700); err != nil {
		t.Fatal(err)
	}
	const device = "AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH"
	lab.writeJSON("settings.json", settings.Settings{
		SharedDir: filepath.Join(lab.home, "shared"), Author: "dana@example.invalid",
		Team: "Fixture", FolderID: "commonmind-0123456789abcdef0123456789abcdef", OwnerID: device, Enrolled: true,
	})
	lab.writeJSON("sync.json", syncer.State{
		Client:   syncer.Client{Address: strings.TrimPrefix(api.URL, "http://"), APIKey: "fixture-key"},
		DeviceID: device, Binary: filepath.Join(lab.home, "bin", "syncthing"), Home: filepath.Join(lab.home, "syncthing"),
	})
	return lab
}

func (l *serviceLab) writeJSON(name string, value any) {
	l.t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		l.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(l.home, name), data, 0o600); err != nil {
		l.t.Fatal(err)
	}
}

func (l *serviceLab) run(exe string, args ...string) (string, error) {
	l.t.Helper()
	return runBinary(l.ctx, exe, l.env, args...)
}

// definitionFor is the service a start through exe installs: it names the
// binary itself, whatever path the command was typed with.
func (l *serviceLab) definitionFor(exe string) (string, string) {
	l.t.Helper()
	exe, err := filepath.EvalSymlinks(exe)
	if err != nil {
		l.t.Fatal(err)
	}
	path, definition, err := background.Definition(runtime.GOOS, exe, l.home, l.userHome)
	if err != nil {
		l.t.Fatal(err)
	}
	return path, string(definition)
}

func (l *serviceLab) calls() string {
	l.t.Helper()
	data, err := os.ReadFile(filepath.Join(l.state, "calls"))
	if err != nil && !os.IsNotExist(err) {
		l.t.Fatal(err)
	}
	return string(data)
}

// TestStartAndStopManageTheUserService: `commonmind start` installs and starts
// the login service that runs this binary's daemon, and `commonmind stop`
// stops and removes it. Every other test runs with --no-service.
func TestStartAndStopManageTheUserService(t *testing.T) {
	lab := newServiceLab(t)
	exe := commonmindBinary(t)
	path, definition := lab.definitionFor(exe)

	output, err := lab.run(exe, "start")
	if err != nil || !strings.Contains(output, "running and will start at login") {
		t.Fatalf("start: %v\n%s", err, output)
	}
	if got := mustRead(t, path); got != definition {
		t.Fatalf("the installed service is not this binary's daemon for this home:\n%s", got)
	}
	if !strings.Contains(definition, exe) || !strings.Contains(definition, "daemon") || !strings.Contains(definition, lab.home) {
		t.Fatalf("the service definition does not run `%s daemon` for %s:\n%s", exe, lab.home, definition)
	}
	started, stopped := "systemctl --user enable --now commonmind.service", "systemctl --user disable --now commonmind.service"
	if runtime.GOOS == "darwin" {
		started, stopped = "launchctl bootstrap gui/", "launchctl bootout gui/"
	}
	if calls := lab.calls(); !strings.Contains(calls, started) {
		t.Fatalf("start did not start the service:\n%s", calls)
	}

	if output, err := lab.run(exe, "start"); err != nil {
		t.Fatalf("start on a running service: %v\n%s", err, output)
	}

	output, err = lab.run(exe, "stop")
	if err != nil || !strings.Contains(output, "stopped") {
		t.Fatalf("stop: %v\n%s", err, output)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("stop left the service file behind (stat: %v)", err)
	}
	if calls := lab.calls(); !strings.Contains(calls, stopped) {
		t.Fatalf("stop did not stop the service:\n%s", calls)
	}
	if output, err := lab.run(exe, "stop"); err != nil {
		t.Fatalf("stop when nothing is installed: %v\n%s", err, output)
	}
}

// TestStartAndStopThroughASymlinkedBinary: the service belongs to an
// installation, not to the spelling of the path the command was typed with.
// A user who links ~/.commonmind/bin/commonmind into a directory on PATH must
// still be able to stop and restart the service the installer started.
func TestStartAndStopThroughASymlinkedBinary(t *testing.T) {
	lab := newServiceLab(t)
	exe := commonmindBinary(t)
	link := filepath.Join(t.TempDir(), "commonmind")
	if err := os.Symlink(exe, link); err != nil {
		t.Fatal(err)
	}
	path, _ := lab.definitionFor(exe)

	if output, err := lab.run(exe, "start"); err != nil {
		t.Fatalf("start: %v\n%s", err, output)
	}
	if output, err := lab.run(link, "start"); err != nil {
		t.Errorf("start through a symlink to the same binary refused its own service: %v\n%s", err, output)
	}
	if output, err := lab.run(link, "stop"); err != nil {
		t.Errorf("stop through a symlink to the same binary refused its own service: %v\n%s", err, output)
	} else if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("stop through a symlink left the service file behind (stat: %v)", err)
	}
}
