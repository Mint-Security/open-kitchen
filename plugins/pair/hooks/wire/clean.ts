import type { PairToolView } from '../../types'

// Everything that arrives from the other side is untrusted text: it is shown to a person (and, for a
// guest's proposal, forwarded to a model), so strip whatever a screen draws as nothing or reorders:
// controls, format characters (bidi, Unicode tags), default-ignorables (variation selectors, fillers),
// lone surrogates and the line separators a terminal ignores.
const HIDDEN = /(?![\n\t])[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu
// Combining marks stack: a few are writing, a pile is a smear over the rows around it.
const MARK_PILE = /(\p{M}{3})\p{M}+/gu

// Cut at `max` UTF-16 units without leaving half a surrogate pair behind.
const cut = (text: string, max: number): string => {
  const head = text.slice(0, max)
  return /[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head
}

export const cleanText = (text: string, max: number): string =>
  cut(text.replace(/\r\n?/g, '\n').replace(HIDDEN, '').replace(MARK_PILE, '$1').replace(/[\p{Zs}\t]+$/gmu, '').replace(/\n{3,}/g, '\n\n').trim(), max)

// Names that read as someone else in a transcript: the model, the engine, the person at the keyboard.
const RESERVED_NAMES = new Set(['claude', 'assistant', 'system', 'anthropic', 'host', 'guest', 'you', 'user', 'pair'])

// A person's name, which the other side picks and which lands in text the model reads: letters, marks,
// digits, spaces and . _ ' - only, and none of the reserved ones.
export const cleanName = (name: string, fallback: string): string => {
  const kept = cut(cleanText(name, 200).replace(/\s+/g, ' ').replace(/[^\p{L}\p{M}\p{N} ._'-]/gu, '').replace(/ {2,}/g, ' ').trim(), 32).trim()
  return kept && !RESERVED_NAMES.has(kept.toLowerCase()) ? kept : fallback
}

// A tool's name as the host's session spells it (`Bash`, `mcp__server__tool`).
export const cleanToolName = (name: string): string => cut(name.replace(/[^\w.:-]/g, ''), 80)

// Like cleanText, but leaves spacing and blank lines alone: a span's edges and a file's lines matter.
const stripHidden = (text: string, max: number): string => cut(text.replace(/\r\n?/g, '\n').replace(HIDDEN, ''), max)
const oneLine = (text: string, max: number): string => stripHidden(text, max).replace(/\s*\n\s*/g, ' ')

// A count from the other side, kept whole and within reason (JSON can carry 1e400, which parses as Infinity).
const countOf = (n: number, min: number): number => (Number.isFinite(n) ? Math.min(1e9, Math.max(min, Math.floor(n))) : min)

export const cleanView = (view: PairToolView): PairToolView => ({
  label: oneLine(view.label, 120).trim() || 'Tool',
  args: oneLine(view.args, 400),
  group: view.group,
  summary: view.summary ? view.summary.map(span => ({ text: oneLine(span.text, 400), isBold: span.isBold })) : null,
  output: view.output.map(line => oneLine(line, 1000)),
  totalLines: countOf(view.totalLines, -1),
  code: view.code
    ? {
        source: stripHidden(view.code.source, 100_000),
        path: oneLine(view.code.path, 300),
        format: view.code.format,
        moreLines: countOf(view.code.moreLines, 0)
      }
    : null,
  ...(view.description === undefined ? {} : { description: oneLine(view.description, 400) }),
  ...(view.added === undefined ? {} : { added: countOf(view.added, 0) }),
  ...(view.removed === undefined ? {} : { removed: countOf(view.removed, 0) })
})
