import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReport } from '../src/report.mjs';

for (const status of ['running', 'error', 'blocked', 'limit', 'stopped', 'completed']) test(`report headline reflects ${status} before passing checks`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mod-ux-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = { status, scenario: { name: 'Fixture', goal: 'Fixture only.' }, events: [], checkResults: [{ id: 'check', status: 'passed', evidence: [] }] };
  await writeReport(root, session);
  const report = await readFile(join(root, 'report.html'), 'utf8');
  const outcome = report.match(/Outcome<strong[^>]*>(.*?)<\/strong>/)[1];
  if (status === 'completed') assert.equal(outcome, 'Configured checks passed');
  else if (status === 'running') assert.equal(outcome, 'Run in progress');
  else assert.equal(outcome, `Run did not complete (${status})`);
  session.status = 'completed'; session.error = 'A persisted harness failure';
  await writeReport(root, session);
  assert.match(await readFile(join(root, 'report.html'), 'utf8'), /Outcome<strong[^>]*>Run has a harness error/);
  delete session.error; session.criticError = 'Critic failed';
  await writeReport(root, session);
  assert.match(await readFile(join(root, 'report.html'), 'utf8'), /Outcome<strong[^>]*>UX review unavailable/);
});
