package syncer

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/names"
)

type Invite struct {
	Team                string `json:"team"`
	FolderID            string `json:"folder"`
	OwnerID             string `json:"owner"`
	Expires             int64  `json:"expires"`
	ID                  string `json:"id,omitempty"`
	Secret              string `json:"secret,omitempty"`
	RequireVerification bool   `json:"require_verification,omitempty"`
}

var deviceIDPattern = regexp.MustCompile(`^([A-Z2-7]{7}-){7}[A-Z2-7]{7}$`)
var folderIDPattern = regexp.MustCompile(`^commonmind-[0-9a-f]{32}$`)

func TeamNameValid(name string) bool {
	return strings.TrimSpace(name) != "" && len(name) <= 80 && strings.IndexFunc(name, unicode.IsControl) == -1
}

func NewFolderID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return "commonmind-" + hex.EncodeToString(b[:])
}

func (i Invite) Encode() string {
	data, _ := json.Marshal(i)
	return "cm2_" + base64.RawURLEncoding.EncodeToString(data)
}

func ParseInvite(token string, now time.Time) (Invite, error) {
	var i Invite
	if len(token) > 4096 || !strings.HasPrefix(token, "cm2_") {
		return i, errors.New("invalid Commonmind invite")
	}
	data, err := base64.RawURLEncoding.DecodeString(token[4:])
	if err != nil {
		return i, errors.New("invalid Commonmind invite encoding")
	}
	if err := json.Unmarshal(data, &i); err != nil {
		return i, errors.New("invalid Commonmind invite contents")
	}
	if !TeamNameValid(i.Team) || !deviceIDPattern.MatchString(i.OwnerID) || !folderIDPattern.MatchString(i.FolderID) {
		return i, errors.New("invalid Commonmind team or device identity")
	}
	if i.Expires <= now.Unix() {
		return i, errors.New("invite expired; ask the inviter for a new one")
	}
	secret, err := base64.RawURLEncoding.DecodeString(i.Secret)
	if !inviteIDPattern.MatchString(i.ID) || err != nil || len(secret) != 32 {
		return Invite{}, errors.New("invalid secret invite")
	}
	return i, nil
}

var inviteIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

type inviteProof struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	MAC  string `json:"mac"`
}

func (i Invite) proofMAC(device, name string) []byte {
	key, _ := base64.RawURLEncoding.DecodeString(i.Secret)
	mac := hmac.New(sha256.New, key)
	payload, _ := json.Marshal([]any{"commonmind-enrollment-v2", i.ID, i.Team, i.FolderID, i.OwnerID, i.Expires, i.RequireVerification, device, name})
	_, _ = mac.Write(payload)
	return mac.Sum(nil)
}

// The hello carries a device-bound proof, never the reusable invite secret.
func (i Invite) ProofName(device, name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	name = names.Truncate(name, 80)
	p := inviteProof{ID: i.ID, Name: name, MAC: base64.RawURLEncoding.EncodeToString(i.proofMAC(device, name))}
	data, _ := json.Marshal(p)
	return "cm2_" + base64.RawURLEncoding.EncodeToString(data)
}

func parseProof(name string) (inviteProof, error) {
	var proof inviteProof
	if len(name) > 2048 || !strings.HasPrefix(name, "cm2_") {
		return proof, ErrInvalidInviteProof
	}
	data, err := base64.RawURLEncoding.DecodeString(name[4:])
	if err != nil || json.Unmarshal(data, &proof) != nil || !inviteIDPattern.MatchString(proof.ID) {
		return proof, ErrInvalidInviteProof
	}
	return proof, nil
}

func VerificationCode(folder, owner, joining string) string {
	sum := sha256.Sum256([]byte(folder + ":" + owner + ":" + joining))
	text := hex.EncodeToString(sum[:8])
	return text[:4] + "-" + text[4:8] + "-" + text[8:12] + "-" + text[12:]
}
