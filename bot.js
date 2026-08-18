require('dotenv').config()          // npm install dotenv
const net = require('net')
const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')
const mineflayer = require('mineflayer')
const armorManager = require('mineflayer-armor-manager')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')

// Web GUI dependencies
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')

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

// ── /crates command config ─────────────────────────────────────────────────
const WARP_CRATES         = process.env.WARP_CRATES_COMMAND || '/warp crates'
const CRATE_SHULKER_BLOCK = process.env.CRATE_SHULKER_BLOCK || 'red_shulker_box'
const CRATE_SCAN_RADIUS   = parseInt(process.env.CRATE_SCAN_RADIUS || '20', 10)
const CRATE_REACH         = parseFloat(process.env.CRATE_REACH || '3.5')

// ── /crates-all: shardshop → crates → dump chain across multiple bots ───────
const SHARDSHOP_COMMAND             = process.env.SHARDSHOP_COMMAND            || '/shardshop'
const CRATES_ALL_STAGGER_MS         = parseInt(process.env.CRATES_ALL_STAGGER_MS        || '30000', 10)
const CRATES_ALL_SHARDSHOP_WAIT_MS  = parseInt(process.env.CRATES_ALL_SHARDSHOP_WAIT_MS || '4000', 10)
const CRATES_ALL_STEP_WAIT_MS       = parseInt(process.env.CRATES_ALL_STEP_WAIT_MS      || '3000', 10)

// ── Outbound proxy config ──────────────────────────────────────────────────────
const PROXY_HOST       = process.env.PROXY_HOST       || ''
const PROXY_ENABLED    = Boolean(PROXY_HOST)
const PROXY_PORT       = parseInt(process.env.PROXY_PORT || '1080', 10)
const PROXY_TYPE       = (process.env.PROXY_TYPE || 'socks5').toLowerCase()

// ── Proxy stall watchdog ────────────────────────────────────────────────────
const PROXY_STALL_ENABLED       = PROXY_ENABLED && process.env.PROXY_STALL_WATCHDOG !== '0'
const PROXY_STALL_TIMEOUT_MS    = parseInt(process.env.PROXY_STALL_TIMEOUT_MS || '90000', 10)
const PROXY_STALL_CHECK_MS      = parseInt(process.env.PROXY_STALL_CHECK_MS   || '20000', 10)
const PROXY_STALL_RATIO         = parseFloat(process.env.PROXY_STALL_RATIO    || '0.5')
const PROXY_IS_LOCAL            = /^(127\.0\.0\.1|localhost|::1)$/i.test(PROXY_HOST)
const PROXY_RESTART_CMD         = process.env.PROXY_RESTART_CMD || (PROXY_IS_LOCAL ? 'brew services restart tor' : '')
const PROXY_RESTART_COOLDOWN_MS = parseInt(process.env.PROXY_RESTART_COOLDOWN_MS || '120000', 10)
let lastProxyRestart = 0
const basicAuth = require('express-basic-auth')

// Web GUI Authentication Protection


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
]
const FAST_RECONNECT_MS = 10400
const RECONNECT_BASE_MS = 10400
const RECONNECT_MAX_MS  = 5 * 60_000

if (BOT_NAMES.length === 0) {
  console.error('No BOT_NAMES defined in .env — nothing to connect.')
  process.exit(1)
}

// ── Web GUI Setup (Replaces neo-blessed) ──────────────────────────────────────
const app = express()
const server = http.createServer(app)
const io = new Server(server)
app.use(basicAuth({
    users: { 'admin': process.env.GUI_PASSWORD || 'ChangeMe123!' },
    challenge: true,
    unauthorizedResponse: (req) => 'Access denied: Invalid credentials.'
}))
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Mineflayer AFK Console</title>
      <style>
        body { background: #1e1e1e; color: #c5c8c6; font-family: monospace; margin: 0; padding: 20px; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
        #header { background: #0000aa; color: white; padding: 10px; font-weight: bold; text-align: center; border-radius: 4px; margin-bottom: 10px; }
        #logs { flex: 1; background: #000; border: 1px solid #555; padding: 10px; overflow-y: auto; border-radius: 4px; margin-bottom: 10px; white-space: pre-wrap; word-wrap: break-word; }
        #input-container { display: flex; }
        #cmd { flex: 1; padding: 10px; background: #333; color: #fff; border: 1px solid #555; border-radius: 4px; font-family: monospace; font-size: 14px; }
        #cmd:focus { outline: none; border-color: #00aa00; }
        .log-line { padding: 2px 0; border-bottom: 1px solid #222; }
      </style>
    </head>
    <body>
      <div id="header">⛏ MINEFLAYER AFK CONSOLE (Loading...)</div>
      <div id="logs"></div>
      <div id="input-container">
        <input type="text" id="cmd" placeholder="Enter command (e.g. /status, /help, /chat hello) ..." autocomplete="off" />
      </div>
      
      <script src="/socket.io/socket.io.js"></script>
      <script>
        const socket = io();
        const logsDiv = document.getElementById('logs');
        const cmdInput = document.getElementById('cmd');
        const headerDiv = document.getElementById('header');

        let history = [];
        let historyIndex = -1;

        function parseTags(text) {
          return text
            .replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/\\{([a-z]+)-fg\\}/gi, '<span style="color: $1;">')
            .replace(/\\{\\/([a-z]+)-fg\\}/gi, '</span>')
            .replace(/\\{bold\\}/gi, '<strong>').replace(/\\{\\/bold\\}/gi, '</strong>')
            .replace(/\\{center\\}/gi, '<div style="text-align:center;">').replace(/\\{\\/center\\}/gi, '</div>');
        }

        socket.on('header', (html) => {
          headerDiv.innerHTML = parseTags(html);
        });

        socket.on('log', (msg) => {
          const div = document.createElement('div');
          div.className = 'log-line';
          div.innerHTML = parseTags(msg);
          logsDiv.appendChild(div);
          logsDiv.scrollTop = logsDiv.scrollHeight;
        });

        socket.on('clear', () => {
          logsDiv.innerHTML = '';
        });

        cmdInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && cmdInput.value.trim() !== '') {
            const val = cmdInput.value.trim();
            socket.emit('command', val);
            history.push(val);
            historyIndex = history.length;
            cmdInput.value = '';
          } else if (e.key === 'ArrowUp') {
            if (historyIndex > 0) {
              historyIndex--;
              cmdInput.value = history[historyIndex];
            }
          } else if (e.key === 'ArrowDown') {
            if (historyIndex < history.length - 1) {
              historyIndex++;
              cmdInput.value = history[historyIndex];
            } else {
              historyIndex = history.length;
              cmdInput.value = '';
            }
          }
        });
      </script>
    </body>
    </html>
  `)
})

io.on('connection', (socket) => {
  socket.emit('header', currentHeader)
  if (activeId && bots[activeId]) {
    bots[activeId].logs.forEach(l => socket.emit('log', l.text))
  }
  socket.on('command', (cmd) => {
    handleCommand(cmd)
  })
})

const WEB_PORT = process.env.PORT || 3000
server.listen(WEB_PORT, () => {

console.log(`Web GUI active and listening on port ${WEB_PORT}`)


})

// ── Outbound proxy tunnelling ──────────────────────────────────────────────────
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
    broadcastLog(`{red-fg}[UNCAUGHT] ${sanitize(text)}{/red-fg}`); 
  } catch (_) {}
})
process.on('unhandledRejection', (reason) => {
  try {
    const msg = reason instanceof Error ? reason.message : String(reason)
    broadcastLog(`{red-fg}[UNHANDLED REJECTION] ${sanitize(msg)}{/red-fg}`);
  } catch (_) {}
})

// ── Tag sanitiser ─────────────────────────────────────────────────────────────
const KNOWN_TAG_RE = /\{(\/?(bold|underline|blink|inverse|red|green|blue|cyan|magenta|yellow|white|gray|grey|black|center|left|right)(-fg|-bg)?)\}/g
const MAX_SANITIZED_LENGTH = 4000
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

// ── Logging System ────────────────────────────────────────────────────────────
function broadcastLog(msg) {
  io.emit('log', msg)
  // Also dump to actual terminal so render logs still get output natively
  process.stdout.write(msg.replace(/\{.*?\}/g, '') + '\n') 
}

process.stderr.write = (chunk) => {
  try {
    const text = (typeof chunk === 'string' ? chunk : chunk.toString('utf8')).trim()
    if (text) broadcastLog(`{gray-fg}[stderr] ${sanitize(text)}{/gray-fg}`)
  } catch (_) {}
  return true
}
console.log   = (...a) => { broadcastLog(`{gray-fg}${sanitize(a.join(' '))}{/gray-fg}`) }
console.warn  = (...a) => { broadcastLog(`{yellow-fg}[warn] ${sanitize(a.join(' '))}{/yellow-fg}`) }
console.error = (...a) => { broadcastLog(`{red-fg}[error] ${sanitize(a.join(' '))}{/red-fg}`) }

function timestamp() {
  return `{gray-fg}${new Date().toLocaleTimeString()}{/gray-fg}`
}

function debouncedRender() {
  // Stubbed out - no longer needed without blessed
}

// ── Multi-bot state ───────────────────────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - (20 * 60 * 1000)
  Object.values(bots).forEach(botState => {
    botState.logs = botState.logs.filter(log => log.time > cutoff)
  })
}, 60000)
const bots = {}
let activeId = null
let currentHeader = ''
const MAX_LOG_LINES = 5000

function updateHeader() {
  const names = Object.keys(bots)
  const activeIndex = names.indexOf(activeId) + 1
  const activeLabel = activeId ? `Active: [${activeIndex}] ${activeId}` : 'No active bot'
  const others = names.map((n, i) => i !== (activeIndex - 1) ? `[${i + 1}] ${n}` : null).filter(Boolean)
  const othersLabel = others.length ? `  |  Others: ${others.join(', ')}` : ''
  const proxyLabel = PROXY_ENABLED ? `   —   Proxy: ${PROXY_TYPE.toUpperCase()} ${PROXY_HOST}:${PROXY_PORT}` : ''
  currentHeader = `{center}{bold}⛏  MINEFLAYER AFK CONSOLE{/bold}   —   ${activeLabel}${othersLabel}${proxyLabel}{/center}`
  io.emit('header', currentHeader)
}

function switchTo(id) {
  if (!bots[id]) { log(`{red-fg}✗ No bot named "${sanitize(id)}"{/red-fg}`); return }
  activeId = id
  
  io.emit('clear')
  
  if (bots[id].logs.length > 0) {
    bots[id].logs.forEach(l => io.emit('log', l.text))
  }
  updateHeader()
}

function logFor(id, msg) {
  if (!bots[id]) return
  
  const line = `${timestamp()} ${msg}`
  bots[id].logs.push({ text: line, time: Date.now() })
  if (bots[id].logs.length > MAX_LOG_LINES) bots[id].logs.splice(0, bots[id].logs.length - MAX_LOG_LINES)
  
  if (id === activeId) { 
    broadcastLog(line)
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

  clearReconnectTimer(id)

  const s = (msg) => logFor(id, `{green-fg}✓ ${msg}{/green-fg}`)
  const e = (msg) => logFor(id, `{red-fg}✗ ${msg}{/red-fg}`)
  const i = (msg) => logFor(id, `{cyan-fg}› ${msg}{/cyan-fg}`)
  const w = (msg) => logFor(id, `{yellow-fg}⚠ ${msg}{/yellow-fg}`)
  const c = (msg) => logFor(id, `{white-fg}${sanitize(msg)}{/white-fg}`)

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
    lastDisconnectReason: null,
    crateRoutineRunning: false,
    inCrateRoutine: false,
    lastActivity: Date.now(),
    forceKilled: false,
    manualDisconnect: false
  }

  if (PROXY_STALL_ENABLED && bot._client) {
    bot._client.on('packet', () => {
      if (bots[id]) bots[id].lastActivity = Date.now()
    })
  }

  const timeouts = []
  const pushT = (fn, delay) => { const t = setTimeout(fn, delay); timeouts.push(t); return t }
  const clearAll = () => { timeouts.forEach(clearTimeout); timeouts.length = 0 }

  function isProxyCrash(reason) {
    if (!reason) return false
    const text = typeof reason === 'string' ? reason : (reason.message || String(reason))
    return PROXY_CRASH_PATTERNS.some(re => re.test(text))
  }

  const scheduleReconnect = (reason, rawError) => {
    clearAll()
    connected = false
    if (manualDisconnect || bots[id]?.reconnectTimer) {
      return;
    }

    const proxyCrash = isProxyCrash(rawError || reason)
    const attempt = bots[id]?.reconnectAttempts || 0

    if (!proxyCrash && attempt >= MAX_RECONNECT) {
      if (bots[id]) bots[id].reconnectTimer = null
      e(`${id} reached max reconnects (${MAX_RECONNECT}). Disconnected permanently. Use /reconnect to try again.`)
      return
    }

    let delay
    if (proxyCrash) {
      delay = FAST_RECONNECT_MS
      w(`${reason} (proxy transfer crash detected). Reconnecting in ${(delay / 1000).toFixed(1)}s…`)
    } else {
      delay = Math.min(RECONNECT_BASE_MS * Math.pow(1.3, attempt), RECONNECT_MAX_MS)
      if (bots[id]) bots[id].reconnectAttempts = attempt + 1
      w(`${reason}. Auto-reconnecting in ${(delay / 1000).toFixed(1)}s (Attempt ${attempt + 1})…`)
    }

    bots[id].reconnectTimer = setTimeout(() => {
      bots[id].reconnectTimer = null
      setImmediate(() => createBotInstance(id, host, port, version))
    }, delay)
  }

  bot.once('login', () => {
    i('Connected to server socket. Awaiting chat auth prompts…')
  })

  bot.on('messagestr', (message) => {
    const text = message.toLowerCase()
    if (text.includes('register') && text.includes('/register')) {
      i('Auth prompt detected: sending /register')
      pushT(() => bot.chat(`/register ${LOGIN_PASSWORD} ${LOGIN_PASSWORD}`), 220 + Math.random() * 400)
    } else if (text.includes('login') && text.includes('/login')) {
      i('Auth prompt detected: sending /login')
      pushT(() => bot.chat(`/login ${LOGIN_PASSWORD}`), 220 + Math.random() * 400)
    }
  })

  bot.once('spawn', () => {
    connected = true
    if (bots[id]) bots[id].spawnTime = Date.now()
    s(`Spawned on ${host}:${port} (v${version}).`)

    pushT(() => { if (connected && bots[id]) bots[id].reconnectAttempts = 0 }, 60_000)

    pushT(() => {
      if (bot.entity) {
        try { bot.armorManager.equipAll() } catch (_) {}
      }
    }, 2000)

    pushT(() => {
      i('Right-clicking compass (server selector)…')
      try { bot.activateItem() } catch (err) { e(`activateItem failed: ${sanitize(err.message)}`) }
    }, 3600 + Math.random() * 600)
  })

  bot.on('windowOpen', (window) => {
    try {
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

      let targetSlot = GUI_SLOT;
      let foundFatalItem = false;

      for (let j = 0; j < window.slots.length; j++) {
        const slot = window.slots[j];
        if (!slot) continue;
        
        const slotDataStr = getSafeItemString(slot).toLowerCase();
        const hasFatal = slotDataStr.includes('fatal') || slotDataStr.includes('red');
        const hasCrateOrKey = slotDataStr.includes('crate') || slotDataStr.includes('key') || slotDataStr.includes('candle');

        if (hasFatal && hasCrateOrKey) {
          targetSlot = j;
          foundFatalItem = true;
          break;
        }
      }

      if (foundFatalItem) {
        i(`Found Fatal Crate/Key at slot ${targetSlot}!`);
      } else {
        i(`Fatal Crate/Key not found, falling back to GUI_SLOT (${GUI_SLOT}).`);
      }

      if (targetSlot >= window.slots.length) {
        w(`Slot ${targetSlot} out of bounds — window only has ${window.slots.length} slots`)
        return
      }
      if (!window.slots[targetSlot]) {
        w(`Slot ${targetSlot} is empty — not clicking.`)
        return
      }

      pushT(async () => {
        if (!bot.currentWindow) { w('Window closed before click could fire.'); return }
        try {
          await bot.clickWindow(targetSlot, 0, 0)
          if(!foundFatalItem ){
            i(`Clicked slot ${targetSlot} — waiting for server transfer…`)
          }else{
            i(`Clicked slot ${targetSlot} — Purchased Fatal key`)
          }
        } catch (err) { e(`Click failed: ${sanitize(err.message || String(err))}`) }
      }, 2000 + Math.random() * 1600)

      pushT(async () => {
          if(!foundFatalItem){
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
    scheduleReconnect('Connection lost', lastRawError || reasonText)
    lastRawError = null
  })

  bots[id].disconnectManually = () => {
    manualDisconnect = true
    if (bots[id]) {
      bots[id].manualDisconnect = true
      bots[id].spawnTime = null
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

    if (spawned.length >= 2 && stalled.length / spawned.length >= PROXY_STALL_RATIO) {
      restartProxyService()
    }

    stalled.forEach(([id, entry]) => {
      console.warn(`[proxy-watchdog] "${id}" has received nothing for ${Math.round((now - entry.lastActivity) / 1000)}s — forcing reconnect.`)
      entry.forceKilled = true
      entry.lastActivity = now
      try {
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
  '/crates':         `Warp to crates, find + walk to the nearest ${CRATE_SHULKER_BLOCK.replace(/_/g, ' ')}`,
  '/crates-loop [n]': 'Run /crates repeatedly (default: until failure). Specify n for a fixed count',
  '/crates-all [n]': `Run shardshop → crates → dump on bots 1 through n (default: all bots)`,
  '/list':           'Compact one-line-per-bot status list',
  '/chat <msg>':     'Send a chat message from the active bot',
  '/disconnect':     'Disconnect the active bot. Alias: /dc',
  '/closeBot':       'Disconnect the active bot and completely remove it from the UI',
  '/clear':          'Clear the active bot\'s log view',
  '/help':           'List all available commands',
  '/status':         'Show active bot\'s connection, position, health, ping, uptime',
  '/inv':            'List active bot\'s inventory',
  '/players':        'List players online from the active bot\'s perspective',
  '/exit':           'Disconnect all bots and close the program',
  '/reconnect':      'Reconnect the active bot',
  '/reconnect-all':  'Reconnect every currently disconnected bot',
  '/new-bot <name>': 'Create and connect a new bot',
  '/switch <id>':    'Switch view to a different bot by name or number',
  '/uptime':         'Show uptime for all bots',
  '/proxy':          'Show the currently configured outbound proxy',
  '/dump':           'dump gear to chest'
}

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
      }, 15000)

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
    await new Promise(r => setTimeout(r, 2000))
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
        try { await chestContainer.deposit(item.type, item.metadata, item.count) } catch (err) { break }
      }
      await chestContainer.close()
    } catch (err) {
      if (chestContainer) { try { await chestContainer.close() } catch (_) {} }
    }
  }
}

const LOCAL_COMMANDS = ['/status', '/inv', '/players', '/clear', '/disconnect', '/dump', '/dc', '/reconnect', '/crates', '/crates-loop', '/closeBot']

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
      if (id === activeId) { io.emit('clear') }
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
          io.emit('clear')
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
      runCrateRoutine(id)
      return true
    }

    case '/crates-loop': {
      if (!bot.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return true }
      runCrateLoop(id)
      return true
    }

    default:
      return false
  }
}

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

    try {
      const mcData = require('minecraft-data')(bot.version)
      if (mcData.blocksByName.light) mcData.blocksByName.light.boundingBox = 'empty'
      for (const block of Object.values(mcData.blocksByName)) {
        if (block.name.includes('button')) block.boundingBox = 'empty'
      }
    } catch (_) {}

    try {
      await Promise.race([
        bot.lookAt(targetPos.offset(0.5, 0.5, 0.5), false),
        new Promise(r => setTimeout(r, 1000))
      ])
    } catch (_) {}

    if (settled || !bot.entity) { resolve(false); return }

    bot.setControlState('forward', true)
    bot.setControlState('sprint', false)
    bot.setControlState('jump', false)
    bot.setControlState('sneak', false)

    timer = setInterval(() => {
      if (!bot.entity) { stop(); resolve(false); return }
      const dist = bot.entity.position.distanceTo(targetPos)
      if (dist <= reach) { stop(); resolve(true) }
    }, 50)

    timeout = setTimeout(() => {
      stop()
      if (bot.entity && bot.entity.position.distanceTo(targetPos) <= reach) resolve(true)
      else resolve(false)
    }, timeoutMs)
  })
}

async function runCrateRoutine(id) {
  const entry = bots[id]
  logFor(id,`Change the version in .env to 1.21.1 to use this mechanic otherwise SKIP it.`)
  if (!entry?.bot?.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return false }
  if (entry.crateRoutineRunning) { logFor(id, `{yellow-fg}⚠ /crates is already running for ${id}.{/yellow-fg}`); return false }
  entry.crateRoutineRunning = true
  entry.inCrateRoutine = true
  const { bot } = entry

  try {
    logFor(id, `{cyan-fg}› Warping to crates…{/cyan-fg}`)
    try { bot.chat(WARP_CRATES) } catch (err) {
      logFor(id, `{red-fg}✗ Failed to send "${sanitize(WARP_CRATES)}": ${sanitize(err.message)}{/red-fg}`)
      return false
    }

    await new Promise(resolve => setTimeout(resolve, 5000 + 100 + Math.random() * 500))
    if (!bot.entity) { logFor(id, `{red-fg}✗ ${id} despawned during warp — aborting.{/red-fg}`); return false }

    const block = bot.findBlock({
      matching: (b) => b && b.name === CRATE_SHULKER_BLOCK,
      maxDistance: CRATE_SCAN_RADIUS
    })

    if (!block) {
      logFor(id, `{red-fg}✗ No ${CRATE_SHULKER_BLOCK.replace(/_/g, ' ')} found within ${CRATE_SCAN_RADIUS} blocks — warping to afk instead.{/red-fg}`)
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

    const freshBlock = bot.blockAt(block.position)
    if (!freshBlock || freshBlock.name !== CRATE_SHULKER_BLOCK) {
      logFor(id, `{red-fg}✗ Block at target location changed before I could click it — warping to afk instead.{/red-fg}`)
      try { bot.chat(WARP_AFK) } catch (_) {}
      return false
    }

    try {
      await bot.lookAt(freshBlock.position.offset(0.5, 0.5, 0.5), true)
      await bot.activateBlock(freshBlock)
      logFor(id, `{green-fg}✓ Right-clicked the ${CRATE_SHULKER_BLOCK.replace(/_/g, ' ')}.{/green-fg}`)
      return true
    } catch (err) {
      logFor(id, `{red-fg}✗ Failed to click shulker box: ${sanitize(err.message)}{/red-fg}`)
      return false
    }
  } finally {
    if (bots[id]) {
      bots[id].crateRoutineRunning = false
      bots[id].inCrateRoutine = false
    }
  }
}

async function runCrateLoop(id, maxIterations = Infinity) {
  const entry = bots[id]
  if (!entry?.bot?.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return }
  if (entry.crateLoopRunning) { logFor(id, `{yellow-fg}⚠ /crates-loop is already running for ${id}.{/yellow-fg}`); return }
  entry.crateLoopRunning = true

  let iteration = 0
  try {
    while (iteration < maxIterations) {
      iteration++
      logFor(id, `{cyan-fg}› Crate loop iteration ${iteration}${maxIterations < Infinity ? '/' + maxIterations : ''}…{/cyan-fg}`)

      const success = await runCrateRoutine(id)
      if (!success) {
        logFor(id, `{yellow-fg}⚠ Crate routine failed on iteration ${iteration} — stopping loop.{/yellow-fg}`)
        break
      }

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

let cratesAllRunning = false

async function runCratesAllSequenceForBot(id) {
  const entry = bots[id]
  if (!entry?.bot?.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned — skipping /crates-all.{/yellow-fg}`); return }
  if (entry.crateRoutineRunning || entry.crateLoopRunning) {
    logFor(id, `{yellow-fg}⚠ ${id} is already busy with a crate routine — skipping /crates-all.{/yellow-fg}`)
    return
  }
  const { bot } = entry
  logFor(id, `{cyan-fg}› /crates-all: starting sequence (shardshop → crates → dump)…{/cyan-fg}`)

  try {
    bot.chat(SHARDSHOP_COMMAND)
    logFor(id, `{cyan-fg}› Sent "${sanitize(SHARDSHOP_COMMAND)}".{/cyan-fg}`)
  } catch (err) {
    logFor(id, `{red-fg}✗ Failed to send shardshop command: ${sanitize(err.message)}{/red-fg}`)
  }
  await new Promise(r => setTimeout(r, CRATES_ALL_SHARDSHOP_WAIT_MS))
  if (!bots[id]?.bot?.entity) { logFor(id, `{red-fg}✗ ${id} despawned during shardshop — aborting sequence.{/red-fg}`); return }

  const crateOk = await runCrateRoutine(id)
  logFor(id, crateOk
    ? `{green-fg}✓ Crate step done — moving on to dump.{/green-fg}`
    : `{yellow-fg}⚠ Crate step failed — continuing to dump anyway.{/yellow-fg}`)
  await new Promise(r => setTimeout(r, CRATES_ALL_STEP_WAIT_MS))
  if (!bots[id]?.bot?.entity) { logFor(id, `{red-fg}✗ ${id} despawned before dump — aborting sequence.{/red-fg}`); return }

  try {
    await tpaAndDump(bot, id)
    logFor(id, `{green-fg}✓ /crates-all: sequence complete for ${id}.{/green-fg}`)
  } catch (err) {
    logFor(id, `{red-fg}✗ Dump step failed: ${sanitize(err.message)}{/red-fg}`)
  }
}

async function runCratesAll(maxBots = Infinity) {
  if (cratesAllRunning) { logWarn('/crates-all is already running.'); return }
  const ids = Object.keys(bots).slice(0, maxBots)
  if (ids.length === 0) { logWarn('No bots to run /crates-all on.'); return }

  cratesAllRunning = true
  logInfo(`Starting /crates-all for ${ids.length} bot(s) [1–${ids.length}], ${(CRATES_ALL_STAGGER_MS / 1000).toFixed(0)}s apart…`)

  try {
    await Promise.allSettled(
      ids.map((id, idx) => new Promise((resolve) => {
        setTimeout(() => { runCratesAllSequenceForBot(id).finally(resolve) }, idx * CRATES_ALL_STAGGER_MS)
      }))
    )
    logSuccess(`/crates-all finished for all ${ids.length} bot(s).`)
  } finally {
    cratesAllRunning = false
  }
}

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
    const regex = isMoney
      ? /Balance:?\s*\$?\s*([\d,]+(?:\.\d+)?)/i
      : new RegExp(`${label}.{0,10}Balance:?\\s*\\$?\\s*([\\d,]+(?:\\.\\d+)?)`, 'i')

    const onMessage = (jsonMsg) => {
      try {
        const text = jsonMsg.toString()
        if (isMoney && /shards|coins/i.test(text)) return
        const match = text.match(regex)
        if (match) finish(parseFloat(match[1].replace(/,/g, '')))
      } catch (_) {}
    }

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
          const mo   = money !== null ? `$${money.toFixed(2)}` : 'N/A'
          log(`[${idx + 1}] {cyan-fg}${name}{/cyan-fg} : {green-fg}Online{/green-fg} | HP: ${hp} | Food: ${food} | Ping: ${ping}ms | Shards: ${sh} | Coins: ${co} | Balance: ${mo}`)
        } else {
          log(`[${idx + 1}] {cyan-fg}${name}{/cyan-fg} : {gray-fg}Offline / Connecting…{/gray-fg}`)
        }
      })
    }).catch(err => logError(`Overview failed: ${sanitize(err.message)}`))
    return
  }

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

  if (trimmed === '/proxy') {
    if (PROXY_ENABLED) {
      logInfo(`{bold}Outbound proxy:{/bold} ${PROXY_TYPE.toUpperCase()} ${PROXY_HOST}:${PROXY_PORT} (applies to all bots)`)
      if (PROXY_STALL_ENABLED) {
        const restartInfo = PROXY_RESTART_CMD ? `restart cmd: "${PROXY_RESTART_CMD}"` : 'no restart cmd (proxy isn\'t local)'
        logInfo(`{bold}Stall watchdog:{/bold} on — stall timeout ${(PROXY_STALL_TIMEOUT_MS / 1000).toFixed(0)}s, checked every ${(PROXY_STALL_CHECK_MS / 1000).toFixed(0)}s, ${restartInfo}`)
      } else {
        logInfo('{bold}Stall watchdog:{/bold} off')
      }
    } else {
      logInfo('No outbound proxy configured — bots connect directly.')
    }
    return
  }

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

  if (trimmed.startsWith('/chat ')) {
    const msg = trimmed.slice(6).trim()
    if (!activeId) { logWarn('No active bot.'); return }
    if (!msg) { logWarn('Usage: /chat <message>'); return }
    try { bots[activeId].bot.chat(msg) } catch (err) { logError(`Chat failed: ${sanitize(err.message)}`); return }
    log(`{green-fg}❯{/green-fg} Chat: ${sanitize(msg)}`)
    return
  }

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

  if (trimmed === '/crates-loop' || trimmed.startsWith('/crates-loop ')) {
    if (!activeId) { logWarn('No active bot.'); return }
    const arg = trimmed.slice('/crates-loop'.length).trim()
    const count = arg ? parseInt(arg, 10) : Infinity
    if (arg && (isNaN(count) || count <= 0)) { logWarn('Usage: /crates-loop [n] — n must be a positive number'); return }
    const entry = bots[activeId]
    if (!entry?.bot?.entity) { logWarn(`${activeId} is not currently spawned.`); return }
    runCrateLoop(activeId, count)
    return
  }

  if (trimmed === '/crates-all' || trimmed.startsWith('/crates-all ')) {
    const arg = trimmed.slice('/crates-all'.length).trim()
    const maxBots = arg ? parseInt(arg, 10) : Infinity
    if (arg && (isNaN(maxBots) || maxBots <= 0)) { logWarn('Usage: /crates-all [n] — n must be a positive number'); return }
    runCratesAll(maxBots)
    return
  }

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
