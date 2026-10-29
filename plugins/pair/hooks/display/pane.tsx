// The Pair pane as either side draws it, from plain values: the real pane and both halves of the
// preview draw this, so the preview shows exactly what each person gets.

import type { ElementTable, RenderElement, UiPressArgument } from 'claude-code'

import type { PairEntry, PairPeerView } from '../../types'
import { COLORS } from './style/colors'
import { drawTranscript } from './style/transcript'
import type { TranscriptOptions } from './style/transcript'

export type PaneElements = Pick<ElementTable, 'Box' | 'Text' | 'Markdown' | 'Code' | 'Button'> & { Input?: ElementTable<'terminal'>['Input'] }

export type PaneModel = {
  isHost: boolean
  peer: PairPeerView | null
  notices: { text: string; isError: boolean }[]
  entries: PairEntry[]
  // Rows kept out above the ones drawn.
  earlier: number
  transcript: TranscriptOptions
  inputRound: number
  // Prefixes every key, so two panes can be drawn in one tree.
  keys: string
}

export type PaneActions = {
  more?: () => void
  submit?: (text: string) => void
  copy?: (press: UiPressArgument) => void
  stop?: () => void
}

export const drawPairPane = (ui: PaneElements, m: PaneModel, act: PaneActions): RenderElement => {
  const { Box, Button, Text } = ui
  const { isHost, peer, keys } = m
  const isOnline = peer !== null && !peer.hasLeft && peer.isOnline
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text>
          <Text bold>Pair</Text>
          <Text dimColor>{` · ${isHost ? 'hosting' : 'watching'} ${peer ? peer.name : isHost ? 'nobody yet' : '…'} · `}</Text>
          <Text color={isOnline ? COLORS.ok : undefined} dimColor={!isOnline}>
            {!peer ? (isHost ? 'waiting' : 'connecting') : peer.hasLeft ? 'left' : peer.isOnline ? 'online' : 'offline'}
          </Text>
          {!isHost && peer && !peer.hasLeft && peer.isWorking && (
            <Text color={COLORS.working}>{` · Claude is working${peer.tool ? ` · ${peer.tool}` : ''}`}</Text>
          )}
        </Text>
        {isHost && (
          <Text dimColor wrap="wrap">
            {'Your guest sees the whole session, tool output included, and what they send goes straight to Claude.'}
          </Text>
        )}
        {!isHost && peer && (
          <Text dimColor wrap="wrap">
            {`What you send goes straight to ${peer.name}'s Claude.`}
          </Text>
        )}
        {m.notices.map((notice, index) => (
          <Text key={`${keys}-notice-${index}`} color={notice.isError ? COLORS.problem : undefined} dimColor={!notice.isError} wrap="wrap">
            {notice.text}
          </Text>
        ))}
      </Box>

      <Box flexDirection="column" gap={1}>
        {m.earlier > 0 && (
          <Box gap={1}>
            <Text dimColor>{`… ${m.earlier} earlier ${m.earlier === 1 ? 'row' : 'rows'}`}</Text>
            {act.more && <Button key={`${keys}-more`} label="Show more" onPress={act.more} />}
          </Box>
        )}
        {m.entries.length === 0 && <Text dimColor>{isHost ? 'Nothing yet.' : 'Waiting for the host…'}</Text>}
        {drawTranscript(ui, m.entries, { ...m.transcript, keys })}
      </Box>

      {!isHost && ui.Input && act.submit && (
        <ui.Input key={m.inputRound > 0 ? `${keys}-input-${m.inputRound}` : `${keys}-input`} label="Ask Claude: " placeholder="goes straight to the host’s Claude" submitLabel="send" onSubmit={act.submit} />
      )}

      <Box gap={1}>
        {isHost && act.copy && <Button key={`${keys}-copy`} label="Copy invite" onPress={act.copy} />}
        {act.stop && <Button key={`${keys}-stop`} label={isHost ? 'Stop sharing' : 'Stop watching'} onPress={act.stop} />}
      </Box>
    </Box>
  )
}

export const drawPreview = (ui: PaneElements, isPaired: boolean, host: PaneModel, guest: PaneModel, act: PaneActions): RenderElement => {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor wrap="wrap">
        {isPaired ? 'Preview: your pane, and your guest’s as it is now. Nothing here is sent.' : 'Preview: your pane once someone joins, and theirs. Nothing here is sent.'}
      </Text>
      {drawPairPane(ui, host, {})}
      <Text dimColor>{'─── your guest’s pane ───'}</Text>
      {drawPairPane(ui, guest, act)}
    </Box>
  )
}
