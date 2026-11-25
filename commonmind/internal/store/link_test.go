package store

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/session"
)

// Everyone who shares the folder can put anything in it, and a sync tool
// carries a symbolic link as readily as a file.

func TestSearchReadsOnlyRegularFiles(t *testing.T) {
	st := searchFixture(t)
	publish(t, st, "a@b.c", "abc", "the ingress controller")
	elsewhere := searchFixture(t)
	publish(t, elsewhere, "x@y.z", "planted", "the ingress controller")
	outside, err := filepath.Glob(filepath.Join(elsewhere.SessionsPath(), "x@y.z", "*", "planted-*"+Extension))
	if err != nil || len(outside) != 1 {
		t.Fatalf("fixture: %v %v", outside, err)
	}
	day := filepath.Join(st.SessionsPath(), "mallory", "2026-09-18")
	if err := os.MkdirAll(day, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside[0], filepath.Join(day, "planted-00000000"+Extension)); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(day, "pipe-00000000"+Extension), 0o644); err != nil {
		t.Fatal(err)
	}

	found := make(chan []Hit, 1)
	go func() {
		hits, _ := st.Search(Query{Text: "ingress"})
		planted, _ := st.Get("planted")
		found <- append(hits, planted...)
	}()
	select {
	case hits := <-found:
		if len(hits) != 1 || hits[0].SessionID != "abc" {
			t.Fatalf("search followed a link out of the shared folder: %+v", hits)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("search is still waiting on something that is not a regular file")
	}
}

func TestPublishRefusesADirectoryThatIsALink(t *testing.T) {
	for _, linked := range []string{
		filepath.Join(SessionsDir, "a@b.c", "2026-09-18"),
		filepath.Join(SessionsDir, "a@b.c"),
		filepath.Join(TempDirName, hostSegment()),
		TempDirName,
	} {
		st := searchFixture(t)
		outside := t.TempDir()
		link := filepath.Join(st.Root(), linked)
		if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, link); err != nil {
			t.Fatal(err)
		}
		rec := session.Record{
			Format: session.Format, SessionID: "abc", Author: "a@b.c", Agent: "claude",
			StartedAt: time.Date(2026, 9, 18, 7, 12, 3, 0, time.UTC), ContentHash: "sha256:abc", Content: "x",
		}
		_, err := st.Publish(rec, "00000000")
		left, _ := os.ReadDir(outside)
		if err == nil || len(left) != 0 {
			t.Errorf("%s is a link: publish went through it (err %v, %d entries outside the folder)", linked, err, len(left))
		}
	}
}
