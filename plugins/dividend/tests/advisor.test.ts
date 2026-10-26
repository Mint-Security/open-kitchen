import { expect, test } from 'claude-code/testing'

import { duration, keyOf, tokens } from '../hooks/display/format'
import { instructionScopes, sessionRows, usageLine } from '../hooks/display/status'
import { heaviestModelName, modelFitTip, startModelTip, usageTips } from '../hooks/tips/advisor'
import type { UsageContext } from '../hooks/tips/advisor'
import { tipKindOf } from '../hooks/tips/kinds'
import type { DividendUsage } from '../types'

const NOW = Date.parse('2026-10-07T10:00:00Z')

const usage = (patch: Partial<DividendUsage> = {}): DividendUsage => ({
  contextTokens: 30_000,
  contextWindow: 200_000,
  contextPercent: 15,
  costUsd: 1.2,
  rateLimits: [],
  unusedMcp: [],
  memoryTokens: null,
  memoryFiles: [],
  hasAnswered: true,
  isJustCompacted: false,
  cacheTtl: null,
  lastAnswerAt: null,
  at: NOW,
  ...patch,
})

const ctx = (patch: Partial<UsageContext> = {}): UsageContext => ({
  sessionKey: 's1',
  projectKey: 'p1',
  mainTurns: 1,
  now: NOW,
  budgetUsd: 0,
  model: null,
  ...patch,
})

const kinds = (u: DividendUsage, c: UsageContext = ctx()) => usageTips(u, c).map(tip => tip.kind)

test('numbers read the way people say them', () => {
  expect([tokens(950), tokens(1_234), tokens(48_600), tokens(1_250_000)]).toEqual(['950', '1.2k', '49k', '1.3M'])
  expect([duration(40), duration(600), duration(3 * 3600), duration(3 * 86400)]).toEqual(['40 s', '10 min', '3 h', '3 days'])
  expect(keyOf('/Users/dana/repo')).toBe(keyOf('/Users/dana/repo'))
  expect(keyOf('/Users/dana/repo')).not.toBe(keyOf('/Users/dana/other'))
  expect(keyOf('/Users/dana/repo')).not.toContain('dana')
})

test('a long context gets one tip, a nearly full one a stronger one', () => {
  expect(kinds(usage({ contextPercent: 59, contextTokens: 118_000 }))).toEqual([])
  const long = usageTips(usage({ contextPercent: 62, contextTokens: 124_000 }), ctx())
  expect(long.map(tip => [tip.id, tip.title])).toEqual([['tip:context:s1', 'Every message now carries 124k tokens']])
  expect(kinds(usage({ contextPercent: 88, contextTokens: 176_000 }))).toEqual(['context-high'])
  expect(kinds(usage({ contextPercent: null, contextTokens: null }))).toEqual([])
})

test('unused MCP servers are named once there have been a few turns and they cost enough', () => {
  const unusedMcp = [
    { server: 'linear', tokens: 6_100 },
    { server: 'notion', tokens: 3_300 }
  ]
  expect(kinds(usage({ unusedMcp }), ctx({ mainTurns: 4 }))).toEqual([])
  const tip = usageTips(usage({ unusedMcp }), ctx({ mainTurns: 5 }))[0]
  expect(tip?.title).toBe('Unused MCP servers add about 9.4k tokens to every message')
  expect(tip?.body.startsWith("linear (6.1k) and notion (3.3k) haven't been used in this session")).toBe(true)
  expect(kinds(usage({ unusedMcp: [{ server: 'tiny', tokens: 900 }] }), ctx({ mainTurns: 9 }))).toEqual([])
  expect(usageTips(usage({ unusedMcp: [{ server: 'big', tokens: 2_400 }, { server: 'small', tokens: 1_900 }] }), ctx({ mainTurns: 9 }))[0]?.body.startsWith("big (2.4k) hasn't been used")).toBe(true)
  const many = Array.from({ length: 5 }, (_, i) => ({ server: `s${i}`, tokens: 2_000 }))
  expect(usageTips(usage({ unusedMcp: many }), ctx({ mainTurns: 9 }))[0]?.body).toContain('and 2 more haven')
})

const file = (name: string, type: string, tokens: number) => ({ name, path: `/work/repo/${name}`, type, tokens })

test('heavy instruction files are broken down by where they load from, each with its remedy, once per project', () => {
  const memoryFiles = [file('AGENTS.md', 'Project', 8_900), file('CLAUDE.md', 'Project', 16), file('memory/MEMORY.md', 'AutoMem', 7_500), file('.claude/CLAUDE.md', 'User', 21)]
  const tip = usageTips(usage({ memoryTokens: 16_437, memoryFiles }), ctx({ projectKey: 'proj' }))[0]
  expect(tip).toMatchObject({ id: 'tip:memory:proj', kind: 'memory', title: 'Instruction files add about 16k tokens to every message' })
  expect(tip?.body).toBe(
    'Project files add about 8.9k (largest: AGENTS.md) and are shared with everyone on the repo: move sections Claude rarely needs into skills, or into .claude/rules files scoped with paths, which load only for matching files. ' +
      "Auto memory, Claude's notes on this project, adds about 7.5k (memory/MEMORY.md): keep it a short index, with the details in the files it points to."
  )
  expect(kinds(usage({ memoryTokens: 9_000 }))).toEqual([])
})

test('only the two heaviest places get advice, and only when they weigh something', () => {
  const body = (memoryFiles: ReturnType<typeof file>[]) =>
    usageTips(usage({ memoryTokens: memoryFiles.reduce((sum, f) => sum + f.tokens, 0), memoryFiles }), ctx())[0]?.body ?? ''
  const three = body([file('CLAUDE.md', 'Project', 5_000), file('memory/MEMORY.md', 'AutoMem', 4_000), file('.claude/CLAUDE.md', 'User', 3_000)])
  expect(three).toContain('Project files add about 5.0k (CLAUDE.md)')
  expect(three).toContain('Auto memory')
  expect(three).not.toContain('user files')
  expect(body([file('.claude/CLAUDE.md', 'User', 11_000), file('CLAUDE.md', 'Project', 1_500)])).toBe(
    'Your user files add about 11k (.claude/CLAUDE.md) in every project: keep only what applies everywhere.'
  )
  expect(body([file('policy/CLAUDE.md', 'Managed', 6_000), file('x/RULES.md', 'Plugin', 5_000)])).toBe(
    "Your organization's managed policy adds about 6.0k (policy/CLAUDE.md); only an admin can change it. " +
      'Plugin files add about 5.0k (x/RULES.md): trim what Claude rarely needs, or move it into a skill, which loads only when it is relevant.'
  )
})

test('a rate limit past 80% says when it resets, once per window; spend limits are left alone', () => {
  const resetsAt = new Date(NOW + 30 * 60 * 1000).toISOString()
  const tips = usageTips(usage({ rateLimits: [{ kind: 'five_hour', percentUsed: 84.5, resetsAt }, { kind: 'seven_day', percentUsed: 40, resetsAt: null }] }), ctx())
  expect(tips.map(tip => [tip.id, tip.title])).toEqual([[`tip:rate-limit:five_hour:${resetsAt}`, '85% of your 5-hour limit is used']])
  expect(tips[0]?.body).toMatch(/^It resets at \d{1,2}:\d{2}.*\. Long conversations/)
  expect(kinds(usage({ rateLimits: [{ kind: 'spend_limit', percentUsed: 95, resetsAt: null }] }))).toEqual([])
})

test('a limit on pace to run out before it resets says when, from half used; earlier use is left alone', () => {
  const inHours = (hours: number) => new Date(NOW + hours * 3600 * 1000).toISOString()
  const fiveHour = usageTips(usage({ rateLimits: [{ kind: 'five_hour', percentUsed: 55, resetsAt: inHours(3) }] }), ctx())[0]
  expect(fiveHour?.title).toMatch(/^At this pace your 5-hour limit runs out around \d{1,2}:\d{2}/)
  expect(fiveHour?.body).toMatch(/^55% is used 2 h into the window, so it runs out 82 min before it resets\. It resets at \d{1,2}:\d{2}/)
  const weekly = usageTips(usage({ rateLimits: [{ kind: 'seven_day', percentUsed: 60, resetsAt: inHours(4 * 24) }] }), ctx())[0]
  expect(weekly?.title).toMatch(/^At this pace your weekly limit runs out around [A-Z][a-z]{2} \d{1,2}:\d{2}/)
  expect(kinds(usage({ rateLimits: [{ kind: 'five_hour', percentUsed: 49, resetsAt: inHours(4) }] }))).toEqual([])
  expect(kinds(usage({ rateLimits: [{ kind: 'five_hour', percentUsed: 60, resetsAt: inHours(0.5) }] }))).toEqual([])
  const usedUp = usageTips(usage({ rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: inHours(1) }] }), ctx())[0]
  expect(usedUp?.title).toBe('Your 5-hour limit is used up')
  expect(usedUp?.body).toMatch(/^It resets at \d{1,2}:\d{2}.*\.$/)
})

test('on a 1M-token window the long-context tip comes at 120k tokens, long before 60%', () => {
  const big = usageTips(usage({ contextPercent: 13, contextTokens: 130_000, contextWindow: 1_000_000 }), ctx())[0]
  expect(big?.title).toBe('Every message now carries 130k tokens')
  expect(big?.body.startsWith("That is 13% of a 1.0M-token window, so Claude Code won't compact it on its own for a long while")).toBe(true)
  expect(kinds(usage({ contextPercent: 11, contextTokens: 110_000, contextWindow: 1_000_000 }))).toEqual([])
})

test('the spend alert is off by default, and on a seat plan says the dollars are not the bill', () => {
  expect(kinds(usage({ costUsd: 40 }))).toEqual([])
  const api = usageTips(usage({ costUsd: 12.3 }), ctx({ budgetUsd: 5 }))[0]
  expect(api).toMatchObject({ id: 'tip:budget:s1:10', title: 'This session passed $10.00 at list price' })
  expect(api?.body).not.toContain('seat plan')
  const seat = usageTips(usage({ costUsd: 12.3, rateLimits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: null }] }), ctx({ budgetUsd: 5 }))[0]
  expect(seat?.body).toContain('On a seat plan that is not your bill')
  expect(kinds(usage({ costUsd: 4.9 }), ctx({ budgetUsd: 5 }))).toEqual([])
})

test('tip ids carry their kind, so a "not for me" can mute the kind', () => {
  expect(tipKindOf('tip:context-high:s1')).toBe('context-high')
  expect(tipKindOf('tip:rate-limit:five_hour:2026-10-07T12:00:00.000Z')).toBe('rate-limit')
  expect(tipKindOf('mock-welcome')).toBeNull()
  expect(tipKindOf('tip:unknown:x')).toBeNull()
  expect(tipKindOf('tip:constructor:x')).toBeNull()
})

test('the status line shows the 5-hour limit, or dollars without one, and leaves the context fill to Claude Code', () => {
  expect(usageLine(usage({ contextPercent: 62, rateLimits: [{ kind: 'five_hour', percentUsed: 41.2, resetsAt: null }] }))).toBe('5h 41%')
  expect(usageLine(usage({ contextPercent: 62, costUsd: 3.12 }))).toBe('$3.12 API-eq')
  expect(usageLine(usage({ contextPercent: null, costUsd: null }))).toBeNull()
  expect(usageLine(usage({ contextPercent: null, contextTokens: null, costUsd: 0, hasAnswered: false }))).toBeNull()
})

const rowOf = (rows: ReturnType<typeof sessionRows>, label: string) => rows.find(row => row.label === label)

test('This session is the prompt cache and the instruction files, the rest being /usage and /context', () => {
  expect(sessionRows(usage({ memoryTokens: 10_400, hasAnswered: false }))).toEqual([{ label: 'Instruction files', value: 'about 10k' }])
  expect(sessionRows(usage())).toEqual([])
})
test('the instruction files are split by where they load from, heaviest first, each file with its path to open', () => {
  const memoryFiles = [file('AGENTS.md', 'Project', 8_900), file('memory/MEMORY.md', 'AutoMem', 7_500), file('.claude/CLAUDE.md', 'User', 21), file('CLAUDE.md', 'Project', 16)]
  const seen = usage({ memoryTokens: 16_437, memoryFiles })
  expect(rowOf(sessionRows(seen), 'Instruction files')).toEqual({ label: 'Instruction files', value: 'about 16k', note: 'project 8.9k, auto memory 7.5k, user 21' })
  expect(instructionScopes(seen).map(scope => [scope.name, scope.files.map(each => each.path)])).toEqual([
    ['project', ['/work/repo/AGENTS.md', '/work/repo/CLAUDE.md']],
    ['auto memory', ['/work/repo/memory/MEMORY.md']],
    ['user', ['/work/repo/.claude/CLAUDE.md']]
  ])
})
test('the summary gives the clock time the prompt cache stays warm until, with what is left of it, or when it expired', () => {
  const answered = NOW - 20 * 60 * 1000
  const warm = rowOf(sessionRows(usage({ cacheTtl: { seconds: 3600, source: 'subscription' }, lastAnswerAt: answered })), 'Prompt cache')
  expect(warm?.value).toMatch(/^warm until \d{1,2}:\d{2}.* ▰▰▰▰▰▰▰▱▱▱$/)
  expect(warm?.note).toBe('lasts 1 hour on a subscription within its limits')
  const cold = rowOf(sessionRows(usage({ cacheTtl: { seconds: 300, source: 'api' }, lastAnswerAt: answered })), 'Prompt cache')
  expect(cold?.value).toMatch(/^expired at \d{1,2}:\d{2}/)
  expect(cold?.note).toBe('lasts 5 minutes on API billing')
  const yesterday = rowOf(sessionRows(usage({ cacheTtl: { seconds: 3600, source: 'subscription' }, lastAnswerAt: NOW - 30 * 3600 * 1000 })), 'Prompt cache')
  expect(yesterday?.value).toMatch(/^expired at [A-Z][a-z]{2} \d{1,2}:\d{2}/)
})

const inHours = (hours: number) => new Date(NOW + hours * 3600 * 1000).toISOString()

test('near the wall the tip says to wrap up cleanly; the earlier limit tip steps aside', () => {
  const tips = usageTips(usage({ rateLimits: [{ kind: 'five_hour', percentUsed: 96, resetsAt: inHours(1) }] }), ctx())
  expect(tips.map(tip => [tip.kind, tip.title])).toEqual([['wall', '96% of your 5-hour limit is used']])
  expect(tips[0]?.body).toMatch(/^It resets at \d{1,2}:\d{2}.*\. Before it runs out mid-task, ask Claude to commit what works/)
})

test('on Opus, a limit tip adds that Sonnet stretches it further', () => {
  const onOpus = usageTips(usage({ rateLimits: [{ kind: 'five_hour', percentUsed: 55, resetsAt: inHours(3) }] }), ctx({ model: 'claude-opus-5-5' }))[0]
  expect(onOpus?.body.endsWith('Sonnet stretches the same limit further for most coding work; switch at the start of a task or right after /compact.')).toBe(true)
  const onSonnet = usageTips(usage({ rateLimits: [{ kind: 'five_hour', percentUsed: 55, resetsAt: inHours(3) }] }), ctx({ model: 'claude-sonnet-5-5' }))[0]
  expect(onSonnet?.body).not.toContain('Sonnet stretches')
})

test('the weekly limit joins the status line past 70%', () => {
  expect(usageLine(usage({ rateLimits: [{ kind: 'five_hour', percentUsed: 41, resetsAt: null }, { kind: 'seven_day', percentUsed: 72, resetsAt: null }] }))).toBe('5h 41% · 7d 72%')
  expect(usageLine(usage({ rateLimits: [{ kind: 'five_hour', percentUsed: 41, resetsAt: null }, { kind: 'seven_day', percentUsed: 69, resetsAt: null }] }))).toBe('5h 41%')
})

test('three turns of only reading and editing on Opus suggest a lighter model', () => {
  expect(modelFitTip({ lightTurns: 3, model: 'claude-opus-5-5', effort: 'max', sessionKey: 's1' })).toMatchObject({ id: 'tip:model-fit:s1', kind: 'model-fit', title: 'This work runs well on a lighter model' })
  expect(modelFitTip({ lightTurns: 3, model: 'claude-opus-5-5', effort: 'max', sessionKey: 's1' })?.body.startsWith('The last 3 turns only read, searched and edited files, on claude-opus-5-5 at max effort.')).toBe(true)
  expect(modelFitTip({ lightTurns: 2, model: 'claude-opus-5-5', effort: null, sessionKey: 's1' })).toBeNull()
  expect(modelFitTip({ lightTurns: 5, model: 'claude-sonnet-5-5', effort: null, sessionKey: 's1' })).toBeNull()
})

test('Mythos and Fable are named as the model menu shows them; a session on them hears of Opus 5.5', () => {
  expect(heaviestModelName('claude-fable-5-1')).toBe('Fable 5.1')
  expect(heaviestModelName('claude-mythos-5-1[1m]')).toBe('Mythos 5.1')
  expect(heaviestModelName('Fable 5.1')).toBe('Fable 5.1')
  expect(heaviestModelName('fable')).toBe('Fable')
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'opus', 'claude-haiku-4-5']) {
    expect(heaviestModelName(model)).toBeNull()
    expect(startModelTip({ model, sessionKey: 's1' })).toBeNull()
  }
  const tip = startModelTip({ model: 'claude-fable-5-1', sessionKey: 's1' })
  expect(tip).toMatchObject({ id: 'tip:model-start:s1', kind: 'model-start', title: 'This session starts on Fable 5.1' })
  expect(tipKindOf(tip?.id ?? '')).toBe('model-start')
})
