import type { PairRoom } from '../../types'
import { is } from '../schema'
import type { Check } from '../schema'
import { formatInvite } from '../wire/protocol'
import { guestFolderIdOf, hostFolderIdOf } from '../wire/syncthing'

export const ROOM_FORMAT = 4

const isLocalId = is.matching(/^[a-z0-9]{12}$/)
const hasLocalId = is.object({ localId: isLocalId })

export const isPairRoom: Check<PairRoom> = is.object({
  v: is.literal(ROOM_FORMAT),
  code: is.string,
  hostDeviceId: is.nullable(is.string),
  roomId: is.string,
  pid: is.string,
  localId: isLocalId,
  role: is.literal('host', 'guest'),
  guestPid: is.nullable(is.string),
  guestDeviceId: is.nullable(is.string),
  guestSince: is.number,
  departed: is.arrayOf(is.string),
  isHistoryPosted: is.boolean,
  startedAt: is.number
})

// A pairing another version of pair stored: its folder is found by the local id alone.
export const localIdOf = (stored: unknown): string | null => (hasLocalId(stored) ? stored.localId : null)

export type Paths = { dir: string; st: string; out: string; socket: string; run: string }

export const roomKeyOf = (room: PairRoom): string => room.localId

// Short enough for a Unix socket path, which macOS caps near 104 bytes.
export const pathsOf = (dataDir: string, localId: string): Paths => {
  const dir = `${dataDir}/rooms/${localId}`
  return { dir, st: `${dir}/st`, out: `${dir}/out`, socket: `${dataDir}/run/${localId}.sock`, run: `${dataDir}/run` }
}

// Where the other side's folder lands here: the host's, or on the host the folder of the guest it let in.
export const inPathOf = (dataDir: string, room: PairRoom): string | null => {
  const { dir } = pathsOf(dataDir, room.localId)
  if (room.role === 'guest') return `${dir}/in`
  return room.guestPid ? `${dir}/in-${room.guestPid}` : null
}

export const myFolderIdOf = (room: PairRoom): string =>
  room.role === 'host' ? hostFolderIdOf(room.roomId) : guestFolderIdOf(room.roomId, room.pid)

// The device on the other end: the host the invite names, or the guest the host admitted.
export const peerDeviceId = (room: PairRoom): string | null => (room.role === 'guest' ? room.hostDeviceId : room.guestDeviceId)

export const inviteText = (room: PairRoom): string | null =>
  room.hostDeviceId ? `/pair ${formatInvite({ code: room.code, hostDeviceId: room.hostDeviceId })}` : null
