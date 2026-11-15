# Mod UX Lab — desktop v1

A local workbench for testing Claude Desktop mod UX. A terminal agent acts as the user, a separate Claude Desktop session is the target, and an optional critic reviews the recorded interaction. Screenshots, actions, observable checks and heuristic concerns appear together in a static HTML report.

V1 targets macOS Claude Desktop through [Peekaboo](https://peekaboo.sh/). Node.js 22+ is the only dependency for the runner, reports and fixture tests. No server, account, telemetry or publishing is provided by Mint.

## Try the complete pipeline without a model

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

## Prepare the desktop driver

Install the signed CLI from its [official source](https://peekaboo.sh/install.html):

```sh
brew install openclaw/tap/peekaboo
peekaboo --version
npm run mod-ux -- doctor
```

The adapter was developed against Peekaboo **4.9.8**. It requires producer-bound `ps1_…` snapshots, `--fresh`, `snapshot_reusable` and `mutation_targeting_available` evidence. It refuses older/partial observations instead of using a global input fallback. An alternative executable can be supplied with `MOD_UX_PEEKABOO=/absolute/path/to/peekaboo`.

To pin the signed companion host for a background runner, set `PEEKABOO_BRIDGE_SOCKET` to its `~/Library/Application Support/Peekaboo/bridge.sock` path. The selected path is saved with new runs. It must belong to a healthy, authorized Peekaboo host.

Peekaboo needs Screen Recording and Accessibility permission for its selected execution host. Follow [its permission instructions](https://peekaboo.sh/permissions.html); a background terminal may require the signed Peekaboo companion/Bridge host. Grant permission only after reviewing which executable/host receives it. The harness does not request, grant or bypass OS permissions. `doctor` prints the driver's reported status without capturing a screen. A successful diagnostic alone does not establish that observation/input works.

## Prepare a disposable Claude Desktop session

1. Open Claude Desktop's **Code** mode in a disposable workspace/session, with the mod under test installed and the initial state required by your scenario.
2. Finish or pause unrelated work in that window. Close dialogs and search overlays. Do not use a production task as the target.
3. Leave only one eligible Claude window, or select an exact ID:

```sh
npm run mod-ux -- windows
```

V1 attaches to an existing window. It does not create/reset a conversation, install mods, select a repository or cancel target-agent work. The entire selected window may be recorded, including its sidebar. Choose the target accordingly.

## Let a terminal Claude test it

The built-in `claude` adapter uses your installed, authenticated Claude Code CLI. It runs with `--safe-mode`, no tools, no MCP servers, no slash commands and no session persistence. Screenshots are passed directly as image blocks; it does not get shell/file/computer tools. The runner performs each validated desktop action separately. The adapter's minimum supported version is **2.1.322**, its tested baseline; newer versions must retain these flags and structured output. Plugin compatibility CI pins **2.1.291** for Dividend and Pair and does not run the live model adapter. Harness tests exercise the adapter's protocol with stubbed subprocess responses.

```sh
npm run mod-ux -- run path/to/your-mod/ux-evals/discovery.json \
  --out .mod-ux/current \
  --actor claude --critic claude \
  --call-budget-usd 0.50
```

Add `--window 12345` when needed, and `--model MODEL_ID` to choose a model. Model calls send the supplied goal, visible accessibility text, screenshots and interaction history to that agent's provider. This is not an offline evaluation. The critic receives the trace plus at most six explicitly indexed frames; it is not a frame-by-frame video review.

`--call-budget-usd` is passed to each terminal-Claude invocation. It is **not a shared billing cap**: there can be one tester invocation per action plus a final completion assessment and a critic, provider enforcement can overshoot an individual request, and target Claude Desktop usage is separate. Generic command agents manage their own billing. After the last permitted action, the tester can assess the resulting frame and say done or blocked; another requested action ends the run as `limit` without dispatching input. The interaction-duration and per-agent timeouts still apply to that final assessment.

To stop the harness from another terminal:

```sh
npm run mod-ux -- stop --run .mod-ux/current
```

Ctrl-C also stops an automated run. Cancellation signals the tester/driver subprocess group, escalates to SIGKILL after 500 ms and closes inherited pipes so a detached descendant cannot keep the call pending. A descendant that deliberately leaves the group is outside this termination guarantee. Input already delivered may have an effect. **Neither command cancels work already executing inside Claude Desktop.** The interaction deadline bounds the tester/target loop; an optional final critic has its own agent timeout.

## Use the controller directly from another terminal agent

```sh
npm run mod-ux -- start path/to/your-mod/ux-evals/discovery.json \
  --out .mod-ux/manual
npm run mod-ux -- observe --run .mod-ux/manual
```

Use the returned screenshot and accessibility elements. Copy a real element ID and the latest observation ID into one action:

```sh
node tools/mod-ux/cli.mjs act --run .mod-ux/manual \
  --observation e0002 --action '{"type":"click","element":"ID_FROM_OBSERVATION"}'
```

`act` returns the **new** observation; use its IDs next. Every action consumes its observation. Stale/expired references and concurrent writers are refused. Input failures stop the session without an automatic retry. If a process crashes with `.lock` present, first ensure it and its children have exited, then remove that run's lock manually. When an unfinished run is reopened after a crash, orphaned pending actions are marked uncertain and the run is blocked before any command proceeds. Fresh observations may inspect that blocked run but cannot unlock input. Inspect the actual UI before starting a new run; the old action is never replayed.

Resume only run directories you created and trust. Saved `session.json` includes executable and companion-socket paths that the controller reuses for observation/input; resuming an unfinished run from someone else can execute their configured program with your environment.

Some Electron surfaces expose only generic accessibility containers. A scenario can explicitly set `target.interactionMode` to `foreground` and include `click_point` in its allowed actions to enable screenshot point clicks. These focus the exact target window and can move the physical pointer. The default driver remains background-only; it never silently retries a failed background action in foreground mode. Do not use the test window or shared pointer during an automated foreground run.

```sh
node tools/mod-ux/cli.mjs finish --run .mod-ux/manual \
  --status completed --summary 'Manual tester completed the task.'
```

Direct `node` invocations produce clean JSON stdout, without npm's script banners.

The JavaScript session APIs `createSession`, `capture`, `applyAction`, `finishSession`, `reviewSession` and `runLoop` take named parameter objects. For example, `applyAction({ directory, session, driver, action, observationId, signal })` makes the run context and optional cancellation explicit. Shared JSDoc contracts in [`src/options.mjs`](src/options.mjs) define accepted session, subprocess, driver and agent options; functions reference those definitions rather than leaving forwarded options undocumented.

Supported actions:

| Action | Fields | Notes |
|---|---|---|
| `click` | `element` | Must come from the current observation |
| `click_point` | `x`, `y` | Normalized 0–1 screenshot point; requires explicit foreground mode and a provider-owned exact-window coordinate mapping |
| `type` | `text` | Single literal line; no control characters or interpreted control escapes |
| `press` | `key` | One macOS chord, such as `return`, `escape`, `cmd+a`; scenario must permit it |
| `scroll` | `element`, `direction`, `amount` | Targeted element, 1–20 units |
| `wait` | `ms` | 0–10,000; followed by a fresh capture |

A scenario can omit `press` to prevent Return submission through that action and instruct the tester not to submit, approve tools or leave the prepared session. These restrictions are not a complete security policy: clicking a visible Send button can still have effects. Use isolated accounts/workspaces and task-appropriate action restrictions. V1 does not provide an OS sandbox or semantic authorization for every clickable control.

Typing accepts the provider's documented dispatched-but-unverified outcome, then always captures a fresh observation. This is not confirmation that text arrived; the tester must inspect the frame before taking another action. An uncertain error still stops the run without a retry.

## Scenarios and observable checks

Each adopter owns its versioned JSON scenarios, for example under `your-mod/ux-evals/`. This keeps desktop scenarios separate from `claude plugin eval`'s `evals/` cases. The CLI takes an explicit file path; it does not load a default mod or discover cases inside the tool. Keep product-specific goals, selectors, state preparation and evaluation results with that product. The commands above use a placeholder path: replace it with your own scenario file.

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

Use transition checks to establish that a task was exercised, then final-state checks to establish how it ended. A final draft that already existed or an absent tip that was never shown cannot establish a successful interaction by itself. Screenshot point clicks without semantic trigger evidence cannot satisfy a check keyed to an accessibility label.

The tester receives the goal, constraints, current image/elements, allowed actions and its interaction history. It does not receive checks, the variant label, native receipts or plugin source. The critic sees evidence and checks after the interaction. Findings must reference existing event IDs and remain labeled **heuristic concerns**.

Sparse accessibility maps are explicitly marked. A selector missing from such a map is **unassessed**, because a visible control may be omitted by the platform. The critic can review the screenshot, but its interpretation remains a separate heuristic judgment. Reports include action counts and separate tester/critic model time, capture overhead, input overhead and requested waits. Pure application latency, human annoyance and transient interruptions between frames are not inferred from these totals.

`completed` means the tester said it finished. Check results, harness errors and critic availability are reported separately. `run` and manual `finish` exit nonzero for blocked/error/limit/stopped sessions, unresolved input, failed configured checks or unavailable critics. A finish request cannot replace a harness failure with completion: the actual status and error remain visible, and the requested status/summary are retained separately as `finishRequest`. Finalized interaction status, finish time, frames and checks cannot be overwritten. Repeated `stop` preserves those artifacts; further `observe` or `finish` calls are refused. A critic may still add its separate review after interaction finalization. Unassessed checks are explicit in JSON/HTML and do not establish UX success.

Exploratory runs may complete with unassessed checks and exit 0. For an acceptance or CI gate, add `--require-assessed` to `run` or `finish`: exit **0** requires at least one check and every check passed; exit **2** means checks are missing or unassessed; exit **1** takes precedence for a run failure, failed check, unresolved input or unavailable critic. An incomplete run or harness error takes priority over check results in the report headline.

For A/B work, prepare separate sessions with the desired mod/version and run the same scenario with `--variant mod-off`, `--variant current` or `--variant candidate`. These are labels only: **the runner does not toggle mods**. Keep host versions, initial state, workspace, viewport and task matched. V1 does not provide statistical comparisons or deterministic live-model replay.

## Bring another tester or critic

Pass a JSON argv array instead of `claude`:

```sh
node tools/mod-ux/cli.mjs run scenario.json --out .mod-ux/custom \
  --actor '["node","/absolute/path/to/my-tester.mjs"]' \
  --critic '["node","/absolute/path/to/my-critic.mjs"]'
```

Each invocation receives one JSON document on stdin and must emit one JSON document on stdout. Put logs on stderr. No shell is involved; use absolute script paths because agents run in an empty `agent-work` directory. The command you configure is trusted local code and inherits your environment; only the built-in Claude adapter disables its own tools/customizations.

A tester returns one of:

```json
{"status":"act","reason":"Open usage information","action":{"type":"click","element":"CURRENT_ELEMENT_ID"}}
```

```json
{"status":"done","reason":"Visible evidence that the goal was reached."}
```

```json
{"status":"blocked","reason":"The mod's entry point is not discoverable."}
```

A critic returns:

```json
{
  "summary": "One possible interruption needs review.",
  "findings": [{
    "title": "Draft disappeared after opening the pane",
    "severity": "high",
    "description": "The before frame contains a draft; the after frame is empty. The trace does not establish the underlying cause.",
    "evidence": ["e0004", "e0006", "e0007"]
  }]
}
```

## Artifacts, fidelity and current limits

Every run directory contains `session.json`, `result.json`, `report.html` and captured frames. State is written before dispatching input so an uncertain action cannot silently be retried. Each observation/action has an ID, timestamp and duration. Tester/model time is separate; capture/input durations include driver overhead and are not pure host latency. Artifacts contain screen content and entered text and are ignored by Git under `.mod-ux/`. They are not automatically redacted.

Before creating a run or capturing a screen, `start`, `run` and `demo` check the output destination with Git, resolving existing symlink parents. A destination inside a work tree must be ignored; use `.mod-ux/` or add an ignore rule for a custom directory. A destination outside Git is allowed. `--allow-unignored-output` explicitly bypasses this check, including when Git is unavailable. It does not redact captures or prevent a later manual upload.

V1 provides the complete observation → action → evidence → check/review loop. It does not yet provide a fixture browser for real native mod states, host hook telemetry, automatic resets, resizing, cross-host support, long-session workload replay, statistical A/B analysis, CI access to a real signed-in desktop, or human-calibrated annoyance estimates. AX and pixels can be captured at different moments; neither should be treated as an atomic host state. Test known-bad and good controls and review findings with people before relying on new heuristics.

The native plugin test kit remains valuable for cheap component/event regressions. This harness exercises the actual desktop host when its driver is permitted to run; it does not replace those tests.
