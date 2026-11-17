import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeekabooDriver } from '../src/peekaboo.mjs';

const snapshot = `ps1_${'a'.repeat(32)}`;
function fake({ windows = [{ window_id: 123, window_title: 'Claude' }], data = {}, calls = [] } = {}) {
  return async argv => {
    calls.push(argv);
    if (argv.includes('list')) return { stdout: JSON.stringify({ success: true, data: { windows } }) };
    if (argv.includes('see')) {
      if (argv.includes('--path')) await writeFile(argv[argv.indexOf('--path') + 1], 'image fixture');
      return { stdout: JSON.stringify({ success: true, data: {
        snapshot_id: snapshot, snapshot_reusable: true, mutation_targeting_available: true,
        ui_elements: [{ id: 'opaque-id', role: 'button', label: 'Usage', identifier: 'hidden-source-key' }], ...data,
      } }) };
    }
    return { stdout: JSON.stringify({ success: true, data: { dispatched: true } }) };
  };
}

test('multiple windows require an explicit choice', async () => {
  const executeCommand = fake({ windows: [{ window_id: 1 }, { window_id: 2 }] });
  await assert.rejects(new PeekabooDriver({ executeCommand }).connect(), /Select exactly one/);
  assert.equal((await new PeekabooDriver({ executeCommand, windowId: '2' }).connect()).windowId, 2);
});

test('observations pin the exact app/window, require fresh actionable evidence and omit source identifiers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mod-ux-driver-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const driver = new PeekabooDriver({ executeCommand: fake({ calls }) });
  await driver.connect();
  const observation = await driver.observe(join(directory, 'frame.png'));
  assert(calls.at(-1).includes('--fresh'));
  assert(calls.at(-1).includes('--window-id'));
  assert(calls.at(-1).includes('com.anthropic.claudefordesktop'));
  assert.equal(observation.elements[0].identifier, undefined);
  assert.equal(observation.receipt.snapshot, snapshot);
});

test('partial/unowned snapshots are rejected before any action', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mod-ux-driver-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const data of [{ snapshot_id: 'old-id' }, { mutation_targeting_available: false }, { snapshot_reusable: false }]) {
    const driver = new PeekabooDriver({ executeCommand: fake({ data }) });
    await driver.connect();
    await assert.rejects(driver.observe(join(directory, 'frame.png')));
  }
});

test('input uses the observed receipt with no foreground fallback; option-like text stays literal', async () => {
  const calls = [];
  const driver = new PeekabooDriver({ executeCommand: fake({ calls }) });
  const observation = { receipt: { snapshot } };
  await driver.act({ type: 'click', element: 'opaque-id' }, observation);
  assert.deepEqual(calls.at(-1).slice(1), ['click', '--on', 'opaque-id', '--snapshot', snapshot, '--json']);
  await driver.act({ type: 'type', text: '--foreground' }, observation);
  assert.deepEqual(calls.at(-1).slice(1), ['type', '--snapshot', snapshot, '--accept-dispatched', '--json', '--', '--foreground']);
  await driver.act({ type: 'press', key: 'return' }, observation);
  assert(!calls.at(-1).includes('--foreground'));
});

test('a disappeared window is never replaced with another one', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mod-ux-driver-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const windows = [{ window_id: 1 }];
  const driver = new PeekabooDriver({ executeCommand: fake({ windows }) });
  await driver.connect();
  windows.splice(0, 1, { window_id: 2 });
  await assert.rejects(driver.observe(join(directory, 'frame.png')), /disappeared/);
});

test('screenshot point actions need an exact captured mapping, and stay in the background unless asked', async () => {
  const calls = [];
  const observation = { receipt: { snapshot, pointBounds: [[271, 149], [900, 700]] } };
  const background = new PeekabooDriver({ windowId: 123, executeCommand: fake({ calls }) });
  await assert.rejects(background.act({ type: 'click_point', x: 0.5, y: 0.9 }, { receipt: { snapshot } }), /coordinate mapping/);
  await assert.rejects(background.act({ type: 'click_point', x: 2, y: 0.9 }, observation), /Invalid normalized/);
  assert.equal(calls.length, 0);
  await background.act({ type: 'click_point', x: 0.5, y: 0.9 }, observation);
  // Window-relative, to that window, without focusing it or moving the pointer.
  assert.deepEqual(calls.at(-1).slice(1), ['click', '--at', '450,630', '--snapshot', snapshot, '--window-id', '123', '--json']);
  const foreground = new PeekabooDriver({ windowId: 123, interactionMode: 'foreground', executeCommand: fake({ calls }) });
  await foreground.act({ type: 'click_point', x: 0.5, y: 0.9 }, observation);
  assert(calls.at(-1).includes('450,630'));
  assert(calls.at(-1).includes('--foreground'));
  assert.equal(calls.at(-1)[calls.at(-1).indexOf('--window-id') + 1], '123');
  assert(!calls.at(-1).includes('--global'));
});

test('observations reach deep into Electron\'s accessibility tree', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mod-ux-driver-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const driver = new PeekabooDriver({ executeCommand: fake({ calls }) });
  await driver.connect();
  await driver.observe(join(directory, 'frame.png'));
  const see = calls.at(-1);
  for (const [flag, value] of [['--depth', '80'], ['--max-elements', '3000'], ['--max-children', '500']]) assert.equal(see[see.indexOf(flag) + 1], value);
});

test('a window is checked by its accessibility labels alone, with no screenshot taken', async () => {
  const calls = [];
  const { elements } = await new PeekabooDriver({ executeCommand: fake({ calls }) }).inspect(42);
  const see = calls.at(-1);
  assert.deepEqual(see.slice(0, 6), ['peekaboo', 'see', '--app', 'com.anthropic.claudefordesktop', '--window-id', '42']);
  for (const flag of ['--fresh', '--no-screenshot', '--tree']) assert(see.includes(flag), flag);
  assert(!see.includes('--path'));
  assert.equal(see[see.indexOf('--depth') + 1], '80');
  assert.deepEqual(elements, [{ id: 'opaque-id', role: 'button', label: 'Usage' }]);
});

test('a window Peekaboo cannot close is closed with its own close button, in the background', async () => {
  const calls = [];
  const executeCommand = async argv => {
    calls.push(argv);
    if (argv.includes('close')) throw Object.assign(new Error('close failed'), { stdout: JSON.stringify({ success: false, error: { message: 'Window close operation failed' } }) });
    if (argv.includes('see')) return { stdout: JSON.stringify({ success: true, data: { snapshot_id: snapshot, ui_elements: [{ id: 'elem_9', label: 'close button' }] } }) };
    return { stdout: JSON.stringify({ success: true, data: {} }) };
  };
  await new PeekabooDriver({ executeCommand }).closeWindow(42);
  const click = calls.at(-1);
  assert.deepEqual(click.slice(1, 6), ['click', '--on', 'elem_9', '--snapshot', snapshot]);
  assert(!click.includes('--foreground'));
  assert.equal(calls.find(argv => argv.includes('see'))[calls.find(argv => argv.includes('see')).indexOf('--window-id') + 1], '42');
});

test('a mapping for another window cannot authorize a point click', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mod-ux-driver-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const driver = new PeekabooDriver({ interactionMode: 'foreground', executeCommand: fake({ data: { coordinate_context: {
    window: { window_id: 999 }, reference_id: snapshot, origin: 'top_left', logical_space: 'global_display_points', logical_bounds: [[0, 0], [900, 700]],
  } } }) });
  await driver.connect();
  const observation = await driver.observe(join(directory, 'frame.png'));
  assert.equal(observation.receipt.pointBounds, null);
  await assert.rejects(driver.act({ type: 'click_point', x: 0.5, y: 0.5 }, observation), /coordinate mapping/);
});

test('generic Electron groups do not count as meaningful semantic coverage even when marked actionable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mod-ux-driver-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const driver = new PeekabooDriver({ executeCommand: fake({ data: {
    window_title: 'Claude', ui_elements: [
      { id: 'group', label: 'group', is_actionable: true, is_value_settable: true },
      { id: 'web', label: 'Claude', is_actionable: true },
      { id: 'close', label: 'close button', is_actionable: true },
    ],
  } }) });
  await driver.connect();
  const observed = await driver.observe(join(directory, 'frame.png'));
  assert.equal(observed.semanticCoverage, 'sparse');
  assert(observed.warnings.some(value => value.includes('missing selectors')));
});

test('a selected host is retained and routing flags cannot become typed content', async () => {
  const calls = [];
  const driver = new PeekabooDriver({ bridgeSocket: '/tmp/known-host.sock', executeCommand: fake({ calls }) });
  const target = await driver.connect();
  assert.equal(target.bridgeSocket, '/tmp/known-host.sock');
  await driver.act({ type: 'type', text: '--foreground' }, { receipt: { snapshot } });
  const argv = calls.at(-1);
  assert(argv.indexOf('--bridge-socket') < argv.indexOf('--'));
  assert.equal(argv[argv.indexOf('--bridge-socket') + 1], '/tmp/known-host.sock');
  assert.deepEqual(argv.slice(argv.indexOf('--') + 1), ['--foreground']);
});

test('typing into a window without keyboard focus appends to its one text field by value', async () => {
  const calls = [];
  const refusal = { success: false, error: { code: 'INVALID_INPUT', message: 'Invalid target: The focused element belongs to a different window.' } };
  const executeCommand = async argv => {
    calls.push(argv);
    if (argv.includes('type')) throw Object.assign(new Error('refused'), { stdout: JSON.stringify(refusal) });
    if (argv.includes('set-value')) throw Object.assign(new Error('unverified'), { stdout: JSON.stringify({ success: false, error: { message: 'The accessibility value write was accepted, but its requested result could not be verified.' } }) });
    return { stdout: JSON.stringify({ success: true, data: {} }) };
  };
  const driver = new PeekabooDriver({ windowId: 7, executeCommand });
  const observation = { receipt: { snapshot }, elements: [{ id: 'prompt', role: 'textField', label: 'Prompt', value: 'Draft so far ' }, { id: 'send', role: 'button', label: 'Send' }] };
  assert.deepEqual(await driver.act({ type: 'type', text: '--and more' }, observation), { unverified: true });
  assert.deepEqual(calls.at(-1).slice(1, 7), ['set-value', '--value', 'Draft so far --and more', '--on', 'prompt', '--snapshot']);
  // An empty field reads as a lone newline; it isn't kept.
  await driver.act({ type: 'type', text: 'Hello' }, { ...observation, elements: [{ id: 'prompt', role: 'textField', label: 'Prompt', value: '\n' }] });
  assert.equal(calls.at(-1)[calls.at(-1).indexOf('--value') + 1], 'Hello');
  // With nowhere unambiguous to put the text, nothing is written.
  const two = { ...observation, elements: [{ id: 'a', role: 'textField', label: 'A' }, { id: 'b', role: 'textArea', label: 'B' }] };
  await assert.rejects(driver.act({ type: 'type', text: 'x' }, two), /2 text fields/);
});

test('a foreground type can replace what the field holds; only setup asks for that', async () => {
  const calls = [];
  const driver = new PeekabooDriver({ windowId: 7, interactionMode: 'foreground', executeCommand: fake({ calls }) });
  await driver.act({ type: 'type', text: 'Say OK.', replace: true }, { receipt: { snapshot } });
  assert.deepEqual(calls.at(-1).slice(1), ['type', '--snapshot', snapshot, '--window-id', '7', '--foreground', '--input-strategy', 'synthOnly', '--clear', '--accept-dispatched', '--json', '--', 'Say OK.']);
  await driver.act({ type: 'type', text: 'more' }, { receipt: { snapshot } });
  assert(!calls.at(-1).includes('--clear'));
});

test('a refused write is an error; only an unconfirmed one is passed on for checking', async () => {
  const executeCommand = async () => { throw Object.assign(new Error('no'), { stdout: JSON.stringify({ success: false, error: { message: 'Element is not settable' } }) }); };
  const driver = new PeekabooDriver({ windowId: 7, executeCommand });
  await assert.rejects(driver.setValue('prompt', 'x', { receipt: { snapshot } }), /not settable/);
});
