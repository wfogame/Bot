'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const controls = require('../bot-controls')
const plain = value => JSON.parse(JSON.stringify(value))

// Evaluate the actual entry point with network/game dependencies mocked. No bot
// connections, disk history writes, or process-wide handlers are started.
function runtime(env = {}) {
  const timers = new Map()
  const authAlerts = []
  // Two HTTP servers run in production (dashboard, analytics) on different
  // ports, so handlers are routed by the port each one listens on. "Last
  // created" would let startAnalyticsServer() shadow the dashboard.
  const handlers = new Map()
  let dashboardHandler
  const wss = new EventEmitter()
  const server = new EventEmitter()
  server.listen = (_port, _bind, cb) => cb()
  const fakeWs = { OPEN: 1, Server: function () { return wss } }
  wss.handleUpgrade = (_req, socket, _head, cb) => cb(socket)
  const setTimer = (fn, delay) => { const t = { fn, delay, unref() {} }; timers.set(t, t); return t }
  const clearTimer = t => timers.delete(t)
  // Its own cron state file per runtime: `/cron add` now persists jobs, and a
  // shared path would leak jobs between tests (and write into the repo).
  const cronStateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bot-cron-')), 'cron-jobs.json')
  const processMock = {
    // MC_WEB_AUTO_BUILD is forced off here (the app default is ON): with it on,
// a /play request for an unbuilt client would clone and build the real
// multi-GB upstream client from the test suite. Tests that need a build point
// MC_WEB_CLIENT_DIR at a temp dir instead.
  env: { BOT_NAMES: 'A,B,C', WEB_GUI: 'true', TUI_GUI: 'false', WEB_PASSWORD: 'test-only', WEB_TERMINAL_LOG: 'false', MC_WEB_AUTO_BUILD: 'false', CRON_STATE_FILE: cronStateFile, ...env },
    stdout: { isTTY: false, write() {} }, stderr: { write() {} },
    on() {}, exit() {}, memoryUsage: () => ({ rss: 0, heapUsed: 0 }), uptime: () => 1
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8')
  const context = vm.createContext({
    Buffer, URL, URLSearchParams, console, process: processMock, __dirname: path.join(__dirname, '..'),
    setTimeout: setTimer, clearTimeout: clearTimer,
    setInterval: setTimer, clearInterval: clearTimer, setImmediate: fn => setTimer(fn, 0),
    require(name) {
      if (name === 'dotenv') return { config() {} }
      if (name === 'fs') return { readFileSync: () => '', writeFileSync() {}, mkdirSync() {}, renameSync() {}, existsSync: () => false }
      if (name === 'http') {
        return {
          createServer(fn) {
            if (!dashboardHandler) dashboardHandler = fn
            return Object.assign(server, {
              listen(port, _bind, cb) { handlers.set(String(port), fn); if (cb) cb() }
            })
          }
        }
      }
      if (name === 'ws') return fakeWs
      if (name === './bot-controls') return {
        ...controls,
        createSlowBroadcast: () => controls.createSlowBroadcast({ setTimer, clearTimer }),
        createSlowBroadcastManager: () => controls.createSlowBroadcastManager({ setTimer, clearTimer }),
        // bot-controls reads the real process.env by default, but inside this
        // harness bot.js reads processMock.env — so the group vars have to be
        // parsed from the same object bot.js sees, exactly as they would be in
        // production where there is only one process.env.
        parseProxyGroups: (env = processMock.env) => controls.parseProxyGroups(env),
        // Same reason: BOT_PASSWORDS is read out of bot.js's own env at startup.
        parseBotPasswords: (env = processMock.env) => controls.parseBotPasswords(env)
      }
      if (name === './expose-terminal') return { sshConfig: () => ({ enabled: false }) }
      if (name === './monitoring') return {
        // A ban verdict that matches nothing, so the kick path stays exercised
        // without a live connection.
        classifyKick: message => ({ banned: false, permanent: false, kind: '', duration: '', durationMs: 0, expiresAt: 0, reason: String(message ?? ''), caseId: '', text: String(message ?? '') }),
        // Alerts are recorded rather than dropped: "alert once" is a property of
        // the auth guard, so it has to be observable from a test.
        createMonitoring: () => ({ getMemorySnapshot: () => null, onDisconnect() {}, onKick() {}, onBan() {}, onAuthFailure(botId, failure) { authAlerts.push({ botId, failure }) }, onProxyStall() {}, onReconnectExhausted() {}, onFatal() {}, onSecurityLockout() {}, inspectServerMessage() {}, onRecovered() {} })
      }
      // Resolved against this test file, not against bot.js, so it needs an entry.
      if (name === './removed-bots') return require('../removed-bots')
      if (name === './bot-manual') return () => ({ routeCommand: () => false, key() {}, onWindowOpen: () => false, onWindowClose() {}, stopManualMode() {}, snapshotFor: () => null })
      if (name === 'mineflayer') return { createBot() { throw Error('Live bot connections forbidden in tests') } }
      if (name === 'mineflayer-armor-manager') return () => {}
      if (name === 'mineflayer-pathfinder') return { goals: {} }
      if (name === 'socks') return {}
      if (name === './cron') return require('../cron')
      if (name === './web-client') return require('../web-client')
      return require(name)
    }
  })
  vm.runInContext(source.slice(0, source.indexOf('// ── Interface startup')), context)
  const run = code => vm.runInContext(code, context)
  const initialOrder = Array.from(run('initialBotOrder'))
  timers.clear()
  run(`
    for (const id of ['A', 'B', 'C']) bots[id] = {
      bot: { entity: {}, health: 20, food: 20, chat(msg) { chats.push([id, msg]) } },
      logs: [], disconnectManually() {}
    }
    activeId = 'A'
  `)
  context.chats = []
  run('webHandle = startWebGUI()')
  // `port` selects the server to talk to: by default the dashboard, or the
  // analytics port for the analytics routes.
  async function request(url, body = '', cookie = '', method = 'POST', port = null) {
    const handler = port == null ? dashboardHandler : handlers.get(String(port))
    if (!handler) throw new Error(`No test HTTP handler listening on ${port}`)
    const req = new EventEmitter()
    Object.assign(req, { url, method, headers: { cookie }, socket: { remoteAddress: '127.0.0.1' } })
    const response = { status: 0, headers: {}, body: '', writeHead(s, h = {}) { this.status = s; this.headers = h }, end(b = '') { this.body = b } }
    const done = handler(req, response)
    if (body) req.emit('data', Buffer.from(body))
    req.emit('end')
    await done
    return response
  }
  async function login() {
    const res = await request('/login', 'password=test-only')
    assert.equal(res.status, 303)
    return res.headers['Set-Cookie'].split(';')[0]
  }
  function socket(cookie) {
    const ws = new EventEmitter()
    Object.assign(ws, { readyState: 1, messages: [], send(text) { this.messages.push(JSON.parse(text)) }, ping() {}, destroy() {} })
    server.emit('upgrade', { url: '/ws', headers: { cookie }, socket: { remoteAddress: '127.0.0.1' } }, ws, Buffer.alloc(0))
    ws.command = msg => ws.emit('message', JSON.stringify(msg))
    return ws
  }
  return { context, run, timers, initialOrder, request, login, socket, authAlerts }
}

test('startup randomization defaults on and false/off/0/no preserve configured order', () => {
  assert.equal(runtime().run('RANDOMIZE_BOT_ORDER'), true)
  for (const flag of ['false', 'OFF', '0', 'no', ' false ']) {
    const r = runtime({ RANDOMIZE_BOT_ORDER: flag })
    assert.deepEqual(r.initialOrder, ['A', 'B', 'C'])
    assert.equal(r.run('RANDOMIZE_BOT_ORDER'), false)
  }
})

test('TUI switch supports name/number; invalid targets and bare command do not send chat', () => {
  const r = runtime()
  r.run(`handleCommand('/switch 2')`); assert.equal(r.run('activeId'), 'B')
  r.run(`handleCommand('/switch C')`); assert.equal(r.run('activeId'), 'C')
  for (const text of ['/switch', '/switch 0', '/switch 99', '/switch missing', '/switch __proto__']) r.context.text = text, r.run('handleCommand(text)')
  assert.equal(r.run('activeId'), 'C')
  assert.deepEqual(plain(r.context.chats), [])
})

test('WebSocket switch updates only the requesting client and subsequent command target', async () => {
  const r = runtime(), cookie = await r.login()
  const first = r.socket(cookie), second = r.socket(cookie)
  first.command({ t: 'cmd', text: '/switch 2' })
  assert.deepEqual(first.messages.find(m => m.t === 'select'), { t: 'select', id: 'B' })
  assert.ok(first.messages.some(m => m.t === 'history' && m.id === 'B'))
  assert.equal(second.messages.some(m => m.t === 'select'), false)
  assert.equal(r.run('activeId'), 'A')
  first.command({ t: 'cmd', text: 'hello' })
  second.command({ t: 'cmd', text: 'other tab' })
  assert.deepEqual(plain(r.context.chats), [['B', 'hello'], ['A', 'other tab']])
})

test('HTTP fallback returns selected bot and honors explicit targets without global switching', async () => {
  const r = runtime(), cookie = await r.login()
  let res = await r.request('/api/command', JSON.stringify({ text: '/switch C', selectedId: 'B' }), cookie)
  assert.equal(res.status, 202)
  assert.equal(JSON.parse(res.body).selectedId, 'C')
  assert.equal(r.run('activeId'), 'A')
  await r.request('/api/command', JSON.stringify({ text: 'hello', selectedId: 'C' }), cookie)
  assert.deepEqual(plain(r.context.chats), [['C', 'hello']])
  await r.request('/api/command', JSON.stringify({ text: 'wrong target?', selectedId: 'gone' }), cookie)
  assert.equal(r.context.chats.length, 1)
  res = await r.request('/command', 'text=%2Fswitch+B&selectedId=C', cookie)
  assert.equal(res.headers.Location, '/?view=B')
  assert.equal(r.run('activeId'), 'A')
})

test('actual router handles slow chat, removed/offline bots, local arguments, and exit cancellation', () => {
  const r = runtime({ ALL_SLOW_DELAY_MS: '25' })
  r.timers.clear()
  r.run(`handleCommand('/all-slow hello')`)
  assert.deepEqual(plain(r.context.chats), [['A', 'hello']])
  assert.equal([...r.timers.values()][0].delay, 25)
  r.run('delete bots.B; bots.C.bot.entity = null')
  const tick = () => { const t = [...r.timers.keys()][0]; r.timers.delete(t); t.fn() }
  tick(); tick()
  assert.equal(r.run('slowBroadcast.running'), false)
  assert.deepEqual(plain(r.context.chats), [['A', 'hello']])
  r.run(`bots.C.bot.entity = {}; runCrateRoutine = (id, color) => chats.push([id, color]); handleCommand('/all-slow /crates purple')`)
  assert.deepEqual(plain(r.context.chats.at(-1)), ['A', 'purple_shulker_box'])
  tick(); assert.deepEqual(plain(r.context.chats.at(-1)), ['C', 'purple_shulker_box'])
  r.run(`handleCommand('/all-slow hello'); handleCommand('/exit')`)
  assert.equal(r.run('slowBroadcast.running'), false)
})

test('bare broadcasts give usage; normal /all stays immediate', () => {
  const r = runtime()
  r.run(`handleCommand('/all'); handleCommand('/all-slow')`)
  assert.deepEqual(plain(r.context.chats), [])
  r.run(`handleCommand('/all hello')`)
  assert.deepEqual(plain(r.context.chats), [['A', 'hello'], ['B', 'hello'], ['C', 'hello']])
})

// A permanent ban has to actually leave the roster, and the removed list — not a
// live connection — is what decides whether a bot may come back.
test('the removed list gates reconnecting and /unban puts a bot back', () => {
  const r = runtime()
  assert.equal(r.run('removedEntryFor("A")'), null, 'nothing is removed by default')

  // What a permanent ban does, minus the live kick event.
  r.run(`removedBots = removedBotsStore.addRemovedBot(removedBots, { bot: 'A', kind: 'permanent', reason: 'cheating' }, { addedBy: 'ban-detection' }).list`)
  assert.equal(r.run('removedEntryFor("A").bot'), 'A')
  assert.equal(r.run('removedEntryFor("a").bot'), 'A', 'a name from .env may not match the kick text casing')
  assert.equal(r.run('removedEntryFor("B")'), null)

  assert.equal(r.run('dropFromRoster("A")'), true)
  assert.equal(r.run('Object.keys(bots).includes("A")'), false, 'the bot leaves the live roster')
  assert.equal(r.run('activeId'), 'C', 'the active bot moves off the removed one')
  assert.equal(r.run('dropFromRoster("A")'), false, 'dropping it twice is harmless')

  // The commands must survive being called, and /unban must clear both the list
  // and the ban hold (otherwise the next reconnect is held again).
  r.run(`handleCommand('/removed')`)
  r.run(`handleCommand('/unban')`)
  r.run(`handleCommand('/unban ghost')`)
  assert.equal(r.run('removedEntryFor("A").bot'), 'A', 'a bare or unknown /unban changes nothing')

  r.run('dataState.bots.A = { banned: true, banKind: "permanent", banExpiresAt: 0 }')
  r.run(`handleCommand('/unban A')`)
  assert.equal(r.run('removedEntryFor("A")'), null, 'the bot is off the removed list')
  assert.equal(r.run('dataState.bots.A.banned'), false, 'and its ban hold is cleared')

  assert.equal(r.run('PERMANENT_BAN_ACTION'), 'remove', 'a permanent ban defaults to leaving the roster')
})

// activeBan is what both the startup loop and scheduleReconnect ask before
// dialling, so it is worth pinning down through bot.js rather than only in isolation.
test('activeBan holds a live ban and releases an expired one', () => {
  const r = runtime()
  r.run(`
    dataState.bots.B = { banned: true, banKind: 'permanent', banExpiresAt: 0 }
    dataState.bots.C = { banned: true, banKind: 'temporary', banExpiresAt: Date.now() - 1000 }
    dataState.bots.D = { banned: true, banKind: 'temporary', banExpiresAt: Date.now() + 60000 }
  `)
  assert.equal(r.run('activeBan("B").permanent'), true, 'no expiry is a permanent hold')
  assert.equal(r.run('activeBan("C")'), null, 'an elapsed ban is no longer held')
  assert.equal(r.run('activeBan("D").permanent'), false)
  assert.ok(r.run('activeBan("D").expiresAt') > Date.now())
  assert.equal(r.run('activeBan("A")'), null, 'an unbanned bot is never held')
})

test('item name helpers prefer anvil custom names and expose the alternative name', () => {
  const r = runtime()
  const out = r.run(`(() => {
    const named = { name: 'netherite_sword', displayName: 'Netherite Sword', customName: '{"text":"Sword"}' }
    const componentName = { name: 'diamond_pickaxe', displayName: 'Diamond Pickaxe', customName: { text: 'My Pick', extra: ['!'] } }
    const plainName = { name: 'diamond_sword', displayName: 'Diamond Sword', customName: 'Sword' }
    const unrenamed = { name: 'netherite_sword', displayName: 'Netherite Sword', customName: null }
    const noCustom = { name: 'diamond', displayName: 'Diamond' }
    // 1.20.5+ sends custom_name as an NBT compound text component; prismarine-item
    // surfaces it through item.customName in this exact shape.
    const nbtCompound = { name: 'netherite_sword', displayName: 'Netherite Sword', customName: { type: 'compound', name: '', value: { text: { type: 'string', value: 'Sword' }, italic: { type: 'byte', value: 0 } } } }
    const nbtString = { name: 'diamond_sword', displayName: 'Diamond Sword', customName: { type: 'string', value: '{"text":"Blade"}' } }
    const legacyNbt = { name: 'netherite_sword', displayName: 'Netherite Sword', customName: null, nbt: { type: 'compound', value: { display: { type: 'compound', value: { Name: { type: 'string', value: '{"text":"Legacy"}' } } } } } }
    return [
      itemDisplayName(named), itemAltName(named, itemDisplayName(named)),
      itemDisplayName(componentName), itemAltName(componentName, itemDisplayName(componentName)),
      itemDisplayName(plainName), itemAltName(plainName, itemDisplayName(plainName)),
      itemDisplayName(unrenamed), itemAltName(unrenamed, itemDisplayName(unrenamed)),
      itemDisplayName(noCustom), itemAltName(noCustom, itemDisplayName(noCustom)),
      itemDisplayName(nbtCompound), itemAltName(nbtCompound, itemDisplayName(nbtCompound)),
      itemDisplayName(nbtString), itemAltName(nbtString, itemDisplayName(nbtString)),
      itemDisplayName(legacyNbt), itemAltName(legacyNbt, itemDisplayName(legacyNbt))
    ]
  })()`)
  assert.deepEqual(plain(out), [
    'Sword', 'netherite_sword',
    'My Pick!', 'diamond_pickaxe',
    'Sword', 'diamond_sword',
    'Netherite Sword', 'netherite_sword',
    'Diamond', null,
    'Sword', 'netherite_sword',
    'Blade', 'diamond_sword',
    'Legacy', 'netherite_sword'
  ])
})

test('/find matches custom, display, and registry names across all bots', () => {
  const r = runtime()
  r.run(`
    bots.A.bot.inventory = { items: () => [
      { type: 1, slot: 12, count: 3, name: 'netherite_sword', displayName: 'Netherite Sword', customName: { type: 'string', value: 'Sword' } },
      { type: 2, slot: 8, count: 1, name: 'diamond', displayName: 'Diamond', customName: null }
    ] }
    bots.B.bot.inventory = { items: () => [
      { type: 3, slot: 0, count: 5, name: 'red_shulker_box', displayName: 'Red Shulker Box', customName: null }
    ] }
    bots.C.bot.inventory = { items: () => [] }
  `)
  r.run(`handleCommand('/find sword')`)
  let logText = r.run(`JSON.stringify(bots.A.logs.map(l => l.text.replace(/^.*?}/, '')))`)
  assert.match(logText, /\[A\]/)
  assert.match(logText, /3x Sword \(netherite_sword\) — inv slot 12/)
  assert.equal(r.run('chats.length'), 0)
  r.run(`handleCommand('/find shulker')`)
  logText = r.run(`JSON.stringify(bots.A.logs.map(l => l.text.replace(/^.*?}/, '')))`)
  assert.match(logText, /5x Red Shulker Box \(red_shulker_box\) — inv slot 0/)
  // No match anywhere
  r.run(`handleCommand('/find nonexistent-item-xyz')`)
  logText = r.run(`JSON.stringify(bots.A.logs.map(l => l.text.replace(/^.*?}/, '')))`)
  assert.match(logText, /No bot has an item matching/)
  // Usage
  r.run(`handleCommand('/find')`)
  logText = r.run(`JSON.stringify(bots.A.logs.map(l => l.text.replace(/^.*?}/, '')))`)
  assert.match(logText, /Usage: \/find/)
})

test('/find also scans the open window and skips offline bots', () => {
  const r = runtime()
  r.run(`
    bots.A.bot.inventory = { items: () => [] }
    bots.A.bot.currentWindow = { slots: { 5: { type: 4, slot: 5, count: 2, name: 'diamond_sword', displayName: 'Diamond Sword', customName: null } } }
    bots.B.bot.entity = null
  `)
  r.run(`handleCommand('/find diamond')`)
  const logText = r.run(`JSON.stringify(bots.A.logs.map(l => l.text.replace(/^.*?}/, '')))`)
  assert.match(logText, /2x Diamond Sword \(diamond_sword\) — window slot 5/)
  assert.match(logText, /\[B\] offline — skipped/)
})

test('/cron add lists runs and manages jobs', () => {
  const r = runtime()
  r.run(`handleCommand('/cron add "*/5 * * * *" /status')`)
  assert.equal(r.run('cronManager.list().length'), 1)
  assert.equal(r.run('cronManager.list()[0].schedule'), '*/5 * * * *')
  assert.equal(r.run('cronManager.list()[0].command'), '/status')
  // Bare /cron lists it
  r.run(`handleCommand('/cron')`)
  let logText = r.run(`JSON.stringify(bots.A.logs.map(l => l.text.replace(/^.*?}/, '')))`)
  assert.match(logText, /Cron jobs/)
  assert.match(logText, /\[[^\]]*1[^\]]*\]/)
  // /cron run fires it through the /all-style dispatcher (local command → per-bot, no chat)
  r.run(`handleCommand('/cron run 1')`)
  assert.equal(r.run('chats.length'), 0)
  logText = r.run(`JSON.stringify(bots.A.logs.map(l => l.text.replace(/^.*?}/, '')))`)
  assert.match(logText, /Status for A/)
  assert.equal(r.run('cronManager.list()[0].runs'), 1)
  // Disable, list state, remove
  r.run(`handleCommand('/cron off 1')`)
  assert.equal(r.run('cronManager.list()[0].enabled'), false)
  r.run(`handleCommand('/cron on 1')`)
  assert.equal(r.run('cronManager.list()[0].enabled'), true)
  r.run(`handleCommand('/cron rm 1')`)
  assert.equal(r.run('cronManager.list().length'), 0)
  r.run(`handleCommand('/cron rm 1')`)
  logText = r.run(`JSON.stringify(bots.A.logs.map(l => l.text.replace(/^.*?}/, '')))`)
  assert.match(logText, /No cron job with id 1/)
})

test('/cron supports @every and raw-chat broadcast commands', () => {
  const r = runtime()
  r.run(`handleCommand('/cron add @every 60 hello everyone')`)
  assert.equal(r.run('cronManager.list()[0].schedule'), '@every 60')
  assert.equal(r.run('cronManager.list()[0].command'), 'hello everyone')
  r.run(`handleCommand('/cron run 1')`)
  assert.deepEqual(plain(r.context.chats), [['A', 'hello everyone'], ['B', 'hello everyone'], ['C', 'hello everyone']])
  // Bad schedule / bad subcommand produce warnings, not crashes
  r.run(`handleCommand('/cron add bogus /status')`)
  r.run(`handleCommand('/cron wat')`)
})

test('CRON_JOB_<N> env entries load at startup', () => {
  const r = runtime({ CRON_JOB_1: '@every 60|/status', CRON_JOB_2: '0 */2 * * *|/crates-all' })
  assert.equal(r.run('cronManager.list().length'), 2)
  assert.equal(r.run('cronManager.list()[0].command'), '/status')
  assert.equal(r.run('cronManager.list()[1].schedule'), '0 */2 * * *')
})

test('CRON_JOB_<N> env entries with quotes or errors load at startup without TDZ crash', () => {
  const r = runtime({
    CRON_JOB_1: '"0 4 * * *|/crates-all"',
    CRON_JOB_2: "'@every 60|/status'",
    CRON_JOB_3: 'broken schedule|/status'
  })
  assert.equal(r.run('cronManager.list().length'), 2)
  assert.equal(r.run('cronManager.list()[0].schedule'), '0 4 * * *')
  assert.equal(r.run('cronManager.list()[0].command'), '/crates-all')
  assert.equal(r.run('cronManager.list()[1].schedule'), '@every 60')
})

test('/dump-spawners is recognized as a local command', () => {
  const r = runtime()
  assert.equal(r.run("LOCAL_COMMANDS.includes('/dump-spawners')"), true)
})

test('/all reuses the shared dispatcher (local args preserved, chat broadcast)', () => {
  const r = runtime()
  r.run(`
    for (const id of ['A', 'B', 'C']) {
      bots[id].bot.entity = { position: { x: 0, y: 0, z: 0 } }
      bots[id].host = 'test-host'; bots[id].port = 1; bots[id].version = '1'; bots[id].spawnTime = Date.now()
    }
  `)
  r.run(`handleCommand('/all /status')`)
  let logText = r.run(`JSON.stringify(bots.A.logs.map(l => l.text.replace(/^.*?}/, '')))`)
  assert.match(logText, /Ran locally on 3 bots/)
  assert.equal(r.run('chats.length'), 0)
  r.run(`handleCommand('/all hello')`)
  assert.deepEqual(plain(r.context.chats), [['A', 'hello'], ['B', 'hello'], ['C', 'hello']])
})

test('webClientUrl builds connect-screen prefills for the /play tab', () => {
  const r = runtime()
  assert.equal(r.run('MC_WEB_ENABLED'), true)
  assert.equal(r.run('MC_WEB_CLIENT_URL'), '')
  assert.equal(r.run('MC_WEB_CLIENT_PORT'), 8090)
  assert.equal(r.run('MC_WEB_VERSION'), '1.21.4')
  assert.equal(
    r.run(`webClientUrl({ base: 'http://localhost:8090/', ip: 'play.example.com:25565', version: '1.21.4', username: 'Steve', proxy: 'wss://mc.example.com' })`),
    'http://localhost:8090/?ip=play.example.com%3A25565&version=1.21.4&username=Steve&proxy=wss%3A%2F%2Fmc.example.com'
  )
  assert.equal(r.run(`webClientUrl({ ip: 'a.b:1' })`), 'http://localhost/?ip=a.b%3A1')
  assert.equal(r.run(`webClientUrl({})`), 'http://localhost/')
  assert.equal(r.run(`webClientUrl({ base: 'https://client.example.com/app/', username: 'X' })`), 'https://client.example.com/app/?username=X')
})

test('/play requires auth', async () => {
  const r = runtime()
  const res = await r.request('/play', '', '', 'GET')
  assert.equal(res.status, 303)
  assert.equal(res.headers.Location, '/login')
})

test('/play serves the self-hosted minecraft web client with prefills', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcweb-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>fake client</html>')
  try {
    const r = runtime({ MC_WEB_SERVER: 'play.example.com:25565', MC_WEB_VERSION: '1.21.4', MC_WEB_USERNAME: 'Steve', MC_WEB_PROXY: 'wss://mc.example.com', MC_WEB_CLIENT_DIR: dir })
    const cookie = await r.login()
    const res = await r.request('/play', '', cookie, 'GET')
    assert.equal(res.status, 200)
    assert.match(res.body, /<iframe/)
    assert.match(res.body, /http:\/\/localhost:[0-9]+\/\?ip=play\.example\.com%3A25565&amp;version=1\.21\.4&amp;username=Steve&amp;proxy=wss%3A%2F%2Fmc\.example\.com/)
    assert.doesNotMatch(res.body, /mcraft\.fun/)
    // Page heartbeats while open and beacons a stop on exit.
    assert.match(res.body, /play-ping/)
    assert.match(res.body, /sendBeacon\('\/play-stop'\)/)
    const h = await r.run('webHandle.webClientReady')
    assert.equal(h.started, true)
    const dash = await r.request('/', '', cookie, 'GET')
    assert.match(dash.body.toString(), /id="playbtn"/)
    h.server.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('/play-stop fully stops the client server and /play restarts it on the same port', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcweb-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>fake client</html>')
  try {
    const r = runtime({ MC_WEB_CLIENT_DIR: dir })
    const cookie = await r.login()
    await r.request('/play', '', cookie, 'GET')
    const h1 = await r.run('webHandle.webClientReady')
    assert.equal(h1.started, true)
    const port1 = h1.port
    const res = await r.request('/play-stop', '', cookie, 'POST')
    assert.equal(res.status, 204)
    const after = await r.run('webHandle.webClientReady')
    assert.equal(after, null)
    assert.equal((await r.run('webHandle.webClient')).started, false)
    // Port is freed → the next /play binds the same port again.
    await r.request('/play', '', cookie, 'GET')
    const h3 = await r.run('webHandle.webClientReady')
    assert.equal(h3.started, true)
    assert.equal(h3.port, port1)
    h3.server.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('/play shows the build-not-found page when the client build is missing', async () => {
  const r = runtime()
  const cookie = await r.login()
  const res = await r.request('/play', '', cookie, 'GET')
  assert.equal(res.status, 200)
  assert.match(res.body, /build not found/)
  assert.match(res.body, /npm run web-client:build/)
  assert.doesNotMatch(res.body, /<iframe/)
  assert.doesNotMatch(res.body, /mcraft\.fun/)
  // webClientReady is deliberately NOT cached for a missing build (the build
  // can finish later, so a later request has to re-check) — assert on the live
  // state instead, which is what "no client server started" really means.
  assert.equal((await r.run('webHandle.webClient')).started, false)
  assert.equal(await r.run('webHandle.webClientReady'), null)
})

test('/play and the PLAY button are disabled when MC_WEB_ENABLED=false', async () => {
  const r = runtime({ MC_WEB_ENABLED: 'false' })
  const cookie = await r.login()
  const res = await r.request('/play', '', cookie, 'GET')
  assert.equal(res.status, 404)
  const dash = await r.request('/', '', cookie, 'GET')
  assert.doesNotMatch(dash.body.toString(), /id="playbtn"/)
})

test('/shardshop-loop [slot] argument handling', async () => {
  const r = runtime()
  // Mock bot entity for bot A so commands can run
  r.run(`
    bots.A.bot.entity = { position: { x: 0, y: 0, z: 0 } }
    bots.A.bot.on = () => {}
    bots.A.bot.removeListener = () => {}
  `)

  // Valid slot via handleCommand
  r.run(`handleCommand('/shardshop-loop 13')`)
  assert.equal(r.run('bots.A.shardshopSlot'), 13)
  assert.equal(r.run('bots.A.shardshopLoopRunning'), true)

  // Clean up loop state for next test
  r.run(`bots.A.shardshopSlot = null; bots.A.shardshopLoopRunning = false`)

  // Invalid slot (out of 0..53 bounds) should warn and not start loop
  r.run(`handleCommand('/shardshop-loop 99')`)
  assert.equal(r.run('bots.A.shardshopLoopRunning'), false)
  assert.equal(r.run('bots.A.shardshopSlot'), null)

  // Invalid non-integer slot
  r.run(`handleCommand('/shardshop-loop abc')`)
  assert.equal(r.run('bots.A.shardshopLoopRunning'), false)

  // /all /shardshop-loop <slot> dispatches to all bots with slot preserved
  r.run(`
    bots.B.bot.entity = { position: { x: 0, y: 0, z: 0 } }; bots.B.bot.on = () => {}; bots.B.bot.removeListener = () => {}
    bots.C.bot.entity = { position: { x: 0, y: 0, z: 0 } }; bots.C.bot.on = () => {}; bots.C.bot.removeListener = () => {}
    handleCommand('/all /shardshop-loop 20')
  `)
  assert.equal(r.run('bots.A.shardshopSlot'), 20)
  assert.equal(r.run('bots.B.shardshopSlot'), 20)
  assert.equal(r.run('bots.C.shardshopSlot'), 20)
})

test('multiple concurrent /all-slow tasks and cancellation', () => {
  const r = runtime({ ALL_SLOW_DELAY_MS: '25' })
  r.timers.clear()

  // Start two concurrent /all-slow broadcasts
  r.run(`handleCommand('/all-slow first')`)
  r.run(`handleCommand('/all-slow second')`)

  assert.equal(r.run('slowBroadcast.running'), true)
  assert.equal(r.run('slowBroadcast.list().length'), 2)
  assert.deepEqual(plain(r.context.chats), [['A', 'first'], ['A', 'second']])

  // Cancel task 1 specifically
  r.run(`handleCommand('/all-slow-cancel 1')`)
  assert.equal(r.run('slowBroadcast.list().length'), 1)
  assert.equal(r.run('slowBroadcast.list()[0].id'), 2)

  // Advance timer for remaining task
  const tick = () => { const t = [...r.timers.keys()][0]; if (t) { r.timers.delete(t); t.fn() } }
  tick()
  assert.deepEqual(plain(r.context.chats.slice(2)), [['B', 'second']])

  // Cancel all remaining tasks
  r.run(`handleCommand('/all-slow-cancel')`)
  assert.equal(r.run('slowBroadcast.running'), false)
  assert.equal(r.run('slowBroadcast.list().length'), 0)
})

test('tpaAndDump does nothing when the inventory is empty', async () => {
  const r = runtime({ WARP_COMMAND: '/warp afk' })
  r.timers.clear()
  r.run(`
    bots.A.bot.entity = { position: { x: 0, y: 0, z: 0, clone: () => ({ x: 0, y: 0, z: 0, distanceTo: () => 0 }) } }
    bots.A.bot.on = (ev, fn) => {}
    bots.A.bot.removeListener = () => {}
    bots.A.bot.registry = { blocksByName: { chest: { id: 54 }, trapped_chest: { id: 146 } } }
    bots.A.bot.findBlocks = () => []
    bots.A.bot.inventory = { items: () => [] }
    dumpPromise = tpaAndDump(bots.A.bot, 'A')
  `)
  await r.run('dumpPromise')
  assert.equal(r.run('bots.A.inDumpRoutine'), false)
  assert.deepEqual(plain(r.context.chats), [])
})

test('handleCommand routes chained commands with &&, ;, sleep, and escaping', async () => {
  const r = runtime()
  r.timers.clear()
  r.run(`
    bots.A.bot.entity = { position: { x: 0, y: 0, z: 0 } }
    bots.A.bot.inventory = { items: () => [] }
    bots.A.logs = []
  `)

  // Chained with escaping: /chat hello \&\& world sends literal &&
  await r.run(`handleCommand('/chat hello \\\\&& world')`)
  assert.deepEqual(plain(r.context.chats), [
    ['A', 'hello && world']
  ])

  // Chained sequential && and ;
  await r.run(`handleCommand('/chat step1 ; /chat step2 && /chat step3')`)
  assert.deepEqual(plain(r.context.chats), [
    ['A', 'hello && world'],
    ['A', 'step1'],
    ['A', 'step2'],
    ['A', 'step3']
  ])
})

// ── /play outside Docker ──────────────────────────────────────────────────────
// The Dockerfile bakes web-client/dist into the image, so containers always have
// the client; a plain `npm run start` has to build it. These pin the page each
// state renders, and that turning auto-build off never spawns one.
const wcModule = require('../web-client')
function emptyDistDir () {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'play-dist-')), 'dist')
}

async function waitForBuild () {
  for (let i = 0; i < 200 && wcModule.buildState().running; i++) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(wcModule.buildState().running, false, 'build should have finished')
  return wcModule.buildState()
}

test('MC_WEB_AUTO_BUILD still defaults on for real installs', () => {
  // The test harness forces it off (see runtime); the app's own default is on,
  // which is what makes /play work from a plain `npm run start`.
  assert.equal(runtime({ MC_WEB_AUTO_BUILD: undefined }).run('MC_WEB_AUTO_BUILD'), true)
  assert.equal(runtime({ MC_WEB_AUTO_BUILD: 'true' }).run('MC_WEB_AUTO_BUILD'), true)
  for (const flag of ['false', '0', 'no', 'OFF']) {
    assert.equal(runtime({ MC_WEB_AUTO_BUILD: flag }).run('MC_WEB_AUTO_BUILD'), false)
  }
})

test('/play says the build is missing and spawns nothing when auto-build is off', async () => {
  const r = runtime({ MC_WEB_AUTO_BUILD: 'false', MC_WEB_CLIENT_DIR: emptyDistDir() })
  r.timers.clear()
  const cookie = await r.login()
  const res = await r.request('/play', '', cookie, 'GET')
  assert.equal(res.status, 200)
  assert.match(res.body, /build not found/)
  assert.match(res.body, /npm run web-client:build/)
  assert.equal(wcModule.buildState().running, false, 'auto-build=false must not start a build')
})

test('/play shows live progress while the client build runs, then the failure', async () => {
  const dist = emptyDistDir()
  // A build that produces nothing: exits 0 but leaves no index.html.
  wcModule.startBuild({ dir: dist, command: 'sleep 1' })
  assert.equal(wcModule.buildState().running, true)

  const r = runtime({ MC_WEB_AUTO_BUILD: 'false', MC_WEB_CLIENT_DIR: dist })
  r.timers.clear()
  const cookie = await r.login()
  const building = await r.request('/play', '', cookie, 'GET')
  assert.equal(building.status, 200)
  assert.match(building.body, /building…/)
  // Self-refreshing, so the tab becomes the client once the build lands.
  assert.match(building.body, /http-equiv="refresh"/)

  const finished = await waitForBuild()
  assert.equal(finished.ok, false)
  const failed = await r.request('/play', '', cookie, 'GET')
  assert.equal(failed.status, 200)
  assert.match(failed.body, /build failed/)
  // The failure page must point at both ways forward.
  assert.match(failed.body, /npm run web-client:build/)
  assert.match(failed.body, /MC_WEB_AUTO_BUILD=false/)
})

// A stand-in for an HTTP CONNECT proxy: records the request the bot sent, then
// answers with the status the test asks for.
function fakeHttpProxy(status = 200) {
  const net = require('node:net')
  const requests = []
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buf = ''
    socket.on('data', chunk => {
      buf += chunk.toString('latin1')
      if (!buf.includes('\r\n\r\n')) return
      requests.push(buf)
      socket.write(status === 200
        ? 'HTTP/1.1 200 Connection established\r\n\r\n'
        : `HTTP/1.1 ${status} Proxy Authentication Required\r\n\r\n`)
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      requests,
      port: server.address().port,
      // A successful CONNECT leaves the tunnelled socket open by design, so
      // closing the listener alone would keep the test runner's event loop alive
      // (and the suite would never exit).
      close() { for (const s of sockets) s.destroy(); sockets.clear(); server.close() }
    }))
  })
}

// Drives the real makeProxyConnect closure against a real socket and returns the
// events the fake mineflayer client saw.
async function driveProxy(r, proxy, target = 'mc.example.com') {
  const events = []
  r.context.__client = { socket: null, setSocket(s) { this.socket = s }, emit(...args) { events.push(args) } }
  r.run(`__connect = makeProxyConnect(${JSON.stringify(target)}, 25565, () => {}, 'A')`)
  r.run('__connect(__client)')
  const start = Date.now()
  while (!events.length && Date.now() - start < 4000) await new Promise(res => setTimeout(res, 10))
  // Close the bot's end of the tunnel too, or the socket outlives the test.
  r.run('__client.socket && __client.socket.destroy()')
  return events
}

test('a per-group HTTP proxy password reaches the CONNECT request', async () => {
  const proxy = await fakeHttpProxy()
  try {
    const r = runtime({
      PROXY_GROUP_1_BOTS: 'A',
      PROXY_GROUP_1_HOST: '127.0.0.1',
      PROXY_GROUP_1_PORT: String(proxy.port),
      PROXY_GROUP_1_TYPE: 'http',
      PROXY_GROUP_1_USER: 'alice',
      PROXY_GROUP_1_PASS: 'group-one-secret'
    })
    const events = await driveProxy(r, proxy)
    assert.equal(events[0][0], 'connect', `expected a tunnel, got ${JSON.stringify(events[0])}`)
    assert.equal(proxy.requests.length, 1)
    const expected = 'Basic ' + Buffer.from('alice:group-one-secret').toString('base64')
    assert.ok(proxy.requests[0].includes(`Proxy-Authorization: ${expected}\r\n`), proxy.requests[0])
  } finally { proxy.close() }
})

test('different proxy groups send their own passwords, and a group without one inherits nothing', async () => {
  const authed = await fakeHttpProxy()
  const bare = await fakeHttpProxy()
  try {
    const shared = {
      PROXY_USER: 'global', PROXY_PASS: 'global-secret'
    }
    // Group 1 has its own password; group 2 has none and must NOT fall back to the
    // global one — that would hand the global password to a different proxy.
    const withAuth = runtime({
      ...shared, PROXY_HOST: '127.0.0.1', PROXY_PORT: String(authed.port), PROXY_TYPE: 'http',
      PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: '127.0.0.1', PROXY_GROUP_1_PORT: String(authed.port), PROXY_GROUP_1_TYPE: 'http',
      PROXY_GROUP_1_USER: 'alice', PROXY_GROUP_1_PASS: 'group-one-secret'
    })
    await driveProxy(withAuth, authed)
    assert.ok(authed.requests[0].includes('Proxy-Authorization'))

    const noAuth = runtime({
      ...shared, PROXY_HOST: '127.0.0.1', PROXY_PORT: String(bare.port), PROXY_TYPE: 'http',
      PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: '127.0.0.1', PROXY_GROUP_1_PORT: String(bare.port), PROXY_GROUP_1_TYPE: 'http'
    })
    await driveProxy(noAuth, bare)
    assert.doesNotMatch(bare.requests[0], /Proxy-Authorization/)
    assert.ok(!bare.requests[0].includes('global-secret'))
  } finally { authed.close(); bare.close() }
})

test('a 407 from the proxy names the exact env vars that need credentials', async () => {
  const proxy = await fakeHttpProxy(407)
  try {
    const r = runtime({
      PROXY_GROUP_1_BOTS: 'A',
      PROXY_GROUP_1_HOST: '127.0.0.1',
      PROXY_GROUP_1_PORT: String(proxy.port),
      PROXY_GROUP_1_TYPE: 'http'
    })
    const events = await driveProxy(r, proxy)
    assert.equal(events[0][0], 'error')
    assert.match(String(events[0][1].message), /requires a username and password/)
    assert.match(String(events[0][1].message), /PROXY_GROUP_1_USER \/ _PASS/)
  } finally { proxy.close() }
})

test('/proxy lists each group with its own auth source, without ever printing a password', () => {
  const r = runtime({
    PROXY_HOST: '9.9.9.9', PROXY_PORT: '1080', PROXY_TYPE: 'socks5',
    PROXY_USER: 'globaluser', PROXY_PASS: 'global-secret',
    PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: '1.2.3.4', PROXY_GROUP_1_USER: 'alice', PROXY_GROUP_1_PASS: 'group-one-secret',
    PROXY_GROUP_2_BOTS: 'B', PROXY_GROUP_2_HOST: '5.6.7.8', PROXY_GROUP_2_TYPE: 'http'
  })
  r.timers.clear()
  r.context.__lines = []
  r.run('subscribeLog((id, line) => __lines.push(String(line)))')
  r.run(`handleCommand('/proxy')`)
  const out = r.context.__lines.join('\n')

  // Each group's credentials are named by variable, so the fix for a 407 is visible here.
  assert.match(out, /\[1\] A → SOCKS5 alice@1\.2\.3\.4:1080 · proxy auth: PROXY_GROUP_1_USER\/_PASS/)
  // Group 2 has none, and must say so rather than implying it borrows the global pair.
  assert.match(out, /\[2\] B → HTTP 5\.6\.7\.8:1080 · proxy auth: none/)
  assert.match(out, /SOCKS5 globaluser@9\.9\.9\.9:1080 \(authenticated\)/)
  assert.ok(out.includes('never shared with a group'))
  assert.ok(!out.includes('group-one-secret'), 'group password leaked into /proxy output')
  assert.ok(!out.includes('global-secret'), 'global password leaked into /proxy output')
})

test('/status reports which variable supplies the login password, per bot', () => {
  const r = runtime({
    LOGIN_PASSWORD: 'global-pw',
    PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: '1.2.3.4', PROXY_GROUP_1_LOGIN_PASSWORD: 'group-pw'
  })
  r.timers.clear()
  r.context.__lines = []
  r.run('subscribeLog((id, line) => __lines.push(String(line)))')

  r.run(`bots.A.bot.entity = { position: { x: 1, y: 2, z: 3 } }`)
  r.run(`bots.B.bot.entity = { position: { x: 4, y: 5, z: 6 } }`)

  r.run(`handleCommand('/switch A'); handleCommand('/status')`)
  r.run(`handleCommand('/switch B'); handleCommand('/status')`)
  const out = r.context.__lines.join('\n')

  // Bot A is in group 1, so it reports the group's password variable…
  assert.match(out, /Login password: from PROXY_GROUP_1_LOGIN_PASSWORD/)
  // …and bot B, in no group, reports the global one. The password itself is never printed.
  assert.match(out, /Login password: from LOGIN_PASSWORD/)
  assert.ok(!out.includes('group-pw'))
  assert.ok(!out.includes('global-pw'))
})

// planAuthAction holds the whole login/register guard and is a plain function on
// the module, so it can be driven directly rather than through a live mineflayer
// connection (which the harness deliberately never creates).
function plan(r, id, message, now) {
  const arg = now === undefined ? '' : `, ${now}`
  return plain(r.run(`planAuthAction(${JSON.stringify(id)}, ${JSON.stringify(message)}${arg})`))
}
const LOGIN_PROMPT = 'Please login using /login <password>'
const REGISTER_PROMPT = 'Please register using /register <password> <password>'

test('an auth prompt is answered with that bot\'s own password', () => {
  const r = runtime({
    LOGIN_PASSWORD: 'global-pw',
    BOT_PASSWORDS: 'B:own-pw',
    PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: 'h', PROXY_GROUP_1_LOGIN_PASSWORD: 'group-pw'
  })
  // Three sources, three answers, resolved per bot in the real module.
  assert.deepEqual(plan(r, 'A', LOGIN_PROMPT, 1000), { command: '/login group-pw', source: 'PROXY_GROUP_1_LOGIN_PASSWORD', kind: 'login' })
  assert.deepEqual(plan(r, 'B', LOGIN_PROMPT, 1000), { command: '/login own-pw', source: 'BOT_PASSWORDS', kind: 'login' })
  assert.deepEqual(plan(r, 'C', LOGIN_PROMPT, 1000), { command: '/login global-pw', source: 'LOGIN_PASSWORD', kind: 'login' })
  // /register sends it twice, the way AuthMe expects.
  assert.deepEqual(plan(r, 'C', REGISTER_PROMPT, 1000), { command: '/register global-pw global-pw', source: 'LOGIN_PASSWORD', kind: 'register' })
  // Ordinary server chatter is not an auth prompt.
  assert.deepEqual(plan(r, 'C', 'Welcome to FATALMC!', 1000), {})
})

// The .ENV tab is only worth having if its "live" claim is true, and that is not
// visible from a registry entry: a value is live when it is read at the point of
// use, and startup-only when bot.js copies it into a const while it loads. Both
// halves are pinned here, so moving a read from one to the other without moving
// the flag fails the suite instead of quietly turning the tab into a lie.
test('the registry calls a value live only when it is read where it is used', () => {
  const r = runtime(dataEnv())
  const live = plain(r.run(`(() => {
    const want = ['CRATES_ALL_DUMP', 'CRATES_ALL_AFK_WARP', 'CRATES_ALL_AFK_DELAY_MS', 'DUMP_HOME_COMMAND', 'TPA_MAIN_PLAYER', 'WARP_COMMAND', 'BOT_NAMES', 'ANALYTICS_PORT', 'LOGIN_PASSWORD', 'ALL_SLOW_DELAY_MS', 'AUTH_RETRY_MS']
    const out = {}
    settings.list().forEach(row => { if (want.includes(row.key)) out[row.key] = row.live })
    return out
  })()`))

  // Read once while bot.js loads, so the tab has to ask for a restart.
  for (const key of ['CRATES_ALL_DUMP', 'CRATES_ALL_AFK_WARP', 'CRATES_ALL_AFK_DELAY_MS', 'DUMP_HOME_COMMAND', 'TPA_MAIN_PLAYER', 'WARP_COMMAND', 'BOT_NAMES', 'ANALYTICS_PORT']) {
    assert.equal(live[key], false, key + ' is captured at boot, so the tab must not call it live')
  }
  // Read where they are used, so an override applies immediately.
  for (const key of ['LOGIN_PASSWORD', 'ALL_SLOW_DELAY_MS', 'AUTH_RETRY_MS']) {
    assert.equal(live[key], true, key + ' is read at the point of use, so the tab may call it live')
  }

  // The live half is not just a label. The auth path resolves the password out of
  // process.env at every attempt - which is what /env set and the .ENV tab write -
  // so a change reaches the next /auth-retry rather than the next restart.
  assert.deepEqual(plan(r, 'B', LOGIN_PROMPT, 1000), { command: '/login 123456', source: 'built-in default', kind: 'login' })
  r.run("process.env.LOGIN_PASSWORD = 'hunter2'")
  assert.deepEqual(plan(r, 'B', LOGIN_PROMPT, 2000), { command: '/login hunter2', source: 'LOGIN_PASSWORD', kind: 'login' })
})

test('a rejected login stops the bot answering prompts and alerts once', () => {
  const r = runtime({ LOGIN_PASSWORD: 'wrong-pw' })
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 1000).command, '/login wrong-pw')

  const failed = plan(r, 'A', 'Wrong password!', 1100)
  assert.equal(failed.record.kind, 'bad-password')
  assert.equal(failed.record.until, null, 'a wrong password is sticky, not a timed wait')
  assert.equal(failed.alert, true)
  assert.equal(r.run('authState.get("A").failure.kind'), 'bad-password')

  // From here the bot refuses to answer, so the account is never hammered.
  const skipped = plan(r, 'A', LOGIN_PROMPT, 1200)
  assert.equal(skipped.command, undefined)
  assert.equal(skipped.skip.kind, 'bad-password')
  assert.equal(skipped.skip.reason, 'Wrong password')

  // A failure is not re-notified on every prompt it suppresses.
  assert.equal(r.authAlerts.length, 0, 'the guard itself does not alert; the chat handler does')
})

test('a player typing a failure phrase, or a late one, cannot disable a bot', () => {
  const r = runtime({ LOGIN_PASSWORD: 'pw' })
  plan(r, 'A', LOGIN_PROMPT, 1000)

  // Looks like player chat (Name: message) rather than a server reply.
  assert.deepEqual(plan(r, 'A', 'Steve: wrong password lol', 1100), {})
  // Outside the reply window: nobody just sent an auth command for this to answer.
  const late = 1000 + r.run('AUTH_REPLY_WINDOW_MS') + 1
  assert.deepEqual(plan(r, 'A', 'Wrong password!', late), {})
  // Either way the bot is still able to log in.
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 2000).command, '/login pw')
  assert.equal(r.run('authState.get("A").failure === undefined'), true, 'nothing was recorded')
})

test('repeated throttling is waited out, then escalates to a wrong password', () => {
  const r = runtime({ LOGIN_PASSWORD: 'pw', AUTH_RETRY_MS: '1000', AUTH_MAX_THROTTLED_RETRIES: '2' })
  const throttled = 'Too many failed attempts, please wait 10 seconds before trying again'

  plan(r, 'A', LOGIN_PROMPT, 1000)
  const first = plan(r, 'A', throttled, 1100)
  assert.equal(first.record.kind, 'throttled')
  assert.equal(first.record.until, 2100)
  assert.equal(first.alert, true)

  // While the wait is running the prompt is refused…
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 1200).skip.kind, 'throttled')
  // …and once it expires the bot tries again by itself.
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 2101).command, '/login pw')

  const second = plan(r, 'A', throttled, 2102)
  assert.equal(second.record.kind, 'throttled')
  assert.equal(second.alert, false, 'the same kind of failure is only alerted once')

  // A third one is the end of the road: this is a wrong password wearing a hat.
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 3103).command, '/login pw')
  const third = plan(r, 'A', throttled, 3104)
  assert.equal(third.record.kind, 'bad-password')
  assert.equal(third.record.until, null)
  assert.equal(third.alert, true, 'escalating to a real failure is worth an alert')
  assert.match(third.record.reason, /repeated 3 times/)
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 9000).skip.kind, 'bad-password')
})

test('an "already logged in" reply is a short pause, never a credential verdict', () => {
  const r = runtime({ LOGIN_PASSWORD: 'pw', AUTH_ALREADY_MS: '5000' })
  plan(r, 'A', LOGIN_PROMPT, 1000)
  const already = plan(r, 'A', 'You are already logged in!', 1100)
  assert.equal(already.record.kind, 'already')
  assert.equal(already.record.until, 6100)
  // The previous connection's session has not expired yet — normal on a fast
  // reconnect — so this must not be treated as a wrong password.
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 1200).skip.kind, 'already')
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 6100).command, '/login pw')
})

test('/auth-retry clears a recorded failure so the bot can log in again', () => {
  const r = runtime({ LOGIN_PASSWORD: 'pw' })
  plan(r, 'A', LOGIN_PROMPT, 1000)
  plan(r, 'A', 'Wrong password!', 1100)
  assert.equal(r.run('authState.has("A")'), true)
  assert.ok(plan(r, 'A', LOGIN_PROMPT, 1200).skip)

  r.context.__lines = []
  r.run('subscribeLog((id, line) => __lines.push(String(line)))')
  r.timers.clear()
  r.run(`handleCommand('/auth-retry A')`)
  const out = r.context.__lines.join('\n')
  assert.match(out, /cleared bad-password/)
  assert.match(out, /Wrong password/)
  assert.equal(r.run('authState.has("A")'), false, 'the hold is cleared')
  // And the very next prompt is answered again.
  assert.equal(plan(r, 'A', LOGIN_PROMPT, 1300).command, '/login pw')
})

test('/auth-retry reports a bot with nothing recorded, and refuses a stranger', () => {
  const r = runtime({ LOGIN_PASSWORD: 'pw' })
  r.context.__lines = []
  r.run('subscribeLog((id, line) => __lines.push(String(line)))')
  r.run(`handleCommand('/auth-retry A')`)
  assert.match(r.context.__lines.join('\n'), /no recorded auth failure/)
  r.context.__lines = []
  r.run(`handleCommand('/auth-retry ghost')`)
  assert.match(r.context.__lines.join('\n'), /No bot named "ghost"/)
})

test('/proxy names the login-password source, and reports a group with no proxy', () => {
  const r = runtime({
    PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: '1.2.3.4', PROXY_GROUP_1_LOGIN_PASSWORD: 'pw-one',
    // Group 2 exists only to group accounts: no HOST, so no dedicated proxy.
    PROXY_GROUP_2_BOTS: 'B', PROXY_GROUP_2_LOGIN_PASSWORD: 'pw-two'
  })
  r.timers.clear()
  r.context.__lines = []
  r.run('subscribeLog((id, line) => __lines.push(String(line)))')
  r.run(`handleCommand('/proxy')`)
  const out = r.context.__lines.join('\n')

  assert.match(out, /\[1\] A → SOCKS5 1\.2\.3\.4:1080 · proxy auth: none · login: PROXY_GROUP_1_LOGIN_PASSWORD/)
  // A hostless group must not read as hosting a proxy at :0, and its password still applies.
  assert.match(out, /\[2\] B → no dedicated proxy \(uses the default connection\) · login: PROXY_GROUP_2_LOGIN_PASSWORD/)
  assert.doesNotMatch(out, /:0\b/, 'no made-up proxy address')
  assert.ok(!out.includes('pw-one') && !out.includes('pw-two'))
})

test('startup names a group variable that no group actually declares', () => {
  const r = runtime({
    PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_HOST: '1.2.3.4',
    // No PROXY_GROUP_2_*, so group 3 is never reached by the scan.
    PROXY_GROUP_3_BOTS: 'B', PROXY_GROUP_3_LOGIN_PASSWORD: 'orphaned-pw'
  })
  r.timers.clear()
  const out = r.run('systemLogs.map(l => l.text).join("\\n")')
  assert.match(out, /ignored, no group declares them: PROXY_GROUP_3_BOTS, PROXY_GROUP_3_LOGIN_PASSWORD/)
  assert.match(out, /Groups start at PROXY_GROUP_1_BOTS/)
  assert.ok(!out.includes('orphaned-pw'), 'the value is never printed')
})

test('startup says when a group carries no proxy of its own', () => {
  const r = runtime({ PROXY_GROUP_1_BOTS: 'A', PROXY_GROUP_1_LOGIN_PASSWORD: 'pw-one' })
  r.timers.clear()
  const out = r.run('systemLogs.map(l => l.text).join("\\n")')
  assert.match(out, /PROXY_GROUP_1 has no HOST — its 1 bot\(s\) use the default route, but its login password still applies/)
})

// Flushes every pending microtask so an awaited sequence has fully settled
// before the next assertion (the harness's timers are manual).
const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve))

// Every log line a runtime has produced — the global `log()` helpers write to
// the active bot's log, while startup warnings go to the system log.
function logsText (r) {
  return r.run("Object.keys(bots).map(id => bots[id].logs.map(l => l.text).join('\\n')).join('\\n') + '\\n' + systemLogs.map(l => l.text).join('\\n')")
}

// Fires every pending mocked timer once (and drops it), the way the real clock
// would as time passes.
function runPendingTimers (r) {
  for (const t of [...r.timers.values()]) { r.timers.delete(t); t.fn() }
}

// The sequence awaits real (mocked) timers between its steps, so a test driving
// it has to advance the clock until the promise settles.
async function driveSequence (r, promise) {
  let settled = false
  promise.then(() => { settled = true }, () => { settled = true })
  for (let i = 0; i < 50 && !settled; i++) {
    await flushMicrotasks()
    if (settled) break
    runPendingTimers(r)
  }
  return promise
}

// The sequence is what actually sends the warp, so it is stubbed out and the
// real runCratesAll is allowed to stagger + thread the plan through to it.
function captureSequence (r) {
  r.run(`
    captured = []
    runCratesAllSequenceForBot = (id, color, plan) => {
      captured.push({ id, color, plan: Object.assign({}, plan) })
      return Promise.resolve()
    }
  `)
  return () => plain(r.run('captured'))
}

test('/crates-all options default to the env values and are overridden per run', async () => {
  const r = runtime({ CRATES_ALL_DUMP: 'home', CRATES_ALL_AFK_DELAY_MS: '0' })
  const captured = captureSequence(r)

  r.run("handleCommand('/crates-all')")
  runPendingTimers(r)
  await flushMicrotasks()
  const withEnvDefaults = captured()
  assert.equal(withEnvDefaults.length, 3)
  assert.deepEqual(withEnvDefaults[0], { id: 'A', plan: { dump: 'home', target: '', afkWarp: true, afkDelayMs: 0 } })
  assert.match(logsText(r), /Starting \/crates-all for 3 bot\(s\) \[1–3\], 30s apart — dump via \/home stash, immediate \/warp afk…/)

  r.run("captured = []; handleCommand('/crates-all 1 purple dump=player:Smith afk=off')")
  runPendingTimers(r)
  await flushMicrotasks()
  const withFlags = captured()
  assert.equal(withFlags.length, 1)
  assert.equal(withFlags[0].color, 'purple_shulker_box')
  assert.equal(withFlags[0].plan.dump, 'tpa')
  assert.equal(withFlags[0].plan.target, 'Smith')
  assert.equal(withFlags[0].plan.afkWarp, false)
})

test('/crates-solo takes the same dump=/afk= flags', async () => {
  const r = runtime()
  const captured = captureSequence(r)

  r.run("handleCommand('/crates-solo B dump=off afk=now')")
  await flushMicrotasks()
  assert.deepEqual(captured(), [{ id: 'B', plan: { dump: 'off', target: '', afkWarp: true, afkDelayMs: 0 } }])

  // A bare word is not a target: it is a typo, and a typo must not teleport a
  // bot to a player whose name happens to match it.
  r.run("captured = []; handleCommand('/crates-solo B dump=Smith')")
  await flushMicrotasks()
  assert.deepEqual(captured(), [])
  assert.match(logsText(r), /Unknown option "dump=Smith"/)

  r.run("captured = []; handleCommand('/crates-solo B dump=player:Smith afk=off')")
  await flushMicrotasks()
  assert.deepEqual(captured(), [{ id: 'B', plan: { dump: 'tpa', target: 'Smith', afkWarp: false, afkDelayMs: 15000 } }])

  // A token the parser cannot read must warn and run nothing at all — the
  // whole point of reporting instead of guessing.
  r.run("captured = []; handleCommand('/crates-solo B foo=bar')")
  await flushMicrotasks()
  assert.deepEqual(captured(), [])
  assert.match(logsText(r), /Unknown option "foo=bar"\. Usage: \/crates-solo \[bot name or number\] \[color\]/)
})

test('/crates-all afk=now warps the moment the routine ends, afk=off never warps', async () => {
  const r = runtime()
  await r.run(`
    chats = []
    bots.A.bot = { entity: {}, chat(msg) { chats.push(msg) } }
    runShardshopLoop = async () => ({ runs: 1, stopReason: 'message' })
    runCrateRoutine = async () => true
  `)

  // dump=off keeps this off the real TPA/chest path.
  await driveSequence(r, r.run("runCratesAllSequenceForBot('A', null, cratesAllPlan(parseCratesAllFlags(['dump=off', 'afk=now'])))"))
  assert.deepEqual(plain(r.run('chats')), ['/warp afk'])
  assert.ok(r.run("bots.A.logs.map(l => l.text).some(line => line.includes('Dump step skipped (dump=off)'))"), 'dump=off must skip the dump step')

  r.run('chats = []')
  await driveSequence(r, r.run("runCratesAllSequenceForBot('A', null, cratesAllPlan(parseCratesAllFlags(['dump=off', 'afk=off'])))"))
  assert.deepEqual(plain(r.run('chats')), [], 'afk=off must never warp')

  // The default is unchanged: a 15s wait before the warp, so the warp is not
  // sent until that timer fires.
  r.run('chats = []')
  const pending = r.run("runCratesAllSequenceForBot('A', null, cratesAllPlan(parseCratesAllFlags(['dump=off'])))")
  await flushMicrotasks()
  runPendingTimers(r) // the wait between the crate step and the dump step
  await flushMicrotasks()
  assert.deepEqual(plain(r.run('chats')), [], 'the default warp waits 15s')
  assert.ok([...r.timers.values()].some(t => t.delay === 15000), 'a 15s warp timer is pending')
  await driveSequence(r, pending)
  assert.deepEqual(plain(r.run('chats')), ['/warp afk'])
})

test('dump=hidden turns the AFK warp off unless the run asks for one', async () => {
  const r = runtime()
  // A hidden dump leaves each bot where it TPA'd to, so warping AFK afterwards
  // would undo it.
  assert.equal(r.run("cratesAllPlan(parseCratesAllFlags(['dump=hidden'])).afkWarp"), false)
  assert.equal(r.run("cratesAllPlan(parseCratesAllFlags(['dump=hidden', 'afk=now'])).afkWarp"), true)
  // CRATES_ALL_AFK_WARP=true is still overruled by dump=hidden, since the
  // documented reason for hidden is staying put.
  const hiddenEnv = runtime({ CRATES_ALL_DUMP: 'hidden', CRATES_ALL_AFK_WARP: 'true' })
  assert.equal(hiddenEnv.run('cratesAllPlan({}).dump'), 'hidden')
  assert.equal(hiddenEnv.run('cratesAllPlan({}).afkWarp'), false)
})

test('/play embeds the client once a build exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-built-'))
  const dist = path.join(dir, 'dist')
  fs.mkdirSync(dist, { recursive: true })
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>built</title>')
  // An off-the-beaten-path port: the harness mocks bot.js's own http module, but
  // web-client.js is loaded for real and would otherwise bind the default 8090.
  const r = runtime({ MC_WEB_AUTO_BUILD: 'false', MC_WEB_CLIENT_DIR: dist, MC_WEB_CLIENT_PORT: '47899' })
  r.timers.clear()
  const cookie = await r.login()
  const res = await r.request('/play', '', cookie, 'GET')
  assert.equal(res.status, 200)
  assert.match(res.body, /<iframe/)
  assert.doesNotMatch(res.body, /build not found/)
  try { wcModule.stopWebClient(r.run('webHandle.webClient'), () => {}) } catch (_) {}
})

// The balance being sampled is the bot's WHOLE-player balance, so one run's
// spawner rows are slices of the same number. This drives the real
// runSpawnerRoutine with stubbed clicks to pin down where the total is kept.
test('/spawners accumulates earnings on the bot row and publishes inventory usage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawner-data-'))
  const r = runtime({ DATA_FILE: path.join(dir, 'spawner-data.json') })
  await r.run(`
    chats = []
    var balances = [100, 130, 200, 250]
    bots.A.bot = {
      entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 1 } },
      game: { dimension: 'overworld' },
      registry: { blocksByName: { spawner: { id: 1 } } },
      inventory: { slots: Object.assign(new Array(46).fill(null), { 9: { name: 'stone' }, 10: { name: 'stone' }, 11: { name: 'stone' } }) },
      findBlocks: () => [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }],
      currentWindow: null
    }
    clickSpawnerOnce = async () => ({ ok: true, balanceBefore: 0, balanceAfter: balances.shift() })
    queryBalance = async () => 250
  `)

  // Run 1 only establishes each spawner's baseline balance — nothing is earned yet.
  await driveSequence(r, r.run("runSpawnerRoutine('A')"))
  assert.equal(r.run('dataState.spawners["A:1"].balance'), 100)
  assert.equal(r.run('dataState.spawners["A:1"].earned'), null)
  assert.equal(r.run('dataState.spawners["A:1"].lifetimeEarned'), undefined, 'no per-spawner lifetime column any more')
  assert.equal(r.run('dataState.bots.A.lifetimeEarned'), 0)
  assert.equal(r.run('dataState.bots.A.invUsed'), 3)
  assert.equal(r.run('dataState.bots.A.invFree'), 33)
  assert.equal(r.run('dataState.bots.A.invTotal'), 36)

  // A leftover row from an earlier, larger run must not keep a stale measurement.
  r.run("dataStore.upsertSpawner(dataState, { bot: 'A', spawnerNumber: 3, earned: 999, ratePerHour: 999 })")

  await driveSequence(r, r.run("runSpawnerRoutine('A')"))
  assert.equal(r.run('dataState.spawners["A:1"].earned'), 100, 'the row keeps its own slice')
  assert.equal(r.run('dataState.spawners["A:2"].earned'), 120)
  // 100 + 120 is the whole run, which is what the bot actually earned.
  assert.equal(r.run('dataState.bots.A.earned'), 220)
  assert.equal(r.run('dataState.bots.A.lifetimeEarned'), 220)
  assert.ok(r.run('dataState.bots.A.ratePerHour') > 0, 'the rate comes from the run window')
  const stale = plain(r.run('dataState.spawners["A:3"]'))
  assert.equal(stale.earned, null, 'a row this run did not visit is not counted into the sheet total')
  assert.equal(stale.ratePerHour, null)
  assert.equal(stale.calculationStatus, 'not seen this run')

  // A second completed run keeps accumulating on the same bot row.
  r.run('balances = [300, 400]')
  await driveSequence(r, r.run("runSpawnerRoutine('A')"))
  assert.equal(r.run('dataState.bots.A.lifetimeEarned'), 220 + (300 - 200) + (400 - 250))
  assert.equal(r.run('dataState.bots.A.lifetimeEarned'), 470)
})

// ── Coinflip data runs, time series, analytics and the .ENV settings tab ─────

// Its own history files per runtime: these commands write records, and the
// repo's data folder is not a test fixture.
function dataEnv (env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-data-'))
  return {
    COINFLIP_FILE: path.join(dir, 'coinflip-history.jsonl'),
    COINFLIP_DEEP_FILE: path.join(dir, 'coinflip-deep.json'),
    COINFLIP_EXPORT_FILE: path.join(dir, 'coinflip-export.csv'),
    TIMESERIES_FILE: path.join(dir, 'timeseries.jsonl'),
    // Short enough that a run in a test gets as far as sending the create.
    COINFLIP_POLL_MS: '1000',
    // The production default is a real 2.5s wait in front of every create;
    // these tests would sit on a timer the harness never fires. The cooldown
    // has its own test, which sets it back up per run.
    COINFLIP_CREATE_COOLDOWN_MS: '0',
    ...env
  }
}

// A bot whose balance queries get real answers. `queryBalance` waits for a reply
// that *parses* — the shard and coin replies are labelled, the money reply is
// not (and deliberately ignores the labelled ones) — so the fake has to answer
// the command it was sent. Replying to every message at once would leave
// /shards and /coins waiting on a timer this harness never fires.
function payingBot (id, balance, extra = {}) {
  const shards = extra.shards == null ? 1234 : extra.shards
  const coins = extra.coins == null ? 567 : extra.coins
  return `(() => {
    const listeners = bots.__payingListeners || (bots.__payingListeners = [])
    bots.${id}.bot = {
      entity: {}, health: 20, food: 20,
      chat(msg) {
        chats.push(['${id}', msg])
        const reply = msg === '/shards' ? 'Shards | Balance: ${shards}'
          : msg === '/coins' ? 'Coins | Balance: ${coins}'
            : /^\\/bal\\b/.test(msg) ? 'Balance: $${balance}'
              : null
        if (reply == null) return
        listeners.slice().forEach(fn => fn({ toString: () => reply }))
      },
      once() {}, removeListener() {},
      on(event, fn) { if (event === 'message') listeners.push(fn) }
    }
  })()`
}

// The coinflip commands only; a balance query is also chat traffic.
const coinflipChats = (r) => plain(r.run("chats.filter(c => c[1].startsWith('/coinflip'))"))

const channelLogs = (r, ...ids) => ids
  .map(id => (id === 'system' ? r.run('systemLogs.map(l => l.text)') : r.run(`bots.${id}.logs.map(l => l.text)`)))
  .flat()
  .join('\n')

test('/bot-coinflip run sends one create for the requested wager and remembers the session', async () => {
  const r = runtime(dataEnv())
  r.run(payingBot('A', 50000))
  r.run("handleCommand('/bot-coinflip run 1000 2 A', { selectedId: 'A' })")
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(coinflipChats(r), [['A', '/coinflip create 1000']])
  assert.equal(r.run('coinflipSessions.get("A").planned'), 2)
  assert.equal(r.run('coinflipSessions.get("A").stopped'), 'running')
  // Nothing about a busy or unanswered flip may ever delete it.
  assert.equal(r.run("chats.some(c => /delete/.test(c[1]))"), false)

  // A refusal from the server ends the run, and the bot is then free to run again.
  r.run("coinflipObserverFor('A').feed('You do not have enough money for this coinflip bet')")
  await new Promise(resolve => setTimeout(resolve, 1300))
  assert.match(channelLogs(r, 'A'), /stopped: insufficient-balance/)
  assert.equal(r.run('coinflipSessions.has("A")'), false)
  assert.equal(r.run('coinflipLastRun.get("A").stopped'), 'insufficient-balance')
})

test('/bot-coinflip run takes a named bot, and an unknown name is reported rather than guessed at', async () => {
  const r = runtime(dataEnv())
  r.run(payingBot('B', 50000))
  r.run("handleCommand('/bot-coinflip run 500 1 B')")
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(coinflipChats(r), [['B', '/coinflip create 500']])
  r.run("coinflipObserverFor('B').feed('You do not have enough money for this coinflip bet')")
  await new Promise(resolve => setTimeout(resolve, 1300))

  r.run('chats = []')
  r.run("handleCommand('/bot-coinflip run 500 1 Ghost')")
  assert.deepEqual(plain(r.run('chats')), [])
  assert.match(channelLogs(r, 'A', 'B', 'system'), /No bot named/)
})

test('an unreadable PRICE is refused and no coinflip is sent', () => {
  const r = runtime(dataEnv())
  r.run("handleCommand('/bot-coinflip run 5x 2 A', { selectedId: 'A' })")
  assert.deepEqual(plain(r.run('chats')), [])
  assert.match(channelLogs(r, 'A', 'system'), /Unknown option/)
})

test('/bot-coinflip run is dispatched per bot, which is what /all-slow needs', async () => {
  const r = runtime(dataEnv())
  r.run(payingBot('B', 50000))
  r.run("dispatchCommandToBot('/bot-coinflip run 250 1', 'B')")
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(coinflipChats(r), [['B', '/coinflip create 250']])
  assert.equal(r.run('coinflipSessions.has("A")'), false, 'the selected bot is not the target here')
  r.run("coinflipObserverFor('B').feed('You do not have enough money for this coinflip bet')")
  await new Promise(resolve => setTimeout(resolve, 1300))
})

// ── One /bot-coinflip suite: run, stats, deep, history and export under one name ─

test('/bot-coinflip with no subcommand lists the suite and the recorded totals', () => {
  const r = runtime(dataEnv())
  r.run("coinflipStore.append({ id: 'x1', bot: 'A', ts: 1700000000000, wager: 1000, result: 'won', delta: 1000, method: 'message' })")
  r.run("handleCommand('/bot-coinflip', { selectedId: 'A' })")
  const logs = channelLogs(r, 'A')
  assert.match(logs, /── \/bot-coinflip ──/)
  assert.match(logs, /1 resolved flip\(s\) \(1W\/0L\)/)
  assert.match(logs, /\/bot-coinflip run \[PRICE\] \[AMOUNT\] \[BOT\|all\]/)
  assert.match(logs, /\/bot-coinflip deep \[BOT\]/)
  assert.match(logs, /\/bot-coinflip export \[BOT\]/)
  // A bare /bot-coinflip is the console's; it must not land in the game as chat.
  assert.deepEqual(plain(r.run('chats')), [])
})

test('/bot-coinflip run plays and records exactly what /bot-coinflip run did', async () => {
  const r = runtime(dataEnv())
  r.run(payingBot('A', 50000))
  r.run("handleCommand('/bot-coinflip run 1200 2 A', { selectedId: 'A' })")
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(coinflipChats(r), [['A', '/coinflip create 1200']])
  assert.equal(r.run('coinflipSessions.get("A").planned'), 2)
  assert.equal(r.run('coinflipSessions.get("A").stopped'), 'running')
  r.run("coinflipObserverFor('A').feed('You do not have enough money for this coinflip bet')")
  await new Promise(resolve => setTimeout(resolve, 1300))
  assert.equal(r.run('coinflipSessions.has("A")'), false)
})

test('/bot-coinflip run is dispatched per bot, which is what /all-slow needs now', async () => {
  const r = runtime(dataEnv())
  r.run(payingBot('B', 50000))
  r.run("dispatchCommandToBot('/bot-coinflip run 250 1', 'B')")
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(coinflipChats(r), [['B', '/coinflip create 250']])
  assert.equal(r.run('coinflipSessions.has("A")'), false, 'the selected bot is not the target here')
  r.run("coinflipObserverFor('B').feed('You do not have enough money for this coinflip bet')")
  await new Promise(resolve => setTimeout(resolve, 1300))
})

test('/bot-coinflip stats and /bot-coinflip history answer on the merged names', () => {
  const r = runtime(dataEnv())
  r.run("coinflipStore.append({ id: 'x1', bot: 'A', ts: 1700000000000, wager: 1000, result: 'won', delta: 1000, opponent: 'Rival', method: 'message' })")
  r.run("handleCommand('/bot-coinflip stats A', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A'), /1 resolved \(1W\/0L\)/)

  r.run("handleCommand('/bot-coinflip history', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A'), /Last 1 coinflip\(s\)/)

  r.run('chats = []')
  r.run("handleCommand('/bot-coinflip history clear', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A'), /\/bot-coinflip history clear confirm/)
  assert.equal(r.run('coinflipStore.all().length'), 1, 'clear without confirm changes nothing')
})

test('/bot-coinflip deep finds the same dissection the older name found', () => {
  const r = runtime(dataEnv())
  for (let i = 0; i < 40; i++) {
    r.run(`coinflipStore.append({ id: 'd${i}', bot: 'A', ts: ${1700000000000 + i * 60000}, wager: 1000, result: '${i % 2 ? 'won' : 'lost'}', delta: ${i % 2 ? 1000 : -1000}, balanceBefore: 50000, method: 'message', serverHour: ${8 + (i % 4)} })`)
  }
  r.run("handleCommand('/bot-coinflip deep A', { selectedId: 'A' })")
  const logs = channelLogs(r, 'A')
  assert.match(logs, /Coinflip dissection \(A\)/)
  assert.match(logs, /40 resolved flip\(s\)/)
  assert.match(logs, /What the numbers say/)
})

test('/bot-coinflip export reports every flip and where the CSV went', () => {
  const r = runtime(dataEnv())
  r.run("coinflipStore.append({ index: 1, id: 'x1', bot: 'A', ts: 1700000000000, wager: 1000, result: 'won', delta: 1000, opponent: 'Rival', balanceBefore: 50000, balanceAfter: 51000, method: 'message', serverHour: 9 })")
  r.run("coinflipStore.append({ index: 2, id: 'x2', bot: 'B', ts: 1700000060000, wager: 2000, result: 'lost', delta: -2000, balanceBefore: 40000, balanceAfter: 38000, method: 'recreate' })")
  r.run("handleCommand('/bot-coinflip export', { selectedId: 'A' })")
  const logs = channelLogs(r, 'A')
  assert.match(logs, /2 flip\(s\) exported to .*coinflip-export\.csv/)
  assert.match(logs, /columns: index, ts, utc, bot, result, wager, opponent, delta/)

  r.run('bots.A.logs.length = 0')
  r.run("handleCommand('/bot-coinflip export B', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A'), /1 flip\(s\) exported/, 'the bot argument scopes the export')

  r.run('bots.A.logs.length = 0')
  r.run("handleCommand('/bot-coinflip export Ghost', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A'), /No bot named "Ghost"/, 'an unknown bot is reported, not widened to the fleet')
})

test('the server owns /coinflip and the suite owns /bot-coinflip', () => {
  const r = runtime(dataEnv())
  r.run(payingBot('A', 50000))
  // /coinflip is a SERVER command, so the console must not own that name: a bare
  // one and the game's own subcommands all reach the bot as ordinary chat.
  r.run("handleCommand('/coinflip', { selectedId: 'A' })")
  r.run("handleCommand('/coinflip create 10000', { selectedId: 'A' })")
  r.run("handleCommand('/coinflip delete', { selectedId: 'A' })")
  assert.deepEqual(plain(r.run("chats.map(c => c[1])")), ['/coinflip', '/coinflip create 10000', '/coinflip delete'])
  assert.equal(r.run('coinflipSessions.size'), 0, 'the console did not start a data run')

  // The suite name refuses a subcommand it does not own instead of inventing
  // server chat out of it, and points at the game's command.
  r.run('bots.A.logs.length = 0')
  r.run("handleCommand('/bot-coinflip create 10000', { selectedId: 'A' })")
  const logs = channelLogs(r, 'A')
  assert.match(logs, /Unknown \/bot-coinflip subcommand "create"/)
  assert.match(logs, /plain \/coinflip/)
  assert.equal(r.run("chats.filter(c => c[1].startsWith('/bot-coinflip')).length"), 0, 'never forwarded as chat')
})

test('/bot-coinflip stats reports the recorded numbers, the streak and the fairness verdict', () => {
  const r = runtime(dataEnv())
  r.run("coinflipStore.append({ id: 'x1', bot: 'A', ts: 1700000000000, wager: 1000, result: 'won', delta: 1000, opponent: 'Rival', method: 'message' })")
  r.run("coinflipStore.append({ id: 'x2', bot: 'A', ts: 1700000001000, wager: 1000, result: 'lost', delta: -1000, opponent: 'Rival', method: 'message' })")
  r.run("handleCommand('/bot-coinflip stats A', { selectedId: 'A' })")
  const logs = channelLogs(r, 'A')
  assert.match(logs, /2 resolved \(1W\/1L\)/)
  assert.match(logs, /net: \$0/)
  assert.match(logs, /fairness verdict: insufficient-data/)
  assert.match(logs, /per opponent:/)
  assert.match(logs, /Rival: 2 flips/)
})

test('/bot-coinflip stats on an empty history says how to fill it instead of printing zeros', () => {
  const r = runtime(dataEnv())
  r.run("handleCommand('/bot-coinflip stats', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A'), /No coinflip history for the whole fleet yet/)
  assert.match(channelLogs(r, 'A'), /run \/bot-coinflip run/)
})

test('/bot-coinflip history lists the flips and needs a confirmation to erase them', () => {
  const r = runtime(dataEnv())
  r.run("coinflipStore.append({ id: 'x1', bot: 'A', ts: 1700000000000, wager: 2000, result: 'lost', delta: -2000, opponent: 'Rival', method: 'message' })")
  r.run("handleCommand('/bot-coinflip history', { selectedId: 'A' })")
  let logs = channelLogs(r, 'A')
  assert.match(logs, /Last 1 coinflip\(s\)/)
  assert.match(logs, /\$2,000/)

  r.run("handleCommand('/bot-coinflip history clear', { selectedId: 'A' })")
  assert.equal(r.run('coinflipStore.all().length'), 1, 'clear without confirm changes nothing')
  assert.match(channelLogs(r, 'A'), /clear confirm/)

  r.run("handleCommand('/bot-coinflip history clear confirm', { selectedId: 'A' })")
  assert.equal(r.run('coinflipStore.all().length'), 0)
})

test('/timeseries status shows the cadence, the file and the metrics', () => {
  const r = runtime(dataEnv())
  r.run("handleCommand('/timeseries status', { selectedId: 'A' })")
  const logs = channelLogs(r, 'A')
  assert.match(logs, /Time series/)
  assert.match(logs, /sampling: on/)
  assert.match(logs, /samples: 0/)
  assert.match(logs, /shards: no data yet/)
})

test('/timeseries series reports the recorded samples and where the JSON is', () => {
  const r = runtime(dataEnv())
  r.run("recordTimeseriesSample('A', { shards: 10 }, 'test')")
  r.run("recordTimeseriesSample('A', { shards: 40 }, 'test')")
  r.run("recordFleetSample('test')")
  r.run("handleCommand('/timeseries series shards', { selectedId: 'A' })")
  const logs = channelLogs(r, 'A')
  assert.match(logs, /shards \(fleet\)/)
  assert.match(logs, /\/api\/timeseries\?metric=shards/)
  // The last bucket is printed even when there are too few points for a line.
  assert.match(logs, /40/)

  // Per bot, the same metric is scoped to that bot's own samples.
  r.run("handleCommand('/timeseries series shards 1h A', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A'), /shards · A/)
})

test('the analytics report is built from the same history and samples the page reads', () => {
  const r = runtime(dataEnv())
  r.run("coinflipStore.append({ id: 'x1', bot: 'A', ts: 1700000000000, wager: 1000, result: 'won', delta: 1000, method: 'message' })")
  r.run("recordTimeseriesSample('A', { shards: 10, coins: 1, balance: 100 }, 'test')")
  const report = plain(r.run('buildAnalyticsReport()'))
  assert.equal(report.headline.coinflips, 1)
  assert.equal(report.headline.shardsNow, 10)
  assert.equal(report.coinflip.stats.wins, 1)
  assert.ok(report.timeseries.bots.includes('A'))
  assert.match(r.run('analytics.renderHtml(buildAnalyticsReport())'), /Fairness verdict/)
})

test('the time-series sampler records a bot sample and a fleet total', async () => {
  const r = runtime(dataEnv())
  r.run(payingBot('A', 50000))
  r.run('startTimeseriesSampler()')
  assert.ok(r.run('cfDuration(settings.get("TIMESERIES_INTERVAL_MS"))') === '1h 0m')

  const sampled = await r.run("sampleTimeseriesNow({ source: 'test' })")
  assert.equal(sampled, 1)
  const rows = plain(r.run('timeseriesStore.all()'))
  assert.equal(rows.length, 2, 'the bot sample and the fleet total')
  assert.equal(rows[0].kind, 'bot')
  assert.equal(rows[0].balance, 50000)
  assert.equal(rows[0].source, 'test')
  assert.equal(rows[1].kind, 'fleet')
  assert.equal(rows[1].balance, 50000)
  assert.equal(rows[1].bots, 1)
})

test('time-series sampling records nothing when it is switched off', async () => {
  const r = runtime(dataEnv({ TIMESERIES_ENABLED: 'false' }))
  r.run(payingBot('A', 50000))
  await r.run("sampleTimeseriesNow({ source: 'test' })")
  assert.equal(r.run('timeseriesStore.all().length'), 0)
  assert.equal(r.run("recordTimeseriesSample('A', { shards: 1 }, 'test')"), null)
})

test('the analytics server serves the page and the JSON, and needs a session', async () => {
  const r = runtime(dataEnv())
  r.run("coinflipStore.append({ id: 'x1', bot: 'A', ts: 1700000000000, wager: 1000, result: 'won', delta: 1000, method: 'message' })")
  // Sign in through the dashboard first: the cookie is shared across ports.
  const cookie = await r.login()
  r.run('startAnalyticsServer()')

  const port = r.run("settings.get('ANALYTICS_PORT')")
  const page = await r.request('/', '', cookie, 'GET', port)
  assert.equal(page.status, 200, page.body)
  assert.match(page.body, /AFK <b>ANALYTICS<\/b>/)
  assert.match(page.body, /Fleet over time|No samples yet/)
  assert.match(page.body, /Fairness verdict/)

  const json = JSON.parse((await r.request('/api/analytics', '', cookie, 'GET', port)).body)
  assert.ok(json.generatedAt > 0)
  assert.ok(json.coinflip && json.timeseries && json.headline)
  assert.equal(json.headline.coinflips, 1)
  assert.equal(json.headline.coinflipNet, 1000)

  const series = JSON.parse((await r.request('/api/timeseries?metric=shards&bucket=1h', '', cookie, 'GET', port)).body)
  assert.equal(series.metric, 'shards')
  assert.equal(series.bucketMs, 3600000)

  // Without the session it explains how to get in rather than leaking the data.
  const denied = await r.request('/api/analytics', '', '', 'GET', port)
  assert.equal(/generatedAt/.test(denied.body), false)
  assert.match(denied.body, /dashboard session/)

  assert.equal((await r.request('/health', '', '', 'GET', port)).body, 'ok')

  // The dashboard runs on its own server and must still be the one on its port.
  assert.equal((await r.request('/health', '', '', 'GET')).body, 'ok')
  assert.equal((await r.request('/api/settings', '', '', 'GET')).status, 303)
})

test('analytics can be switched off entirely', () => {
  const r = runtime(dataEnv({ ANALYTICS_ENABLED: 'false' }))
  assert.equal(r.run('startAnalyticsServer()'), null)
})

test('/analytics points at the page and at the JSON behind it', () => {
  const r = runtime(dataEnv())
  r.run("handleCommand('/analytics', { selectedId: 'A' })")
  const logs = channelLogs(r, 'A')
  assert.match(logs, /http:\/\/localhost:8080\//)
  assert.match(logs, /\/api\/analytics/)
  assert.match(logs, /\/api\/export/)
})

test('/env lists the registry and marks the keys a restart is needed for', () => {
  const r = runtime(dataEnv())
  r.run("handleCommand('/env list coinflip', { selectedId: 'A' })")
  const logs = channelLogs(r, 'A')
  assert.match(logs, /Coinflip/)
  assert.match(logs, /COINFLIP_WAGER_MIN = 10000/)
  assert.match(logs, /COINFLIP_STOP_LOSS = 10000000/)
  assert.match(logs, /temporary override\(s\)/)
})

test('/env set applies immediately and /env reset removes it', () => {
  const r = runtime(dataEnv())
  r.run("handleCommand('/env set COINFLIP_WAGER_MIN 5000', { selectedId: 'A' })")
  assert.equal(r.run("settings.get('COINFLIP_WAGER_MIN')"), 5000)
  assert.match(channelLogs(r, 'A'), /temporary — not saved/)

  r.run("handleCommand('/env get COINFLIP_WAGER_MIN', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A'), /COINFLIP_WAGER_MIN: 5000/)
  assert.match(channelLogs(r, 'A'), /\(override\)/)

  r.run("handleCommand('/env reset COINFLIP_WAGER_MIN', { selectedId: 'A' })")
  assert.equal(r.run("settings.get('COINFLIP_WAGER_MIN')"), 10000)
})

test('a value that cannot be parsed is refused by /env instead of silently reverting', () => {
  const r = runtime(dataEnv())
  r.run("handleCommand('/env set COINFLIP_STOP_LOSS lots', { selectedId: 'A' })")
  assert.equal(r.run("settings.get('COINFLIP_STOP_LOSS')"), 10000000)
  assert.match(channelLogs(r, 'A'), /not a valid int/)
})

test('a startup-only key says so rather than pretending the change took effect', () => {
  const r = runtime(dataEnv())
  r.run("handleCommand('/env set BOT_NAMES A,B,C,D', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A'), /read once at startup/)
})

test('/env reset-all clears every temporary override', () => {
  const r = runtime(dataEnv())
  // Overrides live in the settings module, not in this runtime, so start clean.
  r.run('settings.resetAll()')
  r.run("handleCommand('/env set COINFLIP_WAGER_MIN 5000', { selectedId: 'A' })")
  r.run("handleCommand('/env set COINFLIP_WAGER_MAX 6000', { selectedId: 'A' })")
  assert.equal(r.run('settings.overrideCount()'), 2)
  r.run("handleCommand('/env reset-all', { selectedId: 'A' })")
  assert.equal(r.run('settings.overrideCount()'), 0)
  assert.match(channelLogs(r, 'A'), /Cleared 2 temporary override/)
})

test('the dashboard .ENV tab reads and writes the same registry, and rejects bad input', async () => {
  const r = runtime(dataEnv())
  r.run('settings.resetAll()')
  const cookie = await r.login()
  const list = await r.request('/api/settings', '', cookie, 'GET')
  assert.equal(list.status, 200)
  const groups = JSON.parse(list.body).groups
  assert.ok(groups.some(group => group.group === 'Coinflip' && group.rows.some(row => row.key === 'COINFLIP_STOP_LOSS')))

  const set = await r.request('/api/settings', JSON.stringify({ key: 'COINFLIP_STOP_LOSS', value: '250000' }), cookie, 'POST')
  assert.equal(set.status, 200)
  assert.equal(JSON.parse(set.body).ok, true)
  assert.equal(r.run("settings.get('COINFLIP_STOP_LOSS')"), 250000)

  const bad = await r.request('/api/settings', JSON.stringify({ key: 'COINFLIP_STOP_LOSS', value: 'lots' }), cookie, 'POST')
  assert.equal(bad.status, 400)
  assert.match(JSON.parse(bad.body).error, /not a valid int/)

  const reset = await r.request('/api/settings/reset', JSON.stringify({ all: true }), cookie, 'POST')
  assert.equal(JSON.parse(reset.body).cleared, 1)
  assert.equal(r.run("settings.get('COINFLIP_STOP_LOSS')"), 10000000)
})

test('the settings API needs the session, like every other dashboard route', async () => {
  const r = runtime(dataEnv())
  const res = await r.request('/api/settings', '', '', 'GET')
  assert.equal(res.status, 303)
})

test('a secret is listed as set, never echoed back to the dashboard', async () => {
  const r = runtime(dataEnv())
  const cookie = await r.login()
  const res = await r.request('/api/settings', JSON.stringify({ key: 'WEB_PASSWORD', value: 'a-new-secret' }), cookie, 'POST')
  assert.equal(JSON.parse(res.body).secret, true)
  assert.equal(JSON.parse(res.body).value, null)
  const list = JSON.parse((await r.request('/api/settings', '', cookie, 'GET')).body)
  const row = list.groups.flatMap(group => group.rows).find(entry => entry.key === 'WEB_PASSWORD')
  assert.equal(row.value, null)
  assert.equal(row.secret, true)
  assert.equal(r.run("settings.list().find(r => r.key === 'WEB_PASSWORD').value"), null)
  await r.request('/api/settings/reset', JSON.stringify({ all: true }), cookie, 'POST')
})

// ── The deep dissection: /bot-coinflip deep, the report and the page ─────────────

// Seeding goes through the real store, with COINFLIP_FILE pointed at a temp
// file by dataEnv(), so nothing lands in the repo's data folder.
function seedHistory (r, rows) {
  r.run(`coinflipStore.appendAll(${JSON.stringify(rows)})`)
}

function seededFlip (i, over = {}) {
  const won = i % 3 !== 0
  return {
    id: `seed-${i}`,
    sessionId: `seed-session-${Math.floor(i / 10)}`,
    bot: 'A',
    index: (i % 10) + 1,
    ts: 1770000000000 + i * 60000,
    wager: 10000,
    opponent: 'Rival',
    result: won ? 'won' : 'lost',
    balanceBefore: 1000000,
    balanceAfter: null,
    delta: won ? 10000 : -10000,
    method: 'message',
    mismatched: false,
    serverHour: 14,
    serverClock: '2:00 P.M.',
    ...over
  }
}

test('/bot-coinflip deep dissects the stored flips and names every dissection', () => {
  const r = runtime(dataEnv({ COINFLIP_DEEP_MIN_BUCKET: '3' }))
  r.run("handleCommand('/bot-coinflip deep', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A', 'system'), /No coinflip history for the fleet/)

  seedHistory(r, Array.from({ length: 60 }, (_, i) => seededFlip(i)))
  r.run("handleCommand('/bot-coinflip deep A', { selectedId: 'A' })")
  const text = channelLogs(r, 'A', 'B', 'system')
  assert.match(text, /Coinflip dissection \(A\)/)
  assert.match(text, /Does the previous flip predict the next one\?/)
  assert.match(text, /Runs and what follows them/)
  assert.match(text, /Wager as a share of the balance/)
  assert.match(text, /Time of day/)
  assert.match(text, /Pace and idling/)
  assert.match(text, /The money curve/)
  assert.match(text, /What the numbers say/)
  assert.match(text, /statistical test\(s\) corrected together at q=0\.05/)
  // The hour comes off the record's own server stamp, not our clock.
  assert.match(text, /hours read from the server clock/)

  const report = plain(r.run('coinflipDeepReport()'))
  assert.equal(report.resolved, 60)
  assert.ok(report.sections.length >= 13, `${report.sections.length} dissections`)
  assert.ok(report.tests > 10, `${report.tests} tests in the family`)
  assert.equal(report.hourSource, 'server')
  assert.ok(report.takeaways.length >= 4)
  // Same history, same report — the cache is not allowed to change the numbers.
  assert.equal(r.run('coinflipDeepReport() === coinflipDeepReport()'), true)
  assert.equal(r.run('persistCoinflipDeepReport().resolved'), 60)
})

test('/bot-coinflip deep can be scoped to one bot and an empty scope says so', () => {
  const r = runtime(dataEnv({ COINFLIP_DEEP_MIN_BUCKET: '2' }))
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => seededFlip(i)),
    ...Array.from({ length: 30 }, (_, i) => seededFlip(i, { bot: 'B', id: `seed-b-${i}` }))
  ]
  seedHistory(r, rows)
  assert.equal(r.run('coinflipDeepReport().resolved'), 60)
  assert.equal(r.run('coinflipDeepReport({ bot: "B" }).resolved'), 30)
  assert.equal(r.run('coinflipDeepReport({ bot: "B" }).bot'), 'B')

  r.run("handleCommand('/bot-coinflip deep B', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A', 'B', 'system'), /Coinflip dissection \(B\)/)
  r.run("handleCommand('/bot-coinflip deep Ghost', { selectedId: 'A' })")
  assert.match(channelLogs(r, 'A', 'B', 'system'), /No coinflip history for Ghost/)
})

test('the analytics report and page carry the dissection', () => {
  const r = runtime(dataEnv({ COINFLIP_DEEP_MIN_BUCKET: '3' }))
  seedHistory(r, Array.from({ length: 45 }, (_, i) => seededFlip(i)))

  const report = plain(r.run('buildAnalyticsReport({ recent: 0 })'))
  assert.equal(report.deep.resolved, 45)
  assert.ok(report.deep.sections.length >= 13)
  assert.equal(report.headline.coinflips, 45)
  assert.ok(report.config.coinflipDeepFile.endsWith('coinflip-deep.json'))

  const html = r.run("analytics.renderHtml(buildAnalyticsReport())")
  assert.match(html, /Deep dissection/)
  assert.match(html, /What the numbers say/)
  assert.match(html, /\/api\/coinflip\/deep/)
  assert.match(html, /statistical tests/)
  // Every dissection gets a table, every table and row is closed, and no
  // template placeholder survived the render.
  const tables = html.split('<table>').length - 1
  assert.equal(html.split('</table>').length - 1, tables, 'every table is closed')
  assert.ok(tables >= 13, `${tables} dissection tables`)
  assert.equal(html.split('<tr').length, html.split('</tr>').length, 'every row is closed')
  assert.equal(/undefined|NaN/.test(html), false, 'no placeholder leaked into the page')
})

test('the create waits out the configured cooldown after the balance answer', async () => {
  const r = runtime(dataEnv())
  r.run(payingBot('A', 50000))
  // Nothing is reset between runtimes, so clear any override another test left.
  r.run("settings.reset('COINFLIP_CREATE_COOLDOWN_MS')")
  const before = r.run("settings.get('COINFLIP_CREATE_COOLDOWN_MS')")
  try {
    r.run("handleCommand('/env set COINFLIP_CREATE_COOLDOWN_MS 400', { selectedId: 'A' })")
    assert.equal(r.run("settings.get('COINFLIP_CREATE_COOLDOWN_MS')"), 400)

    r.run("handleCommand('/bot-coinflip run 1000 1 A', { selectedId: 'A' })")
    await flushMicrotasks()
    // The balance was asked for and the run is parked on the cooldown: this is
    // the gap that stops the server answering "you are on cooldown".
    const parked = [...r.timers.values()].filter(timer => timer.delay === 400)
    assert.equal(parked.length, 1, 'one 400ms wait, between /bal and the create')
    assert.deepEqual(coinflipChats(r), [])

    parked[0].fn()
    await flushMicrotasks()
    assert.deepEqual(coinflipChats(r), [['A', '/coinflip create 1000']])

    // Let the flip finish so the run does not outlive the test.
    for (const line of ['Result: Won', 'Amount Bet: $1,000', 'Winner: A', 'Loser: Rival']) {
      r.run(`coinflipObserverFor('A').feed(${JSON.stringify(line)})`)
    }
    await flushMicrotasks()
    assert.equal(r.run('coinflipSessions.has("A")'), false)
  } finally {
    r.run("settings.reset('COINFLIP_CREATE_COOLDOWN_MS')")
  }
  assert.equal(r.run("settings.get('COINFLIP_CREATE_COOLDOWN_MS')"), before, 'the override is gone')
})

test('the new coinflip knobs are registered, live, and described for the .ENV tab', () => {
  const r = runtime(dataEnv())
  const keys = plain(r.run('settings.registered()'))
  for (const key of [
    'COINFLIP_CREATE_COOLDOWN_MS',
    'COINFLIP_COOLDOWN_MAX_RETRIES',
    'COINFLIP_DEEP_MIN_BUCKET',
    'COINFLIP_DEEP_Q',
    'COINFLIP_TZ_OFFSET_MIN'
  ]) {
    assert.ok(keys.includes(key), `${key} is registered`)
    const row = plain(r.run(`settings.list().find(entry => entry.key === '${key}')`))
    assert.equal(row.group, 'Coinflip')
    assert.equal(row.live, true, `${key} is read where it is used`)
    assert.ok(row.desc.length > 10, `${key} explains itself in the tab`)
  }
  // A value outside the allowed range is refused rather than silently clamped.
  assert.equal(r.run("settings.set('COINFLIP_DEEP_Q', '5').ok"), false)
  assert.equal(r.run("settings.set('COINFLIP_CREATE_COOLDOWN_MS', '2s').value"), 2000)
  r.run("settings.reset('COINFLIP_CREATE_COOLDOWN_MS')")
})
