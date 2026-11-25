package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/settings"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/store"
)

// TestMovingTheSharedFolderPublishesIntoTheNewOne: the ledger remembers where
// each session was published, and that path is inside whatever shared folder
// was configured at the time. Pointing init at a new folder must not leave the
// ledger answering for the old one: a session is in the new folder only once it
// has been written there.
func TestMovingTheSharedFolderPublishesIntoTheNewOne(t *testing.T) {
	for _, tc := range []struct {
		name         string
		removeTheOld bool
	}{
		{"the old folder is still there", false},
		{"the old folder is gone", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, oldShared, claudeRoot := initHome(t, "a@b.c")
			claudeFixture(t, claudeRoot, "-tmp-proj", "abc", "/tmp/proj", time.Hour)
			runOut(t, "flush")
			if got := publishedFiles(t, oldShared, "a@b.c", "abc"); len(got) != 1 {
				t.Fatalf("published files in the first folder = %v, want 1", got)
			}

			if tc.removeTheOld {
				if err := os.RemoveAll(oldShared); err != nil {
					t.Fatal(err)
				}
			}
			newShared := filepath.Join(t.TempDir(), "moved")
			runOut(t, "init", "--shared", newShared, "--author", "a@b.c", "--roots", claudeRoot)

			out := runOut(t, "flush")
			if got := publishedFiles(t, newShared, "a@b.c", "abc"); len(got) != 1 {
				t.Fatalf("the session never reached the new shared folder (flush said: %s)", strings.TrimSpace(out))
			}
			if strings.Contains(out, "skipped-deleted 1") {
				t.Fatalf("a folder move was read as a deliberate deletion: %s", out)
			}
			if count, err := store.New(newShared).Count(); err != nil || count != 1 {
				t.Fatalf("sessions in the new shared folder = %d, %v; want 1", count, err)
			}
		})
	}
}

// TestReinitKeepsSettingsThatWereNotRepeated: changing one setting by running
// init again must not reset the others. Turning a folder setup into a team
// already works this way (see TestTeamSetupKeepsSavedPreferencesUnlessOverridden);
// the one that matters most is --exclude, because losing it publishes transcripts
// the user had marked private.
func TestReinitKeepsSettingsThatWereNotRepeated(t *testing.T) {
	// init's flag defaults live under the user's home directory, so this test
	// gets one of its own: a regression would otherwise create ~/CommonMind.
	userHome := t.TempDir()
	t.Setenv("HOME", userHome)
	home := filepath.Join(t.TempDir(), "home")
	t.Setenv("COMMONMIND_HOME", home)
	shared := filepath.Join(t.TempDir(), "team share")
	roots := filepath.Join(t.TempDir(), "claude-projects")

	runOut(t, "init", "--shared", shared, "--author", "first@example.invalid", "--roots", roots, "--exclude", "/work/private-*")
	before, err := settings.Load()
	if err != nil {
		t.Fatal(err)
	}

	runOut(t, "init", "--author", "second@example.invalid")
	after, err := settings.Load()
	if err != nil {
		t.Fatal(err)
	}
	if after.Author != "second@example.invalid" {
		t.Fatalf("author = %q; the one flag that was passed did not apply", after.Author)
	}
	if after.SharedDir != before.SharedDir {
		t.Errorf("shared dir changed from %q to %q", before.SharedDir, after.SharedDir)
	}
	if !reflect.DeepEqual(after.Roots, before.Roots) {
		t.Errorf("roots changed from %q to %q", before.Roots, after.Roots)
	}
	if !reflect.DeepEqual(after.Exclude, before.Exclude) {
		t.Errorf("exclusions changed from %q to %q", before.Exclude, after.Exclude)
	}
	if _, err := os.Stat(filepath.Join(userHome, "CommonMind")); !os.IsNotExist(err) {
		t.Errorf("re-running init created the default shared folder in the home directory (stat: %v)", err)
	}
}

// TestInitRejectsAMalformedExcludePattern: an exclusion that can never match is
// a privacy failure waiting for the next flush, so it has to be refused when
// it is given, not ignored when it is used.
func TestInitRejectsAMalformedExcludePattern(t *testing.T) {
	for _, pattern := range []string{"/work/[clients", "/work/ok-*,/work/[clients"} {
		t.Run(pattern, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			home := filepath.Join(t.TempDir(), "home")
			t.Setenv("COMMONMIND_HOME", home)
			shared := filepath.Join(t.TempDir(), "shared")

			err := run(context.Background(), []string{"init", "--shared", shared, "--author", "a@b.c", "--exclude", pattern}, io.Discard)
			if err == nil {
				t.Fatalf("init accepted the malformed exclusion %q", pattern)
			}
			if !strings.Contains(err.Error(), "[clients") {
				t.Errorf("the error does not name the pattern: %v", err)
			}
			if _, statErr := os.Stat(filepath.Join(home, "settings.json")); !os.IsNotExist(statErr) {
				t.Errorf("settings were saved with a malformed exclusion (stat: %v)", statErr)
			}
		})
	}
}
