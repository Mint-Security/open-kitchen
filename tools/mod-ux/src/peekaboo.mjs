import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute, parseJSON } from './process.mjs';
import { assert, DEFAULT_APP } from './protocol.mjs';

// Electron nests Claude Desktop's controls deep in its accessibility tree. With Peekaboo's default
// traversal limits only the window chrome shows; these reach the prompt box and the plugin's controls.
export const AX_LIMITS = ['--depth', '80', '--max-elements', '3000', '--max-children', '500'];

const elementOf = item => ({
  id: String(item.id), role: item.role ?? item.ax_role ?? '',
  label: item.label || item.title || item.description || '',
  ...(item.value === undefined ? {} : { value: item.value }),
  ...(item.is_enabled === undefined ? {} : { enabled: item.is_enabled }),
  ...(item.is_focused === undefined ? {} : { focused: item.is_focused }),
  ...(item.is_actionable === undefined ? {} : { actionable: item.is_actionable }),
  ...(item.is_value_settable === undefined ? {} : { settable: item.is_value_settable }),
});

export class PeekabooDriver {
  /** @param {import('./options.mjs').PeekabooOptions} [options] */
  constructor({ binary = process.env.MOD_UX_PEEKABOO || 'peekaboo', app = DEFAULT_APP, windowId, interactionMode = 'background', bridgeSocket = process.env.PEEKABOO_BRIDGE_SOCKET, executeCommand = execute } = {}) {
    assert(app === DEFAULT_APP, `v1 is scoped to ${DEFAULT_APP}`);
    this.binary = binary;
    this.app = app;
    this.windowId = windowId;
    assert(['background', 'foreground'].includes(interactionMode), 'Invalid interactionMode');
    this.interactionMode = interactionMode;
    this.bridgeSocket = bridgeSocket;
    this.execute = executeCommand;
  }

  /** @param {import('./options.mjs').CommandOptions} [options] */
  async call(args, options = {}) {
    let result;
    try {
      const separator = args.indexOf('--');
      const flags = [...(this.bridgeSocket ? ['--bridge-socket', this.bridgeSocket] : []), '--json'];
      const jsonArgs = separator < 0 ? [...args, ...flags] : [...args.slice(0, separator), ...flags, ...args.slice(separator)];
      result = parseJSON((await this.execute([this.binary, ...jsonArgs], options)).stdout);
    } catch (error) {
      if (error.stdout) {
        try { error.message = `Peekaboo: ${JSON.stringify(JSON.parse(error.stdout).error)}`; } catch {}
      }
      throw error;
    }
    assert(result.success !== false && !result.error, `Peekaboo: ${JSON.stringify(result.error)}`);
    return result.data ?? result;
  }

  /** @param {import('./options.mjs').CommandOptions} [options] */
  async doctor(options = {}) {
    const version = await this.execute([this.binary, '--version'], options);
    const permissions = await this.call(['permissions', 'status'], options);
    return { driver: 'peekaboo', version: version.stdout.trim(), permissions };
  }

  /** @param {import('./options.mjs').CommandOptions} [options] */
  async windows(options = {}) {
    const result = await this.call(['window', 'list', '--app', this.app], options);
    assert(Array.isArray(result.windows), 'Unsupported Peekaboo window-list JSON; expected data.windows');
    return result.windows;
  }

  /** Clicks an item in the app's menu bar, such as "File > New Session in New Window". @param {import('./options.mjs').CommandOptions} [options] */
  async menu(path, options = {}) {
    return this.call(['menu', 'click', '--app', this.app, '--path', path], options);
  }

  /** Brings one of the app's windows to the front, as when giving focus back to it. @param {import('./options.mjs').CommandOptions} [options] */
  async focusWindow(windowId, options = {}) {
    return this.call(['window', 'focus', '--app', this.app, '--window-id', String(windowId)], options);
  }

  /** @param {import('./options.mjs').CommandOptions} [options] */
  async closeWindow(windowId, options = {}) {
    try {
      return await this.call(['window', 'close', '--app', this.app, '--window-id', String(windowId)], options);
    } catch (error) {
      // Peekaboo's close can fail on a Claude pop-out; its own close button still works, in the background.
      const directory = await mkdtemp(join(tmpdir(), 'mod-ux-close-'));
      try {
        const seen = await this.call(['see', '--app', this.app, '--window-id', String(windowId), '--fresh', '--path', join(directory, 'close.png')], options);
        const button = (seen.ui_elements ?? []).find(item => (item.label || item.title || item.description) === 'close button');
        if (!button) throw error;
        return await this.call(['click', '--on', String(button.id), '--snapshot', seen.snapshot_id], options);
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  }

  /** @param {import('./options.mjs').CommandOptions} [options] */
  async connect(options = {}) {
    const windows = await this.windows(options);
    const eligible = windows.filter(item => !item.is_minimized && item.window_id !== undefined);
    const selected = this.windowId === undefined ? eligible : eligible.filter(item => String(item.window_id) === String(this.windowId));
    assert(selected.length === 1, `Select exactly one Claude window with --window. Available IDs: ${eligible.map(item => item.window_id).join(', ') || 'none'}`);
    this.windowId = selected[0].window_id;
    return { kind: 'peekaboo', app: this.app, windowId: this.windowId, windowTitle: selected[0].window_title ?? '', binary: this.binary, interactionMode: this.interactionMode, ...(this.bridgeSocket ? { bridgeSocket: this.bridgeSocket } : {}) };
  }

  /**
   * Reads one of the app's windows by its accessibility elements alone: no screenshot is taken and
   * nothing is kept, so a window can be checked before anything of it is recorded.
   * @param {import('./options.mjs').CommandOptions} [options]
   */
  async inspect(windowId, options = {}) {
    const data = await this.call(['see', '--app', this.app, '--window-id', String(windowId), '--fresh', '--no-screenshot', '--tree', ...AX_LIMITS], options);
    assert(Array.isArray(data.ui_elements), 'Missing accessibility elements');
    return { elements: data.ui_elements.map(elementOf) };
  }

  /** @param {import('./options.mjs').CommandOptions} [options] */
  async observe(screenshotPath, options = {}) {
    assert(this.windowId !== undefined, 'Connect the driver first');
    const windows = await this.windows(options);
    assert(windows.some(item => String(item.window_id) === String(this.windowId)), 'Pinned Claude window disappeared; refusing to retarget');
    const data = await this.call(['see', '--app', this.app, '--window-id', String(this.windowId), '--fresh', ...AX_LIMITS, '--path', screenshotPath], options);
    assert(typeof data.snapshot_id === 'string' && /^ps1_[a-f0-9]{32}$/.test(data.snapshot_id), 'No producer-bound snapshot; update Peekaboo and check permissions');
    assert(data.snapshot_reusable === true && data.mutation_targeting_available === true, 'Observation is not actionable; check Peekaboo host capabilities and AX completeness');
    assert(Array.isArray(data.ui_elements), 'Missing accessibility elements');
    assert((await stat(screenshotPath)).size > 0, 'Peekaboo did not write the requested screenshot');
    const genericLabels = new Set(['', 'group', 'scroll area', data.window_title, 'close button', 'minimize button', 'full screen button']);
    const sparse = data.ui_elements.every(item => genericLabels.has(item.label || item.title || item.description || ''));
    const context = data.coordinate_context;
    const bounds = context?.logical_bounds;
    const pointBounds = context?.origin === 'top_left' && context?.logical_space === 'global_display_points' && context?.window?.window_id === Number(this.windowId) && context?.reference_id === data.snapshot_id &&
      Array.isArray(bounds) && bounds.length === 2 && bounds.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(Number.isFinite)) && bounds[1].every(value => value > 0) ? bounds : null;
    return {
      screenshot: screenshotPath,
      receipt: { snapshot: data.snapshot_id, pointBounds },
      elements: data.ui_elements.map(elementOf),
      focus: data.focused_element ?? null,
      semanticCoverage: sparse ? 'sparse' : 'available',
      warnings: [...(Array.isArray(data.warnings) ? data.warnings : []), ...(sparse ? ['Sparse accessibility evidence: use the screenshot; missing selectors cannot establish absence.'] : [])],
    };
  }

  /**
   * Sets an element's accessibility value directly: no keystrokes, so no keyboard focus is needed.
   * Peekaboo can't always confirm the write; an unconfirmed one is reported, and the caller checks
   * the value in a fresh observation.
   * @param {import('./options.mjs').CommandOptions} [options]
   */
  async setValue(element, value, observation, options = {}) {
    try {
      return await this.call(['set-value', '--value', value, '--on', element, '--snapshot', observation.receipt.snapshot], options);
    } catch (error) {
      if (/could not be verified/.test(error.message)) return { unverified: true };
      throw error;
    }
  }

  /** @param {import('./options.mjs').CommandOptions} [options] */
  async act(action, observation, options = {}) {
    const snapshot = observation.receipt.snapshot;
    // A concrete snapshot owns the destination. Never fall back to a frontmost/global target.
    let args;
    const foreground = this.interactionMode === 'foreground';
    const targeting = foreground ? ['--window-id', String(this.windowId), '--foreground', '--input-strategy', 'synthOnly'] : [];
    switch (action.type) {
      case 'click': args = ['click', '--on', action.element, '--snapshot', snapshot, ...targeting]; break;
      case 'click_point': {
        const bounds = observation.receipt.pointBounds;
        assert(bounds, 'Snapshot has no exact-window coordinate mapping');
        assert(Number.isFinite(action.x) && Number.isFinite(action.y) && action.x >= 0 && action.x <= 1 && action.y >= 0 && action.y <= 1, 'Invalid normalized point');
        const x = Math.min(bounds[1][0] - 1, action.x * bounds[1][0]);
        const y = Math.min(bounds[1][1] - 1, action.y * bounds[1][1]);
        // Window-relative either way. In the background Peekaboo delivers it to that window without
        // moving the pointer; the exact-window snapshot is what authorizes it.
        args = ['click', '--at', `${x},${y}`, '--snapshot', snapshot, ...(foreground ? targeting : ['--window-id', String(this.windowId)])];
        break;
      }
      case 'type': {
        // replace (setup only; a tester's type action has no such field): select and delete first.
        if (foreground) { args = ['type', '--snapshot', snapshot, ...targeting, ...(action.replace ? ['--clear'] : []), '--accept-dispatched', '--', action.text]; break; }
        try {
          return await this.call(['type', '--snapshot', snapshot, '--accept-dispatched', '--', action.text], options);
        } catch (error) {
          // Background keystrokes follow the app's keyboard focus, which may be in another of its windows
          // (yours). Nothing was sent; append to this window's one text field by value instead.
          if (!/focused element belongs to a different window/.test(error.message)) throw error;
          const fields = observation.elements.filter(item => /^text(Field|Area)$/i.test(item.role) && item.settable !== false);
          assert(fields.length === 1, `The window doesn't hold keyboard focus and has ${fields.length} text fields to type into instead`);
          const current = typeof fields[0].value === 'string' && fields[0].value.trim() ? fields[0].value : '';
          return this.setValue(fields[0].id, current + action.text, observation, options);
        }
      }
      case 'press': args = ['press', action.key, '--snapshot', snapshot, ...targeting]; break;
      case 'scroll': args = ['scroll', '--on', action.element, '--direction', action.direction, '--amount', String(action.amount), '--snapshot', snapshot, ...targeting]; break;
      default: throw new Error(`Unsupported driver action: ${action.type}`);
    }
    return this.call(args, options);
  }
}
