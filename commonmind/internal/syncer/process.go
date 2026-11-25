package syncer

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type State struct {
	Client
	DeviceID string
	Binary   string
	Home     string
}

func Load(home string) (State, error) {
	var s State
	data, err := os.ReadFile(filepath.Join(home, "sync.json"))
	if err != nil {
		return s, err
	}
	err = json.Unmarshal(data, &s)
	return s, err
}

func Prepare(ctx context.Context, home, binary string) (State, error) {
	if s, err := Load(home); err == nil {
		return s, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return State{}, err
	}
	if binary == "" {
		exe, err := os.Executable()
		if err != nil {
			return State{}, err
		}
		binary = filepath.Join(filepath.Dir(exe), "syncthing")
	}
	binary, err := filepath.Abs(binary)
	if err != nil {
		return State{}, err
	}
	if _, err := os.Stat(binary); err != nil {
		return State{}, fmt.Errorf("managed Syncthing is missing; use the release installer or --syncthing /path/to/syncthing: %w", err)
	}
	syncHome := filepath.Join(home, "syncthing")
	if err := os.MkdirAll(syncHome, 0o700); err != nil {
		return State{}, err
	}
	// Left to probe, generate writes fixed listeners when port 22000 is taken,
	// and the rewrite below would find no default to replace.
	if output, err := exec.CommandContext(ctx, binary, "generate", "--home", syncHome, "--no-port-probing").CombinedOutput(); err != nil {
		return State{}, fmt.Errorf("generate sync identity: %w: %s", err, output)
	}
	configPath := filepath.Join(syncHome, "config.xml")
	data, err := os.ReadFile(configPath)
	if err != nil {
		return State{}, err
	}
	var cfg struct {
		Devices []struct {
			ID string `xml:"id,attr"`
		} `xml:"device"`
		GUI struct {
			APIKey string `xml:"apikey"`
		} `xml:"gui"`
	}
	if err := xml.Unmarshal(data, &cfg); err != nil {
		return State{}, err
	}
	if len(cfg.Devices) == 0 || cfg.GUI.APIKey == "" {
		return State{}, errors.New("generated sync config has no identity or API key")
	}
	// A separate listener avoids taking over an existing personal Syncthing instance.
	// Each setting is rewritten by its exact text, so a config that has it in
	// neither form stops setup: going ahead would run Syncthing's own defaults.
	config := string(data)
	for _, setting := range [][2]string{
		{"<listenAddress>default</listenAddress>", "<listenAddress>tcp://0.0.0.0:0</listenAddress><listenAddress>quic://0.0.0.0:0</listenAddress><listenAddress>dynamic+https://relays.syncthing.net/endpoint</listenAddress>"},
		{"<crashReportingEnabled>true</crashReportingEnabled>", "<crashReportingEnabled>false</crashReportingEnabled>"},
		{"<urAccepted>0</urAccepted>", "<urAccepted>-1</urAccepted>"},
	} {
		if !strings.Contains(config, setting[0]) && !strings.Contains(config, setting[1]) {
			return State{}, fmt.Errorf("generated sync config has no %s to rewrite", setting[0])
		}
		config = strings.Replace(config, setting[0], setting[1], 1)
	}
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		return State{}, err
	}
	address, err := freeLoopbackAddress()
	if err != nil {
		return State{}, err
	}
	s := State{Client: Client{Address: address, APIKey: cfg.GUI.APIKey}, DeviceID: cfg.Devices[0].ID, Binary: binary, Home: syncHome}
	if err := s.save(); err != nil {
		return State{}, err
	}
	return s, nil
}

func freeLoopbackAddress() (string, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	defer listener.Close()
	return listener.Addr().String(), nil
}

// save writes the state to sync.json beside the sync home, where Load reads it.
func (s State) save() error {
	encoded, err := json.Marshal(s)
	if err != nil {
		return err
	}
	home := filepath.Dir(s.Home)
	file, err := os.CreateTemp(home, ".sync-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(encoded); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), filepath.Join(home, "sync.json"))
}

// useFreeAddress keeps the saved API address if it can still be bound, and
// otherwise moves to a free one and saves it. The address was chosen when this
// home was set up, from the ephemeral range, so after a reboot any program may
// be listening on it. Without this the managed Syncthing could not start, and
// every ping would offer the API key to whatever took the port.
func (s *State) useFreeAddress() error {
	if listener, err := net.Listen("tcp", s.Address); err == nil {
		return listener.Close()
	}
	address, err := freeLoopbackAddress()
	if err != nil {
		return err
	}
	s.Address = address
	return s.save()
}

// requireGUIPassword gives the sync home a GUI password if it has none. Without
// one, Syncthing hands any local process a token that works in place of the API
// key. Nobody signs in to this GUI, so the password is not kept.
func (s State) requireGUIPassword(ctx context.Context) error {
	data, err := os.ReadFile(filepath.Join(s.Home, "config.xml"))
	if err != nil {
		return err
	}
	var cfg struct {
		GUI struct {
			Password string `xml:"password"`
		} `xml:"gui"`
	}
	if err := xml.Unmarshal(data, &cfg); err != nil {
		return err
	}
	if cfg.GUI.Password != "" {
		return nil
	}
	var password [32]byte
	_, _ = rand.Read(password[:])
	cmd := exec.CommandContext(ctx, s.Binary, "generate", "--home", s.Home, "--no-port-probing", "--gui-user", "commonmind", "--gui-password", "-")
	cmd.Stdin = strings.NewReader(hex.EncodeToString(password[:]) + "\n")
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("protect sync API: %w: %s", err, output)
	}
	return nil
}

type Process struct {
	cmd  *exec.Cmd
	done chan error
}

// stopGrace is how long Syncthing gets to stop before it is killed. With a
// teammate connected it takes about ten seconds, and killed sooner it leaves
// its child process still shutting down with the home's lock held, so the
// next start fails.
const stopGrace = 20 * time.Second

// Start runs the managed Syncthing. The caller holds the sync lock, so nothing of
// ours is listening on the API address yet.
func (s *State) Start(ctx context.Context) (*Process, error) {
	if err := s.requireGUIPassword(ctx); err != nil {
		return nil, err
	}
	if err := s.useFreeAddress(); err != nil {
		return nil, fmt.Errorf("choose sync API address: %w", err)
	}
	cmd := exec.CommandContext(ctx, s.Binary, "serve", "--home", s.Home, "--no-browser", "--no-upgrade", "--no-restart", "--gui-address", s.Address, "--log-file", filepath.Join(s.Home, "syncthing.log"), "--log-max-size", "1048576", "--log-max-old-files", "2")
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = stopGrace
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &Process{cmd: cmd, done: make(chan error, 1)}
	go func() { p.done <- cmd.Wait(); close(p.done) }()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case err := <-p.done:
			return nil, fmt.Errorf("sync exited during startup: %v (see %s)", err, filepath.Join(s.Home, "syncthing.log"))
		case <-ctx.Done():
			p.Close()
			return nil, ctx.Err()
		case <-deadline.C:
			p.Close()
			return nil, errors.New("sync startup timed out; see syncthing/syncthing.log")
		case <-ticker.C:
			if err := s.Ping(ctx); err == nil {
				return p, nil
			}
		}
	}
}

func (p *Process) Close() {
	_ = p.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-p.done:
	case <-time.After(stopGrace):
		_ = p.cmd.Process.Kill()
		<-p.done
	}
}

func (p *Process) Done() <-chan error { return p.done }

func Lock(home string) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(home, "sync.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("managed sync is already running or being configured")
	}
	return f, nil
}
