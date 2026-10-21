import { expect, test } from 'claude-code/testing'

import { CACHE_EXPIRY_ACTIONS, LONGEST_TTL, cacheActionTiming, expiredTip, isCacheExpiryAction, isColdStart, isWarmStart, planOf, recacheTip, resolveTtl, ttlAdviceTip, ttlText, warmCompactTip } from '../hooks/tips/cache'
import type { TtlFacts, TurnFacts } from '../hooks/tips/cache'

const facts = (patch: Partial<TtlFacts> = {}): TtlFacts => ({
  disable: undefined,
  force5m: undefined,
  envTtl: undefined,
  settingTtl: undefined,
  enable1h: undefined,
  enable1hBedrock: undefined,
  useBedrock: undefined,
  plan: null,
  ...patch,
})

test('automatic cache actions default off and need a known, enabled cache', () => {
  expect(CACHE_EXPIRY_ACTIONS.every(isCacheExpiryAction)).toBe(true)
  expect([undefined, null, 'invalid', 'keep cache warm', 1].some(isCacheExpiryAction)).toBe(false)
  expect(cacheActionTiming(1000, null)).toBeNull()
  expect(cacheActionTiming(1000, LONGEST_TTL)).toBeNull()
  expect(cacheActionTiming(1000, { seconds: 0, source: 'DISABLE_PROMPT_CACHING' })).toBeNull()
  expect(cacheActionTiming(1000, { seconds: 300, source: 'api' })).toEqual({ actAt: 241_000, expiresAt: 301_000 })
  expect(cacheActionTiming(1000, { seconds: 3600, source: 'subscription' })).toEqual({ actAt: 3_001_000, expiresAt: 3_601_000 })
})

test("the cache lifetime follows Claude Code's own order: override, variable, setting, switch, then the plan", () => {
  expect(resolveTtl(facts({ plan: 'subscription' }))).toEqual({ seconds: 3600, source: 'subscription' })
  expect(resolveTtl(facts({ plan: 'api' }))).toEqual({ seconds: 300, source: 'api' })
  expect(resolveTtl(facts({ plan: 'over-limits' }))).toEqual({ seconds: 300, source: 'over-limits' })
  expect(resolveTtl(facts({ settingTtl: '1h', plan: 'api' }))).toEqual({ seconds: 3600, source: 'promptCacheTtl' })
  expect(resolveTtl(facts({ envTtl: '5m', settingTtl: '1h' }))).toEqual({ seconds: 300, source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' })
  expect(resolveTtl(facts({ force5m: '1', envTtl: '1h' }))).toEqual({ seconds: 300, source: 'FORCE_PROMPT_CACHING_5M' })
  expect(resolveTtl(facts({ enable1h: 'true', plan: 'api' }))).toEqual({ seconds: 3600, source: 'ENABLE_PROMPT_CACHING_1H' })
  expect(resolveTtl(facts({ force5m: '0', settingTtl: 'forever' }))).toBeNull()
  expect(resolveTtl(facts({ disable: '1', force5m: '1', plan: 'subscription' }))).toEqual({ seconds: 0, source: 'DISABLE_PROMPT_CACHING' })
  expect(resolveTtl(facts({ enable1hBedrock: '1', useBedrock: '1', plan: 'api' }))).toEqual({ seconds: 3600, source: 'ENABLE_PROMPT_CACHING_1H_BEDROCK' })
  expect(resolveTtl(facts({ enable1hBedrock: '1', plan: 'api' }))).toEqual({ seconds: 300, source: 'api' })
  expect(expiredTip({ context: 240_000, idleSeconds: 9_999, ttl: { seconds: 0, source: 'DISABLE_PROMPT_CACHING' }, sessionKey: 's1', answeredAt: 7 })).toBeNull()
})

test('the plan is read off the limits a response reports', () => {
  expect(planOf([{ kind: 'five_hour', percentUsed: 40, resetsAt: null }])).toBe('subscription')
  expect(planOf([{ kind: 'seven_day', percentUsed: 100, resetsAt: null }])).toBe('over-limits')
  expect(planOf([{ kind: 'spend_limit', percentUsed: 20, resetsAt: null }])).toBe('api')
  expect(planOf([])).toBe('api')
  expect(ttlText({ seconds: 3600, source: 'subscription' })).toBe('1 hour on a subscription within its limits')
  expect(ttlText(LONGEST_TTL)).toBe('1 hour at most')
})

const turn = (patch: Partial<TurnFacts> = {}): TurnFacts => ({
  cacheWrite: 125_000,
  cacheRead: 0,
  model: 'claude-haiku-4-5',
  previousModel: 'claude-haiku-4-5',
  effort: null,
  previousEffort: null,
  contextBefore: 120_000,
  contextAfter: 126_000,
  gapSeconds: 75 * 60,
  ttlSeconds: null,
  costUsd: 0.21,
  ...patch,
})

test('a turn that wrote a big conversation to the cache again says why and what it cost', () => {
  const tip = recacheTip(turn(), 's1')
  expect(tip).toMatchObject({ id: 'tip:recache:s1', kind: 'recache', title: 'This message re-cached 125k tokens' })
  expect(tip?.body.startsWith('The prompt cache expired in the 75 min since the last answer, so the whole conversation was written to it again (this turn: about $0.21 at list price).')).toBe(true)
  expect(recacheTip(turn({ gapSeconds: null, costUsd: null }), 's1')?.body.startsWith('The prompt cache had expired, so')).toBe(true)
})

test('a warm cache, a small or new conversation, or a compaction is no re-cache', () => {
  expect(recacheTip(turn({ cacheRead: 118_000, cacheWrite: 7_000 }), 's1')).toBeNull()
  expect(recacheTip(turn({ cacheRead: 30_000 }), 's1')).toBeNull()
  expect(recacheTip(turn({ cacheWrite: 30_000, contextBefore: 30_000 }), 's1')).toBeNull()
  expect(recacheTip(turn({ contextBefore: null }), 's1')).toBeNull()
  expect(recacheTip(turn({ contextBefore: 150_000, contextAfter: 41_000 }), 's1')).toBeNull()
  expect(isColdStart(turn())).toBe(true)
})

test('a re-cache right after a model change is put down to the switch', () => {
  const tip = recacheTip(turn({ model: 'claude-sonnet-5-5', previousModel: 'claude-haiku-4-5' }), 's1')
  expect(tip).toMatchObject({ id: 'tip:switch:s1', kind: 'switch', title: 'Switching models re-cached 125k tokens' })
  expect(tip?.body).toContain('the first message on claude-sonnet-5-5 wrote the whole conversation to the cache again')
})

test('a cold start within the cache lifetime is put down to an effort change, or to something that changed early on', () => {
  const effort = recacheTip(turn({ gapSeconds: 600, ttlSeconds: 3600, previousEffort: 'high', effort: 'max' }), 's1')
  expect(effort?.body.startsWith('The cache had not expired, but the effort level changed (high to max), which can make it miss.')).toBe(true)
  const changed = recacheTip(turn({ gapSeconds: 600, ttlSeconds: 3600 }), 's1')
  expect(changed?.body.startsWith('The cache should still have been warm, but it missed: most often because something near the start of the conversation changed')).toBe(true)
})

test('a lapsed cache is said before the next message, from 40k tokens', () => {
  const ttl = { seconds: 3600, source: 'subscription' as const }
  const tip = expiredTip({ context: 240_000, idleSeconds: 75 * 60, ttl, sessionKey: 's1', answeredAt: 7 })
  expect(tip).toMatchObject({ id: 'tip:expired:s1:7', kind: 'expired', title: 'Your next message will re-cache 240k tokens' })
  expect(tip?.body).toMatch(/^The prompt cache lasts 1 hour on a subscription within its limits, and Claude last answered at \d{1,2}:\d{2}/)
  expect(expiredTip({ context: 240_000, idleSeconds: 3 * 86400, ttl, sessionKey: 's1', answeredAt: 7 })?.body).toContain('Claude last answered 3 days ago')
  expect(expiredTip({ context: 240_000, idleSeconds: 50 * 60, ttl, sessionKey: 's1', answeredAt: 7 })).toBeNull()
  expect(expiredTip({ context: 30_000, idleSeconds: 75 * 60, ttl, sessionKey: 's1', answeredAt: 7 })).toBeNull()
})

test('an offer to compact while warm comes only for an hour-long cache and a big conversation', () => {
  const tip = warmCompactTip({ context: 120_000, ttl: { seconds: 3600, source: 'subscription' }, sessionKey: 's1', answeredAt: 7 })
  expect(tip).toMatchObject({ id: 'tip:warm-compact:s1:7', kind: 'warm-compact', action: 'compact' })
  expect(tip?.title).toMatch(/^The prompt cache expires at \d{1,2}:\d{2}/)
  expect(warmCompactTip({ context: 120_000, ttl: { seconds: 300, source: 'api' }, sessionKey: 's1', answeredAt: 7 })).toBeNull()
  expect(warmCompactTip({ context: 60_000, ttl: { seconds: 3600, source: 'subscription' }, sessionKey: 's1', answeredAt: 7 })).toBeNull()
})

test('a first request that read a big conversation back from the cache was warm', () => {
  const turn = { cacheWrite: 2_000, cacheRead: 118_000, model: 'm', previousModel: 'm', effort: null, previousEffort: null, contextBefore: 120_000, contextAfter: 121_000, gapSeconds: 600, ttlSeconds: 300, costUsd: null }
  expect(isWarmStart(turn)).toBe(true)
  expect(isWarmStart({ ...turn, cacheRead: 30_000 })).toBe(false)
  expect(isWarmStart({ ...turn, cacheWrite: 60_000 })).toBe(false)
})

test('on API billing, breaks that keep outlasting the cache suggest a 1-hour one', () => {
  const api = { seconds: 300, source: 'api' as const }
  expect(ttlAdviceTip({ cold: 2, warm: 0 }, api, 's1')).toBeNull()
  expect(ttlAdviceTip({ cold: 3, warm: 0 }, api, 's1')).toMatchObject({ id: 'tip:ttl:s1', kind: 'ttl', title: 'Your breaks keep outlasting the 5-minute cache' })
  expect(ttlAdviceTip({ cold: 5, warm: 1 }, api, 's1')).toBeNull()
  expect(ttlAdviceTip({ cold: 5, warm: 0 }, { seconds: 300, source: 'promptCacheTtl' }, 's1')).toBeNull()
  expect(ttlAdviceTip({ cold: 5, warm: 0 }, null, 's1')).toBeNull()
})
