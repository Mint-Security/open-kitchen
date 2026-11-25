package settings

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSaveLoadRoundTrip(t *testing.T) {
	t.Setenv("COMMONMIND_HOME", filepath.Join(t.TempDir(), "home"))
	want := Settings{SharedDir: "/shared", Author: "a@b.c", Roots: []string{"/a", "/b"}, Exclude: []string{"/secret/*"}}
	if err := Save(want); err != nil {
		t.Fatal(err)
	}
	got, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestLoadRequiresConfiguration(t *testing.T) {
	t.Setenv("COMMONMIND_HOME", filepath.Join(t.TempDir(), "home"))
	if _, err := Load(); err == nil {
		t.Fatal("expected an error before init")
	}
}

func TestDefaultAuthorIsNeverEmpty(t *testing.T) {
	if DefaultAuthor() == "" {
		t.Fatal("DefaultAuthor returned an empty string")
	}
}

func TestDefaultRootsCoversClaudeAndCodex(t *testing.T) {
	roots := DefaultRoots()
	if len(roots) != 2 {
		t.Fatalf("DefaultRoots = %v, want 2 entries", roots)
	}
}

// TestHomeTightensAnExistingLooseDirectory covers the gap MkdirAll leaves:
// its mode applies only to directories it creates, so a ~/.commonmind that
// already exists at 0755 would keep holding the ledger and the sync
// credentials at 0755.
func TestHomeTightensAnExistingLooseDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "home")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("COMMONMIND_HOME", dir)

	if _, err := Home(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o700 {
		t.Fatalf("home mode = %o, want 700", mode)
	}
}
