package scripts

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// fakeGH stands in for the GitHub CLI. It keeps each release as a directory
// under $FAKE_GH_STATE/releases/<tag> holding "draft", "target" and "assets/",
// and understands the five `gh release` subcommands a publish can use. While
// $FAKE_GH_STATE/fail-upload exists, an upload copies its first file and then
// fails, which is what an interrupted upload leaves behind.
const fakeGH = `#!/bin/sh
set -eu
state=${FAKE_GH_STATE:?}
printf '%s\n' "$*" >> "$state/calls"
if [ "${1:-}" != release ] || [ "$#" -lt 3 ]; then echo "fake gh: unsupported: $*" >&2; exit 2; fi
action=$2; tag=$3; shift 3
dir="$state/releases/$tag"
case "$action" in
  view)
    [ -d "$dir" ] || { echo "release not found" >&2; exit 1; }
    printf '{"isDraft":%s,"targetCommitish":"%s"}\n' "$(cat "$dir/draft")" "$(cat "$dir/target")" ;;
  create)
    [ ! -d "$dir" ] || { echo "a release with this tag already exists" >&2; exit 1; }
    mkdir -p "$dir/assets"
    echo false > "$dir/draft"
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --target) echo "$2" > "$dir/target"; shift 2 ;;
        --title) shift 2 ;;
        --draft) echo true > "$dir/draft"; shift ;;
        *) shift ;;
      esac
    done ;;
  upload)
    [ -d "$dir" ] || { echo "release not found" >&2; exit 1; }
    for file in "$@"; do
      case "$file" in --*) continue ;; esac
      cp "$file" "$dir/assets/"
      if [ -e "$state/fail-upload" ]; then echo "upload failed" >&2; exit 1; fi
    done ;;
  edit)
    [ -d "$dir" ] || { echo "release not found" >&2; exit 1; }
    for option in "$@"; do
      case "$option" in
        --draft=false) echo false > "$dir/draft" ;;
        --latest) echo "$tag" > "$state/latest" ;;
      esac
    done ;;
  delete)
    [ -d "$dir" ] || { echo "release not found" >&2; exit 1; }
    rm -rf "$dir" ;;
  *) echo "fake gh: unsupported: release $action" >&2; exit 2 ;;
esac
`

// releaseLab is a repository with an origin, a fake gh on PATH and a dist
// directory, which is everything release-publish.sh touches.
type releaseLab struct {
	t           *testing.T
	repo, state string
	script      string
}

func newReleaseLab(t *testing.T) *releaseLab {
	t.Helper()
	for _, tool := range []string{"git", "jq", "sha256sum"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s is not installed", tool)
		}
	}
	script, err := filepath.Abs("release-publish.sh")
	if err != nil {
		t.Fatal(err)
	}
	installer, err := os.ReadFile("install.sh")
	if err != nil {
		t.Fatal(err)
	}
	lab := &releaseLab{t: t, repo: t.TempDir(), state: t.TempDir(), script: script}
	if err := os.MkdirAll(filepath.Join(lab.state, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(lab.state, "bin", "gh"), []byte(fakeGH), 0o755); err != nil {
		t.Fatal(err)
	}
	lab.git("init", "-b", "main")
	lab.git("config", "user.name", "Fixture")
	lab.git("config", "user.email", "fixture@example.invalid")
	lab.git("remote", "add", "origin", lab.repo)
	lab.write("commonmind/scripts/install.sh", string(installer))
	lab.write(".gitignore", "dist/\n")
	lab.git("add", ".")
	lab.git("commit", "-m", "initial")
	return lab
}

func (l *releaseLab) env() []string {
	return append(os.Environ(),
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1",
		"FAKE_GH_STATE="+l.state,
		"PATH="+filepath.Join(l.state, "bin")+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func (l *releaseLab) git(args ...string) string {
	l.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = l.repo
	cmd.Env = l.env()
	out, err := cmd.CombinedOutput()
	if err != nil {
		l.t.Fatalf("git %v: %v %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func (l *releaseLab) write(name, content string) {
	l.t.Helper()
	path := filepath.Join(l.repo, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		l.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		l.t.Fatal(err)
	}
}

// commit lands a change to Commonmind on main and returns its commit.
func (l *releaseLab) commit(content string) string {
	l.t.Helper()
	l.write("commonmind/main.go", content)
	l.git("add", ".")
	l.git("commit", "-m", content)
	return l.git("rev-parse", "HEAD")
}

// build fills dist with the four archives a package job leaves, each holding
// content so a test can tell one commit's build from another's.
func (l *releaseLab) build(content string) {
	l.t.Helper()
	if err := os.RemoveAll(filepath.Join(l.repo, "dist")); err != nil {
		l.t.Fatal(err)
	}
	for _, target := range []string{"darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64"} {
		l.write("dist/commonmind-"+target+".tar.gz", content+" for "+target+"\n")
	}
}

// publish runs the script the way the workflow's publish job does.
func (l *releaseLab) publish(ref, sha, version string) (string, error) {
	l.t.Helper()
	cmd := exec.Command("sh", l.script)
	cmd.Dir = l.repo
	cmd.Env = append(l.env(), "GITHUB_REF="+ref, "GITHUB_SHA="+sha, "VERSION="+version)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func (l *releaseLab) failNextUpload(fail bool) {
	l.t.Helper()
	path := filepath.Join(l.state, "fail-upload")
	if !fail {
		if err := os.Remove(path); err != nil {
			l.t.Fatal(err)
		}
		return
	}
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		l.t.Fatal(err)
	}
}

func (l *releaseLab) read(parts ...string) string {
	data, err := os.ReadFile(filepath.Join(append([]string{l.state}, parts...)...))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func (l *releaseLab) exists(tag string) bool {
	_, err := os.Stat(filepath.Join(l.state, "releases", tag))
	return err == nil
}

// assertPublished checks that tag is a published, latest release of sha whose
// assets are exactly the archives built from content, the installer, and
// checksums that match those archives.
func (l *releaseLab) assertPublished(tag, sha, content string) {
	l.t.Helper()
	if got := l.read("releases", tag, "draft"); got != "false" {
		l.t.Fatalf("%s: draft = %q; want a published release", tag, got)
	}
	if got := l.read("releases", tag, "target"); got != sha {
		l.t.Fatalf("%s targets %s; want %s", tag, got, sha)
	}
	if got := l.read("latest"); got != tag {
		l.t.Fatalf("latest release = %q; want %s (the installer downloads from latest)", got, tag)
	}
	assets := filepath.Join(l.state, "releases", tag, "assets")
	entries, err := os.ReadDir(assets)
	if err != nil {
		l.t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	want := []string{"checksums.txt", "commonmind-darwin-amd64.tar.gz", "commonmind-darwin-arm64.tar.gz", "commonmind-linux-amd64.tar.gz", "commonmind-linux-arm64.tar.gz", "install.sh"}
	if strings.Join(names, " ") != strings.Join(want, " ") {
		l.t.Fatalf("%s assets = %v; want %v", tag, names, want)
	}
	checksums, err := os.ReadFile(filepath.Join(assets, "checksums.txt"))
	if err != nil {
		l.t.Fatal(err)
	}
	for _, name := range want[1:5] {
		data, err := os.ReadFile(filepath.Join(assets, name))
		if err != nil {
			l.t.Fatal(err)
		}
		if !bytes.HasPrefix(data, []byte(content+" for ")) {
			l.t.Fatalf("%s holds %q; want the build of %q", name, data, content)
		}
		sum := sha256.Sum256(data)
		if line := hex.EncodeToString(sum[:]) + "  " + name; !strings.Contains(string(checksums), line) {
			l.t.Fatalf("checksums.txt has no line %q:\n%s", line, checksums)
		}
	}
}

func TestReleasePublishCreatesTheLatestRelease(t *testing.T) {
	lab := newReleaseLab(t)
	sha := lab.commit("first")
	lab.build("first")
	if out, err := lab.publish("refs/heads/main", sha, "v1.0.0"); err != nil {
		t.Fatalf("publish: %v\n%s", err, out)
	}
	lab.assertPublished("commonmind--v1.0.0", sha, "first")
}

func TestReleasePublishFromAnExplicitTag(t *testing.T) {
	lab := newReleaseLab(t)
	sha := lab.commit("first")
	lab.git("tag", "commonmind--v1.1.0")
	lab.commit("a newer change does not hold a tagged release back")
	lab.build("first")
	if out, err := lab.publish("refs/tags/commonmind--v1.1.0", sha, "v1.1.0"); err != nil {
		t.Fatalf("publish: %v\n%s", err, out)
	}
	lab.assertPublished("commonmind--v1.1.0", sha, "first")
}

// TestReleasePublishRerunFinishesItsOwnDraft: the docs promise that "a failed
// upload stays a draft until all assets are ready". Nothing is published by
// the failed run, and rerunning it for the same commit completes the release.
func TestReleasePublishRerunFinishesItsOwnDraft(t *testing.T) {
	lab := newReleaseLab(t)
	sha := lab.commit("first")
	lab.build("first")
	lab.failNextUpload(true)
	if out, err := lab.publish("refs/heads/main", sha, "v1.0.0"); err == nil {
		t.Fatalf("a failed upload was reported as a success:\n%s", out)
	}
	if got := lab.read("releases", "commonmind--v1.0.0", "draft"); got != "true" {
		t.Fatalf("after a failed upload draft = %q; want the release to stay a draft", got)
	}
	if got := lab.read("latest"); got != "" {
		t.Fatalf("a half-uploaded release became latest: %q", got)
	}

	lab.failNextUpload(false)
	if out, err := lab.publish("refs/heads/main", sha, "v1.0.0"); err != nil {
		t.Fatalf("rerun: %v\n%s", err, out)
	}
	lab.assertPublished("commonmind--v1.0.0", sha, "first")
}

func TestReleasePublishLeavesAPublishedReleaseAlone(t *testing.T) {
	lab := newReleaseLab(t)
	sha := lab.commit("first")
	lab.build("first")
	if out, err := lab.publish("refs/heads/main", sha, "v1.0.0"); err != nil {
		t.Fatalf("publish: %v\n%s", err, out)
	}
	lab.build("a rebuild of the same commit")
	out, err := lab.publish("refs/heads/main", sha, "v1.0.0")
	if err != nil || !strings.Contains(out, "already published") {
		t.Fatalf("rerun of a published release: %v\n%s", err, out)
	}
	lab.assertPublished("commonmind--v1.0.0", sha, "first")
}

func TestReleasePublishSkipsACommitANewerCommonmindChangeSuperseded(t *testing.T) {
	lab := newReleaseLab(t)
	older := lab.commit("first")
	lab.commit("second")
	lab.build("first")
	out, err := lab.publish("refs/heads/main", older, "v1.0.0")
	if err != nil || !strings.Contains(out, "skipping this release") {
		t.Fatalf("superseded run: %v\n%s", err, out)
	}
	if lab.exists("commonmind--v1.0.0") {
		t.Fatal("a superseded commit created a release")
	}
}

func TestReleasePublishRefusesATagOnAnotherCommit(t *testing.T) {
	lab := newReleaseLab(t)
	lab.commit("first")
	lab.git("tag", "commonmind--v1.0.0")
	sha := lab.commit("second")
	lab.build("second")
	if out, err := lab.publish("refs/heads/main", sha, "v1.0.0"); err == nil {
		t.Fatalf("published over a tag that names another commit:\n%s", out)
	}
	if lab.exists("commonmind--v1.0.0") {
		t.Fatal("a release was created for a tag that names another commit")
	}
}

// TestReleasePublishReplacesADraftASupersededCommitLeft: a draft release has no
// tag, so the next Commonmind commit plans the same version as the run that
// left the draft. That run can no longer finish it — it is superseded, and
// skips — so the newer commit has to take the version over. Otherwise one
// failed upload stops every later release until someone deletes the draft by
// hand.
func TestReleasePublishReplacesADraftASupersededCommitLeft(t *testing.T) {
	lab := newReleaseLab(t)
	first := lab.commit("first")
	lab.build("first")
	lab.failNextUpload(true)
	if out, err := lab.publish("refs/heads/main", first, "v1.0.0"); err == nil {
		t.Fatalf("a failed upload was reported as a success:\n%s", out)
	}
	lab.failNextUpload(false)

	second := lab.commit("second")
	lab.build("first")
	if out, err := lab.publish("refs/heads/main", first, "v1.0.0"); err != nil || !strings.Contains(out, "skipping this release") {
		t.Fatalf("rerun of the superseded commit: %v\n%s", err, out)
	}

	lab.build("second")
	if out, err := lab.publish("refs/heads/main", second, "v1.0.0"); err != nil {
		t.Fatalf("the newer commit could not release over the draft the older one left: %v\n%s", err, out)
	}
	lab.assertPublished("commonmind--v1.0.0", second, "second")
}
