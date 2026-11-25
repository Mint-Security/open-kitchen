package scan

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func touch(t *testing.T, path string, age time.Duration) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}
	when := time.Now().Add(-age)
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatal(err)
	}
}

// TestListIncludesAFileWrittenAMomentAgo pins the absence of an idle rule:
// a transcript an agent is appending to right now is a candidate like any
// other.
func TestListIncludesAFileWrittenAMomentAgo(t *testing.T) {
	root := t.TempDir()
	touch(t, filepath.Join(root, "proj", "quiet.jsonl"), time.Hour)
	touch(t, filepath.Join(root, "proj", "live.jsonl"), 0)

	got, err := List([]string{root}, time.Now().Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("List = %+v, want both the quiet and the live session", got)
	}
}

func TestListSinceBoundary(t *testing.T) {
	root := t.TempDir()
	touch(t, filepath.Join(root, "proj", "recent.jsonl"), 24*time.Hour)
	touch(t, filepath.Join(root, "proj", "ancient.jsonl"), 20*24*time.Hour)

	got, err := List([]string{root}, time.Now().Add(-48*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].SessionID != "recent" {
		t.Fatalf("List = %+v, want only the session inside the --since window", got)
	}
}

func TestListMissingRootIsNotAnError(t *testing.T) {
	got, err := List([]string{filepath.Join(t.TempDir(), "does-not-exist")}, time.Time{})
	if err != nil {
		t.Fatalf("List returned an error for a missing root: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("List = %+v, want empty", got)
	}
}

func TestListUnrecognizedRootYieldsNoCandidatesNoError(t *testing.T) {
	root := t.TempDir()
	touch(t, filepath.Join(root, "not-a-session-tree.txt"), time.Hour)

	got, err := List([]string{root}, time.Now().Add(-24*time.Hour))
	if err != nil {
		t.Fatalf("List returned an error for a root matching neither layout: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("List = %+v, want empty", got)
	}
}

func TestParseWindowSupportsDaySuffix(t *testing.T) {
	d, err := ParseWindow("14d")
	if err != nil {
		t.Fatal(err)
	}
	if d != 14*24*time.Hour {
		t.Fatalf("ParseWindow(14d) = %v, want %v", d, 14*24*time.Hour)
	}
}

func TestParseWindowSupportsStandardDurations(t *testing.T) {
	d, err := ParseWindow("30m")
	if err != nil {
		t.Fatal(err)
	}
	if d != 30*time.Minute {
		t.Fatalf("ParseWindow(30m) = %v, want 30m", d)
	}
}
