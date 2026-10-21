// The shapes of register.tsx's state, and each one fresh. Pure functions, no `$`.

import type { TurnUsage } from 'claude-code'

import type { DividendUsage } from '../types'
import { keyOf } from './display/format'
import type { CacheTtl, Plan } from './tips/cache'
import type { LastTurn } from './tips/store'
import type { McpServer } from './tips/turns'

export const BREAKDOWN_EVERY_TURNS = 3

export type Opening = { usage: TurnUsage; effort: string | null }

// What a conversation counts from its start: a session starting, a /clear and a /resume each begin
// afresh. Signals are read after a main turn completes. Timers are armed per break in a big
// conversation, to say when its cache lapses; an idle small session costs nothing.
export type SessionState = {
  sessionId: string
  sessionKey: string
  mainTurns: number
  // The person's latest request, for the compaction brief.
  lastRequest: string | null
  // The break the person was told about before sending, so the turn after it doesn't repeat it.
  warnedFor: number | null
  coldBreaks: number
  // Breaks of 5 minutes to an hour after which the cache was still warm: proof it lasts longer than 5.
  warmBreaks: number
  filesTouched: string[]
  lightTurns: number
  isDupesChecked: boolean
  bigReads: ReadonlyMap<string, number>
  isJustCompacted: boolean
  turnsSinceBreakdown: number
  mcpServers: McpServer[]
  memory: Pick<DividendUsage, 'memoryTokens' | 'memoryFiles'>
  usedServers: Set<string>
  cancelExpiry: () => void
  keepAlivesInARow: number
}

export const freshSession = (sessionId: string, sessionKey = keyOf(sessionId)): SessionState => ({
  sessionId,
  sessionKey,
  mainTurns: 0,
  lastRequest: null,
  warnedFor: null,
  coldBreaks: 0,
  warmBreaks: 0,
  filesTouched: [],
  lightTurns: 0,
  isDupesChecked: false,
  bigReads: new Map(),
  isJustCompacted: false,
  turnsSinceBreakdown: BREAKDOWN_EVERY_TURNS,
  mcpServers: [],
  memory: { memoryTokens: null, memoryFiles: [] },
  usedServers: new Set(),
  cancelExpiry: () => undefined,
  keepAlivesInARow: 0,
})

// What the conversation held at its last answer: read back as a session starts or resumes, and
// updated after each answer.
export type Figures = {
  lastAnswerAt: number | null
  // When the latest message went: news raised before it has left the band.
  lastMessageAt: number | null
  lastContextTokens: number | null
  lastCostUsd: number | null
  previousModel: string | null
  previousEffort: string | null
  plan: Plan | null
  cacheTtl: CacheTtl | null
}

export const noFigures = (): Figures => ({
  lastAnswerAt: null,
  lastMessageAt: null,
  lastContextTokens: null,
  lastCostUsd: null,
  previousModel: null,
  previousEffort: null,
  plan: null,
  cacheTtl: null,
})

// What a session starting or resuming picks up: the context and cost Claude Code still reports, and
// its last answer's model, effort and time. The cache lifetime stays as it was until it is read again.
export const restoredFigures = (restored: { contextTokens: number | null; costUsd: number | null }, turns: Record<string, LastTurn>, sessionKey: string, cacheTtl: CacheTtl | null): Figures => {
  const last = turns[sessionKey] ?? null
  return {
    lastAnswerAt: last?.at ?? null,
    lastMessageAt: last?.at ?? null,
    lastContextTokens: restored.contextTokens,
    lastCostUsd: restored.costUsd,
    previousModel: last?.model ?? null,
    previousEffort: last?.effort ?? null,
    // The plan rarely changes between sessions: the latest one known says how long the cache lasts.
    plan:
      last?.plan ??
      Object.values(turns)
        .filter(turn => turn.plan !== undefined)
        .sort((a, b) => b.at - a.at)[0]?.plan ??
      null,
    cacheTtl,
  }
}
