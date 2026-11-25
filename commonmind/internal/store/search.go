package store

import (
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/session"
)

const (
	DefaultSearchLimit = 20
	MaxSearchLimit     = 100

	dayLayout = "2006-01-02"
)

// Query is one search. Text is matched against the transcript; the other
// fields are metadata filters. Author and the start day are read off the
// published path (<author>/<day>/<session>.cms), so filtering on them opens
// no file outside the selection. An empty Query matches nothing.
type Query struct {
	Text          string    // case-insensitive substring of the transcript
	Author        string    // case-insensitive substring of the author id
	ExcludeAuthor string    // case-insensitive substring of an author id to leave out
	Repo          string    // case-insensitive substring of the repo name or the cwd
	Agent         string    // "claude", "codex", ...
	Since         time.Time // StartedAt >= Since
	Until         time.Time // StartedAt < Until
	Limit         int
}

func (q Query) IsEmpty() bool {
	return strings.TrimSpace(q.Text) == "" && strings.TrimSpace(q.Author) == "" &&
		strings.TrimSpace(q.ExcludeAuthor) == "" &&
		strings.TrimSpace(q.Repo) == "" && strings.TrimSpace(q.Agent) == "" &&
		q.Since.IsZero() && q.Until.IsZero()
}

type Hit struct {
	Path         string
	SessionID    string
	Author       string
	Agent        string
	CWD          string
	Repo         string
	AgentVersion string
	StartedAt    time.Time
	EndedAt      time.Time
}

type Author struct {
	Name      string
	Sessions  int
	LatestDay string // newest day directory, YYYY-MM-DD; empty if none
}

// Search returns matching sessions newest first. Day directories are
// visited newest first and the walk stops once a day's matches fill the
// limit, so older files are never opened.
func (s *Store) Search(q Query) ([]Hit, error) {
	if q.IsEmpty() {
		return nil, nil
	}
	limit := q.Limit
	if limit <= 0 {
		limit = DefaultSearchLimit
	}
	if limit > MaxSearchLimit {
		limit = MaxSearchLimit
	}
	buckets, err := s.dayBuckets(q)
	if err != nil {
		return nil, err
	}
	needle := strings.ToLower(strings.TrimSpace(q.Text))
	hits := make([]Hit, 0, limit)
	for _, dirs := range buckets {
		found, err := s.scanDirs(dirs, q, needle)
		if err != nil {
			return nil, err
		}
		sort.Slice(found, func(i, j int) bool {
			if !found[i].StartedAt.Equal(found[j].StartedAt) {
				return found[i].StartedAt.After(found[j].StartedAt)
			}
			return found[i].SessionID < found[j].SessionID
		})
		hits = append(hits, found...)
		if len(hits) >= limit {
			return hits[:limit], nil
		}
	}
	return hits, nil
}

// Authors lists who publishes into the folder, most recently active first.
// It reads directory entries only.
func (s *Store) Authors() ([]Author, error) {
	root := s.SessionsPath()
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var authors []Author
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		author := Author{Name: entry.Name()}
		_ = walkSessions(filepath.Join(root, entry.Name()), func(path string, _ fs.DirEntry) error {
			author.Sessions++
			if day := filepath.Base(filepath.Dir(path)); isDay(day) && day > author.LatestDay {
				author.LatestDay = day
			}
			return nil
		})
		authors = append(authors, author)
	}
	sort.Slice(authors, func(i, j int) bool {
		if authors[i].LatestDay != authors[j].LatestDay {
			return authors[i].LatestDay > authors[j].LatestDay
		}
		return authors[i].Name < authors[j].Name
	})
	return authors, nil
}

// dayBuckets returns the directories to search grouped by start day, newest
// first, with the author filters and date window already applied to the
// directory names. A directory not named for a day holds no sessions.
func (s *Store) dayBuckets(q Query) ([][]string, error) {
	root := s.SessionsPath()
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	author := strings.ToLower(strings.TrimSpace(q.Author))
	excluded := strings.ToLower(strings.TrimSpace(q.ExcludeAuthor))
	byDay := map[string][]string{}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		if author != "" && !containsFold(entry.Name(), author) {
			continue
		}
		if excluded != "" && containsFold(entry.Name(), excluded) {
			continue
		}
		authorDir := filepath.Join(root, entry.Name())
		days, err := os.ReadDir(authorDir)
		if err != nil {
			continue
		}
		for _, day := range days {
			name := day.Name()
			if !day.IsDir() || strings.HasPrefix(name, ".") {
				continue
			}
			parsed, err := time.ParseInLocation(dayLayout, name, time.UTC)
			if err != nil || !inWindow(parsed, q) {
				continue
			}
			byDay[name] = append(byDay[name], filepath.Join(authorDir, name))
		}
	}
	days := make([]string, 0, len(byDay))
	for day := range byDay {
		days = append(days, day)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(days)))
	buckets := make([][]string, 0, len(days))
	for _, day := range days {
		buckets = append(buckets, byDay[day])
	}
	return buckets, nil
}

// inWindow reports whether any instant of day can satisfy the window. The
// exact edges are checked per record in matches.
func inWindow(day time.Time, q Query) bool {
	if !q.Since.IsZero() && !day.AddDate(0, 0, 1).After(q.Since) {
		return false
	}
	if !q.Until.IsZero() && !day.Before(q.Until) {
		return false
	}
	return true
}

func (s *Store) scanDirs(dirs []string, q Query, needle string) ([]Hit, error) {
	var (
		found []Hit
		mu    sync.Mutex
	)
	paths := make(chan string)
	var workers sync.WaitGroup
	for i := 0; i < workerCount(); i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for path := range paths {
				rec, ok := decodeFile(path)
				if !ok || !matches(rec, q, needle) {
					continue
				}
				hit := hitFrom(s.SessionsPath(), path, rec)
				mu.Lock()
				found = append(found, hit)
				mu.Unlock()
			}
		}()
	}
	var walkErr error
	for _, dir := range dirs {
		if walkErr = walkSessions(dir, func(path string, _ fs.DirEntry) error {
			paths <- path
			return nil
		}); walkErr != nil {
			break
		}
	}
	close(paths)
	workers.Wait()
	if walkErr != nil {
		return nil, walkErr
	}
	return found, nil
}

func matches(rec session.Record, q Query, needle string) bool {
	if needle != "" && !containsFold(rec.Content, needle) {
		return false
	}
	// The repo filter also matches the working directory, so a path finds
	// sessions as well as a repository name does.
	if repo := strings.ToLower(strings.TrimSpace(q.Repo)); repo != "" && !containsFold(rec.Repo, repo) && !containsFold(rec.CWD, repo) {
		return false
	}
	if agent := strings.TrimSpace(q.Agent); agent != "" && !strings.EqualFold(rec.Agent, agent) {
		return false
	}
	if !q.Since.IsZero() && rec.StartedAt.Before(q.Since) {
		return false
	}
	if !q.Until.IsZero() && !rec.StartedAt.Before(q.Until) {
		return false
	}
	return true
}

func isDay(name string) bool {
	_, err := time.ParseInLocation(dayLayout, name, time.UTC)
	return err == nil
}

// Get returns every published file whose name carries sessionID. It is a
// directed walk: the published name is "<session-id>-<sourceHash>.cms", so
// only the files that already match by name are opened. A session that was
// resumed legitimately has more than one file, so all of them are returned,
// newest first.
func (s *Store) Get(sessionID string) ([]Hit, error) {
	if sessionID == "" {
		return nil, nil
	}
	prefix := sessionID + "-"
	var hits []Hit
	err := walkSessions(s.SessionsPath(), func(path string, entry fs.DirEntry) error {
		if !strings.HasPrefix(entry.Name(), prefix) {
			return nil
		}
		// The name only narrows the walk: ids are dash-separated like the name
		// itself, so "<id>-" also begins the files of every longer id.
		if rec, ok := decodeFile(path); ok && rec.SessionID == sessionID {
			hits = append(hits, hitFrom(s.SessionsPath(), path, rec))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].StartedAt.After(hits[j].StartedAt) })
	return hits, nil
}

// Count reports how many published session files are in the folder. It
// reads no file contents, so it stays a stat-only pass.
func (s *Store) Count() (int, error) {
	count := 0
	err := walkSessions(s.SessionsPath(), func(string, fs.DirEntry) error {
		count++
		return nil
	})
	return count, err
}

// AuthorDirs counts the author directories under the shared folder, which is
// the quickest check that replication is delivering anything at all.
func (s *Store) AuthorDirs() (int, error) {
	entries, err := os.ReadDir(s.SessionsPath())
	if err != nil {
		return 0, err
	}
	count := 0
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") {
			count++
		}
	}
	return count, nil
}

// walkSessions visits every published file under dir, skipping any path
// component that begins with "." (replication bookkeeping, and our own
// staging directory) and any file that is not a .cms. A folder that isn't
// there yet holds no sessions, which is not an error. A directory the walk
// cannot enter is skipped: one author's broken permissions must not hide
// every other author's sessions.
func walkSessions(dir string, visit func(path string, entry fs.DirEntry) error) error {
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if entry == nil || entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() || !strings.HasSuffix(name, Extension) {
			return nil
		}
		return visit(path, entry)
	})
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// decodeFile is a variable so that a test can count how many files a search
// actually opened: reaching the limit early is otherwise invisible from the
// outside, since the walk simply stops.
var decodeFile = func(path string) (session.Record, bool) {
	file, err := Open(path)
	if err != nil {
		return session.Record{}, false
	}
	rec, err := session.Decode(file)
	file.Close()
	// Days are searched newest first, so a file under a day it did not start on
	// would be read ahead of every real session.
	if err != nil || filepath.Base(filepath.Dir(path)) != rec.StartedAt.UTC().Format(dayLayout) {
		return session.Record{}, false
	}
	return rec, true
}

// hitFrom builds a Hit from a decoded record. The author directory is what
// the folder itself says about who published a file; the author inside the
// record is whatever the writer chose to claim. Where they disagree, the
// path wins, so a file dropped into someone else's directory cannot be
// displayed under a third person's name.
func hitFrom(sessionsDir, path string, rec session.Record) Hit {
	author := rec.Author
	if fromPath := authorFromPath(sessionsDir, path); fromPath != "" {
		author = fromPath
	}
	return Hit{
		Path:         path,
		SessionID:    rec.SessionID,
		Author:       author,
		Agent:        rec.Agent,
		CWD:          rec.CWD,
		Repo:         rec.Repo,
		AgentVersion: rec.AgentVersion,
		StartedAt:    rec.StartedAt,
		EndedAt:      rec.EndedAt,
	}
}

func authorFromPath(sessionsDir, path string) string {
	rel, err := filepath.Rel(sessionsDir, path)
	if err != nil {
		return ""
	}
	parts := strings.Split(rel, string(os.PathSeparator))
	if len(parts) < 2 || parts[0] == "" || parts[0] == "." || parts[0] == ".." {
		return ""
	}
	return parts[0]
}

// workerCount sizes the pool. Decompression is what a search spends its
// time on, so it is bounded by cores rather than by the number of files.
func workerCount() int {
	n := runtime.NumCPU()
	if n < 1 {
		return 1
	}
	if n > 32 {
		return 32
	}
	return n
}

// containsFold reports whether haystack contains needleLower, which must
// already be lowercased, ignoring ASCII case. Lowercasing the haystack
// instead would allocate a second copy of a transcript that can be tens of
// megabytes, once per file, for every query.
func containsFold(haystack, needleLower string) bool {
	if needleLower == "" {
		return true
	}
	if len(needleLower) > len(haystack) {
		return false
	}
	first := needleLower[0]
	last := len(haystack) - len(needleLower)
	for i := 0; i <= last; i++ {
		if lowerASCII(haystack[i]) != first {
			continue
		}
		if strings.EqualFold(haystack[i:i+len(needleLower)], needleLower) {
			return true
		}
	}
	return false
}

func lowerASCII(b byte) byte {
	if b >= 'A' && b <= 'Z' {
		return b + ('a' - 'A')
	}
	return b
}
