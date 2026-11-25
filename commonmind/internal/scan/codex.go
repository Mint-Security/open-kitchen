package scan

import (
	"os"
	"regexp"
	"strings"
)

// codexLayout knows "~/.codex/sessions": rollout files nested three levels
// deep by date, "<root>/<yyyy>/<mm>/<dd>/rollout-*.jsonl".
type codexLayout struct{}

func (codexLayout) Agent() Agent { return Codex }

// codexRolloutName matches Codex's rollout file naming, e.g.
// "rollout-2026-09-18T07-12-03-0198e3c1-abcd-4ef0-9a12-abcdef123456.jsonl".
// The session id is the trailing UUID; a session that was resumed reuses the
// same UUID across multiple rollout files with different timestamps.
var codexRolloutName = regexp.MustCompile(`^rollout-.*-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$`)

// Recognizes reports whether root holds the yyyy/mm/dd nesting with at least
// one rollout file at the leaf.
func (l codexLayout) Recognizes(root string) bool {
	found := false
	forEachDateDir(root, func(dayPath string) {
		if found {
			return
		}
		listDir(dayPath, isRolloutFile, func(string, os.DirEntry) {
			found = true
		})
	})
	return found
}

// Candidates walks "<root>/<yyyy>/<mm>/<dd>/rollout-*.jsonl".
func (l codexLayout) Candidates(root string) ([]Candidate, error) {
	if _, err := os.Stat(root); err != nil {
		return nil, err
	}
	var out []Candidate
	forEachDateDir(root, func(dayPath string) {
		listDir(dayPath, isRolloutFile, func(path string, f os.DirEntry) {
			info, err := f.Info()
			if err != nil {
				return
			}
			out = append(out, Candidate{
				Path:      path,
				Agent:     Codex,
				SessionID: codexSessionID(f.Name()),
				ModTime:   info.ModTime(),
				Size:      info.Size(),
			})
		})
	})
	return out, nil
}

// forEachDateDir visits every "<root>/<yyyy>/<mm>/<dd>" directory that
// exists under root.
func forEachDateDir(root string, visit func(dayPath string)) {
	listDir(root, isNumericDir, func(yPath string, _ os.DirEntry) {
		listDir(yPath, isNumericDir, func(mPath string, _ os.DirEntry) {
			listDir(mPath, isNumericDir, func(dPath string, _ os.DirEntry) {
				visit(dPath)
			})
		})
	})
}

func isNumericDir(e os.DirEntry) bool {
	if !e.IsDir() {
		return false
	}
	return isNumeric(e.Name())
}

func isNumeric(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func isRolloutFile(e os.DirEntry) bool {
	return !e.IsDir() && strings.HasPrefix(e.Name(), "rollout-") && strings.HasSuffix(e.Name(), ".jsonl")
}

func codexSessionID(name string) string {
	if m := codexRolloutName.FindStringSubmatch(name); len(m) == 2 {
		return m[1]
	}
	return strings.TrimSuffix(strings.TrimPrefix(name, "rollout-"), ".jsonl")
}
