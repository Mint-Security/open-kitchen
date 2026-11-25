package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/session"
)

const testSourceHash = "deadbeef"

// newStore returns a store over an initialized shared folder. Publish
// refuses a folder whose sessions directory is missing (that is what an
// unmounted share looks like), so every test that publishes needs the
// directory `init` would have created.
func newStore(t *testing.T, root string) *Store {
	t.Helper()
	s := New(root)
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	return s
}

func record() session.Record {
	started := time.Date(2026, 9, 18, 7, 12, 3, 0, time.UTC)
	return session.Record{
		Format: session.Format, SessionID: "abc123", Author: "a@b.c", Agent: "claude",
		CWD: "/tmp/proj", Repo: "proj", SourceFile: "abc123.jsonl",
		StartedAt: started, EndedAt: started.Add(time.Hour),
		ContentHash: "sha256:one", Content: "the transcript",
	}
}

func TestPathLayout(t *testing.T) {
	s := New("/shared")
	got := s.Path(record(), testSourceHash)
	want := filepath.Join("/shared", "sessions", "a@b.c", "2026-09-18", "abc123-deadbeef.cms")
	if got != want {
		t.Fatalf("Path = %q, want %q", got, want)
	}
}

func TestPublishWritesDecodableFile(t *testing.T) {
	root := t.TempDir()
	s := newStore(t, root)
	written, err := s.Publish(record(), testSourceHash)
	if err != nil || !written {
		t.Fatalf("Publish = %v, %v", written, err)
	}
	file, err := os.Open(s.Path(record(), testSourceHash))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	got, err := session.Decode(file)
	if err != nil {
		t.Fatalf("decode published file: %v", err)
	}
	if got.Content != "the transcript" {
		t.Fatalf("content = %q", got.Content)
	}
	if got.PublishedAt.IsZero() {
		t.Fatal("PublishedAt was not stamped")
	}
}

func TestPublishIsIdempotentForSameHash(t *testing.T) {
	root := t.TempDir()
	s := newStore(t, root)
	if _, err := s.Publish(record(), testSourceHash); err != nil {
		t.Fatal(err)
	}
	written, err := s.Publish(record(), testSourceHash)
	if err != nil {
		t.Fatal(err)
	}
	if written {
		t.Fatal("second publish of an identical record should not rewrite the file")
	}
}

func TestPublishLeavesNoTempFiles(t *testing.T) {
	root := t.TempDir()
	s := newStore(t, root)
	if _, err := s.Publish(record(), testSourceHash); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(HostTempDir(root))
	if err != nil {
		t.Fatalf("temp dir should exist: %v", err)
	}
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), ".") {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}
}

// TestSameSessionIDDifferentSourceFilesBothSurvive is the regression test
// for a resumed/forked Claude Code session: a new transcript file keeps the
// original session_id, so two distinct source files can carry the same
// session_id. Before the fix, Path was keyed by session id alone and the
// second Publish silently replaced the first's file.
func TestSameSessionIDDifferentSourceFilesBothSurvive(t *testing.T) {
	root := t.TempDir()
	s := newStore(t, root)

	first := record()
	first.ContentHash = "sha256:first"
	first.Content = "the original session"
	first.SourceFile = "952bd709-5fa4-4745-bf43-6b7069d0c5a7.jsonl"

	second := record()
	second.ContentHash = "sha256:second"
	second.Content = "the resumed session"
	second.SourceFile = "ac7e3feb-6296-4d22-8fff-1009e2ecca8b.jsonl"

	if _, err := s.Publish(first, "aaaaaaaa"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Publish(second, "bbbbbbbb"); err != nil {
		t.Fatal(err)
	}

	matches, err := filepath.Glob(filepath.Join(root, "sessions", "a@b.c", "*", "abc123-*.cms"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 2 {
		t.Fatalf("published files for the colliding session id = %v, want 2 distinct files", matches)
	}

	var contents []string
	for _, path := range matches {
		file, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		rec, err := session.Decode(file)
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
		contents = append(contents, rec.Content)
	}
	if !(contents[0] == "the original session" || contents[1] == "the original session") ||
		!(contents[0] == "the resumed session" || contents[1] == "the resumed session") {
		t.Fatalf("one session's content was lost: %v", contents)
	}
}

// TestOverwriteBranchFiresOnChangedContentForSameSourceFile documents the
// overwrite branch in Publish, which is the ordinary path now that running
// sessions are published: the same source file, republished with more
// transcript, replaces the old file at its (still identical) path.
func TestOverwriteBranchFiresOnChangedContentForSameSourceFile(t *testing.T) {
	root := t.TempDir()
	s := newStore(t, root)

	rec := record()
	rec.ContentHash = "sha256:v1"
	rec.Content = "first pass"
	if _, err := s.Publish(rec, testSourceHash); err != nil {
		t.Fatal(err)
	}

	rec.ContentHash = "sha256:v2"
	rec.Content = "second pass, the session has grown since"
	written, err := s.Publish(rec, testSourceHash)
	if err != nil {
		t.Fatal(err)
	}
	if !written {
		t.Fatal("republishing the same source file with changed content should overwrite")
	}

	file, err := os.Open(s.Path(rec, testSourceHash))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	got, err := session.Decode(file)
	if err != nil {
		t.Fatal(err)
	}
	if got.Content != "second pass, the session has grown since" {
		t.Fatalf("content = %q, want the updated content", got.Content)
	}
}

// TestPublishRefusesWhenSessionsDirIsMissing is the unmounted-share case:
// recreating the shared root here is what let a single local publish make an
// absent NAS look like a live, nearly-empty folder.
func TestPublishRefusesWhenSessionsDirIsMissing(t *testing.T) {
	root := filepath.Join(t.TempDir(), "not-mounted")
	s := New(root)
	written, err := s.Publish(record(), testSourceHash)
	if !errors.Is(err, ErrNoSessionsDir) {
		t.Fatalf("Publish = %v, %v; want ErrNoSessionsDir", written, err)
	}
	if !strings.Contains(err.Error(), filepath.Join(root, SessionsDir)) {
		t.Fatalf("error does not name the missing path: %v", err)
	}
	if _, statErr := os.Stat(root); !os.IsNotExist(statErr) {
		t.Fatal("Publish recreated the shared root")
	}
}

func TestInitCreatesSessionsDirSoPublishWorks(t *testing.T) {
	root := t.TempDir()
	s := New(root)
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Publish(record(), testSourceHash); err != nil {
		t.Fatalf("publish after Init: %v", err)
	}
}

func TestPublishRejectsPathSeparatorsInAuthorAndSessionID(t *testing.T) {
	root := t.TempDir()
	s := newStore(t, root)

	escaping := record()
	escaping.Author = "../../etc"
	if _, err := s.Publish(escaping, testSourceHash); err == nil {
		t.Fatal("an author holding a path separator was accepted")
	}

	escaping = record()
	escaping.SessionID = "../../../tmp/evil"
	if _, err := s.Publish(escaping, testSourceHash); err == nil {
		t.Fatal("a session id holding a path separator was accepted")
	}
}

func TestTempDirIsNamespacedPerHost(t *testing.T) {
	root := t.TempDir()
	if got := HostTempDir(root); filepath.Dir(got) != filepath.Join(root, TempDirName) {
		t.Fatalf("HostTempDir = %q, want a subdirectory of %q", got, filepath.Join(root, TempDirName))
	}
	if filepath.Base(HostTempDir(root)) == "" {
		t.Fatal("HostTempDir has no host segment")
	}
}
