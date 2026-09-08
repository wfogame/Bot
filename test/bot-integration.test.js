'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
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
