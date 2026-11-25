package main

import (
	"context"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestMCPReadsWhatFlushPublished is the whole single-machine path with nothing
// stubbed: the built binary sets up a shared folder, publishes transcripts
// shaped and sized like real ones, and an agent reads them back through
// `commonmind mcp` over stdio. What comes out of get_session has to be the
// transcript the agent wrote, byte for byte.
func TestMCPReadsWhatFlushPublished(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	exe := commonmindBinary(t)
	userHome := t.TempDir()
	env := labEnv(userHome, filepath.Join(userHome, ".commonmind"))
	shared := filepath.Join(userHome, "CommonMind")
	claudeRoot := filepath.Join(userHome, ".claude", "projects")
	codexRoot := filepath.Join(userHome, ".codex", "sessions")
	cli := func(args ...string) string {
		t.Helper()
		output, err := runBinary(ctx, exe, env, args...)
		if err != nil {
			t.Fatalf("commonmind %v: %v\n%s", args, err, output)
		}
		return output
	}
	start := time.Now().Add(-2 * time.Hour)

	// A long Claude Code session: a few megabytes, one line of which is larger
	// than a whole get_session window.
	const claudeID = "5b0c7f1e-2a4d-4c8e-9f10-3d2e1a0b9c8d"
	claudeCWD := filepath.Join(userHome, "work", "ingress")
	long := claudeTranscript(claudeID, claudeCWD, "kestrel-ingress", start, 0, 150, 4<<10) +
		claudeTranscript(claudeID, claudeCWD, "kestrel-ingress", start, 150, 1, 1500<<10) +
		claudeTranscript(claudeID, claudeCWD, "kestrel-ingress", start, 151, 150, 4<<10)
	if len(long) < 4<<20 {
		t.Fatalf("the long fixture is only %d bytes", len(long))
	}
	claudeFile := writeTranscript(t, claudePath(claudeRoot, "-work-ingress", claudeID), long)

	const codexID = "0198e3c1-abcd-4ef0-9a12-abcdef123456"
	codexCWD := filepath.Join(userHome, "work", "api")
	codexFile := writeTranscript(t, codexPath(codexRoot, codexID, start), codexTranscript(codexID, codexCWD, "osprey-api", start, 0, 12))

	cli("init", "--shared", shared, "--author", "dana@example.invalid")
	if output := cli("flush"); !strings.Contains(output, "published 2, skipped-empty 0, skipped-deleted 0") {
		t.Fatalf("flush: %s", output)
	}

	mcp := startMCP(t, ctx, exe, env)
	var listed struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	mcp.request("tools/list", nil, &listed)
	var names []string
	for _, tool := range listed.Tools {
		names = append(names, tool.Name)
	}
	if got := strings.Join(names, " "); got != "search_sessions list_authors get_session" {
		t.Fatalf("tools = %q", got)
	}
	if authors := mcp.authors(); len(authors) != 1 || authors["dana@example.invalid"] != 2 {
		t.Fatalf("authors = %v; want dana with 2 sessions", authors)
	}

	hits := mcp.search(map[string]any{"query": "KESTREL-ingress path time out"})
	if len(hits) != 1 || hits[0].SessionID != claudeID {
		t.Fatalf("search for the Claude session = %+v", hits)
	}
	if hit := hits[0]; hit.Author != "dana@example.invalid" || hit.Agent != "claude" || hit.CWD != claudeCWD || hit.Repo != "ingress" || hit.AgentVersion != "2.1.291" {
		t.Fatalf("Claude session metadata = %+v", hit)
	}
	hits = mcp.search(map[string]any{"agent": "codex", "since": "1d"})
	if len(hits) != 1 || hits[0].SessionID != codexID || hits[0].CWD != codexCWD || hits[0].AgentVersion != "0.153.4" {
		t.Fatalf("search for the Codex session = %+v", hits)
	}
	if hits := mcp.search(map[string]any{"query": "nothing-says-this"}); len(hits) != 0 {
		t.Fatalf("search for text no transcript holds = %+v", hits)
	}

	if _, transcript := mcp.readSession(claudeID); transcript != mustRead(t, claudeFile) {
		t.Fatalf("get_session rebuilt %d bytes of the Claude transcript; the source is %d bytes", len(transcript), len(long))
	}
	if _, transcript := mcp.readSession(codexID); transcript != mustRead(t, codexFile) {
		t.Fatal("get_session did not return the Codex transcript byte for byte")
	}

	// The session is still running: the agent writes on, the last line torn
	// mid-write, and the next flush publishes what is there.
	more := claudeTranscript(claudeID, claudeCWD, "kestrel-second-wind", start, 301, 3, 4<<10)
	appendTranscript(t, claudeFile, more[:len(more)-40])
	if output := cli("flush"); !strings.Contains(output, "published 1,") {
		t.Fatalf("flush of the grown session: %s", output)
	}
	if hits := mcp.search(map[string]any{"query": "kestrel-second-wind"}); len(hits) != 1 || hits[0].SessionID != claudeID {
		t.Fatalf("the running server did not see the republished session: %+v", hits)
	}
	if _, transcript := mcp.readSession(claudeID); transcript != mustRead(t, claudeFile) {
		t.Fatal("get_session did not return the grown transcript byte for byte")
	}
	if authors := mcp.authors(); authors["dana@example.invalid"] != 2 {
		t.Fatalf("republishing a grown session changed the session count: %v", authors)
	}
	mcp.close()
}

// TestMCPStopsOnASignal: a client that ends the server with a signal while it
// still holds the pipe open must not have to wait for a kill.
func TestMCPStopsOnASignal(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	t.Cleanup(cancel)
	exe := commonmindBinary(t)
	userHome := t.TempDir()
	env := labEnv(userHome, filepath.Join(userHome, ".commonmind"))
	if output, err := runBinary(ctx, exe, env, "init", "--shared", filepath.Join(userHome, "CommonMind"), "--author", "dana@example.invalid"); err != nil {
		t.Fatalf("init: %v\n%s", err, output)
	}
	for _, sig := range []syscall.Signal{syscall.SIGTERM, syscall.SIGINT} {
		t.Run(sig.String(), func(t *testing.T) {
			mcp := startMCP(t, ctx, exe, env)
			mcp.signal(sig)
			if err := mcp.wait(5 * time.Second); err != nil && strings.Contains(err.Error(), "still running") {
				t.Fatalf("commonmind mcp ignored %s while its stdin was open: %v", sig, err)
			}
		})
	}
}
