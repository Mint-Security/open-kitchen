import type { PairEntry, PairEvent, PairMessageEntry } from '../../types'
import { cleanName, cleanText, cleanToolName, cleanView } from '../wire/clean'
import { randomId } from '../wire/protocol'

const EVENT_TEXT_CAP = 30_000
const COMPACTED = "Earlier messages were compacted and aren't shown"

const preview = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export const systemEntry = (text: string, id = `sys-${randomId(8)}`): PairEntry => ({ id, kind: 'system', text })

export const entriesOf = (mid: string, events: PairEvent[], known: Set<string>, peerName: string, prefix: string): PairEntry[] =>
  events
    .filter(ev => !(ev.t === 'user' && ev.ref !== null && known.has(ev.ref)))
    .map((ev, index): PairEntry => {
      const id = `${prefix}${mid}:${index}`
      switch (ev.t) {
        case 'user':
          return { id, kind: 'user', author: cleanName(ev.who, peerName), text: cleanText(ev.text, EVENT_TEXT_CAP) }
        case 'assistant':
          return { id, kind: 'assistant', text: cleanText(ev.text, EVENT_TEXT_CAP) }
        case 'tool':
          return { id, kind: 'tool', tool: cleanToolName(ev.name) || 'tool', isError: ev.isError, view: cleanView(ev.view) }
        case 'compacted':
          return { id, kind: 'system', text: COMPACTED }
      }
    })
    .filter(entry => entry.kind === 'tool' || entry.text !== '')

export const lineOf = (entry: PairEntry): string => {
  switch (entry.kind) {
    case 'assistant':
      return `Claude: ${preview(entry.text, 240)}`
    case 'tool': {
      const view = entry.view
      const summary = view.summary?.map(span => span.text).join('') ?? view.output[0] ?? ''
      return `  ${view.args ? `${view.label}(${view.args})` : view.label}${summary ? ` ⎿ ${preview(summary, 160)}` : ''}`
    }
    case 'decision':
      return `  ${entry.text}`
    case 'system':
      return `· ${entry.text}`
    case 'proposal':
      return `${entry.from === 'me' ? 'you' : entry.author}: ${preview(entry.text, 240)}`
    case 'user':
      return `${entry.author}: ${preview(entry.text, 240)}`
  }
}

export const isProposalIn = (unread: readonly string[]) => (entry: PairEntry): entry is PairMessageEntry =>
  entry.kind === 'proposal' && unread.includes(entry.id)
