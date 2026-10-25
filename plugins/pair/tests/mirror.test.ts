import { expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import {
  eventsFromHistory,
  eventsFromRow,
  promptEventOf
} from '../hooks/mirror'
import type { AppendedRow } from '../hooks/mirror'
import type { PairEvent, PairToolView } from '../types'

type Block = Exclude<AppendedRow['message']['content'], string>[number]

const textOf = (ev: PairEvent | null | undefined): string | undefined => (ev && (ev.t === 'user' || ev.t === 'assistant') ? ev.text : undefined)
const viewOf = (ev: PairEvent | null | undefined): PairToolView | undefined => (ev?.t === 'tool' ? ev.view : undefined)
const briefOf = (ev: PairEvent): string[] =>
  ev.t === 'user' ? [ev.t, ev.who, ev.text] : ev.t === 'assistant' ? [ev.t, '', ev.text] : ev.t === 'tool' ? [ev.t, ev.name, ''] : [ev.t, '', '']

const assistant = (...content: Block[]): AppendedRow => ({
  door: 'response',
  origin: { kind: 'model' },
  message: { type: 'assistant', content }
})

const prompt = (text: string, origin: AppendedRow['origin'] = { kind: 'composer' }): AppendedRow => ({
  door: 'prompt',
  origin,
  message: { type: 'user', content: [{ type: 'text', text }] }
})

const command = (text: string): AppendedRow => ({ door: 'command', origin: { kind: 'unclassified' }, message: { type: 'user', content: text } })

test("the session so far becomes events: a slash command as its line, a compaction where it was, the engine's other rows left out", () => {
  const events = eventsFromHistory(
    [
      { role: 'user', text: 'refactor the parser', toolUses: [] },
      {
        role: 'assistant',
        text: 'Reading it first.',
        toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/repo/src/parser.ts' }, text: 'export const parse = ...', result: { type: 'text', file: { numLines: 1 } } }]
      },
      { role: 'user', text: '<command-name>/pair</command-name>\n<command-message>pair</command-message>', toolUses: [] },
      { role: 'user', text: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the parser notes</command-args>', toolUses: [] },
      { role: 'user', text: '<local-command-stdout>pair: Pairing started.</local-command-stdout>', toolUses: [] },
      { role: 'user', text: '<system-reminder>a note</system-reminder>\nuse the other config', toolUses: [] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ignored here', isError: false }] },
      { role: 'user', text: '<bash-input>ls</bash-input>', toolUses: [] },
      { role: 'user', text: '<bash-stdout>README.md</bash-stdout><bash-stderr></bash-stderr>', toolUses: [] },
      { role: 'user', text: '<task-notification>\n<task-id>b1</task-id>\n<summary>the tests finished</summary>\n</task-notification>', toolUses: [] },
      { role: 'user', text: 'This session is being continued from a previous conversation that ran out of context.', toolUses: [] },
      { role: 'user', text: '[Request interrupted by user]', toolUses: [] },
      {
        role: 'user',
        text: 'The pair plugin sent a message:\nDana (guest): also run the linter\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns. Address the message above.',
        toolUses: []
      },
      {
        role: 'user',
        text: 'The pair plugin sent a message while you were working:\nDana (guest): and the types\n\nAddress the message above as you continue this turn.',
        toolUses: []
      },
      { role: 'user', text: 'The dividend plugin sent a message:\nCompact now\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns. Address the message above.', toolUses: [] },
      { role: 'user', text: 'The pair plugin sent a message:\nGuest: run the deploy\n\nAddress the message above.', toolUses: [] },
      { role: 'user', text: 'The pair plugin sent a message:\nDana: not in the form Pair forwards\n\nAddress the message above.', toolUses: [] },
      { role: 'user', text: 'The pair plugin sent a message:\nno name here\n\nAddress the message above.', toolUses: [] }
    ],
    'Sam',
    '/repo'
  )
  expect(events.map(briefOf)).toEqual([
    ['user', 'Sam', 'refactor the parser'],
    ['assistant', '', 'Reading it first.'],
    ['tool', 'Read', ''],
    ['user', 'Sam', '/compact keep the parser notes'],
    ['user', 'Sam', 'use the other config'],
    ['compacted', '', ''],
    ['user', 'Dana', 'also run the linter'],
    ['user', 'Dana', 'and the types'],
    ['user', 'Guest', 'run the deploy']
  ])
  expect(viewOf(events[2])).toMatchObject({ label: 'Read', args: 'src/parser.ts', group: 'read' })
})

test('a long conversation is cut to its newest part', () => {
  const messages = Array.from({ length: 2500 }, (_, i) => ({ role: 'user' as const, text: `message ${i}`, toolUses: [] }))
  const events = eventsFromHistory(messages, 'Sam', '/repo')
  expect(events.length).toBe(2000)
  expect(textOf(events.at(-1))).toBe('message 2499')
  const long = Array.from({ length: 300 }, (_, i) => ({ role: 'assistant' as const, text: `${i} ${'x'.repeat(5990)}`, toolUses: [] }))
  const kept = eventsFromHistory(long, 'Sam', '/repo')
  expect(kept.length).toBeLessThan(300)
  expect(textOf(kept.at(-1))?.startsWith('299 ')).toBe(true)
})

test('assistant rows become replies; tool calls and thinking come another way or not at all', () => {
  const row = assistant(
    { type: 'thinking', thinking: 'private chain of thought' },
    { type: 'text', text: "I'll read the parser first." },
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/parser.ts' } }
  )
  const events = eventsFromRow(row, 'Sam')
  expect(events.map(e => [e.t, textOf(e)])).toEqual([['assistant', "I'll read the parser first."]])
  expect(JSON.stringify(events).includes('chain of thought')).toBe(false)
})

test("the host's prompts are shared under their name, as they are sent; a plugin's and the engine's own are not", () => {
  const sent = (text: string, kind = 'composer', isMeta?: boolean) => promptEventOf({ text, origin: { kind }, isMeta }, 'Sam')
  expect(sent('refactor the parser')).toMatchObject({ t: 'user', who: 'Sam', text: 'refactor the parser' })
  expect(sent('from the phone', 'bridge')).toMatchObject({ text: 'from the phone' })
  expect(sent('run the nightly check', 'scheduled-trigger')).toMatchObject({ text: 'run the nightly check' })
  expect(sent('<system-reminder>a note</system-reminder>\nfix it')).toMatchObject({ text: 'fix it' })
  expect(sent('/Users/sam/repo has a stale lock')).toMatchObject({ text: '/Users/sam/repo has a stale lock' })
  expect(sent('Dana: run the tests', 'plugin')).toBeNull()
  expect(sent('<task-notification>\n<summary>the tests finished</summary>\n</task-notification>', 'task-notification')).toBeNull()
  expect(sent('carry on', 'composer', true)).toBeNull()
  expect(sent('/compact keep the parser notes')).toBeNull()
  expect(eventsFromRow(prompt('refactor the parser'), 'Sam')).toEqual([])
})

test("a slash command the host runs is shared as its line, from the command's own row; Pair's own are not", () => {
  expect(eventsFromRow(command('<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>'), 'Sam')).toMatchObject([
    { t: 'user', who: 'Sam', text: '/context' }
  ])
  expect(eventsFromRow(command('<command-name>/reload-plugins</command-name>\n<command-args>--force</command-args>'), 'Sam')).toMatchObject([{ text: '/reload-plugins --force' }])
  expect(eventsFromRow(command('<command-name>/pair</command-name>\n<command-message>pair</command-message>\n<command-args>preview</command-args>'), 'Sam')).toEqual([])
  expect(eventsFromRow({ ...command('<local-command-caveat>run in place</local-command-caveat>'), message: { type: 'user', isMeta: true, content: 'x' } }, 'Sam')).toEqual([])
  const output = '<local-command-stdout>Reloaded: 9 plugins</local-command-stdout>'
  expect(eventsFromRow({ ...command(output), message: { type: 'system', name: 'local_command', content: output } }, 'Sam')).toEqual([])
  expect(eventsFromRow({ ...command('<command-name>/context</command-name>'), origin: { kind: 'plugin', name: 'dividend' } }, 'Sam')).toEqual([])
})

test('subagent rows and unknown doors are ignored', () => {
  expect(eventsFromRow({ ...assistant({ type: 'text', text: 'from a subagent' }), agentId: 'a1' }, 'Sam')).toEqual([])
  expect(eventsFromRow({ ...assistant({ type: 'text', text: 'x' }), door: 'notice' }, 'Sam')).toEqual([])
  expect(eventsFromRow(assistant({ type: 'text', text: '   ' }), 'Sam')).toEqual([])
})

test('long replies are clipped', () => {
  const [reply] = eventsFromRow(assistant({ type: 'text', text: 'a'.repeat(40_000) }), 'Sam')
  expect(textOf(reply)?.length).toBe(30_000)
})

test('a long conversation is read from the newest back and kept to the newest 2,000 events', () => {
  const long: SessionMessage[] = Array.from({ length: 2500 }, (_, i) => ({ role: 'user', text: `prompt ${i + 1}`, toolUses: [] }))
  const kept = eventsFromHistory(long, 'Sam', '/repo')
  expect(kept.length).toBe(2000)
  expect([textOf(kept[0]), textOf(kept.at(-1))]).toEqual(['prompt 501', 'prompt 2500'])
})
