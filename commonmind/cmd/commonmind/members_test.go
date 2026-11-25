package main

import (
	"strings"
	"testing"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/syncer"
)

func memberID(letter string) string {
	return strings.Repeat(strings.Repeat(letter, 7)+"-", 7) + strings.Repeat(letter, 7)
}

func TestFindMemberByNameOrDeviceID(t *testing.T) {
	members := []syncer.Member{
		{DeviceID: memberID("A"), Name: "dana@example.invalid"},
		{DeviceID: memberID("B"), Name: "sam@example.invalid"},
		{DeviceID: memberID("C"), Name: "sam@example.invalid"},
	}
	for query, want := range map[string]string{
		"Dana@Example.invalid":         memberID("A"),
		"BBBBBBB":                      memberID("B"),
		"ccccccc-ccccccc":              memberID("C"),
		strings.ToLower(memberID("C")): memberID("C"),
	} {
		got, err := findMember(members, query)
		if err != nil || got.DeviceID != want {
			t.Errorf("findMember(%q) = %s, %v; want %s", query, got.DeviceID, err, want)
		}
	}
	for query, why := range map[string]string{
		"sam@example.invalid": "more than one",
		"lee@example.invalid": "no device",
		"AAA":                 "no device",
		"":                    "no device",
	} {
		if _, err := findMember(members, query); err == nil || !strings.Contains(err.Error(), why) {
			t.Errorf("findMember(%q) = %v; want an error saying %q", query, err, why)
		}
	}
}

// A joiner chooses its own name, so a name must never make remove pick another
// device without saying so, or leave a device nothing can pick.
func TestFindMemberCannotBeSteeredByAJoinersName(t *testing.T) {
	lee, impostor := memberID("B"), memberID("C")
	for _, disguise := range []string{
		"lee@example.invalid ", " LEE@example.invalid", "lee@example.invalid\u3164", "lee@example.invalid\u200b", "lee@example.invalid\u2800", "l\u0435\u0435@ex\u0430mple.invalid",
		"lee@example.invalid\u034f", "l\u200bee@example.invalid", "lee@example.invalid\ufe00", "\u217cee@example.invalid", "Iee@example.invalid", "lee@ex\u0251mple.invalid",
	} {
		members := []syncer.Member{{DeviceID: lee, Name: "lee@example.invalid"}, {DeviceID: impostor, Name: disguise}}
		for _, query := range []string{"lee@example.invalid", disguise} {
			_, err := findMember(members, query)
			if err == nil || !strings.Contains(err.Error(), lee) || !strings.Contains(err.Error(), impostor) {
				t.Errorf("findMember(%q) beside %q = %v; want an ambiguity error listing both full device IDs", query, disguise, err)
			}
		}
		if got, err := findMember(members, impostor); err != nil || got.DeviceID != impostor {
			t.Errorf("the impostor's full device ID did not pick it: %v", err)
		}
	}

	// Each named after the start of the other's device ID.
	x1, x2 := memberID("D"), memberID("E")
	members := []syncer.Member{{DeviceID: x1, Name: shortID(x2)}, {DeviceID: x2, Name: shortID(x1)}}
	for _, query := range []string{shortID(x1), shortID(x2)} {
		if _, err := findMember(members, query); err == nil || !strings.Contains(err.Error(), x1) || !strings.Contains(err.Error(), x2) {
			t.Errorf("findMember(%q) = %v; want an ambiguity error listing both full device IDs", query, err)
		}
	}
	for _, id := range []string{x1, x2} {
		if got, err := findMember(members, id); err != nil || got.DeviceID != id {
			t.Errorf("the full device ID %s did not pick its device: %v", id, err)
		}
	}

	// Named with another member's whole device ID, or one that passes for it.
	for _, disguise := range []string{strings.ToLower(lee), "\u0412" + lee[1:]} {
		members = []syncer.Member{{DeviceID: lee, Name: "lee@example.invalid"}, {DeviceID: impostor, Name: disguise}}
		for _, id := range []string{lee, impostor} {
			if got, err := findMember(members, id); err != nil || got.DeviceID != id {
				t.Errorf("beside a device named %+q, the full device ID %s did not pick its device: %v", disguise, id, err)
			}
		}
	}
}

func TestMemberStatus(t *testing.T) {
	now := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	self, creator := memberID("A"), memberID("B")
	for _, c := range []struct {
		member syncer.Member
		want   string
	}{
		{syncer.Member{DeviceID: self, Connected: false}, "this device"},
		{syncer.Member{DeviceID: creator, Connected: true}, "team creator, connected"},
		{syncer.Member{DeviceID: memberID("C"), LastSeen: now.Add(-3 * time.Hour)}, "last seen 3h ago"},
		{syncer.Member{DeviceID: memberID("C"), LastSeen: now.Add(-50 * time.Hour)}, "last seen 2d ago"},
		{syncer.Member{DeviceID: memberID("C"), LastSeen: now.Add(-20 * time.Second)}, "last seen just now"},
		{syncer.Member{DeviceID: memberID("C")}, "never connected"},
	} {
		if got := memberStatus(c.member, self, creator, now); got != c.want {
			t.Errorf("memberStatus(%+v) = %q; want %q", c.member, got, c.want)
		}
	}
}

func TestMemberNamesCannotWriteToTheTerminal(t *testing.T) {
	if got := displayName("dana@example.invalid"); got != "dana@example.invalid" {
		t.Fatalf("displayName changed a plain name: %q", got)
	}
	if got := displayName("sam\x1b[2J"); strings.ContainsRune(got, 0x1b) {
		t.Fatalf("displayName let an escape sequence through: %q", got)
	}
	if got := displayName(""); got == "" {
		t.Fatal("displayName left an empty name blank")
	}
}
