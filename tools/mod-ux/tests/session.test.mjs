import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FixtureDriver } from '../src/fixture.mjs';
import { createSession, withSession, applyAction, capture, finishSession, runLoop, testerRequest, evaluateChecks, reviewSession, saveSession, addEvent } from '../src/session.mjs';
import { execute } from '../src/process.mjs';
import { validateAction, validateCritic, validateScenario } from '../src/protocol.mjs';

const source = JSON.parse(await readFile(new URL('./fixtures/draft-preservation.json', import.meta.url), 'utf8'));
async function setup(t, { buggy = false, scenario = source } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mod-ux-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  const driver = new FixtureDriver({ buggy });
  const session = await createSession({ scenario, directory, driver });
  return { root, directory, driver, session };
}

for (const buggy of [false, true]) test(`end-to-end fixture ${buggy ? 'detects injected draft loss' : 'passes good control'}`, async t => {
  const { directory, driver, session } = await setup(t, { buggy });
  await applyAction({ directory, session, driver, action: { type: 'type', text: 'unsent draft' }, observationId: session.currentObservationId });
  await applyAction({ directory, session, driver, action: { type: 'click', element: 'usage' }, observationId: session.currentObservationId });
  await finishSession({ directory, session, status: 'completed', summary: 'Fixture only.' });
  assert.equal(session.checkResults[0].status, buggy ? 'failed' : 'passed');
  assert.equal(session.checkResults[1].status, 'passed');
  for (const id of session.checkResults[0].evidence) assert(session.events.some(event => event.id === id));
  const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  assert.equal(result.checkResults[0].status, buggy ? 'failed' : 'passed');
  for (const observation of result.events.filter(event => event.kind === 'observation')) await access(join(directory, observation.image));
  assert.match(await readFile(join(directory, 'report.html'), 'utf8'), /synthetic fixture/);
});

test('stale and reused observation IDs cannot dispatch input', async t => {
  const { directory, driver, session } = await setup(t);
  const original = session.currentObservationId;
  await applyAction({ directory, session, driver, action: { type: 'type', text: 'one' }, observationId: original });
  await assert.rejects(applyAction({ directory, session, driver, action: { type: 'type', text: 'two' }, observationId: original }), /latest, unconsumed/);
  assert.equal(driver.state.draft, 'one');
});

test('expired observations require a fresh capture', async t => {
  const { directory, driver, session } = await setup(t);
  session.events[0].at = new Date(Date.now() - 400000).toISOString();
  await assert.rejects(applyAction({ directory, session, driver, action: { type: 'click', element: 'usage' }, observationId: session.currentObservationId }), /expired/);
  assert.equal(driver.state.pane, false);
  await capture({ directory, session, driver });
  await applyAction({ directory, session, driver, action: { type: 'click', element: 'usage' }, observationId: session.currentObservationId });
  assert.equal(driver.state.pane, true);
});

test('input is never retried after an uncertain result', async t => {
  const { directory, driver, session } = await setup(t);
  let calls = 0;
  driver.act = async () => { calls++; driver.state.draft += 'accepted'; throw new Error('ack lost'); };
  await assert.rejects(applyAction({ directory, session, driver, action: { type: 'type', text: 'accepted' }, observationId: session.currentObservationId }), /ack lost/);
  assert.equal(calls, 1);
  assert.equal(session.status, 'blocked');
  assert.equal(session.observationConsumed, true);
  assert.equal(session.events.find(event => event.kind === 'action').outcome, 'uncertain');
  assert.equal(JSON.parse(await readFile(join(directory, 'session.json'), 'utf8')).status, 'blocked');
});

test('STOP and run limits prevent further input', async t => {
  const { directory, driver, session } = await setup(t);
  await writeFile(join(directory, 'STOP'), 'stop');
  await assert.rejects(applyAction({ directory, session, driver, action: { type: 'type', text: 'no' }, observationId: session.currentObservationId }), /stopped/);
  assert.equal(driver.state.draft, '');
  const root = await setup(t, { scenario: { ...source, limits: { maxSteps: 1 } } });
  await runLoop({ directory: root.directory, session: root.session, driver: root.driver, actor: async () => ({ status: 'act', reason: 'wait', action: { type: 'wait', ms: 0 } }) });
  assert.equal(root.session.status, 'limit');
  assert.equal(root.session.steps, 1);
});

test('unexercised and ambiguous preservation checks stay unassessed', async t => {
  const { directory, driver, session } = await setup(t);
  assert.equal(evaluateChecks(session)[0].status, 'unassessed');
  await applyAction({ directory, session, driver, action: { type: 'click', element: 'usage' }, observationId: session.currentObservationId });
  session.events[0].elements.push({ id: 'other-prompt', role: 'text field', label: 'Prompt', value: 'other' });
  assert.equal(evaluateChecks(session)[0].status, 'unassessed');
});

for (const captureAfterError of [true, false]) test('uncertain preservation triggers stay unassessed' + (captureAfterError ? ' with recovery evidence' : ' after an earlier pass and no recovery frame'), async t => {
  const { directory, driver, session } = await setup(t);
  await applyAction({ directory, session, driver, action: { type: 'type', text: 'unsent draft' }, observationId: session.currentObservationId });
  if (!captureAfterError) {
    await applyAction({ directory, session, driver, action: { type: 'click', element: 'usage' }, observationId: session.currentObservationId });
    assert.equal(evaluateChecks(session)[0].status, 'passed');
    driver.observe = async () => { throw new Error('No recovery frame'); };
  }
  driver.act = async () => { throw new Error('Dispatch failed before delivery'); };
  await assert.rejects(applyAction({ directory, session, driver, action: { type: 'click', element: 'usage' }, observationId: session.currentObservationId }), /Dispatch failed/);
  const action = session.events.findLast(event => event.kind === 'action');
  const check = evaluateChecks(session)[0];
  assert.equal(check.status, 'unassessed');
  assert(check.evidence.includes(action.id));
  assert(check.evidence.every(id => session.events.some(event => event.id === id)));
  assert.equal(driver.state.draft, 'unsent draft');
  if (captureAfterError) assert.equal(driver.state.pane, false);
});

test('tester receives visible state and history, without checks, variant or receipts', async t => {
  const { directory, session } = await setup(t);
  const request = testerRequest(directory, session);
  assert.equal(request.goal, source.goal);
  assert(!JSON.stringify(request).includes('draft-preserved'));
  assert.equal(request.variant, undefined);
  assert.equal(request.observation.receipt, undefined);
  assert.equal(request.role, 'tester');
  assert.equal(request.observation.elements[0].label, 'Prompt');
});

test('critic cannot invent evidence or promote concerns to confirmed findings', async t => {
  const { directory, session } = await setup(t);
  await finishSession({ directory, session, status: 'completed', summary: 'self-report' });
  await reviewSession({ directory, session, critic: async () => ({ summary: 'Bad evidence', findings: [{ title: 'Bug', severity: 'high', description: 'unsupported', evidence: ['e9999'] }] }) });
  assert.match(session.criticError, /nonexistent evidence/);
  assert.equal(session.critic, undefined);
  assert.throws(() => validateCritic({ summary: 'x', findings: [{ title: 'x', severity: 'high', description: 'x', evidence: [] }] }, new Set()), /needs evidence/);
});

test('report escapes malicious UI text, goals and critic output', async t => {
  const { directory, session } = await setup(t, { scenario: { ...source, goal: '<script>alert(1)</script>' } });
  session.critic = { summary: '<img src=x onerror=alert(1)>', findings: [] };
  await finishSession({ directory, session, status: 'completed', summary: '</pre><script>evil()</script>' });
  const report = await readFile(join(directory, 'report.html'), 'utf8');
  assert(!report.includes('<script>'));
  assert(report.includes('&lt;script&gt;'));
  assert(report.includes('Content-Security-Policy'));
});

test('run directories cannot be overwritten and concurrent actors are excluded', async t => {
  const { directory, session, driver } = await setup(t);
  await assert.rejects(createSession({ scenario: source, directory, driver }), /EEXIST/);
  await withSession(directory, async () => {
    await assert.rejects(withSession(directory, async () => {}), /busy/);
  });
  assert.equal(session.status, 'running');
});

test('reopening a process killed during input fences the orphaned action before the callback', async t => {
  const { directory, driver } = await setup(t);
  const child = 'const {withSession,driverFor,applyAction}=await import(' + JSON.stringify(new URL('../src/session.mjs', import.meta.url).href) + ');\n' +
    'await withSession(process.argv[1],async s=>{const d=driverFor(s);d.act=async()=>{process.kill(process.pid,"SIGKILL");await new Promise(()=>{});};await applyAction({directory:process.argv[1],session:s,driver:d,action:{type:"type",text:"unknown"},observationId:s.currentObservationId});});';
  await assert.rejects(execute([process.execPath, '--input-type=module', '-e', child.replaceAll('\\n', '\n'), directory]), /SIGKILL/);
  await access(join(directory, '.lock'));
  const crashed = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8'));
  assert.equal(crashed.events.at(-1).outcome, 'pending');
  assert.equal(crashed.metrics.actions.pending, 1);
  await rm(join(directory, '.lock')); // The child has exited; follow the documented lock recovery.
  await withSession(directory, async recovered => {
    assert.equal(recovered.status, 'blocked');
    assert.equal(recovered.events.at(-1).outcome, 'uncertain');
    assert.match(recovered.error, /outcome.*recorded/i);
    const persisted = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8'));
    assert.equal(persisted.status, 'blocked');
    await capture({ directory, session: recovered, driver });
    assert.equal(recovered.observationConsumed, true);
    await assert.rejects(applyAction({ directory, session: recovered, driver, action: { type: 'type', text: 'duplicate' }, observationId: recovered.currentObservationId }), /blocked|unresolved/);
  });
  assert.equal(driver.state.draft, '');
  const fenced = await readFile(join(directory, 'session.json'), 'utf8');
  await withSession(directory, async recovered => assert.equal(recovered.metrics.actions.uncertain, 1));
  assert.equal(await readFile(join(directory, 'session.json'), 'utf8'), fenced);
});

for (const outcome of ['pending', 'uncertain']) test('fresh evidence cannot unlock unresolved ' + outcome + ' input', async t => {
  const { directory, driver, session } = await setup(t);
  addEvent(session, 'action', { action: { type: 'type', text: 'unknown' }, before: session.currentObservationId, outcome });
  await saveSession(directory, session);
  await capture({ directory, session, driver });
  await assert.rejects(applyAction({ directory, session, driver, action: { type: 'type', text: 'duplicate' }, observationId: session.currentObservationId }), /unresolved/);
  assert.equal(driver.state.draft, '');
});

test('invalid action shapes and implicit submission are rejected', () => {
  const observation = { elements: [{ id: 'button' }] };
  for (const action of [
    { type: 'click', element: 'unknown' }, { type: 'type', text: 'hello\nsubmit' },
    { type: 'type', text: 'hello\\nsubmit' }, { type: 'press', key: 'cmd+q && echo bad' },
    { type: 'click', element: 'button', app: 'other' }, { type: 'wait', ms: 10001 },
  ]) assert.throws(() => validateAction(action, observation));
  assert.throws(() => validateScenario({ ...source, target: { app: 'other-app' } }));
  assert.throws(() => validateAction({ type: 'click_point', x: -1, y: 0.5 }, observation));
  assert.throws(() => validateAction({ type: 'click', element: 'not-actionable' }, { elements: [{ id: 'not-actionable', actionable: false }] }), /not actionable/);
});

test('sparse accessibility cannot turn a missing selector into a plugin failure or absence pass', () => {
  const session = {
    scenario: { checks: [{ id: 'present', kind: 'present', selector: { label: 'Prompt' } }, { id: 'absent', kind: 'absent', selector: { label: 'Tip' } }] },
    events: [{ id: 'e0001', kind: 'observation', semanticCoverage: 'sparse', elements: [] }],
  };
  assert(evaluateChecks(session).every(check => check.status === 'unassessed'));
});

test('agent commands receive JSON stdin without shell interpolation', async () => {
  const marker = '$(touch /tmp/should-not-exist-mod-ux); `id`';
  const result = await execute([process.execPath, '-e', 'process.stdin.pipe(process.stdout)'], { input: JSON.stringify({ marker }) });
  assert.equal(JSON.parse(result.stdout).marker, marker);
});

test('timed-out and aborted agents are stopped', async () => {
  await assert.rejects(execute([process.execPath, '-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 30 }), /timed out/);
  const controller = new AbortController();
  const operation = execute([process.execPath, '-e', 'setTimeout(()=>{}, 10000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(operation, /aborted/);
});

test('an already-aborted command never starts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mod-ux-abort-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'must-not-exist');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(execute([process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "bad")', marker], { signal: controller.signal }), /aborted/);
  await assert.rejects(access(marker));
});

test('run duration cancels a pending tester and still writes a report', async t => {
  const { directory, driver, session } = await setup(t, { scenario: { ...source, limits: { maxDurationMs: 150 } } });
  await runLoop({ directory, session, driver, actor: async (_, { signal }) => {
    await execute([process.execPath, '-e', 'setTimeout(()=>{}, 10000)'], { signal });
  } });
  assert.equal(session.status, 'limit');
  await access(join(directory, 'report.html'));
});

test('CLI demo generates evidence without macOS or a model', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mod-ux-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = await execute([process.execPath, resolve('tools/mod-ux/cli.mjs'), 'demo', '--out', join(root, 'demo')]);
  const result = JSON.parse(output.stdout);
  assert.equal(result.checks[0].status, 'failed');
  await access(result.report);
});

test('the final permitted action can complete without allowing another action', async t => {
  const { directory, driver, session } = await setup(t, { scenario: { ...source, limits: { maxSteps: 1 }, checks: [source.checks[1]] } });
  let calls = 0;
  await runLoop({ directory, session, driver, actor: async request => {
    calls++;
    if (calls === 1) return { status: 'act', reason: 'Open usage.', action: { type: 'click', element: 'usage' } };
    assert.equal(request.actionBudget.remaining, 0);
    assert(request.observation.elements.some(element => element.label === 'Your session usage'));
    return { status: 'done', reason: 'Usage is visible.' };
  } });
  assert.equal(calls, 2);
  assert.equal(session.status, 'completed');
  assert.equal(session.steps, 1);
  assert.equal(session.checkResults[0].status, 'passed');
});

test('disappearance needs a confirmed trigger, prior presence and adequate after evidence', () => {
  const check = { id: 'dismissed', kind: 'disappeared', selector: { label: 'Tip' }, after: { label: 'Dismiss' } };
  assert.doesNotThrow(() => validateScenario({ ...source, checks: [check] }));
  assert.throws(() => validateScenario({ ...source, checks: [{ ...check, after: undefined }] }));
  const before = { id: 'before', kind: 'observation', elements: [{ id: 'dismiss', label: 'Dismiss' }, { id: 'tip', label: 'Tip' }] };
  const action = { id: 'click', kind: 'action', action: { type: 'click', element: 'dismiss' }, before: 'before', after: 'after', outcome: 'dispatched' };
  const after = { id: 'after', kind: 'observation', elements: [] };
  const assess = events => evaluateChecks({ scenario: { checks: [check] }, events })[0];
  assert.equal(assess([before, action, after]).status, 'passed');
  assert.deepEqual(assess([before, action, after]).evidence, ['before', 'click', 'after']);
  assert.equal(assess([before, action, { ...after, elements: before.elements }]).status, 'failed');
  assert.equal(assess([before, action, { ...after, semanticCoverage: 'sparse' }]).status, 'unassessed');
  assert.equal(assess([{ ...before, elements: [before.elements[0]] }, action, after]).status, 'unassessed');
  assert.equal(assess([before, { ...action, outcome: 'uncertain' }, after]).status, 'unassessed');
  assert.equal(assess([before, { ...action, after: undefined }, after]).status, 'unassessed');
  assert.equal(assess([after]).status, 'unassessed');
  const absent = evaluateChecks({ scenario: { checks: [{ id: 'absent', kind: 'absent', selector: check.selector }] }, events: [after] });
  assert.equal(absent[0].status, 'passed'); // Final-state absence retains its existing meaning.
});

test('appearance needs a confirmed transition from absent to present', () => {
  const check = { id: 'opened', kind: 'appeared', selector: { label: 'Pane' }, after: { label: 'Open' } };
  validateScenario({ ...source, checks: [check] });
  const before = { id: 'before', kind: 'observation', elements: [{ id: 'open', label: 'Open' }] };
  const action = { id: 'click', kind: 'action', action: { type: 'click', element: 'open' }, before: 'before', after: 'after', outcome: 'dispatched' };
  const after = { id: 'after', kind: 'observation', elements: [{ id: 'pane', label: 'Pane' }] };
  const assess = (initial, click, final) => evaluateChecks({ scenario: { checks: [check] }, events: [initial, click, final] })[0].status;
  assert.equal(assess(before, action, after), 'passed');
  assert.equal(assess({ ...before, elements: [...before.elements, ...after.elements] }, action, after), 'unassessed');
  assert.equal(assess(before, action, { ...after, elements: [] }), 'failed');
  assert.equal(assess({ ...before, semanticCoverage: 'sparse' }, action, after), 'unassessed');
  assert.equal(assess(before, action, { ...after, elements: [], semanticCoverage: 'sparse' }), 'unassessed');
  assert.equal(assess(before, { ...action, outcome: 'uncertain' }, after), 'unassessed');
});

test('a trigger list accepts a click on any of its selectors and nothing else', () => {
  const check = { id: 'opened', kind: 'appeared', selector: { label: 'Pane' }, after: [{ label: 'Open' }, { label: 'Open pane' }] };
  validateScenario({ ...source, checks: [check] });
  assert.throws(() => validateScenario({ ...source, checks: [{ ...check, after: [] }] }), /1-10 selectors/);
  assert.throws(() => validateScenario({ ...source, checks: [{ ...check, after: [{ label: 'Open' }, { id: 'open' }] }] }), /role, label and value/);
  const action = { id: 'click', kind: 'action', action: { type: 'click', element: 'open' }, before: 'before', after: 'after', outcome: 'dispatched' };
  const after = { id: 'after', kind: 'observation', elements: [{ id: 'pane', label: 'Pane' }] };
  const assess = label => evaluateChecks({ scenario: { checks: [check] }, events: [{ id: 'before', kind: 'observation', elements: [{ id: 'open', label }] }, action, after] })[0].status;
  assert.equal(assess('Open'), 'passed');
  assert.equal(assess('Open pane'), 'passed');
  assert.equal(assess('Close'), 'unassessed');
});
