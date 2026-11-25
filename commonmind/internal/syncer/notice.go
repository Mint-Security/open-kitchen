package syncer

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base32"
	"encoding/json"
	"errors"
	"maps"
	"path/filepath"
	"slices"
	"strings"
)

// A Notice is the team creator's word that a device was removed, or let back
// in. It travels in the shared folder, so a member who missed the removal hears
// of it from any teammate who has it, not only from the creator. What makes it
// the creator's is a signature by the key of the creator's sync identity, which
// a member checks against the creator's device ID.
type Notice struct {
	Folder  string `json:"folder"`
	Device  string `json:"device"`
	Removed bool   `json:"removed"`
	// At is when, in Unix nanoseconds on the creator's clock. The latest notice
	// about a device stands, so an old removal can't undo a readmission.
	At int64 `json:"at"`
}

type signedNotice struct {
	Notice      json.RawMessage `json:"notice"`
	Certificate []byte          `json:"certificate"`
	Signature   []byte          `json:"signature"`
}

var errInvalidNotice = errors.New("not a membership notice from the team creator")

// noticeContext starts every signed message, so that a signature on a notice
// can never be taken for one Syncthing makes with the same key.
const noticeContext = "commonmind-membership-notice-v1\n"

func SignNotice(syncHome string, n Notice) ([]byte, error) {
	pair, err := tls.LoadX509KeyPair(filepath.Join(syncHome, "cert.pem"), filepath.Join(syncHome, "key.pem"))
	if err != nil {
		return nil, err
	}
	signer, ok := pair.PrivateKey.(crypto.Signer)
	if !ok {
		return nil, errors.New("the sync identity's key cannot sign")
	}
	body, err := json.Marshal(n)
	if err != nil {
		return nil, err
	}
	message := append([]byte(noticeContext), body...)
	var signature []byte
	if _, pure := signer.Public().(ed25519.PublicKey); pure {
		signature, err = signer.Sign(rand.Reader, message, crypto.Hash(0))
	} else {
		digest := sha256.Sum256(message)
		signature, err = signer.Sign(rand.Reader, digest[:], crypto.SHA256)
	}
	if err != nil {
		return nil, err
	}
	return json.Marshal(signedNotice{Notice: body, Certificate: pair.Certificate[0], Signature: signature})
}

func VerifyNotice(data []byte, ownerID, folderID string) (Notice, error) {
	n, _, err := verifyNotice(data, ownerID, folderID)
	return n, err
}

// CanonicalNotice checks a notice and returns it as SignNotice wrote it. Only the
// notice inside is signed, so one can be reshaped into any number of files that
// all pass; each comes out the same here.
func CanonicalNotice(data []byte, ownerID, folderID string) ([]byte, error) {
	_, signed, err := verifyNotice(data, ownerID, folderID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(signed)
}

func verifyNotice(data []byte, ownerID, folderID string) (Notice, signedNotice, error) {
	var signed signedNotice
	if json.Unmarshal(data, &signed) != nil {
		return Notice{}, signed, errInvalidNotice
	}
	cert, err := x509.ParseCertificate(signed.Certificate)
	if err != nil || !certificateIs(cert.Raw, ownerID) {
		return Notice{}, signed, errInvalidNotice
	}
	var algorithm x509.SignatureAlgorithm
	switch cert.PublicKey.(type) {
	case ed25519.PublicKey:
		algorithm = x509.PureEd25519
	case *ecdsa.PublicKey:
		algorithm = x509.ECDSAWithSHA256
	case *rsa.PublicKey:
		algorithm = x509.SHA256WithRSA
	default:
		return Notice{}, signed, errInvalidNotice
	}
	if cert.CheckSignature(algorithm, append([]byte(noticeContext), signed.Notice...), signed.Signature) != nil {
		return Notice{}, signed, errInvalidNotice
	}
	var n Notice
	if json.Unmarshal(signed.Notice, &n) != nil || n.Folder != folderID || !deviceIDPattern.MatchString(n.Device) || n.At <= 0 {
		return Notice{}, signed, errInvalidNotice
	}
	return n, signed, nil
}

// certificateIs reports whether der is the certificate a device ID names. The
// ID is the certificate's SHA-256 in base32, with a check character after each
// 13 and a dash after each 7.
func certificateIs(der []byte, deviceID string) bool {
	id := strings.ReplaceAll(deviceID, "-", "")
	if len(id) != 56 {
		return false
	}
	var data strings.Builder
	for i := 0; i < len(id); i += 14 {
		data.WriteString(id[i : i+13])
	}
	sum := sha256.Sum256(der)
	return data.String() == base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(sum[:])
}

// CurrentNotices returns the latest of the creator's notices about each
// device, passing over anything that is not one.
func CurrentNotices(notices [][]byte, ownerID, folderID string) map[string]Notice {
	current := map[string]Notice{}
	for _, data := range notices {
		n, err := VerifyNotice(data, ownerID, folderID)
		if err == nil && n.At > current[n.Device].At {
			current[n.Device] = n
		}
	}
	return current
}

// UnseenRemovals returns the removals that stand and that this member has not
// acted on yet: seen holds the latest removal it acted on for each device. A
// notice about the member itself is not for it to act on.
func UnseenRemovals(notices [][]byte, ownerID, folderID, selfID string, seen map[string]int64) []Notice {
	var unseen []Notice
	for _, n := range CurrentNotices(notices, ownerID, folderID) {
		if n.Removed && n.Device != selfID && n.Device != ownerID && n.At > seen[n.Device] {
			unseen = append(unseen, n)
		}
	}
	slices.SortFunc(unseen, func(a, b Notice) int { return strings.Compare(a.Device, b.Device) })
	return unseen
}

// KeepNotices returns the notices a machine keeps: the latest of the creator's
// notices about each device, among those it held and those in the folder, once
// each and as SignNotice wrote it, however many reshaped copies there are. It
// also returns the kept ones the folder no longer has. Anyone who shares the
// folder can delete or change a file in it, the removed device included,
// through a teammate that still trusts it, so a kept notice that goes missing
// is put back.
func KeepNotices(held, inFolder [][]byte, ownerID, folderID string) (kept, missing [][]byte) {
	type standing struct {
		notice Notice
		signed signedNotice
	}
	latest := map[string]standing{}
	stillThere := map[string]bool{}
	for i, data := range slices.Concat(held, inFolder) {
		n, signed, err := verifyNotice(data, ownerID, folderID)
		if err != nil {
			continue
		}
		if i >= len(held) {
			stillThere[string(signed.Notice)] = true
		}
		if current, ok := latest[n.Device]; !ok || n.At > current.notice.At {
			latest[n.Device] = standing{n, signed}
		}
	}
	for _, device := range slices.Sorted(maps.Keys(latest)) {
		data, err := json.Marshal(latest[device].signed)
		if err != nil {
			continue
		}
		kept = append(kept, data)
		if !stillThere[string(latest[device].signed.Notice)] {
			missing = append(missing, data)
		}
	}
	return kept, missing
}
