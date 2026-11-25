package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
)

const Format = "commonmind/1"

// MaxDecodedBytes bounds how much a single .cms file may decompress to, and
// equally how large a record Encode will write. The two are one number on
// purpose: this program must never publish a file its own reader would
// refuse.
//
// A record carries the raw transcript, so the bound is sized against real
// ones. A long session runs to a few tens of MiB of JSONL, a little more once
// it is escaped into the JSON string field. 256 MiB leaves roughly ten times
// that headroom, which is what an unusually long session needs and a corrupt
// or hostile file does not: zstd will happily expand a 100 KB file into
// gigabytes, and without a ceiling that cost lands on every machine that
// searches the folder.
const MaxDecodedBytes = 256 << 20

// window is the zstd window, one number for the writer and the reader like the
// size bound above. A frame names its own window and the reader allocates it
// before any content, so without a limit ten bytes cost half a gigabyte.
const window = 8 << 20

// ErrTooLarge reports a record whose JSON form exceeds MaxDecodedBytes. On
// the read side search treats it like any other decode error: skip the file
// and carry on. On the write side it fails the
// publish outright and names the session, so an oversized transcript is
// reported rather than silently missing from the folder.
var ErrTooLarge = errors.New("decoded record exceeds the size ceiling")

// ceilingReader fails the read that would take the decoded stream past its
// ceiling, so an oversized file is rejected while it is being read rather
// than after it has been fully buffered into memory.
type ceilingReader struct {
	r         io.Reader
	remaining int64
}

func (c *ceilingReader) Read(p []byte) (int, error) {
	if c.remaining <= 0 {
		return 0, ErrTooLarge
	}
	if int64(len(p)) > c.remaining {
		p = p[:c.remaining]
	}
	n, err := c.r.Read(p)
	c.remaining -= int64(n)
	return n, err
}

type Record struct {
	Format       string    `json:"format"`
	SessionID    string    `json:"session_id"`
	Author       string    `json:"author"`
	Agent        string    `json:"agent"`
	CWD          string    `json:"cwd"`
	Repo         string    `json:"repo"`
	AgentVersion string    `json:"agent_version,omitempty"`
	SourceFile   string    `json:"source_file,omitempty"`
	StartedAt    time.Time `json:"started_at"`
	EndedAt      time.Time `json:"ended_at"`
	PublishedAt  time.Time `json:"published_at"`
	ContentHash  string    `json:"content_hash"`
	Content      string    `json:"content"`
}

func Encode(w io.Writer, rec Record) error {
	if rec.Format != Format {
		return fmt.Errorf("unsupported record format %q", rec.Format)
	}
	if rec.SessionID == "" {
		return fmt.Errorf("record has no session_id")
	}
	// Marshal before compressing so an oversized record is refused here,
	// with an error naming the session, instead of being written and then
	// skipped for ever by every machine that reads the folder.
	data, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("encode record: %w", err)
	}
	if len(data) > MaxDecodedBytes {
		return fmt.Errorf("encode record for session %s: %d bytes exceeds the %d byte ceiling: %w", rec.SessionID, len(data), MaxDecodedBytes, ErrTooLarge)
	}
	encoder, err := zstd.NewWriter(w, zstd.WithWindowSize(window))
	if err != nil {
		return fmt.Errorf("open zstd writer: %w", err)
	}
	if _, err := encoder.Write(append(data, '\n')); err != nil {
		encoder.Close()
		return fmt.Errorf("encode record: %w", err)
	}
	return encoder.Close()
}

func Decode(r io.Reader) (Record, error) {
	decoder, err := zstd.NewReader(r, zstd.WithDecoderMaxWindow(window))
	if err != nil {
		return Record{}, fmt.Errorf("open zstd reader: %w", err)
	}
	defer decoder.Close()
	var rec Record
	bounded := &ceilingReader{r: io.LimitReader(decoder, MaxDecodedBytes+1), remaining: MaxDecodedBytes + 1}
	if err := json.NewDecoder(bounded).Decode(&rec); err != nil {
		if errors.Is(err, ErrTooLarge) {
			return Record{}, fmt.Errorf("decode record: decompressed size exceeds %d bytes: %w", MaxDecodedBytes, ErrTooLarge)
		}
		return Record{}, fmt.Errorf("decode record: %w", err)
	}
	if rec.Format != Format {
		return Record{}, fmt.Errorf("unsupported record format %q", rec.Format)
	}
	if rec.SessionID == "" {
		return Record{}, fmt.Errorf("record has no session_id")
	}
	// Go reads some times it then refuses to write, such as a zone of +24:00.
	for _, when := range []time.Time{rec.StartedAt, rec.EndedAt, rec.PublishedAt} {
		if _, err := when.MarshalJSON(); err != nil {
			return Record{}, fmt.Errorf("decode record: %w", err)
		}
	}
	return rec, nil
}

// Repo names the repository cwd is in. A linked worktree is named for the
// repository it belongs to, not for its own directory: agents create one
// per task (<repo>/.claude/worktrees/<name>), and the repo filter has to
// find those sessions under the repository's name.
func Repo(cwd string) string {
	dir := filepath.Clean(cwd)
	for {
		if info, err := os.Stat(filepath.Join(dir, ".git")); err == nil && (info.IsDir() || info.Mode().IsRegular()) {
			if info.Mode().IsRegular() {
				if main, ok := worktreeRepo(filepath.Join(dir, ".git")); ok {
					return main
				}
			}
			return filepath.Base(dir)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return filepath.Base(filepath.Clean(cwd))
		}
		dir = parent
	}
}

// worktreeRepo reads a linked worktree's .git file, which points at
// <repo>/.git/worktrees/<name> (or <repo>.git/worktrees/<name> for a bare
// repository), and returns <repo>. A submodule's .git file points elsewhere
// and is left alone.
func worktreeRepo(gitFile string) (string, bool) {
	data, err := os.ReadFile(gitFile)
	if err != nil {
		return "", false
	}
	gitdir, ok := strings.CutPrefix(strings.TrimSpace(string(data)), "gitdir:")
	if !ok {
		return "", false
	}
	gitdir = strings.TrimSpace(gitdir)
	if !filepath.IsAbs(gitdir) {
		gitdir = filepath.Join(filepath.Dir(gitFile), gitdir)
	}
	gitdir = filepath.Clean(gitdir)
	if filepath.Base(filepath.Dir(gitdir)) != "worktrees" {
		return "", false
	}
	common := filepath.Dir(filepath.Dir(gitdir))
	if filepath.Base(common) == ".git" {
		return filepath.Base(filepath.Dir(common)), true
	}
	return strings.TrimSuffix(filepath.Base(common), ".git"), true
}
