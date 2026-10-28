import { expect, test } from 'claude-code/testing'

import type { PairRoom } from '../types'
import { formatInvite } from '../hooks/wire/protocol'
import { inPathOf, inviteText, isPairRoom, localIdOf, myFolderIdOf, pathsOf, peerDeviceId } from '../hooks/pairing/room'
import { guestFolderIdOf, hostFolderIdOf } from '../hooks/wire/syncthing'

const DEVICE = 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH'
const CODE = '23456789ABCDEFGHJKLMNPQRSTUV'

const room = (patch: Partial<PairRoom> = {}): PairRoom => ({
  v: 4,
  code: CODE,
  hostDeviceId: null,
  roomId: 'r00m',
  pid: 'host0001',
  localId: 'abcdefghijkl',
  role: 'host',
  guestPid: null,
  guestDeviceId: null,
  guestSince: 0,
  departed: [],
  isHistoryPosted: false,
  startedAt: 0,
  ...patch
})

test("a room another version of pair wrote, or anything else, doesn't read as a room", () => {
  expect(isPairRoom(room())).toBe(true)
  for (const other of [null, 'room', [room()], { ...room(), v: 3 }, { ...room(), localId: '../../etc/x' }, { ...room(), role: 'admin' }, { ...room(), departed: ['a', 1] }]) {
    expect(isPairRoom(other)).toBe(false)
  }
})

test("an older pair's room is found by its local id alone, and only by a well-formed one", () => {
  expect(localIdOf({ v: 3, localId: 'abcdefghijkl', anything: 'else' })).toBe('abcdefghijkl')
  for (const other of [null, 'abcdefghijkl', { localId: '../../etc/x' }, { localId: 12 }, {}]) expect(localIdOf(other)).toBeNull()
})

test("a room's files sit under its local id, and the other side's folder lands beside them", () => {
  expect(pathsOf('/d', 'abcdefghijkl')).toEqual({
    dir: '/d/rooms/abcdefghijkl',
    st: '/d/rooms/abcdefghijkl/st',
    out: '/d/rooms/abcdefghijkl/out',
    socket: '/d/run/abcdefghijkl.sock',
    run: '/d/run'
  })
  expect(inPathOf('/d', room())).toBeNull()
  expect(inPathOf('/d', room({ guestPid: 'dana0001' }))).toBe('/d/rooms/abcdefghijkl/in-dana0001')
  expect(inPathOf('/d', room({ role: 'guest' }))).toBe('/d/rooms/abcdefghijkl/in')
})

test('each side sends into its own folder, and knows the device at the other end', () => {
  expect(myFolderIdOf(room())).toBe(hostFolderIdOf('r00m'))
  expect(myFolderIdOf(room({ role: 'guest', pid: 'dana0001' }))).toBe(guestFolderIdOf('r00m', 'dana0001'))
  expect(peerDeviceId(room({ hostDeviceId: DEVICE }))).toBeNull()
  expect(peerDeviceId(room({ guestDeviceId: DEVICE }))).toBe(DEVICE)
  expect(peerDeviceId(room({ role: 'guest', hostDeviceId: DEVICE }))).toBe(DEVICE)
})

test('there is an invite once the host has its device ID', () => {
  expect(inviteText(room())).toBeNull()
  expect(inviteText(room({ hostDeviceId: DEVICE }))).toBe(`/pair ${formatInvite({ code: CODE, hostDeviceId: DEVICE })}`)
})
