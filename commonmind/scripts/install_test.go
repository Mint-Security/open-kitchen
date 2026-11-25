package scripts

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func installerArchive(t *testing.T) []byte {
	t.Helper()
	var archive bytes.Buffer
	gz := gzip.NewWriter(&archive)
	tw := tar.NewWriter(gz)
	files := map[string]string{
		"commonmind": "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$COMMONMIND_HOME/invocation\"\n",
		"syncthing":  "#!/bin/sh\nexit 0\n",
		"LICENSE":    "test", "syncthing-LICENSE.txt": "test", "syncthing-SOURCE.txt": "test", "THIRD-PARTY-LICENSES.txt": "test",
	}
	for name, content := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(content))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return archive.Bytes()
}

func TestInstallerVerifiesArchiveAndForwardsJoinOptions(t *testing.T) {
	for _, corrupt := range []bool{false, true} {
		t.Run(fmt.Sprintf("corrupt=%t", corrupt), func(t *testing.T) {
			srv := serveInstallerArchive(t, corrupt)
			home := filepath.Join(t.TempDir(), "home with spaces ' and $dollars")
			shellHome := t.TempDir()
			cmd := exec.Command("sh", "install.sh", "--join", "cm2_example", "--clients", "none", "--no-service")
			cmd.Env = append(os.Environ(), "HOME="+shellHome, "ZDOTDIR=", "SHELL=/bin/zsh", "COMMONMIND_HOME="+home, "COMMONMIND_RELEASE_URL="+srv.URL)
			output, err := cmd.CombinedOutput()
			if corrupt {
				if err == nil || !strings.Contains(string(output), "checksum verification failed") {
					t.Fatalf("bad checksum accepted: %v %s", err, output)
				}
				if _, err := os.Stat(filepath.Join(home, "bin", "commonmind")); !os.IsNotExist(err) {
					t.Fatal("installed unverified binary")
				}
				if _, err := os.Stat(filepath.Join(shellHome, ".zshrc")); !os.IsNotExist(err) {
					t.Fatal("changed shell configuration before verification")
				}
				return
			}
			if err != nil {
				t.Fatalf("install: %v: %s", err, output)
			}
			invocation, err := os.ReadFile(filepath.Join(home, "invocation"))
			if err != nil {
				t.Fatal(err)
			}
			if string(invocation) != "join\n--clients\nnone\n--no-service\ncm2_example\n" {
				t.Fatalf("join arguments: %s", invocation)
			}
			verifyPathInstructions(t, string(output), home, shellHome)
		})
	}
}

func serveInstallerArchive(t *testing.T, corrupt bool) *httptest.Server {
	t.Helper()
	archive := installerArchive(t)
	asset := fmt.Sprintf("commonmind-%s-%s.tar.gz", runtime.GOOS, runtime.GOARCH)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/" + asset:
			_, _ = w.Write(archive)
		case "/checksums.txt":
			sum := sha256.Sum256(archive)
			if corrupt {
				sum[0] ^= 0xff
			}
			_, _ = fmt.Fprintf(w, "%x  %s\n", sum, asset)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func verifyPathInstructions(t *testing.T, output, home, zshDir string) {
	t.Helper()
	var commands []string
	for _, line := range strings.Split(output, "\n") {
		if strings.HasPrefix(line, "  export PATH=") {
			commands = append(commands, strings.TrimSpace(line))
		}
	}
	if len(commands) != 1 {
		t.Fatalf("missing copyable PATH instructions: %s", output)
	}
	for _, script := range []string{strings.Join(commands, "\n"), `. "$ZDOTDIR/.zshrc"`} {
		cmd := exec.Command("sh", "-c", script+"\nprintf '%s' \"$PATH\"")
		cmd.Env = append(os.Environ(), "ZDOTDIR="+zshDir)
		out, err := cmd.CombinedOutput()
		if err != nil || !strings.HasPrefix(string(out), filepath.Join(home, "bin")+":") {
			t.Fatalf("PATH instructions failed: %v %s", err, out)
		}
	}
	if zsh, err := exec.LookPath("zsh"); err == nil {
		cmd := exec.Command(zsh, "-d", "-i", "-c", `printf '%s' "$PATH"`)
		cmd.Env = append(os.Environ(), "ZDOTDIR="+zshDir)
		out, err := cmd.CombinedOutput()
		if err != nil || !strings.HasPrefix(string(out), filepath.Join(home, "bin")+":") {
			t.Fatalf("new zsh terminal has no Commonmind PATH: %v %s", err, out)
		}
	}
}

func TestInstallerPersistsZshPathAndPreservesConfiguration(t *testing.T) {
	srv := serveInstallerArchive(t, false)
	for _, mode := range []string{"new", "existing", "custom-zdotdir", "symlink", "manual-export", "directory", "missing-parent", "bash", "unset-shell"} {
		t.Run(mode, func(t *testing.T) {
			shellHome := t.TempDir()
			home := filepath.Join(shellHome, "commonmind with spaces ' and $dollars")
			zshDir, shell := shellHome, "/bin/zsh"
			if mode == "custom-zdotdir" {
				zshDir = filepath.Join(t.TempDir(), "zsh config ' $dir")
				if err := os.Mkdir(zshDir, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "missing-parent" {
				zshDir = filepath.Join(shellHome, "missing")
			}
			rc := filepath.Join(zshDir, ".zshrc")
			original := "export EXISTING_SETTING=preserved"
			if mode == "manual-export" {
				original += "\nexport PATH='" + strings.ReplaceAll(home+"/bin", "'", "'\\''") + "':$PATH\n"
			}
			switch mode {
			case "new", "missing-parent":
				original = ""
			case "directory":
				if err := os.Mkdir(rc, 0o700); err != nil {
					t.Fatal(err)
				}
			default:
				target := rc
				if mode == "symlink" {
					target = filepath.Join(shellHome, "dotfiles-zshrc")
					if err := os.Symlink(target, rc); err != nil {
						t.Fatal(err)
					}
				}
				if err := os.WriteFile(target, []byte(original), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "bash" {
				shell = "/bin/bash"
			} else if mode == "unset-shell" {
				shell = ""
			}
			install := func() string {
				t.Helper()
				cmd := exec.Command("sh", "install.sh")
				cmd.Env = append(os.Environ(), "HOME="+shellHome, "ZDOTDIR="+zshDir, "SHELL="+shell, "COMMONMIND_HOME="+home, "COMMONMIND_RELEASE_URL="+srv.URL)
				out, err := cmd.CombinedOutput()
				if err != nil {
					t.Fatalf("install failed: %v %s", err, out)
				}
				return string(out)
			}
			output := install()
			fallback := mode == "directory" || mode == "missing-parent" || mode == "bash" || mode == "unset-shell"
			if fallback {
				if strings.Contains(output, "To undo:") || !strings.Contains(output, "  export PATH=") {
					t.Fatalf("incorrect fallback guidance: %s", output)
				}
				if mode == "directory" || mode == "missing-parent" {
					if !strings.Contains(output, "Warning: could not update") {
						t.Fatalf("missing update warning: %s", output)
					}
				} else if data, err := os.ReadFile(rc); err != nil || string(data) != original {
					t.Fatalf("changed unsupported shell configuration: %v %s", err, data)
				}
				return
			}
			data, err := os.ReadFile(rc)
			if err != nil || !strings.HasPrefix(string(data), original) {
				t.Fatalf("existing configuration lost: %v %s", err, data)
			}
			if mode == "symlink" {
				if info, err := os.Lstat(rc); err != nil || info.Mode()&os.ModeSymlink == 0 {
					t.Fatal("replaced symlink")
				}
			}
			if mode == "manual-export" && string(data) != original {
				t.Fatal("duplicated a PATH export that was added by hand")
			}
			reinstallOutput := install()
			after, err := os.ReadFile(rc)
			if err != nil || !bytes.Equal(data, after) || !strings.Contains(reinstallOutput, "PATH is already configured") {
				t.Fatalf("reinstall changed configuration: %v %s", err, reinstallOutput)
			}
			verifyPathInstructions(t, output, home, zshDir)
			undoPrefix := "To undo: remove this line from " + rc + ", then open a new terminal:\n    "
			_, undo, found := strings.Cut(output, undoPrefix)
			if !found {
				t.Fatalf("missing undo guidance: %s", output)
			}
			undoLine := strings.SplitN(undo, "\n", 2)[0]
			if !strings.Contains(string(data), undoLine+"\n") {
				t.Fatal("undo instructions do not identify the installed line")
			}
			remaining := strings.Replace(string(data), undoLine+"\n", "", 1)
			if strings.Contains(remaining, "export PATH=") || !strings.Contains(remaining, strings.SplitN(original, "\n", 2)[0]) {
				t.Fatalf("undo would remove unrelated configuration: %s", remaining)
			}
		})
	}
}

// TestInstallerStopsWhenTheDownloadFails: the release URL is the one source.
// A GitHub CLI that happens to be signed in is not asked to fetch it instead.
func TestInstallerStopsWhenTheDownloadFails(t *testing.T) {
	dir := t.TempDir()
	bin, home := filepath.Join(dir, "commands"), filepath.Join(dir, "home-404")
	if err := os.MkdirAll(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	for path, content := range map[string]string{
		filepath.Join(bin, "curl"): "#!/bin/sh\necho 'curl: HTTP 404' >&2\nexit 22\n",
		filepath.Join(bin, "gh"):   "#!/bin/sh\ntouch \"$FIXTURE_DIR/gh-was-called\"\n",
	} {
		if err := os.WriteFile(path, []byte(content), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	cmd := exec.Command("sh", "install.sh")
	cmd.Env = append(os.Environ(), "HOME="+dir, "ZDOTDIR=", "SHELL=/bin/zsh", "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"), "COMMONMIND_HOME="+home, "COMMONMIND_RELEASE_URL=", "FIXTURE_DIR="+dir)
	output, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "curl: HTTP 404") || !strings.Contains(string(output), "Could not download") {
		t.Fatalf("missing download failure: %v %s", err, output)
	}
	if _, err := os.Stat(filepath.Join(dir, "gh-was-called")); !os.IsNotExist(err) {
		t.Fatal("fell back to the GitHub CLI")
	}
	if _, err := os.Stat(filepath.Join(home, "bin", "commonmind")); !os.IsNotExist(err) {
		t.Fatal("installed after a download failure")
	}
}
