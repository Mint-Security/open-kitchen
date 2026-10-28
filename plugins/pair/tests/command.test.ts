import { expect, test } from 'claude-code/testing'

import { commandOf } from '../hooks/pairing/command'
import { formatInvite } from '../hooks/wire/protocol'

const INVITE = { code: '23456789ABCDEFGHJKLMNPQRSTUV', hostDeviceId: 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH' }

test("/pair's words, whoever types them", () => {
  for (const role of ['host', 'guest', null] as const) {
    expect(commandOf('', role)).toEqual({ kind: 'status' })
    expect(commandOf('  Stop ', role)).toEqual({ kind: 'stop' })
    expect(commandOf('leave', role)).toEqual({ kind: 'stop' })
    expect(commandOf('invite', role)).toEqual({ kind: 'invite' })
    expect(commandOf('preview', role)).toEqual({ kind: 'preview', arg: '' })
    expect(commandOf('log', role)).toEqual({ kind: 'log', count: 10 })
    expect(commandOf('log 25', role)).toEqual({ kind: 'log', count: 25 })
    expect(commandOf('log 500', role)).toEqual({ kind: 'log', count: 40 })
    expect(commandOf('log 0', role)).toEqual({ kind: 'log', count: 10 })
    expect(commandOf(formatInvite(INVITE).toLowerCase(), role)).toEqual({ kind: 'join', invite: INVITE })
  }
})

test("a guest's sentence that starts with a command's word is a message; the host gets the hint", () => {
  expect(commandOf('preview More', 'host')).toEqual({ kind: 'preview', arg: 'more' })
  expect(commandOf('preview the README first', 'guest')).toEqual({ kind: 'send', text: 'preview the README first' })
  expect(commandOf('log the failing test', 'guest')).toEqual({ kind: 'send', text: 'log the failing test' })
  expect(commandOf('  Fix it  ', 'guest')).toEqual({ kind: 'send', text: 'Fix it' })
  expect(commandOf('log the failing test', 'host')).toEqual({ kind: 'hint' })
  expect(commandOf('hello there', null)).toEqual({ kind: 'hint' })
})
