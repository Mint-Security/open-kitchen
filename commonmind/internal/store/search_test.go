package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/session"
)

func searchFixture(t *testing.T) *Store {
	t.Helper()
	st := New(t.TempDir())
	if err := st.Init(); err != nil {
		t.Fatal(err)
	}
	return st
}

func publish(t *testing.T, st *Store, author, sessionID, content string) {
	t.Helper()
	rec := session.Record{
		Format: session.Format, SessionID: sessionID, Author: author, Agent: "claude",
		CWD: "/tmp/proj", Repo: "proj", AgentVersion: "1.2.3", SourceFile: sessionID + ".jsonl",
		StartedAt:   time.Date(2026, 9, 18, 7, 12, 3, 0, time.UTC),
		EndedAt:     time.Date(2026, 9, 18, 8, 2, 55, 0, time.UTC),
		ContentHash: "sha256:" + sessionID, Content: content,
	}
	if _, err := st.Publish(rec, fmt.Sprintf("%08x", len(sessionID))); err != nil {
		t.Fatal(err)
	}
}

func TestSearchFindsAPublishedSessionAndItsMetadata(t *testing.T) {
	st := searchFixture(t)
	publish(t, st, "a@b.c", "abc", "the ingress controller was misconfigured")
	publish(t, st, "dana@b.c", "xyz", "nothing to see here")

	hits, err := st.Search(Query{Text: "INGRESS controller", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 {
		t.Fatalf("search returned %d hits, want 1: %+v", len(hits), hits)
	}
	hit := hits[0]
	if hit.SessionID != "abc" || hit.Author != "a@b.c" || hit.Agent != "claude" ||
		hit.AgentVersion != "1.2.3" || hit.CWD != "/tmp/proj" || hit.Repo != "proj" {
		t.Fatalf("hit is missing metadata the record already carries: %+v", hit)
	}
	if hit.StartedAt.IsZero() || hit.EndedAt.IsZero() {
		t.Fatalf("hit carries no timestamps: %+v", hit)
	}
	if !strings.HasSuffix(hit.Path, Extension) {
		t.Fatalf("hit does not name the file it came from: %q", hit.Path)
	}
}

// TestSearchMatchesQuerySyntaxLiterally: the tool advertises literal text,
// so punctuation that a query language would parse, as in "cost-center", is
// text.
func TestSearchMatchesQuerySyntaxLiterally(t *testing.T) {
	st := searchFixture(t)
	publish(t, st, "a@b.c", "s1", "the cost-center tag was wrong")
	publish(t, st, "a@b.c", "s2", "we called foo(bar) by mistake")
	publish(t, st, "a@b.c", "s3", "the label reads a:b in the manifest")

	for query, want := range map[string]string{
		"cost-center": "s1",
		"foo(bar":     "s2",
		"a:b":         "s3",
	} {
		hits, err := st.Search(Query{Text: query, Limit: 10})
		if err != nil {
			t.Fatalf("search %q returned an error: %v", query, err)
		}
		if len(hits) != 1 || hits[0].SessionID != want {
			t.Fatalf("search %q = %+v, want the session %s", query, hits, want)
		}
	}
}

func TestSearchSkipsAnUnreadableFileAndKeepsTheRest(t *testing.T) {
	st := searchFixture(t)
	publish(t, st, "a@b.c", "good", "the ingress controller was misconfigured")
	publish(t, st, "a@b.c", "also-good", "the ingress controller recovered")

	dir := filepath.Join(st.SessionsPath(), "a@b.c", "2026-09-18")

	// A file a replication tool is still delivering: valid name, truncated
	// body. And one that is not a .cms record at all.
	if err := os.WriteFile(filepath.Join(dir, "torn-deadbeef"+Extension), []byte("\x28\xb5\x2f\xfd\x00\x00"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "garbage-deadbeef"+Extension), []byte("not compressed at all"), 0o644); err != nil {
		t.Fatal(err)
	}

	hits, err := st.Search(Query{Text: "ingress controller", Limit: 10})
	if err != nil {
		t.Fatalf("a corrupt file in the folder must not fail the search: %v", err)
	}
	if len(hits) != 2 {
		t.Fatalf("search returned %d hits, want the 2 readable ones: %+v", len(hits), hits)
	}
}

func TestSearchIgnoresDotDirectoriesAndForeignFiles(t *testing.T) {
	st := searchFixture(t)
	publish(t, st, "a@b.c", "visible", "the ingress controller was misconfigured")

	// A replication tool's versioning directory, holding a perfectly valid
	// copy of that record, plus a stray file that is not a .cms.
	hidden := filepath.Join(st.SessionsPath(), ".stversions", "a@b.c", "2026-09-18")
	if err := os.MkdirAll(hidden, 0o755); err != nil {
		t.Fatal(err)
	}
	sources, err := filepath.Glob(filepath.Join(st.SessionsPath(), "a@b.c", "*", "visible-*"+Extension))
	if err != nil || len(sources) != 1 {
		t.Fatalf("published files = %v (%v)", sources, err)
	}
	body, err := os.ReadFile(sources[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hidden, filepath.Base(sources[0])), body, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(sources[0]), "notes.txt"), []byte("the ingress controller"), 0o644); err != nil {
		t.Fatal(err)
	}

	hits, err := st.Search(Query{Text: "ingress controller", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 {
		t.Fatalf("search returned %d hits, want 1: a dot-directory and a non-.cms file are not sessions: %+v", len(hits), hits)
	}
}

func publishOn(t *testing.T, st *Store, author, sessionID string, startedAt time.Time, content string) {
	t.Helper()
	rec := session.Record{
		Format: session.Format, SessionID: sessionID, Author: author, Agent: "claude",
		CWD: "/tmp/proj", Repo: "proj", SourceFile: sessionID + ".jsonl",
		StartedAt: startedAt, EndedAt: startedAt.Add(time.Hour),
		ContentHash: "sha256:" + sessionID, Content: content,
	}
	if _, err := st.Publish(rec, fmt.Sprintf("%08x", len(sessionID))); err != nil {
		t.Fatal(err)
	}
}

func day(d int) time.Time { return time.Date(2026, 9, d, 9, 0, 0, 0, time.UTC) }

func ids(hits []Hit) []string {
	out := make([]string, len(hits))
	for i, hit := range hits {
		out[i] = hit.SessionID
	}
	return out
}

func countDecodes(t *testing.T) *atomic.Int64 {
	t.Helper()
	var decoded atomic.Int64
	original := decodeFile
	decodeFile = func(path string) (session.Record, bool) {
		decoded.Add(1)
		return original(path)
	}
	t.Cleanup(func() { decodeFile = original })
	return &decoded
}

// The walk visits day directories newest first and stops once the limit is
// full, so a corpus spread over many days is mostly never opened.
func TestSearchStopsWalkingOnceTheLimitIsReached(t *testing.T) {
	st := searchFixture(t)
	const total = 200
	for i := 0; i < total; i++ {
		publishOn(t, st, "a@b.c", fmt.Sprintf("s-%03d", i), day(1).AddDate(0, 0, i/2), "the ingress controller was misconfigured")
	}
	decoded := countDecodes(t)

	hits, err := st.Search(Query{Text: "ingress", Limit: 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 3 {
		t.Fatalf("search returned %d hits, want the limit of 3", len(hits))
	}
	if read := decoded.Load(); read >= total/2 {
		t.Fatalf("search decoded %d of %d files: the walk did not stop early", read, total)
	}
}

func TestSearchReturnsNewestFirst(t *testing.T) {
	st := searchFixture(t)
	publishOn(t, st, "a@b.c", "old", day(1), "ingress")
	publishOn(t, st, "b@b.c", "newest", day(3).Add(2*time.Hour), "ingress")
	publishOn(t, st, "a@b.c", "middle", day(2), "ingress")
	publishOn(t, st, "b@b.c", "same-day-earlier", day(3), "ingress")

	hits, err := st.Search(Query{Text: "ingress", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"newest", "same-day-earlier", "middle", "old"}
	if got := ids(hits); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("search order = %v, want %v", got, want)
	}
}

func TestSearchByAuthorOpensOnlyThatAuthorsFiles(t *testing.T) {
	st := searchFixture(t)
	publishOn(t, st, "dana@b.c", "d1", day(1), "ingress")
	publishOn(t, st, "dana@b.c", "d2", day(2), "nothing relevant")
	publishOn(t, st, "alex@b.c", "n1", day(2), "ingress")
	publishOn(t, st, "sam@b.c", "s1", day(3), "ingress")
	decoded := countDecodes(t)

	hits, err := st.Search(Query{Author: "DANA", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(hits); fmt.Sprint(got) != "[d2 d1]" {
		t.Fatalf("author-only search = %v, want dana's two sessions newest first", got)
	}
	if decoded.Load() != 2 {
		t.Fatalf("author filter decoded %d files, want only dana's 2", decoded.Load())
	}

	hits, err = st.Search(Query{Text: "ingress", Author: "dana", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(hits); fmt.Sprint(got) != "[d1]" {
		t.Fatalf("author + text search = %v, want [d1]", got)
	}
}

func TestSearchExcludingAnAuthorOpensOnlyEveryoneElsesFiles(t *testing.T) {
	st := searchFixture(t)
	publishOn(t, st, "dana@b.c", "d1", day(1), "ingress")
	publishOn(t, st, "alex@b.c", "n1", day(2), "ingress")
	publishOn(t, st, "sam@b.c", "s1", day(3), "ingress")
	decoded := countDecodes(t)

	hits, err := st.Search(Query{ExcludeAuthor: "ALEX", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(hits); fmt.Sprint(got) != "[s1 d1]" {
		t.Fatalf("exclude-only search = %v, want everyone but alex, newest first", got)
	}
	if decoded.Load() != 2 {
		t.Fatalf("exclude_author decoded %d files, want 2", decoded.Load())
	}

	hits, err = st.Search(Query{Text: "ingress", Author: "b.c", ExcludeAuthor: "sam", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(hits); fmt.Sprint(got) != "[n1 d1]" {
		t.Fatalf("author + exclude_author search = %v, want [n1 d1]", got)
	}
}

func TestSearchDateWindowSkipsDaysOutsideIt(t *testing.T) {
	st := searchFixture(t)
	for d := 1; d <= 10; d++ {
		publishOn(t, st, "a@b.c", fmt.Sprintf("s%02d", d), day(d), "ingress")
	}
	decoded := countDecodes(t)

	hits, err := st.Search(Query{Since: day(4), Until: day(7), Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	// day(7) is 09:00 on the 7th: s07 started at that instant and is excluded,
	// but its directory still has to be opened to know that.
	if got := ids(hits); fmt.Sprint(got) != "[s06 s05 s04]" {
		t.Fatalf("windowed search = %v, want [s06 s05 s04]", got)
	}
	if decoded.Load() != 4 {
		t.Fatalf("window decoded %d files, want the 4 candidate days", decoded.Load())
	}

	hits, err = st.Search(Query{Since: day(9).Add(time.Minute), Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(hits); fmt.Sprint(got) != "[s10]" {
		t.Fatalf("since with a time of day = %v, want [s10]", got)
	}
}

func TestSearchFiltersByRepoAndAgent(t *testing.T) {
	st := searchFixture(t)
	for _, c := range []struct{ id, repo, agent string }{
		{"be-claude", "acme-backend", "claude"},
		{"be-codex", "acme-backend", "codex"},
		{"fe-claude", "acme-frontend", "claude"},
	} {
		rec := session.Record{
			Format: session.Format, SessionID: c.id, Author: "a@b.c", Agent: c.agent,
			CWD: "/tmp/" + c.repo, Repo: c.repo, SourceFile: c.id + ".jsonl",
			StartedAt: day(1), EndedAt: day(1).Add(time.Hour),
			ContentHash: "sha256:" + c.id, Content: "ingress",
		}
		if _, err := st.Publish(rec, fmt.Sprintf("%08x", len(c.id))); err != nil {
			t.Fatal(err)
		}
	}

	hits, err := st.Search(Query{Repo: "backend", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(hits); fmt.Sprint(got) != "[be-claude be-codex]" {
		t.Fatalf("repo filter = %v", got)
	}
	hits, err = st.Search(Query{Agent: "Codex", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(hits); fmt.Sprint(got) != "[be-codex]" {
		t.Fatalf("agent filter = %v", got)
	}
}

func TestSearchRepoFilterFindsSessionsPublishedUnderAWorktreeName(t *testing.T) {
	st := searchFixture(t)
	for _, c := range []struct{ id, cwd, repo string }{
		{"in-worktree", "/home/dana/acme-backend/.claude/worktrees/brave-turing-1a2b3c", "brave-turing-1a2b3c"},
		{"elsewhere", "/home/dana/acme-frontend", "acme-frontend"},
	} {
		rec := session.Record{
			Format: session.Format, SessionID: c.id, Author: "a@b.c", Agent: "claude",
			CWD: c.cwd, Repo: c.repo, SourceFile: c.id + ".jsonl",
			StartedAt: day(1), EndedAt: day(1).Add(time.Hour),
			ContentHash: "sha256:" + c.id, Content: "ingress",
		}
		if _, err := st.Publish(rec, fmt.Sprintf("%08x", len(c.id))); err != nil {
			t.Fatal(err)
		}
	}

	hits, err := st.Search(Query{Repo: "acme-backend", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(hits); fmt.Sprint(got) != "[in-worktree]" {
		t.Fatalf("repo filter = %v, want the worktree session found by its cwd", got)
	}
}

func TestSearchWithAnEmptyQueryMatchesNothing(t *testing.T) {
	st := searchFixture(t)
	publish(t, st, "a@b.c", "abc", "anything at all")
	hits, err := st.Search(Query{Limit: 10})
	if err != nil || len(hits) != 0 {
		t.Fatalf("empty query = %v, %v; want no hits", hits, err)
	}
}

func TestAuthorsListsWhoPublishesNewestActivityFirst(t *testing.T) {
	st := searchFixture(t)
	publishOn(t, st, "dana@b.c", "d1", day(1), "x")
	publishOn(t, st, "dana@b.c", "d2", day(5), "x")
	publishOn(t, st, "sam@b.c", "s1", day(3), "x")
	if err := os.MkdirAll(filepath.Join(st.SessionsPath(), ".stversions", "z@b.c"), 0o755); err != nil {
		t.Fatal(err)
	}
	decoded := countDecodes(t)

	authors, err := st.Authors()
	if err != nil {
		t.Fatal(err)
	}
	want := []Author{{"dana@b.c", 2, "2026-09-05"}, {"sam@b.c", 1, "2026-09-03"}}
	if fmt.Sprint(authors) != fmt.Sprint(want) {
		t.Fatalf("Authors() = %+v, want %+v", authors, want)
	}
	if decoded.Load() != 0 {
		t.Fatalf("Authors() decoded %d files; it must read directory entries only", decoded.Load())
	}

	missing := New(filepath.Join(t.TempDir(), "never-mounted"))
	if authors, err := missing.Authors(); err != nil || len(authors) != 0 {
		t.Fatalf("Authors() over a missing folder = %v, %v", authors, err)
	}
}

// TestGetReturnsEverySessionFileForOneID is the resumed-session case: one
// session id legitimately lives in two source transcripts, and therefore in
// two published files.
func TestGetReturnsEverySessionFileForOneID(t *testing.T) {
	st := searchFixture(t)
	rec := session.Record{
		Format: session.Format, SessionID: "resumed", Author: "a@b.c", Agent: "claude",
		CWD: "/tmp/proj", Repo: "proj", SourceFile: "first.jsonl",
		StartedAt: time.Date(2026, 9, 18, 7, 0, 0, 0, time.UTC), EndedAt: time.Date(2026, 9, 18, 8, 0, 0, 0, time.UTC),
		ContentHash: "sha256:first", Content: "the original conversation",
	}
	if _, err := st.Publish(rec, "aaaaaaaa"); err != nil {
		t.Fatal(err)
	}
	rec.SourceFile = "second.jsonl"
	rec.StartedAt = rec.StartedAt.Add(2 * time.Hour)
	rec.ContentHash = "sha256:second"
	rec.Content = "the resumed conversation"
	if _, err := st.Publish(rec, "bbbbbbbb"); err != nil {
		t.Fatal(err)
	}
	publish(t, st, "a@b.c", "unrelated", "another session entirely")

	hits, err := st.Get("resumed")
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 2 {
		t.Fatalf("Get returned %d files, want both files of the resumed session: %+v", len(hits), hits)
	}
	if !hits[0].StartedAt.After(hits[1].StartedAt) {
		t.Fatalf("Get did not return the newest file first: %+v", hits)
	}
}

func TestSearchOverAnEmptyOrMissingFolderIsNotAnError(t *testing.T) {
	empty := searchFixture(t)
	hits, err := empty.Search(Query{Text: "anything", Limit: 10})
	if err != nil || len(hits) != 0 {
		t.Fatalf("search over an empty folder = %v, %v; want no hits and no error", hits, err)
	}

	missing := New(filepath.Join(t.TempDir(), "never-mounted"))
	hits, err = missing.Search(Query{Text: "anything", Limit: 10})
	if err != nil || len(hits) != 0 {
		t.Fatalf("search over a missing folder = %v, %v; want no hits and no error", hits, err)
	}
	got, err := missing.Get("anything")
	if err != nil || len(got) != 0 {
		t.Fatalf("get over a missing folder = %v, %v; want no hits and no error", got, err)
	}
	count, err := missing.Count()
	if err != nil || count != 0 {
		t.Fatalf("count over a missing folder = %d, %v; want 0 and no error", count, err)
	}
}

// TestSearchReadsAFileOnlyUnderTheDayItStarted: the folder has one shape,
// sessions/<author>/<start day>/. Days are searched newest first and the walk
// stops at the limit, so a file in a far-off day directory would be read before
// every real session and could fill the answer on its own.
func TestSearchReadsAFileOnlyUnderTheDayItStarted(t *testing.T) {
	st := searchFixture(t)
	publish(t, st, "a@b.c", "abc", "the ingress controller")
	rec := session.Record{
		Format: session.Format, SessionID: "misfiled", Author: "a@b.c", Agent: "claude",
		StartedAt: time.Date(2026, 9, 18, 7, 0, 0, 0, time.UTC), Content: "the ingress controller",
	}
	for _, dir := range []string{"9999-12-31", "notes"} {
		day := filepath.Join(st.SessionsPath(), "a@b.c", dir)
		if err := os.MkdirAll(day, 0o755); err != nil {
			t.Fatal(err)
		}
		file, err := os.Create(filepath.Join(day, "misfiled-00000000"+Extension))
		if err != nil {
			t.Fatal(err)
		}
		if err := session.Encode(file, rec); err != nil {
			t.Fatal(err)
		}
		file.Close()
	}

	hits, err := st.Search(Query{Text: "ingress", Limit: 10})
	if err != nil || len(hits) != 1 || hits[0].SessionID != "abc" {
		t.Fatalf("search answered with %v (err %v); want the session filed under its own day", ids(hits), err)
	}
	if got, _ := st.Get("misfiled"); len(got) != 0 {
		t.Fatalf("get returned a file filed under a day it did not start on")
	}
}
