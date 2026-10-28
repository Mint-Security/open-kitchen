import type { PairRole } from '../../types'
import { parseInvite } from '../wire/protocol'
import type { Invite } from '../wire/protocol'

const LOG_LINES = 10
const LOG_LINES_MAX = 40

export type PairCommand =
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'invite' }
  | { kind: 'preview'; arg: string }
  | { kind: 'log'; count: number }
  | { kind: 'join'; invite: Invite }
  | { kind: 'send'; text: string }
  | { kind: 'hint' }

export const commandOf = (args: string, role: PairRole | null): PairCommand => {
  const arg = args.trim()
  const word = arg.toLowerCase()
  if (arg === '') return { kind: 'status' }
  if (word === 'stop' || word === 'leave') return { kind: 'stop' }
  if (word === 'invite') return { kind: 'invite' }
  if (word === 'preview' || (word.startsWith('preview ') && role !== 'guest')) return { kind: 'preview', arg: word.slice('preview'.length).trim() }
  const log = /^log(?: (\d+))?$/.exec(word)
  if (log) return { kind: 'log', count: Math.min(Number(log[1]) || LOG_LINES, LOG_LINES_MAX) }
  const invite = parseInvite(arg)
  if (invite) return { kind: 'join', invite }
  return role === 'guest' ? { kind: 'send', text: arg } : { kind: 'hint' }
}
