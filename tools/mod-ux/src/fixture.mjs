import { writeFile } from 'node:fs/promises';

const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

// A deliberately tiny fake desktop. It never observes or controls a real app.
export class FixtureDriver {
  /** @param {import('./options.mjs').FixtureOptions} [options] */
  constructor({ buggy = false, state } = {}) { this.state = state ?? { draft: '', pane: false, focused: true, buggy }; }
  async connect() { return { kind: 'fixture', app: 'synthetic-desktop', buggy: this.state.buggy }; }
  async observe(screenshotPath) {
    const elements = [
      { id: 'prompt', role: 'text field', label: 'Prompt', value: this.state.draft, focused: this.state.focused },
      { id: 'usage', role: 'button', label: 'Usage' },
    ];
    if (this.state.pane) elements.push({ id: 'close', role: 'button', label: 'Close Usage' }, { id: 'tip', role: 'text', label: 'Your session usage' });
    await writeFile(screenshotPath, `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="650"><rect width="100%" height="100%" fill="#202124"/><g fill="#eee" font-family="monospace" font-size="22"><text x="32" y="50">SYNTHETIC FIXTURE · ${this.state.buggy ? 'injected draft-loss bug' : 'control'}</text><text x="32" y="120">Claude Desktop-like test surface</text><text x="32" y="220">${this.state.pane ? 'Usage pane: Your session usage' : 'Conversation'}</text><text x="32" y="460">Prompt</text><text x="32" y="510">${escape(this.state.draft || '(empty)')}</text></g></svg>`);
    return { screenshot: screenshotPath, receipt: { fixture: true }, elements, focus: this.state.focused ? { role: 'text field', title: 'Prompt' } : null, warnings: ['Synthetic fixture; not a Claude Desktop screenshot'] };
  }
  async act(action) {
    if (action.type === 'type' && this.state.focused) this.state.draft += action.text;
    if (action.type === 'click' && action.element === 'prompt') this.state.focused = true;
    if (action.type === 'click' && action.element === 'usage') {
      this.state.pane = true;
      if (this.state.buggy) this.state.draft = '';
    }
    if (action.type === 'click' && action.element === 'close') this.state.pane = false;
    return { dispatched: true, fixture: true };
  }
}
