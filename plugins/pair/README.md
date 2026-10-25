# Pair

Share a Claude Code session, peer to peer with no backend: whoever you pair with watches it live, drawn the way your own Claude Code draws it, and can talk to your Claude under their own name.

This much of Pair is the session itself: what the host shares of it, and how the other side draws it. It does not pair two machines yet. `/pair preview` shows both sides from your own session, on your machine, with nothing sent anywhere.

## Try it

From a checkout of this repository:

```bash
claude --plugin-dir plugins/pair
```

Then run `/pair preview`. A pane opens with your Pair pane as it will be once someone joins and, under it, your guest's: this session as they would see it, following it as you work. It reads like your transcript: prompts on a grey band, `⏺` replies, `⏺ Bash(npm test)` with the first lines of output under `⎿`, edits as diffs, and reads and searches folded into one line. In the desktop app it is drawn the way the desktop app draws a conversation, each run of tool calls folded into one row that opens on a click.

| Command | Does |
|---|---|
| `/pair preview` | open the preview. `/pair preview more` or `all` shows earlier rows, `open` or `close` each tool call where clicks don't reach the pane |

An installed plugin does nothing until you run `/pair preview`: no timer, no network, no program running. The preview reads this session's messages once, when it opens, and then takes in what happens as it happens, as a guest who joined then would.

## What your guest sees

- **What your transcript shows:** every prompt, one you send while Claude is working included, everything Claude replies, each tool call with what it returned (output folded to its first lines as the transcript folds it, edits as diffs, a new file's first ten lines), and a failed call as the transcript shows it, `Update(src/auth.ts)` and the error. The slash commands you run show as the line you typed, not what they print, and Pair's own are left out. Not thinking or subagents.
- **Nothing masked:** a secret your transcript shows, in a command or in what it printed, your guest sees too.
- **The whole session:** the conversation so far (its newest 2,000 events), then everything as it happens. The conversation so far starts where the session was last compacted, with a line saying so, and leaves out what you sent while Claude was working: the session keeps those messages apart from the rest.
- **Cleaned before it is drawn:** what arrives from the other side is untrusted, so control characters and everything a screen draws as nothing (bidi controls, Unicode tag characters, variation selectors, fillers) are stripped, lengths are capped, and a name keeps to letters, digits, spaces and `. _ ' -`. The preview draws your session through the same cleaning.

## Settings

| Setting | Default | |
|---|---|---|
| Your name | empty | The name your prompts show under; empty shows them as *Host*. |

## Limits

- In the desktop app a click in a plugin's pane may not reach the plugin. Every click in the preview has a `/pair preview` command too.

## Engine behaviour worth knowing

- `$.session.messages()` hands back the transcript so far with the engine's own rows among the user messages, each wrapped in a tag: slash commands and their output (`<command-name>`, `<local-command-stdout>`), `!` shell commands and theirs (`<bash-input>`, `<bash-stdout>`), task notifications, and a compaction's summary. pair keeps a slash command's line, marks where the compaction was, and leaves the rest out. A message sent while Claude works is an attachment, which it does not hand back at all.
- `prompt.submit` fires for each prompt as it is sent, one typed while Claude works included, so pair mirrors prompts from there. A slash command that runs in place, like `/context`, raises none: its `<command-name>` row is where it shows, live and in the session so far. On a machine with managed settings, Claude Code's built-in security plugin sends some `session.append` rows (attachments, hook context, compactions) on past the plugins a person installs; it leaves `prompt.submit` alone.
- The engine's own drawing of a row can't be read back, so the host works each tool row out from the call and its stored result, by the transcript's rules as 2.1.291 has them: `Update(path)` with a summary line and the diff, a new file's first 10 lines, output wrapped ten columns short of the width and folded to 3 lines (4 when that is all) then `… +N lines`, and consecutive reads and searches folded into one `Searched for N patterns, read N files` row, searches first.

## Tests

```bash
claude plugin test plugins/pair       # what the host shares, the cleaning, the views, and the preview
claude plugin validate plugins/pair
```

`tests/pair.test.tsx` drives the preview through Claude Code's test kit, in the terminal's style and the desktop app's, with prompts and tool calls arriving while it is open, and checks that it runs no program and fetches nothing. The pure modules have their own tests: what the host shares (`mirror.test.ts`), the cleaning (`clean.test.ts`), and, under `tests/style/`, how a tool row is drawn and how the desktop app labels a run of them.
