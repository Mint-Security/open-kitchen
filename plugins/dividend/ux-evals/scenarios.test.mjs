import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateChecks } from '../../../tools/mod-ux/src/session.mjs';
import { validateScenario } from '../../../tools/mod-ux/src/protocol.mjs';

const draft = 'UX lab draft — do not send';
const cases = await Promise.all(['discovery', 'pane', 'dismiss'].map(async name => ({ name, scenario: validateScenario(JSON.parse(await readFile(new URL(`./${name}.json`, import.meta.url), 'utf8'))) })));
// Each entry point a scenario accepts, read from its checks; Dividend's own tests hold these labels to the ones it draws.
const entriesOf = scenario => [...new Set(scenario.checks.flatMap(check => (check.after === undefined ? [] : [check.after].flat())).map(trigger => trigger.label))];
const observerFor = opener => (id, value = draft, tip = false, pane = false) => {
  return { id, kind: 'observation', elements: [
    { id: 'prompt', label: 'Prompt', value }, ...(opener ? [{ id: 'open', label: opener }] : []),
    ...(tip ? [{ id: 'dismiss', label: 'Got it' }, { id: 'tip', label: 'This session starts on a different model' }] : []),
    ...(pane ? [{ id: 'session', label: 'This session' }] : []),
  ] };
};
const click = element => ({ id: 'action', kind: 'action', action: { type: 'click', element }, before: 'before', after: 'after', outcome: 'dispatched' });

// The label Dividend draws its way into the pane with; its own tests check that it is the one drawn.
const views = await readFile(new URL('../hooks/display/views.tsx', import.meta.url), 'utf8');
const drawnLabel = name => new RegExp(`export const ${name} = '([^']+)'`).exec(views)?.[1];
test('the scenarios open the pane by the label Dividend draws', () => {
  const open = drawnLabel('OPEN_LABEL');
  assert(open, 'views.tsx no longer exports OPEN_LABEL as a plain string');
  const entries = Object.fromEntries(cases.map(({ name, scenario }) => [name, entriesOf(scenario)]));
  assert.deepEqual(entries.discovery, [open]);
  assert.deepEqual(entries.pane, [open]);
});

for (const { name, scenario } of cases) {
  // Dismissal is triggered by Got it, drawn with the tip; the others by opening the pane.
  for (const opener of name === 'dismiss' ? [null] : entriesOf(scenario)) {
    const label = opener ? `${name} via ${opener}` : name;
    const observe = observerFor(opener);
    const assess = events => evaluateChecks({ scenario, events });
    test(`${label}: tester completion without exercising Dividend cannot pass its checks`, () => {
      const events = name === 'discovery'
        ? [observe('empty', ''), { id: 'type', kind: 'action', action: { type: 'type', text: draft }, before: 'empty', after: 'draft', outcome: 'dispatched' }, observe('draft')]
        : [observe('before')];
      assert(assess(events).some(check => check.status === 'unassessed'));
    });
    test(`${label}: draft loss followed by retyping remains a failed preservation check`, () => {
      const events = [observe('before', draft, name === 'dismiss'), click(name === 'dismiss' ? 'dismiss' : 'open'), observe('after', ''), observe('repaired')];
      assert.equal(assess(events)[0].status, 'failed');
    });
    test(`${label}: confirmed interaction retains the draft`, () => {
      const events = [observe('before', draft, name === 'dismiss'), click(name === 'dismiss' ? 'dismiss' : 'open'), observe('after', draft, false, name !== 'dismiss'), observe('returned')];
      assert(assess(events).every(check => check.status === 'passed'));
      const sparse = events.map(event => event.kind === 'observation' ? { ...event, semanticCoverage: 'sparse', elements: [] } : event);
      assert(assess(sparse).every(check => check.status === 'unassessed'));
    });
    test(`${label}: a dispatched click with no visible effect cannot pass`, () => {
      const events = [observe('before', draft, name === 'dismiss'), click(name === 'dismiss' ? 'dismiss' : 'open'), observe('after', draft, name === 'dismiss')];
      assert(assess(events).some(check => check.status === 'failed'));
    });
    test(`${label}: a draft lost later in the task cannot pass`, () => {
      const events = [observe('before', draft, name === 'dismiss'), click(name === 'dismiss' ? 'dismiss' : 'open'), observe('after', draft, false, name !== 'dismiss'), observe('returned', '')];
      assert.equal(assess(events).find(check => check.id === 'draft-returned').status, 'failed');
    });
  }
}
