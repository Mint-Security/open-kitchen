package scan

import (
	"path/filepath"
	"testing"
	"time"
)

func TestListCodexRolloutFiles(t *testing.T) {
	root := filepath.Join(t.TempDir(), "codex", "sessions")
	sessionID := "0198e3c1-abcd-4ef0-9a12-abcdef123456"
	touch(t, filepath.Join(root, "2026", "09", "18", "rollout-2026-09-18T07-12-03-"+sessionID+".jsonl"), time.Hour)
	// A non-rollout file in the same date directory must not be picked up.
	touch(t, filepath.Join(root, "2026", "09", "18", "notes.jsonl"), time.Hour)

	now := time.Now()
	got, err := List([]string{root}, now.Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("List returned %d candidates, want 1: %+v", len(got), got)
	}
	if got[0].Agent != Codex {
		t.Fatalf("Agent = %q, want codex", got[0].Agent)
	}
	if got[0].SessionID != sessionID {
		t.Fatalf("SessionID = %q, want %q", got[0].SessionID, sessionID)
	}
}

func TestListCodexShapedRootWithoutCodexInNameIsRecognized(t *testing.T) {
	// A Codex root need not be named conventionally; shape recognition must
	// find it even though the path contains no "codex" substring.
	root := filepath.Join(t.TempDir(), "backup", "sessions")
	sessionID := "0198e3c1-abcd-4ef0-9a12-abcdef123456"
	touch(t, filepath.Join(root, "2026", "09", "18", "rollout-2026-09-18T07-12-03-"+sessionID+".jsonl"), time.Hour)

	now := time.Now()
	got, err := List([]string{root}, now.Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Agent != Codex || got[0].SessionID != sessionID {
		t.Fatalf("List = %+v, want one Codex candidate with id %q", got, sessionID)
	}
}
