import { expect, test } from 'claude-code/testing'

import { durationOf } from '../../hooks/display/style/terminal'

test('a turn is timed as Claude Code times it', () => {
  expect([0, 999, 3000, 59_999].map(durationOf)).toEqual(['0s', '0s', '3s', '59s'])
  expect([60_000, 64_000, 3_599_000].map(durationOf)).toEqual(['1m 0s', '1m 4s', '59m 59s'])
  expect([3_600_000, 7_380_000].map(durationOf)).toEqual(['1h 0m', '2h 3m'])
  expect([-500, Number.NaN, Number.POSITIVE_INFINITY].map(durationOf)).toEqual(['0s', '0s', '0s'])
})
