package session

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
)

func TestEncodeDecodeRoundTrip(t *testing.T) {
	want := Record{
		Format: Format, SessionID: "s1", Author: "a@b.c", Agent: "claude",
		CWD: "/tmp/x", Repo: "x",
		StartedAt:   time.Now().UTC().Truncate(time.Millisecond),
		EndedAt:     time.Now().UTC().Truncate(time.Millisecond),
		ContentHash: "sha256:abc", Content: "hello transcript",
	}
	var buf bytes.Buffer
	if err := Encode(&buf, want); err != nil {
		t.Fatalf("encode: %v", err)
	}
	got, err := Decode(&buf)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.SessionID != want.SessionID || got.Content != want.Content || got.Repo != want.Repo {
		t.Fatalf("round trip mismatch: %+v", got)
	}
}

func TestDecodeRejectsUnknownFormat(t *testing.T) {
	var buf bytes.Buffer
	encoder, err := zstd.NewWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	badRec := Record{Format: "commonmind/99", SessionID: "s1"}
	if err := json.NewEncoder(encoder).Encode(badRec); err != nil {
		encoder.Close()
		t.Fatal(err)
	}
	encoder.Close()
	if _, err := Decode(&buf); err == nil {
		t.Fatal("expected unknown format to be rejected")
	}
}

func TestDecodeRejectsTruncatedInput(t *testing.T) {
	var buf bytes.Buffer
	if err := Encode(&buf, Record{Format: Format, SessionID: "s1", Content: "x"}); err != nil {
		t.Fatal(err)
	}
	half := buf.Bytes()[:buf.Len()/2]
	if _, err := Decode(bytes.NewReader(half)); err == nil {
		t.Fatal("expected truncated input to fail")
	}
}

func TestRepoUsesGitToplevelBasename(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "proj", "a", "b")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "proj", ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := Repo(nested); got != "proj" {
		t.Fatalf("Repo = %q, want %q", got, "proj")
	}
}

func TestRepoNamesALinkedWorktreeForItsRepository(t *testing.T) {
	root := t.TempDir()
	write := func(dir, gitdir string) string {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, ".git"), []byte("gitdir: "+gitdir+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		return filepath.Join(dir, "sub")
	}
	if err := os.MkdirAll(filepath.Join(root, "acme-backend", ".git", "worktrees", "wt"), 0o755); err != nil {
		t.Fatal(err)
	}

	cases := []struct{ name, cwd, want string }{
		{"absolute gitdir", write(filepath.Join(root, "acme-backend", ".claude", "worktrees", "wt"),
			filepath.Join(root, "acme-backend", ".git", "worktrees", "wt")), "acme-backend"},
		{"relative gitdir", write(filepath.Join(root, "elsewhere", "wt2"), "../../acme-backend/.git/worktrees/wt2"), "acme-backend"},
		{"bare repository", write(filepath.Join(root, "wt3"), filepath.Join(root, "infra.git", "worktrees", "wt3")), "infra"},
		{"submodule", write(filepath.Join(root, "acme-backend", "vendored"), "../.git/modules/vendored"), "vendored"},
	}
	for _, c := range cases {
		if got := Repo(c.cwd); got != c.want {
			t.Fatalf("%s: Repo = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestRepoFallsBackToBasename(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "loose")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := Repo(dir); got != "loose" {
		t.Fatalf("Repo = %q, want %q", got, "loose")
	}
}

func TestEncodeRejectsWrongFormat(t *testing.T) {
	var buf bytes.Buffer
	if err := Encode(&buf, Record{Format: "commonmind/99", SessionID: "s1"}); err == nil {
		t.Fatal("expected encode to reject wrong format")
	}
}

func TestEncodeRejectsMissingSessionID(t *testing.T) {
	var buf bytes.Buffer
	if err := Encode(&buf, Record{Format: Format}); err == nil {
		t.Fatal("expected encode to reject missing session_id")
	}
}

// TestDecodeRejectsOversizedRecord is the decompression-bomb case: a tiny
// .cms that decompresses to gigabytes must be rejected as a decode error,
// not streamed into memory.
func TestDecodeRejectsOversizedRecord(t *testing.T) {
	var buf bytes.Buffer
	encoder, err := zstd.NewWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	// Hand-rolled so the giant content never exists in memory here either.
	if _, err := io.WriteString(encoder, `{"format":"`+Format+`","session_id":"bomb","content":"`); err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte("a"), 1<<20)
	for written := 0; written < MaxDecodedBytes+(4<<20); written += len(chunk) {
		if _, err := encoder.Write(chunk); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := io.WriteString(encoder, `"}`); err != nil {
		t.Fatal(err)
	}
	if err := encoder.Close(); err != nil {
		t.Fatal(err)
	}

	if _, err := Decode(bytes.NewReader(buf.Bytes())); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("Decode = %v, want ErrTooLarge", err)
	} else if !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("error does not say the file was too large: %v", err)
	}
}

// TestEncodeRefusesARecordOverTheCeiling: the write side is bounded by the
// same number as the read side, so this program can never publish a file
// its own reader would refuse. A session too large to encode fails loudly,
// naming itself, rather than going missing from the folder in silence.
func TestEncodeRefusesARecordOverTheCeiling(t *testing.T) {
	rec := Record{
		Format:    Format,
		SessionID: "oversized-session",
		Content:   strings.Repeat("a", MaxDecodedBytes+1),
	}
	var buf bytes.Buffer
	err := Encode(&buf, rec)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("Encode = %v, want ErrTooLarge", err)
	}
	if !strings.Contains(err.Error(), "oversized-session") || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("error does not name the session and the ceiling: %v", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("an oversized record wrote %d bytes; nothing should have been written", buf.Len())
	}
}

// TestDecodeBoundsTheWindowOfATinyFile: a zstd frame names its own window, and
// the decoder allocates it before reading a byte of content. These ten bytes
// ask for 512 MiB.
func TestDecodeBoundsTheWindowOfATinyFile(t *testing.T) {
	frame := []byte{0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x98, 0x09, 0x00, 0x00, '{'}
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	_, err := Decode(bytes.NewReader(frame))
	runtime.ReadMemStats(&after)
	if err == nil {
		t.Fatal("decoded a frame that holds no record")
	}
	if spent := (after.TotalAlloc - before.TotalAlloc) >> 20; spent > 64 {
		t.Fatalf("decoding ten bytes allocated %d MiB", spent)
	}
}

// TestDecodeRejectsATimeItCouldNotWriteBack: Go reads a zone of +24:00 and then
// refuses to write it, which took the MCP server down on its first search.
func TestDecodeRejectsATimeItCouldNotWriteBack(t *testing.T) {
	var file bytes.Buffer
	w, err := zstd.NewWriter(&file)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte(`{"format":"commonmind/1","session_id":"x","started_at":"2026-09-18T10:00:00+24:00","content":"hello"}`))
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if rec, err := Decode(&file); err == nil {
		t.Fatalf("decoded a record whose start cannot be written back: %v", rec.StartedAt)
	}
}
