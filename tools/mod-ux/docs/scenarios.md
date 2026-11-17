# Scenarios and observable checks

Part of [Mod UX Lab](../README.md).

Each adopter owns its versioned JSON scenarios, for example under `your-mod/ux-evals/`. This keeps desktop scenarios separate from `claude plugin eval`'s `evals/` cases. The CLI takes an explicit file path; it does not load a default mod or discover cases inside the tool. Keep product-specific goals, selectors, state preparation and evaluation results with that product. The commands in these pages use a placeholder path: replace it with your own scenario file.

The harness owns its synthetic fake desktop and good/bad controls under `tests/fixtures/`. Those fixtures test the evaluator itself and power `demo`; they are not evaluations of a real mod.

Use the following as a starting point for a consumer-owned scenario and replace the goal and selectors with your mod's actual task and visible labels. Selectors are exact matches on visible `role`, `label` and/or `value`, not implementation identifiers.

```json
{
  "version": 1,
  "name": "Draft survives a mod pane",
  "goal": "Write an unsent draft, inspect the mod and return to the draft.",
  "target": { "app": "com.anthropic.claudefordesktop" },
  "allowedActions": ["click", "type", "wait"],
  "checks": [
    {
      "id": "draft-preserved",
      "kind": "preserved",
      "selector": { "label": "Prompt" },
      "after": { "label": "Your mod details" }
    }
  ],
  "limits": {
    "maxSteps": 20,
    "maxDurationMs": 300000,
    "agentTimeoutMs": 60000,
    "maxObservationAgeMs": 120000
  }
}
```

- `present` / `absent`: check for an exact selector in the final captured accessibility observation.
- `preserved`: compare a uniquely identified element's value before/after each click matching `after`. An unexercised trigger or missing/ambiguous value is **unassessed**, not passed. Equal empty values do not prove a meaningful draft was tested; the scenario must create the intended state.
- `appeared` / `disappeared`: require a confirmed click matching `after`, with the selector changing from absent to present or present to absent across that click's recorded frames. Missing prerequisites, uncertain input and insufficient accessibility coverage remain **unassessed**. A dispatched click with adequate evidence but no expected transition fails. These checks do not infer a transition from the final frame alone. For example, `{ "id": "tip-dismissed", "kind": "disappeared", "selector": { "label": "Dismiss tip" }, "after": { "label": "Dismiss tip" } }` requires seeing that control before its click and seeing it removed afterward.
- `after` may also be a list of selectors, any one of which counts as the trigger, for one entry point that carries different labels in different states: `"after": [{ "label": "Open details" }, { "label": "Details" }]`.

Use transition checks to establish that a task was exercised, then final-state checks to establish how it ended. A final draft that already existed or an absent tip that was never shown cannot establish a successful interaction by itself. Screenshot point clicks without semantic trigger evidence cannot satisfy a check keyed to an accessibility label.

The tester receives the goal, constraints, current image/elements, allowed actions and its interaction history. It does not receive checks, the variant label, native receipts or plugin source. The critic sees evidence and checks after the interaction. Findings must reference existing event IDs and remain labeled **heuristic concerns**.

Sparse accessibility maps are explicitly marked; with the driver's traversal limits Claude Desktop is not one, but other surfaces can be. A selector missing from such a map is **unassessed**, because a visible control may be omitted by the platform. The critic can review the screenshot, but its interpretation remains a separate heuristic judgment. Reports include action counts and separate tester/critic model time, capture overhead, input overhead and requested waits. Pure application latency, human annoyance and transient interruptions between frames are not inferred from these totals.

`completed` means the tester said it finished. Check results, harness errors and critic availability are reported separately. `run` and manual `finish` exit nonzero for blocked/error/limit/stopped sessions, unresolved input, failed configured checks or unavailable critics. A finish request cannot replace a harness failure with completion: the actual status and error remain visible, and the requested status/summary are retained separately as `finishRequest`. Finalized interaction status, finish time, frames and checks cannot be overwritten. Repeated `stop` preserves those artifacts; further `observe` or `finish` calls are refused. A critic may still add its separate review after interaction finalization. Unassessed checks are explicit in JSON/HTML and do not establish UX success.

Exploratory runs may complete with unassessed checks and exit 0. For an acceptance or CI gate, add `--require-assessed` to `run` or `finish`: exit **0** requires at least one check and every check passed; exit **2** means checks are missing or unassessed; exit **1** takes precedence for a run failure, failed check, unresolved input or unavailable critic. An incomplete run or harness error takes priority over check results in the report headline.

For A/B work, prepare separate sessions with the desired mod/version and run the same scenario with `--variant mod-off`, `--variant current` or `--variant candidate`. These are labels only: **the runner does not toggle mods**. Keep host versions, initial state, workspace, viewport and task matched. V1 does not provide statistical comparisons or deterministic live-model replay.

## The synthetic demo and the fixture suite

From the repository root:

```sh
npm run mod-ux -- demo --out .mod-ux/injected-bug
npm run mod-ux -- demo --control --out .mod-ux/good-control
```

Open either run's `report.html`. The synthetic buggy interface deliberately loses the draft when the usage pane opens. The preservation check fails with links to the before frame, action and after frame. The control preserves the draft and passes. These images are generated fixtures, **not screenshots or findings from Claude Desktop**. The scripted tester in this demo does not exercise the model adapter. The demo command exits successfully after producing its expected findings.

```sh
npm run test:mod-ux
```

The fixture suite runs on Linux/macOS without desktop permissions, model credentials or network. CI runs it alongside lint.

## Artifacts, fidelity and current limits

Every run directory contains `session.json`, `result.json`, `report.html` and captured frames. State is written before dispatching input so an uncertain action cannot silently be retried. Each observation/action has an ID, timestamp and duration. Tester/model time is separate; capture/input durations include driver overhead and are not pure host latency. Artifacts contain screen content and entered text and are ignored by Git under `.mod-ux/`. They are not automatically redacted.

Before creating a run or capturing a screen, `start`, `run` and `demo` check the output destination with Git, resolving existing symlink parents. A destination inside a work tree must be ignored; use `.mod-ux/` or add an ignore rule for a custom directory. A destination outside Git is allowed. `--allow-unignored-output` explicitly bypasses this check, including when Git is unavailable. It does not redact captures or prevent a later manual upload.

V1 provides the complete observation → action → evidence → check/review loop. It does not yet provide a fixture browser for real native mod states, host hook telemetry, automatic resets, resizing, cross-host support, long-session workload replay, statistical A/B analysis, CI access to a real signed-in desktop, or human-calibrated annoyance estimates. AX and pixels can be captured at different moments; neither should be treated as an atomic host state. Test known-bad and good controls and review findings with people before relying on new heuristics.

The native plugin test kit remains valuable for cheap component/event regressions. This harness exercises the actual desktop host when its driver is permitted to run; it does not replace those tests.
