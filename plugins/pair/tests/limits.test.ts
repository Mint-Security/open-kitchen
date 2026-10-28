import { expect, test } from 'claude-code/testing'

import type { PairEvent } from '../types'
import { batchesOf, perMinute } from '../hooks/wire/limits'

const event = (n: number, size: number): PairEvent => ({ t: 'assistant', text: `${n}:${'x'.repeat(size)}` })

test('events go out in batches of about 96 KB, in order, an oversized one on its own', () => {
  const events = Array.from({ length: 5 }, (_, n) => event(n, 30_000))
  expect(batchesOf(events).map(batch => batch.length)).toEqual([3, 2])
  expect(batchesOf(events).flat()).toEqual(events)
  expect(batchesOf([event(0, 200_000), event(1, 10)]).map(batch => batch.length)).toEqual([1, 1])
  expect(batchesOf([])).toEqual([])
})

test('at most so many a minute, counted over the last sixty seconds, and none once cleared', () => {
  const limit = perMinute(2)
  expect([limit.take(0), limit.take(1000), limit.take(2000)]).toEqual([true, true, false])
  expect(limit.take(60_000)).toBe(false)
  expect(limit.take(60_001)).toBe(true)
  expect(limit.take(60_002)).toBe(false)
  limit.clear()
  expect([limit.take(60_003), limit.take(60_004), limit.take(60_005)]).toEqual([true, true, false])
})
