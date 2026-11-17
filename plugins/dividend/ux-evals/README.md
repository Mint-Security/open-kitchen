# Dividend desktop UX evaluations

These are Dividend-owned acceptance and exploratory UX scenarios for [Mod UX Lab](../../../tools/mod-ux/README.md). The harness accepts their paths as input and has no dependency on Dividend. Synthetic fixtures that verify the harness itself live with the harness tests. This directory is separate from `claude plugin eval`'s `evals/` convention.

The JSON files describe user goals, allowed actions and checks. Discovery and guided navigation both expect an unread tip, whose band carries **Usage & tips**: Dividend draws nothing above the prompt without one, and the cases forbid submitting `/dividend`. Discovery leaves the tester to find it; guided navigation names it. Both open a pane containing **This session**; initialize session usage before starting. Dismissal expects one visible tip with a **Got it** control and does not depend on the model's name. The label comes from `hooks/display/views.tsx` (`OPEN_LABEL`), and `scenarios.test.mjs` fails when the two drift apart. The runner does not install the plugin or provision/reset a session.

| Case | Required initial state | Task |
|---|---|---|
| [discovery.json](discovery.json) | Empty prompt and an unread tip (seeded by `try`) | Discover usage, inspect it, and return to a newly typed unsent draft |
| [pane.json](pane.json) | The specified unsent draft and an unread tip with Usage & tips (both set up by `try`) | Open, inspect and close the pane without changing the draft |
| [dismiss.json](dismiss.json) | The specified unsent draft and one visible tip with Got it (both set up by `try`) | Dismiss with Got it and retain the draft |

From the repository root, one command prepares everything and runs a case:

```sh
npm run mod-ux -- try plugins/dividend/ux-evals/pane.json --require-assessed
```

`try` installs this folder's Dividend for a test folder only (`~/.mod-ux/workspaces/dividend`, which Claude Desktop asks you to trust once), opens it as a new Claude Desktop session in its own window and runs the case's `setup` before the tester starts. Add `--driver codex` to have Codex's Computer Use do the input instead ([experimental](../../../tools/mod-ux/docs/codex-driver.md)). Each case seeds one unread weekly-limit tip into Dividend's store, so its band and **Usage & tips** are on screen. Pane and dismissal also type the unsent draft their goals describe. The tip's reset is set far in the future so Dividend doesn't take it back; a real limit tip from your own usage can show up as well. Pass several files to run them one after another, each in a fresh session.

To run against a session you prepared yourself instead, use `run` with the same file; it ignores `setup`:

```sh
npm run mod-ux -- run plugins/dividend/ux-evals/discovery.json \
  --out .mod-ux/dividend-discovery \
  --actor claude --critic claude --call-budget-usd 0.50 --require-assessed
```

Choose another case by passing its file path. Keep run directories distinct. These cases use foreground input: Peekaboo's background press doesn't reach Claude Desktop's buttons in the test window, so the run keeps the focus from setup until it ends, clicks with your pointer, and then gives the focus back. Don't type or use the mouse until it prints its result. With `--driver codex`, Codex does the input without your pointer. They omit the press action and prohibit submission and persistent preference changes; they do not provide an OS sandbox.

The tester and critic make model calls, and screen content is sent to their provider. See the harness documentation for per-call billing, observation and input limits. Checks a sparse accessibility map can't decide remain unassessed; screenshots and agent self-reports do not establish human satisfaction. Generated screen artifacts remain local under ignored `.mod-ux/` directories.

The pane cases require a confirmed click on Usage & tips, unchanged draft values across it, recorded appearance of This session, then a final closed pane and the expected draft. Dismissal requires the Got it control to be observed before its confirmed click and absent afterward, while the draft survives. A tester that immediately says done, a missing tip, or a click with no visible effect cannot pass the configured checks. With the strict gate above, unassessed evidence exits 2; omit the flag only for exploratory runs. Consumer-owned regression tests exercise these actual JSON files through the harness evaluator, including no-op completion, no-effect clicks, lost/retyped drafts, valid transitions and sparse evidence.
