package syncer

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/names"
)

var ErrInvalidInviteProof = errors.New("invalid or expired invite")
var ErrVerificationRequired = errors.New("this invite requires the teammate's verification code")
var ErrVerificationMismatch = errors.New("verification code does not match; device was not authorized")

type InviteStore struct{ Home, FolderID, OwnerID string }
type inviteBook struct {
	RequireVerification bool              `json:"require_verification"`
	Invites             map[string]Invite `json:"invites"`
}
type InviteRequest struct {
	Name                string
	RequireVerification bool
}

// Serialize issuance and Syncthing's read-modify-write configuration updates.
func (s InviteStore) loadLocked() (*os.File, inviteBook, error) {
	book := inviteBook{Invites: map[string]Invite{}}
	lock, err := os.OpenFile(filepath.Join(s.Home, "invites.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, book, err
	}
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		lock.Close()
		return nil, book, err
	}
	data, err := os.ReadFile(filepath.Join(s.Home, "invites.json"))
	if errors.Is(err, os.ErrNotExist) {
		return lock, book, nil
	}
	if err == nil {
		err = json.Unmarshal(data, &book)
	}
	if err != nil {
		lock.Close()
		return nil, book, fmt.Errorf("read invite state: %w", err)
	}
	if book.Invites == nil {
		book.Invites = map[string]Invite{}
	}
	return lock, book, nil
}

func (s InviteStore) Issue(team string, requireVerification *bool, now time.Time) (Invite, error) {
	if !TeamNameValid(team) || !folderIDPattern.MatchString(s.FolderID) || !deviceIDPattern.MatchString(s.OwnerID) {
		return Invite{}, errors.New("invalid team identity for invite")
	}
	lock, book, err := s.loadLocked()
	if err != nil {
		return Invite{}, err
	}
	defer lock.Close()
	if requireVerification != nil {
		book.RequireVerification = *requireVerification
	}
	for id, invite := range book.Invites {
		if invite.Expires <= now.Unix() {
			delete(book.Invites, id)
		}
	}
	var id [16]byte
	var secret [32]byte
	_, _ = rand.Read(id[:])
	_, _ = rand.Read(secret[:])
	invite := Invite{Team: team, FolderID: s.FolderID, OwnerID: s.OwnerID, Expires: now.Add(24 * time.Hour).Unix(), ID: hex.EncodeToString(id[:]), Secret: base64.RawURLEncoding.EncodeToString(secret[:]), RequireVerification: book.RequireVerification}
	book.Invites[invite.ID] = invite
	return invite, s.save(book)
}

// save is on disk when it returns, so a removal's cancelled invites cannot come
// back after a power cut that Syncthing's own config write survived.
func (s InviteStore) save(book inviteBook) error {
	file, err := os.CreateTemp(s.Home, ".invites-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := json.NewEncoder(file).Encode(book); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), filepath.Join(s.Home, "invites.json")); err != nil {
		return err
	}
	dir, err := os.Open(s.Home)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (s InviteStore) inspect(book inviteBook, deviceID, hello string, now time.Time) (InviteRequest, error) {
	proof, err := parseProof(hello)
	if err != nil {
		return InviteRequest{}, err
	}
	invite, ok := book.Invites[proof.ID]
	mac, err := base64.RawURLEncoding.DecodeString(proof.MAC)
	key, keyErr := base64.RawURLEncoding.DecodeString(invite.Secret)
	if !ok || err != nil || keyErr != nil || len(key) != 32 || invite.ID != proof.ID || !deviceIDPattern.MatchString(deviceID) || deviceID == s.OwnerID || invite.OwnerID != s.OwnerID || invite.FolderID != s.FolderID || invite.Expires <= now.Unix() || !hmac.Equal(mac, invite.proofMAC(deviceID, proof.Name)) {
		return InviteRequest{}, ErrInvalidInviteProof
	}
	name, ok := joinerName(proof.Name)
	if !ok {
		return InviteRequest{}, ErrInvalidInviteProof
	}
	return InviteRequest{Name: name, RequireVerification: invite.RequireVerification}, nil
}

// joinerName is the name a device joins under, as the creator keeps it. The
// joiner's side never sends control characters or more than 80 columns, and no
// teammate is named like a device ID, which could stand in for another device
// wherever devices are picked by name.
func joinerName(name string) (string, bool) {
	if names.Width(name) > 80 || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return "", false
	}
	name = strings.TrimSpace(name)
	return name, !deviceIDPattern.MatchString(strings.ToUpper(name))
}

func (s InviteStore) Inspect(deviceID, hello string, now time.Time) (InviteRequest, error) {
	lock, book, err := s.loadLocked()
	if err != nil {
		return InviteRequest{}, err
	}
	defer lock.Close()
	return s.inspect(book, deviceID, hello, now)
}

func (s InviteStore) Accept(ctx context.Context, client Client, deviceID, hello, code string, now time.Time) (string, error) {
	lock, book, err := s.loadLocked()
	if err != nil {
		return "", err
	}
	defer lock.Close()
	request, err := s.inspect(book, deviceID, hello, now)
	if err != nil {
		return "", err
	}
	if request.RequireVerification {
		if code == "" {
			return "", ErrVerificationRequired
		}
		if code != VerificationCode(s.FolderID, s.OwnerID, deviceID) {
			return "", ErrVerificationMismatch
		}
	}
	return request.Name, client.Authorize(ctx, s.FolderID, deviceID, request.Name)
}

type Joined struct{ DeviceID, Name string }

func (s InviteStore) Process(ctx context.Context, client Client, pending map[string]Pending, now time.Time) ([]Joined, error) {
	var joined []Joined
	for id, device := range pending {
		name, err := s.Accept(ctx, client, id, device.Name, "", now)
		if errors.Is(err, ErrInvalidInviteProof) || errors.Is(err, ErrVerificationRequired) {
			continue
		}
		if err != nil {
			return joined, err
		}
		joined = append(joined, Joined{DeviceID: id, Name: name})
	}
	return joined, nil
}

// Remove cancels every open invite, then takes the device out of the team. A
// removed teammate may hold any of the invites, and each would let them straight
// back in, so they go first: a removal that fails halfway leaves none behind.
// It returns how many invites were still open.
func (s InviteStore) Remove(ctx context.Context, client Client, deviceID string, now time.Time) (int, error) {
	if deviceID == s.OwnerID {
		return 0, errors.New("the team creator's own device cannot be removed")
	}
	lock, book, err := s.loadLocked()
	if err != nil {
		return 0, err
	}
	defer lock.Close()
	open := 0
	for _, invite := range book.Invites {
		if invite.Expires > now.Unix() {
			open++
		}
	}
	if len(book.Invites) > 0 {
		book.Invites = map[string]Invite{}
		if err := s.save(book); err != nil {
			return 0, err
		}
	}
	return open, client.Remove(ctx, deviceID)
}
