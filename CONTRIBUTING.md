# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Before you open a pull request

```bash
claude plugin validate .
claude plugin validate plugins/dividend
claude plugin test plugins/dividend
```

All three must pass; CI runs them on every push and pull request. Add a test for any behaviour you change: `plugins/dividend/tests/dividend.test.tsx` drives the whole plugin through Claude Code's test kit, and the other test files cover the pure modules.

## Ground rules

- Dividend sends nothing anywhere: no network calls, no telemetry, no model calls of its own, except the keep-alive or compaction the person chose in the pane before the prompt cache expires.
- Its hooks run on their own, so they only read and show. Anything with an effect beyond that (compacting, drafting into the prompt box, starting a program) happens only when the person presses a button, or as the cache action they chose.
- What it saves is listed in [plugins/dividend/README.md](plugins/dividend/README.md#what-dividend-keeps). A change that saves something new updates that list.
- Text from files, commands, tool output or other sessions is untrusted: it goes through `plain()` before it is shown or saved, never into a prompt the person sends, and never decides what program runs.
- Figures come from what Claude Code reports, not from a price table of our own.
- A tip says something true and useful, in plain words, with what to do about it.
- Keep comments short, and only for a reason the code can't show.

## How it is laid out

`plugins/dividend/hooks/register.tsx` is the hooks module. `register`, at its top, lists every event Dividend hooks and what it does with each; below it are the module state, grouped by how long it lasts, and every function that uses `$`. Those stay in this one file, because Claude Code follows `$` only into functions of the hooks module, never across an import; what a button does reaches the views as a closure. `hooks/state.ts` holds the state's shapes, and each one fresh.

The rest are pure functions that take values and return values, in two folders:

- `hooks/tips/`: what a tip is, with one row per kind (`kinds.ts`); what a turn leaves behind and the tips it raises (`turns.ts`); what makes the tips (`advisor.ts` for the context and limits, `cache.ts` for the cache lifetime and cache tips, `context.ts` for what grows the conversation, repeated instructions and the compaction brief, `asks.ts` for what *Ask Claude* drafts); which saved tips show, interrupt or are taken back (`shown.ts`); and what Dividend keeps, and how a save merges onto it (`store.ts`).
- `hooks/display/`: the band, the pane and the card (`views.tsx`); their rows, the session's figures and the status line (`status.ts`, `rows.ts`, `ui.tsx`); the lessons (`lessons.ts`); how figures and tool calls read (`format.ts`, `tool-labels.ts`), and which files the pane opens, and with what (`open-file.ts`).

By contributing, you agree that your contribution is licensed under the [Apache-2.0](LICENSE) license.
