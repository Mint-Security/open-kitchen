package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/ledger"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/mcpserver"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/publish"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/scan"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/settings"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/store"
	"github.com/Mint-Security/open-kitchen/commonmind/internal/syncer"
)

var version = "dev"

// defaultSince mirrors flush's own flag default so status reports the same
// candidate count flush would act on.
const defaultSince = "14d"

// The one database in the commonmind home. published.db records what this
// machine published; it is not a search index, and it cannot be recovered
// from the shared folder, because it is precisely the difference between
// "we never published this" and "we published it and somebody deleted it".
const ledgerFile = "published.db"

func run(ctx context.Context, args []string, out io.Writer) error {
	if len(args) == 0 {
		return usage(out)
	}
	switch args[0] {
	case "init":
		return cmdInitContext(ctx, args[1:], out)
	case "join":
		return cmdJoin(ctx, args[1:], out)
	case "invite":
		return cmdInvite(ctx, args[1:], out)
	case "approve":
		return cmdApprove(ctx, out)
	case "members":
		return cmdMembers(ctx, out)
	case "remove":
		return cmdRemove(ctx, args[1:], out)
	case "daemon":
		return cmdDaemon(ctx, out)
	case "start", "stop":
		return cmdService(ctx, args[0], out)
	case "connect":
		return cmdConnect(ctx, args[1:], out)
	case "flush":
		return cmdFlush(ctx, args[1:], out)
	case "mcp":
		return cmdMCP(ctx)
	case "status":
		return cmdStatus(ctx, out)
	case "version":
		fmt.Fprintln(out, version)
		return nil
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func usage(out io.Writer) error {
	fmt.Fprintln(out, "commonmind init|join|invite|approve|members|remove|start|stop|daemon|connect|flush|mcp|status|version")
	return nil
}

// splitCSV turns a comma-separated flag value into a trimmed slice, treating
// an empty (or whitespace-only) value as "nothing set" rather than a
// one-element slice holding "".
func splitCSV(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	var out []string
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func cmdInit(args []string, out io.Writer) error {
	return cmdInitContext(context.Background(), args, out)
}

func cmdInitContext(ctx context.Context, args []string, out io.Writer) error {
	flags := flag.NewFlagSet("init", flag.ContinueOnError)
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolve home directory: %w", err)
	}
	shared := flags.String("shared", filepath.Join(home, "CommonMind"), "shared session directory")
	author := flags.String("author", settings.DefaultAuthor(), "author id recorded in published files")
	roots := flags.String("roots", strings.Join(settings.DefaultRoots(), ","), "comma-separated directories to scan for agent sessions")
	exclude := flags.String("exclude", "", "comma-separated glob patterns for directories; a session that worked in or below one is never published")
	team := flags.String("team", "", "create a team with managed background sync")
	binary := flags.String("syncthing", "", "Syncthing binary (development override)")
	noService := flags.Bool("no-service", false, "configure without starting a background service")
	clients := flags.String("clients", "auto", "MCP clients: auto, claude, codex, claude,codex, or none")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if err := publish.ValidateExclude(splitCSV(*exclude)); err != nil {
		return fmt.Errorf("--exclude: %w", err)
	}
	if *team != "" {
		provided := setupOverrides(flags)
		if provided["shared"] {
			return fmt.Errorf("choose --team for managed sync or --shared for an existing shared folder")
		}
		return initTeam(ctx, *team, *author, splitCSV(*roots), splitCSV(*exclude), *binary, *clients, *noService, provided, out)
	}
	absolute, err := filepath.Abs(*shared)
	if err != nil {
		return fmt.Errorf("resolve shared directory: %w", err)
	}
	s := settings.Settings{SharedDir: absolute, Author: *author, Roots: splitCSV(*roots), Exclude: splitCSV(*exclude)}
	// Running init again changes what its flags name and keeps the rest. A
	// flag's default must never replace a saved choice, least of all a saved
	// exclusion. Settings that cannot be loaded are replaced whole: init is
	// also how a broken settings file gets repaired.
	if existing, err := settings.Load(); err == nil {
		if existing.Team != "" {
			return fmt.Errorf("this home already belongs to team %q; use a separate COMMONMIND_HOME for shared-folder mode", existing.Team)
		}
		provided := setupOverrides(flags)
		if !provided["shared"] {
			s.SharedDir = existing.SharedDir
		}
		if !provided["author"] {
			s.Author = existing.Author
		}
		if !provided["roots"] {
			s.Roots = existing.Roots
		}
		if !provided["exclude"] {
			s.Exclude = existing.Exclude
		}
	}
	// init is the only command that creates the shared folder: every other
	// path treats a missing sessions directory as "the share is not there".
	if err := store.New(s.SharedDir).Init(); err != nil {
		return err
	}
	if err := settings.Save(s); err != nil {
		return err
	}
	fmt.Fprintf(out, "shared dir: %s\nauthor: %s\n", s.SharedDir, s.Author)
	return nil
}

func cmdFlush(ctx context.Context, args []string, out io.Writer) error {
	flags := flag.NewFlagSet("flush", flag.ContinueOnError)
	since := flags.String("since", defaultSince, "how far back to scan for sessions, e.g. 14d")
	if err := flags.Parse(args); err != nil {
		return err
	}
	sinceDur, err := scan.ParseWindow(*since)
	if err != nil {
		return fmt.Errorf("--since: %w", err)
	}

	s, err := settings.Load()
	if err != nil {
		return err
	}
	if s.Team != "" && !s.Enrolled {
		return fmt.Errorf("waiting for team enrollment; no transcripts have been published")
	}
	home, err := settings.Home()
	if err != nil {
		return err
	}

	led, err := ledger.Open(filepath.Join(home, ledgerFile))
	if err != nil {
		return err
	}
	defer led.Close()

	published, skippedEmpty, skippedDeleted, publishErr := publish.Run(ctx, store.New(s.SharedDir), led, s.Author, publish.Options{
		Roots:   s.Roots,
		Since:   sinceDur,
		Exclude: s.Exclude,
	})

	fmt.Fprintf(out, "published %d, skipped-empty %d, skipped-deleted %d\n", published, skippedEmpty, skippedDeleted)
	return publishErr
}

func cmdMCP(ctx context.Context) error {
	s, err := settings.Load()
	if err != nil {
		return err
	}
	// Every query reads the shared folder, so a teammate's file is
	// answerable as soon as it lands: there is nothing to refresh first.
	server := mcpserver.New(store.New(s.SharedDir))
	server.Version = version
	err = server.Serve(ctx, os.Stdin, os.Stdout)
	// SIGINT and SIGTERM cancel ctx: being told to stop is not a failure.
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func cmdStatus(ctx context.Context, out io.Writer) error {
	s, err := settings.Load()
	if err != nil {
		return err
	}
	home, err := settings.Home()
	if err != nil {
		return err
	}
	shared := store.New(s.SharedDir)
	sessions, err := shared.Count()
	if err != nil {
		return err
	}
	authors, err := shared.AuthorDirs()
	if err != nil {
		authors = 0
	}
	writable := "no"
	// The probe has a fixed name in a folder teammates can write. Creating it
	// anew never follows a link one of them left there.
	probe := filepath.Join(s.SharedDir, ".commonmind-write-probe")
	_ = os.Remove(probe)
	if file, probeErr := os.OpenFile(probe, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600); probeErr == nil {
		file.Close()
		writable = "yes"
		defer os.Remove(probe)
	}

	roots := s.Roots
	sinceDur, _ := scan.ParseWindow(defaultSince)
	candidates, err := scan.List(roots, time.Now().UTC().Add(-sinceDur))
	if err != nil {
		candidates = nil
	}

	led, err := ledger.Open(filepath.Join(home, ledgerFile))
	if err != nil {
		return err
	}
	defer led.Close()
	skippedEmpty := publish.PreviewSkippedEmpty(led, candidates)

	fmt.Fprintf(out, "shared dir: %s\n", s.SharedDir)
	fmt.Fprintf(out, "writable: %s\n", writable)
	fmt.Fprintf(out, "roots: %s\n", strings.Join(roots, ", "))
	fmt.Fprintf(out, "candidate sessions found: %d\n", len(candidates))
	fmt.Fprintf(out, "  of which yield no usable records (skipped): %d\n", skippedEmpty)
	fmt.Fprintf(out, "sessions in the shared folder: %d\n", sessions)
	fmt.Fprintf(out, "authors visible: %d\n", authors)
	if s.Team != "" {
		fmt.Fprintf(out, "team: %s\nenrolled: %t\n", s.Team, s.Enrolled)
		state, loadErr := syncer.Load(home)
		if loadErr != nil {
			return loadErr
		}
		summary, syncErr := state.Summary(ctx, s.FolderID)
		if syncErr != nil {
			fmt.Fprintln(out, "sync: unavailable (run commonmind start; check daemon.log)")
		} else {
			fmt.Fprintf(out, "sync: %s\n", summary)
		}
		var report struct {
			LastAttempt time.Time `json:"last_attempt"`
			Error       string    `json:"error"`
		}
		if data, err := os.ReadFile(filepath.Join(home, "publish-status.json")); err == nil && json.Unmarshal(data, &report) == nil {
			fmt.Fprintf(out, "last publish attempt: %s\n", report.LastAttempt.Format(time.RFC3339))
			if report.Error != "" {
				fmt.Fprintf(out, "publish error: %s\n", report.Error)
			}
		}
	}
	return nil
}

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "commonmind:", err)
		os.Exit(1)
	}
}
