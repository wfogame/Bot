require('dotenv').config()          // npm install dotenv
const net = require('net')
const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')
const mineflayer = require('mineflayer')
const blessed = require('neo-blessed')
const armorManager = require('mineflayer-armor-manager')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
let SocksClient
try { ({ SocksClient } = require('socks')) } catch (_) { /* only needed if PROXY_HOST is set and PROXY_TYPE=socks5 — npm install socks */ }

// ── .env config (with sane defaults) ──────────────────────────────────────────
const HOST             = process.env.HOST             || 'play.fatalmc.org'
const PORT             = parseInt(process.env.PORT    || '25565', 10)
const VERSION          = process.env.VERSION          || '1.21.2'
const LOGIN_PASSWORD   = process.env.LOGIN_PASSWORD   || '123456'
const BOT_NAMES        = (process.env.BOT_NAMES || '').split(',').map(n => n.trim()).filter(Boolean)
const CONNECT_DELAY_MS = parseInt(process.env.CONNECT_DELAY_MS || '39500', 10)
const MAX_RECONNECT     = parseInt(process.env.MAX_RECONNECT     || '17',   10)
const GUI_SLOT         = parseInt(process.env.GUI_SLOT         || '11', 10)
const WARP_AFK         = process.env.WARP_COMMAND || '/warp afk'

// ── GUI slot selection: fixed slot (default) vs. search-by-item (opt-in) ────
// By default the compass GUI always clicks GUI_SLOT. Set GUI_ITEM_SEARCH_ENABLED=true
// to instead scan every slot for an item matching GUI_ITEM_SEARCH_TERMS and click that
// slot when found, falling back to GUI_SLOT when no match is found (or when disabled).
//
// GUI_ITEM_SEARCH_TERMS syntax: ";" separates AND-groups, "|" separates OR-alternatives
// within a group — an item matches when EVERY group has at least one alternative present
// (case-insensitive substring match against its name/displayName). The default preserves
// the old hardcoded "Fatal Crate/Key" detection for anyone who turns this on without
// customizing it further.
//   e.g. "fatal|red;crate|key|candle"  →  (contains "fatal" OR "red") AND (contains "crate" OR "key" OR "candle")
const GUI_ITEM_SEARCH_ENABLED = /^(1|true|yes|on)$/i.test(process.env.GUI_ITEM_SEARCH_ENABLED || 'false')
const GUI_ITEM_SEARCH_TERMS   = process.env.GUI_ITEM_SEARCH_TERMS || 'fatal|red;crate|key|candle'
const GUI_ITEM_SEARCH_GROUPS  = GUI_ITEM_SEARCH_TERMS
  .split(';').map(g => g.trim()).filter(Boolean)
  .map(g => g.split('|').map(s => s.trim().toLowerCase()).filter(Boolean))
  .filter(g => g.length)

function itemMatchesSearchGroups(itemStr) {
  if (!GUI_ITEM_SEARCH_GROUPS.length) return false
  return GUI_ITEM_SEARCH_GROUPS.every(group => group.some(term => itemStr.includes(term)))
}

// ── /crates command config ─────────────────────────────────────────────────
// Set CRATE_COMMAND in .env to whatever command /crates should send to warp there
// (e.g. CRATE_COMMAND=/warp afk). Defaults to '/warp crates' if unset.
const WARP_CRATES         = process.env.CRATE_COMMAND || '/warp crates'
const CRATE_SHULKER_BLOCK = process.env.CRATE_SHULKER_BLOCK || 'red_shulker_box' // default crate color, used when no [color] arg is given
const CRATE_SCAN_RADIUS   = parseInt(process.env.CRATE_SCAN_RADIUS || '20', 10)
const CRATE_REACH         = parseFloat(process.env.CRATE_REACH || '3.5')

// ── Crate color customization ──────────────────────────────────────────────
// /crates, /crates-loop, /crates-all, and /crates-solo all accept an optional
// trailing [color] argument (e.g. "/crates purple") so a single bot roster can
// farm different crate colors without editing .env or restarting.
const SHULKER_COLORS = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink',
  'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'
]

// Resolves a user-typed color/block name to a real block id.
// Accepts "purple", "purple shulker box", or "purple_shulker_box" (case-insensitive).
// Returns null (not the default) when given something unrecognized, so callers can
// warn instead of silently farming the wrong crate.
function resolveCrateBlockName(input) {
  if (!input) return CRATE_SHULKER_BLOCK
  const norm = input.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (norm === 'shulker' || norm === 'shulker_box') return CRATE_SHULKER_BLOCK
  if (norm.endsWith('_shulker_box') && SHULKER_COLORS.includes(norm.replace('_shulker_box', ''))) return norm
  if (SHULKER_COLORS.includes(norm)) return `${norm}_shulker_box`
  return null
}

// ── /crates-all: shardshop → crates → dump chain across multiple bots ───────
const SHARDSHOP_COMMAND             = process.env.SHARDSHOP_COMMAND            || '/shardshop' // ⚠ verify this matches your server's actual shardshop command
const CRATES_ALL_STAGGER_MS         = parseInt(process.env.CRATES_ALL_STAGGER_MS        || '30000', 10) // delay between each bot starting its sequence
const CRATES_ALL_SHARDSHOP_WAIT_MS  = parseInt(process.env.CRATES_ALL_SHARDSHOP_WAIT_MS || '4000', 10)  // wait after shardshop before starting crates
const CRATES_ALL_STEP_WAIT_MS       = parseInt(process.env.CRATES_ALL_STEP_WAIT_MS      || '3000', 10)  // wait after crates before dump

// ── /shardshop-loop: keep running /shardshop until the server says there's nothing left ──
// Grepped case-insensitively against a configurable, comma-separated phrase list. Default
// covers "insufficent fund" (matches both "insufficent fund"/"insufficent funds" as a
// substring) plus the correctly-spelled "insufficient fund" as a fallback in case the server
// doesn't have the typo. Adjust SHARDSHOP_STOP_PHRASES in .env if your server's wording differs.
const SHARDSHOP_STOP_PHRASES    = (process.env.SHARDSHOP_STOP_PHRASES || 'insufficent fund,not enough,insufficient fund,no more shards,more shards')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
const SHARDSHOP_LOOP_DELAY_MS   = parseInt(process.env.SHARDSHOP_LOOP_DELAY_MS   || '4200',  10) // gap between each /shardshop send
const SHARDSHOP_LOOP_TIMEOUT_MS = parseInt(process.env.SHARDSHOP_LOOP_TIMEOUT_MS || '60000', 10) // safety ceiling if the server never replies with a stop phrase
const SHARDSHOP_LOOP_MAX_RUNS   = parseInt(process.env.SHARDSHOP_LOOP_MAX_RUNS   || '200',   10) // hard cap on sends so a phrase mismatch can't loop forever

// ── Outbound proxy config ──────────────────────────────────────────────────────
// Every bot's Minecraft TCP connection is routed through this single shared
// proxy when PROXY_HOST is set. Leave PROXY_HOST empty/unset to connect
// directly (default, unchanged behavior). const PROXY_HOST       = process.env.PROXY_HOST       || ''

const PROXY_HOST       = process.env.PROXY_HOST       || ''
const PROXY_ENABLED    = Boolean(PROXY_HOST)
const PROXY_PORT       = parseInt(process.env.PROXY_PORT || '1080', 10)
const PROXY_TYPE       = (process.env.PROXY_TYPE || 'socks5').toLowerCase()

// ── Proxy stall watchdog ────────────────────────────────────────────────────
// A stalled Tor circuit (or any proxy) often does NOT throw an error or close
// the socket — it just stops delivering bytes. mineflayer/node-minecraft-protocol
// has no idea anything is wrong in that case, so the normal 'end'/'error'-driven
// reconnect logic never fires and a bot just sits there silently dead.
// We track the last time each bot actually received a packet, and if a spawned
// bot goes quiet for too long, we force-kill its socket so the existing
// scheduleReconnect() path takes over. If MOST bots go quiet at the same time,
// that points at the shared proxy itself (not any one bot) — in that case we
// optionally restart the local proxy service before forcing reconnects.
const PROXY_STALL_ENABLED       = PROXY_ENABLED && process.env.PROXY_STALL_WATCHDOG !== '0'
const PROXY_STALL_TIMEOUT_MS    = parseInt(process.env.PROXY_STALL_TIMEOUT_MS || '90000', 10)   // no packets for this long while spawned = assume stalled
const PROXY_STALL_CHECK_MS      = parseInt(process.env.PROXY_STALL_CHECK_MS   || '20000', 10)   // how often to scan for stalls
const PROXY_STALL_RATIO         = parseFloat(process.env.PROXY_STALL_RATIO    || '0.5')          // fraction of spawned bots stalling at once => treat as shared-proxy failure
const PROXY_IS_LOCAL            = /^(127\.0\.0\.1|localhost|::1)$/i.test(PROXY_HOST)
const PROXY_RESTART_CMD         = process.env.PROXY_RESTART_CMD || (PROXY_IS_LOCAL ? 'brew services restart tor' : '')
const PROXY_RESTART_COOLDOWN_MS = parseInt(process.env.PROXY_RESTART_COOLDOWN_MS || '120000', 10) // don't restart more than once per this window
let lastProxyRestart = 0
// ── Velocity / BungeeCord proxy crash detection ───────────────────────────────
// When a Velocity proxy transfers a player between backend servers, mineflayer's
// protocol layer can receive partial / malformed packets mid-transfer.  This
// causes deserialization errors, zlib failures, or abrupt socket resets that
// look like crashes but are actually recoverable — just reconnect fast.
//
// We match error messages against these patterns to distinguish "proxy transfer
// crash" (fast 3 s reconnect, no backoff) from "real kick" (exponential backoff).
// NOTE: this is unrelated to PROXY_HOST/PROXY_PORT above — this section is about
// the Minecraft server's own backend proxy (Velocity/Bungee), not our outbound
// SOCKS5/HTTP proxy.
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
  /Cannot read propert/i,        // "Cannot read properties of null" from half-torn-down state
  /pre-spawn socketClosed/i,     // synthetic marker (set in the 'end' handler below) for a silent
                                  // socket close with no kick/error text, before the bot ever spawned —
                                  // the signature of a Tor/SOCKS5 circuit dying under the post-login data burst
]
const FAST_RECONNECT_MS = 10400        // flat delay for proxy transfer crashes
const RECONNECT_BASE_MS = 10400        // base delay for real kicks / errors
const RECONNECT_MAX_MS  = 5 * 60_000  // ceiling for exponential backoff

if (BOT_NAMES.length === 0) {
  console.error('No BOT_NAMES defined in .env — nothing to connect.')
  process.exit(1)
}

// ── Outbound proxy tunnelling ──────────────────────────────────────────────────
// node-minecraft-protocol (which mineflayer builds on) lets you override how the
// raw socket is opened via the `connect` option passed to createBot/createClient.
// We use that hook to tunnel every bot's connection through a single SOCKS5 or
// HTTP CONNECT proxy instead of dialing the Minecraft server directly.
//
// Important: because the tunnel socket is already open by the time we hand it
// to the client, the underlying socket's native 'connect' event has already
// fired and won't fire again — so we must manually emit 'connect' on the
// client itself to kick off the handshake/login sequence.
function makeSocksConnect(targetHost, targetPort, onLog) {
  return (client) => {
    if (!SocksClient) {
      client.emit('error', new Error('PROXY_TYPE=socks5 requires the "socks" package — run: npm install socks'))
      client.emit('end', 'Missing socks package')
      return
    }
    onLog?.(`Tunnelling through SOCKS5 proxy ${PROXY_HOST}:${PROXY_PORT}…`)
    SocksClient.createConnection({
      proxy: { host: PROXY_HOST, port: PROXY_PORT, type: 5 },
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

function makeHttpConnect(targetHost, targetPort, onLog) {
  return (client) => {
    onLog?.(`Tunnelling through HTTP proxy ${PROXY_HOST}:${PROXY_PORT}…`)
    const socket = net.connect(PROXY_PORT, PROXY_HOST, () => {
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

      // Any bytes after the CONNECT response headers are already Minecraft
      // protocol data trickling in — push them back onto the socket before
      // handing it off so nothing gets lost.
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

function makeProxyConnect(targetHost, targetPort, onLog) {
  if (!PROXY_ENABLED) return undefined
  return PROXY_TYPE === 'http'
    ? makeHttpConnect(targetHost, targetPort, onLog)
    : makeSocksConnect(targetHost, targetPort, onLog)
}

// ── Global crash guards ───────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  try { 
    const text = err.stack ? err.stack : err.message;
    logBox.log(`{red-fg}[UNCAUGHT] ${sanitize(text)}{/red-fg}`); 
    debouncedRender() 
  }
  catch (_) { /* blessed may not be ready */ }
})
process.on('unhandledRejection', (reason) => {
  try {
    const msg = reason instanceof Error ? reason.message : String(reason)
    logBox.log(`{red-fg}[UNHANDLED REJECTION] ${sanitize(msg)}{/red-fg}`); debouncedRender()
  } catch (_) {}
})

// ── Blessed tag sanitiser ─────────────────────────────────────────────────────
// Player names / chat / errors can contain {curly braces} that blessed parses
// as formatting tags → crash.  We escape everything except our own known tags.
const KNOWN_TAG_RE = /\{(\/?(bold|underline|blink|inverse|red|green|blue|cyan|magenta|yellow|white|gray|grey|black|center|left|right)(-fg|-bg)?)\}/g
const MAX_SANITIZED_LENGTH = 4000 // hard cap — some servers send oversized/malformed chat as a client-crashing trick
function sanitize(str) {
  if (typeof str !== 'string') str = String(str ?? '')
  if (str.length > MAX_SANITIZED_LENGTH) {
    str = str.slice(0, MAX_SANITIZED_LENGTH) + ` …[truncated, ${str.length - MAX_SANITIZED_LENGTH} more chars]`
  }
  const tags = []
  const safe = str.replace(KNOWN_TAG_RE, (m) => { tags.push(m); return `\x00T${tags.length - 1}\x00` })
  const escaped = safe.replace(/[{}]/g, c => '\\' + c)
  return escaped.replace(/\x00T(\d+)\x00/g, (_, i) => tags[+i])
}

// ── TUI setup ─────────────────────────────────────────────────────────────────
const screen = blessed.screen({ smartCSR: true, title: 'Mineflayer AFK Console', fullUnicode: true })

// Debounced render — the single biggest fix for input lag.
// Without this, every chat line from 14 bots triggers a full synchronous repaint.
let renderQueued = false
function debouncedRender() {
  if (renderQueued) return
  renderQueued = true
  setImmediate(() => {
    renderQueued = false
    try {
      screen.render()
    } catch (err) {
      // Render itself failed — don't route this through logBox/console (that's what
      // just broke), write straight to the real fd so it doesn't loop or get lost.
      try { require('fs').writeSync(2, `[render error] ${err && err.message}\n`) } catch (_) {}
    }
  })
}

const header = blessed.box({
  top: 0, left: 0, width: '100%', height: 3,
  content: '{center}{bold}⛏  MINEFLAYER AFK CONSOLE{/bold}{/center}',
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

// Redirect native output into the log box — nothing leaks to raw terminal
process.stderr.write = (chunk) => {
  try {
    const text = (typeof chunk === 'string' ? chunk : chunk.toString('utf8')).trim()
    if (text) logBox.log(`{gray-fg}[stderr] ${sanitize(text)}{/gray-fg}`)
    debouncedRender()
  } catch (_) {}
  return true
}
console.log   = (...a) => { logBox.log(`{gray-fg}${sanitize(a.join(' '))}{/gray-fg}`);            debouncedRender() }
console.warn  = (...a) => { logBox.log(`{yellow-fg}[warn] ${sanitize(a.join(' '))}{/yellow-fg}`);  debouncedRender() }
console.error = (...a) => { logBox.log(`{red-fg}[error] ${sanitize(a.join(' '))}{/red-fg}`);       debouncedRender() }

screen.key(['C-c'], () => process.exit(0))

// Automatically refocus the input box if the user clicks the log box
logBox.on('click', () => {
  inputBox.focus()
})

// Automatically refocus if the user starts typing while defocused
screen.on('keypress', (ch, key) => {
  if (key && key.ctrl && key.name === 'c') return // preserve ctrl+c
  if (!inputBox.focused) {
    inputBox.focus()
    // If they typed a normal character, add it so it doesn't get lost
    if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
      inputBox.setValue(inputBox.getValue() + ch)
    }
    screen.render()
  }
})

function timestamp() {
  return `{gray-fg}${new Date().toLocaleTimeString()}{/gray-fg}`
}

// ── Multi-bot state ───────────────────────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - (20 * 60 * 1000) // 20 minutes ago
  Object.values(bots).forEach(botState => {
    // Filter out anything older than the cutoff
    botState.logs = botState.logs.filter(log => log.time > cutoff)
  })
}, 60000) // Runs once every 60 seconds
const bots = {}       // username → { bot, spawnTime, logs[], host, port, version, reconnectAttempts, … }
let activeId = null
const MAX_LOG_LINES = 5000

function updateHeader() {
  const names = Object.keys(bots)
  const activeIndex = names.indexOf(activeId) + 1
  const activeLabel = activeId ? `Active: [${activeIndex}] ${activeId}` : 'No active bot'
  const others = names.map((n, i) => i !== (activeIndex - 1) ? `[${i + 1}] ${n}` : null).filter(Boolean)
  const othersLabel = others.length ? `  |  Others: ${others.join(', ')}` : ''
  const proxyLabel = PROXY_ENABLED ? `   —   Proxy: ${PROXY_TYPE.toUpperCase()} ${PROXY_HOST}:${PROXY_PORT}` : ''
  header.setContent(`{center}{bold}⛏  MINEFLAYER AFK CONSOLE{/bold}   —   ${activeLabel}${othersLabel}${proxyLabel}{/center}`)
  debouncedRender()
}

function switchTo(id) {
  if (!bots[id]) { log(`{red-fg}✗ No bot named "${sanitize(id)}"{/red-fg}`); return }
  activeId = id
  
  logBox.setContent('')
  logBox.scrollTo(0)
  
  // Map the objects back to strings to render them
  if (bots[id].logs.length > 0) {
    logBox.setContent(bots[id].logs.map(l => l.text).join('\n'))
  }
  
  updateHeader()
  const bottom = logBox.getScrollHeight()
  if (bottom > 0) logBox.scrollTo(bottom)
  debouncedRender()
}

function logFor(id, msg) {
  if (!bots[id]) return
  
  const line = `${timestamp()} ${msg}`
  
  // Store as an object with a timestamp
  bots[id].logs.push({ text: line, time: Date.now() })
  if (bots[id].logs.length > MAX_LOG_LINES) bots[id].logs.splice(0, bots[id].logs.length - MAX_LOG_LINES)
  
  if (id === activeId) { 
    logBox.log(line)
    debouncedRender() 
  }
}
function log(msg)        { if (activeId) logFor(activeId, msg) }
function logSuccess(msg) { log(`{green-fg}✓ ${msg}{/green-fg}`) }
function logError(msg)   { log(`{red-fg}✗ ${msg}{/red-fg}`) }
function logInfo(msg)    { log(`{cyan-fg}› ${msg}{/cyan-fg}`) }
function logWarn(msg)    { log(`{yellow-fg}⚠ ${msg}{/yellow-fg}`) }

// ── Bot creation ──────────────────────────────────────────────────────────────
function clearReconnectTimer(id) {
  const entry = bots[id]
  if (entry?.reconnectTimer) {
    clearTimeout(entry.reconnectTimer)
    entry.reconnectTimer = null
  }
}

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
      connect: makeProxyConnect(host, port, i)
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
    lastDisconnectReason: null,     // stores raw error text for transfer-crash classification
    crateRoutineRunning: false,     // prevents concurrent /crates runs
    inCrateRoutine: false,          // suppresses windowOpen handler during /crates
    shardshopLoopRunning: false,    // prevents concurrent /shardshop-loop runs
    lastActivity: Date.now(),       // updated on every inbound packet — used by the proxy stall watchdog
    forceKilled: false,             // set by the watchdog so scheduleReconnect logs it distinctly
    manualDisconnect: false         // mirrors the closure-local flag so the watchdog (outside this closure) can see it too
  }

  // Any inbound packet (of any kind) proves the tunnel is actually delivering bytes.
  // This is the generic liveness signal the stall watchdog relies on.
  if (PROXY_STALL_ENABLED && bot._client) {
    bot._client.on('packet', () => {
      if (bots[id]) bots[id].lastActivity = Date.now()
    })
  }

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

    bot._client.on('state', (newState) => {
      logFor(id, `{magenta-fg}[state] -> ${newState}{/magenta-fg}`)
    })

    bot._client.on('packet', (data, meta) => {
      if (bot._client.state === 'configuration') {
        logFor(id, `{blue-fg}[config <-] ${meta.name}{/blue-fg}`)

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
      }
    })
    
    const origWrite = bot._client.write.bind(bot._client)
    bot._client.write = (name, params) => {
      if (bot._client.state === 'configuration') {
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
    if (bots[id]) bots[id].spawnTime = Date.now()
    s(`Spawned on ${host}:${port} (v${version}).`)

    // Stable for 60 s → reset backoff
    pushT(() => { if (connected && bots[id]) bots[id].reconnectAttempts = 0 }, 60_000)

    // Auto-equip best armor immediately on spawn
    pushT(() => {
      if (bot.entity) {
        try { bot.armorManager.equipAll() } catch (_) {}
      }
    }, 2000)
    if (process.env.CLICK_COMPASS) {
      pushT(() => {
        i('Right-clicking compass (server selector)…')
        try { bot.activateItem() } catch (err) { e(`activateItem failed: ${sanitize(err.message)}`) }
      }, 3600 + Math.random() * 600)
    }
  })
bot.on('windowOpen', (window) => {
  try {
    // Skip the GUI/Fatal Crate handler when a /crates routine opened this window
    if (bots[id]?.inCrateRoutine) return

    const title = window.title?.toString ? window.title.toString() : String(window.title || '')
    
    const getSafeItemString = (item) => {
      if (!item) return 'null';
      return `[Item ${item.displayName || item.name} x${item.count || 1}]`;
    };

    const slotInfo = window.slots.map((slot, index) => {
      return `Slot ${index}: ${getSafeItemString(slot)}`;
    }).join('\n');
    i(`Window opened: ${sanitize(title)}\n${sanitize(slotInfo)}`);

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
        if(!foundTargetItem ){
        i(`Clicked slot ${targetSlot} — waiting for server transfer…`)
        }else{
          i(`Clicked slot ${targetSlot} — matched configured item search`)
          }
      } catch (err) { e(`Click failed: ${sanitize(err.message || String(err))}`) }
    }, 2000 + Math.random() * 1600)

    // AFK Warp logic
    pushT(async () => {
        if(!foundTargetItem){
        bot.chat(WARP_AFK)
        i(`Warped — waiting for server transfer…`)
        }
    }, 54000 + Math.random() * 1600)

  } catch (err) { e(`windowOpen handler error: ${sanitize(err.message)}`) }
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
  })

  // ── Velocity / proxy packet-level error interception ────────────────────────
  // Mineflayer's high-level 'error' event only fires for some failures.
  // Protocol-layer crashes (partial packets, bad decompression) surface on the
  // raw _client *before* the bot 'end' event.  We catch them here to:
  //   1. Log them clearly instead of crashing
  //   2. Store the raw error so scheduleReconnect can classify it as a
  //      proxy transfer crash and use the fast reconnect path.
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
    const reasonText = reason ? String(reason) : ''
    w(`Disconnected${reasonText ? ': ' + sanitize(reasonText) : ''}.`)

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

    scheduleReconnect('Connection lost', classificationReason)
    lastRawError = null
  })

  bots[id].disconnectManually = () => {
    manualDisconnect = true
    if (bots[id]) {
      bots[id].manualDisconnect = true // let the watchdog (outside this closure) know this was intentional
      bots[id].spawnTime = null        // stop looking "spawned" to the watchdog now that we're intentionally offline
    }
    clearReconnectTimer(id)
    clearAll()
    try { bot.quit() } catch (_) {}
  }

  if (!activeId) activeId = id
  updateHeader()
  return bot
}

// ── Connect all bots with staggered delay ─────────────────────────────────────
BOT_NAMES.forEach((name, index) => {
  setTimeout(() => {
    createBotInstance(name)
    if (index === 0) switchTo(name)
  }, index * CONNECT_DELAY_MS)
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
      console.warn(`[proxy-watchdog] "${id}" has received nothing for ${Math.round((now - entry.lastActivity) / 1000)}s — forcing reconnect.`)
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

// ── Command registry ──────────────────────────────────────────────────────────
const COMMANDS = {
  '/all <cmd>':      'Run a local command on EVERY bot, or broadcast a raw chat/command to all',
  '/overview':       'Dashboard of every bot\'s health, food, ping, shards, coins, and balance',
  '/crates [color]':         `Warp to crates, find + walk to the nearest shulker box of [color] (default: ${CRATE_SHULKER_BLOCK.replace(/_/g, ' ')}, within ${CRATE_SCAN_RADIUS} blocks) and right-click it; falls back to ${WARP_AFK} if not found or unreachable. [color] can be a name like "purple" or a full block id like "purple_shulker_box"`,
  '/crates-loop [n] [color]': 'Run /crates repeatedly (default: until failure). Specify n for a fixed count and/or a crate [color]',
  '/shardshop-loop': `Repeatedly run ${SHARDSHOP_COMMAND} until the server signals it's empty (grep: SHARDSHOP_STOP_PHRASES) or hits the ${SHARDSHOP_LOOP_MAX_RUNS}-run safety cap`,
  '/crates-all [n] [color]': `Run shardshop → crates → dump on bots 1 through n (default: all bots) targeting crate [color] (default: ${CRATE_SHULKER_BLOCK.replace(/_/g, ' ')}), ${(CRATES_ALL_STAGGER_MS / 1000).toFixed(0)}s apart so they don't hit the server at once`,
  '/crates-solo [bot] [color]': 'Run shardshop → crates → dump on just one bot (default: active bot) targeting crate [color] — not all bots',
  '/list':           'Compact one-line-per-bot status list (online / offline / last kick)',
  '/chat <msg>':     'Send a chat message from the active bot (avoids triggering local commands)',
  '/disconnect':     'Disconnect the active bot (stops auto-reconnect). Alias: /dc',
  '/closeBot':       'Disconnect the active bot and completely remove it from the UI',
  '/clear':          'Clear the active bot\'s log view',
  '/help':           'List all available commands',
  '/status':         'Show active bot\'s connection, position, health, ping, uptime',
  '/inv':            'List active bot\'s inventory',
  '/players':        'List players online from the active bot\'s perspective',
  '/exit':           'Disconnect all bots and close the program',
  '/reconnect':      'Reconnect the active bot',
  '/reconnect-all':  'Reconnect every currently disconnected bot',
  '/new-bot <name> [host] [port] [ver]': 'Create and connect a new bot',
  '/switch <id>':    'Switch view to a different bot by name or number',
  '/uptime':         'Show uptime for all bots',
  '/proxy':          'Show the currently configured outbound proxy',
  'anything else':   'Sent directly as a chat message/command from the active bot',
  '/dump':   'dump gear to chest'
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
      logFor(id, `  Server: ${entry.host}:${entry.port} (v${entry.version})`)
      logFor(id, `  Proxy: ${PROXY_ENABLED ? `${PROXY_TYPE.toUpperCase()} ${PROXY_HOST}:${PROXY_PORT}` : 'Direct (no proxy)'}`)
      logFor(id, `  Position: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`)
      logFor(id, `  Health: ${bot.health ?? 'N/A'}  Food: ${bot.food ?? 'N/A'}`)
      logFor(id, `  Ping: ${bot.player?.ping ?? 'N/A'}ms`)
      logFor(id, `  Uptime: ${uptimeSec}s`)
      return true
    }

    case '/inv': {
      if (!bot.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return true }
      const items = bot.inventory.items()
      if (items.length === 0) {
        logFor(id, `{cyan-fg}› Inventory is empty.{/cyan-fg}`)
      } else {
        logFor(id, `{cyan-fg}› Inventory for ${id}:{/cyan-fg}`)
        items.forEach(item => logFor(id, `  ${item.count}x ${sanitize(item.displayName || item.name)} (slot ${item.slot})`))
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
      players.forEach(name => logFor(id, `  ${sanitize(name)}`))
      return true
    }

    case '/clear': {
      entry.logs = []
      if (id === activeId) { logBox.setContent(''); debouncedRender() }
      return true
    }

    case '/disconnect':
    case '/dc': {
      logFor(id, `{yellow-fg}⚠ Disconnecting ${id}…{/yellow-fg}`)
      try { entry.disconnectManually() } catch (_) {}
      return true
    }

    case '/closeBot': {
      logFor(id, `{yellow-fg}⚠ Disconnecting and removing ${id}…{/yellow-fg}`)
      try { entry.disconnectManually() } catch (_) {}
      delete bots[id]
      
      const remainingNames = Object.keys(bots)
      if (activeId === id) {
        if (remainingNames.length > 0) {
          switchTo(remainingNames[remainingNames.length - 1])
        } else {
          activeId = null
          logBox.setContent('')
          debouncedRender()
        }
      }
      updateHeader()
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
const CRATE_STOP_PHRASES     = ['you do not have a', 'error']
const CRATE_CLICK_DELAY_MS   = parseInt(process.env.CRATE_CLICK_DELAY_MS   || '900',   10) // gap between clicks
const CRATE_CLICK_TIMEOUT_MS = parseInt(process.env.CRATE_CLICK_TIMEOUT_MS || '60000', 10) // safety ceiling

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

// ── /crates routine: warp → scan for red shulker box → walk → right-click ──
// Runs once per invocation. The inCrateRoutine flag suppresses the generic
// windowOpen handler so the shulker box GUI doesn't trigger Fatal Crate logic.
async function runCrateRoutine(id, blockNameOverride) {
  const entry = bots[id]
  const blockName = blockNameOverride || CRATE_SHULKER_BLOCK
  logFor(id,`Change the version in .env to 1.21.1 to use this mechanic otherwise SKIP it.`)
  if (!entry?.bot?.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return false }
  if (entry.crateRoutineRunning) { logFor(id, `{yellow-fg}⚠ /crates is already running for ${id}.{/yellow-fg}`); return false }
  entry.crateRoutineRunning = true
  entry.inCrateRoutine = true
  const { bot } = entry

  try {
    if(WARP_AFK!=false){
    logFor(id, `{cyan-fg}› Warping to crates (targeting ${blockName.replace(/_/g, ' ')})…{/cyan-fg}`)
    try { bot.chat(WARP_CRATES) } catch (err) {
      logFor(id, `{red-fg}✗ Failed to send "${sanitize(WARP_CRATES)}": ${sanitize(err.message)}{/red-fg}`)
      return false
    }
    }
    // Wait for warp to complete (5 seconds + random 100-600ms)
    await new Promise(resolve => setTimeout(resolve, 5000 + 100 + Math.random() * 500))
    if (!bot.entity) { logFor(id, `{red-fg}✗ ${id} despawned during warp — aborting.{/red-fg}`); return false }

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
    if (!entry?.bot?.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); resolve(null); return }
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

function formatUptime(ms) {
  if (!ms || ms <= 0) return '0s'
  const s = Math.floor(ms / 1000)
  const parts = []
  if (s >= 3600)       parts.push(`${Math.floor(s / 3600)}h`)
  if (s % 3600 >= 60)  parts.push(`${Math.floor((s % 3600) / 60)}m`)
  parts.push(`${s % 60}s`)
  return parts.join(' ')
}

function handleCommand(trimmed) {
  // ── /all ────────────────────────────────────
  if (trimmed.startsWith('/all ')) {
    const msg = trimmed.slice(5).trim()
    if (!msg) { logWarn('Usage: /all <command or message>'); return }
    const baseCmd = msg.split(' ')[0]

    if (LOCAL_COMMANDS.includes(baseCmd)) {
      logInfo(`{yellow-fg}Running "${baseCmd}" locally on all bots:{/yellow-fg}`)
      let count = 0
      Object.keys(bots).forEach(id => { if (runLocalCommandForBot(id, baseCmd)) count++ })
      logSuccess(`Ran "${baseCmd}" on ${count} bots.`)
      return
    }

    logInfo(`{yellow-fg}Broadcasting to all bots:{/yellow-fg} ${sanitize(msg)}`)
    let sent = 0
    Object.entries(bots).forEach(([, { bot }]) => {
      if (bot?.entity) { try { bot.chat(msg); sent++ } catch (_) {} }
    })
    logSuccess(`Broadcasted to ${sent} bots.`)
    return
  }

  // ── /overview ───────────────────────────────
  if (trimmed === '/overview') {
    const names = Object.keys(bots)
    logInfo('{bold}── Bot Overview Dashboard ──{/bold}')
    logInfo('Querying shard, coin, and money balances…')

    Promise.all(names.map(name => {
      if (!bots[name]?.bot?.entity) return Promise.resolve({ name, shards: null, coins: null, money: null })
      return Promise.all([
        queryBalance(name, 'Shards', '/shards'),
        queryBalance(name, 'Coins', '/coins'),
        queryBalance(name, 'Balance', '/bal')
      ]).then(([shards, coins, money]) => ({ name, shards, coins, money }))
    })).then(results => {
      results.forEach(({ name, shards, coins, money }, idx) => {
        const b = bots[name]
        if (b?.bot?.entity) {
          const hp   = Math.round(b.bot.health || 0)
          const food = Math.round(b.bot.food || 0)
          const ping = b.bot.player?.ping ?? '?'
          const sh   = shards !== null ? shards.toLocaleString() : 'N/A'
          const co   = coins !== null ? coins.toLocaleString() : 'N/A'
          const mo   = money !== null ? `$${money.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/A'
          log(`[${idx + 1}] {cyan-fg}${name}{/cyan-fg} : {green-fg}Online{/green-fg} | HP: ${hp} | Food: ${food} | Ping: ${ping}ms | Shards: ${sh} | Coins: ${co} | Balance: ${mo}`)
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
        log(`  [${idx + 1}] {cyan-fg}${name}{/cyan-fg}  {green-fg}● Online{/green-fg}  (${up})`)
      } else {
        const kick = b?.lastKickReason ? `  — last kick: ${sanitize(b.lastKickReason).slice(0, 60)}` : ''
        log(`  [${idx + 1}] {cyan-fg}${name}{/cyan-fg}  {red-fg}○ Offline{/red-fg}${kick}`)
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
      log(`  [${idx + 1}] {cyan-fg}${name}{/cyan-fg} — ${up}`)
    })
    return
  }

  // ── /proxy ──────────────────────────────────
  if (trimmed === '/proxy') {
    if (PROXY_ENABLED) {
      logInfo(`{bold}Outbound proxy:{/bold} ${PROXY_TYPE.toUpperCase()} ${PROXY_HOST}:${PROXY_PORT} (applies to all bots)`)
      if (PROXY_STALL_ENABLED) {
        const restartInfo = PROXY_RESTART_CMD ? `restart cmd: "${PROXY_RESTART_CMD}"` : 'no restart cmd (proxy isn\'t local — set PROXY_RESTART_CMD in .env if you want auto-restart)'
        logInfo(`{bold}Stall watchdog:{/bold} on — stall timeout ${(PROXY_STALL_TIMEOUT_MS / 1000).toFixed(0)}s, checked every ${(PROXY_STALL_CHECK_MS / 1000).toFixed(0)}s, ${restartInfo}`)
      } else {
        logInfo('{bold}Stall watchdog:{/bold} off (set PROXY_STALL_WATCHDOG=1, or unset PROXY_STALL_WATCHDOG=0, in .env)')
      }
    } else {
      logInfo('No outbound proxy configured — bots connect directly. Set PROXY_HOST in .env to enable one.')
    }
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



  // ── /chat ───────────────────────────────────
  if (trimmed.startsWith('/chat ')) {
    const msg = trimmed.slice(6).trim()
    if (!activeId) { logWarn('No active bot.'); return }
    if (!msg) { logWarn('Usage: /chat <message>'); return }
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
  if (trimmed.startsWith('/switch ')) {
    const arg = trimmed.slice(8).trim()
    if (/^\d+$/.test(arg)) {
      const index = parseInt(arg, 10) - 1
      const names = Object.keys(bots)
      if (names[index]) switchTo(names[index])
      else logWarn(`No bot at index [${arg}]. Valid: 1–${names.length}`)
    } else {
      switchTo(arg)
    }
    return
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

  // ── Single-bot local commands ───────────────
  if (activeId && LOCAL_COMMANDS.includes(trimmed)) {
    runLocalCommandForBot(activeId, trimmed)
    return
  }

  switch (trimmed) {
    case '/help':
      logInfo('{bold}Available commands:{/bold}')
      Object.entries(COMMANDS).forEach(([cmd, desc]) => log(`  {cyan-fg}${cmd}{/cyan-fg} — ${desc}`))
      break

    case '/exit':
      logWarn('Exiting all bots…')
      Object.values(bots).forEach(({ bot }) => { try { bot.quit() } catch (_) {} })
      setTimeout(() => process.exit(0), 300)
      break

    default:
      if (!activeId) { logWarn('No active bot.'); break }
      try { bots[activeId].bot.chat(trimmed) } catch (err) { logError(`Chat failed: ${sanitize(err.message)}`); break }
      log(`{green-fg}❯{/green-fg} Sent: ${sanitize(trimmed)}`)
  }
}

// ── Input handling & History ──────────────────────────────────────────────────
const HISTORY_FILE = path.join(__dirname, '.command_history')
const MAX_HISTORY = 500

// Load persisted history on startup
const commandHistory = (() => {
  try {
    const data = fs.readFileSync(HISTORY_FILE, 'utf8')
    return data.split('\n').filter(Boolean).slice(-MAX_HISTORY)
  } catch (_) { return [] }
})()
let historyIndex = -1

function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, commandHistory.join('\n') + '\n') } catch (_) {}
}

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
    if (commandHistory[commandHistory.length - 1] !== trimmed) {
      commandHistory.push(trimmed)
      if (commandHistory.length > MAX_HISTORY) commandHistory.shift()
      saveHistory()
    }
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

screen.render()
