package publish

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// writeRecords writes a Claude Code transcript with one record per cwd, in
// order. An empty cwd writes a record that carries none.
func writeRecords(t *testing.T, root, id string, cwds ...string) {
	t.Helper()
	dir := filepath.Join(root, "-project")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, cwd := range cwds {
		line := `{"type":"user","sessionId":"` + id + `","timestamp":"2026-09-18T07:12:03.000Z"`
		if cwd != "" {
			line += `,"cwd":"` + filepath.ToSlash(cwd) + `"`
		}
		lines = append(lines, line+`}`)
	}
	if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestMalformedExcludePatternNeverPublishesTheSession: settings.json is
// documented as hand-editable, so a pattern that cannot be parsed can reach a
// flush whatever init checks. Publishing has to fail closed on it: a session
// is shared raw and unredacted, and the pattern was there to stop that.
func TestMalformedExcludePatternNeverPublishesTheSession(t *testing.T) {
	for _, pattern := range []string{"/work/[clients", "/work/*/[clients", "/work/private-*["} {
		root := t.TempDir()
		st, led := newStore(t, t.TempDir())
		writeSession(t, root, "-work-clients", "abc", "/work/clients", time.Hour)

		opts := defaultOpts(root)
		opts.Exclude = []string{pattern}
		n, _, _, err := Run(context.Background(), st, led, "a@b.c", opts)
		if n != 0 || len(published(t, st, "a@b.c", "abc")) != 0 {
			t.Errorf("%q: published %d session(s) past an exclusion that could not be parsed", pattern, n)
		}
		if err == nil {
			t.Errorf("%q: a malformed exclusion was ignored without an error", pattern)
		}
	}
}

// TestExcludePatternCoversTheDirectoryAndEverythingBelow pins what a pattern
// is: a glob, in which * stops at a path separator, that excludes the
// directory it matches and everything below it. Agents start sessions in
// subdirectories and in worktrees under the repository.
func TestExcludePatternCoversTheDirectoryAndEverythingBelow(t *testing.T) {
	for _, tc := range []struct {
		pattern, cwd string
		excluded     bool
	}{
		{"/work/private-*", "/work/private-acme", true},
		{"/work/private-*", "/work/private-acme/api", true},
		{"/work/private", "/work/private/.claude/worktrees/task", true},
		{"/work/private/", "/work/private", true},
		{"/work/private", "/work/private-acme", false},
		{"/work/private", "/work", false},
		{"*/private/*", "/work/private/api", false},
	} {
		if got := isExcluded(tc.cwd, []string{tc.pattern}); got != tc.excluded {
			t.Errorf("isExcluded(%q, %q) = %t; want %t", tc.cwd, tc.pattern, got, tc.excluded)
		}
	}
}

// TestRecordedCWDsReadsKeysNotText: a cwd quoted inside a message is text the
// agent saw, and must neither count as a directory nor hide a later one.
func TestRecordedCWDsReadsKeysNotText(t *testing.T) {
	raw := []byte(`{"cwd":"/work","message":{"content":"he said \"cwd\":\"/in/text\""}}` + "\n" +
		`{"payload":{"cwd" : "/work/a \"b\" \\ c"}}` + "\n" +
		`{"cwd":"/work"}` + "\n" + `{"cwd":7}` + "\n" + `{"cwd":"/torn`)
	want := []string{"/work", `/work/a "b" \ c`}
	if got := recordedCWDs(raw); !slices.Equal(got, want) {
		t.Fatalf("recordedCWDs = %q; want %q", got, want)
	}
}

// TestSessionThatEntersAnExcludedDirectoryIsNotPublished: a session records a
// cwd on every line, and it often starts above the directory it then works in.
func TestSessionThatEntersAnExcludedDirectoryIsNotPublished(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())
	writeRecords(t, root, "moved", "/work", "/work/private/api")

	opts := defaultOpts(root)
	opts.Exclude = []string{"/work/private"}
	if n, _, _, err := Run(context.Background(), st, led, "a@b.c", opts); err != nil || n != 0 {
		t.Fatalf("published %d (err %v); the session went on to work in an excluded directory", n, err)
	}
}

// TestExcludedSessionStaysExcluded: an untracked .commonmind-ignore is one git
// clean away from gone, and a session it kept back is shared raw the moment a
// scan misses it. Like a deletion, an exclusion this machine acted on stands.
func TestExcludedSessionStaysExcluded(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())
	repo := t.TempDir()
	ignore := filepath.Join(repo, ignoreFileName)
	if err := os.WriteFile(ignore, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	writeRecords(t, root, "kept-back", repo)

	for _, step := range []string{"with the ignore file", "after the ignore file is gone"} {
		if n, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root)); err != nil || n != 0 {
			t.Fatalf("%s: published %d (err %v)", step, n, err)
		}
		_ = os.Remove(ignore)
	}
}

// TestSessionWithNoWorkingDirectoryIsHeldBackByAnExclusion: with nothing to
// match the patterns against, publishing would be a guess that the session
// ran somewhere else. Without exclusions it is published as before.
func TestSessionWithNoWorkingDirectoryIsHeldBackByAnExclusion(t *testing.T) {
	root := t.TempDir()
	st, led := newStore(t, t.TempDir())
	writeRecords(t, root, "nowhere", "")

	opts := defaultOpts(root)
	opts.Exclude = []string{"/work/private"}
	if n, _, _, err := Run(context.Background(), st, led, "a@b.c", opts); err != nil || n != 0 {
		t.Fatalf("published %d (err %v) with an exclusion that could not be checked", n, err)
	}
	if n, _, _, err := Run(context.Background(), st, led, "a@b.c", defaultOpts(root)); err != nil || n != 1 {
		t.Fatalf("published %d (err %v) with no exclusions; want 1", n, err)
	}
}

func TestOnlyAbsoluteExcludePatternsAreAccepted(t *testing.T) {
	for _, pattern := range []string{"/Users/dana/private-*", "/home/*/secret", "/"} {
		if err := ValidateExclude([]string{pattern}); err != nil {
			t.Errorf("%q refused: %v", pattern, err)
		}
	}
	// A recorded working directory is always absolute, so none of these could match one.
	for _, pattern := range []string{"private-*", "~/private", "./secret", "projects/*", "*"} {
		if err := ValidateExclude([]string{pattern}); err == nil {
			t.Errorf("%q accepted", pattern)
		}
	}
}
