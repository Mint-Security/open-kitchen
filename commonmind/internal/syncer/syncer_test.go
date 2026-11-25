package syncer

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestManagedIgnoresPreservesExistingRules(t *testing.T) {
	existing := []string{"// Existing rules", "#escape=|", "", "/private/**", "!**", "/.commonmind-tmp"}
	original := append([]string(nil), existing...)
	want := []string{"// Existing rules", "#escape=|", "", "/.commonmind-tmp", "/.commonmind-write-probe", "/private/**", "!**"}
	got := managedIgnores(existing)
	if !reflect.DeepEqual(got, want) || !reflect.DeepEqual(existing, original) {
		t.Fatalf("changed rule order or input: got=%v input=%v", got, existing)
	}
	if !reflect.DeepEqual(managedIgnores(got), got) {
		t.Fatal("repeated setup changed ignore rules")
	}
}

func TestInviteValidationAndIdentityBinding(t *testing.T) {
	now := time.Now()
	i := Invite{Team: "Example Team", FolderID: NewFolderID(), OwnerID: strings.Repeat("AAAAAAA-", 7) + "AAAAAAA", Expires: now.Add(time.Hour).Unix(),
		ID: strings.Repeat("a", 32), Secret: base64.RawURLEncoding.EncodeToString(make([]byte, 32))}
	got, err := ParseInvite(i.Encode(), now)
	if err != nil || got != i {
		t.Fatalf("round trip: %+v, %v", got, err)
	}
	bare, _ := json.Marshal(Invite{Team: i.Team, FolderID: i.FolderID, OwnerID: i.OwnerID, Expires: i.Expires})
	for _, prefix := range []string{"cm1_", "cm2_"} {
		if _, err := ParseInvite(prefix+base64.RawURLEncoding.EncodeToString(bare), now); err == nil {
			t.Fatalf("accepted a %s invite that carries no secret", prefix)
		}
	}
	if _, err := ParseInvite(i.Encode(), now.Add(2*time.Hour)); err == nil {
		t.Fatal("accepted expired invite")
	}
	i.Team = "bad\nterminal"
	if _, err := ParseInvite(i.Encode(), now); err == nil {
		t.Fatal("accepted control characters")
	}
	if _, err := ParseInvite("cm2_"+strings.Repeat("a", 5000), now); err == nil {
		t.Fatal("accepted oversized invite")
	}
	a := VerificationCode("folder", "owner", "first")
	if a == VerificationCode("folder", "owner", "second") || a == VerificationCode("other", "owner", "first") {
		t.Fatal("verification is not bound to team and joining device")
	}
}

func TestSharePreservesOtherMembers(t *testing.T) {
	var patched struct {
		Devices []map[string]any `json:"devices"`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != "test-key" {
			t.Error("missing API authentication")
		}
		if r.Method == "GET" {
			_, _ = w.Write([]byte(`{"devices":[{"deviceID":"existing","introducedBy":"owner"}]}`))
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&patched); err != nil {
			t.Error(err)
		}
	}))
	defer srv.Close()
	client := Client{Address: strings.TrimPrefix(srv.URL, "http://"), APIKey: "test-key"}
	if err := client.Share(context.Background(), "team", "new"); err != nil {
		t.Fatal(err)
	}
	if len(patched.Devices) != 2 || patched.Devices[0]["introducedBy"] != "owner" || patched.Devices[1]["deviceID"] != "new" {
		t.Fatalf("membership lost: %+v", patched)
	}
}

func TestMembersListsTheDevicesTheTeamFolderIsSharedWith(t *testing.T) {
	folder := NewFolderID()
	own, online, away, outsider := fixtureID("A"), fixtureID("B"), fixtureID("C"), fixtureID("D")
	seen := time.Date(2026, 11, 20, 8, 0, 0, 0, time.UTC)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body any
		switch r.URL.Path {
		case "/rest/config":
			body = map[string]any{
				"devices": []any{
					map[string]any{"deviceID": own, "name": "dana"},
					map[string]any{"deviceID": online, "name": "sam"},
					map[string]any{"deviceID": away, "name": "lee"},
					map[string]any{"deviceID": outsider, "name": "another folder's peer"},
				},
				"folders": []any{
					map[string]any{"id": "elsewhere", "devices": []any{map[string]any{"deviceID": own}, map[string]any{"deviceID": outsider}}},
					map[string]any{"id": folder, "devices": []any{map[string]any{"deviceID": own}, map[string]any{"deviceID": online}, map[string]any{"deviceID": away}}},
				},
			}
		case "/rest/system/connections":
			body = map[string]any{"connections": map[string]any{online: map[string]any{"connected": true}, away: map[string]any{"connected": false}}}
		case "/rest/stats/device":
			body = map[string]any{
				own:    map[string]any{"lastSeen": "1970-01-01T01:00:00+01:00"},
				online: map[string]any{"lastSeen": seen.Add(time.Hour)},
				away:   map[string]any{"lastSeen": seen},
			}
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(body)
	}))
	defer srv.Close()
	client := Client{Address: strings.TrimPrefix(srv.URL, "http://")}
	members, err := client.Members(context.Background(), folder)
	if err != nil {
		t.Fatal(err)
	}
	want := []Member{
		{DeviceID: own, Name: "dana"},
		{DeviceID: away, Name: "lee", LastSeen: seen},
		{DeviceID: online, Name: "sam", Connected: true, LastSeen: seen.Add(time.Hour)},
	}
	if len(members) != len(want) {
		t.Fatalf("members = %+v; want %+v", members, want)
	}
	for i := range want {
		if members[i].DeviceID != want[i].DeviceID || members[i].Name != want[i].Name || members[i].Connected != want[i].Connected || !members[i].LastSeen.Equal(want[i].LastSeen) {
			t.Fatalf("members = %+v; want %+v", members, want)
		}
	}
}

// A team flooded through a leaked invite has a config past a few MiB, and
// members and remove are how the creator gets out of that.
func TestMembersReadsAConfigPastFourMiB(t *testing.T) {
	folder := NewFolderID()
	var devices, shared []any
	for i := range 5000 {
		id := fmt.Sprintf("DEVICE-%07d", i)
		devices = append(devices, map[string]any{"deviceID": id, "name": strings.Repeat("n", 1000)})
		shared = append(shared, map[string]any{"deviceID": id})
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := map[string]any{}
		if r.URL.Path == "/rest/config" {
			body = map[string]any{"devices": devices, "folders": []any{map[string]any{"id": folder, "devices": shared}}}
		}
		_ = json.NewEncoder(w).Encode(body)
	}))
	defer srv.Close()
	client := Client{Address: strings.TrimPrefix(srv.URL, "http://")}
	members, err := client.Members(context.Background(), folder)
	if err != nil || len(members) != 5000 {
		t.Fatalf("read %d members, %v; want 5000", len(members), err)
	}
}

// Integration tests stay on loopback, including discovery and relays.
func keepOnLoopback(t *testing.T, s State) {
	t.Helper()
	configPath := filepath.Join(s.Home, "config.xml")
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	config := string(data)
	for _, flag := range []string{"globalAnnounceEnabled", "localAnnounceEnabled", "relaysEnabled", "natEnabled"} {
		config = strings.ReplaceAll(config, "<"+flag+">true</"+flag+">", "<"+flag+">false</"+flag+">")
	}
	config = strings.ReplaceAll(config, "tcp://0.0.0.0:0", "tcp://127.0.0.1:0")
	config = strings.ReplaceAll(config, "<listenAddress>quic://0.0.0.0:0</listenAddress>", "")
	config = strings.ReplaceAll(config, "<listenAddress>dynamic+https://relays.syncthing.net/endpoint</listenAddress>", "")
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestPrepareRefusesAConfigItCannotRewrite: the listeners and the reporting
// switches are rewritten by their exact text. A generated config that has
// them in another form must stop setup, not go ahead with Syncthing's defaults.
func TestPrepareRefusesAConfigItCannotRewrite(t *testing.T) {
	dir := t.TempDir()
	fake := filepath.Join(dir, "syncthing")
	script := `#!/bin/sh
mkdir -p "$3"
cat > "$3/config.xml" <<XML
<configuration version="51">
  <device id="AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA" name="fixture"></device>
  <gui enabled="true" tls="false"><address>127.0.0.1:8384</address><apikey>fixture-key</apikey></gui>
  <options>
    <listenAddress>tcp://0.0.0.0:22001</listenAddress>
    <urAccepted>0</urAccepted>
    <crashReportingEnabled>true</crashReportingEnabled>
  </options>
</configuration>
XML
`
	if err := os.WriteFile(fake, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(dir, "home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := Prepare(context.Background(), home, fake); err == nil {
		t.Fatal("set up sync on listeners it did not choose")
	}
	if _, err := os.Stat(filepath.Join(home, "sync.json")); !os.IsNotExist(err) {
		t.Fatal("saved a sync state for a config it could not rewrite")
	}
}

// TestRealSyncthingGetsItsOwnListenersWhenTheDefaultPortIsTaken: with 22000
// taken, as it is on a machine that runs a Syncthing of its own, generate
// writes fixed listeners where the default would be.
func TestRealSyncthingGetsItsOwnListenersWhenTheDefaultPortIsTaken(t *testing.T) {
	binary := os.Getenv("COMMONMIND_TEST_SYNCTHING")
	if binary == "" {
		t.Skip("set COMMONMIND_TEST_SYNCTHING to test the real sync configuration")
	}
	if tcp, err := net.Listen("tcp", ":22000"); err == nil {
		defer tcp.Close()
	}
	if udp, err := net.ListenPacket("udp", ":22000"); err == nil {
		defer udp.Close()
	}
	s, err := Prepare(context.Background(), t.TempDir(), binary)
	if err != nil {
		t.Fatal(err)
	}
	config, err := os.ReadFile(filepath.Join(s.Home, "config.xml"))
	if err != nil {
		t.Fatal(err)
	}
	for _, listener := range []string{"tcp://0.0.0.0:0", "quic://0.0.0.0:0"} {
		if !strings.Contains(string(config), "<listenAddress>"+listener+"</listenAddress>") {
			t.Fatalf("no %s listener in the sync config:\n%s", listener, config)
		}
	}
}

func TestRealSyncthingIdentitySignsRemovalNotices(t *testing.T) {
	binary := os.Getenv("COMMONMIND_TEST_SYNCTHING")
	if binary == "" {
		t.Skip("set COMMONMIND_TEST_SYNCTHING to sign with a real sync identity")
	}
	creator, err := Prepare(context.Background(), t.TempDir(), binary)
	if err != nil {
		t.Fatal(err)
	}
	member, err := Prepare(context.Background(), t.TempDir(), binary)
	if err != nil {
		t.Fatal(err)
	}
	folder := NewFolderID()
	notice := Notice{Folder: folder, Device: member.DeviceID, Removed: true, At: time.Now().UnixNano()}
	signed, err := SignNotice(creator.Home, notice)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := VerifyNotice(signed, creator.DeviceID, folder); err != nil || got != notice {
		t.Fatalf("the creator's own notice: %+v, %v", got, err)
	}
	if _, err := VerifyNotice(signed, member.DeviceID, folder); err == nil {
		t.Fatal("a notice passed as another device's")
	}
}

func TestRealSyncthingRefusesTheAPIWithoutItsKey(t *testing.T) {
	binary := os.Getenv("COMMONMIND_TEST_SYNCTHING")
	if binary == "" {
		t.Skip("set COMMONMIND_TEST_SYNCTHING to test the real sync API")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	s, err := Prepare(ctx, t.TempDir(), binary)
	if err != nil {
		t.Fatal(err)
	}
	keepOnLoopback(t, s)
	process, err := s.Start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(process.Close)
	// What any local process can do: load the GUI page and use the token it hands out.
	page, err := http.Get("http://" + s.Address + "/")
	if err != nil {
		t.Fatal(err)
	}
	page.Body.Close()
	req, err := http.NewRequestWithContext(ctx, "GET", "http://"+s.Address+"/rest/config", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, cookie := range page.Cookies() {
		req.AddCookie(cookie)
		req.Header.Set("X-"+cookie.Name, cookie.Value)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatal("the sync API answered a request that carried no API key")
	}
	if err := s.Ping(ctx); err != nil {
		t.Fatalf("the API key stopped working: %v", err)
	}
}

func TestRealSyncthingEnrollmentIntroductionsAndRemoval(t *testing.T) {
	binary := os.Getenv("COMMONMIND_TEST_SYNCTHING")
	if binary == "" {
		t.Skip("set COMMONMIND_TEST_SYNCTHING to test real three-device sync")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	folderID := NewFolderID()
	type peer struct {
		State
		shared, address string
		process         *Process
	}
	newPeer := func() peer {
		home := t.TempDir()
		s, err := Prepare(ctx, home, binary)
		if err != nil {
			t.Fatal(err)
		}
		keepOnLoopback(t, s)
		process, err := s.Start(ctx)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(process.Close)
		shared := filepath.Join(home, "shared")
		if err := os.MkdirAll(filepath.Join(shared, "sessions"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := s.ConfigureFolder(ctx, folderID, "Integration team", shared, s.DeviceID); err != nil {
			t.Fatal(err)
		}
		var status struct {
			Listeners map[string]struct {
				Addresses []string `json:"lanAddresses"`
			} `json:"connectionServiceStatus"`
		}
		if err := s.Request(ctx, "GET", "system/status", nil, &status); err != nil {
			t.Fatal(err)
		}
		for _, listener := range status.Listeners {
			for _, address := range listener.Addresses {
				if strings.HasPrefix(address, "tcp://127.0.0.1:") {
					_, port, _ := net.SplitHostPort(strings.TrimPrefix(address, "tcp://"))
					if port != "0" {
						return peer{s, shared, address, process}
					}
				}
			}
		}
		t.Fatalf("no loopback listener: %+v", status)
		return peer{}
	}
	owner, first, second := newPeer(), newPeer(), newPeer()
	waitFor := func(description string, condition func() bool) {
		t.Helper()
		for !condition() {
			select {
			case <-ctx.Done():
				t.Fatalf("timed out: %s", description)
			case <-time.After(250 * time.Millisecond):
			}
		}
	}
	join := func(joiner peer) {
		if err := joiner.AddDevice(ctx, owner.DeviceID, "owner", true, []string{owner.address}); err != nil {
			t.Fatal(err)
		}
		if err := joiner.Share(ctx, folderID, owner.DeviceID); err != nil {
			t.Fatal(err)
		}
		waitFor("pending enrollment", func() bool { pending, _ := owner.Pending(ctx); _, exists := pending[joiner.DeviceID]; return exists })
		if connected, _ := owner.Connected(ctx, joiner.DeviceID); connected {
			t.Fatal("connected before approval")
		}
		if err := owner.AddDevice(ctx, joiner.DeviceID, "member", false, []string{joiner.address}); err != nil {
			t.Fatal(err)
		}
		if err := owner.Share(ctx, folderID, joiner.DeviceID); err != nil {
			t.Fatal(err)
		}
		waitFor("approved connection", func() bool { connected, _ := owner.Connected(ctx, joiner.DeviceID); return connected })
	}
	join(first)
	join(second)
	waitFor("automatic peer introduction", func() bool { connected, _ := first.Connected(ctx, second.DeviceID); return connected })
	if err := os.WriteFile(filepath.Join(first.shared, "sessions", "fixture.cms"), []byte("synthetic shared session"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitFor("replicated session", func() bool {
		b, _ := os.ReadFile(filepath.Join(second.shared, "sessions", "fixture.cms"))
		return string(b) == "synthetic shared session"
	})
	if err := os.MkdirAll(filepath.Join(first.shared, ".commonmind-tmp"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(first.shared, ".commonmind-tmp", "partial.cms"), []byte("private staging"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := first.Request(ctx, "POST", "db/scan?folder="+folderID, nil, nil); err != nil {
		t.Fatal(err)
	}
	var ignores struct {
		Ignore []string `json:"ignore"`
	}
	if err := first.Request(ctx, "GET", "db/ignores?folder="+folderID, nil, &ignores); err != nil {
		t.Fatal(err)
	}
	if len(ignores.Ignore) != 2 {
		t.Fatalf("missing staging ignore: %+v", ignores)
	}
	if err := os.Remove(filepath.Join(first.shared, "sessions", "fixture.cms")); err != nil {
		t.Fatal(err)
	}
	if err := first.Request(ctx, "POST", "db/scan?folder="+folderID, nil, nil); err != nil {
		t.Fatal(err)
	}
	waitFor("replicated deletion", func() bool {
		_, err := os.Stat(filepath.Join(second.shared, "sessions", "fixture.cms"))
		return os.IsNotExist(err)
	})

	connectedMembers := func(p peer) []string {
		members, err := p.Members(ctx, folderID)
		if err != nil {
			t.Fatal(err)
		}
		var ids []string
		for _, m := range members {
			if m.Connected {
				ids = append(ids, m.DeviceID)
			}
		}
		slices.Sort(ids)
		return ids
	}
	if members, _ := owner.Members(ctx, folderID); len(members) != 3 {
		t.Fatalf("the creator lists %d members; want 3: %+v", len(members), members)
	}
	want := []string{first.DeviceID, second.DeviceID}
	slices.Sort(want)
	if got := connectedMembers(owner); !slices.Equal(got, want) {
		t.Fatalf("connected members = %v; want %v", got, want)
	}

	if err := owner.Remove(ctx, second.DeviceID); err != nil {
		t.Fatal(err)
	}
	knows := func(p peer, id string) bool {
		var device map[string]any
		return p.Request(ctx, "GET", "config/devices/"+id, nil, &device) == nil
	}
	if knows(owner, second.DeviceID) {
		t.Fatal("the creator still lists the removed device")
	}
	waitFor("the other teammate to drop the removed device", func() bool { return !knows(first, second.DeviceID) })
	waitFor("the removed device to be cut off", func() bool {
		toOwner, _ := owner.Connected(ctx, second.DeviceID)
		toFirst, _ := first.Connected(ctx, second.DeviceID)
		return !toOwner && !toFirst
	})
	if !knows(first, owner.DeviceID) || !knows(owner, first.DeviceID) {
		t.Fatal("removing one device took others with it")
	}
	if members, _ := first.Members(ctx, folderID); len(members) != 2 {
		t.Fatalf("the other teammate lists %d members after the removal; want 2: %+v", len(members), members)
	}

	// A stopped Syncthing has let go of its home by the time Close returns, so
	// the next start, as after commonmind stop and start, can take it.
	owner.process.Close()
	restarted, err := owner.Start(ctx)
	if err != nil {
		t.Fatalf("start right after a stop: %v", err)
	}
	t.Cleanup(restarted.Close)
}
