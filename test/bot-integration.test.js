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
  let requestHandler
  const wss = new EventEmitter()
  const server = new EventEmitter()
  server.listen = (_port, _bind, cb) => cb()
  const fakeWs = { OPEN: 1, Server: function () { return wss } }
  wss.handleUpgrade = (_req, socket, _head, cb) => cb(socket)
  const setTimer = (fn, delay) => { const t = { fn, delay, unref() {} }; timers.set(t, t); return t }
  const clearTimer = t => timers.delete(t)
  const processMock = {
    env: { BOT_NAMES: 'A,B,C', WEB_GUI: 'true', TUI_GUI: 'false', WEB_PASSWORD: 'test-only', WEB_TERMINAL_LOG: 'false', ...env },
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
      if (name === 'fs') return { readFileSync: () => '', writeFileSync() {} }
      if (name === 'http') return { createServer(fn) { requestHandler = fn; return server } }
      if (name === 'ws') return fakeWs
      if (name === './bot-controls') return { ...controls, createSlowBroadcast: () => controls.createSlowBroadcast({ setTimer, clearTimer }) }
      if (name === './expose-terminal') return { sshConfig: () => ({ enabled: false }) }
      if (name === './monitoring') return { createMonitoring: () => ({ getMemorySnapshot: () => null, onDisconnect() {}, onKick() {}, onProxyStall() {}, onReconnectExhausted() {}, onFatal() {}, onSecurityLockout() {}, inspectServerMessage() {}, onRecovered() {} }) }
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
  async function request(url, body = '', cookie = '', method = 'POST') {
    const req = new EventEmitter()
    Object.assign(req, { url, method, headers: { cookie }, socket: { remoteAddress: '127.0.0.1' } })
    const response = { status: 0, headers: {}, body: '', writeHead(s, h = {}) { this.status = s; this.headers = h }, end(b = '') { this.body = b } }
    const done = requestHandler(req, response)
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
  return { context, run, timers, initialOrder, request, login, socket }
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
    const h = await r.run('webHandle.webClientReady')
    assert.equal(h.started, true)
    const dash = await r.request('/', '', cookie, 'GET')
    assert.match(dash.body.toString(), /id="playbtn"/)
    h.server.close()
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
  const h = await r.run('webHandle.webClientReady')
  assert.equal(h.started, false)
})

test('/play and the PLAY button are disabled when MC_WEB_ENABLED=false', async () => {
  const r = runtime({ MC_WEB_ENABLED: 'false' })
  const cookie = await r.login()
  const res = await r.request('/play', '', cookie, 'GET')
  assert.equal(res.status, 404)
  const dash = await r.request('/', '', cookie, 'GET')
  assert.doesNotMatch(dash.body.toString(), /id="playbtn"/)
})
