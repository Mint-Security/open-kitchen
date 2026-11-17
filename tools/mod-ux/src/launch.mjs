// One-command desktop runs: install the plugin under test for one test folder only, open that
// folder as a new Claude Desktop Code session, start the session and hand it to the run loop.
// The test folder is kept per plugin (~/.mod-ux/workspaces/<plugin>) so Claude Desktop's trust
// question comes up once, for you to answer; each run's plugin copy, marketplace and store are its
// own and cleanup() removes them, with the registrations `claude plugin` keeps for any install.
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { execute, parseJSON } from './process.mjs';
import { assert, DEFAULT_APP } from './protocol.mjs';

const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SKIPPED = new Set(['node_modules', '.git', '.mod-ux']);

// The plugin a scenario belongs to: the nearest folder above it with a plugin manifest.
export async function findPluginDir(scenarioFile) {
  for (let directory = dirname(resolve(scenarioFile)); ; directory = dirname(directory)) {
    try { await stat(join(directory, '.claude-plugin', 'plugin.json')); return directory; } catch {}
    assert(directory !== dirname(directory), `No .claude-plugin/plugin.json above ${scenarioFile}; pass --plugin DIR`);
  }
}

export async function pluginName(pluginDir) {
  const manifest = JSON.parse(await readFile(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert(typeof manifest.name === 'string' && PLUGIN_NAME.test(manifest.name), 'The plugin manifest needs a lowercase name');
  return { name: manifest.name, version: typeof manifest.version === 'string' ? manifest.version : undefined };
}

// Claude Code keeps each plugin's $.store in ~/.claude/plugins/store, one JSON file per plugin id.
// Not a documented contract: checked against Claude Code 2.1.322.
export function storeFile(pluginId, home = homedir()) {
  const plain = /^[a-z0-9._-]+$/.test(pluginId) && pluginId.length <= 64 && pluginId !== '.' && pluginId !== '..';
  const name = plain ? `${pluginId}.json` : `${pluginId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'plugin'}-${createHash('sha256').update(pluginId).digest('hex').slice(0, 12)}.json`;
  return join(home, '.claude', 'plugins', 'store', name);
}

// Where Claude Code writes a folder's session transcripts.
export function transcriptDir(folder, home = homedir()) {
  return join(home, '.claude', 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-'));
}

export function newSessionLink(folder) {
  return `claude://code/new?folder=${encodeURIComponent(folder)}`;
}

/**
 * Copies the plugin into this run's own marketplace and installs it with local scope in the
 * plugin's test folder, where other installs of the same plugin are disabled. Seeds its store when asked.
 * @param {{ pluginDir: string, setup?: { store?: object }, claude?: string, home?: string, root?: string, folder?: string, run?: string, executeCommand?: Function, signal?: AbortSignal }} options
 */
export async function prepareWorkspace({ pluginDir, setup = {}, claude = process.env.MOD_UX_CLAUDE || 'claude', home = homedir(), root, folder, run = randomBytes(4).toString('hex'), executeCommand = execute, signal }) {
  const { name, version } = await pluginName(pluginDir);
  assert(/^[0-9a-f]{8}$/.test(run), 'A run id is 8 hex digits');
  root = await realpath(root ?? await mkdtemp(join(tmpdir(), `mod-ux-${name}-`)));
  const marketplace = `mod-ux-${run}`;
  const pluginId = `${name}@${marketplace}`;
  folder ??= join(home, '.mod-ux', 'workspaces', name);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  folder = await realpath(folder);
  const catalog = join(root, 'marketplace');
  await mkdir(join(catalog, '.claude-plugin'), { recursive: true, mode: 0o700 });
  await cp(pluginDir, join(catalog, name), { recursive: true, filter: source => !SKIPPED.has(basename(source)) });
  await writeFile(join(catalog, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: marketplace, owner: { name: 'Mod UX Lab' },
    metadata: { description: `A throwaway copy of ${name} for one Mod UX Lab run` },
    plugins: [{ name, source: `./${name}` }],
  }, null, 2));

  const workspace = { root, folder, catalog, marketplace, pluginId, name, version, home, store: storeFile(pluginId, home), disabled: [], claude, executeCommand };
  const plugin = args => runClaude(workspace, ['plugin', ...args], signal);
  // The id is new, so its store is too; one that exists belongs to something else and stays.
  workspace.storeExisted = await stat(workspace.store).then(() => true, () => false);
  try {
    assert(!workspace.storeExisted, `${workspace.store} already exists; refusing to reuse it`);
    await plugin(['marketplace', 'add', catalog, '--scope', 'local']);
    await plugin(['install', pluginId, '--scope', 'local']);
    const installed = parseJSON((await executeCommand([claude, 'plugin', 'list', '--json'], { cwd: folder, signal, timeoutMs: 60000 })).stdout);
    for (const other of installed.filter(item => item.enabled && item.id !== pluginId && item.id.startsWith(`${name}@`))) {
      await plugin(['disable', other.id, '--scope', 'local']);
      workspace.disabled.push(other.id);
    }
    if (setup.store !== undefined) {
      await mkdir(dirname(workspace.store), { recursive: true, mode: 0o700 });
      await writeFile(workspace.store, JSON.stringify(setup.store), { flag: 'wx', mode: 0o600 });
    }
  } catch (error) {
    await cleanupWorkspace(workspace);
    throw error;
  }
  return workspace;
}

async function runClaude(workspace, args, signal) {
  const { stdout } = await workspace.executeCommand([workspace.claude, ...args, '--json'], { cwd: workspace.folder, signal, timeoutMs: 120000 });
  const result = parseJSON(stdout.trim().split('\n').at(-1));
  assert(result.outcome === 'ok', `claude ${args.join(' ')}: ${result.message ?? JSON.stringify(result)}`);
  return result;
}

// Undoes prepareWorkspace, keeping only the (empty) test folder. Each step runs even when an earlier
// one fails; every failure is reported. keepFolder keeps the run's own files (its setup screenshots).
export async function cleanupWorkspace(workspace, { keepFolder = false } = {}) {
  const failures = [];
  const attempt = async (what, step) => { try { await step(); } catch (error) { failures.push(`${what}: ${error.message}`); } };
  await attempt('uninstall', () => runClaude(workspace, ['plugin', 'uninstall', workspace.pluginId, '--scope', 'local'], undefined));
  await attempt('marketplace', () => runClaude(workspace, ['plugin', 'marketplace', 'remove', workspace.marketplace], undefined));
  // Removing a marketplace leaves its plugin cache and the plugin's store behind.
  await attempt('cache', () => rm(join(workspace.home, '.claude', 'plugins', 'cache', workspace.marketplace), { recursive: true, force: true }));
  if (!workspace.storeExisted) await attempt('store', () => rm(workspace.store, { force: true }));
  if (!keepFolder) await attempt('run files', () => rm(workspace.root, { recursive: true, force: true }));
  return failures;
}

const observable = windows => windows.filter(item => item.is_on_screen !== false && !item.is_minimized && item.window_id !== undefined && item.observation_capability !== 'pixels_only');

// Claude Desktop's main window: titled "Claude", where pop-out windows carry their session's title.
export function mainWindow(windows) {
  const shown = observable(windows);
  const titled = shown.filter(item => item.window_title === 'Claude');
  const found = titled.length === 1 ? titled : shown.length === 1 ? shown : [];
  assert(found.length === 1, `Couldn't tell which of ${shown.length} Claude windows is the main one (titled "Claude")`);
  return found[0].window_id;
}

const compact = text => String(text ?? '').replace(/\s+/g, '');
// The trust dialog itself, not a conversation that happens to quote its words: its title and its
// Trust workspace button.
const trustAsked = observation => observation.elements.some(item => item.label === 'Trust this workspace?') &&
  observation.elements.some(item => item.role === 'button' && item.label === 'Trust workspace');

// The composer's folder control names the folder by path, or under your home folder as ~/…
const folderLabels = (folder, home = homedir()) => {
  const labels = [`Folder: ${folder}`];
  if (folder.startsWith(`${home}/`)) labels.push(`Folder: ~${folder.slice(home.length)}`);
  return labels;
};

// Whether a new session's composer names the folder, as a window starting a session there shows.
export function showsFolder(observation, folder, home) {
  const labels = folderLabels(folder, home);
  return observation.elements.some(item => item.role === 'button' && labels.includes(item.label));
}

// Whether the composer is set to the folder, with no trust question about it still open.
export function folderChosen(observation, folder, home) {
  return showsFolder(observation, folder, home) && !trustAsked(observation);
}

// The composer's location control, once it has drawn: "Folder: <path>" for a folder, or
// "Environment: <name>" for one Claude Desktop knows as an environment.
const shownFolders = observation => observation.elements.filter(item => item.role === 'button' && /^(Folder|Environment): /.test(String(item.label))).map(item => item.label);

// The trust dialog shows the path it asks about. Only the throwaway folder, exactly, is answered.
export function trustAskedFor(observation, folder) {
  return trustAsked(observation) && observation.elements.some(item => compact(item.label) === compact(folder) || compact(item.value) === compact(folder));
}

const FRONT_APP = 'ObjC.import("AppKit"); var a = $.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({ pid: a.processIdentifier, bundle: a.bundleIdentifier.js })';

export async function frontApp(executeCommand, signal) {
  const front = JSON.parse((await executeCommand(['osascript', '-l', 'JavaScript', '-e', FRONT_APP], { signal, timeoutMs: 10000 })).stdout.trim());
  assert(Number.isInteger(front.pid) && front.pid > 0, 'Could not tell which app is in front');
  // macOS allows no screen capture while locked, and every step needs one.
  assert(front.bundle !== 'com.apple.loginwindow', 'Your Mac is locked; unlock it and run again');
  return front;
}

// Electron focuses a window when it shows one, so a new pop-out takes focus once; hand it back.
export async function giveFocusBack({ executeCommand, desktop, front, main, signal }) {
  if (front.bundle === DEFAULT_APP) return desktop.focusWindow(main, { signal }); // You were in Claude: its main window.
  await executeCommand(['osascript', '-l', 'JavaScript', '-e', `ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${front.pid}).activateWithOptions(0)`], { signal, timeoutMs: 10000 });
}

/**
 * Opens a new Desktop Code session for the test folder in a window of its own and starts it.
 *
 * "New Session in New Window" opens a pop-out whose composer starts in the last folder used. When
 * that is already the test folder, nothing else is needed. Otherwise the claude://code/new link
 * sets it, in the main window, which is where Claude Desktop sends such links; Desktop then asks
 * whether to trust the folder, every time a link brings one in, and that question is left to you.
 *
 * Peekaboo can't start the session in the background: its background press doesn't reach the
 * composer's Send button, setting the prompt's value brings the app forward, and a new pop-out's
 * prompt isn't focused even when its window is. But Electron focuses a new window when it shows
 * it anyway, so setup is one short foreground step in that moment: a click puts the caret in the
 * prompt, the first message replaces whatever was left there and is sent, the draft is typed, and
 * focus goes back where it was. The answer is awaited after that, with focus back with you. For a
 * foreground run (keepFocus), the window keeps the focus instead, so that nothing you type lands in
 * it when the run takes it again; the run gives it back with focusBack when it ends. A failed setup
 * gives it back either way.
 * Returns the pop-out's window id and focusBack, which acts once; onWindow hears of every pop-out as
 * soon as it opens, so a failed setup can still close it.
 * @param {{ workspace: object, desktop: { windows: Function, inspect: Function, menu: Function, focusWindow: Function, closeWindow: Function }, driverFor: (windowId: number, interactionMode?: string) => object, setup?: { prompt?: string, draft?: string }, screenshots: string, keepFocus?: boolean, opener?: string, timeoutMs?: number, pollMs?: number, onNotice?: (message: string) => void, onWindow?: (windowId: number) => void, signal?: AbortSignal }} options
 */
export async function startDesktopSession({ workspace, desktop, driverFor, setup = {}, screenshots, keepFocus = false, opener = 'open', timeoutMs = 180000, pollMs = 1500, onNotice = () => {}, onWindow = () => {}, signal }) {
  const deadline = Date.now() + timeoutMs;
  const { folder, home } = workspace;
  await mkdir(screenshots, { recursive: true, mode: 0o700 });
  let lastFolders = [], shot = 0;
  const look = (driver, label) => driver.observe(join(screenshots, `${label}-${++shot}.png`), { signal }).then(seen => { lastFolders = shownFolders(seen); return seen; });
  const waitFor = async (what, check) => {
    for (let attempt = 0; ; attempt++) {
      assert(Date.now() < deadline, `${what}${lastFolders.length ? ` (it showed ${lastFolders.join(', ')})` : ''}`);
      if (attempt) await delay(pollMs, undefined, { signal });
      const found = await check(attempt);
      if (found) return found;
    }
  };

  const main = mainWindow(await desktop.windows({ signal }));
  const front = await frontApp(workspace.executeCommand, signal);
  const openWindow = async () => {
    const shownBefore = new Set(observable(await desktop.windows({ signal })).map(item => String(item.window_id)));
    await desktop.menu('File > New Session in New Window', { signal });
    const id = await waitFor('Claude Desktop did not open a new session window', async () => {
      const opened = observable(await desktop.windows({ signal })).filter(item => item.window_title === 'New session' && !shownBefore.has(String(item.window_id)));
      return opened.length === 1 ? opened[0].window_id : undefined;
    });
    onWindow(id);
    // The composer names its folder once it has drawn. The window is read by its labels alone, with
    // no screenshot, and captured only once it shows the test folder; one in another folder is
    // closed unrecorded.
    let labels;
    await waitFor('The new session window did not show its folder', async () => { labels = await desktop.inspect(id, { signal }); lastFolders = shownFolders(labels); return lastFolders.length > 0; });
    return { id, composer: folderChosen(labels, folder, home) ? await look(driverFor(id), 'window') : undefined };
  };

  let givenBack = false;
  const focusBack = async () => { if (givenBack) return; givenBack = true; await giveFocusBack({ executeCommand: workspace.executeCommand, desktop, front, main, signal }); };
  let opened = await openWindow();
  if (!opened.composer || !folderChosen(opened.composer, folder, home)) {
    await desktop.closeWindow(opened.id, { signal });
    await giveFocusBack({ executeCommand: workspace.executeCommand, desktop, front, main, signal });
    const mainDriver = driverFor(main);
    let asked = false;
    await workspace.executeCommand([opener, '-g', newSessionLink(folder)], { signal, timeoutMs: 30000 }); // -g: not brought to the front
    await waitFor(`Claude Desktop did not take ${basename(folder)} as its folder`, async () => {
      const seen = await look(mainDriver, 'main');
      if (trustAsked(seen)) {
        assert(trustAskedFor(seen, folder), 'Claude Desktop is asking to trust a folder other than the test folder; leaving that to you');
        // A security question is yours to answer.
        if (!asked) onNotice(`Claude Desktop asks whether to trust ${folder}. Click Trust workspace in its main window. It asks whenever the test folder isn't the last one you used.`);
        asked = true;
        return false;
      }
      return folderChosen(seen, folder, home);
    });
    opened = await openWindow();
    assert(opened.composer && folderChosen(opened.composer, folder, home), `The new session window did not start in ${basename(folder)} (it showed ${lastFolders.join(', ') || 'no folder'})`);
  }

  const { id: windowId } = opened;
  const driver = driverFor(windowId, 'foreground'); // Setup is foreground whatever the run's mode.
  const earlier = await transcripts(workspace); // The folder is reused: only a new transcript is this session's.
  const promptHolds = text => async () => { const seen = await look(driver, 'prompt'); return seen.elements.find(isPrompt)?.value === text && seen; };
  try {
    // The window has had focus since it opened. Put the caret in the prompt, replace anything left
    // there with the first message, send it, and type the draft while the focus lasts.
    const prompt = opened.composer.elements.find(isPrompt);
    assert(prompt, 'The new session window has no prompt box');
    await driver.act({ type: 'click', element: prompt.id }, opened.composer, { signal });
    // A Peekaboo snapshot drives one action, so look again before typing.
    await driver.act({ type: 'type', text: setup.prompt ?? 'Reply with the single word OK.', replace: true }, await look(driver, 'clicked'), { signal });
    const typed = await waitFor('The prompt did not take the first message', promptHolds(setup.prompt ?? 'Reply with the single word OK.'));
    await driver.act({ type: 'press', key: 'return' }, typed, { signal });
    if (setup.draft) {
      // Typing goes on while Claude answers; the draft stays unsent.
      const empty = await waitFor('The first message was not sent', async () => { const seen = await look(driver, 'sent'); const value = seen.elements.find(isPrompt)?.value; return typeof value === 'string' && !value.trim() && seen; });
      await driver.act({ type: 'type', text: setup.draft }, empty, { signal });
      await waitFor('The prompt did not take the draft', promptHolds(setup.draft));
    }
    if (!keepFocus) await focusBack();
    await waitForAnswer({ workspace, earlier, deadline, pollMs, signal });
  } catch (error) {
    await focusBack().catch(() => {});
    throw error;
  }
  return { windowId, focusBack };
}

const isPrompt = item => item.label === 'Prompt' && /^text(Field|Area)$/i.test(item.role);

async function transcripts(workspace) {
  try { return new Set((await readdir(transcriptDir(workspace.folder, workspace.home))).filter(file => file.endsWith('.jsonl'))); } catch { return new Set(); }
}

async function waitForAnswer({ workspace, earlier, deadline, pollMs, signal }) {
  const directory = transcriptDir(workspace.folder, workspace.home);
  for (;;) {
    for (const file of await transcripts(workspace)) {
      if (earlier.has(file)) continue;
      const lines = (await readFile(join(directory, file), 'utf8')).split('\n');
      if (lines.some(line => line.includes('"type":"assistant"'))) return;
    }
    assert(Date.now() < deadline, 'The setup message got no answer; check the new session in Claude Desktop');
    await delay(pollMs, undefined, { signal });
  }
}
