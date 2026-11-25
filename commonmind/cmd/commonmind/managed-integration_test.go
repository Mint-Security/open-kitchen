package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/settings"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/store"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/syncer"
)

func TestManagedCLIEnrollmentAndPublishing(t *testing.T) {
	for _, mode := range []string{"fresh", "own-folder"} {
		for _, requireVerification := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/verification=%t", mode, requireVerification), func(t *testing.T) { testManagedCLIEnrollment(t, mode == "own-folder", requireVerification) })
		}
	}
}

func testManagedCLIEnrollment(t *testing.T, ownFolder, requireVerification bool) {
	stBinary := os.Getenv("COMMONMIND_TEST_SYNCTHING")
	if stBinary == "" {
		t.Skip("set COMMONMIND_TEST_SYNCTHING to exercise managed CLI and daemon")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	exe := filepath.Join(t.TempDir(), "commonmind")
	if output, err := exec.CommandContext(ctx, "go", "build", "-o", exe, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, output)
	}
	type peer struct {
		home, roots string
		syncer.State
	}
	makePeer := func(name string) peer {
		home := t.TempDir()
		roots := filepath.Join(home, "roots")
		if err := os.MkdirAll(filepath.Join(roots, "project"), 0o700); err != nil {
			t.Fatal(err)
		}
		raw := `{"sessionId":"` + name + `","cwd":"/work/` + name + `","timestamp":"2026-09-21T00:00:00Z","message":"` + name + `-only synthetic content"}` + "\n"
		if err := os.WriteFile(filepath.Join(roots, "project", name+".jsonl"), []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		state, err := syncer.Prepare(ctx, home, stBinary)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(state.Home, "config.xml")
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		config := string(data)
		for _, flag := range []string{"globalAnnounceEnabled", "localAnnounceEnabled", "relaysEnabled", "natEnabled"} {
			config = strings.ReplaceAll(config, "<"+flag+">true</"+flag+">", "<"+flag+">false</"+flag+">")
		}
		config = strings.ReplaceAll(config, "tcp://0.0.0.0:0", "tcp://127.0.0.1:0")
		config = strings.ReplaceAll(config, "<listenAddress>quic://0.0.0.0:0</listenAddress>", "")
		config = strings.ReplaceAll(config, "<listenAddress>dynamic+https://relays.syncthing.net/endpoint</listenAddress>", "")
		if err := os.WriteFile(path, []byte(config), 0o600); err != nil {
			t.Fatal(err)
		}
		return peer{home, roots, state}
	}
	clientBin := t.TempDir()
	fakeClient(t, clientBin, "codex", "echo 'exec: codex: not found' >&2\nexit 127\n")
	runCLI := func(p peer, args ...string) string {
		t.Helper()
		cmd := exec.CommandContext(ctx, exe, args...)
		cmd.Env = append(os.Environ(), "COMMONMIND_HOME="+p.home, "PATH="+clientBin)
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%v: %v %s", args, err, output)
		}
		return string(output)
	}
	wait := func(description string, condition func() bool) {
		t.Helper()
		for !condition() {
			select {
			case <-ctx.Done():
				t.Fatalf("timed out: %s", description)
			case <-time.After(200 * time.Millisecond):
			}
		}
	}
	start := func(p peer) string {
		cmd := exec.CommandContext(ctx, exe, "daemon")
		cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
		cmd.WaitDelay = 10 * time.Second
		cmd.Env = append(os.Environ(), "COMMONMIND_HOME="+p.home)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_ = cmd.Process.Signal(syscall.SIGTERM)
			_ = cmd.Wait()
			if t.Failed() {
				t.Log(stderr.String())
			}
		})
		wait("daemon API", func() bool { return p.Ping(ctx) == nil })
		var state struct {
			Listeners map[string]struct {
				Addresses []string `json:"lanAddresses"`
			} `json:"connectionServiceStatus"`
		}
		if err := p.Request(ctx, "GET", "system/status", nil, &state); err != nil {
			t.Fatal(err)
		}
		for _, listener := range state.Listeners {
			for _, a := range listener.Addresses {
				if strings.HasPrefix(a, "tcp://127.0.0.1:") && !strings.HasSuffix(a, ":0") {
					return a
				}
			}
		}
		t.Fatal("no loopback listener")
		return ""
	}
	readSettings := func(p peer) settings.Settings {
		var s settings.Settings
		data, err := os.ReadFile(filepath.Join(p.home, "settings.json"))
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	owner, joiner := makePeer("owner"), makePeer("joiner")
	saved := map[string]settings.Settings{}
	ledgers := map[string][]byte{}
	if ownFolder {
		for _, p := range []peer{owner, joiner} {
			shared := filepath.Join(p.home, "own folder")
			runCLI(p, "init", "--shared", shared, "--roots", p.roots, "--author", filepath.Base(p.roots)+"-own", "--exclude", "/private/*")
			runCLI(p, "flush")
			saved[p.home] = readSettings(p)
			data, err := os.ReadFile(filepath.Join(p.home, ledgerFile))
			if err != nil {
				t.Fatal(err)
			}
			ledgers[p.home] = data
			if err := os.WriteFile(filepath.Join(shared, ".stignore"), []byte("#escape=|\n// Custom excludes\n/private/**\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	assertKept := func(p peer) {
		t.Helper()
		if !ownFolder {
			return
		}
		before, after := saved[p.home], readSettings(p)
		if after.SharedDir != before.SharedDir || after.Author != before.Author || !reflect.DeepEqual(after.Roots, before.Roots) || !reflect.DeepEqual(after.Exclude, before.Exclude) {
			t.Fatalf("lost saved preferences: before=%+v after=%+v", before, after)
		}
		data, err := os.ReadFile(filepath.Join(p.home, ledgerFile))
		if err != nil || !bytes.Equal(data, ledgers[p.home]) {
			t.Fatal("the publication ledger changed")
		}
		if count, err := store.New(after.SharedDir).Count(); err != nil || count != 1 {
			t.Fatalf("lost a published session: %d %v", count, err)
		}
		ignore, err := os.ReadFile(filepath.Join(after.SharedDir, ".stignore"))
		if err != nil || !strings.HasPrefix(string(ignore), "#escape=|") || !strings.Contains(string(ignore), "/private/**") || !strings.Contains(string(ignore), "/.commonmind-tmp") {
			t.Fatalf("lost ignore patterns: %s %v", ignore, err)
		}
	}
	if ownFolder {
		runCLI(owner, "init", "--team", "Fixture", "--clients", "none", "--no-service")
	} else {
		runCLI(owner, "init", "--team", "Fixture", "--clients", "none", "--no-service", "--roots", owner.roots, "--author", "owner")
	}
	assertKept(owner)
	ownerSettings := readSettings(owner)
	runCLI(owner, "init", "--team", "Fixture", "--clients", "none", "--no-service")
	if !reflect.DeepEqual(ownerSettings, readSettings(owner)) {
		t.Fatal("repeated init changed the team")
	}
	assertKept(owner)
	ownerAddress := start(owner)
	output := runCLI(owner, "invite", "--no-wait", fmt.Sprintf("--require-verification=%t", requireVerification))
	var token string
	for _, field := range strings.Fields(output) {
		if strings.HasPrefix(field, "cm2_") {
			token = field
			break
		}
	}
	if token == "" {
		t.Fatalf("no invite: %s", output)
	}
	if ownFolder {
		output = runCLI(joiner, "join", "--clients", "codex", "--no-service", token)
	} else {
		output = runCLI(joiner, "join", "--clients", "codex", "--no-service", "--roots", joiner.roots, "--author", "joiner", token)
	}
	if !strings.Contains(output, "codex CLI unavailable") || !strings.Contains(output, "Team setup is saved") {
		t.Fatalf("missing recoverable integration warning: %s", output)
	}
	if strings.Contains(output, "SEND THIS VERIFICATION CODE") != requireVerification {
		t.Fatalf("wrong verification mode: %s", output)
	}
	assertKept(joiner)
	joinSettings := readSettings(joiner)
	if ownFolder {
		output = runCLI(owner, "invite", "--no-wait")
		for _, field := range strings.Fields(output) {
			if strings.HasPrefix(field, "cm2_") {
				token = field
				break
			}
		}
	}
	runCLI(joiner, "join", "--clients", "none", "--no-service", token)
	if !reflect.DeepEqual(joinSettings, readSettings(joiner)) {
		t.Fatal("repeated join changed the team")
	}
	assertKept(joiner)
	start(joiner)
	if err := joiner.Request(ctx, "PATCH", "config/devices/"+owner.DeviceID, map[string]any{"addresses": []string{ownerAddress}}, nil); err != nil {
		t.Fatal(err)
	}
	s := readSettings(owner)
	if requireVerification {
		wait("pending join", func() bool { pending, _ := owner.Pending(ctx); _, ok := pending[joiner.DeviceID]; return ok })
		expectedCount := 0
		if ownFolder {
			expectedCount = 1
		}
		if count, err := store.New(readSettings(joiner).SharedDir).Count(); err != nil || count != expectedCount {
			t.Fatalf("published before approval: %d %v", count, err)
		}
		if readSettings(joiner).Enrolled {
			t.Fatal("enrolled before approval")
		}
		code := syncer.VerificationCode(s.FolderID, s.OwnerID, joiner.DeviceID)
		pending, err := owner.Pending(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := approveDevices(ctx, owner.home, owner.Client, s, pending, strings.NewReader(code+"\n"), io.Discard); err != nil {
			t.Fatal(err)
		}
	}
	wait("enrollment", func() bool { return readSettings(joiner).Enrolled })
	wait("published session replicated to owner", func() bool {
		hits, _ := store.New(s.SharedDir).Search(store.Query{Text: "joiner-only", Limit: 20})
		return len(hits) == 1
	})
	if output := runCLI(joiner, "status"); !strings.Contains(output, "enrolled: true") || !strings.Contains(output, "1 teammates connected") {
		t.Fatalf("status: %s", output)
	}
	if output := runCLI(joiner, "join", "--clients", "none", "--no-service", token); !strings.Contains(output, "Already joined") || strings.Contains(output, "SEND THIS VERIFICATION CODE") {
		t.Fatalf("repeat join requested verification: %s", output)
	}
	before := readSettings(joiner)
	if output := runCLI(joiner, "join", "--clients", "none", "--no-service", "--author", "someone-else", token); !strings.Contains(output, "Ignoring --author") || !strings.Contains(output, before.Author) || !reflect.DeepEqual(before, readSettings(joiner)) {
		t.Fatalf("repeat join with a different author did not warn or changed settings: %s", output)
	}
	if !ownFolder && !requireVerification {
		another := makePeer("another")
		runCLI(another, "join", "--clients", "none", "--no-service", "--roots", another.roots, "--author", "another", token)
		start(another)
		if err := another.Request(ctx, "PATCH", "config/devices/"+owner.DeviceID, map[string]any{"addresses": []string{ownerAddress}}, nil); err != nil {
			t.Fatal(err)
		}
		wait("second device using the same invite", func() bool { return readSettings(another).Enrolled })
		wait("second device published session", func() bool {
			hits, _ := store.New(s.SharedDir).Search(store.Query{Text: "another-only", Limit: 20})
			return len(hits) == 1
		})
	}
	duplicate := exec.CommandContext(ctx, exe, "daemon")
	duplicate.Env = append(os.Environ(), "COMMONMIND_HOME="+owner.home)
	if output, err := duplicate.CombinedOutput(); err == nil || !strings.Contains(string(output), "already running") {
		t.Fatalf("duplicate daemon: %v %s", err, output)
	}
}
