package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/Mint-Security/open-kitchen/commonmind/internal/settings"
)

func validateClients(selection string) error {
	if selection == "auto" || selection == "none" {
		return nil
	}
	if len(splitCSV(selection)) == 0 {
		return errors.New("choose clients: auto, none, claude, codex, or claude,codex")
	}
	for _, name := range splitCSV(selection) {
		if name != "claude" && name != "codex" {
			return fmt.Errorf("unknown MCP client %q", name)
		}
	}
	return nil
}

func cmdConnect(ctx context.Context, args []string, out io.Writer) error {
	selection := "auto"
	if len(args) > 1 {
		return errors.New("usage: commonmind connect [auto|none|claude|codex|claude,codex]")
	}
	if len(args) == 1 {
		selection = args[0]
	}
	return connectClients(ctx, selection, out)
}

func connectClients(ctx context.Context, selection string, out io.Writer) error {
	if err := validateClients(selection); err != nil {
		return err
	}
	if selection == "none" {
		return nil
	}
	if _, err := settings.Load(); err != nil {
		return err
	}
	home, err := settings.Home()
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	names := splitCSV(selection)
	if selection == "auto" {
		names = []string{"claude", "codex"}
	}
	var failures []error
	for _, name := range names {
		clientCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		binary, err := resolveClient(clientCtx, name)
		if err != nil {
			cancel()
			if selection == "auto" && errors.Is(err, exec.ErrNotFound) {
				continue
			}
			failures = append(failures, fmt.Errorf("%s CLI unavailable: %w; install or repair its CLI, then run commonmind connect %s", name, err, name))
			continue
		}
		if clientCommand(clientCtx, binary, "mcp", "get", "commonmind").Run() == nil {
			cancel()
			fmt.Fprintf(out, "%s already has a commonmind server; existing configuration preserved. Inspect with: %s mcp get commonmind\n", name, name)
			continue
		}
		args := []string{"mcp", "add", "commonmind"}
		if name == "claude" {
			args = append(args, "--scope", "user")
		}
		args = append(args, "--env", "COMMONMIND_HOME="+home, "--", exe, "mcp")
		output, err := clientCommand(clientCtx, binary, args...).CombinedOutput()
		cancel()
		if err != nil {
			failures = append(failures, fmt.Errorf("register %s MCP: %w: %s; retry with commonmind connect %s", name, err, strings.TrimSpace(string(output)), name))
			continue
		}
		fmt.Fprintf(out, "Connected %s. Restart its session to load Commonmind.\n", name)
	}
	return errors.Join(failures...)
}

func clientCommand(ctx context.Context, binary string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.WaitDelay = time.Second
	return cmd
}

func resolveClient(ctx context.Context, name string) (string, error) {
	var failures []error
	seen := map[string]bool{}
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		if !filepath.IsAbs(dir) {
			continue
		}
		candidate := filepath.Join(dir, name)
		if seen[candidate] {
			continue
		}
		seen[candidate] = true
		if _, err := exec.LookPath(candidate); err != nil {
			continue
		}
		// Terminal shims can exist even when the CLI they wrap is missing.
		probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		output, err := clientCommand(probeCtx, candidate, "--version").CombinedOutput()
		cancel()
		if err == nil {
			return candidate, nil
		}
		failures = append(failures, fmt.Errorf("%s: %w: %s", candidate, err, strings.TrimSpace(string(output))))
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
	}
	if len(failures) == 0 {
		return "", exec.ErrNotFound
	}
	return "", errors.Join(failures...)
}
