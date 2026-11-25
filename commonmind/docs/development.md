# Development and releases

[Back to the README](../README.md)

## Build from source

Install Go 1.27 or later and Git, then clone the repository:

```sh
git clone https://github.com/Mint-Security/open-kitchen.git
cd open-kitchen/commonmind
make build
make test
# For managed sync from a source build, supply the Syncthing executable:
./bin/commonmind init --team example --syncthing /absolute/path/to/syncthing --clients none
```

## Tests

`go test -race ./...` and `go vet ./...` run without Syncthing installed. To run the real
three-device enrollment, introduction, replication and deletion test:

```sh
COMMONMIND_TEST_SYNCTHING=/absolute/path/to/syncthing go test ./internal/syncer ./cmd/commonmind -run 'TestReal|TestManagedCLI' -v
```

`TestManagedCLIDayInTheLife` is the widest of these: two machines, each with the built CLI,
its own daemon and its own Syncthing, and an agent on each reading through `commonmind mcp`
over stdio. It publishes transcripts shaped and sized like real ones, then follows a running
session as it grows, a teammate's deletion, and a daemon restart. It takes one to three
minutes, most of it waiting for the daemon's once-a-minute publish.
`TestMCPReadsWhatFlushPublished` is the same read path on one machine and needs no Syncthing.

The service tests put a fake `launchctl` and `systemctl` first on `PATH` and use a home
directory of their own, so they never touch a real login service.

The `commonmind` workflow also smoke-tests the packaged installer on Linux and macOS on every
PR and `main` push that changes Commonmind. It checks fresh zsh PATH setup, reinstall, custom `ZDOTDIR`, symlinks,
undo, unwritable startup files, and team initialization with a broken Codex launcher,
including terminal warning colors. Failed runs save installer logs as artifacts. You
can run the `commonmind` workflow manually from Actions without publishing a release.

To repeat the installer smoke test locally, install zsh and run as a regular user:

```sh
bash scripts/smoke-install.sh /absolute/path/to/release-assets /tmp/commonmind-smoke test
```

The asset directory must contain `install.sh`, `checksums.txt`, and the archive for your
platform. The last argument is the expected binary version (`test` for CI packages, or
the release tag for downloaded assets). The test directory must not exist yet; it holds
isolated homes and logs for inspection afterward. No cloud credentials or agent API keys
are needed, and existing shell profiles and Commonmind settings are not used.

## Releases

Commonmind shares its repository with other tools, so its releases are tagged
`commonmind--vX.Y.Z` and only a change under `commonmind/` or to its two workflows makes one.
Merging such a change into `main` publishes a release after the macOS and Linux tests pass.
The workflow increments the latest stable patch version (`commonmind--v1.0.0` →
`commonmind--v1.0.1`), builds all four platform/architecture combinations from that tested
commit, and publishes the tag, installer, archives and SHA-256 checksums together. No manual
tagging or extra token is needed. Reruns reuse an existing tag for that commit, and a failed
upload stays a draft until all assets are ready. A draft left by a commit that has since been
superseded is replaced by the newer commit's release. If another Commonmind change lands on `main`
while a run is waiting or building, it leaves releasing to that newer commit's successful
tests; a newer commit that leaves Commonmind alone does not hold a release back.

Releases are published from `Mint-Security/open-kitchen` only. In any other copy of the
repository the tests run and nothing is published. The installer downloads from the
repository's latest release, so a Commonmind release is always marked latest and a release of
anything else in the repository must not be (`gh release create --latest=false`).

An explicit `commonmind--v*` tag publishes that version only when the tagged commit is on `main`
and the version is the newest stable one, since its release becomes the one every install and
invite downloads. Releases and CI build with the newest patch of Go 1.27, the version `go.mod` requires. A manual `commonmind-release` workflow run is a
build-only preview, useful for checking a branch before merging. To retry an automatic
release, rerun the failed jobs in its `commonmind` workflow run. The publish step is `scripts/release-publish.sh`,
tested against a fake `gh` in `scripts/release-publish_test.go`. The installer verifies archive checksums. Packaging
verifies Syncthing 2.1.5 against pinned upstream checksums and includes its license and source
link. `THIRD-PARTY-LICENSES.txt` collects the licence files of Go and of every module built into
the binary, including those in a package's own directory below its module's root, and the
Unicode licence; packaging stops if Go or a module has none, so build with the official Go,
whose GOROOT has its LICENSE. A release is required before generated install-and-join commands can be used on a
fresh machine; source builds can use the direct `commonmind join` command.

Managed onboarding is described in [the enrollment design](managed-teams.md).

## A machine that ran a build before 1.0.0

Earlier builds named the macOS login service `org.commonmind.agent`. 1.0.0 installs
`security.mint.commonmind` and leaves the old one alone, which keeps restarting beside it.
Remove it once:

```sh
launchctl bootout gui/$(id -u)/org.commonmind.agent
rm ~/Library/LaunchAgents/org.commonmind.agent.plist
```

On macOS and Linux, run `commonmind stop && commonmind start` once after upgrading, so the
sync API gets its password.
