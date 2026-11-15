import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateChecks } from '../../../tools/mod-ux/src/session.mjs';
import { validateScenario } from '../../../tools/mod-ux/src/protocol.mjs';

const draft = 'UX lab draft — do not send';
const cases = await Promise.all(['discovery', 'pane', 'dismiss'].map(async name => ({ name, scenario: validateScenario(JSON.parse(await readFile(new URL(`./${name}.json`, import.meta.url), 'utf8'))) })));
function observe(id, value = draft, tip = false, pane = false) {
  return { id, kind: 'observation', elements: [
    { id: 'prompt', label: 'Prompt', value }, { id: 'open', label: 'All tips' },
    ...(tip ? [{ id: 'dismiss', label: 'Got it' }, { id: 'tip', label: 'This session starts on a different model' }] : []),
    ...(pane ? [{ id: 'session', label: 'This session' }] : []),
  ] };
}
const click = element => ({ id: 'action', kind: 'action', action: { type: 'click', element }, before: 'before', after: 'after', outcome: 'dispatched' });

for (const { name, scenario } of cases) {
  const assess = events => evaluateChecks({ scenario, events });
  test(`${name}: tester completion without exercising Dividend cannot pass its checks`, () => {
    const events = name === 'discovery'
      ? [observe('empty', ''), { id: 'type', kind: 'action', action: { type: 'type', text: draft }, before: 'empty', after: 'draft', outcome: 'dispatched' }, observe('draft')]
      : [observe('before')];
    assert(assess(events).some(check => check.status === 'unassessed'));
  });
  test(`${name}: draft loss followed by retyping remains a failed preservation check`, () => {
    const events = [observe('before', draft, name === 'dismiss'), click(name === 'dismiss' ? 'dismiss' : 'open'), observe('after', ''), observe('repaired')];
    assert.equal(assess(events)[0].status, 'failed');
  });
  test(`${name}: confirmed interaction retains the draft`, () => {
    const events = [observe('before', draft, name === 'dismiss'), click(name === 'dismiss' ? 'dismiss' : 'open'), observe('after', draft, false, name !== 'dismiss'), observe('returned')];
    assert(assess(events).every(check => check.status === 'passed'));
    const sparse = events.map(event => event.kind === 'observation' ? { ...event, semanticCoverage: 'sparse', elements: [] } : event);
    assert(assess(sparse).every(check => check.status === 'unassessed'));
  });
  test(`${name}: a dispatched click with no visible effect cannot pass`, () => {
    const events = [observe('before', draft, name === 'dismiss'), click(name === 'dismiss' ? 'dismiss' : 'open'), observe('after', draft, name === 'dismiss')];
    assert(assess(events).some(check => check.status === 'failed'));
  });
  test(`${name}: a draft lost later in the task cannot pass`, () => {
    const events = [observe('before', draft, name === 'dismiss'), click(name === 'dismiss' ? 'dismiss' : 'open'), observe('after', draft, false, name !== 'dismiss'), observe('returned', '')];
    assert.equal(assess(events).find(check => check.id === 'draft-returned').status, 'failed');
  });
}
