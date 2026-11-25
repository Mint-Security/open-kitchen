# Managed teams

Commonmind owns the installation and lifecycle of a separate Syncthing process. Syncthing
owns file replication, discovery, NAT traversal and transport encryption. No new hosted
Commonmind service is introduced. Bring-your-own shared-folder mode remains available.

## Enrollment

`init --team NAME` generates a team folder ID and device identity, configures a private
shared folder, installs the user service and connects the selected MCP clients. The creator
can publish immediately. Its device is the team's introducer.

For an existing shared-folder configuration, `init --team` and `join` automatically reuse
its storage and publishing preferences. The publication ledger and session files stay in
place; sync ignore patterns are preserved. Managed settings are saved only after sync
configuration succeeds. A repeated init/join for the same team keeps its identity and
membership, while a different managed team is rejected. A joining device that started
with its own folder still requires enrollment before publishing new transcripts.

`invite` issues a `cm2_` base64url token containing the team name, folder ID, creator device
ID, 24-hour expiry, random 128-bit invite ID, random 256-bit secret and verification policy.
It is a reusable bearer credential: anyone holding it can join before expiry. Send it privately
to your teammates. The creator stores issued invites in `invites.json` (0600) under `COMMONMIND_HOME`, outside
the shared folder. Device keys and local API credentials never enter the token.

`join` validates the token, creates its own identity and adds the creator as an introducer.
Its Syncthing Hello name carries an HMAC-SHA256 proof binding the invite's details, verification
policy, joining device ID and display name. It never carries the reusable secret. The creator
checks the proof against the pending device ID, which Syncthing derives from the peer's TLS
certificate; copying another device's Hello cannot authorize a different device.

The creator's daemon (or foreground `invite`) accepts valid requests automatically by default.
The same invite can authorize multiple devices until expiry; there are no single-use claims
or recovery records. Expired, unknown or forged proofs are rejected. Enrollment adds the device
and folder access in one Syncthing configuration update, serialized with an advisory lock so
concurrent joins preserve each other's changes. Retrying a completed update is harmless.

The founder can run `invite --require-verification` to require codes for this and future
invites, or `invite --require-verification=false` to restore automatic enrollment for new
invites. Issued invites keep their original policy. In verification mode, a valid secret
proof is still required. The teammate also sends back the 64-bit verification code derived
from the folder and device IDs over the trusted channel. The founder types that code into
`invite` or `approve`; a generic "yes" cannot authorize a device. The setting is only
available on the founder's machine.

A device that shows up without a valid proof is never admitted, with or without a code.
Anyone who learns the creator's device ID can make one appear as pending; `invite` and
`approve` pass over it.

Enrollment adds the exact device and shares the team folder. Existing peers learn the new
member through Syncthing's introducer mechanism; members never introduce each other back to
the creator. Initial enrollment and membership propagation require the creator to be online.
Established peers can subsequently exchange files directly.

The daemon checks for a live connection and reciprocal folder sharing with the creator
before marking a join enrolled. Until then, neither automatic nor explicit `flush` publishes
transcripts. Once enrolled, it publishes once per minute and reports the last attempt in
`status`. It restores the joining device's friendly name after enrollment. It does not
require the creator to remain connected on subsequent runs.

Closing `invite` leaves automatic acceptance running in the founder's daemon; verification
mode still needs `approve`. Closing `join` leaves background enrollment running.
A pending join can use a fresh invite without resetting its identity,
publishing preferences or data. Existing enrolled members do not reverify.

The creator's daemon writes a line to `daemon.log` for every device it accepts, and a
foreground `invite` or `approve` prints one.

## Membership and removal

`members` reads the team folder's device list, names, connection state and last-seen times
from the local Syncthing. On a member's machine the creator appears under the name `join`
gave it, marked as the team creator.

A device's name is its joiner's choice. The creator refuses a proof whose name has control
characters, takes more than 80 terminal columns or is shaped like a device ID, none of which
the joiner's own side sends, and keeps the name without surrounding spaces. `remove` takes a
name or a device ID or its start; when that could mean more than one device it changes nothing
and lists each with its full device ID, which always picks its device. Two names count as one
when they would pass for each other on screen: they differ only in case, spacing, invisible
characters, or characters Unicode lists as drawn alike, compared by the skeleton of UTS #39
with the table from Unicode's `confusables.txt`.

`remove` runs on the creator's machine only. Under the same lock as enrollment, it first
empties `invites.json`, keeping the verification policy, and then takes the device out of every
folder and the device list in one configuration update. Invites go first because a removed
teammate may hold any of them and the daemon would accept a valid proof straight back; a
removal that fails halfway leaves no invite behind. The creator never removes its own device.

Every member marks the creator as its introducer, and Syncthing removes an introduced device
on each member once the introducer stops listing it. A member connected to the creator drops
the device when the change is made. A removed device that keeps connecting shows up as pending
again and is passed over like any device without a valid proof.

A member that was offline would otherwise drop the device only on its next connection to the
creator, and until then relay to it whatever it receives from the rest of the team. So `remove`
also leaves a notice in the shared folder naming the folder, the device, the time, and that
the device was removed. The creator signs it with the key of its own Syncthing identity, and
the certificate travels with it; a member checks that the certificate's SHA-256 is the
creator's device ID, which it already has, and that the signature holds. Every signed message
starts with a fixed label, so it cannot be taken for anything Syncthing signs with the same
key. Letting a removed device back in leaves a second notice, saying so. The latest notice
about a device stands, so an old copy of a removal is not news once its readmission is.

Notices sit at the top of the shared folder, each under a new name with 128 random bits in it,
`.commonmind-notice-<hex>.json`, and none is ever replaced, so nothing anyone puts in the folder
ahead of a notice can stand in its way. Anyone who shares the folder can still delete or change
one, the removed device included, through a teammate that still trusts it. So every daemon, the
creator's too, keeps the latest notice about each device that reaches it in `notices.json` in
its own home, and writes back any the folder no longer has, under a new name. Only the notice
inside a file is signed, so one notice can be wrapped in any number of different files that all
pass: a daemon keeps one copy of it, as the creator wrote it, and reads each file in the folder
once, and again only when it changes.

Each member's daemon acts on the notices that stand and that it has not acted on. Cut off from
the creator, it drops the device itself; connected to the creator, it leaves that to Syncthing
and only notes the notice. It acts on each notice once and records that in `removals.json` in
its own home, so deleting the notice from the folder undoes nothing. Until a member hears of
the removal from the creator or from a teammate who has, it still trusts the device. A removed
device that deletes each notice as it arrives can delay that; every teammate holding the notice
puts it back.

On a removed machine, `join` with a new invite presents a fresh proof even though the machine
counts itself enrolled, and the creator lets it back in; a current member's proof is passed
over. The daemon restores the device's author name once it is connected to the creator.

Removal recalls nothing. The device keeps what it received, and its published sessions stay
in the shared folder until someone deletes them.

## Lifecycle and distribution

Releases bundle a pinned Syncthing binary with Commonmind. The installer verifies archive
checksums and installs both under the Commonmind home. Syncthing's own update mechanism is
disabled so the wrapper and the engine are released together. macOS uses launchd; Linux
uses a systemd user service. `--no-service` plus `daemon` supports other supervisors.

The daemon holds an OS advisory lock and supervises the sync child. Sync failure exits the
daemon so the user service restarts it. SIGINT/SIGTERM stops the child before releasing the
lock, giving it up to 20 seconds: with a teammate connected Syncthing takes about ten, and
killed sooner it leaves a process holding its own lock, so the next start fails. Initialization uses the same lock while configuring the initial sync process. Local
API credentials and device keys live under a 0700 directory; the API listens on loopback.
Commonmind gives that Syncthing a random GUI password and never uses it: without one,
Syncthing lets any local program use the API with a token from the GUI page, no key needed.
The process has separate listeners and config from a user's personal Syncthing installation.

One installed user service and one team per Commonmind home are supported. Cancelling an
invite without removing a device, leaving a team from a member's machine, Windows service
integration and automatic migration between teams are future work.

## Session reads

`get_session` reads every transcript byte accepted by the codec, a window at a time:
`offset` and `max_bytes` select the window, and `next_offset` says where the next one
starts. The 256 MiB decoded-record bound remains a codec safety limit. See
[the MCP tool reference](mcp-tools.md#read-a-session).

## Validation

Unit tests cover invite validation and expiry, device-bound proofs, reusable invites,
concurrent joins, failed updates, verification policy, refusing a device with no proof, the pre-enrollment publishing
gate, membership preservation, service-path escaping and reading
a transcript larger than one window to the end. The optional real-engine test runs three Syncthing instances
with discovery, relays and NAT disabled on loopback. It verifies the initial refusal,
approval, automatic peer introduction, file replication, deletion propagation, the member
list, that a member drops a device once the creator removes it, that a creator's removal
notice verifies against its real device ID, and that Syncthing can start again right after
a stop with a teammate connected.
Managed CLI tests exercise fresh homes and homes that started with their own folder, with automatic and verified invites,
including publishing, retries and two devices joining with the same invite, and removing a
teammate: the other member drops it, its invite admits no one afterward, and a new invite
brings it back, and the creator's latest notice about it says so. A four-machine test has a
member miss the removal and come back while the creator is offline, after another member's
folder lost the notice and that member put it back; it drops the device once that member
passes the notice on. CI runs both suites on Linux and macOS.
