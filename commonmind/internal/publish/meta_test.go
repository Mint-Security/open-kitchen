package publish

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestSniffMetaReadsTopLevelAndPayloadKeys(t *testing.T) {
	raw := strings.Join([]string{
		`{"type":"user","sessionId":"claude-id","cwd":"/work/repo","version":"2.1.0","timestamp":"2026-09-18T07:00:00.000Z"}`,
		`{"timestamp":"2026-09-18T07:00:01.000Z","ordinal":0,"type":"session_meta","payload":{"session_id":"codex-id","cwd":"/other","cli_version":"0.9.9"}}`,
	}, "\n")
	meta := sniffMeta([]byte(raw))
	if meta.SessionID != "claude-id" {
		t.Errorf("SessionID = %q, want the first one seen", meta.SessionID)
	}
	if meta.CWD != "/work/repo" || meta.Version != "2.1.0" {
		t.Errorf("cwd/version = %q/%q, want first-wins values", meta.CWD, meta.Version)
	}
	if meta.Records != 2 {
		t.Errorf("Records = %d, want 2", meta.Records)
	}
}

func TestSniffMetaFindsPayloadOnlyMetadata(t *testing.T) {
	raw := `{"timestamp":"2026-09-18T07:00:01.000Z","type":"session_meta","payload":{"session_id":"codex-id","cwd":"/other","cli_version":"0.9.9"}}` + "\n"
	meta := sniffMeta([]byte(raw))
	if meta.SessionID != "codex-id" || meta.CWD != "/other" || meta.Version != "0.9.9" {
		t.Fatalf("payload metadata not recovered: %+v", meta)
	}
}

// TestSniffMetaTakesTheLastTimestampFromBeyondTheHeadWindow: ended_at has
// to be the session's real end. A head-only scan would stop at line 200 and
// report a multi-hour session as a few seconds long.
func TestSniffMetaTakesTheLastTimestampFromBeyondTheHeadWindow(t *testing.T) {
	var b strings.Builder
	fmt.Fprintf(&b, `{"sessionId":"s","cwd":"/work","version":"1.0.0","timestamp":"2026-09-18T07:00:00.000Z"}`+"\n")
	for i := 0; i < 5000; i++ {
		fmt.Fprintf(&b, `{"type":"filler","timestamp":"2026-09-18T07:%02d:00.000Z"}`+"\n", i%60)
	}
	fmt.Fprintf(&b, `{"type":"user","timestamp":"2026-09-18T19:30:00.000Z"}`+"\n")

	meta := sniffMeta([]byte(b.String()))
	if got := meta.StartedAt.UTC().Format(time.RFC3339); got != "2026-09-18T07:00:00Z" {
		t.Errorf("StartedAt = %s", got)
	}
	if got := meta.EndedAt.UTC().Format(time.RFC3339); got != "2026-09-18T19:30:00Z" {
		t.Errorf("EndedAt = %s, want the final record's timestamp", got)
	}
	if meta.Records != metaHeadLines+metaTailLines {
		t.Errorf("Records = %d, want the two windows counted once each (%d)", meta.Records, metaHeadLines+metaTailLines)
	}
}

func TestSniffMetaIgnoresNonStringAndMalformedValues(t *testing.T) {
	raw := strings.Join([]string{
		`{"cwd":{"not":"a string"},"version":17,"timestamp":"not a timestamp"}`,
		`not json`,
		`{"sessionId":"","cwd":"/work","version":"1.0.0","timestamp":"2026-09-18T07:00:00.000Z"}`,
	}, "\n")
	meta := sniffMeta([]byte(raw))
	if meta.CWD != "/work" || meta.Version != "1.0.0" {
		t.Fatalf("a malformed value poisoned the walk: %+v", meta)
	}
	if meta.SessionID != "" {
		t.Errorf("SessionID = %q, want empty (an empty string is not a value)", meta.SessionID)
	}
	if meta.Records != 2 {
		t.Errorf("Records = %d, want 2 (the non-JSON line is not a record)", meta.Records)
	}
	if meta.StartedAt.IsZero() {
		t.Error("the usable timestamp was not picked up")
	}
}

func TestSniffMetaCountsNothingForAnEmptyTranscript(t *testing.T) {
	for _, raw := range []string{"", "   \n\n\t\n", "[1,2,3]\n\"bare\"\n"} {
		if meta := sniffMeta([]byte(raw)); meta.Records != 0 {
			t.Errorf("Records = %d for %q, want 0", meta.Records, raw)
		}
	}
}
