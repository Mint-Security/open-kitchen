package publish

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/ledger"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/scan"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/session"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/store"
)

// tempFileLifetime is how long an orphan in the store's temp directory is
// tolerated. A publish is a single fsync-and-rename, so anything older is the
// residue of a hard kill mid-write.
const tempFileLifetime = time.Hour

// ignoreFileName, if present in a session's cwd or any ancestor of it, opts
// that session out of publishing entirely.
const ignoreFileName = ".commonmind-ignore"

// Options configures one publish run.
type Options struct {
	// Roots are the directories scanned for candidate session files, e.g.
	// ~/.claude/projects and ~/.codex/sessions.
	Roots []string
	// Since bounds the retroactive sweep: only files modified within this
	// long of now are considered.
	Since time.Duration
	// Exclude holds glob patterns naming directories. A session that worked
	// in one, or below one, is never published.
	Exclude []string
}

// Run scans the configured roots and publishes every session's transcript
// through st, byte for byte as the agent wrote it. A session that is still
// running is published too, and republished as it grows: there is no idle
// rule and no notion of a session being finished. It returns the number of
// sessions actually written — republishing an unchanged session is a no-op,
// per store.Publish — the number of sessions that yielded no usable records
// at all and were skipped, and the number skipped because the file this
// machine published for them is no longer in the shared folder.
//
// That last count is what makes deletion durable, and led is what makes it
// possible: a published file that is missing while the ledger says this
// machine wrote it was deleted on purpose, and republishing it would undo
// somebody's `rm`. Absence alone is still never read as intent — an
// unmounted share looks identical — which is why the share is verified
// before any candidate is considered.
//
// The empty count is not a curiosity. From the outside an agent nobody can
// read looks exactly like an agent nobody used, so an empty transcript, or
// one holding nothing this program recognizes as a record, is counted and
// reported. See also PreviewSkippedEmpty, which reports the same signal
// without publishing anything.
func Run(ctx context.Context, st *store.Store, led *ledger.DB, author string, opts Options) (published int, skippedEmpty int, skippedDeleted int, err error) {
	// An exclusion that cannot be parsed excludes nothing. Publishing past it
	// would share, raw, exactly what it was written to hold back.
	if err := ValidateExclude(opts.Exclude); err != nil {
		return 0, 0, 0, err
	}
	if err := pruneTempFiles(st, tempFileLifetime, time.Now()); err != nil {
		return 0, 0, 0, err
	}

	now := time.Now().UTC()
	since := now.Add(-opts.Since)
	candidates, err := scan.List(opts.Roots, since)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("scan session roots: %w", err)
	}
	// Before anything consults the ledger. A missing published file only
	// means "deleted" when the folder holding it is actually there; on an
	// unmounted share every file is missing, and reading that as a wave of
	// deliberate deletions would silently stop publishing altogether.
	if len(candidates) > 0 {
		if err := st.EnsureSessionsDir(); err != nil {
			return 0, 0, 0, err
		}
	}

	var errs []error
	for _, cand := range candidates {
		select {
		case <-ctx.Done():
			return published, skippedEmpty, skippedDeleted, ctx.Err()
		default:
		}

		wrote, empty, deleted, err := publishOne(st, led, author, cand, opts.Exclude)
		if err != nil {
			errs = append(errs, fmt.Errorf("publish %s: %w", cand.Path, err))
			continue
		}
		if wrote {
			published++
		}
		if empty {
			skippedEmpty++
		}
		if deleted {
			skippedDeleted++
		}
	}
	return published, skippedEmpty, skippedDeleted, errors.Join(errs...)
}

// PreviewSkippedEmpty reads every candidate (without publishing anything)
// and reports how many would be skipped as empty if flushed now. status uses
// this so "a whole agent is missing" is answerable before anyone runs flush.
// A candidate that fails to read is not counted here — Run will surface that
// failure explicitly the next time it actually runs.
//
// A candidate the ledger already accounts for, unchanged, is known to have
// had usable records — it was published — so it is not read again. That is
// what keeps status off the whole window the way flush is.
func PreviewSkippedEmpty(led *ledger.DB, candidates []scan.Candidate) int {
	n := 0
	for _, cand := range candidates {
		if entry, ok, err := lookup(led, cand); err == nil && ok && unchanged(entry, cand) {
			continue
		}
		raw, err := os.ReadFile(cand.Path)
		if err != nil {
			continue
		}
		if sniffMeta(raw).Records == 0 {
			n++
		}
	}
	return n
}

// lookup resolves cand against the ledger, whose key is the transcript's
// absolute path.
func lookup(led *ledger.DB, cand scan.Candidate) (ledger.Entry, bool, error) {
	if led == nil {
		return ledger.Entry{}, false, nil
	}
	abs, err := filepath.Abs(cand.Path)
	if err != nil {
		return ledger.Entry{}, false, err
	}
	return led.Lookup(abs)
}

// unchanged reports whether the source transcript is byte-for-byte what it
// was when we last published it, judged by size and mtime alone so that an
// untouched session costs one stat rather than a full read and hash.
func unchanged(entry ledger.Entry, cand scan.Candidate) bool {
	return entry.SourceSize == cand.Size && entry.SourceMtimeNS == cand.ModTime.UnixNano()
}

// publishOne returns whether the session was written, whether it was
// skipped for yielding no usable records, and whether it was skipped
// because the file this machine published for it has since been deleted.
//
// The ledger is consulted first, and in that order, because both answers it
// gives are worth having before the transcript is touched: a deleted
// published file must not be recreated, and an unchanged session must not be
// re-read and hashed on every flush just to discover it is the same file it
// was an hour ago.
//
// The published content is the source transcript verbatim: no caps, no
// filtering, no per-agent parsing of the conversation. Whatever the agent
// wrote is what lands in the shared folder — including, for a session being
// appended to right now, a final line cut off mid-write. Raw bytes are
// preserved as-is and sniffMeta simply skips a line it cannot parse.
func publishOne(st *store.Store, led *ledger.DB, author string, cand scan.Candidate, exclude []string) (wrote bool, empty bool, deleted bool, err error) {
	entry, known, err := lookup(led, cand)
	if err != nil {
		return false, false, false, err
	}
	// The ledger speaks for the shared folder it was written against. An entry
	// that points into another folder — init was run again with a new
	// --shared — says nothing about this one: the session is not here, and it
	// was not deleted from here either.
	if known && !isUnder(st.SessionsPath(), entry.PublishedPath) {
		known = false
	}
	if held, err := heldBack(led, cand); err != nil || held {
		return false, false, false, err
	}
	if known {
		switch _, statErr := os.Stat(entry.PublishedPath); {
		case os.IsNotExist(statErr):
			// We published this file and it is not there any more.
			// The share itself is mounted — Run checked — so this is
			// somebody's deliberate deletion, and republishing it
			// would undo their rm.
			return false, false, true, nil
		case statErr == nil && unchanged(entry, cand):
			return false, false, false, nil
		}
	}

	raw, err := os.ReadFile(cand.Path)
	if err != nil {
		return false, false, false, fmt.Errorf("read session file: %w", err)
	}
	meta := sniffMeta(raw)
	if meta.Records == 0 {
		return false, true, false, nil
	}

	// The check covers every directory the session records, not only the one
	// it started in. With nothing recorded there is nothing to check a pattern
	// against, and publishing would be a guess.
	cwds := recordedCWDs(raw)
	if len(cwds) == 0 && len(exclude) > 0 {
		return false, false, false, nil
	}
	for _, dir := range cwds {
		if isExcluded(dir, exclude) || isIgnoredByFile(dir) {
			return false, false, false, holdBack(led, cand)
		}
	}
	cwd := meta.CWD

	sessionID := meta.SessionID
	if sessionID == "" {
		sessionID = cand.SessionID
	}
	startedAt := meta.StartedAt
	if startedAt.IsZero() {
		startedAt = cand.ModTime
	}
	endedAt := meta.EndedAt
	if endedAt.IsZero() {
		endedAt = cand.ModTime
	}
	hash := sha256.Sum256(raw)
	sourceHash, err := sourceHash8(cand.Path)
	if err != nil {
		return false, false, false, fmt.Errorf("hash source path: %w", err)
	}

	rec := session.Record{
		Format:       session.Format,
		SessionID:    sessionID,
		Author:       author,
		Agent:        string(cand.Agent),
		AgentVersion: meta.Version,
		CWD:          cwd,
		Repo:         session.Repo(cwd),
		SourceFile:   filepath.Base(cand.Path),
		StartedAt:    startedAt,
		EndedAt:      endedAt,
		ContentHash:  "sha256:" + hex.EncodeToString(hash[:]),
		Content:      string(raw),
	}
	wrote, err = st.Publish(rec, sourceHash)
	if err != nil {
		return false, false, false, err
	}
	if err := record(led, cand, st.Path(rec, sourceHash), rec.ContentHash); err != nil {
		return wrote, false, false, err
	}
	return wrote, false, false, nil
}

// isUnder reports whether path is inside dir.
func isUnder(dir, path string) bool {
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && !filepath.IsAbs(rel)
}

// record notes where cand was published. It runs after an unchanged
// republish too: that is the no-op case, and the ledger still needs to know
// the file is ours before somebody deletes it.
func record(led *ledger.DB, cand scan.Candidate, publishedPath, contentHash string) error {
	if led == nil {
		return nil
	}
	abs, err := filepath.Abs(cand.Path)
	if err != nil {
		return err
	}
	return led.Record(ledger.Entry{
		SourcePath:    abs,
		PublishedPath: publishedPath,
		ContentHash:   contentHash,
		SourceSize:    cand.Size,
		SourceMtimeNS: cand.ModTime.UnixNano(),
		PublishedAt:   time.Now().UTC(),
	})
}

// heldBack reports whether an exclusion ever applied to cand on this machine.
func heldBack(led *ledger.DB, cand scan.Candidate) (bool, error) {
	if led == nil {
		return false, nil
	}
	abs, err := filepath.Abs(cand.Path)
	if err != nil {
		return false, err
	}
	return led.Excluded(abs)
}

func holdBack(led *ledger.DB, cand scan.Candidate) error {
	if led == nil {
		return nil
	}
	abs, err := filepath.Abs(cand.Path)
	if err != nil {
		return err
	}
	return led.Exclude(abs)
}

// recordedCWDs returns each distinct working directory raw records, at any
// depth. A session records one on every line, and it changes along the way.
func recordedCWDs(raw []byte) []string {
	var cwds []string
	key := []byte(`"cwd"`)
	for {
		i := bytes.Index(raw, key)
		if i < 0 {
			return cwds
		}
		raw = raw[i+len(key):]
		value := bytes.TrimLeft(raw, " \t")
		if len(value) == 0 || value[0] != ':' {
			continue
		}
		value = bytes.TrimLeft(value[1:], " \t")
		if len(value) == 0 || value[0] != '"' {
			continue
		}
		end := 1
		for end < len(value) && value[end] != '"' {
			if value[end] == '\\' {
				end++
			}
			end++
		}
		var cwd string
		if end >= len(value) || json.Unmarshal(value[:end+1], &cwd) != nil || cwd == "" || slices.Contains(cwds, cwd) {
			continue
		}
		cwds = append(cwds, cwd)
	}
}

// sourceHash8 returns the first 8 hex chars of the sha256 of path's absolute
// form. It is what makes a published file's name unique to the transcript it
// came from, not just to the session id recorded inside it: a resumed or
// forked Claude Code session keeps its original session_id in a fresh
// transcript file, so two distinct files can carry the same session_id.
func sourceHash8(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(abs))
	return hex.EncodeToString(sum[:])[:8], nil
}

// ValidateExclude reports the first exclusion that is not an absolute,
// well-formed glob.
// Setup refuses such a pattern and so does Run, because settings.json can be
// edited by hand.
func ValidateExclude(patterns []string) error {
	for _, pattern := range patterns {
		if _, err := path.Match(pattern, ""); err != nil {
			return fmt.Errorf("exclude pattern %q is not a valid glob: %w", pattern, err)
		}
		if !path.IsAbs(pattern) {
			return fmt.Errorf("exclude pattern %q must start with /: it is matched against a session's full working directory", pattern)
		}
	}
	return nil
}

// isExcluded reports whether cwd, or a directory above it, matches one of the
// configured glob patterns from `init --exclude`.
func isExcluded(cwd string, patterns []string) bool {
	if cwd == "" {
		return false
	}
	for dir := path.Clean(cwd); ; dir = path.Dir(dir) {
		for _, pattern := range patterns {
			if pattern = strings.TrimRight(pattern, "/"); pattern == "" {
				continue
			}
			if ok, err := path.Match(pattern, dir); ok || err != nil {
				return true
			}
		}
		if dir == path.Dir(dir) {
			return false
		}
	}
}

// isIgnoredByFile reports whether cwd or any ancestor of it contains a
// .commonmind-ignore file.
func isIgnoredByFile(cwd string) bool {
	if cwd == "" {
		return false
	}
	dir := filepath.Clean(cwd)
	for {
		if _, err := os.Stat(filepath.Join(dir, ignoreFileName)); err == nil {
			return true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return false
		}
		dir = parent
	}
}

// pruneTempFiles removes orphaned temp files a hard kill left behind. They hold
// a full transcript each, nothing else ever removes them, and a replication
// tool copies them around the team. Only this host's own staging directory is
// pruned: another machine's temp file carries a replicated mtime that says
// nothing reliable about that machine's clock, and it is that machine's
// in-flight session to finish or abandon.
func pruneTempFiles(st *store.Store, lifetime time.Duration, now time.Time) error {
	dir, err := st.StagingDir()
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read temp dir: %w", err)
	}
	cutoff := now.Add(-lifetime)
	var errs []error
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if info.ModTime().After(cutoff) {
			continue
		}
		if err := os.Remove(filepath.Join(dir, entry.Name())); err != nil && !os.IsNotExist(err) {
			errs = append(errs, fmt.Errorf("remove orphaned temp file %s: %w", entry.Name(), err))
		}
	}
	return errors.Join(errs...)
}
