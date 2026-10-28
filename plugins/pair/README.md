# Pair

Share a Claude Code session, peer to peer with no backend. The host runs `/pair` and gets an invite; whoever pastes it watches the host's session live, drawn the way the host's own Claude Code draws it, and can talk to the host's Claude under their own name.

It is one session, hosted where it already runs: the host's machine, repo and credentials. The guest needs none of that, only the invite. The two machines talk peer to peer through [Syncthing](https://syncthing.net): there is no server to run and no account to make.

## Try it

Install it from this repository's marketplace, on both machines:

```bash
claude plugin marketplace add Mint-Security/open-kitchen
claude plugin install pair@mint-security
```

Or, from a checkout of this repository, start a session with it twice, in two terminals or on two machines: one to host, one to join.

```bash
claude --plugin-dir plugins/pair
```

Or `scripts/pair-sandbox.sh host` and `scripts/pair-sandbox.sh guest`: the same two sessions on one machine, the host in a throwaway project with a few files for Claude to work on, each under its own name, with Dividend's band out of the way. Edits to `plugins/pair` reload in both. To see the guest's view without a second session at all, run `/pair preview` in the host's session.

1. **Host:** `/pair`. A few seconds later, once its Syncthing is up, the invite (`/pair XXXX-XXXX-…`, 84 characters in groups of four) is on the clipboard; the band above the prompt has a **Copy invite** button. pair never prints the invite: `/pair invite` copies it again, so it stays out of screen shares and out of the conversation Claude reads. Only where there is no clipboard, as in a `claude -p` run, does `/pair invite` print it. For as long as you share, the status line under the prompt says so, and with whom (*Pair · sharing with Dana*), and the band keeps a **Stop sharing** button, which ends the pairing as `/pair stop` does.
2. **Guest:** paste the invite and press Enter. An invite with a typo in its device part is refused at once; one with a typo in the code part is found out within ten minutes. A few seconds later the **Pair pane** fills with the host's session: the conversation so far, then what happens as it happens. It reads like the host's transcript: prompts on a grey band, `⏺` replies, `⏺ Bash(npm test)` with the first lines of output under `⎿`, edits as diffs, and reads and searches folded into one line. The pane scrolls; it keeps to the newest line unless you scroll up to read.
3. **Guest:** type in the pane's field (or `/pair <message>`). Claude receives it as `Dana (guest): <message>` right away, runs it with the host's tools and permissions, and the guest watches the result.

The first `/pair` on a machine downloads Syncthing (about 11 MB, once).

| Command | Who | Does |
|---|---|---|
| `/pair` | host | start hosting (or, when active, open the pane and print the status) |
| `/pair preview` | host | a pane with your Pair pane above your guest's, showing this session as they get it: the session so far when it opens, then what happens as it happens; works before you pair, with nothing sent anywhere. `/pair preview more` or `all` shows earlier rows, `open` or `close` each tool call where clicks don't reach the pane |
| `/pair <invite>` | guest | join |
| `/pair <text>` | guest | ask the host's Claude (straight in, at most 8 a minute) |
| `/pair invite` | host | copy the invite to the clipboard again (printed only where there is no clipboard) |
| `/pair log [n]` | both | print the last lines of the shared log into your conversation, where Claude reads it too |
| `/pair stop` | both | leave: tells the other side, stops Syncthing and deletes the pairing's files |

A guest's `/pair <text>` is a message unless it is exactly one of these commands: `/pair log 20` prints the log, `/pair log the failing test` goes to Claude.

Messages go out under the plugin's `displayName` setting, or else your OS username (looked up once, when a pairing starts).

An installed plugin does nothing until someone runs `/pair`: no timer, no network, no program running. While a pairing is open it runs its own Syncthing and checks on it once a second. `/pair stop`, or the session ending, stops it.

## What the guest can and can't do

- **See** what the host's transcript shows: every prompt, one the host sends while Claude is working included, everything Claude replies, each tool call with what it returned (output folded to its first lines as the transcript folds it, edits as diffs, a new file's first ten lines). The slash commands the host runs show as the line they typed, not what they print, and Pair's own are left out. Not thinking or subagents. The whole session: when the guest is let in, the session so far (its newest 2,000 events), then everything as it happens. The session so far starts where the host's session was last compacted, with a line saying so, and leaves out what the host sent while Claude was working: the session keeps those messages apart from the rest. A guest who takes the seat later gets the same, afresh: nothing sent to the one before reaches them. Nothing is masked: a secret the host's transcript shows, in a command or in what it printed, the guest sees too. A failed tool call shows as the transcript shows it, `Update(src/auth.ts)` and the error, not with every argument spelled out.
- **Send:** short text messages (600 characters), which go straight to the host's Claude, at most 8 a minute (the rest wait their turn). Nothing else: no files, no commands, no approvals, and no side channel between the two of you, who are side by side or on a call anyway. Claude handles them the way the host's permission mode says: any permission prompt appears on the host's screen, reading files in the project needs no prompt, and a mode that lets Claude edit files or run commands without asking lets a guest's message do the same. The host takes in at most 30 files a minute from the guest, counted before anything is read of them, and reads at most 32 in one go; the rest are dropped, and the host told.
- **Not** reach your machine in any other way: each side's Syncthing only sends its own folder and only receives the other's, so nothing the guest does to the files reaches what the host writes (and the other way round). One thing it can do is take disk space: the folder the guest sends into has no size limit of its own beyond Syncthing's floor of 1% free space. But note: a guest's message is a prompt to *your* Claude with *your* permissions, and nobody reviews it first. Give the invite only to someone you would let type in your terminal.

## Settings

| Setting | Default | |
|---|---|---|
| Your name | empty | The name your messages go out under; empty uses your OS username. |

## How the two sides find each other

- **The invite is the key to everything.** It is two things: a secret code, 140 random bits, from which both sides derive the keys that seal every message; and the host's Syncthing device ID, so the guest knows whom to dial and trust. Each side's Syncthing makes its own identity (`syncthing generate`), as it always does, and says which device ID it is (`syncthing device-id`), so nothing about the host's keys can be worked out from the invite. The guest introduces itself under a name that proves it holds the code (an HMAC of its own device ID); the host's Syncthing parks an unknown device as pending, and the host admits the first one whose proof checks out. Nobody copies a device ID by hand or clicks "accept". The name carries a version, so pairs that lay out their folders differently never admit each other.
- **A private Syncthing per pairing.** `/pair` runs Syncthing v2.1.6 from its GitHub release. The archive is checked against its published SHA-256 (from the release's PGP-signed checksum file) and the binary inside against its own pinned SHA-256, before it first runs and again before every start; a copy that changed on disk is fetched afresh. It is kept in `~/.claude/pair/bin`. Its config is written before it first starts, into a folder only your user can open: random ports, its API on a Unix socket in a private directory (the API key goes by environment, never on the command line), no GUI, no usage reporting, no upgrades, and only the machine's public address announced to global discovery (LAN discovery still finds a peer on the same network). The pairing's folders and socket get a random local name, so nothing derived from the invite shows in a path or in the process list. It runs as a single process for as long as the pairing is open, and never touches any other Syncthing on the machine.
- **Files, not a channel.** Each side writes only its own folder, which its Syncthing runs as send-only, and receives the other side's as receive-only: a send-only folder never applies a change from the other device, so a peer cannot swap a file the other side writes for a link, or plant one under a name it will write next. Each folder holds a state file (overwritten) and numbered message files (never rewritten), each sealed. After a write a side asks Syncthing to scan, and it reads the other side's folder once a second. A message takes about a second and a half to arrive. Messages are taken in the order they were written: Syncthing pulls them in name order, and one that lands before the message ahead of it waits up to five seconds for it. A message that lands later than that is still taken in. The host gives each guest its own folder, so a guest who later takes the seat never inherits the previous one's.
- **Public infrastructure, no account.** The guest finds the host through Syncthing's global discovery servers and connects directly when it can (same network, reachable port), or through Syncthing's community relays when it can't. The guest looks the host up itself, every few seconds: Syncthing on its own waits half an hour before asking again about a device it has never seen. The host looks nobody up; it waits to be dialed.
- Measured with both sides on one Mac: the host is reachable six seconds after its first `/pair` (download included), and the guest is watching six seconds after pasting the invite.

## Security model (POC)

- **The invite is the whole capability.** Whoever holds it can join as the guest (while the seat is free), read the whole session, tool output included, and prompt the host's Claude. Share it privately. Typing `/pair <invite>` also puts it in your session transcript, and in anything that records your prompts, until the pairing ends.
- **Transport:** TLS 1.3 between the two devices, each pinned to the other's device ID (the host's from the invite, the guest's admitted on its proof); a relay only forwards that TLS. On top of it every payload is sealed with keys from the invite, so the files in the shared folder are unreadable to anything but pair. The sealing is encrypt-then-MAC built from HMAC-SHA256, because the mod sandbox's crypto only hashes: POC-grade, to be swapped for a vetted AEAD before this leaves a demo.
- **What third parties learn:** the discovery servers learn the two device IDs and the machines' addresses; a relay, if one is used, learns the addresses and how much is sent. None of them sees the content, the invite or the names.
- **One guest.** The host admits the first guest whose proof checks out and shares its folder with that device alone. Anyone else, the same invite included, stays pending at the host's Syncthing and never gets in; after half a minute of seeing the host up but not getting in, they are told the seat may be taken (or the host's pair is another version). A guest who says goodbye is taken off the host's folder at once, their messages still waiting their turn are dropped, and whatever they send after that is ignored. Once a guest has said goodbye, or been away two minutes (a guest whose session crashed comes back as a new device), the seat is free: the next device whose proof checks out takes it. The host sees a guest the moment they are let in, by name once their first state arrives; a guest who goes quiet shows as offline, and only a goodbye counts as having left. A device that said goodbye is never let in again; anyone else with the invite can take a free seat, so to shut someone out for good, `/pair stop` and start a new pairing with a new invite.
- **Everything arriving from the other side is untrusted:** only plain files of pair's own naming are read (links and oversized files are skipped), control characters and everything a screen draws as nothing (bidi controls, Unicode tag characters, variation selectors, fillers) are stripped, lengths are capped, and what reaches Claude is exactly the cleaned text. A name keeps to letters, digits, spaces and `. _ ' -`, and never reads as the model, the engine or the person at the keyboard (those show as *Guest*); a guest's messages reach Claude as *"Dana (guest): …"* under their current name, so no name reads as the host's own, and a change of name is written in the log. `/pair` itself never quotes what the other side wrote beyond their name, since the model reads command output. `/pair log` does print the shared log into your conversation, on purpose.
- **Nothing lingers.** A pairing's folder (keys, config, shared files) is deleted at `/pair stop` or when the session ends; one left behind by a crash is deleted by the next `/pair`, ten minutes later at the earliest. A pairing never outlives the Claude Code process that started it, and a plugin update mid-pairing ends it, said once, rather than carrying it on under different code.
- What the host mirrors passes through their session, so anything that sees the host's session can see it too; the network cannot.

## Requirements and limits

- macOS or Linux, on arm64 or x86_64. Windows is not supported yet.
- `curl`, `unzip` (macOS) or `tar` (Linux), and `shasum` or `sha256sum`, for the one-time download from github.com.
- Outbound HTTPS to the Syncthing discovery servers, and a way through to a relay (most listen on TCP 22067) when the two machines can't reach each other directly. A network that blocks both keeps the two sides apart.
- pair runs programs on your machine (Syncthing, and `curl` and friends for the download) through the session; a Claude Code surface or policy that does not let plugins run programs cannot pair.
- A pairing lasts as long as the host's Claude Code process. In the desktop app, Stop and rewinding a conversation start that process again, which ends the pairing; the guest is told the host left.
- In the desktop app a click in a plugin's pane may not reach the plugin. Every click in the preview has a `/pair preview` command too.

## Engine behaviour worth knowing

- A prompt queued from inside a command or a press handler is never delivered by the engine (an awaited one hangs the command); one queued from a timer is. So **Send to Claude** queues the message and the one-second loop submits it, up to a second of delay.
- `prompt.submit` fires for each prompt as it is sent, one typed while Claude works included, so pair mirrors prompts from there. A slash command that runs in place, like `/context`, raises none: its `<command-name>` row is where it shows, live and in the session so far. On a machine with managed settings, Claude Code's built-in security plugin sends some `session.append` rows (attachments, hook context, compactions) on past the plugins a person installs; it leaves `prompt.submit` alone.
- `$.process.spawn` keeps a child exactly as long as the plugin reads its output, and the module unloading kills it. Syncthing v2 forks a supervisor even with `--no-restart`, which would outlive that kill, so pair runs it with `STMONITORED=yes`: one process, which really stops.
- `$.fs.write` replaces the file's content and follows symbolic links, file and directory alike, so a folder another device can change must never be written to: hence the one-way folders. A command's output text is read by the model and recorded in the transcript, so the plugin never echoes the invite or the other side's words into one unasked.
- `$.state` lives as long as the process and survives a hot reload of the plugin's code, nothing longer: a resumed session starts unpaired. A reload brings back whatever the old code stored, so the room carries a format version, and a room another version wrote ends the pairing instead of resuming it.
- `$.session.messages()` hands back the transcript so far with the engine's own rows among the user messages, each wrapped in a tag: slash commands and their output (`<command-name>`, `<local-command-stdout>`), `!` shell commands and theirs (`<bash-input>`, `<bash-stdout>`), task notifications, and a compaction's summary. pair keeps a slash command's line, marks where the compaction was, and leaves the rest out. A message sent while Claude works is an attachment, which it does not hand back at all.
- A pane is a window the engine scrolls over everything the hook draws; `$.ui.scroll({ in, to: 'end' })` moves it, and a `ui.scroll` hook sees the person's own moves.
- `tool.call` carries the call's arguments at the top level of the event, beside `tool` and `tool_use_id`, not under an `input` key.
- The engine's own drawing of a row can't be read back, so the host works each tool row out from the call and its stored result, by the transcript's rules as 2.1.291 has them: `Update(path)` with a summary line and the diff, a new file's first 10 lines, output wrapped ten columns short of the width and folded to 3 lines (4 when that is all) then `… +N lines`, and consecutive reads and searches folded into one `Searched for N patterns, read N files` row, searches first.

## Tests

```bash
claude plugin test plugins/pair       # what the host shares, the cleaning, the views, protocol vectors, and both roles over a simulated Syncthing
claude plugin validate plugins/pair
node scripts/e2e-pair.mjs --spend     # the real thing, see below
```

The plugin tests run both roles against a simulated two-device world: an in-memory file system, one-way folders that only move files while the two are connected, Syncthing's REST answers, the discovery lookup and the programs the plugin runs. Claude Code 2.1.291's test kit cannot raise `session.append` rows, so the mirroring of replies and slash commands, and the real transport, are proven by `scripts/e2e-pair.mjs`: three headless sessions on one machine (host, guest, and a third with the same invite that must not get in), each running its own Syncthing over the public discovery servers and relays, with four real model turns on Haiku: one before pairing, whose conversation the guest must see; two a guest's messages start straight away; and one the host types. It checks the guest's log for the tool rows with their arguments and output, that both Syncthings run one-way folders, that what sits in them on disk holds no plaintext, and that nothing is left running or on disk afterwards. It spends about 10 cents, so it refuses to run without `--spend`.

What the simulated world cannot show was checked against the real thing: a guest on a two-way folder can replace the host's own files with links pointing outside it (Syncthing applies the swap within a second), and with the host's folder send-only neither a file nor a folder link gets through.
