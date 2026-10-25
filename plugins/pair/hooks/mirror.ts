// What the host's conversation looks like to the guest: pure functions from a prompt the host sent, a
// `session.append` row, a finished tool call, or the session so far, to the events worth sharing. A
// tool call carries the view the host's transcript draws for it (`style/tool-rows.ts`). No `$` in here.

import type { SessionMessage } from 'claude-code'

import type { PairEvent } from '../types'
import { toolViewOf } from './style/tool-rows'

const TEXT_CAP = 30_000
const HISTORY_EVENTS_CAP = 2000
const HISTORY_CHARS_CAP = 1_500_000

const clip = (text: string, cap: number): string => (text.length > cap ? `${text.slice(0, cap - 1)}…` : text)

export type AppendedRow = {
  door: string
  agentId?: string
  origin: { kind: string; name?: string }
  message: { type: string; name?: string; isMeta?: true; content: string | readonly { type: string; [field: string]: unknown }[] }
}

// A prompt as `prompt.submit` takes it in; newer engines also mark one the person never typed.
export type SubmittedPrompt = { text: string; origin: { kind: string }; isMeta?: boolean }

const userEvent = (who: string, text: string): PairEvent => ({ t: 'user', who, ref: null, text: clip(text, TEXT_CAP) })
const assistantEvent = (text: string): PairEvent => ({ t: 'assistant', text: clip(text, TEXT_CAP) })

const blockTexts = (row: AppendedRow): string[] =>
  typeof row.message.content === 'string'
    ? [row.message.content]
    : row.message.content.map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).filter(Boolean)

// Slash commands' output, `!` shell commands and theirs, task notifications and the engine's other notes
// are in the transcript as user messages, each wrapped in a tag of its own; none of it is something the
// host typed.
const ENGINE_TEXT =
  /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>|^\s*<[a-z][a-z0-9-]*>|^\s*\[Request interrupted by user/
const REMINDERS = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const COMPACTION_SUMMARY = /^This session is being continued from a previous conversation/
// A prompt a plugin submitted comes back from the session as a user row inside the engine's frame: the
// plugin's name, the text, and a closing paragraph for the model.
const PLUGIN_FRAME = /^The (\S+) plugin sent a message(?: while you were working)?:\n([\s\S]*)\n\n[^\n]*$/
// How Pair forwards a guest's message: `Dana (guest): …`, or `Guest: …` before the guest has a name.
const GUEST_LINE = /^(?:([^\n:]{1,32}) \(guest\)|Guest): ([\s\S]+)$/
// The line a slash command is typed as; it reaches the guest from the command's own row.
const SLASH_COMMAND = /^\/[^\s/]+(\s|$)/
const COMMAND_NAME = /<command-name>\/?([^<\s]+)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/

const promptText = (text: string): string => {
  const kept = text.replace(REMINDERS, '').trim()
  return ENGINE_TEXT.test(kept) ? '' : kept
}

// A slash command the host ran, as the line they typed it on; Pair's own come out empty. Null for any
// other text.
const commandLineOf = (text: string): string | null => {
  const name = COMMAND_NAME.exec(text)?.[1]
  if (!name) return null
  if (name === 'pair') return ''
  const args = COMMAND_ARGS.exec(text)?.[1]?.trim() ?? ''
  return args ? `/${name} ${args}` : `/${name}`
}

// The host's prompts, typed or sent while Claude works, not a plugin's (Pair's own are the guest's
// messages, which reach the guest their own way). The engine's own are left out by their text, as in
// the session so far.
export const promptEventOf = (prompt: SubmittedPrompt, hostName: string): PairEvent | null => {
  if (prompt.isMeta || prompt.origin.kind === 'plugin' || SLASH_COMMAND.test(prompt.text.trim())) return null
  const text = promptText(prompt.text)
  return text ? userEvent(hostName, text) : null
}

// Replies, and the slash commands the host ran; tool calls come from `tool.call`, which sees what they
// returned.
export const eventsFromRow = (row: AppendedRow, hostName: string): PairEvent[] => {
  if (row.agentId) return []
  if (row.door === 'response' && row.message.type === 'assistant') {
    return blockTexts(row)
      .map(text => text.trim())
      .filter(Boolean)
      .map(assistantEvent)
  }
  if (row.door === 'command' && row.message.type === 'user' && !row.message.isMeta && row.origin.kind !== 'plugin') {
    const line = commandLineOf(blockTexts(row).join('\n'))
    return line ? [userEvent(hostName, line)] : []
  }
  return []
}

export const toolEventOf = (tool: string, input: unknown, result: unknown, text: string, isError: boolean, cwd: string): PairEvent => ({
  t: 'tool',
  name: tool,
  isError,
  view: toolViewOf(tool, input, result, text, isError, cwd)
})

// A row a plugin submitted is not the host's words. Pair's own carry a guest's message, which comes back
// under the guest's name, as the guest's side shares it live; another plugin's are left out, as they are live.
const pluginRowEventsOf = (plugin: string, body: string): PairEvent[] => {
  const line = plugin === 'pair' ? GUEST_LINE.exec(body) : null
  return line ? [userEvent(line[1] ?? 'Guest', line[2] ?? '')] : []
}

const historyEventsOf = (message: SessionMessage, hostName: string, cwd: string): PairEvent[] => {
  if (message.role === 'user') {
    if (COMPACTION_SUMMARY.test(message.text)) return [{ t: 'compacted' }]
    const framed = PLUGIN_FRAME.exec(message.text)
    if (framed) return pluginRowEventsOf(framed[1] ?? '', framed[2] ?? '')
    const line = commandLineOf(message.text)
    const text = line ?? promptText(message.text)
    return text ? [userEvent(hostName, text)] : []
  }
  const text = message.text.trim()
  return [
    ...(text ? [assistantEvent(text)] : []),
    ...message.toolUses.map(use => toolEventOf(use.tool, use.input, use.result, use.text ?? '', use.isError === true, cwd))
  ]
}

// The conversation so far, newest last, read from the newest back so a long session costs no more than
// what is kept. It starts where the session was last compacted: what came before is a summary now.
export const eventsFromHistory = (messages: readonly SessionMessage[], hostName: string, cwd: string): PairEvent[] => {
  const kept: PairEvent[] = []
  let chars = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const events = message ? historyEventsOf(message, hostName, cwd) : []
    for (let j = events.length - 1; j >= 0; j--) {
      const next = events[j]
      if (!next) continue
      chars += JSON.stringify(next).length
      if (chars > HISTORY_CHARS_CAP || kept.length >= HISTORY_EVENTS_CAP) return kept.reverse()
      kept.push(next)
    }
  }
  return kept.reverse()
}
