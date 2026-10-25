# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Before you open a pull request

```bash
claude plugin validate .
claude plugin validate plugins/dividend
claude plugin test plugins/dividend
claude plugin validate plugins/pair
claude plugin test plugins/pair
```

All of them must pass; CI runs them on every push and pull request. Add a test for any behaviour you change: `plugins/dividend/tests/dividend.test.tsx` and `plugins/pair/tests/pair.test.tsx` drive each whole plugin through Claude Code's test kit, and the other test files cover the pure modules.

## Dividend's ground rules

- Dividend sends nothing anywhere: no network calls, no telemetry, no model calls of its own, except the keep-alive or compaction the person chose in the pane before the prompt cache expires.
- Its hooks run on their own, so they only read and show. Anything with an effect beyond that (compacting, drafting into the prompt box, starting a program) happens only when the person presses a button, or as the cache action they chose.
- What it saves is listed in [plugins/dividend/README.md](plugins/dividend/README.md#what-dividend-keeps). A change that saves something new updates that list.
- Text from files, commands, tool output or other sessions is untrusted: it goes through `plain()` before it is shown or saved, never into a prompt the person sends, and never decides what program runs.
- Figures come from what Claude Code reports, not from a price table of our own.
- A tip says something true and useful, in plain words, with what to do about it.
- Keep comments short, and only for a reason the code can't show.

## How Dividend is laid out

`plugins/dividend/hooks/register.tsx` is the hooks module. `register`, at its top, lists every event Dividend hooks and what it does with each; below it are the module state, grouped by how long it lasts, and every function that uses `$`. Those stay in this one file, because Claude Code follows `$` only into functions of the hooks module, never across an import; what a button does reaches the views as a closure. `hooks/state.ts` holds the state's shapes, and each one fresh.

The rest are pure functions that take values and return values, in two folders:

- `hooks/tips/`: what a tip is, with one row per kind (`kinds.ts`); what a turn leaves behind and the tips it raises (`turns.ts`); what makes the tips (`advisor.ts` for the context and limits, `cache.ts` for the cache lifetime and cache tips, `context.ts` for what grows the conversation, repeated instructions and the compaction brief, `asks.ts` for what *Ask Claude* drafts); which saved tips show, interrupt or are taken back (`shown.ts`); and what Dividend keeps, and how a save merges onto it (`store.ts`).
- `hooks/display/`: the band, the pane and the card (`views.tsx`); their rows, the session's figures and the status line (`status.ts`, `rows.ts`, `ui.tsx`); the lessons (`lessons.ts`); how figures and tool calls read (`format.ts`, `tool-labels.ts`), and which files the pane opens, and with what (`open-file.ts`).

## Pair's ground rules

- Pair sends nothing anywhere and runs no program: no network calls, no telemetry, no model calls of its own.
- Nothing runs until `/pair preview`.
- What would leave the host is what its transcript shows, and nothing more (`hooks/mirror.ts`).
- Everything from the other side is untrusted: it is cleaned before it is shown (`hooks/clean.ts`).

## How Pair is laid out

`plugins/pair/hooks/register.tsx` is the hooks module: the commands and the preview. The rest are pure: what the host shares (`mirror.ts`), the cleaning of what the other side sends (`clean.ts`), the whole pane (`pane.tsx`), and, in `hooks/style/`, everything that copies how Claude Code draws a conversation: a tool row (`tool-rows.ts`), and the transcript in a terminal's style or the desktop app's (`transcript.tsx`, `terminal.tsx`, `desktop.tsx`). Nothing in `style/` decides what is shared or sent; it only makes what it is given look the way Claude Code draws it.

By contributing, you agree that your contribution is licensed under the [Apache-2.0](LICENSE) license.
