# What `try` does

Part of [Mod UX Lab](../README.md).

```sh
npm run mod-ux -- try plugins/dividend/ux-evals/pane.json
```

`try` takes one or more scenario files and, for each one:

1. Finds the plugin the scenario belongs to: the nearest folder above it with `.claude-plugin/plugin.json`, or `--plugin DIR`.
2. Copies that plugin into a marketplace of the run's own and installs it with `--scope local` in the plugin's test folder, `~/.mod-ux/workspaces/<plugin>`. Other installs of the same plugin are turned off for that folder only. Your own settings and installs are untouched.
3. Seeds the plugin's store from the scenario's `setup.store`, if it has one, so the run starts from a known state.
4. Opens **File > New Session in New Window**. The pop-out starts in the last folder you used; when that's the test folder, nothing else is needed. `try` reads the pop-out by its accessibility labels until its composer names a folder (`Folder: …`) or an environment (`Environment: …`), and captures it only once that is the test folder. Otherwise `try` closes it unrecorded, sets the folder with the `claude://code/new?folder=…` link and opens another. Claude Desktop asks whether to trust a folder every time a link brings one in: `try` says so and waits for you to click **Trust workspace** (it never answers a security question itself, and stops if the question names any other folder). The whole run happens in the pop-out, with no sidebar for the tester to wander into.
5. Starts the session in the pop-out by sending `setup.prompt` (default: "Reply with the single word OK."), because a plugin only runs once a session has a first message, and types `setup.draft` after it without sending it, if the scenario has one. Then it waits for the answer.
6. Runs the tester and the critic (`--critic none` to skip it) and writes the report to `.mod-ux/<scenario>-<time>/`, or `--out` for a single scenario.
7. Closes the pop-out, uninstalls the copy, and removes its marketplace, plugin cache and store, and the run's own temporary files (`--keep-workspace` keeps those, with the setup screenshots). The test folder stays, empty apart from its local settings, for the next run.

**Don't type or use the mouse while `try` has the focus.** Starting the session needed focus when this was tested (Peekaboo 4.9.8, Claude Desktop on macOS 26): Electron focuses a new window when it opens, Peekaboo's background press doesn't reach the composer's Send button, setting the prompt's value through accessibility brings the app forward, and a new pop-out's prompt isn't focused even when its window is. So setup is foreground input to the pop-out, while it has the focus it took: `try` clicks into its prompt (your pointer moves there), replaces anything left in it with the first message, sends it and types the draft. A `background` scenario then gives focus straight back to the app you were in, or to Claude's main window if that was it, and the rest of its input reaches the pop-out without focus or pointer. A `foreground` scenario keeps the focus until the run ends, so that nothing you type in between lands in the test window, and then gives it back. Dividend's scenarios are `foreground`, because Peekaboo's background press didn't reach their buttons either ([the tester and the input driver](input.md)). When the link is needed, Claude Desktop shows it in the main window, as the new-session page; go back to your session whenever you like. These are limits of that driver on those controls, not of background input in general: Codex's Computer Use did all of the input itself (see [Let Codex drive](codex-driver.md)).

**Setup checks each step.** A new-session window can open with unsent text left over from an earlier one, so the first message replaces whatever the prompt holds. `try` checks that the prompt holds exactly what it typed before it goes on; when it doesn't, `try` stops before the tester starts, says which step failed, and keeps the setup screenshots. Since setup became a foreground step, it completed in each of the four runs here.

The store seeding relies on where Claude Code keeps a plugin's `$.store` (`~/.claude/plugins/store/`), checked against Claude Code 2.1.322; it is not a documented contract. Everything else goes through `claude plugin … --json` and the `claude://` link Claude Code itself uses for `--desktop`.
