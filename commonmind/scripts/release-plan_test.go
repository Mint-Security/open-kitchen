package scripts

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestReleasePlan(t *testing.T) {
	script, err := filepath.Abs("release-plan.sh")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, event, ref, want string
		tags                   []string
		headTag                string
		newer                  string // a file a later commit on main changes
		offMain                bool   // the commit is on a branch that never reached main
		fails                  bool
	}{
		{name: "first release", event: "push", ref: "refs/heads/main", want: "version=v1.0.0\npublish=true\n"},
		{name: "next patch", event: "push", ref: "refs/heads/main", tags: []string{"commonmind--v1.0.0"}, want: "version=v1.0.1\npublish=true\n"},
		{name: "numeric ordering and stable tags only", event: "push", ref: "refs/heads/main", tags: []string{"commonmind--v1.0.9", "commonmind--v1.0.10", "commonmind--v9.0.0-rc1", "commonmind--v9.0", "commonmind--v01.0.0", "commonmind--v9x0x0"}, want: "version=v1.0.11\npublish=true\n"},
		{name: "other tools' tags are not Commonmind's", event: "push", ref: "refs/heads/main", tags: []string{"commonmind--v1.0.0", "dividend--v0.9.0", "v3.0.0"}, want: "version=v1.0.1\npublish=true\n"},
		{name: "rerun keeps existing annotated tag", event: "push", ref: "refs/heads/main", tags: []string{"commonmind--v1.0.0"}, headTag: "commonmind--v1.0.1", want: "version=v1.0.1\npublish=true\n"},
		{name: "superseded by a newer Commonmind change", event: "push", ref: "refs/heads/main", newer: "commonmind/main.go", want: "version=\npublish=false\n"},
		{name: "superseded by a newer Commonmind workflow", event: "push", ref: "refs/heads/main", newer: ".github/workflows/commonmind.yml", want: "version=\npublish=false\n"},
		{name: "a newer change elsewhere does not supersede", event: "push", ref: "refs/heads/main", tags: []string{"commonmind--v1.0.0"}, newer: "plugins/pair/README.md", want: "version=v1.0.1\npublish=true\n"},
		{name: "pull request cannot publish", event: "pull_request", ref: "refs/heads/main", want: "version=\npublish=false\n"},
		{name: "feature branch cannot publish", event: "push", ref: "refs/heads/feature", want: "version=\npublish=false\n"},
		{name: "manual preview", event: "workflow_dispatch", ref: "refs/heads/main", want: "version=dev-SHA\npublish=false\n"},
		{name: "explicit version", event: "push", ref: "refs/tags/commonmind--v1.1.0", tags: []string{"commonmind--v1.0.0"}, headTag: "commonmind--v1.1.0", want: "version=v1.1.0\npublish=true\n"},
		{name: "a tag on a commit that never reached main cannot publish", event: "push", ref: "refs/tags/commonmind--v1.1.0", headTag: "commonmind--v1.1.0", offMain: true, fails: true},
		{name: "an older version cannot become the latest release", event: "push", ref: "refs/tags/commonmind--v1.1.0", tags: []string{"commonmind--v1.2.0"}, headTag: "commonmind--v1.1.0", fails: true},
		{name: "a tag that is not a stable version cannot publish", event: "push", ref: "refs/tags/commonmind--v1.0.0-rc1", headTag: "commonmind--v1.0.0-rc1", fails: true},
		{name: "another tool's tag cannot publish", event: "push", ref: "refs/tags/dividend--v1.1.0", want: "version=\npublish=false\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := t.TempDir()
			git := func(args ...string) string {
				t.Helper()
				cmd := exec.Command("git", args...)
				cmd.Dir = repo
				cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
				out, err := cmd.CombinedOutput()
				if err != nil {
					t.Fatalf("git %v: %v %s", args, err, out)
				}
				return strings.TrimSpace(string(out))
			}
			git("init", "-b", "main")
			git("config", "user.name", "Fixture")
			git("config", "user.email", "fixture@example.invalid")
			git("remote", "add", "origin", repo)
			git("commit", "--allow-empty", "-m", "initial")
			for _, tag := range tc.tags {
				git("tag", tag)
			}
			if tc.offMain {
				git("checkout", "-q", "-b", "unreviewed")
			}
			git("commit", "--allow-empty", "-m", "change")
			sha := git("rev-parse", "HEAD")
			if tc.headTag != "" {
				git("tag", "-a", tc.headTag, "-m", "release")
			}
			if tc.newer != "" {
				path := filepath.Join(repo, tc.newer)
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte("newer\n"), 0o644); err != nil {
					t.Fatal(err)
				}
				git("add", tc.newer)
				git("commit", "-m", "newer change")
			}
			before := git("tag", "--list")
			cmd := exec.Command("sh", script, tc.event, tc.ref, sha)
			cmd.Dir = repo
			cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			out, err := cmd.Output()
			if tc.fails {
				if err == nil {
					t.Fatalf("planned a release it should refuse: %q", out)
				}
				return
			}
			if err != nil {
				t.Fatalf("plan: %v %s", err, stderr.String())
			}
			want := strings.ReplaceAll(tc.want, "SHA", sha)
			if string(out) != want {
				t.Fatalf("got %q; want %q", out, want)
			}
			if git("tag", "--list") != before {
				t.Fatal("planning mutated tags")
			}
		})
	}
}
