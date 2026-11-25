package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
)

type Settings struct {
	SharedDir string   `json:"shared_dir"`
	Author    string   `json:"author"`
	Roots     []string `json:"roots,omitempty"`
	Exclude   []string `json:"exclude,omitempty"`
	Team      string   `json:"team,omitempty"`
	FolderID  string   `json:"folder_id,omitempty"`
	OwnerID   string   `json:"owner_id,omitempty"`
	Enrolled  bool     `json:"enrolled,omitempty"`
}

var ErrNotConfigured = errors.New("commonmind is not configured; run: commonmind init")

func Home() (string, error) {
	home := strings.TrimSpace(os.Getenv("COMMONMIND_HOME"))
	if home == "" {
		base, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home directory: %w", err)
		}
		home = filepath.Join(base, ".commonmind")
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return "", fmt.Errorf("create commonmind home: %w", err)
	}
	// MkdirAll's mode applies only to directories it creates, so a home
	// that already exists with looser permissions would keep them. The
	// directory holds the ledger and managed sync credentials.
	if err := os.Chmod(home, 0o700); err != nil {
		return "", fmt.Errorf("secure commonmind home: %w", err)
	}
	return filepath.Abs(home)
}

func path() (string, error) {
	home, err := Home()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "settings.json"), nil
}

func Load() (Settings, error) {
	file, err := path()
	if err != nil {
		return Settings{}, err
	}
	payload, err := os.ReadFile(file)
	if err != nil {
		if os.IsNotExist(err) {
			return Settings{}, ErrNotConfigured
		}
		return Settings{}, fmt.Errorf("read settings: %w", err)
	}
	var s Settings
	if err := json.Unmarshal(payload, &s); err != nil {
		return Settings{}, fmt.Errorf("parse settings: %w", err)
	}
	if s.SharedDir == "" || s.Author == "" {
		return Settings{}, errors.New("settings are incomplete; run: commonmind init")
	}
	return s, nil
}

func Save(s Settings) error {
	file, err := path()
	if err != nil {
		return err
	}
	payload, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(file), ".settings-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(payload, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), file)
}

// DefaultRoots returns the standard Claude Code and Codex session
// directories under the user's home directory.
func DefaultRoots() []string {
	base, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return []string{
		filepath.Join(base, ".claude", "projects"),
		filepath.Join(base, ".codex", "sessions"),
	}
}

func DefaultAuthor() string {
	if out, err := exec.Command("git", "config", "--get", "user.email").Output(); err == nil {
		if email := strings.TrimSpace(string(out)); email != "" {
			return email
		}
	}
	name := "unknown"
	if u, err := user.Current(); err == nil && u.Username != "" {
		name = u.Username
	}
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "localhost"
	}
	return name + "@" + host
}
