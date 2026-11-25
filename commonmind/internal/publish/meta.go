package publish

import (
	"bytes"
	"encoding/json"
	"time"
)

const (
	// metaHeadLines and metaTailLines bound how much of a transcript the
	// sniffer parses. Session identity (id, cwd, version) is written into
	// the opening records by both agents, so a head window finds it; the
	// tail window exists only so ended_at is the session's real last
	// timestamp rather than the timestamp of its 200th line, which on a
	// long session is minutes after the start instead of hours.
	metaHeadLines = 200
	metaTailLines = 200

	// maxMetaLineBytes skips a line too large to be a plausible record
	// rather than failing the session. Codex's opening record carries the
	// entire system prompt, so the bound has to be generous.
	maxMetaLineBytes = 4 << 20
)

// transcriptMeta is the small amount of structure recovered from a raw
// transcript so search results are usable: without cwd, repo and
// agent_version a hit says nothing about where it came from.
//
// It is recovered generically — one shallow walk over each line's JSON
// keys, looking at the top level and one level down inside a "payload"
// object — rather than by parsing either agent's record shapes. Claude Code
// writes its metadata at the top level of flat records; Codex nests it in
// the payload of an envelope. Both are covered by the same walk, and a
// third agent, or a field that moves between versions, most likely is too.
type transcriptMeta struct {
	SessionID string
	CWD       string
	Version   string
	StartedAt time.Time
	EndedAt   time.Time

	// Records counts the lines in the scanned windows that parsed as a
	// JSON object. Zero means the transcript yielded nothing usable at
	// all — an empty file, or one holding no records this program can
	// recognize as records — and such a session is counted as
	// skipped-empty rather than published.
	Records int
}

// sniffMeta recovers what metadata it can from a raw transcript. Every
// field is best-effort: an absent one stays empty, and no line is ever
// fatal, since these files are written by a live agent in an undocumented
// format that changes across versions.
func sniffMeta(raw []byte) transcriptMeta {
	var meta transcriptMeta
	rest := foldLines(&meta, raw, metaHeadLines)
	foldLines(&meta, tailLines(rest, metaTailLines), metaTailLines)
	return meta
}

// foldLines folds at most limit non-blank lines of raw into meta and
// returns the bytes it did not read.
func foldLines(meta *transcriptMeta, raw []byte, limit int) []byte {
	rest := raw
	for seen := 0; len(rest) > 0 && seen < limit; {
		line := rest
		if i := bytes.IndexByte(rest, '\n'); i >= 0 {
			line, rest = rest[:i], rest[i+1:]
		} else {
			rest = nil
		}
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		seen++
		if len(line) > maxMetaLineBytes {
			continue
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(line, &fields); err != nil {
			continue
		}
		meta.Records++
		foldFields(meta, fields)
		if payload, ok := fields["payload"]; ok {
			var nested map[string]json.RawMessage
			if json.Unmarshal(payload, &nested) == nil {
				foldFields(meta, nested)
			}
		}
	}
	return rest
}

// foldFields folds one decoded record's keys into meta. Identity fields are
// first-wins: the opening records are the authoritative ones, and a later
// record carrying, say, a sub-agent's own cwd must not overwrite the
// session's.
func foldFields(meta *transcriptMeta, fields map[string]json.RawMessage) {
	if meta.SessionID == "" {
		meta.SessionID = stringField(fields, "sessionId", "session_id")
	}
	if meta.CWD == "" {
		meta.CWD = stringField(fields, "cwd")
	}
	if meta.Version == "" {
		meta.Version = stringField(fields, "version", "cli_version")
	}
	if ts, ok := parseTimestamp(stringField(fields, "timestamp")); ok {
		extendTimeRange(meta, ts)
	}
}

// stringField returns the first of names present in fields as a non-empty
// JSON string. A key holding a number, object or array is not an error —
// it simply isn't the field we were looking for.
func stringField(fields map[string]json.RawMessage, names ...string) string {
	for _, name := range names {
		raw, ok := fields[name]
		if !ok {
			continue
		}
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			continue
		}
		if value != "" {
			return value
		}
	}
	return ""
}

// tailLines returns the suffix of raw holding at most its last n lines.
func tailLines(raw []byte, n int) []byte {
	if n <= 0 {
		return nil
	}
	end := len(raw)
	// Ignore a trailing newline so the final record counts as one line.
	for end > 0 && (raw[end-1] == '\n' || raw[end-1] == '\r') {
		end--
	}
	start := end
	for count := 0; count < n && start > 0; count++ {
		i := bytes.LastIndexByte(raw[:start], '\n')
		if i < 0 {
			return raw[:end]
		}
		start = i
	}
	return raw[start:end]
}

// parseTimestamp parses the RFC3339Nano shape both agents use for their own
// per-record timestamp. An unparsable value is ignored, never fatal.
func parseTimestamp(value string) (time.Time, bool) {
	if value == "" {
		return time.Time{}, false
	}
	ts, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, false
	}
	return ts, true
}

// extendTimeRange grows meta's [StartedAt, EndedAt] bounds to include ts.
func extendTimeRange(meta *transcriptMeta, ts time.Time) {
	if meta.StartedAt.IsZero() || ts.Before(meta.StartedAt) {
		meta.StartedAt = ts
	}
	if meta.EndedAt.IsZero() || ts.After(meta.EndedAt) {
		meta.EndedAt = ts
	}
}
