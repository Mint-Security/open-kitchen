import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PairEntry, PairEvent, PairPeerView } from '../types'
import { eventsFromHistory, eventsFromRow, promptEventOf, toolEventOf } from './mirror'
import type { AppendedRow } from './mirror'
import { cleanName, cleanText, cleanToolName, cleanView } from './clean'
import { drawPairPane } from './pane'
import { styleOf } from './style/transcript'

const PREVIEW = 'pair-preview'
// The guest's half of the preview shows the newest rows, so both halves fit on screen; more on request.
const PREVIEW_ROWS = 30
const PREVIEW_MORE_ROWS = 100
const EXPANDED_CAP = 200
// A guest's pane keeps its newest rows, and so does the preview.
const LOG_CAP = 1500
const EVENT_TEXT_CAP = 30_000
const COMPACTED = "Earlier messages were compacted and aren't shown"

const previewTickAtom = atom({ plugin: 'pair', key: 'previewTick' } as const, 0)
const expandedAtom = atom({ plugin: 'pair', key: 'expanded' } as const, [])

let myName = ''
// The preview pane: this session as a guest gets it, the session so far read when the pane opens and then
// what happens as it happens, never read while drawing.
let isPreviewOpen = false
let previewReads = 0
let previewError: string | null = null
let previewRows = PREVIEW_ROWS
let arePreviewRowsOpen = false
let previewEvents: PairEvent[] = []
let isPreviewBuilt = false
let previewVersion = 0
let previewEntries: { version: number; entries: PairEntry[] } | null = null
let isMainTurnOpen = false
let lastTool: string | null = null
let sessionCwd = ''
// The transcript's bullet: what this machine's Claude Code draws.
const bullet = '⏺'

const hostLabel = (): string => myName || 'Host'

// Handlers fire and forget; a failure after a reload or at teardown must not surface as an unhandled rejection.
const detach = (work: Promise<unknown>): void => {
  work.catch(() => undefined)
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const entriesOf = (mid: string, events: PairEvent[], known: Set<string>, peerName: string, prefix: string): PairEntry[] =>
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

async function redrawPreview($: EngineInterface) {
  previewVersion++
  await update($, previewTickAtom, tick => tick + 1)
}

// The session so far, read once when the preview opens; whatever happens while it is read goes after it.
async function readPreview($: EngineInterface) {
  const reading = ++previewReads
  let past: PairEvent[] = []
  try {
    past = eventsFromHistory(await $.session.messages(), hostLabel(), sessionCwd)
    previewError = null
  } catch (error) {
    previewError = errorText(error)
  }
  if (reading !== previewReads || !isPreviewOpen) return
  previewEvents = [...past, ...previewEvents].slice(-LOG_CAP)
  isPreviewBuilt = true
  await redrawPreview($)
}

// Someone is shown the session as it happens: here, the preview alone.
const isSharing = (): boolean => isPreviewOpen

async function share($: EngineInterface, events: PairEvent[]) {
  if (events.length === 0 || !isPreviewOpen) return
  previewEvents = [...previewEvents, ...events].slice(-LOG_CAP)
  await redrawPreview($)
}

function startPreview() {
  isPreviewOpen = true
  isPreviewBuilt = false
  previewEvents = []
  previewError = null
}

// Drawn from what the preview holds, cleaned as the guest's side cleans what arrives.
function latestPreviewEntries(): PairEntry[] {
  if (previewEntries?.version !== previewVersion) {
    previewEntries = { version: previewVersion, entries: entriesOf('preview', previewEvents, new Set(), hostLabel(), 'p:') }
  }
  return previewEntries.entries
}

// A reload of this module finds the preview still open: it starts again from the session so far.
async function resumePreview($: EngineInterface) {
  if (!(await $.ui.panes()).some(pane => pane.id === PREVIEW)) return
  startPreview()
  await readPreview($)
}

// A desktop row of tool calls opened or closed again, for every pane that draws it.
async function toggleExpanded($: EngineInterface, id: string) {
  await update($, expandedAtom, ids => (ids.includes(id) ? ids.filter(other => other !== id) : [...ids, id].slice(-EXPANDED_CAP)))
}

async function showMorePreview($: EngineInterface) {
  previewRows += PREVIEW_MORE_ROWS
  await update($, previewTickAtom, tick => tick + 1)
}

// The same as the preview's clicks, for a surface whose clicks do not reach a plugin.
async function previewCommand($: EngineInterface, arg: string): Promise<string> {
  if (arg === '') return openPreview($)
  if (!isPreviewOpen) return 'Open the preview first: /pair preview.'
  if (arg === 'more') previewRows += PREVIEW_MORE_ROWS
  else if (arg === 'all') previewRows = Number.MAX_SAFE_INTEGER
  else if (arg === 'open' || arg === 'close') arePreviewRowsOpen = arg === 'open'
  else return 'Use /pair preview more or all for earlier rows, and open or close for each tool call.'
  await update($, previewTickAtom, tick => tick + 1)
  return arg === 'more'
    ? `The preview shows ${PREVIEW_MORE_ROWS} more rows.`
    : arg === 'all'
      ? 'The preview shows every row.'
      : arg === 'open'
        ? 'The preview shows each tool call.'
        : 'The preview folds tool calls again.'
}

async function openPreview($: EngineInterface): Promise<string> {
  startPreview()
  previewRows = PREVIEW_ROWS
  arePreviewRowsOpen = false
  await $.ui.open({ id: PREVIEW, title: 'Pair preview' })
  detach(readPreview($))
  return 'The preview shows this session as a guest would see it, and follows it as you work.'
}

async function handleCommand($: EngineInterface, args: string): Promise<string> {
  const word = args.trim().toLowerCase()

  if (word === 'preview' || word.startsWith('preview ')) return previewCommand($, word.slice(7).trim())
  return 'Use /pair preview to see this session as a guest would.'
}

export const register: Register = (on, options) => {
  myName = typeof options.displayName === 'string' ? cleanName(options.displayName, '') : ''

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pair',
      description: 'See this session as someone you pair with would see it',
      argumentHint: '[preview [more | all | open | close]]'
    })
    sessionCwd = e.cwd
    detach(resumePreview($))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isMainTurnOpen = true
    lastTool = null

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (result.drop === undefined && isSharing()) {
      try {
        const event = promptEventOf({ ...e, text: result.text }, hostLabel())
        if (event) await share($, [event])
      } catch {
        // an unexpected prompt shape must never get in the way of the prompt
      }
    }

    return result
  })

  on('tool.call', async ($, e, next) => {
    lastTool = e.tool
    const result = await next(e)
    if (isSharing() && !e.agentId) {
      try {
        // The call's arguments ride on the event itself, beside the envelope's own fields.
        const { tool: _tool, tool_use_id: _id, agentId: _agent, consent: _consent, ...input } = e as Record<string, unknown>
        const isDenied = 'deny' in result && typeof result.deny === 'string'
        const text = isDenied ? result.deny : (result.text ?? '')
        await share($, [toolEventOf(e.tool, input, isDenied ? undefined : result.result, text, isDenied || result.isError === true, sessionCwd)])
      } catch {
        // an unexpected result shape must never get in the way of the call
      }
    }

    return result
  })

  on('turn.complete', ($, e, next) => {
    if (!e.agentId) {
      lastTool = null
      isMainTurnOpen = false
    }

    return next(e)
  })

  // Only the rows a guest gets anything from: on a machine with managed settings, the security plugin sends
  // some other rows past the plugins a person installs, and the engine reports every hook it skipped.
  on('session.append', { door: ['response', 'command'] }, async ($, e, next) => {
    const result = await next(e)
    if (!result.deny && isSharing()) {
      try {
        await share($, eventsFromRow(e as AppendedRow, hostLabel()))
      } catch {
        // an unexpected row shape must never get in the way of the session
      }
    }

    return result
  })

  on('ui.close', ($, e, next) => {
    if (e.id === PREVIEW) isPreviewOpen = false

    return next(e)
  })

  on('command.run', { command: 'pair' }, async ($, e) => ({ text: await handleCommand($, e.args) }))

  on('ui.render', { component: 'Pane', requestId: PREVIEW }, async ($, e) => {
    await read($, previewTickAtom)
    const expanded = await read($, expandedAtom)
    const ui = $.ui.resolve(e)
    const { Box, Button, Code, Markdown, Text } = ui

    const elements = { Box, Text, Markdown, Code, Button, Input: 'Input' in ui ? ui.Input : undefined }
    const transcript = {
      columns: e.props.bodyColumns,
      bullet,
      me: 'you',
      style: styleOf(e.surface),
      expanded: new Set(expanded),
      isAllExpanded: arePreviewRowsOpen,
      onToggle: (id: string) => detach(toggleExpanded($, id))
    }
    const all = isPreviewBuilt ? latestPreviewEntries() : []
    const shown = all.slice(-previewRows)
    const guest: PairPeerView = { name: 'your guest', isOnline: true, hasLeft: false, isWorking: false, tool: null }
    const host: PairPeerView = { name: hostLabel(), isOnline: true, hasLeft: false, isWorking: isMainTurnOpen, tool: isMainTurnOpen ? lastTool : null }
    const say = (text: string) => () => $.ui.toast(`Pair preview · ${text}`)

    const hostPane = drawPairPane(
      elements,
      {
        isHost: true,
        peer: guest,
        notices: [],
        entries: [],
        earlier: 0,
        transcript: { ...transcript, me: myName || 'you' },
        keys: 'preview'
      },
      {}
    )
    const guestPane = drawPairPane(
      elements,
      {
        isHost: false,
        peer: host,
        notices: previewError
          ? [{ text: `Couldn't read this session: ${previewError}`, isError: true }]
          : isPreviewBuilt
            ? []
            : [{ text: 'Reading this session…', isError: false }],
        entries: shown,
        earlier: all.length - shown.length,
        transcript,
        keys: 'preview-guest'
      },
      {
        more: () => detach(showMorePreview($)),
        submit: say('what your guest types here goes straight to your Claude.')
      }
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor wrap="wrap">
          {'Preview: your pane once someone joins, and theirs. Nothing here is sent.'}
        </Text>
        {hostPane}
        <Text dimColor>{'─── your guest’s pane ───'}</Text>
        {guestPane}
      </Box>
    )
  })
}
