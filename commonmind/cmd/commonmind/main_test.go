package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/session"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/settings"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/store"
)

// claudeFixture writes a minimal, realistic Claude Code session JSONL file
// under root/<project>/<sessionID>.jsonl and backdates its mtime by age, so
// a test can place it inside or outside the --since window.
func claudeFixture(t *testing.T, root, project, sessionID, cwd string, age time.Duration) string {
	t.Helper()
	dir := filepath.Join(root, project)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, sessionID+".jsonl")
	lines := strings.Join([]string{
		`{"type":"user","message":{"role":"user","content":"the ingress controller"},"sessionId":"` + sessionID + `","cwd":"` + cwd + `","version":"1.2.3","timestamp":"2026-09-18T07:12:03.000Z"}`,
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

func TestFlushPublishesAndStatusReports(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	shared := filepath.Join(t.TempDir(), "shared")
	claudeRoot := filepath.Join(t.TempDir(), "claude-projects")
	t.Setenv("COMMONMIND_HOME", home)

	if err := run(context.Background(), []string{
		"init", "--shared", shared, "--author", "a@b.c", "--roots", claudeRoot,
	}, os.Stdout); err != nil {
		t.Fatalf("init: %v", err)
	}

	claudeFixture(t, claudeRoot, "-tmp-proj", "abc", "/tmp/proj", time.Hour)

	if err := run(context.Background(), []string{"flush"}, os.Stdout); err != nil {
		t.Fatalf("flush: %v", err)
	}

	matches, err := filepath.Glob(filepath.Join(shared, "sessions", "a@b.c", "*", "abc-*.cms"))
	if err != nil || len(matches) != 1 {
		t.Fatalf("published files = %v (%v)", matches, err)
	}

	var out strings.Builder
	if err := run(context.Background(), []string{"status"}, &out); err != nil {
		t.Fatalf("status: %v", err)
	}
	if !strings.Contains(out.String(), "sessions in the shared folder: 1") {
		t.Fatalf("status output: %s", out.String())
	}
}

// TestFlushPublishesAStillRunningSession pins the absence of an idle rule
// at the CLI: a transcript written a moment ago is published like any other.
func TestFlushPublishesAStillRunningSession(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	shared := filepath.Join(t.TempDir(), "shared")
	claudeRoot := filepath.Join(t.TempDir(), "claude-projects")
	t.Setenv("COMMONMIND_HOME", home)

	if err := run(context.Background(), []string{
		"init", "--shared", shared, "--author", "a@b.c", "--roots", claudeRoot,
	}, os.Stdout); err != nil {
		t.Fatalf("init: %v", err)
	}

	claudeFixture(t, claudeRoot, "-tmp-proj", "live", "/tmp/proj", 0)

	if err := run(context.Background(), []string{"flush"}, os.Stdout); err != nil {
		t.Fatalf("flush: %v", err)
	}
	matches, err := filepath.Glob(filepath.Join(shared, "sessions", "a@b.c", "*", "live-*.cms"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 {
		t.Fatalf("a still-running session was not published: %v", matches)
	}
}

// TestFlushRepublishesAGrowingSession is the consequence of dropping the
// idle rule: published files are mutable. A session is published while
// running, its transcript grows, and the next flush must overwrite the
// published file in place — after which a search over the folder finds the
// appended text, because search reads the file rather than a cached copy.
func TestFlushRepublishesAGrowingSession(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	shared := filepath.Join(t.TempDir(), "shared")
	claudeRoot := filepath.Join(t.TempDir(), "claude-projects")
	t.Setenv("COMMONMIND_HOME", home)

	if err := run(context.Background(), []string{
		"init", "--shared", shared, "--author", "a@b.c", "--roots", claudeRoot,
	}, os.Stdout); err != nil {
		t.Fatalf("init: %v", err)
	}
	source := claudeFixture(t, claudeRoot, "-tmp-proj", "growing", "/tmp/proj", 0)

	var first strings.Builder
	if err := run(context.Background(), []string{"flush"}, &first); err != nil {
		t.Fatalf("first flush: %v", err)
	}
	if !strings.Contains(first.String(), "published 1,") {
		t.Fatalf("first flush = %q, want 1 published", first.String())
	}

	// The agent appends another turn to the transcript it is still writing.
	appended := `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"the second turn mentions zeppelins"}]},"timestamp":"2026-09-18T07:20:00.000Z"}` + "\n"
	file, err := os.OpenFile(source, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(appended); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	var second strings.Builder
	if err := run(context.Background(), []string{"flush"}, &second); err != nil {
		t.Fatalf("second flush: %v", err)
	}
	if !strings.Contains(second.String(), "published 1,") {
		t.Fatalf("second flush = %q, want the grown session republished", second.String())
	}

	// Still one file at the same path: republishing replaces, it does not
	// accumulate.
	matches, err := filepath.Glob(filepath.Join(shared, "sessions", "a@b.c", "*", "growing-*.cms"))
	if err != nil || len(matches) != 1 {
		t.Fatalf("published files = %v (%v), want exactly one", matches, err)
	}
	published, err := os.Open(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	rec, err := session.Decode(published)
	published.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rec.Content, "zeppelins") {
		t.Fatal("the published file does not carry the appended turn")
	}

	// And a search over the folder sees the new content, not the old.
	hits, err := store.New(shared).Search(store.Query{Text: "zeppelins", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].SessionID != "growing" {
		t.Fatalf("search for the appended text = %+v, want the growing session", hits)
	}
	count, err := store.New(shared).Count()
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("the folder holds %d sessions, want 1: a republished file must replace the old one", count)
	}
}

func TestFlushSecondRunDoesNotRepublish(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	shared := filepath.Join(t.TempDir(), "shared")
	claudeRoot := filepath.Join(t.TempDir(), "claude-projects")
	t.Setenv("COMMONMIND_HOME", home)

	if err := run(context.Background(), []string{
		"init", "--shared", shared, "--author", "a@b.c", "--roots", claudeRoot,
	}, os.Stdout); err != nil {
		t.Fatalf("init: %v", err)
	}
	claudeFixture(t, claudeRoot, "-tmp-proj", "abc", "/tmp/proj", time.Hour)

	var first strings.Builder
	if err := run(context.Background(), []string{"flush"}, &first); err != nil {
		t.Fatalf("first flush: %v", err)
	}
	if !strings.Contains(first.String(), "published 1,") {
		t.Fatalf("first flush = %q, want 1 published", first.String())
	}

	var second strings.Builder
	if err := run(context.Background(), []string{"flush"}, &second); err != nil {
		t.Fatalf("second flush: %v", err)
	}
	if !strings.Contains(second.String(), "published 0,") {
		t.Fatalf("second flush = %q, want 0 published (re-run must not republish)", second.String())
	}
}

// TestFlushScansOnlyTheRootsInSettings: settings that name no roots mean there
// is nothing to scan, not every session under the home directory.
func TestFlushScansOnlyTheRootsInSettings(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("COMMONMIND_HOME", filepath.Join(home, ".commonmind"))
	shared := filepath.Join(t.TempDir(), "shared")
	if err := store.New(shared).Init(); err != nil {
		t.Fatal(err)
	}
	if err := settings.Save(settings.Settings{SharedDir: shared, Author: "a@b.c"}); err != nil {
		t.Fatal(err)
	}
	claudeFixture(t, filepath.Join(home, ".claude", "projects"), "-tmp-proj", "abc", "/tmp/proj", time.Hour)

	if out := runOut(t, "flush"); !strings.Contains(out, "published 0,") {
		t.Fatalf("flush published from a directory the settings do not name:\n%s", out)
	}
}

// TestStatusProbeDoesNotWriteThroughALink: the probe has a fixed name inside a
// folder teammates can write, so one of them can make it a link to any file.
func TestStatusProbeDoesNotWriteThroughALink(t *testing.T) {
	_, shared, _ := initHome(t, "a@b.c")
	target := filepath.Join(t.TempDir(), "authorized_keys")
	if err := os.WriteFile(target, []byte("ssh-ed25519 mine\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(shared, ".commonmind-write-probe")); err != nil {
		t.Fatal(err)
	}

	out := runOut(t, "status")
	if got, err := os.ReadFile(target); err != nil || string(got) != "ssh-ed25519 mine\n" {
		t.Fatalf("status wrote through the link: %q (%v)", got, err)
	}
	if !strings.Contains(out, "writable: yes") {
		t.Fatalf("status no longer finds the folder writable:\n%s", out)
	}
}

func TestStatusCountsAuthorDirectories(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	shared := filepath.Join(t.TempDir(), "shared")
	emptyRoot := filepath.Join(t.TempDir(), "empty-roots")
	t.Setenv("COMMONMIND_HOME", home)

	if err := run(context.Background(), []string{
		"init", "--shared", shared, "--author", "a@b.c", "--roots", emptyRoot,
	}, os.Stdout); err != nil {
		t.Fatalf("init: %v", err)
	}
	// A replication tool's bookkeeping directory is not an author.
	if err := os.Mkdir(filepath.Join(shared, "sessions", ".stfolder"), 0o755); err != nil {
		t.Fatal(err)
	}

	var out strings.Builder
	if err := run(context.Background(), []string{"status"}, &out); err != nil {
		t.Fatalf("status: %v", err)
	}
	if !strings.Contains(out.String(), "authors visible: 0") {
		t.Fatalf("status counted a dot-entry as an author:\n%s", out.String())
	}

	if err := os.Mkdir(filepath.Join(shared, "sessions", "dana@b.c"), 0o755); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := run(context.Background(), []string{"status"}, &out); err != nil {
		t.Fatalf("status: %v", err)
	}
	if !strings.Contains(out.String(), "authors visible: 1") {
		t.Fatalf("status did not count a real author:\n%s", out.String())
	}
}

// publishAs writes one session file into the shared folder as a teammate
// would, i.e. the way a replication tool delivers one.
func publishAs(t *testing.T, shared, author, sessionID, content string) {
	t.Helper()
	st := store.New(shared)
	if err := st.Init(); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Publish(session.Record{
		Format: session.Format, SessionID: sessionID, Author: author, Agent: "claude",
		CWD: "/tmp/proj", Repo: "proj", SourceFile: sessionID + ".jsonl",
		StartedAt: time.Now().UTC(), EndedAt: time.Now().UTC(),
		ContentHash: "sha256:" + sessionID, Content: content,
	}, "aaaaaaaa"); err != nil {
		t.Fatal(err)
	}
}

// TestFlushAgainstAnUnmountedShareIsRefused: if publishing recreated the
// shared root, one flush against an unmounted share would leave a folder
// holding exactly one local session where the team's whole history should
// be. Publishing refuses instead, and leaves the absent mount point absent,
// so that when the share comes back everyone's sessions are still there.
func TestFlushAgainstAnUnmountedShareIsRefused(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	shared := filepath.Join(t.TempDir(), "shared")
	claudeRoot := filepath.Join(t.TempDir(), "claude-projects")
	t.Setenv("COMMONMIND_HOME", home)

	if err := run(context.Background(), []string{
		"init", "--shared", shared, "--author", "a@b.c", "--roots", claudeRoot,
	}, os.Stdout); err != nil {
		t.Fatalf("init: %v", err)
	}
	publishAs(t, shared, "dana@b.c", "dana-one", "the ingress controller was misconfigured")
	publishAs(t, shared, "erin@b.c", "erin-one", "the ingress controller was fine")

	var before strings.Builder
	if err := run(context.Background(), []string{"status"}, &before); err != nil {
		t.Fatalf("status: %v", err)
	}
	if !strings.Contains(before.String(), "sessions in the shared folder: 2") {
		t.Fatalf("setup did not publish both teammates:\n%s", before.String())
	}

	// The NAS goes away, and a local session of mine becomes publishable.
	unmounted := shared + "-elsewhere"
	if err := os.Rename(shared, unmounted); err != nil {
		t.Fatal(err)
	}
	claudeFixture(t, claudeRoot, "-tmp-proj", "mine", "/tmp/proj", time.Hour)

	if err := run(context.Background(), []string{"flush"}, os.Stdout); err == nil {
		t.Fatal("flush against an unmounted share should report an error")
	}
	if _, err := os.Stat(shared); !os.IsNotExist(err) {
		t.Fatalf("flush recreated the shared folder: %v", err)
	}

	// The mount comes back, with every teammate's session still in it.
	if err := os.Rename(unmounted, shared); err != nil {
		t.Fatal(err)
	}
	var after strings.Builder
	if err := run(context.Background(), []string{"status"}, &after); err != nil {
		t.Fatalf("status: %v", err)
	}
	if !strings.Contains(after.String(), "sessions in the shared folder: 2") {
		t.Fatalf("teammates' sessions went missing:\n%s", after.String())
	}
}
