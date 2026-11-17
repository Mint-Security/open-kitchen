# Mod UX Lab

Test a Claude Desktop mod the way a user would. An AI tester gets a goal, looks at a real Claude Desktop window, and clicks and types its way through it. Code checks what the screen showed, an optional AI critic reviews the recording, and it all lands in one static HTML report.

<img src="../../.github/assets/mod-ux-demo.gif" width="460" alt="Demo: an AI agent tests Dividend, a Claude Code mod by Mint, in the real Claude Desktop. It looks at the screen, clicks Usage &amp; tips, reads the pane that opens, closes it, and finds the unsent draft still there. All four checks pass.">

The demo is a real `try` run of [Dividend's pane scenario](../../plugins/dividend/ux-evals/pane.json): the frames the harness captured, with the pointer and the highlights drawn on.

V1 targets Claude Desktop on macOS, through [Peekaboo](https://peekaboo.sh/). It runs on your machine: Mint provides no server, account or telemetry.

## Try it

**With no desktop and no model.** A synthetic demo runs the whole pipeline on generated fixtures:

```sh
npm run mod-ux -- demo --out .mod-ux/injected-bug
```

Open the run's `report.html`. The fake interface loses a draft when a pane opens, and the report shows the failed check next to its before and after frames. Add `--control` for the version that keeps the draft and passes. These are fixtures, not findings from Claude Desktop.

**On the real Claude Desktop.** You need macOS, Claude Desktop, Node.js 22+, the Claude Code CLI (2.1.322 or newer) and [Peekaboo](https://peekaboo.sh/install.html) 4.9.8 or newer, with Screen Recording and Accessibility permission:

```sh
brew install openclaw/tap/peekaboo
npm run mod-ux -- doctor
npm run mod-ux -- try plugins/dividend/ux-evals/pane.json
```

`try` takes one or more scenario files and does the whole run for each:

1. Installs the scenario's plugin for a test folder only (`~/.mod-ux/workspaces/<plugin>`) and puts its store in the state the scenario asks for. Your own installs and settings are untouched.
2. Opens a new Claude Desktop window in that folder and starts a session in it. If Claude Desktop asks whether to trust the folder, `try` waits for you: it never answers that question itself.
3. Runs the tester, the checks and the critic, and writes the report to `.mod-ux/<scenario>-<time>/`.
4. Closes the window and removes what it installed.

**Don't type or use the mouse while `try` has the focus.** It starts the session with real clicks and keys, and a `foreground` scenario, such as Dividend's, keeps the focus until the run ends. [What `try` does](docs/try.md) has every step and the reasons.

## How it works

- **The tester** is Claude by default, or any command you pass. It sees the goal, a screenshot and the window's accessibility elements, and picks one action at a time. It never sees the checks or the plugin's code.
- **The input driver** delivers each action to the test window: Peekaboo, or Codex's Computer Use with `--driver codex` (experimental).
- **The checks** are decided by code, from what was observed in the window, not by a model. One that can't be decided is reported as unassessed, never as passed.
- **The critic** reviews the recorded run afterwards. Each finding points to the events it rests on and stays labelled a heuristic concern.

## Write a scenario

A scenario is a JSON file that lives with your mod, for example under `your-mod/ux-evals/`. [Dividend's](../../plugins/dividend/ux-evals/) are working examples.

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

| Check | Passes when |
|---|---|
| `present`, `absent` | The selector is, or isn't, in the final observation |
| `preserved` | An element's value is the same before and after each click matching `after` |
| `appeared`, `disappeared` | The selector goes from absent to present, or from present to absent, across a click matching `after` |

Selectors match a visible `role`, `label` or `value` exactly. For `try`, a `setup` block can seed the plugin's store, set the session's first message and leave an unsent draft, and `target.interactionMode` chooses `background` (the default) or `foreground` input. [Scenarios and checks](docs/scenarios.md) covers the rules, the exit codes and `--require-assessed` for CI.

## Commands

Run them as `npm run mod-ux -- COMMAND`, or as `node tools/mod-ux/cli.mjs COMMAND` for clean JSON output.

| Command | What it does |
|---|---|
| `try SCENARIO...` | Installs the plugin, runs each scenario in a window of its own, and cleans up |
| `demo` | Runs the synthetic pipeline, with no desktop or model |
| `doctor` | Prints the driver's version and permission status |
| `windows` | Lists Claude Desktop's windows and their IDs |
| `run SCENARIO` | Runs the tester and the critic against a session you prepared |
| `start`, `observe`, `act`, `finish` | The same loop one step at a time, for another agent or by hand |
| `stop --run DIR` | Stops a run from another terminal |

## Limits

- It works with Claude Desktop on macOS only, and was tested on one setup (Peekaboo 4.9.8, Claude Desktop on macOS 26).
- With Peekaboo, background presses didn't reach Claude Desktop's own buttons in `try`'s window. Dividend's scenarios therefore use foreground input, which takes your pointer and the focus until the run ends. `--driver codex` does the input in the background, and is experimental.
- The tester and the critic are model calls. The goal, screenshots and visible text go to that agent's provider.
- A run's folder holds screenshots and typed text, unredacted. Runs go under `.mod-ux/`, which Git ignores.
- `completed` means the tester said it finished. The checks say whether it worked, and the critic's findings are leads to review, not verdicts.
- It doesn't replace the plugin test kit (`claude plugin test`), which stays the cheap way to catch component regressions. This one exercises the real desktop app.

## Reference

- [What `try` does](docs/try.md): every step, the focus it takes, and what it cleans up
- [Let Codex drive](docs/codex-driver.md): `--driver codex`, its isolation and its limits (experimental)
- [The tester and the input driver](docs/input.md): interaction modes, Peekaboo setup, and an assistant's own computer use
- [Running and controlling a session](docs/controller.md): `run`, the step-by-step commands, the actions, stopping, and your own tester or critic
- [Scenarios and checks](docs/scenarios.md): the format, how each check is decided, exit codes, A/B runs, artifacts, and what v1 leaves out
