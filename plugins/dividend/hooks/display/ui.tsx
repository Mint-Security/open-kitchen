// Drawing shared by the pane and the /dividend session card.

import type { ElementTable } from 'claude-code'

import { plain } from './format'
import { valueParts } from './rows'
import type { Row } from './rows'

export const labelWidth = (labels: string[]): number => Math.max(0, ...labels.map(label => label.length)) + 2

// Label, figure and note in columns; a bar's cells left in green.
export const rowsTree = ({ Box, Text }: Pick<ElementTable, 'Box' | 'Text'>, drawn: Row[], width = labelWidth(drawn.map(row => row.label)), stacked = false) => {
  const rows = drawn.map(row => ({ label: plain(row.label, 80), value: plain(row.value, 200), ...(row.note ? { note: plain(row.note, 400) } : {}) }))

  return rows.map((row, index) => (
    <Box key={`dividend-row-${index}`} flexDirection={stacked ? 'column' : 'row'}>
      <Box {...(stacked ? {} : { width, flexShrink: 0 })}>
        <Text dimColor>{row.label}</Text>
      </Box>
      <Box flexShrink={1}>
        <Text wrap="wrap">
          {valueParts(row.value).map((part, at) =>
            part.kind === 'text' ? (
              <Text key={`dividend-row-${index}-${at}`} bold>
                {part.text}
              </Text>
            ) : (
              <Text key={`dividend-row-${index}-${at}`} color={part.kind === 'left' ? 'green' : undefined} dimColor={part.kind === 'gone'}>
                {part.text}
              </Text>
            ),
          )}
          {row.note ? <Text dimColor>{`  ${row.note}`}</Text> : null}
        </Text>
      </Box>
    </Box>
  ))
}
