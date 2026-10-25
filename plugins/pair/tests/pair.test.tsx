import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const makeWorld = (on: On) => {
  const w = {
    ran: [] as string[][],
    spawns: [] as string[][],
    fetches: 0,
    reads: 0,
    past: [] as SessionMessage[],
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    opened: [] as string[],
    closed: [] as string[]
  }

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.messages', () => {
    w.reads++
    return { value: w.past } as never
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
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
  on('ui.close', (_$, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('tool.call', () => ({ result: { text: 'ok', isError: false } }) as never)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('process.run', (_$, e) => {
    w.ran.push([...e.argv])
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_$: unknown, e: { argv: readonly string[] }) {
    w.spawns.push([...e.argv])
    return { value: { code: 1, signal: null } }
  } as never)
  on('http.fetch', () => {
    w.fetches++
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })

  return w
}

type World = ReturnType<typeof makeWorld>

const SITE = { bodyColumns: 100, scroll: { offset: 0, bodyRows: 40 }, view: {} }
const PANE = { title: 'Pair', isFocused: true, placement: 'dock' as const, ...SITE }

const seconds = async (clock: MockClock, n: number) => {
  for (let i = 0; i < n; i++) {
    await clock.advance(1000)
    for (let j = 0; j < 8; j++) await clock.settle()
  }
}

const composer = { kind: 'composer' }

const run = ($: Engine, args: string) => $.command.run({ command: 'pair', args } as never)
const mountPreview = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'pair', surface, component: 'Pane', requestId: 'pair-preview', props: { ...PANE, title: 'Pair preview' } })
// The key of the first folded row of tool calls a desktop transcript drew.
const toolsKey = async (pane: { drawn: () => Promise<unknown> }) => JSON.stringify(await pane.drawn()).match(/"key":"([a-z-]+-tools-[^"]+)"/)?.[1] ?? ''

const setup = async ($: Engine, on: On, surface: 'terminal' | 'desktop' = 'terminal', tweak?: (w: World) => void) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = makeWorld(on)
  tweak?.(w)
  await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
  return { clock, w }
}

const earlier: SessionMessage[] = [
  { role: 'user', text: 'look at the flaky test', toolUses: [] },
  {
    role: 'assistant',
    text: 'It races the timer.',
    toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'npm test' }, text: '1 failing' }]
  }
]

for (const surface of ['terminal', 'desktop'] as const) {
  test(`preview: the session as a guest would see it, before any pairing, with nothing started (${surface})`, async ($, on) => {
    const { clock, w } = await setup($, on, surface, world => {
      world.past = earlier
    })
    const opened = (await run($, 'preview')).text
    expect(opened).toContain('as a guest would see it')
    expect(opened).not.toContain('flaky')
    expect(w.opened).toEqual(['pair-preview'])

    const pane = await mountPreview($, surface)
    await seconds(clock, 1)
    await pane.redraw()
    expect(await pane.find({ text: /Reading this session/ })).toBeUndefined()
    expect(await pane.find({ text: /^Pair preview|Preview: your pane once someone joins/ })).toBeDefined()
    expect(await pane.find({ text: /Your guest sees the whole session, tool output included/ })).toBeDefined()
    expect(await pane.find({ text: /What you send goes straight to Host's Claude/ })).toBeDefined()
    expect(await pane.find({ text: /look at the flaky test/ })).toBeDefined()
    const toolRow = surface === 'desktop' ? 'Ran a command ›' : /^Bash\(npm test\)$/
    expect(await pane.find({ text: toolRow })).toBeDefined()
    if (surface === 'desktop') {
      expect(await pane.find({ text: '1 failing' })).toBeUndefined()
      await pane.press({ key: await toolsKey(pane) })
      await pane.redraw()
      expect(await pane.find({ text: 'Ran a command ⌄' })).toBeDefined()
    }
    expect(await pane.find({ text: '1 failing' })).toBeDefined()

    expect(await pane.find({ key: 'preview-input' })).toBeUndefined()
    await pane.input({ key: 'preview-guest-input', text: 'hello' })
    expect(w.toasts.at(-1)).toContain('goes straight to your Claude')
    expect([w.ran.length, w.fetches, w.spawns.length, w.statuses.length]).toEqual([0, 0, 0, 0])

    expect((await run($, '')).text).toContain('/pair preview')
  })
}

test('preview: follows the session as a guest gets it, from what happens rather than reading it again', async ($, on) => {
  const { clock, w } = await setup($, on, 'terminal', world => {
    world.past = earlier
  })
  await $.prompt.submit({ text: 'sent with no preview open', wait: false, origin: composer } as never)
  await run($, 'preview')
  const pane = await mountPreview($)
  await seconds(clock, 1)

  await $.prompt.submit({ text: 'now the timer test', wait: false, origin: composer } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 't2', command: 'npm test -- timer' } as never)
  await $.prompt.submit({ text: 'and keep it short', wait: false, turnId: 't9', origin: composer } as never)
  await $.prompt.submit({ text: 'Dana: from a plugin', wait: false, origin: { kind: 'plugin', name: 'pair' } } as never)
  await $.prompt.submit({ text: '/compact', wait: false, origin: composer } as never)
  await pane.redraw()
  const drawn = JSON.stringify(await pane.drawn())
  const order = ['look at the flaky test', 'now the timer test', 'Bash(npm test -- timer)', 'and keep it short'].map(text => drawn.indexOf(text))
  expect(order.every((at, i) => at > (order[i - 1] ?? -1))).toBe(true)
  expect(drawn).not.toContain('from a plugin')
  expect(drawn).not.toContain('/compact')
  expect(drawn).not.toContain('with no preview open')
  expect(w.reads).toBe(1)

  // Opened again, it starts over from the session so far, as a guest let in now would.
  await run($, 'preview')
  await seconds(clock, 1)
  await pane.redraw()
  expect(JSON.stringify(await pane.drawn())).not.toContain('now the timer test')
  expect(w.reads).toBe(2)
})

test('preview: a compacted session starts where it was compacted, and says so', async ($, on) => {
  const { clock } = await setup($, on, 'terminal', world => {
    world.past = [{ role: 'user', text: 'This session is being continued from a previous conversation that ran out of context.', toolUses: [] }, ...earlier]
  })
  await run($, 'preview')
  const pane = await mountPreview($)
  await seconds(clock, 1)
  await pane.redraw()
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn.indexOf("Earlier messages were compacted and aren't shown")).toBeGreaterThan(-1)
  expect(drawn.indexOf("Earlier messages were compacted and aren't shown")).toBeLessThan(drawn.indexOf('look at the flaky test'))
  expect(drawn).not.toContain('continued from a previous conversation')
})

test('preview: a long conversation shows its newest rows, and more on request', async ($, on) => {
  const { clock } = await setup($, on, 'terminal', world => {
    world.past = Array.from({ length: 140 }, (_, i): SessionMessage => ({ role: 'user', text: `prompt ${i + 1}`, toolUses: [] }))
  })
  await run($, 'preview')
  const pane = await mountPreview($)
  await seconds(clock, 1)
  await pane.redraw()
  expect(await pane.find({ text: /prompt 140/ })).toBeDefined()
  expect(await pane.find({ text: /prompt 110$/ })).toBeUndefined()
  expect(await pane.find({ text: '… 110 earlier rows' })).toBeDefined()
  await pane.press({ key: 'preview-guest-more' })
  await pane.redraw()
  expect(await pane.find({ text: /prompt 11$/ })).toBeDefined()
  expect(await pane.find({ text: '… 10 earlier rows' })).toBeDefined()
  expect((await run($, 'preview all')).text).toBe('The preview shows every row.')
  await pane.redraw()
  expect(await pane.find({ text: /prompt 1$/ })).toBeDefined()
  expect(await pane.find({ text: /earlier rows/ })).toBeUndefined()
  expect((await run($, 'preview sideways')).text).toContain('/pair preview more or all')
})

test('preview: a desktop surface opens every folded tool row on /pair preview open', async ($, on) => {
  const { clock } = await setup($, on, 'desktop', world => {
    world.past = earlier
  })
  expect((await run($, 'preview open')).text).toBe('Open the preview first: /pair preview.')
  await run($, 'preview')
  const pane = await mountPreview($, 'desktop')
  await seconds(clock, 1)
  await pane.redraw()
  expect(await pane.find({ text: 'Ran a command ›' })).toBeDefined()
  expect((await run($, 'preview open')).text).toBe('The preview shows each tool call.')
  await pane.redraw()
  expect(await pane.find({ text: /^Bash\(npm test\)$/ })).toBeDefined()
  expect((await run($, 'preview close')).text).toBe('The preview folds tool calls again.')
  await pane.redraw()
  expect(await pane.find({ text: /^Bash\(npm test\)$/ })).toBeUndefined()
})
