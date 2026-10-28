// Invites, key derivation and message sealing for the `pair` mod. Pure functions, no `$`.
//
// The invite is a secret code and the host's device ID. The transport is Syncthing's TLS between the
// host the invite names and a guest that proves it holds the code; sealing every payload as well keeps
// what sits in the shared folder unreadable to anything but this mod. The mod sandbox's
// `crypto.subtle` only digests, so sealing is encrypt-then-MAC built from HMAC-SHA256: an HMAC
// counter-mode keystream plus an HMAC tag.
//
// The code carries 140 random bits, derived into keys with plain SHA-256 and no slow KDF, so it has to
// withstand guessing by itself: 128 bits or more is that margin.

import type { PairEvent, PairToolView } from '../../types'
import { is } from '../schema'
import type { Check, Checked } from '../schema'

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const CODE_LENGTH = 28
const DEVICE_LENGTH = 56
const SYNCTHING_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const NONCE_BYTES = 16
const TAG_BYTES = 32

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type RoomKeys = { roomId: string; encKey: Uint8Array; macKey: Uint8Array }

const messageId = is.matching(/^[a-z0-9]{10}$/)
const pid = is.matching(/^[a-z0-9]{8}$/)

export const isStatePayload = is.object({
  v: is.literal(1),
  role: is.literal('host', 'guest'),
  name: is.string,
  isWorking: is.boolean,
  tool: is.nullable(is.string),
  guest: is.nullable(pid)
})

export type StatePayload = Checked<typeof isStatePayload>

const isToolView: Check<PairToolView> = is.object({
  label: is.string,
  args: is.string,
  group: is.literal('read', 'search', null),
  summary: is.nullable(is.arrayOf(is.object({ text: is.string, isBold: is.boolean }), 16)),
  output: is.arrayOf(is.string, 400),
  totalLines: is.number,
  code: is.nullable(is.object({ source: is.string, path: is.string, format: is.literal('diff', 'source'), moreLines: is.number })),
  description: is.optional(is.string),
  added: is.optional(is.number),
  removed: is.optional(is.number)
})

const isPairEvent: Check<PairEvent> = is.oneOf(
  is.object({ t: is.literal('user'), who: is.string, ref: is.nullable(messageId), text: is.string }),
  is.object({ t: is.literal('assistant'), text: is.string }),
  is.object({ t: is.literal('tool'), name: is.string, isError: is.boolean, view: isToolView }),
  is.object({ t: is.literal('compacted') })
)

const envelope = { v: is.literal(1), mid: messageId }

export const isMessagePayload = is.oneOf(
  is.object({ ...envelope, kind: is.literal('events', 'history'), events: is.arrayOf(isPairEvent) }),
  is.object({ ...envelope, kind: is.literal('proposal'), text: is.string }),
  is.object({ ...envelope, kind: is.literal('decision'), ref: messageId, outcome: is.literal('sent', 'failed') }),
  is.object({ ...envelope, kind: is.literal('bye') })
)

export type MessagePayload = Checked<typeof isMessagePayload>

export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n))

export const randomToken = (n: number): string => {
  let out = ''
  for (const byte of randomBytes(n)) out += ALPHABET.charAt(byte & 31)
  return out
}

export const randomId = (n: number): string => randomToken(n).toLowerCase()

export const generateCode = (): string => randomToken(CODE_LENGTH)

export type Invite = { code: string; hostDeviceId: string }

// A device ID as Syncthing prints it: 56 characters of its base32, check characters included, in eight
// dashed groups of seven. Syncthing checks the check characters itself when it loads one.
export const isDeviceId = (text: string): boolean => /^[A-Z2-7]{7}(?:-[A-Z2-7]{7}){7}$/.test(text)

// Both alphabets have 32 letters, so a device ID's characters carry over one for one.
const translate = (text: string, from: string, to: string): string => [...text].map(char => to.charAt(from.indexOf(char))).join('')

export const formatInvite = ({ code, hostDeviceId }: Invite): string => {
  const invite = `${code}${translate(hostDeviceId.replace(/-/g, ''), SYNCTHING_BASE32, ALPHABET)}`
  return (invite.match(/.{1,4}/g) ?? [invite]).join('-')
}

export const parseInvite = (input: string): Invite | null => {
  const text = input.toUpperCase().replace(/[\s-]/g, '')
  if (text.length !== CODE_LENGTH + DEVICE_LENGTH || [...text].some(char => !ALPHABET.includes(char))) return null
  const device = translate(text.slice(CODE_LENGTH), ALPHABET, SYNCTHING_BASE32)
  return { code: text.slice(0, CODE_LENGTH), hostDeviceId: (device.match(/.{7}/g) ?? []).join('-') }
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const be32 = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])

const sha256 = async (data: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-256', data))

export const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const fromBase64Url = (text: string): Uint8Array => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0))
}

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

export const hmacSha256 = async (key: Uint8Array, message: Uint8Array): Promise<Uint8Array> => {
  if (key.length > 64) throw new Error('hmac key longer than one block')
  const inner = new Uint8Array(64).fill(0x36)
  const outer = new Uint8Array(64).fill(0x5c)
  key.forEach((byte, i) => {
    inner[i] = 0x36 ^ byte
    outer[i] = 0x5c ^ byte
  })
  return sha256(concat(outer, await sha256(concat(inner, message))))
}

export const deriveKeys = async (code: string): Promise<RoomKeys> => {
  const derive = (label: string) => sha256(encoder.encode(`pair-v1|${label}|${code}`))
  return {
    roomId: toHex((await derive('room')).slice(0, 16)),
    encKey: await derive('enc'),
    macKey: await derive('mac')
  }
}

export const aadFor = (roomId: string, pid: string, slot: 'state' | 'msg'): string => `${roomId}|${pid}|${slot}`

const applyKeystream = async (encKey: Uint8Array, nonce: Uint8Array, data: Uint8Array): Promise<Uint8Array> => {
  const out = new Uint8Array(data.length)
  for (let block = 0; block * 32 < data.length; block++) {
    const pad = await hmacSha256(encKey, concat(nonce, be32(block)))
    for (let i = 0; i < 32 && block * 32 + i < data.length; i++) {
      out[block * 32 + i] = (data[block * 32 + i] ?? 0) ^ (pad[i] ?? 0)
    }
  }
  return out
}

const tagOf = (macKey: Uint8Array, aad: string, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> => {
  const aadBytes = encoder.encode(aad)
  return hmacSha256(macKey, concat(be32(aadBytes.length), aadBytes, nonce, ciphertext))
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export const seal = async (keys: RoomKeys, aad: string, payload: unknown): Promise<string> => {
  const nonce = randomBytes(NONCE_BYTES)
  const ciphertext = await applyKeystream(keys.encKey, nonce, encoder.encode(JSON.stringify(payload)))
  const tag = await tagOf(keys.macKey, aad, nonce, ciphertext)
  return toBase64Url(concat(nonce, ciphertext, tag))
}

// A guest's Syncthing introduces itself to the host under this name. The host's Syncthing parks an
// unknown device as pending with the name it gave; only someone holding the invite can make a name
// that checks out for that device, so the host admits on the name alone. The version in the name
// keeps pairs that lay out their folders differently from admitting each other.
const GUEST_NAME = /^pair2-guest-([a-z0-9]{8})-([0-9a-f]{24})$/

const guestProof = async (keys: RoomKeys, pid: string, deviceId: string): Promise<string> =>
  toHex(await hmacSha256(keys.macKey, encoder.encode(`pair-v2|guest|${pid}|${deviceId}`))).slice(0, 24)

export const guestDeviceName = async (keys: RoomKeys, pid: string, deviceId: string): Promise<string> =>
  `pair2-guest-${pid}-${await guestProof(keys, pid, deviceId)}`

// The guest's pid when the name checks out for that device, else null.
export const guestClaim = async (keys: RoomKeys, deviceId: string, name: string): Promise<string | null> => {
  const match = GUEST_NAME.exec(name)
  if (!match) return null
  const [, pid = '', proof = ''] = match
  return sameBytes(encoder.encode(proof), encoder.encode(await guestProof(keys, pid, deviceId))) ? pid : null
}

export const open = async (keys: RoomKeys, aad: string, data: string): Promise<unknown> => {
  try {
    const raw = fromBase64Url(data)
    if (raw.length < NONCE_BYTES + TAG_BYTES) return null
    const nonce = raw.slice(0, NONCE_BYTES)
    const ciphertext = raw.slice(NONCE_BYTES, raw.length - TAG_BYTES)
    const tag = raw.slice(raw.length - TAG_BYTES)
    if (!sameBytes(tag, await tagOf(keys.macKey, aad, nonce, ciphertext))) return null
    return JSON.parse(decoder.decode(await applyKeystream(keys.encKey, nonce, ciphertext)))
  } catch {
    return null
  }
}
