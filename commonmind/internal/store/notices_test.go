package store

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func TestNoticesAreKeptAndReadBack(t *testing.T) {
	root := t.TempDir()
	s := newStore(t, root)
	if notices, err := s.Notices(); err != nil || len(notices) != 0 {
		t.Fatalf("a new folder has notices %q, %v", notices, err)
	}
	for _, data := range []string{"first", "second", "first"} {
		if err := s.WriteNotice([]byte(data)); err != nil {
			t.Fatal(err)
		}
	}
	notices, err := s.Notices()
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, notice := range notices {
		got = append(got, string(notice))
	}
	slices.Sort(got)
	if !reflect.DeepEqual(got, []string{"first", "first", "second"}) {
		t.Fatalf("notices = %q; want every one written, none replaced", got)
	}

	// Each notice gets a name no one could have known before it was written.
	unguessable := regexp.MustCompile(`^\.commonmind-notice-[0-9a-f]{32}\.json$`)
	entries, _ := os.ReadDir(root)
	var names []string
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), NoticePrefix) {
			if !unguessable.MatchString(entry.Name()) {
				t.Errorf("notice named %q", entry.Name())
			}
			names = append(names, entry.Name())
		}
	}
	if len(names) != 3 {
		t.Fatalf("notice files = %q; want three", names)
	}
	if entries, _ := os.ReadDir(filepath.Join(root, TempDirName)); len(entries) > 1 {
		t.Fatalf("staging left behind: %v", entries)
	}
}

// Anyone who shares the folder can put a link, a pipe, a directory or a huge
// file under a notice's name, or a file where notices used to be kept.
func TestNoticesStayInsideTheFolder(t *testing.T) {
	root := t.TempDir()
	s := newStore(t, root)
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret")
	if err := os.WriteFile(secret, []byte("not a notice"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(root, NoticePrefix+"link.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, NoticePrefix+"big.json"), []byte(strings.Repeat("x", 128<<10)), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, NoticePrefix+"dir.json"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".commonmind-removed"), []byte("in the way"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteNotice([]byte("real")); err != nil {
		t.Fatal(err)
	}
	notices, err := s.Notices()
	if err != nil || len(notices) != 1 || string(notices[0]) != "real" {
		t.Fatalf("notices = %q, %v; want only the regular, small one", notices, err)
	}
}
