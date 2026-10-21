// The prompt cache: how long it lasts here, what a cold start was caused by, and what to say before
// one happens. Pure functions, no `$`.

import type { DividendCacheTtl, DividendTtlSource, DividendUsage } from '../../types'
import { clockTime, duration, tokens, usd } from '../display/format'
import type { Tip } from './kinds'

export type Plan = 'subscription' | 'over-limits' | 'api'

export type TtlSource = DividendTtlSource

export type CacheTtl = DividendCacheTtl

export type TtlFacts = {
  // DISABLE_PROMPT_CACHING, or its variant for the session's model family.
  disable: string | undefined
  force5m: string | undefined
  envTtl: string | undefined
  settingTtl: unknown
  enable1h: string | undefined
  enable1hBedrock: string | undefined
  useBedrock: string | undefined
  plan: Plan | null
}

const FIVE_MINUTES = 5 * 60
const ONE_HOUR = 60 * 60
const RECACHE_TOKENS = 40_000
const EXPIRED_TOKENS = 40_000
const WARM_COMPACT_TOKENS = 80_000
const WARM_COMPACT_LEAD_SECONDS = 10 * 60
// No cache outlives an hour: past that it has lapsed, whatever the plan.
export const LONGEST_TTL: CacheTtl = { seconds: 60 * 60, source: 'unknown' }
const TTL_ADVICE_BREAKS = 3

export const CACHE_EXPIRY_ACTIONS = ['Do nothing', 'Keep cache warm', 'Auto compact'] as const

export type CacheExpiryAction = (typeof CACHE_EXPIRY_ACTIONS)[number]

export const isCacheExpiryAction = (value: unknown): value is CacheExpiryAction => CACHE_EXPIRY_ACTIONS.some(action => action === value)

export const KEEP_ALIVE_PROMPT = "Dividend cache keep-alive. Reply only with OK. Do not use tools or continue the task."

export const KEEP_ALIVES_IN_A_ROW = 5

// Opt-in actions also work for small conversations and 5-minute caches. An unknown lifetime is
// enough for advice, but never enough to spend usage on the person's behalf.
export type CacheActionTiming = { actAt: number; expiresAt: number }

export const cacheActionTiming = (answeredAt: number, ttl: CacheTtl | null): CacheActionTiming | null => {
  if (ttl === null || ttl.source === 'unknown' || ttl.seconds <= 0) return null
  const expiresAt = answeredAt + ttl.seconds * 1000
  const leadSeconds = Math.min(WARM_COMPACT_LEAD_SECONDS, ttl.seconds / 5)
  return { actAt: expiresAt - leadSeconds * 1000, expiresAt }
}

export const isEnvSet = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false'


const secondsOf = (value: unknown): number | null => (value === '5m' ? FIVE_MINUTES : value === '1h' ? ONE_HOUR : null)

// Claude Code's own order for the main conversation: caching off, the 5-minute override, the variable,
// the setting, the 1-hour switches; unset, 1 hour on a subscription within its limits and 5 minutes
// elsewhere. Caching off reads as a lifetime of 0.
export const resolveTtl = (facts: TtlFacts): CacheTtl | null => {
  if (isEnvSet(facts.disable)) return { seconds: 0, source: 'DISABLE_PROMPT_CACHING' }
  if (isEnvSet(facts.force5m)) return { seconds: FIVE_MINUTES, source: 'FORCE_PROMPT_CACHING_5M' }
  const fromEnv = secondsOf(facts.envTtl)
  if (fromEnv !== null) return { seconds: fromEnv, source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' }
  const fromSetting = secondsOf(facts.settingTtl)
  if (fromSetting !== null) return { seconds: fromSetting, source: 'promptCacheTtl' }
  if (isEnvSet(facts.enable1h)) return { seconds: ONE_HOUR, source: 'ENABLE_PROMPT_CACHING_1H' }
  if (isEnvSet(facts.useBedrock) && isEnvSet(facts.enable1hBedrock)) return { seconds: ONE_HOUR, source: 'ENABLE_PROMPT_CACHING_1H_BEDROCK' }
  if (facts.plan === null) return null
  return { seconds: facts.plan === 'subscription' ? ONE_HOUR : FIVE_MINUTES, source: facts.plan }
}

// Only a subscription reports 5-hour and weekly windows; past one of them it is billed like the API.
export const planOf = (rateLimits: DividendUsage['rateLimits']): Plan => {
  const windows = rateLimits.filter(limit => limit.kind === 'five_hour' || limit.kind === 'seven_day')
  if (windows.length === 0) return 'api'
  return windows.some(limit => limit.percentUsed >= 100) ? 'over-limits' : 'subscription'
}

const ttlName = (seconds: number): string =>
  seconds === ONE_HOUR ? '1 hour' : seconds === FIVE_MINUTES ? '5 minutes' : duration(seconds)

const SOURCE_PHRASE: Record<TtlSource, string> = {
  FORCE_PROMPT_CACHING_5M: '(FORCE_PROMPT_CACHING_5M)',
  CLAUDE_CODE_PROMPT_CACHE_TTL: '(CLAUDE_CODE_PROMPT_CACHE_TTL)',
  promptCacheTtl: '(promptCacheTtl in your settings)',
  ENABLE_PROMPT_CACHING_1H: '(ENABLE_PROMPT_CACHING_1H)',
  ENABLE_PROMPT_CACHING_1H_BEDROCK: '(ENABLE_PROMPT_CACHING_1H_BEDROCK)',
  DISABLE_PROMPT_CACHING: '(prompt caching is turned off)',
  subscription: 'on a subscription within its limits',
  'over-limits': 'once a plan is past its limits',
  api: 'on API billing',
  unknown: 'at most',
}

export const ttlText = (ttl: CacheTtl): string => (ttl.seconds === 0 ? 'not at all (prompt caching is turned off)' : `${ttlName(ttl.seconds)} ${SOURCE_PHRASE[ttl.source]}`)

export type TurnFacts = {
  cacheWrite: number
  cacheRead: number
  model: string
  previousModel: string | null
  effort: string | null
  previousEffort: string | null
  contextBefore: number | null
  contextAfter: number | null
  gapSeconds: number | null
  ttlSeconds: number | null
  costUsd: number | null
}

// A turn's first request wrote far more to the cache than it read back, in a conversation that was
// already big and did not shrink: the whole conversation went into the cache again.
export const isColdStart = (turn: TurnFacts): boolean =>
  turn.cacheWrite >= RECACHE_TOKENS &&
  turn.cacheRead * 5 <= turn.cacheWrite &&
  turn.contextBefore !== null &&
  turn.contextBefore >= RECACHE_TOKENS &&
  !(turn.contextAfter !== null && turn.contextAfter < turn.contextBefore * 0.8)

const isModelSwitch = (turn: TurnFacts): boolean => turn.previousModel !== null && turn.previousModel !== turn.model

const isLapsed = (turn: TurnFacts): boolean => turn.gapSeconds === null || turn.ttlSeconds === null || turn.gapSeconds >= turn.ttlSeconds

const isEffortChange = (turn: TurnFacts): boolean => turn.previousEffort !== null && turn.effort !== null && turn.previousEffort !== turn.effort

// Why the cache missed, and what avoids it next time.
const recacheBody = (turn: TurnFacts, cost: string): string => {
  if (isLapsed(turn)) {
    const why = turn.gapSeconds !== null ? `The prompt cache expired in the ${duration(turn.gapSeconds)} since the last answer` : 'The prompt cache had expired'
    return `${why}, so the whole conversation was written to it again${cost}. Coming back to a long conversation after a break? For something new, a fresh session skips this. Carrying on, /compact still reads the history once, but every message after it carries a short summary instead.`
  }
  const why = isEffortChange(turn)
    ? `The cache had not expired, but the effort level changed (${turn.previousEffort} to ${turn.effort}), which can make it miss`
    : 'The cache should still have been warm, but it missed: most often because something near the start of the conversation changed, such as an MCP server connecting or a tool or skill being added'
  return `${why}. The whole conversation was written to it again${cost}. Changes like these cost least at the start of a task or right after /compact.`
}

export const recacheTip = (turn: TurnFacts, sessionKey: string): Tip | null => {
  if (!isColdStart(turn)) return null
  const cost = turn.costUsd !== null && turn.costUsd > 0 ? ` (this turn: about ${usd(turn.costUsd)} at list price)` : ''
  if (isModelSwitch(turn)) {
    return {
      id: `tip:switch:${sessionKey}`,
      kind: 'switch',
      title: `Switching models re-cached ${tokens(turn.cacheWrite)} tokens`,
      body: `Each model keeps its own prompt cache, so the first message on ${turn.model} wrote the whole conversation to the cache again${cost}. Switching at the start of a task, or right after /compact, costs far less.`
    }
  }
  return { id: `tip:recache:${sessionKey}`, kind: 'recache', title: `This message re-cached ${tokens(turn.cacheWrite)} tokens`, body: recacheBody(turn, cost) }
}

type IdleFacts = {
  context: number
  idleSeconds: number
  ttl: CacheTtl
  sessionKey: string
  answeredAt: number
}

const SAME_DAY_SECONDS = 12 * 3600

// Before the next message rather than after it: the cache has lapsed while the person was away. Times
// are clock times, so a tip that sits unread doesn't go stale.
export const expiredTip = (idle: IdleFacts): Tip | null => {
  if (idle.ttl.seconds === 0 || idle.context < EXPIRED_TOKENS || idle.idleSeconds < idle.ttl.seconds) return null
  const answered = idle.idleSeconds < SAME_DAY_SECONDS ? `at ${clockTime(idle.answeredAt)}` : `${duration(idle.idleSeconds)} ago`
  return {
    id: `tip:expired:${idle.sessionKey}:${idle.answeredAt}`,
    kind: 'expired',
    title: `Your next message will re-cache ${tokens(idle.context)} tokens`,
    body: `The prompt cache lasts ${ttlText(idle.ttl)}, and Claude last answered ${answered}, so the next message writes the whole conversation to the cache again. Starting something new? /clear costs nothing. Carrying on? /compact first, so the messages after it carry a summary instead.`
  }
}

// Shortly before a long-lived cache lapses, compacting is still cheap: a reason to do it before a break.
export const warmCompactTip = (idle: Omit<IdleFacts, 'idleSeconds'>): Tip | null => {
  if (idle.ttl.seconds < 3 * WARM_COMPACT_LEAD_SECONDS || idle.context < WARM_COMPACT_TOKENS) return null
  return {
    id: `tip:warm-compact:${idle.sessionKey}:${idle.answeredAt}`,
    kind: 'warm-compact',
    title: `The prompt cache expires at ${clockTime(idle.answeredAt + idle.ttl.seconds * 1000)}`,
    body: `Stepping away? Compacting now, while the cache is warm, costs little and leaves a short summary to carry on from. Once it expires, the next message writes all ${tokens(idle.context)} tokens to the cache again.`,
    action: 'compact'
  }
}

// When to speak up about a break in a big conversation, if at all: once the cache has lapsed, and
// shortly before, with an offer to compact while it is still cheap.
export const breakTiming = (idle: Omit<IdleFacts, 'idleSeconds'>): { expiresAt: number; warm: Tip | null; warmAt: number } | null => {
  if (expiredTip({ ...idle, idleSeconds: idle.ttl.seconds }) === null) return null
  const expiresAt = idle.answeredAt + idle.ttl.seconds * 1000
  return { expiresAt, warm: warmCompactTip(idle), warmAt: expiresAt - WARM_COMPACT_LEAD_SECONDS * 1000 }
}

// The first request read a big conversation back from the cache: it was still warm.
export const isWarmStart = (turn: TurnFacts): boolean => turn.cacheRead >= RECACHE_TOKENS && turn.cacheWrite * 5 <= turn.cacheRead

// On API billing the cache lasts 5 minutes unless set otherwise; breaks a little longer than that
// keep paying for the whole conversation again. Dividend infers the plan, so the cache must bear it out
// too: cold after such breaks, and never warm after one, which only a longer cache would be.
export const ttlAdviceTip = (breaks: { cold: number; warm: number }, ttl: CacheTtl | null, sessionKey: string): Tip | null => {
  if (ttl === null || ttl.source !== 'api' || breaks.cold < TTL_ADVICE_BREAKS || breaks.warm > 0) return null
  const coldBreaks = breaks.cold
  return {
    id: `tip:ttl:${sessionKey}`,
    kind: 'ttl',
    title: 'Your breaks keep outlasting the 5-minute cache',
    body: `${coldBreaks} times this session a break between 5 minutes and an hour let the cache expire, and the next message wrote the whole conversation to it again. Setting "promptCacheTtl": "1h" in settings.json keeps it for an hour. Each cache write then costs 2 times the base input price instead of 1.25 times, which pays off once breaks like these are common.`
  }
}
