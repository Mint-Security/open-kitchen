#!/usr/bin/env node
// End-to-end check of the pair plugin: three real headless Claude Code sessions on this machine (a host,
// a guest, and a third with the same invite that must be turned away), each running its own Syncthing
// through the plugin, over the public Syncthing discovery servers and relays, with real model turns on
// the host: one before pairing (in the session the guest gets), two the guest asks for (straight to
// Claude), and one after.
//
// The plugin tests cannot raise `session.append` rows or run programs, so this is what proves the
// mirroring (tool rows with their arguments and output), a guest's message reaching Claude,
// and the Syncthing transport in the real engine. The plugin downloads Syncthing into
// ~/.claude/pair the first time, as it would for anyone.
//
// It spends money: about 10 cents on Haiku, capped at $0.30 for the host and $0.02 for each other
// session. Hence the flag:  node scripts/e2e-pair.mjs --spend
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

if (!process.argv.includes('--spend')) {
  console.log('This runs real Claude Code sessions with four real Haiku turns (about $0.10).\nRe-run with --spend to go ahead.')
  process.exit(2)
}

const PLUGIN = fileURLToPath(new URL('../plugins/pair', import.meta.url))
const ROOMS = join(homedir(), '.claude', 'pair', 'rooms')
// Room folders have random names, so this run's are the ones that were not there before it.
const roomsBefore = new Set(existsSync(ROOMS) ? readdirSync(ROOMS) : [])
// A room whose alive file is fresh belongs to a pairing some other session is running; this run must not touch it.
const live = [...roomsBefore].filter(name => {
  try {
    return Date.now() - statSync(join(ROOMS, name, "alive")).mtimeMs < 10 * 60_000
  } catch {
    return false
  }
})
if (live.length > 0) {
  console.log(`Another pairing is live on this machine (${live.length} room${live.length === 1 ? "" : "s"} under ${ROOMS}). Stop it, or wait ten minutes, so this run cannot delete it.`)
  process.exit(2)
}
const newRooms = () => (existsSync(ROOMS) ? readdirSync(ROOMS) : []).filter(name => !roomsBefore.has(name))
const processes = () => execFileSync('ps', ['-ax', '-o', 'command']).toString().split('\n')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const started = Date.now()
const log = (...args) => console.log(`[+${Math.round((Date.now() - started) / 1000)}s]`, ...args)

const cwd = mkdtempSync(join(tmpdir(), 'pair-e2e-'))
const named = name => {
  const options = { options: { displayName: name } }
  return ['--settings', JSON.stringify({ pluginConfigs: { pair: options, 'pair@inline': options } })]
}

const session = (name, extra = [], budget = '0.02') => {
  const proc = spawn(
    'claude',
    ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--plugin-dir', PLUGIN, '--max-budget-usd', budget, ...extra],
    { cwd, env: { ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  const waiters = { local: [], turn: [] }
  const turns = []
  let cost = 0
  createInterface({ input: proc.stdout }).on('line', line => {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (event.type !== 'result') return
    // A session's total so far, on every result: keep the latest, never add them up.
    cost = Math.max(cost, event.total_cost_usd ?? 0)
    const kind = event.local_command ? 'local' : 'turn'
    if (kind === 'turn') turns.push(event)
    waiters[kind].shift()?.(event)
  })
  proc.stderr.on('data', data => {
    const text = String(data).trim()
    if (text) log(`[${name} stderr]`, text.slice(0, 300))
  })
  const expectResult = (kind, ms) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name}: no ${kind} result within ${ms}ms`)), ms)
      waiters[kind].push(event => {
        clearTimeout(timer)
        resolve(event)
      })
    })
  const send = text => proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
  const say = async text => {
    const done = expectResult('local', 30000)
    send(text)
    return (await done).result
  }
  return {
    say,
    // asks `/pair` (or another command) until the answer matches, or gives up after `ms`
    until: async (text, pattern, ms) => {
      const deadline = Date.now() + ms
      let last = ''
      while (Date.now() < deadline) {
        last = await say(text)
        if (pattern.test(last)) return last
        await wait(2000)
      }
      throw new Error(`${name}: "${text}" never matched ${pattern} in ${ms}ms; last answer: ${JSON.stringify(last)}`)
    },
    ask: async (text, ms = 120000) => {
      const done = expectResult('turn', ms)
      send(text)
      return done
    },
    nextTurn: (ms = 120000) => expectResult('turn', ms),
    close: () => proc.stdin.end(),
    kill: () => proc.kill(),
    cost: () => cost,
    turns
  }
}

const filesUnder = dir => {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true })
    .map(name => join(dir, String(name)))
    .filter(path => statSync(path).isFile())
}

const host = session('host', ['--model', 'haiku', '--allowedTools', 'Bash(echo:*)', ...named('Sam')], '0.30')
const guest = session('guest', named('Dana'))
const intruder = session('intruder', named('Eve'))
const sessions = [host, guest, intruder]
const failsafe = setTimeout(() => {
  log('E2E TIMEOUT')
  sessions.forEach(s => s.kill())
  process.exit(2)
}, 600000)

const show = text => log('  ', JSON.stringify(text).replace(/[2-9A-Z]{4}(-[2-9A-Z]{4}){20}/g, '<invite>'))

let roomId = ''
try {
  log('1. the host talks to Claude, then starts pairing; Syncthing comes up (downloaded on first use)')
  const earlier = await host.ask('Reply with the single word: ready')
  assert.match(String(earlier.result), /ready/i)
  const started = await host.say('/pair')
  assert.match(started, /They will see the whole session, tool output included/)
  assert.match(started, /what they send goes straight to Claude with your permissions/)
  // The invite names the host's device, so it exists once the host's Syncthing has made its identity; a -p session has no clipboard, so /pair invite prints it.
  const printed = await host.until('/pair invite', /Invite: \/pair /, 120000)
  const invite = printed.match(/([2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){20})/)?.[1]
  assert.ok(invite, 'the host can print the invite')
  const secret = invite.replaceAll('-', '').slice(0, 28)
  roomId = createHash('sha256').update(`pair-v1|room|${secret}`).digest('hex').slice(0, 32)
  show(await host.until('/pair', /^pair: Hosting\. Waiting for your guest to join\./, 120000))

  log('2. the guest joins with the invite and watches')
  show(await guest.say(`/pair ${invite}`))
  show(await guest.until('/pair', /Watching Sam: online/, 180000))
  show(await host.until('/pair', /Hosting Dana: online/, 60000))
  const history = await guest.until('/pair log 12', /Sam started sharing here/, 60000)
  log(history.split('\n').map(line => '     | ' + line.slice(0, 150)).join('\n'))
  assert.match(history, /Sam: Reply with the single word: ready[\s\S]*Claude: ready[\s\S]*Sam started sharing here/i, 'the guest sees the conversation from before pairing, above the divider')
  assert.doesNotMatch(history, /\/pair/, 'the /pair command itself is not part of the shared history')

  log('3. a third session with the same invite does not get in')
  // Same invite, its own device: the host keeps the guest it has while that guest is there. The third
  // side can see the host but never connects, and says so.
  assert.match(await intruder.say(`/pair ${invite}`), /Connecting/)
  const refused = await intruder.until('/pair', /already has two people|someone else may already have joined|Watching Sam/, 180000)
  show(refused)
  assert.doesNotMatch(refused, /Watching Sam/, 'the third session must not see the session')
  assert.match(await intruder.say('/pair stop'), /Pairing stopped/)
  show(await guest.until('/pair', /Watching Sam: online/, 120000))

  log("4. by default the guest's message goes straight to the host's Claude: a REAL model turn starts")
  const autoTurn = host.nextTurn(150000)
  assert.match(await guest.say('/pair Run the shell command: echo pair-ok  (use the Bash tool) and tell me exactly what it printed.'), /Sent\. Sam's Claude gets it right away/)
  const autoResult = await autoTurn
  log('   host turn result:', JSON.stringify(String(autoResult.result).slice(0, 160)), 'cost $' + (autoResult.total_cost_usd ?? 0).toFixed(4), 'turns', autoResult.num_turns)
  assert.ok(!autoResult.is_error, 'the host turn did not error')
  assert.match(String(autoResult.result), /pair-ok/)

  log('5. the next message goes straight in too: another REAL model turn')
  const turn = host.nextTurn(150000)
  assert.match(await guest.say('/pair Now run the shell command: echo second-ok  (use the Bash tool) and say what it printed.'), /Sent\. Sam's Claude gets it right away/)
  const result = await turn
  assert.ok(!result.is_error, 'the host turn did not error')
  assert.match(String(result.result), /second-ok/)

  log('6. the guest watched all of it, drawn as the host sees it')
  const guestLog = await guest.until('/pair log 40', /Claude: .*second-ok/, 60000)
  log(guestLog.split('\n').map(line => '     | ' + line.slice(0, 150)).join('\n'))
  assert.match(guestLog, /you: Run the shell command/)
  assert.match(guestLog, /✓ sent to Claude/)
  assert.match(guestLog, /Bash\(echo pair-ok\) ⎿ pair-ok/)
  assert.match(guestLog, /Bash\(echo second-ok\) ⎿ second-ok/)
  assert.doesNotMatch(guestLog, /Dana: Run the shell command/, 'the guest does not see their own message twice')

  log("7. the host's own prompt is mirrored too")
  const pong = await host.ask('Reply with the single word: pong')
  assert.match(String(pong.result), /pong/i)
  const guestLog2 = await guest.until('/pair log 6', /Claude: pong/i, 60000)
  log(guestLog2.split('\n').map(line => '     | ' + line.slice(0, 150)).join('\n'))
  assert.match(guestLog2, /Sam: Reply with the single word: pong/)

  log('8. each side runs one-way folders, and what sits in them on disk is sealed')
  const roomDirs = newRooms()
  for (const name of roomDirs) {
    // Syncthing rewrites the config with a template of its own defaults; only pair's folders count.
    const config = readFileSync(join(ROOMS, name, 'st', 'config.xml'), 'utf8')
    const types = [...config.matchAll(/<folder id="pair-[^"]+"[^>]*type="([a-z]+)"/g)].map(m => m[1]).sort()
    assert.deepEqual(types, ['receiveonly', 'sendonly'], `${name} sends its own folder and only receives the other side's`)
  }
  const shared = roomDirs.flatMap(name =>
    readdirSync(join(ROOMS, name))
      .filter(dir => dir === 'out' || dir.startsWith('in'))
      .flatMap(dir => filesUnder(join(ROOMS, name, dir)))
      .filter(file => !file.includes('.stfolder'))
  )
  const syncthings = processes().filter(line => roomDirs.some(name => line.includes(name)))
  assert.equal(syncthings.length, 2, 'one Syncthing per side')
  assert.ok(!processes().some(line => line.includes(roomId) || line.includes(secret)), 'nothing derived from the invite is in a command line')
  log(`   ${roomDirs.length} room folders, ${shared.length} shared files`)
  assert.ok(shared.length > 4, 'messages went through the shared folders')
  for (const file of shared) {
    const text = readFileSync(file, 'utf8')
    for (const clear of ['pair-ok', 'second-ok', 'Run the shell command', 'pong', 'echo', 'single word', invite, secret]) {
      assert.ok(!text.includes(clear), `${file} holds "${clear}" in the clear`)
    }
  }

  log('9. leaving: the guest hears the host go, and nothing is left behind')
  assert.equal(await host.say('/pair stop'), 'pair: Pairing stopped.')
  show(await guest.until('/pair', /Sam: left/, 60000))
  assert.equal(await guest.say('/pair stop'), 'pair: Pairing stopped.')
  await wait(6000)
  assert.deepEqual(newRooms(), [], 'the room folders are deleted')
  const running = processes().filter(line => roomDirs.some(name => line.includes(name)))
  assert.deepEqual(running, [], 'no Syncthing is left running for the room')

  log(`ALL PASSED. model spend across the sessions: $${sessions.reduce((sum, s) => sum + s.cost(), 0).toFixed(4)}`)
} catch (error) {
  log('FAILED:', error.message)
  log('host turns:', JSON.stringify(host.turns.map(t => String(t.result).slice(0, 200))))
  if (existsSync(ROOMS)) {
    for (const name of newRooms()) {
      const file = join(ROOMS, name, 'st', 'syncthing.log')
      if (existsSync(file)) log(`--- ${name} syncthing.log (tail)\n` + readFileSync(file, 'utf8').split('\n').slice(-15).join('\n'))
    }
  }
  process.exitCode = 1
} finally {
  clearTimeout(failsafe)
  sessions.forEach(s => s.close())
  await wait(500)
  sessions.forEach(s => s.kill())
  // A failed run leaves its rooms behind (a later /pair would sweep them, ten minutes on); this one cleans up now.
  await wait(1000)
  for (const name of newRooms()) {
    rmSync(join(ROOMS, name), { recursive: true, force: true })
    rmSync(join(ROOMS, '..', 'run', `${name}.sock`), { force: true })
  }
  rmSync(cwd, { recursive: true, force: true })
}
