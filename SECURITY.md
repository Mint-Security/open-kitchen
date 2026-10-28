# Security

Please report security issues privately to **opensource@mint.security**, not in a public issue. We'll confirm we got it and keep you updated until it is resolved.

## What Dividend can do

Dividend is a Claude Code mod: JavaScript that Claude Code runs inside itself with your user permissions, outside the sandbox and permission rules that cover Claude's own tool calls. So the boundary is in Dividend's code, and this is all of it:

- Its hooks run automatically on Claude Code's lifecycle events: sessions, turns, tool calls, usage reports, compactions, and a timer during a break.
- It makes no HTTP requests and sends no telemetry of its own, and it calls the model only for the keep-alive or compaction you choose in its pane before the prompt cache expires, through Claude Code's own session.
- It reads the instruction files Claude Code has already loaded, to find repeated lines, unless that tip is turned off.
- It starts one program, your system's file opener, only after you press an instruction file in its pane, and only for a regular, non-link Markdown or text file: `open -t` on macOS, `xdg-open` elsewhere, `explorer.exe` on Windows. The path is passed as an argument, with no shell in between, from your home folder.
- Text it takes from files, commands and tool output is stripped of control, bidi and zero-width characters before it is shown or saved.
- *Compact now* and `/dividend compact` run Claude Code's compaction only when you ask. *Ask Claude* puts text in your prompt box; you decide whether to send it.

What it keeps, and for how long, is in [plugins/dividend/README.md](plugins/dividend/README.md#what-dividend-keeps). It stays on this machine.

## What Pair can do

Pair is a proof of concept, and unlike Dividend it talks to the network and lets another person in, by design. In short:

- Nothing runs until you type `/pair`. Then it downloads Syncthing from its GitHub release once, checked against pinned checksums, and runs it as one process until the pairing ends; it looks the host up on Syncthing's discovery servers, and the two Syncthings connect directly or through Syncthing's community relays. No server of ours, no telemetry, no model calls of its own.
- Whoever holds your invite can join while the seat is free, see everything Claude does in the session, tool output included and any secret in it, and prompt your Claude with your permissions.
- Everything the other side sends is treated as untrusted: it is validated, stripped of invisible characters and capped before it is shown, and reaches Claude only as the guest's message.
- Messages are sealed with keys from the invite, using encrypt-then-MAC built from HMAC-SHA256, because a mod can only hash: POC-grade until a vetted cipher replaces it.

The full security model is in [plugins/pair/README.md](plugins/pair/README.md#security-model-poc).

## Updates

Auto-update is off by default for this marketplace, so an installed copy changes only when you update it. To stay on a reviewed release, add the marketplace pinned to a release tag, for example `claude plugin marketplace add Mint-Security/open-kitchen#dividend--v0.1.0`. Each plugin's releases are tagged `<plugin>--v<version>`.
