package mcpserver

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/session"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/store"
)

// jsonlTranscript builds a transcript of whole JSONL lines whose lengths vary
// with seed, so two transcripts never break their lines at the same offsets.
func jsonlTranscript(seed, lines int) string {
	var b strings.Builder
	for i := 0; i < lines; i++ {
		fmt.Fprintf(&b, `{"n":%d,"text":"%s — naïve café"}`+"\n", i, strings.Repeat("x", 40+(i*seed)%97))
	}
	return b.String()
}

// TestGetSessionPagesEveryFileOfAResumedSession: a resumed session is one
// session id in two published files, and get_session answers with both. A
// client that reads on the way the tool tells it to — call again with offset
// set to next_offset — must end up with each file's transcript exactly: no
// bytes dropped, none repeated, and every window made of whole lines.
//
// The two files are told apart by started_at, the only field in the response
// that differs between them.
func TestGetSessionPagesEveryFileOfAResumedSession(t *testing.T) {
	st := store.New(t.TempDir())
	if err := st.Init(); err != nil {
		t.Fatal(err)
	}
	const window = 4096
	sources := map[string]string{}
	for i, source := range []struct {
		file, hash string
		seed       int
	}{{"first.jsonl", "aaaaaaaa", 7}, {"second.jsonl", "bbbbbbbb", 13}} {
		started := time.Date(2026, 9, 18, 7+i, 0, 0, 0, time.UTC)
		content := jsonlTranscript(source.seed, 400)
		if len(content) < 3*window {
			t.Fatalf("fixture is too small to need paging: %d bytes", len(content))
		}
		rec := session.Record{
			Format: session.Format, SessionID: "resumed", Author: "a@b.c", Agent: "claude",
			CWD: "/tmp/proj", Repo: "proj", SourceFile: source.file,
			StartedAt: started, EndedAt: started.Add(time.Hour),
			ContentHash: "sha256:" + source.file, Content: content,
		}
		if _, err := st.Publish(rec, source.hash); err != nil {
			t.Fatal(err)
		}
		sources[started.Format(time.RFC3339)] = content
	}

	srv := New(st)
	got := map[string]*strings.Builder{}
	for key := range sources {
		got[key] = &strings.Builder{}
	}
	offset := 0
	for page := 0; ; page++ {
		if page > 1000 {
			t.Fatal("paging did not terminate")
		}
		response := call(t, srv, fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_session","arguments":{"session_id":"resumed","offset":%d,"max_bytes":%d}}}`, offset, window))
		body, _ := json.Marshal(response["result"])
		var result struct {
			IsError           bool `json:"isError"`
			StructuredContent struct {
				Result []struct {
					StartedAt  time.Time `json:"started_at"`
					Transcript string    `json:"transcript"`
					Truncated  bool      `json:"truncated"`
					NextOffset int       `json:"next_offset"`
				} `json:"result"`
			} `json:"structuredContent"`
		}
		if err := json.Unmarshal(body, &result); err != nil || result.IsError {
			t.Fatalf("get_session failed: %v %s", err, body)
		}
		next := -1
		for _, entry := range result.StructuredContent.Result {
			key := entry.StartedAt.UTC().Format(time.RFC3339)
			if got[key] == nil {
				t.Fatalf("get_session returned a file that was never published: started_at %s", key)
			}
			if entry.Transcript != "" && !strings.HasSuffix(entry.Transcript, "\n") && entry.Truncated {
				t.Errorf("page %d of %s ends in the middle of a line", page, key)
			}
			got[key].WriteString(entry.Transcript)
			if entry.Truncated && next < 0 {
				next = entry.NextOffset
			}
		}
		if next < 0 {
			break
		}
		if next <= offset {
			t.Fatalf("next_offset %d does not move past offset %d", next, offset)
		}
		offset = next
	}
	for key, want := range sources {
		if have := got[key].String(); have != want {
			t.Errorf("file started at %s: paging rebuilt %d bytes, the transcript is %d bytes; they differ first at byte %d", key, len(have), len(want), firstDifference(have, want))
		}
	}
}

func firstDifference(a, b string) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return i
		}
	}
	return min(len(a), len(b))
}
