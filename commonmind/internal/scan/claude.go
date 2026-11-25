package scan

import (
	"os"
	"strings"
)

// claudeLayout knows "~/.claude/projects": one directory per project, each
// holding session files directly.
type claudeLayout struct{}

func (claudeLayout) Agent() Agent { return Claude }

// Recognizes reports whether root holds at least one project directory with
// a *.jsonl file directly inside it.
func (l claudeLayout) Recognizes(root string) bool {
	found := false
	listDir(root, isClaudeProjectDir, func(projectPath string, _ os.DirEntry) {
		if found {
			return
		}
		listDir(projectPath, isSessionFile, func(string, os.DirEntry) {
			found = true
		})
	})
	return found
}

// Candidates walks "<root>/<project-dir>/<session-uuid>.jsonl". Only files
// directly inside a project directory count as a session: "subagents/" and
// "tool-results/" subdirectories hold auxiliary material, not sessions.
func (l claudeLayout) Candidates(root string) ([]Candidate, error) {
	if _, err := os.Stat(root); err != nil {
		return nil, err
	}
	var out []Candidate
	listDir(root, isClaudeProjectDir, func(projectPath string, _ os.DirEntry) {
		listDir(projectPath, isSessionFile, func(path string, f os.DirEntry) {
			info, err := f.Info()
			if err != nil {
				return
			}
			out = append(out, Candidate{
				Path:      path,
				Agent:     Claude,
				SessionID: strings.TrimSuffix(f.Name(), ".jsonl"),
				ModTime:   info.ModTime(),
				Size:      info.Size(),
			})
		})
	})
	return out, nil
}

func isClaudeProjectDir(e os.DirEntry) bool {
	name := e.Name()
	if !e.IsDir() || strings.HasPrefix(name, ".") {
		return false
	}
	return name != "subagents" && name != "tool-results"
}

func isSessionFile(e os.DirEntry) bool {
	return !e.IsDir() && strings.HasSuffix(e.Name(), ".jsonl")
}
