package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/store"
)

func TestEachNoticeFileIsReadOnce(t *testing.T) {
	root := t.TempDir()
	shared := store.New(root)
	path := func(name string) string { return filepath.Join(root, store.NoticePrefix+name+".json") }
	write := func(name, data string) {
		if err := os.WriteFile(path(name), []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for i := range 20 {
		write("copy"+strconv.Itoa(i), "notice")
	}
	write("junk", "junk")
	reads := 0
	check := func(data []byte) ([]byte, error) {
		reads++
		if string(data) != "notice" {
			return nil, errors.New("not a notice")
		}
		return data, nil
	}

	notices, files, err := readNotices(shared, nil, check)
	if err != nil || !reflect.DeepEqual(notices, [][]byte{[]byte("notice")}) || reads != 21 {
		t.Fatalf("first pass: notices %q, %d reads, %v; want the one notice from 21 reads", notices, reads, err)
	}
	reads = 0
	if notices, files, err = readNotices(shared, files, check); err != nil || len(notices) != 1 || reads != 0 {
		t.Fatalf("second pass: %d notices, %d reads, %v; want the notice and no reads", len(notices), reads, err)
	}

	// A file that changes is read again, also one replaced with the same size
	// and time; a file that goes is forgotten.
	write("copy1", "junk!")
	info, err := os.Stat(path("copy2"))
	if err != nil {
		t.Fatal(err)
	}
	write("replacement", "nOtice")
	if err := os.Chtimes(path("replacement"), time.Time{}, info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path("replacement"), path("copy2")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path("copy0")); err != nil {
		t.Fatal(err)
	}
	reads = 0
	if notices, files, err = readNotices(shared, files, check); err != nil || len(notices) != 1 || reads != 2 || len(files) != 20 {
		t.Fatalf("after changes: %d notices, %d reads, %d files, %v; want the notice, 2 reads, 20 files", len(notices), reads, len(files), err)
	}
}
