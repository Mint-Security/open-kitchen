import { expect, test } from 'claude-code/testing'

import { is } from '../hooks/schema'

test('the plain checks take only their own kind of value', () => {
  const cases: [(x: unknown) => boolean, unknown[], unknown[]][] = [
    [is.string, ['', 'a'], [1, null, undefined, ['a']]],
    [is.number, [0, -1.5], ['1', null, true]],
    [is.boolean, [true, false], [0, 'true', null]],
    [is.integer(0), [0, 7], [-1, 1.5, '3', null]],
    [is.literal('a', 'b', null), ['a', 'b', null], ['c', undefined, 0]],
    [is.matching(/^[a-z]+$/, 3), ['abc'], ['abcd', 'AB', 1]],
    [is.plainObject, [{}, { a: 1 }], [null, [], 'x']]
  ]
  for (const [check, good, bad] of cases) {
    for (const x of good) expect(check(x)).toBe(true)
    for (const x of bad) expect(check(x)).toBe(false)
  }
})

test('the composed checks check every part, and only the parts they name', () => {
  const point = is.object({ x: is.number, label: is.optional(is.string), tag: is.nullable(is.string) })
  expect(point({ x: 1, tag: null })).toBe(true)
  expect(point({ x: 1, label: 'a', tag: 'b', extra: true })).toBe(true)
  expect(point({ x: 1, label: 2, tag: null })).toBe(false)
  expect(point({ label: 'a', tag: null })).toBe(false)
  expect(point([1])).toBe(false)

  expect(is.arrayOf(is.number, 2)([1, 2])).toBe(true)
  expect(is.arrayOf(is.number, 2)([1, 2, 3])).toBe(false)
  expect(is.arrayOf(is.number)([1, '2'])).toBe(false)
  expect(is.recordOf(is.boolean)({ a: true, b: false })).toBe(true)
  expect(is.recordOf(is.boolean)({ a: true, b: 'no' })).toBe(false)

  const shape = is.oneOf(is.object({ kind: is.literal('a'), n: is.number }), is.object({ kind: is.literal('b') }))
  expect(shape({ kind: 'a', n: 1 })).toBe(true)
  expect(shape({ kind: 'b' })).toBe(true)
  expect(shape({ kind: 'a' })).toBe(false)
  expect(shape({ kind: 'c' })).toBe(false)
})
