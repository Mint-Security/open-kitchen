// What Dividend keeps in Claude Code's plugin store, read back with care: the store is a JSON file, so
// whatever is in it is checked before it is used. Pure functions, no `$`.

import type { DividendReaction, DividendTip } from '../../types'
import { plain } from '../display/format'
import { isCacheExpiryAction } from './cache'
import type { CacheExpiryAction, Plan } from './cache'
import { tipKindOf } from './kinds'
import type { TipKind } from './kinds'

export const STORE_KEY = 'dividend'
export const TURNS_KEY = 'dividend-turns'
export const SETTINGS_KEY = 'dividend-settings'
const TIPS_KEPT = 60
const TURNS_KEPT = 20

type Persisted = {
  tips: DividendTip[]
  reactions: Record<string, DividendReaction>
  // Tips a session withdrew because they no longer held: kept so a merge or a restart doesn't revive them.
  withdrawn?: string[]
}

export type Saved = Partial<Persisted>

// What one save adds to the store: tips raised or restated, reactions, and tips taken back.
export type Changes = { tips?: DividendTip[]; reactions?: Record<string, DividendReaction>; withdrawn?: string[] }

// The store is a JSON file: a value that isn't the shape Dividend saves reads as empty, so one bad
// value can't make every save fail until a reset.
export const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const asStrings = (value: unknown): string[] => asList(value).filter((item): item is string => typeof item === 'string')

export type Settings = { cacheExpiryAction: CacheExpiryAction }

export const restoredSettings = (stored: unknown): Settings => {
  const { cacheExpiryAction } = asRecord(stored)
  return { cacheExpiryAction: isCacheExpiryAction(cacheExpiryAction) ? cacheExpiryAction : 'Do nothing' }
}

// Snoozes end with the session.
export const restoredReactions = (reacted: unknown): Record<string, DividendReaction> =>
  Object.fromEntries(
    Object.entries(asRecord(reacted))
      .filter(([, reaction]) => reaction !== 'later')
      .map(([id, reaction]): [string, DividendReaction] => [id, reaction === 'not-relevant' ? 'not-relevant' : 'seen']),
  )

const WITHDRAWN_KEPT = 200
const READ_KEPT = 300

const isTipEntry = (entry: unknown): entry is DividendTip & { action?: unknown } => {
  const tip = asRecord(entry)
  return typeof tip.id === 'string' && typeof tip.title === 'string' && typeof tip.body === 'string' && typeof tip.receivedAt === 'number'
}

export const restoredTips = (saved: Saved): DividendTip[] => {
  const withdrawn = asStrings(saved.withdrawn)
  return asList(saved.tips)
    .filter(isTipEntry)
    .filter(entry => tipKindOf(entry.id) !== null && !withdrawn.includes(entry.id))
    .map(entry => ({
      id: entry.id,
      title: plain(entry.title, 200),
      body: plain(entry.body),
      receivedAt: entry.receivedAt,
      ...(entry.action === 'compact' ? { action: 'compact' as const } : {}),
    }))
}

// A tip kind turned off ("don't show these") is not offered again, in any session.
export const mutedKinds = (reacted: Record<string, DividendReaction>): Set<TipKind> =>
  new Set(
    Object.entries(reacted)
      .filter(([, reaction]) => reaction === 'not-relevant')
      .map(([id]) => tipKindOf(id))
      .filter((kind): kind is TipKind => kind !== null),
  )

const REACTION_WEIGHT: Record<DividendReaction, number> = { later: 1, seen: 2, 'not-relevant': 3 }

// Two sessions' reactions to the same tips: the firmer one stands, so a "don't show these" is never undone.
export const mergeReactions = (a: Record<string, DividendReaction>, b: Record<string, DividendReaction>): Record<string, DividendReaction> => {
  const merged = { ...a }
  for (const [id, reaction] of Object.entries(b)) {
    const current = merged[id]
    merged[id] = current === undefined || REACTION_WEIGHT[reaction] > REACTION_WEIGHT[current] ? reaction : current
  }
  return merged
}

// Every session shares the store, so a save writes only this one's changes onto what is there now:
// what another session raised or took back, and a reset, stand. Old tips go once there are many; a
// "don't show these" is kept so its kind stays off.
export const merged = (saved: Saved, changes: Changes): Persisted => {
  const changed = new Map((changes.tips ?? []).map(tip => [tip.id, tip]))
  const withdrawn = [...new Set([...asStrings(saved.withdrawn), ...(changes.withdrawn ?? [])])].filter(id => !changed.has(id)).slice(-WITHDRAWN_KEPT)
  const kept = [...restoredTips({ ...saved, withdrawn }).filter(tip => !changed.has(tip.id)), ...changed.values()]
    .sort((a, b) => a.receivedAt - b.receivedAt)
    .slice(-TIPS_KEPT)
  const keptIds = new Set(kept.map(tip => tip.id))
  const reacted = mergeReactions(restoredReactions(saved.reactions), restoredReactions(changes.reactions ?? {}))
  // A tip read and then dropped for newer ones stays read, so it can't come back unread.
  const readDropped = new Set(Object.entries(reacted).filter(([id, reaction]) => !keptIds.has(id) && reaction === 'seen').slice(-READ_KEPT).map(([id]) => id))
  return {
    tips: kept,
    reactions: Object.fromEntries(Object.entries(reacted).filter(([id, reaction]) => keptIds.has(id) || reaction === 'not-relevant' || readDropped.has(id))),
    withdrawn,
  }
}

// Each session's last answer, so a resumed one knows what model and effort it was on, how long it
// has been, and what plan it ran on (which sets how long the prompt cache lasts).
export type LastTurn = { model: string; at: number; plan?: Plan; effort?: string }

const isLastTurn = (value: unknown): value is LastTurn => {
  const turn = asRecord(value)
  return typeof turn.model === 'string' && typeof turn.at === 'number'
}

export const lastTurnsIn = (stored: unknown): Record<string, LastTurn> =>
  Object.fromEntries(Object.entries(asRecord(stored)).filter((entry): entry is [string, LastTurn] => isLastTurn(entry[1])))

export const withLastTurn = (turns: Record<string, LastTurn>, sessionKey: string, turn: LastTurn): Record<string, LastTurn> =>
  Object.fromEntries([...Object.entries(turns).filter(([key]) => key !== sessionKey), [sessionKey, turn]].slice(-TURNS_KEPT))
