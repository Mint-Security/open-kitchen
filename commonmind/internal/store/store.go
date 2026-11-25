package store

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/session"
)

const (
	TempDirName    = ".commonmind-tmp"
	SessionsDir    = "sessions"
	Extension      = ".cms"
	unknownHostDir = "unknown-host"
)

// ErrNoSessionsDir reports a shared folder whose sessions directory is not
// there. Creating it is exclusively `init`'s job: if publishing recreated it,
// a flush against an unmounted share would leave a folder holding one local
// session where the team's whole history should have been.
var ErrNoSessionsDir = errors.New("shared sessions directory does not exist")

// HostTempDir is the staging directory this host writes into. It is
// namespaced per host because the shared folder is replicated: without the
// hostname, every machine receives copies of everyone else's in-flight
// transcripts and prunes them by a replicated mtime it cannot interpret.
func HostTempDir(root string) string {
	return filepath.Join(root, TempDirName, hostSegment())
}

func hostSegment() string {
	host, err := os.Hostname()
	if err != nil {
		return unknownHostDir
	}
	host = strings.TrimSpace(host)
	host = strings.Map(func(r rune) rune {
		if r == os.PathSeparator || r == '/' || r == 0 {
			return '-'
		}
		return r
	}, host)
	if host == "" || host == "." || host == ".." {
		return unknownHostDir
	}
	return host
}

// Open opens a published session file, and only a regular file. Everyone who
// shares the folder can put a symbolic link or a pipe in it: a link is read
// from wherever it points, and a read from a pipe never ends.
func Open(path string) (*os.File, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", path)
	}
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
}

// realDir fails if anything between the shared folder and dir is there and
// is not a directory: what is written or pruned through a link lands outside
// the folder.
func (s *Store) realDir(dir string) error {
	rel, err := filepath.Rel(s.root, dir)
	if err != nil {
		return err
	}
	at := s.root
	for _, part := range strings.Split(rel, string(os.PathSeparator)) {
		at = filepath.Join(at, part)
		info, err := os.Lstat(at)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return fmt.Errorf("%s is not a directory; refusing to use it", at)
		}
	}
	return nil
}

// StagingDir is HostTempDir, refused when it is not this host's own directory.
func (s *Store) StagingDir() (string, error) {
	dir := HostTempDir(s.root)
	return dir, s.realDir(dir)
}

type Store struct{ root string }

func New(root string) *Store { return &Store{root: root} }

func (s *Store) Root() string { return s.root }

// SessionsPath is the root of the published tree inside the shared folder.
func (s *Store) SessionsPath() string { return filepath.Join(s.root, SessionsDir) }

// Init creates the shared folder's sessions directory. It is the only place
// that does: see ErrNoSessionsDir.
func (s *Store) Init() error {
	if err := os.MkdirAll(s.SessionsPath(), 0o755); err != nil {
		return fmt.Errorf("create shared directory: %w", err)
	}
	return nil
}

// validName rejects a path component that could escape the directory it is
// meant to name. Author and session id both come from outside this program
// (settings, and the agent's own transcript), and both are interpolated
// straight into a path.
func validName(kind, value string) error {
	if value == "" {
		return fmt.Errorf("%s is empty", kind)
	}
	if value == "." || value == ".." {
		return fmt.Errorf("%s %q is not a usable path component", kind, value)
	}
	if strings.ContainsRune(value, '/') || strings.ContainsRune(value, os.PathSeparator) || strings.ContainsRune(value, 0) {
		return fmt.Errorf("%s %q contains a path separator", kind, value)
	}
	return nil
}

// Path returns the destination for rec. sourceHash is the first 8 hex chars
// of the sha256 of the absolute path of the transcript rec came from.
// It, not the session id alone, makes the filename unique: a resumed or
// forked Claude Code session keeps its original session_id in a brand-new
// transcript file, so two distinct source files can carry the same
// session_id and must never collide on one path.
func (s *Store) Path(rec session.Record, sourceHash string) string {
	day := rec.StartedAt.UTC().Format("2006-01-02")
	return filepath.Join(s.SessionsPath(), rec.Author, day, rec.SessionID+"-"+sourceHash+Extension)
}

// EnsureSessionsDir refuses a shared folder whose sessions directory is
// absent: an unmounted NAS or an unstarted sync daemon must not be made to
// look like an empty-but-live folder. It is the first thing publishing does,
// before anything else can read that absence as a deliberate deletion.
func (s *Store) EnsureSessionsDir() error {
	if info, err := os.Stat(s.SessionsPath()); err != nil || !info.IsDir() {
		return fmt.Errorf("%w: %s (run: commonmind init, or check that the shared folder is mounted)", ErrNoSessionsDir, s.SessionsPath())
	}
	return nil
}

func (s *Store) Publish(rec session.Record, sourceHash string) (bool, error) {
	if err := validName("author", rec.Author); err != nil {
		return false, err
	}
	if err := validName("session id", rec.SessionID); err != nil {
		return false, err
	}
	if err := s.EnsureSessionsDir(); err != nil {
		return false, err
	}

	final := s.Path(rec, sourceHash)
	tmpDir, err := s.StagingDir()
	if err != nil {
		return false, err
	}
	if err := s.realDir(filepath.Dir(final)); err != nil {
		return false, err
	}
	// Overwriting is the normal path, not an exception. A running session
	// is published while it is still being appended to, so every flush
	// republishes it with more transcript than the last one wrote: the
	// destination exists, decodes, and carries a different content hash.
	// (The rarer case this also covers is the corrupt or half-written
	// residue of an interrupted publish, which fails to decode.) An
	// unchanged republish of the same source file is the only case that
	// should no-op below. The write itself is a temp-file-and-rename, so a
	// reader — ours or a replication tool's — only ever sees the old file
	// or the new one, never a blend.
	if existing, err := Open(final); err == nil {
		got, decodeErr := session.Decode(existing)
		existing.Close()
		if decodeErr == nil && got.ContentHash == rec.ContentHash {
			return false, nil
		}
	}
	rec.PublishedAt = time.Now().UTC()

	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return false, fmt.Errorf("create temp dir: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(final), 0o755); err != nil {
		return false, fmt.Errorf("create session dir: %w", err)
	}
	tmp, err := os.CreateTemp(tmpDir, rec.SessionID+".*"+Extension)
	if err != nil {
		return false, fmt.Errorf("create temp file: %w", err)
	}
	defer os.Remove(tmp.Name())

	if err := session.Encode(tmp, rec); err != nil {
		tmp.Close()
		return false, err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return false, fmt.Errorf("sync temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return false, fmt.Errorf("close temp file: %w", err)
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return false, fmt.Errorf("chmod temp file: %w", err)
	}
	if err := os.Rename(tmp.Name(), final); err != nil {
		return false, fmt.Errorf("publish session file: %w", err)
	}
	dir, err := os.Open(filepath.Dir(final))
	if err != nil {
		return false, fmt.Errorf("sync session dir: %w", err)
	}
	if err := dir.Sync(); err != nil {
		dir.Close()
		return false, fmt.Errorf("sync session dir: %w", err)
	}
	if err := dir.Close(); err != nil {
		return false, fmt.Errorf("sync session dir: %w", err)
	}
	return true, nil
}
