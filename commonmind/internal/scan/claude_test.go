package scan

import (
	"path/filepath"
	"testing"
	"time"
)

func TestListClaudeSkipsSubagentsAndToolResults(t *testing.T) {
	root := t.TempDir()
	touch(t, filepath.Join(root, "-Users-x-proj", "session-1.jsonl"), time.Hour)
	touch(t, filepath.Join(root, "-Users-x-proj", "subagents", "session-2.jsonl"), time.Hour)
	touch(t, filepath.Join(root, "-Users-x-proj", "tool-results", "session-3.jsonl"), time.Hour)

	now := time.Now()
	got, err := List([]string{root}, now.Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("List returned %d candidates, want 1 (subagents/tool-results must be skipped): %+v", len(got), got)
	}
	if got[0].SessionID != "session-1" {
		t.Fatalf("SessionID = %q, want session-1", got[0].SessionID)
	}
	if got[0].Agent != Claude {
		t.Fatalf("Agent = %q, want claude", got[0].Agent)
	}
}

func TestListClaudeShapedRootNamedLikeCodexIsRecognizedAsClaude(t *testing.T) {
	// A Claude root can live at a path that happens to contain "codex";
	// shape, not name, must decide.
	root := filepath.Join(t.TempDir(), "codex-backup")
	touch(t, filepath.Join(root, "-Users-x-proj", "session-1.jsonl"), time.Hour)

	now := time.Now()
	got, err := List([]string{root}, now.Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Agent != Claude {
		t.Fatalf("List = %+v, want one Claude candidate", got)
	}
}
