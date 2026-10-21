# Dividend

Dividend explains what a Claude Code session carries and costs, while you work: a tip above the prompt when something is worth knowing, a short explanation in each, and a pane with the session's figures. It covers three areas, each of which can be turned off on its own: the prompt cache, the context, and your plan's limits.

Dividend needs Claude Code 2.1.291 or newer; it is tested on 2.1.291. To install it, from a shell:

```bash
claude plugin marketplace add Mint-Security/open-kitchen
claude plugin install dividend@mint-security
```

Then run `/dividend` in a Claude Code session. Inside a terminal session, `/plugin install dividend --marketplace Mint-Security/open-kitchen` does the same in one line. The [repository README](../../README.md#claude-code-marketplace) has the desktop app's way, and [SECURITY.md](../../SECURITY.md#updates) how to stay on a reviewed release.

## What you see

- **A band above the prompt** with the newest unread tip and *Got it*, *Don't show these* and *Later*. Some tips add *Compact now*, which compacts with a brief to carry on from (not while Claude is working; a compaction that is skipped or fails leaves the tip, to try again). In the desktop app, and other sessions where a plugin can't compact directly, it puts `/compact` with the brief in the prompt box for you to send. Tips Claude can act on itself add *Ask Claude*, which puts the tip and what to do about it in the prompt box, after any draft there, for you to read and send. *Later* hides a tip in this session only. Another plugin's band goes first; the tip waits, counted in the status line.
- **A status line**: `1 new · 5h 41%`, with the weekly limit (`· 7d 72%`) once it passes 70%. Without plan limits, the session's cost at list price takes their place, marked API-eq.
- **`/dividend`** opens a pane: the clock time the prompt cache stays warm until, with a bar of what is left; the instruction files by where they load from, each file a button that opens it; every tip so far; and *How it works*, a button per lesson that shows it in the pane.
- **`/dividend session`** prints the same figures as a card in the transcript, which keeps the figures of the moment it was asked.
- **`/dividend learn [cache | context | limits | compact]`** prints a lesson.
- **`/dividend compact [what else to keep]`** compacts with a brief: your latest request, what is done, the next step, the files touched, decisions made and why, and open questions.
- **`/dividend reset`** deletes everything Dividend saved and turns every kind of tip back on, in every session.

## Tips

Tips come in three areas. The prompt cache: when it went cold and why, and a word before a break outlasts it. The context: what a long conversation, a heavy tool output, MCP servers and instruction files add to every message. Your plan's limits: how fast they are going, and when a lighter model would do. Each comes from what Claude Code reports, not from a price table of Dividend's own. [TIPS.md](TIPS.md) lists every tip and when it comes.

## Settings

Dividend's plugin options: `tips` (all of them), `cache`, `context` and `limits` (one area each), `actions` (the *Compact now* and *Ask Claude* buttons), all on by default, and `budgetUsd` (0, off).

**Before the prompt cache expires** is chosen in the `/dividend` pane, for every session on this machine: *Do nothing* (default), *Keep cache warm* (shortly before the cache expires, it sends `Dividend cache keep-alive. Reply only with OK. Do not use tools or continue the task.` in the session, at most 5 times in a row until you send something yourself), or *Auto compact* (once, in a terminal session). Both automatic choices use your plan's allowance or API budget, and act only in an idle session with an empty prompt box.

## What Dividend does on your machine

Dividend is a Claude Code mod: JavaScript that Claude Code runs inside itself, with your user permissions. Claude Code's permission rules and sandbox cover Claude's own tool calls, not a mod, so this is the whole of what Dividend does:

- **It runs on its own.** Its hooks run automatically as Claude Code starts and ends a session, starts and completes a turn, runs a tool, reports usage, compacts, and on a timer during a break.
- **It sends nothing anywhere.** No HTTP requests and no telemetry of its own, and it calls the model only for the cache action you choose: the keep-alive message above, or Claude Code's own compaction. What `/dividend session` and `/dividend learn` print becomes part of the conversation, as any command's output does.
- **It reads the instruction files Claude Code has already loaded** (CLAUDE.md, AGENTS.md, rules, memory), once a session, to find a line repeated across them. It doesn't read them while that tip is turned off.
- **It reads each prompt you send**, typed here, in the desktop app or from your phone, to keep your latest request in memory for the compaction brief. It never changes or holds back a prompt, and doesn't save it. It reads the prompt box only to check that it is empty, or to add to it for *Ask Claude*.
- **It reads these environment variables, to know how long the prompt cache lasts:** `DISABLE_PROMPT_CACHING` and its `_HAIKU`, `_SONNET`, `_OPUS` and `_FABLE` forms, `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `ENABLE_PROMPT_CACHING_1H`, `ENABLE_PROMPT_CACHING_1H_BEDROCK` and `CLAUDE_CODE_USE_BEDROCK`; and `HOME` (or `USERPROFILE` on Windows) as the folder the file opener starts in. None of them is a credential, and none leaves your machine.
- **It starts one program, only when you press a button:** your system's file opener, for the instruction file you pressed in the pane, and only for a regular file (not a link) whose real name ends in `.md`, `.markdown` or `.txt`; anything else, such as a script an `@import` pulled in, is shown by its path instead. On macOS it opens as text (`open -t`), elsewhere with `xdg-open`, on Windows with `explorer.exe`. The file's path is the only thing it passes to the opener, as an argument with no shell in between, and the opener starts in your home folder.
- **What it shows is plain text.** File names, the program a command ran, a page's host and quoted lines are stripped of control, bidi and zero-width characters before Dividend shows or saves them.
- **The compaction brief quotes only what you sent**, never another session's message, a channel's or a notification. *Ask Claude* drafts what to do without quoting any file's content.
- **It acts on the conversation only when you press a button, or as the cache action you chose.** *Compact now* and `/dividend compact` run Claude Code's own compaction. *Ask Claude* puts a request in your prompt box; you decide whether to send it.

## What Dividend keeps

Dividend keeps its data in Claude Code's plugin store, a JSON file of its own under `~/.claude/plugins/store/` that only your user can read (`0600`). It stays on this machine. Every Claude Code session on your machine reads and writes the same file.

- **Tips:** up to the 60 newest, each with its title and text, the time it came, and an id made of its kind and a hash of the session or project it belongs to (or the limit window it is about). A tip's text can name instruction files, files Claude read again (any file, `.env` included), the program a Bash run started, a fetched page's host, an MCP server or a model, and the repeated-instruction tip quotes up to 120 characters of the line.
- **Your reactions:** which tips you read and which kinds you turned off; read tips stay marked read for up to 300 tips after they leave the list. *Later* is never saved.
- **Tips taken back:** up to 200 ids, so a tip that no longer holds doesn't come back.
- **Each session's last turn:** up to 20 sessions, each under a hash of its session id, with the model, the effort level, the plan Dividend read off the limits, and the time Claude last answered. A resumed session uses it to tell an expired cache from a model switch.
- **Your choice before the prompt cache expires**, once you make one.

All of it stays until `/dividend reset`, which deletes everything Dividend saved.
