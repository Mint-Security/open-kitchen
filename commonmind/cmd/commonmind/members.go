package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
	"unicode"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/names"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/settings"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/store"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/syncer"
)

func cmdMembers(ctx context.Context, out io.Writer) error {
	s, state, err := managedState()
	if err != nil {
		return err
	}
	if err := state.Ping(ctx); err != nil {
		return fmt.Errorf("start managed sync to list the team: %w", err)
	}
	members, err := state.Members(ctx, s.FolderID)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "%s: %d devices\n", displayName(s.Team), len(members))
	table := tabwriter.NewWriter(out, 0, 0, 3, ' ', 0)
	now := time.Now()
	for _, m := range members {
		if m.DeviceID == state.DeviceID {
			m.Name = s.Author
		}
		fmt.Fprintf(table, "  %s\t%s\t%s\n", displayName(m.Name), shortID(m.DeviceID), memberStatus(m, state.DeviceID, s.OwnerID, now))
	}
	return table.Flush()
}

func cmdRemove(ctx context.Context, args []string, out io.Writer) error {
	if len(args) != 1 {
		return errors.New("usage: commonmind remove NAME|DEVICE-ID")
	}
	s, state, err := managedState()
	if err != nil {
		return err
	}
	if s.OwnerID != state.DeviceID {
		return errors.New("only the team creator can remove a device")
	}
	if err := state.Ping(ctx); err != nil {
		return fmt.Errorf("start managed sync before removing a device: %w", err)
	}
	members, err := state.Members(ctx, s.FolderID)
	if err != nil {
		return err
	}
	member, err := findMember(members, args[0])
	if err != nil {
		return err
	}
	home, err := settings.Home()
	if err != nil {
		return err
	}
	invites := syncer.InviteStore{Home: home, FolderID: s.FolderID, OwnerID: s.OwnerID}
	cancelled, err := invites.Remove(ctx, state.Client, member.DeviceID, time.Now())
	if err != nil {
		return err
	}
	if err := announce(home, s, member.DeviceID, true); err != nil {
		return fmt.Errorf("removed %s, but teammates will hear of it only from this machine: %w", displayName(member.Name), err)
	}
	fmt.Fprintf(out, "Removed %s (%s). Teammates drop it the next time they connect to this machine.\n", displayName(member.Name), shortID(member.DeviceID))
	fmt.Fprintln(out, "It keeps the sessions it already has, and the ones it published stay in the team's history.")
	switch cancelled {
	case 0:
	case 1:
		fmt.Fprintln(out, "Cancelled the open invite, since a removed teammate could use it to come back. Run commonmind invite for a new one.")
	default:
		fmt.Fprintf(out, "Cancelled %d open invites, since a removed teammate could use one to come back. Run commonmind invite for new ones.\n", cancelled)
	}
	return nil
}

// announce leaves the creator's signed notice that a device is out of the
// team, or back in. A device let in that was never removed needs no notice.
// The creator's daemon keeps a copy of each notice, which counts too: the
// folder can lose one.
func announce(home string, s settings.Settings, deviceID string, removed bool) error {
	shared := store.New(s.SharedDir)
	notices, err := shared.Notices()
	if err != nil {
		return err
	}
	var held [][]byte
	if err := readState(filepath.Join(home, "notices.json"), &held); err != nil {
		return err
	}
	notices = append(notices, held...)
	current, known := syncer.CurrentNotices(notices, s.OwnerID, s.FolderID)[deviceID]
	if !removed && (!known || !current.Removed) {
		return nil
	}
	state, err := syncer.Load(home)
	if err != nil {
		return err
	}
	notice, err := syncer.SignNotice(state.Home, syncer.Notice{Folder: s.FolderID, Device: deviceID, Removed: removed, At: max(time.Now().UnixNano(), current.At+1)})
	if err != nil {
		return err
	}
	return shared.WriteNotice(notice)
}

// findMember picks the one device a name or device ID means: a device ID, or
// the start of one as members shows it, or a name. Names are the teammates' own
// choice: two devices can share one, or have names that only look alike, or a
// name that looks like a device ID. A query that could mean more than one device
// is refused, and the error lists each one's full device ID, which always picks
// its device.
func findMember(members []syncer.Member, query string) (syncer.Member, error) {
	id := strings.ToUpper(strings.TrimSpace(query))
	var matches []syncer.Member
	for _, m := range members {
		if m.DeviceID == id {
			return m, nil
		}
		if len(id) >= 7 && strings.HasPrefix(m.DeviceID, id) || names.Same(m.Name, query) {
			matches = append(matches, m)
		}
	}
	switch len(matches) {
	case 0:
		return syncer.Member{}, fmt.Errorf("no device %s in this team; commonmind members lists them", strconv.Quote(query))
	case 1:
		return matches[0], nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s could mean more than one device:", strconv.QuoteToASCII(query))
	for _, m := range matches {
		fmt.Fprintf(&b, "\n  %s  %s", strconv.QuoteToASCII(m.Name), m.DeviceID)
	}
	b.WriteString("\nRun it again with the full device ID of the one you mean.")
	return syncer.Member{}, errors.New(b.String())
}

func memberStatus(m syncer.Member, self, creator string, now time.Time) string {
	var status string
	switch {
	case m.DeviceID == self:
		status = "this device"
	case m.Connected:
		status = "connected"
	case m.LastSeen.IsZero():
		status = "never connected"
	default:
		status = "last seen " + ago(now.Sub(m.LastSeen))
	}
	if m.DeviceID == creator && m.DeviceID != self {
		return "team creator, " + status
	}
	return status
}

func ago(d time.Duration) string {
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

// displayName shows a name a teammate chose. It is quoted when it holds
// anything a terminal would act on rather than print.
func displayName(name string) string {
	if name == "" || strings.IndexFunc(name, func(r rune) bool { return !unicode.IsPrint(r) }) >= 0 {
		return strconv.Quote(name)
	}
	return name
}

func shortID(id string) string {
	if len(id) < 7 {
		return id
	}
	return id[:7]
}
