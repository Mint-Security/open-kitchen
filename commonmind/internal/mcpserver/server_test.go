package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/session"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/store"
	"github.com/klauspost/compress/zstd"
)

func call(t *testing.T, srv *Server, line string) map[string]any {
	t.Helper()
	var out bytes.Buffer
	if err := srv.Serve(context.Background(), strings.NewReader(line+"\n"), &out); err != nil && err != context.Canceled {
		t.Fatalf("serve: %v", err)
	}
	var response map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(out.Bytes()), &response); err != nil {
		t.Fatalf("decode response %q: %v", out.String(), err)
	}
	return response
}

func fixture(t *testing.T) (*Server, string) {
	t.Helper()
	root := t.TempDir()
	st := store.New(root)
	if err := st.Init(); err != nil {
		t.Fatal(err)
	}
	rec := session.Record{
		Format: session.Format, SessionID: "abc", Author: "a@b.c", Agent: "claude",
		CWD: "/tmp/proj", Repo: "proj", SourceFile: "abc.jsonl",
		StartedAt: time.Now().UTC(), EndedAt: time.Now().UTC(),
		ContentHash: "sha256:abc", Content: "the ingress controller was misconfigured",
	}
	if _, err := st.Publish(rec, "aaaaaaaa"); err != nil {
		t.Fatal(err)
	}
	return New(st), root
}

func TestToolsListAdvertisesTheReadOnlyTools(t *testing.T) {
	srv, _ := fixture(t)
	response := call(t, srv, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	result := response["result"].(map[string]any)
	tools := result["tools"].([]any)
	advertised := map[string]bool{}
	for _, tool := range tools {
		entry := tool.(map[string]any)
		advertised[entry["name"].(string)] = true
		annotations := entry["annotations"].(map[string]any)
		if annotations["readOnlyHint"] != true {
			t.Fatalf("tool %v is not advertised read-only", entry["name"])
		}
	}
	for _, want := range []string{"search_sessions", "list_authors", "get_session"} {
		if !advertised[want] {
			t.Fatalf("tools/list does not advertise %q: %v", want, advertised)
		}
	}
	if len(tools) != 3 {
		t.Fatalf("advertised %d tools, want 3", len(tools))
	}
}

func TestInitializeReportsTheBuildVersion(t *testing.T) {
	srv, _ := fixture(t)
	srv.Version = "v1.2.3"
	response := call(t, srv, `{"jsonrpc":"2.0","id":1,"method":"initialize"}`)
	info := response["result"].(map[string]any)["serverInfo"].(map[string]any)
	if info["version"] != "v1.2.3" {
		t.Fatalf("serverInfo.version = %v; want the version this binary was built as", info["version"])
	}
}

func TestSearchSessionsFindsPublishedSession(t *testing.T) {
	srv, _ := fixture(t)
	response := call(t, srv, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_sessions","arguments":{"query":"ingress"}}}`)
	body, _ := json.Marshal(response["result"])
	if !strings.Contains(string(body), "abc") {
		t.Fatalf("search did not return the session: %s", body)
	}
}

func TestGetSessionReturnsTranscriptFromFile(t *testing.T) {
	srv, _ := fixture(t)
	response := call(t, srv, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_session","arguments":{"session_id":"abc"}}}`)
	body, _ := json.Marshal(response["result"])
	if !strings.Contains(string(body), "misconfigured") {
		t.Fatalf("get_session did not return file content: %s", body)
	}
}

func TestGetSessionPagesALargeTranscriptToTheEnd(t *testing.T) {
	root := t.TempDir()
	st := store.New(root)
	if err := st.Init(); err != nil {
		t.Fatal(err)
	}
	content := strings.Repeat("large transcript with Unicode שלום\n", 70000) + "END-OF-SESSION"
	rec := session.Record{Format: session.Format, SessionID: "large", Author: "fixture", Content: content, ContentHash: "large"}
	if _, err := st.Publish(rec, "abcdef01"); err != nil {
		t.Fatal(err)
	}
	srv := New(st)

	var read strings.Builder
	offset, pages := 0, 0
	for {
		response := call(t, srv, fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_session","arguments":{"session_id":"large","offset":%d}}}`, offset))
		result := response["result"].(map[string]any)
		entry := result["structuredContent"].(map[string]any)["result"].([]any)[0].(map[string]any)
		var textEntries []map[string]any
		text := result["content"].([]any)[0].(map[string]any)["text"].(string)
		if err := json.Unmarshal([]byte(text), &textEntries); err != nil {
			t.Fatal(err)
		}
		window := entry["transcript"].(string)
		if textEntries[0]["transcript"] != window {
			t.Fatal("text result differs from structured result")
		}
		if len(window) > defaultTranscriptWindow {
			t.Fatalf("window of %d bytes exceeds the %d byte default", len(window), defaultTranscriptWindow)
		}
		if int(entry["transcript_bytes"].(float64)) != len(content) {
			t.Fatalf("transcript_bytes = %v, want %d", entry["transcript_bytes"], len(content))
		}
		read.WriteString(window)
		pages++
		if entry["truncated"] == false {
			if _, ok := entry["next_offset"]; ok {
				t.Fatal("the last window still carries a next_offset")
			}
			break
		}
		if !strings.HasSuffix(window, "\n") {
			t.Fatalf("window %d does not end on a line break", pages)
		}
		offset = int(entry["next_offset"].(float64))
	}
	if pages < 2 {
		t.Fatalf("a %d byte transcript was read in %d window(s)", len(content), pages)
	}
	if read.String() != content {
		t.Fatal("the windows do not add up to the transcript")
	}
}

func TestTranscriptWindow(t *testing.T) {
	cases := []struct {
		name        string
		content     string
		offset, max int
		window      string
		next        int
	}{
		{"whole", "a\nb\n", 0, 100, "a\nb\n", 4},
		{"ends on the last line break", "one\ntwo\nthree", 0, 9, "one\ntwo\n", 8},
		{"reads on from an offset", "one\ntwo\nthree", 8, 9, "three", 13},
		{"a long line is cut on a rune boundary", "שלום", 0, 3, "ש", 2},
		{"a window smaller than one rune still advances", "שלום", 0, 1, "ש", 2},
		{"past the end", "abc", 10, 5, "", 3},
	}
	for _, c := range cases {
		window, next := transcriptWindow(c.content, c.offset, c.max)
		if window != c.window || next != c.next {
			t.Fatalf("%s: got (%q, %d), want (%q, %d)", c.name, window, next, c.window, c.next)
		}
	}
	if windowSize(0) != defaultTranscriptWindow || windowSize(maxTranscriptWindow+1) != maxTranscriptWindow || windowSize(10) != 10 {
		t.Fatal("windowSize does not apply the default and the ceiling")
	}
}

func TestSearchSessionsAndGetSessionIncludeAgentVersion(t *testing.T) {
	root := t.TempDir()
	st := store.New(root)
	if err := st.Init(); err != nil {
		t.Fatal(err)
	}
	rec := session.Record{
		Format: session.Format, SessionID: "branched", Author: "a@b.c", Agent: "claude",
		CWD: "/tmp/proj", Repo: "proj", SourceFile: "branched.jsonl",
		AgentVersion: "1.2.3",
		StartedAt:    time.Now().UTC(), EndedAt: time.Now().UTC(),
		ContentHash: "sha256:branched", Content: "the branch-specific ingress fix",
	}
	if _, err := st.Publish(rec, "bbbbbbbb"); err != nil {
		t.Fatal(err)
	}
	srv := New(st)

	search := call(t, srv, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_sessions","arguments":{"query":"branch-specific"}}}`)
	searchBody, _ := json.Marshal(search["result"])
	if !strings.Contains(string(searchBody), "1.2.3") {
		t.Fatalf("search_sessions did not surface agent_version: %s", searchBody)
	}

	get := call(t, srv, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_session","arguments":{"session_id":"branched"}}}`)
	getBody, _ := json.Marshal(get["result"])
	if !strings.Contains(string(getBody), "1.2.3") {
		t.Fatalf("get_session did not surface agent_version: %s", getBody)
	}
}

func TestUnknownToolIsAnError(t *testing.T) {
	srv, _ := fixture(t)
	response := call(t, srv, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"nope","arguments":{}}}`)
	body, _ := json.Marshal(response["result"])
	if !strings.Contains(string(body), "isError") && response["error"] == nil {
		t.Fatalf("unknown tool did not error: %s", body)
	}
}

// TestGetSessionReturnsEveryFileForAResumedSession: one session id can
// legitimately live in two published files, and get_session returns both.
func TestGetSessionReturnsEveryFileForAResumedSession(t *testing.T) {
	root := t.TempDir()
	st := store.New(root)
	if err := st.Init(); err != nil {
		t.Fatal(err)
	}
	rec := session.Record{
		Format: session.Format, SessionID: "resumed", Author: "a@b.c", Agent: "claude",
		CWD: "/tmp/proj", Repo: "proj", SourceFile: "first.jsonl",
		StartedAt: time.Now().UTC(), EndedAt: time.Now().UTC(),
		ContentHash: "sha256:first", Content: "the original conversation",
	}
	if _, err := st.Publish(rec, "aaaaaaaa"); err != nil {
		t.Fatal(err)
	}
	rec.SourceFile = "second.jsonl"
	rec.ContentHash = "sha256:second"
	rec.Content = "the resumed conversation"
	if _, err := st.Publish(rec, "bbbbbbbb"); err != nil {
		t.Fatal(err)
	}

	response := call(t, New(st), `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_session","arguments":{"session_id":"resumed"}}}`)
	body, _ := json.Marshal(response["result"])
	if !strings.Contains(string(body), "the original conversation") || !strings.Contains(string(body), "the resumed conversation") {
		t.Fatalf("get_session did not return both files of the session: %s", body)
	}
}

func TestSearchSessionsFiltersOnMetadataWithoutAQuery(t *testing.T) {
	root := t.TempDir()
	st := store.New(root)
	if err := st.Init(); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		id, author string
		started    time.Time
	}{
		{"sam-new", "sam@x.y", time.Date(2026, 9, 22, 8, 0, 0, 0, time.UTC)},
		{"sam-old", "sam@x.y", time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC)},
		{"alex-new", "alex@x.y", time.Date(2026, 9, 22, 9, 0, 0, 0, time.UTC)},
	} {
		rec := session.Record{
			Format: session.Format, SessionID: c.id, Author: c.author, Agent: "claude",
			CWD: "/tmp/proj", Repo: "proj", SourceFile: c.id + ".jsonl",
			StartedAt: c.started, EndedAt: c.started.Add(time.Hour),
			ContentHash: "sha256:" + c.id, Content: "ingress",
		}
		if _, err := st.Publish(rec, "cccccccc"); err != nil {
			t.Fatal(err)
		}
	}
	srv := New(st)

	response := call(t, srv, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_sessions","arguments":{"author":"sam","since":"2026-09-17","until":"2026-09-23"}}}`)
	body, _ := json.Marshal(response["result"])
	if !strings.Contains(string(body), "sam-new") || strings.Contains(string(body), "sam-old") || strings.Contains(string(body), "alex-new") {
		t.Fatalf("author + window search returned the wrong sessions: %s", body)
	}

	response = call(t, srv, `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"search_sessions","arguments":{"exclude_author":"sam"}}}`)
	body, _ = json.Marshal(response["result"])
	if !strings.Contains(string(body), "alex-new") || strings.Contains(string(body), "sam-") {
		t.Fatalf("exclude_author alone must list everyone else's sessions: %s", body)
	}

	response = call(t, srv, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_sessions","arguments":{}}}`)
	body, _ = json.Marshal(response["result"])
	if !strings.Contains(string(body), `"isError":true`) {
		t.Fatalf("a search with no query and no filter must be an error: %s", body)
	}

	response = call(t, srv, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_sessions","arguments":{"since":"last tuesday"}}}`)
	body, _ = json.Marshal(response["result"])
	if !strings.Contains(string(body), `"isError":true`) || !strings.Contains(string(body), "since") {
		t.Fatalf("an unparseable since must be an error naming the field: %s", body)
	}

	response = call(t, srv, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_authors","arguments":{}}}`)
	body, _ = json.Marshal(response["result"])
	if !strings.Contains(string(body), `"author":"sam@x.y"`) || !strings.Contains(string(body), `"sessions":2`) || !strings.Contains(string(body), `"latest_day":"2026-09-22"`) {
		t.Fatalf("list_authors did not describe the authors: %s", body)
	}
}

func TestParseWhen(t *testing.T) {
	if got, err := parseWhen(""); err != nil || !got.IsZero() {
		t.Fatalf("empty = %v, %v; want zero", got, err)
	}
	if got, err := parseWhen("2026-09-17"); err != nil || !got.Equal(time.Date(2026, 9, 17, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("day = %v, %v", got, err)
	}
	if got, err := parseWhen("2026-09-17T10:30:00+03:00"); err != nil || !got.Equal(time.Date(2026, 9, 17, 7, 30, 0, 0, time.UTC)) {
		t.Fatalf("rfc3339 = %v, %v", got, err)
	}
	got, err := parseWhen("5d")
	if err != nil {
		t.Fatal(err)
	}
	if d := time.Since(got) - 5*24*time.Hour; d < 0 || d > time.Minute {
		t.Fatalf("5d resolved to %v, not five days before now", got)
	}
	for _, bad := range []string{"yesterday", "-3d", "2026-13-40"} {
		if _, err := parseWhen(bad); err == nil {
			t.Fatalf("parseWhen(%q) accepted", bad)
		}
	}
}

// TestSearchAnswersWhenAFileCarriesAnUnusableTime: one teammate's file must not
// cost everyone the server. The search skips it, like any file it cannot read.
func TestSearchAnswersWhenAFileCarriesAnUnusableTime(t *testing.T) {
	srv, root := fixture(t)
	day := filepath.Join(root, "sessions", "mallory", time.Now().UTC().Format("2006-01-02"))
	if err := os.MkdirAll(day, 0o755); err != nil {
		t.Fatal(err)
	}
	var file bytes.Buffer
	w, err := zstd.NewWriter(&file)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now().UTC().Format("2006-01-02T15:04:05") + "+24:00"
	_, _ = w.Write([]byte(`{"format":"commonmind/1","session_id":"x","started_at":"` + started + `","content":"hello"}`))
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(day, "x-00000000.cms"), file.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}

	response := call(t, srv, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_sessions","arguments":{"since":"7d"}}}`)
	body, _ := json.Marshal(response["result"])
	if !strings.Contains(string(body), "abc") || strings.Contains(string(body), "mallory") {
		t.Fatalf("search did not answer with the readable session alone: %s", body)
	}
}
