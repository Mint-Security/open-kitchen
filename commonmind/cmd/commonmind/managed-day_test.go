package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/settings"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/store"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/syncer"
)

// managedLab runs several Commonmind machines on this one: each has its own
// user home and Commonmind home, the built CLI, a real `commonmind daemon`, and
// a real Syncthing kept on loopback with discovery and relays off.
type managedLab struct {
	t        *testing.T
	ctx      context.Context
	exe      string
	syncBin  string
	machines []*machine
}

type machine struct {
	lab      *managedLab
	name     string
	userHome string
	home     string
	env      []string
	syncer.State
	daemon *daemonProcess
}

type daemonProcess struct {
	cmd    *exec.Cmd
	stderr bytes.Buffer
	exited chan struct{}
	err    error
}

func newManagedLab(t *testing.T, timeout time.Duration) *managedLab {
	t.Helper()
	syncBin := os.Getenv("COMMONMIND_TEST_SYNCTHING")
	if syncBin == "" {
		t.Skip("set COMMONMIND_TEST_SYNCTHING to run Commonmind's daemon against a real Syncthing")
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	t.Cleanup(cancel)
	return &managedLab{t: t, ctx: ctx, exe: commonmindBinary(t), syncBin: syncBin}
}

// machine creates one machine and its sync identity, the way the first
// `init --team` or `join` would, then pins that Syncthing to loopback.
func (l *managedLab) machine(name string) *machine {
	l.t.Helper()
	userHome := l.t.TempDir()
	m := &machine{lab: l, name: name, userHome: userHome, home: filepath.Join(userHome, ".commonmind")}
	m.env = labEnv(m.userHome, m.home)
	if err := os.MkdirAll(m.home, 0o700); err != nil {
		l.t.Fatal(err)
	}
	state, err := syncer.Prepare(l.ctx, m.home, l.syncBin)
	if err != nil {
		l.t.Fatal(err)
	}
	m.State = state
	path := filepath.Join(state.Home, "config.xml")
	config := mustRead(l.t, path)
	for _, flag := range []string{"globalAnnounceEnabled", "localAnnounceEnabled", "relaysEnabled", "natEnabled"} {
		config = strings.ReplaceAll(config, "<"+flag+">true</"+flag+">", "<"+flag+">false</"+flag+">")
	}
	config = strings.ReplaceAll(config, "tcp://0.0.0.0:0", "tcp://127.0.0.1:0")
	config = strings.ReplaceAll(config, "<listenAddress>quic://0.0.0.0:0</listenAddress>", "")
	config = strings.ReplaceAll(config, "<listenAddress>dynamic+https://relays.syncthing.net/endpoint</listenAddress>", "")
	if err := os.WriteFile(path, []byte(config), 0o600); err != nil {
		l.t.Fatal(err)
	}
	l.machines = append(l.machines, m)
	l.t.Cleanup(func() {
		if m.daemon != nil {
			m.stopDaemon()
		}
	})
	return m
}

func (m *machine) cli(args ...string) string {
	m.lab.t.Helper()
	output, err := runBinary(m.lab.ctx, m.lab.exe, m.env, args...)
	if err != nil {
		m.lab.t.Fatalf("%s: commonmind %v: %v\n%s", m.name, args, err, output)
	}
	return output
}

func (m *machine) settings() settings.Settings {
	m.lab.t.Helper()
	var s settings.Settings
	if err := json.Unmarshal([]byte(mustRead(m.lab.t, filepath.Join(m.home, "settings.json"))), &s); err != nil {
		m.lab.t.Fatal(err)
	}
	return s
}

func (m *machine) shared() *store.Store { return store.New(m.settings().SharedDir) }

// launchDaemon starts `commonmind daemon` without waiting for it.
func (m *machine) launchDaemon() *daemonProcess {
	m.lab.t.Helper()
	d := &daemonProcess{exited: make(chan struct{})}
	d.cmd = exec.Command(m.lab.exe, "daemon")
	d.cmd.Env = m.env
	d.cmd.Stderr = &d.stderr
	if err := d.cmd.Start(); err != nil {
		m.lab.t.Fatal(err)
	}
	go func() { d.err = d.cmd.Wait(); close(d.exited) }()
	m.daemon = d
	return d
}

// refresh re-reads sync.json, as every CLI command does. The daemon moves its
// sync API to another port when the saved one is taken, which a Syncthing child
// still shutting down from the previous run can cause.
func (m *machine) refresh() {
	if state, err := syncer.Load(m.home); err == nil {
		m.State = state
	}
}

// startDaemon starts the daemon, waits for its sync API and returns the
// loopback address its Syncthing listens on, which changes at every start.
func (m *machine) startDaemon() string {
	m.lab.t.Helper()
	d := m.launchDaemon()
	m.lab.wait(m.name+"'s daemon to answer", func() bool {
		select {
		case <-d.exited:
			m.lab.t.Fatalf("%s's daemon exited: %v\n%s", m.name, d.err, d.stderr.String())
		default:
		}
		m.refresh()
		return m.Ping(m.lab.ctx) == nil
	})
	var address string
	var last string
	m.lab.t.Cleanup(func() {
		if address == "" {
			m.lab.t.Logf("%s: no loopback sync listener; last look at system/status on %s: %s", m.name, m.Address, last)
		}
	})
	m.lab.wait(m.name+"'s sync listener", func() bool {
		select {
		case <-d.exited:
			m.lab.t.Fatalf("%s's daemon exited: %v\n%s", m.name, d.err, d.stderr.String())
		default:
		}
		m.refresh()
		var status struct {
			Listeners map[string]struct {
				Error     *string  `json:"error"`
				Addresses []string `json:"lanAddresses"`
			} `json:"connectionServiceStatus"`
		}
		if err := m.Request(m.lab.ctx, "GET", "system/status", nil, &status); err != nil {
			last = err.Error()
			return false
		}
		last = fmt.Sprintf("%+v", status.Listeners)
		for _, listener := range status.Listeners {
			for _, candidate := range listener.Addresses {
				if strings.HasPrefix(candidate, "tcp://127.0.0.1:") && !strings.HasSuffix(candidate, ":0") {
					address = candidate
					return true
				}
			}
		}
		return false
	})
	return address
}

func (m *machine) stopDaemon() {
	d := m.daemon
	if d == nil {
		return
	}
	m.daemon = nil
	_ = d.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-d.exited:
	case <-time.After(20 * time.Second):
		_ = d.cmd.Process.Kill()
		<-d.exited
	}
	if m.lab.t.Failed() {
		m.lab.t.Logf("%s daemon stderr:\n%s", m.name, d.stderr.String())
	}
}

// reach tells m where to find peer, standing in for the discovery this lab
// keeps off.
func (m *machine) reach(peer *machine, address string) {
	m.lab.t.Helper()
	if err := m.Request(m.lab.ctx, "PATCH", "config/devices/"+peer.DeviceID, map[string]any{"addresses": []string{address}}, nil); err != nil {
		m.lab.t.Fatal(err)
	}
}

func (m *machine) lastPublishAttempt() time.Time {
	var report struct {
		LastAttempt time.Time `json:"last_attempt"`
		Error       string    `json:"error"`
	}
	data, err := os.ReadFile(filepath.Join(m.home, "publish-status.json"))
	if err != nil || json.Unmarshal(data, &report) != nil {
		return time.Time{}
	}
	if report.Error != "" {
		m.lab.t.Fatalf("%s's daemon reported a publish error: %s", m.name, report.Error)
	}
	return report.LastAttempt
}

func (l *managedLab) wait(description string, condition func() bool) {
	l.t.Helper()
	for !condition() {
		select {
		case <-l.ctx.Done():
			l.t.Fatalf("timed out waiting for %s", description)
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// TestManagedCLIDayInTheLife follows two teammates through an ordinary day,
// with nothing stubbed between an agent writing a transcript on one machine
// and another agent reading it on the other: real transcripts' shapes and
// sizes, the daemon's own publishing schedule, real Syncthing, and
// `commonmind mcp` over stdio.
//
// It takes two to three minutes, most of it waiting for the daemon's
// once-a-minute publish.
func TestManagedCLIDayInTheLife(t *testing.T) {
	lab := newManagedLab(t, 6*time.Minute)
	t.Parallel()
	dana, sam := lab.machine("dana"), lab.machine("sam")
	start := time.Now().Add(-3 * time.Hour)

	// Dana's morning, before Commonmind is set up: a long Claude Code session
	// in a repository, a Codex session, a session she resumed (one session id,
	// two transcript files), one that is still running, and three that must
	// never leave her machine or cannot.
	claudeRoot := filepath.Join(dana.userHome, ".claude", "projects")
	codexRoot := filepath.Join(dana.userHome, ".codex", "sessions")
	work := filepath.Join(dana.userHome, "work")
	for _, dir := range []string{"ingress/.git", "api", "private-acme", "quiet/deep"} {
		if err := os.MkdirAll(filepath.Join(work, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(work, "quiet", ".commonmind-ignore"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	const (
		longID    = "5b0c7f1e-2a4d-4c8e-9f10-3d2e1a0b9c8d"
		liveID    = "7d1e9a3c-5f6b-4a2d-8c7e-1f0a9b8c7d6e"
		resumedID = "2f4a6c8e-1b3d-4f5a-9c7e-0a2b4c6d8e0f"
		forkID    = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b"
		codexID   = "0198e3c1-abcd-4ef0-9a12-abcdef123456"
		laterID   = "4c2e0a8f-6d4b-4a29-8f7e-5d3c1b9a7f5e"
	)
	ingress := filepath.Join(work, "ingress")
	long := claudeTranscript(longID, ingress, "kestrel-ingress", start, 0, 120, 4<<10) +
		claudeTranscript(longID, ingress, "kestrel-ingress", start, 120, 1, 1500<<10) +
		claudeTranscript(longID, ingress, "kestrel-ingress", start, 121, 120, 4<<10)
	longFile := writeTranscript(t, claudePath(claudeRoot, "-work-ingress", longID), long)
	liveFile := writeTranscript(t, claudePath(claudeRoot, "-work-ingress", liveID), claudeTranscript(liveID, ingress, "heron-live", start.Add(time.Hour), 0, 4, 2<<10))
	writeTranscript(t, claudePath(claudeRoot, "-work-ingress", resumedID), claudeTranscript(resumedID, ingress, "wagtail-original", start, 0, 3, 1<<10))
	writeTranscript(t, claudePath(claudeRoot, "-work-ingress", forkID), claudeTranscript(resumedID, ingress, "wagtail-resumed", start.Add(30*time.Minute), 0, 3, 1<<10))
	api := filepath.Join(work, "api")
	codexFile := writeTranscript(t, codexPath(codexRoot, codexID, start), codexTranscript(codexID, api, "osprey-api", start, 0, 10))
	writeTranscript(t, claudePath(claudeRoot, "-work-private-acme", "11111111-aaaa-4bbb-8ccc-000000000001"),
		claudeTranscript("11111111-aaaa-4bbb-8ccc-000000000001", filepath.Join(work, "private-acme"), "magpie-excluded-by-pattern", start, 0, 2, 1<<10))
	writeTranscript(t, claudePath(claudeRoot, "-work-quiet-deep", "11111111-aaaa-4bbb-8ccc-000000000002"),
		claudeTranscript("11111111-aaaa-4bbb-8ccc-000000000002", filepath.Join(work, "quiet", "deep"), "magpie-excluded-by-ignore-file", start, 0, 2, 1<<10))
	writeTranscript(t, claudePath(claudeRoot, "-work-ingress", "11111111-aaaa-4bbb-8ccc-000000000003"), "\n")

	// Sam has one session of his own.
	const samID = "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d"
	samRoot := filepath.Join(sam.userHome, ".claude", "projects")
	writeTranscript(t, claudePath(samRoot, "-work-billing", samID), claudeTranscript(samID, filepath.Join(sam.userHome, "work", "billing"), "wren-billing", start, 0, 5, 2<<10))

	// Dana creates the team; Sam joins with her invite.
	dana.cli("init", "--team", "Lab", "--clients", "none", "--no-service", "--author", "dana@example.invalid",
		"--syncthing", lab.syncBin, "--exclude", filepath.Join(work, "private-*"))
	danaAddress := dana.startDaemon()
	var invite string
	for _, field := range strings.Fields(dana.cli("invite", "--no-wait")) {
		if strings.HasPrefix(field, "cm2_") {
			invite = field
			break
		}
	}
	if invite == "" {
		t.Fatal("no invite was printed")
	}
	sam.cli("join", "--clients", "none", "--no-service", "--author", "sam@example.invalid", "--syncthing", lab.syncBin, invite)
	samAddress := sam.startDaemon()
	sam.reach(dana, danaAddress)
	lab.wait("Sam's enrollment", func() bool { return sam.settings().Enrolled })

	// Each agent talks to its own machine's `commonmind mcp`.
	samAgent := startMCP(t, lab.ctx, lab.exe, sam.env)
	danaAgent := startMCP(t, lab.ctx, lab.exe, dana.env)
	lab.wait("Dana's five sessions and Sam's one to reach both machines", func() bool {
		for _, agent := range []*mcpClient{samAgent, danaAgent} {
			authors := agent.authors()
			if authors["dana@example.invalid"] != 5 || authors["sam@example.invalid"] != 1 {
				return false
			}
		}
		return true
	})
	if status := dana.cli("status"); !strings.Contains(status, "yield no usable records (skipped): 1") || !strings.Contains(status, "enrolled: true") {
		t.Fatalf("dana's status:\n%s", status)
	}

	// Sam's agent finds Dana's work by what was said, and reads all of it.
	hits := samAgent.search(map[string]any{"query": "kestrel-ingress path time out", "exclude_author": "sam"})
	if len(hits) != 1 || hits[0].SessionID != longID {
		t.Fatalf("search for Dana's long session = %+v", hits)
	}
	if hit := hits[0]; hit.Author != "dana@example.invalid" || hit.Agent != "claude" || hit.Repo != "ingress" || hit.CWD != ingress || hit.AgentVersion != "2.1.291" {
		t.Fatalf("long session metadata = %+v", hit)
	}
	if _, transcript := samAgent.readSession(longID); transcript != mustRead(t, longFile) {
		t.Fatalf("Sam read %d bytes of Dana's long session; she wrote %d", len(transcript), len(long))
	}
	hits = samAgent.search(map[string]any{"agent": "codex", "repo": "api"})
	if len(hits) != 1 || hits[0].SessionID != codexID || hits[0].Author != "dana@example.invalid" || hits[0].AgentVersion != "0.153.4" {
		t.Fatalf("search for Dana's Codex session = %+v", hits)
	}
	if _, transcript := samAgent.readSession(codexID); transcript != mustRead(t, codexFile) {
		t.Fatal("Sam did not read Dana's Codex session byte for byte")
	}
	var resumed []mcpSessionFile
	samAgent.tool("get_session", map[string]any{"session_id": resumedID}, &resumed)
	if len(resumed) != 2 || !strings.Contains(resumed[0].Transcript+resumed[1].Transcript, "wagtail-original") || !strings.Contains(resumed[0].Transcript+resumed[1].Transcript, "wagtail-resumed") {
		t.Fatalf("get_session for the resumed session returned %d file(s)", len(resumed))
	}
	// Dana's agent finds Sam's.
	if hits := danaAgent.search(map[string]any{"query": "wren-billing", "author": "sam"}); len(hits) != 1 || hits[0].SessionID != samID {
		t.Fatalf("Dana's search for Sam's session = %+v", hits)
	}
	// What Dana kept private is on neither machine.
	for _, agent := range []*mcpClient{samAgent, danaAgent} {
		if hits := agent.search(map[string]any{"query": "magpie-excluded"}); len(hits) != 0 {
			t.Fatalf("an excluded session was published: %+v", hits)
		}
	}

	// Sam deletes Dana's Codex session from the shared history. Dana's agent
	// keeps writing that transcript, and her running session grows as well:
	// its last line is torn mid-write when the daemon next looks.
	codexCopies, err := filepath.Glob(filepath.Join(sam.shared().SessionsPath(), "dana@example.invalid", "*", codexID+"-*.cms"))
	if err != nil || len(codexCopies) != 1 {
		t.Fatalf("Sam's copies of Dana's Codex session = %v, %v", codexCopies, err)
	}
	if err := os.Remove(codexCopies[0]); err != nil {
		t.Fatal(err)
	}
	lab.wait("the deletion to reach Dana's machine", func() bool {
		return len(danaAgent.search(map[string]any{"agent": "codex"})) == 0
	})
	appendTranscript(t, codexFile, codexTranscript(codexID, api, "osprey-after-deletion", start, 10, 2))
	more := claudeTranscript(liveID, ingress, "heron-second-wind", start.Add(time.Hour), 4, 3, 2<<10)
	appendTranscript(t, liveFile, more[:len(more)-40])
	edited := time.Now()

	lab.wait("Dana's daemon to republish her running session to Sam", func() bool {
		return len(samAgent.search(map[string]any{"query": "heron-second-wind"})) == 1
	})
	if _, transcript := samAgent.readSession(liveID); transcript != mustRead(t, liveFile) {
		t.Fatal("Sam did not read Dana's running session as it now stands, torn last line included")
	}
	lab.wait("Dana's daemon to finish that publish", func() bool { return dana.lastPublishAttempt().After(edited) })
	for _, agent := range []*mcpClient{samAgent, danaAgent} {
		if hits := agent.search(map[string]any{"query": "osprey"}); len(hits) != 0 {
			t.Fatalf("a deleted session came back once its transcript grew: %+v", hits)
		}
		if authors := agent.authors(); authors["dana@example.invalid"] != 4 || authors["sam@example.invalid"] != 1 {
			t.Fatalf("after one deletion and one republish, authors = %v; want dana 4, sam 1", authors)
		}
	}

	// Dana's laptop restarts. A session from while the daemon was down is
	// published as soon as it is back, and the deletion still holds.
	dana.stopDaemon()
	writeTranscript(t, claudePath(claudeRoot, "-work-ingress", laterID), claudeTranscript(laterID, ingress, "plover-after-restart", time.Now().Add(-time.Minute), 0, 3, 1<<10))
	down, err := runBinary(lab.ctx, lab.exe, dana.env, "status")
	if err != nil || !strings.Contains(down, "sync: unavailable") {
		t.Fatalf("status while the daemon is down: %v\n%s", err, down)
	}
	sam.reach(dana, dana.startDaemon())
	dana.reach(sam, samAddress)
	lab.wait("the session from before the restart to reach Sam", func() bool {
		return len(samAgent.search(map[string]any{"query": "plover-after-restart"})) == 1
	})
	if hits := samAgent.search(map[string]any{"query": "osprey"}); len(hits) != 0 {
		t.Fatalf("a deleted session came back after a restart: %+v", hits)
	}
	if status := sam.cli("status"); !strings.Contains(status, "1 teammates connected") {
		t.Fatalf("sam's status:\n%s", status)
	}
	samAgent.close()
	danaAgent.close()
}

// TestManagedCLIDaemonStartsWhenItsSavedPortIsTaken: the sync API's port is
// chosen once, at setup, from the ephemeral range. After a reboot any program
// may be listening there, and the daemon has to come up regardless. It must
// also not hand its API key to whatever answered.
func TestManagedCLIDaemonStartsWhenItsSavedPortIsTaken(t *testing.T) {
	lab := newManagedLab(t, 3*time.Minute)
	t.Parallel()
	dana := lab.machine("dana")
	dana.cli("init", "--team", "Lab", "--clients", "none", "--no-service", "--author", "dana@example.invalid", "--syncthing", lab.syncBin)

	var sawAPIKey atomic.Bool
	squatter := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != "" {
			sawAPIKey.Store(true)
		}
		http.NotFound(w, r)
	}))
	// The Syncthing that init ran may hold the port for a moment after init returns.
	var listener net.Listener
	lab.wait("the saved sync API address "+dana.Address+" to be free to take", func() bool {
		var err error
		listener, err = net.Listen("tcp", dana.Address)
		return err == nil
	})
	squatter.Listener = listener
	squatter.Start()
	t.Cleanup(squatter.Close)

	d := dana.launchDaemon()
	// Until the daemon has moved, nothing here may talk to the saved address: a
	// CLI command run now would read it from sync.json and send the key itself.
	lab.wait("the daemon to bring sync up on another port", func() bool {
		select {
		case <-d.exited:
			t.Fatalf("the daemon gave up because another program holds its saved sync API port %s: %v\n%s", dana.Address, d.err, d.stderr.String())
		default:
		}
		state, err := syncer.Load(dana.home)
		return err == nil && state.Address != dana.Address && state.Ping(lab.ctx) == nil
	})
	if status := dana.cli("status"); !strings.Contains(status, "sync: ") || strings.Contains(status, "sync: unavailable") {
		t.Fatalf("status after the daemon moved off the taken port:\n%s", status)
	}
	if sawAPIKey.Load() {
		t.Error("the sync API key was sent to the unrelated program on the saved port")
	}
}
