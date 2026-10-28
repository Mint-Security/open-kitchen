import { expect, test } from 'claude-code/testing'

import {
  aadFor,
  deriveKeys,
  formatInvite,
  fromBase64Url,
  generateCode,
  guestClaim,
  guestDeviceName,
  hmacSha256,
  isDeviceId,
  isMessagePayload,
  open,
  parseInvite,
  seal,
  toBase64Url
} from '../hooks/wire/protocol'

const utf8 = (text: string) => new TextEncoder().encode(text)
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

test('HMAC-SHA256 matches the RFC 4231 test case 2', async () => {
  const mac = await hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?'))
  expect(hex(mac)).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
})

test('base64url round-trips every byte value', () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
  const text = toBase64Url(bytes)
  expect(/^[A-Za-z0-9_-]+$/.test(text)).toBe(true)
  expect(Array.from(fromBase64Url(text))).toEqual(Array.from(bytes))
})

const HOST = 'ETGVC3W-5XEDWUX-33UVECG-T57TXMQ-GLIWUHJ-JBWVVI4-QJ7E3QJ-MMZ7DQG'

test('an invite is a 140-bit code and the host device ID, in groups, read back case- and dash-insensitively', () => {
  const code = generateCode()
  expect(code).toMatch(/^[2-9A-HJ-NP-Z]{28}$/)
  const invite = formatInvite({ code, hostDeviceId: HOST })
  expect(invite).toMatch(/^([2-9A-HJ-NP-Z]{4}-){20}[2-9A-HJ-NP-Z]{4}$/)
  expect(parseInvite(invite)).toEqual({ code, hostDeviceId: HOST })
  expect(parseInvite(`  ${invite.toLowerCase()}  `)).toEqual({ code, hostDeviceId: HOST })
  expect(parseInvite(invite.slice(0, -1))).toBeNull()
  expect(parseInvite(invite.replace(/-[2-9A-HJ-NP-Z]{4}$/, '-0000'))).toBeNull()
  expect(parseInvite('hello world')).toBeNull()
  expect(parseInvite(code)).toBeNull()
  expect(new Set(Array.from({ length: 50 }, generateCode)).size).toBe(50)
})

test('a device ID is what Syncthing prints: eight dashed groups of seven', () => {
  expect(isDeviceId(HOST)).toBe(true)
  for (const bad of [HOST.toLowerCase(), HOST.replace(/-/g, ''), HOST.slice(0, -1), HOST.replace('ETGVC3W', 'ETGVC3W1'), `${HOST}\n`]) {
    expect(isDeviceId(bad)).toBe(false)
  }
})

test('keys are deterministic per code and distinct across codes', async () => {
  const a = await deriveKeys('ABCDEFGHJKLMNPQR')
  const again = await deriveKeys('ABCDEFGHJKLMNPQR')
  const b = await deriveKeys('ABCDEFGHJKLMNPQS')
  expect(a.roomId).toMatch(/^[0-9a-f]{32}$/)
  expect(again.roomId).toBe(a.roomId)
  expect(hex(again.encKey)).toBe(hex(a.encKey))
  expect(b.roomId).not.toBe(a.roomId)
  expect(hex(b.macKey)).not.toBe(hex(a.macKey))
  expect(hex(a.encKey)).not.toBe(hex(a.macKey))
})

test('sealed payloads round-trip (including long unicode) and hide the plaintext', async () => {
  const keys = await deriveKeys(generateCode())
  const aad = aadFor(keys.roomId, 'alice001', 'msg')
  const payload = { v: 1, text: `héllo wörld ✓ ${'x'.repeat(3000)}`, marker: 'plaintext-marker' }
  const sealed = await seal(keys, aad, payload)
  expect(sealed.includes('plaintext-marker')).toBe(false)
  expect(await open(keys, aad, sealed)).toEqual(payload)
  expect(await seal(keys, aad, payload)).not.toBe(sealed)
})

test("a guest's device name proves it holds the invite, for that device only", async () => {
  const keys = await deriveKeys(generateCode())
  const other = await deriveKeys(generateCode())
  const device = 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH'
  const name = await guestDeviceName(keys, 'dana0001', device)
  expect(name).toMatch(/^pair2-guest-dana0001-[0-9a-f]{24}$/)
  expect(await guestClaim(keys, device, name)).toBe('dana0001')

  expect(await guestClaim(keys, device.replace('AAAAAAA', 'AAAAAAB'), name)).toBeNull()
  expect(await guestClaim(other, device, name)).toBeNull()
  expect(await guestClaim(keys, device, name.replace(/.$/, c => (c === '0' ? '1' : '0')))).toBeNull()
  expect(await guestClaim(keys, device, name.replace('dana0001', 'eeee0002'))).toBeNull()
  for (const bad of ['', 'pair host', 'pair2-guest-dana0001', `${name}0`, name.toUpperCase()]) {
    expect(await guestClaim(keys, device, bad)).toBeNull()
  }
})

test('the conversation from before pairing travels as its own kind of message', () => {
  const event = { t: 'assistant', text: 'earlier' }
  expect(isMessagePayload({ v: 1, mid: 'm1m1m1m1m1', kind: 'history', events: [event] })).toBe(true)
  expect(isMessagePayload({ v: 1, mid: 'm1m1m1m1m1', kind: 'history', events: [{ ...event, t: 'shell' }] })).toBe(false)
  expect(isMessagePayload({ v: 1, mid: 'm1m1m1m1m1', kind: 'history' })).toBe(false)
})

test('each kind of event carries the fields of its own kind', () => {
  const view = { label: 'Bash', args: 'npm test', group: null, summary: null, output: ['PASS'], totalLines: 1, code: null }
  const valid = [
    { t: 'user', who: 'Sam', ref: null, text: 'run the tests' },
    { t: 'user', who: 'Dana', ref: 'm1m1m1m1m1', text: 'and the linter' },
    { t: 'assistant', text: 'Done.' },
    { t: 'tool', name: 'Bash', isError: false, view },
    { t: 'compacted' }
  ]
  const invalid = [
    { t: 'user', text: 'no author' },
    { t: 'user', who: 'Sam', text: 'no ref' },
    { t: 'user', who: 'Dana', ref: 'm1'.repeat(50), text: 'padded' },
    { t: 'assistant' },
    { t: 'tool', name: 'Bash', isError: false },
    { t: 'tool', name: 'Bash', isError: false, view: { ...view, output: 'PASS' } },
    { t: 'tool', isError: false, view }
  ]
  for (const event of valid) expect(isMessagePayload({ v: 1, mid: 'm1m1m1m1m1', kind: 'events', events: [event] })).toBe(true)
  for (const event of invalid) expect(isMessagePayload({ v: 1, mid: 'm1m1m1m1m1', kind: 'events', events: [event] })).toBe(false)
})

test('a message id is the ten characters randomId makes; padding is refused', () => {
  expect(isMessagePayload({ v: 1, mid: 'abcdefghjk', kind: 'bye' })).toBe(true)
  for (const mid of ['z'.repeat(100_000), 'ABCDEFGHJK', 'short', '', 'abcdefghjk-'])
    expect(isMessagePayload({ v: 1, mid, kind: 'bye' })).toBe(false)
  expect(isMessagePayload({ v: 1, mid: 'abcdefghjk', kind: 'decision', ref: 'r'.repeat(5000), outcome: 'sent' })).toBe(false)
})

test('a message from the other side is a guest asking Claude, never a note', () => {
  expect(isMessagePayload({ v: 1, mid: 'm1m1m1m1m1', kind: 'proposal', text: 'run the tests' })).toBe(true)
  expect(isMessagePayload({ v: 1, mid: 'm1m1m1m1m1', kind: 'note', text: 'back in five' })).toBe(false)
})

test('tampering, a different sender slot, or a different code all fail to open', async () => {
  const keys = await deriveKeys(generateCode())
  const other = await deriveKeys(generateCode())
  const aad = aadFor(keys.roomId, 'alice001', 'msg')
  const sealed = await seal(keys, aad, { v: 1, text: 'hi' })

  const flipped = sealed.slice(0, 30) + (sealed[30] === 'A' ? 'B' : 'A') + sealed.slice(31)
  expect(await open(keys, aad, flipped)).toBeNull()
  expect(await open(keys, aad, sealed.slice(0, -4))).toBeNull()
  expect(await open(keys, aadFor(keys.roomId, 'bobbob02', 'msg'), sealed)).toBeNull()
  expect(await open(keys, aadFor(keys.roomId, 'alice001', 'state'), sealed)).toBeNull()
  expect(await open(other, aad, sealed)).toBeNull()
  expect(await open(keys, aad, 'not base64 !!')).toBeNull()
})
