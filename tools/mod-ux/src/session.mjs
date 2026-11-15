import { mkdir, readFile, writeFile, rename, open, unlink, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assert, matches, validateAction, validateScenario, validateDecision, validateCritic } from './protocol.mjs';
import { PeekabooDriver } from './peekaboo.mjs';
import { FixtureDriver } from './fixture.mjs';
import { writeReport } from './report.mjs';
import { callClaude, callCommandAgent, TESTER_PROMPT, CRITIC_PROMPT } from './agents.mjs';
import { measureSession } from './metrics.mjs';

async function exists(file) { try { await access(file); return true; } catch { return false; } }
const elapsed = session => Date.now() - Date.parse(session.startedAt);

export function addEvent(session, kind, data) {
  const event = { id: `e${String(session.events.length + 1).padStart(4, '0')}`, kind, at: new Date().toISOString(), elapsedMs: elapsed(session), ...data };
  session.events.push(event);
  return event;
}

export async function saveSession(directory, session) {
  session.metrics = measureSession(session);
  const temporary = join(directory, `.session-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(session, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, join(directory, 'session.json'));
  await writeReport(directory, session);
}

export async function withSession(directory, callback) {
  directory = resolve(directory);
  let lock;
  try { lock = await open(join(directory, '.lock'), 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Run is busy. After a crashed process exits, remove its .lock before continuing.'); throw error; }
  try {
    await lock.writeFile(String(process.pid));
    const session = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8'));
    const pending = session.events.filter(event => event.kind === 'action' && event.outcome === 'pending');
    if (pending.length && !session.finishedAt) {
      const error = 'Harness exited before the action outcome was recorded. Inspect the target and start a new run.';
      for (const event of pending) { event.outcome = 'uncertain'; event.error = error; }
      session.status = 'blocked';
      session.error ??= error;
      session.observationConsumed = true;
      await saveSession(directory, session);
    }
    return await callback(session, directory);
  } finally { await lock.close(); await unlink(join(directory, '.lock')); }
}

export function driverFor(session) {
  if (session.target.kind === 'fixture') return new FixtureDriver({ state: session.fixtureState });
  assert(session.target.kind === 'peekaboo', 'Unknown saved driver');
  return new PeekabooDriver(session.target);
}

/** @param {import('./options.mjs').CommandOptions} [options] */
function processOptions(session, options = {}) {
  const remaining = session.scenario.limits.maxDurationMs - elapsed(session);
  assert(remaining > 0, 'Run duration limit reached');
  return { ...options, timeoutMs: Math.min(options.timeoutMs ?? 30000, remaining) };
}

/** @param {import('./options.mjs').CaptureOptions} options */
export async function capture({ directory, session, driver, ...options }) {
  assert(!session.finishedAt, 'Run is already finalized; start a new run for new observations');
  const started = Date.now();
  const filename = `frame-${String(session.events.length + 1).padStart(4, '0')}.${session.target.kind === 'fixture' ? 'svg' : 'png'}`;
  const observed = await driver.observe(join(directory, filename), processOptions(session, options));
  const event = addEvent(session, 'observation', {
    image: filename, receipt: observed.receipt, elements: observed.elements, focus: observed.focus,
    warnings: observed.warnings, semanticCoverage: observed.semanticCoverage ?? 'available', durationMs: Date.now() - started,
  });
  session.currentObservationId = event.id;
  session.observationConsumed = session.status !== 'running';
  if (driver.state) session.fixtureState = driver.state;
  await saveSession(directory, session);
  return publicObservation(directory, event);
}

export function publicObservation(directory, event) {
  // Hidden target receipts and implementation identifiers do not reach the tester.
  return { id: event.id, screenshotPath: join(directory, event.image), elements: event.elements, warnings: event.warnings, semanticCoverage: event.semanticCoverage };
}

/** @param {import('./options.mjs').CreateSessionOptions} options */
export async function createSession({ scenario, directory, driver, windowId, variant = 'current', provenance = {} }) {
  scenario = validateScenario(scenario);
  directory = resolve(directory);
  await mkdir(directory, { mode: 0o700 }); // Fail rather than overwrite an earlier run.
  await mkdir(join(directory, 'agent-work'), { mode: 0o700 });
  const session = { version: 1, id: randomUUID(), startedAt: new Date().toISOString(), status: 'running', variant, provenance, scenario, events: [], agentTimeMs: 0, agentInvocations: [], usage: [], steps: 0 };
  try {
    driver ??= new PeekabooDriver({ app: scenario.target.app, interactionMode: scenario.target.interactionMode, windowId });
    session.target = await driver.connect(processOptions(session));
    if (driver.state) session.fixtureState = driver.state;
    await saveSession(directory, session);
    await capture({ directory, session, driver });
    return session;
  } catch (error) {
    session.status = 'error'; session.error = error.message;
    await saveSession(directory, session);
    throw error;
  }
}

/** @param {import('./options.mjs').ActionOptions} options */
export async function applyAction({ directory, session, driver, action, observationId, ...options }) {
  assert(session.status === 'running', `Run is ${session.status}`);
  assert(!session.events.some(event => event.kind === 'action' && ['pending', 'uncertain'].includes(event.outcome)), 'Run has unresolved input; inspect the target and start a new run');
  assert(!await exists(join(directory, 'STOP')), 'Run was stopped');
  assert(session.steps < session.scenario.limits.maxSteps, 'Step limit reached');
  assert(observationId === session.currentObservationId && !session.observationConsumed, 'Action needs the latest, unconsumed observation');
  const observation = session.events.find(event => event.id === observationId);
  assert(Date.now() - Date.parse(observation.at) <= session.scenario.limits.maxObservationAgeMs, 'Observation expired; observe again');
  validateAction(action, observation, session.scenario.allowedActions);
  if (action.type === 'click_point') assert(session.target.interactionMode === 'foreground', 'Point clicks require a scenario with foreground mode');
  processOptions(session, options);
  session.observationConsumed = true;
  session.steps++;
  const event = addEvent(session, 'action', { action, before: observationId, outcome: 'pending' });
  await saveSession(directory, session); // Consume before sending anything; never retry an uncertain mutation.
  const started = Date.now();
  try {
    if (action.type === 'wait') await delay(action.ms, undefined, { signal: options.signal });
    else event.driverResult = await driver.act(action, observation, processOptions(session, options));
    event.outcome = 'dispatched';
    event.durationMs = Date.now() - started;
    const after = await capture({ directory, session, driver, ...options });
    event.after = after.id;
    await saveSession(directory, session);
    return after;
  } catch (error) {
    event.outcome = 'uncertain'; event.error = error.message; event.durationMs = Date.now() - started;
    session.status = 'blocked'; session.error = error.message;
    if (driver.state) session.fixtureState = driver.state;
    // Observe once for evidence if the run still has time. Never replay the action.
    try { const after = await capture({ directory, session, driver, ...options }); event.after = after.id; } catch {}
    session.observationConsumed = true;
    await saveSession(directory, session);
    throw error;
  }
}

export function evaluateChecks(session) {
  const observations = session.events.filter(event => event.kind === 'observation');
  const final = observations.at(-1);
  return session.scenario.checks.map(check => {
    if (['present', 'absent'].includes(check.kind)) {
      if (!final) return { id: check.id, status: 'unassessed', description: 'No observation was captured.', evidence: [] };
      const present = final.elements.some(element => matches(element, check.selector));
      if (!present && final.semanticCoverage === 'sparse') return { id: check.id, status: 'unassessed', description: 'Sparse accessibility evidence cannot establish that this selector is absent.', evidence: [final.id] };
      const passed = check.kind === 'present' ? present : !present;
      return { id: check.id, status: passed ? 'passed' : 'failed', description: `Final observation ${check.kind === 'present' ? 'must contain' : 'must not contain'} ${JSON.stringify(check.selector)}.`, evidence: [final.id] };
    }
    const exercised = [];
    for (const event of session.events.filter(item => item.kind === 'action' && item.action.type === 'click')) {
      const before = session.events.find(item => item.id === event.before);
      const after = session.events.find(item => item.id === event.after);
      const clicked = before?.elements.find(item => item.id === event.action.element);
      if (!clicked || !matches(clicked, check.after)) continue;
      const evidence = [before.id, event.id, ...(after ? [after.id] : [])];
      if (event.outcome !== 'dispatched' || !after) {
        exercised.push({ status: 'unassessed', evidence });
        continue;
      }
      const initial = before.elements.filter(item => matches(item, check.selector));
      const resulting = after.elements.filter(item => matches(item, check.selector));
      if (check.kind === 'appeared') {
        const unassessed = initial.length > 0 || before.semanticCoverage === 'sparse' || (!resulting.length && after.semanticCoverage === 'sparse');
        const status = unassessed ? 'unassessed' : resulting.length ? 'passed' : 'failed';
        exercised.push({ status, evidence });
      } else if (check.kind === 'disappeared') {
        const unassessed = !initial.length || (!resulting.length && after.semanticCoverage === 'sparse');
        const status = unassessed ? 'unassessed' : resulting.length ? 'failed' : 'passed';
        exercised.push({ status, evidence });
      } else if (initial.length !== 1 || resulting.length !== 1 || initial[0].value === undefined || resulting[0].value === undefined) {
        exercised.push({ status: 'unassessed', evidence });
      } else exercised.push({ status: initial[0].value === resulting[0].value ? 'passed' : 'failed', evidence });
    }
    const status = exercised.some(item => item.status === 'failed') ? 'failed' : exercised.length && exercised.every(item => item.status === 'passed') ? 'passed' : 'unassessed';
    const description = ['appeared', 'disappeared'].includes(check.kind)
      ? `${JSON.stringify(check.selector)} must ${check.kind === 'appeared' ? 'appear' : 'disappear'} across clicking ${JSON.stringify(check.after)}.`
      : `Value of ${JSON.stringify(check.selector)} must survive clicking ${JSON.stringify(check.after)}.`;
    return { id: check.id, status, description: status === 'unassessed' ? 'Trigger was not confirmed, or required before/after evidence was missing, sparse or ambiguous.' : description, evidence: [...new Set(exercised.flatMap(item => item.evidence))] };
  });
}

/** @param {import('./options.mjs').FinishOptions} options */
export async function finishSession({ directory, session, status, summary }) {
  assert(['completed', 'blocked', 'error', 'limit', 'stopped'].includes(status), 'Invalid final status');
  assert(!session.finishedAt, 'Run is already finalized');
  if (session.status === 'running') {
    session.status = status;
    session.summary = summary;
  } else {
    session.finishRequest = { status, summary };
    session.summary = session.error ?? summary;
  }
  session.finishedAt = new Date().toISOString();
  session.checkResults = evaluateChecks(session);
  await saveSession(directory, session);
  return session;
}

export function testerRequest(directory, session) {
  const observation = session.events.find(event => event.id === session.currentObservationId);
  return {
    version: 1, role: 'tester', instructions: TESTER_PROMPT,
    goal: session.scenario.goal, constraints: session.scenario.constraints ?? [], allowedActions: session.scenario.allowedActions,
    actionBudget: { remaining: Math.max(0, session.scenario.limits.maxSteps - session.steps) },
    interactionMode: session.target.interactionMode ?? 'background',
    actionSchema: { click: { type: 'click', element: 'current actionable element ID' }, click_point: { type: 'click_point', x: 0.5, y: 0.5 }, type: { type: 'type', text: 'literal single line' }, press: { type: 'press', key: 'return' }, scroll: { type: 'scroll', element: 'current element ID', direction: 'down', amount: 3 }, wait: { type: 'wait', ms: 1000 } },
    observation: publicObservation(directory, observation),
    history: session.events.filter(event => ['action', 'decision'].includes(event.kind)).map(({ id, kind, action, result, outcome, error }) => ({ id, kind, action, result, outcome, error })),
  };
}

/** @param {import('./options.mjs').ReviewOptions} options */
export async function reviewSession({ directory, session, critic, ...options }) {
  delete session.critic;
  delete session.criticError;
  const observations = session.events.filter(event => event.kind === 'observation');
  // Bounded, explicitly indexed samples; the full accessibility/action trace is still supplied.
  const samples = observations.filter((_, index) => index === 0 || index === observations.length - 1 || index % Math.max(1, Math.ceil(observations.length / 4)) === 0).slice(0, 6);
  const request = {
    version: 1, role: 'critic', instructions: CRITIC_PROMPT, goal: session.scenario.goal,
    driver: { kind: session.target.kind, interactionMode: session.target.interactionMode ?? 'background' },
    status: session.status, testerSummary: session.summary, checks: session.checkResults,
    trace: session.events.map(({ receipt, driverResult, ...event }) => event),
    imageEvidence: samples.map(event => ({ id: event.id, path: join(directory, event.image) })),
    images: samples.map(event => join(directory, event.image)),
  };
  try {
    session.critic = validateCritic(await critic(request, options), new Set(session.events.map(event => event.id)));
  } catch (error) { session.criticError = error.message; }
  await saveSession(directory, session);
}

/**
 * @param {import('./options.mjs').AgentCallerOptions} [options]
 * @returns {import('./options.mjs').Agent}
 */
export function agentCaller(mode, { model, callBudgetUsd = 0.5, timeoutMs = 60000, cwd, signal, session } = {}) {
  return async (request, callOptions = {}) => {
    const started = Date.now();
    let status = 'error';
    try {
      if (mode === 'claude') {
        const { result, usage } = await callClaude(request, { model, budgetUsd: callBudgetUsd, timeoutMs, cwd, signal: callOptions.signal ?? signal });
        session?.usage.push({ role: request.role, ...usage });
        status = 'completed';
        return result;
      }
      const result = await callCommandAgent(mode, request, { timeoutMs, cwd, signal: callOptions.signal ?? signal });
      status = 'completed';
      return result;
    } finally {
      if (session) {
        const durationMs = Date.now() - started;
        session.agentTimeMs += durationMs;
        session.agentInvocations ??= [];
        session.agentInvocations.push({ role: request.role, status, durationMs, at: new Date().toISOString() });
      }
    }
  };
}

/** @param {import('./options.mjs').RunOptions} options */
export async function runLoop({ directory, session, driver, actor, critic, signal }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const deadline = setTimeout(abort, Math.max(1, session.scenario.limits.maxDurationMs - elapsed(session)));
  const stopTimer = setInterval(async () => { if (await exists(join(directory, 'STOP'))) abort(); }, 200);
  try {
    while (session.status === 'running') {
      if (controller.signal.aborted) throw new Error('Run stopped or duration limit reached');
      const request = testerRequest(directory, session);
      const decision = validateDecision(await actor(request, { signal: controller.signal }), request.observation, session.scenario.allowedActions);
      addEvent(session, 'decision', { result: decision });
      await saveSession(directory, session);
      if (decision.status !== 'act') {
        await finishSession({ directory, session, status: decision.status === 'done' ? 'completed' : 'blocked', summary: `Tester self-report: ${decision.reason}` });
        break;
      }
      if (session.steps >= session.scenario.limits.maxSteps) {
        await finishSession({ directory, session, status: 'limit', summary: 'Step limit reached; tester requested more input.' });
        break;
      }
      await applyAction({ directory, session, driver, action: decision.action, observationId: request.observation.id, signal: controller.signal });
    }
  } catch (error) {
    session.error ??= error.message;
    const stopped = signal?.aborted || await exists(join(directory, 'STOP'));
    await finishSession({ directory, session, status: stopped ? 'stopped' : elapsed(session) >= session.scenario.limits.maxDurationMs ? 'limit' : 'error', summary: error.message });
  } finally {
    clearTimeout(deadline); clearInterval(stopTimer);
    signal?.removeEventListener('abort', abort);
  }
  if (critic && !signal?.aborted && !await exists(join(directory, 'STOP'))) await reviewSession({ directory, session, critic, signal });
  return session;
}
