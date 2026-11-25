package main

import (
	"context"
	"flag"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/settings"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/syncer"
)

func TestInitPreservesExistingConfigurationOnFailure(t *testing.T) {
	for _, team := range []string{"", "existing-team"} {
		t.Run("team="+team, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("COMMONMIND_HOME", home)
			if err := settings.Save(settings.Settings{SharedDir: "/existing/shared", Author: "fixture", Team: team}); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(home, "settings.json")
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			err = initTeam(context.Background(), "new-team", "new-author", nil, nil, filepath.Join(home, "missing-syncthing"), "none", true, nil, io.Discard)
			want := `team "existing-team"`
			if team == "" {
				want = "managed Syncthing is missing"
			}
			if err == nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("wrong error: %v", err)
			}
			after, err := os.ReadFile(path)
			if err != nil || string(before) != string(after) {
				t.Fatal("existing settings changed")
			}
			if _, err := os.Stat(filepath.Join(home, "sync.json")); !os.IsNotExist(err) {
				t.Fatal("created managed sync for an existing configuration")
			}
		})
	}
}

func TestTeamSetupKeepsSavedPreferencesUnlessOverridden(t *testing.T) {
	existing := settings.Settings{SharedDir: "/existing", Author: "existing", Roots: []string{"/old-roots"}, Exclude: []string{"/private/*"}}
	flags := flag.NewFlagSet("fixture", flag.ContinueOnError)
	flags.String("roots", "/default-roots", "")
	flags.String("author", "default-author", "")
	flags.String("exclude", "", "")
	requested := settings.Settings{Author: "default-author", Roots: []string{"/new-roots"}}
	if got := savedPreferences(existing, requested, setupOverrides(flags)); !reflect.DeepEqual(got, existing) {
		t.Fatalf("defaults replaced saved preferences: %+v", got)
	}
	if err := flags.Parse([]string{"--roots", "/new-roots", "--exclude", ""}); err != nil {
		t.Fatal(err)
	}
	got := savedPreferences(existing, requested, setupOverrides(flags))
	if got.SharedDir != existing.SharedDir || got.Author != existing.Author || !reflect.DeepEqual(got.Roots, requested.Roots) || len(got.Exclude) != 0 {
		t.Fatalf("explicit overrides not applied: %+v", got)
	}
	if !reflect.DeepEqual(existing.Exclude, []string{"/private/*"}) {
		t.Fatal("modified original preferences")
	}
}

func TestApprovalRequiresAProofAndTheMatchingCode(t *testing.T) {
	owner, joining, stranger := strings.Repeat("AAAAAAA-", 7)+"AAAAAAA", strings.Repeat("BBBBBBB-", 7)+"BBBBBBB", strings.Repeat("CCCCCCC-", 7)+"CCCCCCC"
	s := settings.Settings{FolderID: syncer.NewFolderID(), OwnerID: owner, Team: "Fixture"}
	code := syncer.VerificationCode(s.FolderID, owner, joining)
	for _, tc := range []struct {
		answer   string
		approved bool
	}{{"yes\n", false}, {"wrong-code\n", false}, {"\n", false}, {"", false}, {code + "\n", true}} {
		t.Run(strings.TrimSpace(tc.answer), func(t *testing.T) {
			requests := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests++ }))
			defer srv.Close()
			client := syncer.Client{Address: strings.TrimPrefix(srv.URL, "http://")}
			home, require := t.TempDir(), true
			invite, err := syncer.InviteStore{Home: home, FolderID: s.FolderID, OwnerID: owner}.Issue(s.Team, &require, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			pending := map[string]syncer.Pending{
				joining:  {Name: invite.ProofName(joining, "dana")},
				stranger: {Name: "no invite, only a name"},
			}
			var out strings.Builder
			_ = approveDevices(context.Background(), home, client, s, pending, strings.NewReader(tc.answer), &out)
			if (requests != 0) != tc.approved {
				t.Fatalf("answer %q: reached the authorization API %d times", tc.answer, requests)
			}
			if strings.Contains(out.String(), "no invite") {
				t.Fatalf("asked about a device that holds no invite:\n%s", out.String())
			}
		})
	}
}

func TestUnapprovedJoinCannotPublish(t *testing.T) {
	t.Setenv("COMMONMIND_HOME", t.TempDir())
	if err := settings.Save(settings.Settings{SharedDir: t.TempDir(), Author: "fixture", Team: "Test", Enrolled: false}); err != nil {
		t.Fatal(err)
	}
	if err := cmdFlush(context.Background(), nil, io.Discard); err == nil || !strings.Contains(err.Error(), "enrollment") {
		t.Fatalf("unapproved flush: %v", err)
	}
}
