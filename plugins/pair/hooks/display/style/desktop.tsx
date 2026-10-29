// How Claude Code's desktop app draws a conversation: prompts in a bubble on the right, replies as text,
// every run of tool calls one row that opens on a click. A row is labelled as the app labels it ("Ran 4
// commands", "Created pane.tsx +154 -0"), by its own rules and words, so a guest on a desktop surface
// reads what a desktop shows. The app also writes a sentence for some runs; those never reach a plugin.

import type { RenderElement } from 'claude-code'

import type { PairEntry, PairToolView } from '../../../types'
import { COLORS } from './colors'
import { drawEntry, drawTool } from './terminal'
import type { ToolEntry } from './terminal'
import type { Elements, TranscriptOptions } from './transcript'

export type DesktopTool = { tool: string; view: PairToolView; isError: boolean }

type Category = 'read' | 'write' | 'edit' | 'notebook_edit' | 'grep' | 'glob' | 'web' | 'bash' | 'task' | 'skill' | 'todo' | 'kill_bash' | 'unknown'

const CATEGORIES: Readonly<Record<string, Category>> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'notebook_edit',
  Grep: 'grep',
  Glob: 'glob',
  WebFetch: 'web',
  WebSearch: 'web',
  Bash: 'bash',
  Task: 'task',
  Agent: 'task',
  Skill: 'skill',
  TodoWrite: 'todo',
  KillShell: 'kill_bash'
}

const PHRASES: Readonly<Record<Category, (n: number) => string>> = {
  read: n => (n === 1 ? 'Read a file' : `Read ${n} files`),
  write: n => (n === 1 ? 'Created a file' : `Created ${n} files`),
  edit: n => (n === 1 ? 'Edited a file' : `Edited ${n} files`),
  notebook_edit: n => (n === 1 ? 'Edited a notebook' : `Edited ${n} notebooks`),
  grep: n => (n === 1 ? 'Searched code' : `Searched ${n} patterns`),
  glob: n => (n === 1 ? 'Found files' : `Searched ${n} patterns`),
  web: () => 'Searched the web',
  bash: n => (n === 1 ? 'Ran a command' : `Ran ${n} commands`),
  task: n => (n === 1 ? 'Ran an agent' : `Ran ${n} agents`),
  skill: n => (n === 1 ? 'Used a skill' : `Used ${n} skills`),
  todo: () => 'Updated todo list',
  kill_bash: n => (n === 1 ? 'Stopped a command' : `Stopped ${n} commands`),
  unknown: n => (n === 1 ? 'Used a tool' : `Used ${n} tools`)
}

// Changes first, then reads and searches, then the rest; files count once however often touched.
const TIERS: Readonly<Partial<Record<Category, number>>> = { write: 1, edit: 1, notebook_edit: 1, read: 3, grep: 3, glob: 3, web: 3 }
const FILE_CATEGORIES: ReadonlySet<Category> = new Set(['read', 'write', 'edit', 'notebook_edit'])

const categoryOf = (tool: string): Category => CATEGORIES[tool] ?? 'unknown'

const fileName = (path: string): string => path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? path

const sizeOf = (view: PairToolView): string => (view.added === undefined ? '' : ` +${view.added} -${view.removed ?? 0}`)

const singleLabel = ({ tool, view, isError }: DesktopTool): string => {
  const category = categoryOf(tool)
  if (isError) return category === 'bash' ? 'Command failed' : 'Failed'
  switch (category) {
    case 'bash':
      return view.description || PHRASES.bash(1)
    case 'read':
      return view.args ? `Read ${fileName(view.args)}` : PHRASES.read(1)
    case 'write':
      return view.args ? `${view.label === 'Update' ? 'Edited' : 'Created'} ${fileName(view.args)}${sizeOf(view)}` : PHRASES.write(1)
    case 'edit':
      return view.args ? `Edited ${fileName(view.args)}${sizeOf(view)}` : PHRASES.edit(1)
    default:
      return PHRASES[category](1)
  }
}

export const desktopLabelOf = (tools: readonly DesktopTool[]): string => {
  const [only] = tools
  if (tools.length === 1 && only) return singleLabel(only)
  const groups = tools.reduce((all, { tool, view }) => {
    const category = categoryOf(tool)
    const group = all.get(category) ?? { count: 0, paths: new Set<string>(), pathless: 0, first: all.size }
    const isFile = FILE_CATEGORIES.has(category)
    return new Map(all).set(category, {
      count: group.count + 1,
      paths: isFile && view.args ? new Set([...group.paths, view.args]) : group.paths,
      pathless: group.pathless + (isFile && !view.args ? 1 : 0),
      first: group.first
    })
  }, new Map<Category, { count: number; paths: ReadonlySet<string>; pathless: number; first: number }>())
  const parts = [...groups]
    .map(([category, group]) => ({
      label: PHRASES[category](FILE_CATEGORIES.has(category) ? group.paths.size + group.pathless : group.count),
      count: group.count,
      tier: TIERS[category] ?? 4,
      first: group.first
    }))
    .sort((a, b) => a.tier - b.tier || b.count - a.count || a.first - b.first)
  const shown = parts.slice(0, parts.length > 3 ? 2 : 3)
  const rest = parts.slice(shown.length).reduce((sum, part) => sum + part.count, 0)
  const joined = shown.map((part, index) => (index === 0 ? part.label : `${part.label.charAt(0).toLowerCase()}${part.label.slice(1)}`)).join(', ')
  return rest > 0 ? `${joined}, and ${rest} more ${rest === 1 ? 'step' : 'steps'}` : joined
}

type DesktopRow = { kind: 'entry'; entry: PairEntry } | { kind: 'tools'; id: string; entries: ToolEntry[] }

export const desktopRowsOf = (entries: readonly PairEntry[]): DesktopRow[] => {
  const rows: DesktopRow[] = []
  for (const entry of entries) {
    const last = rows.at(-1)
    if (entry.kind !== 'tool') rows.push({ kind: 'entry', entry })
    else if (last?.kind === 'tools') last.entries.push(entry)
    else rows.push({ kind: 'tools', id: entry.id, entries: [entry] })
  }
  return rows
}

const drawBubble = (ui: Elements, key: string, text: string) => {
  const { Box, Markdown } = ui
  return (
    <Box key={key} flexDirection="row" justifyContent="flex-end">
      <Box flexDirection="column" backgroundColor={COLORS.userMessage} borderStyle="round" borderColor={COLORS.userMessage} paddingX={2} paddingY={1}>
        <Markdown text={text} />
      </Box>
    </Box>
  )
}

const drawToolRow = (ui: Elements, row: { id: string; entries: ToolEntry[] }, options: TranscriptOptions) => {
  const { Box, Button, Text } = ui
  const label = desktopLabelOf(row.entries)
  const isOpen = options.isAllExpanded === true || options.expanded?.has(row.id) === true
  const onToggle = options.onToggle
  return (
    <Box key={row.id} flexDirection="column" gap={1}>
      {Button && onToggle ? (
        <Button key={`${options.keys ?? 'pair'}-tools-${row.id}`} plain dimColor label={`${label} ${isOpen ? '⌄' : '›'}`} onPress={() => onToggle(row.id)} />
      ) : (
        <Text dimColor>{label}</Text>
      )}
      {isOpen && (
        <Box flexDirection="column" paddingLeft={2} gap={1}>
          {row.entries.map(entry => drawTool(ui, entry, options))}
        </Box>
      )}
    </Box>
  )
}

export const drawDesktop = (ui: Elements, entries: readonly PairEntry[], options: TranscriptOptions): RenderElement[] =>
  desktopRowsOf(entries).map(row => {
    if (row.kind === 'tools') return drawToolRow(ui, row, options)
    const { entry } = row
    switch (entry.kind) {
      case 'user':
        return drawBubble(ui, entry.id, entry.text)
      case 'proposal':
        return drawBubble(ui, entry.id, `${entry.from === 'me' ? options.me : entry.author}: ${entry.text}`)
      case 'assistant': {
        const { Box, Markdown } = ui
        return (
          <Box key={entry.id} flexDirection="column">
            <Markdown text={entry.text} />
          </Box>
        )
      }
      default:
        return drawEntry(ui, entry, options)
    }
  })
