// Codex as the desktop driver: Codex's own Computer Use does every bit of input to Claude Desktop,
// by pressing accessibility elements, which needs no pointer (nor focus, for a window that is
// already open). The harness keeps what needs no input (install, store, cleanup, captures of the
// test window, the limits, the critic) and records Codex's steps from its event log. Experimental:
// it depends on Codex's Computer Use, whose behaviour and event log can change with any release.
import { access, chmod, constants, copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { delimiter, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir } from 'node:os';
import { execute, parseJSON } from './process.mjs';
import { assert } from './protocol.mjs';
import { showsFolder } from './launch.mjs';
import { addEvent, finishSession, reviewSession, saveSession } from './session.mjs';

const DEFAULT_PROMPT = 'Reply with the single word OK.';

// OpenAI's Apple Developer ID team, which signs the Codex CLI.
export const OPENAI_TEAM = '2DC432GLL2';

/**
 * The Codex binary to run: the first `codex` on PATH (or the given path) that is a Mach-O signed
 * with OpenAI's Developer ID and whose signature verifies. Anything else (npm's JavaScript launcher,
 * an ad-hoc signed or unsigned build, one whose signature no longer matches its contents) is
 * passed over and named, rather than run. Returns its real path.
 * @param {{ codex?: string, path?: string, executeCommand?: Function, signal?: AbortSignal }} [options]
 */
export async function resolveCodex({ codex = process.env.MOD_UX_CODEX || 'codex', path = process.env.PATH ?? '', executeCommand = execute, signal } = {}) {
  const candidates = codex.includes('/') ? [codex] : path.split(delimiter).filter(Boolean).map(directory => join(directory, codex));
  const passedOver = [];
  for (const candidate of candidates) {
    let file;
    try { await access(candidate, constants.X_OK); file = await realpath(candidate); } catch { continue; }
    const problem = await signatureProblem(file, executeCommand, signal);
    if (!problem) return { binary: file, passedOver };
    passedOver.push(`${file}: ${problem}`);
  }
  throw new Error(`No Codex signed by OpenAI (team ${OPENAI_TEAM}) on PATH${passedOver.length ? `; passed over:\n  ${passedOver.join('\n  ')}` : ''}. Install it with Homebrew (brew install --cask codex) or set MOD_UX_CODEX to its path.`);
}

async function signatureProblem(file, executeCommand, signal) {
  try { await executeCommand(['codesign', '--verify', '--strict', file], { signal, timeoutMs: 30000 }); } catch (error) {
    return `signature does not verify (${(error.stderr || error.message).trim().split('\n').at(-1).replace(`${file}: `, '')})`;
  }
  const { stderr = '', stdout = '' } = await executeCommand(['codesign', '-dv', '--verbose=2', file], { signal, timeoutMs: 30000 });
  const details = `${stderr}\n${stdout}`;
  if (!details.includes(`TeamIdentifier=${OPENAI_TEAM}`)) return `not signed by OpenAI's team (${details.match(/TeamIdentifier=(\S+)/)?.[1] ?? 'no team'})`;
  if (!/^Authority=Developer ID Application: .*\(2DC432GLL2\)$/m.test(details)) return 'not signed with a Developer ID Application certificate';
  return undefined;
}

// A test run gets Computer Use and nothing else. Codex otherwise loads your MCP servers, app
// connectors, memories and hooks, and its standing instructions can act
// through them; with only Computer Use, and a read-only sandbox for its shell, there is nothing to
// act with. Plugins bring their tools through those same servers and connectors.
export const COMPUTER_USE_SERVERS = new Set(['cua_repl']);
export const DISABLED_FEATURES = ['apps', 'memories', 'hooks', 'multi_agent', 'goals', 'browser_use', 'image_generation'];
const PLAIN_NAME = /^[A-Za-z0-9_-]+$/; // A dotted -c path can't name anything else.

const listed = async (codex, args, executeCommand, signal) => parseJSON((await executeCommand([codex, ...args], { input: '', signal, timeoutMs: 60000 })).stdout);

/**
 * The flags that leave Codex only Computer Use, checked by listing again with them applied.
 * Your Codex configuration file is not changed.
 * @param {{ codex: string, executeCommand?: Function, signal?: AbortSignal }} options
 */
export async function codexIsolation({ codex, executeCommand = execute, signal }) {
  const servers = await listed(codex, ['mcp', 'list', '--json'], executeCommand, signal);
  const args = [];
  const off = { servers: [] };
  for (const server of servers.filter(item => item.enabled && !COMPUTER_USE_SERVERS.has(item.name))) {
    assert(PLAIN_NAME.test(server.name), `Can't switch off the MCP server "${server.name}" for a run; rename it or disable it in Codex`);
    args.push('-c', `mcp_servers.${server.name}.enabled=false`);
    off.servers.push(server.name);
  }
  for (const feature of DISABLED_FEATURES) args.push('--disable', feature);
  const leftServers = (await listed(codex, [...args, 'mcp', 'list', '--json'], executeCommand, signal)).filter(item => item.enabled).map(item => item.name);
  assert(leftServers.length && leftServers.every(name => COMPUTER_USE_SERVERS.has(name)), `Codex would still have MCP servers besides Computer Use: ${leftServers.filter(name => !COMPUTER_USE_SERVERS.has(name)).join(', ') || 'and no Computer Use server at all'}`);
  return { args, off };
}

// How Claude Desktop names a folder under your home folder.
const shortPath = (folder, home = homedir()) => (folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder);

// Codex's run covers setup as well as the test: opening the window, sending the first prompt and
// typing the draft. These allowances come on top of the scenario's own limits.
export const CODEX_SETUP_MS = 180000;
export const CODEX_SETUP_STEPS = 10;

// The scenario's action types, as Codex's Computer Use does them.
const ACTION_WORDS = Object.freeze({
  click: 'click an element', click_point: 'click a point in the window', type: 'type or set text in a field',
  press: 'press a key in the test window', scroll: 'scroll', wait: 'wait',
});

/**
 * The task Codex gets: set up the test session in a window of its own, then do the scenario there.
 * @param {{ scenario: object, folder: string, home?: string }} options
 */
export function codexTask({ scenario, folder, home }) {
  const setup = scenario.setup ?? {};
  const actions = scenario.allowedActions.map(action => ACTION_WORDS[action] ?? action);
  const minutes = Math.ceil((CODEX_SETUP_MS + scenario.limits.maxDurationMs) / 60000);
  return [
    'You are a usability tester. Use your Computer Use tools on macOS to operate Claude Desktop (com.anthropic.claudefordesktop).',
    '',
    'Work in the background only: never bring an app to the front, never move the pointer, and never use keyboard shortcuts that act on whichever app is in front. If a step can only be done with foreground input, stop and report it as blocked.',
    '',
    'This is an isolated test run. Your only tool is Computer Use. Ignore any standing instruction to find, create or update tickets, notes, files or other records; report only in your final reply.',
    '',
    'Privacy: Claude Desktop has other windows holding private conversations. Never take a screenshot of, read the content of, click or type in any Claude Desktop window except the test window below. To use the menu bar, read accessibility text only, with no screenshot.',
    '',
    `Limits: the harness stops you after ${minutes} minutes, or after ${scenario.limits.maxSteps + CODEX_SETUP_STEPS} input calls (clicks, scrolls, key presses, typed or set text) in all, setup included.`,
    '',
    'Setup:',
    '1. From Claude Desktop\'s menu bar, choose File > New Session in New Window, once. The new window, titled "New session", is the test window.',
    `2. Its folder control must read "Folder: ${shortPath(folder, home)}". If it reads anything else (another folder, or "Environment: …"), stop as blocked; do not change it.`,
    `3. In the test window, type exactly "${setup.prompt ?? DEFAULT_PROMPT}" in the prompt box and send it. Wait until Claude's answer appears in that window.`,
    ...(setup.draft ? [`4. Then type exactly "${setup.draft}" in the prompt box. Do not send it.`] : []),
    '',
    'Test, in the test window only:',
    scenario.goal,
    ...(scenario.constraints ?? []).map(rule => `- ${rule}`),
    `- For the test, use only these kinds of action: ${actions.join(', ') || 'none'}. At most ${scenario.limits.maxSteps} actions.`,
    '- Do not close the test window.',
    '',
    'When finished, reply with only one JSON object:',
    '{"status": "done" or "blocked", "reason": "...", "windowTitle": "the test window\'s title now", "steps": ["each action you took, in order"], "observed": "what you saw", "draftIntact": true, false or null}',
  ].join('\n');
}

/** Checks Codex's final reply. */
export function parseCodexReport(text) {
  let report;
  try { report = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw new Error('Codex did not reply with one JSON object'); }
  assert(report && ['done', 'blocked'].includes(report.status), 'Codex reported no status');
  assert(typeof report.reason === 'string' && report.reason.trim(), 'Codex gave no reason');
  assert(report.windowTitle === undefined || typeof report.windowTitle === 'string', 'Invalid window title');
  assert(report.steps === undefined || (Array.isArray(report.steps) && report.steps.every(step => typeof step === 'string')), 'Invalid steps');
  return report;
}

// Computer Use calls that change the app, as they appear in the code Codex runs, with the
// scenario's action type each one counts as.
const INPUT_CALLS = /\.(click|drag|scroll|selectText|setValue|performSecondaryAction|paste|pressKey|typeText|typeCharacters)\s*\(\s*(\{\s*x\b)?/g;
const INPUT_TYPES = Object.freeze({ click: 'click', performSecondaryAction: 'click', drag: 'drag', scroll: 'scroll', pressKey: 'press', selectText: 'type', setValue: 'type', paste: 'type', typeText: 'type', typeCharacters: 'type' });

/** The input calls in one Computer Use step's code, by type. A call inside a loop counts once. */
export function inputCalls(code) {
  return [...String(code ?? '').matchAll(INPUT_CALLS)].map(([, name, point]) => (name === 'click' && point ? 'click_point' : INPUT_TYPES[name]));
}

/**
 * Codex's Computer Use calls, in order, with the screenshots they returned. Accessibility text is
 * left out: Codex reads it to find elements, and it can include text from outside the test window.
 */
export function codexTrace(jsonl) {
  const steps = [];
  for (const line of jsonl.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const item = event?.item;
    if (event.type !== 'item.completed') continue;
    if (['command_execution', 'file_change', 'web_search'].includes(item?.type)) {
      steps.push({ server: item.type, tool: item.type, title: String(item.command ?? item.query ?? item.type), code: '', images: [] });
      continue;
    }
    if (item?.type !== 'mcp_tool_call') continue;
    const content = Array.isArray(item.result?.content) ? item.result.content : [];
    steps.push({
      server: String(item.server ?? ''), tool: String(item.tool ?? ''),
      title: String(item.arguments?.title ?? item.tool ?? 'Computer Use'),
      code: String(item.arguments?.code ?? ''),
      ...(item.error ? { error: String(item.error?.message ?? item.error) } : {}),
      images: content.filter(part => part?.type === 'image' && typeof part.data === 'string').map(part => ({ data: part.data, type: part.mimeType ?? part.mime_type ?? 'image/jpeg' })),
    });
  }
  return steps;
}

export const CODEX_FILES = Object.freeze({ events: 'codex-events.jsonl', lastMessage: 'codex-last-message.txt' });

/**
 * Runs Codex non-interactively on the task. Its event log is kept in the run directory, and each
 * event goes to onEvent as Codex writes it. A failure carries the trace up to that point.
 * @param {{ task: string, directory: string, model?: string, codex?: string, isolation?: string[], executeCommand?: Function, timeoutMs?: number, onEvent?: (event: object) => void, signal?: AbortSignal }} options
 */
export async function runCodex({ task, directory, model, codex = process.env.MOD_UX_CODEX || 'codex', isolation = [], executeCommand = execute, timeoutMs = 900000, onEvent, signal }) {
  const last = join(directory, CODEX_FILES.lastMessage);
  const started = Date.now();
  const decoder = new StringDecoder('utf8');
  let partial = '';
  const onStdout = onEvent && (chunk => {
    const lines = (partial + decoder.write(chunk)).split('\n');
    partial = lines.pop();
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      onEvent(event);
    }
  });
  // stdin is closed (empty input): with stdin open, `codex exec` waits for more input.
  let stdout;
  try {
    ({ stdout } = await executeCommand([codex, 'exec', ...isolation, '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--json', '-o', last, ...(model ? ['-m', model] : []), '-C', join(directory, 'agent-work'), task], { input: '', timeoutMs, signal, maxBytes: 256 * 1024 * 1024, ...(onStdout ? { onStdout } : {}) }));
  } catch (error) {
    if (error.stdout) await writeFile(join(directory, CODEX_FILES.events), error.stdout, { mode: 0o600 });
    throw Object.assign(new Error(failureOf(error.stdout ?? '') ?? error.message), { trace: codexTrace(error.stdout ?? '') });
  }
  await writeFile(join(directory, CODEX_FILES.events), stdout, { mode: 0o600 });
  const trace = codexTrace(stdout);
  try {
    const failure = failureOf(stdout);
    assert(!failure, failure);
    return { report: parseCodexReport(await readFile(last, 'utf8').catch(() => '')), trace, durationMs: Date.now() - started };
  } catch (error) { throw Object.assign(error, { trace }); }
}

// Codex reports a failed turn in its event log, with the provider's message nested in it.
function failureOf(jsonl) {
  for (const line of jsonl.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'turn.failed') continue;
    const message = event.error?.error?.message ?? event.error?.message ?? JSON.stringify(event.error ?? {});
    return `Codex failed: ${message}${/model/i.test(message) ? ' (choose another model with --codex-model)' : ''}`;
  }
  return undefined;
}

const observable = windows => windows.filter(item => item.is_on_screen !== false && !item.is_minimized && item.window_id !== undefined && item.observation_capability !== 'pixels_only');
const tally = types => Object.fromEntries([...new Set(types)].map(type => [type, types.filter(item => item === type).length]));

/**
 * Runs the scenario with Codex driving, while the harness watches and keeps the scenario's limits.
 *
 * The test window is the one new window whose composer names the test folder, checked by its
 * accessibility labels alone (no screenshot) before the harness captures any of it. Windows open
 * before the run are never read, captured or closed. If a second new window names the test folder,
 * the harness can't tell which one Codex used: it drops what it captured and captures, and later
 * closes, neither.
 *
 * Codex is stopped at the time limit (the scenario's, plus CODEX_SETUP_MS), at the step limit (the
 * scenario's, plus CODEX_SETUP_STEPS, counted from the input calls Codex asks for, as it asks), on
 * the run's STOP file (`cli.mjs stop --run`), or on the signal. Codex's failures and stops are
 * returned, not thrown, so the run can be recorded either way.
 * @param {{ scenario: object, workspace: { folder: string, home?: string }, scratch: string, desktop: { windows: Function, inspect: Function }, driverFor: (windowId: number) => { observe: Function }, model?: string, codex?: string, isolation?: string[], stopFile?: string, sampleMs?: number, pinMs?: number, setupMs?: number, run?: Function, signal?: AbortSignal }} options
 */
export async function codexRun({ scenario, workspace, scratch, desktop, driverFor, model, codex, isolation = [], stopFile, sampleMs = 4000, pinMs = 1000, setupMs = CODEX_SETUP_MS, run = runCodex, signal }) {
  const before = new Set((await desktop.windows({ signal })).map(item => String(item.window_id)));
  const frames = [];
  const window = { id: undefined, problem: undefined };

  const controller = new AbortController();
  let ended;
  const end = reason => { ended ??= reason; controller.abort(); };
  const onAbort = () => end('stopped');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) end('stopped');
  const timeMs = setupMs + scenario.limits.maxDurationMs;
  const deadline = setTimeout(() => end('time'), timeMs);
  const stopWatch = stopFile && setInterval(() => access(stopFile).then(() => end('stopped'), () => {}), 200);
  const budget = scenario.limits.maxSteps + CODEX_SETUP_STEPS;
  const inputs = [];
  const counted = new Set();
  // Counted when Codex asks for the call (item.started), so the call over the limit is the last.
  const onEvent = event => {
    const item = event?.item;
    if (!['item.started', 'item.completed'].includes(event?.type) || item?.type !== 'mcp_tool_call' || typeof item.arguments?.code !== 'string') return;
    if (item.id ? counted.has(item.id) : event.type === 'item.started') return;
    if (item.id) counted.add(item.id);
    inputs.push(...inputCalls(item.arguments.code));
    if (inputs.length > budget) end('steps');
  };

  const showingFolder = async items => {
    const found = [];
    for (const item of items) {
      try { if (showsFolder(await desktop.inspect(item.window_id, { signal }), workspace.folder, workspace.home)) found.push(item.window_id); } catch {} // Mid-change; checked again next time.
    }
    return found;
  };
  const sample = async () => {
    const opened = observable(await desktop.windows({ signal })).filter(item => !before.has(String(item.window_id)) && String(item.window_id) !== String(window.id));
    const found = await showingFolder(opened);
    if (found.length && (window.id !== undefined || found.length > 1)) {
      window.problem = `${window.id === undefined ? found.length : found.length + 1} new windows started in the test folder, so the harness can't tell which one Codex used; it captured and closed none of them`;
      window.id = undefined;
      frames.length = 0;
      return;
    }
    if (found.length === 1) window.id = found[0];
    if (window.id === undefined) return;
    const path = join(scratch, `codex-run-${String(frames.length + 1).padStart(3, '0')}.png`);
    frames.push({ at: Date.now(), path, observed: await driverFor(window.id).observe(path, { signal }) });
  };
  const sampling = new AbortController();
  const sampler = (async () => {
    while (!sampling.signal.aborted && !window.problem) {
      try { await sample(); } catch {} // The window may be mid-change, or gone; the next sample tries again.
      try { await delay(window.id === undefined ? pinMs : sampleMs, undefined, { signal: sampling.signal }); } catch {}
    }
  })();

  const startedAt = new Date().toISOString();
  const started = Date.now();
  await mkdir(join(scratch, 'agent-work'), { recursive: true, mode: 0o700 });
  let result, failure;
  try {
    result = await run({ task: codexTask({ scenario, folder: workspace.folder, home: workspace.home }), directory: scratch, model, ...(codex ? { codex } : {}), isolation, timeoutMs: timeMs + 60000, onEvent, signal: controller.signal });
  } catch (error) { failure = error; } finally {
    clearTimeout(deadline); clearInterval(stopWatch);
    signal?.removeEventListener('abort', onAbort);
    sampling.abort();
    await sampler;
  }
  const reasons = {
    stopped: 'Stopped by the operator',
    time: `Time limit reached: ${Math.round(timeMs / 1000)}s in all, setup included`,
    steps: `Step limit reached: Codex asked for input call ${inputs.length}, over the ${budget} allowed (${scenario.limits.maxSteps} for the test, ${CODEX_SETUP_STEPS} for setup). It was stopped then, so that call may not have taken effect`,
  };
  const outcome = ended ?? (failure ? 'error' : 'finished');
  return {
    startedAt, durationMs: Date.now() - started, frames, windowId: window.id, ...(window.problem ? { windowProblem: window.problem } : {}),
    report: result?.report, trace: result?.trace ?? failure?.trace ?? [],
    inputs: { total: inputs.length, byType: tally(inputs), budget },
    ended: outcome, ...(outcome === 'finished' ? {} : { reason: reasons[outcome] ?? failure.message }),
  };
}

/**
 * Starts the run's record before Codex starts, so `cli.mjs stop --run` can find it. The caller
 * holds it (withSession) while Codex works, then hands it to recordCodexRun.
 * @param {{ directory: string, scenario: object, variant?: string, provenance?: object }} options
 */
export async function openCodexRun({ directory, scenario, variant = 'current', provenance = {} }) {
  await mkdir(directory, { mode: 0o700 }); // Fail rather than overwrite an earlier run.
  await mkdir(join(directory, 'agent-work'), { mode: 0o700 });
  const session = {
    version: 1, id: randomUUID(), startedAt: new Date().toISOString(), status: 'running', variant,
    provenance: { ...provenance, driver: 'codex' }, scenario, events: [], agentTimeMs: 0, agentInvocations: [], usage: [], steps: 0,
    target: { kind: 'peekaboo', app: scenario.target.app, interactionMode: 'background' },
  };
  await saveSession(directory, session);
  return session;
}

const FINAL_STATUS = Object.freeze({ stopped: 'stopped', time: 'limit', steps: 'limit', error: 'error' });

/**
 * Writes a Codex-driven run as a harness run: Codex's raw log and reply, the harness's captures of
 * the test window as frames, Codex's steps (as text), input counts and report, one final capture
 * for the checks, the focus log, then the critic's review and the report as for any run.
 * @param {{ directory: string, session: object, outcome: object, scratch: string, driver?: { connect: Function, observe: Function }, focus?: { samples: object[], summary: object }, criticFor?: (session: object) => Function }} options
 */
export async function recordCodexRun({ directory, session, outcome, scratch, driver, focus, criticFor }) {
  // Codex's own log and reply first: they are the evidence if anything after this goes wrong. Its
  // screenshots and accessibility reads may show more than the test window, so they stay out of
  // the report and the critic's request; like everything in the run directory, they stay private.
  const raw = {};
  for (const [key, name] of Object.entries(CODEX_FILES)) {
    try { await copyFile(join(scratch, name), join(directory, name)); await chmod(join(directory, name), 0o600); raw[key] = name; } catch {}
  }
  if (focus) {
    await writeFile(join(directory, 'focus.json'), JSON.stringify(focus, null, 2) + '\n', { mode: 0o600 });
    session.provenance.focus = focus.summary;
  }
  session.agentTimeMs += outcome.durationMs;
  session.agentInvocations.push({ role: 'tester', agent: 'codex', status: outcome.ended === 'finished' ? 'completed' : outcome.ended, durationMs: outcome.durationMs, at: outcome.startedAt });
  session.steps = outcome.inputs.total;
  const started = Date.parse(session.startedAt);
  const frame = async (from, observed, at, note) => {
    const image = `frame-${String(session.events.length + 1).padStart(4, '0')}.png`;
    await copyFile(from, join(directory, image));
    const event = addEvent(session, 'observation', {
      image, receipt: observed.receipt, elements: observed.elements, focus: observed.focus, warnings: observed.warnings,
      semanticCoverage: observed.semanticCoverage ?? 'available', note,
    });
    Object.assign(event, { at: new Date(at).toISOString(), elapsedMs: at - started });
  };
  for (const item of outcome.frames) await frame(item.path, item.observed, item.at, 'Harness capture of the test window while Codex worked');
  const breaches = outcome.trace.filter(step => step.server && !COMPUTER_USE_SERVERS.has(step.server)).map(step => `${step.server}.${step.tool}`);
  addEvent(session, 'native', {
    driver: 'codex', ended: outcome.ended, ...(outcome.reason ? { reason: outcome.reason } : {}), ...(outcome.report ? { report: outcome.report } : {}), durationMs: outcome.durationMs,
    inputs: { ...outcome.inputs, counting: 'Input calls in the code of each Computer Use step Codex asked for, setup included. A call inside a loop counts once.' },
    steps: outcome.trace.map(({ server, tool, title, code, error, images }) => ({ server, tool, title, code, ...(error ? { error } : {}), screenshots: images.length })),
    ...(breaches.length ? { isolationBreaches: breaches } : {}), raw,
    note: 'Codex\'s own screenshots and accessibility reads are in codex-events.jsonl only, outside the report: they may show more than the test window.',
  });
  if (driver) {
    session.target = { ...await driver.connect(), interactionMode: 'background' };
    const finalPath = join(scratch, 'final.png');
    try { await frame(finalPath, await driver.observe(finalPath), Date.now(), 'Final state, captured by the harness after Codex finished'); }
    catch (error) { session.error ??= `Final capture of the test window failed: ${error.message}`; }
  }
  const problems = [
    ...(outcome.ended === 'error' ? [outcome.reason] : []),
    ...(breaches.length ? [`Codex used tools outside Computer Use: ${[...new Set(breaches)].join(', ')}`] : []),
    ...(!driver && outcome.ended === 'finished' ? [outcome.windowProblem ?? 'The harness found no new window whose composer named the test folder, so it captured no test window'] : []),
  ];
  if (problems.length) session.error = [session.error, ...problems].filter(Boolean).join('; ');
  const status = FINAL_STATUS[outcome.ended] ?? (outcome.report.status === 'done' ? 'completed' : 'blocked');
  await finishSession({ directory, session, status, summary: outcome.report ? `Codex: ${outcome.report.reason}` : outcome.reason });
  if (criticFor && status !== 'stopped') await reviewSession({ directory, session, critic: criticFor(session) });
  return session;
}
