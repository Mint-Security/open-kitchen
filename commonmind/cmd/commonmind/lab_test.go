package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// The tests in this file's family drive Commonmind the way a user and an agent
// do: the built binary as a subprocess, transcripts shaped like the ones the
// agents write, and the MCP server over its real stdio transport.

var labBinary struct {
	once sync.Once
	dir  string
	path string
	err  error
}

func TestMain(m *testing.M) {
	code := m.Run()
	if labBinary.dir != "" {
		os.RemoveAll(labBinary.dir)
	}
	os.Exit(code)
}

// commonmindBinary builds the CLI once per test run and returns its path.
func commonmindBinary(t *testing.T) string {
	t.Helper()
	labBinary.once.Do(func() {
		labBinary.dir, labBinary.err = os.MkdirTemp("", "commonmind-lab-")
		if labBinary.err != nil {
			return
		}
		labBinary.path = filepath.Join(labBinary.dir, "commonmind")
		if output, err := exec.Command("go", "build", "-o", labBinary.path, ".").CombinedOutput(); err != nil {
			labBinary.err = fmt.Errorf("build commonmind: %v: %s", err, output)
		}
	})
	if labBinary.err != nil {
		t.Fatal(labBinary.err)
	}
	return labBinary.path
}

// labEnv is the environment of one machine in a test: its own user home and
// its own Commonmind home, so nothing reaches the developer's real ones.
func labEnv(userHome, commonmindHome string, extra ...string) []string {
	env := make([]string, 0, len(os.Environ())+len(extra)+2)
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "HOME=") && !strings.HasPrefix(kv, "COMMONMIND_HOME=") {
			env = append(env, kv)
		}
	}
	return append(append(env, "HOME="+userHome, "COMMONMIND_HOME="+commonmindHome), extra...)
}

// runBinary runs one CLI command to completion and returns its output.
func runBinary(ctx context.Context, exe string, env []string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.Env = env
	output, err := cmd.CombinedOutput()
	return string(output), err
}

// mcpClient speaks JSON-RPC to a running `commonmind mcp` over its stdio.
type mcpClient struct {
	t      *testing.T
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	stderr bytes.Buffer
	nextID int
	done   chan error
}

func startMCP(t *testing.T, ctx context.Context, exe string, env []string) *mcpClient {
	t.Helper()
	cmd := exec.CommandContext(ctx, exe, "mcp")
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	client := &mcpClient{t: t, cmd: cmd, stdin: stdin, stdout: bufio.NewReaderSize(stdout, 1<<20), done: make(chan error, 1)}
	cmd.Stderr = &client.stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// A test that already waited has taken the exit status; this only
		// reaps a server a failed test left running.
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})
	var initialized struct {
		ServerInfo struct {
			Name string `json:"name"`
		} `json:"serverInfo"`
		Capabilities map[string]any `json:"capabilities"`
	}
	client.request("initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "commonmind-lab", "version": "0"},
	}, &initialized)
	if initialized.ServerInfo.Name != "commonmind" || initialized.Capabilities["tools"] == nil {
		t.Fatalf("unexpected initialize result: %+v", initialized)
	}
	client.notify("notifications/initialized")
	return client
}

func (c *mcpClient) send(message map[string]any) {
	c.t.Helper()
	data, err := json.Marshal(message)
	if err != nil {
		c.t.Fatal(err)
	}
	if _, err := c.stdin.Write(append(data, '\n')); err != nil {
		c.t.Fatalf("write to commonmind mcp: %v (stderr: %s)", err, c.stderr.String())
	}
}

func (c *mcpClient) notify(method string) {
	c.t.Helper()
	c.send(map[string]any{"jsonrpc": "2.0", "method": method})
}

// request sends one request and decodes its result into result.
func (c *mcpClient) request(method string, params, result any) {
	c.t.Helper()
	c.nextID++
	message := map[string]any{"jsonrpc": "2.0", "id": c.nextID, "method": method}
	if params != nil {
		message["params"] = params
	}
	c.send(message)
	line, err := c.stdout.ReadBytes('\n')
	if err != nil {
		c.t.Fatalf("read %s response: %v (stderr: %s)", method, err, c.stderr.String())
	}
	var response struct {
		ID     int             `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(line, &response); err != nil {
		c.t.Fatalf("decode %s response: %v", method, err)
	}
	if response.ID != c.nextID {
		c.t.Fatalf("%s: response id %d; want %d", method, response.ID, c.nextID)
	}
	if response.Error != nil {
		c.t.Fatalf("%s: JSON-RPC error %d: %s", method, response.Error.Code, response.Error.Message)
	}
	if result != nil {
		if err := json.Unmarshal(response.Result, result); err != nil {
			c.t.Fatalf("decode %s result: %v", method, err)
		}
	}
}

// tool calls one tool and decodes its structured result into result. The text
// form of the answer has to be the same data: clients differ in which they read.
func (c *mcpClient) tool(name string, arguments map[string]any, result any) {
	c.t.Helper()
	if arguments == nil {
		arguments = map[string]any{}
	}
	var answer struct {
		IsError bool `json:"isError"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		StructuredContent struct {
			Result json.RawMessage `json:"result"`
		} `json:"structuredContent"`
	}
	c.request("tools/call", map[string]any{"name": name, "arguments": arguments}, &answer)
	if answer.IsError || len(answer.Content) != 1 {
		c.t.Fatalf("%s %v failed: %+v", name, arguments, answer.Content)
	}
	var fromText, fromStructured any
	if err := json.Unmarshal([]byte(answer.Content[0].Text), &fromText); err != nil {
		c.t.Fatalf("%s: text content is not JSON: %v", name, err)
	}
	if err := json.Unmarshal(answer.StructuredContent.Result, &fromStructured); err != nil {
		c.t.Fatalf("%s: structured content is not JSON: %v", name, err)
	}
	if a, b := fmt.Sprint(fromText), fmt.Sprint(fromStructured); a != b {
		c.t.Fatalf("%s: text and structured content disagree", name)
	}
	if err := json.Unmarshal(answer.StructuredContent.Result, result); err != nil {
		c.t.Fatalf("decode %s result: %v", name, err)
	}
}

type mcpHit struct {
	SessionID    string    `json:"session_id"`
	Author       string    `json:"author"`
	Agent        string    `json:"agent"`
	Repo         string    `json:"repo"`
	CWD          string    `json:"cwd"`
	AgentVersion string    `json:"agent_version"`
	StartedAt    time.Time `json:"started_at"`
}

type mcpAuthor struct {
	Author   string `json:"author"`
	Sessions int    `json:"sessions"`
}

type mcpSessionFile struct {
	mcpHit
	Transcript      string `json:"transcript"`
	TranscriptBytes int    `json:"transcript_bytes"`
	Offset          int    `json:"offset"`
	Truncated       bool   `json:"truncated"`
	NextOffset      int    `json:"next_offset"`
	Error           string `json:"error"`
}

func (c *mcpClient) search(arguments map[string]any) []mcpHit {
	c.t.Helper()
	var hits []mcpHit
	c.tool("search_sessions", arguments, &hits)
	return hits
}

func (c *mcpClient) authors() map[string]int {
	c.t.Helper()
	var listed []mcpAuthor
	c.tool("list_authors", nil, &listed)
	counts := map[string]int{}
	for _, author := range listed {
		counts[author.Author] = author.Sessions
	}
	return counts
}

// readSession reads a single-file session to its end the way the tool tells an
// agent to: call again with offset set to next_offset while truncated is true.
// Every window but the last has to end on a line break.
func (c *mcpClient) readSession(sessionID string) (mcpHit, string) {
	c.t.Helper()
	var transcript strings.Builder
	var first mcpHit
	for offset, pages := 0, 0; ; pages++ {
		if pages > 10000 {
			c.t.Fatalf("get_session %s did not reach the end", sessionID)
		}
		var files []mcpSessionFile
		c.tool("get_session", map[string]any{"session_id": sessionID, "offset": offset}, &files)
		if len(files) != 1 {
			c.t.Fatalf("get_session %s returned %d files; want 1", sessionID, len(files))
		}
		file := files[0]
		if file.Error != "" {
			c.t.Fatalf("get_session %s: %s", sessionID, file.Error)
		}
		if pages == 0 {
			first = file.mcpHit
		}
		transcript.WriteString(file.Transcript)
		if !file.Truncated {
			if transcript.Len() != file.TranscriptBytes {
				c.t.Fatalf("get_session %s: read %d bytes; transcript_bytes says %d", sessionID, transcript.Len(), file.TranscriptBytes)
			}
			return first, transcript.String()
		}
		if file.NextOffset <= offset {
			c.t.Fatalf("get_session %s: next_offset %d does not move past %d", sessionID, file.NextOffset, offset)
		}
		offset = file.NextOffset
	}
}

// close ends the session the way an MCP client does, by closing the server's
// stdin, and requires a clean exit.
func (c *mcpClient) close() {
	c.t.Helper()
	if err := c.stdin.Close(); err != nil {
		c.t.Fatal(err)
	}
	if err := c.wait(10 * time.Second); err != nil {
		c.t.Fatalf("commonmind mcp did not exit cleanly after its stdin closed: %v (stderr: %s)", err, c.stderr.String())
	}
}

func (c *mcpClient) wait(timeout time.Duration) error {
	go func() { c.done <- c.cmd.Wait() }()
	select {
	case err := <-c.done:
		return err
	case <-time.After(timeout):
		return fmt.Errorf("still running after %s", timeout)
	}
}

func (c *mcpClient) signal(sig syscall.Signal) {
	c.t.Helper()
	if err := c.cmd.Process.Signal(sig); err != nil {
		c.t.Fatal(err)
	}
}

// --- transcripts ---------------------------------------------------------

// jsonLine marshals one transcript record the way the agents write it: one
// compact JSON object, with <, > and & left as they are.
func jsonLine(record map[string]any) string {
	var b bytes.Buffer
	encoder := json.NewEncoder(&b)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(record); err != nil {
		panic(err)
	}
	return b.String()
}

func stamp(start time.Time, step int) string {
	return start.Add(time.Duration(step) * 1700 * time.Millisecond).UTC().Format("2006-01-02T15:04:05.000Z")
}

// toolOutput is command output of about size bytes: several lines, with the
// tabs, quotes, escapes and non-ASCII text that real output has.
func toolOutput(turn, size int) string {
	var b strings.Builder
	for line := 0; b.Len() < size; line++ {
		fmt.Fprintf(&b, "ingress-nginx-%04d-%03d\t1/1\tRunning\t\"zone=eu-west-1%c\"\tC:\\logs\\pod.log\t→ café naïve 日本語 ✓ \x1b[32mok\x1b[0m\n", turn, line, 'a'+rune(line%3))
	}
	return b.String()
}

// claudeTranscript builds a Claude Code session transcript: a file-history
// snapshot first (so the opening line carries no session id), then per turn a
// user prompt, an assistant message that calls a tool, the tool result, and a
// closing assistant message. marker is text only this transcript contains.
// outputBytes sizes each tool result; firstTurn lets a later call continue a
// transcript where an earlier one stopped.
func claudeTranscript(sessionID, cwd, marker string, start time.Time, firstTurn, turns, outputBytes int) string {
	var b strings.Builder
	if firstTurn == 0 {
		b.WriteString(jsonLine(map[string]any{
			"type": "file-history-snapshot", "messageId": sessionID + "-snapshot", "isSnapshotUpdate": false,
			"snapshot": map[string]any{"messageId": sessionID + "-snapshot", "trackedFileBackups": map[string]any{}, "timestamp": stamp(start, 0)},
		}))
	}
	common := func(kind, uuid, parent string, step int) map[string]any {
		record := map[string]any{
			"type": kind, "uuid": uuid, "parentUuid": parent, "isSidechain": false, "userType": "external",
			"cwd": cwd, "sessionId": sessionID, "version": "2.1.291", "gitBranch": "main", "timestamp": stamp(start, step),
		}
		if parent == "" {
			record["parentUuid"] = nil
		}
		return record
	}
	for turn := firstTurn; turn < firstTurn+turns; turn++ {
		id := func(part string) string { return fmt.Sprintf("%s-%04d-%s", sessionID[:8], turn, part) }
		parent := ""
		if turn > 0 {
			parent = fmt.Sprintf("%s-%04d-%s", sessionID[:8], turn-1, "answer")
		}
		step := turn * 4

		prompt := common("user", id("prompt"), parent, step)
		prompt["message"] = map[string]any{"role": "user", "content": fmt.Sprintf("Turn %d: why does the %s path time out? Check the \"upstream\" block & the <timeouts>.", turn, marker)}
		b.WriteString(jsonLine(prompt))

		call := common("assistant", id("call"), id("prompt"), step+1)
		call["requestId"] = "req_" + id("call")
		call["message"] = map[string]any{
			"id": "msg_" + id("call"), "type": "message", "role": "assistant", "model": "claude-fixture", "stop_reason": "tool_use",
			"content": []any{
				map[string]any{"type": "text", "text": "I'll look at the running pods first."},
				map[string]any{"type": "tool_use", "id": "toolu_" + id("call"), "name": "Bash", "input": map[string]any{"command": "kubectl get pods -n ingress -o wide | grep -v 'Completed'", "description": "List ingress pods"}},
			},
			"usage": map[string]any{"input_tokens": 1200 + turn, "output_tokens": 85, "cache_read_input_tokens": 40000},
		}
		b.WriteString(jsonLine(call))

		output := toolOutput(turn, outputBytes)
		result := common("user", id("result"), id("call"), step+2)
		result["message"] = map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "tool_result", "tool_use_id": "toolu_" + id("call"), "content": output, "is_error": false},
		}}
		result["toolUseResult"] = map[string]any{"stdout": output, "stderr": "", "interrupted": false, "isImage": false}
		b.WriteString(jsonLine(result))

		answer := common("assistant", id("answer"), id("result"), step+3)
		answer["requestId"] = "req_" + id("answer")
		answer["message"] = map[string]any{
			"id": "msg_" + id("answer"), "type": "message", "role": "assistant", "model": "claude-fixture", "stop_reason": "end_turn",
			"content": []any{map[string]any{"type": "text", "text": fmt.Sprintf("All pods are running, so the %s timeout is not a crash loop.\n\n```yaml\nproxy-read-timeout: \"60\"\n```", marker)}},
			"usage":   map[string]any{"input_tokens": 1400 + turn, "output_tokens": 240},
		}
		b.WriteString(jsonLine(answer))
	}
	return b.String()
}

// codexTranscript builds a Codex rollout: a session_meta envelope whose payload
// holds the identity, then per turn the user message, a reasoning item, a
// function call with its output, the assistant message and a token count.
func codexTranscript(sessionID, cwd, marker string, start time.Time, firstTurn, turns int) string {
	var b strings.Builder
	line := func(step int, kind string, payload map[string]any) {
		b.WriteString(jsonLine(map[string]any{"timestamp": stamp(start, step), "type": kind, "payload": payload}))
	}
	if firstTurn == 0 {
		line(0, "session_meta", map[string]any{
			"id": sessionID, "timestamp": stamp(start, 0), "cwd": cwd, "originator": "codex_cli_rs", "cli_version": "0.153.4",
			"instructions": strings.Repeat("You are a coding agent running in the Codex CLI. ", 200),
			"git":          map[string]any{"commit_hash": "9f2c1e7", "branch": "main", "repository_url": "https://example.invalid/acme/api.git"},
		})
	}
	for turn := firstTurn; turn < firstTurn+turns; turn++ {
		step := 1 + turn*6
		callID := fmt.Sprintf("call_%s_%04d", sessionID[:8], turn)
		line(step, "turn_context", map[string]any{"cwd": cwd, "approval_policy": "on-request", "sandbox_policy": map[string]any{"mode": "workspace-write"}, "model": "codex-fixture"})
		line(step+1, "response_item", map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": fmt.Sprintf("Turn %d: make the %s test pass.", turn, marker)}}})
		line(step+2, "response_item", map[string]any{"type": "reasoning", "summary": []any{map[string]any{"type": "summary_text", "text": "**Running the tests**"}}, "encrypted_content": strings.Repeat("gAAAAAB", 60)})
		line(step+3, "response_item", map[string]any{"type": "function_call", "name": "shell", "call_id": callID, "arguments": `{"command":["bash","-lc","go test ./... 2>&1 | tail -n 20"],"workdir":"` + cwd + `"}`})
		line(step+4, "response_item", map[string]any{"type": "function_call_output", "call_id": callID, "output": `{"output":"ok  \texample.invalid/acme/api\t0.412s\n","metadata":{"exit_code":0,"duration_seconds":1.9}}`})
		line(step+5, "response_item", map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": fmt.Sprintf("The %s test passes now.", marker)}}})
		line(step+5, "event_msg", map[string]any{"type": "token_count", "info": map[string]any{"total_token_usage": map[string]any{"input_tokens": 9000 + turn, "output_tokens": 300, "total_tokens": 9300 + turn}}})
	}
	return b.String()
}

// writeTranscript writes content where an agent would, and appendTranscript
// adds to it the way a running agent does.
func writeTranscript(t *testing.T, path, content string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func appendTranscript(t *testing.T, path, content string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(content); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func claudePath(root, project, sessionID string) string {
	return filepath.Join(root, project, sessionID+".jsonl")
}

func codexPath(root, sessionID string, start time.Time) string {
	day := start.UTC()
	return filepath.Join(root, day.Format("2006"), day.Format("01"), day.Format("02"), "rollout-"+day.Format("2006-01-02T15-04-05")+"-"+sessionID+".jsonl")
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
