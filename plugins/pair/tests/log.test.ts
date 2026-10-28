import { expect, test } from 'claude-code/testing'

import type { PairEntry, PairEvent } from '../types'
import { entriesOf, isProposalIn, lineOf, systemEntry } from '../hooks/session/log'
import { toolEventOf } from '../hooks/session/mirror'

const bash = toolEventOf('Bash', { command: 'npm test' }, { stdout: 'PASS\nmore', stderr: '' }, '', false, '/repo')

test("what arrives becomes the log's entries: cleaned, the guest's own messages left out, the compaction said", () => {
  const events: PairEvent[] = [
    { t: 'user', who: 'Sam\u202e', ref: null, text: 'refactor it' },
    { t: 'user', who: 'Dana', ref: 'm1', text: 'my own, sent back' },
    { t: 'assistant', text: '' },
    { t: 'compacted' },
    bash
  ]
  const entries = entriesOf('mid', events, new Set(['m1']), 'Host', 'h:')
  expect(entries.map(entry => [entry.id, entry.kind])).toEqual([
    ['h:mid:0', 'user'],
    ['h:mid:2', 'system'],
    ['h:mid:3', 'tool']
  ])
  expect(entries[0]).toMatchObject({ author: 'Sam', text: 'refactor it' })
  expect(entries[1]).toMatchObject({ text: "Earlier messages were compacted and aren't shown" })
  expect(entriesOf('m', [{ t: 'user', who: '', ref: null, text: 'hi' }], new Set(), 'Host', '')[0]).toMatchObject({ author: 'Host' })
})

test("/pair log draws one line per entry: long text cut, a tool by its call and first line", () => {
  const entries: PairEntry[] = [
    { id: 'a', kind: 'assistant', text: 'line one\n\nline   two' },
    { id: 'u', kind: 'user', author: 'Sam', text: 'x'.repeat(300) },
    { id: 'p', kind: 'proposal', from: 'me', author: 'Dana', text: 'mine' },
    { id: 'q', kind: 'proposal', from: 'partner', author: 'Dana', text: 'theirs' },
    { id: 'd', kind: 'decision', text: '✓ sent to Claude', isError: false },
    systemEntry('Pairing started', 's'),
    ...entriesOf('m', [bash], new Set(), 'Host', '')
  ]
  expect(entries.map(lineOf)).toEqual([
    'Claude: line one line two',
    `Sam: ${'x'.repeat(239)}…`,
    'you: mine',
    'Dana: theirs',
    '  ✓ sent to Claude',
    '· Pairing started',
    '  Bash(npm test) ⎿ PASS'
  ])
})

test('a message still waiting its turn is a proposal whose id is unread', () => {
  const waiting: PairEntry = { id: 'p1', kind: 'proposal', from: 'partner', author: 'Dana', text: 'hi' }
  const sent: PairEntry = { ...waiting, id: 'p2' }
  expect([waiting, sent, systemEntry('a note', 'p1')].filter(isProposalIn(['p1']))).toEqual([waiting])
  expect(systemEntry('a note').id).toMatch(/^sys-[a-z0-9]{8}$/)
})
