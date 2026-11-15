#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PeekabooDriver } from './src/peekaboo.mjs';
import { FixtureDriver } from './src/fixture.mjs';
import { validateScenario, assert } from './src/protocol.mjs';
import { commandArray } from './src/process.mjs';
import { assertPrivateOutput } from './src/output.mjs';
import { createSession, withSession, driverFor, capture, applyAction, finishSession, runLoop, agentCaller, reviewSession } from './src/session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const help = `Mod UX Lab · desktop-first mod testing (Node 22+)

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
Start attaches to a manually prepared, disposable Claude Desktop session. It does not reset or install mods.
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
  } });
  const [command, scenarioFile] = positionals;
  if (values.help || !command) { console.log(help); return; }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const modelOptions = { model: values.model, callBudgetUsd: Number(values['call-budget-usd'] ?? 0.5), signal: controller.signal };
  if (command === 'run') validateAgent(values.actor, 'actor');
  if (['run', 'finish'].includes(command)) {
    validateAgent(values.critic, 'critic');
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
