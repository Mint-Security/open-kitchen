// A run of text in a tool's result line, as the transcript draws it: plain or bold.
export type PairSpan = { text: string; isBold: boolean }

// A tool call as the host's transcript draws it, worked out on the host from the call and its stored
// result, so the guest's pane can draw the same rows: `Label(args)`, then under it a summary line, a
// diff or file preview, or the first lines of output.
export type PairToolView = {
  label: string
  args: string
  // Read and search calls fold into one summary row, as the transcript folds them.
  group: 'read' | 'search' | null
  summary: PairSpan[] | null
  output: string[]
  totalLines: number
  code: { source: string; path: string; format: 'diff' | 'source'; moreLines: number } | null
  // What a desktop surface labels a collapsed row with: a command's own description, a change's size.
  description?: string
  added?: number
  removed?: number
}

export type PairEvent =
  | { t: 'user'; who: string; ref: string | null; text: string }
  | { t: 'assistant'; text: string }
  | { t: 'tool'; name: string; isError: boolean; view: PairToolView }
  // Where the host's session was compacted: what came before it is a summary, never shared.
  | { t: 'compacted' }

export type PairEntry =
  | { id: string; kind: 'user'; author: string; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'tool'; tool: string; isError: boolean; view: PairToolView }
  | { id: string; kind: 'proposal'; from: 'me' | 'partner'; author: string; text: string }
  | { id: string; kind: 'decision'; text: string; isError: boolean }
  | { id: string; kind: 'system'; text: string }

export type PairPeerView = {
  name: string
  isOnline: boolean
  hasLeft: boolean
  isWorking: boolean
  tool: string | null
}

declare module 'claude-code' {
  interface PluginState {
    pair: {
      // Bumped to redraw the preview pane when the session it shows has changed.
      previewTick: number
      // The collapsed tool rows a desktop-style transcript shows open, by the id of their first row.
      expanded: string[]
    }
  }
}
