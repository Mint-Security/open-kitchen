// What a tip is. Every kind has one row here: whose it is, which area of the settings turns it off,
// and how it shows. An id starts with its kind, then the session or project it is about (a limit
// tip names its window instead). Pure functions, no `$`.

export type Area = 'cache' | 'context' | 'limits'

// session, project or account: most tips belong to the session that raised it, a few to its project,
// the limit tips to the account. Quiet tips show in the pane only: worth knowing, not worth
// interrupting for. News reports what a turn just did, so it leaves the band when the next message goes.
type KindFacts = { scope: 'session' | 'project' | 'account'; area: Area; isQuiet?: true; isNews?: true }

const KINDS = {
  recache: { scope: 'session', area: 'cache', isNews: true },
  switch: { scope: 'session', area: 'cache', isNews: true },
  expired: { scope: 'session', area: 'cache' },
  'warm-compact': { scope: 'session', area: 'cache' },
  ttl: { scope: 'session', area: 'cache' },
  context: { scope: 'session', area: 'context' },
  'context-high': { scope: 'session', area: 'context' },
  growth: { scope: 'session', area: 'context', isNews: true },
  breakpoint: { scope: 'session', area: 'context' },
  reread: { scope: 'session', area: 'context' },
  mcp: { scope: 'session', area: 'context', isQuiet: true },
  memory: { scope: 'project', area: 'context' },
  dupes: { scope: 'project', area: 'context' },
  'rate-limit': { scope: 'account', area: 'limits' },
  wall: { scope: 'account', area: 'limits' },
  'model-fit': { scope: 'session', area: 'limits' },
  'model-start': { scope: 'session', area: 'limits' },
  budget: { scope: 'session', area: 'limits' },
} as const satisfies Record<string, KindFacts>

export type TipKind = keyof typeof KINDS

// What a tip's button does, where it has one: compacting is the person's call, never Dividend's.
type TipAction = 'compact'

export type Tip = { id: string; kind: TipKind; title: string; body: string; action?: TipAction }

const KIND_NAMES: ReadonlySet<string> = new Set(Object.keys(KINDS))

const factsOf = (kind: TipKind): KindFacts => KINDS[kind]

export const tipKindOf = (id: string): TipKind | null => {
  const kind = /^tip:([a-z-]+):/.exec(id)?.[1]
  return kind !== undefined && KIND_NAMES.has(kind) ? (kind as TipKind) : null
}

export const areaOf = (kind: TipKind): Area => factsOf(kind).area

export const isQuietTip = (id: string): boolean => {
  const kind = tipKindOf(id)
  return kind !== null && factsOf(kind).isQuiet === true
}

export const isNewsTip = (id: string): boolean => {
  const kind = tipKindOf(id)
  return kind !== null && factsOf(kind).isNews === true
}

export const isTipHere = (id: string, here: { sessionKey: string; projectKey: string }): boolean => {
  const kind = tipKindOf(id)
  if (kind === null) return false
  const scope = factsOf(kind).scope
  if (scope === 'account') return true
  return id.split(':')[2] === (scope === 'session' ? here.sessionKey : here.projectKey)
}

// A limit tip about a window that has since reset no longer holds.
export const isPastLimitTip = (id: string, now: number): boolean => {
  const match = /^tip:(?:rate-limit|wall):[^:]+:(.+)$/.exec(id)
  const resetsAt = match?.[1] ? Date.parse(match[1]) : Number.NaN
  return Number.isFinite(resetsAt) && resetsAt <= now
}
