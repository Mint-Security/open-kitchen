import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { keyOf } from '../hooks/display/format'
import { KEEP_ALIVE_PROMPT } from '../hooks/tips/cache'

const SITE = { bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 12, ...SITE }
const PANE = { title: 'Dividend', isFocused: true, placement: 'dock' as const, ...SITE }
const NOW = Date.parse('2026-10-07T10:00:00Z')
const SUMMARY = { role: 'user' as const, text: 'Summary of the conversation so far', toolUses: [] }

type Reading = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}

// The session as Claude Code reports it: what /context, the status line and /cost would show.
const makeWorld = (on: On, clock: MockClock, stored: Record<string, unknown> = {}, env: Record<string, string> = {}) => {
  const w = {
    sessionId: 'session-one',
    reading: { context: { tokens: 30_000, window: 200_000, percent: 15 }, rateLimits: [], cost: { usd: 0.4 } } as Reading,
    mcpTools: [] as { name: string; serverName: string; tokens: number; isLoaded: boolean }[],
    memoryFiles: [] as { path: string; type: string; tokens: number }[],
    compactResult: { messages: [SUMMARY] } as { messages: (typeof SUMMARY)[] } | { skip: string },
    stepUsages: [] as Usage[],
    settings: {} as Record<string, unknown>,
    compactions: 0,
    compactError: null as string | null,
    compactInstructions: [] as (string | undefined)[],
    toolTexts: [] as string[],
    stats: {} as Record<string, { kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean; realPath?: string }>,
    isMac: false,
    openedIn: [] as (string | null)[],
    files: {} as Record<string, string>,
    fsReads: [] as string[],
    store: JSON.parse(JSON.stringify(stored)) as Record<string, unknown>,
    // While on, each write of dividend's tips waits to be let through: saves that overlap both read the store first.
    isHoldingWrites: false,
    heldWrites: [] as (() => void)[],
    usageCalls: 0,
    breakdowns: 0,
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    opened: [] as string[],
    otherBand: null as string | null,
    openedFiles: [] as string[][],
    openExit: 0,
    draft: '',
    fills: [] as { text: string; mode?: string }[],
    isFillable: true,
    submissions: [] as string[],
    promptError: false,
    promptDrop: false,
    promptReadDelayMs: 0
  }
  on('store.get', (_$, e) => ({ value: w.store[e.key] }) as never)
  on('store.set', async (_$, e) => {
    if (e.key === 'dividend' && w.isHoldingWrites) {
      await new Promise<void>(resolve => w.heldWrites.push(resolve))
    }
    w.store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    delete w.store[e.key]
    return { value: undefined }
  })
  mock.env(on, env)
  on('settings.read', () => ({ value: w.settings }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: w.sessionId }) as never)
  on('session.usage', (_$, e) => {
    w.usageCalls++
    const isBreakdown = (e as { breakdown?: string }).breakdown !== undefined
    if (isBreakdown) w.breakdowns++
    const breakdown = isBreakdown ? { mcpTools: w.mcpTools, memoryFiles: w.memoryFiles } : undefined
    return { value: { startedAt: clock.now(), ...w.reading, context: { ...w.reading.context, breakdown } } } as never
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.compact', (_$, e) => {
    if (w.compactError) {
      throw new Error(w.compactError)
    }
    w.compactions++
    w.compactInstructions.push((e as { instructions?: string }).instructions)
    return w.compactResult as never
  })
  on('prompt.submit', (_$, e) => {
    if (e.origin.kind === 'plugin') {
      if (w.promptError) throw new Error('unavailable')
      w.submissions.push(e.text)
      if (w.promptDrop) return { drop: 'blocked' }
    }
    return { text: e.text, origin: e.origin } as never
  })
  on('fs.stat', (_$, e) => ({ value: w.stats[e.path] ?? { kind: 'file', size: 10, mtimeMs: 0, isLink: false, realPath: e.path } }) as never)
  on('fs.exists', () => ({ value: w.isMac }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('prompt.read', async () => {
    if (w.promptReadDelayMs) await clock.sleep(w.promptReadDelayMs)
    return { value: { text: w.draft, cursor: w.draft.length } } as never
  })
  on('prompt.fill', (_$, e) => {
    w.fills.push({ text: e.text, mode: e.mode })
    return { isFilled: w.isFillable, text: e.text, cursor: e.text.length } as never
  })
  on('process.run', (_$, e) => {
    w.openedFiles.push([...e.argv])
    w.openedIn.push(e.init?.cwd ?? null)
    return { value: { exitCode: w.openExit, stdout: '', stderr: '' } } as never
  })
  on('fs.read', (_$, e) => {
    w.fsReads.push(e.path)
    return { value: w.files[e.path] ?? '' } as never
  })
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: w.stepUsages[e.index] ?? null } as never
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('tool.call', () => {
    const text = w.toolTexts.shift() ?? 'ok'
    return { result: { text }, text } as never
  })
  // As Claude Code answers a band no hook below drew; or another plugin's band below dividend's.
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if (e.component === 'AbovePrompt') {
      return w.otherBand ? <Text>{w.otherBand}</Text> : ({ type: 'engine', ref: 0 } as never)
    }

    return <Box />
  })
  return w
}

const settle = async (clock: MockClock) => {
  for (let i = 0; i < 12; i++) await clock.settle()
}

const start = async ($: Engine, on: On, surface: 'terminal' | 'desktop' = 'terminal', stored: Record<string, unknown> = {}, reading?: Reading, env: Record<string, string> = {}) => {
  const clock = mock.clock(on, { now: NOW })
  const w = makeWorld(on, clock, stored, env)
  if (reading) w.reading = reading
  await $.session.start({ cwd: '/work/repo', surface, isInteractive: true })
  await settle(clock)
  return { clock, w }
}

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string }
const WARM: Usage = { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 900, model: 'claude-haiku-4-5' }
let turnCount = 0

const turn = async ($: Engine, clock: MockClock, n = 1, usage: Usage = WARM) => {
  for (let i = 0; i < n; i++) {
    const turnId = `t${++turnCount}`
    await $.turn.start({ text: 'go on', turnId } as never)
    await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId, usage } as never)
    await settle(clock)
  }
}

const band = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'dividend', surface, component: 'AbovePrompt', props: BAND })

// A prompt sent into the session: typed by the person, or another origin's.
const say = (engine: Engine, text: string, kind = 'composer') => engine.prompt.submit({ text, origin: { kind }, wait: false } as never)

const tipTitles = (w: { store: Record<string, unknown> }): string[] =>
  ((w.store.dividend as { tips?: { title: string }[] } | undefined)?.tips ?? []).map(tip => tip.title)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a tip shows above the prompt, Got it puts it away, Don't show these turns its kind off (${surface})`, async ($, on) => {
    const { clock, w } = await start($, on, surface)
    const above = await band($, surface)

    w.reading = { ...w.reading, context: { tokens: 124_000, window: 200_000, percent: 62 } }
    await turn($, clock)
    await above.redraw()
    expect(await above.find({ text: 'Every message now carries 124k tokens' })).toBeDefined()
    expect(await above.find({ text: / · Tip · / })).toBeDefined()
    await above.press({ key: 'dividend-seen' })
    await above.redraw()
    expect(await above.find({ key: 'dividend-seen' })).toBeUndefined()

    w.reading = { ...w.reading, context: { tokens: 176_000, window: 200_000, percent: 88 } }
    await turn($, clock)
    await above.redraw()
    expect(await above.find({ text: 'The context window is 88% full' })).toBeDefined()
    await above.press({ key: 'dividend-mute' })
    await above.redraw()
    expect(await above.find({ key: 'dividend-seen' })).toBeUndefined()

    const pane = await $.ui.mount({ plugin: 'dividend', surface, component: 'Pane', requestId: 'dividend', props: PANE })
    expect(await pane.find({ text: 'read' })).toBeDefined()
    expect(await pane.find({ text: "this kind won't show again" })).toBeDefined()
    expect(w.toasts).toEqual([])
  })
}

test('/dividend with anything else lists the commands', async ($, on) => {
  await start($, on)
  const answer = (await $.command.run({ command: 'dividend', args: 'hello there' } as never)).text ?? ''
  expect(answer).toBe('/dividend opens the pane, /dividend session shows the prompt cache and the instruction files, /dividend compact compacts with a brief to carry on from, /dividend learn explains how it all works, /dividend reset clears the tips.')
})

const RESUMED: Reading = { context: { tokens: 120_000, window: 200_000, percent: 60 }, rateLimits: [], cost: { usd: 1.1 } }
const cold = (model = 'claude-haiku-4-5'): Usage => ({ input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 125_000, model })
const lastAnswer = (model: string, minutesAgo: number) => ({ 'dividend-turns': { [keyOf('session-one')]: { model, at: NOW - minutesAgo * 60_000 } } })

test('a resumed conversation that comes back to a cold cache is told why that turn was heavy, when no warning was on screen', async ($, on) => {
  const covering = { id: `tip:memory:${keyOf('/work/repo')}`, title: 'Instruction files add about 14k tokens to every message', body: 'b', receivedAt: NOW + 1 }
  const { clock, w } = await start($, on, 'terminal', { ...lastAnswer('claude-haiku-4-5', 75), dividend: { tips: [covering], reactions: {} } }, RESUMED)
  w.reading = { ...RESUMED, context: { tokens: 126_000, window: 200_000, percent: 63 }, cost: { usd: 1.31 } }
  await turn($, clock, 1, cold())
  expect(tipTitles(w)).toContain('This message re-cached 125k tokens')
  const pane = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })
  expect(await pane.find({ text: /^The prompt cache expired in the 75 min since the last answer.*about \$0\.21 at list price/ })).toBeDefined()
})

test('a warning on screen as the message went counts as told: the heavy turn after it is not reported again', async ($, on) => {
  const { clock, w } = await start($, on, 'terminal', lastAnswer('claude-haiku-4-5', 75), RESUMED)
  const above = await band($)
  expect(await above.find({ text: 'Your next message will re-cache 120k tokens' })).toBeDefined()
  w.reading = { ...RESUMED, context: { tokens: 126_000, window: 200_000, percent: 63 } }
  await turn($, clock, 1, cold())
  expect(tipTitles(w).some(title => title.includes('re-cached'))).toBe(false)
})

test('a resumed conversation whose cache was still warm gets no tip', async ($, on) => {
  const { clock, w } = await start($, on, 'terminal', lastAnswer('claude-haiku-4-5', 9), RESUMED)
  w.reading = { ...RESUMED, context: { tokens: 127_000, window: 200_000, percent: 63 } }
  await turn($, clock, 1, { ...WARM, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 7_000 })
  expect(tipTitles(w).some(title => title.includes('re-cached'))).toBe(false)
})

test('a heavy first turn after a model change is put down to the switch', async ($, on) => {
  const { clock, w } = await start($, on, 'terminal', lastAnswer('claude-haiku-4-5', 2), RESUMED)
  w.reading = { ...RESUMED, context: { tokens: 126_000, window: 200_000, percent: 63 } }
  await turn($, clock, 1, cold('claude-sonnet-5-5'))
  expect(tipTitles(w)).toContain('Switching models re-cached 125k tokens')
})

test("a fresh session's first turn fills its cache without a tip", async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { ...w.reading, context: { tokens: 46_000, window: 200_000, percent: 23 } }
  await turn($, clock, 1, { ...WARM, cache_read_input_tokens: 0, cache_creation_input_tokens: 45_000 })
  expect(tipTitles(w).some(title => title.includes('re-cached'))).toBe(false)
})

test('MCP servers that were loaded but never used are named after a few turns; used ones are not', async ($, on) => {
  const { clock, w } = await start($, on)
  w.mcpTools = [
    { name: 'mcp__linear__list_issues', serverName: 'linear', tokens: 3_500, isLoaded: true },
    { name: 'mcp__linear__create_issue', serverName: 'linear', tokens: 2_600, isLoaded: true },
    { name: 'mcp__github__get_pr', serverName: 'github', tokens: 4_000, isLoaded: true },
    { name: 'mcp__notion__search', serverName: 'notion', tokens: 9_000, isLoaded: false }
  ]
  await $.tool.call({ tool: 'mcp__github__get_pr', input: {} } as never)
  await turn($, clock, 4)
  const pane = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })
  expect(await pane.find({ text: /Unused MCP servers/ })).toBeUndefined()
  await pane.unmount()
  await turn($, clock)
  const after = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })
  expect(await after.find({ text: 'Unused MCP servers add about 6.1k tokens to every message' })).toBeDefined()
  expect(await after.find({ text: /^linear \(6\.1k\) hasn't been used in this session/ })).toBeDefined()
  const above = await band($)
  expect(await above.find({ text: /Unused MCP servers/ })).toBeUndefined()
  expect(w.statuses.at(-1)).toBe('$0.40 API-eq')
  expect(w.breakdowns).toBeLessThan(w.usageCalls)
})

test('the status line leads with the 5-hour limit, and the pane leaves totals to /usage', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = {
    context: { tokens: 90_000, window: 200_000, percent: 45 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 41.2, resetsAt: new Date(NOW + 2 * 3600 * 1000).toISOString() },
      { kind: 'seven_day', percentUsed: 12 }
    ],
    cost: { usd: 3.12 }
  }
  w.memoryFiles = [{ path: '/work/repo/CLAUDE.md', type: 'Project', tokens: 4_000 }]
  await turn($, clock)
  expect(w.statuses.at(-1)).toBe('5h 41%')
  const pane = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })
  expect(await pane.find({ text: /so far at list price|on pace|Last prompt/ })).toBeUndefined()
  expect(await pane.find({ text: /^\s*project 4\.0k$/ })).toBeDefined()
  expect(await pane.find({ key: `dividend-open-${keyOf('/work/repo/CLAUDE.md')}` })).toBeDefined()
})

test('"Don\'t show these" turns that kind of tip off in later sessions too', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { ...w.reading, context: { tokens: 124_000, window: 200_000, percent: 62 } }
  await turn($, clock)
  const above = await band($)
  expect(await above.find({ text: 'Every message now carries 124k tokens' })).toBeDefined()
  await above.press({ key: 'dividend-mute' })
  await above.redraw()
  expect(await above.find({ key: 'dividend-seen' })).toBeUndefined()

  w.sessionId = 'session-two'
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
  await settle(clock)
  await turn($, clock)
  await above.redraw()
  expect(await above.find({ text: /carries 124k tokens/ })).toBeUndefined()
})

test('the spend alert follows the budgetUsd setting', { options: { budgetUsd: 5 } }, async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { ...w.reading, cost: { usd: 12.3 } }
  await turn($, clock)
  expect(tipTitles(w)).toContain('This session passed $10.00 at list price')
})

test('tips can be turned off', { options: { tips: false } }, async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { ...w.reading, context: { tokens: 180_000, window: 200_000, percent: 90 } }
  await turn($, clock)
  expect(tipTitles(w)).toEqual([])
})

test('an idle session does no work: nothing runs on a timer', async ($, on) => {
  const { clock, w } = await start($, on)
  const calls = w.usageCalls
  for (let i = 0; i < 10; i++) {
    await clock.advance(60_000)
    await settle(clock)
  }
  expect(w.usageCalls).toBe(calls)
  await turn($, clock)
  expect(w.usageCalls).toBe(calls + 1)
})

test('subagent turns are not counted as the conversation moving on', async ($, on) => {
  const { clock, w } = await start($, on)
  const calls = w.usageCalls
  await $.turn.complete({ answer: 'sub', durationMs: 10, isAborted: false, turnId: 'a1', agentId: 'agent-1' } as never)
  await settle(clock)
  expect(w.usageCalls).toBe(calls)
})

test('/dividend session prints the prompt cache and the instruction files, and draws the card from its own text', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { context: { tokens: 130_000, window: 200_000, percent: 65 }, rateLimits: [], cost: { usd: 2.5 } }
  await turn($, clock)
  const breakdowns = w.breakdowns
  const report = (await $.command.run({ command: 'dividend', args: 'session' } as never)).text ?? ''
  expect(w.breakdowns).toBe(breakdowns + 1)
  const lines = report.split('\n')
  expect(lines.filter(line => !line.startsWith('Prompt cache:'))).toEqual([
    'Dividend · this session',
    'Instruction files: 0',
    'Tips waiting: 1 — Every message now carries 130k tokens (/dividend shows them)'
  ])
  expect(lines.find(line => line.startsWith('Prompt cache:'))).toMatch(/^Prompt cache: warm until \d{1,2}:\d{2}.* ▰{10} — lasts 5 minutes on API billing$/)

  const printed = ['Dividend · this session', 'Prompt cache: warm until 9:56 AM ▰▰▰▱▱▱▱▱▱▱ — lasts 1 hour on a subscription within its limits', 'Instruction files: about 99k — project 99k'].join('\n')
  const row = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'CommandOutput', props: { command: 'dividend', args: 'session', text: `dividend: ${printed}`, isErrored: false } })
  expect(await row.find({ text: 'warm until 9:56 AM ' })).toBeDefined()
  expect(await row.find({ text: 'about 99k' })).toBeDefined()
  expect(await row.find({ text: '  project 99k' })).toBeDefined()

  const lesson = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'CommandOutput', props: { command: 'dividend', args: 'learn cache', text: 'How the prompt cache works', isErrored: false } })
  expect(await lesson.find({ text: 'Prompt cache' })).toBeUndefined()
})
test('a compaction drops the old context figure and the context tip it made moot, until the next answer', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { ...w.reading, context: { tokens: 176_000, window: 200_000, percent: 88 } }
  await turn($, clock)
  expect(w.statuses.at(-1)).toBe('1 new · $0.40 API-eq')

  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  await settle(clock)
  expect(w.statuses.at(-1)).toBe('$0.40 API-eq')
  const report = (await $.command.run({ command: 'dividend', args: 'session' } as never)).text ?? ''
  expect(report).not.toContain('88%')
  expect(w.statuses.at(-1)).toBe('$0.40 API-eq')

  w.reading = { ...w.reading, context: { tokens: 150_000, window: 200_000, percent: 75 } }
  await turn($, clock, 1, { ...WARM, cache_read_input_tokens: 0, cache_creation_input_tokens: 45_000 })
  expect(w.statuses.at(-1)).toBe('1 new · $0.40 API-eq')
  expect(tipTitles(w).some(title => title.includes('re-cached'))).toBe(false)
})

test("a subagent's compaction, a precompute and a vetoed compaction leave the figures alone", async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { ...w.reading, context: { tokens: 176_000, window: 200_000, percent: 88 } }
  await turn($, clock)
  await $.session.compact({ trigger: 'auto', agentId: 'agent-1', messages: [SUMMARY] })
  await $.session.compact({ trigger: 'precompute', messages: [SUMMARY] })
  w.compactResult = { skip: 'a hook said no' }
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  await settle(clock)
  expect(w.statuses.at(-1)).toBe('1 new · $0.40 API-eq')
  const report = (await $.command.run({ command: 'dividend', args: 'session' } as never)).text ?? ''
  expect(report).toContain('Tips waiting: 1 — The context window is 88% full')
})

test('a tip not yet read keeps its figures current; once read it stays as it was', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { ...w.reading, context: { tokens: 124_000, window: 200_000, percent: 62 } }
  await turn($, clock)
  const above = await band($)
  w.reading = { ...w.reading, context: { tokens: 140_000, window: 200_000, percent: 70 } }
  await turn($, clock)
  await above.redraw()
  expect(await above.find({ text: 'Every message now carries 140k tokens' })).toBeDefined()
  expect(tipTitles(w).filter(title => title.includes('carries'))).toEqual(['Every message now carries 140k tokens'])

  await above.press({ key: 'dividend-seen' })
  w.reading = { ...w.reading, context: { tokens: 150_000, window: 200_000, percent: 75 } }
  await turn($, clock)
  const pane = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })
  expect(await pane.find({ text: 'Every message now carries 140k tokens' })).toBeDefined()
})

test('the instruction-files tip names the heavy places, with files as the project knows them, and restates an older unread one', async ($, on) => {
  const older = {
    dividend: {
      tips: [
        {
          id: `tip:memory:${keyOf('/work/repo')}`,
          title: 'Instruction files add 16k tokens to every message',
          body: 'The CLAUDE.md and memory files loaded here (largest: repo/AGENTS.md, 8.9k) are sent with every request.',
          receivedAt: 1
        }
      ],
      reactions: {}
    }
  }
  const { clock, w } = await start($, on, 'terminal', older)
  w.memoryFiles = [
    { path: '/work/repo/CLAUDE.md', type: 'Project', tokens: 16 },
    { path: '/work/repo/AGENTS.md', type: 'Project', tokens: 8_900 },
    { path: '/home/dana/.claude/projects/-work-repo/memory/MEMORY.md', type: 'AutoMem', tokens: 7_500 },
    { path: '/home/dana/.claude/CLAUDE.md', type: 'User', tokens: 21 }
  ]
  await turn($, clock)
  const above = await band($)
  expect(await above.find({ text: 'Instruction files add about 16k tokens to every message' })).toBeDefined()
  expect(
    await above.find({ text: /^Project files add about 8\.9k \(largest: AGENTS\.md\).* Auto memory, Claude's notes on this project, adds about 7\.5k \(memory\/MEMORY\.md\)/ })
  ).toBeDefined()
    const pane = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })
  expect(await pane.find({ text: /^\s*auto memory 7\.5k$/ })).toBeDefined()
  expect(await pane.find({ key: `dividend-open-${keyOf('/work/repo/AGENTS.md')}` })).toBeDefined()
})

test("a cold start is caught by the turn's first request, though the tool calls after it read the cache", async ($, on) => {
  const { clock, w } = await start($, on, 'terminal', lastAnswer('claude-haiku-4-5', 9), RESUMED)
  w.reading = { ...RESUMED, context: { tokens: 128_000, window: 200_000, percent: 64 }, cost: { usd: 1.4 } }
  const warmAfter: Usage = { ...WARM, cache_read_input_tokens: 125_000, cache_creation_input_tokens: 2_000 }
  w.stepUsages = [cold(), warmAfter, warmAfter]
  const turnId = 'cold-tools'
  await $.turn.start({ text: 'carry on', turnId } as never)
  for (let index = 0; index < w.stepUsages.length; index++) {
    for await (const _ of $.turn.step({ turnId, index, model: 'claude-haiku-4-5', messageCount: 4 + index } as never)) {
      // drained: the stub streams nothing
    }
  }
  const summed: Usage = { input_tokens: 30, output_tokens: 120, cache_read_input_tokens: 250_000, cache_creation_input_tokens: 129_000, model: 'claude-haiku-4-5' }
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId, usage: summed } as never)
  await settle(clock)
  expect(tipTitles(w)).toContain('This message re-cached 125k tokens')
})

const SEAT: Reading = {
  context: { tokens: 120_000, window: 200_000, percent: 60 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 20, resetsAt: new Date(NOW + 4 * 3600 * 1000).toISOString() }],
  cost: { usd: 1.0 }
}

const chosen = (action: string) => ({ 'dividend-settings': { cacheExpiryAction: action } })

for (const stored of [{}, chosen('Do nothing'), chosen('invalid'), { 'dividend-settings': 'Keep cache warm' }]) {
  test(`cache policy ${JSON.stringify(stored)} leaves an idle session alone`, async ($, on) => {
    const { clock, w } = await start($, on, 'terminal', stored, SEAT)
    await turn($, clock)
    await clock.advance(61 * 60_000)
    await settle(clock)
    expect(w.submissions).toEqual([])
    expect(w.compactions).toBe(0)
  })
}

test('keep-alive submits a fixed plugin prompt at 50 minutes, then rearms after its answer', { options: { tips: false, cache: false, actions: false } }, async ($, on) => {
  const { clock, w } = await start($, on, 'terminal', chosen('Keep cache warm'), SEAT)
  await say($, 'add the export button')
  await turn($, clock)
  await clock.advance(49 * 60_000)
  await settle(clock)
  expect(w.submissions).toEqual([])
  await clock.advance(60_000)
  await settle(clock)
  expect(w.submissions).toEqual([KEEP_ALIVE_PROMPT])
  expect(w.fills).toEqual([])
  await turn($, clock)
  await clock.advance(50 * 60_000)
  await settle(clock)
  expect(w.submissions).toEqual([KEEP_ALIVE_PROMPT, KEEP_ALIVE_PROMPT])
  await turn($, clock)
  await $.command.run({ command: 'dividend', args: 'compact' } as never)
  await settle(clock)
  expect(w.compactInstructions.at(-1)).toContain('the person\'s latest request: "add the export button"')
})

test("keep-alive stops after 5 in a row, and only the person's own message starts the count again", async ($, on) => {
  const { clock, w } = await start($, on, 'terminal', chosen('Keep cache warm'), SEAT)
  await turn($, clock)
  for (let i = 0; i < 5; i++) {
    await clock.advance(50 * 60_000)
    await settle(clock)
    await turn($, clock)
  }
  expect(w.submissions.length).toBe(5)
  await clock.advance(50 * 60_000)
  await settle(clock)
  expect(w.submissions.length).toBe(5)
  await say($, 'build finished', 'task-notification')
  await turn($, clock)
  await clock.advance(50 * 60_000)
  await settle(clock)
  expect(w.submissions.length).toBe(5)
  await say($, 'back, carry on')
  await turn($, clock)
  await clock.advance(50 * 60_000)
  await settle(clock)
  expect(w.submissions).toEqual(Array(6).fill(KEEP_ALIVE_PROMPT))
})

test('keep-alive runs at four minutes for a small conversation on a five-minute cache', async ($, on) => {
  const { clock, w } = await start($, on, 'terminal', chosen('Keep cache warm'))
  await turn($, clock)
  await clock.advance(239_000)
  await settle(clock)
  expect(w.submissions).toEqual([])
  await clock.advance(1000)
  await settle(clock)
  expect(w.submissions).toEqual([KEEP_ALIVE_PROMPT])
})

test('automatic compaction uses the brief once and never submits a keep-alive', { options: { tips: false, actions: false } }, async ($, on) => {
  const { clock, w } = await start($, on, 'terminal', chosen('Auto compact'), SEAT)
  await say($, 'add the export button')
  await turn($, clock)
  await clock.advance(50 * 60_000)
  await settle(clock)
  expect(w.compactions).toBe(1)
  expect(w.compactInstructions[0]).toContain('add the export button')
  await clock.advance(2 * 3600_000)
  await settle(clock)
  expect(w.compactions).toBe(1)
  expect(w.submissions).toEqual([])
  expect(w.fills).toEqual([])
})

for (const action of ['Keep cache warm', 'Auto compact']) {
  for (const interruption of ['draft', 'turn', 'end', 'changed session', 'sleep', 'TTL shortened', 'compaction']) {
    test(`${action} skips after ${interruption}`, async ($, on) => {
      const { clock, w } = await start($, on, 'terminal', chosen(action), SEAT)
      await turn($, clock)
      if (interruption === 'draft') w.draft = 'half-written thought'
      if (interruption === 'turn') await $.turn.start({ text: 'working', turnId: 'running' } as never)
      if (interruption === 'end') await $.session.end({ reason: 'exit', sessionId: w.sessionId } as never)
      if (interruption === 'changed session') w.sessionId = 'another-session'
      if (interruption === 'TTL shortened') w.settings = { promptCacheTtl: '5m' }
      // A pending host call resumes after the computer wakes; the action must use the time then.
      if (interruption === 'sleep') w.promptReadDelayMs = 11 * 60_000
      if (interruption === 'compaction') await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
      await settle(clock)
      await clock.advance((interruption === 'sleep' ? 61 : 50) * 60_000)
      await settle(clock)
      expect(w.submissions).toEqual([])
      expect(w.compactions).toBe(interruption === 'compaction' ? 1 : 0)
      expect(w.fills).toEqual([])
      if (interruption === 'draft') expect(w.draft).toBe('half-written thought')
    })
  }

  test(`${action} does nothing with caching disabled`, async ($, on) => {
    const { clock, w } = await start($, on, 'terminal', chosen(action), SEAT, { DISABLE_PROMPT_CACHING: '1' })
    await turn($, clock)
    await clock.advance(61 * 60_000)
    await settle(clock)
    expect(w.submissions).toEqual([])
    expect(w.compactions).toBe(0)
  })

  test(`${action} does not guess the lifetime of a resumed cache`, async ($, on) => {
    const { clock, w } = await start($, on, 'terminal', { ...lastAnswer('claude-haiku-4-5', 9), ...chosen(action) }, RESUMED)
    await clock.advance(51 * 60_000)
    await settle(clock)
    expect(w.submissions).toEqual([])
    expect(w.compactions).toBe(0)
  })

  test(`${action} discards a firing timer when a compaction finishes meanwhile`, async ($, on) => {
    const { clock, w } = await start($, on, 'terminal', chosen(action), SEAT)
    await turn($, clock)
    w.promptReadDelayMs = 1000
    await clock.advance(50 * 60_000)
    await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
    await clock.advance(1000)
    await settle(clock)
    expect(w.submissions).toEqual([])
    expect(w.compactions).toBe(1)
  })

  test(`${action} discards a firing timer when a newer turn finishes`, async ($, on) => {
    const { clock, w } = await start($, on, 'terminal', chosen(action), SEAT)
    await turn($, clock)
    w.promptReadDelayMs = 1000
    await clock.advance(50 * 60_000)
    await turn($, clock)
    await clock.advance(1000)
    await settle(clock)
    expect(w.submissions).toEqual([])
    expect(w.compactions).toBe(0)
  })
}

for (const failure of ['skip', 'error', 'headless error']) {
  test(`automatic compaction handles ${failure} without drafting or retrying`, async ($, on) => {
    const { clock, w } = await start($, on, 'terminal', chosen('Auto compact'), SEAT)
    if (failure === 'skip') w.compactResult = { skip: 'a hook said no' }
    else w.compactError = failure === 'headless error' ? '$.session.compact: not available in a headless session' : 'unavailable'
    await turn($, clock)
    await clock.advance(50 * 60_000)
    await settle(clock)
    expect(w.toasts.at(-1)).toContain(failure === 'skip' ? 'skipped' : 'failed')
    expect(w.fills).toEqual([])
    const attempts = w.compactions
    await clock.advance(61 * 60_000)
    await settle(clock)
    expect(w.compactions).toBe(attempts)
  })
}

test('automatic compaction skips SDK and desktop sessions without filling their prompt', async ($, on) => {
  const { clock, w } = await start($, on, 'desktop', chosen('Auto compact'), SEAT)
  await $.session.start({ cwd: '/work/repo', surface: 'desktop', isInteractive: false })
  await settle(clock)
  await turn($, clock)
  await clock.advance(50 * 60_000)
  await settle(clock)
  expect(w.compactions).toBe(0)
  expect(w.submissions).toEqual([])
  expect(w.fills).toEqual([])
})

for (const failure of ['error', 'drop']) {
  test(`keep-alive handles a prompt ${failure} once`, async ($, on) => {
    const { clock, w } = await start($, on, 'terminal', chosen('Keep cache warm'), SEAT)
    w.promptError = failure === 'error'
    w.promptDrop = failure === 'drop'
    await turn($, clock)
    await clock.advance(50 * 60_000)
    await settle(clock)
    expect(w.toasts.at(-1)).toContain('no retry until the next answer')
    await clock.advance(61 * 60_000)
    await settle(clock)
    expect(w.submissions.length).toBe(failure === 'error' ? 0 : 1)
    expect(w.compactions).toBe(0)
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane picks what happens before the cache expires, and an idle session follows it at once (${surface})`, async ($, on) => {
    const { clock, w } = await start($, on, surface, {}, SEAT)
    await turn($, clock)
    const pane = await $.ui.mount({ plugin: 'dividend', surface, component: 'Pane', requestId: 'dividend', props: PANE })
    expect(await pane.find({ text: 'Before the prompt cache expires' })).toBeDefined()
    expect(await pane.find({ text: /^Dividend only shows tips/ })).toBeDefined()
    await pane.press({ key: 'dividend-expiry-warm' })
    await settle(clock)
    await pane.redraw()
    expect(w.store['dividend-settings']).toEqual({ cacheExpiryAction: 'Keep cache warm' })
    expect(await pane.find({ text: /^Shortly before the cache expires, Dividend sends a short message/ })).toBeDefined()
    await clock.advance(50 * 60_000)
    await settle(clock)
    expect(w.submissions).toEqual([KEEP_ALIVE_PROMPT])
  })
}

test('Do nothing picked in another session stops the keep-alive this one had armed', async ($, on) => {
  const { clock, w } = await start($, on, 'terminal', chosen('Keep cache warm'), SEAT)
  await turn($, clock)
  w.store['dividend-settings'] = { cacheExpiryAction: 'Do nothing' }
  await clock.advance(50 * 60_000)
  await settle(clock)
  expect(w.submissions).toEqual([])
})

test('/dividend reset goes back to doing nothing before the cache expires', async ($, on) => {
  const { clock, w } = await start($, on, 'terminal', chosen('Keep cache warm'), SEAT)
  await turn($, clock)
  await $.command.run({ command: 'dividend', args: 'reset' } as never)
  await settle(clock)
  expect(w.store['dividend-settings']).toBeUndefined()
  await clock.advance(50 * 60_000)
  await settle(clock)
  expect(w.submissions).toEqual([])
})

test('a desktop pane says its sessions skip Auto compact', async ($, on) => {
  const { clock } = await start($, on, 'desktop', chosen('Auto compact'), SEAT)
  await $.session.start({ cwd: '/work/repo', surface: 'desktop', isInteractive: false })
  await settle(clock)
  const pane = await $.ui.mount({ plugin: 'dividend', surface: 'desktop', component: 'Pane', requestId: 'dividend', props: PANE })
  expect(await pane.find({ text: /^Desktop and SDK sessions like this one skip it/ })).toBeDefined()
})

test('a break in a big conversation brings an offer to compact before the cache lapses, then a warning once it has', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = SEAT
  await turn($, clock)
  const above = await band($)
  await clock.advance(49 * 60 * 1000)
  await settle(clock)
  await above.redraw()
  expect(await above.find({ text: /^The prompt cache expires at / })).toBeUndefined()
  await clock.advance(2 * 60 * 1000)
  await settle(clock)
  await above.redraw()
  expect(await above.find({ text: /^The prompt cache expires at / })).toBeDefined()
  expect(await above.find({ key: 'dividend-compact' })).toBeDefined()

  await clock.advance(10 * 60 * 1000)
  await settle(clock)
  await above.redraw()
  expect(await above.find({ text: 'Your next message will re-cache 120k tokens' })).toBeDefined()
  expect(await above.find({ text: /^The prompt cache expires at / })).toBeUndefined()
  await above.press({ key: 'dividend-seen' })

  await turn($, clock, 1, cold())
  expect(tipTitles(w).some(title => title.includes('re-cached'))).toBe(false)
})

test('Compact now compacts the conversation, and only when pressed', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = SEAT
  await turn($, clock)
  await clock.advance(51 * 60 * 1000)
  await settle(clock)
  expect(w.compactions).toBe(0)
  const above = await band($)
  await above.press({ key: 'dividend-compact' })
  await settle(clock)
  expect(w.compactions).toBe(1)
  await clock.advance(10 * 60 * 1000)
  await settle(clock)
  await above.redraw()
  expect(await above.find({ text: /Your next message will re-cache/ })).toBeUndefined()
})

test('a resumed conversation whose cache lapsed while it was closed is told before its first message', async ($, on) => {
  const { clock, w } = await start($, on, 'terminal', lastAnswer('claude-haiku-4-5', 75), RESUMED)
  await settle(clock)
  const above = await band($)
  expect(await above.find({ text: 'Your next message will re-cache 120k tokens' })).toBeDefined()
  expect(await above.find({ text: /^The prompt cache lasts 1 hour at most, and Claude last answered at \d{1,2}:\d{2}/ })).toBeDefined()
  expect(w.compactions).toBe(0)
})

test('the cache lifetime follows the promptCacheTtl setting', async ($, on) => {
  const { clock, w } = await start($, on)
  w.settings = { promptCacheTtl: '5m' }
  w.reading = SEAT
  await turn($, clock)
  await clock.advance(6 * 60 * 1000)
  await settle(clock)
  const pane = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })
  expect(await pane.find({ text: /^\s*lasts 5 minutes \(promptCacheTtl in your settings\)$/ })).toBeDefined()
  expect(await pane.find({ text: 'Your next message will re-cache 120k tokens' })).toBeDefined()
})

test('on API billing, breaks that keep outlasting the 5-minute cache suggest a longer one', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { context: { tokens: 120_000, window: 200_000, percent: 60 }, rateLimits: [], cost: { usd: 1.0 } }
  await turn($, clock)
  for (let i = 0; i < 3; i++) {
    await clock.advance(10 * 60 * 1000)
    await settle(clock)
    await turn($, clock, 1, cold())
  }
  expect(tipTitles(w)).toContain('Your breaks keep outlasting the 5-minute cache')

  await clock.advance(10 * 60 * 1000)
  await settle(clock)
  await turn($, clock, 1, { ...WARM, cache_read_input_tokens: 118_000, cache_creation_input_tokens: 2_000 })
  expect(tipTitles(w)).not.toContain('Your breaks keep outlasting the 5-minute cache')
})

test('a cache still warm after a 10-minute break means it lasts longer than 5 minutes: no advice to lengthen it', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { context: { tokens: 120_000, window: 200_000, percent: 60 }, rateLimits: [], cost: { usd: 1.0 } }
  await turn($, clock)
  await clock.advance(10 * 60 * 1000)
  await settle(clock)
  await turn($, clock, 1, { ...WARM, cache_read_input_tokens: 118_000, cache_creation_input_tokens: 2_000 })
  for (let i = 0; i < 3; i++) {
    await clock.advance(10 * 60 * 1000)
    await settle(clock)
    await turn($, clock, 1, cold())
  }
  expect(tipTitles(w)).not.toContain('Your breaks keep outlasting the 5-minute cache')
})

test('an area can be turned off as a whole', { options: { cache: false } }, async ($, on) => {
  const { clock, w } = await start($, on, 'terminal', lastAnswer('claude-haiku-4-5', 75), RESUMED)
  w.reading = { ...RESUMED, context: { tokens: 126_000, window: 200_000, percent: 63 } }
  await turn($, clock, 1, cold())
  expect(tipTitles(w).some(title => title.includes('re-cached') || title.includes('will re-cache'))).toBe(false)
  expect(tipTitles(w)).toContain('Every message now carries 126k tokens')
})


const toolTurn = async ($: Engine, clock: MockClock, calls: Record<string, unknown>[], usage: Usage = WARM) => {
  const turnId = `t${++turnCount}`
  await $.turn.start({ text: 'go on', turnId } as never)
  for (const call of calls) await $.tool.call(call as never)
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId, usage } as never)
  await settle(clock)
}

test('a turn that added 50k+ tokens names the tool output behind most of it', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { context: { tokens: 60_000, window: 200_000, percent: 30 }, rateLimits: [], cost: { usd: 1 } }
  await turn($, clock)
  w.reading = { context: { tokens: 115_000, window: 200_000, percent: 57 }, rateLimits: [], cost: { usd: 1.5 } }
  w.toolTexts = ['x'.repeat(160_000), 'y'.repeat(40_000)]
  await toolTurn($, clock, [{ tool: 'Bash', command: 'cd app && CI=1 make build 2>&1' }, { tool: 'Read', file_path: '/work/repo/src/app.ts' }])
  expect(tipTitles(w)).toContain('That turn added 55k tokens to the conversation')
  const pane = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })
  expect(await pane.find({ text: /^About 40k of it came from a Bash run of make, and every later message carries it/ })).toBeDefined()
})

test('a commit in a big conversation offers to compact, with a brief of the goal and the files touched', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { context: { tokens: 80_000, window: 200_000, percent: 40 }, rateLimits: [], cost: { usd: 1 } }
  await say($, 'add the export button')
  await say($, '/dividend')
  await toolTurn($, clock, [
    { tool: 'Edit', file_path: '/work/repo/src/export.ts' },
    { tool: 'Bash', command: 'git commit -m "Add export"' }
  ])
  const above = await band($)
  expect(await above.find({ text: 'A good moment to compact' })).toBeDefined()
  w.compactResult = { messages: [{ ...SUMMARY, text: 'The goal: an export button.' }], tokensBefore: 80_000, tokensAfter: 9_000 } as never
  await above.press({ key: 'dividend-compact' })
  await settle(clock)
  expect(w.compactInstructions.at(-1)).toContain('the person\'s latest request: "add the export button"')
  expect(w.compactInstructions.at(-1)).toContain('the files touched (src/export.ts)')
  expect(w.toasts).toContain('Compacted: 80k to 9.0k tokens.')
  await above.redraw()
  expect(await above.find({ text: 'A good moment to compact' })).toBeUndefined()
})

test('/dividend compact compacts with a brief', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { context: { tokens: 90_000, window: 200_000, percent: 45 }, rateLimits: [], cost: { usd: 1 } }
  await turn($, clock)
  w.compactResult = { messages: [{ ...SUMMARY, text: 'The goal: ship 0.6.0.' }], tokensBefore: 240_000, tokensAfter: 18_000 } as never
  const answer = (await $.command.run({ command: 'dividend', args: 'compact keep the API notes' } as never)).text ?? ''
  expect(answer).toBe('Compacting, with a brief to carry on from.')
  await settle(clock)
  expect(w.compactions).toBe(1)
  expect(w.toasts).toContain('Compacted: 240k to 18k tokens.')
  expect(w.compactInstructions.at(-1)?.endsWith('Also: keep the API notes')).toBe(true)
})

test('a file read whole three times in a session is named once', async ($, on) => {
  const { clock, w } = await start($, on)
  w.toolTexts = ['z'.repeat(24_000), 'z'.repeat(24_000), 'z'.repeat(24_000)]
  const read = { tool: 'Read', file_path: '/work/repo/src/app.ts' }
  await toolTurn($, clock, [read, read])
  expect(tipTitles(w).some(title => title.includes('was read'))).toBe(false)
  await toolTurn($, clock, [read])
  expect(tipTitles(w)).toContain('src/app.ts was read 3 times this session')
})

test('a limit that moves mid-turn updates the status line before the turn ends', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = SEAT
  await turn($, clock)
  expect(w.statuses.at(-1)).toBe('1 new · 5h 20%')
  await $.turn.start({ text: 'a long task', turnId: 'long' } as never)
  await $.session.measure({
    context: SEAT.context,
    rateLimits: [{ kind: 'five_hour', percentUsed: 26, resetsAt: new Date(NOW + 4 * 3600 * 1000).toISOString() }],
    cost: { usd: 1.4 },
    changed: ['rateLimits', 'cost']
  } as never)
  await settle(clock)
  expect(w.statuses.at(-1)).toBe('1 new · 5h 26%')
})

test('/dividend learn explains a topic, and lists them otherwise', async ($, on) => {
  await start($, on)
  const lesson = (await $.command.run({ command: 'dividend', args: 'learn cache' } as never)).text ?? ''
  expect(lesson.startsWith('How the prompt cache works')).toBe(true)
  const index = (await $.command.run({ command: 'dividend', args: 'learn' } as never)).text ?? ''
  expect(index.startsWith('Lessons:')).toBe(true)
})

test('three turns of only reading and editing on Opus suggest a lighter model', async ($, on) => {
  const { clock, w } = await start($, on)
  const opus: Usage = { ...WARM, model: 'claude-opus-5-5' }
  const edit = [{ tool: 'Read', file_path: '/work/repo/a.ts' }, { tool: 'Edit', file_path: '/work/repo/a.ts' }]
  await toolTurn($, clock, edit, opus)
  await toolTurn($, clock, edit, opus)
  expect(tipTitles(w).some(title => title.includes('lighter model'))).toBe(false)
  await toolTurn($, clock, edit, opus)
  expect(tipTitles(w)).toContain('This work runs well on a lighter model')
})

test('an instruction repeated in two instruction files is named once per project', async ($, on) => {
  const { clock, w } = await start($, on)
  w.files = {
    '/home/dana/.claude/CLAUDE.md': '- Run the test suite before every commit and fix what fails.',
    '/work/repo/AGENTS.md': '* Run the test suite before every commit and fix what fails.'
  }
  w.memoryFiles = [
    { path: '/home/dana/.claude/CLAUDE.md', type: 'User', tokens: 20 },
    { path: '/work/repo/AGENTS.md', type: 'Project', tokens: 4_000 }
  ]
  await turn($, clock)
  expect(tipTitles(w)).toContain('The same instruction is in two instruction files')
})

test('the weekly limit joins the status line past 70%, and a limit near the wall raises its own tip mid-turn', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { ...SEAT, rateLimits: [...SEAT.rateLimits, { kind: 'seven_day', percentUsed: 72, resetsAt: new Date(NOW + 86400 * 1000).toISOString() }] }
  await turn($, clock)
  expect(w.statuses.at(-1)).toBe('1 new · 5h 20% · 7d 72%')
  await $.turn.start({ text: 'one more', turnId: 'wall' } as never)
  await $.session.measure({
    context: SEAT.context,
    rateLimits: [{ kind: 'five_hour', percentUsed: 96, resetsAt: new Date(NOW + 3600 * 1000).toISOString() }],
    cost: { usd: 2 },
    changed: ['rateLimits']
  } as never)
  await settle(clock)
  expect(tipTitles(w)).toContain('96% of your 5-hour limit is used')
})

test("another session's tips stay in that session; this project's and the account's show here", async ($, on) => {
  const elsewhere = {
    dividend: {
      tips: [
        { id: 'tip:context:someone-else', title: 'Every message now carries 609k tokens', body: 'b', receivedAt: 1 },
        { id: `tip:memory:${keyOf('/work/repo')}`, title: 'Instruction files add about 14k tokens to every message', body: 'b', receivedAt: 2 },
        { id: 'tip:memory:another-project', title: 'Instruction files add about 30k tokens to every message', body: 'b', receivedAt: 3 },
        { id: 'tip:rate-limit:five_hour:2026-10-07T12:00:00.000Z', title: '85% of your 5-hour limit is used', body: 'b', receivedAt: 4 }
      ],
      reactions: {}
    }
  }
  const { w } = await start($, on, 'terminal', elsewhere)
  expect(w.statuses.at(-1)).toBe('2 new')
  const pane = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })
  expect(await pane.find({ text: 'Every message now carries 609k tokens' })).toBeUndefined()
  expect(await pane.find({ text: 'Instruction files add about 30k tokens to every message' })).toBeUndefined()
  expect(await pane.find({ text: 'Instruction files add about 14k tokens to every message' })).toBeDefined()
  expect(await pane.find({ text: '85% of your 5-hour limit is used' })).toBeDefined()
  const above = await band($)
  expect(await above.find({ text: '85% of your 5-hour limit is used' })).toBeDefined()
})

test("a kind turned off in another session is off here at the next turn, and this session's saves keep it off", async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { ...w.reading, context: { tokens: 124_000, window: 200_000, percent: 62 } }
  await turn($, clock)
  expect(w.statuses.at(-1)).toBe('1 new · $0.40 API-eq')
  const saved = w.store.dividend as { tips: unknown[]; reactions: Record<string, string> }
  w.store.dividend = { ...saved, reactions: { ...saved.reactions, 'tip:context:other-session': 'not-relevant' } }
  await turn($, clock)
  expect(w.statuses.at(-1)).toBe('$0.40 API-eq')
  const above = await band($)
  expect(await above.find({ text: /carries/ })).toBeUndefined()
  expect((w.store.dividend as { reactions: Record<string, string> }).reactions['tip:context:other-session']).toBe('not-relevant')
})

test("saving keeps what other sessions saved since this one started", async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { ...w.reading, context: { tokens: 124_000, window: 200_000, percent: 62 } }
  await turn($, clock)
  const saved = w.store.dividend as { tips: unknown[]; reactions: Record<string, string> }
  const theirs = { id: 'tip:recache:other-session', title: 'This message re-cached 90k tokens', body: 'b', receivedAt: 2 }
  w.store.dividend = { tips: [...saved.tips, theirs], reactions: { ...saved.reactions, 'tip:budget:other-session:5': 'not-relevant' } }
  w.reading = { ...w.reading, context: { tokens: 130_000, window: 200_000, percent: 65 } }
  await turn($, clock)
  const now = w.store.dividend as { tips: { id: string; title: string }[]; reactions: Record<string, string> }
  expect(now.tips.map(tip => tip.id)).toContain('tip:recache:other-session')
  expect(now.tips.find(tip => tip.id.startsWith('tip:context:'))?.title).toBe('Every message now carries 130k tokens')
  expect(now.reactions['tip:budget:other-session:5']).toBe('not-relevant')
})

test('a limit tip raised mid-turn and a context tip raised as the turn ends are both saved, though their saves overlap', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { ...SEAT, context: { tokens: 30_000, window: 200_000, percent: 15 } }
  await turn($, clock)
  w.isHoldingWrites = true
  w.reading = { ...SEAT, context: { tokens: 124_000, window: 200_000, percent: 62 } }
  await $.turn.start({ text: 'one more', turnId: 'overlap' } as never)
  await $.session.measure({
    context: SEAT.context,
    rateLimits: [{ kind: 'five_hour', percentUsed: 96, resetsAt: new Date(NOW + 3600 * 1000).toISOString() }],
    cost: { usd: 2 },
    changed: ['rateLimits']
  } as never)
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 'overlap', usage: WARM } as never)
  // Both saves are under way before either writes; then the writes go through.
  for (let round = 0; round < 5; round++) {
    await settle(clock)
    w.heldWrites.splice(0).forEach(write => write())
  }
  w.isHoldingWrites = false
  await settle(clock)
  expect(tipTitles(w)).toContain('96% of your 5-hour limit is used')
  expect(tipTitles(w)).toContain('Every message now carries 124k tokens')
})

// Accepted for now: $.store has no ifVersion, so a save cannot tell that another process wrote
// between its read and its write. When that changes, this test should be turned around.
test('known limit: a save from another session that lands between this one reading and writing the store is lost', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { ...SEAT, context: { tokens: 30_000, window: 200_000, percent: 15 } }
  await turn($, clock)
  w.isHoldingWrites = true
  w.reading = { ...SEAT, context: { tokens: 124_000, window: 200_000, percent: 62 } }
  await turn($, clock)
  expect(w.heldWrites.length).toBe(1)
  const theirs = { id: 'tip:recache:other-session', title: 'This message re-cached 90k tokens', body: 'b', receivedAt: 2 }
  w.store.dividend = { tips: [theirs], reactions: {} }
  w.heldWrites.splice(0).forEach(write => write())
  w.isHoldingWrites = false
  await settle(clock)
  expect(tipTitles(w)).toContain('Every message now carries 124k tokens')
  expect(tipTitles(w)).not.toContain('This message re-cached 90k tokens')
})

test("a break warning from an earlier break is dropped at session start, and stays dropped in the store", async ($, on) => {
  const key = keyOf('session-one')
  const earlier = NOW - 3 * 3600 * 1000
  const stored = {
    'dividend-turns': { [key]: { model: 'claude-haiku-4-5', at: NOW - 5 * 60 * 1000, plan: 'subscription' } },
    dividend: {
      tips: [{ id: `tip:warm-compact:${key}:${earlier}`, title: 'The prompt cache expires in 10 min', body: 'b', receivedAt: earlier, action: 'compact' }],
      reactions: {}
    }
  }
  const { w } = await start($, on, 'terminal', stored, RESUMED)
  const above = await band($)
  expect(await above.find({ text: 'The prompt cache expires in 10 min' })).toBeUndefined()
  const saved = w.store.dividend as { tips: { id: string }[]; withdrawn: string[] }
  expect(saved.tips.map(tip => tip.id)).not.toContain(`tip:warm-compact:${key}:${earlier}`)
  expect(saved.withdrawn).toContain(`tip:warm-compact:${key}:${earlier}`)
})

test('a withdrawn tip is not brought back from the store, by a restart or a merge', async ($, on) => {
  const key = keyOf('session-one')
  const id = `tip:expired:${key}:${NOW - 9000}`
  const stored = { dividend: { tips: [{ id, title: 'Your next message will re-cache 400k tokens', body: 'b', receivedAt: 1 }], reactions: {}, withdrawn: [id] } }
  const { clock, w } = await start($, on, 'terminal', stored)
  const above = await band($)
  expect(await above.find({ text: /re-cache 400k/ })).toBeUndefined()
  w.reading = { ...w.reading, context: { tokens: 124_000, window: 200_000, percent: 62 } }
  await turn($, clock)
  expect((w.store.dividend as { tips: { id: string }[] }).tips.map(tip => tip.id)).not.toContain(id)
})

test('sending a message takes back every break warning of the session, read ones aside', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = SEAT
  await turn($, clock)
  await clock.advance(61 * 60 * 1000)
  await settle(clock)
  const above = await band($)
  expect(await above.find({ text: 'Your next message will re-cache 120k tokens' })).toBeDefined()
  await $.turn.start({ text: 'back again', turnId: 'back' } as never)
  await settle(clock)
  await above.redraw()
  expect(await above.find({ text: /re-cache 120k|prompt cache expires/ })).toBeUndefined()
  expect((w.store.dividend as { withdrawn: string[] }).withdrawn.some(id => id.startsWith('tip:expired:'))).toBe(true)
})

test('Later hides a tip in this session only: the store keeps it unread, and the next session shows it again', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { ...w.reading, context: { tokens: 124_000, window: 200_000, percent: 62 } }
  await turn($, clock)
  const above = await band($)
  await above.press({ key: 'dividend-later' })
  await settle(clock)
  await turn($, clock)
  await above.redraw()
  expect(await above.find({ text: 'Every message now carries 124k tokens' })).toBeUndefined()
  expect(Object.values((w.store.dividend as { reactions: Record<string, string> }).reactions)).not.toContain('later')

  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
  await settle(clock)
  await turn($, clock)
  await above.redraw()
  expect(await above.find({ text: 'Every message now carries 124k tokens' })).toBeDefined()
})

test('a tip another session took back or restated stays as that session left it when this one saves', async ($, on) => {
  const takenBack = 'tip:context:their-session'
  const restated = 'tip:recache:their-session'
  const stored = {
    dividend: {
      tips: [
        { id: takenBack, title: 'Every message now carries 150k tokens', body: 'b', receivedAt: 1 },
        { id: restated, title: 'This message re-cached 90k tokens', body: 'b', receivedAt: 2 }
      ],
      reactions: {}
    }
  }
  const { clock, w } = await start($, on, 'terminal', stored)
  w.store.dividend = { tips: [{ id: restated, title: 'This message re-cached 95k tokens', body: 'b', receivedAt: 2 }], reactions: {}, withdrawn: [takenBack] }
  w.reading = { ...w.reading, context: { tokens: 124_000, window: 200_000, percent: 62 } }
  await turn($, clock)
  const saved = w.store.dividend as { tips: { id: string; title: string }[]; withdrawn: string[] }
  expect(saved.tips.map(tip => tip.id)).not.toContain(takenBack)
  expect(saved.withdrawn).toContain(takenBack)
  expect(saved.tips.find(tip => tip.id === restated)?.title).toBe('This message re-cached 95k tokens')
  expect(tipTitles(w)).toContain('Every message now carries 124k tokens')
})

test('a /dividend reset in another session holds here: what this session held is neither kept nor written back', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { ...w.reading, context: { tokens: 124_000, window: 200_000, percent: 62 } }
  await turn($, clock)
  const above = await band($)
  await above.press({ key: 'dividend-mute' })
  await settle(clock)
  delete w.store.dividend
  w.reading = { ...w.reading, context: { tokens: 130_000, window: 200_000, percent: 65 } }
  await turn($, clock)
  await above.redraw()
  expect(await above.find({ text: 'Every message now carries 130k tokens' })).toBeDefined()
  expect(Object.values((w.store.dividend as { reactions: Record<string, string> }).reactions)).not.toContain('not-relevant')
})

test('a message queued behind an answer gets no break warning while it runs', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { context: { tokens: 120_000, window: 200_000, percent: 60 }, rateLimits: [], cost: { usd: 1 } }
  await $.turn.start({ text: 'go on', turnId: 'answered' } as never)
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 'answered', usage: WARM } as never)
  await $.turn.start({ text: 'queued', turnId: 'queued' } as never)
  await settle(clock)
  await clock.advance(10 * 60 * 1000)
  await settle(clock)
  expect(tipTitles(w).some(title => title.includes('will re-cache'))).toBe(false)

  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 'queued', usage: WARM } as never)
  await settle(clock)
  await clock.advance(6 * 60 * 1000)
  await settle(clock)
  expect(tipTitles(w)).toContain('Your next message will re-cache 120k tokens')
})

test("another plugin's band goes first; the tip waits, still counted in the status line", async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { ...w.reading, context: { tokens: 124_000, window: 200_000, percent: 62 } }
  await turn($, clock)
  w.otherBand = 'Another plugin · a question for you'
  const above = await band($)
  expect(await above.find({ text: 'Another plugin · a question for you' })).toBeDefined()
  expect(await above.find({ text: 'Every message now carries 124k tokens' })).toBeUndefined()
  expect(w.statuses.at(-1)).toBe('1 new · $0.40 API-eq')
  w.otherBand = null
  await above.redraw()
  expect(await above.find({ text: 'Every message now carries 124k tokens' })).toBeDefined()
})

test('Compact now is not offered while Claude works, and a skipped compaction keeps the tip to try again', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = SEAT
  await turn($, clock)
  await clock.advance(51 * 60 * 1000)
  await settle(clock)
  const working = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, isWorking: true } })
  expect(await working.find({ text: /^The prompt cache expires at / })).toBeDefined()
  expect(await working.find({ key: 'dividend-compact' })).toBeUndefined()
  await working.unmount()

  w.compactResult = { skip: 'a hook said no' }
  const above = await band($)
  await above.press({ key: 'dividend-compact' })
  await settle(clock)
  await above.redraw()
  expect(w.toasts).toContain('The compaction was skipped (a hook said no).')
  expect(await above.find({ key: 'dividend-compact' })).toBeDefined()
})

test('paging through a big file is not reading it again', async ($, on) => {
  const { clock, w } = await start($, on)
  w.toolTexts = ['z'.repeat(24_000), 'z'.repeat(24_000), 'z'.repeat(24_000)]
  const page = (offset: number) => ({ tool: 'Read', file_path: '/work/repo/src/big.ts', offset, limit: 1000 })
  await toolTurn($, clock, [page(1), page(1001), page(2001)])
  expect(tipTitles(w).some(title => title.includes('was read'))).toBe(false)
})

test('a first turn with no answer leaves the plan as it was, so a 1-hour cache is not taken for 5 minutes', async ($, on) => {
  const stored = { 'dividend-turns': { [keyOf('session-one')]: { model: 'claude-haiku-4-5', at: NOW - 2 * 60_000, plan: 'subscription' } } }
  const { clock, w } = await start($, on, 'terminal', stored, RESUMED)
  await $.turn.start({ text: 'go on', turnId: 'no-answer' } as never)
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: true, turnId: 'no-answer' } as never)
  await settle(clock)
  await clock.advance(10 * 60 * 1000)
  await settle(clock)
  expect(tipTitles(w).some(title => title.includes('will re-cache'))).toBe(false)
  await clock.advance(55 * 60 * 1000)
  await settle(clock)
  expect(tipTitles(w)).toContain('Your next message will re-cache 120k tokens')
})

test('/clear updates the status line at once, and keeps the 5-hour figure', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = SEAT
  await turn($, clock)
  expect(w.statuses.at(-1)).toBe('1 new · 5h 20%')
  w.sessionId = 'session-two'
  await $.session.end({ reason: 'clear', sessionId: 'session-one' } as never)
  await settle(clock)
  expect(w.statuses.at(-1)).toBe('5h 20%')
})

test('a fetched URL that does not parse is named as a page: no query string reaches a tip or the store', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { context: { tokens: 60_000, window: 200_000, percent: 30 }, rateLimits: [], cost: { usd: 1 } }
  await turn($, clock)
  w.reading = { context: { tokens: 115_000, window: 200_000, percent: 57 }, rateLimits: [], cost: { usd: 1.5 } }
  w.toolTexts = ['x'.repeat(160_000)]
  await toolTurn($, clock, [{ tool: 'WebFetch', url: 'not a url?token=hunter2' }])
  expect(tipTitles(w)).toContain('That turn added 55k tokens to the conversation')
  const pane = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })
  expect(await pane.find({ text: /^About 40k of it came from fetching a page, and every later message carries it/ })).toBeDefined()
  expect(JSON.stringify(w.store)).not.toContain('hunter2')
})

test('a store that is not the shape dividend saves reads as empty, and the next save writes it afresh', async ($, on) => {
  const stored = { dividend: { tips: 'nope', reactions: [1, 2], withdrawn: 7 }, 'dividend-turns': ['garbage', { model: 1 }] }
  const { clock, w } = await start($, on, 'terminal', stored)
  w.reading = { ...w.reading, context: { tokens: 124_000, window: 200_000, percent: 62 } }
  await turn($, clock)
  expect(tipTitles(w)).toContain('Every message now carries 124k tokens')
  const saved = w.store.dividend as { tips: unknown[]; reactions: Record<string, string>; withdrawn: string[] }
  expect(Array.isArray(saved.tips)).toBe(true)
  expect(saved.withdrawn).toEqual([])
  const above = await band($)
  expect(await above.find({ text: 'Every message now carries 124k tokens' })).toBeDefined()
})

test('pressing an instruction file opens it as text from the home folder: open -t on macOS, xdg-open elsewhere', async ($, on) => {
  const { clock, w } = await start($, on, 'terminal', {}, undefined, { HOME: '/home/dana' })
  w.memoryFiles = [{ path: '/work/repo/AGENTS.md', type: 'Project', tokens: 7_700 }]
  await turn($, clock)
  const pane = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })
  await pane.press({ key: `dividend-open-${keyOf('/work/repo/AGENTS.md')}` })
  await settle(clock)
  expect(w.openedFiles).toEqual([['xdg-open', '/work/repo/AGENTS.md']])
  expect(w.openedIn).toEqual(['/home/dana'])

  w.isMac = true
  await pane.press({ key: `dividend-open-${keyOf('/work/repo/AGENTS.md')}` })
  await settle(clock)
  expect(w.openedFiles.at(-1)).toEqual(['open', '-t', '/work/repo/AGENTS.md'])

  w.isMac = false
  w.openExit = 1
  await pane.press({ key: `dividend-open-${keyOf('/work/repo/AGENTS.md')}` })
  await settle(clock)
  expect(w.openedFiles.at(-1)).toEqual(['xdg-open', '/work/repo/AGENTS.md'])
  expect(w.openedFiles.some(argv => argv[0] === 'open' && argv[1] !== '-t')).toBe(false)
  expect(w.toasts).toContain("Couldn't open AGENTS.md.")
})

test('an instruction file that is a script, or a link to one, is shown and never opened', async ($, on) => {
  const { clock, w } = await start($, on)
  w.memoryFiles = [
    { path: '/work/repo/bin/setup', type: 'Project', tokens: 300 },
    { path: '/work/repo/CLAUDE.md', type: 'Project', tokens: 200 }
  ]
  w.stats['/work/repo/CLAUDE.md'] = { kind: 'file', size: 10, mtimeMs: 0, isLink: true, realPath: '/work/repo/run.command' }
  await turn($, clock)
  const pane = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })
  await pane.press({ key: `dividend-open-${keyOf('/work/repo/bin/setup')}` })
  await pane.press({ key: `dividend-open-${keyOf('/work/repo/CLAUDE.md')}` })
  await settle(clock)
  expect(w.openedFiles).toEqual([])
  expect(w.toasts).toContain('Dividend opens only Markdown and text files. The file is at /work/repo/bin/setup')
  expect(w.toasts).toContain('Dividend opens only Markdown and text files. The file is at /work/repo/CLAUDE.md')
})

test('How it works shows a lesson in the pane when its button is pressed, and puts it away on a second press', async ($, on) => {
  await start($, on)
  const pane = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })
  expect(await pane.find({ text: 'How the prompt cache works' })).toBeUndefined()
  await pane.press({ key: 'dividend-learn-cache' })
  await pane.redraw()
  expect(await pane.find({ text: 'How the prompt cache works' })).toBeDefined()
  await pane.press({ key: 'dividend-learn-limits' })
  await pane.redraw()
  expect(await pane.find({ text: 'How plan limits work' })).toBeDefined()
  expect(await pane.find({ text: 'How the prompt cache works' })).toBeUndefined()
  await pane.press({ key: 'dividend-learn-limits' })
  await pane.redraw()
  expect(await pane.find({ text: 'How plan limits work' })).toBeUndefined()
})

test('Ask Claude puts the request in the prompt box, after any draft, and only tips Claude can act on offer it', async ($, on) => {
  const { clock, w } = await start($, on)
  w.memoryFiles = [
    { path: '/work/repo/AGENTS.md', type: 'Project', tokens: 8_900 },
    { path: '/home/dana/.claude/projects/-work-repo/memory/MEMORY.md', type: 'AutoMem', tokens: 7_500 }
  ]
  await turn($, clock)
  const above = await band($)
  expect(await above.find({ text: 'Instruction files add about 16k tokens to every message' })).toBeDefined()
  w.isFillable = false
  await above.press({ key: 'dividend-ask' })
  await settle(clock)
  await above.redraw()
  expect(w.toasts).toContain("Couldn't put the request in the prompt box.")
  expect(await above.find({ key: 'dividend-ask' })).toBeDefined()

  w.isFillable = true
  w.draft = 'also, '
  await above.press({ key: 'dividend-ask' })
  await settle(clock)
  await above.redraw()
  expect(w.fills.at(-1)?.mode).toBe('append')
  expect(w.fills.at(-1)?.text).toMatch(/^\n\nDividend tip: Instruction files add about 16k tokens to every message\.\n\nLook at the instruction files you have loaded/)
  expect(await above.find({ text: 'Instruction files add about 16k tokens to every message' })).toBeUndefined()

  w.reading = { ...w.reading, context: { tokens: 124_000, window: 200_000, percent: 62 } }
  await turn($, clock)
  await above.redraw()
  expect(await above.find({ text: 'Every message now carries 124k tokens' })).toBeDefined()
  expect(await above.find({ key: 'dividend-ask' })).toBeUndefined()
})

test('a compaction takes back the reports and offers it answers: the heavy turn, the breakpoint, the context', async ($, on) => {
  const { clock, w } = await start($, on, 'terminal', lastAnswer('claude-haiku-4-5', 9), RESUMED)
  w.reading = { ...RESUMED, context: { tokens: 126_000, window: 200_000, percent: 63 } }
  await toolTurn($, clock, [{ tool: 'Bash', command: 'git commit -m "Add export"' }], cold())
  expect(tipTitles(w)).toEqual(expect.arrayContaining(['This message re-cached 125k tokens', 'A good moment to compact', 'Every message now carries 126k tokens']))
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  await settle(clock)
  expect(tipTitles(w).filter(title => /re-cached|carries|good moment/.test(title))).toEqual([])
})

test('news of a heavy turn leaves the band when the next message goes, and stays in the pane unread', async ($, on) => {
  const { clock, w } = await start($, on, 'terminal', lastAnswer('claude-haiku-4-5', 9), RESUMED)
  w.reading = { ...RESUMED, context: { tokens: 126_000, window: 200_000, percent: 63 } }
  await turn($, clock, 1, cold())
  const above = await band($)
  expect(await above.find({ text: 'This message re-cached 125k tokens' })).toBeDefined()
  await clock.advance(60_000)
  await $.turn.start({ text: 'carry on', turnId: 'next' } as never)
  await settle(clock)
  await above.redraw()
  expect(await above.find({ text: 'This message re-cached 125k tokens' })).toBeUndefined()
  const pane = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })
  expect(await pane.find({ text: 'This message re-cached 125k tokens' })).toBeDefined()
})

test('with tips turned off, tips saved earlier stay out of the band and the status line', { options: { tips: false } }, async ($, on) => {
  const saved = { dividend: { tips: [{ id: `tip:memory:${keyOf('/work/repo')}`, title: 'Instruction files add about 14k tokens to every message', body: 'b', receivedAt: 1 }], reactions: {} } }
  const { w } = await start($, on, 'terminal', saved)
  const above = await band($)
  expect(await above.find({ text: /Instruction files add/ })).toBeUndefined()
  expect(w.statuses.some(status => status?.includes('new'))).toBe(false)
})

test('an area turned off hides its tips saved earlier too', { options: { limits: false } }, async ($, on) => {
  const later = new Date(NOW + 3600 * 1000).toISOString()
  const saved = { dividend: { tips: [{ id: `tip:rate-limit:five_hour:${later}`, title: '85% of your 5-hour limit is used', body: 'b', receivedAt: 1 }], reactions: {} } }
  await start($, on, 'terminal', saved)
  const above = await band($)
  expect(await above.find({ text: /5-hour limit/ })).toBeUndefined()
})

test('a tip read and then dropped for newer ones stays read when it is raised again', async ($, on) => {
  const memoryId = `tip:memory:${keyOf('/work/repo')}`
  const others = Array.from({ length: 60 }, (_, n) => ({ id: `tip:recache:other-${n}`, title: `Other ${n}`, body: 'b', receivedAt: 2 + n }))
  const saved = { dividend: { tips: [{ id: memoryId, title: 'Instruction files add about 16k tokens to every message', body: 'b', receivedAt: 1 }, ...others], reactions: { [memoryId]: 'seen' } } }
  const { clock, w } = await start($, on, 'terminal', saved)
  w.memoryFiles = [
    { path: '/work/repo/AGENTS.md', type: 'Project', tokens: 8_900 },
    { path: '/home/dana/.claude/projects/-work-repo/memory/MEMORY.md', type: 'AutoMem', tokens: 7_500 }
  ]
  w.reading = { ...w.reading, context: { tokens: 124_000, window: 200_000, percent: 62 } }
  await turn($, clock)
  expect((w.store.dividend as { tips: { id: string }[] }).tips.map(tip => tip.id)).not.toContain(memoryId)
  await turn($, clock)
  const above = await band($)
  expect(await above.find({ text: /Instruction files add/ })).toBeUndefined()
  expect((w.store.dividend as { reactions: Record<string, string> }).reactions[memoryId]).toBe('seen')
})

test('a limit tip about a window that has reset is taken back, and the status line drops its figure', async ($, on) => {
  const past = new Date(NOW - 3600 * 1000).toISOString()
  const saved = { dividend: { tips: [{ id: `tip:rate-limit:five_hour:${past}`, title: '85% of your 5-hour limit is used', body: 'b', receivedAt: 1 }], reactions: {} } }
  const { clock, w } = await start($, on, 'terminal', saved)
  const above = await band($)
  expect(await above.find({ text: /5-hour limit/ })).toBeUndefined()
  expect((w.store.dividend as { withdrawn: string[] }).withdrawn).toContain(`tip:rate-limit:five_hour:${past}`)

  w.reading = SEAT
  await turn($, clock)
  expect(w.statuses.at(-1)).toBe('1 new · 5h 20%')
  await clock.advance(5 * 3600 * 1000)
  await $.turn.start({ text: 'back after the reset', turnId: 'after-reset' } as never)
  await settle(clock)
  expect(w.statuses.at(-1)).not.toContain('5h 20%')
})

test('a /resume inside the session starts the counts over for the resumed conversation', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { ...w.reading, context: { tokens: 124_000, window: 200_000, percent: 62 } }
  await turn($, clock)
  const above = await band($)
  expect(await above.find({ text: 'Every message now carries 124k tokens' })).toBeDefined()
  w.sessionId = 'session-two'
  await $.session.end({ reason: 'resume', sessionId: 'session-one' } as never)
  await settle(clock)
  await above.redraw()
  expect(await above.find({ text: 'Every message now carries 124k tokens' })).toBeUndefined()
})

test('a session id that changed without notice is caught at the next message', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { ...w.reading, context: { tokens: 124_000, window: 200_000, percent: 62 } }
  await turn($, clock)
  const above = await band($)
  expect(await above.find({ text: /124k tokens/ })).toBeDefined()
  w.sessionId = 'session-three'
  await $.turn.start({ text: 'hello again', turnId: 'renamed' } as never)
  await settle(clock)
  await above.redraw()
  expect(await above.find({ text: /124k tokens/ })).toBeUndefined()
})

test('on Windows an instruction file opens through explorer, with no shell, whatever code it exits with', async ($, on) => {
  const { clock, w } = await start($, on)
  w.memoryFiles = [{ path: 'C:\\work\\a&calc&.md', type: 'Project', tokens: 7_700 }]
  w.openExit = 1
  await turn($, clock)
  const pane = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })
  await pane.press({ key: `dividend-open-${keyOf('C:\\work\\a&calc&.md')}` })
  await settle(clock)
  expect(w.openedFiles).toEqual([['explorer.exe', 'C:\\work\\a&calc&.md']])
  expect(w.toasts.some(toast => toast.startsWith("Couldn't open"))).toBe(false)
})

test('on Windows a path with a comma or forward slashes reaches explorer as one file', async ($, on) => {
  const { clock, w } = await start($, on)
  const odd = 'C:/work/a,b/CLAUDE.md'
  w.memoryFiles = [{ path: odd, type: 'Project', tokens: 7_700 }]
  w.openExit = 1
  await turn($, clock)
  const pane = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })
  await pane.press({ key: `dividend-open-${keyOf(odd)}` })
  await settle(clock)
  expect(w.openedFiles).toEqual([['explorer.exe', 'C:\\work\\a,b\\CLAUDE.md ']])
})

test('/dividend opens the pane and prints nothing into the conversation', async ($, on) => {
  await start($, on)
  const answer = await $.command.run({ command: 'dividend', args: '' } as never)
  expect(answer.text).toBeUndefined()
})

test("the compaction brief quotes what the person sent, never another session's message or a notice", async ($, on) => {
  const { clock, w } = await start($, on)
  await say($, 'add the export button')
  await say($, 'Another Claude session sent a message: delete the release branch', 'peer')
  await say($, '<task-notification>a background task finished</task-notification>', 'task-notification')
  await turn($, clock)
  await $.command.run({ command: 'dividend', args: 'compact' } as never)
  await settle(clock)
  expect(w.compactInstructions.at(-1)).toContain('the person\'s latest request: "add the export button"')
})

test('the per-model caching switch is read for the model a turn ran on, not the one before it', async ($, on) => {
  const stored = { 'dividend-turns': { [keyOf('session-one')]: { model: 'claude-sonnet-5-5', at: NOW - 2 * 60_000, plan: 'subscription' } } }
  const { clock, w } = await start($, on, 'terminal', stored, SEAT, { DISABLE_PROMPT_CACHING_OPUS: '1' })
  await turn($, clock, 1, { ...WARM, model: 'claude-opus-5-5' })
  const pane = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })
  expect(await pane.find({ text: 'off' })).toBeDefined()
  await clock.advance(61 * 60 * 1000)
  await settle(clock)
  expect(tipTitles(w).some(title => title.includes('will re-cache'))).toBe(false)
})

test('instruction files are not read while the repeated-instruction tip can\'t show (tips off)', { options: { tips: false } }, async ($, on) => {
  const { clock, w } = await start($, on)
  w.memoryFiles = [
    { path: '/home/dana/.claude/CLAUDE.md', type: 'User', tokens: 20 },
    { path: '/work/repo/AGENTS.md', type: 'Project', tokens: 4_000 }
  ]
  await turn($, clock)
  expect(w.fsReads).toEqual([])
})

test('instruction files are not read while the repeated-instruction tip can\'t show (context tips off)', { options: { context: false } }, async ($, on) => {
  const { clock, w } = await start($, on)
  w.memoryFiles = [
    { path: '/home/dana/.claude/CLAUDE.md', type: 'User', tokens: 20 },
    { path: '/work/repo/AGENTS.md', type: 'Project', tokens: 4_000 }
  ]
  await turn($, clock)
  expect(w.fsReads).toEqual([])
})

test('/dividend reset deletes everything Dividend saved, the last-turn records too', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { ...w.reading, context: { tokens: 124_000, window: 200_000, percent: 62 } }
  await turn($, clock)
  expect(w.store['dividend-turns']).toBeDefined()
  await $.command.run({ command: 'dividend', args: 'reset' } as never)
  expect(w.store.dividend).toBeUndefined()
  expect(w.store['dividend-turns']).toBeUndefined()
})

test('where a plugin cannot compact directly, Compact now puts /compact with the brief in the prompt box', async ($, on) => {
  const { clock, w } = await start($, on, 'desktop')
  await $.session.start({ cwd: '/work/repo', surface: 'desktop', isInteractive: false })
  await settle(clock)
  w.reading = { context: { tokens: 80_000, window: 200_000, percent: 40 }, rateLimits: [], cost: { usd: 1 } }
  w.compactError = '$.session.compact: not available in a headless (-p / SDK) session yet'
  await toolTurn($, clock, [{ tool: 'Bash', command: 'git commit -m "Add export"' }])
  const above = await band($, 'desktop')
  await above.press({ key: 'dividend-compact' })
  await settle(clock)
  expect(w.fills.at(-1)?.text.startsWith('/compact Keep a brief to carry on from:')).toBe(true)
  expect(w.toasts.at(-1)).toBe('/compact is in the prompt box, with the brief: press Enter to compact.')
  await above.redraw()
  expect(await above.find({ text: 'A good moment to compact' })).toBeDefined()

  w.draft = 'half-written thought'
  const fills = w.fills.length
  await above.press({ key: 'dividend-compact' })
  await settle(clock)
  expect(w.fills.length).toBe(fills)
  expect(w.toasts.at(-1)).toBe('This session compacts through /compact: clear the prompt box, then press Compact now again.')
})

test('text from a repository that would blank the band is drawn plain: no control, bidi or invisible characters', async ($, on) => {
  const { clock, w } = await start($, on)
  const odd = '/work/repo/.claude/rules/no\u0007tes\u202Etxt\u00AD\u2028\u{E0041}\u{E007F}.md'
  w.memoryFiles = [{ path: odd, type: 'Project', tokens: 12_000 }]
  await turn($, clock)
  const above = await band($)
  expect(await above.find({ text: 'Instruction files add about 12k tokens to every message' })).toBeDefined()
  expect(tipTitles(w).join(' ') + JSON.stringify(w.store.dividend)).not.toMatch(/[\u0007\u202E\u00AD\u2028\u{E0000}-\u{E007F}]/u)
  const pane = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })
  const button = await pane.find({ key: `dividend-open-${keyOf(odd)}` })
  expect(button).toBeDefined()
  expect(JSON.stringify(button)).not.toMatch(/[\u0007\u202E\u00AD\u2028\u{E0000}-\u{E007F}]/u)
})

// One saved tip of every kind, for this session or project (the limit tips are the account's), and
// one of each for another session or project.
const SESSION_KEY = keyOf('session-one')
const PROJECT_KEY = keyOf('/work/repo')
const RESET = new Date(NOW + 2 * 3600 * 1000).toISOString()
const KIND_IDS: Record<string, string> = {
  recache: `tip:recache:${SESSION_KEY}`,
  switch: `tip:switch:${SESSION_KEY}`,
  expired: `tip:expired:${SESSION_KEY}:${NOW - 3_600_000}`,
  'warm-compact': `tip:warm-compact:${SESSION_KEY}:${NOW - 3_600_000}`,
  ttl: `tip:ttl:${SESSION_KEY}`,
  context: `tip:context:${SESSION_KEY}`,
  'context-high': `tip:context-high:${SESSION_KEY}`,
  growth: `tip:growth:${SESSION_KEY}:bash`,
  breakpoint: `tip:breakpoint:${SESSION_KEY}`,
  reread: `tip:reread:${SESSION_KEY}`,
  mcp: `tip:mcp:${SESSION_KEY}`,
  memory: `tip:memory:${PROJECT_KEY}`,
  dupes: `tip:dupes:${PROJECT_KEY}`,
  'rate-limit': `tip:rate-limit:five_hour:${RESET}`,
  wall: `tip:wall:seven_day:${RESET}`,
  'model-fit': `tip:model-fit:${SESSION_KEY}`,
  budget: `tip:budget:${SESSION_KEY}:5`,
}
const KINDS = Object.keys(KIND_IDS)
const saved = (tips: { id: string; title: string; action?: 'compact' }[]) => ({
  dividend: { tips: tips.map((tip, index) => ({ ...tip, body: 'Its text.', receivedAt: NOW - 100_000 + index })), reactions: {} },
})
const elsewhere = (id: string) => id.replace(SESSION_KEY, 'other').replace(PROJECT_KEY, 'other')
const everyKind = () =>
  saved(Object.entries(KIND_IDS).flatMap(([kind, id]) => [...(elsewhere(id) === id ? [] : [{ id: elsewhere(id), title: `${kind} elsewhere` }]), { id, title: `${kind} tip` }]))

const pane = ($: Engine) => $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'Pane', requestId: 'dividend', props: PANE })

const kindsIn = async (view: { find: (query: { text: string }) => Promise<unknown> }, suffix = 'tip'): Promise<string[]> => {
  const shown: string[] = []
  for (const kind of KINDS) if (await view.find({ text: `${kind} ${suffix}` })) shown.push(kind)
  return shown
}

// What the band offers, newest first: Got it puts each tip away and shows the next.
const bandQueue = async ($: Engine): Promise<string[]> => {
  const above = await band($)
  const queue: string[] = []
  for (let shown = await kindsIn(above); shown.length > 0; shown = await kindsIn(above)) {
    queue.push(...shown)
    await above.press({ key: 'dividend-seen' })
    await above.redraw()
  }
  return queue
}

const newestFirst = (except: string[]) => [...KINDS].reverse().filter(kind => !except.includes(kind))

test('each kind of tip shows in its own session, project or account, and three offer Ask Claude', async ($, on) => {
  await start($, on, 'terminal', everyKind())
  const view = await pane($)
  expect(await kindsIn(view)).toEqual(KINDS)
  expect(await kindsIn(view, 'elsewhere')).toEqual([])
  const asking = []
  for (const kind of KINDS) if (await view.find({ key: `dividend-ask-${KIND_IDS[kind]}` })) asking.push(kind)
  expect(asking).toEqual(['ttl', 'memory', 'dupes'])
})

const AREAS: Record<string, string[]> = {
  cache: ['recache', 'switch', 'expired', 'warm-compact', 'ttl'],
  context: ['context', 'context-high', 'growth', 'breakpoint', 'reread', 'mcp', 'memory', 'dupes'],
  limits: ['rate-limit', 'wall', 'model-fit', 'budget'],
}
for (const [area, kinds] of Object.entries(AREAS)) {
  test(`turning off ${area} tips hides exactly those kinds`, { options: { [area]: false } }, async ($, on) => {
    await start($, on, 'terminal', everyKind())
    expect(await kindsIn(await pane($))).toEqual(KINDS.filter(kind => !kinds.includes(kind)))
  })
}

test('every kind but unused MCP servers may interrupt, newest first', async ($, on) => {
  const { w } = await start($, on, 'terminal', everyKind())
  expect(w.statuses.at(-1)).toBe('16 new')
  expect(await bandQueue($)).toEqual(newestFirst(['mcp']))
})

test('once a message goes, break warnings are taken back and news of a turn leaves the band', async ($, on) => {
  const { clock } = await start($, on, 'terminal', everyKind())
  await turn($, clock)
  expect(await kindsIn(await pane($))).toEqual(KINDS.filter(kind => kind !== 'expired' && kind !== 'warm-compact'))
  expect(await bandQueue($)).toEqual(newestFirst(['mcp', 'expired', 'warm-compact', 'recache', 'switch', 'growth']))
})

test('a compaction takes back the tips it answers', async ($, on) => {
  const { clock } = await start($, on, 'terminal', everyKind())
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  await settle(clock)
  expect(await kindsIn(await pane($))).toEqual(['ttl', 'mcp', 'memory', 'dupes', 'rate-limit', 'wall', 'model-fit', 'budget'])
})

test('a /clear starts over what the conversation counted', async ($, on) => {
  const { clock, w } = await start($, on)
  const opus: Usage = { ...WARM, model: 'claude-opus-5-5' }
  const read = { tool: 'Read', file_path: '/work/repo/src/app.ts' }
  w.mcpTools = [{ name: 'mcp__docs__search', serverName: 'docs', tokens: 3_000, isLoaded: true }]
  w.memoryFiles = [
    { path: '/home/dana/.claude/CLAUDE.md', type: 'User', tokens: 20 },
    { path: '/work/repo/AGENTS.md', type: 'Project', tokens: 40 },
  ]
  w.toolTexts = Array.from({ length: 8 }, () => 'z'.repeat(24_000))
  await say($, 'add the export button')
  await toolTurn($, clock, [{ tool: 'mcp__docs__search' }], opus)
  await turn($, clock, 1, opus)
  await toolTurn($, clock, [read, read], opus)
  await toolTurn($, clock, [{ tool: 'Edit', file_path: '/work/repo/src/export.ts' }], opus)

  w.sessionId = 'session-two'
  await $.session.end({ reason: 'clear', sessionId: 'session-one' } as never)
  await settle(clock)
  // Without the counts starting over, this would be the third read of the file, the third light
  // turn in a row and the fifth turn, which names the MCP server.
  await toolTurn($, clock, [read], opus)
  expect(tipTitles(w).filter(title => /was read|lighter model|Unused MCP/.test(title))).toEqual([])
  expect(w.fsReads.length).toBe(4)
  await turn($, clock, 4, opus)
  expect(tipTitles(w)).toContain('Unused MCP servers add about 3.0k tokens to every message')
  await $.command.run({ command: 'dividend', args: 'compact' } as never)
  await settle(clock)
  expect(w.compactInstructions.at(-1)).not.toMatch(/export/)
})

// A view's buttons, in order, as label [hotkey], with * on the one that leads.
const buttonsIn = async (view: { find: (query: { key: string }) => Promise<unknown> }, keys: string[]): Promise<string[]> => {
  const shown: string[] = []
  for (const key of keys) {
    const props = ((await view.find({ key })) as { props?: { label?: string; hotkey?: string; variant?: string } } | undefined)?.props
    if (props) shown.push([props.label, props.hotkey && `[${props.hotkey}]`, props.variant === 'primary' && '*'].filter(Boolean).join(' '))
  }
  return shown
}

const BUTTONS = ['compact', 'ask', 'seen', 'mute', 'later', 'open']
const ONE_TIP = {
  plain: { id: KIND_IDS['rate-limit']!, title: 'A tip' },
  compact: { id: KIND_IDS.breakpoint!, title: 'A tip', action: 'compact' as const },
  ask: { id: KIND_IDS.memory!, title: 'A tip' },
}
const REST = ["Don't show these [n]", 'Later [l]', 'All tips [o]']

for (const [name, tip, isWorking, buttons] of [
  ['nothing to do', ONE_TIP.plain, false, ['Got it [y] *', ...REST]],
  ['a compaction to offer', ONE_TIP.compact, false, ['Compact now [c] *', 'Got it [y]', ...REST]],
  ['a compaction to offer, while Claude works', ONE_TIP.compact, true, ['Got it [y] *', ...REST]],
  ['something Claude can do', ONE_TIP.ask, false, ['Ask Claude [a] *', 'Got it [y]', ...REST]],
] as const) {
  test(`the band's buttons for a tip with ${name}`, async ($, on) => {
    await start($, on, 'terminal', saved([tip]))
    const above = await $.ui.mount({ plugin: 'dividend', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, isWorking } })
    expect(await buttonsIn(above, BUTTONS.map(button => `dividend-${button}`))).toEqual(buttons)
  })
}

test("with the action buttons off, the band offers neither Compact now nor Ask Claude", { options: { actions: false } }, async ($, on) => {
  await start($, on, 'terminal', saved([ONE_TIP.compact]))
  expect(await buttonsIn(await band($), BUTTONS.map(button => `dividend-${button}`))).toEqual(['Got it [y] *', ...REST])
})

test("the pane's buttons name their tip and have no hotkeys", async ($, on) => {
  await start($, on, 'terminal', saved(Object.values(ONE_TIP)))
  const view = await pane($)
  const buttonsOf = (id: string) => buttonsIn(view, BUTTONS.map(button => `dividend-${button}-${id}`))
  expect(await buttonsOf(ONE_TIP.plain.id)).toEqual(['Got it', "Don't show these"])
  expect(await buttonsOf(ONE_TIP.compact.id)).toEqual(['Compact now', 'Got it', "Don't show these"])
  expect(await buttonsOf(ONE_TIP.ask.id)).toEqual(['Ask Claude', 'Got it', "Don't show these"])
})

test("a turn's tool calls count for that turn alone", async ($, on) => {
  const { clock, w } = await start($, on)
  const opus: Usage = { ...WARM, model: 'claude-opus-5-5' }
  await toolTurn($, clock, [{ tool: 'Bash', command: 'make' }], opus)
  for (let i = 0; i < 3; i++) await toolTurn($, clock, [{ tool: 'Read', file_path: '/work/repo/a.ts' }, { tool: 'Edit', file_path: '/work/repo/a.ts' }], opus)
  expect(tipTitles(w)).toContain('This work runs well on a lighter model')
})

test('a compaction forgets the files read so far', async ($, on) => {
  const { clock, w } = await start($, on)
  w.toolTexts = Array.from({ length: 3 }, () => 'z'.repeat(24_000))
  const read = { tool: 'Read', file_path: '/work/repo/src/app.ts' }
  await toolTurn($, clock, [read, read])
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  await settle(clock)
  await toolTurn($, clock, [read])
  expect(tipTitles(w).some(title => title.includes('was read'))).toBe(false)
})

test('a /clear starts over the count of breaks that outlasted the cache', async ($, on) => {
  const { clock, w } = await start($, on)
  w.reading = { context: { tokens: 120_000, window: 200_000, percent: 60 }, rateLimits: [], cost: { usd: 1.0 } }
  const coldBreak = async () => {
    await clock.advance(10 * 60 * 1000)
    await settle(clock)
    await turn($, clock, 1, cold())
  }
  await turn($, clock)
  await coldBreak()
  await coldBreak()
  w.sessionId = 'session-two'
  await $.session.end({ reason: 'clear', sessionId: 'session-one' } as never)
  await settle(clock)
  await turn($, clock)
  await coldBreak()
  expect(tipTitles(w)).not.toContain('Your breaks keep outlasting the 5-minute cache')
})
