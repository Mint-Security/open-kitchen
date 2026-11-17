import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPluginDir, prepareWorkspace, cleanupWorkspace, storeFile, transcriptDir, newSessionLink, mainWindow, folderChosen, trustAskedFor, startDesktopSession, frontApp } from '../src/launch.mjs';
import { validateScenario } from '../src/protocol.mjs';

const exists = path => stat(path).then(() => true, () => false);

async function fixturePlugin() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mod-ux-launch-')));
  const plugin = join(base, 'plugins', 'demo');
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
  await mkdir(join(plugin, 'node_modules', 'left-out'), { recursive: true });
  await mkdir(join(plugin, 'ux-evals'), { recursive: true });
  await writeFile(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.2.3' }));
  await writeFile(join(plugin, 'hooks.tsx'), 'export {}');
  await writeFile(join(plugin, 'ux-evals', 'case.json'), '{}');
  const home = join(base, 'home');
  await mkdir(home);
  return { base, plugin, home };
}

// A stand-in for `claude plugin …`: answers like the CLI's --json mode and records each call.
function fakeClaude({ installed = [], failOn } = {}) {
  const calls = [];
  const executeCommand = async (command, options) => {
    calls.push({ command, cwd: options?.cwd });
    if (command[0] === 'open') return { stdout: '' };
    if (command.includes('list')) return { stdout: JSON.stringify(installed) };
    if (failOn && command.includes(failOn)) return { stdout: JSON.stringify({ outcome: 'error', message: `${failOn} refused` }) };
    return { stdout: `noise\n${JSON.stringify({ outcome: 'ok' })}` };
  };
  return { calls, executeCommand };
}

test('the store file and transcript folder follow Claude Code\'s own naming', () => {
  assert.equal(storeFile('dividend@dividend-dev', '/h'), '/h/.claude/plugins/store/dividend_dividend-dev-8cee70a1dda6.json');
  assert.equal(storeFile('dividend@mint-security', '/h'), '/h/.claude/plugins/store/dividend_mint-security-a678fe772b2e.json');
  assert.equal(storeFile('plain-id', '/h'), '/h/.claude/plugins/store/plain-id.json');
  assert.equal(transcriptDir('/private/tmp/mod-ux.a/demo-ux-1', '/h'), '/h/.claude/projects/-private-tmp-mod-ux-a-demo-ux-1');
  assert.equal(newSessionLink('/tmp/a b/c'), 'claude://code/new?folder=%2Ftmp%2Fa%20b%2Fc');
});

test('a scenario finds its plugin by walking up to the nearest manifest', async () => {
  const { base, plugin } = await fixturePlugin();
  assert.equal(await findPluginDir(join(plugin, 'ux-evals', 'case.json')), plugin);
  await assert.rejects(findPluginDir(join(base, 'loose.json')), /pass --plugin DIR/);
});

test('the plugin is installed for the throwaway folder only, and cleanup undoes every trace', async () => {
  const { base, plugin, home } = await fixturePlugin();
  const installed = [
    { id: 'demo@released', enabled: true }, { id: 'demo@already-off', enabled: false },
    { id: 'demolition@other', enabled: true }, { id: 'other@released', enabled: true },
  ];
  const claude = fakeClaude({ installed });
  const store = { demo: { tips: [{ id: 't1' }] } };
  const root = join(base, 'root'); await mkdir(root);
  const workspace = await prepareWorkspace({ pluginDir: plugin, setup: { store }, home, root, claude: 'claude', executeCommand: claude.executeCommand });
  assert.match(workspace.pluginId, /^demo@mod-ux-[0-9a-f]{8}$/);
  assert.equal(workspace.version, '1.2.3');
  const scoped = claude.calls.filter(call => !call.command.includes('list'));
  assert(scoped.every(call => call.cwd === workspace.folder && call.command.includes('--scope') && call.command.at(-1) === '--json'));
  assert.deepEqual(scoped.map(call => call.command.slice(1, 3)), [['plugin', 'marketplace'], ['plugin', 'install'], ['plugin', 'disable']]);
  assert.deepEqual(workspace.disabled, ['demo@released']); // Only enabled installs of this very plugin.
  assert(scoped.every(call => call.command[call.command.indexOf('--scope') + 1] === 'local'));
  const catalog = JSON.parse(await readFile(join(workspace.catalog, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.deepEqual(catalog.plugins, [{ name: 'demo', source: './demo' }]);
  assert.deepEqual((await readdir(join(workspace.catalog, 'demo'))).sort(), ['.claude-plugin', 'hooks.tsx', 'ux-evals']);
  assert.deepEqual(JSON.parse(await readFile(workspace.store, 'utf8')), store);
  assert.equal((await stat(workspace.store)).mode & 0o777, 0o600);

  const cache = join(home, '.claude', 'plugins', 'cache', workspace.marketplace);
  await mkdir(cache, { recursive: true });
  claude.calls.length = 0;
  assert.deepEqual(await cleanupWorkspace(workspace), []);
  assert.deepEqual(claude.calls.map(call => call.command.slice(1, 4)), [['plugin', 'uninstall', workspace.pluginId], ['plugin', 'marketplace', 'remove']]);
  assert.equal(await exists(workspace.store), false);
  assert.equal(await exists(cache), false);
  assert.equal(await exists(workspace.root), false);
});

test('a refused install leaves nothing behind and says why', async () => {
  const { base, plugin, home } = await fixturePlugin();
  const root = join(base, 'root'); await mkdir(root);
  const claude = fakeClaude({ failOn: 'install' });
  await assert.rejects(prepareWorkspace({ pluginDir: plugin, setup: { store: {} }, home, root, executeCommand: claude.executeCommand }), /install refused/);
  assert.equal(await exists(root), false);
  assert(claude.calls.some(call => call.command.includes('remove'))); // The marketplace added first is removed again.
});

test('cleanup keeps going past a failing step and reports it', async () => {
  const { base, plugin, home } = await fixturePlugin();
  const root = join(base, 'root'); await mkdir(root);
  const workspace = await prepareWorkspace({ pluginDir: plugin, home, root, executeCommand: fakeClaude().executeCommand });
  workspace.executeCommand = fakeClaude({ failOn: 'uninstall' }).executeCommand;
  const failures = await cleanupWorkspace(workspace, { keepFolder: true });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^uninstall: .*uninstall refused/);
  assert.equal(await exists(workspace.folder), true);
});

test('a store file that already exists is neither reused nor deleted', async () => {
  const { base, plugin, home } = await fixturePlugin();
  const root = join(base, 'root'); await mkdir(root);
  const taken = storeFile('demo@mod-ux-deadbeef', home);
  await mkdir(join(home, '.claude', 'plugins', 'store'), { recursive: true });
  await writeFile(taken, '{"someone":"else"}');
  const claude = fakeClaude();
  await assert.rejects(prepareWorkspace({ pluginDir: plugin, setup: { store: {} }, home, root, run: 'deadbeef', executeCommand: claude.executeCommand }), /already exists/);
  assert.equal(await readFile(taken, 'utf8'), '{"someone":"else"}');
  assert(!claude.calls.some(call => call.command.includes('install'))); // Refused before installing anything.
});

test('the main window is the one titled Claude, among pop-outs titled by their session', () => {
  const window = (window_id, window_title, more = {}) => ({ window_id, window_title, is_on_screen: true, observation_capability: 'combined_eligible', ...more });
  const prewarmed = window(8, '', { is_on_screen: false, observation_capability: 'pixels_only' });
  assert.equal(mainWindow([prewarmed, window(7, 'Claude'), window(9, 'Agent memory page')]), 7);
  assert.equal(mainWindow([prewarmed, window(7, '')]), 7); // A lone window, whatever its title.
  assert.throws(() => mainWindow([prewarmed]), /0 Claude windows/);
  assert.throws(() => mainWindow([window(7, 'One'), window(9, 'Two')]), /main one/);
});

test('the composer counts as set only on the exact folder, with no trust question open', () => {
  const screen = (...elements) => ({ elements: elements.map((item, index) => ({ id: `e${index}`, ...item })) });
  const folder = '/private/tmp/mod-ux-demo-x/demo-ux-1a2b3c4d';
  assert(folderChosen(screen({ role: 'button', label: `Folder: ${folder}` }), folder));
  assert(!folderChosen(screen({ role: 'button', label: `Folder: ${folder}-other` }), folder));
  assert(!folderChosen(screen({ role: 'button', label: 'Choose folder' }), folder));
  const trustButton = { role: 'button', label: 'Trust workspace' };
  const asking = screen({ label: 'Trust this workspace?' }, { label: '', value: `/private/tmp/mod-ux-demo-x/\ndemo-ux-1a2b3c4d` }, trustButton, { role: 'button', label: `Folder: ${folder}` });
  assert(!folderChosen(asking, folder)); // The control names it before the folder is trusted.
  assert(trustAskedFor(asking, folder)); // The dialog wraps the path; line breaks don't matter.
  assert(!trustAskedFor(screen({ label: 'Trust this workspace?' }, { value: '/Users/me/real-project' }, trustButton), folder));
  assert(!trustAskedFor(screen({ value: folder }), folder)); // No question, nothing to answer.
  // A conversation quoting the dialog's words, with the folder's path, is not the dialog.
  const quoting = screen({ label: 'Trust this workspace?' }, { label: folder }, { role: 'button', label: `Folder: ${folder}` });
  assert(!trustAskedFor(quoting, folder));
  assert(folderChosen(quoting, folder));
  // Under your home folder, Claude Desktop names it with ~.
  assert(folderChosen(screen({ role: 'button', label: 'Folder: ~/.mod-ux/workspaces/demo' }), '/Users/me/.mod-ux/workspaces/demo', '/Users/me'));
  assert(!folderChosen(screen({ role: 'button', label: 'Folder: ~/.mod-ux/workspaces/demo' }), '/Users/other/.mod-ux/workspaces/demo', '/Users/me'));
  assert(!folderChosen(screen({ role: 'text', label: `Folder: ${folder}` }), folder)); // Only the composer's control counts.
});

// A Claude Desktop stand-in: a main window, and pop-outs that open from the menu in the last folder
// used. The link sets that folder once the person trusts it, after `trustAfter` looks at the main
// window (never, with Infinity); `trustPath` is the path the trust dialog names. Typed text shows
// in the prompt one look later, as on the real app; Return sends it and empties the prompt.
function fakeDesktop({ folder, lastFolder = folder, leftover = '\n', environment, trustPath = folder, trustAfter = 2, popoutShows = true, answers = true, workspace, home, opened = [] }) {
  const log = [];
  let mainLooks = 0, nextId = 3, linked = false, looks = 0;
  const used = new Set(); // Like Peekaboo's, an observation drives one action.
  const popouts = new Map(); // id -> { prompt, pending, folder }
  // Claude Desktop names some locations as environments ("Environment: <name>") rather than by path.
  const location = shown => (environment && shown !== folder ? `Environment: ${environment}` : `Folder: ${shown}`);
  const windows = () => [
    { window_id: 1, window_title: 'Claude', is_on_screen: true, observation_capability: 'combined_eligible' },
    { window_id: 2, window_title: 'Mine, popped out', is_on_screen: true, observation_capability: 'combined_eligible' },
    ...[...popouts.keys()].map(id => ({ window_id: id, window_title: 'New session', is_on_screen: true, observation_capability: 'combined_eligible' })),
  ];
  const original = workspace.executeCommand;
  workspace.executeCommand = async (command, options) => {
    if (command[0] === 'open') { log.push(['link', command.slice(1)]); linked = true; return { stdout: '' }; }
    return original(command, options);
  };
  const desktop = {
    async windows() { return windows(); },
    async menu(path) { log.push(['menu', path]); if (popoutShows) popouts.set(nextId++, { prompt: leftover, pending: undefined, folder: lastFolder }); },
    async inspect(id) { log.push(['inspect', id]); return { elements: [{ id: 'f', role: 'button', label: location(popouts.get(id).folder) }] }; },
    async focusWindow(id) { log.push(['focus', id]); },
    async closeWindow(id) { log.push(['close', id]); popouts.delete(id); },
  };
  const driverFor = (windowId, mode = 'background') => ({
    async observe() {
      log.push(['observe', windowId]);
      if (windowId === 1) {
        if (!linked) return { id: 'w1', elements: [] };
        if (++mainLooks <= trustAfter) return { id: 'w1', elements: [{ id: 'q', label: 'Trust this workspace?' }, { id: 'p', label: '', value: trustPath }, { id: 'trust', role: 'button', label: 'Trust workspace' }] };
        lastFolder = folder;
        return { id: 'w1', elements: [{ id: 'f', role: 'button', label: `Folder: ${folder}` }] };
      }
      const window = popouts.get(windowId);
      if (window.pending !== undefined) { window.prompt = window.pending; window.pending = undefined; }
      const send = window.prompt.trim() ? [{ id: 'send', role: 'button', label: 'Send' }] : [];
      return { id: `w${windowId}-${++looks}`, elements: [{ id: 'f', role: 'button', label: location(window.folder) }, { id: 'prompt', role: 'textField', label: 'Prompt', value: window.prompt }, ...send] };
    },
    async setValue(element, value, observation) {
      log.push(['set', windowId, element, value, observation.id]);
      popouts.get(windowId).pending = value;
      return { unverified: true };
    },
    async act(action, observation) {
      log.push(['act', windowId, action, observation.id, mode]);
      if (used.has(observation.id)) throw new Error(`Snapshot is stale: ${observation.id} already drove an action`);
      used.add(observation.id);
      const window = popouts.get(windowId);
      if (action.type === 'type') window.pending = (action.replace || !window.prompt.trim() ? '' : window.prompt) + action.text;
      if (action.type === 'press' && action.key === 'return') {
        window.prompt = '\n';
        if (answers) {
          const directory = transcriptDir(workspace.folder, home);
          await mkdir(directory, { recursive: true });
          await writeFile(join(directory, 'this-session.jsonl'), '{"type":"user"}\n{"type":"assistant","message":{}}\n');
        }
      }
      return {};
    },
  });
  return { desktop, driverFor, log, onWindow: id => opened.push(id) };
}

// The front app, as osascript reports it, and every activation asked for.
function withFrontApp(workspace, front) {
  const activations = [];
  const original = workspace.executeCommand;
  workspace.executeCommand = async (command, options) => {
    if (command[0] !== 'osascript') return original(command, options);
    if (command.at(-1).includes('frontmostApplication')) return { stdout: JSON.stringify(front) };
    activations.push(command.at(-1));
    return { stdout: '' };
  };
  return activations;
}

async function preparedWorkspace() {
  const { base, plugin, home } = await fixturePlugin();
  const root = join(base, 'root'); await mkdir(root);
  const claude = fakeClaude();
  const workspace = await prepareWorkspace({ pluginDir: plugin, home, root, executeCommand: claude.executeCommand });
  return { workspace, home, root, claude, folderName: workspace.folder.split('/').at(-1) };
}

const launch = (prepared, fake, extra = {}) => startDesktopSession({ workspace: prepared.workspace, desktop: fake.desktop, driverFor: fake.driverFor, onWindow: fake.onWindow, screenshots: join(prepared.root, `setup-${Math.random()}`), pollMs: 5, timeoutMs: 3000, ...extra });

test('a new window already in the test folder needs no link and no trust question', async () => {
  const prepared = await preparedWorkspace();
  const activations = withFrontApp(prepared.workspace, { pid: 4242, bundle: 'com.google.Chrome' });
  // A new-session pop-out can open with unsent text left from an earlier one.
  const fake = fakeDesktop({ folder: prepared.workspace.folder, leftover: 'Left from last time', workspace: prepared.workspace, home: prepared.home });
  const notices = [];
  const { windowId } = await launch(prepared, fake, { setup: { prompt: 'Say OK.', draft: 'Unsent draft' }, onNotice: message => notices.push(message) });
  assert.equal(windowId, 3);
  assert.deepEqual(notices, []);
  assert(!fake.log.some(entry => entry[0] === 'link'));
  // Nothing reaches the main window. Setup is foreground input to the new window while it holds the
  // focus it took on opening: a click into the prompt, the first message replacing what was left
  // there, Return only once the text has landed, then the draft.
  const acts = fake.log.filter(entry => entry[0] === 'act');
  assert(acts.every(entry => entry[1] === 3 && entry[4] === 'foreground'));
  assert.deepEqual(acts.map(entry => entry[2]), [{ type: 'click', element: 'prompt' }, { type: 'type', text: 'Say OK.', replace: true }, { type: 'press', key: 'return' }, { type: 'type', text: 'Unsent draft' }]);
  const typedAt = fake.log.indexOf(acts[1]), returnAt = fake.log.indexOf(acts[2]);
  assert(fake.log.slice(typedAt + 1, returnAt).filter(entry => entry[0] === 'observe').length >= 1); // Return once a look shows the text.
  assert(!fake.log.some(entry => entry[0] === 'set')); // Setting the value would bring the app forward.
  // Focus goes back once, right after the draft is typed.
  assert.equal(activations.length, 1);
  assert.match(activations[0], /runningApplicationWithProcessIdentifier\(4242\)\.activateWithOptions/);
});

test('a new window in another folder is closed; the link sets the folder, and its trust question is left to you', async () => {
  const prepared = await preparedWorkspace();
  withFrontApp(prepared.workspace, { pid: 4242, bundle: 'com.google.Chrome' });
  const opened = [];
  const fake = fakeDesktop({ folder: prepared.workspace.folder, lastFolder: '/Users/me/some-project', trustAfter: 3, workspace: prepared.workspace, home: prepared.home, opened });
  const notices = [];
  const { windowId } = await launch(prepared, fake, { onNotice: message => notices.push(message) });
  assert.equal(windowId, 4);
  assert.deepEqual(opened, [3, 4]); // Each window is reported as it opens, so a failed setup can close it.
  assert(fake.log.some(entry => entry[0] === 'close' && entry[1] === 3));
  assert(!fake.log.some(entry => entry[0] === 'observe' && entry[1] === 3)); // Read by its labels alone, never captured.
  assert(fake.log.some(entry => entry[0] === 'inspect' && entry[1] === 3));
  assert.deepEqual(fake.log.find(entry => entry[0] === 'link')[1], ['-g', newSessionLink(prepared.workspace.folder)]);
  assert.equal(notices.length, 1); // Asked once, however long the person takes.
  assert(notices[0].includes(prepared.workspace.folder));
  assert(!fake.log.some(entry => ['act', 'set'].includes(entry[0]) && entry[1] === 1)); // The trust question is never answered for you.
});

test('a new window in a named environment is another folder: closed unrecorded, and the link sets the folder', async () => {
  const prepared = await preparedWorkspace();
  withFrontApp(prepared.workspace, { pid: 4242, bundle: 'com.google.Chrome' });
  const fake = fakeDesktop({ folder: prepared.workspace.folder, lastFolder: '/Users/me/some-repo', environment: 'some-repo', trustAfter: 0, workspace: prepared.workspace, home: prepared.home });
  assert.equal((await launch(prepared, fake)).windowId, 4);
  assert(fake.log.some(entry => entry[0] === 'close' && entry[1] === 3));
  assert(!fake.log.some(entry => entry[0] === 'observe' && entry[1] === 3));
  assert(fake.log.some(entry => entry[0] === 'link'));
});

test('a foreground run keeps the focus through setup, and gets it back once when it ends', async () => {
  const prepared = await preparedWorkspace();
  const activations = withFrontApp(prepared.workspace, { pid: 4242, bundle: 'com.google.Chrome' });
  const fake = fakeDesktop({ folder: prepared.workspace.folder, workspace: prepared.workspace, home: prepared.home });
  const started = await launch(prepared, fake, { setup: { draft: 'Unsent draft' }, keepFocus: true });
  assert.equal(activations.length, 0); // Nothing you type meanwhile can land in the test window.
  await started.focusBack();
  await started.focusBack();
  assert.equal(activations.length, 1);
  // A background run had it back already: its focusBack does nothing more.
  const other = await preparedWorkspace();
  const otherActivations = withFrontApp(other.workspace, { pid: 4242, bundle: 'com.google.Chrome' });
  const background = await launch(other, fakeDesktop({ folder: other.workspace.folder, workspace: other.workspace, home: other.home }));
  assert.equal(otherActivations.length, 1);
  await background.focusBack();
  assert.equal(otherActivations.length, 1);
});

test('when you were in Claude, focus goes back to its main window', async () => {
  const prepared = await preparedWorkspace();
  const activations = withFrontApp(prepared.workspace, { pid: 77, bundle: 'com.anthropic.claudefordesktop' });
  const fake = fakeDesktop({ folder: prepared.workspace.folder, workspace: prepared.workspace, home: prepared.home });
  await launch(prepared, fake);
  assert.deepEqual(fake.log.filter(entry => entry[0] === 'focus'), [['focus', 1]]);
  assert.equal(activations.length, 0);
});

test('a trust question about any other folder is left alone and stops the launch', async () => {
  const prepared = await preparedWorkspace();
  withFrontApp(prepared.workspace, { pid: 4242, bundle: 'com.google.Chrome' });
  const opened = [];
  const fake = fakeDesktop({ folder: prepared.workspace.folder, lastFolder: '/Users/me/some-project', trustPath: '/Users/me/real-project', workspace: prepared.workspace, home: prepared.home, opened });
  await assert.rejects(launch(prepared, fake), /other than the test folder/);
  assert(!fake.log.some(entry => entry[0] === 'act' && entry[1] === 1));
});

test('no window, no folder, or no answer stops the launch with a reason', async () => {
  const first = await preparedWorkspace();
  withFrontApp(first.workspace, { pid: 4242, bundle: 'com.google.Chrome' });
  await assert.rejects(launch(first, fakeDesktop({ folder: first.workspace.folder, popoutShows: false, workspace: first.workspace, home: first.home }), { timeoutMs: 200 }), /did not open a new session window/);
  const second = await preparedWorkspace();
  withFrontApp(second.workspace, { pid: 4242, bundle: 'com.google.Chrome' });
  const silent = fakeDesktop({ folder: second.workspace.folder, answers: false, workspace: second.workspace, home: second.home });
  await assert.rejects(launch(second, silent, { timeoutMs: 300 }), /got no answer/);
  assert.deepEqual(silent.log.find(entry => entry[0] === 'act' && entry[2].type === 'type')[2], { type: 'type', text: 'Reply with the single word OK.', replace: true }); // The default first message.
  // A setup that keeps the focus for a foreground run still gives it back when it fails.
  const kept = await preparedWorkspace();
  const keptActivations = withFrontApp(kept.workspace, { pid: 4242, bundle: 'com.google.Chrome' });
  await assert.rejects(launch(kept, fakeDesktop({ folder: kept.workspace.folder, answers: false, workspace: kept.workspace, home: kept.home }), { timeoutMs: 300, keepFocus: true }), /got no answer/);
  assert.equal(keptActivations.length, 1);
  const third = await preparedWorkspace();
  withFrontApp(third.workspace, { pid: 4242, bundle: 'com.google.Chrome' });
  const elsewhere = fakeDesktop({ folder: '/somewhere/else', lastFolder: '/Users/me/some-project', trustAfter: 0, workspace: third.workspace, home: third.home });
  await assert.rejects(launch(third, elsewhere, { timeoutMs: 300 }), /did not take .*\(it showed Folder: \/somewhere\/else\)/);
});

test('a transcript from an earlier run in the reused folder is not taken for this session\'s answer', async () => {
  const prepared = await preparedWorkspace();
  withFrontApp(prepared.workspace, { pid: 4242, bundle: 'com.google.Chrome' });
  const directory = transcriptDir(prepared.workspace.folder, prepared.home);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'earlier.jsonl'), '{"type":"assistant","message":{}}\n');
  const silent = fakeDesktop({ folder: prepared.workspace.folder, answers: false, workspace: prepared.workspace, home: prepared.home });
  await assert.rejects(launch(prepared, silent, { timeoutMs: 300 }), /got no answer/);
});

test('the test folder is kept for the next run; only the run\'s own files go', async () => {
  const { workspace } = await preparedWorkspace();
  assert(workspace.folder.endsWith('/.mod-ux/workspaces/demo'));
  assert.deepEqual(await cleanupWorkspace(workspace), []);
  assert.equal(await exists(workspace.folder), true);
  assert.equal(await exists(workspace.root), false);
});

test('a scenario setup is limited to store, prompt and draft, in plain one-line text', async () => {
  const base = { version: 1, name: 'n', goal: 'g', target: { app: 'com.anthropic.claudefordesktop' } };
  assert.doesNotThrow(() => validateScenario({ ...base, setup: { store: { a: 1 }, prompt: 'Say OK.', draft: 'Draft — unsent' } }));
  assert.throws(() => validateScenario({ ...base, setup: { install: true } }), /store, prompt and draft/);
  assert.throws(() => validateScenario({ ...base, setup: { prompt: 'two\nlines' } }), /one line/);
  assert.throws(() => validateScenario({ ...base, setup: { draft: 'escaped \\n newline' } }), /one line/);
  assert.throws(() => validateScenario({ ...base, setup: { store: [] } }), /must be an object/);
  for (const name of ['discovery', 'pane', 'dismiss']) {
    const scenario = validateScenario(JSON.parse(await readFile(new URL(`../../../plugins/dividend/ux-evals/${name}.json`, import.meta.url), 'utf8')));
    assert(scenario.setup.store.dividend.tips.length === 1);
    // Peekaboo's background press doesn't reach Claude Desktop's buttons in try's window.
    assert.equal(scenario.target.interactionMode, 'foreground');
  }
});

test('a locked Mac stops the launch before anything else happens', async () => {
  const locked = async () => ({ stdout: JSON.stringify({ pid: 120, bundle: 'com.apple.loginwindow' }) });
  await assert.rejects(frontApp(locked), /Mac is locked/);
  assert.deepEqual(await frontApp(async () => ({ stdout: JSON.stringify({ pid: 9, bundle: 'com.google.Chrome' }) })), { pid: 9, bundle: 'com.google.Chrome' });
});
