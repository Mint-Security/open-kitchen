import type { ElementTable, RenderElement, UiPressArgument } from 'claude-code'

import { COLORS } from './style/colors'

export type BandElements = Pick<ElementTable, 'Box' | 'Text' | 'Button'>

export type BandActions = {
  copy: (press: UiPressArgument) => void
  stop: () => void
}

export type PairBand = { kind: 'stopped'; problem: string | null } | { kind: 'sharing'; line: string; canInvite: boolean }

export const drawPairBand = (ui: BandElements, band: PairBand, act: BandActions): RenderElement => {
  const { Box, Button, Text } = ui

  if (band.kind === 'stopped') {
    return (
      <Box flexDirection="column">
        <Text wrap="wrap">
          <Text color={COLORS.problem} bold>
            Pair
          </Text>
          <Text dimColor>{` · stopped: ${band.problem ?? 'see /pair'}`}</Text>
        </Text>
        <Box gap={1}>
          <Button key="pair-band-stop" label="Clear" hotkey="s" onPress={act.stop} />
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={COLORS.ok} bold>
          Pair
        </Text>
        <Text dimColor>{` · ${band.line}`}</Text>
      </Text>
      <Box gap={1}>
        {band.canInvite && <Button key="pair-band-copy" label="Copy invite" hotkey="c" variant="primary" onPress={act.copy} />}
        <Button key="pair-band-stop" label="Stop sharing" hotkey="s" onPress={act.stop} />
      </Box>
    </Box>
  )
}
