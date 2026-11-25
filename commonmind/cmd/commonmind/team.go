package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/background"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/publish"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/settings"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/store"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/syncer"
	"github.com/mattn/go-isatty"
)

func setupOverrides(flags *flag.FlagSet) map[string]bool {
	provided := map[string]bool{}
	flags.Visit(func(f *flag.Flag) { provided[f.Name] = true })
	return provided
}

func savedPreferences(existing, requested settings.Settings, provided map[string]bool) settings.Settings {
	if provided["author"] {
		existing.Author = requested.Author
	}
	if provided["roots"] {
		existing.Roots = requested.Roots
	}
	if provided["exclude"] {
		existing.Exclude = requested.Exclude
	}
	return existing
}

// warnIgnoredOverrides tells the user which explicitly passed setup flags were
// dropped because this home is already joined to the team. Joining again never
// rewrites settings, so without this the saved value stays in place and nothing
// says so.
func warnIgnoredOverrides(out io.Writer, settingsPath string, existing, requested settings.Settings, provided map[string]bool) {
	for _, o := range []struct {
		flag    string
		differs bool
		current string
	}{
		{"author", requested.Author != existing.Author, fmt.Sprintf("%q", existing.Author)},
		{"roots", !slices.Equal(requested.Roots, existing.Roots), strings.Join(existing.Roots, ",")},
		{"exclude", !slices.Equal(requested.Exclude, existing.Exclude), strings.Join(existing.Exclude, ",")},
	} {
		if provided[o.flag] && o.differs {
			fmt.Fprintf(out, "Ignoring --%s: this device is already joined with %s. To change it, edit %s.\n", o.flag, o.current, settingsPath)
		}
	}
}

func initTeam(ctx context.Context, team, author string, roots, exclude []string, binary, clients string, noService bool, provided map[string]bool, out io.Writer) error {
	if !syncer.TeamNameValid(team) {
		return errors.New("team must be a nonempty name of at most 80 bytes without control characters")
	}
	if err := validateClients(clients); err != nil {
		return err
	}
	home, err := settings.Home()
	if err != nil {
		return err
	}
	s := settings.Settings{SharedDir: filepath.Join(home, "shared"), Author: author, Roots: roots, Exclude: exclude}
	ownFolder := false
	if existing, err := settings.Load(); err == nil {
		if existing.Team != "" {
			if existing.Team != team {
				return fmt.Errorf("already configured for team %q; use a separate COMMONMIND_HOME for a different team", existing.Team)
			}
			return finishSetup(ctx, clients, noService, out)
		}
		s, ownFolder = savedPreferences(existing, s, provided), true
	} else if !errors.Is(err, settings.ErrNotConfigured) {
		return err
	}
	s.Team, s.FolderID, s.Enrolled = team, syncer.NewFolderID(), true
	if err := configureTeam(ctx, home, s, binary, nil); err != nil {
		return err
	}
	if ownFolder {
		fmt.Fprintf(out, "Kept the existing folder at %q, its sessions and its saved preferences, except where a flag replaced one.\n", s.SharedDir)
	}
	fmt.Fprintf(out, "Created team %q. Background publishing shares raw transcripts from the configured roots.\n", team)
	return finishSetup(ctx, clients, noService, out)
}

func configureTeam(ctx context.Context, home string, s settings.Settings, binary string, invite *syncer.Invite) error {
	lock, err := syncer.Lock(home)
	if err != nil {
		return err
	}
	defer lock.Close()
	state, err := syncer.Prepare(ctx, home, binary)
	if err != nil {
		return err
	}
	process, err := state.Start(ctx)
	if err != nil {
		return err
	}
	defer process.Close()
	if err := store.New(s.SharedDir).Init(); err != nil {
		return err
	}
	if err := state.ConfigureFolder(ctx, s.FolderID, s.Team, s.SharedDir, state.DeviceID); err != nil {
		return err
	}
	name := s.Author
	if invite != nil {
		name = invite.ProofName(state.DeviceID, s.Author)
	}
	if err := state.Request(ctx, "PATCH", "config/devices/"+state.DeviceID, map[string]any{"name": name}, nil); err != nil {
		return err
	}
	if invite == nil {
		s.OwnerID = state.DeviceID
	} else {
		s.OwnerID = invite.OwnerID
		if s.OwnerID == state.DeviceID {
			return errors.New("cannot join your own device")
		}
		if err := state.AddDevice(ctx, s.OwnerID, s.Team+" inviter", true, nil); err != nil {
			return err
		}
		if err := state.Share(ctx, s.FolderID, s.OwnerID); err != nil {
			return err
		}
	}
	return settings.Save(s)
}

func finishSetup(ctx context.Context, clients string, noService bool, out io.Writer) error {
	if noService {
		fmt.Fprintln(out, "Configured. Run commonmind daemon in a separate terminal, or commonmind start.")
	} else if err := cmdService(ctx, "start", out); err != nil {
		return err
	}
	if err := connectClients(ctx, clients, out); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		warning := fmt.Sprintf("Warning: agent integration incomplete: %v", err)
		if terminal, ok := out.(*os.File); ok && isatty.IsTerminal(terminal.Fd()) && os.Getenv("NO_COLOR") == "" && os.Getenv("TERM") != "dumb" {
			warning = "\x1b[1;31m" + warning + "\x1b[0m"
		}
		fmt.Fprintf(out, "\n%s\nTeam setup is saved; agent integration can be retried separately.\n\n", warning)
	}
	return nil
}

func managedState() (settings.Settings, syncer.State, error) {
	s, err := settings.Load()
	if err != nil {
		return s, syncer.State{}, err
	}
	if s.Team == "" {
		return s, syncer.State{}, errors.New("managed sync is not configured; run commonmind init --team NAME")
	}
	home, err := settings.Home()
	if err != nil {
		return s, syncer.State{}, err
	}
	state, err := syncer.Load(home)
	return s, state, err
}

func cmdJoin(ctx context.Context, args []string, out io.Writer) error {
	flags := flag.NewFlagSet("join", flag.ContinueOnError)
	binary := flags.String("syncthing", "", "Syncthing binary (development override)")
	noService := flags.Bool("no-service", false, "configure without starting a background service")
	clients := flags.String("clients", "auto", "MCP clients: auto, claude, codex, claude,codex, or none")
	author := flags.String("author", settings.DefaultAuthor(), "author label")
	roots := flags.String("roots", strings.Join(settings.DefaultRoots(), ","), "session directories to publish")
	exclude := flags.String("exclude", "", "comma-separated glob patterns for directories; a session that worked in or below one is never published")
	wait := flags.Duration("wait", 5*time.Minute, "how long to wait for enrollment")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return errors.New("usage: commonmind join [options] INVITE")
	}
	if err := publish.ValidateExclude(splitCSV(*exclude)); err != nil {
		return fmt.Errorf("--exclude: %w", err)
	}
	if err := validateClients(*clients); err != nil {
		return err
	}
	i, err := syncer.ParseInvite(flags.Arg(0), time.Now())
	if err != nil {
		return err
	}
	home, err := settings.Home()
	if err != nil {
		return err
	}
	s := settings.Settings{SharedDir: filepath.Join(home, "shared"), Author: *author, Roots: splitCSV(*roots), Exclude: splitCSV(*exclude)}
	configure, ownFolder := true, false
	if existing, err := settings.Load(); err == nil {
		if existing.Team == "" {
			s, ownFolder = savedPreferences(existing, s, setupOverrides(flags)), true
		} else {
			if existing.FolderID != i.FolderID || existing.OwnerID != i.OwnerID {
				return errors.New("already configured for a different team; use a separate COMMONMIND_HOME")
			}
			configure = false
			warnIgnoredOverrides(out, filepath.Join(home, "settings.json"), existing, s, setupOverrides(flags))
		}
	} else if !errors.Is(err, settings.ErrNotConfigured) {
		return err
	}
	if configure {
		s.Team, s.FolderID, s.Enrolled = i.Team, i.FolderID, false
		if err := configureTeam(ctx, home, s, *binary, &i); err != nil {
			return err
		}
		if ownFolder {
			fmt.Fprintf(out, "Kept the existing folder at %q, its sessions and its saved preferences, except where a flag replaced one.\n", s.SharedDir)
		}
	}
	_, state, err := managedState()
	if err != nil {
		return err
	}
	existing, err := settings.Load()
	if err != nil {
		return err
	}
	if existing.Enrolled {
		fmt.Fprintf(out, "Already joined %s; team membership is preserved.\nPublishing as %q.\n", existing.Team, existing.Author)
		if err := finishSetup(ctx, *clients, *noService, out); err != nil {
			return err
		}
		// The creator passes over a device it already has. One it removed shows
		// up as pending, and this proof from the new invite lets it back in.
		return updateJoinProof(ctx, home, state, existing, i)
	}
	if !configure {
		if err := updateJoinProof(ctx, home, state, existing, i); err != nil {
			return err
		}
	}
	fmt.Fprintf(out, "Joining %q. Once joined, raw transcripts from your configured roots will be shared.\n", i.Team)
	setupErr := finishSetup(ctx, *clients, *noService, out)
	if i.RequireVerification {
		fmt.Fprintf(out, "\n============================================================\nSEND THIS VERIFICATION CODE TO YOUR INVITER\n\n    %s\n\nUse the same channel where you received the invite.\nYour inviter must approve this device before sharing starts.\n============================================================\n\n", syncer.VerificationCode(i.FolderID, i.OwnerID, state.DeviceID))
	} else {
		fmt.Fprintln(out, "Your secret invite authorizes this device automatically. No verification code is needed.")
	}
	if setupErr != nil {
		return setupErr
	}
	if *noService {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, *wait)
	defer cancel()
	if i.RequireVerification {
		fmt.Fprintln(out, "Waiting for the inviter to approve…")
	} else {
		fmt.Fprintln(out, "Waiting for the founder's machine to accept the invite…")
	}
	for {
		s, err := settings.Load()
		if err != nil {
			return err
		}
		if s.Enrolled {
			fmt.Fprintf(out, "Joined %s. Sync and publishing are running.\n", s.Team)
			return nil
		}
		if err := pause(ctx, time.Second); err != nil {
			return fmt.Errorf("enrollment still pending; background sync will keep waiting (check commonmind status): %w", err)
		}
	}
}

func updateJoinProof(ctx context.Context, home string, state syncer.State, s settings.Settings, invite syncer.Invite) error {
	if err := state.Ping(ctx); err != nil {
		lock, err := syncer.Lock(home)
		if err != nil {
			return err
		}
		defer lock.Close()
		process, err := state.Start(ctx)
		if err != nil {
			return err
		}
		defer process.Close()
	}
	name := invite.ProofName(state.DeviceID, s.Author)
	return state.Request(ctx, "PATCH", "config/devices/"+state.DeviceID, map[string]any{"name": name}, nil)
}

func cmdInvite(ctx context.Context, args []string, out io.Writer) error {
	flags := flag.NewFlagSet("invite", flag.ContinueOnError)
	noWait := flags.Bool("no-wait", false, "print invite and let the background service handle enrollment")
	require := flags.Bool("require-verification", false, "save whether this and future invites require a verification code")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("usage: commonmind invite [--require-verification[=false]] [--no-wait]")
	}
	s, state, err := managedState()
	if err != nil {
		return err
	}
	if s.OwnerID != state.DeviceID {
		return errors.New("only the team creator can issue invites in this version")
	}
	if err := state.Ping(ctx); err != nil {
		return fmt.Errorf("start managed sync before inviting: %w", err)
	}
	home, err := settings.Home()
	if err != nil {
		return err
	}
	invites := syncer.InviteStore{Home: home, FolderID: s.FolderID, OwnerID: s.OwnerID}
	var policy *bool
	if setupOverrides(flags)["require-verification"] {
		policy = require
	}
	i, err := invites.Issue(s.Team, policy, time.Now())
	if err != nil {
		return err
	}
	fmt.Fprintln(out, "Send this command privately to your teammates (reusable secret invite; valid for 24 hours):")
	fmt.Fprintf(out, "curl -fsSL https://github.com/Mint-Security/open-kitchen/releases/latest/download/install.sh | sh -s -- --join %s\n", i.Encode())
	fmt.Fprintf(out, "Already installed: commonmind join %s\n", i.Encode())
	if i.RequireVerification {
		fmt.Fprintln(out, "Verification codes are required for this and future invites. Use --require-verification=false to change the default for new invites.")
	} else {
		fmt.Fprintln(out, "Joining is automatic; no verification code is needed. Use --require-verification to require codes for new invites.")
	}
	if *noWait {
		if i.RequireVerification {
			fmt.Fprintln(out, "Run commonmind approve after they join.")
		} else {
			fmt.Fprintln(out, "Keep the founder's background service online.")
		}
		return nil
	}
	var tty *os.File
	if i.RequireVerification {
		tty, err = os.OpenFile("/dev/tty", os.O_RDWR, 0)
		if err != nil {
			return errors.New("approval needs a terminal; use invite --no-wait, then commonmind approve")
		}
		defer tty.Close()
	}
	ctx, cancel := context.WithDeadline(ctx, time.Unix(i.Expires, 0))
	defer cancel()
	fmt.Fprintln(out, "Accepting teammates until this invite expires. Keep this machine online; Ctrl-C leaves sync running. Check commonmind status for connected teammates.")
	if i.RequireVerification {
		fmt.Fprintln(out, "Wait for the device prompt before entering your teammate's verification code.")
	}
	for {
		pending, err := state.Pending(ctx)
		if err != nil {
			return err
		}
		if i.RequireVerification {
			if err := approveDevices(ctx, home, state.Client, s, pending, tty, out); err != nil {
				return err
			}
		} else if err := acceptInvited(ctx, s, invites, state.Client, pending, out); err != nil {
			return err
		}
		if err := pause(ctx, 2*time.Second); err != nil {
			return err
		}
	}
}

func cmdApprove(ctx context.Context, out io.Writer) error {
	s, state, err := managedState()
	if err != nil {
		return err
	}
	if s.OwnerID != state.DeviceID {
		return errors.New("only the team creator can approve new devices")
	}
	pending, err := state.Pending(ctx)
	if err != nil {
		return err
	}
	home, err := settings.Home()
	if err != nil {
		return err
	}
	invites := syncer.InviteStore{Home: home, FolderID: s.FolderID, OwnerID: s.OwnerID}
	if err := acceptInvited(ctx, s, invites, state.Client, pending, out); err != nil {
		return err
	}
	for id, device := range pending {
		request, err := invites.Inspect(id, device.Name, time.Now())
		if errors.Is(err, syncer.ErrInvalidInviteProof) || (err == nil && !request.RequireVerification) {
			delete(pending, id)
		} else if err != nil {
			return err
		}
	}
	if len(pending) == 0 {
		fmt.Fprintln(out, "No pending join requests require verification.")
		return nil
	}
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return errors.New("approval needs an interactive terminal")
	}
	defer tty.Close()
	return approveDevices(ctx, home, state.Client, s, pending, tty, out)
}

func acceptInvited(ctx context.Context, s settings.Settings, invites syncer.InviteStore, client syncer.Client, pending map[string]syncer.Pending, out io.Writer) error {
	joined, err := invites.Process(ctx, client, pending, time.Now())
	for _, j := range joined {
		fmt.Fprintf(out, "Accepted %s using its secret invite.\n", displayName(j.Name))
		if announceErr := announce(invites.Home, s, j.DeviceID, false); announceErr != nil {
			return announceErr
		}
	}
	return err
}

func approveDevices(ctx context.Context, home string, client syncer.Client, s settings.Settings, pending map[string]syncer.Pending, input io.Reader, out io.Writer) error {
	ids := make([]string, 0, len(pending))
	for id := range pending {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	reader := bufio.NewReader(input)
	for _, id := range ids {
		invites := syncer.InviteStore{Home: home, FolderID: s.FolderID, OwnerID: s.OwnerID}
		// Anyone who knows the creator's device ID can show up as pending. Only a
		// device that proves it holds an invite is this command's business.
		request, err := invites.Inspect(id, pending[id].Name, time.Now())
		if errors.Is(err, syncer.ErrInvalidInviteProof) {
			continue
		}
		if err != nil {
			return err
		}
		name := request.Name
		if !request.RequireVerification {
			if _, err := invites.Accept(ctx, client, id, pending[id].Name, "", time.Now()); err != nil {
				return err
			}
			fmt.Fprintf(out, "Accepted %q using its secret invite.\n", name)
			if err := announce(home, s, id, false); err != nil {
				return err
			}
			continue
		}
		code := syncer.VerificationCode(s.FolderID, s.OwnerID, id)
		fmt.Fprintf(out, "Device %q requests access to %q.\nAsk your teammate for their verification code and type it here (blank skips): ", name, s.Team)
		answer, err := reader.ReadString('\n')
		if err != nil {
			return err
		}
		answer = strings.TrimSpace(answer)
		if answer == "" {
			continue
		}
		if answer != code {
			return errors.New("verification code does not match; device was not authorized")
		}
		if _, err := invites.Accept(ctx, client, id, pending[id].Name, answer, time.Now()); err != nil {
			return err
		}
		fmt.Fprintf(out, "Approved %q. Existing teammates will learn this device automatically.\n", name)
		if err := announce(home, s, id, false); err != nil {
			return err
		}
	}
	return nil
}

func cmdService(ctx context.Context, action string, out io.Writer) error {
	_, state, err := managedState()
	if err != nil {
		return err
	}
	home, err := settings.Home()
	if err != nil {
		return err
	}
	if action == "stop" {
		if err := background.Stop(home); err != nil {
			return err
		}
		fmt.Fprintln(out, "Background sync and publishing stopped. Session files and settings are preserved.")
		return nil
	}
	exe, err := background.Executable()
	if err != nil {
		return err
	}
	if err := background.Install(exe, home); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	for {
		if err := state.Ping(ctx); err == nil {
			fmt.Fprintln(out, "Background sync and publishing are running and will start at login.")
			return nil
		}
		if err := pause(ctx, time.Second); err != nil {
			return fmt.Errorf("service did not become ready; check daemon.log: %w", err)
		}
	}
}

func pause(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
