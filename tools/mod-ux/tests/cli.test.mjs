import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureDriver } from '../src/fixture.mjs';
import { createSession, applyAction, capture, finishSession, runLoop } from '../src/session.mjs';
import { execute } from '../src/process.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const scenario = JSON.parse(await readFile(new URL('./fixtures/draft-preservation.json', import.meta.url), 'utf8'));
const command = args => execute([process.execPath, cli, ...args]);
async function setup(t, buggy = false) {
  const root = await mkdtemp(join(tmpdir(), 'mod-ux-cli-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  const driver = new FixtureDriver({ buggy });
  const session = await createSession({ scenario, directory, driver });
  return { directory, driver, session };
}
async function openPane(directory, driver, session) {
  await applyAction({ directory, session, driver, action: { type: 'type', text: 'unsent draft' }, observationId: session.currentObservationId });
  await applyAction({ directory, session, driver, action: { type: 'click', element: 'usage' }, observationId: session.currentObservationId });
}

test('manual finish returns a passing control with input counts', async t => {
  const { directory, driver, session } = await setup(t);
  await openPane(directory, driver, session);
  const output = await command(['finish', '--run', directory, '--status', 'completed', '--summary', 'Inspected the pane.']);
  const result = JSON.parse(output.stdout);
  assert.equal(result.status, 'completed');
  assert(result.checks.every(check => check.status === 'passed'));
  assert.equal(result.actions.uncertain, 0);
  assert.equal(result.actions.pending, 0);
});

test('manual finish retains a harness failure and exits nonzero', async t => {
  const { directory, driver, session } = await setup(t);
  driver.act = async () => { throw new Error('Unknown input delivery'); };
  await assert.rejects(applyAction({ directory, session, driver, action: { type: 'click', element: 'usage' }, observationId: session.currentObservationId }), /Unknown input delivery/);
  let result;
  await assert.rejects(command(['finish', '--run', directory, '--status', 'completed', '--summary', 'Tester claims completion.']), error => {
    assert.match(error.message, /exited 1/);
    result = JSON.parse(error.stdout);
    return true;
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.error, 'Unknown input delivery');
  assert.equal(result.actions.uncertain, 1);
  assert.equal(result.finishRequest.status, 'completed');
  assert.equal(result.finishRequest.summary, 'Tester claims completion.');
  assert.equal(result.checks[0].status, 'unassessed');
  const persisted = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8'));
  assert.equal(persisted.status, 'blocked');
  assert(persisted.finishedAt);
});

for (const action of ['finish', 'observe', 'stop']) test('finalized interaction artifacts survive CLI ' + action, async t => {
  const { directory, session } = await setup(t);
  await finishSession({ directory, session, status: 'completed', summary: 'Original result.' });
  const files = ['session.json', 'result.json', 'report.html'];
  const before = await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')));
  const args = [action, '--run', directory, ...(action === 'finish' ? ['--status', 'completed', '--summary', 'Replacement result.'] : [])];
  if (action === 'stop') {
    await command(args);
    await command(args); // Stopping an idle, finalized run is idempotent.
  } else {
    await assert.rejects(command(args), error => {
      assert.match(error.message, /exited 1/);
      assert.match(JSON.parse(error.message.slice(error.message.indexOf(': ') + 2)).error, /finalized/i);
      return true;
    });
  }
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(directory, file), 'utf8'))), before);
});

test('direct capture rejects finalized interactions without appending evidence', async t => {
  const { directory, driver, session } = await setup(t);
  await finishSession({ directory, session, status: 'completed', summary: 'Original result.' });
  const before = await readFile(join(directory, 'session.json'), 'utf8');
  await assert.rejects(capture({ directory, session, driver }), /finalized/i);
  assert.equal(await readFile(join(directory, 'session.json'), 'utf8'), before);
});

test('manual finish exits nonzero for a failed configured check', async t => {
  const { directory, driver, session } = await setup(t, true);
  await openPane(directory, driver, session);
  await assert.rejects(command(['finish', '--run', directory, '--status', 'completed', '--summary', 'The pane opened.']), error => {
    assert.match(error.message, /exited 1/);
    const result = JSON.parse(error.stdout);
    assert.equal(result.status, 'completed');
    assert.equal(result.checks[0].status, 'failed');
    return true;
  });
});

test('automated input failures finalize as blocked with recovery evidence', async t => {
  const { directory, driver, session } = await setup(t);
  driver.act = async () => { throw new Error('Unknown input delivery'); };
  await runLoop({ directory, session, driver, actor: async () => ({ status: 'act', reason: 'Open the pane.', action: { type: 'click', element: 'usage' } }) });
  assert.equal(session.status, 'blocked');
  assert.equal(session.error, 'Unknown input delivery');
  assert(session.finishedAt);
  assert.equal(session.checkResults[0].status, 'unassessed');
  const action = session.events.find(event => event.kind === 'action');
  assert(action.after); // Blocking input does not suppress its one recovery capture.
});

for (const checks of [[scenario.checks[0]], []]) test(`strict finish rejects ${checks.length ? 'unassessed' : 'missing'} checks with exit 2`, async t => {
  const { directory, session } = await setup(t);
  session.scenario.checks = checks;
  await writeFile(join(directory, 'session.json'), JSON.stringify(session));
  await assert.rejects(command(['finish', '--run', directory, '--summary', 'No interaction.', '--require-assessed']), error => {
    assert.match(error.message, /exited 2/);
    assert.equal(JSON.parse(error.stdout).status, 'completed');
    return true;
  });
});

test('strict finish accepts assessed checks and preserves failure exit precedence', async t => {
  for (const buggy of [false, true]) {
    const { directory, driver, session } = await setup(t, buggy);
    await openPane(directory, driver, session);
    const operation = command(['finish', '--run', directory, '--summary', 'Inspected.', '--require-assessed']);
    if (buggy) await assert.rejects(operation, /exited 1/);
    else assert(JSON.parse((await operation).stdout).checks.every(check => check.status === 'passed'));
  }
});

test('exploratory finish keeps unassessed checks explicit without a strict gate', async t => {
  const { directory, session } = await setup(t);
  session.scenario.checks = [scenario.checks[0]];
  await writeFile(join(directory, 'session.json'), JSON.stringify(session));
  const result = JSON.parse((await command(['finish', '--run', directory, '--summary', 'Exploratory only.'])).stdout);
  assert(result.checks.some(check => check.status === 'unassessed'));
});

for (const role of ['actor', 'critic']) test(`invalid ${role} is rejected before any desktop capture or run directory`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mod-ux-invalid-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  const args = ['run', fileURLToPath(new URL('./fixtures/draft-preservation.json', import.meta.url)), '--out', directory,
    '--actor', role === 'actor' ? 'codex' : 'claude', ...(role === 'critic' ? ['--critic', 'codex'] : [])];
  await assert.rejects(execute([process.execPath, cli, ...args], { env: { ...process.env, MOD_UX_PEEKABOO: join(root, 'must-not-execute') } }), error => {
    assert.match(error.message, new RegExp(`${role}.*JSON argv array`, 'i'));
    return true;
  });
  await assert.rejects(access(directory));
});

test('an invalid critic cannot finalize an existing manual interaction', async t => {
  const { directory } = await setup(t);
  const before = await readFile(join(directory, 'session.json'), 'utf8');
  await assert.rejects(command(['finish', '--run', directory, '--summary', 'Done.', '--critic', 'codex']), /critic.*JSON argv array/i);
  assert.equal(await readFile(join(directory, 'session.json'), 'utf8'), before);
});

test('automated runs apply the assessed-check gate without calling a real desktop or model', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mod-ux-run-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'fake-peekaboo');
  await writeFile(binary, `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
if(args[0]==='window')console.log(JSON.stringify({data:{windows:[{window_id:1}]}}));
else if(args[0]==='see'){
fs.writeFileSync(args[args.indexOf('--path')+1],'SYNTHETIC CAPTURE');
console.log(JSON.stringify({data:{snapshot_id:'ps1_0123456789abcdef0123456789abcdef',snapshot_reusable:true,mutation_targeting_available:true,ui_elements:[{id:'group',label:'group'}]}}));
}else process.exitCode=1;
`, { mode: 0o700 });
  const actor = JSON.stringify([process.execPath, '-e', 'console.log(JSON.stringify({status:"done",reason:"Synthetic completion."}))']);
  for (const strict of [false, true]) {
    const args = ['run', fileURLToPath(new URL('./fixtures/draft-preservation.json', import.meta.url)), '--out', join(root, String(strict)), '--actor', actor, ...(strict ? ['--require-assessed'] : [])];
    const operation = execute([process.execPath, cli, ...args], { env: { ...process.env, MOD_UX_PEEKABOO: binary } });
    let result;
    if (strict) await assert.rejects(operation, error => { assert.equal(error.exitCode, 2); result = JSON.parse(error.stdout); return true; });
    else result = JSON.parse((await operation).stdout);
    assert.equal(result.status, 'completed');
    assert(result.checks.every(check => check.status === 'unassessed'));
  }
});
