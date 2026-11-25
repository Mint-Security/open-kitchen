package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// initHome sets up a commonmind home, a shared folder and a Claude Code
// session root, and returns all three.
func initHome(t *testing.T, author string) (home, shared, claudeRoot string) {
	t.Helper()
	home = filepath.Join(t.TempDir(), "home")
	shared = filepath.Join(t.TempDir(), "shared")
	claudeRoot = filepath.Join(t.TempDir(), "claude-projects")
	t.Setenv("COMMONMIND_HOME", home)
	if err := run(context.Background(), []string{
		"init", "--shared", shared, "--author", author, "--roots", claudeRoot,
	}, os.Stdout); err != nil {
		t.Fatalf("init: %v", err)
	}
	return home, shared, claudeRoot
}

func publishedFiles(t *testing.T, shared, author, sessionID string) []string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(shared, "sessions", author, "*", sessionID+"-*.cms"))
	if err != nil {
		t.Fatal(err)
	}
	return matches
}

func runOut(t *testing.T, args ...string) string {
	t.Helper()
	var out strings.Builder
	if err := run(context.Background(), args, &out); err != nil {
		t.Fatalf("%v: %v (output: %s)", args, err, out.String())
	}
	return out.String()
}

// TestDeletedPublishedFileStaysDeleted is the core regression. Removing a
// published file is a deliberate act, and the local ledger is what lets the
// next flush tell that apart from a file that was never published: the
// session must not come back, and it must not stay searchable.
func TestDeletedPublishedFileStaysDeleted(t *testing.T) {
	_, shared, claudeRoot := initHome(t, "a@b.c")
	claudeFixture(t, claudeRoot, "-tmp-proj", "abc", "/tmp/proj", time.Hour)

	runOut(t, "flush")
	files := publishedFiles(t, shared, "a@b.c", "abc")
	if len(files) != 1 {
		t.Fatalf("published files = %v, want 1", files)
	}
	if err := os.Remove(files[0]); err != nil {
		t.Fatal(err)
	}

	out := runOut(t, "flush")
	if !strings.Contains(out, "published 0") {
		t.Fatalf("a deleted session was republished: %s", out)
	}
	if !strings.Contains(out, "skipped-deleted 1") {
		t.Fatalf("flush did not report the deliberate deletion: %s", out)
	}
	if got := publishedFiles(t, shared, "a@b.c", "abc"); len(got) != 0 {
		t.Fatalf("the deleted session came back: %v", got)
	}
	if status := runOut(t, "status"); !strings.Contains(status, "sessions in the shared folder: 0") {
		t.Fatalf("the shared folder still holds the deleted session:\n%s", status)
	}
}

// TestWipedLedgerRepublishesADeletedSession pins the one real limit of
// doing this locally rather than with a marker in the shared folder: the
// ledger is per-machine, so wiping ~/.commonmind — or setting the tool up on
// a second machine against the same transcripts — brings a deleted session
// back. This is documented behaviour, not a bug, and the README says so.
func TestWipedLedgerRepublishesADeletedSession(t *testing.T) {
	home, shared, claudeRoot := initHome(t, "a@b.c")
	claudeFixture(t, claudeRoot, "-tmp-proj", "abc", "/tmp/proj", time.Hour)

	runOut(t, "flush")
	files := publishedFiles(t, shared, "a@b.c", "abc")
	if len(files) != 1 {
		t.Fatalf("published files = %v, want 1", files)
	}
	if err := os.Remove(files[0]); err != nil {
		t.Fatal(err)
	}
	if out := runOut(t, "flush"); !strings.Contains(out, "published 0") {
		t.Fatalf("setup: the deletion did not hold: %s", out)
	}

	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Remove(filepath.Join(home, "published.db"+suffix)); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	}

	if out := runOut(t, "flush"); !strings.Contains(out, "published 1") {
		t.Fatalf("a wiped ledger was expected to republish the session: %s", out)
	}
	if got := publishedFiles(t, shared, "a@b.c", "abc"); len(got) != 1 {
		t.Fatalf("published files after the ledger was wiped = %v, want 1", got)
	}
}

// TestBulkDeletionJustWorks: with no index or cache to protect, a large
// deletion is only a smaller folder. The next flush reports the files as
// deliberately deleted and does not republish them.
func TestBulkDeletionJustWorks(t *testing.T) {
	_, shared, claudeRoot := initHome(t, "a@b.c")
	for i := 0; i < 12; i++ {
		claudeFixture(t, claudeRoot, "-tmp-proj", fmt.Sprintf("s-%02d", i), "/tmp/proj", time.Hour)
	}
	if out := runOut(t, "flush"); !strings.Contains(out, "published 12") {
		t.Fatalf("setup flush: %s", out)
	}

	for i := 0; i < 10; i++ {
		files := publishedFiles(t, shared, "a@b.c", fmt.Sprintf("s-%02d", i))
		if len(files) != 1 {
			t.Fatalf("published files for s-%02d = %v", i, files)
		}
		if err := os.Remove(files[0]); err != nil {
			t.Fatal(err)
		}
	}

	if out := runOut(t, "flush"); !strings.Contains(out, "published 0") || !strings.Contains(out, "skipped-deleted 10") {
		t.Fatalf("a 10-of-12 deletion should be ordinary now: %s", out)
	}
	if status := runOut(t, "status"); !strings.Contains(status, "sessions in the shared folder: 2") {
		t.Fatalf("status after the deletion:\n%s", status)
	}
}
