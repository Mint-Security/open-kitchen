# The tester and the input driver

Part of [Mod UX Lab](../README.md).

Two separate parts act on the desktop. The **tester** (`--actor`: Claude, or any command) only chooses the next action. The **input driver**, Peekaboo, delivers it. Which model tests, and whether you launch the CLI from a terminal, a background process or another agent, doesn't change how input is delivered.

| Scenario `target.interactionMode` | How input reaches the window | Your pointer and front app |
|---|---|---|
| `background` (the default) | Accessibility actions on an element; `click_point` as an accessibility press at a window-relative point; typing and keys to the window when it holds the app's keyboard focus, otherwise typing sets its one text field's value | Untouched, except that setting a value in Claude Desktop brings it forward |
| `foreground` | Focuses the target window and synthesizes shared input (`--foreground --input-strategy synthOnly`) | Taken over until the run ends, when `try` gives focus back; don't use the Mac meanwhile |

Electron nests Claude Desktop's controls deep in its accessibility tree. With Peekaboo 4.9.8's default traversal limits, only the window chrome was visible in testing, which looks like an inaccessible app; the driver passes `--depth 80 --max-elements 3000 --max-children 500`, which reached the prompt box (with its value) and a plugin's buttons. A control that is still missing can be reached with `click_point` if the scenario allows it. In the background, both kinds of click are accessibility presses, so they reach only controls that accept one. In the tested setup (Peekaboo 4.9.8, Claude Desktop on macOS 26), Claude Desktop's own controls didn't, in `try`'s pop-out: not the composer's (Send, the folder picker), not the trust dialog, and not a plugin's buttons. Peekaboo's debug log showed why for Dividend's **Usage & tips**: its direct press of the element failed (`actionUnsupported`), and its fallback, a press of whatever accessibility element is at the element's point, found nothing pressable there. In one of those runs the typed draft was sent during that click, for a reason not found. Passing `--input-strategy actionOnly` didn't change this: Peekaboo's helper app does the click and keeps its own strategy. In `foreground` mode the same click is a real one at the element, and opened Dividend's pane. The driver never upgrades a background run to foreground on its own.

This harness's Claude adapter is a tester and critic model; Peekaboo, or Codex with `--driver codex`, delivers the input. It doesn't use Claude's own computer use.

## Prepare the desktop driver

Install the signed CLI from its [official source](https://peekaboo.sh/install.html):

```sh
brew install openclaw/tap/peekaboo
peekaboo --version
npm run mod-ux -- doctor
```

The adapter was developed against Peekaboo **4.9.8**. It requires producer-bound `ps1_…` snapshots, `--fresh`, `snapshot_reusable` and `mutation_targeting_available` evidence. It refuses older/partial observations instead of using a global input fallback. An alternative executable can be supplied with `MOD_UX_PEEKABOO=/absolute/path/to/peekaboo`.

To pin the signed companion host for a background runner, set `PEEKABOO_BRIDGE_SOCKET` to its `~/Library/Application Support/Peekaboo/bridge.sock` path. The selected path is saved with new runs. It must belong to a healthy, authorized Peekaboo host. This picks the process that delivers input; it doesn't create a separate desktop or change the scenario's interaction mode.

Peekaboo needs Screen Recording and Accessibility permission for its selected execution host. Follow [its permission instructions](https://peekaboo.sh/permissions.html); a background terminal may require the signed Peekaboo companion/Bridge host. Grant permission only after reviewing which executable/host receives it. The harness does not request, grant or bypass OS permissions. `doctor` prints the driver's reported status without capturing a screen. A successful diagnostic alone does not establish that observation/input works.

## Review with a native controller on its own

Codex and Claude can also operate apps themselves, with no harness involved. They collect their own screenshots and notes, with no harness trace, checks or report, and a controller's statement that it finished is not a harness pass. With `--driver codex`, Codex is instead the input driver for a harness run ([Let Codex drive](codex-driver.md)).

- **Codex**: per [its documentation](https://learn.chatgpt.com/docs/computer-use), Computer Use can work in the background on macOS; on Windows it uses the active desktop.
- **Claude Desktop**: per [its documentation](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork), working in the background is the default on macOS 15 or later. If it keeps taking over the screen, check that **How Claude uses the apps you allow**, under Computer use in Settings, isn't set to **Full control**. That setting doesn't affect Peekaboo.
- **Claude Code's CLI**: its built-in `computer-use` MCP server, enabled through `/mcp`, hides other visible apps while it works, allows one session at a time, and isn't available with `-p` ([documentation](https://code.claude.com/docs/en/computer-use)).

None of these was tested here for window isolation, apart from the Codex observation in [Let Codex drive](codex-driver.md). Naming the test window in the task is a request, not a guarantee, so close or minimize windows with sensitive content first. Copy the scenario's goal, constraints, allowed actions and limits into the task; for discoverability, keep the checks and the plugin's code out of it. For example:

```text
Use your native Computer Use tools to review the prepared Claude Desktop window on macOS.
Work only in the Claude Desktop window titled "[test window title]". Do not capture, click or type in any other window.
Use background app control only. Stop and explain if an action needs foreground or shared input.
Task, constraints and allowed actions: [copy from the chosen scenario].
Action and time limits: [copy from the chosen scenario].
Record actions and before/after screenshots under .mod-ux/native-review/.
Separate observed failures, possible UX friction and checks you could not assess.
Do not start a mod-ux run or call mod-ux act.
```
