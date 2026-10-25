// What the host's transcript draws for a finished tool call, worked out from the call and its stored
// result: `Label(args)` and the line, diff, preview or output under it. No `$` in here.

import type { PairSpan, PairToolView } from '../../types'

const ARGS_CAP = 240
const LINE_CAP = 400
const OUTPUT_LINES_CAP = 40
const DIFF_CHARS_CAP = 30_000
// The transcript previews a written file's first 10 lines.
const PREVIEW_LINES = 10

const clip = (text: string, cap: number): string => (text.length > cap ? `${text.slice(0, cap - 1)}…` : text)

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null
const textOf = (x: unknown): string => (typeof x === 'string' ? x : '')
const numberOf = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
const counted = (n: number, one: string, many: string): string => (n === 1 ? one : many)
const plain = (text: string): PairSpan => ({ text, isBold: false })
const bold = (text: string): PairSpan => ({ text, isBold: true })

// Paths under the session's folder are drawn relative to it, as the transcript draws them.
export const relativeTo = (path: string, cwd: string): string => {
  const root = cwd.replace(/\/+$/, '')
  if (!root || !path.startsWith('/')) return path
  return path === root ? '.' : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

const linesOf = (text: string): string[] => {
  const trimmed = text.replace(/\s+$/, '')
  return trimmed ? trimmed.split(/\r?\n/) : []
}

const outputOf = (text: string): Pick<PairToolView, 'output' | 'totalLines'> => {
  const lines = linesOf(text)
  return { output: lines.slice(0, OUTPUT_LINES_CAP).map(line => clip(line, LINE_CAP)), totalLines: lines.length }
}

// Unified-diff hunks from a stored `structuredPatch`, cut only between hunks so it still parses.
const diffOf = (hunks: unknown): { source: string; added: number; removed: number; moreLines: number } | null => {
  if (!Array.isArray(hunks)) return null
  const kept: string[] = []
  let added = 0
  let removed = 0
  let moreLines = 0
  let size = 0
  for (const hunk of hunks) {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) continue
    const lines = hunk.lines.filter((line): line is string => typeof line === 'string')
    added += lines.filter(line => line.startsWith('+')).length
    removed += lines.filter(line => line.startsWith('-')).length
    const header = `@@ -${numberOf(hunk.oldStart)},${numberOf(hunk.oldLines)} +${numberOf(hunk.newStart)},${numberOf(hunk.newLines)} @@`
    const body = lines.map(line => clip(line, LINE_CAP))
    const cost = header.length + body.reduce((sum, line) => sum + line.length + 1, 0)
    if (size + cost > DIFF_CHARS_CAP) {
      // A hunk that alone is over the cap keeps what fits; any later one is counted, not drawn.
      const room = kept.length > 0 ? 0 : DIFF_CHARS_CAP - header.length
      const fit: string[] = []
      let used = 0
      for (const line of body) {
        if (used + line.length + 1 > room) break
        fit.push(line)
        used += line.length + 1
      }
      if (fit.length > 0) kept.push(header, ...fit)
      size += fit.length > 0 ? header.length + used : 0
      moreLines += lines.length - fit.length
      continue
    }
    kept.push(header, ...body)
    size += cost
  }
  return kept.length > 0 ? { source: kept.join('\n'), added, removed, moreLines } : null
}

const changeSummary = (added: number, removed: number): PairSpan[] => [
  ...(added > 0 ? [plain('Added '), bold(String(added)), plain(` ${counted(added, 'line', 'lines')}`)] : []),
  ...(added > 0 && removed > 0 ? [plain(', ')] : []),
  ...(removed > 0 ? [plain(`${added === 0 ? 'R' : 'r'}emoved `), bold(String(removed)), plain(` ${counted(removed, 'line', 'lines')}`)] : [])
]

const sizeOf = (bytes: number): string =>
  bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / (1024 * 1024)).toFixed(1)}MB`

const quoted = (value: unknown): string => (typeof value === 'string' ? `"${value}"` : JSON.stringify(value) ?? '')

// The generic `key: "value", key: 42` form the transcript gives a tool without its own renderer.
const argsOf = (input: unknown): string =>
  isRecord(input)
    ? Object.entries(input)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}: ${quoted(value)}`)
        .join(', ')
    : ''

const viewArgs = (text: string): string => clip(text.replace(/\s*\n[\s\S]*$/, '…'), ARGS_CAP)

const bare = (label: string, args: string): PairToolView => ({
  label,
  args: viewArgs(args),
  group: null,
  summary: null,
  output: [],
  totalLines: 0,
  code: null
})

// A call's label and arguments, the same whether it worked or failed.
const headOf = (tool: string, args: Record<string, unknown>, path: (key: string) => string, input: unknown): PairToolView => {
  switch (tool) {
    case 'Bash': {
      const description = viewArgs(textOf(args.description))
      return { ...bare('Bash', textOf(args.command)), ...(description ? { description } : {}) }
    }
    case 'Read':
      return { ...bare('Read', path('file_path')), group: 'read' }
    case 'Grep':
    case 'Glob':
      return { ...bare('Search', `pattern: ${quoted(textOf(args.pattern))}${args.path ? `, path: ${quoted(path('path'))}` : ''}`), group: 'search' }
    case 'Edit':
    case 'MultiEdit':
      return bare('Update', path('file_path'))
    case 'Write':
      return bare('Write', path('file_path'))
    case 'WebFetch':
      return bare('Fetch', textOf(args.url))
    case 'WebSearch':
      return bare('Web Search', quoted(textOf(args.query)))
    default: {
      const mcp = /^mcp__([^_].*?)__(.+)$/.exec(tool)
      return bare(mcp ? `${mcp[1]} - ${mcp[2]} (MCP)` : tool, argsOf(input))
    }
  }
}

// What the host's transcript draws for one finished tool call, from its input and stored result.
export const toolViewOf = (tool: string, input: unknown, result: unknown, text: string, isError: boolean, cwd: string): PairToolView => {
  const args = isRecord(input) ? input : {}
  const record = isRecord(result) ? result : {}
  const path = (key: string) => relativeTo(textOf(args[key]), cwd)
  const head = headOf(tool, args, path, input)
  if (isError) return { ...head, ...outputOf(text) }
  const changed = (label: string): PairToolView => {
    const diff = diffOf(record.structuredPatch)
    return {
      ...bare(label, path('file_path')),
      summary: diff ? changeSummary(diff.added, diff.removed) : null,
      code: diff ? { source: diff.source, path: path('file_path'), format: 'diff', moreLines: diff.moreLines } : null,
      ...(diff ? { added: diff.added, removed: diff.removed } : {})
    }
  }
  switch (tool) {
    case 'Bash': {
      const out = [textOf(record.stdout), textOf(record.stderr)].filter(Boolean).join('\n') || (isRecord(result) ? '' : text)
      return { ...head, ...outputOf(out) }
    }
    case 'Read':
    case 'Grep':
    case 'Glob':
      return head
    case 'Edit':
    case 'MultiEdit':
      return changed('Update')
    case 'Write': {
      if (record.type === 'update') return changed('Update')
      const lines = linesOf(textOf(args.content))
      return {
        ...head,
        summary: [plain('Wrote '), bold(String(lines.length)), plain(` ${counted(lines.length, 'line', 'lines')} to `), bold(path('file_path'))],
        code: {
          source: lines.slice(0, PREVIEW_LINES).map(line => clip(line, LINE_CAP)).join('\n'),
          path: path('file_path'),
          format: 'source',
          moreLines: Math.max(0, lines.length - PREVIEW_LINES)
        },
        added: lines.length,
        removed: 0
      }
    }
    case 'WebFetch':
      return { ...head, summary: [plain(`Received ${sizeOf(numberOf(record.bytes))} (${numberOf(record.code)} ${textOf(record.codeText)})`)] }
    case 'WebSearch': {
      const searches = numberOf(record.searchCount) || 1
      return { ...head, summary: [plain(`Did ${searches} ${counted(searches, 'search', 'searches')} in ${Math.round(numberOf(record.durationSeconds))}s`)] }
    }
    default:
      return { ...head, ...outputOf(text) }
  }
}
