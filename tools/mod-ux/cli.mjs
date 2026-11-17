#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PeekabooDriver } from './src/peekaboo.mjs';
import { FixtureDriver } from './src/fixture.mjs';
import { validateScenario, assert } from './src/protocol.mjs';
import { commandArray, execute } from './src/process.mjs';
import { assertPrivateOutput } from './src/output.mjs';
import { findPluginDir, prepareWorkspace, cleanupWorkspace, startDesktopSession, frontApp } from './src/launch.mjs';
import { codexIsolation, codexRun, openCodexRun, recordCodexRun, resolveCodex } from './src/codex.mjs';
import { watchFocus } from './src/focus.mjs';
import { claudeKeyTaps } from './src/taps.mjs';
import { createSession, withSession, driverFor, capture, applyAction, finishSession, runLoop, agentCaller, reviewSession } from './src/session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const help = `Mod UX Lab · desktop-first mod testing (Node 22+)

  node tools/mod-ux/cli.mjs try SCENARIO... [--driver peekaboo|codex] [--codex-model MODEL] [--plugin DIR] [--out DIRECTORY] [--critic claude|none] [--keep-workspace]
      --driver codex is experimental: Codex's Computer Use does the input, in the background.
  node tools/mod-ux/cli.mjs demo [--out NEW_DIRECTORY] [--control]
  node tools/mod-ux/cli.mjs doctor
  node tools/mod-ux/cli.mjs windows
  node tools/mod-ux/cli.mjs start SCENARIO --out NEW_DIRECTORY [--window ID] [--variant LABEL]
  node tools/mod-ux/cli.mjs observe --run DIRECTORY
  node tools/mod-ux/cli.mjs act --run DIRECTORY --observation ID --action JSON
  node tools/mod-ux/cli.mjs finish --run DIRECTORY --status completed --summary TEXT [--critic claude]
  node tools/mod-ux/cli.mjs run SCENARIO --out NEW_DIRECTORY --actor claude [--critic claude] [--window ID]
  node tools/mod-ux/cli.mjs stop --run DIRECTORY

Agents: 'claude' uses the terminal CLI; alternatively pass a JSON argv array.
Use --require-assessed on run/finish for exit 2 when checks are missing or unassessed.
Outputs inside Git must be ignored; --allow-unignored-output explicitly overrides this check.
Model options: --model NAME --call-budget-usd 0.50 (per invocation; target costs separate).
Desktop driver: Peekaboo 4.9.8+, macOS, Screen Recording + Accessibility permission.
Set MOD_UX_PEEKABOO to its executable. No automatic installation or permission changes.
Try installs the scenario's plugin for a reused test folder only, opens that folder as a new Claude
Desktop session in a window of its own, runs the scenario's setup, the tester and the critic in that
window, then closes it and removes the install again.
Start and run attach to a session you prepared yourself; they do not install mods.
All commands return JSON. Reports and screenshots stay in the run directory.
See tools/mod-ux/README.md for contracts, limits and setup.
`;

function summary(directory, session) {
  return { run: directory, status: session.status, summary: session.summary, error: session.error, finishRequest: session.finishRequest, actions: session.metrics?.actions, checks: session.checkResults ?? [], criticError: session.criticError, report: join(directory, 'report.html') };
}

function runExitCode(session, requireAssessed) {
  const failed = session.status !== 'completed' || Boolean(session.error || session.criticError) ||
    (session.checkResults ?? []).some(check => check.status === 'failed') ||
    session.events.some(event => event.kind === 'action' && ['pending', 'uncertain'].includes(event.outcome));
  if (failed) return 1;
  const checks = session.checkResults ?? [];
  return requireAssessed && (!checks.length || checks.some(check => check.status !== 'passed')) ? 2 : 0;
}

function validateAgent(mode, role) {
  if (mode === undefined || mode === 'claude') return;
  try { commandArray(mode); }
  catch { throw new Error(`--${role} must be claude or a JSON argv array of command strings`); }
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, out: { type: 'string' }, run: { type: 'string' }, window: { type: 'string' },
    variant: { type: 'string' }, observation: { type: 'string' }, action: { type: 'string' }, actor: { type: 'string' }, critic: { type: 'string' },
    status: { type: 'string' }, summary: { type: 'string' }, model: { type: 'string' }, 'call-budget-usd': { type: 'string' }, control: { type: 'boolean' },
    'require-assessed': { type: 'boolean' }, 'allow-unignored-output': { type: 'boolean' },
    plugin: { type: 'string' }, 'keep-workspace': { type: 'boolean' }, driver: { type: 'string' }, 'codex-model': { type: 'string' },
  } });
  const [command, scenarioFile] = positionals;
  if (values.help || !command) { console.log(help); return; }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const modelOptions = { model: values.model, callBudgetUsd: Number(values['call-budget-usd'] ?? 0.5), signal: controller.signal };
  if (command === 'run') validateAgent(values.actor, 'actor');
  if (command === 'try') validateAgent(values.actor, 'actor');
  if (command === 'try') assert([undefined, 'peekaboo', 'codex'].includes(values.driver), '--driver must be peekaboo or codex');
  if (['run', 'finish', 'try'].includes(command)) {
    if (!(command === 'try' && values.critic === 'none')) validateAgent(values.critic, 'critic');
    assert(Number.isFinite(modelOptions.callBudgetUsd) && modelOptions.callBudgetUsd > 0 && modelOptions.callBudgetUsd <= 100, 'Invalid Claude invocation budget');
  }
  if (command === 'doctor') {
    try { console.log(JSON.stringify(await new PeekabooDriver().doctor({ signal: controller.signal }), null, 2)); }
    catch (error) { throw new Error(`${error.message}\nInstall the signed CLI: brew install openclaw/tap/peekaboo. Then review 'peekaboo permissions status'.`); }
    return;
  }
  if (command === 'windows') { console.log(JSON.stringify(await new PeekabooDriver().windows({ signal: controller.signal }), null, 2)); return; }
  if (command === 'demo') {
    const directory = resolve(values.out ?? `.mod-ux/demo-${Date.now()}`);
    await assertPrivateOutput(directory, { allowUnignored: values['allow-unignored-output'] });
    await mkdir(dirname(directory), { recursive: true });
    const scenario = JSON.parse(await readFile(join(here, 'tests/fixtures/draft-preservation.json'), 'utf8'));
    const driver = new FixtureDriver({ buggy: !values.control });
    await createSession({ scenario, directory, driver, variant: values.control ? 'synthetic-control' : 'injected-draft-loss' });
    const script = [
      { status: 'act', reason: 'Write a draft before opening the usage pane.', action: { type: 'type', text: 'Please explain this failing test.' } },
      { status: 'act', reason: 'Inspect the synthetic usage pane without sending the draft.', action: { type: 'click', element: 'usage' } },
      { status: 'done', reason: 'Opened the usage pane; the configured preservation check assesses the draft.' },
    ];
    const result = await withSession(directory, async session => runLoop({ directory, session, driver, actor: async () => script.shift(), signal: controller.signal }));
    console.log(JSON.stringify(summary(directory, result), null, 2));
    return;
  }
  if (command === 'try') {
    const files = positionals.slice(1);
    assert(files.length > 0, 'try needs one or more scenario files');
    assert(!values.out || files.length === 1, 'With several scenarios, --out is not used: each run goes to .mod-ux/');
    const actor = values.actor ?? 'claude';
    const critic = values.critic === 'none' ? undefined : values.critic ?? 'claude';
    const results = [];
    // Only an OpenAI-signed Codex is run, whatever comes first on PATH.
    const codex = values.driver === 'codex' ? await resolveCodex({ signal: controller.signal }) : undefined;
    // Computer Use and nothing else: checked before any run starts.
    const isolation = codex ? await codexIsolation({ codex: codex.binary, signal: controller.signal }) : undefined;
    if (codex) {
      // A computer-use controller's leftover keyboard taps on Claude can make every key arrive twice.
      const held = await claudeKeyTaps({ signal: controller.signal });
      assert(!held.length, `${[...new Set(held.map(tap => tap.tapper))].join(', ')} already holds keyboard taps on Claude Desktop, which can repeat what you type there. Quit and reopen Claude Desktop first.`);
    }
    for (const file of files) {
      const source = await readFile(resolve(file), 'utf8');
      const scenario = validateScenario(JSON.parse(source));
      const pluginDir = resolve(values.plugin ?? await findPluginDir(file));
      const directory = resolve(values.out ?? join('.mod-ux', `${basename(file, '.json')}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
      await assertPrivateOutput(directory, { allowUnignored: values['allow-unignored-output'] });
      await mkdir(dirname(directory), { recursive: true });
      await frontApp(execute, controller.signal); // Fails early, before installing anything, when the Mac is locked.
      const workspace = await prepareWorkspace({ pluginDir, setup: scenario.setup, signal: controller.signal });
      let result, setupError, windowId, focusBack, focusLog, leftTaps = [];
      const desktop = new PeekabooDriver();
      const provenance = { scenarioSHA256: createHash('sha256').update(source).digest('hex'), plugin: workspace.name, pluginVersion: workspace.version, pluginDir, folder: workspace.folder, ...(codex ? { codexBinary: codex.binary } : {}) };
      const variant = values.variant ?? `${workspace.name}@${workspace.version ?? 'unversioned'}`;
      const focus = values.driver === 'codex' ? watchFocus() : undefined;
      try {
        if (values.driver === 'codex') {
          // Experimental. Codex does every bit of input; the harness watches, keeps the limits and
          // captures the test window once it has made sure which window that is. The run's record
          // exists from the start, so `stop --run` stops Codex too.
          const scratch = join(workspace.root, 'codex');
          await openCodexRun({ directory, scenario, variant, provenance });
          result = await withSession(directory, async session => {
            if (session.finishedAt) return session; // Stopped before Codex started.
            try {
              const outcome = await codexRun({ scenario, workspace, scratch, desktop, driverFor: id => new PeekabooDriver({ windowId: id }), model: values['codex-model'], codex: codex.binary, isolation: isolation.args, stopFile: join(directory, 'STOP'), signal: controller.signal });
              windowId = outcome.windowId; // Set only for a window verified as the test window.
              focusLog = await focus.stop();
              return await recordCodexRun({ directory, session, outcome, scratch, driver: windowId === undefined ? undefined : new PeekabooDriver({ windowId }), focus: focusLog,
                criticFor: critic && (current => agentCaller(critic, { ...modelOptions, cwd: join(directory, 'agent-work'), timeoutMs: scenario.limits.agentTimeoutMs, session: current })) });
            } catch (error) {
              // The harness failed, not Codex: the record says so rather than staying "running".
              if (!session.finishedAt) { session.error ??= error.message; await finishSession({ directory, session, status: 'error', summary: error.message }).catch(() => {}); }
              throw error;
            }
          });
        } else {
        try {
          // Setup is a few seconds of foreground input to the new window, which has taken focus
          // anyway. A background run gets focus back straight after; a foreground one keeps it until
          // the run ends.
          ({ windowId, focusBack } = await startDesktopSession({ workspace, desktop, driverFor: (id, interactionMode = 'background') => new PeekabooDriver({ windowId: id, interactionMode }), setup: scenario.setup, keepFocus: scenario.target.interactionMode === 'foreground', screenshots: join(workspace.root, 'setup'), onNotice: message => console.error(message), onWindow: id => { windowId = id; }, signal: controller.signal }));
        } catch (error) { setupError = error; throw error; }
        await createSession({ scenario, directory, windowId, variant, provenance });
        result = await withSession(directory, async current => {
          const options = { ...modelOptions, cwd: join(directory, 'agent-work'), timeoutMs: scenario.limits.agentTimeoutMs, session: current };
          return runLoop({ directory, session: current, driver: driverFor(current), actor: agentCaller(actor, options), critic: critic && agentCaller(critic, options), signal: controller.signal });
        });
        }
      } finally {
        if (focusBack) await focusBack().catch(error => console.error(`Could not give focus back: ${error.message}`));
        if (focus && !focusLog) focusLog = await focus.stop().catch(() => undefined);
        leftTaps = codex ? await claudeKeyTaps().catch(error => [{ tapper: `unknown (${error.message})` }]) : [];
        if (leftTaps.length) console.error(`${[...new Set(leftTaps.map(tap => tap.tapper))].join(', ')} still holds ${leftTaps.length} keyboard tap(s) on Claude Desktop; keys you type there may arrive twice. Quit and reopen Claude Desktop to clear them.`);
        const keepFolder = Boolean(values['keep-workspace'] || setupError);
        const cleanup = await cleanupWorkspace(workspace, { keepFolder });
        if (windowId !== undefined) await desktop.closeWindow(windowId).catch(error => cleanup.push(`window: ${error.message}`));
        results.push({
          scenario: file, ...(result ? summary(directory, result) : { run: directory, status: 'error' }),
          ...(setupError ? { setupScreenshots: join(workspace.root, 'setup') } : {}),
          desktopSession: `The test session stays in Claude Desktop's sidebar under ${basename(workspace.folder)}; archive it when done.`,
          testFolder: workspace.folder, ...(keepFolder ? { runFiles: workspace.root } : {}), ...(cleanup.length ? { cleanupFailures: cleanup } : {}),
          ...(focusLog ? { focus: focusLog.summary } : {}), ...(leftTaps.length ? { claudeKeyTapsLeft: leftTaps } : {}), ...(codex ? { codex: codex.binary, codexSwitchedOff: isolation.off.servers, ...(codex.passedOver.length ? { codexPassedOver: codex.passedOver } : {}) } : {}),
        });
        if (!result) console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
      }
      // A failure (1) outranks missing evidence (2), across scenarios as within one. Keyboard taps
      // left on Claude Desktop fail the run whatever its result: they repeat what you type there.
      const code = leftTaps.length ? 1 : runExitCode(result, values['require-assessed']);
      process.exitCode = [process.exitCode ?? 0, code].includes(1) ? 1 : Math.max(process.exitCode ?? 0, code);
    }
    console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
    return;
  }
  if (['start', 'run'].includes(command)) {
    assert(scenarioFile && values.out, 'A scenario file and --out NEW_DIRECTORY are required');
    if (command === 'run') assert(values.actor, '--actor is required; use claude or a JSON argv array');
    const source = await readFile(resolve(scenarioFile), 'utf8');
    const scenario = validateScenario(JSON.parse(source));
    const directory = resolve(values.out);
    await assertPrivateOutput(directory, { allowUnignored: values['allow-unignored-output'] });
    await mkdir(dirname(directory), { recursive: true });
    const session = await createSession({ scenario, directory, windowId: values.window, variant: values.variant, provenance: { scenarioSHA256: createHash('sha256').update(source).digest('hex') } });
    if (command === 'start') {
      console.log(JSON.stringify({ ...summary(directory, session), observation: session.currentObservationId }, null, 2));
      return;
    }
    const result = await withSession(directory, async current => {
      const options = { ...modelOptions, cwd: join(directory, 'agent-work'), timeoutMs: scenario.limits.agentTimeoutMs, session: current };
      return runLoop({ directory, session: current, driver: driverFor(current), actor: agentCaller(values.actor, options), critic: values.critic && agentCaller(values.critic, options), signal: controller.signal });
    });
    console.log(JSON.stringify(summary(directory, result), null, 2));
    process.exitCode = runExitCode(result, values['require-assessed']);
    return;
  }
  assert(['observe', 'act', 'finish', 'stop'].includes(command), `Unknown command: ${command}`);
  assert(values.run, '--run DIRECTORY is required');
  const directory = resolve(values.run);
  if (command === 'stop') {
    await readFile(join(directory, 'session.json'), 'utf8');
    await writeFile(join(directory, 'STOP'), new Date().toISOString(), { mode: 0o600 });
    try {
      await withSession(directory, session => session.finishedAt ? session : finishSession({ directory, session, status: 'stopped', summary: 'Stopped by the operator. Target Claude work, if any, was not canceled.' }));
    } catch (error) { if (!error.message.startsWith('Run is busy.')) throw error; }
    console.log(JSON.stringify({ run: directory, stopRequested: true, note: 'Stops the harness; does not cancel work already running inside Claude Desktop.' }));
    return;
  }
  const result = await withSession(directory, async session => {
    if (command === 'observe') return capture({ directory, session, driver: driverFor(session), signal: controller.signal });
    if (command === 'act') {
      assert(values.action && values.observation, '--action JSON and --observation ID are required');
      return applyAction({ directory, session, driver: driverFor(session), action: JSON.parse(values.action), observationId: values.observation, signal: controller.signal });
    }
    assert(values.summary, '--summary is required');
    await finishSession({ directory, session, status: values.status ?? 'completed', summary: values.summary });
    if (values.critic) await reviewSession({ directory, session, critic: agentCaller(values.critic, { ...modelOptions, cwd: join(directory, 'agent-work'), timeoutMs: session.scenario.limits.agentTimeoutMs, session }) });
    process.exitCode = runExitCode(session, values['require-assessed']);
    return summary(directory, session);
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
