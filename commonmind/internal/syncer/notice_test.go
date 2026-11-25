package syncer

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base32"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

// syncIdentity writes a Syncthing-style identity, cert.pem and key.pem, and
// returns its home and device ID: the certificate's SHA-256 in base32, with a
// check character after every 13 (any character will do for these tests).
func syncIdentity(t *testing.T, key crypto.Signer) (string, string) {
	t.Helper()
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "syncthing"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, template, template, key.Public(), key)
	if err != nil {
		t.Fatal(err)
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "cert.pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "key.pem"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}), 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(der)
	data := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(sum[:])
	var id string
	for i := 0; i < len(data); i += 13 {
		id += data[i:i+13] + "A"
	}
	var groups []string
	for i := 0; i < len(id); i += 7 {
		groups = append(groups, id[i:i+7])
	}
	return home, strings.Join(groups, "-")
}

func TestOnlyTheCreatorsSyncIdentityCanSignARemoval(t *testing.T) {
	_, edKey, _ := ed25519.GenerateKey(rand.Reader)
	ecKey, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	folder, removed := NewFolderID(), fixtureID("B")
	for name, key := range map[string]crypto.Signer{"ed25519": edKey, "ecdsa": ecKey} {
		t.Run(name, func(t *testing.T) {
			home, owner := syncIdentity(t, key)
			want := Notice{Folder: folder, Device: removed, Removed: true, At: time.Now().UnixNano()}
			signed, err := SignNotice(home, want)
			if err != nil {
				t.Fatal(err)
			}
			if got, err := VerifyNotice(signed, owner, folder); err != nil || got != want {
				t.Fatalf("VerifyNotice = %+v, %v; want %+v", got, err, want)
			}
			if _, err := VerifyNotice(signed, owner, NewFolderID()); err == nil {
				t.Error("accepted a notice for another team's folder")
			}
			if _, err := VerifyNotice(signed, fixtureID("C"), folder); err == nil {
				t.Error("accepted a notice that the expected creator did not sign")
			}
			altered := bytes.Replace(signed, []byte(removed[:7]), []byte(fixtureID("D")[:7]), 1)
			if _, err := VerifyNotice(altered, owner, folder); err == nil {
				t.Error("accepted a notice altered after it was signed")
			}
		})
	}

	// A member's own identity, certificate included, does not make it the creator.
	_, memberKey, _ := ed25519.GenerateKey(rand.Reader)
	memberHome, _ := syncIdentity(t, memberKey)
	_, owner := syncIdentity(t, edKey)
	forged, err := SignNotice(memberHome, Notice{Folder: folder, Device: removed, Removed: true, At: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyNotice(forged, owner, folder); err == nil {
		t.Error("accepted a notice a member signed with its own identity")
	}
	for _, garbage := range []string{"", "{}", `{"notice":{},"certificate":"","signature":""}`} {
		if _, err := VerifyNotice([]byte(garbage), owner, folder); err == nil {
			t.Errorf("accepted %q", garbage)
		}
	}
}

func TestUnseenRemovalsActsOnlyOnEachDevicesLatestNotice(t *testing.T) {
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	home, owner := syncIdentity(t, key)
	folder, self := NewFolderID(), fixtureID("S")
	sign := func(device string, removed bool, at int64) []byte {
		data, err := SignNotice(home, Notice{Folder: folder, Device: device, Removed: removed, At: at})
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	_, otherKey, _ := ed25519.GenerateKey(rand.Reader)
	otherHome, _ := syncIdentity(t, otherKey)
	forged, _ := SignNotice(otherHome, Notice{Folder: folder, Device: fixtureID("E"), Removed: true, At: 5})
	notices := [][]byte{
		sign(fixtureID("B"), true, 10),
		sign(fixtureID("C"), true, 20),
		sign(self, true, 30),
		forged, []byte("not a notice"),
		// Let back in after its removal: an old copy of the removal is not news.
		sign(fixtureID("D"), false, 50), sign(fixtureID("D"), true, 40),
		// Removed again after being let back in.
		sign(fixtureID("F"), true, 60), sign(fixtureID("F"), false, 55), sign(fixtureID("F"), true, 50),
		sign(fixtureID("G"), false, 70),
	}
	seen := map[string]int64{fixtureID("B"): 10, fixtureID("C"): 15}
	got := UnseenRemovals(notices, owner, folder, self, seen)
	want := []Notice{{Folder: folder, Device: fixtureID("C"), Removed: true, At: 20}, {Folder: folder, Device: fixtureID("F"), Removed: true, At: 60}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("UnseenRemovals = %+v; want %+v", got, want)
	}
	if seen[fixtureID("C")] != 15 {
		t.Fatal("UnseenRemovals changed the record it was given")
	}
	data, _ := json.Marshal(got)
	if strings.Contains(string(data), self) {
		t.Fatal("a member would act on its own removal")
	}
}

func TestKeepNoticesPutsBackWhatTheFolderLost(t *testing.T) {
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	home, owner := syncIdentity(t, key)
	folder := NewFolderID()
	sign := func(device string, at int64) []byte {
		data, err := SignNotice(home, Notice{Folder: folder, Device: device, Removed: true, At: at})
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	a, b, c := sign(fixtureID("A"), 1), sign(fixtureID("B"), 2), sign(fixtureID("C"), 3)
	_, otherKey, _ := ed25519.GenerateKey(rand.Reader)
	otherHome, _ := syncIdentity(t, otherKey)
	forged, _ := SignNotice(otherHome, Notice{Folder: folder, Device: fixtureID("D"), Removed: true, At: 4})
	changed := bytes.Replace(a, []byte(fixtureID("A")[:7]), []byte(fixtureID("E")[:7]), 1)

	// This machine held a and b. The folder lost a, or had it changed, and gained c.
	kept, missing := KeepNotices([][]byte{a, b}, [][]byte{b, c, c, forged, []byte("not a notice"), changed}, owner, folder)
	if !reflect.DeepEqual(kept, [][]byte{a, b, c}) {
		t.Errorf("kept %d notices; want a, b and c, each once", len(kept))
	}
	if !reflect.DeepEqual(missing, [][]byte{a}) {
		t.Errorf("missing %q; want a, to put back", missing)
	}
	if kept, missing := KeepNotices(kept, [][]byte{c, b, a}, owner, folder); len(kept) != 3 || len(missing) != 0 {
		t.Errorf("with nothing new or lost, kept %d and missing %d", len(kept), len(missing))
	}
}

// Only the notice inside is signed, so anyone who shares the folder can wrap
// one genuine notice in as many different files as they like.
func TestKeepNoticesKeepsOneCopyOfEachDevicesLatestNotice(t *testing.T) {
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	home, owner := syncIdentity(t, key)
	folder, device := NewFolderID(), fixtureID("A")
	sign := func(removed bool, at int64) []byte {
		data, err := SignNotice(home, Notice{Folder: folder, Device: device, Removed: removed, At: at})
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	removed, readmitted := sign(true, 1), sign(false, 2)
	var copies [][]byte
	for i := range 50 {
		copies = append(copies, []byte("{"+strings.Repeat(" ", i%5)+`"padding":`+strconv.Itoa(i)+","+string(removed[1:])))
	}
	if _, err := VerifyNotice(copies[49], owner, folder); err != nil {
		t.Fatalf("a reshaped copy does not pass, so this test proves nothing: %v", err)
	}

	if kept, missing := KeepNotices(copies[:10], copies[10:], owner, folder); !reflect.DeepEqual(kept, [][]byte{removed}) || len(missing) != 0 {
		t.Errorf("from 50 copies of one notice, kept %d and missing %d; want the one, as it was signed, and none missing", len(kept), len(missing))
	}
	if kept, missing := KeepNotices([][]byte{removed}, [][]byte{copies[3], readmitted}, owner, folder); !reflect.DeepEqual(kept, [][]byte{readmitted}) || len(missing) != 0 {
		t.Errorf("after the readmission, kept %d and missing %d; want only the readmission", len(kept), len(missing))
	}
	if kept, missing := KeepNotices([][]byte{readmitted}, copies, owner, folder); !reflect.DeepEqual(kept, [][]byte{readmitted}) || !reflect.DeepEqual(missing, [][]byte{readmitted}) {
		t.Errorf("with only copies of the removal in the folder, kept %d and missing %d; want the readmission kept and put back", len(kept), len(missing))
	}
}
