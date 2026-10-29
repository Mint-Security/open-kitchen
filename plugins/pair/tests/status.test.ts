import { expect, test } from 'claude-code/testing'

import type { PairLink, PairPeer, PairRoom } from '../types'
import { SEAT_HINT, describePairing, noticesOf, stateFor, statusLine } from '../hooks/pairing/status'

const host: PairRoom = {
  v: 4,
  code: '23456789ABCDEFGHJKLMNPQRSTUV',
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
  startedAt: 0
}
const guest: PairRoom = { ...host, role: 'guest' }
const dana = (patch: Partial<PairPeer> = {}): PairPeer => ({ pid: 'dana0001', name: 'Dana', isOnline: true, hasLeft: false, isWorking: false, tool: null, ...patch })

test('the status line says where the pairing stands, from either side', () => {
  const cases: [PairRoom | null, PairPeer | null, PairLink, string | undefined][] = [
    [null, null, 'ok', undefined],
    [host, null, 'failed', 'Pair · stopped · see /pair'],
    [guest, null, 'full', 'Pair · room is full'],
    [guest, null, 'downloading', 'Pair · downloading Syncthing…'],
    [host, null, 'starting', 'Pair · starting…'],
    [host, null, 'connecting', 'Pair · sharing · waiting for your guest'],
    [guest, null, 'connecting', 'Pair · connecting…'],
    [host, dana({ hasLeft: true }), 'offline', 'Pair · sharing · Dana left'],
    [host, dana(), 'offline', 'Pair · sharing · Dana offline'],
    [guest, dana({ isOnline: false }), 'ok', 'Pair · Dana offline'],
    [host, dana({ isWorking: true }), 'ok', 'Pair · sharing with Dana'],
    [guest, dana({ isWorking: true }), 'ok', 'Pair · watching Dana · Claude working']
  ]
  for (const [room, peer, link, line] of cases) expect(statusLine(room, peer, link)).toBe(line)
})

test("/pair's answer and the pane's notices say the same state in their own words", () => {
  expect(describePairing(host, null, 'starting', null)).toBe('Hosting. Waiting for your guest to join.\nStarting Syncthing…')
  expect(describePairing(guest, null, 'downloading', null)).toBe('Connecting to the host…\nDownloading Syncthing (one time, about 11 MB); this can take a minute…')
  expect(describePairing(guest, dana({ isWorking: true, tool: 'Edit' }), 'ok', null)).toBe('Watching Dana: online · Claude is working (Edit)')
  expect(describePairing(host, dana({ isOnline: false }), 'offline', null)).toBe('Hosting Dana: offline\nThe connection is down; retrying.')
  expect(describePairing(host, dana({ hasLeft: true }), 'offline', null)).toBe('Hosting Dana: left')
  expect(describePairing(guest, null, 'offline', SEAT_HINT)).toBe(`Connecting to the host…\n${SEAT_HINT}`)
  expect(describePairing(guest, null, 'full', null)).toBe('Connecting to the host…\nThis pairing already has two people.')
  expect(noticesOf(true, null, 'connecting', null)).toEqual([{ text: 'Send your guest the invite: Copy invite, below.', isError: false }])
  expect(noticesOf(false, dana(), 'offline', null)).toEqual([{ text: 'Connection lost, retrying…', isError: true }])
  expect(noticesOf(false, null, 'offline', SEAT_HINT)).toEqual([{ text: SEAT_HINT, isError: true }])
  expect(noticesOf(true, null, 'failed', 'Syncthing did not start; retrying.')).toEqual([{ text: 'Syncthing did not start; retrying.', isError: true }])
  expect(noticesOf(false, null, 'starting', null)).toEqual([{ text: 'Starting Syncthing…', isError: false }])
  expect(noticesOf(true, null, 'downloading', null)).toEqual([
    { text: 'Downloading Syncthing (one time, about 11 MB); this can take a minute…', isError: false },
    { text: 'Send your guest the invite: Copy invite, below.', isError: false }
  ])
})

test('what the host says of itself: working while a turn runs, for at most a quarter of an hour; a guest never is', () => {
  const me = { name: 'Sam', tool: 'Edit', workingSince: 1000 }
  expect(stateFor({ ...host, guestPid: 'dana0001' }, me, 2000)).toEqual({ v: 1, role: 'host', name: 'Sam', isWorking: true, tool: 'Edit', guest: 'dana0001' })
  expect(stateFor(host, me, 1000 + 15 * 60_000)).toMatchObject({ isWorking: false })
  expect(stateFor(host, { ...me, workingSince: null }, 2000)).toMatchObject({ isWorking: false })
  expect(stateFor(guest, me, 2000)).toEqual({ v: 1, role: 'guest', name: 'Sam', isWorking: false, tool: null, guest: null })
})
