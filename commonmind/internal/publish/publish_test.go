package publish

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/ledger"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/scan"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/session"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/store"
)

// newStore returns a store over an initialized shared folder, and the
// publish ledger that goes with it. Publish refuses a folder whose sessions
// directory is missing, which is what an unmounted share looks like; the
// ledger is per-machine state, so one test gets exactly one, however many
// times it flushes.
func newStore(t *testing.T, root string) (*store.Store, *ledger.DB) {
	t.Helper()
	st := store.New(root)
	if err := st.Init(); err != nil {
		t.Fatal(err)
	}
	return st, newLedger(t)
}

func newLedger(t *testing.T) *ledger.DB {
	t.Helper()
	led, err := ledger.Open(filepath.Join(t.TempDir(), "published.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { led.Close() })
	return led
}

// published globs for a published session file, since both its date
// directory (from the session's own first timestamp) and its filename
// suffix (a hash of the source transcript path) vary.
func published(t *testing.T, st *store.Store, author, sessionID string) []string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(st.Root(), "sessions", author, "*", sessionID+"-*"+store.Extension))
	if err != nil {
		t.Fatal(err)
	}
	return matches
}

// writeSession writes a minimal, realistic Claude Code session JSONL file
// at <root>/<project>/<id>.jsonl and backdates its mtime by age.
func writeSession(t *testing.T, root, project, id, cwd string, age time.Duration) string {
	t.Helper()
	dir := filepath.Join(root, project)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, id+".jsonl")
	lines := strings.Join([]string{
		`{"type":"user","message":{"role":"user","content":"the ingress controller"},"sessionId":"` + id + `","cwd":"` + filepath.ToSlash(cwd) + `","version":"1.2.3","timestamp":"2026-09-18T07:12:03.000Z"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"looking into the ingress controller"}]},"timestamp":"2026-09-18T07:12:10.000Z"}`,
	}, "\n")
	if err := os.WriteFile(path, []byte(lines+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	when := time.Now().Add(-age)
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatal(err)
	}
	return path
}

// writeSessionWithID writes a session JSONL file whose FILENAME (and thus
// scan.Candidate.SessionID) is filename, but whose records carry sessionID
// as their internal sessionId — the shape of a resumed or forked Claude
// Code session, which starts a fresh transcript file but keeps the
// original session_id.
func writeSessionWithID(t *testing.T, root, project, filename, sessionID, cwd string, age time.Duration, text string) string {
	t.Helper()
	dir := filepath.Join(root, project)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, filename+".jsonl")
	lines := strings.Join([]string{
		`{"type":"user","message":{"role":"user","content":"` + text + `"},"sessionId":"` + sessionID + `","cwd":"` + filepath.ToSlash(cwd) + `","version":"1.2.3","timestamp":"2026-09-18T07:12:03.000Z"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"looking into it"}]},"timestamp":"2026-09-18T07:12:10.000Z"}`,
	}, "\n")
	if err := os.WriteFile(path, []byte(lines+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	when := time.Now().Add(-age)
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatal(err)
	}
	return path
}

func defaultOpts(roots ...string) Options {
	return Options{Roots: roots, Since: 14 * 24 * time.Hour}
}

// TestPublishesRunningSessionsToo pins the absence of an idle rule: a
// transcript written a moment ago is published alongside a quiet one.
func TestPublishesRunningSessionsToo(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())

	writeSession(t, root, "-tmp-running", "running", filepath.Join(t.TempDir(), "running"), 0)
	writeSession(t, root, "-tmp-quiet", "quiet", filepath.Join(t.TempDir(), "quiet"), time.Hour)

	n, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root))
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("published %d sessions, want 2", n)
	}

	if matches := published(t, st, "a@b.c", "quiet"); len(matches) != 1 {
		t.Fatalf("quiet session was not published: %v", matches)
	}
	if matches := published(t, st, "a@b.c", "running"); len(matches) != 1 {
		t.Fatalf("a still-running session was not published: %v", matches)
	}
}

func TestRepublishIsANoOp(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())
	writeSession(t, root, "-tmp-sample", "sample", filepath.Join(t.TempDir(), "sample"), time.Hour)

	n, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root))
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("first run published %d, want 1", n)
	}

	n, _, _, err = Run(context.Background(), st, led, "a@b.c", defaultOpts(root))
	if err != nil || n != 0 {
		t.Fatalf("second run = %d, %v; want 0, nil", n, err)
	}
}

func TestSinceWindowExcludesOldFiles(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())

	writeSession(t, root, "-tmp-recent", "recent", filepath.Join(t.TempDir(), "recent"), 24*time.Hour)
	writeSession(t, root, "-tmp-ancient", "ancient", filepath.Join(t.TempDir(), "ancient"), 20*24*time.Hour)

	n, _, _, err := Run(context.Background(), st, led, "a@b.c", Options{Roots: []string{root}, Since: 48 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("published %d sessions, want 1 (only the one inside --since)", n)
	}
	if matches := published(t, st, "a@b.c", "ancient"); len(matches) != 0 {
		t.Fatal("a session older than --since was published")
	}
}

func TestExcludePatternSkipsMatchingCWD(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())
	secretCWD := filepath.Join(t.TempDir(), "secret-project")
	writeSession(t, root, "-tmp-secret", "excluded", secretCWD, time.Hour)

	opts := defaultOpts(root)
	opts.Exclude = []string{filepath.Join(filepath.Dir(secretCWD), "secret-*")}
	n, _, _, err := Run(context.Background(), st, led, "a@b.c", opts)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("published %d sessions, want 0 (cwd matched --exclude)", n)
	}
}

func TestCommonmindIgnoreFileSkipsSession(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())
	repo := t.TempDir()
	cwd := filepath.Join(repo, "sub", "dir")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, ignoreFileName), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	writeSession(t, root, "-tmp-ignored", "ignored", cwd, time.Hour)

	n, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root))
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("published %d sessions, want 0 (.commonmind-ignore ancestor)", n)
	}
}

// TestRecordWithNoDialogueIsStillPublished: a transcript of bookkeeping
// records with no dialogue in it. Publishing raw has no opinion about what a
// record contains, so it is published, and its text is searchable.
func TestRecordWithNoDialogueIsStillPublished(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())
	dir := filepath.Join(root, "-tmp-summary")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "summary.jsonl")
	if err := os.WriteFile(path, []byte(`{"type":"summary","summary":"nothing to see","sessionId":"summary"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}

	n, skipped, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root))
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 || skipped != 0 {
		t.Fatalf("published %d / skipped %d, want 1 / 0: nothing is dropped any more", n, skipped)
	}
}

// TestTranscriptWithNothingUsableIsCountedSkipped is the surviving half of
// the counter that exists because an entire agent's sessions once vanished
// silently. A file holding no record this program can recognize is skipped
// — and counted, so it is visible in flush and status output.
func TestTranscriptWithNothingUsableIsCountedSkipped(t *testing.T) {
	for _, tc := range []struct {
		name    string
		content string
	}{
		{"empty file", ""},
		{"blank lines only", "\n\n   \n"},
		{"not json at all", "this is not a transcript\nnor is this\n"},
		{"json but not records", `"a bare string"` + "\n" + `[1,2,3]` + "\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			st, led := newStore(t, t.TempDir())
			dir := filepath.Join(root, "-tmp-junk")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, "junk.jsonl")
			if err := os.WriteFile(path, []byte(tc.content), 0o644); err != nil {
				t.Fatal(err)
			}
			old := time.Now().Add(-time.Hour)
			if err := os.Chtimes(path, old, old); err != nil {
				t.Fatal(err)
			}

			n, skipped, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root))
			if err != nil {
				t.Fatal(err)
			}
			if n != 0 {
				t.Fatalf("published %d sessions, want 0", n)
			}
			if skipped != 1 {
				t.Fatalf("skippedEmpty = %d, want 1: a transcript yielding nothing usable must be counted, not silently dropped", skipped)
			}

			candidates, err := scan.List([]string{root}, time.Now().Add(-14*24*time.Hour))
			if err != nil {
				t.Fatal(err)
			}
			if got := PreviewSkippedEmpty(led, candidates); got != 1 {
				t.Fatalf("PreviewSkippedEmpty = %d, want 1: status must report the same signal flush does", got)
			}
		})
	}
}

func TestMalformedLineIsSkippedNotFatal(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())
	dir := filepath.Join(root, "-tmp-messy")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "messy.jsonl")
	cwd := filepath.ToSlash(filepath.Join(t.TempDir(), "messy"))
	content := `not json at all` + "\n" +
		`{"type":"user","message":{"role":"user","content":"still works"},"sessionId":"messy","cwd":"` + cwd + `","timestamp":"2026-09-18T07:12:03.000Z"}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}

	n, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root))
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("published %d sessions, want 1 (malformed line must not fail the session)", n)
	}
}

func TestRunRemovesOrphanedTempFiles(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, root)

	tmpDir := store.HostTempDir(root)
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(tmpDir, "stale.123"+store.Extension)
	fresh := filepath.Join(tmpDir, "fresh.456"+store.Extension)
	for _, path := range []string{stale, fresh} {
		if err := os.WriteFile(path, []byte("a half-written transcript"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}

	sessionRoot := t.TempDir()
	writeSession(t, sessionRoot, "-tmp-sample", "sample", filepath.Join(t.TempDir(), "sample"), time.Hour)
	if _, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(sessionRoot)); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale temp file survived the publish: %v", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("a temp file younger than the lifetime was removed: %v", err)
	}
}

func TestPublishedFileIsWorldReadable(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())
	writeSession(t, root, "-tmp-sample", "sample", filepath.Join(t.TempDir(), "sample"), time.Hour)
	if _, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root)); err != nil {
		t.Fatal(err)
	}
	matches := published(t, st, "a@b.c", "sample")
	if len(matches) != 1 {
		t.Fatalf("sample session was not published: %v", matches)
	}
	info, err := os.Stat(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o644 {
		t.Fatalf("published file mode = %o, want 644 so teammates can read it", mode)
	}
}

// TestResumedSessionWithSameSessionIDDoesNotOverwriteTheOriginal is the
// regression test for the resumed/forked-session bug: two distinct
// transcript files carrying the same internal sessionId (what Claude Code
// writes when a session is resumed or forked) must both survive, both
// index, and both be findable by search. Before the fix, the second publish
// landed on the first one's path and silently replaced it.
func TestResumedSessionWithSameSessionIDDoesNotOverwriteTheOriginal(t *testing.T) {
	shared := t.TempDir()
	st, led := newStore(t, shared)
	claudeRoot := t.TempDir()

	const sessionID = "7ce98385-ec2d-4bc9-9554-4a1ba176f111"
	writeSessionWithID(t, claudeRoot, "-tmp-proj-a", "952bd709-5fa4-4745-bf43-6b7069d0c5a7", sessionID,
		filepath.Join(t.TempDir(), "proj-a"), time.Hour, "the original conversation about the ingress controller")
	writeSessionWithID(t, claudeRoot, "-tmp-proj-b", "ac7e3feb-6296-4d22-8fff-1009e2ecca8b", sessionID,
		filepath.Join(t.TempDir(), "proj-b"), time.Hour, "the resumed conversation continues about the ingress controller")

	n, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(claudeRoot))
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("published %d sessions, want 2: a resumed session must not silently replace the original", n)
	}

	matches := published(t, st, "a@b.c", sessionID)
	if len(matches) != 2 {
		t.Fatalf("published files for the colliding session id = %v, want 2 distinct paths", matches)
	}

	hits, err := st.Get(sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 2 {
		t.Fatalf("store.Get(%q) returned %d hits, want 2 (get_session returning two entries for one id is correct here)", sessionID, len(hits))
	}

	searchHits, err := st.Search(store.Query{Text: "resumed conversation", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(searchHits) != 1 {
		t.Fatalf("search for the resumed session's own text found %d hits, want 1", len(searchHits))
	}
}

// TestResumedSessionRerunDoesNotRepublish confirms idempotence still holds
// under the new source-file-keyed path scheme.
func TestResumedSessionRerunDoesNotRepublish(t *testing.T) {
	shared := t.TempDir()
	st, led := newStore(t, shared)
	claudeRoot := t.TempDir()

	const sessionID = "7ce98385-ec2d-4bc9-9554-4a1ba176f111"
	writeSessionWithID(t, claudeRoot, "-tmp-proj-a", "952bd709-5fa4-4745-bf43-6b7069d0c5a7", sessionID,
		filepath.Join(t.TempDir(), "proj-a"), time.Hour, "the original conversation")
	writeSessionWithID(t, claudeRoot, "-tmp-proj-b", "ac7e3feb-6296-4d22-8fff-1009e2ecca8b", sessionID,
		filepath.Join(t.TempDir(), "proj-b"), time.Hour, "the resumed conversation")

	if n, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(claudeRoot)); err != nil || n != 2 {
		t.Fatalf("first run = %d, %v; want 2, nil", n, err)
	}
	n, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(claudeRoot))
	if err != nil || n != 0 {
		t.Fatalf("second run = %d, %v; want 0, nil (idempotent under the new path scheme)", n, err)
	}
}

// writeCodexSession writes a minimal, realistic Codex rollout JSONL file at
// "<root>/<yyyy>/<mm>/<dd>/rollout-...-<id>.jsonl" — the layout
// internal/scan's Codex dialect expects — and backdates its mtime by age.
func writeCodexSession(t *testing.T, root, sessionID, cwd string, age time.Duration) string {
	t.Helper()
	dir := filepath.Join(root, "2026", "09", "18")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "rollout-2026-09-18T07-12-03-"+sessionID+".jsonl")
	lines := strings.Join([]string{
		`{"timestamp":"2026-09-18T07:12:03.000Z","ordinal":0,"type":"session_meta","payload":{"type":"session_meta","session_id":"` + sessionID + `","id":"` + sessionID + `","cwd":"` + filepath.ToSlash(cwd) + `","cli_version":"0.153.4","git":{"commit_hash":"abc123","repository_url":"https://github.com/example/proj.git"}}}`,
		`{"timestamp":"2026-09-18T07:12:04.000Z","ordinal":1,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"the ingress controller"}]}}`,
		`{"timestamp":"2026-09-18T07:12:05.000Z","ordinal":2,"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"looking into the ingress controller"}]}}`,
	}, "\n")
	if err := os.WriteFile(path, []byte(lines+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	when := time.Now().Add(-age)
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatal(err)
	}
	return path
}

// writeCodexOnlyDropTypes writes a Codex rollout file made entirely of
// payload types that hold no dialogue (reasoning, token_count).
func writeCodexOnlyDropTypes(t *testing.T, root, sessionID string, age time.Duration) string {
	t.Helper()
	dir := filepath.Join(root, "2026", "09", "18")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "rollout-2026-09-18T08-00-00-"+sessionID+".jsonl")
	lines := strings.Join([]string{
		`{"timestamp":"2026-09-18T08:00:00.000Z","ordinal":0,"type":"response_item","payload":{"type":"reasoning","summary":[],"encrypted_content":"gAAAAA"}}`,
		`{"timestamp":"2026-09-18T08:00:01.000Z","ordinal":1,"type":"event_msg","payload":{"type":"token_count","info":{"total_tokens":5}}}`,
	}, "\n")
	if err := os.WriteFile(path, []byte(lines+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	when := time.Now().Add(-age)
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestPublishesCodexSession proves the one generic metadata path recovers a
// Codex session's identity out of its {timestamp, ordinal, type, payload}
// envelope — cwd and cli_version live one level down, inside payload — with
// no Codex-specific code anywhere in this program.
func TestPublishesCodexSession(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())
	sessionID := "0198e3c1-abcd-4ef0-9a12-abcdef123456"
	writeCodexSession(t, root, sessionID, filepath.Join(t.TempDir(), "proj"), time.Hour)

	n, skipped, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root))
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("published %d Codex sessions, want 1", n)
	}
	if skipped != 0 {
		t.Fatalf("skippedEmpty = %d, want 0", skipped)
	}

	matches := published(t, st, "a@b.c", sessionID)
	if len(matches) != 1 {
		t.Fatalf("Codex session was not published: %v", matches)
	}
	f, err := os.Open(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	rec, err := session.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Agent != "codex" {
		t.Errorf("Agent = %q, want codex", rec.Agent)
	}
	if !strings.Contains(rec.Content, "looking into the ingress controller") {
		t.Fatal("published Codex content missing assistant dialogue")
	}
	if !strings.Contains(rec.Content, "the ingress controller") {
		t.Fatal("published Codex content missing user dialogue")
	}
	if rec.AgentVersion != "0.153.4" {
		t.Errorf("AgentVersion = %q, want cli_version", rec.AgentVersion)
	}
}

// TestCodexSessionOfOnlyReasoningAndTokenAccountingIsPublished: a session
// with no dialogue in it is still a session. Raw publishing keeps it,
// encrypted reasoning blob and all, so it is published and not counted as
// skipped.
func TestCodexSessionOfOnlyReasoningAndTokenAccountingIsPublished(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())
	sessionID := "0198e3c1-0000-0000-0000-000000000000"
	writeCodexOnlyDropTypes(t, root, sessionID, time.Hour)

	n, skipped, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root))
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("published %d sessions, want 1", n)
	}
	if skipped != 0 {
		t.Fatalf("skippedEmpty = %d, want 0", skipped)
	}
	// No session_meta record, so no session id inside the file: the one
	// scan read off the filename is what it must be published under.
	if matches := published(t, st, "a@b.c", sessionID); len(matches) != 1 {
		t.Fatalf("published files = %v, want 1 keyed by the filename session id", matches)
	}
}

// TestRunDoesNotPruneThroughALinkedStagingDirectory: in a folder replicated by
// anything but the managed sync, the staging directory is replicated too, and a
// teammate can swap this host's for a link to any directory on this machine.
func TestRunDoesNotPruneThroughALinkedStagingDirectory(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, root)
	outside := t.TempDir()
	keep := filepath.Join(outside, "id_ed25519")
	if err := os.WriteFile(keep, []byte("key"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * tempFileLifetime)
	if err := os.Chtimes(keep, old, old); err != nil {
		t.Fatal(err)
	}
	staging := store.HostTempDir(root)
	if err := os.MkdirAll(filepath.Dir(staging), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, staging); err != nil {
		t.Fatal(err)
	}

	_, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(t.TempDir()))
	if _, statErr := os.Stat(keep); statErr != nil {
		t.Fatalf("a publish run removed a file outside the shared folder: %v", statErr)
	}
	if err == nil {
		t.Fatal("a staging directory that is a link was used without an error")
	}
}

// TestPruneLeavesForeignHostTempFilesAlone: the staging directory is inside
// the shared folder, so it is replicated. Another machine's in-flight file
// is that machine's to finish, and its mtime arrived over the network — this
// host must not judge it by its own clock.
func TestPruneLeavesForeignHostTempFilesAlone(t *testing.T) {
	root := t.TempDir()

	mine := store.HostTempDir(root)
	theirs := filepath.Join(root, store.TempDirName, "someone-elses-laptop")
	for _, dir := range []string{mine, theirs} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	myStale := filepath.Join(mine, "stale.123"+store.Extension)
	theirStale := filepath.Join(theirs, "stale.456"+store.Extension)
	old := time.Now().Add(-2 * time.Hour)
	for _, path := range []string{myStale, theirStale} {
		if err := os.WriteFile(path, []byte("a half-written transcript"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}

	if err := pruneTempFiles(store.New(root), tempFileLifetime, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(myStale); !os.IsNotExist(err) {
		t.Fatalf("this host's stale temp file survived: %v", err)
	}
	if _, err := os.Stat(theirStale); err != nil {
		t.Fatalf("another host's temp file was deleted: %v", err)
	}
}

// decodePublished decodes the single published file for sessionID.
func decodePublished(t *testing.T, st *store.Store, author, sessionID string) session.Record {
	t.Helper()
	matches := published(t, st, author, sessionID)
	if len(matches) != 1 {
		t.Fatalf("published files for %q = %v, want exactly 1", sessionID, matches)
	}
	file, err := os.Open(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	rec, err := session.Decode(file)
	if err != nil {
		t.Fatal(err)
	}
	return rec
}

// TestPublishedContentIsByteIdenticalToTheSourceTranscript is the whole
// point of publishing raw: the file in the shared folder holds exactly the
// bytes the agent wrote, for both agents' formats.
func TestPublishedContentIsByteIdenticalToTheSourceTranscript(t *testing.T) {
	claudeRoot := t.TempDir()
	codexRoot := t.TempDir()
	st, led := newStore(t, t.TempDir())

	claudePath := writeSession(t, claudeRoot, "-tmp-sample", "sample", filepath.Join(t.TempDir(), "sample"), time.Hour)
	codexID := "0198e3c1-abcd-4ef0-9a12-abcdef123456"
	codexPath := writeCodexSession(t, codexRoot, codexID, filepath.Join(t.TempDir(), "proj"), time.Hour)

	n, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(claudeRoot, codexRoot))
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("published %d sessions, want 2", n)
	}

	for _, tc := range []struct{ sessionID, source string }{
		{"sample", claudePath},
		{codexID, codexPath},
	} {
		raw, err := os.ReadFile(tc.source)
		if err != nil {
			t.Fatal(err)
		}
		rec := decodePublished(t, st, "a@b.c", tc.sessionID)
		if rec.Content != string(raw) {
			t.Fatalf("published content for %s is not byte-identical to %s (%d bytes published, %d on disk)",
				tc.sessionID, tc.source, len(rec.Content), len(raw))
		}
		sum := sha256.Sum256(raw)
		if want := "sha256:" + hex.EncodeToString(sum[:]); rec.ContentHash != want {
			t.Fatalf("content_hash = %q, want the hash of the source file %q", rec.ContentHash, want)
		}
	}
}

// TestClaudeMetadataIsRecoveredGenerically: Claude Code writes sessionId,
// cwd and version at the top level of its flat records.
func TestClaudeMetadataIsRecoveredGenerically(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())
	cwd := filepath.Join(t.TempDir(), "sample")
	writeSession(t, root, "-tmp-sample", "sample", cwd, time.Hour)

	if _, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root)); err != nil {
		t.Fatal(err)
	}
	rec := decodePublished(t, st, "a@b.c", "sample")
	if rec.Agent != "claude" {
		t.Errorf("Agent = %q, want claude", rec.Agent)
	}
	if rec.SessionID != "sample" {
		t.Errorf("SessionID = %q, want the id carried in the records", rec.SessionID)
	}
	if rec.CWD != filepath.ToSlash(cwd) {
		t.Errorf("CWD = %q, want %q", rec.CWD, cwd)
	}
	if rec.Repo != filepath.Base(cwd) {
		t.Errorf("Repo = %q, want %q derived from cwd", rec.Repo, filepath.Base(cwd))
	}
	if rec.AgentVersion != "1.2.3" {
		t.Errorf("AgentVersion = %q, want 1.2.3", rec.AgentVersion)
	}
	if got := rec.StartedAt.UTC().Format(time.RFC3339); got != "2026-09-18T07:12:03Z" {
		t.Errorf("StartedAt = %s, want the first record's timestamp", got)
	}
	if got := rec.EndedAt.UTC().Format(time.RFC3339); got != "2026-09-18T07:12:10Z" {
		t.Errorf("EndedAt = %s, want the last record's timestamp", got)
	}
}

// TestCodexMetadataIsRecoveredGenerically: the same walk, one level down
// inside payload, where Codex keeps session_id, cwd and cli_version.
func TestCodexMetadataIsRecoveredGenerically(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())
	sessionID := "0198e3c1-abcd-4ef0-9a12-abcdef123456"
	cwd := filepath.Join(t.TempDir(), "proj")
	writeCodexSession(t, root, sessionID, cwd, time.Hour)

	if _, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root)); err != nil {
		t.Fatal(err)
	}
	rec := decodePublished(t, st, "a@b.c", sessionID)
	if rec.Agent != "codex" {
		t.Errorf("Agent = %q, want codex", rec.Agent)
	}
	if rec.SessionID != sessionID {
		t.Errorf("SessionID = %q, want payload.session_id %q", rec.SessionID, sessionID)
	}
	if rec.CWD != filepath.ToSlash(cwd) {
		t.Errorf("CWD = %q, want payload.cwd %q", rec.CWD, cwd)
	}
	if rec.AgentVersion != "0.153.4" {
		t.Errorf("AgentVersion = %q, want payload.cli_version", rec.AgentVersion)
	}
	if got := rec.StartedAt.UTC().Format(time.RFC3339); got != "2026-09-18T07:12:03Z" {
		t.Errorf("StartedAt = %s, want the first envelope timestamp", got)
	}
	if got := rec.EndedAt.UTC().Format(time.RFC3339); got != "2026-09-18T07:12:05Z" {
		t.Errorf("EndedAt = %s, want the last envelope timestamp", got)
	}
}

// TestSessionWithoutRecoverableMetadataStillPublishes: metadata is
// best-effort. A transcript whose records carry none of the keys the
// sniffer looks for is published anyway, keyed by the session id scan read
// off the filename, with empty cwd and version and timestamps falling back
// to the file's mtime.
func TestSessionWithoutRecoverableMetadataStillPublishes(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())
	dir := filepath.Join(root, "-tmp-bare")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "bare-session-id.jsonl")
	content := `{"type":"note","text":"no identity fields anywhere in here"}` + "\n" +
		`{"type":"note","text":"nor here"}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	modTime := time.Now().Add(-time.Hour)
	if err := os.Chtimes(path, modTime, modTime); err != nil {
		t.Fatal(err)
	}

	n, skipped, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root))
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 || skipped != 0 {
		t.Fatalf("published %d / skipped %d, want 1 / 0", n, skipped)
	}
	rec := decodePublished(t, st, "a@b.c", "bare-session-id")
	if rec.Content != content {
		t.Error("published content is not the source transcript")
	}
	if rec.CWD != "" || rec.AgentVersion != "" {
		t.Errorf("CWD = %q, AgentVersion = %q; both should be empty rather than guessed", rec.CWD, rec.AgentVersion)
	}
	if rec.StartedAt.Sub(modTime).Abs() > time.Second {
		t.Errorf("StartedAt = %s, want the file's mtime %s as the fallback", rec.StartedAt, modTime)
	}
}

// TestTornFinalLinePublishesAndKeepsItsMetadata covers reading a transcript
// mid-append, which is now the ordinary case: the last line can be cut off
// wherever the agent's write happened to land. The raw bytes are published
// as they were read, torn tail included, and the metadata sniffer recovers
// everything from the complete records ahead of it.
func TestTornFinalLinePublishesAndKeepsItsMetadata(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())
	cwd := filepath.Join(t.TempDir(), "torn-project")

	dir := filepath.Join(root, "-tmp-torn")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// The trailing line is valid JSON right up to the byte the read caught
	// it at: no closing braces, no newline.
	raw := strings.Join([]string{
		`{"type":"user","message":{"role":"user","content":"the ingress controller"},"sessionId":"torn","cwd":"` + filepath.ToSlash(cwd) + `","version":"1.2.3","timestamp":"2026-09-18T07:12:03.000Z"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"looking into it"}]},"timestamp":"2026-09-18T07:12:10.000Z"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"still wri`,
	}, "\n")
	path := filepath.Join(dir, "torn.jsonl")
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}

	n, empty, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root))
	if err != nil {
		t.Fatalf("a transcript with a torn final line failed to publish: %v", err)
	}
	if n != 1 || empty != 0 {
		t.Fatalf("published %d, skipped-empty %d; want 1 published and 0 skipped", n, empty)
	}

	rec := decodePublished(t, st, "a@b.c", "torn")
	if rec.Content != raw {
		t.Fatal("the torn final line was not preserved byte for byte")
	}
	if rec.SessionID != "torn" {
		t.Errorf("SessionID = %q, want torn", rec.SessionID)
	}
	if rec.CWD != filepath.ToSlash(cwd) {
		t.Errorf("CWD = %q, want %q", rec.CWD, cwd)
	}
	if rec.AgentVersion != "1.2.3" {
		t.Errorf("AgentVersion = %q, want 1.2.3", rec.AgentVersion)
	}
	if got := rec.StartedAt.UTC().Format(time.RFC3339); got != "2026-09-18T07:12:03Z" {
		t.Errorf("StartedAt = %s, want the first record's timestamp", got)
	}
	if got := rec.EndedAt.UTC().Format(time.RFC3339); got != "2026-09-18T07:12:10Z" {
		t.Errorf("EndedAt = %s, want the last COMPLETE record's timestamp", got)
	}
}

// TestUnchangedSessionIsSkippedWithoutBeingRead is the performance half of
// the ledger. A session whose transcript has not moved since we published it
// must cost one stat, not a full read-and-hash of the file — so the source is
// made unreadable after the first flush: a second flush that touches it at
// all fails, and the published file's mtime proves nothing was rewritten.
func TestUnchangedSessionIsSkippedWithoutBeingRead(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())
	source := writeSession(t, root, "-tmp-sample", "sample", filepath.Join(t.TempDir(), "sample"), time.Hour)

	n, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root))
	if err != nil || n != 1 {
		t.Fatalf("first run = %d, %v; want 1, nil", n, err)
	}
	matches := published(t, st, "a@b.c", "sample")
	if len(matches) != 1 {
		t.Fatalf("published files = %v", matches)
	}
	before, err := os.Stat(matches[0])
	if err != nil {
		t.Fatal(err)
	}

	if err := os.Chmod(source, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(source, 0o644) })

	n, _, deleted, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root))
	if err != nil {
		t.Fatalf("an unchanged session was read again: %v", err)
	}
	if n != 0 || deleted != 0 {
		t.Fatalf("second run = %d published / %d deleted; want 0 / 0", n, deleted)
	}
	after, err := os.Stat(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatalf("the published file was rewritten: %s -> %s", before.ModTime(), after.ModTime())
	}
}

// TestGrownSessionIsRepublishedAndLedgerUpdated: the skip is keyed on the
// source's size and mtime, so a session still being appended to keeps being
// republished as it grows, and the ledger follows it.
func TestGrownSessionIsRepublishedAndLedgerUpdated(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())
	source := writeSession(t, root, "-tmp-live", "live", filepath.Join(t.TempDir(), "live"), time.Hour)

	if n, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root)); err != nil || n != 1 {
		t.Fatalf("first run = %d, %v; want 1, nil", n, err)
	}
	abs, err := filepath.Abs(source)
	if err != nil {
		t.Fatal(err)
	}
	first, ok, err := led.Lookup(abs)
	if err != nil || !ok {
		t.Fatalf("ledger lookup after publish = %v, %v", ok, err)
	}

	file, err := os.OpenFile(source, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(`{"type":"user","message":{"role":"user","content":"and the sidecar too"},"timestamp":"2026-09-18T08:00:00.000Z"}` + "\n"); err != nil {
		t.Fatal(err)
	}
	file.Close()
	when := time.Now()
	if err := os.Chtimes(source, when, when); err != nil {
		t.Fatal(err)
	}

	n, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root))
	if err != nil || n != 1 {
		t.Fatalf("a grown session was not republished: %d, %v", n, err)
	}
	second, ok, err := led.Lookup(abs)
	if err != nil || !ok {
		t.Fatalf("ledger lookup after republish = %v, %v", ok, err)
	}
	if second.SourceSize <= first.SourceSize || second.SourceMtimeNS == first.SourceMtimeNS {
		t.Fatalf("the ledger did not follow the growth: %+v -> %+v", first, second)
	}
	if second.ContentHash == first.ContentHash {
		t.Fatal("the ledger kept the old content hash")
	}
}

// TestUnmountedShareRefusesRatherThanSkipping is the safety ordering. Every
// published file is missing when the share is not mounted, which is exactly
// what a deliberate deletion looks like to the ledger — so the share is
// verified first, and the run fails instead of quietly deciding the whole
// folder was deleted on purpose.
func TestUnmountedShareRefusesRatherThanSkipping(t *testing.T) {
	root := t.TempDir()
	shared := t.TempDir()
	st, led := newStore(t, shared)
	writeSession(t, root, "-tmp-alpha", "alpha", filepath.Join(t.TempDir(), "alpha"), time.Hour)
	writeSession(t, root, "-tmp-bravo", "bravo", filepath.Join(t.TempDir(), "bravo"), time.Hour)

	if n, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root)); err != nil || n != 2 {
		t.Fatalf("setup run = %d, %v; want 2, nil", n, err)
	}

	// The NAS goes away.
	if err := os.RemoveAll(shared); err != nil {
		t.Fatal(err)
	}

	n, _, skippedDeleted, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root))
	if !errors.Is(err, store.ErrNoSessionsDir) {
		t.Fatalf("err = %v, want store.ErrNoSessionsDir", err)
	}
	if skippedDeleted != 0 {
		t.Fatalf("an unmounted share was read as %d deliberate deletions", skippedDeleted)
	}
	if n != 0 {
		t.Fatalf("published %d against an unmounted share", n)
	}
	if _, statErr := os.Stat(shared); !os.IsNotExist(statErr) {
		t.Fatalf("the run recreated the shared folder: %v", statErr)
	}
}
