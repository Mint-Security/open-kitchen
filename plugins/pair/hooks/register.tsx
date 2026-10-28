import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  FsEntry,
  HookStream,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  Register,
  RenderSurface,
  Timer
} from 'claude-code'

import type { PairEntry, PairEvent, PairLink, PairMessageEntry, PairPeerView, PairRoom } from '../types'
import { drawPairBand } from './display/band'
import type { PairBand } from './display/band'
import { drawPairPane, drawPreview } from './display/pane'
import type { PaneModel } from './display/pane'
import { styleOf } from './display/style/transcript'
import { commandOf } from './pairing/command'
import { ROOM_FORMAT, inPathOf, inviteText, isPairRoom, localIdOf, myFolderIdOf, pathsOf, peerDeviceId, roomKeyOf } from './pairing/room'
import type { Paths } from './pairing/room'
import { SEAT_HINT, describePairing, noticesOf, sharingLine, stateFor, statusLine } from './pairing/status'
import { entriesOf, isProposalIn, lineOf, systemEntry } from './session/log'
import { eventsFromHistory, eventsFromRow, promptEventOf, toolEventOf } from './session/mirror'
import type { AppendedRow } from './session/mirror'
import { cleanName, cleanText, cleanToolName } from './wire/clean'
import { batchesOf, perMinute } from './wire/limits'
import {
  aadFor,
  deriveKeys,
  generateCode,
  guestClaim,
  guestDeviceName,
  isDeviceId,
  isMessagePayload,
  isStatePayload,
  open,
  randomId,
  seal
} from './wire/protocol'
import type { Invite, MessagePayload, RoomKeys, StatePayload } from './wire/protocol'
import {
  DISCOVERY_LOOKUP,
  STATE_FILE,
  SYNCTHING_VERSION,
  addressesFrom,
  configXml,
  guestDevice,
  guestFolderIdOf,
  hostFolderIdOf,
  inboundFolder,
  isConfiguredDevices,
  isConnections,
  isPendingDevices,
  isReceived,
  messageFile,
  parseSharedFile,
  releaseFor,
  seqOfMessageFile,
  toRead,
  withReceived
} from './wire/syncthing'
import type { FolderSpec, Release, SharedFile } from './wire/syncthing'

const PANE = 'pair'
const PREVIEW = 'pair-preview'
const PREVIEW_ROWS = 30
const PREVIEW_MORE_ROWS = 100
const EXPANDED_CAP = 200
const LOG_CAP = 1500
const TICK_MS = 1000
const ONLINE_MS = 8000
const OUTBOX_CAP = 300
const PROPOSAL_CAP = 600
const FORWARDS_PER_MINUTE = 8
const INCOMING_PER_MINUTE = 30
const TICK_STUCK_MS = 30_000
const READY_WITHIN_MS = 20_000
const RESTART_AFTER_MS = 15_000
const QUICK_EXITS_TO_SAY = 3
const LOOKUP_EVERY_MS = 4000
const LOOKUP_IDLE_MS = 30_000
const LOOKUP_EAGER_MS = 2 * 60_000
const STILL_LOOKING_MS = 90_000
const GIVE_UP_MS = 10 * 60_000
const ALIVE_EVERY_MS = 60_000
const OUTPUT_SAVE_EVERY_MS = 5000
const SEAT_HINT_AFTER_MS = 30_000
const SEAT_TIMEOUT_MS = 2 * 60_000
const MISTYPED_INVITE =
  "That invite looks mistyped: Syncthing does not accept the device ID in it. Check it against the host's, then /pair stop and try again."
const STALE_ROOM_MS = 10 * 60_000
const LINGER_MS = 3000
const FILE_MAX_BYTES = 256 * 1024
const FILES_PER_TICK = 32
const PENDING_CAP = 50
const GAP_WAIT_MS = 5000
const DEPARTED_CAP = 1000
const GUEST = 'Guest'
const HISTORY_DIVIDER = 'h:divider'

const roomAtom = atom({ plugin: 'pair', key: 'room' } as const, null)
const peerAtom = atom({ plugin: 'pair', key: 'peer' } as const, null)
const logAtom = atom({ plugin: 'pair', key: 'log' } as const, [])
const unreadAtom = atom({ plugin: 'pair', key: 'unread' } as const, [])
const receivedAtom = atom({ plugin: 'pair', key: 'received' } as const, [])
const previewTickAtom = atom({ plugin: 'pair', key: 'previewTick' } as const, 0)
const expandedAtom = atom({ plugin: 'pair', key: 'expanded' } as const, [])
const linkAtom = atom({ plugin: 'pair', key: 'link' } as const, 'starting')
const problemAtom = atom({ plugin: 'pair', key: 'problem' } as const, null)

type PollBody = {
  now: number
  read: number[]
  peer: { pid: string; seenAt: number; rev: number; state: string } | null
  messages: { seq: number; pid: string; data: string }[]
}

type SyncthingNode = {
  roomKey: string
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  apiKey: string
  socketPath: string
  logPath: string
  startedAt: number
  isReady: boolean
}

// A reason pair cannot run here at all; anything else is retried.
class PairProblem extends Error {}

let configuredName = ''
let isNameResolved = false
let timer: Timer | null = null
let myName = ''
let dataDir = ''
let workingSince: number | null = null
let isPreviewOpen = false
let previewReads = 0
let previewError: string | null = null
let previewRows = PREVIEW_ROWS
let arePreviewRowsOpen = false
let previewEvents: PairEvent[] = []
let isPreviewBuilt = false
let previewVersion = 0
let previewEntries: { version: number; entries: PairEntry[] } | null = null
let isMainTurnOpen = false
let lastTool: string | null = null
let tickStartedAt: number | null = null
let tickRun = 0
let sentSignature = ''
let shownStatus: string | undefined
let isHosting = false
let sessionCwd = ''
let bullet = '⏺'
let peerStateCache: { pid: string; rev: number; state: StatePayload | null } | null = null
let node: SyncthingNode | null = null
let isNodeStarting = false
let nextStartAt = 0
let quickExits = 0
let isConnected = false
let lastConnectedAt = 0
let lastLookupAt = 0
let injectedAddresses = ''
let lastSeq: number | null = null
let seqListing: { localId: string; highest: Promise<number> } | null = null
let isScanPending = false
let lastAliveAt = 0
let hasSaidStillLooking = false
let peerVisibleSince = 0
let syncthingOutput = ''
let isOutputDirty = false
let lastOutputSaveAt = 0
let peerStateFile: { name: string; mtimeMs: number; size: number; file: SharedFile | null } | null = null
let gap: { dir: string; seq: number; since: number } | null = null
let isFollowing = true
let isScrollDue = false
let isScrolling = false
let isPaneDrawn = false
const outbox: PairEvent[] = []
const forwards: PairMessageEntry[] = []
const keyCache = new Map<string, RoomKeys>()
const forwardLimit = perMinute(FORWARDS_PER_MINUTE)
const incomingLimit = perMinute(INCOMING_PER_MINUTE)
let floodSaidAt = 0

const envelope = () => ({ v: 1 as const, mid: randomId(10) })

const hostLabel = (): string => myName || 'Host'

// A room another version of pair wrote reads as no room: that pairing ends on load, it is not resumed.
async function readRoom($: EngineInterface): Promise<PairRoom | null> {
  const room: unknown = await read($, roomAtom)
  return isPairRoom(room) ? room : null
}

// Still the pairing in progress: not stopped, nor stopped and started again, while this was working on it.
async function isCurrentRoom($: EngineInterface, room: PairRoom): Promise<boolean> {
  const current = await readRoom($)
  return current !== null && roomKeyOf(current) === roomKeyOf(room)
}

// Handlers fire and forget; a failure after a reload or at teardown must not surface as an unhandled rejection.
const detach = (work: Promise<unknown>): void => {
  work.catch(() => undefined)
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function enqueue(events: PairEvent[]) {
  outbox.push(...events)
  if (outbox.length > OUTBOX_CAP) outbox.splice(0, outbox.length - OUTBOX_CAP)
}

function resetTransport() {
  isConnected = false
  lastConnectedAt = 0
  lastLookupAt = 0
  injectedAddresses = ''
  lastSeq = null
  seqListing = null
  isScanPending = false
  lastAliveAt = 0
  hasSaidStillLooking = false
  peerVisibleSince = 0
  peerStateFile = null
  gap = null
  nextStartAt = 0
  quickExits = 0
  sentSignature = ''
}

async function keysFor(code: string): Promise<RoomKeys> {
  const cached = keyCache.get(code)
  if (cached) return cached
  const keys = await deriveKeys(code)
  keyCache.set(code, keys)
  return keys
}

async function run($: EngineInterface, argv: string[], timeoutMs = 30_000) {
  const out = await $.process.run(argv, { timeoutMs })
  if (out.exitCode !== 0) {
    throw new Error(`${argv[0]}: ${(out.stderr || out.stdout).trim().slice(0, 200) || `exit ${out.exitCode}`}`)
  }
  return out
}

async function resolveDataDir($: EngineInterface) {
  if (dataDir) return
  const home = await $.env.get('HOME')
  if (!home) throw new PairProblem('pair keeps its files under your home directory, and HOME is not set.')
  dataDir = `${home.replace(/\/+$/, '')}/.claude/pair`
}

async function releaseOf($: EngineInterface): Promise<Release> {
  let uname = ''
  try {
    uname = (await run($, ['uname', '-sm'], 5000)).stdout
  } catch (error) {
    throw new PairProblem(`pair runs Syncthing on this machine and could not start a program here (${errorText(error)}).`)
  }
  bullet = uname.startsWith('Darwin') ? '⏺' : '●'
  const release = releaseFor(uname)
  if (!release) throw new PairProblem(`pair runs on macOS and Linux for now; this machine is ${cleanText(uname, 40) || 'something else'}.`)
  return release
}

async function sha256Of($: EngineInterface, file: string): Promise<string> {
  for (const argv of [['shasum', '-a', '256', file], ['sha256sum', file]]) {
    try {
      const out = await $.process.run(argv, { timeoutMs: 60_000 })
      if (out.exitCode === 0) return out.stdout.trim().split(/\s+/)[0] ?? ''
    } catch {
      // the other tool, then
    }
  }
  return ''
}

// One copy per machine, fetched on first use from Syncthing's GitHub release. The archive is checked
// against its published checksum, and the binary against the one pinned in syncthing.ts, before it
// first runs and again before every start: a copy that changed on disk is fetched afresh.
async function ensureBinary($: EngineInterface, release: Release): Promise<string> {
  const bin = `${dataDir}/bin/${SYNCTHING_VERSION}/syncthing`
  if (await $.fs.exists(bin)) {
    if ((await sha256Of($, bin)) === release.binarySha256) return bin
    await run($, ['rm', '-f', bin])
  }
  $.ui.toast('Pair · downloading Syncthing (one time, about 11 MB)')
  const tmp = `${dataDir}/bin/.download-${randomId(8)}`
  try {
    await run($, ['mkdir', '-p', tmp, `${dataDir}/bin/${SYNCTHING_VERSION}`])
    await run($, ['curl', '-fsSL', '--retry', '2', '--connect-timeout', '20', '-o', `${tmp}/${release.file}`, release.url], 300_000)
    if ((await sha256Of($, `${tmp}/${release.file}`)) !== release.sha256) {
      throw new PairProblem('The downloaded Syncthing did not match its published checksum, so pair did not run it.')
    }
    if (release.isZip) await run($, ['unzip', '-q', '-o', `${tmp}/${release.file}`, `${release.dir}/syncthing`, '-d', tmp], 60_000)
    else await run($, ['tar', '-xzf', `${tmp}/${release.file}`, '-C', tmp, `${release.dir}/syncthing`], 60_000)
    if ((await sha256Of($, `${tmp}/${release.dir}/syncthing`)) !== release.binarySha256) {
      throw new PairProblem('The Syncthing in the download did not match its pinned checksum, so pair did not run it.')
    }
    await run($, ['chmod', '755', `${tmp}/${release.dir}/syncthing`])
    await run($, ['mv', '-f', `${tmp}/${release.dir}/syncthing`, bin])
  } finally {
    await $.process.run(['rm', '-rf', tmp]).catch(() => undefined)
  }
  return bin
}

// Syncthing makes this device's own key and certificate, somewhere else first, so the only config it
// ever starts with is the one written below.
async function generateIdentity($: EngineInterface, bin: string, paths: Paths): Promise<string> {
  const scratch = `${paths.dir}/identity`
  await run($, [bin, 'generate', `--home=${scratch}`, '--no-port-probing'])
  for (const file of ['cert.pem', 'key.pem']) await $.fs.write(`${paths.st}/${file}`, await $.fs.read(`${scratch}/${file}`))
  await run($, ['rm', '-rf', scratch])
  const deviceId = await deviceIdIn($, bin, paths.st)
  if (!deviceId) throw new PairProblem('Syncthing made an identity pair could not read.')
  return deviceId
}

// The device ID of the certificate in `home`, as Syncthing itself reads it.
async function deviceIdIn($: EngineInterface, bin: string, home: string): Promise<string | null> {
  const out = await $.process.run([bin, 'device-id', `--home=${home}`], { timeoutMs: 30_000 }).catch(() => null)
  const deviceId = out?.exitCode === 0 ? out.stdout.trim() : ''
  return isDeviceId(deviceId) ? deviceId : null
}

// Written once per pairing, before Syncthing first starts, into a folder only this user can open. The
// guest's config already names the host (the invite gives its device ID) and introduces the guest
// under a name that proves it holds the invite; the host's names nobody until a guest knocks.
async function prepareRoom($: EngineInterface, room: PairRoom, paths: Paths, bin: string) {
  if (await $.fs.exists(`${paths.st}/config.xml`)) {
    // Made before a reload that came before the invite went out: the identity is on disk, the invite not yet.
    if (room.role === 'host' && !room.hostDeviceId) {
      const me = await deviceIdIn($, bin, paths.st)
      if (me) await inviteReady($, room, me)
    }
    return
  }
  await run($, ['mkdir', '-p', paths.dir])
  await run($, ['chmod', '700', paths.dir])
  const me = await generateIdentity($, bin, paths)
  const deviceName = room.role === 'host' ? 'pair host' : await guestDeviceName(await keysFor(room.code), room.pid, me)
  await $.fs.write(`${paths.out}/.stfolder/pair`, '')
  await $.fs.write(`${paths.dir}/alive`, '')
  await run($, ['chmod', '-R', 'go-rwx', paths.dir])
  await run($, ['mkdir', '-p', paths.run])
  await run($, ['chmod', '700', paths.run])
  const folders: FolderSpec[] =
    room.role === 'host'
      ? [{ id: hostFolderIdOf(room.roomId), path: paths.out, type: 'sendonly' }]
      : [
          { id: guestFolderIdOf(room.roomId, room.pid), path: paths.out, type: 'sendonly' },
          { id: hostFolderIdOf(room.roomId), path: `${paths.dir}/in`, type: 'receiveonly' }
        ]
  await $.fs.write(
    `${paths.st}/config.xml`,
    configXml({
      me: { id: me, name: deviceName },
      peer: room.role === 'guest' && room.hostDeviceId ? { id: room.hostDeviceId, name: 'pair host' } : null,
      folders,
      socketPath: paths.socket
    })
  )
  if (room.role === 'host') await inviteReady($, room, me)
}

// The host's invite names its device, so it exists once Syncthing has made the identity: it goes to the
// clipboard then, as /pair said it would.
async function inviteReady($: EngineInterface, room: PairRoom, hostDeviceId: string) {
  if (!(await isCurrentRoom($, room))) return
  const ready = { ...room, hostDeviceId }
  await update($, roomAtom, current => (isPairRoom(current) && roomKeyOf(current) === roomKeyOf(room) ? { ...current, hostDeviceId } : current))
  await copyInvite($, ready)
}

// Run as one process, Syncthing logs to its output instead of its --log-file: keep the tail, which the
// tick saves beside its config for whoever has to debug a pairing.
async function drain($: EngineInterface, started: SyncthingNode) {
  try {
    for await (const chunk of started.stream) {
      syncthingOutput = (syncthingOutput + chunk.text).slice(-32_000)
      isOutputDirty = true
    }
  } catch {
    // it ended either way
  }
  if (node === started) {
    node = null
    isConnected = false
    quickExits = started.isReady ? 0 : quickExits + 1
    nextStartAt = (await $.clock.now()) + RESTART_AFTER_MS * Math.min(Math.max(quickExits, 1), 4)
    await $.fs.write(started.logPath, syncthingOutput).catch(() => undefined)
    if (quickExits >= QUICK_EXITS_TO_SAY) {
      await setProblem($, `Syncthing stops as soon as it starts; retrying. What it said is in ${started.logPath}.`)
    }
  }
}

async function setProblem($: EngineInterface, problem: string | null) {
  if ((await read($, problemAtom)) !== problem) await update($, problemAtom, () => problem)
}

async function startNode($: EngineInterface, room: PairRoom) {
  if (isNodeStarting || node) return
  isNodeStarting = true
  try {
    await resolveDataDir($)
    await run($, ['mkdir', '-p', dataDir])
    await run($, ['chmod', '700', dataDir])
    const paths = pathsOf(dataDir, room.localId)
    const bin = await ensureBinary($, await releaseOf($))
    if (!(await isCurrentRoom($, room))) return
    await prepareRoom($, room, paths, bin)
    if (!(await isCurrentRoom($, room))) {
      await wipeRoom($, room)
      return
    }
    await $.process.run(['rm', '-f', paths.socket]).catch(() => undefined)
    const apiKey = randomId(32)
    // STMONITORED keeps Syncthing to one process, so ending this stream really stops it; the API key
    // goes by environment, never argv, which other users on the machine can read.
    syncthingOutput = ''
    const stream = $.process.spawn({
      argv: [bin, 'serve', `--home=${paths.st}`, '--no-browser', '--no-restart', '--no-upgrade'],
      env: { STMONITORED: 'yes', STNOUPGRADE: '1', STGUIAPIKEY: apiKey }
    })
    const started: SyncthingNode = {
      roomKey: roomKeyOf(room),
      stream,
      apiKey,
      socketPath: paths.socket,
      logPath: `${paths.st}/syncthing.log`,
      startedAt: await $.clock.now(),
      isReady: false
    }
    node = started
    detach(drain($, started))
    // Stopped while this was starting (a first download takes a while): nothing may outlive the room.
    if (!(await isCurrentRoom($, room))) {
      await retire($, started, room)
      return
    }
    if (quickExits < QUICK_EXITS_TO_SAY) await setProblem($, null)
  } catch (error) {
    const isFatal = error instanceof PairProblem
    nextStartAt = isFatal ? Number.POSITIVE_INFINITY : (await $.clock.now()) + RESTART_AFTER_MS
    await setProblem($, errorText(error))
    if (isFatal) await setLink($, 'failed')
  } finally {
    isNodeStarting = false
  }
}

async function stopNode(running: SyncthingNode | null) {
  if (node === running) {
    node = null
    isConnected = false
  }
  if (!running) return
  try {
    await running.stream.return({ code: null, signal: 'SIGTERM' })
  } catch {
    // already gone
  }
}

async function rest($: EngineInterface, path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const running = node
  if (!running) throw new Error('Syncthing is not running')
  const res = await $.http.fetch(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? { 'X-API-Key': running.apiKey } : { 'X-API-Key': running.apiKey, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    socketPath: running.socketPath
  })
  if (!res.ok) throw new Error(`Syncthing ${path.split('?')[0]}: ${res.status}`)
  return res.text ? (JSON.parse(res.text) as unknown) : null
}

async function writeShared($: EngineInterface, room: PairRoom, name: string, file: SharedFile) {
  await resolveDataDir($)
  await $.fs.write(`${pathsOf(dataDir, room.localId).out}/${name}`, JSON.stringify(file))
  isScanPending = true
}

async function highestSeqIn($: EngineInterface, room: PairRoom): Promise<number> {
  await resolveDataDir($)
  try {
    return Math.max(0, ...(await $.fs.list(pathsOf(dataDir, room.localId).out)).map(entry => seqOfMessageFile(entry.name) ?? 0))
  } catch {
    return 0
  }
}

async function nextSeq($: EngineInterface, room: PairRoom): Promise<number> {
  if (lastSeq === null) {
    const listing = seqListing?.localId === room.localId ? seqListing : { localId: room.localId, highest: highestSeqIn($, room) }
    seqListing = listing
    const highest = await listing.highest
    lastSeq = Math.max(lastSeq ?? 0, highest)
  }
  lastSeq += 1
  return lastSeq
}

async function post($: EngineInterface, room: PairRoom, body: MessagePayload): Promise<boolean> {
  try {
    const keys = await keysFor(room.code)
    const seq = await nextSeq($, room)
    await writeShared($, room, messageFile(seq), { pid: room.pid, seq, data: await seal(keys, aadFor(room.roomId, room.pid, 'msg'), body) })
    return true
  } catch {
    return false
  }
}

function followLog() {
  isScrollDue = true
}

// Never awaited by the loop, and only once the pane has been drawn somewhere: the transport must not wait on the UI.
function scrollIfDue($: EngineInterface) {
  if (!isScrollDue || !isFollowing || isScrolling || !isPaneDrawn) return
  isScrolling = true
  detach(
    $.ui
      .scroll({ in: PANE, to: 'end' })
      .then(result => {
        if (!result || !('deny' in result && result.deny)) isScrollDue = false
      })
      .finally(() => {
        isScrolling = false
      })
  )
}

async function pushEntries($: EngineInterface, entries: PairEntry[]) {
  if (entries.length === 0) return
  await update($, logAtom, log => [...log, ...entries].slice(-LOG_CAP))
  const log = await read($, logAtom)
  if (log.length >= LOG_CAP) {
    const kept = new Set(log.map(entry => entry.id))
    await update($, unreadAtom, ids => ids.filter(id => kept.has(id)))
  }
  followLog()
}

async function note($: EngineInterface, text: string) {
  await pushEntries($, [systemEntry(text)])
  $.ui.toast(`Pair · ${text}`)
}

async function markRead($: EngineInterface, id: string) {
  await update($, unreadAtom, ids => ids.filter(x => x !== id))
}

async function resetSession($: EngineInterface, room: PairRoom | null) {
  await update($, roomAtom, () => room)
  await update($, peerAtom, () => null)
  await update($, logAtom, () => [])
  await update($, unreadAtom, () => [])
  await update($, receivedAtom, () => [])
  await update($, linkAtom, () => 'starting')
  await update($, problemAtom, () => null)
  peerStateCache = null
  outbox.length = 0
  forwards.length = 0
  forwardLimit.clear()
  incomingLimit.clear()
  floodSaidAt = 0
  isHosting = room?.role === 'host'
  isFollowing = true
  isScrollDue = room !== null
}

async function pendingProposals($: EngineInterface): Promise<PairMessageEntry[]> {
  return (await read($, logAtom)).filter(isProposalIn(await read($, unreadAtom)))
}

async function dropWaiting($: EngineInterface) {
  const left = await pendingProposals($)
  await update($, unreadAtom, () => [])
  if (left.length > 0) {
    const who = left[0]?.author ?? 'your last guest'
    await pushEntries($, [systemEntry(`Dropped ${left.length === 1 ? `${who}'s waiting message` : `${left.length} messages ${who} left waiting`}`)])
  }
}

async function refreshStatus($: EngineInterface) {
  const text = statusLine(await readRoom($), await read($, peerAtom), await read($, linkAtom))
  if (text === shownStatus) return
  shownStatus = text
  $.ui.status(text)
}

async function setLink($: EngineInterface, next: PairLink) {
  const prev = await read($, linkAtom)
  if (prev === next) return
  await update($, linkAtom, () => next)
  if (next === 'offline') $.ui.toast('Pair · connection lost, retrying')
  else if (next === 'full') $.ui.toast('Pair · this pairing already has two people')
  else if (next === 'ok' && prev === 'offline') $.ui.toast('Pair · reconnected')
}

async function publishState($: EngineInterface, room: PairRoom, keys: RoomKeys) {
  const state = stateFor(room, { name: myName, tool: lastTool, workingSince }, await $.clock.now())
  const signature = JSON.stringify(state)
  if (signature === sentSignature) return
  await writeShared($, room, STATE_FILE, { pid: room.pid, seq: 0, data: await seal(keys, aadFor(room.roomId, room.pid, 'state'), state) })
  sentSignature = signature
}

// Whatever was queued before the guest was let in was dropped when they were: the session so far reaches
// them whole.
async function flushOutbox($: EngineInterface, room: PairRoom) {
  if (room.role !== 'host' || outbox.length === 0 || !room.guestDeviceId) return
  const batches = batchesOf(outbox.splice(0, outbox.length))
  for (const [index, batch] of batches.entries()) {
    if (!(await post($, room, { ...envelope(), kind: 'events', events: batch }))) {
      outbox.unshift(...batches.slice(index).flat())
      return
    }
  }
}

// The session so far goes out once a guest is in, read then; a guest who takes over the seat later gets
// it afresh.
async function postHistory($: EngineInterface, room: PairRoom): Promise<PairRoom> {
  if (room.role !== 'host' || !room.guestDeviceId || room.isHistoryPosted) return room
  for (const batch of batchesOf(await pastConversation($))) {
    if (!(await post($, room, { ...envelope(), kind: 'history', events: batch }))) return room
  }
  await update($, roomAtom, current => (isPairRoom(current) ? { ...current, isHistoryPosted: true } : current))
  return { ...room, isHistoryPosted: true }
}

async function scanIfPending($: EngineInterface, room: PairRoom) {
  if (!isScanPending || !node?.isReady) return
  isScanPending = false
  try {
    await rest($, `/rest/db/scan?folder=${myFolderIdOf(room)}`, { method: 'POST' })
  } catch {
    isScanPending = true
  }
}

// The guest dials the host; the host never looks anyone up. Syncthing's own lookup of a device it has
// not seen backs off for half an hour, so a guest that starts before the host has announced itself
// would sit there: the guest looks the host up here instead, every few seconds, and hands Syncthing
// the addresses.
async function updateConnection($: EngineInterface, room: PairRoom) {
  const peerId = peerDeviceId(room)
  const nowMs = await $.clock.now()
  if (!peerId) {
    isConnected = false
    await setLink($, 'connecting')
    return
  }
  const answer = await rest($, '/rest/system/connections')
  isConnected = isConnections(answer) && answer.connections[peerId]?.connected === true
  // Online is the connection, whatever the other side has written or not: only a goodbye means left.
  const peer = await read($, peerAtom)
  if (peer && !peer.hasLeft && (peer.isOnline !== isConnected || (!isConnected && peer.isWorking))) {
    await update($, peerAtom, current => (current ? { ...current, isOnline: isConnected, isWorking: isConnected && current.isWorking } : current))
  }
  if (isConnected) {
    lastConnectedAt = nowMs
    await setLink($, 'ok')
    return
  }
  await setLink($, lastConnectedAt > 0 ? 'offline' : 'connecting')
  if (room.role !== 'guest') return
  // Eager while joining, then gentle on the public discovery servers.
  const every = nowMs - room.startedAt < LOOKUP_EAGER_MS || lastConnectedAt > 0 ? LOOKUP_EVERY_MS : LOOKUP_IDLE_MS
  if (nowMs - lastLookupAt < every) return
  lastLookupAt = nowMs
  try {
    const found = await $.http.fetch(`${DISCOVERY_LOOKUP}${peerId}`)
    const addresses = found.status === 200 ? addressesFrom(found.text) : []
    if (addresses.length > 0 && peerVisibleSince === 0) peerVisibleSince = nowMs
    const key = JSON.stringify(addresses)
    if (addresses.length > 0 && key !== injectedAddresses) {
      await rest($, `/rest/config/devices/${peerId}`, { method: 'PATCH', body: { addresses: [...addresses, 'dynamic'] } })
      injectedAddresses = key
    }
  } catch {
    // looked up again on the next round
  }
}

// The seat is free until a guest is admitted, and again once that guest has said goodbye or been
// gone a while (a crashed session comes back as a new device, under a new pid).
async function isSeatFree($: EngineInterface, room: PairRoom): Promise<boolean> {
  if (!room.guestDeviceId) return true
  if ((await read($, peerAtom))?.hasLeft) return true
  return !isConnected && (await $.clock.now()) - Math.max(lastConnectedAt, room.guestSince) > SEAT_TIMEOUT_MS
}

// Everything posted to the last guest is deleted before the folder is shared with a new one: the scan
// records the deletions first, so none of it reaches the new device.
async function clearPosted($: EngineInterface, room: PairRoom) {
  const { out } = pathsOf(dataDir, room.localId)
  const posted = (await $.fs.list(out).catch((): FsEntry[] => [])).filter(entry => seqOfMessageFile(entry.name) !== null)
  if (posted.length > 0) await run($, ['rm', '-f', ...posted.map(entry => `${out}/${entry.name}`)])
  await rest($, `/rest/db/scan?folder=${hostFolderIdOf(room.roomId)}`, { method: 'POST' })
}

// The last guest's folder, device and posted files go before the new guest's are made, so a new guest
// never meets what the old one left (the scan records the deletions first), and the host's state names
// the new guest before the folder is shared, so they never read a stale one. The host sees the guest the
// moment they are let in; their name follows with their first state.
async function seatGuest($: EngineInterface, room: PairRoom, deviceId: string, pid: string, name: string): Promise<PairRoom> {
  const me = room.hostDeviceId
  if (!me) return room
  if (room.guestDeviceId) {
    await clearPosted($, room)
    if (room.guestPid) {
      await rest($, `/rest/config/folders/${guestFolderIdOf(room.roomId, room.guestPid)}`, { method: 'DELETE' }).catch(() => undefined)
      await $.process.run(['rm', '-rf', `${pathsOf(dataDir, room.localId).dir}/in-${room.guestPid}`]).catch(() => undefined)
    }
    await rest($, `/rest/config/devices/${room.guestDeviceId}`, { method: 'DELETE' }).catch(() => undefined)
  }
  const seated: PairRoom = { ...room, guestPid: pid, guestDeviceId: deviceId, guestSince: await $.clock.now(), isHistoryPosted: false }
  await publishState($, seated, await keysFor(room.code))
  await scanIfPending($, room)
  const deviceDefaults = await rest($, '/rest/config/defaults/device')
  await rest($, `/rest/config/devices/${deviceId}`, { method: 'PUT', body: guestDevice(deviceDefaults, deviceId, name) })
  const folderDefaults = await rest($, '/rest/config/defaults/folder')
  const inbound: FolderSpec = { id: guestFolderIdOf(room.roomId, pid), path: `${pathsOf(dataDir, room.localId).dir}/in-${pid}`, type: 'receiveonly' }
  await rest($, `/rest/config/folders/${inbound.id}`, { method: 'PUT', body: inboundFolder(folderDefaults, inbound, [me, deviceId]) })
  await rest($, `/rest/config/folders/${hostFolderIdOf(room.roomId)}`, {
    method: 'PATCH',
    body: { devices: [{ deviceID: me }, { deviceID: deviceId }] }
  })
  outbox.length = 0
  await update($, roomAtom, current =>
    isPairRoom(current) ? { ...current, guestPid: pid, guestDeviceId: deviceId, guestSince: seated.guestSince, isHistoryPosted: false } : current
  )
  if (room.guestDeviceId) {
    await dropWaiting($)
    await update($, receivedAtom, () => [])
    peerStateCache = null
    peerStateFile = null
  }
  await update($, peerAtom, () => ({ pid, name: GUEST, isOnline: false, hasLeft: false, isWorking: false, tool: null }))
  await note($, 'A guest joined')
  isConnected = false
  lastConnectedAt = 0
  return seated
}

// A device the host's Syncthing does not know is parked as pending, with the name it introduced itself
// under. While the seat is free, the first one whose name proves it holds the invite is let in: the
// invite is the whole capability, for the first guest and for whoever takes the seat after them. A knock
// under the host's own pid, or the pid of the guest being replaced, is refused: the folders and the files
// in them are told apart by pid.
async function admitGuest($: EngineInterface, room: PairRoom): Promise<PairRoom> {
  if (room.role !== 'host' || !(await isSeatFree($, room))) return room
  const pending = await rest($, '/rest/cluster/pending/devices')
  const keys = await keysFor(room.code)
  const knocks = isPendingDevices(pending) ? Object.entries(pending) : []
  const newestFirst = knocks.sort((a, b) => (b[1].time ?? '').localeCompare(a[1].time ?? ''))
  for (const [deviceId, knock] of newestFirst.slice(0, PENDING_CAP)) {
    const name = knock.name ?? ''
    const pid = await guestClaim(keys, deviceId, name)
    if (pid && pid !== room.pid && pid !== room.guestPid && !room.departed.includes(deviceId)) return seatGuest($, room, deviceId, pid, name)
  }
  return room
}

async function readShared($: EngineInterface, path: string): Promise<SharedFile | null> {
  try {
    return parseSharedFile(await $.fs.read(path))
  } catch {
    return null
  }
}

// The other side's folder: its state slot and the messages after the cursor. Only plain files of our
// own naming are read; links and anything else are skipped. On the host, only files under the seated
// guest's pid count: the folder is theirs, but the pid inside a file is whatever they wrote.
async function readPeer($: EngineInterface, room: PairRoom): Promise<PollBody | null> {
  const dir = inPathOf(dataDir, room)
  if (!dir) return null
  let entries: FsEntry[] = []
  try {
    entries = await $.fs.list(dir)
  } catch {
    return null
  }
  const files = entries.filter(entry => entry.kind === 'file' && !entry.isLink && entry.size <= FILE_MAX_BYTES)
  const nowMs = await $.clock.now()
  const stateEntry = files.find(entry => entry.name === STATE_FILE)
  if (stateEntry && !(peerStateFile && peerStateFile.name === dir && peerStateFile.mtimeMs === stateEntry.mtimeMs && peerStateFile.size === stateEntry.size)) {
    peerStateFile = { name: dir, mtimeMs: stateEntry.mtimeMs, size: stateEntry.size, file: await readShared($, `${dir}/${STATE_FILE}`) }
  }
  const isOwn = (pid: string): boolean => room.role !== 'host' || pid === room.guestPid
  const state = stateEntry && peerStateFile?.name === dir && peerStateFile.file && isOwn(peerStateFile.file.pid) ? peerStateFile.file : null
  const received = await read($, receivedAtom)
  const unread = files
    .map(entry => seqOfMessageFile(entry.name))
    .filter((seq): seq is number => seq !== null && !isReceived(received, seq))
    .sort((a, b) => a - b)
  const isWaitedFor = (missing: number) => gap?.dir === dir && gap.seq === missing && nowMs - gap.since >= GAP_WAIT_MS
  const { seqs: ready, missing } = toRead(unread, received, isWaitedFor)
  const seqs = ready.slice(0, FILES_PER_TICK)
  gap = missing === null ? null : gap?.dir === dir && gap.seq === missing ? gap : { dir, seq: missing, since: nowMs }
  const messages: PollBody['messages'] = []
  for (const seq of seqs) {
    const file = await readShared($, `${dir}/${messageFile(seq)}`)
    if (file && file.seq === seq && isOwn(file.pid)) messages.push({ seq, pid: file.pid, data: file.data })
  }
  return {
    now: nowMs,
    read: seqs,
    peer: state ? { pid: state.pid, seenAt: isConnected ? nowMs : lastConnectedAt, rev: stateEntry?.mtimeMs ?? 0, state: state.data } : null,
    messages
  }
}

async function decide($: EngineInterface, room: PairRoom, entry: PairEntry, outcome: 'sent' | 'failed') {
  await post($, room, { ...envelope(), kind: 'decision', ref: entry.id, outcome })
}

// A guest's messages go to Claude in the order they came, at most FORWARDS_PER_MINUTE a minute; the
// rest wait their turn.
async function forwardWaiting($: EngineInterface) {
  const nowMs = await $.clock.now()
  for (const entry of await pendingProposals($)) {
    if (!forwardLimit.take(nowMs)) return
    await markRead($, entry.id)
    forwards.push(entry)
  }
}

async function submitForwards($: EngineInterface, room: PairRoom) {
  for (let entry = forwards.shift(); entry; entry = forwards.shift()) {
    const message = entry
    // Marked as a guest's, so no name the guest picks reads to Claude as the host's own.
    const author = message.author === GUEST ? GUEST : `${message.author} (guest)`
    detach(
      $.prompt.submit({ text: `${author}: ${message.text}` }).then(
        result => ('drop' in result && result.drop ? decide($, room, message, 'failed') : undefined),
        () => decide($, room, message, 'failed')
      )
    )
    await share($, [{ t: 'user', who: message.author, ref: message.id, text: message.text }])
    await decide($, room, message, 'sent')
    await pushEntries($, [systemEntry(`Sent ${message.author}'s message to Claude`)])
  }
}

// The conversation from before the pairing goes above everything said since, however late it arrives.
async function insertHistory($: EngineInterface, entries: PairEntry[], peerName: string) {
  const divider = systemEntry(`${peerName} started sharing here`, HISTORY_DIVIDER)
  await update($, logAtom, log => {
    const at = log.findIndex(entry => entry.id === HISTORY_DIVIDER)
    return (at === -1 ? [...entries, divider, ...log] : [...log.slice(0, at), ...entries, ...log.slice(at)]).slice(-LOG_CAP)
  })
  followLog()
}

async function canReceive($: EngineInterface, nowMs: number, peerName: string): Promise<boolean> {
  if ((await read($, peerAtom))?.hasLeft) return false
  if (incomingLimit.take(nowMs)) return true
  if (nowMs - floodSaidAt > 60_000) {
    floodSaidAt = nowMs
    await note($, `${peerName} is sending a lot at once; some of it was dropped`)
  }
  return false
}

// A guest who said goodbye keeps nothing of the session: their device comes off the host's folder and is
// never let in again (a Syncthing still lingering would knock once more), and the seat is free for
// whoever comes next with the invite.
async function dismissGuest($: EngineInterface, room: PairRoom) {
  const gone = room.guestDeviceId
  if (room.role !== 'host' || !gone || !room.hostDeviceId) return
  await update($, roomAtom, current => (isPairRoom(current) ? { ...current, departed: [...current.departed, gone].slice(-DEPARTED_CAP) } : current))
  await rest($, `/rest/config/folders/${hostFolderIdOf(room.roomId)}`, { method: 'PATCH', body: { devices: [{ deviceID: room.hostDeviceId }] } })
  await rest($, `/rest/config/devices/${gone}`, { method: 'DELETE' })
}

async function ingestFromPeer($: EngineInterface, room: PairRoom, body: MessagePayload, known: Set<string>, peerName: string) {
  const isHost = room.role === 'host'

  if (body.kind === 'events' && !isHost) {
    await pushEntries($, entriesOf(body.mid, body.events, known, peerName, ''))
    return
  }

  if (body.kind === 'history' && !isHost) {
    const entries = entriesOf(body.mid, body.events, known, peerName, 'h:')
    if (entries.length > 0) await insertHistory($, entries, peerName)
    return
  }

  if (body.kind === 'proposal' && isHost) {
    const text = cleanText(body.text, PROPOSAL_CAP)
    if (!text) return
    const entry: PairMessageEntry = { id: body.mid, kind: 'proposal', from: 'partner', author: peerName, text }
    await pushEntries($, [entry])
    await update($, unreadAtom, ids => [...ids, entry.id])
    return
  }

  if (body.kind === 'decision' && !isHost) {
    const text = body.outcome === 'sent' ? '✓ sent to Claude' : 'could not be delivered to Claude'
    await pushEntries($, [{ id: body.mid, kind: 'decision', text, isError: body.outcome === 'failed' }])
    if (body.outcome !== 'sent') $.ui.toast(`Pair · your message ${text}`)
    return
  }

  if (body.kind === 'bye') {
    const peer = await read($, peerAtom)
    if (peer && !peer.hasLeft) {
      await update($, peerAtom, () => ({ ...peer, hasLeft: true, isOnline: false, isWorking: false }))
      await note($, isHost ? `${peerName} left` : `${peerName} ended the session`)
      if (isHost) await dropWaiting($)
      await dismissGuest($, room).catch(() => undefined)
    }
  }
}

async function applyPoll($: EngineInterface, room: PairRoom, keys: RoomKeys, poll: PollBody) {
  const isHost = room.role === 'host'
  const fallback = isHost ? 'Guest' : 'Host'
  const prev = await read($, peerAtom)
  const row = poll.peer?.pid === room.pid ? null : poll.peer
  let peer = prev

  if (row && !(prev && prev.pid === row.pid && prev.hasLeft)) {
    let state: StatePayload | null = null
    if (peerStateCache && peerStateCache.pid === row.pid && peerStateCache.rev === row.rev) {
      state = peerStateCache.state
    } else {
      const decoded = await open(keys, aadFor(room.roomId, row.pid, 'state'), row.state)
      state = isStatePayload(decoded) && decoded.role !== room.role ? decoded : null
      peerStateCache = { pid: row.pid, rev: row.rev, state }
    }
    const sameAsBefore = prev !== null && prev.pid === row.pid
    const chosen = cleanName(state?.name ?? '', '')
    const name = chosen || (sameAsBefore ? prev.name : fallback)
    peer = {
      pid: row.pid,
      name,
      isOnline: poll.now - row.seenAt < ONLINE_MS,
      hasLeft: false,
      isWorking: state?.isWorking ?? false,
      tool: state?.tool ? cleanToolName(state.tool) || null : null
    }
    if (!sameAsBefore) await note($, isHost ? `${peer.name} joined` : `Watching ${peer.name}`)
    else if (prev.name !== peer.name) await note($, prev.name === fallback ? `Your guest is ${peer.name}` : `${prev.name} is now called ${peer.name}`)
  }
  if (JSON.stringify(peer) !== JSON.stringify(prev)) await update($, peerAtom, () => peer)

  const known = new Set((await read($, logAtom)).map(entry => entry.id))
  const peerName = peer?.name ?? fallback
  for (const message of poll.messages) {
    if (message.pid === room.pid) continue
    // On the host, every file the guest wrote counts toward what it may send, before anything is read of it.
    if (isHost && !(await canReceive($, poll.now, peerName))) continue
    const body = await open(keys, aadFor(room.roomId, message.pid, 'msg'), message.data)
    if (!isMessagePayload(body)) continue
    if (known.has(body.mid) || known.has(`${body.mid}:0`) || known.has(`h:${body.mid}:0`)) continue
    await ingestFromPeer($, room, body, known, peerName)
    known.add(body.mid)
  }
  if (poll.read.length > 0) await update($, receivedAtom, received => withReceived(received, poll.read))
}

async function keepAlive($: EngineInterface, room: PairRoom) {
  const nowMs = await $.clock.now()
  if (isOutputDirty && nowMs - lastOutputSaveAt >= OUTPUT_SAVE_EVERY_MS) {
    isOutputDirty = false
    lastOutputSaveAt = nowMs
    await $.fs.write(`${pathsOf(dataDir, room.localId).st}/syncthing.log`, syncthingOutput).catch(() => undefined)
  }
  if (nowMs - lastAliveAt < ALIVE_EVERY_MS) return
  lastAliveAt = nowMs
  await $.fs.write(`${pathsOf(dataDir, room.localId).dir}/alive`, String(nowMs)).catch(() => undefined)
}

async function lookingTooLong($: EngineInterface, room: PairRoom): Promise<boolean> {
  if (room.role !== 'guest' || lastConnectedAt > 0) return false
  const waited = (await $.clock.now()) - room.startedAt
  if (waited > GIVE_UP_MS) return true
  if (waited > STILL_LOOKING_MS && !hasSaidStillLooking) {
    hasSaidStillLooking = true
    await note($, "Still looking for the host. Check the invite, and that their /pair is still running.")
  }
  return false
}

// A guest the host has not let in can see the host but never connects: someone else may hold the seat,
// or the host's pair is a version that does not admit this one.
async function updateSeatHint($: EngineInterface, room: PairRoom) {
  if (room.role !== 'guest') return
  const current = await read($, problemAtom)
  if (current !== null && current !== SEAT_HINT) return
  const isStuck =
    !(await read($, peerAtom)) && peerVisibleSince > 0 && (await $.clock.now()) - peerVisibleSince > SEAT_HINT_AFTER_MS
  await setProblem($, isStuck ? SEAT_HINT : null)
}

// Syncthing drops a device whose ID does not check out, and says nothing: a guest whose config no longer
// names the host has a mistyped invite, and would otherwise look for the host until it gives up.
async function knowsHost($: EngineInterface, room: PairRoom): Promise<boolean> {
  if (room.role !== 'guest') return true
  const devices = await rest($, '/rest/config/devices').catch(() => null)
  return !isConfiguredDevices(devices) || devices.some(device => device.deviceID === room.hostDeviceId)
}

// The pairing cannot go on (someone else took the guest seat, the host never showed): Syncthing stops,
// and the room stays, saying why, until /pair stop clears it.
async function halt($: EngineInterface, link: PairLink, problem: string | null) {
  nextStartAt = Number.POSITIVE_INFINITY
  await stopNode(node)
  await setLink($, link)
  await setProblem($, problem)
}

async function tick($: EngineInterface) {
  // A host call that never answers must not freeze the loop for the rest of the session.
  if (tickStartedAt !== null && Date.now() - tickStartedAt < TICK_STUCK_MS) return
  const runId = ++tickRun
  tickStartedAt = Date.now()
  try {
    let room = await readRoom($)
    isHosting = room?.role === 'host'
    if (!room) return
    const nowMs = await $.clock.now()

    if (!node || node.roomKey !== roomKeyOf(room)) {
      if (node) await stopNode(node)
      if (nowMs >= nextStartAt) detach(startNode($, room))
      await refreshStatus($)
      scrollIfDue($)
      return
    }
    await keepAlive($, room)
    if (!node.isReady) {
      if (await rest($, '/rest/system/ping').then(() => true, () => false)) {
        node.isReady = true
        quickExits = 0
        await setProblem($, null)
        await setLink($, 'connecting')
        if (!(await knowsHost($, room))) await halt($, 'failed', MISTYPED_INVITE)
      } else if (nowMs - node.startedAt > READY_WITHIN_MS) {
        await stopNode(node)
        nextStartAt = nowMs + RESTART_AFTER_MS
        await setProblem($, 'Syncthing did not start; retrying.')
      }
      await refreshStatus($)
      return
    }

    const keys = await keysFor(room.code)
    room = await admitGuest($, room)
    room = await postHistory($, room)
    await updateConnection($, room)
    await publishState($, room, keys)
    await flushOutbox($, room)
    await scanIfPending($, room)
    const poll = await readPeer($, room)
    if (poll) await applyPoll($, room, keys, poll)
    await updateSeatHint($, room)
    if (room.role === 'host') await forwardWaiting($)
    await submitForwards($, room)
    await scanIfPending($, room)

    const hostState = room.role === 'guest' ? peerStateCache?.state : null
    if (hostState?.guest && hostState.guest !== room.pid) {
      await halt($, 'full', null)
    } else if (await lookingTooLong($, room)) {
      await halt($, 'failed', "No pairing found for that invite: the host's /pair may have stopped, or the invite was mistyped. /pair stop to clear it.")
    }
    await refreshStatus($)
    scrollIfDue($)
  } catch {
    // a failed tick is simply retried on the next one
  } finally {
    if (tickRun === runId) tickStartedAt = null
  }
}

const INVITE_NOT_YET = 'Your invite is ready once Syncthing is up, usually in a few seconds.'

// Why there is no invite, or no sending: still starting, or stopped for good.
async function notUpYet($: EngineInterface): Promise<string> {
  return (await read($, linkAtom)) === 'failed'
    ? `This pairing has stopped: ${(await read($, problemAtom)) ?? 'see /pair'}. /pair stop clears it.`
    : INVITE_NOT_YET
}

async function copyInvite($: EngineInterface, room: PairRoom, surface?: RenderSurface) {
  const text = inviteText(room)
  if (!text) {
    $.ui.toast(`Pair · ${await notUpYet($)}`)
    return
  }
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(copied.isCopied ? 'Pair · invite copied' : 'Pair · could not copy, run /pair invite')
}

async function wipeRoom($: EngineInterface, room: PairRoom) {
  await resolveDataDir($)
  const paths = pathsOf(dataDir, room.localId)
  await $.process.run(['rm', '-rf', paths.dir, paths.socket]).catch(() => undefined)
}

async function retire($: EngineInterface, running: SyncthingNode | null, room: PairRoom) {
  await stopNode(running)
  await wipeRoom($, room)
}

// Rooms left behind by sessions that ended without /pair stop (the module unloading kills Syncthing,
// but nothing then deletes the folder).
async function sweepStaleRooms($: EngineInterface, current: PairRoom) {
  await resolveDataDir($)
  const nowMs = await $.clock.now()
  let entries: FsEntry[] = []
  try {
    entries = await $.fs.list(`${dataDir}/rooms`)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.name === roomKeyOf(current)) continue
    const { dir, socket } = pathsOf(dataDir, entry.name)
    const alive = await $.fs.stat(`${dir}/alive`).catch(() => null)
    if (!alive || nowMs - alive.mtimeMs > STALE_ROOM_MS) {
      await $.process.run(['rm', '-rf', dir, socket]).catch(() => undefined)
    }
  }
}

// Leaving: the goodbye is written first, and Syncthing lingers a few seconds to deliver it before it
// is stopped and the room's folder (keys, config, shared files) is deleted.
async function endPairing($: EngineInterface, room: PairRoom, options: { sayBye: boolean; linger: boolean }) {
  if (options.sayBye) {
    await post($, room, { ...envelope(), kind: 'bye' })
    await scanIfPending($, room)
  }
  stopTimer()
  const running = node
  node = null
  keyCache.delete(room.code)
  resetTransport()
  await resetSession($, null)
  await refreshStatus($)
  await $.ui.close({ id: PANE })
  if (options.linger && running?.isReady) $.clock.after(LINGER_MS, () => detach(retire($, running, room)))
  else await retire($, running, room)
}

// A pairing a different version of pair started, still held when this one loaded (an update arrived
// mid-pairing): its Syncthing went with the old code, so it ends here, said once.
async function endOutdated($: EngineInterface, stored: unknown) {
  stopTimer()
  resetTransport()
  await resetSession($, null)
  await refreshStatus($)
  await $.ui.close({ id: PANE }).catch(() => undefined)
  $.ui.toast('Pair · pair was updated, which ended your pairing. Run /pair to start a new one.')
  const localId = localIdOf(stored)
  if (!localId) return
  await resolveDataDir($)
  const { dir, socket } = pathsOf(dataDir, localId)
  await $.process.run(['rm', '-rf', dir, socket]).catch(() => undefined)
}

async function pastConversation($: EngineInterface): Promise<PairEvent[]> {
  try {
    return eventsFromHistory(await $.session.messages(), hostLabel(), sessionCwd)
  } catch {
    return []
  }
}

async function startPairing($: EngineInterface): Promise<string> {
  await resolveName($)
  try {
    await resolveDataDir($)
  } catch (error) {
    return errorText(error)
  }
  const code = generateCode()
  const keys = await keysFor(code)
  const room: PairRoom = {
    v: ROOM_FORMAT,
    code,
    hostDeviceId: null,
    roomId: keys.roomId,
    pid: randomId(8),
    localId: randomId(12),
    role: 'host',
    guestPid: null,
    guestDeviceId: null,
    guestSince: 0,
    departed: [],
    isHistoryPosted: false,
    startedAt: await $.clock.now()
  }
  resetTransport()
  await resetSession($, room)
  await pushEntries($, [systemEntry('Pairing started')])
  detach(sweepStaleRooms($, room))
  ensureTimer($)
  await $.ui.open({ id: PANE, title: 'Pair' })
  await refreshStatus($)
  return `Pairing started. Your invite goes to your clipboard once Syncthing is up, in a few seconds: send it to your guest and they run it in their Claude Code (/pair invite shows it). They will see the whole session, tool output included, and what they send goes straight to Claude with your permissions, at most ${FORWARDS_PER_MINUTE} messages a minute.`
}

async function redrawPreview($: EngineInterface) {
  previewVersion++
  await update($, previewTickAtom, n => n + 1)
}

// The session so far, read once when the preview opens; whatever happens while it is read goes after it.
async function readPreview($: EngineInterface) {
  const reading = ++previewReads
  let past: PairEvent[] = []
  try {
    past = eventsFromHistory(await $.session.messages(), hostLabel(), sessionCwd)
    previewError = null
  } catch (error) {
    previewError = errorText(error)
  }
  if (reading !== previewReads || !isPreviewOpen) return
  previewEvents = [...past, ...previewEvents].slice(-LOG_CAP)
  isPreviewBuilt = true
  await redrawPreview($)
}

// Someone is shown the session as it happens: the guest of a pairing, and the preview.
const isSharing = (): boolean => isHosting || isPreviewOpen

async function share($: EngineInterface, events: PairEvent[]) {
  if (events.length === 0) return
  if (isHosting) enqueue(events)
  if (!isPreviewOpen) return
  previewEvents = [...previewEvents, ...events].slice(-LOG_CAP)
  await redrawPreview($)
}

function startPreview() {
  isPreviewOpen = true
  isPreviewBuilt = false
  previewEvents = []
  previewError = null
}

// Drawn from what the preview holds, cleaned as the guest's side cleans what arrives.
function latestPreviewEntries(): PairEntry[] {
  if (previewEntries?.version !== previewVersion) {
    previewEntries = { version: previewVersion, entries: entriesOf('preview', previewEvents, new Set(), hostLabel(), 'p:') }
  }
  return previewEntries.entries
}

// A reload of this module finds the preview still open: it starts again from the session so far.
async function resumePreview($: EngineInterface) {
  if (!(await $.ui.panes()).some(pane => pane.id === PREVIEW)) return
  startPreview()
  await readPreview($)
}

// A desktop row of tool calls opened or closed again, for every pane that draws it.
async function toggleExpanded($: EngineInterface, id: string) {
  await update($, expandedAtom, ids => (ids.includes(id) ? ids.filter(other => other !== id) : [...ids, id].slice(-EXPANDED_CAP)))
}

async function showMorePreview($: EngineInterface) {
  previewRows += PREVIEW_MORE_ROWS
  await update($, previewTickAtom, n => n + 1)
}

// The same as the preview's clicks, for a surface whose clicks do not reach a plugin.
async function previewCommand($: EngineInterface, arg: string): Promise<string> {
  if (arg === '') return openPreview($)
  if (!isPreviewOpen) return 'Open the preview first: /pair preview.'
  if (arg === 'more') previewRows += PREVIEW_MORE_ROWS
  else if (arg === 'all') previewRows = Number.MAX_SAFE_INTEGER
  else if (arg === 'open' || arg === 'close') arePreviewRowsOpen = arg === 'open'
  else return 'Use /pair preview more or all for earlier rows, and open or close for each tool call.'
  await update($, previewTickAtom, n => n + 1)
  return arg === 'more'
    ? `The preview shows ${PREVIEW_MORE_ROWS} more rows.`
    : arg === 'all'
      ? 'The preview shows every row.'
      : arg === 'open'
        ? 'The preview shows each tool call.'
        : 'The preview folds tool calls again.'
}

async function openPreview($: EngineInterface): Promise<string> {
  const room = await readRoom($)
  if (room?.role === 'guest') return "You're watching someone else's session: there is nothing of yours to preview."
  startPreview()
  previewRows = PREVIEW_ROWS
  arePreviewRowsOpen = false
  await $.ui.open({ id: PREVIEW, title: 'Pair preview' })
  detach(readPreview($))
  return `The preview shows this session as ${room ? 'your guest sees' : 'a guest would see'} it, and follows it as you work.`
}

async function joinPairing($: EngineInterface, invite: Invite): Promise<string> {
  await resolveName($)
  try {
    await resolveDataDir($)
  } catch (error) {
    return errorText(error)
  }
  const keys = await keysFor(invite.code)
  const room: PairRoom = {
    v: ROOM_FORMAT,
    code: invite.code,
    hostDeviceId: invite.hostDeviceId,
    roomId: keys.roomId,
    pid: randomId(8),
    localId: randomId(12),
    role: 'guest',
    guestPid: null,
    guestDeviceId: null,
    guestSince: 0,
    departed: [],
    isHistoryPosted: false,
    startedAt: await $.clock.now()
  }
  resetTransport()
  await resetSession($, room)
  detach(sweepStaleRooms($, room))
  ensureTimer($)
  await $.ui.open({ id: PANE, title: 'Pair' })
  await refreshStatus($)
  return 'Connecting. The Pair pane shows the session once you are connected, usually within a few seconds; ask Claude something there or with /pair <message>.'
}

async function stopPairing($: EngineInterface): Promise<string> {
  const room = await readRoom($)
  if (!room) return 'Not paired.'
  await endPairing($, room, { sayBye: true, linger: true })
  return 'Pairing stopped.'
}

async function sendProposal($: EngineInterface, raw: string): Promise<string> {
  const room = await readRoom($)
  if (!room || room.role !== 'guest') return 'Only the guest can ask the host’s Claude.'
  if ((await read($, linkAtom)) === 'failed') return `Not sent. ${await notUpYet($)}`
  const text = cleanText(raw, PROPOSAL_CAP + 1)
  if (!text) return 'Nothing to send.'
  if (text.length > PROPOSAL_CAP) return `Too long: keep it under ${PROPOSAL_CAP} characters.`
  const body = { ...envelope(), kind: 'proposal' as const, text }
  if (!(await post($, room, body))) return "Couldn't save it; not sent."
  await pushEntries($, [{ id: body.mid, kind: 'proposal', from: 'me', author: 'you', text }])
  const peer = await read($, peerAtom)
  if (!peer) return 'Saved; it goes to the host once you are connected.'
  return `Sent. ${peer.name}'s Claude gets it right away.`
}

async function recentLog($: EngineInterface, count: number): Promise<string> {
  const log = await read($, logAtom)
  return log.length === 0 ? 'Nothing yet.' : log.slice(-count).map(lineOf).join('\n')
}

async function handleCommand($: EngineInterface, args: string): Promise<string> {
  const room = await readRoom($)
  const command = commandOf(args, room?.role ?? null)
  switch (command.kind) {
    case 'status':
      if (!room) return startPairing($)
      await $.ui.open({ id: PANE, title: 'Pair' })
      followLog()
      return describePairing(room, await read($, peerAtom), await read($, linkAtom), await read($, problemAtom))
    case 'stop':
      return stopPairing($)
    case 'invite': {
      if (room?.role !== 'host') return 'Only the host has an invite to share.'
      const text = inviteText(room)
      if (!text) return notUpYet($)
      return (await $.ui.copy({ text })).isCopied ? 'Invite copied to your clipboard.' : `Invite: ${text}`
    }
    case 'preview':
      return previewCommand($, command.arg)
    case 'log':
      return room ? recentLog($, command.count) : 'Not paired.'
    case 'join':
      return room ? 'Already paired. Run /pair stop first.' : joinPairing($, command.invite)
    case 'send':
      return sendProposal($, command.text)
    case 'hint':
      return room ? 'Your guest sees what you type to Claude; /pair takes invite, preview, log or stop.' : 'Not paired. Run /pair to host a session, or /pair <invite> to join one.'
  }
}

// Messages are sent under a name: the configured one, else the OS user ("robin" shows as "Robin").
// Resolved when a pairing starts, not at session start: an installed plugin does nothing until /pair.
async function resolveName($: EngineInterface) {
  if (configuredName || isNameResolved) return
  isNameResolved = true
  try {
    const out = await $.process.run(['id', '-un'], { timeoutMs: 2000 })
    const user = out.exitCode === 0 ? cleanName(out.stdout, '') : ''
    myName = user ? user.charAt(0).toUpperCase() + user.slice(1) : ''
  } catch {
    myName = ''
  }
}

// The loop only runs while a pairing is open.
function ensureTimer($: EngineInterface) {
  if (timer) return
  const ticking = $.clock.every(TICK_MS, () => tick($))
  timer = ticking
}

function stopTimer() {
  timer?.cancel()
  timer = null
}

export const register: Register = (on, options) => {
  configuredName = typeof options.displayName === 'string' ? cleanName(options.displayName, '') : ''
  myName = configuredName

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pair',
      description: 'Share this session with someone, or watch someone else’s, peer to peer',
      argumentHint: '[invite | message | preview [more | all | open | close] | log [n] | stop]'
    })
    sessionCwd = e.cwd
    const stored: unknown = await read($, roomAtom)
    if (stored !== null && !isPairRoom(stored)) await endOutdated($, stored)
    else if (stored !== null) ensureTimer($)
    detach(resumePreview($))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const room = await readRoom($)
    if (room) {
      try {
        await endPairing($, room, { sayBye: true, linger: false })
      } catch {
        // the session ends either way
      }
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isMainTurnOpen = true
    workingSince = await $.clock.now()
    lastTool = null

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (result.drop === undefined && isSharing()) {
      try {
        const event = promptEventOf({ ...e, text: result.text }, hostLabel())
        if (event) await share($, [event])
      } catch {
        // an unexpected prompt shape must never get in the way of the prompt
      }
    }

    return result
  })

  on('tool.call', async ($, e, next) => {
    lastTool = e.tool
    const result = await next(e)
    if (isSharing() && !e.agentId) {
      try {
        // The call's arguments ride on the event itself, beside the envelope's own fields.
        const { tool: _tool, tool_use_id: _id, agentId: _agent, consent: _consent, ...input } = e as Record<string, unknown>
        const isDenied = 'deny' in result && typeof result.deny === 'string'
        const text = isDenied ? result.deny : (result.text ?? '')
        await share($, [toolEventOf(e.tool, input, isDenied ? undefined : result.result, text, isDenied || result.isError === true, sessionCwd)])
      } catch {
        // an unexpected result shape must never get in the way of the call
      }
    }

    return result
  })

  on('turn.complete', ($, e, next) => {
    if (!e.agentId) {
      workingSince = null
      lastTool = null
      isMainTurnOpen = false
    }

    return next(e)
  })

  // Only the rows a guest gets anything from: on a machine with managed settings, the security plugin sends
  // some other rows past the plugins a person installs, and the engine reports every hook it skipped.
  on('session.append', { door: ['response', 'command'] }, async ($, e, next) => {
    const result = await next(e)
    if (!result.deny && isSharing()) {
      try {
        await share($, eventsFromRow(e as AppendedRow, hostLabel()))
      } catch {
        // an unexpected row shape must never get in the way of the session
      }
    }

    return result
  })

  on('ui.scroll', async ($, e, next) => {
    const result = await next(e)
    if (e.component === 'Pane' && e.requestId === PANE && e.origin?.kind === 'person') {
      isFollowing = e.offset + e.bodyRows >= e.contentRows
    }

    return result
  })

  on('ui.close', ($, e, next) => {
    if (e.id === PREVIEW) isPreviewOpen = false

    return next(e)
  })

  on('command.run', { command: 'pair' }, async ($, e) => ({ text: await handleCommand($, e.args) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const room = await readRoom($)
    if (room?.role !== 'host') return next(e)
    const peer = await read($, peerAtom)
    const link = await read($, linkAtom)
    const band: PairBand =
      link === 'failed' ? { kind: 'stopped', problem: await read($, problemAtom) } : { kind: 'sharing', line: sharingLine(peer, link), canInvite: !peer || peer.hasLeft }

    return drawPairBand($.ui.resolve(e), band, {
      copy: press => detach(copyInvite($, room, press.surface)),
      stop: () => detach(stopPairing($))
    })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    isPaneDrawn = true
    const room = await readRoom($)
    const peer = await read($, peerAtom)
    const log = await read($, logAtom)
    const link = await read($, linkAtom)
    const problem = await read($, problemAtom)
    const expanded = await read($, expandedAtom)
    const ui = $.ui.resolve(e)
    const { Box, Button, Code, Markdown, Text } = ui

    if (!room) {
      return <Text dimColor>{'Not paired. Run /pair to host a session, or /pair <invite> to join one.'}</Text>
    }

    const isHost = room.role === 'host'
    const model: PaneModel = {
      isHost,
      peer,
      notices: noticesOf(isHost, peer, link, problem),
      entries: log,
      earlier: 0,
      transcript: {
        columns: e.props.bodyColumns,
        bullet,
        me: myName || 'you',
        style: styleOf(e.surface),
        expanded: new Set(expanded),
        onToggle: id => detach(toggleExpanded($, id))
      },
      keys: 'pair'
    }

    return drawPairPane({ Box, Text, Markdown, Code, Button, Input: 'Input' in ui ? ui.Input : undefined }, model, {
      submit: isHost ? undefined : value => detach(sendProposal($, value).then(message => $.ui.toast(`Pair · ${message}`))),
      copy: press => detach(copyInvite($, room, press.surface)),
      stop: () => detach(stopPairing($))
    })
  })

  on('ui.render', { component: 'Pane', requestId: PREVIEW }, async ($, e) => {
    await read($, previewTickAtom)
    const room = await readRoom($)
    const peer = await read($, peerAtom)
    const log = await read($, logAtom)
    const expanded = await read($, expandedAtom)
    const ui = $.ui.resolve(e)
    const { Box, Button, Code, Markdown, Text } = ui

    if (room?.role === 'guest') {
      return <Text dimColor>{"You're watching someone else's session: there is nothing of yours to preview."}</Text>
    }

    const elements = { Box, Text, Markdown, Code, Button, Input: 'Input' in ui ? ui.Input : undefined }
    const transcript = {
      columns: e.props.bodyColumns,
      bullet,
      me: 'you',
      style: styleOf(e.surface),
      expanded: new Set(expanded),
      isAllExpanded: arePreviewRowsOpen,
      onToggle: (id: string) => detach(toggleExpanded($, id))
    }
    const all = isPreviewBuilt ? latestPreviewEntries() : []
    const shown = all.slice(-previewRows)
    const guest: PairPeerView = peer ?? { name: 'your guest', isOnline: true, hasLeft: false, isWorking: false, tool: null }
    const host: PairPeerView = { name: hostLabel(), isOnline: true, hasLeft: false, isWorking: isMainTurnOpen, tool: isMainTurnOpen ? lastTool : null }
    const say = (text: string) => () => $.ui.toast(`Pair preview · ${text}`)

    return drawPreview(
      elements,
      room !== null,
      {
        isHost: true,
        peer: guest,
        notices: [],
        entries: room ? log : [],
        earlier: 0,
        transcript: { ...transcript, me: myName || 'you' },
        keys: 'preview'
      },
      {
        isHost: false,
        peer: host,
        notices: previewError
          ? [{ text: `Couldn't read this session: ${previewError}`, isError: true }]
          : isPreviewBuilt
            ? []
            : [{ text: 'Reading this session…', isError: false }],
        entries: shown,
        earlier: all.length - shown.length,
        transcript,
        keys: 'preview-guest'
      },
      {
        more: () => detach(showMorePreview($)),
        submit: say('what your guest types here goes straight to your Claude.')
      }
    )
  })
}
