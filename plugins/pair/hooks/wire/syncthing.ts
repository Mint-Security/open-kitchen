// What pair needs to know about Syncthing, as data: the pinned release, the config each side runs
// with, and the layout of the folders the two sides share. Pure functions, no `$`.
//
// Each pairing is two one-way folders. Each side writes only its own, which its Syncthing runs as
// send-only, and receives the other's as receive-only. A send-only folder never applies a change from
// the other device, so nothing the other side does can touch what this side writes: not a file
// swapped for a link, not a file planted for a name it will write next. Each folder holds `state.json`
// (overwritten) and numbered message files that are never rewritten.

import { is } from '../schema'
import type { Checked } from '../schema'

export const SYNCTHING_VERSION = 'v2.1.6'
const CONFIG_VERSION = 52

type Asset = { file: string; dir: string; sha256: string; binarySha256: string; isZip: boolean }

const asset = (os: 'macos' | 'linux', arch: 'arm64' | 'amd64', sha256: string, binarySha256: string): Asset => {
  const dir = `syncthing-${os}-${arch}-${SYNCTHING_VERSION}`
  const isZip = os === 'macos'
  return { file: `${dir}${isZip ? '.zip' : '.tar.gz'}`, dir, sha256, binarySha256, isZip }
}

// The archive's from the release's signed sha256sum.txt.asc; the binary's from that archive, so the
// copy kept on disk is checked again before every start.
const ASSETS: Readonly<Record<string, Asset>> = {
  'Darwin arm64': asset(
    'macos',
    'arm64',
    'f86bfa0bdbb5b1b13229a7e5643e898e3c4e017a4fff6dd525994ebaf28ff6e2',
    '8dcabdc7816d6d517b2cffe8429722331a7200989554631b417035811e641b04'
  ),
  'Darwin x86_64': asset(
    'macos',
    'amd64',
    'd1464be24a7157440dfb52e2d84939f83caf89c129761945abcdd4956e09ffb1',
    'a104b02d92f830665b17716804c3300b1b8e28fcc51caa9bd7ee6081a30e5551'
  ),
  'Linux x86_64': asset(
    'linux',
    'amd64',
    '524ef4e1df1850b719e2378c8369956f4e5f2ab9a46fdf7f45f2b925012147aa',
    'd72663e4f9efe0b8de5e1dacb13c1c8decc82e76623cf2fa47fd306f3e1d3a3e'
  ),
  'Linux aarch64': asset(
    'linux',
    'arm64',
    'f054de02462d5d58bd126908f2f92b63aba74f162a5be85e50e96d656e7db47d',
    '68d16bb03d9568189cd39a79c32767bba75bd750c612968b3db4d9d6174c1d3a'
  ),
  'Linux arm64': asset(
    'linux',
    'arm64',
    'f054de02462d5d58bd126908f2f92b63aba74f162a5be85e50e96d656e7db47d',
    '68d16bb03d9568189cd39a79c32767bba75bd750c612968b3db4d9d6174c1d3a'
  )
}

export type Release = Asset & { url: string }

// `uname -sm`, e.g. "Darwin arm64".
export const releaseFor = (uname: string): Release | null => {
  const found = ASSETS[uname.trim().replace(/\s+/g, ' ')]
  return found
    ? { ...found, url: `https://github.com/syncthing/syncthing/releases/download/${SYNCTHING_VERSION}/${found.file}` }
    : null
}

export const DISCOVERY_LOOKUP = 'https://discovery-lookup.syncthing.net/v2/?device='

const isAddress = is.matching(/^(tcp|tcp4|tcp6|quic|quic4|quic6|relay):\/\/[A-Za-z0-9.:[\]_-]{3,200}(\/\?[A-Za-z0-9=&%._:-]{0,300})?$/)
const isLookup = is.object({ addresses: is.arrayOf(is.unknown) })

// A discovery answer is untrusted input that ends up in our Syncthing config: keep only addresses
// of the kinds Syncthing dials, in the shape it announces them.
export const addressesFrom = (text: string): string[] => {
  try {
    const answer: unknown = JSON.parse(text)
    return isLookup(answer) ? answer.addresses.filter(isAddress).slice(0, 16) : []
  } catch {
    return []
  }
}

export const isConnections = is.object({ connections: is.recordOf(is.object({ connected: is.optional(is.boolean) })) })
export const isPendingDevices = is.recordOf(is.object({ name: is.optional(is.string), time: is.optional(is.string) }))
export const isConfiguredDevices = is.arrayOf(is.object({ deviceID: is.optional(is.string) }))

export const STATE_FILE = 'state.json'
export const messageFile = (seq: number): string => `m-${String(seq).padStart(9, '0')}.json`
export const seqOfMessageFile = (name: string): number | null => {
  const match = /^m-(\d{9})\.json$/.exec(name)
  return match ? Number(match[1]) : null
}

export type Received = readonly (readonly [number, number])[]

export const isReceived = (received: Received, seq: number): boolean => received.some(([from, to]) => seq >= from && seq <= to)

export const withReceived = (received: Received, seqs: readonly number[]): [number, number][] =>
  [...received, ...seqs.map(seq => [seq, seq] as const)]
    .sort((a, b) => a[0] - b[0])
    .reduce<[number, number][]>((runs, [from, to]) => {
      const last = runs.at(-1)
      if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to)
      else runs.push([from, to])
      return runs
    }, [])

export const toRead = (unread: readonly number[], received: Received, canSkip: (missing: number) => boolean): { seqs: number[]; missing: number | null } => {
  const seqs: number[] = []
  let next = (received.at(-1)?.[1] ?? 0) + 1
  for (const seq of unread) {
    if (seq > next && !canSkip(next)) return { seqs, missing: next }
    seqs.push(seq)
    next = Math.max(next, seq + 1)
  }
  return { seqs, missing: null }
}

const isSharedFile = is.object({
  pid: is.matching(/^[a-z0-9]{8}$/),
  seq: is.integer(0),
  data: is.matching(/^[A-Za-z0-9_-]+$/, 300_000)
})

export type SharedFile = Checked<typeof isSharedFile>

export const parseSharedFile = (text: string): SharedFile | null => {
  try {
    const file: unknown = JSON.parse(text)
    return isSharedFile(file) ? { pid: file.pid, seq: file.seq, data: file.data } : null
  } catch {
    return null
  }
}

// The host's folder, and one per guest it admits, so a guest who takes over a seat never reads or
// inherits what the one before wrote.
export const hostFolderIdOf = (roomId: string): string => `pair-${roomId.slice(0, 16)}-host`
export const guestFolderIdOf = (roomId: string, pid: string): string => `pair-${roomId.slice(0, 16)}-${pid}`

export type FolderType = 'sendonly' | 'receiveonly'
export type FolderSpec = { id: string; path: string; type: FolderType }

type FolderOptions = { rescanIntervalS: number; fsWatcherEnabled: boolean; ignorePerms: boolean; maxConflicts: number; order: 'alphabetic' }

export type FolderConfig = FolderOptions & { id: string; label: string; path: string; type: FolderType; devices: { deviceID: string }[] }
export type DeviceConfig = { deviceID: string; name: string; addresses: string[] }

const FOLDER_OPTIONS: FolderOptions = { rescanIntervalS: 3600, fsWatcherEnabled: false, ignorePerms: true, maxConflicts: 0, order: 'alphabetic' }

const defaultsOf = (answer: unknown): Record<string, unknown> => (is.plainObject(answer) ? answer : {})

// The guest's device and folder as the host adds them once it admits that guest, over the config API,
// on top of the defaults Syncthing answers with.
export const guestDevice = (defaults: unknown, deviceId: string, name: string): DeviceConfig => ({
  ...defaultsOf(defaults),
  deviceID: deviceId,
  name,
  addresses: ['dynamic']
})

export const inboundFolder = (defaults: unknown, spec: FolderSpec, deviceIds: string[]): FolderConfig => ({
  ...defaultsOf(defaults),
  ...FOLDER_OPTIONS,
  id: spec.id,
  label: 'pair',
  path: spec.path,
  type: spec.type,
  devices: deviceIds.map(deviceID => ({ deviceID }))
})

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export type NodeConfig = {
  me: { id: string; name: string }
  peer: { id: string; name: string } | null
  folders: FolderSpec[]
  socketPath: string
}

const deviceXml = (device: { id: string; name: string }): string =>
  `    <device id="${escapeXml(device.id)}" name="${escapeXml(device.name)}" compression="metadata" introducer="false" skipIntroductionRemovals="false" introducedBy="">
        <address>dynamic</address>
        <paused>false</paused>
        <autoAcceptFolders>false</autoAcceptFolders>
    </device>`

const folderXml = (folder: FolderSpec, deviceIds: string[]): string =>
  `    <folder id="${escapeXml(folder.id)}" label="pair" path="${escapeXml(folder.path)}" type="${folder.type}" rescanIntervalS="${FOLDER_OPTIONS.rescanIntervalS}" fsWatcherEnabled="false" fsWatcherDelayS="10" ignorePerms="true" autoNormalize="true">
        <filesystemType>basic</filesystemType>
${deviceIds.map(id => `        <device id="${escapeXml(id)}" introducedBy=""></device>`).join('\n')}
        <minDiskFree unit="%">1</minDiskFree>
        <markerName>.stfolder</markerName>
        <maxConflicts>0</maxConflicts>
        <order>${FOLDER_OPTIONS.order}</order>
    </folder>`

// Written before Syncthing first starts: generated defaults would listen on the well-known ports,
// broadcast on the LAN and report usage before anything else could change them. Global discovery
// gets the machine's public address alone, not its private ones; LAN discovery still finds a peer
// on the same network.
export const configXml = ({ me, peer, folders, socketPath }: NodeConfig): string => {
  const devices = peer ? [me, peer] : [me]
  return `<configuration version="${CONFIG_VERSION}">
${folders.map(folder => folderXml(folder, devices.map(device => device.id))).join('\n')}
${devices.map(deviceXml).join('\n')}
    <gui enabled="true" tls="false">
        <address>${escapeXml(socketPath)}</address>
        <unixSocketPermissions>600</unixSocketPermissions>
        <theme>default</theme>
    </gui>
    <options>
        <listenAddress>tcp://0.0.0.0:0</listenAddress>
        <listenAddress>quic://0.0.0.0:0</listenAddress>
        <listenAddress>dynamic+https://relays.syncthing.net/endpoint</listenAddress>
        <globalAnnounceServer>default</globalAnnounceServer>
        <globalAnnounceEnabled>true</globalAnnounceEnabled>
        <localAnnounceEnabled>true</localAnnounceEnabled>
        <announceLANAddresses>false</announceLANAddresses>
        <relaysEnabled>true</relaysEnabled>
        <natEnabled>false</natEnabled>
        <startBrowser>false</startBrowser>
        <urAccepted>-1</urAccepted>
        <autoUpgradeIntervalH>0</autoUpgradeIntervalH>
        <crashReportingEnabled>false</crashReportingEnabled>
        <reconnectionIntervalS>5</reconnectionIntervalS>
    </options>
</configuration>
`
}
