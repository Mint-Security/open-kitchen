// Cost tips from what the session itself shows. No price table of our own: dollars only where
// Claude Code gives them (its /cost total, and a turn's share of it), tokens everywhere else. On a
// seat plan the dollars are list price, not the bill; the rate limits are what gets used up.
// Pure functions, no `$`.

import type { DividendRateLimit, DividendUsage } from '../../types'
import { dayTime, duration, tokens, usd } from '../display/format'
import type { Tip } from './kinds'

const CONTEXT_PERCENT = 60
const CONTEXT_TOKENS = 120_000
const CONTEXT_HIGH_PERCENT = 85
const MCP_AFTER_TURNS = 5
const MCP_SERVER_TOKENS = 2_000
const MEMORY_TOKENS = 10_000
const MEMORY_SCOPE_TOKENS = 2_000
const RATE_LIMIT_PERCENT = 80
const WALL_PERCENT = 95
const LIGHT_TURNS = 3
const PACE_FROM_PERCENT = 50
const WINDOW_SECONDS: Record<string, number> = { five_hour: 5 * 3600, seven_day: 7 * 86400 }

const RATE_LIMIT_LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly', spend_limit: 'spend' }

const rateLimitLabel = (kind: string): string => RATE_LIMIT_LABEL[kind] ?? kind.replace(/_/g, ' ')

const listOf = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`

// The breakdown's figures are Claude Code's local estimate; /context counts exactly.
export const about = (n: number | null): string => (n ? `about ${tokens(n)}` : '0')

// Claude Code labels each instruction file with where it was loaded from, and each place has its own remedy.
type Scope = { name: string; say: (amount: string) => string }

const SCOPES: Record<string, Scope> = {
  Project: {
    name: 'project',
    say: amount =>
      `Project files add ${amount} and are shared with everyone on the repo: move sections Claude rarely needs into skills, or into .claude/rules files scoped with paths, which load only for matching files.`,
  },
  AutoMem: {
    name: 'auto memory',
    say: amount => `Auto memory, Claude's notes on this project, adds ${amount}: keep it a short index, with the details in the files it points to.`,
  },
  User: { name: 'user', say: amount => `Your user files add ${amount} in every project: keep only what applies everywhere.` },
  Local: { name: 'local', say: amount => `Your local files add ${amount}: they are yours alone, so trim what you no longer need.` },
  Managed: { name: 'managed', say: amount => `Your organization's managed policy adds ${amount}; only an admin can change it.` },
}

export const scopeOf = (type: string): Scope =>
  SCOPES[type] ?? {
    name: type.toLowerCase(),
    say: amount => `${type} files add ${amount}: trim what Claude rarely needs, or move it into a skill, which loads only when it is relevant.`,
  }

// Instruction files by where they were loaded from, heaviest first, each with its files heaviest first.
export const byScope = (files: DividendUsage['memoryFiles']) =>
  [...new Set(files.map(file => file.type))]
    .map(type => {
      const inScope = files.filter(file => file.type === type).sort((a, b) => b.tokens - a.tokens)
      return { type, tokens: inScope.reduce((sum, file) => sum + file.tokens, 0), files: inScope }
    })
    .sort((a, b) => b.tokens - a.tokens)

export type UsageContext = {
  sessionKey: string
  projectKey: string
  mainTurns: number
  now: number
  budgetUsd: number
  model: string | null
}

// A session's context tips, which a compaction makes moot.
export const contextTipIds = (sessionKey: string) => ({ filling: `tip:context:${sessionKey}`, high: `tip:context-high:${sessionKey}` })

const contextTips = (usage: DividendUsage, ctx: UsageContext): Tip[] => {
  const percent = usage.contextPercent
  const held = usage.contextTokens
  if (percent === null || held === null) return []
  const ids = contextTipIds(ctx.sessionKey)
  if (percent >= CONTEXT_HIGH_PERCENT) {
    return [
      {
        id: ids.high,
        kind: 'context-high',
        title: `The context window is ${percent}% full`,
        body: 'Near the limit Claude Code compacts on its own, unless auto-compact is off, often in the middle of a task. Compacting now, at a breakpoint you choose, keeps what matters and makes every turn after it lighter.'
      }
    ]
  }
  // A 1M-token window is only a few percent full long after every message has grown expensive.
  if (percent < CONTEXT_PERCENT && held < CONTEXT_TOKENS) return []
  const why =
    percent >= CONTEXT_PERCENT || usage.contextWindow === null
      ? `This conversation fills ${percent}% of the context window, and each message carries all of it.`
      : `That is ${percent}% of a ${tokens(usage.contextWindow)}-token window, so Claude Code won't compact it on its own for a long while, and each message carries all of it.`
  return [
    {
      id: ids.filling,
      kind: 'context',
      title: `Every message now carries ${tokens(held)} tokens`,
      body: `${why} At a natural breakpoint, /compact keeps the gist and makes every turn lighter; /clear between unrelated tasks starts from nothing.`
    }
  ]
}

const mcpTips = (usage: DividendUsage, ctx: UsageContext): Tip[] => {
  const unused = usage.unusedMcp.filter(server => server.tokens >= MCP_SERVER_TOKENS)
  const total = unused.reduce((sum, server) => sum + server.tokens, 0)
  if (ctx.mainTurns < MCP_AFTER_TURNS || unused.length === 0) return []
  const named = listOf(unused.slice(0, 3).map(server => `${server.server} (${tokens(server.tokens)})`))
  const more = unused.length > 3 ? ` and ${unused.length - 3} more` : ''
  return [
    {
      id: `tip:mcp:${ctx.sessionKey}`,
      kind: 'mcp',
      title: `Unused MCP servers add ${about(total)} tokens to every message`,
      body: `${named}${more} ${unused.length === 1 ? "hasn't" : "haven't"} been used in this session, but their tool descriptions go out with every request. Turn them off in /mcp for sessions that don't need them.`
    }
  ]
}

// /context already lists every file; the tip says which places hold the weight and what to do about each.
const memoryTips = (usage: DividendUsage, ctx: UsageContext): Tip[] => {
  if (usage.memoryTokens === null || usage.memoryTokens < MEMORY_TOKENS) return []
  const advice = byScope(usage.memoryFiles)
    .filter((scope, index) => index === 0 || scope.tokens >= MEMORY_SCOPE_TOKENS)
    .slice(0, 2)
    .map(scope => {
      const largest = scope.files[0]?.name ?? ''
      const which = scope.files.length === 1 ? largest : `largest: ${largest}`
      return scopeOf(scope.type).say(`${about(scope.tokens)} (${which})`)
    })
  return [
    {
      id: `tip:memory:${ctx.projectKey}`,
      kind: 'memory',
      title: `Instruction files add ${about(usage.memoryTokens)} tokens to every message`,
      body: advice.join(' ')
    }
  ]
}

type Pace = { elapsed: number; runsOutIn: number; early: number }

// Whether a limit runs out before it resets, at the rate it has been used since its window opened.
const runsOutEarly = (limit: DividendUsage['rateLimits'][number], now: number): Pace | null => {
  const window = WINDOW_SECONDS[limit.kind]
  if (window === undefined || limit.resetsAt === null || limit.percentUsed <= 0 || limit.percentUsed >= 100) return null
  const left = (Date.parse(limit.resetsAt) - now) / 1000
  const elapsed = window - left
  if (!(left > 0) || elapsed <= 0) return null
  const runsOutIn = ((100 - limit.percentUsed) * elapsed) / limit.percentUsed
  return runsOutIn < left ? { elapsed, runsOutIn, early: left - runsOutIn } : null
}

const RATE_LIMIT_ADVICE = 'Long conversations and many agents at once use it up fastest: /compact at breakpoints and fewer parallel agents stretch what is left.'

const isOpus = (model: string | null): boolean => model !== null && /opus/i.test(model)

// Only a subscription reports 5-hour and weekly windows; a gateway's spend limit is no seat plan.
export const isSeatPlan = (usage: DividendUsage): boolean => usage.rateLimits.some(limit => limit.kind === 'five_hour' || limit.kind === 'seven_day')

const LIGHTER_MODEL = ' Sonnet stretches the same limit further for most coding work; switch at the start of a task or right after /compact.'

// When a limit resets, as a clock time (with the weekday once it is not today), so an unread tip stays true.
const resetText = (limit: DividendUsage['rateLimits'][number], now: number): string => {
  const at = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN
  return Number.isFinite(at) && at > now ? `It resets at ${dayTime(at, now)}. ` : ''
}

// One limit, said once: used up, on pace to run out before it resets, or past 80%.
const rateLimitTip = (limit: DividendRateLimit, ctx: UsageContext): Tip | null => {
  const label = rateLimitLabel(limit.kind)
  const tip = (title: string, body: string): Tip => ({ id: `tip:rate-limit:${limit.kind}:${limit.resetsAt ?? ctx.sessionKey}`, kind: 'rate-limit', title, body })
  if (limit.percentUsed >= 100) return tip(`Your ${label} limit is used up`, resetText(limit, ctx.now).trim() || 'Claude Code reports it fully used.')
  const advice = `${resetText(limit, ctx.now)}${RATE_LIMIT_ADVICE}${isOpus(ctx.model) ? LIGHTER_MODEL : ''}`
  const used = Math.round(limit.percentUsed)
  const pace = limit.percentUsed >= PACE_FROM_PERCENT ? runsOutEarly(limit, ctx.now) : null
  if (pace !== null) {
    return tip(
      `At this pace your ${label} limit runs out around ${dayTime(ctx.now + pace.runsOutIn * 1000, ctx.now)}`,
      `${used}% is used ${duration(pace.elapsed)} into the window, so it runs out ${duration(pace.early)} before it resets. ${advice}`,
    )
  }
  return limit.percentUsed >= RATE_LIMIT_PERCENT ? tip(`${used}% of your ${label} limit is used`, advice) : null
}

// From 95% until a limit is used up, the tip about the wall speaks instead.
const isNearWall = (limit: DividendRateLimit): boolean => limit.percentUsed >= WALL_PERCENT && limit.percentUsed < 100

const rateLimitTips = (usage: DividendUsage, ctx: UsageContext): Tip[] =>
  usage.rateLimits.filter(limit => limit.kind !== 'spend_limit' && !isNearWall(limit)).flatMap(limit => rateLimitTip(limit, ctx) ?? [])

// Close to the wall: a word to wrap up cleanly rather than stop mid-task.
const wallTips = (usage: DividendUsage, ctx: UsageContext): Tip[] =>
  usage.rateLimits
    .filter(limit => limit.kind !== 'spend_limit' && isNearWall(limit))
    .map(limit => {
      const when = resetText(limit, ctx.now)
      return {
        id: `tip:wall:${limit.kind}:${limit.resetsAt ?? ctx.sessionKey}`,
        kind: 'wall' as const,
        title: `${Math.round(limit.percentUsed)}% of your ${rateLimitLabel(limit.kind)} limit is used`,
        body: `${when}Before it runs out mid-task, ask Claude to commit what works and write a short note of where things stand, so a new session can pick up from there.`
      }
    })

// Turns that only read, searched and edited files, on the heaviest model: a lighter one does this well.
export const modelFitTip = (fit: { lightTurns: number; model: string; effort: string | null; sessionKey: string }): Tip | null => {
  if (fit.lightTurns < LIGHT_TURNS || !isOpus(fit.model)) return null
  const at = fit.effort ? ` at ${fit.effort} effort` : ''
  return {
    id: `tip:model-fit:${fit.sessionKey}`,
    kind: 'model-fit',
    title: 'This work runs well on a lighter model',
    body: `The last ${fit.lightTurns} turns only read, searched and edited files, on ${fit.model}${at}. Sonnet, or a lower effort, handles work like this well and costs less: it goes further on a plan's limits, and is cheaper on API billing. Switch at the start of the next task or right after /compact.`
  }
}

// The models Opus 5.5 is suggested over, at a session's start, by how Claude Code names them.
const HEAVIEST_MODEL = /\b(mythos|fable)(?:[- ](\d+)[-.](\d+))?/i

// `claude-fable-5-1` as the model menu shows it, Fable 5.1; null for any other model.
export const heaviestModelName = (model: string): string | null => {
  const match = HEAVIEST_MODEL.exec(model)
  if (!match?.[1]) return null
  const version = match[2] && match[3] ? ` ${match[2]}.${match[3]}` : ''
  return `${match[1].charAt(0).toUpperCase()}${match[1].slice(1).toLowerCase()}${version}`
}

// A conversation that opens on Mythos or Fable: switching while it is short re-caches little.
export const startModelTip = (start: { model: string; sessionKey: string }): Tip | null => {
  const name = heaviestModelName(start.model)
  if (name === null) return null
  return {
    id: `tip:model-start:${start.sessionKey}`,
    kind: 'model-start',
    title: `This session starts on ${name}`,
    body: `Opus 5.5 handles most coding work well and costs less: it goes further on a plan's limits, and is cheaper on API billing. Switch now, while the conversation is short and switching re-caches little: /model claude-opus-5-5, or the model menu in the desktop app. Keep ${name} for the work that needs it.`
  }
}

const budgetTips = (usage: DividendUsage, ctx: UsageContext): Tip[] => {
  if (ctx.budgetUsd <= 0 || usage.costUsd === null || usage.costUsd < ctx.budgetUsd) return []
  const crossed = Math.floor(usage.costUsd / ctx.budgetUsd) * ctx.budgetUsd
  const seat = isSeatPlan(usage) ? " On a seat plan that is not your bill: the rate limits are what this session uses up." : ''
  return [
    {
      id: `tip:budget:${ctx.sessionKey}:${crossed}`,
      kind: 'budget',
      title: `This session passed ${usd(crossed)} at list price`,
      body: `It is at ${usd(usage.costUsd)} by Claude Code's own count (/cost).${seat} The alert's step is the plugin's budgetUsd setting.`
    }
  ]
}

// The limit tips alone: the ones worth raising mid-turn, as soon as a limit moves.
export const limitTips = (usage: DividendUsage, ctx: UsageContext): Tip[] => [...rateLimitTips(usage, ctx), ...wallTips(usage, ctx), ...budgetTips(usage, ctx)]

export const usageTips = (usage: DividendUsage, ctx: UsageContext): Tip[] => [
  ...rateLimitTips(usage, ctx),
  ...wallTips(usage, ctx),
  ...budgetTips(usage, ctx),
  ...contextTips(usage, ctx),
  ...mcpTips(usage, ctx),
  ...memoryTips(usage, ctx)
]
