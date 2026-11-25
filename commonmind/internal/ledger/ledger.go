// Package ledger records what this machine has published.
//
// It is the one piece of state that cannot be recovered from the shared
// folder, because it is precisely the difference between "we never published
// this" and "we published it and somebody deleted it".
package ledger

import (
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS published (
  source_path     TEXT PRIMARY KEY,
  published_path  TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  source_size     INTEGER NOT NULL,
  source_mtime_ns INTEGER NOT NULL,
  published_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS excluded (
  source_path TEXT PRIMARY KEY,
  excluded_at TEXT NOT NULL
);
`

// Entry is one source transcript this machine has published.
type Entry struct {
	// SourcePath is the absolute path of the agent's own transcript.
	SourcePath string
	// PublishedPath is where it was written in the shared folder.
	PublishedPath string
	ContentHash   string
	// SourceSize and SourceMtimeNS are the source file's size and mtime as
	// of that publish, which is how a later flush recognises an unchanged
	// session without reading it.
	SourceSize    int64
	SourceMtimeNS int64
	PublishedAt   time.Time
}

type DB struct{ db *sql.DB }

func Open(path string) (*DB, error) {
	db, err := sql.Open("sqlite", dsn(path))
	if err != nil {
		return nil, fmt.Errorf("open publish ledger: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("create publish ledger schema: %w", err)
	}
	// The ledger holds the absolute paths of every transcript on this
	// machine and where each one landed in the shared folder.
	if err := os.Chmod(path, 0o600); err != nil {
		db.Close()
		return nil, fmt.Errorf("secure publish ledger: %w", err)
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.Chmod(path+suffix, 0o600); err != nil && !os.IsNotExist(err) {
			db.Close()
			return nil, fmt.Errorf("secure publish ledger %s file: %w", suffix, err)
		}
	}
	return &DB{db: db}, nil
}

func (d *DB) Close() error { return d.db.Close() }

// Lookup returns the entry for sourcePath, if this machine has published it.
func (d *DB) Lookup(sourcePath string) (Entry, bool, error) {
	entry := Entry{SourcePath: sourcePath}
	var publishedAt string
	err := d.db.QueryRow(
		`SELECT published_path, content_hash, source_size, source_mtime_ns, published_at FROM published WHERE source_path = ?`,
		sourcePath,
	).Scan(&entry.PublishedPath, &entry.ContentHash, &entry.SourceSize, &entry.SourceMtimeNS, &publishedAt)
	switch {
	case err == sql.ErrNoRows:
		return Entry{}, false, nil
	case err != nil:
		return Entry{}, false, fmt.Errorf("read publish ledger: %w", err)
	}
	entry.PublishedAt, _ = time.Parse(time.RFC3339Nano, publishedAt)
	return entry, true, nil
}

// Record upserts entry, which is what one successful publish amounts to.
func (d *DB) Record(entry Entry) error {
	_, err := d.db.Exec(
		`INSERT INTO published (source_path, published_path, content_hash, source_size, source_mtime_ns, published_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(source_path) DO UPDATE SET
		   published_path = excluded.published_path,
		   content_hash = excluded.content_hash,
		   source_size = excluded.source_size,
		   source_mtime_ns = excluded.source_mtime_ns,
		   published_at = excluded.published_at`,
		entry.SourcePath, entry.PublishedPath, entry.ContentHash,
		entry.SourceSize, entry.SourceMtimeNS, entry.PublishedAt.UTC().Format(time.RFC3339Nano),
	)
	if err != nil {
		return fmt.Errorf("write publish ledger: %w", err)
	}
	return nil
}

// Exclude records that an exclusion held sourcePath back. Like a deletion, it
// stands: the pattern or ignore file that caused it can go missing by accident.
func (d *DB) Exclude(sourcePath string) error {
	_, err := d.db.Exec(
		`INSERT INTO excluded (source_path, excluded_at) VALUES (?, ?) ON CONFLICT(source_path) DO NOTHING`,
		sourcePath, time.Now().UTC().Format(time.RFC3339Nano),
	)
	if err != nil {
		return fmt.Errorf("write publish ledger: %w", err)
	}
	return nil
}

// Excluded reports whether an exclusion ever held sourcePath back.
func (d *DB) Excluded(sourcePath string) (bool, error) {
	var found int
	err := d.db.QueryRow(`SELECT 1 FROM excluded WHERE source_path = ?`, sourcePath).Scan(&found)
	switch {
	case err == sql.ErrNoRows:
		return false, nil
	case err != nil:
		return false, fmt.Errorf("read publish ledger: %w", err)
	}
	return true, nil
}

func dsn(path string) string {
	query := url.Values{}
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "foreign_keys(1)")
	query.Add("_pragma", "journal_mode(WAL)")
	query.Set("_txlock", "immediate")
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(path), RawQuery: query.Encode()}).String()
}
