import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, stat, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { codexTask, parseCodexReport, codexTrace, inputCalls, runCodex, codexRun, openCodexRun, recordCodexRun, resolveCodex, codexIsolation, CODEX_SETUP_STEPS } from '../src/codex.mjs';
import { claudeKeyTaps } from '../src/taps.mjs';
import { summarizeFocus, watchFocus } from '../src/focus.mjs';
import { validateScenario } from '../src/protocol.mjs';
import { withSession } from '../src/session.mjs';
import { execute } from '../src/process.mjs';

const scenario = validateScenario({
  version: 1, name: 'Pane', goal: 'Open the pane with Usage & tips, then close it.', target: { app: 'com.anthropic.claudefordesktop' },
  setup: { prompt: 'Say OK.', draft: 'Unsent draft' }, constraints: ['Do not submit anything.'], allowedActions: ['click', 'click_point', 'scroll', 'wait', 'type'],
  checks: [{ id: 'pane-closed', kind: 'absent', selector: { label: 'This session' } }, { id: 'draft', kind: 'present', selector: { label: 'Prompt', value: 'Unsent draft' } }],
  limits: { maxSteps: 7 },
});

const scratchDir = async t => { const directory = await mkdtemp(join(tmpdir(), 'mod-ux-codex-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; };

test('the task keeps Codex in the background and on the test window, with the setup, the scenario and its limits', () => {
  const task = codexTask({ scenario, folder: '/Users/me/.mod-ux/workspaces/dividend', home: '/Users/me' });
  assert.match(task, /background only: never bring an app to the front, never move the pointer/);
  assert.match(task, /Never take a screenshot of, read the content of, click or type in any Claude Desktop window except the test window/);
  assert.match(task, /File > New Session in New Window, once/);
  assert(task.includes('"Folder: ~/.mod-ux/workspaces/dividend"')); // As Claude Desktop names a folder under home.
  assert(task.includes('type exactly "Say OK."'));
  assert(task.includes('type exactly "Unsent draft" in the prompt box. Do not send it.'));
  assert(task.includes(scenario.goal));
  assert(task.includes('- Do not submit anything.'));
  assert(task.includes('only these kinds of action: click an element, click a point in the window, scroll, wait, type or set text in a field. At most 7 actions.'));
  assert(task.includes(`stops you after 8 minutes, or after ${7 + CODEX_SETUP_STEPS} input calls`)); // 5 for the scenario, 3 for setup.
  assert.match(task, /reply with only one JSON object/);
  const noDraft = codexTask({ scenario: { ...scenario, setup: {} }, folder: '/elsewhere/x', home: '/Users/me' });
  assert(noDraft.includes('"Folder: /elsewhere/x"'));
  assert(noDraft.includes('type exactly "Reply with the single word OK."'));
  assert(!noDraft.includes('Do not send it.'));
});

test("the scenario's own actions reach Codex, typing included: Dividend's discovery scenario", async () => {
  const discovery = validateScenario(JSON.parse(await readFile(new URL('../../../plugins/dividend/ux-evals/discovery.json', import.meta.url), 'utf8')));
  assert(discovery.allowedActions.includes('type'));
  const task = codexTask({ scenario: discovery, folder: '/Users/me/.mod-ux/workspaces/dividend', home: '/Users/me' });
  assert(task.includes('only these kinds of action: click an element, click a point in the window, type or set text in a field, scroll, wait. At most 16 actions.'));
  assert(task.includes(discovery.goal)); // Which has the tester type the draft itself.
});

test("Codex's reply must be one JSON report", () => {
  assert.deepEqual(parseCodexReport('```json\n{"status":"done","reason":"Opened and closed.","windowTitle":"OK","steps":["a"]}\n```'), { status: 'done', reason: 'Opened and closed.', windowTitle: 'OK', steps: ['a'] });
  assert.throws(() => parseCodexReport('All done!'), /one JSON object/);
  assert.throws(() => parseCodexReport('{"status":"maybe","reason":"x"}'), /no status/);
  assert.throws(() => parseCodexReport('{"status":"done","reason":" "}'), /no reason/);
  assert.throws(() => parseCodexReport('{"status":"done","reason":"x","steps":[1]}'), /Invalid steps/);
});

const event = (code, title, content = [{ type: 'text', text: 'Window: "OK"…' }], error) => JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'cua_repl', tool: 'js', arguments: { code, title }, result: { content }, ...(error ? { error } : {}) } });
const EVENTS = [
  JSON.stringify({ type: 'thread.started' }),
  JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', arguments: { code: 'ignored' } } }),
  event('await app.click(59)', 'Opening Dividend'),
  event('await app.getScreenshot()', 'Looking at the pane', [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }]),
  event('await app.click(75)', 'Closing it', [], { message: 'element gone' }),
  'not json',
  JSON.stringify({ type: 'turn.completed' }),
].join('\n');

test("Codex's trace keeps each step and its screenshots, but not what it read", () => {
  const trace = codexTrace(EVENTS);
  assert.deepEqual(trace.map(step => step.title), ['Opening Dividend', 'Looking at the pane', 'Closing it']);
  assert.equal(trace[1].images.length, 1);
  assert.equal(trace[2].error, 'element gone');
  assert(!JSON.stringify(trace).includes('Window: "OK"')); // Accessibility reads can include other windows.
});

test('input calls are counted from the code Codex runs, reads not included', () => {
  assert.deepEqual(inputCalls('await app.click(4); await app.getAXState(); await app.setValue(39, "Say OK.")'), ['click', 'type']);
  assert.deepEqual(inputCalls('await app.click({ x: 10, y: 20 }); await app.pressKey("return"); await app.scroll(3, "down"); await app.typeText("hi", 2)'), ['click_point', 'press', 'scroll', 'type']);
  assert.deepEqual(inputCalls('await app.getScreenshot(); nodeRepl.write(await app.getAXState())'), []);
  assert.deepEqual(inputCalls(undefined), []);
});

test('codex exec runs with stdin closed, its events streamed and its log kept, and a failed turn explained', async t => {
  const directory = await scratchDir(t);
  await mkdir(join(directory, 'agent-work'));
  const calls = [];
  const executeCommand = async (command, options) => {
    calls.push({ command, options });
    await writeFile(command[command.indexOf('-o') + 1], '{"status":"done","reason":"ok","windowTitle":"OK"}');
    // Codex writes its log in pieces; an event can be split across them, even mid-character.
    const bytes = Buffer.from(`${EVENTS.replace('Opening Dividend', 'Opening Dividend…')}\n`);
    for (let at = 0; at < bytes.length; at += 37) options.onStdout?.(bytes.subarray(at, at + 37));
    return { stdout: EVENTS };
  };
  const seen = [];
  const result = await runCodex({ task: 'TASK', directory, model: 'gpt-5.6-sol', codex: 'codex', isolation: ['--disable', 'apps'], executeCommand, timeoutMs: 1234, onEvent: item => seen.push(item) });
  // Isolation flags, and a read-only sandbox for Codex's own shell: no writes, no network.
  assert.deepEqual(calls[0].command.slice(0, 10), ['codex', 'exec', '--disable', 'apps', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--json', '-o']);
  assert.deepEqual(calls[0].command.slice(11), ['-m', 'gpt-5.6-sol', '-C', join(directory, 'agent-work'), 'TASK']);
  assert.equal(calls[0].options.input, ''); // Closed stdin: an open one makes codex exec wait.
  assert.equal(calls[0].options.timeoutMs, 1234);
  assert.deepEqual(seen.map(item => item.type), ['thread.started', 'item.started', 'item.completed', 'item.completed', 'item.completed', 'turn.completed']);
  assert.equal(seen[2].item.arguments.title, 'Opening Dividend…');
  assert.equal(result.report.windowTitle, 'OK');
  assert.equal(result.trace.length, 3);
  assert.equal(await readFile(join(directory, 'codex-events.jsonl'), 'utf8'), EVENTS);
  const failed = JSON.stringify({ type: 'turn.failed', error: { type: 'error', status: 400, error: { message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." } } });
  await assert.rejects(runCodex({ task: 'T', directory, executeCommand: async () => ({ stdout: failed }) }), /not supported.*--codex-model/);
  // Stopped part way: what it wrote is kept, and the error carries the trace so far.
  const stopped = async () => { throw Object.assign(new Error('Process aborted'), { stdout: `${event('await app.click(1)', 'First')}\n` }); };
  await assert.rejects(runCodex({ task: 'T', directory, executeCommand: stopped }), error => error.message === 'Process aborted' && error.trace.length === 1);
  assert.match(await readFile(join(directory, 'codex-events.jsonl'), 'utf8'), /First/);
  const exited = async () => { throw Object.assign(new Error('codex exited 1: noise'), { stdout: failed }); };
  await assert.rejects(runCodex({ task: 'T', directory, executeCommand: exited }), /Codex failed: The 'gpt-6.1-sol' model/);
});

const HOME = '/h';
const FOLDER = '/h/.mod-ux/workspaces/dividend';
const composer = folder => ({ elements: [{ id: '1', role: 'button', label: `Folder: ${folder}` }, { id: '2', role: 'textArea', label: 'Prompt' }] });
// A Claude Desktop whose windows come and go on cue, recording what the harness reads and captures.
function fakeDesktop(initial) {
  const desktop = {
    shown: [...initial], labels: {}, inspected: [], captured: [],
    async windows() { return desktop.shown.map(item => ({ is_on_screen: true, ...item })); },
    async inspect(id) { desktop.inspected.push(id); return desktop.labels[id] ?? { elements: [] }; },
    driverFor: id => ({ async observe(path) { desktop.captured.push(id); await writeFile(path, 'png'); return { receipt: {}, elements: [], warnings: [] }; } }),
  };
  return desktop;
}
const finished = { report: { status: 'done', reason: 'ok' }, trace: [], durationMs: 1 };
const options = (desktop, scratch, extra) => ({ scenario, workspace: { folder: FOLDER, home: HOME }, scratch, desktop, driverFor: desktop.driverFor, sampleMs: 5, pinMs: 2, ...extra });

test("the test window is the new one whose composer names the test folder; another window that opens meanwhile is neither captured nor kept", async t => {
  const scratch = await scratchDir(t);
  // Yours: the main window, and one minimized.
  const desktop = fakeDesktop([{ window_id: 1, window_title: 'Claude' }, { window_id: 2, window_title: 'Private', is_minimized: true }]);
  desktop.labels[1] = composer(FOLDER); // Even a window open before that names the folder is never taken.
  const run = async ({ task }) => {
    assert.match(task, /New Session in New Window/);
    // You open a window of your own first, and bring back the minimized one.
    desktop.labels[5] = composer('~/work/secret');
    desktop.shown.push({ window_id: 5, window_title: 'New session' });
    desktop.shown[1] = { ...desktop.shown[1], is_minimized: false };
    await delay(20);
    desktop.labels[9] = composer('~/.mod-ux/workspaces/dividend');
    desktop.shown.push({ window_id: 9, window_title: 'New session' });
    await delay(40);
    return finished;
  };
  const result = await codexRun(options(desktop, scratch, { run }));
  assert.equal(result.windowId, 9);
  assert.equal(result.windowProblem, undefined);
  assert(result.frames.length >= 1);
  assert(desktop.captured.length && desktop.captured.every(id => id === 9)); // Captured only once identified.
  assert(desktop.inspected.includes(5)); // Checked by its labels, with no screenshot...
  assert(!desktop.inspected.includes(1) && !desktop.inspected.includes(2)); // ...while windows open before are never read.
  assert.equal(result.ended, 'finished');
});

test('two new windows in the test folder are ambiguous: nothing is captured, kept or closed', async t => {
  const scratch = await scratchDir(t);
  for (const order of ['together', 'one after the other']) {
    const desktop = fakeDesktop([{ window_id: 1, window_title: 'Claude' }]);
    const run = async () => {
      desktop.labels[7] = composer(FOLDER);
      desktop.shown.push({ window_id: 7 });
      if (order !== 'together') await delay(25);
      desktop.labels[9] = composer(FOLDER);
      desktop.shown.push({ window_id: 9 });
      await delay(40);
      return finished;
    };
    const result = await codexRun(options(desktop, scratch, { run }));
    assert.equal(result.windowId, undefined, order);
    assert.match(result.windowProblem, /2 new windows started in the test folder/, order);
    assert.deepEqual(result.frames, [], order); // Anything captured of the first is dropped.
  }
});

test('a failed Codex run is returned, with the verified window, so it can be recorded and the window closed', async t => {
  const scratch = await scratchDir(t);
  const desktop = fakeDesktop([{ window_id: 1 }]);
  const failing = async () => {
    desktop.labels[9] = composer(FOLDER);
    desktop.shown.push({ window_id: 9 });
    await delay(20);
    throw Object.assign(new Error('Codex failed: x'), { trace: [{ server: 'cua_repl', tool: 'js', title: 'a', code: '', images: [] }] });
  };
  const result = await codexRun(options(desktop, scratch, { run: failing }));
  assert.equal(result.ended, 'error');
  assert.equal(result.reason, 'Codex failed: x');
  assert.equal(result.windowId, 9);
  assert.equal(result.trace.length, 1);
});

// A Codex that works until it is stopped: it asks for `calls` steps, then waits for the stop.
const working = (steps = [], gap = 1) => async ({ onEvent, signal }) => {
  for (const [index, code] of steps.entries()) {
    if (signal.aborted) break;
    onEvent({ type: 'item.started', item: { id: `item_${index}`, type: 'mcp_tool_call', arguments: { code } } });
    onEvent({ type: 'item.completed', item: { id: `item_${index}`, type: 'mcp_tool_call', arguments: { code } } }); // The same call, not counted twice.
    await delay(gap);
  }
  if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  throw Object.assign(new Error('Process aborted'), { trace: [] });
};

test("Codex is stopped at the scenario's time limit, setup allowance included", async t => {
  const scratch = await scratchDir(t);
  let timeoutMs;
  const quick = validateScenario({ ...scenario, limits: { maxSteps: 7, maxDurationMs: 30 } });
  const run = working();
  const result = await codexRun({ ...options(fakeDesktop([]), scratch), scenario: quick, setupMs: 10, run: args => { timeoutMs = args.timeoutMs; return run(args); } });
  assert.equal(result.ended, 'time');
  assert.match(result.reason, /Time limit reached/);
  assert(result.durationMs >= 20 && result.durationMs < 5000, String(result.durationMs));
  assert.equal(timeoutMs, 40 + 60000); // Codex's own process deadline backs the limit up.
});

test("Codex is stopped as it asks for the input call over the step limit, setup allowance included", async t => {
  const scratch = await scratchDir(t);
  const budget = scenario.limits.maxSteps + CODEX_SETUP_STEPS;
  const steps = Array.from({ length: budget }, (_, index) => (index % 2 ? 'await app.setValue(2, "x"); await app.getAXState()' : 'await app.click(1)'));
  const result = await codexRun({ ...options(fakeDesktop([]), scratch), run: working([...steps, 'await app.click(3)', 'await app.click(4)']) });
  assert.equal(result.ended, 'steps');
  assert.equal(result.inputs.total, budget + 1); // The last one asked for; the one after it never was.
  assert.equal(result.inputs.budget, budget);
  assert.deepEqual(result.inputs.byType, { click: Math.ceil(budget / 2) + 1, type: Math.floor(budget / 2) });
  assert.match(result.reason, new RegExp(`input call ${budget + 1}, over the ${budget} allowed`));
});

test('Codex is stopped by the signal, or by the stop command, which finds the run busy and leaves a STOP file', async t => {
  const scratch = await scratchDir(t);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  assert.equal((await codexRun({ ...options(fakeDesktop([]), scratch), run: working(), signal: controller.signal })).ended, 'stopped');

  const directory = join(scratch, 'run');
  await openCodexRun({ directory, scenario });
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const session = await withSession(directory, async current => {
    const stopping = delay(30).then(() => execute([process.execPath, cli, 'stop', '--run', directory], { timeoutMs: 20000 }));
    const outcome = await codexRun({ ...options(fakeDesktop([]), scratch), stopFile: join(directory, 'STOP'), run: working() });
    assert.equal(JSON.parse((await stopping).stdout).stopRequested, true);
    assert.equal(outcome.ended, 'stopped');
    return recordCodexRun({ directory, session: current, outcome, scratch, criticFor: () => { throw new Error('No review of a stopped run'); } });
  });
  assert.equal(session.status, 'stopped');
  assert.equal(session.summary, 'Stopped by the operator');
  assert.equal(session.error, undefined);
});

test("a Codex run is recorded as a harness run, with Codex's raw log kept through cleanup", async t => {
  const base = await scratchDir(t);
  const scratch = join(base, 'workspace', 'codex');
  await mkdir(scratch, { recursive: true });
  await writeFile(join(scratch, 'during.png'), 'png');
  await writeFile(join(scratch, 'codex-events.jsonl'), EVENTS, { mode: 0o600 });
  await writeFile(join(scratch, 'codex-last-message.txt'), '{"status":"done","reason":"Opened and closed the pane."}', { mode: 0o644 });
  const directory = join(base, 'run');
  const opened = await openCodexRun({ directory, scenario, provenance: { plugin: 'dividend' } });
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'session.json'), 'utf8')).status, 'running'); // There for `stop` from the start.
  const startedAt = new Date(Date.parse(opened.startedAt) + 100).toISOString();
  const outcome = {
    startedAt, durationMs: 4000, ended: 'finished', report: { status: 'done', reason: 'Opened and closed the pane.', windowTitle: 'OK' },
    trace: [{ server: 'cua_repl', tool: 'js', title: 'Opening Dividend', code: 'await app.click(59)', images: [{ data: 'AAAA' }] }],
    inputs: { total: 6, byType: { click: 4, type: 2 }, budget: 17 }, windowId: 9,
    frames: [{ at: Date.parse(opened.startedAt) + 2000, path: join(scratch, 'during.png'), observed: { receipt: {}, elements: [{ id: 's', label: 'This session' }], warnings: [] } }],
  };
  const driver = {
    async connect() { return { kind: 'peekaboo', app: 'com.anthropic.claudefordesktop', windowId: 9, windowTitle: 'OK' }; },
    async observe(path) { await writeFile(path, 'png'); return { receipt: {}, elements: [{ id: 'p', role: 'textField', label: 'Prompt', value: 'Unsent draft' }], warnings: [] }; },
  };
  const focus = { samples: [], summary: summarizeFocus([{ at: 0, app: 'com.google.Chrome', x: 1, y: 1 }, { at: 500, app: 'com.google.Chrome', x: 1, y: 1 }]) };
  const reviewed = [];
  const session = await withSession(directory, current => recordCodexRun({ directory, session: current, outcome, scratch, driver, focus, criticFor: () => async request => { reviewed.push(request); return { summary: 'Looks fine.', findings: [] }; } }));
  await rm(join(base, 'workspace'), { recursive: true }); // The run's cleanup removes the workspace...
  for (const name of ['codex-events.jsonl', 'codex-last-message.txt']) assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600, name); // ...but not the raw log, kept private.
  assert.equal(await readFile(join(directory, 'codex-events.jsonl'), 'utf8'), EVENTS);
  const native = session.events.find(item => item.kind === 'native');
  assert.deepEqual(native.raw, { events: 'codex-events.jsonl', lastMessage: 'codex-last-message.txt' });
  assert.equal(session.status, 'completed');
  assert.equal(session.summary, 'Codex: Opened and closed the pane.');
  assert.deepEqual(session.events.map(item => item.kind), ['observation', 'native', 'observation']);
  assert.equal(session.events[0].elapsedMs, 2000);
  assert.deepEqual(native.steps, [{ server: 'cua_repl', tool: 'js', title: 'Opening Dividend', code: 'await app.click(59)', screenshots: 1 }]);
  assert.equal(native.isolationBreaches, undefined);
  assert.equal(session.error, undefined);
  assert(!JSON.stringify(session).includes('AAAA')); // Codex's screenshots stay out of the record.
  assert.deepEqual(Object.fromEntries(session.checkResults.map(check => [check.id, check.status])), { 'pane-closed': 'passed', draft: 'passed' });
  // Codex's input, counted rather than shown as none.
  assert.equal(session.steps, 6);
  assert.deepEqual(session.metrics.actions, { total: 6, byType: { click: 4, type: 2 }, uncertain: null, pending: null, source: 'codex trace, setup included' });
  assert.equal(session.target.windowId, 9);
  assert.equal(session.provenance.driver, 'codex');
  assert.equal(session.provenance.focus.claudeCameToFront, 0);
  assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('frame-')).sort(), ['frame-0001.png', 'frame-0003.png']);
  assert.equal(reviewed.length, 1);
  assert.equal(reviewed[0].images.length, 2); // The critic sees the harness's captures of the test window only.
  assert(!JSON.stringify(reviewed[0]).includes('AAAA')); // Nor anything from Codex's raw log (the critic has no tools to open it).
  assert(JSON.parse(await readFile(join(directory, 'focus.json'), 'utf8')).summary);
  const report = await readFile(join(directory, 'report.html'), 'utf8');
  assert(report.includes('Codex: Opened and closed the pane.'));
  assert(report.includes('6 calls'));
});

test('a run whose test window was never identified, or that went over a limit, is not a pass', async t => {
  const base = await scratchDir(t);
  const base_outcome = { startedAt: new Date().toISOString(), durationMs: 1, trace: [], frames: [], inputs: { total: 3, byType: { click: 3 }, budget: 17 } };
  const record = async (name, outcome) => {
    const directory = join(base, name);
    await openCodexRun({ directory, scenario });
    return withSession(directory, current => recordCodexRun({ directory, session: current, outcome: { ...base_outcome, ...outcome }, scratch: join(base, 'none') }));
  };
  const lost = await record('lost', { ended: 'finished', report: { status: 'done', reason: 'ok' }, windowProblem: '2 new windows started in the test folder, so the harness can\'t tell which one Codex used; it captured and closed none of them' });
  assert.equal(lost.status, 'completed'); // Codex's own word...
  assert.match(lost.error, /2 new windows started in the test folder/); // ...but a harness error,
  assert(lost.checkResults.every(check => check.status === 'unassessed')); // with nothing to check.
  assert.deepEqual((await record('none', { ended: 'finished', report: { status: 'done', reason: 'ok' } })).error.match(/no new window whose composer named the test folder/)?.length, 1);
  const over = await record('over', { ended: 'steps', reason: 'Step limit reached: …' });
  assert.equal(over.status, 'limit');
  assert.equal(over.summary, 'Step limit reached: …');
  const failed = await record('failed', { ended: 'error', reason: 'Codex failed: x' });
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'Codex failed: x');
});

test('the focus log names every change of front app and counts pointer moves', async () => {
  const summary = summarizeFocus([
    { at: 1000, app: 'com.google.Chrome', x: 5, y: 5 },
    { at: 1500, app: 'com.anthropic.claudefordesktop', x: 5, y: 5 },
    { at: 2000, app: 'com.google.Chrome', x: 9, y: 5 },
    { at: 2500, app: 'com.google.Chrome', x: 9, y: 5 },
  ]);
  assert.equal(summary.samples, 4);
  assert.equal(summary.durationMs, 1500);
  assert.equal(summary.frontAtStart, 'com.google.Chrome');
  assert.deepEqual(summary.frontChanges.map(change => [change.atMs, change.to]), [[500, 'com.anthropic.claudefordesktop'], [1000, 'com.google.Chrome']]);
  assert.equal(summary.claudeCameToFront, 1);
  assert.equal(summary.pointerMoves, 1);
  let tick = 0;
  const watcher = watchFocus({ intervalMs: 2, executeCommand: async () => ({ stdout: JSON.stringify({ app: tick++ % 2 ? 'a' : 'b', x: 0, y: 0 }) }) });
  await new Promise(resolve => setTimeout(resolve, 30));
  const { samples } = await watcher.stop();
  assert(samples.length >= 2);
});

test('only a Codex signed with OpenAI\'s Developer ID is run, whatever comes first on PATH', async t => {
  const base = await scratchDir(t);
  const make = async (directory, name = 'codex') => { await mkdir(directory, { recursive: true }); const file = join(directory, name); await writeFile(file, '#!/bin/sh\n'); await chmod(file, 0o755); return realpath(file); };
  const npmShim = await make(join(base, 'npm', 'lib'), 'codex.js');
  await mkdir(join(base, 'npm', 'bin'));
  await symlink(npmShim, join(base, 'npm', 'bin', 'codex'));
  const adhoc = await make(join(base, 'adhoc'));
  const otherTeam = await make(join(base, 'other'));
  const tampered = await make(join(base, 'tampered'));
  const good = await make(join(base, 'brew'));
  const answers = {
    [npmShim]: { verify: 'code object is not signed at all' },
    [adhoc]: { details: 'Signature=adhoc\nTeamIdentifier=not set' },
    [otherTeam]: { details: 'Authority=Developer ID Application: Someone Else (ABCDE12345)\nTeamIdentifier=ABCDE12345' },
    [tampered]: { verify: 'invalid signature (code or signature have been modified)' },
    [good]: { details: 'Authority=Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=2DC432GLL2' },
  };
  const calls = [];
  const executeCommand = async command => {
    calls.push(command);
    const answer = answers[command.at(-1)];
    if (command[1] === '--verify' && answer.verify) throw Object.assign(new Error('codesign exited 1'), { stderr: `${command.at(-1)}: ${answer.verify}` });
    return command[1] === '--verify' ? { stdout: '', stderr: '' } : { stdout: '', stderr: answer.details };
  };
  const path = ['npm/bin', 'adhoc', 'missing', 'other', 'tampered', 'brew'].map(directory => join(base, directory)).join(':');
  const found = await resolveCodex({ path, executeCommand });
  assert.equal(found.binary, good);
  assert.deepEqual(found.passedOver.map(line => line.split(': ').slice(1).join(': ')), [
    'signature does not verify (code object is not signed at all)',
    "not signed by OpenAI's team (not)",
    "not signed by OpenAI's team (ABCDE12345)",
    'signature does not verify (invalid signature (code or signature have been modified))',
  ]);
  assert(found.passedOver[0].startsWith(npmShim)); // Named by the real file behind the link.
  assert(calls.every(command => command[0] === 'codesign')); // Checked, never run.
  await assert.rejects(resolveCodex({ path: join(base, 'npm/bin'), executeCommand }), /No Codex signed by OpenAI \(team 2DC432GLL2\) on PATH; passed over:/);
  assert.equal((await resolveCodex({ codex: good, path: '', executeCommand })).binary, good); // An explicit path is checked too.
});

test('a Codex run gets Computer Use and nothing else, checked before it starts', async () => {
  const servers = [
    { name: 'cua_repl', enabled: true }, { name: 'notes', enabled: true }, { name: 'tracker', enabled: true },
    { name: 'computer-use', enabled: false }, { name: 'node_repl', enabled: true },
  ];
  const calls = [];
  const executeCommand = async command => {
    calls.push(command);
    const off = new Set(command.filter(part => part.endsWith('.enabled=false')).map(part => part.slice('mcp_servers.'.length, -'.enabled=false'.length)));
    return { stdout: JSON.stringify(servers.map(server => ({ ...server, enabled: server.enabled && !off.has(server.name) }))) };
  };
  const { args, off } = await codexIsolation({ codex: 'codex', executeCommand });
  assert.deepEqual(off.servers, ['notes', 'tracker', 'node_repl']);
  assert.deepEqual(args.slice(0, 6), ['-c', 'mcp_servers.notes.enabled=false', '-c', 'mcp_servers.tracker.enabled=false', '-c', 'mcp_servers.node_repl.enabled=false']);
  for (const feature of ['apps', 'memories', 'hooks', 'multi_agent', 'goals', 'browser_use', 'image_generation']) assert(args.includes(feature));
  assert.deepEqual(calls[1].slice(-3), ['mcp', 'list', '--json']); // Listed again with the flags applied.
  // An override that doesn't take, or no Computer Use at all, stops the run.
  const stubborn = async command => ({ stdout: JSON.stringify(servers) });
  await assert.rejects(codexIsolation({ codex: 'codex', executeCommand: stubborn }), /still have MCP servers besides Computer Use: notes, tracker, node_repl/);
  const none = async () => ({ stdout: JSON.stringify([{ name: 'notes', enabled: true }]) });
  await assert.rejects(codexIsolation({ codex: 'codex', executeCommand: async command => command.includes('-c') ? { stdout: '[]' } : none() }), /no Computer Use server at all/);
  await assert.rejects(codexIsolation({ codex: 'codex', executeCommand: async () => ({ stdout: JSON.stringify([{ name: 'cua_repl', enabled: true }, { name: 'a.b', enabled: true }]) }) }), /Can't switch off the MCP server "a.b"/);
});

test('anything Codex did outside Computer Use is an isolation breach the run reports', async t => {
  const trace = codexTrace([
    JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'cua_repl', tool: 'js', arguments: { code: 'x', title: 'Click' }, result: { content: [] } } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'tracker', tool: 'save_issue', arguments: {}, result: { content: [] } } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'gh issue list' } }),
  ].join('\n'));
  assert.deepEqual(trace.map(step => `${step.server}.${step.tool}`), ['cua_repl.js', 'tracker.save_issue', 'command_execution.command_execution']);
  const base = await scratchDir(t);
  const directory = join(base, 'run');
  await openCodexRun({ directory, scenario });
  const driver = { async connect() { return { kind: 'peekaboo', windowId: 9 }; }, async observe(path) { await writeFile(path, 'png'); return { receipt: {}, elements: [], warnings: [] }; } };
  const outcome = { startedAt: new Date().toISOString(), durationMs: 1, ended: 'finished', report: { status: 'done', reason: 'ok' }, trace, frames: [], inputs: { total: 0, byType: {}, budget: 17 }, windowId: 9 };
  const session = await withSession(directory, current => recordCodexRun({ directory, session: current, outcome, scratch: base, driver }));
  assert.deepEqual(session.events.find(item => item.kind === 'native').isolationBreaches, ['tracker.save_issue', 'command_execution.command_execution']);
  assert.match(session.error, /outside Computer Use: tracker.save_issue, command_execution.command_execution/);
});

test('keyboard taps another program holds on Claude are found; others are not', async () => {
  const taps = [
    { tapperPid: 9847, tapper: 'SkyComputerUseService', tappedPid: 7405, active: true, enabled: true, keys: true },
    { tapperPid: 9847, tapper: 'SkyComputerUseService', tappedPid: 7405, active: false, enabled: true, keys: true }, // Listen-only.
    { tapperPid: 64293, tapper: 'Siri', tappedPid: 0, active: true, enabled: true, keys: true }, // Every app, not Claude.
    { tapperPid: 1364, tapper: 'key-remapper', tappedPid: 7405, active: true, enabled: false, keys: true }, // Disabled.
    { tapperPid: 5, tapper: 'mouse', tappedPid: 7405, active: true, enabled: true, keys: false }, // Not the keyboard.
  ];
  const executeCommand = async command => command[0] === 'ps'
    ? { stdout: '  101 /usr/sbin/cfprefsd\n 7405 /Applications/Claude.app/Contents/MacOS/Claude\n 7406 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper\n' }
    : { stdout: JSON.stringify(taps) };
  assert.deepEqual((await claudeKeyTaps({ executeCommand })).map(tap => tap.tapper), ['SkyComputerUseService']);
  assert.deepEqual(await claudeKeyTaps({ before: [taps[0]], executeCommand }), []); // One that was there before isn't new.
  assert.deepEqual(await claudeKeyTaps({ executeCommand: async command => command[0] === 'ps' ? { stdout: '' } : { stdout: '[]' } }), []); // Claude not running.
});
