import { expect, test } from 'claude-code/testing'

import {
  addressesFrom,
  configXml,
  guestDevice,
  inboundFolder,
  isConfiguredDevices,
  isConnections,
  isPendingDevices,
  parseSharedFile,
  toRead,
  withReceived
} from '../hooks/wire/syncthing'

test('a shared file is read only when it is one of ours: our pid, a whole number, sealed data', () => {
  expect(parseSharedFile(JSON.stringify({ pid: 'dana0001', seq: 3, data: 'AbC-_9', extra: 'dropped' }))).toEqual({ pid: 'dana0001', seq: 3, data: 'AbC-_9' })
  for (const file of [
    { pid: 'DANA0001', seq: 3, data: 'x' },
    { pid: 'dana0001', seq: -1, data: 'x' },
    { pid: 'dana0001', seq: 1.5, data: 'x' },
    { pid: 'dana0001', seq: 3, data: 'not base64url!' },
    { pid: 'dana0001', seq: 3, data: 'a'.repeat(300_001) },
    [{ pid: 'dana0001', seq: 3, data: 'x' }]
  ]) {
    expect(parseSharedFile(JSON.stringify(file))).toBeNull()
  }
  expect(parseSharedFile('{not json')).toBeNull()
})

test('a discovery answer gives up only the addresses Syncthing dials, at most sixteen', () => {
  const good = 'tcp://198.51.100.7:41234'
  expect(addressesFrom(JSON.stringify({ addresses: [good, 'javascript:alert(1)', 7, 'relay://203.0.113.9:22067/?id=ABCDEFG'] }))).toEqual([
    good,
    'relay://203.0.113.9:22067/?id=ABCDEFG'
  ])
  expect(addressesFrom(JSON.stringify({ addresses: Array(20).fill(good) })).length).toBe(16)
  for (const answer of ['null', '{}', '{"addresses":"tcp://x:1"}', 'nonsense']) expect(addressesFrom(answer)).toEqual([])
})

test("Syncthing's answers are taken at their shape, and the guest's device and folder are built on its defaults", () => {
  expect(isConnections({ connections: { A: { connected: true, address: 'x' }, B: {} }, total: {} })).toBe(true)
  expect(isConnections({ connections: { A: { connected: 'yes' } } })).toBe(false)
  expect(isPendingDevices({ A: { name: 'pair2-guest', time: '2026-10-06T00:00:00Z' } })).toBe(true)
  expect(isPendingDevices(null)).toBe(false)
  expect(isConfiguredDevices([{ deviceID: 'A' }, {}])).toBe(true)
  expect(isConfiguredDevices({ deviceID: 'A' })).toBe(false)
  expect(isConfiguredDevices([{ deviceID: 7 }, null])).toBe(false)

  expect(guestDevice({ compression: 'metadata', name: 'default' }, 'A', 'pair2-guest')).toEqual({
    compression: 'metadata',
    deviceID: 'A',
    name: 'pair2-guest',
    addresses: ['dynamic']
  })
  const folder = inboundFolder({ type: 'sendreceive', fsWatcherEnabled: true, minDiskFree: 1 }, { id: 'f', path: '/in', type: 'receiveonly' }, ['H', 'A'])
  expect(folder).toMatchObject({ id: 'f', label: 'pair', path: '/in', type: 'receiveonly', fsWatcherEnabled: false, order: 'alphabetic', minDiskFree: 1 })
  expect(folder.devices).toEqual([{ deviceID: 'H' }, { deviceID: 'A' }])
  expect(guestDevice(['not', 'defaults'], 'A', 'n')).toEqual({ deviceID: 'A', name: 'n', addresses: ['dynamic'] })
})

test('received numbers are kept as runs, in whatever order they arrive', () => {
  expect(withReceived([], [3, 1, 2])).toEqual([[1, 3]])
  expect(withReceived([[1, 3]], [5])).toEqual([
    [1, 3],
    [5, 5]
  ])
  expect(
    withReceived(
      [
        [1, 3],
        [5, 5]
      ],
      [4]
    )
  ).toEqual([[1, 5]])
  expect(withReceived([[1, 5]], [3, 2])).toEqual([[1, 5]])
})

test('messages are read in order: a gap holds back the ones after it until it may be skipped, and a late one is still taken in', () => {
  const never = () => false
  expect(toRead([1, 2, 3], [], never)).toEqual({ seqs: [1, 2, 3], missing: null })
  expect(toRead([4, 5], [[1, 3]], never)).toEqual({ seqs: [4, 5], missing: null })
  expect(toRead([1, 3, 4], [], never)).toEqual({ seqs: [1], missing: 2 })

  const asked: number[] = []
  const skip = (missing: number) => {
    asked.push(missing)
    return true
  }
  expect(toRead([3, 4], [[1, 1]], skip)).toEqual({ seqs: [3, 4], missing: null })
  expect(asked).toEqual([2])

  expect(
    toRead(
      [2, 4],
      [
        [1, 1],
        [3, 3]
      ],
      never
    )
  ).toEqual({ seqs: [2, 4], missing: null })
})

test("Syncthing's config keeps it to the pairing: one-way folders pulled in name order, its API on a private socket, random ports, its public address alone announced, nothing reported or upgraded", () => {
  const host = configXml({ me: { id: 'HOST', name: 'pair host' }, peer: null, folders: [{ id: 'out', path: '/rooms/x/out', type: 'sendonly' }], socketPath: '/run/x.sock' })
  for (const setting of [
    '<folder id="out" label="pair" path="/rooms/x/out" type="sendonly"',
    '<order>alphabetic</order>',
    '<address>/run/x.sock</address>\n        <unixSocketPermissions>600</unixSocketPermissions>',
    '<listenAddress>tcp://0.0.0.0:0</listenAddress>',
    '<listenAddress>quic://0.0.0.0:0</listenAddress>',
    '<announceLANAddresses>false</announceLANAddresses>',
    '<natEnabled>false</natEnabled>',
    '<urAccepted>-1</urAccepted>',
    '<autoUpgradeIntervalH>0</autoUpgradeIntervalH>',
    '<crashReportingEnabled>false</crashReportingEnabled>',
    '<autoAcceptFolders>false</autoAcceptFolders>',
    'introducer="false"'
  ]) {
    expect(host).toContain(setting)
  }
  expect(host.match(/<device id="/g)?.length).toBe(2)

  const guest = configXml({
    me: { id: 'GUEST', name: 'pair2-x' },
    peer: { id: 'HOST', name: 'pair host' },
    folders: [{ id: 'in', path: '/rooms/a&b"c/in', type: 'receiveonly' }],
    socketPath: '/s'
  })
  expect(guest).toContain('path="/rooms/a&amp;b&quot;c/in" type="receiveonly"')
  expect(guest).toContain('<device id="GUEST" introducedBy=""></device>\n        <device id="HOST" introducedBy=""></device>')
})
