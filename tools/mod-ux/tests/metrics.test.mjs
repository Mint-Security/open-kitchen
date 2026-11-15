import test from 'node:test';
import assert from 'node:assert/strict';
import { measureSession } from '../src/metrics.mjs';

test('desktop timings separate model, input, capture and requested waits', () => {
  const result = measureSession({
    target: { kind: 'peekaboo' }, status: 'completed', startedAt: '2026-11-12T19:00:00Z', finishedAt: '2026-11-12T19:01:00Z',
    events: [
      { kind: 'observation', durationMs: 1200 },
      { kind: 'action', action: { type: 'click' }, durationMs: 300, outcome: 'dispatched' },
      { kind: 'action', action: { type: 'wait', ms: 1000 }, durationMs: 1002, outcome: 'dispatched' },
      { kind: 'action', action: { type: 'type' }, durationMs: 500, outcome: 'uncertain' },
    ],
    agentInvocations: [{ role: 'tester', durationMs: 10000 }, { role: 'tester', durationMs: 12000 }, { role: 'critic', durationMs: 5000 }],
    checkResults: [{ status: 'passed' }, { status: 'unassessed' }],
  });
  assert.equal(result.timing.interactionWallMs, 60000);
  assert.equal(result.timing.testerModelMs, 22000);
  assert.equal(result.timing.criticModelMs, 5000);
  assert.equal(result.timing.captureDriverMs, 1200);
  assert.equal(result.timing.inputDriverMs, 800);
  assert.equal(result.timing.requestedWaitMs, 1000);
  assert.equal(result.actions.uncertain, 1);
  assert.equal(result.checks.unassessed, 1);
  assert(result.unmeasured.includes('Human annoyance/satisfaction'));
});

test('older traces do not invent per-role model timing', () => {
  const result = measureSession({ events: [], status: 'running', agentTimeMs: 50000 });
  assert.equal(result.timing.testerModelMs, null);
  assert.equal(result.timing.criticModelMs, null);
  assert.equal(result.timing.interactionWallMs, null);
});

test('pending input is visible before an outcome is known', () => {
  const metrics = measureSession({ status: 'running', events: [{ kind: 'action', action: { type: 'click' }, outcome: 'pending' }] });
  assert.equal(metrics.actions.pending, 1);
  assert.equal(metrics.actions.uncertain, 0);
});
