import { atom, read, update } from 'claude-code'
import type { EngineInterface, MatchedHook, Register, SessionMeasureInput, SessionUsage, Timer, TurnUsage } from 'claude-code'

import type { DividendRateLimit, DividendReaction, DividendTip } from '../types'
import { keyOf, plain, tokens } from './display/format'
import { lessonText } from './display/lessons'
import type { LessonTopic } from './display/lessons'
import { isOpenable, isWindowsPath, openerArgv } from './display/open-file'
import { cardRows, cardText } from './display/rows'
import { newConversation, sessionRows, usageLine, usageOf } from './display/status'
import { fileNameIn, serverOf } from './display/tool-labels'
import type { ToolCallFacts } from './display/tool-labels'
import { bandView, cardView, paneView } from './display/views'
import { BREAKDOWN_EVERY_TURNS, freshSession, noFigures, restoredFigures } from './state'
import type { Figures, Opening } from './state'
import { limitTips, usageTips } from './tips/advisor'
import type { UsageContext } from './tips/advisor'
import { askFor } from './tips/asks'
import { KEEP_ALIVE_PROMPT, KEEP_ALIVES_IN_A_ROW, LONGEST_TTL, breakTiming, cacheActionTiming, expiredTip, isEnvSet, planOf, resolveTtl } from './tips/cache'
import type { CacheExpiryAction, CacheTtl } from './tips/cache'
import { compactionBrief, duplicateInstructions, dupesTip } from './tips/context'
import { isPastLimitTip } from './tips/kinds'
import type { Area, Tip } from './tips/kinds'
import { bandTips, isAnsweredByCompaction, isBreakTip, isSettled, isStaleBreakTip, isUnread, shownTips, tipsToSave } from './tips/shown'
import type { Here, TipSettings } from './tips/shown'
import { asRecord, lastTurnsIn, merged, mergeReactions, mutedKinds, restoredReactions, restoredSettings, restoredTips, SETTINGS_KEY, STORE_KEY, TURNS_KEY, withLastTurn } from './tips/store'
import type { Changes, LastTurn, Saved, Settings } from './tips/store'
import { fixedCosts, freshTurn, noteOutput, turnReport } from './tips/turns'
import type { ToolOutcome, TurnWork } from './tips/turns'

const PANE = 'dividend'

const tips = atom({ plugin: 'dividend', key: 'tips' } as const, [])
const reactions = atom({ plugin: 'dividend', key: 'reactions' } as const, {})
const usage = atom({ plugin: 'dividend', key: 'usage' } as const, null)

// Where a prompt the person sent comes from: typed here, from the desktop app or a phone. Another
// session's message, a channel's or a notification never counts as their request.
const REQUEST_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

// A -p or SDK session, the desktop app's among them, compacts only through a /compact prompt: the
// command goes in the prompt box with the brief, for the person to send.
const NO_DIRECT_COMPACTION = /not available in a headless/

const toRateLimits = (limits: SessionUsage['rateLimits']): DividendRateLimit[] =>
  limits.map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed, resetsAt: limit.resetsAt ?? null }))

const effortName = (effort: string | number | undefined): string | null => (effort === undefined ? null : String(effort))

const detach = (work: Promise<unknown>): void => {
  work.catch(() => undefined)
}

export const register: Register = (on, options) => {
  configure(options)

  on('session.start', async ($, e, next) => {
    await startHere($, e.cwd, e.isInteractive)

    return next(e)
  })

  // What the person sent, never another session's message, is what the compaction brief calls their request.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    noteRequest(e.origin.kind, result.text)

    return result
  })

  // A /clear or a /resume goes on without a session.start; a message after it checks the id again.
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    endConversation($, e.reason)

    return result
  })

  // `/compact`, the automatic one, or a plugin's; a subagent's own window and a precompute change nothing here.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && e.trigger !== 'precompute' && result.skip === undefined) {
      detach(afterCompaction($))
    }

    return result
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!e.agentId && e.index === 0 && result.usage) {
      openingRequests.set(e.turnId, { usage: result.usage, effort: effortName(e.effort) })
    }

    return result
  })

  on('turn.start', async ($, e, next) => {
    await startTurn($, e.turnId)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    noteToolCall(e as unknown as ToolCallFacts, result as unknown as ToolOutcome)

    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('rateLimits') || e.changed.includes('cost')) {
      detach(onMeasure($, e))
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    completeTurn($, e)

    return result
  })

  on('command.run', { command: 'dividend' }, async ($, e) => runCommand($, e.args.trim()))
  on('ui.render', { component: 'AbovePrompt' }, drawBand)
  on('ui.render', { component: 'CommandOutput', props: { command: 'dividend' } }, drawCard)
  on('ui.render', { component: 'Pane', requestId: PANE }, drawPane)
}

function configure(options: Parameters<Register>[1]) {
  budgetUsd = typeof options.budgetUsd === 'number' && options.budgetUsd > 0 ? options.budgetUsd : 0
  isTipping = options.tips !== false
  isActing = options.actions !== false
  areasOff = new Set((['cache', 'context', 'limits'] as const).filter(area => options[area] === false))
}

// Module state, by how long it lasts. A hot reload starts all of it over; what must outlast one is in
// $.state and $.store.

// Set once, from the plugin's settings.
let budgetUsd = 0
let isTipping = true
let isActing = true
let areasOff = new Set<Area>()

// For as long as the process runs: a /clear or a /resume keeps these.
let projectKey = 'none'
let projectDir = ''
// False in a -p or SDK session (the desktop app's), where a plugin can't compact directly.
let isInteractive = true
// Main turns Claude answered in this process: rate limits come only with an answer.
let answeredTurns = 0
let isCompacting = false
let isSessionOpen = false
let storeWork: Promise<unknown> = Promise.resolve()
let openLesson: LessonTopic | null = null
// The instruction files the last breakdown listed. Kept across a /clear: a new conversation counts
// its breakdown at its first turn, which replaces them.
let memoryPaths: string[] = []
const turnStarts = new Map<string, number>()
// Each main turn's first request: a turn's own usage adds up all its requests, so a cold start
// would hide behind the cache reads of the tool calls after it.
const openingRequests = new Map<string, Opening>()

// What a conversation counts from its start: a session starting, a /clear and a /resume each begin
// afresh.
let session = freshSession('', 'none')

// What the conversation held at its last answer.
let figures: Figures = noFigures()

// What the main turn under way has left behind so far.
let turnWork = freshTurn()

const isTurnRunning = (): boolean => turnStarts.size > 0

// Which session and project this is, for whose tips show here.
const here = (): Here => ({ sessionKey: session.sessionKey, projectKey })

const tipSettings = (): TipSettings => ({ isTipping, areasOff })

const usageContext = (now: number): UsageContext => ({ sessionKey: session.sessionKey, projectKey, mainTurns: session.mainTurns, now, budgetUsd, model: figures.previousModel })

// A file as the person knows it: relative to the project when it is inside it.
const fileName = (path: string): string => fileNameIn(projectDir, path)

// A session starts: the command, the counts from nothing or from where a resumed one was, and what
// other sessions saved.
async function startHere($: EngineInterface, cwd: string, isSessionInteractive: boolean) {
  await $.command.register({
    name: 'dividend',
    description: 'Open the Dividend pane: tips on what this session carries and costs',
    argumentHint: '[session | compact | learn | reset]',
  })
  projectKey = keyOf(cwd)
  isInteractive = isSessionInteractive
  projectDir = cwd
  await startSession($)
  await sync($)
  const now = await $.clock.now()
  await withdrawUnread($, id => isStaleBreakTip(id, session.sessionKey, figures.lastAnswerAt) || isPastLimitTip(id, now))
  await refreshStatus($)
  detach(checkResumed($))
}

// A fresh session starts from nothing; a resumed one from what it held and its last answer. Snoozes end here.
async function startSession($: EngineInterface, { isClear = false }: { isClear?: boolean } = {}) {
  const sessionId = await $.session.id()
  cancelExpiryTimers()
  isSessionOpen = true
  session = freshSession(sessionId)
  turnWork = freshTurn()
  if (!isClear) {
    turnStarts.clear()
    openingRequests.clear()
  }
  await update($, usage, seen => (isClear && seen ? newConversation(seen) : null))
  await update($, reactions, reacted => Object.fromEntries(Object.entries(reacted).filter(([, reaction]) => reaction !== 'later')))
  const restored = await $.session.usage()
  figures = restoredFigures({ contextTokens: restored.context.tokens ?? null, costUsd: restored.cost?.usd ?? null }, await lastTurns($), session.sessionKey, figures.cacheTtl)
  const cacheTtl = await readTtl($, figures.previousModel)
  figures.cacheTtl = cacheTtl
}

function endConversation($: EngineInterface, reason: string) {
  isSessionOpen = false
  cancelExpiryTimers()
  if (reason === 'clear' || reason === 'resume') {
    detach(switchConversation($, { isBetweenMessages: true }))
  }
}

// A /clear or a /resume inside the session: the process goes on under another session id, with no
// session.start, so the counts start over and a resumed conversation picks up what it held.
async function switchConversation($: EngineInterface, { isBetweenMessages }: { isBetweenMessages: boolean }) {
  await startSession($, { isClear: true })
  await sync($)
  const now = await $.clock.now()
  await withdrawUnread($, id => isStaleBreakTip(id, session.sessionKey, figures.lastAnswerAt) || isPastLimitTip(id, now))
  await refreshStatus($)
  $.ui.invalidate('ui.render')
  if (isBetweenMessages) {
    detach(checkResumed($))
  }
}

// A resumed conversation whose cache lapsed while it was closed: said before its first message.
async function checkResumed($: EngineInterface) {
  if (figures.lastAnswerAt === null || figures.lastContextTokens === null) {
    return
  }
  const now = await $.clock.now()
  const ttl = figures.cacheTtl ?? LONGEST_TTL
  const tip = expiredTip({ context: figures.lastContextTokens, idleSeconds: (now - figures.lastAnswerAt) / 1000, ttl, sessionKey: session.sessionKey, answeredAt: figures.lastAnswerAt })
  if (tip) {
    session.warnedFor = figures.lastAnswerAt
    await addTips($, [tip])
    return
  }
  armExpiryTimers($, now)
}

// How long the prompt cache lasts for the model in use, by Claude Code's own order of settings, else by the plan.
async function readTtl($: EngineInterface, model: string | null): Promise<CacheTtl | null> {
  try {
    const settings = await $.settings.read()
    const family = /haiku|sonnet|opus|fable/i.exec(model ?? '')?.[0]?.toLowerCase()
    const byFamily: Record<string, string | undefined> = {
      haiku: await $.env.get('DISABLE_PROMPT_CACHING_HAIKU'),
      sonnet: await $.env.get('DISABLE_PROMPT_CACHING_SONNET'),
      opus: await $.env.get('DISABLE_PROMPT_CACHING_OPUS'),
      fable: await $.env.get('DISABLE_PROMPT_CACHING_FABLE'),
    }
    const disables = [await $.env.get('DISABLE_PROMPT_CACHING'), family ? byFamily[family] : undefined]
    return resolveTtl({
      disable: disables.find(isEnvSet),
      force5m: await $.env.get('FORCE_PROMPT_CACHING_5M'),
      envTtl: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
      settingTtl: settings.promptCacheTtl,
      enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
      enable1hBedrock: await $.env.get('ENABLE_PROMPT_CACHING_1H_BEDROCK'),
      useBedrock: await $.env.get('CLAUDE_CODE_USE_BEDROCK'),
      plan: figures.plan,
    })
  } catch {
    return null
  }
}

function countFixedCosts(counted: SessionUsage) {
  const breakdown = counted.context.breakdown
  if (!breakdown) {
    return
  }
  const costs = fixedCosts(breakdown, projectDir)
  memoryPaths = costs.memoryPaths
  session.mcpServers = costs.mcpServers
  session.memory = costs.memory
}

// What Claude Code reports now. The breakdown of what every request carries is counted every few
// turns, or when asked for.
async function observe($: EngineInterface, { isAnswer = false, model = figures.previousModel, breakdown = false }: { isAnswer?: boolean; model?: string | null; breakdown?: boolean } = {}) {
  await sync($)
  const isCounting = breakdown || session.turnsSinceBreakdown >= BREAKDOWN_EVERY_TURNS
  const counted = isCounting ? await $.session.usage({ breakdown: 'summary' }) : await $.session.usage()
  if (isCounting) {
    session.turnsSinceBreakdown = 0
    countFixedCosts(counted)
    // The files are read only for the repeated-instruction tip: not at all while it can't be shown.
    const isDupesWanted = isTipping && !areasOff.has('context') && !mutedKinds(await read($, reactions)).has('dupes')
    if (!session.isDupesChecked && isDupesWanted && memoryPaths.length > 1) {
      session.isDupesChecked = true
      detach(checkDuplicates($, memoryPaths))
    }
  }
  const now = await $.clock.now()
  const rateLimits = toRateLimits(counted.rateLimits)
  // Only an answer says which plan this is: no limits before one is no sign of API billing.
  if (isAnswer) {
    figures.plan = planOf(rateLimits)
  }
  const cacheTtl = await readTtl($, model)
  figures.cacheTtl = cacheTtl
  const seen = usageOf({ counted, rateLimits, session, figures, hasAnswered: answeredTurns > 0, now })
  await update($, usage, () => seen)
  await withdrawUnread($, id => isPastLimitTip(id, now))
  await addTips($, usageTips(seen, usageContext(now)))
  await refreshStatus($)
}

// Instruction files that repeat each other: read locally, once a session, never sent anywhere.
async function checkDuplicates($: EngineInterface, paths: string[]) {
  const files: { name: string; text: string }[] = []
  for (const path of paths) {
    try {
      files.push({ name: fileName(path), text: await $.fs.read(path) })
    } catch {
      // A file Dividend cannot read is left out of the comparison.
    }
  }
  const tip = dupesTip(duplicateInstructions(files), projectKey)
  if (tip) {
    await addTips($, [tip])
  }
}

function noteRequest(origin: string, text: string | undefined) {
  if (!REQUEST_ORIGINS.has(origin)) {
    return
  }
  session.keepAlivesInARow = 0
  if (text !== undefined && !text.trimStart().startsWith('/')) {
    session.lastRequest = text
  }
}

async function startTurn($: EngineInterface, turnId: string) {
  const sentAt = await $.clock.now()
  turnStarts.set(turnId, sentAt)
  detach(beforeTurn($, sentAt))
}

// A message is on its way: a break warning is moot, and news from before it leaves the band. A warning
// read, or on screen as the message went, has told the person: the turn after it won't repeat it.
async function beforeTurn($: EngineInterface, sentAt: number) {
  cancelExpiryTimers()
  if ((await $.session.id()) !== session.sessionId) {
    await switchConversation($, { isBetweenMessages: false })
  }
  const reacted = await read($, reactions)
  const list = await read($, tips)
  const expiredId = `tip:expired:${session.sessionKey}:${figures.lastAnswerAt}`
  const wasRead = list.some(tip => tip.id === expiredId && !isUnread(tip, reacted))
  const wasOnScreen = bandTips(list, reacted, here(), tipSettings(), figures.lastMessageAt).at(-1)?.id === expiredId
  if (!wasRead && !wasOnScreen) {
    session.warnedFor = null
  }
  figures.lastMessageAt = sentAt
  await withdrawUnread($, id => isBreakTip(id, session.sessionKey))
  await refreshStatus($)
  $.ui.invalidate('ui.render')
}

// A tool call has answered: its MCP server counts as used, and a main-thread result goes to the turn's tips.
function noteToolCall(call: ToolCallFacts, outcome: ToolOutcome) {
  const server = serverOf(call.tool)
  if (server) {
    session.usedServers.add(server)
  }
  if (!call.agentId) {
    const noted = noteOutput({ work: turnWork, filesTouched: session.filesTouched, bigReads: session.bigReads }, call, outcome, { projectDir, sessionKey: session.sessionKey })
    turnWork = noted.work
    session.filesTouched = noted.filesTouched
    session.bigReads = noted.bigReads
  }
}

// A limit moved mid-turn: the status line and the limit tips follow it, without waiting for the turn.
async function onMeasure($: EngineInterface, measured: SessionMeasureInput) {
  const rateLimits = toRateLimits(measured.rateLimits)
  const now = await $.clock.now()
  await update($, usage, seen => seen && { ...seen, rateLimits, costUsd: measured.cost?.usd ?? seen.costUsd, at: now })
  const seen = await read($, usage)
  if (seen) {
    await addTips($, limitTips(seen, usageContext(now)))
  }
  await refreshStatus($)
}

function completeTurn($: EngineInterface, e: { turnId: string; agentId?: string; usage?: TurnUsage }) {
  const startedAt = turnStarts.get(e.turnId) ?? null
  const opening = openingRequests.get(e.turnId)
  turnStarts.delete(e.turnId)
  openingRequests.delete(e.turnId)
  if (!e.agentId) {
    $.ui.invalidate('ui.render')
    session.mainTurns++
    if (e.usage) {
      answeredTurns++
    }
    session.turnsSinceBreakdown++
    session.isJustCompacted = false
    const work = turnWork
    turnWork = freshTurn()
    detach(afterTurn($, e.usage, opening, startedAt, work))
  }
}

async function afterTurn($: EngineInterface, turn: TurnUsage | undefined, opening: Opening | undefined, startedAt: number | null, work: TurnWork) {
  const before = { context: figures.lastContextTokens, cost: figures.lastCostUsd, model: figures.previousModel, effort: figures.previousEffort, answeredAt: figures.lastAnswerAt }
  const now = await $.clock.now()
  figures.lastAnswerAt = now
  await observe($, { isAnswer: turn !== undefined, model: turn?.model ?? figures.previousModel })
  const seen = await read($, usage)
  figures.lastContextTokens = seen?.contextTokens ?? figures.lastContextTokens
  figures.lastCostUsd = seen?.costUsd ?? figures.lastCostUsd
  if (turn) {
    const effort = opening?.effort ?? null
    figures.previousModel = turn.model
    figures.previousEffort = effort ?? figures.previousEffort
    await rememberTurn($, { model: turn.model, at: now, ...(figures.plan ? { plan: figures.plan } : {}), ...(effort ? { effort } : {}) })
    const report = turnReport({ first: opening?.usage ?? turn, effort, before, seen, startedAt, ttl: figures.cacheTtl, counts: session, work, sessionKey: session.sessionKey })
    session.coldBreaks = report.coldBreaks
    session.warmBreaks = report.warmBreaks
    session.lightTurns = report.lightTurns
    if (report.isWarmBreak) {
      await withdrawUnread($, id => id === `tip:ttl:${session.sessionKey}`)
    }
    await addTips($, report.tips)
  }
  session.warnedFor = null
  armExpiryTimers($, now)
}

// The window was just rewritten: its old size no longer holds, a context tip not yet read no longer
// applies, and the next turn's cache write is the compaction's, not an expired cache.
async function afterCompaction($: EngineInterface) {
  session.isJustCompacted = true
  figures.lastContextTokens = null
  session.turnsSinceBreakdown = BREAKDOWN_EVERY_TURNS
  cancelExpiryTimers()
  session.bigReads = new Map()
  await withdrawUnread($, id => isAnsweredByCompaction(id, session.sessionKey))
  await update($, usage, seen => seen && { ...seen, contextTokens: null, contextPercent: null, isJustCompacted: true })
  await refreshStatus($)
}

function cancelExpiryTimers() {
  session.cancelExpiry()
}

// Before the break outlasts the cache: shortly before, an offer to compact while it is cheap; once
// it has lapsed, a word that the next message re-caches everything.
function armExpiryTimers($: EngineInterface, now: number) {
  cancelExpiryTimers()
  const ttl = figures.cacheTtl
  const answeredAt = figures.lastAnswerAt
  const context = figures.lastContextTokens
  // A turn already running (a queued message, a task's notice) is no break: its own end arms them.
  if (!isSessionOpen || isTurnRunning() || isCompacting || ttl === null || answeredAt === null || context === null) {
    return
  }
  let isArmed = true
  const timers: Timer[] = []
  session.cancelExpiry = () => {
    isArmed = false
    for (const timer of timers) {
      timer.cancel()
    }
  }
  const isCurrent = () => isArmed
  const actionTiming = cacheActionTiming(answeredAt, ttl)
  if (actionTiming && now < actionTiming.expiresAt) {
    timers.push($.clock.after(Math.max(0, actionTiming.actAt - now), () => detach(onCacheAction($, answeredAt, isCurrent))))
  }
  if (!isTipping) {
    return
  }
  const timing = breakTiming({ context, ttl, sessionKey: session.sessionKey, answeredAt })
  if (timing === null) {
    return
  }
  const { expiresAt, warm, warmAt } = timing
  if (warm && warmAt > now) {
    timers.push(
      $.clock.after(warmAt - now, () => {
        if (isArmed && !isTurnRunning()) {
          detach(addTips($, [warm]))
        }
      }),
    )
  }
  timers.push($.clock.after(Math.max(0, expiresAt - now) + 1000, () => detach(onExpired($, answeredAt))))
}

// Recheck after the waits: a turn, /clear, compaction or session end can invalidate an already
// firing timer. A sleeping computer is never woken; a late callback skips a cache that went cold.
async function onCacheAction($: EngineInterface, answeredAt: number, isCurrent: () => boolean) {
  const action = await expiryAction($)
  if (action === 'Do nothing' || (action === 'Keep cache warm' && session.keepAlivesInARow >= KEEP_ALIVES_IN_A_ROW)) {
    return
  }
  const sessionId = await $.session.id()
  const draft = await $.prompt.read()
  const ttl = await readTtl($, figures.previousModel)
  const now = await $.clock.now()
  const timing = cacheActionTiming(answeredAt, ttl)
  if (!isCurrent() || !isSessionOpen || sessionId !== session.sessionId || answeredAt !== figures.lastAnswerAt || isTurnRunning() || isCompacting || draft.text.trim() !== '' || !timing || now < timing.actAt || now >= timing.expiresAt) {
    return
  }
  if (action === 'Keep cache warm') {
    session.keepAlivesInARow++
    try {
      const result = await $.prompt.submit({ text: KEEP_ALIVE_PROMPT })
      if (result.drop !== undefined) {
        $.ui.toast('Dividend cache keep-alive was blocked; no retry until the next answer.')
      }
    } catch {
      $.ui.toast('Dividend could not send the cache keep-alive; no retry until the next answer.')
    }
  } else if (action === 'Auto compact' && isInteractive) {
    $.ui.toast((await runCompaction($, '', { automatic: true })).text)
  }
}

async function onExpired($: EngineInterface, answeredAt: number) {
  if (!isSessionOpen || answeredAt !== figures.lastAnswerAt || isTurnRunning() || figures.cacheTtl === null || figures.lastContextTokens === null) {
    return
  }
  const now = await $.clock.now()
  const tip = expiredTip({ context: figures.lastContextTokens, idleSeconds: (now - answeredAt) / 1000, ttl: figures.cacheTtl, sessionKey: session.sessionKey, answeredAt })
  if (!tip) {
    return
  }
  session.warnedFor = answeredAt
  await withdrawUnread($, id => id === `tip:warm-compact:${session.sessionKey}:${answeredAt}`)
  await addTips($, [tip])
}

// One store change at a time in this process. The store has no locking, so another process saving at
// the same moment can still overwrite this one's change.
function serially<T>(work: () => Promise<T>): Promise<T> {
  const run = storeWork.then(work)
  storeWork = run.catch(() => undefined)
  return run
}

async function savedState($: EngineInterface): Promise<Saved> {
  return asRecord(await $.store.get(STORE_KEY)) as Saved
}

// What this session holds is what the store holds, plus its own snoozes, which end with the session.
async function mirror($: EngineInterface, saved: Saved) {
  const snoozed = Object.fromEntries(Object.entries(await read($, reactions)).filter(([, reaction]) => reaction === 'later'))
  await update($, tips, () => restoredTips(saved))
  await update($, reactions, () => mergeReactions(snoozed, restoredReactions(saved.reactions)))
}

// What other sessions did since this one last looked: their tips, a kind turned off, a reset.
function sync($: EngineInterface): Promise<void> {
  return serially(async () => mirror($, await savedState($)))
}

function save($: EngineInterface, changes: Changes): Promise<void> {
  return serially(async () => {
    const persisted = merged(await savedState($), changes)
    await $.store.set(STORE_KEY, persisted)
    await mirror($, persisted)
  })
}

async function lastTurns($: EngineInterface): Promise<Record<string, LastTurn>> {
  return lastTurnsIn(await $.store.get(TURNS_KEY))
}

async function rememberTurn($: EngineInterface, turn: LastTurn) {
  await $.store.set(TURNS_KEY, withLastTurn(await lastTurns($), session.sessionKey, turn))
}

async function expiryAction($: EngineInterface): Promise<CacheExpiryAction> {
  return restoredSettings(await $.store.get(SETTINGS_KEY)).cacheExpiryAction
}

async function chooseExpiryAction($: EngineInterface, action: CacheExpiryAction) {
  const settings: Settings = { cacheExpiryAction: action }
  await serially(() => $.store.set(SETTINGS_KEY, settings))
  $.ui.invalidate('ui.render')
}

async function refreshStatus($: EngineInterface) {
  const reacted = await read($, reactions)
  const unread = bandTips(await read($, tips), reacted, here(), tipSettings(), figures.lastMessageAt).length
  const seen = await read($, usage)
  const parts = [unread > 0 ? `${unread} new` : null, seen ? usageLine(seen, await $.clock.now()) : null].filter((part): part is string => part !== null)
  $.ui.status(parts.length > 0 ? parts.join(' · ') : undefined)
}

async function addTips($: EngineInterface, candidates: Tip[]) {
  if (!isTipping || candidates.length === 0) {
    return
  }
  await sync($)
  const reacted = await read($, reactions)
  const saved = await read($, tips)
  const changed = tipsToSave(candidates, saved, reacted, areasOff, await $.clock.now())
  if (changed.length === 0) {
    return
  }
  await save($, { tips: changed })
  await refreshStatus($)
}

// Takes back tips not read (a snoozed one included) that no longer hold, and saves that, so no other
// session or restart brings them back.
async function withdrawUnread($: EngineInterface, isMoot: (id: string) => boolean) {
  const reacted = await read($, reactions)
  const gone = (await read($, tips)).filter(tip => isMoot(tip.id) && !isSettled(tip, reacted)).map(tip => tip.id)
  if (gone.length === 0) {
    return
  }
  await save($, { withdrawn: gone })
}

async function react($: EngineInterface, tip: DividendTip, reaction: DividendReaction) {
  // A snooze stays with this session: other sessions keep showing the tip, and the next one shows it again.
  if (reaction === 'later') {
    await serially(() => update($, reactions, reacted => ({ ...reacted, [tip.id]: reaction })))
  } else {
    await save($, { reactions: { [tip.id]: reaction } })
  }
  await refreshStatus($)
}

// Everything Dividend saved goes: the tips and reactions, each session's last-turn record and the
// choice before the cache expires. Every session mirrors the store, so the others drop what they held
// at their next look.
async function reset($: EngineInterface) {
  await serially(async () => {
    await $.store.delete(STORE_KEY)
    await $.store.delete(TURNS_KEY)
    await $.store.delete(SETTINGS_KEY)
    await update($, tips, () => [])
    await update($, reactions, () => ({}))
  })
  await refreshStatus($)
}

async function runCommand($: EngineInterface, text: string): Promise<{ text?: string }> {
  if (text === 'session') {
    return { text: await sessionReport($) }
  }

  if (text === 'reset') {
    await reset($)

    return { text: 'Tips cleared, every kind of tip is back on, and Dividend does nothing before the cache expires.' }
  }

  // A command holds the turn it answers, so the compaction runs just after it.
  if (text === 'compact' || text.startsWith('compact ')) {
    const extra = text.slice('compact'.length)
    $.clock.after(0, () => detach(compactAndSay($, extra)))

    return { text: 'Compacting, with a brief to carry on from.' }
  }

  if (text === 'learn' || text.startsWith('learn ')) {
    return { text: lessonText(text.slice('learn'.length).trim()) }
  }

  if (text) {
    return {
      text: '/dividend opens the pane, /dividend session shows the prompt cache and the instruction files, /dividend compact compacts with a brief to carry on from, /dividend learn explains how it all works, /dividend reset clears the tips.',
    }
  }

  await $.ui.open({ id: PANE, title: 'Dividend' })
  detach(observe($))

  return {}
}

// /dividend session: the pane's "This session" as a card, counted afresh. Printed as text, so the
// transcript row keeps the figures of the moment it was asked.
async function sessionReport($: EngineInterface): Promise<string> {
  await observe($, { breakdown: true })
  const seen = await read($, usage)
  const reacted = await read($, reactions)
  const waitingTips = shownTips(await read($, tips), reacted, here(), tipSettings()).filter(tip => isUnread(tip, reacted))
  const rows = seen ? sessionRows(seen) : [{ label: 'Session', value: 'nothing counted yet' }]
  const waiting = waitingTips.length === 0 ? [] : [{ label: 'Tips waiting', value: String(waitingTips.length), note: `${waitingTips.map(tip => tip.title).join('; ')} (/dividend shows them)` }]
  return cardText([...rows, ...waiting])
}

// Compacting with a brief, between turns. Only a manual call may draft a fallback into the prompt box.
async function runCompaction($: EngineInterface, extra: string, { automatic = false }: { automatic?: boolean } = {}): Promise<{ isDone: boolean; text: string }> {
  if (isTurnRunning()) {
    return { isDone: false, text: 'Compaction runs between turns; try again once Claude has answered.' }
  }
  if (isCompacting) {
    return { isDone: false, text: 'A compaction is already running.' }
  }
  isCompacting = true
  try {
    const instructions = compactionBrief({ request: session.lastRequest, files: session.filesTouched, extra })
    const result = await $.session.compact({ instructions })
    if (result.skip !== undefined) {
      return { isDone: false, text: `The compaction was skipped (${result.skip}).` }
    }
    await afterCompaction($)
    const sizes = result.tokensBefore !== undefined && result.tokensAfter !== undefined ? `: ${tokens(result.tokensBefore)} to ${tokens(result.tokensAfter)} tokens` : ''
    return { isDone: true, text: `Compacted${sizes}.` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return !automatic && (!isInteractive || NO_DIRECT_COMPACTION.test(message)) ? draftCompaction($, extra) : { isDone: false, text: `The compaction failed (${plain(message, 300)}).` }
  } finally {
    isCompacting = false
  }
}

async function draftCompaction($: EngineInterface, extra: string): Promise<{ isDone: boolean; text: string }> {
  if ((await $.prompt.read()).text.trim() !== '') {
    return { isDone: false, text: 'This session compacts through /compact: clear the prompt box, then press Compact now again.' }
  }
  const instructions = compactionBrief({ request: session.lastRequest, files: session.filesTouched, extra })
  const filled = await $.prompt.fill({ text: `/compact ${instructions}` })
  return filled.isFilled
    ? { isDone: false, text: '/compact is in the prompt box, with the brief: press Enter to compact.' }
    : { isDone: false, text: "This session can't compact from a plugin; run /compact yourself." }
}

async function compactAndSay($: EngineInterface, extra: string) {
  $.ui.toast((await runCompaction($, extra)).text)
}

// The tip stays until the compaction is done, so a skipped or failed one can be tried again.
async function compactNow($: EngineInterface, tip: DividendTip) {
  const outcome = await runCompaction($, '')
  if (outcome.isDone) {
    await react($, tip, 'seen')
  }
  $.ui.toast(outcome.text)
}

// The request goes into the prompt box, after any draft there, for the person to read and send.
async function askClaude($: EngineInterface, tip: DividendTip) {
  const text = askFor(tip)
  if (text === null) {
    return
  }
  const draft = (await $.prompt.read()).text
  const filled = draft.trim() === '' ? await $.prompt.fill({ text }) : await $.prompt.fill({ text: `\n\n${text}`, mode: 'append' })
  if (!filled.isFilled) {
    $.ui.toast("Couldn't put the request in the prompt box.")
    return
  }
  await react($, tip, 'seen')
}

async function openFile($: EngineInterface, path: string) {
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => null)
  if (!isOpenable(stat, path)) {
    $.ui.toast(`Dividend opens only Markdown and text files. The file is at ${plain(path, 300)}`)
    return
  }
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const init = { timeoutMs: 10_000, ...(home ? { cwd: home } : {}) }
  const isWindows = isWindowsPath(path)
  const isMac = !isWindows && (await $.fs.exists('/System/Library/CoreServices/SystemVersion.plist').catch(() => false))
  try {
    const { exitCode } = await $.process.run(openerArgv(path, isMac), init)
    // Explorer exits nonzero even when it opened the file.
    if (exitCode === 0 || isWindows) {
      return
    }
  } catch {
    // No opener on this system: said below.
  }
  $.ui.toast(`Couldn't open ${fileName(path)}.`)
}

function toggleLesson($: EngineInterface, topic: LessonTopic) {
  openLesson = openLesson === topic ? null : topic
  $.ui.invalidate('ui.render')
}

const viewActions = ($: EngineInterface) => ({
  compact: (tip: DividendTip) => void compactNow($, tip),
  ask: (tip: DividendTip) => void askClaude($, tip),
  react: (tip: DividendTip, reaction: DividendReaction) => void react($, tip, reaction),
  openPane: () => void $.ui.open({ id: PANE, title: 'Dividend' }),
  openFile: (path: string) => void openFile($, path),
  toggleLesson: (topic: LessonTopic) => toggleLesson($, topic),
  chooseExpiryAction: (action: CacheExpiryAction) => void chooseExpiryAction($, action),
})

const drawBand: MatchedHook<'ui.render', { component: 'AbovePrompt' }> = async ($, e, next) => {
  if (e.props.hasSurvey) {
    return next(e)
  }

  // A tip can wait: another plugin's band goes first.
  const below = await next(e)
  if (below.type !== 'engine') {
    return below
  }
  const reacted = await read($, reactions)
  const current = bandTips(await read($, tips), reacted, here(), tipSettings(), figures.lastMessageAt).at(-1)
  if (!current) {
    return below
  }
  return bandView($.ui.resolve(e), { tip: current, canCompact: isActing && current.action === 'compact' && !e.props.isWorking, isActing }, viewActions($))
}

// /dividend session's row, drawn as a card from the figures it was printed with; anything else as it was.
const drawCard: MatchedHook<'ui.render', { component: 'CommandOutput'; props: { command: 'dividend' } }> = async ($, e, next) => {
  const rows = e.props.args.trim() === 'session' && !e.props.isErrored ? cardRows(e.props.text) : null
  if (rows === null) {
    return next(e)
  }
  return cardView($.ui.resolve(e), rows)
}

const drawPane: MatchedHook<'ui.render', { component: 'Pane'; requestId: typeof PANE }> = async ($, e) => {
  const reacted = await read($, reactions)
  const all = shownTips(await read($, tips), reacted, here(), tipSettings())
  const seen = await read($, usage)
  const canCompact = isActing && !isTurnRunning()
  const chosen = await expiryAction($)
  return paneView($.ui.resolve(e), { all, reacted, seen, canCompact, isActing, openLesson, expiryAction: chosen, isInteractive }, viewActions($))
}
