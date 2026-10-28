// The host's conversation in the guest's pane, drawn row by row as Claude Code draws it on that surface:
// in a terminal's style (`terminal.tsx`) or the desktop app's (`desktop.tsx`). Pure: it takes the
// surface's elements.

import type { ElementTable, RenderElement } from 'claude-code'

import type { PairEntry } from '../../../types'
import { drawDesktop } from './desktop'
import { drawTerminal } from './terminal'

export type Elements = Pick<ElementTable, 'Box' | 'Text' | 'Markdown' | 'Code'> & { Button?: ElementTable['Button'] }

export type TranscriptStyle = 'terminal' | 'desktop'

export type TranscriptOptions = {
  columns: number
  bullet: string
  me: string
  style?: TranscriptStyle
  // Desktop rows of tool calls drawn open, by the id of their first call, and how a click opens one.
  expanded?: ReadonlySet<string>
  isAllExpanded?: boolean
  onToggle?: (id: string) => void
  keys?: string
}

export const styleOf = (surface: string): TranscriptStyle => (surface === 'terminal' ? 'terminal' : 'desktop')

export const drawTranscript = (ui: Elements, entries: readonly PairEntry[], options: TranscriptOptions): RenderElement[] =>
  options.style === 'desktop' ? drawDesktop(ui, entries, options) : drawTerminal(ui, entries, options)
