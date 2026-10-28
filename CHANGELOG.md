# Changelog

## pair 0.1.0

First release candidate.

- `/pair` hosts the session and puts an invite on the clipboard once its Syncthing is up: a secret code and the host's device ID. `/pair <invite>` joins it. Peer to peer over a private Syncthing the plugin downloads and checks on first use: no server, no account.
- The guest's pane draws the host's session the way Claude Code draws it, in the terminal's style or the desktop's, the conversation so far first.
- The guest sees the whole session, from where it was last compacted, as it happens, and their messages go straight to the host's Claude, at most 8 a minute.
- `/pair preview` shows the host's pane above the guest's before anyone joins.
- Everything from the other side is cleaned before it is shown.
- Requires Claude Code 2.1.291 or newer, on macOS or Linux.

## dividend 0.1.1

- A session that opens on Mythos or Fable suggests Opus 5.5, while switching re-caches little. Turned off with the other limit tips, or by *Don't show these*.

## dividend 0.1.0

First public release.

- Tips above the prompt on the prompt cache, the context and plan limits, each with a short explanation and what to do about it.
- *Compact now* with a brief to carry on from, and *Ask Claude*, which drafts a request in the prompt box for the tips Claude can act on.
- `/dividend` pane: the prompt cache's warm-until time, the instruction files (each one opens), every tip, and short lessons.
- `/dividend session`, `/dividend learn`, `/dividend compact`, and `/dividend reset`, which deletes everything Dividend saved.
- Requires Claude Code 2.1.291 or newer.
