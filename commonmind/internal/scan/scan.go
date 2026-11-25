// Package scan finds candidate agent session files under a set of root
// directories. It never reads the file contents — only path shape, name and
// stat info — so it stays cheap to run over a whole home directory on every
// flush.
package scan

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Agent identifies which coding agent wrote a session file.
type Agent string

const (
	Claude Agent = "claude"
	Codex  Agent = "codex"
)

// Candidate is one session file found under a root, before it has been read.
type Candidate struct {
	Path      string
	Agent     Agent
	SessionID string
	ModTime   time.Time
	Size      int64
}

// A Layout knows how one coding agent stores its session transcripts.
type Layout interface {
	// Agent names the agent this layout belongs to.
	Agent() Agent
	// Recognizes reports whether root looks like this layout's directory
	// shape, so a custom root does not have to be named conventionally.
	Recognizes(root string) bool
	// Candidates returns every session file under root, without reading
	// any file's contents.
	Candidates(root string) ([]Candidate, error)
}

var layouts = []Layout{claudeLayout{}, codexLayout{}}

// List walks roots and returns every candidate last modified no earlier
// than since. A session that is still being written to is included: nothing
// here asks whether an agent has stopped appending.
//
// A missing root is not an error — a machine may only have one of the two
// agents installed.
func List(roots []string, since time.Time) ([]Candidate, error) {
	var all []Candidate
	for _, root := range roots {
		if root == "" {
			continue
		}
		found, err := listRoot(root)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, fmt.Errorf("scan %s: %w", root, err)
		}
		all = append(all, found...)
	}

	out := make([]Candidate, 0, len(all))
	for _, c := range all {
		if c.ModTime.Before(since) {
			continue
		}
		out = append(out, c)
	}
	return out, nil
}

// listRoot resolves root to the layout whose directory shape it matches. If
// none recognizes it (e.g. the root doesn't exist yet, or is empty), it
// falls back to the name hint so a correctly-named but currently-empty root
// still resolves to the right layout instead of silently matching none.
func listRoot(root string) ([]Candidate, error) {
	for _, l := range layouts {
		if l.Recognizes(root) {
			return l.Candidates(root)
		}
	}
	for _, l := range layouts {
		if agentNameHint(root) == l.Agent() {
			return l.Candidates(root)
		}
	}
	return nil, nil
}

func agentNameHint(root string) Agent {
	if strings.Contains(strings.ToLower(filepath.ToSlash(root)), "codex") {
		return Codex
	}
	return Claude
}

// listDir reads a directory, skipping entries that don't pass keep, and
// hands each surviving entry's path and os.DirEntry to visit. A missing or
// unreadable directory yields no entries rather than an error, since a
// layout may probe several nesting levels that don't exist for every root.
func listDir(dir string, keep func(os.DirEntry) bool, visit func(path string, entry os.DirEntry)) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !keep(e) {
			continue
		}
		visit(filepath.Join(dir, e.Name()), e)
	}
}

// ParseWindow parses a duration with an additional "d" (days) unit on top of
// what time.ParseDuration accepts, so CLI flags can say "14d".
func ParseWindow(value string) (time.Duration, error) {
	value = strings.TrimSpace(value)
	if strings.HasSuffix(value, "d") {
		days, err := strconv.ParseFloat(strings.TrimSuffix(value, "d"), 64)
		if err != nil {
			return 0, fmt.Errorf("invalid duration %q: %w", value, err)
		}
		return time.Duration(days * float64(24*time.Hour)), nil
	}
	d, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("invalid duration %q: %w", value, err)
	}
	return d, nil
}
