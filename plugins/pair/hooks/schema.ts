export type Check<T> = (x: unknown) => x is T
export type Checked<C> = C extends Check<infer T> ? T : never

type Shape = Record<string, Check<unknown>>
type ShapeOf<S extends Shape> = { [K in keyof S]: Checked<S[K]> }

const isPlainObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

export const is = {
  unknown: (_x: unknown): _x is unknown => true,
  string: (x: unknown): x is string => typeof x === 'string',
  number: (x: unknown): x is number => typeof x === 'number',
  boolean: (x: unknown): x is boolean => typeof x === 'boolean',
  plainObject: isPlainObject,
  integer:
    (min: number): Check<number> =>
    (x): x is number =>
      Number.isInteger(x) && (x as number) >= min,
  literal:
    <L extends readonly (string | number | boolean | null)[]>(...values: L): Check<L[number]> =>
    (x): x is L[number] =>
      values.includes(x as L[number]),
  matching:
    (pattern: RegExp, maxLength = Number.POSITIVE_INFINITY): Check<string> =>
    (x): x is string =>
      typeof x === 'string' && x.length <= maxLength && pattern.test(x),
  nullable:
    <T>(check: Check<T>): Check<T | null> =>
    (x): x is T | null =>
      x === null || check(x),
  optional:
    <T>(check: Check<T>): Check<T | undefined> =>
    (x): x is T | undefined =>
      x === undefined || check(x),
  arrayOf:
    <T>(check: Check<T>, max = Number.POSITIVE_INFINITY): Check<T[]> =>
    (x): x is T[] =>
      Array.isArray(x) && x.length <= max && x.every(check),
  recordOf:
    <T>(check: Check<T>): Check<Record<string, T>> =>
    (x): x is Record<string, T> =>
      isPlainObject(x) && Object.values(x).every(check),
  object:
    <S extends Shape>(shape: S): Check<ShapeOf<S>> =>
    (x): x is ShapeOf<S> =>
      isPlainObject(x) && Object.entries(shape).every(([key, check]) => check(x[key])),
  oneOf:
    <C extends readonly Check<unknown>[]>(...checks: C): Check<Checked<C[number]>> =>
    (x): x is Checked<C[number]> =>
      checks.some(check => check(x))
}
