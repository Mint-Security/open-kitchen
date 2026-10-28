import type { PairEvent } from '../../types'

const BATCH_BYTES = 96_000

const utf8 = new TextEncoder()

export const batchesOf = (events: PairEvent[]): PairEvent[][] => {
  const batches: PairEvent[][] = []
  let batch: PairEvent[] = []
  let size = 0
  for (const next of events) {
    const cost = utf8.encode(JSON.stringify(next)).length
    if (batch.length > 0 && size + cost > BATCH_BYTES) {
      batches.push(batch)
      batch = []
      size = 0
    }
    batch.push(next)
    size += cost
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

export type PerMinute = { take: (nowMs: number) => boolean; clear: () => void }

export const perMinute = (limit: number): PerMinute => {
  const times: number[] = []
  return {
    take: nowMs => {
      while (times.length > 0 && nowMs - (times[0] ?? 0) > 60_000) times.shift()
      if (times.length >= limit) return false
      times.push(nowMs)
      return true
    },
    clear: () => {
      times.length = 0
    }
  }
}
