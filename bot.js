require('dotenv').config() // npm install dotenv ws — neo-blessed only if TUI_GUI, socks only for PROXY_HOST
const { readDelayMs, shuffledCopy, createSlowBroadcast, parseProxyGroups, resolveBotProxy } = require('./bot-controls')
const os = require('os')
const { createMonitoring } = require('./monitoring')
const net = require('net')
const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const zlib = require('zlib')
const { exec } = require('child_process')
const { createTerminal, sshConfig } = require('./expose-terminal')
const mineflayer = require('mineflayer')
const armorManager = require('mineflayer-armor-manager')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
let SocksClient
try { ({ SocksClient } = require('socks')) } catch (_) { /* only needed if PROXY_HOST is set and PROXY_TYPE=socks5 — npm install socks */ }

// ── .env config (original) ──────────────────────────────────────────────────
const HOST = process.env.HOST || 'play.fatalmc.org'
const PORT = parseInt(process.env.PORT || '25565', 10)
const VERSION = process.env.VERSION || '1.21.2'
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || '123456'
const BOT_NAMES = (process.env.BOT_NAMES || '').split(',').map(n => n.trim()).filter(Boolean)
const CONNECT_DELAY_MS = parseInt(process.env.CONNECT_DELAY_MS || '39500', 10)
const CONNECT_DELAY_RANDOM_MS = parseInt(process.env.CONNECT_DELAY_RANDOM_MS || '0', 10)
const ALL_SLOW_DELAY_MS = readDelayMs(process.env.ALL_SLOW_DELAY_MS, 15000)
const RANDOMIZE_BOT_ORDER = !/^(0|false|no|off)$/i.test((process.env.RANDOMIZE_BOT_ORDER || '').trim())
const MAX_RECONNECT = parseInt(process.env.MAX_RECONNECT || '17', 10)
const GUI_SLOT = parseInt(process.env.GUI_SLOT || '11', 10)
const WARP_AFK = process.env.WARP_COMMAND || '/warp afk'
const WARP_BEFORE_CRATE = (process.env.WARP_BEFORE_CRATE ?? process.env.WARPORNOT ?? 'true').toLowerCase() !== 'false'
const SERVER_COMMAND = (process.env.SERVER_COMMAND ?? '').trim()
const CLICK_COMPASS_ENABLED = /^(1|true|yes|on)$/i.test(process.env.CLICK_COMPASS || '')

// ── Interface config: TUI_GUI + WEB_GUI ──────────────────────────────────────
// WEB_GUI=true serves the web dashboard; TUI_GUI=true runs the blessed terminal UI.
// Both can run at the same time (same bots, same logs — pick your screen).
// TUI_GUI defaults to "on when attached to a terminal" so Docker/pm2 runs get web-only.
const WEB_GUI = /^(1|true|yes|on)$/i.test(process.env.WEB_GUI ?? 'true')
const TUI_GUI = process.env.TUI_GUI === undefined
? Boolean(process.stdout.isTTY)
: /^(1|true|yes|on)$/i.test(process.env.TUI_GUI)
const WEB_PORT = parseInt(process.env.WEB_PORT || '80', 10) // if taken (or EACCES), 81, 82, … are tried
const WEB_BIND = process.env.WEB_BIND || '0.0.0.0'
const WEB_PORT_MAX_ATTEMPTS = parseInt(process.env.WEB_PORT_MAX_ATTEMPTS || '20', 10)
const WEB_PASSWORD = process.env.WEB_PASSWORD || null // null → random password generated + printed at startup
const WEB_SESSION_HOURS = parseFloat(process.env.WEB_SESSION_HOURS || '12')
const WEB_LOGIN_MAX_FAILS = parseInt(process.env.WEB_LOGIN_MAX_FAILS || '10', 10)
const WEB_TERMINAL_LOG = /^(1|true|yes|on)$/i.test(process.env.WEB_TERMINAL_LOG ?? 'true')
const WEB_TERMINAL_ENABLED = /^(1|true|yes|on)$/i.test(process.env.WEB_TERMINAL_ENABLED || 'false')
const SSH_CONFIG = sshConfig()
const SSH_ENABLED = SSH_CONFIG.enabled
const WS_BROADCAST_INTERVAL_MS = parseInt(process.env.WS_BROADCAST_INTERVAL_MS || '100', 10)
const LOG_MAX_LINES = parseInt(process.env.LOG_MAX_LINES || '5000', 10)
const WINDOW_DEBUG = /^(1|true|yes|on)$/i.test(process.env.WINDOW_DEBUG || '') // true restores full window slot dumps
const CONFIG_PACKET_LOG_LIMIT = parseInt(process.env.CONFIG_PACKET_LOG_LIMIT || '120', 10) // 0 = unlimited config packet logging

// ── GUI slot selection: fixed slot (default) vs. search-by-item (opt-in) ────
// GUI_ITEM_SEARCH_TERMS syntax: ";" separates AND-groups, "|" separates OR-alternatives
// within a group — an item matches when EVERY group has at least one alternative present
// (case-insensitive substring match against its name/displayName).
// e.g. "fatal|red;crate|key|candle" → (contains "fatal" OR "red") AND (contains "crate" OR "key" OR "candle")
const GUI_ITEM_SEARCH_ENABLED = /^(1|true|yes|on)$/i.test(process.env.GUI_ITEM_SEARCH_ENABLED || 'false')
const GUI_ITEM_SEARCH_TERMS = process.env.GUI_ITEM_SEARCH_TERMS || 'fatal|red;crate|key|candle'
const GUI_ITEM_SEARCH_GROUPS = GUI_ITEM_SEARCH_TERMS
.split(';').map(g => g.trim()).filter(Boolean)
.map(g => g.split('|').map(s => s.trim().toLowerCase()).filter(Boolean))
.filter(g => g.length)

function itemMatchesSearchGroups(itemStr) {
if (!GUI_ITEM_SEARCH_GROUPS.length) return false
return GUI_ITEM_SEARCH_GROUPS.every(group => group.some(term => itemStr.includes(term)))
}

// ── /crates command config ─────────────────────────────────────────────────
const WARP_CRATES = process.env.CRATE_COMMAND || '/warp crates'
const CRATE_SHULKER_BLOCK = process.env.CRATE_SHULKER_BLOCK || 'red_shulker_box'
const CRATE_SCAN_RADIUS = parseInt(process.env.CRATE_SCAN_RADIUS || '20', 10)
const CRATE_REACH = parseFloat(process.env.CRATE_REACH || '3.5')

// ── Crate color customization ──────────────────────────────────────────────
const SHULKER_COLORS = [
'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink',
'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'
]

function resolveCrateBlockName(input) {
if (!input) return CRATE_SHULKER_BLOCK
const norm = input.trim().toLowerCase().replace(/[\s-]+/g, '_')
if (norm === 'shulker' || norm === 'shulker_box') return CRATE_SHULKER_BLOCK
if (norm.endsWith('_shulker_box') && SHULKER_COLORS.includes(norm.replace('_shulker_box', ''))) return norm
if (SHULKER_COLORS.includes(norm)) return `${norm}_shulker_box`
return null
}

// ── /crates-all: shardshop → crates → dump chain across multiple bots ───────
const SHARDSHOP_COMMAND = process.env.SHARDSHOP_COMMAND || '/shardshop' // ⚠ verify this matches your server's actual shardshop command

// ── /overview rank detection ─────────────────────────────────────────────
// /fix is the ONLY rank probe (no /rank): an access-denied reply ("You do not
// have access to the command", "no permission") proves the bot is a Member; a
// "you are on cool down" reply (case-insensitive) means the probe was
// rate-limited so the rank shows N/A; any other reply — including generic
// errors like "Error: This item cannot be repaired" — means the bot passed the
// /fix rank gate, so the rank is Regent. RANK_COOLDOWN_MS (default 4.5s = 3×
// the server's /fix cooldown) is waited BEFORE /fix fires, because the balance
// queries preceding it send several commands back-to-back and would otherwise
// trip the server cooldown.
const RANK_FIX_COMMAND = process.env.RANK_FIX_COMMAND || '/fix'
const RANK_COOLDOWN_MS = (() => { const n = parseInt(process.env.RANK_COOLDOWN_MS, 10); return Number.isFinite(n) && n >= 0 ? n : 4500 })()
const RANK_REPLY_TIMEOUT_MS = 2500
const RANK_MEMBER_PATTERNS = [
  /you do not have access(?: to the command)?/i,
  /\bno permission\b/i
]
const RANK_COOLDOWN_PATTERN = /you are on cool ?down/i
const CRATES_ALL_STAGGER_MS = parseInt(process.env.CRATES_ALL_STAGGER_MS || '30000', 10)
const CRATES_ALL_SHARDSHOP_WAIT_MS = parseInt(process.env.CRATES_ALL_SHARDSHOP_WAIT_MS || '4000', 10)
const CRATES_ALL_STEP_WAIT_MS = parseInt(process.env.CRATES_ALL_STEP_WAIT_MS || '3000', 10)

// ── /shardshop-loop: keep running /shardshop until the server says there's nothing left ──
const SHARDSHOP_STOP_PHRASES = (process.env.SHARDSHOP_STOP_PHRASES || 'insufficent fund,not enough,insufficient fund,no more shards,more shards')
.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
const SHARDSHOP_LOOP_DELAY_MS = parseInt(process.env.SHARDSHOP_LOOP_DELAY_MS || '4200', 10)
const SHARDSHOP_LOOP_TIMEOUT_MS = parseInt(process.env.SHARDSHOP_LOOP_TIMEOUT_MS || '60000', 10)
const SHARDSHOP_LOOP_MAX_RUNS = parseInt(process.env.SHARDSHOP_LOOP_MAX_RUNS || '200', 10)

// ── Crate click loop (real tail) ────────────────────────────────────────────
const CRATE_STOP_PHRASES = ['you do not have a', 'error']
const CRATE_CLICK_DELAY_MS = parseInt(process.env.CRATE_CLICK_DELAY_MS || '900', 10)
const CRATE_CLICK_TIMEOUT_MS = parseInt(process.env.CRATE_CLICK_TIMEOUT_MS || '60000', 10)

// ── Outbound proxy config (original) ────────────────────────────────────────
const PROXY_HOST = process.env.PROXY_HOST || ''
const PROXY_ENABLED = Boolean(PROXY_HOST)
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '1080', 10)
const PROXY_TYPE = (process.env.PROXY_TYPE || 'socks5').toLowerCase()
const PROXY_DEFAULT = PROXY_ENABLED ? { host: PROXY_HOST, port: PROXY_PORT, type: PROXY_TYPE } : null
// Dedicated per-bot proxy groups: PROXY_GROUP_<N>_BOTS/_HOST/_PORT/_TYPE (see .env.example).
// Bots not listed in any group fall back to PROXY_DEFAULT (global proxy, or direct if unset).
const PROXY_GROUPS = parseProxyGroups()
const PROXY_GROUPS_ENABLED = PROXY_GROUPS.length > 0

// ── Proxy stall watchdog ────────────────────────────────────────────────────
const PROXY_STALL_ENABLED = PROXY_ENABLED && process.env.PROXY_STALL_WATCHDOG !== '0'
const PROXY_STALL_TIMEOUT_MS = parseInt(process.env.PROXY_STALL_TIMEOUT_MS || '90000', 10)
const PROXY_STALL_CHECK_MS = parseInt(process.env.PROXY_STALL_CHECK_MS || '20000', 10)
const PROXY_STALL_RATIO = parseFloat(process.env.PROXY_STALL_RATIO || '0.5')
const PROXY_IS_LOCAL = /^(127\.0\.0\.1|localhost|::1)$/i.test(PROXY_HOST)
const PROXY_RESTART_CMD = process.env.PROXY_RESTART_CMD || (PROXY_IS_LOCAL ? 'brew services restart tor' : '')
const PROXY_RESTART_COOLDOWN_MS = parseInt(process.env.PROXY_RESTART_COOLDOWN_MS || '120000', 10)
let lastProxyRestart = 0

// ── Velocity / BungeeCord proxy crash detection ───────────────────────────────
const PROXY_CRASH_PATTERNS = [
/PartialReadError/i,
/deserialization/i,
/decompress/i, /zlib/i,
/unexpected end/i,
/Invalid VarInt/i,
/socket hang up/i,
/ECONNRESET/i,
/read ECONNRESET/i,
/This socket has been ended/i,
/write after end/i,
/Invalid packet/i,
/Missing (packet|field)/i,
/buffer length/i,
/not enough (data|bytes)/i,
/Cannot read propert/i,
/pre-spawn socketClosed/i,
/Parse error/i,
/Invalid tag/i
]
const FAST_RECONNECT_MS = 10400
const RECONNECT_BASE_MS = 10400
const RECONNECT_MAX_MS = 5 * 60_000

if (BOT_NAMES.length === 0) {
process.stderr.write('No BOT_NAMES defined in .env — nothing to connect.\n')
process.exit(1)
}

// ── Outbound proxy tunnelling (original, unchanged) ──────────────────────────
function makeSocksConnect(targetHost, targetPort, onLog, proxy) {
return (client) => {
if (!SocksClient) {
client.emit('error', new Error('PROXY_TYPE=socks5 requires the "socks" package — run: npm install socks'))
client.emit('end', 'Missing socks package')
return
}
onLog?.(`Tunnelling through SOCKS5 proxy ${proxy.host}:${proxy.port}…`)
SocksClient.createConnection({
proxy: { host: proxy.host, port: proxy.port, type: 5 },
command: 'connect',
destination: { host: targetHost, port: targetPort }
}).then(({ socket }) => {
client.setSocket(socket)
client.emit('connect')
}).catch(err => {
const errMsg = `SOCKS5 proxy connection failed: ${err.message}`
client.emit('error', new Error(errMsg))
client.emit('end', errMsg)
})
}
}

function makeHttpConnect(targetHost, targetPort, onLog, proxy) {
return (client) => {
onLog?.(`Tunnelling through HTTP proxy ${proxy.host}:${proxy.port}…`)
const socket = net.connect(proxy.port, proxy.host, () => {
socket.write(
`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
`Host: ${targetHost}:${targetPort}\r\n` +
`Connection: keep-alive\r\n\r\n`
)
})

let buffer = ''
const onData = (chunk) => {
buffer += chunk.toString('latin1')
const headerEnd = buffer.indexOf('\r\n\r\n')
if (headerEnd === -1) return
socket.removeListener('data', onData)

const statusLine = buffer.slice(0, buffer.indexOf('\r\n'))
const match = statusLine.match(/^HTTP\/\d\.\d (\d{3})/)
const statusCode = match ? parseInt(match[1], 10) : null

if (statusCode !== 200) {
socket.destroy()
const errMsg = `HTTP proxy CONNECT failed: ${statusLine || 'no response from proxy'}`
client.emit('error', new Error(errMsg))
client.emit('end', errMsg)
return
}

const leftover = buffer.slice(headerEnd + 4)
if (leftover.length) socket.unshift(Buffer.from(leftover, 'latin1'))

client.setSocket(socket)
client.emit('connect')
}

socket.on('data', onData)
socket.on('error', (err) => {
const errMsg = `HTTP proxy connection failed: ${err.message}`
client.emit('error', new Error(errMsg))
client.emit('end', errMsg)
})
}
}

function makeProxyConnect(targetHost, targetPort, onLog, username) {
const proxy = resolveBotProxy(username, PROXY_GROUPS, PROXY_DEFAULT)
if (!proxy) return undefined
return proxy.type === 'http'
? makeHttpConnect(targetHost, targetPort, onLog, proxy)
: makeSocksConnect(targetHost, targetPort, onLog, proxy)
}

// ── Sanitizers ───────────────────────────────────────────────────────────────
// sanitize() produces the canonical stored form (length-capped, tags intact, no escaping).
// Each renderer escapes for itself: escBlessed() for the TUI, escHtml() for the browser.
const KNOWN_TAG_RE = /\{(\/?(bold|underline|blink|inverse|red|green|blue|cyan|magenta|yellow|white|gray|grey|black|center|left|right)(-fg|-bg)?)\}/g
const MAX_SANITIZED_LENGTH = 4000 // hard cap — some servers send oversized/malformed chat as a client-crashing trick
function sanitize(str) {
if (typeof str !== 'string') str = String(str ?? '')
if (str.length > MAX_SANITIZED_LENGTH) {
str = str.slice(0, MAX_SANITIZED_LENGTH) + ` …[truncated, ${str.length - MAX_SANITIZED_LENGTH} more chars]`
}
return str
}
function escBlessed(str) {
const tags = []
const safe = str.replace(KNOWN_TAG_RE, m => { tags.push(m); return `\x00T${tags.length - 1}\x00` })
return safe.replace(/[{}]/g, c => '\\' + c).replace(/\x00T(\d+)\x00/g, (_, i) => tags[+i])
}
const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function escHtml(str) {
const tags = []
const safe = str.replace(KNOWN_TAG_RE, m => { tags.push(m); return `\x00T${tags.length - 1}\x00` })
return safe.replace(/[&<>"']/g, c => HTML_ESCAPE_MAP[c]).replace(/\x00T(\d+)\x00/g, (_, i) => tags[+i])
}
function stripTags(str) { return str.replace(/\{\/?[a-z]+(?:-fg|-bg)?\}/gi, '') }
function timestamp() { return `{gray-fg}${new Date().toLocaleTimeString()}{/gray-fg}` }
function formatUptime(ms) {
if (!ms || ms <= 0) return '0s'
const s = Math.floor(ms / 1000)
const parts = []
if (s >= 3600) parts.push(`${Math.floor(s / 3600)}h`)
if (s % 3600 >= 60) parts.push(`${Math.floor((s % 3600) / 60)}m`)
parts.push(`${s % 60}s`)
return parts.join(' ')
}

// ── Multi-bot state + UI-agnostic log bus ────────────────────────────────────
// logFor() stores the line once; every active interface (TUI, web, plain console)
// subscribes and renders it in its own format. No interface owns the log pipeline.
const SYSTEM_ID = '__system__'
const systemLogs = [] // mirrors a bots[id].logs array, for messages with no associated bot
const bots = {} // username → { bot, spawnTime, logs[], host, port, version, reconnectAttempts, … }
let activeId = null
function currentActiveId() { return activeId } // read the global from inside handleCommand's shadowed scope
let tui = null // set by startTUI()
let webHandle = null // set by startWebGUI()
let markBotsDirtyFn = null
let webClearFn = null
const slowBroadcast = createSlowBroadcast()

// ── Manual interact mode (prismarine-viewer 3D + hand-driven controls) ───────
// /manual-interact turns one bot into a slow, hand-driven avatar: browser 3D
// view, hold-to-move pad, raw window/slot control — while suppressing this
// file's automatic windowOpen click-slot + AFK-warp logic for that bot.
const createManualControls = require('./bot-manual')
function loadViewerFactory() {
try {
const pv = require('prismarine-viewer')
return typeof pv.mineflayer === 'function' ? pv.mineflayer : (typeof pv === 'function' ? pv : null)
} catch (_) { return null }
}
const manual = createManualControls({ bots, logFor, sanitize, notifyBotsChanged, SYSTEM_ID, WEB_BIND, loadViewerFactory })

const logSubscribers = new Set()
function subscribeLog(fn) { logSubscribers.add(fn); return () => logSubscribers.delete(fn) }

function logFor(id, msg) {
if (id !== SYSTEM_ID && !bots[id]) return
const line = `${timestamp()} ${msg}`
const store = id === SYSTEM_ID ? systemLogs : bots[id].logs
store.push({ text: line, time: Date.now() })
if (store.length > LOG_MAX_LINES) store.splice(0, store.length - LOG_MAX_LINES)
if (logSubscribers.size) {
for (const fn of logSubscribers) { try { fn(id, line) } catch (_) {} }
}
}
function log(msg) { logFor(activeId || SYSTEM_ID, msg) }
function logSuccess(msg) { log(`{green-fg}✓ ${msg}{/green-fg}`) }
function logError(msg) { log(`{red-fg}✗ ${msg}{/red-fg}`) }
function logInfo(msg) { log(`{cyan-fg}› ${msg}{/cyan-fg}`) }

// Centralized Discord alerts and host memory/swap monitoring.
let monitoring
function logWarn(msg) { log(`{yellow-fg}⚠ ${msg}{/yellow-fg}`) }

// 20-minute log pruning (original behavior), timers unref'd so they never hold the process open
const pruneTimer = setInterval(() => {
const cutoff = Date.now() - (20 * 60 * 1000)
Object.values(bots).forEach(botState => { botState.logs = botState.logs.filter(l => l.time > cutoff) })
systemLogs.splice(0, systemLogs.length, ...systemLogs.filter(l => l.time > cutoff))
}, 60000)
if (pruneTimer.unref) pruneTimer.unref()

// Runtime stats probes (event-loop lag + log throughput)
let evlLagMs = 0, logRateTick = 0, logRateWindow = 0
const probeTimer = setInterval(() => {
const t = Date.now()
setImmediate(() => { evlLagMs = Date.now() - t })
logRateWindow = logRateTick; logRateTick = 0
}, 2000)
if (probeTimer.unref) probeTimer.unref()
function globalStats() {
const m = process.memoryUsage()
return {
rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576),
uptimeSec: Math.floor(process.uptime()), clients: webHandle ? webHandle.clients.size : 0,
evlLagMs, logPerSec: Math.round(logRateWindow / 2),
bots: Object.keys(bots).length, online: Object.values(bots).filter(b => b.bot && b.bot.entity).length,
memory: monitoring ? monitoring.getMemorySnapshot() : null
}
}

monitoring = createMonitoring({
  logFor, systemId: SYSTEM_ID, sanitize,
  getStats: () => globalStats(),
  getBotCount: () => Object.keys(bots).length
})

function botSnapshot() {
return Object.entries(bots).map(([id, e]) => {
const b = e.bot
const ping = b && b.player ? b.player.ping : null
const histArr = e.pingHist || (e.pingHist = [])
if (typeof ping === 'number') { histArr.push(Math.max(0, ping)); if (histArr.length > 60) histArr.shift() }
return {
id, online: !!(b && b.entity),
ping: typeof ping === 'number' ? Math.max(0, ping) : null,
health: b ? (b.health ?? null) : null, food: b ? (b.food ?? null) : null,
uptimeSec: e.spawnTime ? Math.floor((Date.now() - e.spawnTime) / 1000) : null,
attempts: e.reconnectAttempts || 0,
kick: e.lastKickReason ? escHtml(sanitize(e.lastKickReason).slice(0, 140)) : null,
pingHist: histArr,
manual: manual.snapshotFor(e)
}
})
}
function notifyBotsChanged() {
if (tui) { try { tui.updateHeader() } catch (_) {} }
if (markBotsDirtyFn) markBotsDirtyFn()
}
function switchTo(id) {
if (!bots[id]) { logFor(activeId || SYSTEM_ID, `{red-fg}✗ No bot named "${sanitize(id)}"{/red-fg}`); return }
activeId = id
if (tui) tui.show(id)
notifyBotsChanged()
}
function clearReconnectTimer(id) {
const entry = bots[id]
if (entry?.reconnectTimer) {
clearTimeout(entry.reconnectTimer)
entry.reconnectTimer = null
}
}

// ── Command history (persisted across restarts, shared by TUI + web) ──────────
const HISTORY_FILE = path.join(__dirname, '.command_history')
const MAX_HISTORY = 500
const commandHistory = (() => {
try {
const data = fs.readFileSync(HISTORY_FILE, 'utf8')
return data.split('\n').filter(Boolean).slice(-MAX_HISTORY)
} catch (_) { return [] }
})()
function saveHistory() {
try { fs.writeFileSync(HISTORY_FILE, commandHistory.join('\n') + '\n') } catch (_) {}
}
function recordHistory(trimmed) {
if (commandHistory[commandHistory.length - 1] !== trimmed) {
commandHistory.push(trimmed)
if (commandHistory.length > MAX_HISTORY) commandHistory.shift()
saveHistory()
}
}

// ── Global crash guards ───────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
try { logFor(SYSTEM_ID, `{red-fg}[UNCAUGHT] ${sanitize(err.stack || err.message)}{/red-fg}`); monitoring?.onFatal('uncaught exception', err.stack || err.message) } catch (_) {}
})
process.on('unhandledRejection', (reason) => {
try { const detail = reason instanceof Error ? (reason.stack || reason.message) : String(reason); logFor(SYSTEM_ID, `{red-fg}[UNHANDLED REJECTION] ${sanitize(detail)}{/red-fg}`); monitoring?.onFatal('unhandled rejection', detail) } catch (_) {}
})

// ── TUI (optional — lazily loaded, only when TUI_GUI is on) ──────────────────
function startTUI() {
if (!TUI_GUI) return null
let blessed
try { blessed = require('neo-blessed') } catch (_) {
logFor(SYSTEM_ID, '{yellow-fg}⚠ TUI_GUI is on but neo-blessed is not installed — TUI disabled (npm install neo-blessed).{/yellow-fg}')
return null
}
const screen = blessed.screen({ smartCSR: true, title: 'Mineflayer AFK Console', fullUnicode: true })

// Debounced render — the single biggest fix for input lag under chat bursts.
let renderQueued = false
function debouncedRender() {
if (renderQueued) return
renderQueued = true
setImmediate(() => {
renderQueued = false
try {
screen.render()
} catch (err) {
try { fs.writeSync(2, `[render error] ${err && err.message}\n`) } catch (_) {}
}
})
}

const header = blessed.box({
top: 0, left: 0, width: '100%', height: 3,
content: '{center}{bold}⛏ MINEFLAYER AFK CONSOLE{/bold}{/center}',
tags: true,
style: { fg: 'white', bg: 'blue' }
})

const logBox = blessed.log({
top: 3, left: 0, width: '100%', height: '100%-6',
border: { type: 'line' },
label: ' Activity Log ',
tags: true,
padding: { left: 1, right: 1 },
style: { border: { fg: 'gray' }, label: { fg: 'cyan', bold: true } },
scrollable: true, alwaysScroll: true, mouse: true,
scrollbar: { ch: '│', style: { fg: 'cyan' } }
})

const inputBox = blessed.textbox({
bottom: 0, left: 0, width: '100%', height: 3,
border: { type: 'line' },
tags: true,
style: { border: { fg: 'green' }, fg: 'white' },
inputOnFocus: true
})
inputBox.setLabel(' {green-fg}{bold}❯{/bold}{/green-fg} Command ')

screen.append(header)
screen.append(logBox)
screen.append(inputBox)
inputBox.focus()

screen.key(['C-c'], () => process.exit(0))

// Automatically refocus the input box if the user clicks the log box
logBox.on('click', () => { inputBox.focus() })

// Automatically refocus if the user starts typing while defocused
screen.on('keypress', (ch, key) => {
if (key && key.ctrl && key.name === 'c') return // preserve ctrl+c
if (!inputBox.focused) {
inputBox.focus()
if (ch && ch.length === 1 && !key.ctrl && !key.meta) inputBox.setValue(inputBox.getValue() + ch)
screen.render()
}
})

function updateHeader() {
const names = Object.keys(bots)
const activeIndex = names.indexOf(activeId) + 1
const activeLabel = activeId ? `Active: [${activeIndex}] ${activeId}` : 'No active bot'
const others = names.map((n, i) => i !== (activeIndex - 1) ? `[${i + 1}] ${n}` : null).filter(Boolean)
const othersLabel = others.length ? ` | Others: ${others.join(', ')}` : ''
const proxyLabel = PROXY_GROUPS_ENABLED
? ` — Proxy: ${PROXY_GROUPS.length} group(s)`
: PROXY_ENABLED ? ` — Proxy: ${PROXY_TYPE.toUpperCase()} ${PROXY_HOST}:${PROXY_PORT}` : ''
const webLabel = webHandle ? ` — Web: :${webHandle.port}` : ''
header.setContent(`{center}{bold}⛏ MINEFLAYER AFK CONSOLE{/bold} — ${activeLabel}${othersLabel}${proxyLabel}${webLabel}{/center}`)
debouncedRender()
}

// System-channel lines are shown inline (like the old console hijack), bot lines only when active
subscribeLog((id, line) => {
if (id === activeId || id === SYSTEM_ID) { logBox.log(escBlessed(line)); debouncedRender() }
})

// ── Input handling & History (real tail, verbatim) ──────────────────────────
let historyIndex = -1

inputBox.key('up', () => {
if (historyIndex < commandHistory.length - 1) {
historyIndex++
inputBox.setValue(commandHistory[commandHistory.length - 1 - historyIndex])
debouncedRender()
}
})

inputBox.key('down', () => {
if (historyIndex > 0) {
historyIndex--
inputBox.setValue(commandHistory[commandHistory.length - 1 - historyIndex])
debouncedRender()
} else if (historyIndex === 0) {
historyIndex = -1
inputBox.setValue('')
debouncedRender()
}
})

inputBox.key('tab', () => {
const val = inputBox.getValue()
if (val.startsWith('/')) {
const available = Object.keys(COMMANDS)
const prefix = val.split(' ')[0]
const matches = available.filter(c => c.startsWith(prefix))
if (matches.length === 1) {
// Strip parameter hints (e.g. "/warp <place>" → "/warp ")
const base = matches[0].replace(/ [<\[].*$/, '')
inputBox.setValue(base + ' ')
debouncedRender()
} else if (matches.length > 1) {
logInfo(`{cyan-fg}Matches:{/cyan-fg} ${matches.map(m => m.split(' ')[0]).join(', ')}`)
}
}
})

inputBox.on('submit', (input) => {
const trimmed = (input || '').trim()
inputBox.clearValue()
inputBox.focus()
debouncedRender()

if (trimmed.length > 0) {
recordHistory(trimmed)
historyIndex = -1
handleCommand(trimmed)
}
})

// Escape key can cause neo-blessed to stop reading input — re-focus immediately
inputBox.on('cancel', () => {
inputBox.clearValue()
setImmediate(() => {
inputBox.focus()
debouncedRender()
})
})

const t = {
screen, logBox, inputBox, updateHeader,
show(id) {
logBox.setContent('')
logBox.scrollTo(0)
// Cap: switching views stays instant even with large logs (escBlessed escapes the stored tag text)
const logs = ((bots[id] && bots[id].logs) || []).slice(-600)
if (logs.length) logBox.setContent(logs.map(l => escBlessed(l.text)).join('\n'))
updateHeader()
const bottom = logBox.getScrollHeight()
if (bottom > 0) logBox.scrollTo(bottom)
debouncedRender()
},
clear() { logBox.setContent(''); debouncedRender() }
}

updateHeader()
screen.render()
return t
}

// ── Web GUI: login page ──────────────────────────────────────────────────────
const LOGIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — AFK Console</title>
<style>
body{background:#0a0e13;color:#c7d2dc;font:14px ui-monospace,'Cascadia Code','SF Mono',Menlo,Consolas,monospace;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#0f151d;border:1px solid #1d2836;border-radius:12px;padding:34px 38px;width:320px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.45)}
h1{font-size:16px;color:#e8f0f6;margin:0 0 4px}h1 b{color:#2dd4bf}
p{color:#5b6b7a;font-size:12px;margin:0 0 22px}
input{width:100%;background:#0a0e13;border:1px solid #1d2836;border-radius:8px;color:#c7d2dc;padding:10px 12px;font:inherit;margin-bottom:14px;box-sizing:border-box}
input:focus{outline:none;border-color:#2dd4bf}
button{width:100%;background:#2dd4bf;color:#04211d;border:0;border-radius:8px;padding:10px;font:inherit;font-weight:700;cursor:pointer}
.err{color:#f87171;font-size:12px;margin:0 0 14px}
</style></head><body>
<form class="card" method="post" action="/login">
<h1>⛏ AFK<b>CONSOLE</b></h1><p>sign in to continue</p>__ERR__
<input type="password" name="password" placeholder="password" autofocus>
<button>sign in</button></form></body></html>`

// ── Web GUI: dashboard page ──────────────────────────────────────────────────
const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AFK Console</title>
<style>
:root{--bg:#0a0e13;--panel:#0f151d;--panel2:#131b25;--line:#1d2836;--txt:#c7d2dc;--dim:#5b6b7a;--acc:#2dd4bf;--red:#f87171;--grn:#4ade80;--yel:#fbbf24;--cyan:#67e8f9;--mag:#e879f9;--blu:#7db3f5}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:var(--bg);color:var(--txt);font:13px/1.45 ui-monospace,'Cascadia Code','SF Mono',Menlo,Consolas,monospace;overflow:hidden}
#app{display:grid;height:100vh;grid-template-rows:46px 1fr;grid-template-columns:250px 1fr;grid-template-areas:"top top" "side main"}
header{grid-area:top;display:flex;align-items:center;gap:14px;padding:0 14px;background:linear-gradient(180deg,#101a24,#0d141c);border-bottom:1px solid var(--line)}
.logo{font-weight:700;color:#e8f0f6;letter-spacing:.5px}.logo b{color:var(--acc)}
#chips{display:flex;gap:8px;margin-left:auto;flex-wrap:wrap}
.wsstate{border:1px solid var(--line);border-radius:6px;padding:2px 8px;font-size:11px;color:var(--dim)}
.wsstate.up{color:var(--grn);border-color:rgba(74,222,128,.45)}
.wsstate.wait{color:var(--yel);border-color:rgba(251,191,36,.45)}
.wsstate.down{color:var(--red);border-color:rgba(248,113,113,.45)}
.chip{background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:2px 8px;font-size:11px;color:var(--dim)}
.chip b{color:var(--txt);font-weight:600}
#logout{background:none;border:1px solid var(--line);color:var(--dim);border-radius:6px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px}
#logout:hover{color:var(--red);border-color:var(--red)}
aside{grid-area:side;background:var(--panel);border-right:1px solid var(--line);overflow-y:auto;padding:8px}
.views{display:flex;gap:6px;margin-bottom:8px}
.vchip{flex:1;text-align:center;padding:5px 4px;border:1px solid var(--line);border-radius:6px;color:var(--dim);cursor:pointer;font-size:11px;user-select:none}
.vchip.on{color:var(--acc);border-color:var(--acc);background:rgba(45,212,191,.08)}
.bot{border:1px solid var(--line);border-radius:8px;padding:8px 9px;margin-bottom:6px;cursor:pointer;background:var(--panel2)}
.bot.on{border-color:rgba(74,222,128,.45)}
.bot.sel{outline:1px solid var(--acc)}
.bhead{display:flex;align-items:center;gap:7px}
.dot{width:8px;height:8px;border-radius:50%;background:#39434f;flex:none}
.bot.on .dot{background:var(--grn);box-shadow:0 0 6px rgba(74,222,128,.7)}
.bname{font-weight:600;color:#dbe6ee;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.batt{margin-left:auto;font-size:10px;color:var(--yel)}
.bmeta{display:flex;gap:10px;margin-top:5px;font-size:11px;color:var(--dim);flex-wrap:wrap}
canvas{display:block;margin-top:5px;width:100%;height:16px}
main{grid-area:main;position:relative;display:flex;flex-direction:column;min-width:0;min-height:0}
#loghead{position:relative;display:flex;align-items:center;gap:8px;padding:7px 12px;background:var(--panel);border-bottom:1px solid var(--line)}
#channame{color:var(--acc);font-weight:700}
#search{margin-left:auto;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--txt);padding:3px 8px;width:180px;font:inherit;font-size:12px}
#search:focus{outline:none;border-color:var(--acc)}
button.tb{background:none;border:1px solid var(--line);color:var(--dim);border-radius:6px;padding:3px 9px;cursor:pointer;font:inherit;font-size:11px}
button.tb:hover{color:var(--txt);border-color:var(--acc)}
#newchip{position:absolute;top:-9px;right:150px;background:var(--acc);color:#04211d;border-radius:9px;padding:1px 8px;font-size:10px;font-weight:700;cursor:pointer;display:none}
#logwrap{flex:1;min-height:0;overflow-y:auto;padding:6px 0 140px;background:var(--bg)}
.ln{padding:0 14px;white-space:pre-wrap;word-break:break-word}
.ln .tag{color:var(--dim);font-size:11px}
.c-red{color:var(--red)}.c-green{color:var(--grn)}.c-blue{color:var(--blu)}.c-cyan{color:var(--cyan)}
.c-magenta{color:var(--mag)}.c-yellow{color:var(--yel)}.c-white{color:#e8f0f6}
.c-gray,.c-grey{color:var(--dim)}.c-black{color:#0a0e13}.b{font-weight:700}
#cmdbar{position:fixed;left:250px;right:0;bottom:0;z-index:30;display:flex;min-height:56px;gap:8px;align-items:center;padding:9px 12px;background:var(--panel);border-top:1px solid var(--line);box-shadow:0 -6px 18px rgba(0,0,0,.25)}
#cmdbar.cmdbar-hidden{display:none}
.manual-viewer{background:none;border:1px solid rgba(103,232,249,.4);color:var(--cyan);border-radius:5px;padding:2px 6px;font:inherit;font-size:10px;cursor:pointer;margin-left:auto}
.manual-viewer:hover{border-color:var(--cyan);background:rgba(103,232,249,.08)}
.manual-badge{color:var(--yel);border:1px solid rgba(251,191,36,.4);border-radius:5px;padding:1px 5px;font-size:9px}
#manualbar{position:fixed;left:250px;right:0;bottom:56px;z-index:29;display:none;align-items:center;justify-content:center;gap:18px;padding:8px 12px;background:var(--panel2);border-top:1px solid var(--line);box-shadow:0 -5px 14px rgba(0,0,0,.18)}
#manualbar.on{display:flex}
.manual-group{display:flex;align-items:center;gap:6px}
.manual-label{color:var(--dim);font-size:10px;text-transform:uppercase}
.move-pad{display:grid;grid-template-columns:34px 34px 34px;grid-template-rows:28px 28px;gap:4px}
.mkey,.hkey{background:var(--bg);border:1px solid var(--line);color:var(--txt);border-radius:6px;cursor:pointer;font:inherit;user-select:none;touch-action:none}
.mkey{min-width:34px;min-height:28px}
.mkey[data-control="forward"]{grid-column:2;grid-row:1}
.mkey[data-control="left"]{grid-column:1;grid-row:2}
.mkey[data-control="back"]{grid-column:2;grid-row:2}
.mkey[data-control="right"]{grid-column:3;grid-row:2}
.mkey.held,.hkey.on{color:#04211d;background:var(--acc);border-color:var(--acc)}
.action-keys,.hotbar-keys{display:flex;gap:4px;flex-wrap:wrap}
.hkey{min-width:29px;height:29px;padding:0 6px}
#guitui{flex:none;max-height:60vh;overflow:auto;margin:0 12px 12px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:10px 12px;box-shadow:0 -6px 18px rgba(0,0,0,.3);display:flex;flex-direction:column;gap:8px}
#guitui[hidden]{display:none}
#guitui .ghead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
#guitui .gtitle{color:var(--acc);font-weight:700;font-size:12px;letter-spacing:.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#guitui .gsub{color:var(--dim);font-size:10px;margin-right:auto}
#guitui .gslots{display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:4px}
.gslot{position:relative;border:1px solid var(--line);background:var(--bg);border-radius:6px;min-height:50px;padding:3px 5px;font:inherit;font-size:11px;line-height:1.35;color:var(--txt);cursor:pointer;overflow:hidden;user-select:none;text-align:left;display:flex;flex-direction:column;gap:1px}
.gslot .gsidx{color:var(--dim);font-size:9px}
.gslot .gsitem{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gslot .gsalt{color:var(--dim);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gslot:hover:not(.empty){border-color:var(--acc);background:rgba(45,212,191,.06)}
.gslot.empty{color:#2b3542;cursor:default}
.gslot.empty:hover{border-color:var(--line)}
.prompt{color:var(--grn);font-weight:700}
#cmd{display:block;flex:1 1 auto;min-width:0;height:32px;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:7px 10px;color:var(--txt);font:inherit}
#cmd:focus{outline:none;border-color:var(--acc)}
#sugg{position:absolute;bottom:100%;left:12px;right:12px;background:var(--panel2);border:1px solid var(--line);border-radius:8px 8px 0 0;max-height:220px;overflow:auto;z-index:5}
.sg{padding:6px 10px;cursor:pointer;display:flex;gap:10px}
.sg:hover{background:rgba(45,212,191,.08)}
.sg b{color:var(--acc);white-space:nowrap}.sg span{color:var(--dim);font-size:11px}
#help{position:absolute;inset:0;background:rgba(6,9,13,.95);z-index:9;overflow:auto;padding:26px}
#help h3{color:var(--acc);margin-bottom:12px}
#help .hcmd{display:flex;gap:12px;padding:4px 0;border-bottom:1px solid #141c26}
#help .hcmd b{color:var(--cyan);min-width:230px;white-space:nowrap}
#help .hcmd span{color:var(--dim)}
#terminal{position:absolute;inset:0;background:#050708;z-index:40;display:flex;flex-direction:column}
#terminal[hidden]{display:none}
.terminal-head{display:flex;justify-content:space-between;align-items:center;padding:9px 12px;background:var(--panel);border-bottom:1px solid var(--line);color:var(--acc)}
#terminalout{flex:1;overflow:auto;padding:12px;color:#b7f7c5;white-space:pre-wrap;word-break:break-word;font:13px/1.4 ui-monospace,'Cascadia Code','SF Mono',Menlo,Consolas,monospace}
#terminalform{display:flex;gap:8px;align-items:center;padding:9px 12px;background:var(--panel);border-top:1px solid var(--line)}
#terminalinput{flex:1;min-width:0;height:32px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--txt);padding:7px 10px;font:inherit}
#terminalinput:focus{outline:none;border-color:var(--acc)}
#toasts{position:fixed;right:14px;bottom:70px;display:flex;flex-direction:column;gap:8px;z-index:20}
.toast{background:var(--panel2);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:8px;padding:9px 14px;max-width:340px;font-size:12px;box-shadow:0 6px 24px rgba(0,0,0,.5)}
.toast.bad{border-left-color:var(--red)}.toast.good{border-left-color:var(--grn)}
.toast.out{opacity:0;transition:opacity .4s}
@media(max-width:760px){header{overflow-x:auto}header>*{flex-shrink:0}#chips{flex-wrap:nowrap}#loghead{overflow-x:auto}#loghead>*{flex-shrink:0}#botlist{display:flex;gap:6px}.bot{margin-bottom:0}#app{grid-template-columns:1fr;grid-template-areas:"top" "side" "main";grid-template-rows:46px 160px 1fr}#cmdbar{left:0}#manualbar{left:0;overflow-x:auto;justify-content:flex-start}#search{width:110px}aside{display:flex;gap:6px;overflow-x:auto;overflow-y:hidden}.bot{min-width:180px}.views{min-width:140px;flex-direction:column}}
</style></head><body>
<div id="app">
<header><div class="logo">⛏ AFK<b>CONSOLE</b></div><div id="chips"></div><div id="wsstate" class="wsstate down">offline</div><button id="logout">sign out</button></header>
<aside><div class="views"><div class="vchip on" data-view="all">ALL</div><div class="vchip" data-view="system">SYSTEM</div><button class="vchip" id="terminalbtn" type="button">TERMINAL</button></div><div id="botlist"></div></aside>
<main>
<div id="loghead"><span id="channame">ALL CHANNELS</span><span id="newchip"></span>
<input id="search" placeholder="filter logs…"><button class="tb" id="topbtn" type="button" title="scroll to top">↑ top</button><button class="tb" id="bottombtn" type="button" title="scroll to newest">↓ bottom</button><button class="tb" id="followbtn" type="button">⏸ pause</button>
<button class="tb" id="clearbtn">clear</button><button class="tb" id="helpbtn">? cmds</button></div>
<div id="logwrap"><div id="log"></div></div>
<div id="guitui" hidden></div>
<div id="manualbar" aria-label="Manual bot controls">
<div class="manual-group"><span class="manual-label">move</span><div class="move-pad">
<button class="mkey" type="button" data-control="forward" title="Forward">W</button>
<button class="mkey" type="button" data-control="left" title="Left">A</button>
<button class="mkey" type="button" data-control="back" title="Back">S</button>
<button class="mkey" type="button" data-control="right" title="Right">D</button>
</div></div>
<div class="manual-group"><span class="manual-label">actions</span><div class="action-keys">
<button class="mkey" type="button" data-control="jump">jump</button>
<button class="mkey" type="button" data-control="sneak">sneak</button>
<button class="mkey" type="button" data-control="sprint">sprint</button>
</div></div>
<div class="manual-group"><span class="manual-label">hotbar</span><div class="hotbar-keys">
<button class="hkey" type="button" data-slot="1">1</button>
<button class="hkey" type="button" data-slot="2">2</button>
<button class="hkey" type="button" data-slot="3">3</button>
<button class="hkey" type="button" data-slot="4">4</button>
<button class="hkey" type="button" data-slot="5">5</button>
<button class="hkey" type="button" data-slot="6">6</button>
<button class="hkey" type="button" data-slot="7">7</button>
<button class="hkey" type="button" data-slot="8">8</button>
<button class="hkey" type="button" data-slot="9">9</button>
</div></div>
</div>
<form id="cmdbar" action="/command" method="post"><div id="sugg" hidden></div><span class="prompt">❯</span>
<input type="hidden" id="selectedId" name="selectedId" value="all">
<input id="cmd" name="text" placeholder="type / for commands — runs on selected bot" autocomplete="off" spellcheck="false">
<button class="tb" id="sendbtn">send</button>
</form>
<div id="help" hidden></div>
<div id="terminal" hidden><div class="terminal-head"><b>bash</b><button class="tb" id="terminalclose" type="button">close</button></div><pre id="terminalout"></pre><form id="terminalform"><span class="prompt">$</span><input id="terminalinput" autocomplete="off" spellcheck="false"><button class="tb" type="submit">run</button></form></div>
</main>
</div>
<div id="toasts"></div>
<script>
(function(){
'use strict'
var ws=null,view=new URLSearchParams(location.search).get('view')||'all',follow=true,scrollOnNextLog=false,lines=[],hist=[],hIdx=-1,pending=0,cmds={},prevOnline={},botStates={},heldControls={},rcDelay=600,rcTimer=null,rt=null,pollTimer=null,pollBusy=false,terminalOpen=false,terminalEnabled=false
function el(i){return document.getElementById(i)}
function setWsState(kind,text){var state=el('wsstate');state.className='wsstate '+kind;state.textContent=text}
// Strips ANSI/VT100 escape and control sequences (color codes, cursor moves,
// title-set OSC sequences, bracketed-paste toggles, etc.) that a real
// interactive shell (xterm-256color) constantly emits. This is a plain <pre>
// box, not a full terminal emulator, so those bytes must never be shown raw —
// left unstripped they render as the "random mystery characters" bug.
var ANSI_CSI_RE=/\\x1b\\[[0-9;?]*[ -\\/]*[@-~]/g
var ANSI_OSC_RE=/\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)/g
var ANSI_OTHER_RE=/\\x1b[@-Z\\\\-_]/g
var CTRL_STRIP_RE=/[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]/g
function stripAnsi(text){
return String(text)
.replace(ANSI_OSC_RE,'')
.replace(ANSI_CSI_RE,'')
.replace(ANSI_OTHER_RE,'')
.replace(CTRL_STRIP_RE,'')
}
function terminalWrite(text){var out=el('terminalout');out.textContent+=stripAnsi(text);out.scrollTop=out.scrollHeight}
function openTerminal(){
if(!terminalEnabled){toast('SSH terminal is disabled','bad');return}
if(!ws||ws.readyState!==1){terminalWrite('WebSocket is required for the terminal.\\n');return}
terminalOpen=true;el('terminal').hidden=false;el('cmdbar').classList.add('cmdbar-hidden');el('terminalinput').focus();ws.send(JSON.stringify({t:'terminal',action:'open'}))
}
function closeTerminal(){terminalOpen=false;el('terminal').hidden=true;el('cmdbar').classList.remove('cmdbar-hidden');if(ws&&ws.readyState===1)ws.send(JSON.stringify({t:'terminal',action:'close'}))}
function reportClientError(message,stack){
try{fetch('/api/client-error',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:String(message),stack:stack?String(stack):''})})}catch(_){}}
window.addEventListener('error',function(e){reportClientError(e.message||'window error',e.error&&e.error.stack)})
window.addEventListener('unhandledrejection',function(e){reportClientError(e.reason&&e.reason.message||String(e.reason||'unhandled rejection'),e.reason&&e.reason.stack)})
var TAGRE=/\\{(\\/?)([a-z]+)(-fg|-bg)?\\}/g
var CLR={'red-fg':'c-red','green-fg':'c-green','blue-fg':'c-blue','cyan-fg':'c-cyan','magenta-fg':'c-magenta','yellow-fg':'c-yellow','white-fg':'c-white','gray-fg':'c-gray','grey-fg':'c-gray','black-fg':'c-black'}
function seg(t,act){var c=[],k;for(k in act){if(CLR[k])c.push(CLR[k]);if(k==='bold')c.push('b')}return c.length?'<span class="'+c.join(' ')+'">'+t+'</span>':t}
function parseLine(s){var html='',plain='',act={},last=0,m;TAGRE.lastIndex=0
while((m=TAGRE.exec(s))){var t=s.slice(last,m.index);if(t){html+=seg(t,act);plain+=t}
var k=m[2]+(m[3]||'');if(m[1]){delete act[k]}else{act[k]=1}
last=TAGRE.lastIndex}
var tl=s.slice(last);if(tl){html+=seg(tl,act);plain+=tl}
return{h:html,p:plain}}
function startHttpFallback(){
if(pollTimer)return
setWsState('wait','http fallback')
var poll=function(){
if(pollBusy)return
pollBusy=true
var requestedView=view
fetch('/api/state?view='+encodeURIComponent(requestedView),{credentials:'same-origin',cache:'no-store'}).then(function(r){
if(!r.ok)throw Error('HTTP '+r.status)
return r.json()
}).then(function(m){
cmds=m.commands||cmds;hist=m.cmdHistory||hist;terminalEnabled=!!m.terminalEnabled;el('terminalbtn').hidden=!terminalEnabled;renderBots(m.bots||[]);renderStats(m.stats||{});buildHelp();if(view===requestedView)setLines(m.lines||[]);setWsState('up','http fallback')
}).catch(function(){setWsState('down','offline')}).then(function(){pollBusy=false})
}
poll();pollTimer=setInterval(poll,2000)
}
function stopHttpFallback(){if(pollTimer){clearInterval(pollTimer);pollTimer=null}}
function scheduleConnect(){if(rcTimer)clearTimeout(rcTimer);rcTimer=setTimeout(function(){rcTimer=null;connect()},rcDelay);rcDelay=Math.min(Math.round(rcDelay*1.7),9000)}
function connect(){
if(ws&&(ws.readyState===WebSocket.CONNECTING||ws.readyState===WebSocket.OPEN))return
setWsState('wait','connecting')
var endpoint=(location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws'
try{ws=new WebSocket(endpoint)}catch(e){startHttpFallback();scheduleConnect();return}
ws.onopen=function(){rcDelay=600;stopHttpFallback();setWsState('up','connected');ws.send(JSON.stringify({t:'sub',id:view}));}
ws.onmessage=function(ev){var m;try{m=JSON.parse(ev.data)}catch(e){return}
if(m.t==='hello'){cmds=m.commands||{};hist=m.cmdHistory||[];terminalEnabled=!!m.terminalEnabled;el('terminalbtn').hidden=!terminalEnabled;renderBots(m.bots||[]);renderStats(m.stats||{});buildHelp();toast('connected to console','good')}
else if(m.t==='log'){addLines(m.entries||[])}
else if(m.t==='bots'){renderBots(m.bots||[]);renderStats(m.stats||{})}
else if(m.t==='select'){setView(m.id,false)}
else if(m.t==='history'){if(m.id===view)setLines(m.lines||[])}
else if(m.t==='clear'){if(m.id===view){lines=[];el('log').innerHTML=''}}
else if(m.t==='terminal'){terminalWrite(m.data||'')}}
ws.onclose=function(){releaseAllManualKeys();startHttpFallback();scheduleConnect()}
ws.onerror=function(){releaseAllManualKeys();startHttpFallback()}
}
function setView(v,subscribe){releaseAllManualKeys();view=v;el('selectedId').value=v;lines=[];pending=0;el('log').innerHTML='';el('newchip').style.display='none'
el('channame').textContent=v==='all'?'ALL CHANNELS':v==='system'?'SYSTEM':v
var chips=document.querySelectorAll('.vchip'),i
for(i=0;i<chips.length;i++)chips[i].classList.toggle('on',chips[i].getAttribute('data-view')===v)
var cards=document.querySelectorAll('.bot')
for(i=0;i<cards.length;i++)cards[i].classList.toggle('sel',cards[i].getAttribute('data-id')===v)
if(subscribe!==false&&ws&&ws.readyState===1)ws.send(JSON.stringify({t:'sub',id:v}))
else if(pollTimer)startHttpFallback()
updateManualBar()
updateGuiTui()
setFollow(true)}
function scrollBottom(){var w=el('logwrap');w.scrollTop=w.scrollHeight;pending=0;el('newchip').style.display='none'}
function setFollow(f){follow=f;el('followbtn').textContent=f?'⏸ pause':'▶ follow';if(f)scrollBottom()}
el('logwrap').addEventListener('scroll',function(){var w=el('logwrap')
var at=w.scrollTop+w.clientHeight>=w.scrollHeight-40
if(at&&pending)scrollBottom()
if(!at&&follow){follow=false;el('followbtn').textContent='▶ follow'}})
el('followbtn').onclick=function(){setFollow(!follow)}
function matchFilter(p){var q=el('search').value.trim().toLowerCase();return !q||p.toLowerCase().indexOf(q)>=0}
function addLines(es){var frag=document.createDocumentFragment(),app=false,L=el('log')
for(var i=0;i<es.length;i++){var e=es[i]
if(view!=='all'&&e.id!==view)continue
var pr=parseLine(e.text),pre=(view==='all'&&e.id!=='__system__')?'<span class="tag">['+e.id+']</span> ':''
lines.push({h:pr.h,p:pr.p,pre:pre})
if(matchFilter(pr.p)){var d=document.createElement('div');d.className='ln';d.innerHTML=pre+pr.h;frag.appendChild(d);app=true
if(!follow)pending++}}
if(lines.length>3000)lines.splice(0,lines.length-3000)
if(app){L.appendChild(frag)
while(L.childNodes.length>1200)L.removeChild(L.firstChild)
if(scrollOnNextLog){scrollOnNextLog=false;scrollBottom()}
else if(follow)scrollBottom()
else{var c=el('newchip');c.style.display='block';c.textContent=pending+' new ↓';c.onclick=scrollBottom}}}
function setLines(ls){lines=[];pending=0;el('newchip').style.display='none';var L=el('log');L.innerHTML=''
for(var i=0;i<ls.length;i++){var pr=parseLine(ls[i]);lines.push({h:pr.h,p:pr.p,pre:''})
var d=document.createElement('div');d.className='ln';d.innerHTML=pr.h;L.appendChild(d)}
if(follow)scrollBottom()}
function rebuild(){var L=el('log'),q=el('search').value.trim().toLowerCase(),n=0,frag=document.createDocumentFragment()
L.innerHTML=''
for(var i=0;i<lines.length&&n<1200;i++){var l=lines[i];if(q&&l.p.toLowerCase().indexOf(q)<0)continue
var d=document.createElement('div');d.className='ln';d.innerHTML=l.pre+l.h;frag.appendChild(d);n++}
L.appendChild(frag);if(follow)scrollBottom()}
el('search').addEventListener('input',function(){if(rt)clearTimeout(rt);rt=setTimeout(rebuild,160)})
function selectedBotState(){return botStates[view]||null}
function manualSelected(){var b=selectedBotState();return !!(b&&b.manual&&b.manual.mode)}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function guiTuiState(){var b=selectedBotState();if(!b||!b.manual||!b.manual.guiTui||!b.manual.window)return null;return b.manual.window}
function updateGuiTui(){var panel=el('guitui');if(!panel)return
var win=guiTuiState()
if(!win){panel.hidden=true;el('manualbar').style.bottom='';return}
panel.hidden=false
var html='<div class="ghead"><span class="gtitle">╔═ '+esc((win.title||'window').toUpperCase())+' ═╗</span><span class="gsub">'+win.slots.length+' slots · click = left · right-click = right</span>'
html+='<button class="tb" type="button" data-g="close">✕ close</button><button class="tb" type="button" data-g="hide">hide</button></div>'
html+='<div class="gslots">'
for(var gi=0;gi<win.slots.length;gi++){var gs=win.slots[gi]||{slot:gi,label:'slot '+gi,item:null}
var gname=gs.item||'',galt=gs.alt||''
html+='<button class="gslot'+(gname?' ':' empty')+'" type="button" data-slot="'+gs.slot+'" title="'+esc(gs.slot+' '+gs.label+(gname?' · '+gname:'')+(galt?' ['+galt+']':''))+'">'
html+='<span class="gsidx">'+gs.slot+'</span><span class="gsitem">'+(gname?esc(gname):'·')+'</span>'+(galt?'<span class="gsalt">'+esc(galt)+'</span>':'')+'</button>'}
html+='</div>'
panel.innerHTML=html
var gslots=panel.querySelectorAll('.gslot:not(.empty)')
for(var gi2=0;gi2<gslots.length;gi2++){(function(cell){var slot=cell.getAttribute('data-slot')
cell.addEventListener('click',function(){sendCmd('/window-click '+slot+' l')})
cell.addEventListener('contextmenu',function(e){e.preventDefault();sendCmd('/window-click '+slot+' r')})})(gslots[gi2])}
var gbtns=panel.querySelectorAll('[data-g]')
for(var gj=0;gj<gbtns.length;gj++){(function(btn){btn.addEventListener('click',function(){btn.getAttribute('data-g')==='close'?sendCmd('/window-close'):sendCmd('/gui-tui')})})(gbtns[gj])}
el('manualbar').style.bottom=(56+panel.offsetHeight)+'px'}
function updateManualBar(){var bar=el('manualbar');if(!bar)return;bar.classList.toggle('on',manualSelected())}
function sendManualKey(control,state){
if(!manualSelected())return
if(!ws||ws.readyState!==1){toast('Manual movement requires the WebSocket connection.','bad');return}
ws.send(JSON.stringify({t:'key',id:view,control:control,state:state}))
}
function releaseManualKey(control,button){
if(!heldControls[control])return
delete heldControls[control]
if(button)button.classList.remove('held')
sendManualKey(control,false)
}
function releaseAllManualKeys(){
var controls=Object.keys(heldControls)
for(var i=0;i<controls.length;i++){
var control=controls[i]
releaseManualKey(control,document.querySelector('.mkey[data-control="'+control+'"]'))
}
}
function bindManualControls(){
var keys=document.querySelectorAll('.mkey[data-control]')
for(var i=0;i<keys.length;i++){
(function(button){
var control=button.getAttribute('data-control')
function down(e){
e.preventDefault()
if(heldControls[control])return
heldControls[control]=true
button.classList.add('held')
sendManualKey(control,true)
if(e.pointerId!==undefined&&button.setPointerCapture){try{button.setPointerCapture(e.pointerId)}catch(_){}}
}
function up(e){if(e)e.preventDefault();releaseManualKey(control,button)}
button.addEventListener('pointerdown',down)
button.addEventListener('pointerup',up)
button.addEventListener('pointercancel',up)
button.addEventListener('lostpointercapture',up)
button.addEventListener('contextmenu',function(e){e.preventDefault()})
})(keys[i])
}
var slots=document.querySelectorAll('.hkey[data-slot]')
for(var j=0;j<slots.length;j++){
(function(button){
button.addEventListener('click',function(){
if(!manualSelected())return
sendCmd('/hotbar '+button.getAttribute('data-slot'))
})
})(slots[j])
}
window.addEventListener('blur',releaseAllManualKeys)
document.addEventListener('visibilitychange',function(){if(document.hidden)releaseAllManualKeys()})
}
function bindManualKeyboard(){
var map={KeyW:'forward',KeyS:'back',KeyA:'left',KeyD:'right',Space:'jump',ShiftLeft:'sneak',ShiftRight:'sneak',ControlLeft:'sprint',ControlRight:'sprint'}
document.addEventListener('keydown',function(e){
var control=map[e.code]
if(!control||!manualSelected())return
var tag=(document.activeElement&&document.activeElement.tagName)||''
if(tag==='INPUT'||tag==='TEXTAREA')return
e.preventDefault()
if(e.repeat||heldControls[control])return
heldControls[control]=true
var button=document.querySelector('.mkey[data-control="'+control+'"]')
if(button)button.classList.add('held')
sendManualKey(control,true)
})
document.addEventListener('keyup',function(e){
var control=map[e.code]
if(!control)return
releaseManualKey(control,document.querySelector('.mkey[data-control="'+control+'"]'))
})
}
function renderBots(bs){var box=el('botlist');box.innerHTML='';botStates={}
for(var i=0;i<bs.length;i++){var b=bs[i];botStates[b.id]=b
var old=prevOnline[b.id]
if(old===true&&!b.online)toast(b.id+' went offline'+(b.kick?' — '+b.kick:''),'bad')
if(old===false&&b.online)toast(b.id+' is online','good')
prevOnline[b.id]=b.online
var d=document.createElement('div')
d.className='bot'+(b.online?' on':'')+(b.id===view?' sel':'')
d.setAttribute('data-id',b.id)
var up=b.uptimeSec==null?'':fmtUp(b.uptimeSec)
var manualHtml=b.manual&&b.manual.mode?'<span class="manual-badge">manual</span>':''
var guiHtml=b.manual&&(b.manual.guiTui||b.manual.session)?'<span class="manual-badge" style="color:var(--cyan);border-color:rgba(103,232,249,.4)">gui</span>':''
var viewerHtml=b.manual&&b.manual.viewerPort?'<button class="manual-viewer" type="button" data-port="'+String(b.manual.viewerPort)+'">🌐 viewer</button>':''
d.innerHTML='<div class="bhead"><div class="dot"></div><div class="bname"></div>'+manualHtml+guiHtml+viewerHtml+(b.attempts?'<div class="batt">↻'+b.attempts+'</div>':'')+'</div>'
+'<div class="bmeta"><span>'+(b.ping==null?'—':b.ping)+'ms</span><span>'+(b.health==null?'—':b.health)+'❤</span><span>'+(b.food==null?'—':b.food)+'🍗</span>'+(up?'<span>'+up+'</span>':'')+'</div>'
+'<canvas width="220" height="16"></canvas>'
d.querySelector('.bname').textContent=b.id
if(b.kick)d.title=b.kick
d.onclick=(function(id){return function(){setView(id)}})(b.id)
var viewerButton=d.querySelector('.manual-viewer')
if(viewerButton)viewerButton.onclick=(function(port){return function(e){e.preventDefault();e.stopPropagation();window.open('http://'+location.hostname+':'+port+'/','_blank','noopener')}})(b.manual.viewerHostPort||b.manual.viewerPort)
box.appendChild(d)
drawSpark(d.querySelector('canvas'),b.pingHist||[])}
updateManualBar()
updateGuiTui()}
function drawSpark(cv,h){var ctx=cv.getContext('2d');ctx.clearRect(0,0,cv.width,cv.height)
if(!h||h.length<2)return
var mx=0;for(var i=0;i<h.length;i++)mx=Math.max(mx,h[i]);if(mx<=0)mx=1
ctx.strokeStyle='#2dd4bf';ctx.lineWidth=1.2;ctx.beginPath()
for(var j=0;j<h.length;j++){var x=j/(h.length-1)*(cv.width-2)+1,y=cv.height-2-(h[j]/mx)*(cv.height-4)
if(j===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}
ctx.stroke()}
function fmtUp(t){if(t<60)return t+'s';if(t<3600)return Math.floor(t/60)+'m'
return Math.floor(t/3600)+'h'+Math.floor((t%3600)/60)+'m'}
function renderStats(s){el('chips').innerHTML=''
var items=[['bots',(s.online||0)+'/'+(s.bots||0)],['mem',(s.rssMB||0)+'M'],['lag',(s.evlLagMs||0)+'ms'],
['logs',(s.logPerSec||0)+'/s'],['viewers',(s.clients||0)],['up',fmtUp(Math.floor(s.uptimeSec||0))]]
for(var i=0;i<items.length;i++){var c=document.createElement('div');c.className='chip'
var b=document.createElement('b');b.textContent=items[i][1]
c.appendChild(document.createTextNode(items[i][0]+' '));c.appendChild(b);el('chips').appendChild(c)}}
function toast(text,kind){var d=document.createElement('div');d.className='toast '+(kind||'');d.textContent=text
el('toasts').appendChild(d)
setTimeout(function(){d.classList.add('out');setTimeout(function(){d.remove()},500)},6000)}
var cinput=el('cmd')
function sendCmd(v){hist.push(v);hIdx=-1;setFollow(true);scrollOnNextLog=true;scrollBottom();setTimeout(scrollBottom,0);setTimeout(scrollBottom,180)
var selectedId=view
if(ws&&ws.readyState===1){ws.send(JSON.stringify({t:'cmd',text:v,selectedId:selectedId}));return}
fetch('/api/command',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:v,selectedId:selectedId})}).then(function(r){if(!r.ok)throw Error('HTTP '+r.status);return r.json()}).then(function(m){if(m.selectedId)setView(m.selectedId)}).catch(function(){toast('Command delivery could not be confirmed. Check logs before retrying.','bad');connect()})}
function hideSugg(){el('sugg').hidden=true}
function showSugg(){var v=cinput.value
if(!v||v.charAt(0)!=='/'){hideSugg();return}
var keys=Object.keys(cmds).filter(function(k){return k.indexOf(v)===0||(k.split(' ')[0]||'').indexOf(v)===0})
var box=el('sugg');box.innerHTML=''
if(!keys.length){hideSugg();return}
box.hidden=false
for(var i=0;i<Math.min(keys.length,8);i++){(function(k){var d=document.createElement('div');d.className='sg'
var b=document.createElement('b');b.textContent=k
var sp=document.createElement('span');sp.textContent=cmds[k]||''
d.appendChild(b);d.appendChild(sp)
d.onmousedown=function(e){e.preventDefault();cinput.value=k;cinput.focus();hideSugg()}
box.appendChild(d)})(keys[i])}}
cinput.addEventListener('input',showSugg)
cinput.addEventListener('keydown',function(e){
if(e.key==='Enter'){var v=cinput.value.trim();cinput.value='';hideSugg();if(v)sendCmd(v)}
else if(e.key==='Tab'){e.preventDefault();var kids=el('sugg').children
if(kids.length){cinput.value=kids[0].querySelector('b').textContent;showSugg()}}
else if(e.key==='ArrowUp'&&!el('sugg').hidden){return}
else if(e.key==='ArrowUp'){if(hist.length){if(hIdx<0)hIdx=hist.length;hIdx=Math.max(0,hIdx-1);cinput.value=hist[hIdx]||'';e.preventDefault()}}
else if(e.key==='ArrowDown'){if(hIdx>=0){hIdx++;if(hIdx>=hist.length){hIdx=-1;cinput.value=''}else cinput.value=hist[hIdx];e.preventDefault()}}})
el('cmdbar').addEventListener('submit',function(e){e.preventDefault();var v=cinput.value.trim();cinput.value='';hideSugg();if(v)sendCmd(v)})
el('topbtn').onclick=function(){follow=false;scrollOnNextLog=false;el('followbtn').textContent='▶ follow';el('logwrap').scrollTop=0}
el('bottombtn').onclick=function(){setFollow(true)}
el('terminalbtn').onclick=openTerminal
el('terminalclose').onclick=closeTerminal
window.addEventListener('resize',function(){
if(!terminalOpen||!ws||ws.readyState!==1)return
var box=el('terminalout'),cols=Math.max(20,Math.min(400,Math.floor(box.clientWidth/8))),rows=Math.max(5,Math.min(200,Math.floor(box.clientHeight/18)))
ws.send(JSON.stringify({t:'terminal',action:'resize',cols:cols,rows:rows}))
})
el('terminalform').addEventListener('submit',function(e){e.preventDefault();var input=el('terminalinput');var v=input.value;input.value='';if(ws&&ws.readyState===1&&v)ws.send(JSON.stringify({t:'terminal',action:'input',data:v+'\\n'}))})
function buildHelp(){var h=el('help');h.innerHTML=''
var t=document.createElement('h3');t.textContent='COMMANDS — click anywhere to dismiss';h.appendChild(t)
Object.keys(cmds).forEach(function(k){var r=document.createElement('div');r.className='hcmd'
var b=document.createElement('b');b.textContent=k
var sp=document.createElement('span');sp.textContent=cmds[k]||''
r.appendChild(b);r.appendChild(sp);h.appendChild(r)})}
el('helpbtn').onclick=function(){el('help').hidden=!el('help').hidden}
el('help').onclick=function(){el('help').hidden=true}
el('clearbtn').onclick=function(){lines=[];el('log').innerHTML=''
if(view!=='all'&&view!=='system'&&ws&&ws.readyState===1)ws.send(JSON.stringify({t:'cmd',text:'/clear'}))}
el('logout').onclick=function(){fetch('/logout',{method:'POST'}).then(function(){location.href='/login'},function(){location.href='/login'})}
document.addEventListener('keydown',function(e){
if(e.key==='/'&&document.activeElement!==cinput&&document.activeElement!==el('search')){
cinput.focus();if(!cinput.value)cinput.value='/';e.preventDefault()}})
var chips=document.querySelectorAll('.vchip[data-view]')
for(var ci=0;ci<chips.length;ci++)chips[ci].onclick=(function(v){return function(){setView(v)}})(chips[ci].getAttribute('data-view'))
bindManualControls()
bindManualKeyboard()
setView(view,false)
connect()
})()
</script></body></html>`

// ── Web GUI server (native http + ws, session-cookie auth) ───────────────────
function startWebGUI() {
if (!WEB_GUI) return null
let WebSocket
try { WebSocket = require('ws') } catch (_) {
logFor(SYSTEM_ID, '{red-fg}✗ WEB_GUI is on but the "ws" package is missing — run: npm install ws. Web GUI disabled.{/red-fg}')
return null
}

const webTrace = (message) => {
if (!WEB_TERMINAL_LOG) return
const line = `[web] ${message}`
const noisy = /^(GET \/api\/state|websocket message type=)/.test(message)
if (!noisy) logFor(SYSTEM_ID, `{gray-fg}${sanitize(line)}{/gray-fg}`)
try { process.stdout.write(`[web] ${new Date().toISOString()} ${message}\n`) } catch (_) {}
}

const password = WEB_PASSWORD || crypto.randomBytes(9).toString('base64url')
if (!WEB_PASSWORD) {
logFor(SYSTEM_ID, `{yellow-fg}⚠ WEB_PASSWORD not set — generated login password: ${password} (set WEB_PASSWORD in .env to pin it){/yellow-fg}`)
}

const SESSION_MS = Math.max(0.1, WEB_SESSION_HOURS) * 3600_000
const sessions = new Map() // token → expiry ms (sliding)
const fails = new Map() // ip → { count, until }
const clients = new Set() // ws contexts: { ws, view, alive, send }
const handle = { clients, port: null, url: null }

// Serve the dashboard script separately. This avoids a large inline script being
// rejected or truncated by a forwarded browser page while still keeping the UI
// source co-located with the dashboard markup.
const appJsMatch = PAGE_HTML.match(/<script>([\s\S]*?)<\/script>/)
const appJsBuf = Buffer.from(appJsMatch ? appJsMatch[1] : '', 'utf8')
const pageHtml = PAGE_HTML.replace(/<script>[\s\S]*?<\/script>/, '<script src="/app.js"></script>')
const pageBuf = Buffer.from(pageHtml, 'utf8')
let pageGz = null
try { pageGz = zlib.gzipSync(pageBuf, { level: 6 }) } catch (_) {}

function newSession() {
const token = crypto.randomBytes(24).toString('base64url')
sessions.set(token, Date.now() + SESSION_MS)
return token
}
function sessionValid(token) {
if (!token || !sessions.has(token)) return false
const exp = sessions.get(token)
if (Date.now() > exp) { sessions.delete(token); return false }
if (Date.now() > exp - SESSION_MS / 2) sessions.set(token, Date.now() + SESSION_MS)
return true
}
function parseCookies(req) {
const out = {}
const raw = req.headers.cookie
if (!raw) return out
raw.split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim() })
return out
}
function tokenFromReq(req, url) {
return parseCookies(req).sid || (url && url.searchParams.get('token')) || null
}
function timingSafeEq(a, b) {
const A = Buffer.from(String(a)), B = Buffer.from(String(b))
if (A.length !== B.length) { crypto.timingSafeEqual(A, A); return false }
return crypto.timingSafeEqual(A, B)
}
function readBody(req, cap) {
cap = cap || 16384
return new Promise(resolve => {
let len = 0; const chunks = []
req.on('data', c => { len += c.length; if (len > cap) { req.destroy(); resolve(null); return } chunks.push(c) })
req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
req.on('error', () => resolve(null))
})
}

const server = http.createServer(async (req, res) => {
try {
const url = new URL(req.url, 'http://localhost')
const p = url.pathname
webTrace(`${req.method} ${p} from ${req.socket.remoteAddress || '?'}`)
if (p === '/health') { res.writeHead(200); res.end('ok'); return }
if (p === '/favicon.ico') { res.writeHead(204); res.end(); return }

if (p === '/login' && req.method === 'GET') {
if (sessionValid(tokenFromReq(req, url))) { res.writeHead(303, { Location: '/' }); res.end(); return }
res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
res.end(LOGIN_HTML.replace('__ERR__', url.searchParams.get('e') ? '<p class="err">wrong password</p>' : ''))
return
}
if (p === '/login' && req.method === 'POST') {
const ip = req.socket.remoteAddress || '?'
const f = fails.get(ip)
if (f && f.until && Date.now() < f.until) { res.writeHead(429); res.end('too many attempts'); return }
const body = await readBody(req)
const supplied = new URLSearchParams(body || '').get('password') || ''
if (timingSafeEq(supplied, password)) {
fails.delete(ip)
const token = newSession()
res.writeHead(303, {
Location: '/',
'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}`
})
res.end()
logFor(SYSTEM_ID, `{green-fg}✓ Web GUI login from ${ip}{/green-fg}`)
webTrace(`login success from ${ip}`)
} else {
const cnt = ((f && f.count) || 0) + 1
fails.set(ip, { count: cnt, until: cnt >= WEB_LOGIN_MAX_FAILS ? Date.now() + 10 * 60_000 : 0 })
if (cnt >= WEB_LOGIN_MAX_FAILS) { logFor(SYSTEM_ID, `{red-fg}✗ Web login locked out for ${ip} (10 min){/red-fg}`); monitoring?.onSecurityLockout(ip) }
webTrace(`login failed from ${ip} (attempt ${cnt})`)
res.writeHead(303, { Location: '/login?e=1' }); res.end()
}
return
}
if (p === '/logout' && req.method === 'POST') {
const token = tokenFromReq(req, url)
if (token) sessions.delete(token)
res.writeHead(303, { Location: '/login', 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' })
res.end()
return
}
if (!sessionValid(tokenFromReq(req, url))) { res.writeHead(303, { Location: '/login' }); res.end(); return }
webTrace(`authenticated request ${req.method} ${p}`)
if (p === '/api/client-error' && req.method === 'POST') {
const body = await readBody(req, 8192)
let report
try { report = JSON.parse(body || '{}') } catch (_) { report = null }
if (report && typeof report.message === 'string') {
webTrace(`browser error: ${sanitize(report.message).slice(0, 500)}`)
if (report.stack) webTrace(`browser stack: ${sanitize(String(report.stack)).slice(0, 1200)}`)
}
res.writeHead(204); res.end(); return
}
if (p === '/api/state' && req.method === 'GET') {
const view = normalizeView(url.searchParams.get('view') || 'all') || 'all'
res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
res.end(JSON.stringify({ commands: COMMANDS, cmdHistory: commandHistory, bots: botSnapshot(), stats: globalStats(), terminalEnabled: SSH_ENABLED && WEB_TERMINAL_ENABLED, lines: historyForView(view) }))
return
}
if (p === '/api/command' && req.method === 'POST') {
const body = await readBody(req)
let msg
try { msg = JSON.parse(body || '{}') } catch (_) { msg = null }
if (!msg || typeof msg.text !== 'string' || !msg.text.trim()) { res.writeHead(400); res.end('invalid command'); return }
const trimmed = msg.text.trim()
webTrace(`HTTP command: ${sanitize(trimmed).slice(0, 300)}`)
recordHistory(trimmed)
let selectedId = null
handleCommand(trimmed, {
selectedId: botViewId(typeof msg.selectedId === 'string' ? msg.selectedId : null),
selectBot: id => { selectedId = id }
})
res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
res.end(JSON.stringify({ accepted: true, selectedId }))
return
}
if (p === '/command' && req.method === 'POST') {
const body = await readBody(req)
const form = new URLSearchParams(body || '')
const text = form.get('text') || ''
let selectedId = normalizeView(form.get('selectedId'))
if (text.trim()) {
const trimmed = text.trim()
webTrace(`form command: ${sanitize(trimmed).slice(0, 300)}`)
recordHistory(trimmed)
handleCommand(trimmed, { selectedId: botViewId(selectedId), selectBot: id => { selectedId = id } })
}
res.writeHead(303, { Location: selectedId ? '/?view=' + encodeURIComponent(selectedId) : '/' }); res.end()
return
}
if (p === '/' && req.method === 'GET') {
const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && pageGz
res.writeHead(200, {
'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
...(gz ? { 'Content-Encoding': 'gzip' } : {})
})
res.end(gz ? pageGz : pageBuf)
return
}
if (p === '/app.js' && req.method === 'GET') {
webTrace(`serving dashboard script (${appJsBuf.length} bytes)`)
res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
res.end(appJsBuf)
return
}
res.writeHead(404); res.end('not found')
} catch (err) {
webTrace(`request error: ${sanitize(err.stack || err.message || String(err)).slice(0, 1600)}`)
try { res.writeHead(500); res.end('error') } catch (_) {}
}
})

const wss = new WebSocket.Server({ noServer: true })
server.on('upgrade', (req, socket, head) => {
let url
try { url = new URL(req.url, 'http://localhost') } catch (_) { socket.destroy(); return }
webTrace(`upgrade ${req.url} from ${req.socket.remoteAddress || '?'}`)
if (url.pathname !== '/ws') { socket.destroy(); return }
if (!sessionValid(tokenFromReq(req, url))) {
webTrace('upgrade rejected: invalid or missing session')
socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
socket.destroy()
return
}
wss.handleUpgrade(req, socket, head, ws => { webTrace('upgrade accepted'); addClient(ws) })
})

function normalizeView(v) {
if (v === 'all' || v === 'system') return v
if (typeof v === 'string' && Object.hasOwn(bots, v)) return v
return null
}
function botViewId(v) { return (v !== 'all' && v !== 'system') ? v : null }
function historyForView(v) {
if (v === 'system') return systemLogs.slice(-400).map(l => escHtml(l.text))
if (v === 'all') {
const all = systemLogs.slice(-400)
Object.values(bots).forEach(e => { all.push(...e.logs.slice(-400)) })
all.sort((a, b) => a.time - b.time)
return all.slice(-400).map(l => escHtml(l.text))
}
const e = bots[v]
return e ? e.logs.slice(-400).map(l => escHtml(l.text)) : []
}

function addClient(ws) {
const ctx = { ws, view: 'all', alive: true }
webTrace('websocket client connected')
let terminalSession = null
const closeTerminalProcess = () => {
if (!terminalSession) return
try { terminalSession.close() } catch (_) {}
terminalSession = null
}
const openTerminalProcess = () => {
if (!SSH_ENABLED || !WEB_TERMINAL_ENABLED) {
ctx.send({ t: 'terminal', data: 'SSH terminal is disabled. Set SSH=true and WEB_TERMINAL_ENABLED=true in .env.\n' })
return
}
if (terminalSession) return
terminalSession = createTerminal()
const session = terminalSession
session.onData(chunk => ctx.send({ t: 'terminal', data: chunk.toString() }))
session.onClose(() => {
logFor(SYSTEM_ID, '{yellow-fg}[ssh] Remote terminal closed.{/yellow-fg}')
ctx.send({ t: 'terminal', data: '\n[SSH terminal disconnected]\n' })
if (terminalSession === session) terminalSession = null
})
logFor(SYSTEM_ID, `{cyan-fg}[ssh] Connecting terminal to ${SSH_CONFIG.username}@${SSH_CONFIG.host}:${SSH_CONFIG.port}…{/cyan-fg}`)
session.connect().then(() => {
logFor(SYSTEM_ID, `{green-fg}[ssh] Remote terminal connected as ${SSH_CONFIG.username}@${SSH_CONFIG.host}.{/green-fg}`)
ctx.send({ t: 'terminal', data: `SSH connected to ${SSH_CONFIG.host} as ${SSH_CONFIG.username}\n` })
}).catch(err => {
logFor(SYSTEM_ID, `{red-fg}[ssh] Terminal connection failed: ${sanitize(err.message)}{/red-fg}`)
ctx.send({ t: 'terminal', data: `\nSSH connection failed: ${sanitize(err.message)}\n` })
session.close()
if (terminalSession === session) terminalSession = null
})
}
ctx.send = obj => { if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(obj)) } catch (_) {} } }
clients.add(ctx)
ws.on('pong', () => { ctx.alive = true })
ws.on('error', () => {})
ws.on('close', (code, reason) => { closeTerminalProcess(); clients.delete(ctx); webTrace(`websocket client closed code=${code} reason=${sanitize(String(reason || ''))}`) })
ws.on('message', raw => {
let msg
try { msg = JSON.parse(raw) } catch (_) { webTrace('websocket received invalid JSON'); return }
webTrace(`websocket message type=${msg.t || 'unknown'}`)

// Hold-to-move / hotbar controls from the dashboard manual pad (bot-manual.js).
if (msg.t === 'key') {
const id = typeof msg.id === 'string' ? msg.id : null
const state = msg.state === true || msg.state === 'down' || msg.state === 'on'
if (id && Object.hasOwn(bots, id) && typeof msg.control === 'string') {
manual.key(id, msg.control, state)
}
return
}

if (msg.t === 'terminal') {
if (msg.action === 'open') openTerminalProcess()
else if (msg.action === 'close') closeTerminalProcess()
else if (msg.action === 'input' && terminalSession && typeof msg.data === 'string') {
if (msg.data.length > 8192) {
logFor(SYSTEM_ID, '{yellow-fg}[ssh] Rejected oversized terminal input.{/yellow-fg}')
} else {
terminalSession.write(msg.data)
}
} else if (msg.action === 'resize' && terminalSession) {
const cols = Number.parseInt(msg.cols, 10)
const rows = Number.parseInt(msg.rows, 10)
if (Number.isInteger(cols) && Number.isInteger(rows) && cols >= 20 && cols <= 400 && rows >= 5 && rows <= 200) {
terminalSession.resize(cols, rows)
}
}
return
}
if (msg.t === 'cmd' && typeof msg.text === 'string') {
const trimmed = msg.text.trim()
if (!trimmed) return
recordHistory(trimmed)
// Commands typed while viewing a bot act on THAT bot (see handleCommand's ctx routing)
handleCommand(trimmed, {
selectedId: botViewId(typeof msg.selectedId === 'string' ? msg.selectedId : ctx.view),
selectBot: id => {
ctx.view = id
ctx.send({ t: 'select', id })
ctx.send({ t: 'history', id, lines: historyForView(id) })
}
})
} else if (msg.t === 'sub' && typeof msg.id === 'string') {
const v = normalizeView(msg.id)
if (v) { ctx.view = v; ctx.send({ t: 'history', id: v, lines: historyForView(v) }) }
}
})
ctx.send({ t: 'hello', commands: COMMANDS, cmdHistory: commandHistory, bots: botSnapshot(), stats: globalStats(), terminalEnabled: SSH_ENABLED && WEB_TERMINAL_ENABLED })
}

// Batched log flush with per-connection routing: a client only receives lines
// for its subscribed bot (plus the system channel) instead of everything.
let pendingLogs = []
let flushTimer = null
function flushWebLogs() {
flushTimer = null
if (!pendingLogs.length) return
if (!clients.size) { pendingLogs.length = 0; return }
const batch = pendingLogs.map(e => ({ id: e.id, text: escHtml(e.text) }))
pendingLogs.length = 0
for (const ctx of clients) {
let entries
if (ctx.view === 'all') entries = batch
else if (ctx.view === 'system') entries = batch.filter(e => e.id === SYSTEM_ID)
else entries = batch.filter(e => e.id === ctx.view)
if (entries.length) ctx.send({ t: 'log', entries })
}
}
subscribeLog((id, text) => {
logRateTick++
if (!clients.size) return
pendingLogs.push({ id, text })
if (!flushTimer) {
flushTimer = setTimeout(flushWebLogs, WS_BROADCAST_INTERVAL_MS)
if (flushTimer.unref) flushTimer.unref()
}
})

// Bot list / stats push: dirty-flag driven with a 5s freshness floor — no per-event spam.
let botsDirty = true, snapTick = 0
markBotsDirtyFn = () => { botsDirty = true }
webClearFn = id => { for (const ctx of clients) if (ctx.view === id || ctx.view === 'all') ctx.send({ t: 'clear', id }) }
const snapTimer = setInterval(() => {
snapTick++
if (!clients.size) { botsDirty = false; return }
if (botsDirty || snapTick % 5 === 0) {
botsDirty = false
const msg = { t: 'bots', bots: botSnapshot(), stats: globalStats() }
for (const ctx of clients) ctx.send(msg)
}
}, 1000)
if (snapTimer.unref) snapTimer.unref()

// Prune dead sockets so we never keep writing to connections that silently dropped
const hb = setInterval(() => {
for (const ctx of clients) {
if (ctx.alive === false) { try { ctx.ws.terminate() } catch (_) {} ; continue }
ctx.alive = false
try { ctx.ws.ping() } catch (_) {}
}
}, 30000)
if (hb.unref) hb.unref()

// Port fallback: 80 → 81 → 82 … (also on EACCES, e.g. unprivileged port 80)
function listenFallback(port, triesLeft) {
const onError = err => {
if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && triesLeft > 0) {
logFor(SYSTEM_ID, `{yellow-fg}⚠ Web port ${port} unavailable (${err.code}) — trying ${port + 1}…{/yellow-fg}`)
listenFallback(port + 1, triesLeft - 1)
} else {
logFor(SYSTEM_ID, `{red-fg}✗ Web GUI failed to start: ${sanitize(err.message)}{/red-fg}`)
try { process.stderr.write(`[web] failed to start on ${WEB_BIND}:${port}: ${err.message}\n`) } catch (_) {}
}
}
server.once('error', onError)
server.listen(port, WEB_BIND, () => {
server.removeListener('error', onError)
handle.port = port
handle.url = `http://${WEB_BIND === '0.0.0.0' ? 'localhost' : WEB_BIND}:${port}`
logFor(SYSTEM_ID, `{green-fg}✓ Web GUI listening on ${WEB_BIND}:${port}${port !== WEB_PORT ? ` (WEB_PORT ${WEB_PORT} was taken — fell back automatically)` : ''}{/green-fg}`)
try { process.stdout.write(`[web] listening on ${WEB_BIND}:${port} — open port ${port} in the VS Code Ports panel\n`) } catch (_) {}
})
}
listenFallback(WEB_PORT, WEB_PORT_MAX_ATTEMPTS)
return handle
}

// ── Console / stderr mirroring ───────────────────────────────────────────────
// TUI active → swallow raw output (protects the blessed screen).
// Web/headless → keep real stdout/stderr for pm2/docker logs AND mirror into the System channel.
function installConsolePlumbing() {
const realLog = console.log.bind(console), realWarn = console.warn.bind(console), realError = console.error.bind(console)
const realStderr = process.stderr.write.bind(process.stderr)
console.log = (...a) => { if (!tui) realLog(...a); logFor(SYSTEM_ID, `{gray-fg}${sanitize(a.join(' '))}{/gray-fg}`) }
console.warn = (...a) => { if (!tui) realWarn(...a); logFor(SYSTEM_ID, `{yellow-fg}[warn] ${sanitize(a.join(' '))}{/yellow-fg}`) }
console.error = (...a) => { if (!tui) realError(...a); logFor(SYSTEM_ID, `{red-fg}[error] ${sanitize(a.join(' '))}{/red-fg}`) }
process.stderr.write = (chunk, encoding, cb) => {
try {
const text = (typeof chunk === 'string' ? chunk : chunk.toString('utf8')).trim()
if (text) logFor(SYSTEM_ID, `{gray-fg}[stderr] ${sanitize(text)}{/gray-fg}`)
} catch (_) {}
if (tui) return true
return realStderr(chunk, encoding, cb)
}
}

// ── Bot creation (original, with consolidated packet listener + log throttling) ──
function createBotInstance(username, host = HOST, port = PORT, version = VERSION) {
const id = username
let connected = false
let manualDisconnect = false

// Cancel any pending reconnect from a previous instance (timer lives on bots[id], not in closure)
clearReconnectTimer(id)

const s = (msg) => logFor(id, `{green-fg}✓ ${msg}{/green-fg}`)
const e = (msg) => logFor(id, `{red-fg}✗ ${msg}{/red-fg}`)
const i = (msg) => logFor(id, `{cyan-fg}› ${msg}{/cyan-fg}`)
const w = (msg) => logFor(id, `{yellow-fg}⚠ ${msg}{/yellow-fg}`)
const c = (msg) => logFor(id, `{white-fg}${sanitize(msg)}{/white-fg}`)

// Clean up previous instance
if (bots[id]?.bot) {
try { bots[id].bot.removeAllListeners() } catch (_) {}
try { if (bots[id].bot._client) bots[id].bot._client.removeAllListeners() } catch (_) {}
}

const existingLogs = bots[id]?.logs || []
const existingReconnectAttempts = bots[id]?.reconnectAttempts || 0

let bot
try {
bot = mineflayer.createBot({
host, port, username: id, version, hideErrors: true,
connect: makeProxyConnect(host, port, i, id)
})
} catch (err) {
const fallback = activeId || id
logFor(fallback, `{red-fg}✗ Failed to create bot "${id}": ${sanitize(err.message)}{/red-fg}`)
return null
}

bot.loadPlugin(armorManager)
bot.loadPlugin(pathfinder)

bots[id] = {
bot, spawnTime: null, logs: existingLogs, host, port, version,
reconnectAttempts: existingReconnectAttempts,
reconnectTimer: null,
lastKickReason: null,
lastDisconnectReason: null, // stores raw error text for transfer-crash classification
crateRoutineRunning: false, // prevents concurrent /crates runs
crateLoopRunning: false, // prevents concurrent /crates-loop runs
inCrateRoutine: false, // suppresses windowOpen handler during /crates
shardshopLoopRunning: false, // prevents concurrent /shardshop-loop runs
lastActivity: Date.now(), // updated on every inbound packet — used by the proxy stall watchdog
forceKilled: false, // set by the watchdog so scheduleReconnect logs it distinctly
manualDisconnect: false, // mirrors the closure-local flag so the watchdog (outside this closure) can see it too
pingHist: [], // web GUI sparkline
manualMode: false, // manual interact mode (bot-manual.js)
manualViewer: null, // { port } when the 3D viewer is live
manualWindow: null, // window tracked for manual /window-* commands
guiTui: false, // dashboard ASCII GUI TUI toggle (/gui-tui)
suppressNextWindowClick: false, // suppress auto slot-click for the next windowOpen
suppressWindowTimer: null, // clears the above when no window opens within 5s
manualSession: false, // sticky manual GUI session (set when a /gui window opens)
guiSessionTimer: null, // 20-min auto-close timer for the manual GUI session
}
const entry = bots[id]

// Managed timers — all cleared on disconnect so nothing fires against a dead bot
const timeouts = []
const pushT = (fn, delay) => { const t = setTimeout(fn, delay); timeouts.push(t); return t }
const clearAll = () => { timeouts.forEach(clearTimeout); timeouts.length = 0 }

// Detect whether a disconnect was caused by a Velocity proxy transfer crash
function isProxyCrash(reason) {
if (!reason) return false
const text = typeof reason === 'string' ? reason : (reason.message || String(reason))
return PROXY_CRASH_PATTERNS.some(re => re.test(text))
}

const scheduleReconnect = (reason, rawError) => {
clearAll()
connected = false
// ADDED CHECK: Prevent recursive calls if already reconnecting or manually disconnected
if (manualDisconnect || bots[id]?.reconnectTimer) {
// If a reconnect is already scheduled, or if the user manually disconnected,
// do not schedule another reconnect.
return;
}

const proxyCrash = isProxyCrash(rawError || reason)
const attempt = bots[id]?.reconnectAttempts || 0

// Check max reconnect limit (only for non-proxy-crash disconnects; proxy crashes reset the count)
if (!proxyCrash && attempt >= MAX_RECONNECT) {
if (bots[id]) bots[id].reconnectTimer = null
e(`${id} reached max reconnects (${MAX_RECONNECT}). Disconnected permanently. Use /reconnect to try again.`)
monitoring?.onReconnectExhausted(id, MAX_RECONNECT)
return
}

let delay
if (proxyCrash) {
// Proxy transfer crash → fast flat reconnect, don't increment backoff
delay = FAST_RECONNECT_MS
w(`${reason} (proxy transfer crash detected). Reconnecting in ${(delay / 1000).toFixed(1)}s…`)
} else {
// Real kick / unknown error → exponential backoff
delay = Math.min(RECONNECT_BASE_MS * Math.pow(1.3, attempt), RECONNECT_MAX_MS)
if (bots[id]) bots[id].reconnectAttempts = attempt + 1
w(`${reason}. Auto-reconnecting in ${(delay / 1000).toFixed(1)}s (Attempt ${attempt + 1})…`)
}

bots[id].reconnectTimer = setTimeout(() => {
bots[id].reconnectTimer = null
// Defer to next tick so reconnect never runs inside the disconnect/create call stack
setImmediate(() => createBotInstance(id, host, port, version))
}, delay)
}

const safeChat = (msg) => {
if (!connected || !bot.entity) return false
try { bot.chat(msg); return true } catch (err) {
logFor(id, `{red-fg}[chat] Failed: ${sanitize(err.message)}{/red-fg}`)
return false
}
}

if (bot._client) {
let sentSettings = false
let configLogCount = 0
let configQuiet = false
const IMPORTANT_CONFIG = new Set(['cookie_request', 'custom_payload', 'feature_flags', 'keep_alive'])

bot._client.on('state', (newState) => {
logFor(id, `{magenta-fg}[state] -> ${newState}{/magenta-fg}`)

// --- RECONFIGURE FIX ---
// Some auth plugins (and 1.21+ Velocity backends in general) push the client
// BACK into the 'configuration' state after /login or /register (e.g. to resend
// registry_data / a resource pack). mineflayer's physics tick has no idea this
// happened and keeps writing play-phase 'position' packets every tick regardless
// of protocol state, which the backend rejects as a protocol violation and kicks
// us for with "An internal error occurred during your connection." Pausing
// physics for the duration of any configuration phase (including this mid-game
// reconfigure, not just the initial login one) fixes it.
if (newState === 'configuration') {
bot.physicsEnabled = false
} else if (newState === 'play') {
bot.physicsEnabled = true
}
})

// ONE consolidated per-packet listener (was: two — stall heartbeat + config logging),
// preserving the original order: generic log → cookie_response → delayed settings.
// Routine config packets (registry_data spam) are throttled after CONFIG_PACKET_LOG_LIMIT lines.
bot._client.on('packet', (data, meta) => {
if (PROXY_STALL_ENABLED) entry.lastActivity = Date.now()
if (bot._client.state !== 'configuration') return

if (IMPORTANT_CONFIG.has(meta.name) || CONFIG_PACKET_LOG_LIMIT <= 0) {
logFor(id, `{blue-fg}[config <-] ${meta.name}{/blue-fg}`)
} else if (configLogCount < CONFIG_PACKET_LOG_LIMIT) {
configLogCount++
logFor(id, `{blue-fg}[config <-] ${meta.name}{/blue-fg}`)
} else if (!configQuiet) {
configQuiet = true
logFor(id, '{blue-fg}[config <-] …routine config packets suppressed (set CONFIG_PACKET_LOG_LIMIT=0 to see all){/blue-fg}')
}

if (meta.name === 'cookie_request') {
logFor(id, `{yellow-fg}[config ->] cookie_request ${data.cookie}{/yellow-fg}`)
bot._client.write('cookie_response', {
key: data.cookie,
value: undefined
})
}

// --- NEW TIMING FIX ---
// Wait until the server starts talking to us in the config phase
// before we send our settings, so we know it's ready to listen.
if (!sentSettings && (meta.name === 'custom_payload' || meta.name === 'feature_flags' || meta.name === 'keep_alive' || meta.name === 'cookie_request')) {
sentSettings = true
logFor(id, `{yellow-fg}[config ->] sending delayed client_information (settings){/yellow-fg}`)

bot._client.write('settings', {
locale: 'en_us',
viewDistance: 8,
chatFlags: 0,
chatColors: true,
skinParts: 127,
mainHand: 1,
enableTextFiltering: false,
allowServerListings: true
})
}
})

// Packets that only make sense in the 'play' state. If any of these slip out
// while we're in 'configuration' (e.g. a packet already queued the same tick
// physicsEnabled got flipped off), the backend/Velocity kicks with an internal
// error rather than just ignoring it — so we drop them here as a second line
// of defense on top of the physicsEnabled toggle above.
const PLAY_ONLY_PACKETS = new Set([
'position', 'position_look', 'look', 'vehicle_move', 'entity_action', 'abilities'
])

const origWrite = bot._client.write.bind(bot._client)
bot._client.write = (name, params) => {
if (bot._client.state === 'configuration') {
if (PLAY_ONLY_PACKETS.has(name)) {
logFor(id, `{red-fg}[config ->] BLOCKED play-only packet during configuration: ${name}{/red-fg}`)
return
}
logFor(id, `{green-fg}[config ->] ${name}{/green-fg}`)
}
return origWrite(name, params)
}
}

bot.once('login', () => {
i('Connected to server socket. Awaiting chat auth prompts…')
})

// Listen to plain text messages to grep for auth requests
bot.on('messagestr', (message) => {
const text = message.toLowerCase()
monitoring?.inspectServerMessage(id, message)

// Grep for register prompts (e.g., "Please register using /register <password> <password>")
if (text.includes('register') && text.includes('/register')) {
i('Auth prompt detected: sending /register')
pushT(() => bot.chat(`/register ${LOGIN_PASSWORD} ${LOGIN_PASSWORD}`), 220 + Math.random() * 400)
}

// Grep for login prompts (e.g., "Please login using /login <password>")
else if (text.includes('login') && text.includes('/login')) {
i('Auth prompt detected: sending /login')
pushT(() => bot.chat(`/login ${LOGIN_PASSWORD}`), 220 + Math.random() * 400)
}
})

bot.on('resourcePack', (url, hashOrUuid) => {
i(`Resource pack requested — auto-accepting…`)
try {
if (bot.supportFeature('resourcePackUsesUUID')) {
const uuidStr = hashOrUuid.toString();
bot._client.write('resource_pack_receive', { uuid: uuidStr, result: 3 }); // ACCEPTED

// The server throws an "internal error" if LOADED is sent in the exact same tick.
// We must restore the 50ms delay that was in the original code.
setTimeout(() => {
bot._client.write('resource_pack_receive', { uuid: uuidStr, result: 0 }); // LOADED
}, 50);
} else {
bot.acceptResourcePack(); // For older versions it still works fine
}
} catch (err) { e(`acceptResourcePack failed: ${sanitize(err.message)}`) }
})

bot.once('spawn', () => {
connected = true
const recoveredAfter = bots[id]?.reconnectAttempts || 0
if (bots[id]) bots[id].spawnTime = Date.now()
monitoring?.onRecovered(id, recoveredAfter)
s(`Spawned on ${host}:${port} (v${version}).`)
notifyBotsChanged()

// Stable for 60 s → reset backoff
pushT(() => { if (connected && bots[id]) bots[id].reconnectAttempts = 0 }, 60_000)

// Auto-equip best armor immediately on spawn
pushT(() => {
if (bot.entity) {
try { bot.armorManager.equipAll() } catch (_) {}
}
}, 2000)
if (CLICK_COMPASS_ENABLED) {
pushT(() => {
i('Right-clicking compass (server selector)…')
try { bot.activateItem() } catch (err) { e(`activateItem failed: ${sanitize(err.message)}`) }
}, 3000 + Math.random() * 2000)
} else {
const spawnCommand = SERVER_COMMAND || '/server lifesteal'
pushT(() => {
i(`Sending server command after spawn: ${spawnCommand}`)
try { bot.chat(spawnCommand) } catch (err) { e(`Server command failed: ${sanitize(err.message)}`) }
}, 3000 + Math.random() * 2000)
}
})

bot.on('windowOpen', (window) => {
try {
// Manual interaction gets first refusal — suppresses automatic slot selection
// and the delayed AFK warp when manual mode is on or /window-open opened it.
if (manual.onWindowOpen(id, window)) return

// Skip the GUI/Fatal Crate handler when a /crates routine opened this window
if (bots[id]?.inCrateRoutine) return

const title = window.title?.toString ? window.title.toString() : String(window.title || '')

const getSafeItemString = (item) => {
if (!item) return 'null';
return `[Item ${item.displayName || item.name} x${item.count || 1}]`;
};

// Full slot dumps are opt-in (WINDOW_DEBUG=true) — they were the single
// biggest log-volume generator on GUI-heavy servers.
if (WINDOW_DEBUG) {
const slotInfo = window.slots.map((slot, index) => {
return `Slot ${index}: ${getSafeItemString(slot)}`;
}).join('\n');
i(`Window opened: ${sanitize(title)}\n${sanitize(slotInfo)}`);
} else {
i(`Window opened: ${sanitize(title)} (${window.slots.length} slots)`);
}

// Slot selection: fixed GUI_SLOT by default, or search-by-item when GUI_ITEM_SEARCH_ENABLED
let targetSlot = GUI_SLOT; // Default to GUI_SLOT
let foundTargetItem = false;

if (GUI_ITEM_SEARCH_ENABLED) {
for (let j = 0; j < window.slots.length; j++) {
const slot = window.slots[j];
if (!slot) continue;

// Stringify safely and make lowercase for case-insensitive search
const slotDataStr = getSafeItemString(slot).toLowerCase();

if (itemMatchesSearchGroups(slotDataStr)) {
targetSlot = j;
foundTargetItem = true;
break; // Stop searching once we find it
}
}

if (foundTargetItem) {
i(`Item search matched "${GUI_ITEM_SEARCH_TERMS}" at slot ${targetSlot}!`);
} else {
i(`Item search enabled but no match for "${GUI_ITEM_SEARCH_TERMS}" — falling back to GUI_SLOT (${GUI_SLOT}).`);
}
}

// Validation
if (targetSlot >= window.slots.length) {
w(`Slot ${targetSlot} out of bounds — window only has ${window.slots.length} slots`)
return
}
if (!window.slots[targetSlot]) {
w(`Slot ${targetSlot} is empty — not clicking.`)
return
}

// Click the decided slot
pushT(async () => {
if (!bot.currentWindow) { w('Window closed before click could fire.'); return }
try {
await bot.clickWindow(targetSlot, 0, 0)
if (!foundTargetItem) {
i(`Clicked slot ${targetSlot} — waiting for server transfer…`)
} else {
i(`Clicked slot ${targetSlot} — matched configured item search`)
}
} catch (err) { e(`Click failed: ${sanitize(err.message || String(err))}`) }
}, 2000 + Math.random() * 1600)

// AFK Warp logic
pushT(async () => {
if (!foundTargetItem) {
bot.chat(WARP_AFK)
i(`Warped — waiting for server transfer…`)
}
}, 54000 + Math.random() * 1600)

} catch (err) { e(`windowOpen handler error: ${sanitize(err.message)}`) }
})

bot.on('windowClose', (window) => {
try {
manual.onWindowClose(id, window)
notifyBotsChanged()
} catch (err) { e(`windowClose handler error: ${sanitize(err.message || String(err))}`) }
})

bot.on('message', (jsonMsg) => { try { c(jsonMsg.toString()) } catch (_) {} })

bot.on('kicked', (reason) => {
let text
try { text = typeof reason === 'string' ? reason : JSON.stringify(reason) } catch (_) { text = 'unknown' }
if (bots[id]) {
bots[id].lastKickReason = text
bots[id].lastDisconnectReason = text
}
e(`Kicked: ${sanitize(text)}`)
monitoring?.onKick(id, text)
notifyBotsChanged()
})

// ── Velocity / proxy packet-level error interception ────────────────────────
let lastRawError = null

bot.on('error', (err) => {
lastRawError = err
if (bots[id]) bots[id].lastDisconnectReason = err.message || String(err)
const proxyCrash = isProxyCrash(err)
if (proxyCrash) {
w(`Proxy packet error (will auto-reconnect): ${sanitize(err.message || String(err))}`)
} else {
e(`Error: ${sanitize(err.message || String(err))}`)
}
})

// Intercept _client-level errors — these fire for deserialization / zlib
// failures that don't always propagate to the bot 'error' event.
if (bot._client) {
bot._client.on('error', (err) => {
lastRawError = err
if (bots[id]) bots[id].lastDisconnectReason = err.message || String(err)
const proxyCrash = isProxyCrash(err)
if (proxyCrash) {
w(`Protocol-level crash (transfer?): ${sanitize(err.message || String(err))}`)
} else {
e(`Client error: ${sanitize(err.message || String(err))}`)
}
})
}

bot.on('end', (reason) => {
connected = false

try {
// Release held controls, close the viewer, restore automatic behavior.
if (bots[id]?.bot === bot) manual.stopManualMode(id)
} catch (err) { w(`Manual mode cleanup failed: ${sanitize(err.message || String(err))}`) }

const reasonText = reason ? String(reason) : ''
w(`Disconnected${reasonText ? ': ' + sanitize(reasonText) : ''}.`)
notifyBotsChanged()

// node-minecraft-protocol's 'end' reason is almost always the generic
// string "socketClosed" once the connection has already torn down — it
// does NOT carry the actual kick/error text. Prefer the real reason
// captured earlier by the 'kicked' / 'error' / client 'error' handlers
// (lastDisconnectReason) so classification reflects what actually
// happened instead of the useless "socketClosed" placeholder.
const hasRealReason = lastRawError || bots[id]?.lastDisconnectReason
let classificationReason = hasRealReason || reasonText

// Special case: a bare socketClosed with NO kick packet and NO protocol
// error, before this bot has ever reached spawn, while an outbound proxy
// is in use — this is the signature of a Tor/SOCKS5 circuit dying under
// the data burst that starts right after auth succeeds (world/chunk/
// inventory data), not a real server kick. Treat it as a proxy crash so
// it gets the fast, no-backoff reconnect instead of slow exponential
// backoff eating into MAX_RECONNECT for something that isn't a real kick.
if (!hasRealReason && PROXY_ENABLED && !bots[id]?.spawnTime && (reasonText === 'socketClosed' || !reasonText)) {
classificationReason = 'pre-spawn socketClosed (proxy tunnel likely dropped)'
}

monitoring?.onDisconnect(id, classificationReason, manualDisconnect)
scheduleReconnect('Connection lost', classificationReason)
lastRawError = null
})

bots[id].disconnectManually = () => {
manualDisconnect = true

try { manual.stopManualMode(id) } catch (_) {}

if (bots[id]) {
bots[id].manualDisconnect = true // let the watchdog (outside this closure) know this was intentional
bots[id].spawnTime = null // stop looking "spawned" to the watchdog now that we're intentionally offline
}
clearReconnectTimer(id)
clearAll()
try { bot.quit() } catch (_) {}
notifyBotsChanged()
}

if (!activeId) activeId = id
notifyBotsChanged()
return bot
}

// ── Connect all bots with staggered delay ───────────────────────────────────
let currentConnectDelay = 0
const initialConnectTimers = []
const initialBotOrder = RANDOMIZE_BOT_ORDER ? shuffledCopy(BOT_NAMES) : BOT_NAMES.slice()
initialBotOrder.forEach((name, index) => {
const timer = setTimeout(() => {
createBotInstance(name)
if (index === 0) switchTo(name)
}, currentConnectDelay)
initialConnectTimers.push(timer)
currentConnectDelay += CONNECT_DELAY_MS + Math.floor(Math.random() * (CONNECT_DELAY_RANDOM_MS + 1))
})

// ── Proxy stall watchdog ─────────────────────────────────────────────────────
// Force-kills sockets for bots that have gone silent while spawned (see config
// block near the top), so they fall through to the existing reconnect logic
// instead of sitting there dead forever. If a large fraction of bots stall at
// once, restarts the local proxy service first since that points at the shared
// tunnel rather than any individual bot.
function restartProxyService() {
if (!PROXY_RESTART_CMD) return
const now = Date.now()
if (now - lastProxyRestart < PROXY_RESTART_COOLDOWN_MS) return
lastProxyRestart = now
console.warn(`[proxy-watchdog] Multiple bots stalled at once — restarting local proxy: ${PROXY_RESTART_CMD}`)
exec(PROXY_RESTART_CMD, (err, stdout, stderr) => {
if (err) console.error(`[proxy-watchdog] Restart command failed: ${sanitize(err.message)}`)
else console.warn(`[proxy-watchdog] Restart command completed.`)
})
}

if (PROXY_STALL_ENABLED) {
setInterval(() => {
const now = Date.now()
const spawned = Object.entries(bots).filter(([, entry]) => entry.bot?.entity && entry.spawnTime && !entry.manualDisconnect)
const stalled = spawned.filter(([, entry]) => now - entry.lastActivity > PROXY_STALL_TIMEOUT_MS)
if (stalled.length === 0) return

// Shared-proxy failure: a big chunk of bots went quiet at the same time.
if (spawned.length >= 2 && stalled.length / spawned.length >= PROXY_STALL_RATIO) {
restartProxyService()
}

stalled.forEach(([id, entry]) => {
const stalledSeconds = Math.round((now - entry.lastActivity) / 1000)
console.warn(`[proxy-watchdog] "${id}" has received nothing for ${stalledSeconds}s — forcing reconnect.`)
monitoring?.onProxyStall(id, stalledSeconds)
entry.forceKilled = true
entry.lastActivity = now // avoid re-triggering every scan while the kill/reconnect is in flight
try {
// Destroy the raw socket directly (not bot.quit()) — a graceful quit
// still has to write bytes down the same stalled tunnel and can hang too.
const sock = entry.bot?._client?.socket
if (sock && !sock.destroyed) sock.destroy(new Error('proxy-watchdog: no activity, forcing reconnect'))
else entry.bot?.emit('end', 'proxy-watchdog: forced')
} catch (_) {}
})
}, PROXY_STALL_CHECK_MS)
}

// ── Command registry (original + /stats) ──────────────────────────────────────
const COMMANDS = {
'/all <cmd>': 'Run a local command on EVERY bot, or broadcast a raw chat/command to all',
'/all-slow <cmd>': `Like /all, but starts each bot ${ALL_SLOW_DELAY_MS / 1000}s apart (ALL_SLOW_DELAY_MS)`,
'/overview': 'Dashboard of every bot\'s health, food, ping, rank (via /fix + /rank), shards, coins, and balance',
'/stats': 'Runtime stats: memory, event-loop lag, log rate, web viewers, uptime',
'/crates [color]': `Warp to crates, find + walk to the nearest shulker box of [color] (default: ${CRATE_SHULKER_BLOCK.replace(/_/g, ' ')}, within ${CRATE_SCAN_RADIUS} blocks) and right-click it; falls back to ${WARP_AFK} if not found or unreachable. [color] can be a name like "purple" or a full block id like "purple_shulker_box"`,
'/crates-loop [n] [color]': 'Run /crates repeatedly (default: until failure). Specify n for a fixed count and/or a crate [color]',
'/shardshop-loop': `Repeatedly run ${SHARDSHOP_COMMAND} until the server signals it's empty (grep: SHARDSHOP_STOP_PHRASES) or hits the ${SHARDSHOP_LOOP_MAX_RUNS}-run safety cap`,
'/crates-all [n] [color]': `Run shardshop → crates → dump on bots 1 through n (default: all bots) targeting crate [color] (default: ${CRATE_SHULKER_BLOCK.replace(/_/g, ' ')}), ${(CRATES_ALL_STAGGER_MS / 1000).toFixed(0)}s apart so they don't hit the server at once`,
'/crates-solo [bot] [color]': 'Run shardshop → crates → dump on just one bot (default: active bot) targeting crate [color] — not all bots',
'/list': 'Compact one-line-per-bot status list (online / offline / last kick)',
'/chat <msg>': 'Send a chat message from the active bot (avoids triggering local commands); /-prefixed server commands open their GUI without auto-clicking',
'/disconnect': 'Disconnect the active bot (stops auto-reconnect). Alias: /dc',
'/closeBot': 'Disconnect the active bot and completely remove it from the UI',
'/clear': 'Clear the active bot\'s log view',
'/help': 'List all available commands',
'/status': 'Show active bot\'s connection, position, health, ping, uptime',
'/inv': 'List active bot\'s inventory',
'/players': 'List players online from the active bot\'s perspective',
'/exit': 'Disconnect all bots and close the program',
'/reconnect': 'Reconnect the active bot',
'/reconnect-all': 'Reconnect every currently disconnected bot',
'/reconnect-all-slow': 'Reconnect ALL bots (online or offline) with a 30s delay between each to avoid rate limits',
'/new-bot <n> [host] [port] [ver]': 'Create and connect a new bot',
'/switch <id>': 'Switch view to a different bot by name or number',
'/uptime': 'Show uptime for all bots',
'/proxy': 'Show the currently configured outbound proxy',
'/manual-interact': 'Toggle manual interact mode for the active bot (3D view, movement pad, direct world actions); disabled while crate/shardshop routines run',
'/manual-stop': 'Stop manual interact mode, release held controls, stop pathfinding, close viewer',
'/drop [count]': 'Drop the held stack (all of it, or [count] items from it)',
'/pickup [all]': 'Walk to the nearest dropped item and collect it; /pickup all sweeps everything within reach',
'/gui <cmd>': 'Send a server command (e.g. /gui /shardshop) and treat the GUI it opens as manual — no auto scan/click or warp',
'/gui-tui': 'Toggle the ASCII GUI overlay on the dashboard for the open window (click a slot to interact, right-click for right button)',
'/walk <x> <y> <z> [range]': 'Pathfind near coordinates (range defaults to 1, capped at 16); /walk stop cancels',
'/look <yaw> <pitch>': 'Turn the bot using yaw/pitch in degrees',
'/lookat <x> <y> <z>': 'Turn the bot toward world coordinates',
'/hotbar <1-9>': 'Select a hotbar slot in manual mode',
'/key <control> <down|up>': 'Hold/release forward, back, left, right, jump, sneak, or sprint in manual mode',
'/dig': 'Mine the block under the bot cursor',
'/place': 'Place the held block against the block under the cursor',
'/use': 'Use/activate the currently held item',
'/attack': 'Attack the entity under the cursor',
'/window-open': 'Open the container under the cursor without automatic slot clicking',
'/window': 'Inspect the open window (or player inventory)',
'/window-click <slot> [l|r]': 'Left/right-click a raw window slot',
'/move <src> <dst>': 'Move an item between raw window slots',
'/window-close': 'Close the open container window',
'anything else': 'Sent directly as a chat message/command from the active bot',
'/dump': 'dump gear to chest'
}

/**
* Sends a TPA command based on an .env variable, then finds the nearest chests
* within a configured radius and dumps the bot's inventory into them.
*
* @param {object} bot - The mineflayer bot instance
*/
async function tpaAndDump(bot, id) {
const tpaTarget = process.env.TPA_TARGET_PLAYER || 'DefaultPlayerName'
const scanRadius = parseInt(process.env.CHEST_SCAN_RADIUS || '30', 10)

bot.chat(`/tpa ${tpaTarget}`)
logFor(id, `{cyan-fg}› Sent /tpa to ${tpaTarget}. Waiting for teleport...{/cyan-fg}`)

try {
await new Promise((resolve, reject) => {
const startPos = bot.entity.position.clone()
const timeout = setTimeout(() => {
bot.removeListener('move', onMove)
reject(new Error('Teleport timed out'))
}, 45000)

function onMove() {
if (bot.entity.position.distanceTo(startPos) > 10) {
clearTimeout(timeout)
bot.removeListener('move', onMove)
resolve()
}
}
bot.on('move', onMove)
})
logFor(id, `{cyan-fg}› Teleport detected! Looking for chests...{/cyan-fg}`)
await new Promise(r => setTimeout(r, 2500))
} catch (err) {
logFor(id, `{yellow-fg}⚠ ${err.message}. Looking for chests nearby anyway...{/yellow-fg}`)
}

const chestIds = [
bot.registry.blocksByName.chest.id,
bot.registry.blocksByName.trapped_chest.id
]

const chestBlocks = bot.findBlocks({
matching: chestIds,
maxDistance: scanRadius,
count: 50
})

if (chestBlocks.length === 0) {
logFor(id, `{yellow-fg}⚠ No chests found within ${scanRadius} blocks.{/yellow-fg}`)
return
}

chestBlocks.sort((a, b) => {
return bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b)
})

for (const chestPos of chestBlocks) {
const itemsToDump = bot.inventory.items()
if (itemsToDump.length === 0) return

const chestBlock = bot.blockAt(chestPos)
let chestContainer

try {
chestContainer = await bot.openContainer(chestBlock)

for (const item of itemsToDump) {
try {
await chestContainer.deposit(item.type, item.metadata, item.count)
} catch (err) {
break
}
}

await chestContainer.close()
} catch (err) {
if (chestContainer) {
try { await chestContainer.close() } catch (_) {}
}
}
}
}
const LOCAL_COMMANDS = ['/status', '/inv', '/players', '/clear', '/disconnect', '/dump', '/dc', '/reconnect', '/crates', '/crates-loop', '/shardshop-loop', '/closeBot']

function runLocalCommandForBot(id, cmd) {
const entry = bots[id]
if (!entry) return false
const { bot } = entry

switch (cmd) {
case '/status': {
if (!bot.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return true }
const pos = bot.entity.position
const uptimeSec = entry.spawnTime ? Math.floor((Date.now() - entry.spawnTime) / 1000) : 0
logFor(id, `{cyan-fg}› Status for ${id}:{/cyan-fg}`)
logFor(id, ` Server: ${entry.host}:${entry.port} (v${entry.version})`)
logFor(id, ` Proxy: ${PROXY_ENABLED ? `${PROXY_TYPE.toUpperCase()} ${PROXY_HOST}:${PROXY_PORT}` : 'Direct (no proxy)'}`)
logFor(id, ` Position: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`)
logFor(id, ` Health: ${bot.health ?? 'N/A'} Food: ${bot.food ?? 'N/A'}`)
logFor(id, ` Ping: ${bot.player?.ping ?? 'N/A'}ms`)
logFor(id, ` Uptime: ${uptimeSec}s`)
return true
}

case '/inv': {
if (!bot.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return true }
const items = bot.inventory.items()
if (items.length === 0) {
logFor(id, `{cyan-fg}› Inventory is empty.{/cyan-fg}`)
} else {
logFor(id, `{cyan-fg}› Inventory for ${id}:{/cyan-fg}`)
items.forEach(item => logFor(id, ` ${item.count}x ${sanitize(item.displayName || item.name)} (slot ${item.slot})`))
}
return true
}
case '/dump': {
if (!bot.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return true }
tpaAndDump(bot, id)
return true
}
case '/players': {
if (!bot.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return true }
const players = Object.keys(bot.players)
logFor(id, `{cyan-fg}› Players online (${players.length}):{/cyan-fg}`)
players.forEach(name => logFor(id, ` ${sanitize(name)}`))
return true
}

case '/clear': {
// UI-agnostic version of the original (logBox.setContent + debouncedRender):
// clears the stored logs, tells any web clients viewing this bot, and the TUI if active.
entry.logs = []
if (webClearFn) webClearFn(id)
if (id === activeId && tui) tui.clear()
return true
}

case '/disconnect':
case '/dc': {
logFor(id, `{yellow-fg}⚠ Disconnecting ${id}…{/yellow-fg}`)
try { entry.disconnectManually() } catch (_) {}
return true
}

case '/closeBot': {
// UI-agnostic version of the original.
logFor(id, `{yellow-fg}⚠ Disconnecting and removing ${id}…{/yellow-fg}`)
try { entry.disconnectManually() } catch (_) {}
delete bots[id]

const remainingNames = Object.keys(bots)
if (activeId === id) {
if (remainingNames.length > 0) {
switchTo(remainingNames[remainingNames.length - 1])
} else {
activeId = null
if (tui) tui.clear()
}
}
notifyBotsChanged()
return true
}

case '/reconnect': {
const { host, port, version } = entry
logFor(id, `{yellow-fg}⚠ Reconnecting ${id}…{/yellow-fg}`)
try { entry.disconnectManually() } catch (_) {}
setTimeout(() => createBotInstance(id, host, port, version), 1000)
return true
}

case '/crates': {
if (!bot.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return true }
runCrateRoutine(id) // fire-and-forget async routine, logs its own progress
return true
}

case '/crates-loop': {
if (!bot.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return true }
runCrateLoop(id) // fire-and-forget, logs its own progress
return true
}

case '/shardshop-loop': {
if (!bot.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return true }
shardshopLoopCommand(id) // fire-and-forget, logs its own progress
return true
}

default:
return false
}
}

// ── Anti-cheat safe walk-to-target helper ──────────────────────────────────
// Since the crate room is flat, mineflayer-pathfinder is overkill and often
// triggers server anti-cheat rubberbanding (walking in place). This simple
// loop perfectly mimics a vanilla player walking forward without jumping/sprinting.
function walkToBlock(bot, targetPos, { reach = 4.5, timeoutMs = 15000 } = {}) {
return new Promise(async (resolve) => {
if (!bot.entity) { resolve(false); return }

let timer = null
let timeout = null
let settled = false

const stop = () => {
if (settled) return
settled = true
try { bot.clearControlStates() } catch (_) {}
if (timer) clearInterval(timer)
if (timeout) clearTimeout(timeout)
}

// 1. Inject physics override for GrimAC!
// The debug logs showed the bot was standing in a 'light' block with 0.07 velocity.
// Mineflayer often has broken physics for non-solid blocks like light and buttons,
// applying weird friction or collision that GrimAC instantly flags.
try {
const mcData = require('minecraft-data')(bot.version)
if (mcData.blocksByName.light) mcData.blocksByName.light.boundingBox = 'empty'
for (const block of Object.values(mcData.blocksByName)) {
if (block.name.includes('button')) block.boundingBox = 'empty'
}
} catch (_) {}

// 2. Look smoothly (false) to avoid Aimbot flags
// Wrapped in a 1-second timeout because Mineflayer's smooth lookAt has a bug
// where it can hang forever if it gets stuck on floating-point precision.
try {
await Promise.race([
bot.lookAt(targetPos.offset(0.5, 0.5, 0.5), false),
new Promise(r => setTimeout(r, 1000))
])
} catch (_) {}

if (settled || !bot.entity) { resolve(false); return }

// 3. Start walking purely vanilla
bot.setControlState('forward', true)
bot.setControlState('sprint', false)
bot.setControlState('jump', false)
bot.setControlState('sneak', false)

timer = setInterval(() => {
if (!bot.entity) { stop(); resolve(false); return }

const dist = bot.entity.position.distanceTo(targetPos)
if (dist <= reach) {
stop()
resolve(true)
}
}, 50)

timeout = setTimeout(() => {
stop()
if (bot.entity && bot.entity.position.distanceTo(targetPos) <= reach) {
resolve(true)
} else {
resolve(false)
}
}, timeoutMs)
})
}

// ── Crate click loop: keep right-clicking until the server signals "done" ───
// Each right-click on the shulker box consumes one key and grants a reward.
// We keep clicking until the server sends a chat message that means "you're
// out" — grepping for "you do not have a" (out of keys) or "error" (any
// failure), both case-insensitive — then stop and let the routine continue
// on (e.g. into the /dump step of /crates-all / /crates-solo). A safety
// ceiling stops the loop if the server never replies with either.
function clickCrateUntilStopMessage(bot, id, block, blockName = CRATE_SHULKER_BLOCK) {
return new Promise((resolve) => {
let settled = false
let clicks = 0
let clickTimer = null

const finish = (stopReason) => {
if (settled) return
settled = true
bot.removeListener('messagestr', onMessage)
clearTimeout(clickTimer)
clearTimeout(ceiling)
resolve({ clicks, stopReason })
}

// Grep every plain-text server message for the stop phrases, case-insensitively.
const onMessage = (message) => {
const text = message.toLowerCase()
if (CRATE_STOP_PHRASES.some(p => text.includes(p))) finish('message')
}
bot.on('messagestr', onMessage)

const ceiling = setTimeout(() => finish('timeout'), CRATE_CLICK_TIMEOUT_MS)

const clickOnce = async () => {
if (settled) return
if (!bot.entity) { finish('despawned'); return }
const freshBlock = bot.blockAt(block.position)
if (!freshBlock || freshBlock.name !== blockName) { finish('block-gone'); return }
try {
await bot.lookAt(freshBlock.position.offset(0.5, 0.5, 0.5), true)
await bot.activateBlock(freshBlock)
clicks++
} catch (_) { /* transient click failure — keep trying on the next tick */ }
if (!settled) clickTimer = setTimeout(clickOnce, CRATE_CLICK_DELAY_MS)
}

clickOnce()
})
}

// ── /crates routine: warp → scan for shulker box → walk → right-click ──
// Runs once per invocation. The inCrateRoutine flag suppresses the generic
// windowOpen handler so the shulker box GUI doesn't trigger Fatal Crate logic.
async function runCrateRoutine(id, blockNameOverride) {
const entry = bots[id]
if (entry?.manualMode) { logFor(id, `{yellow-fg}⚠ Stop manual interact (/manual-stop) before starting /crates.{/yellow-fg}`); return false }
// A GUI session armed by /chat or /gui must not swallow this routine's window
if (entry.suppressNextWindowClick) entry.suppressNextWindowClick = false
if (entry.suppressWindowTimer) { clearTimeout(entry.suppressWindowTimer); entry.suppressWindowTimer = null }
if (entry.manualWindow) entry.manualWindow = null
if (entry.manualSession) { entry.manualSession = false }
if (entry.guiSessionTimer) { clearTimeout(entry.guiSessionTimer); entry.guiSessionTimer = null }
const blockName = blockNameOverride || CRATE_SHULKER_BLOCK
logFor(id, `Change the version in .env to 1.21.1 to use this mechanic otherwise SKIP it.`)
if (!entry?.bot?.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return false }
if (entry.crateRoutineRunning) { logFor(id, `{yellow-fg}⚠ /crates is already running for ${id}.{/yellow-fg}`); return false }
entry.crateRoutineRunning = true
entry.inCrateRoutine = true
const { bot } = entry

try {
if (WARP_BEFORE_CRATE) {
logFor(id, `{cyan-fg}› Warping to crates (targeting ${blockName.replace(/_/g, ' ')})…{/cyan-fg}`)
try { bot.chat(WARP_CRATES) } catch (err) {
logFor(id, `{red-fg}✗ Failed to send "${sanitize(WARP_CRATES)}": ${sanitize(err.message)}{/red-fg}`)
return false
}

// Wait for warp to complete (5 seconds + random 100-600ms)
await new Promise(resolve => setTimeout(resolve, 5000 + 100 + Math.random() * 500))
if (!bot.entity) { logFor(id, `{red-fg}✗ ${id} despawned during warp — aborting.{/red-fg}`); return false }
} else {
logFor(id, `{cyan-fg}› Skipping warp (WARP_BEFORE_CRATE=false) — scanning from current position (targeting ${blockName.replace(/_/g, ' ')})…{/cyan-fg}`)
}

const block = bot.findBlock({
matching: (b) => b && b.name === blockName,
maxDistance: CRATE_SCAN_RADIUS
})

if (!block) {
logFor(id, `{red-fg}✗ No ${blockName.replace(/_/g, ' ')} found within ${CRATE_SCAN_RADIUS} blocks — warping to afk instead.{/red-fg}`)
try { bot.chat(WARP_AFK) } catch (_) {}
return false
}

logFor(id, `{cyan-fg}› Found it at ${block.position.x}, ${block.position.y}, ${block.position.z} — walking over…{/cyan-fg}`)

const reached = await walkToBlock(bot, block.position, { reach: CRATE_REACH, timeoutMs: 15000 })
if (!bot.entity) return false

if (!reached) {
logFor(id, `{red-fg}✗ Couldn't reach the shulker box (timed out/stuck) — warping to afk instead.{/red-fg}`)
try { bot.chat(WARP_AFK) } catch (_) {}
return false
}

// Re-fetch the block at the target position in case it changed while walking over
const freshBlock = bot.blockAt(block.position)
if (!freshBlock || freshBlock.name !== blockName) {
logFor(id, `{red-fg}✗ Block at target location changed before I could click it — warping to afk instead.{/red-fg}`)
try { bot.chat(WARP_AFK) } catch (_) {}
return false
}

logFor(id, `{cyan-fg}› Clicking the ${blockName.replace(/_/g, ' ')} until the server says we're out (grep: "you do not have a" / "error")…{/cyan-fg}`)
const { clicks, stopReason } = await clickCrateUntilStopMessage(bot, id, freshBlock, blockName)

switch (stopReason) {
case 'message':
logFor(id, `{green-fg}✓ Clicked ${clicks} time(s) — server said we're out/errored, moving on.{/green-fg}`)
return true
case 'block-gone':
logFor(id, `{yellow-fg}⚠ Shulker box disappeared after ${clicks} click(s) — treating as done.{/yellow-fg}`)
return true
case 'despawned':
logFor(id, `{red-fg}✗ ${id} despawned mid-click after ${clicks} click(s).{/red-fg}`)
return false
default:
logFor(id, `{yellow-fg}⚠ Stopped after ${clicks} click(s) — hit the ${(CRATE_CLICK_TIMEOUT_MS / 1000).toFixed(0)}s safety timeout without a stop message.{/yellow-fg}`)
return true
}
} finally {
if (bots[id]) {
bots[id].crateRoutineRunning = false
bots[id].inCrateRoutine = false
}
}
}

// ── /crates-loop: repeatedly run the crate routine ────────────────────────
async function runCrateLoop(id, maxIterations = Infinity, blockNameOverride) {
const entry = bots[id]
if (entry?.manualMode) { logFor(id, `{yellow-fg}⚠ Stop manual interact (/manual-stop) before starting /crates-loop.{/yellow-fg}`); return }
if (!entry?.bot?.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return }
if (entry.crateLoopRunning) { logFor(id, `{yellow-fg}⚠ /crates-loop is already running for ${id}.{/yellow-fg}`); return }
entry.crateLoopRunning = true

let iteration = 0
try {
while (iteration < maxIterations) {
iteration++
logFor(id, `{cyan-fg}› Crate loop iteration ${iteration}${maxIterations < Infinity ? '/' + maxIterations : ''}…{/cyan-fg}`)

const success = await runCrateRoutine(id, blockNameOverride)
if (!success) {
logFor(id, `{yellow-fg}⚠ Crate routine failed on iteration ${iteration} — stopping loop.{/yellow-fg}`)
break
}

// Brief pause between iterations to avoid spamming the server
await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000))
if (!bots[id]?.bot?.entity) {
logFor(id, `{red-fg}✗ ${id} despawned during crate loop — stopping.{/red-fg}`)
break
}
}
logFor(id, `{green-fg}✓ Crate loop finished after ${iteration} iteration(s).{/green-fg}`)
} finally {
if (bots[id]) bots[id].crateLoopRunning = false
}
}

// ── /shardshop-loop: keep sending /shardshop until the server signals "empty" ──
// Mirrors clickCrateUntilStopMessage's grep-until-stop-phrase approach, but for
// repeatedly running the shardshop command instead of clicking a block.
function runShardshopLoop(id) {
return new Promise((resolve) => {
const entry = bots[id]
if (entry?.manualMode) { logFor(id, `{yellow-fg}⚠ Stop manual interact (/manual-stop) before starting /shardshop-loop.{/yellow-fg}`); resolve(null); return }
if (entry.suppressNextWindowClick) entry.suppressNextWindowClick = false
if (entry.suppressWindowTimer) { clearTimeout(entry.suppressWindowTimer); entry.suppressWindowTimer = null }
if (entry.manualWindow) entry.manualWindow = null
if (entry.manualSession) { entry.manualSession = false }
if (entry.guiSessionTimer) { clearTimeout(entry.guiSessionTimer); entry.guiSessionTimer = null }
if (!entry?.bot?.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-ffg}`); resolve(null); return }
if (entry.shardshopLoopRunning) { logFor(id, `{yellow-fg}⚠ /shardshop-loop is already running for ${id}.{/yellow-fg}`); resolve(null); return }
entry.shardshopLoopRunning = true
const { bot } = entry

let settled = false
let runs = 0
let sendTimer = null

const finish = (stopReason) => {
if (settled) return
settled = true
bot.removeListener('messagestr', onMessage)
clearTimeout(sendTimer)
clearTimeout(ceiling)
if (bots[id]) bots[id].shardshopLoopRunning = false
resolve({ runs, stopReason })
}

// Grep every plain-text server message for the configurable stop phrases.
const onMessage = (message) => {
const text = message.toLowerCase()
if (SHARDSHOP_STOP_PHRASES.some(p => text.includes(p))) finish('message')
}
bot.on('messagestr', onMessage)

const ceiling = setTimeout(() => finish('timeout'), SHARDSHOP_LOOP_TIMEOUT_MS)

const sendOnce = () => {
if (settled) return
if (!bot.entity) { finish('despawned'); return }
if (runs >= SHARDSHOP_LOOP_MAX_RUNS) { finish('max-runs'); return }
try {
bot.chat(SHARDSHOP_COMMAND)
runs++
logFor(id, `{cyan-fg}› Sent "${sanitize(SHARDSHOP_COMMAND)}" (run ${runs}).{/cyan-fg}`)
} catch (err) {
logFor(id, `{red-fg}✗ Failed to send shardshop: ${sanitize(err.message)}{/red-fg}`)
}
if (!settled) sendTimer = setTimeout(sendOnce, SHARDSHOP_LOOP_DELAY_MS)
}

sendOnce()
})
}

async function shardshopLoopCommand(id) {
const result = await runShardshopLoop(id)
if (!result) return
const { runs, stopReason } = result
switch (stopReason) {
case 'message':
logFor(id, `{green-fg}✓ Ran ${sanitize(SHARDSHOP_COMMAND)} ${runs} time(s) — server signalled empty, stopping.{/green-fg}`)
break
case 'despawned':
logFor(id, `{red-fg}✗ ${id} despawned mid-loop after ${runs} run(s).{/red-fg}`)
break
case 'max-runs':
logFor(id, `{yellow-fg}⚠ Hit the ${SHARDSHOP_LOOP_MAX_RUNS}-run safety cap after ${runs} run(s) without a stop message — check SHARDSHOP_STOP_PHRASES in .env.{/yellow-fg}`)
break
default:
logFor(id, `{yellow-fg}⚠ Stopped after ${runs} run(s) — hit the ${(SHARDSHOP_LOOP_TIMEOUT_MS / 1000).toFixed(0)}s safety timeout without a stop message.{/yellow-fg}`)
}
}

// ── /crates-all: shardshop → crates → dump, staggered across bots ──────────
let cratesAllRunning = false

async function runCratesAllSequenceForBot(id, blockNameOverride) {
const entry = bots[id]
if (entry?.manualMode) { logFor(id, `{yellow-fg}⚠ Stop manual interact (/manual-stop) before running /crates-all on ${id}.{/yellow-fg}`); return }
if (entry.suppressNextWindowClick) entry.suppressNextWindowClick = false
if (entry.suppressWindowTimer) { clearTimeout(entry.suppressWindowTimer); entry.suppressWindowTimer = null }
if (entry.manualWindow) entry.manualWindow = null
if (entry.manualSession) { entry.manualSession = false }
if (entry.guiSessionTimer) { clearTimeout(entry.guiSessionTimer); entry.guiSessionTimer = null }
if (!entry?.bot?.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned — skipping /crates-all.{/yellow-fg}`); return }
if (entry.crateRoutineRunning || entry.crateLoopRunning) {
logFor(id, `{yellow-fg}⚠ ${id} is already busy with a crate routine — skipping /crates-all.{/yellow-fg}`)
return
}
const { bot } = entry
logFor(id, `{cyan-fg}› /crates-all: starting sequence (shardshop → crates → dump)…{/cyan-fg}`)

// 1. /shardshop-loop — sell off everything before making room for more
logFor(id, `{cyan-fg}› Running /shardshop-loop until empty…{/cyan-fg}`)
const shardshopResult = await runShardshopLoop(id)
if (!shardshopResult) { logFor(id, `{red-fg}✗ /shardshop-loop failed for ${id} — aborting sequence.{/red-fg}`); return }
logFor(id, `{green-fg}✓ /shardshop-loop completed (${shardshopResult.runs} runs, stopped: ${shardshopResult.stopReason}).{/green-fg}`)
if (!bots[id]?.bot?.entity) { logFor(id, `{red-fg}✗ ${id} despawned during shardshop-loop — aborting sequence.{/red-fg}`); return }

// 2. /crates
const crateOk = await runCrateRoutine(id, blockNameOverride)
logFor(id, crateOk
? `{green-fg}✓ Crate step done — moving on to dump.{/green-fg}`
: `{yellow-fg}⚠ Crate step failed — continuing to dump anyway.{/yellow-fg}`)
await new Promise(r => setTimeout(r, CRATES_ALL_STEP_WAIT_MS))
if (!bots[id]?.bot?.entity) { logFor(id, `{red-fg}✗ ${id} despawned before dump — aborting sequence.{/red-fg}`); return }

// 3. /dump
try {
await tpaAndDump(bot, id)
logFor(id, `{green-fg}✓ /crates-all: sequence complete for ${id}.{/green-fg}`)
} catch (err) {
logFor(id, `{red-fg}✗ Dump step failed: ${sanitize(err.message)}{/red-fg}`)
}

// 4. Warp back to AFK after 15s
await new Promise(r => setTimeout(r, 15000))
if (bots[id]?.bot?.entity) {
logFor(id, `{cyan-fg}› Warping back to AFK…{/cyan-fg}`)
try { bot.chat(WARP_AFK) } catch (_) {}
}
}

// Runs the shardshop → crates → dump sequence on bots 1..maxBots (insertion
// order, matching /list and /switch numbering), starting one bot every
// CRATES_ALL_STAGGER_MS so they don't all warp/click/TPA at the exact same
// moment. maxBots omitted/Infinity = every bot currently registered.
async function runCratesAll(maxBots = Infinity, blockNameOverride) {
if (cratesAllRunning) { logWarn('/crates-all is already running.'); return }
const ids = Object.keys(bots).slice(0, maxBots)
if (ids.length === 0) { logWarn('No bots to run /crates-all on.'); return }

cratesAllRunning = true
logInfo(`Starting /crates-all for ${ids.length} bot(s) [1–${ids.length}], ${(CRATES_ALL_STAGGER_MS / 1000).toFixed(0)}s apart…`)

try {
await Promise.allSettled(
ids.map((id, idx) => new Promise((resolve) => {
setTimeout(() => { runCratesAllSequenceForBot(id, blockNameOverride).finally(resolve) }, idx * CRATES_ALL_STAGGER_MS)
}))
)
logSuccess(`/crates-all finished for all ${ids.length} bot(s).`)
} finally {
cratesAllRunning = false
}
}

// Generalized balance query — works for "/shards" ("Shards | Balance: 1,234"),
// "/coins" ("Coins | Balance: 10 🪙."), and the money command "/bal" (which
// replies with a bare "Balance: $0.40" — no "Shards"/"Coins" label in front,
// and a decimal dollar amount instead of a whole number).
function queryBalance(id, label, command, timeoutMs = 2000) {
return new Promise((resolve) => {
const entry = bots[id]
if (!entry?.bot?.entity) { resolve(null); return }
const bot = entry.bot

let settled = false
const finish = (value) => {
if (settled) return
settled = true
bot.removeListener('message', onMessage)
bot.removeListener('end', onEnd)
clearTimeout(timer)
resolve(value)
}

const isMoney = label.toLowerCase() === 'balance'
// Money replies as a bare "Balance: $0.40" (no leading label, decimal amount).
// Shards/Coins reply as "<Label> ... Balance: <whole number>".
const regex = isMoney
? /Balance:?\s*\$?\s*([\d,]+(?:\.\d+)?)/i
: new RegExp(`${label}.{0,10}Balance:?\\s*\\$?\\s*([\\d,]+(?:\\.\\d+)?)`, 'i')

const onMessage = (jsonMsg) => {
try {
const text = jsonMsg.toString()
// The Shards/Coins replies also contain the word "Balance:" — don't let
// the money listener grab those instead of the real /bal reply.
if (isMoney && /shards|coins/i.test(text)) return
const match = text.match(regex)
if (match) finish(parseFloat(match[1].replace(/,/g, '')))
} catch (_) {}
}

// Resolve immediately if the bot disconnects while waiting
const onEnd = () => finish(null)

const timer = setTimeout(() => finish(null), timeoutMs)
bot.on('message', onMessage)
bot.on('end', onEnd)
try { bot.chat(command) } catch (_) { finish(null) }
})
}

// ── /overview rank detection ──────────────────────────────────────────────
// /fix is the ONLY probe: access denied ⇒ Member, cooldown ⇒ N/A, anything
// else ("cannot be repaired", ERROR, …) ⇒ Regent. RANK_COOLDOWN_MS (default
// 4.5s) is waited before /fix so the balance-query cooldown has worn off.
function listenForRankReply (bot, command, ms, classify) {
  return new Promise((resolve) => {
    const lines = []
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      bot.removeListener('message', onMessage)
      bot.removeListener('end', onEnd)
      clearTimeout(timer)
      resolve(value)
    }
    const onMessage = (jsonMsg) => {
      try {
        const text = jsonMsg.toString()
        if (classify) {
          const verdict = classify(text)
          if (verdict) { finish({ lines, verdict }); return }
        }
        lines.push(text)
      } catch (_) {}
    }
    const onEnd = () => finish({ lines, verdict: null })
    const timer = setTimeout(() => finish({ lines, verdict: null }), ms)
    bot.on('message', onMessage)
    bot.on('end', onEnd)
    try { bot.chat(command) } catch (_) { finish({ lines, verdict: null }) }
  })
}

async function queryRank (id) {
  const entry = bots[id]
  if (!entry?.bot?.entity) return null
  const bot = entry.bot
  const classifyFix = (text) => {
    if (RANK_COOLDOWN_PATTERN.test(text)) return 'cooldown'
    if (RANK_MEMBER_PATTERNS.some(re => re.test(text))) return 'member'
    return null
  }

  // The balance queries that ran just before this fired three commands
  // back-to-back — wait out the server cooldown BEFORE /fix, otherwise the
  // server answers "you are on cool down" and the rank comes back N/A.
  await new Promise(resolve => setTimeout(resolve, RANK_COOLDOWN_MS))
  if (!bot.entity) return null

  // /fix is the ONLY probe: access denied ⇒ Member, rate-limited ⇒ N/A, any
  // other reply (including "Error: This item cannot be repaired") means the
  // bot passed the /fix rank gate ⇒ Regent.
  const fix = await listenForRankReply(bot, RANK_FIX_COMMAND, RANK_REPLY_TIMEOUT_MS, classifyFix)
  if (fix.verdict === 'member') return 'Member'
  if (fix.verdict === 'cooldown') return 'N/A'
  return bot.entity ? 'Regent' : null
}

// ── Command router (real tail + context routing prologue for the web GUI) ────
function handleCommand(raw, ctx) {
const trimmed = String(raw ?? '').trim()
if (!trimmed) return

// ── Context routing (added for the web GUI) ───────────────────────────────
// The TUI calls handleCommand(trimmed) and the "active bot" is the global
// activeId, exactly like the original. A web client calls
// handleCommand(text, { selectedId }) so commands typed while viewing a
// specific bot act on THAT bot — without touching the global activeId the
// TUI (or other browser tabs) see. The shadowed helpers below route all of
// this command's output (including async continuations like /overview's)
// into the commanding context's channel.
const requestedId = ctx && ctx.selectedId
// Never silently send a stale tab's command to a different bot.
if (requestedId && !Object.hasOwn(bots, requestedId) && !/^\/switch(?:\s|$)/.test(trimmed)) {
logFor(SYSTEM_ID, `{yellow-fg}⚠ Bot "${sanitize(requestedId)}" no longer exists.{/yellow-fg}`)
return
}
const ctxId = requestedId || null
const activeId = ctxId || currentActiveId() // shadows the global for this invocation
const log = (msg) => logFor(activeId || SYSTEM_ID, msg)
const logInfo = (msg) => logFor(activeId || SYSTEM_ID, `{cyan-fg}› ${msg}{/cyan-fg}`)
const logSuccess = (msg) => logFor(activeId || SYSTEM_ID, `{green-fg}✓ ${msg}{/green-fg}`)
const logWarn = (msg) => logFor(activeId || SYSTEM_ID, `{yellow-fg}⚠ ${msg}{/yellow-fg}`)
const logError = (msg) => logFor(activeId || SYSTEM_ID, `{red-fg}✗ ${msg}{/red-fg}`)

// Echo the run command so the log is self-documenting (the web console needs it)
log(`{bold}{green-fg}❯ ${sanitize(trimmed)}{/green-fg}{/bold}`)

// ── /all and /all-slow ───────────────────────
const broadcastMatch = trimmed.match(/^\/(all|all-slow)(?:\s+([\s\S]*))?$/)
if (broadcastMatch) {
const command = '/' + broadcastMatch[1]
const msg = (broadcastMatch[2] || '').trim()
if (!msg) { logWarn(`Usage: ${command} <command or message>`); return }
const baseCmd = msg.split(/\s+/)[0]
const isLocal = LOCAL_COMMANDS.includes(baseCmd)
const ids = Object.keys(bots)
const dispatch = id => {
if (!bots[id]) return false

// Manual commands route per bot through their own router (e.g. /all /manual-stop).
if (manual.routeCommand(msg, id)) return true

if (isLocal) {
// Reuse the single-bot router so arguments (e.g. /crates purple) survive.
handleCommand(msg, { selectedId: id })
return true
}
if (!bots[id].bot?.entity) return false
bots[id].bot.chat(msg)
return true
}
const onError = (err, id) => logWarn(`${id}: ${sanitize(err.message)}`)
if (command === '/all-slow') {
if (slowBroadcast.running) { logWarn('An /all-slow broadcast is already running. Wait for it to finish.'); return }
logInfo(`Slow broadcast to ${ids.length} bot(s), ${ALL_SLOW_DELAY_MS / 1000}s apart: ${sanitize(msg)}`)
slowBroadcast.start(ids, ALL_SLOW_DELAY_MS, dispatch, {
onError,
onDone: ({ sent, skipped }) => logSuccess(`Slow broadcast finished: ${sent} dispatched, ${skipped} skipped/failed.`)
})
} else {
let sent = 0
for (const id of ids) {
try { if (dispatch(id)) sent++ } catch (err) { onError(err, id) }
}
logSuccess(`${isLocal ? 'Ran locally on' : 'Broadcasted to'} ${sent} bots.`)
}
return
}

// ── /overview ───────────────────────────────
if (trimmed === '/overview') {
const names = Object.keys(bots)
logInfo('{bold}── Bot Overview Dashboard ──{/bold}')
logInfo('Querying shards, coins, balance, and rank…')

Promise.all(names.map(name => {
if (!bots[name]?.bot?.entity) return Promise.resolve({ name, shards: null, coins: null, money: null, rank: null })
return Promise.all([
queryBalance(name, 'Shards', '/shards'),
queryBalance(name, 'Coins', '/coins'),
queryBalance(name, 'Balance', '/bal')
]).then(([shards, coins, money]) =>
// Rank detection runs after the balances settle so its /fix + /rank land
// RANK_COOLDOWN_MS (4.5s) apart — safe from the server's command cooldown.
queryRank(name).then(rank => ({ name, shards, coins, money, rank }))
)
})).then(results => {
results.forEach(({ name, shards, coins, money, rank }, idx) => {
const b = bots[name]
if (b?.bot?.entity) {
const hp = Math.round(b.bot.health || 0)
const food = Math.round(b.bot.food || 0)
const ping = b.bot.player?.ping ?? '?'
const sh = shards !== null ? shards.toLocaleString() : 'N/A'
const co = coins !== null ? coins.toLocaleString() : 'N/A'
const mo = money !== null ? `$${money.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/A'
const rk = rank || 'N/A'
log(`[${idx + 1}] {cyan-fg}${name}{/cyan-fg} : {green-fg}Online{/green-fg} | HP: ${hp} | Food: ${food} | Ping: ${ping}ms | Rank: ${rk} | Shards: ${sh} | Coins: ${co} | Balance: ${mo}`)
} else {
log(`[${idx + 1}] {cyan-fg}${name}{/cyan-fg} : {gray-fg}Offline / Connecting…{/gray-fg}`)
}
})
}).catch(err => logError(`Overview failed: ${sanitize(err.message)}`))
return
}

// ── /list ───────────────────────────────────
if (trimmed === '/list') {
const names = Object.keys(bots)
logInfo(`{bold}── Bots (${names.length}) ──{/bold}`)
names.forEach((name, idx) => {
const b = bots[name]
if (b?.bot?.entity) {
const up = formatUptime(b.spawnTime ? Date.now() - b.spawnTime : 0)
log(` [${idx + 1}] {cyan-fg}${name}{/cyan-fg} {green-fg}● Online{/green-fg} (${up})`)
} else {
const kick = b?.lastKickReason ? ` — last kick: ${sanitize(b.lastKickReason).slice(0, 60)}` : ''
log(` [${idx + 1}] {cyan-fg}${name}{/cyan-fg} {red-fg}○ Offline{/red-fg}${kick}`)
}
})
return
}

// ── /uptime ─────────────────────────────────
if (trimmed === '/uptime') {
const names = Object.keys(bots)
logInfo('{bold}── Uptime ──{/bold}')
names.forEach((name, idx) => {
const b = bots[name]
const up = (b?.bot?.entity && b.spawnTime) ? formatUptime(Date.now() - b.spawnTime) : '{gray-fg}offline{/gray-fg}'
log(` [${idx + 1}] {cyan-fg}${name}{/cyan-fg} — ${up}`)
})
return
}

// ── /proxy ──────────────────────────────────
if (trimmed === '/proxy') {
if (PROXY_GROUPS_ENABLED) {
logInfo(`{bold}Dedicated proxy groups:{/bold} ${PROXY_GROUPS.length} configured`)
PROXY_GROUPS.forEach(g => logInfo(`  [${g.index}] ${g.bots.join(', ')} → ${g.type.toUpperCase()} ${g.host}:${g.port}`))
logInfo(PROXY_DEFAULT ? `  (other bots) → ${PROXY_DEFAULT.type.toUpperCase()} ${PROXY_DEFAULT.host}:${PROXY_DEFAULT.port}` : '  (other bots) → direct connection')
}
if (PROXY_ENABLED) {
logInfo(`{bold}Outbound proxy:{/bold} ${PROXY_TYPE.toUpperCase()} ${PROXY_HOST}:${PROXY_PORT} (applies to all bots without a dedicated group)`)
if (PROXY_STALL_ENABLED) {
const restartInfo = PROXY_RESTART_CMD ? `restart cmd: "${PROXY_RESTART_CMD}"` : 'no restart cmd (proxy isn\'t local — set PROXY_RESTART_CMD in .env if you want auto-restart)'
logInfo(`{bold}Stall watchdog:{/bold} on — stall timeout ${(PROXY_STALL_TIMEOUT_MS / 1000).toFixed(0)}s, checked every ${(PROXY_STALL_CHECK_MS / 1000).toFixed(0)}s, ${restartInfo}`)
} else {
logInfo('{bold}Stall watchdog:{/bold} off (set PROXY_STALL_WATCHDOG=1, or unset PROXY_STALL_WATCHDOG=0, in .env)')
}
} else if (!PROXY_GROUPS_ENABLED) {
logInfo('No outbound proxy configured — bots connect directly. Set PROXY_HOST or PROXY_GROUP_1_* in .env to enable one.')
}
return
}

// ── /stats (added) ──────────────────────────
if (trimmed === '/stats') {
const s = globalStats()
const mem = s.memory
const hostMem = mem && mem.availablePct != null ? ` · host RAM free ${mem.availablePct.toFixed(1)}% · swap ${mem.swapPct.toFixed(1)}% · pressure ${mem.level}` : ''
logInfo(`Runtime: RSS ${s.rssMB}MB · heap ${s.heapMB}MB · event-loop lag ${s.evlLagMs}ms · logs ${s.logPerSec}/s · web viewers ${s.clients} · bots ${s.online}/${s.bots} online · uptime ${formatUptime(s.uptimeSec * 1000)}${hostMem}`)
return
}

// ── /reconnect-all ──────────────────────────
if (trimmed === '/reconnect-all') {
let count = 0
Object.entries(bots).forEach(([id, entry]) => {
if (!entry.bot?.entity) {
const { host, port, version } = entry
try { entry.disconnectManually() } catch (_) {}
setTimeout(() => createBotInstance(id, host, port, version), 1000 + count * 2000)
count++
}
})
if (count === 0) logInfo('All bots are already online.')
else logSuccess(`Reconnecting ${count} offline bot(s)…`)
return
}

// ── /reconnect-all-slow ─────────────────────
if (trimmed === '/reconnect-all-slow') {
let count = 0
const delayMs = parseInt(process.env.RECONNECT_SLOW_DELAY_MS || '30000', 10)
Object.entries(bots).forEach(([id, entry]) => {
const { host, port, version } = entry
setTimeout(() => {
logInfo(`{yellow-fg}⚠ Staggered reconnect: disconnecting ${id}…{/yellow-fg}`)
try { entry.disconnectManually() } catch (_) {}
setTimeout(() => createBotInstance(id, host, port, version), 1000)
}, count * delayMs)
count++
})
logSuccess(`Staggered reconnect started for ${count} bot(s) (${delayMs / 1000}s apart)…`)
return
}

// ── /chat ───────────────────────────────────
if (trimmed.startsWith('/chat ')) {
const msg = trimmed.slice(6).trim()
if (!activeId) { logWarn('No active bot.'); return }
if (!msg) { logWarn('Usage: /chat <message>'); return }
// /-prefixed server commands (e.g. /chat /shardshop) often open a GUI — arm
// the manual-window suppression so the automatic slot-scan/click and the
// delayed AFK warp don't fire on the window they open.
if (msg.startsWith('/') && bots[activeId] && typeof manual.armWindowSuppression === 'function') {
manual.armWindowSuppression(bots[activeId])
}
try { bots[activeId].bot.chat(msg) } catch (err) { logError(`Chat failed: ${sanitize(err.message)}`); return }
log(`{green-fg}❯{/green-fg} Chat: ${sanitize(msg)}`)
return
}

// ── /new-bot ────────────────────────────────
if (trimmed.startsWith('/new-bot ')) {
const args = trimmed.slice(9).trim().split(/\s+/).filter(Boolean)
const username = args[0]
if (!username) { logWarn('Usage: /new-bot <username> [host] [port] [version]'); return }
if (bots[username]) { logWarn(`Bot "${username}" already exists.`); return }
const h = args[1] || HOST
const p = args[2] ? parseInt(args[2], 10) : PORT
const v = args[3] || VERSION
logInfo(`Creating new bot: ${username} @ ${h}:${p} (v${v})`)
createBotInstance(username, h, p, v)
return
}

// ── /switch ─────────────────────────────────
if (trimmed === '/switch' || trimmed.startsWith('/switch ')) {
const arg = trimmed.slice(7).trim()
if (!arg) { logWarn('Usage: /switch <bot name or number>'); return }
const names = Object.keys(bots)
const targetId = /^\d+$/.test(arg) ? names[Number(arg) - 1] : arg
if (!targetId || !Object.hasOwn(bots, targetId)) {
logWarn(/^\d+$/.test(arg) ? `No bot at index [${arg}]. Valid: 1–${names.length}` : `No bot named "${sanitize(arg)}".`)
return
}
// A browser owns its selection; do not change the TUI or another tab.
if (ctx && typeof ctx.selectBot === 'function') ctx.selectBot(targetId)
else switchTo(targetId)
return { selectedId: targetId }
}

// ── /crates [color] ───
if (trimmed === '/crates' || trimmed.startsWith('/crates ')) {
if (!activeId) { logWarn('No active bot.'); return }
const arg = trimmed.slice('/crates'.length).trim()
const entry = bots[activeId]
if (!entry?.bot?.entity) { logWarn(`${activeId} is not currently spawned.`); return }
let blockName = CRATE_SHULKER_BLOCK
if (arg) {
const resolved = resolveCrateBlockName(arg)
if (!resolved) { logWarn(`Unknown crate color "${arg}". Try one of: ${SHULKER_COLORS.join(', ')} — or a full block name like "purple_shulker_box".`); return }
blockName = resolved
}
runCrateRoutine(activeId, blockName)
return
}

// ── /crates-loop [n] [color] ───
if (trimmed === '/crates-loop' || trimmed.startsWith('/crates-loop ')) {
if (!activeId) { logWarn('No active bot.'); return }
const parts = trimmed.slice('/crates-loop'.length).trim().split(/\s+/).filter(Boolean)
let count = Infinity
if (parts.length && /^\d+$/.test(parts[0])) count = parseInt(parts.shift(), 10)
if (count <= 0) { logWarn('Usage: /crates-loop [n] [color] — n must be a positive number'); return }
let blockName = CRATE_SHULKER_BLOCK
if (parts.length) {
const resolved = resolveCrateBlockName(parts.shift())
if (!resolved) { logWarn(`Unknown crate color. Try one of: ${SHULKER_COLORS.join(', ')} — or a full block name like "purple_shulker_box".`); return }
blockName = resolved
}
if (parts.length) { logWarn('Usage: /crates-loop [n] [color]'); return }
const entry = bots[activeId]
if (!entry?.bot?.entity) { logWarn(`${activeId} is not currently spawned.`); return }
runCrateLoop(activeId, count, blockName)
return
}

// ── /shardshop-loop ───
if (trimmed === '/shardshop-loop') {
if (!activeId) { logWarn('No active bot.'); return }
const entry = bots[activeId]
if (!entry?.bot?.entity) { logWarn(`${activeId} is not currently spawned.`); return }
shardshopLoopCommand(activeId)
return
}

// ── /crates-all [n] [color] ───
if (trimmed === '/crates-all' || trimmed.startsWith('/crates-all ')) {
const parts = trimmed.slice('/crates-all'.length).trim().split(/\s+/).filter(Boolean)
let maxBots = Infinity
if (parts.length && /^\d+$/.test(parts[0])) maxBots = parseInt(parts.shift(), 10)
if (maxBots <= 0) { logWarn('Usage: /crates-all [n] [color] — n must be a positive number'); return }
let blockName
if (parts.length) {
blockName = resolveCrateBlockName(parts.shift())
if (!blockName) { logWarn(`Unknown crate color. Try one of: ${SHULKER_COLORS.join(', ')} — or a full block name like "purple_shulker_box".`); return }
}
if (parts.length) { logWarn('Usage: /crates-all [n] [color]'); return }
runCratesAll(maxBots, blockName)
return
}

// ── /crates-solo [bot] [color] — same shardshop → crates → dump chain as /crates-all,
// but for exactly ONE bot (default: the active one) instead of the whole roster ──
if (trimmed === '/crates-solo' || trimmed.startsWith('/crates-solo ')) {
const parts = trimmed.slice('/crates-solo'.length).trim().split(/\s+/).filter(Boolean)
let targetId = activeId

// First token: a bot ref (number or exact existing bot name) if it matches one,
// otherwise it's treated as the color and targetId falls back to the active bot.
if (parts.length) {
if (/^\d+$/.test(parts[0])) {
const names = Object.keys(bots)
const idx = parseInt(parts[0], 10) - 1
targetId = names[idx]
if (!targetId) { logWarn(`No bot at index [${parts[0]}]. Valid: 1–${names.length}`); return }
parts.shift()
} else if (bots[parts[0]]) {
targetId = parts.shift()
}
}

let blockName
if (parts.length) {
blockName = resolveCrateBlockName(parts.shift())
if (!blockName) { logWarn(`Unknown crate color. Try one of: ${SHULKER_COLORS.join(', ')} — or a full block name like "purple_shulker_box".`); return }
}
if (parts.length) { logWarn('Usage: /crates-solo [bot name or number] [color]'); return }

if (!targetId) { logWarn('No active bot. Usage: /crates-solo [bot name or number] [color]'); return }
if (!bots[targetId]) { logWarn(`No bot named "${sanitize(targetId)}".`); return }

logInfo(`Starting /crates-solo (shardshop → crates → dump) for ${targetId}${blockName ? ` targeting ${blockName.replace(/_/g, ' ')}` : ''}…`)
runCratesAllSequenceForBot(targetId, blockName)
return
}

// ── Manual interaction commands (bot-manual.js) ─────────────
// After the crate/shardshop parsing above but before the local-command switch
// and the raw Minecraft chat fallback, so /walk, /window-*, /key etc. never
// leak to the server as chat.
if (manual.routeCommand(trimmed, activeId)) return

// ── Single-bot local commands ───────────────
if (activeId && LOCAL_COMMANDS.includes(trimmed)) {
runLocalCommandForBot(activeId, trimmed)
return
}

switch (trimmed) {
case '/help':
logInfo('{bold}Available commands:{/bold}')
Object.entries(COMMANDS).forEach(([cmd, desc]) => log(` {cyan-fg}${cmd}{/cyan-fg} — ${desc}`))
break

case '/exit':
logWarn('Exiting all bots…')
slowBroadcast.cancel()
initialConnectTimers.forEach(clearTimeout)
initialConnectTimers.length = 0
Object.values(bots).forEach(entry => { try { entry.disconnectManually() } catch (_) {} })
setTimeout(() => process.exit(0), 300)
break

default:
if (!activeId) { logWarn('No active bot.'); break }
try { bots[activeId].bot.chat(trimmed) } catch (err) { logError(`Chat failed: ${sanitize(err.message)}`); break }
log(`{green-fg}❯{/green-fg} Sent: ${sanitize(trimmed)}`)
}
}

// ── Interface startup ─────────────────────────────────────────────────────────
tui = startTUI()
webHandle = startWebGUI()

if (tui || webHandle) {
installConsolePlumbing()
} else {
// No interface at all — plain stdout logging so it's never silent
subscribeLog((id, line) => { try { process.stdout.write(stripTags(line) + '\n') } catch (_) {} })
}
