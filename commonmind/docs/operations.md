# Setup and operations

[Back to the README](../README.md)

Use the [quick start](../README.md#quick-start) for a new team. This guide covers
setup options, invitations, privacy and background services.

## Setup options and existing installations

For zsh users, the installer automatically adds a marked PATH line to `.zshrc`
(respecting `ZDOTDIR`) and skips an identical entry on reinstall. It prints the exact
line to remove to undo the change. Open a new terminal afterward, or run the highlighted
export command in your current terminal. For other shells, or if `.zshrc` cannot be
updated, installation still succeeds and the installer prints manual PATH instructions.

`init --team` creates the shared folder, registers MCP with installed Claude Code and Codex
CLIs, and starts publishing and sync. The default roots are `~/.claude/projects` and
`~/.codex/sessions`; the publishing window is the last 14 days by source modification time.
The default author is your git email, with a user/hostname fallback.

Started with [your own shared folder](#bring-your-own-shared-folder)? Run the same
`init --team` command. It turns that setup into a team and keeps the folder, sessions,
publishing history, author, roots, exclusions and sync ignore patterns. `--author`, `--roots`
and `--exclude` given on that command replace the saved ones. An invitation's join command
does the same. Repeating setup for the same team keeps the existing
team and device identity; it does not apply new roots, author or exclusions. A different
managed team is never replaced automatically.

Configure these choices up front:

```sh
commonmind init --team example --author alice --clients claude \
  --roots /path/to/agent/session/root --exclude '/path/to/private-*'
```

`--clients` accepts `auto` (default), `claude`, `codex`, `claude,codex`, or `none`. Existing
MCP entries named `commonmind` are preserved and reported; inspect them if you previously
connected a different Commonmind installation. Restart your agent session to load a new
MCP entry. `commonmind connect` can register clients later.

Team setup starts background sync before registering agent integrations. If an agent CLI
is broken or registration fails, setup prints a warning and continues with enrollment.
It checks that a CLI can run before using it and tries later PATH entries if a launcher
fails. Repair or install the affected CLI, then run `commonmind connect codex` (or `claude`)
to retry. Other detected clients are still configured; explicit `connect` failures return
a nonzero exit status.

## Invite a teammate

`commonmind invite` prints one install-and-join command. Send it privately to your teammates
through your usual trusted channel. They run it, and installation, sync and MCP setup happen
automatically. **No verification code is needed by default.** Keep the creator's machine
online until they join. The same command works for multiple teammates during its 24-hour window.

The command contains a **secret granting team access**, valid for 24 hours. The creator's
machine checks the expiry when accepting each device. Anyone with the command can join
before it expires, so don't post it in a public channel. Existing members keep
their connection when reinstalling; they don't need another invite or verification code.

The creator can require a verification code for this and future invites:

```sh
commonmind invite --require-verification
```

In that mode, the teammate sends back the prominent code printed by the installer. Wait
for the device prompt in `invite` and type their code, or run `commonmind approve` later.
Use `commonmind invite --require-verification=false` to make new invites automatic again.
Invites already issued keep their original requirement.

Use `commonmind invite --no-wait` to print the command and let background sync accept it.
Without `--no-wait`, the command stays open for additional teammates until expiry or Ctrl-C.
Teammates who already have Commonmind installed can run the accompanying
`commonmind join cm2_...` command.

Join options go before the invite:

```sh
commonmind join --clients codex --exclude '/path/to/private-*' cm2_...
```

The installer also accepts these options after its `--join INVITE` argument. No transcripts
are published while enrollment is pending. Closing the join terminal does not stop background
sync; it can complete enrollment when the creator comes online. If the invite expires before joining,
ask for a new one and run its join command; your existing setup is preserved.

The creator needs to be online for enrollment and membership updates. Once introduced,
peers sync directly whenever they overlap online. There is no always-online storage node.
Syncthing can use its public discovery and encrypted relay infrastructure to connect peers;
those services do not receive plaintext transcripts.

## See who is on the team, and remove a device

`commonmind members` lists the devices the team folder is shared with: the name each joined
under, the start of its device ID, and whether it is connected or when it was last seen. A
teammate with two machines appears twice. Any member can run it.

The team creator can take a device out:

```sh
commonmind remove sam@example.com
```

Name the device by its name or by the device ID that `members` shows. When that could mean
more than one device, for example two devices whose names look alike, `remove` changes nothing
and lists each one with its full device ID; run it again with the ID of the one you mean.
Removing a device also cancels every invite still open, since a removed teammate could use
one to come back. Run `commonmind invite` afterward for a new one. To bring someone back,
send them a new invite and have them run its join command, on the same machine or a new one.

Teammates drop the removed device on their own as soon as they hear of the removal, from the
creator's machine or from any teammate who already has. Until then, a teammate's machine still
trusts the removed device and can pass it anything new that teammate receives, from anyone on
the team. Keep the creator's machine online, as for joins. Removal recalls nothing: the device keeps every session it already
received, and the sessions it published stay in the team's history. They sit in
`sessions/<author>/` beside those of every other machine publishing under that author, and
whatever is deleted there is never published again (see [deletion](#exclusions-and-deletion)).

## Exclusions and deletion

Commonmind publishes raw transcripts, including tool output and any secrets they contain.
There is no redaction. Choose the transcript roots and exclusions before enabling publishing.

An `--exclude` glob names a directory by its full path, starting with `/`, and `*` stops at
a `/`. A session that worked in that directory, or anywhere below it, is not published. A
`.commonmind-ignore` file in a session's
working directory or one above it does the same. A session is checked against every working
directory it records, not only the one it started in.

A session that was held back stays held back on this machine, even if the pattern or the
ignore file later goes away. With `--exclude` set, a session that records no working
directory is not published either. Configure exclusions before publishing; adding one later
does not remove files already shared.

Delete a published `.cms` file to remove it from the shared history. Syncthing propagates
the deletion; the publisher's local ledger prevents republishing once it observes the
missing file. Offline peers retain their copy until they sync. Backups, snapshots and files
copied outside the folder remain outside Commonmind's control.

The ledger is local. Losing `~/.commonmind/published.db`, moving to another machine, or
scanning the same source under a different path can republish previously deleted sessions.
For durable exclusion, exclude the source before publishing again. All team members have
read/write access to the shared folder; author labels are not access controls.

## Background service and local state

Commonmind stores its application data under `~/.commonmind` (or `COMMONMIND_HOME`):

- `bin/`: Commonmind, Syncthing, and license notices.
- `settings.json` and `published.db`: configuration and the local publishing ledger.
- `invites.json`: issued invite secrets and verification policies on the creator's machine.
- `shared/`: replicated session files.
- `syncthing/` and `sync.json`: private sync identity, database, API credentials and logs.
- `publish-status.json` and `daemon.log`: the last publishing attempt and service errors.
- `notices.json` and `removals.json`: the team creator's latest signed membership notice
  about each device this machine has seen, and the removals it has acted on.

The local API is bound to loopback and protected by an API key. Managed Syncthing uses its
own configuration and listen ports, independent of any personal Syncthing installation.
Its staging files are excluded from replication. Updates are delivered in Commonmind
releases, with automatic Syncthing upgrades disabled.

On macOS, Commonmind installs a LaunchAgent. On Linux, it installs a systemd user service.
These start at login; they do not configure Linux lingering or require root. For headless
systems without a user service manager, use `init --team NAME --no-service` or
`join --no-service INVITE`, then run `commonmind daemon` under your own supervisor.
Only one managed team per Commonmind home and one installed user service are supported.
Changing teams uses a separate home; stop the old user service first.

## Bring your own shared folder

Commonmind also works without a team, over Syncthing, an existing network share, a synced drive,
or a folder used only on this machine. It does not install a service or configure peers:

```sh
commonmind init --shared ~/CommonMind
commonmind flush
commonmind connect
```

Arrange replication and schedule `flush` yourself in this mode. `init` creates the
`sessions/` directory; later publishing refuses to recreate it if it disappears, so a
missing mount cannot silently become a fresh local folder.
