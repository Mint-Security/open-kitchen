// The band, the pane and the /dividend session card, drawn from what they show. No `$`: register.tsx
// reads the state, and passes in what each button does.

import type { ElementTable } from 'claude-code'

import type { DividendReaction, DividendTip, DividendUsage } from '../../types'
import { askFor } from '../tips/asks'
import { CACHE_EXPIRY_ACTIONS, KEEP_ALIVES_IN_A_ROW } from '../tips/cache'
import type { CacheExpiryAction } from '../tips/cache'
import { keyOf, tokens } from './format'
import { LESSON_TOPICS, lessonOf } from './lessons'
import type { LessonTopic } from './lessons'
import { CARD_TITLE } from './rows'
import type { Row } from './rows'
import { cacheRow, instructionScopes } from './status'
import { labelWidth, rowsTree } from './ui'

type Elements = Pick<ElementTable, 'Box' | 'Button' | 'Text'>

type TipActions = { compact: (tip: DividendTip) => void; ask: (tip: DividendTip) => void; react: (tip: DividendTip, reaction: DividendReaction) => void }

const REACTION_LABEL: Record<DividendReaction, string> = {
  seen: 'read',
  'not-relevant': "this kind won't show again",
  later: 'saved for later',
}

const EXPIRY_KEY: Record<CacheExpiryAction, string> = { 'Do nothing': 'nothing', 'Keep cache warm': 'warm', 'Auto compact': 'compact' }

const EXPIRY_TEXT: Record<CacheExpiryAction, string> = {
  'Do nothing': 'Dividend only shows tips. It sends nothing and compacts nothing on its own.',
  'Keep cache warm': `Shortly before the cache expires, Dividend sends a short message asking Claude to reply OK, so your next message can still read the cache. Each one uses your plan or API budget. It sends up to ${KEEP_ALIVES_IN_A_ROW} in a row, then waits for your next message.`,
  'Auto compact': 'Shortly before the cache expires, Dividend compacts the conversation once, with a brief to carry on from. It uses your plan or API budget.',
}

// What a tip offers, in order: its action, Ask Claude where Claude can act on it, Got it and Don't show
// these. The band shows one tip at a time, so its keys don't name the tip, its buttons have hotkeys, and
// the first of them leads.
const tipButtons = (Button: Elements['Button'], tip: DividendTip, { canCompact, isActing, isBand }: { canCompact: boolean; isActing: boolean; isBand: boolean }, act: TipActions) => {
  const canAsk = isActing && askFor(tip) !== null
  const key = (name: string): string => (isBand ? `dividend-${name}` : `dividend-${name}-${tip.id}`)
  const hotkey = (letter: string) => (isBand ? { hotkey: letter } : {})
  const leads = isBand ? { variant: 'primary' as const } : {}

  return [
    ...(canCompact ? [<Button key={key('compact')} label="Compact now" {...hotkey('c')} {...leads} onPress={() => act.compact(tip)} />] : []),
    ...(canAsk ? [<Button key={key('ask')} label="Ask Claude" {...hotkey('a')} {...leads} onPress={() => act.ask(tip)} />] : []),
    <Button key={key('seen')} label="Got it" {...hotkey('y')} {...(canCompact || canAsk ? {} : leads)} onPress={() => act.react(tip, 'seen')} />,
    <Button key={key('mute')} label="Don't show these" {...hotkey('n')} onPress={() => act.react(tip, 'not-relevant')} />,
  ]
}

export const bandView = (
  { Box, Button, Text }: Elements,
  { tip, canCompact, isActing }: { tip: DividendTip; canCompact: boolean; isActing: boolean },
  act: TipActions & { openPane: () => void },
) => (
  <Box flexDirection="column">
    <Text wrap="truncate-end">
      <Text color="green" bold>Dividend</Text>
      <Text dimColor> · Tip · </Text>
      <Text bold>{tip.title}</Text>
    </Text>
    <Text dimColor wrap="wrap">{tip.body}</Text>
    <Box gap={1}>
      {tipButtons(Button, tip, { canCompact, isActing, isBand: true }, act)}
      <Button key="dividend-later" label="Later" hotkey="l" onPress={() => act.react(tip, 'later')} />
      <Button key="dividend-open" label="All tips" hotkey="o" dimColor onPress={() => act.openPane()} />
    </Box>
  </Box>
)

// The /dividend session card, drawn from the figures it was printed with.
export const cardView = ({ Box, Text }: Pick<Elements, 'Box' | 'Text'>, rows: Row[]) => (
  <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
    <Text>
      <Text color="green" bold>
        Dividend
      </Text>
      <Text bold>{CARD_TITLE.slice('Dividend'.length)}</Text>
    </Text>
    {rowsTree({ Box, Text }, rows)}
  </Box>
)

export const paneView = (
  { Box, Button, Text }: Elements,
  { all, reacted, seen, canCompact, isActing, openLesson, expiryAction, isInteractive }: { all: DividendTip[]; reacted: Record<string, DividendReaction>; seen: DividendUsage | null; canCompact: boolean; isActing: boolean; openLesson: LessonTopic | null; expiryAction: CacheExpiryAction; isInteractive: boolean },
  act: TipActions & { openFile: (path: string) => void; toggleLesson: (topic: LessonTopic) => void; chooseExpiryAction: (action: CacheExpiryAction) => void },
) => {
  const cache = seen ? cacheRow(seen) : null
  const scopes = seen ? instructionScopes(seen) : []
  const width = labelWidth(['Instruction files', 'Prompt cache', ...scopes.map(scope => `  ${scope.name} ${tokens(scope.tokens)}`)])
  const lesson = openLesson ? lessonOf(openLesson) : null
  const newestFirst = [...all].reverse()

  return (
    <Box flexDirection="column" gap={1}>
      {seen && (
        <Box flexDirection="column">
          <Text bold>This session</Text>
          {rowsTree({ Box, Text }, cache ? [cache] : [], width)}
          {seen.memoryTokens !== null && (
            <Box flexDirection="column">
              {rowsTree({ Box, Text }, [{ label: 'Instruction files', value: tokens(seen.memoryTokens) }], width)}
              <Box flexDirection="column" rowGap={1} marginTop={1}>
              {scopes.map(scope => (
                <Box key={`dividend-scope-${scope.name}`}>
                  <Box width={width} flexShrink={0}>
                    <Text dimColor>{`  ${scope.name} ${tokens(scope.tokens)}`}</Text>
                  </Box>
                  <Box columnGap={2} rowGap={1} flexWrap="wrap" flexShrink={1}>
                    {scope.files.map(file => (
                      <Button key={`dividend-open-${keyOf(file.path)}`} label={`${file.name} ${tokens(file.tokens)}`} onPress={() => act.openFile(file.path)} />
                    ))}
                  </Box>
                </Box>
              ))}
              </Box>
            </Box>
          )}
        </Box>
      )}

      {newestFirst.length === 0 && (
        <Text dimColor wrap="wrap">No tips yet. They come when a session gives a reason: a long context, a cold cache, unused MCP servers, heavy instruction files, a rate limit running low.</Text>
      )}
      {newestFirst.map(tip => {
        const reaction = reacted[tip.id]

        return (
          <Box key={`dividend-tip-${tip.id}`} flexDirection="column">
            <Text wrap="wrap">
              <Text color={reaction ? undefined : 'green'}>{reaction ? '○' : '●'} </Text>
              <Text bold={!reaction}>{tip.title}</Text>
            </Text>
            <Text dimColor wrap="wrap">{tip.body}</Text>
            {reaction ? (
              <Text dimColor>{REACTION_LABEL[reaction]}</Text>
            ) : (
              <Box gap={1}>
                {tipButtons(Button, tip, { canCompact: canCompact && tip.action === 'compact', isActing, isBand: false }, act)}
              </Box>
            )}
          </Box>
        )
      })}
      <Box flexDirection="column">
        <Text bold>Before the prompt cache expires</Text>
        <Box gap={1} flexWrap="wrap" marginY={1}>
          {CACHE_EXPIRY_ACTIONS.map(action => (
            <Button
              key={`dividend-expiry-${EXPIRY_KEY[action]}`}
              label={action}
              variant={expiryAction === action ? 'primary' : undefined}
              onPress={() => act.chooseExpiryAction(action)}
            />
          ))}
        </Box>
        <Text dimColor wrap="wrap">{EXPIRY_TEXT[expiryAction]}</Text>
        {expiryAction === 'Auto compact' && !isInteractive && (
          <Text dimColor wrap="wrap">Desktop and SDK sessions like this one skip it; terminal sessions compact.</Text>
        )}
        <Text dimColor wrap="wrap">Your choice applies to every Claude Code session on this computer.</Text>
      </Box>
      <Box flexDirection="column">
        <Text bold>How it works</Text>
        <Box gap={1} flexWrap="wrap" marginTop={1}>
          {LESSON_TOPICS.map(topic => (
            <Button
              key={`dividend-learn-${topic}`}
              label={lessonOf(topic).label}
              variant={openLesson === topic ? 'primary' : undefined}
              onPress={() => act.toggleLesson(topic)}
            />
          ))}
        </Box>
        {lesson && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{lesson.title}</Text>
            <Text dimColor wrap="wrap">{lesson.text}</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}
