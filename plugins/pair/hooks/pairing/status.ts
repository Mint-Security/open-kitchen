import type { PairLink, PairPeer, PairRoom } from '../../types'
import type { StatePayload } from '../wire/protocol'

const WORKING_MAX_MS = 15 * 60_000

const DOWNLOADING = 'Downloading Syncthing (one time, about 11 MB); this can take a minute…'

export const SEAT_HINT =
  "Can't get into the host's session, though it is up: someone else may already have joined with this invite, or the host runs another version of pair."

export function sharingLine(peer: PairPeer | null, link: PairLink): string {
  if (!peer) return 'sharing · waiting for your guest'
  if (peer.hasLeft) return `sharing · ${peer.name} left`
  if (link === 'offline' || !peer.isOnline) return `sharing · ${peer.name} offline`
  return `sharing with ${peer.name}`
}

export function statusLine(room: PairRoom | null, peer: PairPeer | null, link: PairLink): string | undefined {
  if (!room) return undefined
  if (link === 'failed') return 'Pair · stopped · see /pair'
  if (link === 'full') return 'Pair · room is full'
  if (link === 'downloading') return 'Pair · downloading Syncthing…'
  if (link === 'starting') return 'Pair · starting…'
  if (room.role === 'host') return `Pair · ${sharingLine(peer, link)}`
  if (!peer) return 'Pair · connecting…'
  if (peer.hasLeft) return `Pair · ${peer.name} left`
  if (link === 'offline' || !peer.isOnline) return `Pair · ${peer.name} offline`
  return `Pair · watching ${peer.name}${peer.isWorking ? ' · Claude working' : ''}`
}

// What `/pair` answers, which the model reads too: the state of things, never what the other side wrote
// beyond their name (which cleanName keeps to a name). /pair log is the one command that quotes them.
export function describePairing(room: PairRoom, peer: PairPeer | null, link: PairLink, problem: string | null): string {
  const isHost = room.role === 'host'
  const lines: string[] = []
  if (!peer) lines.push(isHost ? 'Hosting. Waiting for your guest to join.' : 'Connecting to the host…')
  else {
    const state = peer.hasLeft ? 'left' : peer.isOnline ? 'online' : 'offline'
    if (isHost) lines.push(`Hosting ${peer.name}: ${state}`)
    else lines.push(`Watching ${peer.name}: ${state}${peer.isWorking ? ` · Claude is working${peer.tool ? ` (${peer.tool})` : ''}` : ''}`)
  }
  if (link === 'downloading') lines.push(DOWNLOADING)
  if (link === 'starting') lines.push('Starting Syncthing…')
  if (link === 'offline' && problem !== SEAT_HINT && !peer?.hasLeft) lines.push('The connection is down; retrying.')
  if (link === 'full') lines.push('This pairing already has two people.')
  if (problem) lines.push(problem)
  return lines.join('\n')
}

export const noticesOf = (isHost: boolean, peer: PairPeer | null, link: PairLink, problem: string | null): { text: string; isError: boolean }[] => [
  ...(link === 'downloading' ? [{ text: DOWNLOADING, isError: false }] : []),
  ...(link === 'starting' ? [{ text: 'Starting Syncthing…', isError: false }] : []),
  ...(link === 'offline' && problem !== SEAT_HINT && !peer?.hasLeft ? [{ text: 'Connection lost, retrying…', isError: true }] : []),
  ...(link === 'full' ? [{ text: 'This pairing already has two people.', isError: true }] : []),
  ...(problem ? [{ text: problem, isError: true }] : []),
  ...(isHost && !peer && link !== 'failed' ? [{ text: 'Send your guest the invite: Copy invite, below.', isError: false }] : [])
]

export function stateFor(room: PairRoom, me: { name: string; tool: string | null; workingSince: number | null }, nowMs: number): StatePayload {
  const isHost = room.role === 'host'
  const isWorking = isHost && me.workingSince !== null && nowMs - me.workingSince < WORKING_MAX_MS
  return { v: 1, role: room.role, name: me.name, isWorking, tool: isHost ? me.tool : null, guest: isHost ? room.guestPid : null }
}
