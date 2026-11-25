package syncer

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func fixtureID(letter string) string {
	return strings.Repeat(strings.Repeat(letter, 7)+"-", 7) + strings.Repeat(letter, 7)
}
func fixtureInvites(t *testing.T) InviteStore {
	t.Helper()
	return InviteStore{Home: t.TempDir(), FolderID: NewFolderID(), OwnerID: fixtureID("A")}
}
func issueFixture(t *testing.T, store InviteStore, require *bool, now time.Time) Invite {
	t.Helper()
	invite, err := store.Issue("Fixture", require, now)
	if err != nil {
		t.Fatal(err)
	}
	return invite
}

func authorizationFixture(t *testing.T, folderID string, failUpdate *atomic.Bool) (Client, *atomic.Int32) {
	t.Helper()
	requests := &atomic.Int32{}
	config := map[string]any{"devices": []any{}, "folders": []any{map[string]any{"id": folderID, "devices": []any{}}}, "options": map[string]any{"fixture": true}}
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		requests.Add(1)
		switch {
		case r.Method == "GET" && r.URL.Path == "/rest/config":
			_ = json.NewEncoder(w).Encode(config)
		case r.Method == "GET" && r.URL.Path == "/rest/config/defaults/device":
			_, _ = w.Write([]byte(`{}`))
		case r.Method == "PUT" && r.URL.Path == "/rest/config":
			if failUpdate != nil && failUpdate.Swap(false) {
				http.Error(w, "fixture failure", 500)
				return
			}
			if err := json.NewDecoder(r.Body).Decode(&config); err != nil {
				t.Error(err)
			}
		default:
			t.Errorf("unexpected authorization request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "unexpected request", 400)
		}
	}))
	t.Cleanup(srv.Close)
	return Client{Address: strings.TrimPrefix(srv.URL, "http://")}, requests
}

func TestSecretInviteRejectsInvalidProofsBeforeAuthorization(t *testing.T) {
	now := time.Now()
	for _, scenario := range []string{"other-device", "secret", "expiry", "folder", "owner", "mode", "name", "unknown-invite", "expired", "malformed"} {
		t.Run(scenario, func(t *testing.T) {
			store := fixtureInvites(t)
			invite := issueFixture(t, store, nil, now)
			device := fixtureID("B")
			requestTime := now
			modified := invite
			switch scenario {
			case "secret":
				modified.Secret = strings.Repeat("A", 43)
			case "expiry":
				modified.Expires += 3600
			case "folder":
				modified.FolderID = NewFolderID()
			case "owner":
				modified.OwnerID = fixtureID("D")
			case "mode":
				modified.RequireVerification = true
			case "unknown-invite":
				modified.ID = strings.Repeat("f", 32)
			case "expired":
				requestTime = now.Add(25 * time.Hour)
			}
			hello := modified.ProofName(device, "fixture")
			if scenario == "other-device" {
				device = fixtureID("C")
			}
			if scenario == "name" {
				proof, _ := parseProof(hello)
				proof.Name = "changed"
				raw, _ := json.Marshal(proof)
				hello = "cm2_" + base64.RawURLEncoding.EncodeToString(raw)
			}
			if scenario == "malformed" {
				hello = "cm2_invalid"
			}
			client, calls := authorizationFixture(t, store.FolderID, nil)
			_, err := store.Accept(context.Background(), client, device, hello, "", requestTime)
			if !errors.Is(err, ErrInvalidInviteProof) || calls.Load() != 0 {
				t.Fatalf("invalid request authorized: %v calls=%d", err, calls.Load())
			}
		})
	}
}

func TestSecretInviteVerificationPolicyAndParsing(t *testing.T) {
	now := time.Now()
	store := fixtureInvites(t)
	yes, no := true, false
	strict := issueFixture(t, store, &yes, now)
	inherited := issueFixture(t, store, nil, now)
	automatic := issueFixture(t, store, &no, now)
	if !strict.RequireVerification || !inherited.RequireVerification || automatic.RequireVerification {
		t.Fatal("policy was not saved for future invites")
	}
	parsed, err := ParseInvite(strict.Encode(), now)
	if err != nil || parsed != strict || !strings.HasPrefix(strict.Encode(), "cm2_") {
		t.Fatal("secret invite round trip failed")
	}
	if _, err := ParseInvite(strict.Encode(), now.Add(25*time.Hour)); err == nil {
		t.Fatal("expired invite accepted by joiner")
	}
	invalid := strict
	invalid.Secret = ""
	if _, err := ParseInvite(invalid.Encode(), now); err == nil {
		t.Fatal("missing secret accepted")
	}
	client, calls := authorizationFixture(t, store.FolderID, nil)
	device := fixtureID("B")
	hello := strict.ProofName(device, "fixture")
	proofData, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(hello, "cm2_"))
	if err != nil || strings.Contains(string(proofData), strict.Secret) {
		t.Fatal("hello exposed the reusable invite secret")
	}
	downgraded := strict
	downgraded.RequireVerification = false
	if _, err := store.Accept(context.Background(), client, device, downgraded.ProofName(device, "fixture"), "", now); !errors.Is(err, ErrInvalidInviteProof) || calls.Load() != 0 {
		t.Fatal("modified invite bypassed founder's verification policy")
	}
	for _, code := range []string{"", "yes", "wrong"} {
		if _, err := store.Accept(context.Background(), client, device, hello, code, now); err == nil || calls.Load() != 0 {
			t.Fatal("verification requirement bypassed")
		}
	}
	if _, err := store.Accept(context.Background(), client, device, hello, VerificationCode(store.FolderID, store.OwnerID, device), now); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(store.Home, "invites.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("invite secrets not private")
	}
}

func TestSecretInviteAcceptsMultipleDevicesUntilExpiry(t *testing.T) {
	store := fixtureInvites(t)
	now := time.Now()
	invite := issueFixture(t, store, nil, now)
	client, calls := authorizationFixture(t, store.FolderID, nil)
	results := make(chan error, 2)
	var wait sync.WaitGroup
	for _, device := range []string{fixtureID("B"), fixtureID("C")} {
		wait.Add(1)
		go func(id string) {
			defer wait.Done()
			reopened := InviteStore{Home: store.Home, FolderID: store.FolderID, OwnerID: store.OwnerID}
			_, err := reopened.Accept(context.Background(), client, id, invite.ProofName(id, "fixture"), "", now)
			results <- err
		}(device)
	}
	wait.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	var config struct {
		Devices []map[string]any
		Folders []struct{ Devices []map[string]any }
		Options map[string]any
	}
	if err := client.Request(context.Background(), "GET", "config", nil, &config); err != nil {
		t.Fatal(err)
	}
	if len(config.Devices) != 2 || len(config.Folders[0].Devices) != 2 || config.Options["fixture"] != true {
		t.Fatalf("lost configuration during concurrent joins: %+v", config)
	}
	before := calls.Load()
	device := fixtureID("D")
	if _, err := store.Accept(context.Background(), client, device, invite.ProofName(device, "fixture"), "", time.Unix(invite.Expires, 0)); !errors.Is(err, ErrInvalidInviteProof) || calls.Load() != before {
		t.Fatal("expired invite authorized another device")
	}
}

func TestFailedAuthorizationCanRetryWithoutClaimState(t *testing.T) {
	store := fixtureInvites(t)
	now := time.Now()
	invite := issueFixture(t, store, nil, now)
	var fail atomic.Bool
	fail.Store(true)
	client, _ := authorizationFixture(t, store.FolderID, &fail)
	device := fixtureID("B")
	hello := invite.ProofName(device, "fixture")
	if _, err := store.Accept(context.Background(), client, device, hello, "", now); err == nil {
		t.Fatal("fixture did not fail authorization")
	}
	var config struct{ Devices []map[string]any }
	if err := client.Request(context.Background(), "GET", "config", nil, &config); err != nil || len(config.Devices) != 0 {
		t.Fatal("failed authorization left a partially added device")
	}
	if _, err := store.Accept(context.Background(), client, device, hello, "", now); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Accept(context.Background(), client, device, hello, "", now); err != nil {
		t.Fatal(err)
	}
	if err := client.Request(context.Background(), "GET", "config", nil, &config); err != nil || len(config.Devices) != 1 {
		t.Fatal("retry duplicated or failed to authorize the device")
	}
}

func TestBrokenInviteStateFailsClosed(t *testing.T) {
	store := fixtureInvites(t)
	now := time.Now()
	invite := issueFixture(t, store, nil, now)
	if err := os.WriteFile(filepath.Join(store.Home, "invites.json"), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	client, calls := authorizationFixture(t, store.FolderID, nil)
	device := fixtureID("B")
	if _, err := store.Accept(context.Background(), client, device, invite.ProofName(device, "fixture"), "", now); err == nil || calls.Load() != 0 {
		t.Fatal("corrupt state permitted authorization")
	}
}

func TestDeviceWithoutAProofIsNeverAuthorized(t *testing.T) {
	store := fixtureInvites(t)
	client, calls := authorizationFixture(t, store.FolderID, nil)
	device := fixtureID("B")
	for _, code := range []string{"", VerificationCode(store.FolderID, store.OwnerID, device)} {
		if _, err := store.Accept(context.Background(), client, device, "a plain device name", code, time.Now()); !errors.Is(err, ErrInvalidInviteProof) || calls.Load() != 0 {
			t.Fatalf("a device that holds no invite was not refused: %v", err)
		}
	}
}

func TestRemovingADeviceCancelsEveryOpenInvite(t *testing.T) {
	store := fixtureInvites(t)
	now := time.Now()
	require := true
	invite := issueFixture(t, store, &require, now)
	issueFixture(t, store, nil, now)
	var fail atomic.Bool
	client, _ := authorizationFixture(t, store.FolderID, &fail)
	removed, stays := fixtureID("B"), fixtureID("C")
	for _, id := range []string{removed, stays} {
		code := VerificationCode(store.FolderID, store.OwnerID, id)
		if _, err := store.Accept(context.Background(), client, id, invite.ProofName(id, "fixture"), code, now); err != nil {
			t.Fatal(err)
		}
	}

	fail.Store(true)
	if _, err := store.Remove(context.Background(), client, removed, now); err == nil {
		t.Fatal("fixture did not fail the update")
	}
	if _, err := store.Inspect(removed, invite.ProofName(removed, "fixture"), now); !errors.Is(err, ErrInvalidInviteProof) {
		t.Fatal("an invite outlived a removal that failed halfway")
	}
	cancelled, err := store.Remove(context.Background(), client, removed, now)
	if err != nil {
		t.Fatal(err)
	}
	if cancelled != 0 {
		t.Fatalf("cancelled %d invites on the retry; the first attempt already had", cancelled)
	}

	var config struct {
		Devices []struct{ DeviceID string }
		Folders []struct{ Devices []struct{ DeviceID string } }
	}
	if err := client.Request(context.Background(), "GET", "config", nil, &config); err != nil {
		t.Fatal(err)
	}
	if len(config.Devices) != 1 || config.Devices[0].DeviceID != stays || len(config.Folders[0].Devices) != 1 || config.Folders[0].Devices[0].DeviceID != stays {
		t.Fatalf("removal did not leave exactly the other device: %+v", config)
	}
	for _, id := range []string{removed, fixtureID("D")} {
		code := VerificationCode(store.FolderID, store.OwnerID, id)
		if _, err := store.Accept(context.Background(), client, id, invite.ProofName(id, "fixture"), code, now); !errors.Is(err, ErrInvalidInviteProof) {
			t.Fatalf("a cancelled invite still let %s in: %v", id, err)
		}
	}
	if next := issueFixture(t, store, nil, now); !next.RequireVerification {
		t.Fatal("removal reset the verification policy")
	}
}

func TestRemovingCountsTheInvitesItCancels(t *testing.T) {
	store := fixtureInvites(t)
	now := time.Now()
	issueFixture(t, store, nil, now.Add(-25*time.Hour))
	issueFixture(t, store, nil, now)
	issueFixture(t, store, nil, now)
	client, _ := authorizationFixture(t, store.FolderID, nil)
	cancelled, err := store.Remove(context.Background(), client, fixtureID("B"), now)
	if err != nil || cancelled != 2 {
		t.Fatalf("cancelled %d, %v; want the 2 invites still open", cancelled, err)
	}
	if _, err := store.Remove(context.Background(), client, store.OwnerID, now); err == nil {
		t.Fatal("removed the creator's own device")
	}
}

func TestProcessReportsTheDevicesItAccepted(t *testing.T) {
	store := fixtureInvites(t)
	now := time.Now()
	invite := issueFixture(t, store, nil, now)
	client, _ := authorizationFixture(t, store.FolderID, nil)
	joining, stranger := fixtureID("B"), fixtureID("C")
	pending := map[string]Pending{
		joining:  {Name: invite.ProofName(joining, "sam")},
		stranger: {Name: "no proof here"},
	}
	joined, err := store.Process(context.Background(), client, pending, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(joined) != 1 || joined[0] != (Joined{DeviceID: joining, Name: "sam"}) {
		t.Fatalf("joined = %+v; want only sam", joined)
	}
}

// The creator keeps a joiner's name to what the joiner's own side would send:
// ProofName drops control characters and stops at 80, so a proof that carries
// more came from a modified client.
func TestCreatorKeepsOnlyNamesAnHonestJoinerSends(t *testing.T) {
	store := fixtureInvites(t)
	now := time.Now()
	invite := issueFixture(t, store, nil, now)
	client, _ := authorizationFixture(t, store.FolderID, nil)
	device := fixtureID("B")
	name, err := store.Accept(context.Background(), client, device, invite.ProofName(device, "  sam@example.invalid "), "", now)
	if err != nil || name != "sam@example.invalid" {
		t.Fatalf("accepted as %q, %v; want the name without its surrounding spaces", name, err)
	}
	var config struct{ Devices []struct{ Name string } }
	if err := client.Request(context.Background(), "GET", "config", nil, &config); err != nil || len(config.Devices) != 1 || config.Devices[0].Name != "sam@example.invalid" {
		t.Fatalf("stored %+v, %v", config.Devices, err)
	}

	other := fixtureID("C")
	forged := func(name string) string {
		data, _ := json.Marshal(inviteProof{ID: invite.ID, Name: name, MAC: base64.RawURLEncoding.EncodeToString(invite.proofMAC(other, name))})
		return "cm2_" + base64.RawURLEncoding.EncodeToString(data)
	}
	wide := []string{strings.Repeat("\uff37", 41), strings.Repeat("\u3164", 39) + "sam@example.invalid   BBBBBBB   ok"}
	for _, name := range append([]string{fixtureID("D"), " " + strings.ToLower(fixtureID("B")), "sam\x1b[2J", strings.Repeat("s", 81)}, wide...) {
		if _, err := store.Accept(context.Background(), client, other, forged(name), "", now); !errors.Is(err, ErrInvalidInviteProof) {
			t.Errorf("accepted a device named %q: %v", name, err)
		}
	}
	if _, err := store.Accept(context.Background(), client, other, forged(strings.Repeat("ש", 80)), "", now); err != nil {
		t.Errorf("refused an 80-character name: %v", err)
	}
	long := fixtureID("E")
	if name, err := store.Accept(context.Background(), client, long, invite.ProofName(long, strings.Repeat("\uff37", 50)), "", now); err != nil || name != strings.Repeat("\uff37", 40) {
		t.Errorf("a joiner with a long wide name was accepted as %q, %v; want its first 80 columns", name, err)
	}
}
