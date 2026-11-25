package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/settings"
)

func fakeClient(t *testing.T, dir, name, script string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func setupClientTest(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("COMMONMIND_HOME", home)
	if err := settings.Save(settings.Settings{SharedDir: filepath.Join(home, "shared"), Author: "fixture"}); err != nil {
		t.Fatal(err)
	}
	return home
}

const workingClient = `case "$*" in
 --version) echo 'fixture 1.0'; exit 0 ;;
 'mcp get commonmind') exit 1 ;;
 'mcp add commonmind'*) printf '%s\n' "$@" > "$COMMONMIND_HOME/registered"; exit 0 ;;
 *) exit 2 ;;
esac
`

func TestConnectSkipsBrokenLauncherAndUsesWorkingCLI(t *testing.T) {
	home := setupClientTest(t)
	shims, real := t.TempDir(), t.TempDir()
	fakeClient(t, shims, "codex", "echo 'exec: codex: not found' >&2\nexit 127\n")
	fakeClient(t, real, "codex", workingClient)
	t.Setenv("PATH", shims+string(os.PathListSeparator)+real)
	var out strings.Builder
	if err := connectClients(context.Background(), "codex", &out); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(home, "registered"))
	if err != nil || !strings.Contains(string(data), "COMMONMIND_HOME="+home) || !strings.Contains(out.String(), "Connected codex") {
		t.Fatalf("registration failed: %s %v %s", data, err, out.String())
	}
}

func TestSetupSurvivesBrokenLauncherAndConnectReportsIt(t *testing.T) {
	setupClientTest(t)
	bin := t.TempDir()
	fakeClient(t, bin, "codex", "echo 'exec: codex: not found' >&2\nexit 127\n")
	t.Setenv("PATH", bin)
	var out strings.Builder
	if err := finishSetup(context.Background(), "auto", true, &out); err != nil {
		t.Fatalf("optional integration aborted setup: %v", err)
	}
	for _, want := range []string{"Warning:", "codex CLI unavailable", "commonmind connect codex", "Team setup is saved"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %q in %s", want, out.String())
		}
	}
	if err := cmdConnect(context.Background(), []string{"codex"}, &out); err == nil || !strings.Contains(err.Error(), "exit status 127") {
		t.Fatalf("explicit connect hid failure: %v", err)
	}
}

func TestConnectAttemptsOtherClientsAfterRegistrationFailure(t *testing.T) {
	home := setupClientTest(t)
	bin := t.TempDir()
	fakeClient(t, bin, "claude", "if [ \"$1\" = --version ]; then exit 0; fi\necho 'registration failed' >&2\nexit 1\n")
	fakeClient(t, bin, "codex", workingClient)
	t.Setenv("PATH", bin)
	var out strings.Builder
	err := connectClients(context.Background(), "auto", &out)
	if err == nil || !strings.Contains(err.Error(), "register claude MCP") {
		t.Fatalf("missing failure: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, "registered")); err != nil {
		t.Fatal("failed to register second client")
	}
}

func TestConnectPreservesExistingRegistration(t *testing.T) {
	setupClientTest(t)
	bin := t.TempDir()
	fakeClient(t, bin, "codex", "case \"$*\" in --version|'mcp get commonmind') exit 0;; *) echo 'must not add' >&2; exit 99;; esac\n")
	t.Setenv("PATH", bin)
	var out strings.Builder
	if err := connectClients(context.Background(), "auto", &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "existing configuration preserved") {
		t.Fatal(out.String())
	}
}
