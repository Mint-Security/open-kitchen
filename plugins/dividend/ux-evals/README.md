# Dividend desktop UX evaluations

These are Dividend-owned acceptance and exploratory UX scenarios for [Mod UX Lab](../../../tools/mod-ux/README.md). The harness accepts their paths as input and has no dependency on Dividend. Synthetic fixtures that verify the harness itself live with the harness tests. This directory is separate from `claude plugin eval`'s `evals/` convention.

The JSON files describe user goals, allowed actions and checks. Prepare each case's required state manually. Discovery and guided navigation both expect an unread tip, whose band carries **Usage & tips**: Dividend draws nothing above the prompt without one, and the cases forbid submitting `/dividend`. Discovery leaves the tester to find it; guided navigation names it. Both open a pane containing **This session**; initialize session usage before starting. Dismissal expects one visible tip with a **Got it** control and does not depend on the model's name. The label comes from `hooks/display/views.tsx` (`OPEN_LABEL`), and `scenarios.test.mjs` fails when the two drift apart. The runner does not install the plugin or provision/reset a session.

| Case | Required initial state | Task |
|---|---|---|
| [discovery.json](discovery.json) | Empty prompt and an unread tip | Discover usage, inspect it, and return to a newly typed unsent draft |
| [pane.json](pane.json) | The specified unsent draft and an unread tip with Usage & tips | Open, inspect and close the pane without changing the draft |
| [dismiss.json](dismiss.json) | The specified unsent draft and one visible tip with Got it | Dismiss with Got it and retain the draft |

Prepare a disposable Claude Desktop Code session using the harness setup instructions. Do not target an active working conversation. Before each new run, inspect and prepare the case's stated initial state manually. Missing prerequisites should be reported as blocked.

From the repository root:

```sh
npm run mod-ux -- run plugins/dividend/ux-evals/discovery.json \
  --out .mod-ux/dividend-discovery \
  --actor claude --critic claude --call-budget-usd 0.50 --require-assessed
```

Choose another case by passing its file path. Add `--window ID` when multiple Claude windows exist. Keep run directories distinct. These cases permit foreground screenshot clicks, so they may focus the selected window and move the pointer. They omit the press action and prohibit submission and persistent preference changes; they do not provide an OS sandbox.

The tester and critic make model calls, and screen content is sent to their provider. See the harness documentation for per-call billing, observation and input limits. Sparse accessibility checks remain unassessed; screenshots and agent self-reports do not establish human satisfaction. Generated screen artifacts remain local under ignored `.mod-ux/` directories.

The pane cases require a confirmed click on Usage & tips, unchanged draft values across it, recorded appearance of This session, then a final closed pane and the expected draft. Dismissal requires the Got it control to be observed before its confirmed click and absent afterward, while the draft survives. A tester that immediately says done, a missing tip, or a click with no visible effect cannot pass the configured checks. With the strict gate above, unassessed evidence exits 2; omit the flag only for exploratory runs. Consumer-owned regression tests exercise these actual JSON files through the harness evaluator, including no-op completion, no-effect clicks, lost/retyped drafts, valid transitions and sparse evidence.
