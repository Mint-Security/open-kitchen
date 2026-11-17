# Running and controlling a session

Part of [Mod UX Lab](../README.md).

## Prepare a disposable Claude Desktop session

`try` does all of this for you. These steps are for `start` and `run`, which attach to a session you prepared:

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

These commands use the same Peekaboo driver and scenario mode as `run`, whichever assistant calls them. For an assistant's own computer use, see [Review with a native controller on its own](input.md#review-with-a-native-controller-on-its-own).

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

Observations read the accessibility tree deeply enough for Claude Desktop's controls (see [the tester and the input driver](input.md)). Where a control is still missing, a scenario can allow `click_point`: in background mode it is an accessibility press at a window-relative point in the exact window, without moving the pointer, so it reaches only controls that accept one; with `target.interactionMode` set to `foreground` it focuses the window and uses the shared pointer instead. The driver never silently retries a failed background action in foreground mode.

```sh
node tools/mod-ux/cli.mjs finish --run .mod-ux/manual \
  --status completed --summary 'Manual tester completed the task.'
```

Direct `node` invocations produce clean JSON stdout, without npm's script banners.

The JavaScript session APIs `createSession`, `capture`, `applyAction`, `finishSession`, `reviewSession` and `runLoop` take named parameter objects. For example, `applyAction({ directory, session, driver, action, observationId, signal })` makes the run context and optional cancellation explicit. Shared JSDoc contracts in [`src/options.mjs`](../src/options.mjs) define accepted session, subprocess, driver and agent options; functions reference those definitions rather than leaving forwarded options undocumented.

Supported actions:

| Action | Fields | Notes |
|---|---|---|
| `click` | `element` | Must come from the current observation |
| `click_point` | `x`, `y` | Normalized 0–1 screenshot point; needs a provider-owned exact-window coordinate mapping. Background by default (pointer untouched); focused shared input only in `foreground` mode |
| `type` | `text` | Single literal line; no control characters or interpreted control escapes |
| `press` | `key` | One macOS chord, such as `return`, `escape`, `cmd+a`; scenario must permit it |
| `scroll` | `element`, `direction`, `amount` | Targeted element, 1–20 units |
| `wait` | `ms` | 0–10,000; followed by a fresh capture |

A scenario can omit `press` to prevent Return submission through that action and instruct the tester not to submit, approve tools or leave the prepared session. These restrictions are not a complete security policy: clicking a visible Send button can still have effects. Use isolated accounts/workspaces and task-appropriate action restrictions. V1 does not provide an OS sandbox or semantic authorization for every clickable control.

Typing accepts the provider's documented dispatched-but-unverified outcome, then always captures a fresh observation. This is not confirmation that text arrived; the tester must inspect the frame before taking another action. An uncertain error still stops the run without a retry.

## Bring another tester or critic

A different tester changes who decides, not how input is delivered: every action still goes through the input driver and the scenario's mode. Only `try --driver codex` changes the input driver; a Codex CLI passed as `--actor` is a tester like any other, with Peekaboo delivering its actions. Pass a JSON argv array instead of `claude`:

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
