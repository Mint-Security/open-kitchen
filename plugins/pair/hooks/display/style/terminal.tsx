// How Claude Code draws a conversation in a terminal: the prompt on a grey band, a bullet before each
// reply and tool call, what a tool returned hung under `⎿`, reads and searches folded into one line.

import type { RenderElement } from 'claude-code'

import type { PairEntry, PairSpan, PairToolView } from '../../../types'
import type { Elements, TranscriptOptions } from './transcript'

// As the transcript does: tool output wrapped ten columns short of the width, three lines of it shown
// (four when that is all there is).
const FOLD_LINES = 3
const WRAP_MARGIN = 10
// The transcript's user-message band; no theme key carries it, so this is the dark theme's.
const PROMPT_BAND = '#373737'
const HUNG = '  ⎿  '

export const moreLines = (n: number): string => `… +${n} ${n === 1 ? 'line' : 'lines'}`

export const foldOutput = (lines: readonly string[], totalLines: number, columns: number): { shown: string[]; hidden: number } => {
  const width = Math.max(columns - WRAP_MARGIN, 10)
  const wrapped = lines.flatMap(line => {
    const parts: string[] = []
    for (let at = 0; at < Math.max(line.length, 1); at += width) parts.push(line.slice(at, at + width))
    return parts
  })
  const rest = wrapped.length - FOLD_LINES + Math.max(0, totalLines - lines.length)
  if (rest <= 0) return { shown: wrapped, hidden: 0 }
  if (rest === 1 && wrapped.length > FOLD_LINES) return { shown: wrapped.slice(0, FOLD_LINES + 1), hidden: 0 }
  return { shown: wrapped.slice(0, FOLD_LINES), hidden: rest }
}

const plain = (text: string): PairSpan => ({ text, isBold: false })
const bold = (text: string): PairSpan => ({ text, isBold: true })

// `Searched for 2 patterns, read 3 files`: searches first, whatever order the calls came in.
export const groupSummary = (views: readonly PairToolView[]): PairSpan[] => {
  const parts = (['search', 'read'] as const).flatMap(group => {
    if (!views.some(view => view.group === group)) return []
    const n = views.filter(view => view.group === group).length
    if (group === 'search') return [[plain('searched for '), bold(String(n)), plain(` ${n === 1 ? 'pattern' : 'patterns'}`)]]
    if (group === 'read') return [[plain('read '), bold(String(n)), plain(` ${n === 1 ? 'file' : 'files'}`)]]
    return []
  })
  const spans = parts.flatMap((part, index) => (index === 0 ? part : [plain(', '), ...part]))
  const first = spans[0]
  return first ? [{ ...first, text: first.text.charAt(0).toUpperCase() + first.text.slice(1) }, ...spans.slice(1)] : []
}

export type ToolEntry = Extract<PairEntry, { kind: 'tool' }>

type Row = { kind: 'entry'; entry: PairEntry } | { kind: 'group'; id: string; views: PairToolView[] }

// Consecutive reads and searches become one row.
export const rowsOf = (entries: readonly PairEntry[]): Row[] => {
  const rows: Row[] = []
  for (const entry of entries) {
    const view = entry.kind === 'tool' && !entry.isError ? entry.view : undefined
    const last = rows.at(-1)
    if (view?.group) {
      if (last?.kind === 'group') last.views.push(view)
      else rows.push({ kind: 'group', id: entry.id, views: [view] })
    } else {
      rows.push({ kind: 'entry', entry })
    }
  }
  return rows
}

const spanText = (Text: Elements['Text'], spans: readonly PairSpan[], props: { dimColor?: boolean }) => (
  <Text wrap="wrap" {...props}>
    {spans.map((span, index) =>
      span.isBold ? (
        <Text key={`s${index}`} bold {...props}>
          {span.text}
        </Text>
      ) : (
        span.text
      )
    )}
  </Text>
)

const hung = (ui: Elements, key: string, children: RenderElement | RenderElement[]) => {
  const { Box, Text } = ui
  return (
    <Box key={key} flexDirection="row">
      <Text dimColor>{HUNG}</Text>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  )
}

const drawResult = (ui: Elements, entry: ToolEntry, columns: number): RenderElement | null => {
  const { Code, Text } = ui
  const view = entry.view
  if (view.totalLines < 0) return null
  if (entry.isError || view.output.length > 0) {
    const { shown, hidden } = foldOutput(view.output, view.totalLines, columns)
    return hung(ui, `${entry.id}:out`, [
      <Text key="o" wrap="wrap" color={entry.isError ? 'error' : undefined} dimColor={!entry.isError}>
        {shown.join('\n')}
      </Text>,
      ...(hidden > 0 ? [<Text key="m" dimColor>{moreLines(hidden)}</Text>] : [])
    ])
  }
  if (view.summary) {
    const code = view.code
    return hung(ui, `${entry.id}:sum`, [
      <Text key="s">{spanText(Text, view.summary, {})}</Text>,
      ...(code
        ? [
            <Code
              key="c"
              source={code.source}
              path={code.path || undefined}
              format={code.format}
              startLine={code.format === 'source' ? 1 : undefined}
            />,
            ...(code.moreLines > 0 ? [<Text key="m" dimColor>{moreLines(code.moreLines)}</Text>] : [])
          ]
        : [])
    ])
  }
  return view.label === 'Bash' ? hung(ui, `${entry.id}:none`, <Text dimColor>(No content)</Text>) : null
}

export const drawTool = (ui: Elements, entry: ToolEntry, options: TranscriptOptions) => {
  const { Box, Text } = ui
  const view = entry.view
  const result = drawResult(ui, entry, options.columns)
  return (
    <Box key={entry.id} flexDirection="column">
      <Box flexDirection="row">
        <Text color={entry.isError ? 'error' : 'success'}>{`${options.bullet} `}</Text>
        <Box flexGrow={1}>
          <Text bold wrap="wrap">
            {view.args ? `${view.label}(${view.args})` : view.label}
          </Text>
        </Box>
      </Box>
      {result}
    </Box>
  )
}

// The transcript draws a prompt as markdown, unless it is long.
const PROMPT_MARKDOWN_MAX = 4000

const drawPrompt = (ui: Elements, key: string, text: string) => {
  const { Box, Markdown, Text } = ui
  return (
    <Box key={key} flexDirection="row" backgroundColor={PROMPT_BAND} paddingRight={1}>
      <Text color="inactive">❯ </Text>
      <Box flexDirection="column" flexGrow={1}>
        {text.length <= PROMPT_MARKDOWN_MAX ? (
          <Markdown text={text} />
        ) : (
          <Text color="text" wrap="wrap">
            {text}
          </Text>
        )}
      </Box>
    </Box>
  )
}

export const drawEntry = (ui: Elements, entry: PairEntry, options: TranscriptOptions): RenderElement => {
  const { Box, Markdown, Text } = ui
  switch (entry.kind) {
    case 'assistant':
      return (
        <Box key={entry.id} flexDirection="row">
          <Text>{`${options.bullet} `}</Text>
          <Box flexDirection="column" flexGrow={1}>
            <Markdown text={entry.text} />
          </Box>
        </Box>
      )
    case 'user':
      return drawPrompt(ui, entry.id, entry.text)
    case 'proposal':
      return drawPrompt(ui, entry.id, `${entry.from === 'me' ? options.me : entry.author}: ${entry.text}`)
    case 'tool':
      return drawTool(ui, entry, options)
    case 'decision':
      return (
        <Text key={entry.id} dimColor={!entry.isError} color={entry.isError ? 'error' : undefined}>
          {`${HUNG}${entry.text}`}
        </Text>
      )
    default:
      return (
        <Text key={entry.id} dimColor>
          {`· ${entry.text}`}
        </Text>
      )
  }
}

export const drawTerminal = (ui: Elements, entries: readonly PairEntry[], options: TranscriptOptions): RenderElement[] => {
  const { Box, Text } = ui
  return rowsOf(entries).map(row =>
    row.kind === 'group' ? (
      <Box key={row.id} paddingLeft={2}>
        {spanText(Text, groupSummary(row.views), { dimColor: true })}
      </Box>
    ) : (
      drawEntry(ui, row.entry, options)
    )
  )
}
