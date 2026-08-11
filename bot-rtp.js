
require('dotenv').config()                        // npm install dotenv
const mineflayer   = require('mineflayer')
const blessed      = require('neo-blessed')
const armorManager = require('mineflayer-armor-manager')

// ── .env config (with sane defaults) ──────────────────────────────────────────
const HOST             = process.env.HOST             || 'play.fatalmc.org'
const PORT             = parseInt(process.env.PORT    || '25565', 10)
const VERSION          = process.env.VERSION          || '1.21.1'
const LOGIN_PASSWORD   = process.env.LOGIN_PASSWORD   || '123456'
const BOT_NAMES_ENV    = (process.env.BOT_NAMES || '').split(',').map(n => n.trim()).filter(Boolean)

const BOT_NAMES = [
  'S3gF4ult_0x00',
  'Hypr_P4ck3t_X',
  'Nul1_P01nt3r',
  'H3adl3ss_T1ck',
  'F1shyShellArch'
]

const CONNECT_DELAY_MS = parseInt(process.env.CONNECT_DELAY_MS || '39500', 10)
const GUI_SLOT         = parseInt(process.env.GUI_SLOT         || '11', 10)

// ── Discord alert config ──────────────────────────────────────────────────────
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || 'https://discord.com/api/webhooks/1536063570859786383/fJihPygSzeQfWT5mHHGv8riec0cE0ajbxCotcoHj91AJLqpraOCUwOlrUq5230JCcCVL'
const DISCORD_USER_ID     = process.env.DISCORD_USER_ID     || '1262159132887093339'

// ── Roam / base-finding config ────────────────────────────────────────────────
const MODE                    = process.env.MODE               || 'roam'
const RTP_COMMAND             = process.env.RTP_COMMAND        || '/rtp world world'
const RTP_INTERVAL_MS         = parseFloat(process.env.RTP_INTERVAL_MS || '34800')
const BASE_SCAN_INTERVAL_MS   = parseInt(process.env.BASE_SCAN_INTERVAL_MS || '12000', 10)
const BASE_SCAN_RADIUS        = parseInt(process.env.BASE_SCAN_RADIUS     || '256', 10)
const BASE_ALERT_THRESHOLD    = parseInt(process.env.BASE_ALERT_THRESHOLD || '4', 10)
const RTP_PAUSE_ON_BASE_MS    = parseInt(process.env.RTP_PAUSE_ON_BASE_MS || '600000', 25)

// ── Player proximity config ──────────────────────────────────────────────────
const PLAYER_PROXIMITY_RADIUS      = parseInt(process.env.PLAYER_PROXIMITY_RADIUS      || '32', 10)
const PLAYER_PROXIMITY_INTERVAL_MS = parseInt(process.env.PLAYER_PROXIMITY_INTERVAL_MS || '5000', 10)
const PLAYER_PROXIMITY_COOLDOWN_MS = parseInt(process.env.PLAYER_PROXIMITY_COOLDOWN_MS || '300000', 10)

// ── Auto-eat config ──────────────────────────────────────────────────────────
const FOOD_CHECK_INTERVAL_MS = parseInt(process.env.FOOD_CHECK_INTERVAL_MS || '5000', 10)
const FOOD_EAT_THRESHOLD     = parseInt(process.env.FOOD_EAT_THRESHOLD    || '18', 10)

// ── Velocity / BungeeCord proxy crash detection ──────────────────────────────
const PROXY_CRASH_PATTERNS = [
  /PartialReadError/i,
  /deserialization/i,
  /decompress/i,
  /zlib/i,
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
const FAST_RECONNECT_MS  = 3000
const RECONNECT_BASE_MS  = 8000
const RECONNECT_MAX_MS   = 5 * 60_000

// ── Memory limits ─────────────────────────────────────────────────────────────
// Per-bot log buffer kept in JS.  blessed's logBox has its OWN internal buffer
// controlled by the `scrollback` option (set on the widget below).  Both must
// be capped or the process will eventually OOM / crash.
//
// 5 000 lines × ~200 bytes × 20 bots ≈ 20 MB in our arrays.
// blessed's logBox scrollback is set to the same value.
const MAX_LOG_LINES        = 5000000000000
const MAX_RTP_HISTORY_SIZE = 5000000000000

// ── Discord rate limiting ────────────────────────────────────────────────────
const discordQueue = []
let   discordDraining = false
const DISCORD_MIN_GAP_MS = 600

async function drainDiscordQueue() {
  if (discordDraining) return
  discordDraining = true
  while (discordQueue.length > 0) {
    const task = discordQueue.shift()
    try { await task() } catch (_) {}
    if (discordQueue.length > 0) await new Promise(r => setTimeout(r, DISCORD_MIN_GAP_MS))
  }
  discordDraining = false
}

function enqueueDiscord(asyncFn) {
  discordQueue.push(asyncFn)
  drainDiscordQueue()
}

// ── Global crash guards ──────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  try { logBox.log(`{red-fg}[UNCAUGHT] ${sanitize(err.message)}{/red-fg}`); debouncedRender() }
  catch (_) {}
})
process.on('unhandledRejection', (reason) => {
  try {
    const msg = reason instanceof Error ? reason.message : String(reason)
    logBox.log(`{red-fg}[UNHANDLED REJECTION] ${sanitize(msg)}{/red-fg}`); debouncedRender()
  } catch (_) {}
})

// ── Blessed tag sanitiser ────────────────────────────────────────────────────
const KNOWN_TAG_RE = /\{(\/?(bold|underline|blink|inverse|red|green|blue|cyan|magenta|yellow|white|gray|grey|black|bright|light|center|left|right)(-fg|-bg)?)\}/g

function sanitize(str) {
  if (typeof str !== 'string') str = String(str ?? '')
  const tags = []
  const safe = str.replace(KNOWN_TAG_RE, (m) => { tags.push(m); return `\x00T${tags.length - 1}\x00` })
  const escaped = safe.replace(/[{}]/g, c => '\\' + c)
  return escaped.replace(/\x00T(\d+)\x00/g, (_, i) => tags[+i])
}

// ── TUI setup ────────────────────────────────────────────────────────────────
const screen = blessed.screen({ smartCSR: true, title: 'Mineflayer Bot Console', fullUnicode: true })

function focusCommandInput() {
  if (screen.focused !== inputBox) {
    inputBox.focus()
  }
}
screen.on('keypress', (ch, key) => {
  if (!key) return

  // Keep normal keyboard input going to the command box.
  // Mouse interaction can still be used for the log.
  if (
    key.name !== 'mouse' &&
    key.name !== 'escape' &&
    screen.focused !== inputBox
  ) {
    inputBox.focus()
  }
})
let renderQueued = false
function debouncedRender() {
  if (renderQueued) return
  renderQueued = true
  setImmediate(() => { renderQueued = false; screen.render() })
}

const header = blessed.box({
  top: 0, left: 0, width: '100%', height: 3,
  content: '{center}{bold}⛏  MINEFLAYER BOT CONSOLE{/bold}{/center}',
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
  scrollbar: { ch: '│', style: { fg: 'cyan' } },
  // ── THIS IS THE KEY CRASH FIX ──
  // blessed.log keeps its own internal line buffer (_clines).
  // Without a scrollback cap it grows forever and eventually crashes
  // when blessed tries to render/diff millions of stored lines.
  scrollback: MAX_LOG_LINES
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

if (typeof fetch !== 'function') {
  logBox.log('{red-fg}[startup] Global fetch not found — Node 18+ is required for Discord webhook alerts.{/red-fg}')
}

// Redirect native output into the log box
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

function timestamp() {
  return `{gray-fg}${new Date().toLocaleTimeString()}{/gray-fg}`
}

// ── Multi-bot state ──────────────────────────────────────────────────────────
const bots = {}
let activeId = null
const rtpLocationHistory = new Map()

function updateHeader() {
  const names = Object.keys(bots)
  const activeIndex = names.indexOf(activeId) + 1
  const activeLabel = activeId ? `Active: [${activeIndex}] ${activeId}` : 'No active bot'
  const others = names.map((n, i) => i !== (activeIndex - 1) ? `[${i + 1}] ${n}` : null).filter(Boolean)
  const othersLabel = others.length ? `  |  Others: ${others.join(', ')}` : ''
  header.setContent(`{center}{bold}⛏  MINEFLAYER BOT CONSOLE{/bold}   —   ${activeLabel}${othersLabel}{/center}`)
  debouncedRender()
}

function switchTo(id) {
  if (!bots[id]) { log(`{red-fg}✗ No bot named "${sanitize(id)}"{/red-fg}`); return }
  activeId = id
  logBox.setContent('')
  logBox.scrollTo(0)
  if (bots[id].logs.length > 0) logBox.setContent(bots[id].logs.join('\n'))
  updateHeader()
  const bottom = logBox.getScrollHeight()
  if (bottom > 0) logBox.scrollTo(bottom)
  debouncedRender()
}

// ── Safe log trimming ────────────────────────────────────────────────────────
// The old code used splice() which is fine, but the real crash was blessed's
// internal buffer (now capped via scrollback above).  Our per-bot array is
// trimmed here with a simple reassignment — no risk of crash.
function logFor(id, msg) {
  if (!bots[id]) return
  const line = `${timestamp()} ${msg}`
  const logs = bots[id].logs

  logs.push(line)

  // Trim oldest lines when we exceed the cap
  if (logs.length > MAX_LOG_LINES) {
    // Keep the newest half when we hit the limit — avoids trimming on every
    // single log call once the buffer is full (which would be O(n) per log).
    const keep = Math.floor(MAX_LOG_LINES * 0.75)
    bots[id].logs = logs.slice(-keep)
  }

  if (id === activeId) { logBox.log(line); debouncedRender() }
}

function log(msg)        { if (activeId) logFor(activeId, msg) }
function logSuccess(msg) { log(`{green-fg}✓ ${msg}{/green-fg}`) }
function logError(msg)   { log(`{red-fg}✗ ${msg}{/red-fg}`) }
function logInfo(msg)    { log(`{cyan-fg}› ${msg}{/cyan-fg}`) }
function logWarn(msg)    { log(`{yellow-fg}⚠ ${msg}{/yellow-fg}`) }

// ── Discord helpers ──────────────────────────────────────────────────────────

function sendDiscordAlert(title, description, color = 0x5865F2) {
  if (!DISCORD_WEBHOOK_URL) return

  enqueueDiscord(async () => {
    try {
      await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: DISCORD_USER_ID ? `<@${DISCORD_USER_ID}>` : undefined,
          allowed_mentions: DISCORD_USER_ID ? { users: [DISCORD_USER_ID] } : undefined,
          embeds: [{
            title,
            description,
            color,
            timestamp: new Date().toISOString()
          }]
        })
      })
    } catch (err) {
      const fallbackId = activeId || Object.keys(bots)[0]
      if (fallbackId) logFor(fallbackId, `{red-fg}[discord] Failed to send alert: ${sanitize(err.message)}{/red-fg}`)
    }
  })
}

const rtpDiscordMessageIds = new Map()

function updateDiscordRtpLog(botId, x, y, z) {
  if (!DISCORD_WEBHOOK_URL) return

  enqueueDiscord(async () => {
    const title = '📜 RTP LOG'
    const description = `**${botId}** latest RTP location:\n\`${x}, ${y}, ${z}\``
    const existingId = rtpDiscordMessageIds.get(botId)

    try {
      if (!existingId) {
        const res = await fetch(DISCORD_WEBHOOK_URL + '?wait=true', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            embeds: [{ title, description, color: 0x3498DB, timestamp: new Date().toISOString() }]
          })
        })
        if (!res.ok) throw new Error(`Discord POST failed: ${res.status} ${await res.text()}`)
        const data = await res.json()
        rtpDiscordMessageIds.set(botId, data.id)
      } else {
        const res = await fetch(`${DISCORD_WEBHOOK_URL}/messages/${existingId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            embeds: [{ title, description, color: 0x3498DB, timestamp: new Date().toISOString() }]
          })
        })
        if (!res.ok) throw new Error(`Discord PATCH failed: ${res.status} ${await res.text()}`)
      }
    } catch (err) {
      logFor(botId, `{red-fg}[discord] RTP log update failed: ${sanitize(err.message)}{/red-fg}`)
      if (err.message.includes('Unknown Message') || err.message.includes('404')) {
        rtpDiscordMessageIds.delete(botId)
      }
    }
  })
}

// ── Base-finding helpers ─────────────────────────────────────────────────────

const BASE_INDICATORS = [
  'ender_chest', 'anvil', 'chipped_anvil', 'damaged_anvil',
  'smithing_table', 'furnace', 'blast_furnace', 'smoker', 'enchanting_table'
]

const storageIdCache = new WeakMap()

function getStorageBlockIds(bot) {
  if (!bot.registry) return []
  if (storageIdCache.has(bot.registry)) return storageIdCache.get(bot.registry)

  const ids = Object.keys(bot.registry.blocksByName)
    .filter(name =>
      name === 'chest' || name === 'trapped_chest' || name === 'barrel' ||
      BASE_INDICATORS.includes(name) || name.endsWith('shulker_box')
    )
    .map(name => bot.registry.blocksByName[name].id)

  storageIdCache.set(bot.registry, ids)
  return ids
}

function scanForBase(bot, id) {
  if (!bot.entity) return

  const state = bots[id]
  if (!state) return

  try {
    const ids = getStorageBlockIds(bot)
    if (ids.length === 0) return

    const positions = bot.findBlocks({
      matching: ids,
      maxDistance: BASE_SCAN_RADIUS,
      count: 4096
    })

    if (positions.length < BASE_ALERT_THRESHOLD) return

    const buckets = new Map()
    for (const pos of positions) {
      const key = `${Math.floor(pos.x / 16)},${Math.floor(pos.z / 16)}`
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(pos)
    }

    for (const [key, blockPositions] of buckets) {
      if (blockPositions.length < BASE_ALERT_THRESHOLD) continue
      if (state.alertedBases.has(key)) continue

      const counts = {}
      let hasIndicator = false

      for (const p of blockPositions) {
        const block = bot.blockAt(p)
        const name = block ? block.name : 'unknown'
        counts[name] = (counts[name] || 0) + 1
        if (BASE_INDICATORS.includes(name) || name.endsWith('shulker_box')) hasIndicator = true
      }

      if (!hasIndicator) continue

      state.alertedBases.add(key)

      const cx = Math.round(blockPositions.reduce((sum, p) => sum + p.x, 0) / blockPositions.length)
      const cy = Math.round(blockPositions.reduce((sum, p) => sum + p.y, 0) / blockPositions.length)
      const cz = Math.round(blockPositions.reduce((sum, p) => sum + p.z, 0) / blockPositions.length)
      const breakdown = Object.entries(counts).map(([n, c]) => `${c}x ${n}`).join(', ')

      logFor(id, `{magenta-fg}{bold}⛺ Possible base near ${cx}, ${cy}, ${cz} — ${blockPositions.length} storage blocks (${breakdown}){/bold}{/magenta-fg}`)
      sendDiscordAlert(`⛺ Base found — ${id}`, `Location: \`${cx}, ${cy}, ${cz}\`\nStorage blocks: ${blockPositions.length}\nBreakdown: ${breakdown}`, 0xE67E22)

      if (typeof state.pauseRtp === 'function') state.pauseRtp(RTP_PAUSE_ON_BASE_MS)
    }
  } catch (err) {
    logFor(id, `{red-fg}[scan] Error: ${sanitize(err.message)}{/red-fg}`)
  }
}

function manageTotems(bot, id) {
  if (!bot.entity || !bot.registry) return

  const state = bots[id]
  if (!state) return

  try {
    const totemDef = bot.registry.itemsByName['totem_of_undying']
    if (!totemDef) return

    const offhand = bot.inventory.slots[45]
    const hasOffhandTotem = !!(offhand && offhand.type === totemDef.id)

    if (state.lastOffhandWasTotem && !hasOffhandTotem) {
      logFor(id, `{yellow-fg}{bold}✨ TOTEM POPPED — ${id} was saved from death!{/bold}{/yellow-fg}`)
      sendDiscordAlert(`✨ Totem popped — ${id}`, `${id} used a Totem of Undying to survive near-death.`, 0xF1C40F)
    }

    if (!hasOffhandTotem) {
      const totem = bot.inventory.items().find(item => item.type === totemDef.id)
      if (totem) {
        bot.equip(totem, 'off-hand')
          .then(() => { state.lastOffhandWasTotem = true })
          .catch(err => logFor(id, `{red-fg}[totem] Equip failed: ${sanitize(err.message)}{/red-fg}`))
        return
      } else if (state.lastOffhandWasTotem) {
        logFor(id, '{yellow-fg}⚠ Out of totems!{/yellow-fg}')
      }
    }

    state.lastOffhandWasTotem = hasOffhandTotem
  } catch (err) {
    logFor(id, `{red-fg}[totem] Error: ${sanitize(err.message)}{/red-fg}`)
  }
}

function checkNearbyPlayers(bot, id) {
  if (!bot.entity) return

  const state = bots[id]
  if (!state) return

  try {
    const now = Date.now()

    for (const [name, player] of Object.entries(bot.players)) {
      if (name === id || bots[name]) continue
      if (!player.entity) continue

      const dist = bot.entity.position.distanceTo(player.entity.position)
      if (dist > PLAYER_PROXIMITY_RADIUS) continue

      const lastAlert = state.lastPlayerAlert.get(name) || 0
      if (now - lastAlert < PLAYER_PROXIMITY_COOLDOWN_MS) continue

      state.lastPlayerAlert.set(name, now)

      logFor(id, `{red-fg}{bold}⚠ Player nearby: ${sanitize(name)} (${dist.toFixed(1)} blocks){/bold}{/red-fg}`)
      sendDiscordAlert(`⚠ Player nearby — ${id}`, `${name} is ${dist.toFixed(1)} blocks from ${id}.`, 0xE74C3C)
    }
  } catch (err) {
    logFor(id, `{red-fg}[proximity] Error: ${sanitize(err.message)}{/red-fg}`)
  }
}

function manageFood(bot, id) {
  if (!bot.entity || !bot.registry) return

  const state = bots[id]
  if (!state) return

  if (bot.food === undefined || bot.food === null) return
  if (bot.food >= FOOD_EAT_THRESHOLD) return
  if (bot.currentWindow) return

  try {
    const edibleItems = bot.inventory.items().filter(item => bot.registry.foodsByName?.[item.name])

    if (edibleItems.length === 0) {
      if (!state.noFoodWarned) {
        logFor(id, '{yellow-fg}⚠ Hungry but no food in inventory!{/yellow-fg}')
        state.noFoodWarned = true
      }
      return
    }

    state.noFoodWarned = false

    edibleItems.sort((a, b) =>
      (bot.registry.foodsByName[b.name].foodPoints || 0) -
      (bot.registry.foodsByName[a.name].foodPoints || 0)
    )

    const best = edibleItems[0]
    bot.equip(best, 'hand')
      .then(() => bot.consume())
      .then(() => logFor(id, `{green-fg}✓ Ate ${sanitize(best.displayName || best.name)}{/green-fg}`))
      .catch(err => logFor(id, `{red-fg}[food] Eat failed: ${sanitize(err.message)}{/red-fg}`))
  } catch (err) {
    logFor(id, `{red-fg}[food] Error: ${sanitize(err.message)}{/red-fg}`)
  }
}

// ── Proxy crash detection ────────────────────────────────────────────────────

function isProxyCrash(reason) {
  if (!reason) return false
  const text = typeof reason === 'string' ? reason : (reason.message || String(reason))
  return PROXY_CRASH_PATTERNS.some(re => re.test(text))
}

// ── Bot creation ─────────────────────────────────────────────────────────────

function createBotInstance(username, host = HOST, port = PORT, version = VERSION) {
  const id = username
  let connected = false
  let manualDisconnect = false
  let reconnectTimer = null

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

  const existingLogs              = bots[id]?.logs              || []
  const existingAlertedBases      = bots[id]?.alertedBases      || new Set()
  const existingReconnectAttempts = bots[id]?.reconnectAttempts  || 0

  let bot
  try {
    bot = mineflayer.createBot({ host, port, username: id, version, hideErrors: true })
  } catch (err) {
    const fallback = activeId || id
    logFor(fallback, `{red-fg}✗ Failed to create bot "${id}": ${sanitize(err.message)}{/red-fg}`)
    return null
  }

  bot.loadPlugin(armorManager)

  bots[id] = {
    bot, spawnTime: null, logs: existingLogs, host, port, version,
    alertedBases: existingAlertedBases,
    lastOffhandWasTotem: false,
    lastPlayerAlert: new Map(),
    noFoodWarned: false,
    reconnectAttempts: existingReconnectAttempts,
    lastKickReason: null,
    lastDisconnectReason: null
  }

  const timeouts  = []
  const intervals = []

  const pushT = (fn, delay) => { const t = setTimeout(fn, delay);  timeouts.push(t);  return t }
  const pushI = (fn, delay) => { const iv = setInterval(fn, delay); intervals.push(iv); return iv }

  const clearAll = () => {
    timeouts.forEach(clearTimeout);   timeouts.length = 0
    intervals.forEach(clearInterval); intervals.length = 0
  }

  const scheduleReconnect = (reason, rawError) => {
    clearAll()
    connected = false
    if (manualDisconnect || reconnectTimer) return

    const proxyCrash = isProxyCrash(rawError || reason)
    const attempt = bots[id]?.reconnectAttempts || 0

    let delay
    if (proxyCrash) {
      delay = FAST_RECONNECT_MS
      w(`${reason} (proxy transfer crash detected). Reconnecting in ${(delay / 1000).toFixed(1)}s…`)
    } else {
      delay = Math.min(RECONNECT_BASE_MS * Math.pow(1.3, attempt), RECONNECT_MAX_MS)
      if (bots[id]) bots[id].reconnectAttempts = attempt + 1
      w(`${reason}. Auto-reconnecting in ${(delay / 1000).toFixed(1)}s (Attempt ${attempt + 1})…`)
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      createBotInstance(id, host, port, version)
    }, delay)
  }

  const safeChat = (msg) => {
    if (!connected || !bot.entity) return false
    try { bot.chat(msg); return true } catch (err) {
      logFor(id, `{red-fg}[chat] Failed: ${sanitize(err.message)}{/red-fg}`)
      return false
    }
  }

  // ── RTP scheduling ─────────────────────────────────

  let rtpTimer = null

  const scheduleRtp = (delay) => {
    rtpTimer = pushT(() => {
      bot.chat(RTP_COMMAND)
      i(`Sent ${RTP_COMMAND} (periodic)`)

      pushT(() => {
        if (bot.entity) {
          const pos = bot.entity.position
          const x = Math.round(pos.x)
          const y = Math.round(pos.y)
          const z = Math.round(pos.z)

          i(`Arrived at RTP location: ${x}, ${y}, ${z}`)
          updateDiscordRtpLog(id, x, y, z)

          const chunkKey = `${Math.floor(x / 16)},${Math.floor(z / 16)}`
          const timesSeen = (rtpLocationHistory.get(chunkKey) || 0) + 1
          rtpLocationHistory.set(chunkKey, timesSeen)

          if (rtpLocationHistory.size > MAX_RTP_HISTORY_SIZE) {
            const excess = rtpLocationHistory.size - MAX_RTP_HISTORY_SIZE
            const iter = rtpLocationHistory.keys()
            for (let n = 0; n < excess; n++) rtpLocationHistory.delete(iter.next().value)
          }

          if (timesSeen > 1) w(`Notice: We have RTP'd to this chunk area ${timesSeen} times!`)
        }
      }, 5000)

      scheduleRtp(RTP_INTERVAL_MS + Math.random() * 15000)
    }, delay)
  }

  bots[id].pauseRtp = (ms) => {
    if (rtpTimer) clearTimeout(rtpTimer)
    w(`Base found — holding position, RTP paused for ${(ms / 60000).toFixed(1)} min.`)
    scheduleRtp(ms)
  }

  // ── Start roaming mode ─────────────────────────────

  const startRoaming = () => {
    i('Entering roam mode: RTP + totem/food management + base & player scanning')

    safeChat(RTP_COMMAND)
    s(`Sent ${RTP_COMMAND}`)

    pushI(() => manageTotems(bot, id),         3000)
    pushI(() => manageFood(bot, id),           FOOD_CHECK_INTERVAL_MS)
    pushI(() => scanForBase(bot, id),          BASE_SCAN_INTERVAL_MS)
    pushI(() => checkNearbyPlayers(bot, id),   PLAYER_PROXIMITY_INTERVAL_MS)

    scheduleRtp(RTP_INTERVAL_MS + Math.random() * 15000)
  }

  // ── Lifecycle events ───────────────────────────────

  let lastRawError = null

  bot.once('login', () => {
    i('Connected to server socket. Sending auth…')
    pushT(() => bot.chat(`/login ${LOGIN_PASSWORD}`), 2220 + Math.random() * 400)
  })

  bot.once('spawn', () => {
    connected = true
    if (bots[id]) bots[id].spawnTime = Date.now()
    s(`Spawned on ${host}:${port} (v${version}).`)

    pushT(() => { if (connected && bots[id]) bots[id].reconnectAttempts = 0 }, 60_000)

    pushT(() => {
      i('Right-clicking compass (server selector)…')
      try { bot.activateItem() } catch (err) { e(`activateItem failed: ${sanitize(err.message)}`) }
    }, 3600 + Math.random() * 600)
  })

  bot.on('windowOpen', (window) => {
    try {
      const title = window.title?.toString ? window.title.toString() : String(window.title || '')
      i(`Window opened: ${sanitize(title)} (${window.slots.length} slots)`)

      window.slots.forEach((item, idx) => {
        if (item) i(`  slot ${idx}: ${item.count}x ${sanitize(item.displayName || item.name)}`)
      })

      if (GUI_SLOT >= window.slots.length) {
        w(`Slot ${GUI_SLOT} out of bounds — window only has ${window.slots.length} slots`)
        return
      }
      if (!window.slots[GUI_SLOT]) {
        w(`Slot ${GUI_SLOT} is empty — not clicking.`)
        return
      }

      pushT(async () => {
        if (!bot.currentWindow) { w('Window closed before click could fire.'); return }
        try {
          await bot.clickWindow(GUI_SLOT, 0, 0)
          i(`Clicked slot ${GUI_SLOT} — waiting for server transfer…`)
        } catch (err) { e(`Click failed: ${sanitize(err.message || String(err))}`) }

        pushT(() => {
          if (MODE === 'roam') startRoaming()
          else { safeChat('/warp afk'); s('Sent /warp afk') }
        }, 8000 + Math.random() * 4200)
      }, 2000 + Math.random() * 1600)
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

  bot.on('error', (err) => {
    lastRawError = err
    if (bots[id]) bots[id].lastDisconnectReason = err.message || String(err)
    if (isProxyCrash(err)) {
      w(`Proxy packet error (will auto-reconnect): ${sanitize(err.message || String(err))}`)
    } else {
      e(`Error: ${sanitize(err.message || String(err))}`)
    }
  })

  if (bot._client) {
    bot._client.on('error', (err) => {
      lastRawError = err
      if (bots[id]) bots[id].lastDisconnectReason = err.message || String(err)
      if (isProxyCrash(err)) {
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
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    clearAll()
    try { bot.quit() } catch (_) {}
  }

  if (!activeId) activeId = id
  updateHeader()
  return bot
}

// ── Connect all bots with staggered delay ────────────────────────────────────
BOT_NAMES.forEach((name, index) => {
  setTimeout(() => {
    createBotInstance(name)
    if (index === 0) switchTo(name)
  }, index * CONNECT_DELAY_MS)
})

// ── Command registry ─────────────────────────────────────────────────────────
const COMMANDS = {
  '/all <cmd>':      'Run a local command on EVERY bot, or broadcast a raw chat/command to all',
  '/overview':       'Dashboard of every bot\'s health, food, ping, and shard count',
  '/list':           'Compact one-line-per-bot status list (online / offline / last kick)',
  '/chat <msg>':     'Send a chat message from the active bot (avoids triggering local commands)',
  '/disconnect':     'Disconnect the active bot (stops auto-reconnect). Alias: /dc',
  '/clear':          'Clear the active bot\'s log view',
  '/help':           'List all available commands',
  '/status':         'Show active bot\'s connection, position, health, ping, uptime',
  '/inv':            'List active bot\'s inventory',
  '/players':        'List players online from the active bot\'s perspective',
  '/rtp':            'Manually send the RTP command as the active bot',
  '/exit':           'Disconnect all bots and close the program',
  '/reconnect':      'Reconnect the active bot',
  '/reconnect-all':  'Reconnect every currently disconnected bot',
  '/new-bot <name> [host] [port] [ver]': 'Create and connect a new bot',
  '/switch <id>':    'Switch view to a different bot by name or number',
  '/uptime':         'Show uptime for all bots',
  '/mem':            'Show memory usage breakdown',
  'anything else':   'Sent directly as a chat message/command from the active bot'
}

const LOCAL_COMMANDS = ['/status', '/inv', '/players', '/rtp', '/clear', '/disconnect', '/dc', '/reconnect']

function formatUptime(ms) {
  if (!ms || ms <= 0) return '0s'
  const s = Math.floor(ms / 1000)
  const parts = []
  if (s >= 3600)       parts.push(`${Math.floor(s / 3600)}h`)
  if (s % 3600 >= 60)  parts.push(`${Math.floor((s % 3600) / 60)}m`)
  parts.push(`${s % 60}s`)
  return parts.join(' ')
}

function runLocalCommandForBot(id, cmd) {
  const entry = bots[id]
  if (!entry) return false
  const { bot } = entry

  switch (cmd) {
    case '/status': {
      if (!bot.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return true }
      const pos = bot.entity.position
      const up = entry.spawnTime ? formatUptime(Date.now() - entry.spawnTime) : '0s'
      logFor(id, `{cyan-fg}› Status for ${id}:{/cyan-fg}`)
      logFor(id, `  Server: ${entry.host}:${entry.port} (v${entry.version})`)
      logFor(id, `  Position: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`)
      logFor(id, `  Health: ${bot.health ?? 'N/A'}  Food: ${bot.food ?? 'N/A'}`)
      logFor(id, `  Ping: ${bot.player?.ping ?? 'N/A'}ms`)
      logFor(id, `  Uptime: ${up}`)
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

    case '/players': {
      if (!bot.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return true }
      const players = Object.keys(bot.players)
      logFor(id, `{cyan-fg}› Players online (${players.length}):{/cyan-fg}`)
      players.forEach(name => logFor(id, `  ${sanitize(name)}`))
      return true
    }

    case '/rtp': {
      if (!bot.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return true }
      try { bot.chat(RTP_COMMAND) } catch (err) { logFor(id, `{red-fg}[rtp] Chat failed: ${sanitize(err.message)}{/red-fg}`) }
      logFor(id, `{cyan-fg}› Sent ${RTP_COMMAND}{/cyan-fg}`)
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

    case '/reconnect': {
      const { host, port, version } = entry
      logFor(id, `{yellow-fg}⚠ Reconnecting ${id}…{/yellow-fg}`)
      try { entry.disconnectManually() } catch (_) {}
      setTimeout(() => createBotInstance(id, host, port, version), 1000)
      return true
    }

    default:
      return false
  }
}

function queryShards(id, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const entry = bots[id]
    if (!entry?.bot?.entity) { resolve(null); return }
    const bot = entry.bot

    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      bot.removeListener('message', onMessage)
      clearTimeout(timer)
      resolve(value)
    }

    const onMessage = (jsonMsg) => {
      try {
        const text = jsonMsg.toString()
        const match = text.match(/Shards.{0,10}Balance:?\s*([\d,]+)/i)
        if (match) finish(parseInt(match[1].replace(/,/g, ''), 10))
      } catch (_) {}
    }

    const timer = setTimeout(() => finish(null), timeoutMs)
    bot.on('message', onMessage)
    try { bot.chat('/shards') } catch (_) { finish(null) }
  })
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
      logSuccess(`Ran "${baseCmd}" on ${count} bots. (Switch to a bot to see its individual output.)`)
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
    logInfo('Querying shard counts…')

    Promise.all(names.map(name => {
      if (!bots[name]?.bot?.entity) return Promise.resolve({ name, shards: null })
      return queryShards(name).then(shards => ({ name, shards }))
    })).then(results => {
      results.forEach(({ name, shards }, idx) => {
        const b = bots[name]
        if (b?.bot?.entity) {
          const hp   = Math.round(b.bot.health || 0)
          const food = Math.round(b.bot.food || 0)
          const ping = b.bot.player?.ping ?? '?'
          const sh   = shards !== null ? shards.toLocaleString() : 'N/A'
          log(`[${idx + 1}] {cyan-fg}${name}{/cyan-fg} : {green-fg}Online{/green-fg} | HP: ${hp} | Food: ${food} | Ping: ${ping}ms | Shards: ${sh}`)
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

  if (trimmed === '/mem') {
    const mem = process.memoryUsage()
    logInfo('{bold}── Memory Usage ──{/bold}')
    log(`  RSS:         ${(mem.rss / 1048576).toFixed(1)} MB`)
    log(`  Heap Used:   ${(mem.heapUsed / 1048576).toFixed(1)} MB`)
    log(`  Heap Total:  ${(mem.heapTotal / 1048576).toFixed(1)} MB`)
    log(`  External:    ${(mem.external / 1048576).toFixed(1)} MB`)

    let totalLogLines = 0
    Object.values(bots).forEach(b => { totalLogLines += b.logs.length })
    log(`  Log lines:   ${totalLogLines.toLocaleString()} across ${Object.keys(bots).length} bots (cap: ${MAX_LOG_LINES.toLocaleString()}/bot)`)
    log(`  RTP history: ${rtpLocationHistory.size.toLocaleString()} entries (cap: ${MAX_RTP_HISTORY_SIZE.toLocaleString()})`)
    log(`  Discord queue: ${discordQueue.length} pending`)
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

// ════════════════════════════════════════════════════════════════════════════
// INPUT HANDLING & HISTORY
// ════════════════════════════════════════════════════════════════════════════

const commandHistory = []
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
    if (commandHistory[commandHistory.length - 1] !== trimmed) commandHistory.push(trimmed)
    historyIndex = -1
    handleCommand(trimmed)
  }
})

inputBox.on('cancel', () => {
  inputBox.clearValue()
  inputBox.focus()
  debouncedRender()
})

screen.render()
