require('dotenv').config() // npm install dotenv ws — neo-blessed only if TUI_GUI, socks only for PROXY_HOST
const {
  readDelayMs,
  readInt,
  readNumber,
  parseDumpMode,
  parseCratesAllDump,
  parseCratesAllFlags,
  shuffledCopy,
  createSlowBroadcast,
  createSlowBroadcastManager,
  parseProxyGroups,
  findIgnoredProxyGroupVars,
  resolveBotProxy,
  hasProxyAuth,
  proxyAuthHeader,
  buildHttpConnectRequest,
  describeProxy,
  resolveLoginPassword,
  parseBotPasswords,
  classifyAuthReply,
  nextAuthFailure,
  isAuthBlocked,
  parseSleepDuration,
  parseCommandChain,
  executeCommandChain: executeCommandChainBase,
  parseNameList,
  parseDataArgs,
  hasInventoryItems,
  randomInt,
  buildHiddenDumpPlan
} = require('./bot-controls')
const os = require('os')
const { createMonitoring, classifyKick } = require('./monitoring')
const removedBotsStore = require('./removed-bots')
const net = require('net')
const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const zlib = require('zlib')
const { exec } = require('child_process')
const { createTerminal, sshConfig } = require('./expose-terminal')
const dataStore = require(path.join(__dirname, 'data-store'))
// Runtime settings (the dashboard .ENV tab: temporary overrides, never written to disk),
// coinflip data collection, the time-series store, and the read-only analytics pages.
const settings = require(path.join(__dirname, 'settings'))
const coinflip = require(path.join(__dirname, 'coinflip'))
const analysis = require(path.join(__dirname, 'analysis'))
const timeseries = require(path.join(__dirname, 'timeseries'))
const analytics = require(path.join(__dirname, 'analytics'))
const { handleChartJs, handleCoinflipDashboardJs } = require('./coinflip-dashboard-static')
const { callFreeLLMChat, getAvailableModels } = require('./ai-chat')
const mineflayer = require('mineflayer')
const armorManager = require('mineflayer-armor-manager')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
let SocksClient
try { ({ SocksClient } = require('socks')) } catch (_) { /* only needed if PROXY_HOST is set and PROXY_TYPE=socks5 — npm install socks */ }

// ── .env config (original) ──────────────────────────────────────────────────
const HOST = process.env.HOST || 'play.fatalmc.org'
const PORT = parseInt(process.env.PORT || '25565', 10)
const VERSION = process.env.VERSION || '1.21.2'
// The /register + /login password is resolved PER BOT (resolveLoginPassword), so
// each proxy group of accounts can use its own and a single bot can override
// both; LOGIN_PASSWORD stays the fallback for every bot not covered. See
// bot-controls.js for the precedence and the two BOT_PASSWORD spellings.
const BOT_PASSWORDS = parseBotPasswords()

// ── Login / register failure guard ───────────────────────────────────────────
// A rejected /login is treated as a configuration mistake, not a network blip:
// the bot answers every prompt it sees, so a wrong password gets the account
// rate-limited and then kicked, which is how a typo in .env turns into a ban.
// Once a failure is recorded the bot stops sending auth commands, says which
// variable to fix, and alerts Discord once. A restart (or /auth-retry) clears it,
// deliberately: the fix is an edit to .env, and a restart is how that lands.
const AUTH_REPLY_WINDOW_MS = parseInt(process.env.AUTH_REPLY_WINDOW_MS || '30000', 10)
const AUTH_THROTTLE_MS = parseInt(process.env.AUTH_RETRY_MS || '300000', 10)
const AUTH_ALREADY_MS = parseInt(process.env.AUTH_ALREADY_MS || '60000', 10)
const AUTH_MAX_THROTTLED = Math.max(1, parseInt(process.env.AUTH_MAX_THROTTLED_RETRIES || '2', 10))
// id -> { sentAt, kind, failure }. Survives reconnects on purpose: the failure is
// a property of the credentials, not of this one connection, so reconnecting
// must not talk the bot back into retrying them.
const authState = new Map()

// Decides what one server message means for one bot, and records the outcome.
// Pulled out of the chat handler so the whole guard can be exercised without a
// live connection. Returns one of:
//   { record, alert }             a failure was recognised (alert only when it is
//                                 new or changed kind, so Discord is told once)
//   { skip }                      an auth prompt we refuse to answer
//   { command, source, kind }     an auth prompt to answer
function planAuthAction(id, message, now = Date.now()) {
  const text = String(message || '').toLowerCase()
  const state = authState.get(id) || {}
  const failure = state.failure || null

  // A failure reply only counts as one if it answers something we just sent.
  // Without that window, a player typing "wrong password" into chat would stop a
  // bot from ever logging in again.
  if (state.sentAt && now - state.sentAt <= settings.get('AUTH_REPLY_WINDOW_MS') && !detectPlayerChat(message)) {
    const verdict = classifyAuthReply(message)
    if (verdict) {
      const next = nextAuthFailure(failure, verdict, now, {
        throttleMs: settings.get('AUTH_RETRY_MS'), alreadyMs: settings.get('AUTH_ALREADY_MS'), maxThrottled: settings.get('AUTH_MAX_THROTTLED_RETRIES')
      })
      // Clear sentAt so the same reply cannot be counted twice.
      authState.set(id, { ...state, failure: next, sentAt: 0 })
      return { record: next, alert: !failure || failure.kind !== next.kind }
    }
  }

  const wantsRegister = text.includes('register') && text.includes('/register')
  const wantsLogin = text.includes('login') && text.includes('/login')
  if (!wantsRegister && !wantsLogin) return {}

  // A throttled failure expires, so this lets it through once its wait is over.
  if (isAuthBlocked(failure, now)) return { skip: failure }

  const auth = resolveLoginPassword(id, PROXY_GROUPS, process.env, BOT_PASSWORDS)
  const kind = wantsRegister ? 'register' : 'login'
  authState.set(id, { ...state, sentAt: now, kind })
  return {
    command: wantsRegister ? `/register ${auth.password} ${auth.password}` : `/login ${auth.password}`,
    source: auth.source,
    kind
  }
}

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
const TPA_MAIN_PLAYER = (process.env.TPA_MAIN_PLAYER || process.env.TPA_TARGET_PLAYER || '').trim()
const TPA_TRUSTED_BOTS = parseNameList(process.env.TPA_TRUSTED_BOTS || BOT_NAMES.join(','))
const TPA_AUTO_DEFAULT = /^(1|true|yes|on)$/i.test(process.env.TPA_AUTO_DEFAULT || 'false')
const DUMP_HOME_COMMAND = (process.env.DUMP_HOME_COMMAND || '/home stash').trim()
const DUMP_MIN_TPA_GAP_MS = Math.max(180000, parseInt(process.env.DUMP_MIN_TPA_GAP_MS || '180000', 10))
const DUMP_HIDDEN_MIN_MS = Math.max(60000, parseInt(process.env.DUMP_HIDDEN_MIN_MS || '480000', 10))
const DUMP_HIDDEN_MAX_MS = Math.max(DUMP_HIDDEN_MIN_MS, parseInt(process.env.DUMP_HIDDEN_MAX_MS || '720000', 10))
// /dump + /dump-spawners tuning. Every value has the long-standing default, so
// an existing .env needs no changes; invalid values fall back instead of
// producing NaN timers.
const DUMP_TPA_TIMEOUT_MS = readDelayMs(process.env.DUMP_TPA_TIMEOUT_MS, 45000)
const DUMP_TPA_MIN_DISTANCE = readNumber(process.env.DUMP_TPA_MIN_DISTANCE, 10, 0.5, 1000)
const DUMP_SETTLE_MS = readDelayMs(process.env.DUMP_SETTLE_MS, 2500)
const DUMP_WARP_DELAY_MS = readDelayMs(process.env.DUMP_WARP_DELAY_MS, 2500)
const DUMP_CLICK_DELAY_MS = readDelayMs(process.env.DUMP_CLICK_DELAY_MS, 120)
const DUMP_OPEN_TIMEOUT_MS = readDelayMs(process.env.DUMP_OPEN_TIMEOUT_MS, 15000)
const CHEST_SCAN_RADIUS = readNumber(process.env.CHEST_SCAN_RADIUS, 30, 1, 256)
const CHEST_SCAN_COUNT = readInt(process.env.CHEST_SCAN_COUNT, 50, 1, 500)
let hiddenDumpRun = null

// ── Persistent /data recorder ───────────────────────────────────────────────
// JSON is the durable local source of truth. /data compiles it into one current
// snapshot and optionally POSTs that snapshot to a Google Apps Script webhook.
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'spawner-data.json')
const DATA_WEBHOOK_URL = (process.env.DATA_WEBHOOK_URL || '').trim()
// Shared secret for the Apps Script endpoint (matched against its WEBHOOK_SECRET
// script property, or "secret" in the POST body). Empty disables the check.
const DATA_WEBHOOK_SECRET = (process.env.DATA_WEBHOOK_SECRET || '').trim()
const DATA_WEBHOOK_TIMEOUT_MS = readDelayMs(process.env.DATA_WEBHOOK_TIMEOUT_MS, 15000)
const dataState = dataStore.loadState(DATA_FILE)
function persistData () {
  dataState.updatedAt = new Date().toISOString()
  dataStore.saveState(DATA_FILE, dataState)
}

// ── Removed / permanently-banned list ───────────────────────────────────────
// A permanent ban means the account is gone, so the bot leaves the roster instead
// of being retried forever. That cannot live in .env (the bot cannot edit
// BOT_NAMES for you), so it is its own file, loaded at startup and consulted
// before anything else decides to connect.
const REMOVED_BOTS_FILE = (process.env.REMOVED_BOTS_FILE || '').trim() || path.join(__dirname, 'removed-bots.json')
// What a permanent ban does to the live roster: 'remove' mirrors /closeBot,
// 'hold' keeps the entry visible with the banned badge.
const PERMANENT_BAN_ACTION = /^(hold|keep|visible)$/i.test(process.env.PERMANENT_BAN_ACTION || '') ? 'hold' : 'remove'
// How long to wait before retrying a ban whose length the server never stated.
const BAN_RETRY_MS = readDelayMs(process.env.BAN_RETRY_MS, 1800000)
let removedBots = removedBotsStore.loadRemovedBots(REMOVED_BOTS_FILE)
function persistRemovedBots () { removedBots = removedBotsStore.saveRemovedBots(REMOVED_BOTS_FILE, removedBots) }
function removedEntryFor (id) { return removedBotsStore.findRemovedBot(removedBots, id) }
// Mirrors /closeBot: disconnect first (which stops the reconnect path dead), then
// drop the entry so it stops appearing as a bot that might come back.
function dropFromRoster (id) {
  try { bots[id]?.disconnectManually() } catch (_) {}
  if (!bots[id]) return false
  delete bots[id]
  if (activeId === id) {
    const rest = Object.keys(bots)
    activeId = rest.length ? rest[rest.length - 1] : null
    if (!activeId && tui) { try { tui.clear() } catch (_) {} }
  }
  notifyBotsChanged()
  return true
}

// ── Ban hold ────────────────────────────────────────────────────────────────
// A banned account must stop knocking, and a ban outlives the process: a 29-day
// ban cannot live in a setTimeout, and a restart must not walk straight back into
// the server. So the absolute expiry is the number that matters, it is stored in
// the data file (surviving restarts), and a slow sweep is what ends the hold.
function activeBan (id) {
  const row = dataState.bots?.[id]
  const state = dataStore.isBanActive(row)
  if (!state.held) return null
  return { expiresAt: state.expiresAt, permanent: state.permanent, kind: row.banKind || 'permanent' }
}

// Called on a timer rather than scheduled per ban: one sweep handles every bot,
// needs no long-lived timer, and re-reads the file state so a restart resumes the
// hold correctly instead of losing it.
function releaseExpiredBans () {
  Object.keys(dataState.bots || {}).forEach(id => {
    const row = dataState.bots[id]
    if (!row || !row.banned) return
    const expiresAt = Number(row.banExpiresAt) || 0
    // No expiry means permanent — that one is never released automatically.
    if (!expiresAt || Date.now() < expiresAt) return
    dataStore.upsertBot(dataState, { bot: id, banned: false, bannedAt: null, banKind: null, banReason: null, banExpiresAt: 0 })
    persistData()
    logFor(id, `{green-fg}✓ ${sanitize(id)}'s ban has expired — reconnecting.{/green-fg}`)
    const { host, port, version } = bots[id] || { host: HOST, port: PORT, version: VERSION }
    try { bots[id]?.disconnectManually() } catch (_) {}
    setTimeout(() => createBotInstance(id, host, port, version), 1000)
    notifyBotsChanged()
  })
}

const BAN_SWEEP_MS = readDelayMs(process.env.BAN_SWEEP_MS, 60000)
const banSweepTimer = setInterval(releaseExpiredBans, BAN_SWEEP_MS)
if (banSweepTimer.unref) banSweepTimer.unref()
function botLocation (bot) {
  const p = bot?.entity?.position
  return { x: p?.x ?? null, y: p?.y ?? null, z: p?.z ?? null, dimension: bot?.game?.dimension || null }
}

// ── Chat activity watchdog ───────────────────────────────────────────────────
// If no player chat has been seen for CHAT_WATCHDOG_TIMEOUT_MS, the bot runs
// CHAT_WATCHDOG_COMMAND (default: /server lifesteal) to nudge itself back onto
// the right server. Chat lines can be prefixed with odd unicode just before the
// "<name>: message" part — detectPlayerChat strips non-ASCII before matching.
const CHAT_WATCHDOG_ENABLED = /^(1|true|yes|on)$/i.test(process.env.CHAT_WATCHDOG_ENABLED ?? 'true')
const CHAT_WATCHDOG_TIMEOUT_MS = parseInt(process.env.CHAT_WATCHDOG_TIMEOUT_MS || '600000', 10)
const CHAT_WATCHDOG_CHECK_MS = parseInt(process.env.CHAT_WATCHDOG_CHECK_MS || '60000', 10)
const CHAT_WATCHDOG_COMMAND = (process.env.CHAT_WATCHDOG_COMMAND ?? '').trim()
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

// ── Minecraft web client (/play tab): self-hosted zardoy/minecraft-web-client ──
// The client build (web-client/dist — see scripts/build-web-client.sh or the
// Dockerfile) is served locally by web-client.js on its own port and embedded
// in /play. The browser client talks WebSocket to a proxy (mwc-proxy — self-host
// with ./run-docker.sh proxy or `npx minecraft-web-proxy`) that bridges to the
// Minecraft server over TCP. MC_WEB_SERVER/…/MC_WEB_PROXY only prefill the
// connect screen; everything can be edited in the client itself.
const MC_WEB_ENABLED = /^(1|true|yes|on)$/i.test(process.env.MC_WEB_ENABLED ?? 'true')
const MC_WEB_CLIENT_URL = process.env.MC_WEB_CLIENT_URL || '' // override for the client page (e.g. https://client.example.com); empty = serve the local build
const MC_WEB_CLIENT_PORT = parseInt(process.env.MC_WEB_CLIENT_PORT || '8090', 10) // local port serving the client build
const MC_WEB_CLIENT_PORT_MAX_ATTEMPTS = parseInt(process.env.MC_WEB_CLIENT_PORT_MAX_ATTEMPTS || '10', 10)
const MC_WEB_CLIENT_DIR = process.env.MC_WEB_CLIENT_DIR || require('path').join(__dirname, 'web-client', 'dist')
const MC_WEB_CLIENT_HOST_PORT = process.env.MC_WEB_CLIENT_HOST_PORT || '' // host-side client port when docker maps it (set by run-docker.sh)
// Non-Docker installs have no baked-in client build (the Dockerfile produces
// web-client/dist; a plain `npm run start` never has). With this on (default)
// the build runs automatically the first time /play is opened — lazily, so
// nothing is downloaded or compiled unless the tab is actually used — and the
// page shows progress until it is ready. Set MC_WEB_AUTO_BUILD=false to keep
// the old behaviour (a "build not found" page telling you to build by hand).
const MC_WEB_AUTO_BUILD = /^(1|true|yes|on)$/i.test(process.env.MC_WEB_AUTO_BUILD ?? 'true')
const MC_WEB_BUILD_CMD = (process.env.MC_WEB_BUILD_CMD || '').trim() // override the build command (default: sh scripts/build-web-client.sh)
const MC_WEB_SERVER = process.env.MC_WEB_SERVER || '' // e.g. play.example.com:25565 (prefilled server address)
const MC_WEB_VERSION = process.env.MC_WEB_VERSION || '1.21.4' // protocol version the client uses
const MC_WEB_USERNAME = process.env.MC_WEB_USERNAME || '' // offline-mode username prefilled in the client
const MC_WEB_PROXY = process.env.MC_WEB_PROXY || '' // self-hosted mwc-proxy, e.g. wss://mc.example.com (https page → wss required)

// Build the client URL with connect-screen prefills. Pure so tests can call it.
function webClientUrl({ base = 'http://localhost/', ip = '', version = '', username = '', proxy = '' } = {}) {
const u = new URL(base)
const q = u.searchParams
if (ip) q.set('ip', ip)
if (version) q.set('version', version)
if (username) q.set('username', username)
if (proxy) q.set('proxy', proxy)
return u.toString()
}
const SSH_CONFIG = sshConfig()
const SSH_ENABLED = SSH_CONFIG.enabled
const WS_BROADCAST_INTERVAL_MS = readDelayMs(process.env.WS_BROADCAST_INTERVAL_MS, 100)
const WS_SEND_MAX_BUFFERED = 1 << 20 // 1MB; drop pushes to clients this far behind instead of buffering
// Dashboard only sends LOG_VIEW_LINES per channel, so 1500 stored lines is
// generous headroom while keeping memory low on small hosts.
const LOG_MAX_LINES = readInt(process.env.LOG_MAX_LINES, 1500, 50, 200000)
const LOG_VIEW_LINES = readInt(process.env.LOG_VIEW_LINES, 400, 10, 200000)
// Log retention: lines older than LOG_PRUNE_MINUTES are dropped every
// LOG_PRUNE_INTERVAL_MS. Set LOG_PRUNE_MINUTES=0 to keep logs for the session.
const LOG_PRUNE_MINUTES = readNumber(process.env.LOG_PRUNE_MINUTES, 20, 0, 1440)
const LOG_PRUNE_INTERVAL_MS = readDelayMs(process.env.LOG_PRUNE_INTERVAL_MS, 60000)
// Dashboard knobs: page title and the HTTP fallback poll cadence used when the
// browser cannot open a WebSocket (WS push cadence: WS_BROADCAST_INTERVAL_MS).
const DASHBOARD_TITLE = (process.env.DASHBOARD_TITLE || 'AFK Console').trim() || 'AFK Console'
const WEB_REFRESH_MS = readDelayMs(process.env.WEB_REFRESH_MS, 2000)
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

// ── /spawners config ───────────────────────────────────────────────────────
// The bot never moves for this: it scans for spawner blocks already inside its
// reach, right-clicks each one, clicks SPAWNER_SLOT_FIRST (13) in the GUI that
// opens, waits, clicks SPAWNER_SLOT_SECOND (53), then moves on to the next
// spawner until every reachable spawner has been handled.
const SPAWNER_BLOCK = process.env.SPAWNER_BLOCK || 'spawner'
const SPAWNER_REACH = parseFloat(process.env.SPAWNER_REACH || '4.5')
const SPAWNER_MAX_COUNT = parseInt(process.env.SPAWNER_MAX_COUNT || '64', 10)
const SPAWNER_SLOT_FIRST = parseInt(process.env.SPAWNER_SLOT_FIRST || '13', 10)
const SPAWNER_SLOT_SECOND = parseInt(process.env.SPAWNER_SLOT_SECOND || '53', 10)
const SPAWNER_WINDOW_WAIT_MS = parseInt(process.env.SPAWNER_WINDOW_WAIT_MS || '3000', 10)
const SPAWNER_SLOT_DELAY_MS = parseInt(process.env.SPAWNER_SLOT_DELAY_MS || '1500', 10)
const SPAWNER_NEXT_DELAY_MS = parseInt(process.env.SPAWNER_NEXT_DELAY_MS || '1500', 10)

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
// What /crates-all does once the crates are done. Defaults reproduce the
// original behaviour exactly (TPA to TPA_MAIN_PLAYER → dump into nearby chests
// → /warp afk after 15s), so an existing .env keeps working unchanged:
//   CRATES_ALL_DUMP         off | tpa (default) | home | hidden | player:<name>
//   CRATES_ALL_AFK_WARP     false leaves each bot wherever the sequence ended
//   CRATES_ALL_AFK_DELAY_MS 0 warps to AFK the instant the routine finishes
// The same two knobs are available per run as `dump=` / `afk=` flags.
const CRATES_ALL_DUMP_ENV = parseCratesAllDump(process.env.CRATES_ALL_DUMP)
const CRATES_ALL_AFK_WARP = /^(1|true|yes|on)$/i.test(process.env.CRATES_ALL_AFK_WARP ?? 'true')
const CRATES_ALL_AFK_DELAY_MS = readInt(process.env.CRATES_ALL_AFK_DELAY_MS, 15000, 0, 2147483647)
const CRATES_ALL_FLAGS_USAGE = '[dump=off|tpa|home|hidden|player:<name>] [afk=now|off|<seconds>]'
const CRATES_ALL_USAGE = `/crates-all [n] [color] ${CRATES_ALL_FLAGS_USAGE}`
const CRATES_ALL_SOLO_USAGE = `/crates-solo [bot name or number] [color] ${CRATES_ALL_FLAGS_USAGE}`

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
// Credentials for the GLOBAL proxy. Each PROXY_GROUP_<N>_* carries its own, so
// two providers on one machine never share a login. _PASSWORD is an accepted
// spelling of _PASS everywhere, since both read naturally.
const PROXY_USER = process.env.PROXY_USER || ''
const PROXY_PASS = process.env.PROXY_PASS !== undefined
? process.env.PROXY_PASS
: (process.env.PROXY_PASSWORD || '')
const PROXY_DEFAULT = PROXY_ENABLED ? { host: PROXY_HOST, port: PROXY_PORT, type: PROXY_TYPE, user: PROXY_USER, pass: PROXY_PASS } : null
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
// Only a local SOCKS proxy can be restarted from here, and the command to do it
// differs per platform: Homebrew on macOS, systemd on Linux. It used to assume
// brew unconditionally, so a Linux host running Tor locally hit "brew: command
// not found" from the stall watchdog. Unset on anything else — the watchdog
// then stays quiet instead of spawning a command that cannot work.
const PROXY_RESTART_CMD = process.env.PROXY_RESTART_CMD || (PROXY_IS_LOCAL
? (process.platform === 'darwin' ? 'brew services restart tor'
: process.platform === 'linux' ? 'systemctl restart tor 2>/dev/null || sudo systemctl restart tor'
: '')
: '')
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
onLog?.(`Tunnelling through SOCKS5 proxy ${describeProxy(proxy)}${proxy.pass ? ' (authenticated)' : ''}…`)
SocksClient.createConnection({
// userId/password are only sent when set — passing undefined makes the
// library negotiate "no auth" instead of an empty credential pair, which
// a proxy that requires auth rejects with a clearer error.
proxy: {
host: proxy.host,
port: proxy.port,
type: 5,
userId: proxy.user || undefined,
password: proxy.pass || undefined
},
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
onLog?.(`Tunnelling through HTTP proxy ${describeProxy(proxy)}${hasProxyAuth(proxy) ? ' (authenticated)' : ''}…`)
const socket = net.connect(proxy.port, proxy.host, () => {
socket.write(buildHttpConnectRequest(targetHost, targetPort, proxy))
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
// 407 means the proxy wants credentials we did not send (or sent wrong ones).
// Say which of the two it is, because "CONNECT failed: 407" is the one error
// that is always a config fix, never a retry.
let errMsg = `HTTP proxy CONNECT failed: ${statusLine || 'no response from proxy'}`
if (statusCode === 407) {
const which = proxy.group ? `PROXY_GROUP_${proxy.group}_USER / _PASS` : 'PROXY_USER / PROXY_PASS'
errMsg = hasProxyAuth(proxy)
? `HTTP proxy rejected the credentials for ${describeProxy(proxy)} (407) — check ${which}`
: `HTTP proxy requires a username and password (407) — set ${which} in .env`
}
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

// ── Item name helpers ────────────────────────────────────────────────────────
// Minecraft items carry two names: the registry/base name (e.g. "netherite_sword"
// or "Netherite Sword") and an optional custom name set by the player through an
// anvil or similar. Custom names are preferred for display, with the base name
// shown as the alternative so renamed items stay identifiable.
// Flatten any text-component shape into plain text. Handles: plain strings,
// JSON text components ({text, extra, …}), NBT tags ({type, value} — 1.20.5+
// components arrive as prismarine-nbt), NBT compounds (custom_name's data is a
// compound like {type:'compound', value:{text:{type:'string', value:'Sword'}}}),
// and arrays (extra lists).
function textParts (node, out) {
if (node == null)  return out
if (typeof node === 'string') {
try {
const parsed = JSON.parse(node)
if (typeof parsed === 'string') { out.push(parsed);  return out }
return textParts(parsed, out)
} catch (_) { out.push(node);  return out }
}
if (typeof node === 'number' || typeof node === 'boolean') { out.push(String(node));  return out }
if (Array.isArray(node)) { node.forEach(n => textParts(n, out));  return out }
if (typeof node === 'object') {
// NBT tag wrapper: { type: 'string'|'compound'|'list'|…, value: … }
if (typeof node.type === 'string' && Object.prototype.hasOwnProperty.call(node, 'value')) {
if (node.type === 'string') {
const rawStr = String(node.value)
try { return textParts(JSON.parse(rawStr), out) } catch (_) { out.push(rawStr);  return out }
}
return textParts(node.value, out)
}
// Plain JSON text component (or NBT compound's inner object)
if (node.text !== undefined) textParts(node.text, out)
if (node.extra !== undefined) textParts(node.extra, out)
if (node.with !== undefined) textParts(node.with, out)
if (node.translate !== undefined && out.length === 0 && node.fallback !== undefined) textParts(node.fallback, out)
}
return out
}
function itemCustomName (item) {
if (!item) return null
let raw = null
try { raw = item.customName } catch (_) {}
if (raw == null && item.nbt) {
// Belt-and-braces: if the getter surfaced nothing (older item instances,
// items built by hand), read legacy NBT display.Name directly.
try {
raw = item.nbt.value?.display?.value?.Name?.value ?? null
} catch (_) { raw = null }
}
if (raw == null) return null
const parts = []
textParts(raw, parts)
const text = parts.length ? parts.join('') : null
if (!text) return null
const out = String(text).replace(/\u00a7./g, '').trim()
return out || null
}
function itemDisplayName (item) {
return itemCustomName(item) || (item && (item.displayName || item.name)) || null
}
// The "other" name when an item has two: prefer the registry key (netherite_sword)
// over the display name, skipping anything identical to what is already shown.
function itemAltName (item, shown) {
if (!item) return null
const candidates = [item.name, item.displayName].filter(Boolean)
const base = String(shown || '').toLowerCase()
for (const c of candidates) {
if (String(c).toLowerCase() !== base) return String(c)
}
return null
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
const slowBroadcast = createSlowBroadcastManager()
const slowBroadcastManager = slowBroadcast

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

// ── Commands known to run locally on a bot rather than sent as raw in-game chat ─
// ── Coinflip data collection, time series, analytics, and the settings tab ───
// The registry is what the dashboard's .ENV tab edits. It normally reads
// process.env itself, but bot.js is loaded under a sandboxed process in the
// tests, so the value THIS module sees is handed in as the registry default —
// which keeps a sandbox's environment authoritative while leaving a live
// override able to beat it.
function cfDefine (key, spec) {
  const fromEnv = process.env[key]
  if (fromEnv !== undefined && fromEnv !== '') {
    const parsed = settings.coerce(spec.type || 'string', fromEnv)
    if (parsed !== null) spec = { ...spec, def: parsed }
  }
  settings.define(key, spec)
}
// Every knob here is registered with the settings registry, which is what makes
// the dashboard's .ENV tab able to change it without a restart and without ever
// writing to .env. A value marked live (the default) is read through
// settings.get(...) at the moment it is used; the few that are read once at
// boot say so in their description, because pretending otherwise would make the
// tab lie about what it just did.
cfDefine('COINFLIP_DEFAULT_FLIPS', { type: 'int', def: 10, min: 1, group: 'Coinflip', desc: 'Flips per bot when /bot-coinflip run gets no count' })
cfDefine('COINFLIP_WAGER_MIN', { type: 'int', def: 10000, min: 1, group: 'Coinflip', desc: 'Low end of the random wager (used when no PRICE argument is given)' })
cfDefine('COINFLIP_WAGER_MAX', { type: 'int', def: 1000000, min: 1, group: 'Coinflip', desc: 'High end of the random wager' })
cfDefine('COINFLIP_STOP_LOSS', { type: 'int', def: 10000000, min: 1, group: 'Coinflip', desc: 'Stop a per-bot run once its net loss reaches this' })
cfDefine('COINFLIP_BALANCE_FRACTION', { type: 'number', def: 1, min: 0.01, max: 1, group: 'Coinflip', desc: 'Never wager more than this fraction of the balance' })
cfDefine('COINFLIP_BUSY_WAIT_MS', { type: 'ms', def: 15000, min: 1000, group: 'Coinflip', desc: 'Wait this long when a coinflip is already active, then re-ask (never delete)' })
cfDefine('COINFLIP_BUSY_MAX_WAIT_MS', { type: 'ms', def: 900000, min: 60000, group: 'Coinflip', desc: 'Give up on an active coinflip after this long' })
cfDefine('COINFLIP_FLIP_TIMEOUT_MS', { type: 'ms', def: 600000, min: 60000, group: 'Coinflip', desc: 'How long one flip may wait for an opponent and a result' })
cfDefine('COINFLIP_POLL_MS', { type: 'ms', def: 15000, min: 1000, group: 'Coinflip', desc: 'How often the runner wakes up to re-check a flip' })
cfDefine('COINFLIP_SETTLE_MS', { type: 'ms', def: 1500, min: 100, group: 'Coinflip', desc: 'Quiet period that closes a multi-line result block' })
cfDefine('COINFLIP_MIN_SAMPLE', { type: 'int', def: 30, min: 5, group: 'Coinflip', desc: 'Resolved flips needed before a fairness verdict is given' })
cfDefine('COINFLIP_SUSPICION_P', { type: 'number', def: 0.01, min: 0.0001, max: 0.5, group: 'Coinflip', desc: 'A two-sided p below this is called suspicious' })
cfDefine('COINFLIP_BALANCE_TIMEOUT_MS', { type: 'ms', def: 2500, min: 500, group: 'Coinflip', desc: 'How long /bal has to answer around a flip' })
cfDefine('COINFLIP_CREATE_COOLDOWN_MS', { type: 'ms', def: 2500, min: 0, group: 'Coinflip', desc: 'Gap left after the balance check and before /coinflip create — the /bal before it is what trips the server rate limit' })
cfDefine('COINFLIP_COOLDOWN_MAX_RETRIES', { type: 'int', def: 5, min: 1, group: 'Coinflip', desc: 'Consecutive "you are on cooldown" replies tolerated before a run stops' })
cfDefine('COINFLIP_DEEP_MIN_BUCKET', { type: 'int', def: 20, min: 1, group: 'Coinflip', desc: 'Flips a bucket needs before /bot-coinflip deep treats it as evidence rather than an anecdote' })
cfDefine('COINFLIP_DEEP_Q', { type: 'number', def: 0.05, min: 0.0001, max: 0.5, group: 'Coinflip', desc: 'False-discovery rate a dissection must beat to count as a finding (Benjamini-Hochberg, across every test)' })
cfDefine('COINFLIP_TZ_OFFSET_MIN', { type: 'int', def: -new Date().getTimezoneOffset(), min: -840, max: 840, group: 'Coinflip', desc: 'Minutes from UTC used for the hour-of-day dissection when a record has no server timestamp' })
cfDefine('TIMESERIES_ENABLED', { type: 'bool', def: true, group: 'Time series', desc: 'Record samples to the data folder' })
cfDefine('TIMESERIES_INTERVAL_MS', { type: 'ms', def: 3600000, min: 60000, group: 'Time series', desc: 'How often a sample is taken (default hourly)' })
cfDefine('TIMESERIES_RANK_INTERVAL_MS', { type: 'ms', def: 21600000, min: 0, group: 'Time series', desc: 'How often ranks are probed (0 disables — each probe costs a /fix)' })
cfDefine('TIMESERIES_STARTUP_DELAY_MS', { type: 'ms', def: 120000, min: 0, group: 'Time series', desc: 'First sample after boot (0 disables)' })
cfDefine('TIMESERIES_MAX_RECORDS', { type: 'int', def: 500000, min: 1000, group: 'Time series', desc: 'Samples kept in memory and on disk' })
cfDefine('ANALYTICS_ENABLED', { type: 'bool', def: true, group: 'Analytics', desc: 'Serve the read-only analytics page' })
cfDefine('ANALYTICS_PORT', { type: 'int', def: 8080, min: 1, max: 65535, group: 'Analytics', live: false, desc: 'Port for the analytics page — the listener starts at boot, so this one needs a restart' })
cfDefine('ANALYTICS_OPEN', { type: 'bool', def: false, group: 'Analytics', desc: 'Serve analytics with no login at all (default: the dashboard session is required)' })
cfDefine('ANALYTICS_BUCKET_MS', { type: 'ms', def: 3600000, min: 60000, group: 'Analytics', desc: 'Bucket size for the charts (also ?bucket=1h)' })
// Keys that are read once at startup. They are listed so the tab is a complete
// picture of the configuration rather than only the new half of it.
cfDefine('ALL_SLOW_DELAY_MS', { type: 'ms', def: 15000, min: 0, group: 'Timing', desc: 'Default gap between bots in /all-slow (live)' })
cfDefine('AUTH_RETRY_MS', { type: 'ms', def: 300000, min: 1000, group: 'Auth', desc: 'Wait before retrying a throttled login (live)' })
cfDefine('AUTH_ALREADY_MS', { type: 'ms', def: 60000, min: 0, group: 'Auth', desc: 'Wait when the server says "already logged in" (live)' })
cfDefine('AUTH_MAX_THROTTLED_RETRIES', { type: 'int', def: 2, min: 1, group: 'Auth', desc: 'Throttled retries before it becomes a wrong-password failure (live)' })
cfDefine('AUTH_REPLY_WINDOW_MS', { type: 'ms', def: 30000, min: 1000, group: 'Auth', desc: 'How long a reply counts as an answer to our auth command (live)' })
cfDefine('LOGIN_PASSWORD', { type: 'string', def: '123456', group: 'Auth', desc: 'Global /register + /login password. Resolved at each auth attempt, so a change applies to the next /auth-retry — a per-bot or group password is read at boot and still wins for those bots' })
cfDefine('HOST', { type: 'string', def: 'play.fatalmc.org', group: 'Server', live: false, desc: 'Default server host (startup-only)' })
cfDefine('PORT', { type: 'int', def: 25565, group: 'Server', live: false, desc: 'Default server port (startup-only)' })
cfDefine('VERSION', { type: 'string', def: '1.21.2', group: 'Server', live: false, desc: 'Minecraft version to connect with (startup-only)' })
cfDefine('BOT_NAMES', { type: 'list', group: 'Server', live: false, desc: 'The roster (startup-only — edit the file and restart to change it)' })
cfDefine('CONNECT_DELAY_MS', { type: 'ms', def: 39500, min: 0, group: 'Timing', live: false, desc: 'Gap between initial bot connects (startup-only)' })
// These six are read once while bot.js loads, so they are registered as
// startup-only. The .ENV tab still shows and sets them, but it says plainly
// that the running process keeps its old value — claiming otherwise is exactly
// the lie this registry exists to prevent. Both /crates-all flags override the
// Crates defaults per run, so the common change needs no restart at all.
cfDefine('CRATES_ALL_DUMP', { type: 'string', def: 'tpa', group: 'Crates', live: false, desc: 'Default dump step for /crates-all (off|tpa|home|hidden|player:<name>). Startup-only; the per-run dump= flag overrides it' })
cfDefine('CRATES_ALL_AFK_WARP', { type: 'bool', def: true, group: 'Crates', live: false, desc: 'Whether /crates-all warps back to AFK. Startup-only; afk=off overrides it per run' })
cfDefine('CRATES_ALL_AFK_DELAY_MS', { type: 'ms', def: 15000, min: 0, group: 'Crates', live: false, desc: 'Delay before that AFK warp (0 = immediately). Startup-only; afk=now overrides it per run' })
cfDefine('DUMP_HOME_COMMAND', { type: 'string', def: '/home stash', group: 'Dump', live: false, desc: 'The /home command used by dump=home (startup-only)' })
cfDefine('TPA_MAIN_PLAYER', { type: 'string', def: (process.env.TPA_MAIN_PLAYER || process.env.TPA_TARGET_PLAYER || '').trim(), group: 'Dump', live: false, desc: 'Default /tpa target for the dump step (startup-only; TPA_TARGET_PLAYER is still read as an alias)' })
cfDefine('WARP_COMMAND', { type: 'string', def: '/warp afk', group: 'Dump', live: false, desc: 'The AFK warp command (startup-only)' })
cfDefine('WEB_PORT', { type: 'int', def: 80, min: 1, max: 65535, group: 'Dashboard', live: false, desc: 'Dashboard port (startup-only)' })
cfDefine('WEB_PASSWORD', { type: 'string', group: 'Dashboard', live: false, desc: 'Dashboard login (startup-only; leave empty for a generated one)' })

const COINFLIP_FILE = process.env.COINFLIP_FILE || path.join(__dirname, 'data', 'coinflip-history.jsonl')
const COINFLIP_SUMMARY_FILE = process.env.COINFLIP_SUMMARY_FILE || path.join(__dirname, 'data', 'coinflip-stats.json')
const COINFLIP_DEEP_FILE = process.env.COINFLIP_DEEP_FILE || path.join(__dirname, 'data', 'coinflip-deep.json')
const COINFLIP_EXPORT_FILE = process.env.COINFLIP_EXPORT_FILE || path.join(__dirname, 'data', 'coinflip-export.csv')
const TIMESERIES_FILE = process.env.TIMESERIES_FILE || path.join(__dirname, 'data', 'timeseries.jsonl')
const TIMESERIES_SUMMARY_FILE = process.env.TIMESERIES_SUMMARY_FILE || path.join(__dirname, 'data', 'timeseries-summary.json')
const coinflipStore = coinflip.createCoinflipStore({ file: COINFLIP_FILE, maxRecords: 200000 })
const timeseriesStore = timeseries.createTimeseriesStore({ file: TIMESERIES_FILE })


const LOCAL_COMMANDS = ['/status', '/inv', '/players', '/clear', '/disconnect', '/dump', '/dump-spawners', '/dc', '/reconnect', '/crates', '/crates-loop', '/spawners', '/data', '/shardshop-loop', '/closeBot', '/bot-coinflip', '/bot-coinflip-all', '/ai-chat']

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

// ── Scheduled jobs (cron) ────────────────────────────────────────────────────
// /cron manages jobs at runtime; CRON_JOB_<N>="<schedule>|<command>" in .env
// loads them at startup. Schedules are 5-field cron ("0 4 * * *") or
// "@every <seconds>" (min 5). Jobs dispatch with /all semantics: known local
// commands run per bot, everything else is broadcast as chat to spawned bots.
const { CronManager, parseBotTargetCommand, matchBotName, parseCronAddArgs } = require('./cron')
// Per-bot dispatch with /all semantics: manual commands route through their own
// router, known local commands run through handleCommand (arguments preserved),
// everything else is sent as chat to that bot. Returns true when dispatched.
function dispatchCommandToBot (msg, id) {
  const command = String(msg || '').trim()
  if (!command) return false
  if (!bots[id]) return false
  if (manual.routeCommand(command, id)) return true
  if (LOCAL_COMMANDS.includes(command.split(/\s+/)[0])) {
    // Reuse the single-bot router so arguments (e.g. /crates purple) survive.
    handleCommand(command, { selectedId: id })
    return true
  }
  if (!bots[id].bot?.entity) return false
  bots[id].bot.chat(command)
  return true
}
// Batch variant used by cron jobs: dispatch to every bot, return how many took it.
function dispatchCommandToAllBots (msg) {
  let sent = 0
  for (const id of Object.keys(bots)) {
    try { if (dispatchCommandToBot(msg, id)) sent++ } catch (_) {}
  }
  return sent
}
// Resolves a job's @targets against the live roster (case-insensitive) so
// `@hypr_7_core` still finds `Hypr_7_core`. Unknown names are reported with a
// hint instead of silently skipping the job.
function resolveCronTargets (targetIds) {
  const roster = Object.keys(bots)
  const resolved = []
  const unknown = []
  for (const name of targetIds) {
    const match = matchBotName(name, roster)
    if (match) resolved.push(match)
    else unknown.push(name)
  }
  return { resolved, unknown, roster }
}
// Cheap "did you mean" for a mistyped target: prefix, substring, or the target
// being a prefix of a real name (e.g. "@Hypr" → Hypr_7_core).
function suggestBotName (name, roster) {
  const want = String(name || '').trim().toLowerCase()
  if (!want) return null
  return roster.find(id => id.toLowerCase().startsWith(want)) ||
    roster.find(id => id.toLowerCase().includes(want)) ||
    roster.find(id => want.startsWith(id.toLowerCase())) ||
    null
}
function describeUnknownTargets (unknown, roster) {
  return unknown.map(name => {
    const hint = suggestBotName(name, roster)
    const near = hint ? ` (did you mean ${hint}?)` : ''
    return `${name}${near}`
  }).join(', ')
}
// Cron persistence: jobs added with `/cron add` are written to CRON_STATE_FILE
// and reloaded on the next start, so runtime jobs survive a restart. Set
// CRON_PERSIST=false to keep jobs in memory only (CRON_JOB_<N> in .env is
// always loaded and wins over a duplicate in the file).
const CRON_PERSIST = !/^(0|false|no|off)$/i.test((process.env.CRON_PERSIST || '').trim())
const CRON_STATE_FILE = CRON_PERSIST
  ? ((process.env.CRON_STATE_FILE || '').trim() || path.join(__dirname, 'cron-jobs.json'))
  : ''
const cronManager = new CronManager({
  stateFile: CRON_STATE_FILE,
  dispatch: (command) => {
    const parsed = parseBotTargetCommand(command)
    const trimmed = parsed.command
    const targetIds = parsed.botIds
    if (targetIds) {
      const { resolved, unknown, roster } = resolveCronTargets(targetIds)
      if (unknown.length) {
        logFor(SYSTEM_ID, `{red-fg}✗ Cron target bot(s) not found: ${describeUnknownTargets(unknown, roster)} — job skipped. Known bots: ${roster.join(', ') || 'none'}{/red-fg}`)
        return 0
      }
      if (trimmed.startsWith('/data')) {
        // /data pushes per targeted bot; its check/status subcommands are global.
        if (parseDataArgs(trimmed.slice('/data'.length)).action !== 'push') return handleCommand(trimmed)
        return compileAndPushData(() => {}, resolved)
      }
      let sent = 0
      for (const id of resolved) {
        try { if (dispatchCommandToBot(trimmed, id)) sent++ } catch (_) {}
      }
      return sent
    }
    // Global commands should run through the main command router rather than per-bot
    if (trimmed.startsWith('/crates-all') || trimmed.startsWith('/all') || trimmed.startsWith('/overview') || trimmed === '/data') {
      return handleCommand(trimmed)
    }
    return dispatchCommandToAllBots(trimmed)
  },
  log: (msg) => logFor(SYSTEM_ID, msg)
})
// CRON_ENABLED=0 stops the scheduler entirely; jobs can still be added and
// fired by hand with /cron run. CRON_TICK_MS tunes the scheduler resolution.
const CRON_ENABLED = !/^(0|false|no|off)$/i.test((process.env.CRON_ENABLED || '').trim())
const CRON_TICK_MS = readDelayMs(process.env.CRON_TICK_MS, 1000)
// .env first (authoritative), then the saved state file on top of it.
const CRON_ENV_LOADED = CRON_ENABLED ? cronManager.loadFromEnv(process.env) : 0
const CRON_FILE_LOADED = CRON_ENABLED ? cronManager.loadFromFile() : 0
if (CRON_ENABLED) cronManager.start(CRON_TICK_MS)

// Log pruning (default 20 minutes, env-tunable); timers unref'd so they never
// hold the process open.
const pruneTimer = setInterval(() => {
const cutoff = LOG_PRUNE_MINUTES > 0 ? Date.now() - (LOG_PRUNE_MINUTES * 60 * 1000) : 0
Object.values(bots).forEach(botState => { botState.logs = botState.logs.filter(l => l.time > cutoff) })
systemLogs.splice(0, systemLogs.length, ...systemLogs.filter(l => l.time > cutoff))
}, LOG_PRUNE_INTERVAL_MS)
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
const online = !!(b && b.entity)
return {
id, online,
ping: typeof ping === 'number' ? Math.max(0, ping) : null,
health: b ? (b.health ?? null) : null, food: b ? (b.food ?? null) : null,
uptimeSec: e.spawnTime ? Math.floor((Date.now() - e.spawnTime) / 1000) : null,
attempts: e.reconnectAttempts || 0,
kick: e.lastKickReason ? escHtml(sanitize(e.lastKickReason).slice(0, 140)) : null,
banned: Boolean(dataState.bots[id]?.banned),
banKind: dataState.bots[id]?.banKind || null,
// In-memory on purpose: a rejected password is fixed by editing .env, and a
// restart is how that edit takes effect, so this must not outlive the process.
authFailed: Boolean(authState.get(id)?.failure),
authKind: authState.get(id)?.failure ? escHtml(sanitize(authState.get(id).failure.kind)) : null,
authReason: authState.get(id)?.failure ? escHtml(sanitize(authState.get(id).failure.reason)) : null,
coinflip: coinflipSessions.get(id) || coinflipLastRun.get(id) || null,
pingHist: histArr,
manual: manual.snapshotFor(e),
// connecting: bot exists but hasn't spawned yet (useful for filtering in web UI)
connecting: !online && !!b
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
: PROXY_ENABLED ? ` — Proxy: ${describeProxy(PROXY_DEFAULT)}` : ''
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
<title>Sign in — ${DASHBOARD_TITLE}</title>
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
<title>${DASHBOARD_TITLE}</title>
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
.bot.connecting{border-color:rgba(255,200,0,.45);background:rgba(255,200,0,.04)}
.bot.sel{outline:1px solid var(--acc)}
.bhead{display:flex;align-items:center;gap:7px}
.dot{width:8px;height:8px;border-radius:50%;background:#39434f;flex:none}
.bot.on .dot{background:var(--grn);box-shadow:0 0 6px rgba(74,222,128,.7)}
.bot.connecting .dot{background:var(--yel);box-shadow:0 0 6px rgba(255,200,0,.5)}
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
#envbtn.on{color:var(--acc);border-color:var(--acc)}
#envpanel{position:fixed;inset:0;z-index:40;background:rgba(6,9,13,.74);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:36px 16px}
#envpanel[hidden]{display:none}
#envbox{background:var(--panel);border:1px solid var(--line);border-radius:12px;width:min(1000px,100%);padding:14px 18px 24px;box-shadow:0 18px 60px rgba(0,0,0,.5)}
#envbox .ehead{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:4px}
#envbox .ehead b{color:var(--acc);letter-spacing:.5px}
#envbox .enote{color:var(--dim);font-size:11px;margin-right:auto}
#envbox h4{color:var(--cyan);font-size:11px;text-transform:uppercase;letter-spacing:.8px;margin:16px 0 4px;border-bottom:1px solid var(--line);padding-bottom:4px}
.eitem{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(29,40,54,.5)}
.eitem .ekey{width:280px;flex:none;color:#dbe6ee;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eitem .edesc{flex:1;min-width:0;color:var(--dim);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eitem input{flex:none;width:150px;background:var(--bg);border:1px solid var(--line);border-radius:5px;color:var(--txt);font:inherit;font-size:11px;padding:2px 6px}
.eitem input:focus{outline:none;border-color:var(--acc)}
.eitem .temp{flex:none;color:var(--yel);font-size:10px}
.eitem .startup{flex:none;color:var(--dim);font-size:10px}
.eitem button{flex:none;background:none;border:1px solid var(--line);color:var(--dim);border-radius:5px;font:inherit;font-size:10px;padding:2px 7px;cursor:pointer}
.eitem button:hover{color:var(--acc);border-color:var(--acc)}
.eitem button.set{color:var(--acc);border-color:rgba(45,212,191,.45)}
@media(max-width:760px){.eitem{flex-wrap:wrap}.eitem .ekey{width:100%}.eitem .edesc{display:none}}
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
</style><script src="/chart.js"></script><script src="/coinflip-dashboard.js"></script></head><body>
<div id="app">
<header><div class="logo">⛏ AFK<b>CONSOLE</b></div><div id="chips"></div><div id="wsstate" class="wsstate down">offline</div><button id="logout">sign out</button></header>
<aside><div class="views"><div class="vchip on" data-view="all">ALL</div><div class="vchip" data-view="system">SYSTEM</div><button class="vchip" id="terminalbtn" type="button">TERMINAL</button><button class="vchip" id="envbtn" type="button" title="Temporary .env overrides — nothing is written to disk">.ENV</button><button class="vchip" id="coinflipbtn" type="button" title="Coinflip fleet analytics">COINFLIP</button><!--PLAYBTN--></div><label style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:11px;color:var(--dim);cursor:pointer"><input type="checkbox" id="show-all-bots" style="accent-color:var(--acc)">Show offline bots</label><div id="botlist"></div></aside>
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
<div id="envpanel" hidden><div id="envbox"><div class="ehead"><b>.ENV</b><span class="enote">temporary — applied to this running process only, and forgotten on the next restart (edit the file for a permanent change)</span><button class="tb" id="envresetall" type="button">reset all</button><button class="tb" id="envclose" type="button">close</button></div><div id="envbody">loading…</div></div></div>
<div id="terminal" hidden><div class="terminal-head"><b>bash</b><button class="tb" id="terminalclose" type="button">close</button></div><pre id="terminalout"></pre><form id="terminalform"><span class="prompt">$</span><input id="terminalinput" autocomplete="off" spellcheck="false"><button class="tb" type="submit">run</button></form></div>
</main>
</div>
<div id="coinflippanel" hidden style="position:absolute;inset:0;z-index:35;background:var(--bg);overflow:auto;padding:14px">
<div style="max-width:1400px;margin:0 auto">
<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
<h2 style="color:var(--acc);font-size:15px;margin:0">🎲 Coinflip Fleet Analytics</h2>
<button class="tb" id="cfclose" type="button" title="close">✕ close</button>
</div>
<div id="cfkpi" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:14px"></div>
<div style="display:grid;grid-template-columns:280px 1fr;gap:14px;min-height:60vh">
<div style="display:flex;flex-direction:column;gap:8px">
<div style="color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Bots</div>
<div id="cfbotlist" style="display:flex;flex-direction:column;gap:6px;max-height:40vh;overflow-y:auto"></div>
<div style="color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-top:8px">Tabs</div>
<div id="cftabs" style="display:flex;gap:6px;flex-wrap:wrap"></div>
</div>
<div id="cfcontent" style="min-width:0"></div>
</div>
</div>
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
poll();pollTimer=setInterval(poll,${WEB_REFRESH_MS})
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
var showAll = el('show-all-bots')?.checked || false
for(var i=0;i<bs.length;i++){var b=bs[i]
// Filter out offline non-connecting bots unless showAll is checked
if(!showAll && !b.online && !b.connecting) continue
botStates[b.id]=b
var old=prevOnline[b.id]
if(old===true&&!b.online)toast(b.id+(b.banned?' was banned':' went offline')+(b.kick?' — '+b.kick:''),'bad')
if(old===false&&b.online)toast(b.id+' is online','good')
prevOnline[b.id]=b.online
var d=document.createElement('div')
var cls = 'bot'
if(b.online) cls += ' on'
else if(b.connecting) cls += ' connecting'
if(b.id===view) cls += ' sel'
d.className = cls
d.setAttribute('data-id',b.id)
var up=b.uptimeSec==null?'':fmtUp(b.uptimeSec)
var manualHtml=b.manual&&b.manual.mode?'<span class="manual-badge">manual</span>':''
var guiHtml=b.manual&&(b.manual.guiTui||b.manual.session)?'<span class="manual-badge" style="color:var(--cyan);border-color:rgba(103,232,249,.4)">gui</span>':''
var bannedHtml=b.banned?'<span class="manual-badge" style="color:var(--red);border-color:rgba(248,113,113,.45)">⛔ banned</span>':''
var authHtml=b.authFailed?'<span class="manual-badge" style="color:var(--red);border-color:rgba(248,113,113,.45)">🔑 '+b.authKind+'</span>':''
var viewerHtml=b.manual&&b.manual.viewerPort?'<button class="manual-viewer" type="button" data-port="'+String(b.manual.viewerPort)+'">🌐 viewer</button>':''
var cfHtml=b.coinflip?'<span class="manual-badge" style="color:var(--cyan);border-color:rgba(103,232,249,.4)">🎲 '+b.coinflip.flips+'/'+b.coinflip.planned+'</span>':''
var connectingHtml = b.connecting ? '<span class="manual-badge" style="color:var(--yellow);border-color:rgba(255,200,0,.4)">⏳ connecting</span>' : ''
d.innerHTML='<div class="bhead"><div class="dot"></div><div class="bname"></div>'+bannedHtml+authHtml+cfHtml+manualHtml+guiHtml+viewerHtml+connectingHtml+(b.attempts?'<div class="batt">↻'+b.attempts+'</div>':'')+'</div>'
+'<div class="bmeta"><span>'+(b.ping==null?'—':b.ping)+'ms</span><span>'+(b.health==null?'—':b.health)+'❤</span><span>'+(b.food==null?'—':b.food)+'🍗</span>'+(up?'<span>'+up+'</span>':'')+'</div>'
+'<canvas width="220" height="16"></canvas>'
d.querySelector('.bname').textContent=b.id
if(b.banned)d.title='Banned'+(b.banKind?' ('+b.banKind+')':'')+(b.kick?' — '+b.kick:'')
else if(b.authFailed)d.title='Login rejected: '+b.authReason+' — fix the password and run /auth-retry '+b.id
else if(b.coinflip)d.title='Coinflip run: '+b.coinflip.flips+' of '+b.coinflip.planned+' flips, net '+(b.coinflip.net>=0?'+':'')+b.coinflip.net+' — '+b.coinflip.stopped
else if(b.kick)d.title=b.kick
else if(b.connecting)d.title='Connecting to server...'
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
function envRow(r,box){
var row=document.createElement('div');row.className='eitem'
var k=document.createElement('div');k.className='ekey';k.textContent=r.key
k.title=new Date().toISOString()+' '+r.key
if(r.desc)k.title=r.key+' — '+r.desc
var d=document.createElement('div');d.className='edesc';d.textContent=r.desc||'(no description)'
var input=document.createElement('input')
input.type=r.secret?'password':'text'
input.placeholder=r.secret?(r.configured?'(set)':'(unset)'):(r.configured?'':'not set')
if(!r.secret&&r.value!=null&&r.value!=='')input.value=Array.isArray(r.value)?r.value.join(','):String(r.value)
var setBtn=document.createElement('button');setBtn.type='button';setBtn.className='set';setBtn.textContent='set'
setBtn.onclick=(function(key,field){return function(){envSave(key,field.value)}})(r.key,input)
var resetBtn=document.createElement('button');resetBtn.type='button';resetBtn.textContent='reset'
resetBtn.onclick=(function(key){return function(){envReset(key)}})(r.key)
var mark=document.createElement('span')
mark.className=r.overridden?'temp':'startup'
mark.textContent=r.overridden?'* temporary':(r.live?'':'startup-only')
if(r.source==='default')mark.title='using the built-in default ('+(r.default==null?'':String(r.default))+')'
row.appendChild(k);row.appendChild(d);row.appendChild(input);row.appendChild(setBtn);row.appendChild(resetBtn);row.appendChild(mark)
box.appendChild(row)
}
function envRender(groups){
var box=el('envbody');box.innerHTML=''
if(!groups||!groups.length){box.textContent='No settings to show.';return}
for(var i=0;i<groups.length;i++){
var h=document.createElement('h4');h.textContent=groups[i].group;box.appendChild(h)
var rows=groups[i].rows||[]
for(var j=0;j<rows.length;j++)envRow(rows[j],box)
}
}
function envLoad(){
el('envpanel').hidden=false;el('envbody').textContent='loading…'
fetch('/api/settings',{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.json()}).then(function(m){envRender(m.groups||[])}).catch(function(){el('envbody').textContent='could not load the settings'})
}
function envSave(key,value){
fetch('/api/settings',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:key,value:value})}).then(function(r){return r.json()}).then(function(m){
if(!m.ok){toast(m.error||('could not set '+key),'bad');return}
toast(key+(m.value==null?' updated (temporary)':(' = '+m.value+' (temporary)')),'good');envLoad()
}).catch(function(){toast('could not reach the console','bad')})
}
function envReset(key){
fetch('/api/settings/reset',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:key})}).then(function(r){return r.json()}).then(function(m){
toast(m.ok?(key+' reset'):(m.error||'not overridden'),m.ok?'good':'bad');envLoad()
}).catch(function(){})
}
function envResetAll(){
fetch('/api/settings/reset',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({all:true})}).then(function(r){return r.json()}).then(function(m){
toast('cleared '+((m.cleared==null)?0:m.cleared)+' override(s)','good');envLoad()
}).catch(function(){})
}
var pb=el('playbtn');if(pb)pb.onclick=function(){window.open('/play','_blank','noopener')}
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
const pageHtml = PAGE_HTML
.replace('<button class="vchip" id="coinflipbtn" type="button" title="Coinflip fleet analytics">COINFLIP</button><!--PLAYBTN-->', MC_WEB_ENABLED ? '<button class="vchip" id="playbtn" type="button" title="Play the server in your browser (zardoy minecraft-web-client)">PLAY</button>' : '')
.replace(/<script>[\s\S]*?<\/script>/, '<script src="/app.js"></script>')
const pageBuf = Buffer.from(pageHtml, 'utf8')
let pageGz = null
try { pageGz = zlib.gzipSync(pageBuf, { level: 6 }) } catch (_) {}

function playPageHtml(base) {
const clientUrl = webClientUrl({ base: base || MC_WEB_CLIENT_URL, ip: MC_WEB_SERVER, version: MC_WEB_VERSION, username: MC_WEB_USERNAME, proxy: MC_WEB_PROXY })
const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n<title>Minecraft — AFK Console</title>\n<style>\nhtml,body{height:100%;margin:0;background:#0a0e13;color:#c7d2dc;font:13px/1.4 ui-monospace,'Cascadia Code','SF Mono',Menlo,Consolas,monospace;display:flex;flex-direction:column}\n.bar{display:flex;align-items:center;gap:12px;padding:8px 14px;background:linear-gradient(180deg,#101a24,#0d141c);border-bottom:1px solid #1d2836;flex-wrap:wrap}\n.bar b{color:#2dd4bf;letter-spacing:.5px}\n.bar a{color:#c7d2dc;text-decoration:none;border:1px solid #1d2836;border-radius:6px;padding:3px 10px;font-size:12px}\n.bar a:hover{border-color:#2dd4bf;color:#e8f0f6}\n.bar .hint{margin-left:auto;color:#5b6b7a;font-size:11px}\niframe{flex:1;border:0;width:100%;min-height:0}\n</style></head><body>\n<div class="bar"><b>⛏ Minecraft Web Client</b><a href="/">← dashboard</a><span class="hint">offline-mode (cracked) servers supported — set MC_WEB_* in .env to prefill</span></div>\n<iframe src="${esc(clientUrl)}" title="Minecraft Web Client" allow="fullscreen; pointer-lock; clipboard-write; gamepad; autoplay"></iframe>\n<script>\n(function () {\n  var ping = function () { try { fetch('/play-ping', { cache: 'no-store' }) } catch (e) {} }\n  ping()\n  setInterval(ping, 5000)\n  window.addEventListener('pagehide', function () {\n    try { navigator.sendBeacon('/play-stop') } catch (e) {\n      try { fetch('/play-stop', { method: 'POST', keepalive: true }) } catch (e2) {}\n    }\n  })\n})()\n</script>\n</body></html>`
}

// Local web client server: serves the self-hosted build (never a remote site).
// Started lazily on the first /play request — no extra port is bound and no
// client assets are loaded unless someone actually opens the PLAY tab. It is
// also stopped completely when the PLAY tab is left (pagehide beacon) or goes
// silent (heartbeat watchdog), so its memory is fully released on small hosts.
let webClientHandle = { started: false, port: null, reason: "", server: null, dir: MC_WEB_CLIENT_DIR }
let webClientReady = null
let webClientLastPing = 0
let webClientWatchdog = null
function stopWebClient(reason) {
if (webClientWatchdog) { clearInterval(webClientWatchdog); webClientWatchdog = null }
const h = webClientHandle
if (h && h.started && h.server) {
try { require('./web-client').stopWebClient(h) } catch (_) {}
logFor(SYSTEM_ID, `{yellow-fg}\u23f9 Minecraft web client stopped (${reason || 'no heartbeat'}){/yellow-fg}`)
}
webClientHandle = { started: false, port: null, reason: "", server: null, dir: MC_WEB_CLIENT_DIR }
webClientReady = null
webClientLastPing = 0
}
// ── On-demand client build (non-Docker installs) ─────────────────────────────
// Docker bakes web-client/dist into the image, so containers always have it.
// A plain `npm run start` does not, which made /play useless outside Docker.
// MC_WEB_AUTO_BUILD (default on) builds it the first time /play is opened.
function webClientBuildState () {
  try { return require('./web-client').buildState() } catch (_) { return { running: false, ok: false, error: '', tail: [], logFile: '' } }
}
function webClientBuildExists () {
  try { return require('./web-client').buildExists(MC_WEB_CLIENT_DIR) } catch (_) { return false }
}
// Returns true when a build is running now (or already was).
function ensureWebClientBuild () {
  let wc
  try { wc = require('./web-client') } catch (_) { return false }
  const st = wc.buildState()
  if (st.running) return true
  if (wc.buildExists(MC_WEB_CLIENT_DIR)) return false
  const started = wc.startBuild({
    dir: MC_WEB_CLIENT_DIR,
    command: MC_WEB_BUILD_CMD,
    log: m => logFor(SYSTEM_ID, `{gray-fg}[web-client build] ${sanitize(m)}{/gray-fg}`)
  })
  if (started && started.running) {
    logFor(SYSTEM_ID, '{yellow-fg}⛏ Minecraft web client is not built yet — building it now (the first run clones zardoy/minecraft-web-client and takes a few minutes; /play shows progress). Set MC_WEB_AUTO_BUILD=false to skip this.{/yellow-fg}')
    return true
  }
  return false
}

function ensureWebClient() {
// Checked synchronously, before a promise is cached: the build runs in the
// background, so a later /play request must re-check rather than reuse a
// "not started" result forever.
if (!webClientReady && !webClientBuildExists()) {
if (MC_WEB_AUTO_BUILD) ensureWebClientBuild()
return { started: false, port: null, reason: 'client build missing', server: null, dir: MC_WEB_CLIENT_DIR }
}
if (!webClientReady) {
webClientReady = (async () => {
try {
const wc = require('./web-client')
const h = await wc.startWebClient({ dir: MC_WEB_CLIENT_DIR, port: MC_WEB_CLIENT_PORT, maxAttempts: MC_WEB_CLIENT_PORT_MAX_ATTEMPTS, log: m => logFor(SYSTEM_ID, `{gray-fg}[web-client] ${sanitize(m)}{/gray-fg}`) })
webClientHandle = h
if (h.started) {
webClientLastPing = Date.now()
logFor(SYSTEM_ID, `{green-fg}\u2713 Minecraft web client serving on :${h.port}{/green-fg}`)
if (!webClientWatchdog) webClientWatchdog = setInterval(() => {
if (webClientHandle.started && webClientLastPing && Date.now() - webClientLastPing > 45_000) stopWebClient()
}, 10_000)
} else logFor(SYSTEM_ID, `{yellow-fg}\u26a0 ${sanitize(h.reason)}{/yellow-fg}`)
} catch (err) {
webClientHandle = { started: false, port: null, reason: err.message || String(err), server: null, dir: MC_WEB_CLIENT_DIR }
logFor(SYSTEM_ID, `{yellow-fg}\u26a0 web client server error: ${sanitize(err.message || String(err))}{/yellow-fg}`)
}
return webClientHandle
})()
}
return webClientReady
}

// Where the /play iframe points: explicit override, or the local client server.
function clientBaseFor(req) {
if (MC_WEB_CLIENT_URL) return MC_WEB_CLIENT_URL
const host = String((req && req.headers && req.headers.host) || '').split(':')[0] || 'localhost'
const port = MC_WEB_CLIENT_HOST_PORT || String(webClientHandle.port || MC_WEB_CLIENT_PORT)
return `http://${host}:${port}/`
}

function clientNotBuiltHtml() {
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Minecraft \u2014 AFK Console</title>
<style>html,body{height:100%;margin:0;background:#0a0e13;color:#c7d2dc;font:13px/1.4 ui-monospace,Consolas,monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px}
code{background:#131b25;border:1px solid #1d2836;border-radius:6px;padding:2px 8px;color:#67e8f9}
a{color:#2dd4bf}</style></head><body>
<div><b style="color:#2dd4bf">\u26cf Minecraft Web Client</b> \u2014 build not found</div>
<div style="color:#5b6b7a;max-width:660px;text-align:center;line-height:1.6">The self-hosted client build is missing from <code>${esc(webClientHandle.dir)}</code>. Build it once with <code>npm run web-client:build</code> (clones zardoy/minecraft-web-client and runs its production build \u2014 takes a few minutes), or rebuild the Docker image, which bakes it in.</div>
<a href="/">\u2190 back to dashboard</a>
</body></html>`
}
// /play while the on-demand build runs. Auto-refreshes so the tab turns into
// the client by itself once the build finishes. Safe to leave open — the build
// continues in the background regardless of what the browser does.
function clientBuildingHtml(st) {
  const lines = (st.tail || []).slice(-14).map(l => escHtml(l)).join('\n')
  const seconds = st.startedAt ? Math.max(0, Math.round((Date.now() - st.startedAt) / 1000)) : 0
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Minecraft — building…</title>
<meta http-equiv="refresh" content="10">
<style>html,body{height:100%;margin:0;background:#0a0e13;color:#c7d2dc;font:13px/1.5 ui-monospace,Consolas,monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px}
pre{background:#0d141d;border:1px solid #1d2836;border-radius:8px;padding:12px 14px;color:#8fa3b5;max-width:min(860px,92vw);max-height:38vh;overflow:auto;margin:0;white-space:pre-wrap}
code{background:#131b25;border:1px solid #1d2836;border-radius:6px;padding:2px 8px;color:#67e8f9}
a{color:#2dd4bf}.b{color:#2dd4bf;font-weight:bold}.m{color:#5b6b7a}</style></head><body>
<div><span class="b">⛏ Minecraft Web Client</span> — building… (${seconds}s)</div>
<div class="m" style="max-width:660px;text-align:center">This build is only needed outside Docker: the container image bakes the client in, a plain <code>npm run start</code> has to build it once. This page refreshes itself every 10s.</div>
<pre>${lines || '(waiting for output…)'}</pre>
<div class="m">Full log: <code>${escHtml(st.logFile || 'web-client/build.log')}</code></div>
<a href="/">← back to dashboard</a>
</body></html>`
}

// /play when the on-demand build failed. Shows the tail of the build output and
// both ways forward, rather than a generic "build not found".
function clientBuildFailedHtml(st) {
  const lines = (st.tail || []).slice(-24).map(l => escHtml(l)).join('\n')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Minecraft — build failed</title>
<style>html,body{height:100%;margin:0;background:#0a0e13;color:#c7d2dc;font:13px/1.5 ui-monospace,Consolas,monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px}
pre{background:#0d141d;border:1px solid #3b1d22;border-radius:8px;padding:12px 14px;color:#c9a3a8;max-width:min(880px,92vw);max-height:38vh;overflow:auto;margin:0;white-space:pre-wrap}
code{background:#131b25;border:1px solid #1d2836;border-radius:6px;padding:2px 8px;color:#67e8f9}
a{color:#2dd4bf}.b{color:#f87171;font-weight:bold}.m{color:#5b6b7a}</style></head><body>
<div><span class="b">⛏ Minecraft Web Client</span> — build failed</div>
<div style="color:#fca5a5;max-width:700px;text-align:center">${escHtml(st.error || 'the build did not complete')}</div>
<pre>${lines || '(no output captured)'}</pre>
<div class="m" style="max-width:720px;text-align:center;line-height:1.7">Retry with <code>npm run web-client:build</code>, or point <code>MC_WEB_CLIENT_DIR</code> at an existing build. Set <code>MC_WEB_AUTO_BUILD=false</code> to stop building on <code>/play</code>. The build needs <code>git</code>, <code>bash</code>, network access, and ~2 GB of free disk.</div>
<a href="/">← back to dashboard</a>
</body></html>`
}

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
// The analytics listener is a separate server outside this closure, so it is
// handed the session check it needs here.
webAuth = { sessionValid, tokenFromReq }
function readBody(req, cap) {
cap = cap || 16384
return new Promise(resolve => {
let len = 0; const chunks = []
req.on('data', c => { len += c.length; if (len > cap) { req.destroy(); resolve(null); return } chunks.push(c) })
req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
req.on('error', () => resolve(null))
})
}

/**
* Gracefully disconnects all active bots one by one in random order,
* with a random delay between minSec and maxSec (default: 10–20s) between each.
*
* @param {number} [minSec=10]
* @param {number} [maxSec=20]
* @returns {Promise<{ ok: boolean, disconnected: number }>}
*/
async function disconnectAllSlow(minSec = 10, maxSec = 20) {
  const activeBots = Object.entries(bots).filter(([id, entry]) => entry && (entry.bot?.entity || entry.connected || entry.bot))
  if (activeBots.length === 0) {
    logFor(SYSTEM_ID, '{cyan-fg}› [slow-disconnect] No active bots to disconnect.{/cyan-fg}')
    return { ok: true, disconnected: 0 }
  }

  const shuffled = shuffledCopy(activeBots)
  logFor(SYSTEM_ID, `{yellow-fg}⚠ [slow-disconnect] Disconnecting ${shuffled.length} bot(s) slowly in random order (${minSec}–${maxSec}s apart)…{/yellow-fg}`)

  let count = 0
  for (let i = 0; i < shuffled.length; i++) {
    const [id, entry] = shuffled[i]
    logFor(id, `{yellow-fg}⚠ [slow-disconnect] Disconnecting ${id} (${i + 1}/${shuffled.length})…{/yellow-fg}`)
    try {
      entry.disconnectManually()
      count++
    } catch (err) {
      logFor(id, `{red-fg}✗ [slow-disconnect] Error disconnecting ${id}: ${sanitize(err.message)}{/red-fg}`)
    }

    if (i < shuffled.length - 1) {
      const delayMs = Math.floor(Math.random() * ((maxSec - minSec) * 1000 + 1)) + (minSec * 1000)
      logFor(SYSTEM_ID, `{cyan-fg}› [slow-disconnect] Waiting ${(delayMs / 1000).toFixed(1)}s before disconnecting next bot…{/cyan-fg}`)
      await new Promise(r => setTimeout(r, delayMs))
    }
  }

  logFor(SYSTEM_ID, `{green-fg}✓ [slow-disconnect] Finished: all ${count} bot(s) disconnected.{/green-fg}`)
  return { ok: true, disconnected: count }
}

const server = http.createServer(async (req, res) => {
try {
const url = new URL(req.url, 'http://localhost')
const p = url.pathname
webTrace(`${req.method} ${p} from ${req.socket.remoteAddress || '?'}`)
if (p === '/health') { res.writeHead(200); res.end('ok'); return }
if (p === '/favicon.ico') { res.writeHead(204); res.end(); return }
if (p === '/api/internal/disconnect-slow' && req.method === 'POST') {
  const ip = req.socket.remoteAddress || ''
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === ''
  if (!isLocal && !sessionValid(tokenFromReq(req, url))) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'forbidden' }))
    return
  }
  webTrace(`triggering slow-disconnect from ${ip}`)
  disconnectAllSlow().then(result => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(result))
  }).catch(err => {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: err.message }))
  })
  return
}

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
if (p === '/api/settings' && req.method === 'GET') {
// The .ENV tab: the registry's current values, grouped, with secrets withheld.
res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
res.end(JSON.stringify({ groups: settings.grouped(), overrides: settings.overrideCount() }))
return
}
if (p === '/api/settings' && req.method === 'POST') {
const body = await readBody(req, 8192)
let msg
try { msg = JSON.parse(body || '{}') } catch (_) { msg = null }
const result = msg && msg.key ? settings.set(msg.key, msg.value) : { ok: false, error: 'a setting name is required' }
res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
res.end(JSON.stringify(result))
if (result.ok) logFor(SYSTEM_ID, `{cyan-fg}› .ENV tab: ${sanitize(String(msg.key))} set for this run only${result.live ? '' : ' (startup-only key — the running process keeps its old value)'}{/cyan-fg}`)
else logFor(SYSTEM_ID, `{yellow-fg}⚠ .ENV tab rejected ${sanitize(String(msg && msg.key))}: ${sanitize(result.error)}{/yellow-fg}`)
return
}
if (p === '/api/settings/reset' && req.method === 'POST') {
const body = await readBody(req, 8192)
let msg
try { msg = JSON.parse(body || '{}') } catch (_) { msg = null }
const result = msg && msg.all ? { ok: true, cleared: settings.resetAll().length } : settings.reset(msg && msg.key)
res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
res.end(JSON.stringify(result))
return
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
if (p === '/play-ping' && (req.method === 'GET' || req.method === 'POST')) {
webClientLastPing = Date.now()
res.writeHead(204); res.end(); return
}
if (p === '/play-stop' && req.method === 'POST') {
stopWebClient('page closed')
res.writeHead(204); res.end(); return
}
if (p === '/play' && req.method === 'GET') {
if (!MC_WEB_ENABLED) { res.writeHead(404); res.end('not found'); return }
webClientLastPing = Date.now()
await ensureWebClient()
if (!webClientHandle.started && !MC_WEB_CLIENT_URL) {
// Not serving: either the on-demand build is running, it failed, or
// auto-build is off and the build was never made.
const build = webClientBuildState()
res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
if (build.running) res.end(clientBuildingHtml(build))
else if (build.finishedAt && !build.ok) res.end(clientBuildFailedHtml(build))
else res.end(clientNotBuiltHtml())
return
}
webTrace('serving minecraft web client page')
res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
res.end(playPageHtml(clientBaseFor(req)))
return
}
if (p === '/api/coinflip/summary' && req.method === 'GET') {
  sendJson(res, coinflipStore.summary({ recent: 100, minSample: settings.get('COINFLIP_MIN_SAMPLE'), suspicionP: settings.get('COINFLIP_SUSPICION_P') }))
  return
}
if (p === '/api/coinflip/bot' && req.method === 'GET') {
  const botName = url.searchParams.get('bot') || null
  if (!botName) { sendJson(res, { ok: false, error: 'bot parameter required' }, 400); return }
  const rows = coinflipStore.all().filter(r => r.bot === botName)
  const summary = coinflipStore.summary({ recent: 100, minSample: settings.get('COINFLIP_MIN_SAMPLE'), suspicionP: settings.get('COINFLIP_SUSPICION_P') })
  sendJson(res, { bot: botName, rows, summary })
  return
}
if (p === '/api/coinflip/fairness' && req.method === 'GET') {
  const rows = coinflipStore.all()
  const fairness = coinflip.analyzeFairness(rows, { minSample: settings.get('COINFLIP_MIN_SAMPLE'), suspicionP: settings.get('COINFLIP_SUSPICION_P') })
  sendJson(res, fairness)
  return
}
if (p === '/api/coinflip/deep' && req.method === 'GET') {
  const botName = url.searchParams.get('bot') || null
  const deep = coinflipDeepReport({ bot: botName })
  sendJson(res, deep)
  return
}
if (p === '/api/coinflip/bots' && req.method === 'GET') {
  const rows = coinflipStore.all()
  const botsMap = {}
  for (const row of rows) {
    if (!botsMap[row.bot]) botsMap[row.bot] = { flips: 0, wins: 0, losses: 0, net: 0, lastSeen: 0 }
    botsMap[row.bot].flips++
    if (row.result === 'win') botsMap[row.bot].wins++
    else if (row.result === 'loss') botsMap[row.bot].losses++
    botsMap[row.bot].net += row.delta || 0
    botsMap[row.bot].lastSeen = Math.max(botsMap[row.bot].lastSeen, row.ts || 0)
  }
  sendJson(res, { bots: botsMap })
  return
}
if (p === '/chart.js' && req.method === 'GET') {
  handleChartJs(req, res)
  return
}
if (p === '/coinflip-dashboard.js' && req.method === 'GET') {
  handleCoinflipDashboardJs(req, res)
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
if (v === 'system') return systemLogs.slice(-LOG_VIEW_LINES).map(l => escHtml(l.text))
if (v === 'all') {
const all = systemLogs.slice(-LOG_VIEW_LINES)
Object.values(bots).forEach(e => { all.push(...e.logs.slice(-LOG_VIEW_LINES)) })
all.sort((a, b) => a.time - b.time)
return all.slice(-LOG_VIEW_LINES).map(l => escHtml(l.text))
}
const e = bots[v]
return e ? e.logs.slice(-LOG_VIEW_LINES).map(l => escHtml(l.text)) : []
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
if (ctx.ws && ctx.ws.bufferedAmount > WS_SEND_MAX_BUFFERED) continue
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
for (const ctx of clients) if (!(ctx.ws && ctx.ws.bufferedAmount > WS_SEND_MAX_BUFFERED)) ctx.send(msg)
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
// Sweep expired sessions + failed-login bookkeeping so those maps never grow unbounded.
for (const [tok, exp] of sessions) if (Date.now() > exp) sessions.delete(tok)
for (const [ip, f] of fails) if (Date.now() > f.until) fails.delete(ip)
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
// Tell the user up front that /play still needs a build, so it is discoverable
// without clicking PLAY first. Nothing is built here — the build only starts on
// the first /play request, so an unused tab costs nothing.
if (webClientBuildExists()) {
if (MC_WEB_ENABLED) logFor(SYSTEM_ID, `{gray-fg}\u26cf Minecraft web client build found (${MC_WEB_CLIENT_DIR}) \u2014 /play is ready{/gray-fg}`)
} else if (!MC_WEB_ENABLED) {
// client disabled entirely — say nothing
} else if (MC_WEB_AUTO_BUILD) {
logFor(SYSTEM_ID, '{gray-fg}\u26cf Minecraft web client build not found \u2014 opening /play will build it once (or run npm run web-client:build now){/gray-fg}')
} else {
logFor(SYSTEM_ID, `{yellow-fg}\u26cf Minecraft web client build not found in ${MC_WEB_CLIENT_DIR} and MC_WEB_AUTO_BUILD is off \u2014 run npm run web-client:build to enable /play{/yellow-fg}`)
}
// Live views of the lazy web-client state (started on first /play request).
Object.defineProperty(handle, 'webClient', { get: () => webClientHandle, configurable: true })
Object.defineProperty(handle, 'webClientReady', { get: () => webClientReady, configurable: true })
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
// Recognize "<name>: message" player chat lines. The server may inject odd
// unicode just before the username, so strip § codes + non-ASCII first.
function detectPlayerChat (text) {
  const clean = String(text || '')
    .replace(/\u00a7./g, '')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const m = clean.match(/^([A-Za-z0-9_]{1,16}):\s*(.+)$/)
  return m ? { name: m[1], message: m[2] } : null
}

function detectTpaRequester (text) {
  const clean = String(text || '').replace(/\u00a7./g, '').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim()
  const patterns = [
    /^(?:teleport request from|tp request from)\s+([A-Za-z0-9_]{1,16})\b/i,
    /^([A-Za-z0-9_]{1,16})\s+(?:has )?(?:requested|sent)\s+(?:a )?teleport/i,
    /^([A-Za-z0-9_]{1,16}).*\b(?:wants to teleport|would like to teleport)\b/i
  ]
  for (const pattern of patterns) {
    const match = clean.match(pattern)
    if (match) return match[1]
  }
  return null
}

function isTrustedTpaName (name) {
  return TPA_TRUSTED_BOTS.some(trusted => trusted.toLowerCase() === String(name || '').toLowerCase())
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
  inDumpRoutine: false, // suppresses windowOpen handler during /dump (chests must not be auto-clicked/warped)
  dumpOperationActive: false,
  tpautoEnabled: TPA_AUTO_DEFAULT,
  dumpTimers: [],
  dumpCancelRequested: false,
inSpawnerRoutine: false, // suppresses windowOpen handler during /spawners (slots 13/53 are clicked by the routine)
shardshopLoopRunning: false, // prevents concurrent /shardshop-loop runs
lastActivity: Date.now(), // updated on every inbound packet — used by the proxy stall watchdog
forceKilled: false, // set by the watchdog so scheduleReconnect logs it distinctly
manualDisconnect: false, // mirrors the closure-local flag so the watchdog (outside this closure) can see it too
pingHist: [], // web GUI sparkline
manualMode: false, // manual interact mode (bot-manual.js)
manualViewer: null, // { port, firstPerson } when the 3D viewer is live
manualViewerFirstPerson: false, // 3D viewer camera: false = orbit, true = first-person (/view)
manualWindow: null, // window tracked for manual /window-* commands
guiTui: false, // dashboard ASCII GUI TUI toggle (/gui-tui)
suppressNextWindowClick: false, // suppress auto slot-click for the next windowOpen
suppressWindowTimer: null, // clears the above when no window opens within 5s
manualSession: false, // sticky manual GUI session (set when a /gui window opens)
guiSessionTimer: null, // 20-min auto-close timer for the manual GUI session
lastPlayerChatAt: Date.now(), // chat activity watchdog — last time a player message was seen
lastPlayerChat: '', // latest player chat message
}
const entry = bots[id]

// Managed timers — all cleared on disconnect so nothing fires against a dead bot
const timeouts = []
const pushT = (fn, delay) => {
const t = setTimeout(() => { const i = timeouts.indexOf(t); if (i >= 0) timeouts.splice(i, 1); fn() }, delay)
timeouts.push(t)
return t
}
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

// The removed list outranks everything: a permanently banned bot is not yours
// to reconnect any more, whatever BOT_NAMES still says.
const removal = removedEntryFor(id)
if (removal) {
e(`${id} is on the removed list (${removedBotsStore.describeRemovedBot(removal)}) — not reconnecting. Run /unban ${id} to put it back.`)
notifyBotsChanged()
return
}

// A banned account must stop knocking: repeated logins during a ban look like
// evasion and are pointless anyway. The expiry is an absolute time in the data
// file, so this holds across restarts, and the ban sweep reconnects when it
// lapses. Switching proxy is irrelevant — the ban follows the account.
const ban = activeBan(id)
if (ban) {
if (ban.permanent) e(`${id} is permanently banned (${ban.kind}) — not reconnecting. Remove it from BOT_NAMES, or run /closeBot ${id}.`)
else w(`${id} is banned (${ban.kind}) — holding off until ${new Date(ban.expiresAt).toLocaleString()}.`)
notifyBotsChanged()
return
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
// us for with "An internal error occurred during your connection."
//
// The velocity plugin owns bot.inConfigurationPhase and bot.physicsEnabled
// (it sets them on start_configuration/finish_configuration packets). We must
// NOT write those flags directly — that races with the plugin's delayed
// exitConfigurationPhase (2s timeout). Instead we only disable physics on
// entering configuration, and on 'play' we defer to the velocity plugin's
// exit handler when it is active (post-spawn reconfigure), or re-enable
// immediately for the initial login (velocity plugin not active yet).
if (newState === 'configuration') {
bot.physicsEnabled = false
} else if (newState === 'play') {
// Only re-enable if the velocity plugin hasn't taken us into
// configuration (initial login). Otherwise let its exit handler
// re-enable physics after the server finishes setup.
if (!bot.inConfigurationPhase) bot.physicsEnabled = true
}
})

// Coordinate with the velocity plugin's configurationPhase events so we
// never race its delayed exitConfigurationPhase (2s timeout).
bot.on('configurationPhase', (phase) => {
if (phase === 'start') {
bot.physicsEnabled = false
} else if (phase === 'end') {
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
feedCoinflipLine(id, message)

const requester = detectTpaRequester(message)
if (requester && bots[id]?.tpautoEnabled) {
  if (isTrustedTpaName(requester)) {
    i(`TPA auto: accepting trusted request from ${requester}.`)
    try { bot.chat('/tpaccept') } catch (err) { e(`TPA auto accept failed: ${sanitize(err.message)}`) }
  } else {
    w(`TPA auto: ignored request from untrusted player ${requester}.`)
  }
}

// Auth prompts ("Please login using /login <password>") and the server's replies
// to them. planAuthAction decides both: it recognises a rejection and remembers
// it, so a wrong password is reported once instead of being retried into a ban.
const authAction = planAuthAction(id, message)
if (authAction.record) {
const f = authAction.record
e(`${id}: auth ${f.kind} — ${sanitize(f.reason)}${f.until ? ` (retrying after ${new Date(f.until).toLocaleTimeString()})` : ' — stopped sending auth commands'}`)
if (authAction.alert) {
if (f.until == null) e(`${id}: fix the password (LOGIN_PASSWORD, PROXY_GROUP_<N>_LOGIN_PASSWORD, or BOT_PASSWORDS), then run /auth-retry ${id}`)
else w(`${id}: repeated throttling escalates to a wrong-password failure after ${AUTH_MAX_THROTTLED} tries.`)
monitoring?.onAuthFailure(id, f)
notifyBotsChanged()
}
}
if (authAction.skip) {
i(`Auth prompt ignored for ${id} — ${authAction.skip.kind}: ${sanitize(authAction.skip.reason)} (fix it, then /auth-retry ${id})`)
} else if (authAction.command) {
i(`Auth prompt detected: sending /${authAction.kind} (password from ${authAction.source})`)
const payload = authAction.command
pushT(() => bot.chat(payload), 220 + Math.random() * 400)
}
})

// Chat activity watchdog: timestamp real player chat so the idle check below
// can run /server lifesteal when the chat has been silent too long. Our own
// bots' echoes (name matches a bot key) do not count as player chat.
bot.on('messagestr', (text) => {
  try {
    const who = detectPlayerChat(text)
    if (who && !(who.name in bots)) {
      bots[id].lastPlayerChatAt = Date.now()
      bots[id].lastPlayerChat = text
    }
  } catch (_) {}
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
// Getting back in means the ban is gone (a temporary ban expired, or somebody
// lifted it), so clear the flag instead of reporting a stale ban forever.
if (dataState.bots[id]?.banned) {
dataStore.upsertBot(dataState, { bot: id, banned: false, bannedAt: null, banKind: null })
persistData()
logFor(id, `{green-fg}✓ ${sanitize(id)} is no longer banned — cleared the ban flag.{/green-fg}`)
}
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

// Skip the GUI/Fatal Crate handler when a /crates or /dump routine opened this
// window. /dump opens chests to deposit items — the GUI item search, slot
// auto-click, and delayed AFK warp must never run on them (it would grab
// items out of the chest and warp away mid-dump).
if (bots[id]?.inCrateRoutine || bots[id]?.inDumpRoutine || bots[id]?.inSpawnerRoutine) return

const title = window.title?.toString ? window.title.toString() : String(window.title || '')

const getSafeItemString = (item) => {
if (!item) return 'null';
const shown = itemDisplayName(item) || item.name || 'item';
const alt = itemAltName(item, shown);
return `[Item ${shown}${alt ? ` (${alt})` : ''} x${item.count || 1}]`;
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

// Slot selection: fixed GUI_SLOT by default, custom shardshopSlot when running /shardshop-loop,
// or search-by-item when GUI_ITEM_SEARCH_ENABLED
const currentEntry = bots[id]
let targetSlot = (currentEntry?.shardshopSlot != null) ? currentEntry.shardshopSlot : GUI_SLOT;
let foundTargetItem = false;

if (currentEntry?.shardshopSlot == null && GUI_ITEM_SEARCH_ENABLED) {
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
if (currentEntry?.shardshopSlot != null) {
i(`Clicked slot ${targetSlot} (shardshop slot) — waiting for server transfer…`)
} else if (!foundTargetItem) {
i(`Clicked slot ${targetSlot} — waiting for server transfer…`)
} else {
i(`Clicked slot ${targetSlot} — matched configured item search`)
}
} catch (err) { e(`Click failed: ${sanitize(err.message || String(err))}`) }
}, 2000 + Math.random() * 1600)

// AFK Warp logic
pushT(async () => {
if (!foundTargetItem && currentEntry?.shardshopSlot == null) {
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
// A ban arrives as an ordinary kick, so the wording is the only evidence. The
// verdict is written to the persisted data state (not just memory) so a banned
// bot is still reported as banned after a restart, and /data publishes it.
const banVerdict = classifyKick(text)
if (banVerdict.banned) {
const alreadyBanned = Boolean(dataState.bots[id]?.banned)
// The FIRST detection sets the clock. Later kicks from the same ban keep it, so a
// reconnect attempt twenty minutes in cannot push the release time further out.
const knownExpiry = Number(dataState.bots[id]?.banExpiresAt) || 0
// A permanent ban never expires. Everything else needs a real expiry or the bot
// would be held forever: a stated length is authoritative, and when the server
// says "temporary" (or only "possibly banned") without saying for how long, retry
// after BAN_RETRY_MS rather than writing the account off.
const unknownLength = !banVerdict.permanent && !banVerdict.durationMs && !banVerdict.expiresAt
const expiresAt = knownExpiry || banVerdict.expiresAt ||
  (banVerdict.durationMs ? Date.now() + banVerdict.durationMs : (unknownLength ? Date.now() + BAN_RETRY_MS : 0))
const banRow = {
bot: id,
banned: true,
// Keep the original ban time across the reconnect attempts that follow.
bannedAt: dataState.bots[id]?.bannedAt || Date.now(),
banKind: banVerdict.kind,
// The clean phrase, never the raw component tree: this is what lands in the
// spreadsheet cell and the Discord embed.
banReason: banVerdict.reason,
banExpiresAt: expiresAt
}
if (banVerdict.duration) banRow.banDuration = banVerdict.duration
if (banVerdict.caseId) banRow.banCaseId = banVerdict.caseId
dataStore.upsertBot(dataState, banRow)
dataStore.recordBan(dataState, {
bot: id,
kind: banVerdict.kind,
reason: banVerdict.reason,
caseId: banVerdict.caseId,
duration: banVerdict.duration,
expiresAt,
permanent: banVerdict.permanent
})
persistData()
if (!alreadyBanned) {
const hold = expiresAt ? ` — held until ${new Date(expiresAt).toLocaleString()}` : (banVerdict.permanent ? ' — permanent, will NOT reconnect' : '')
logFor(id, `{red-fg}⛔ ${sanitize(id)} is ${banVerdict.kind === 'suspected' ? 'possibly ' : ''}banned${banVerdict.duration ? ' for ' + sanitize(banVerdict.duration) : ''} (${sanitize(banVerdict.kind)})${hold}{/red-fg}`)
if (banVerdict.reason && banVerdict.reason !== text) logFor(id, `{red-fg}   reason: ${sanitize(banVerdict.reason)}${banVerdict.caseId ? ' [case ' + sanitize(banVerdict.caseId) + ']' : ''}{/red-fg}`)
if (banVerdict.permanent) {
const moved = removedBotsStore.addRemovedBot(removedBots, { bot: id, kind: banVerdict.kind, reason: banVerdict.reason, caseId: banVerdict.caseId }, { addedBy: 'ban-detection' })
persistRemovedBots()
logFor(id, `{red-fg}   This ban does not expire — ${moved.added ? 'moved to' : 'already on'} the removed list (${REMOVED_BOTS_FILE}).{/red-fg}`)
logFor(id, `{yellow-fg}   Remove it from BOT_NAMES too, or it will just be skipped with a warning at every start. /removed lists them, /unban ${sanitize(id)} puts it back.{/yellow-fg}`)
if (PERMANENT_BAN_ACTION === 'remove' && dropFromRoster(id)) logFor(id, `{yellow-fg}   Removed from the live roster (PERMANENT_BAN_ACTION=hold keeps it visible instead).{/yellow-fg}`)
}
}
}
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

if (bots[id]?.dumpTimers?.length) {
  bots[id].dumpTimers.splice(0).forEach(clearTimeout)
  bots[id].dumpCancelRequested = true
  logFor(id, `{yellow-fg}⚠ Dump routine cancelled because the bot disconnected.{/yellow-fg}`)
}

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
if (bots[id]?.dumpTimers?.length) bots[id].dumpTimers.splice(0).forEach(clearTimeout)
if (bots[id]) bots[id].dumpCancelRequested = true
try { bot.quit() } catch (_) {}
notifyBotsChanged()
}

if (!activeId) activeId = id
notifyBotsChanged()
return bot
}

// ── Group configuration that would otherwise be discovered much later ───────
// A group with no HOST is legitimate (it groups accounts and carries a login
// password), but a PROXY_GROUP_<N>_* variable that belongs to no group is always
// a mistake: the group scan stops at the first missing PROXY_GROUP_<N>_BOTS, so
// everything after a gap is dropped. Both used to be entirely silent, and the
// only symptom was bots logging in with the wrong password.
for (const g of PROXY_GROUPS) {
if (!g.host) logFor(SYSTEM_ID, `{yellow-fg}⚠ PROXY_GROUP_${g.index} has no HOST — its ${g.bots.length} bot(s) use the default route${g.loginPassword ? `, but its login password still applies` : ''}.{/yellow-fg}`)
}
const ignoredGroupVars = findIgnoredProxyGroupVars(process.env, PROXY_GROUPS)
if (ignoredGroupVars.length) {
logFor(SYSTEM_ID, `{yellow-fg}⚠ ignored, no group declares them: ${sanitize(ignoredGroupVars.join(', '))}{/yellow-fg}`)
logFor(SYSTEM_ID, '{yellow-fg}  Groups start at PROXY_GROUP_1_BOTS and stop at the first missing number, so one gap drops every later group.{/yellow-fg}')
}

// ── Connect all bots with staggered delay ───────────────────────────────────
let currentConnectDelay = 0
const initialConnectTimers = []
const initialBotOrder = RANDOMIZE_BOT_ORDER ? shuffledCopy(BOT_NAMES) : BOT_NAMES.slice()
initialBotOrder.forEach((name, index) => {
// The removed list wins over everything: a permanently banned bot is not yours
// to reconnect any more, even if it is still named in BOT_NAMES.
const removal = removedEntryFor(name)
if (removal) {
logFor(SYSTEM_ID, `{red-fg}⛔ ${sanitize(name)} is on the removed list (${sanitize(removedBotsStore.describeRemovedBot(removal))}) — not connecting. Run /unban ${sanitize(name)} to put it back.{/red-fg}`)
return
}

// A ban outlives the process, so a restart must not walk straight back into it.
const held = activeBan(name)
if (held) {
logFor(SYSTEM_ID, held.permanent
? `{red-fg}⛔ ${sanitize(name)} is permanently banned (${sanitize(held.kind)}) — not connecting. Remove it from BOT_NAMES to stop this warning.{/red-fg}`
: `{red-fg}⛔ ${sanitize(name)} is banned (${sanitize(held.kind)}) — not connecting until ${new Date(held.expiresAt).toLocaleString()}.{/red-fg}`)
return
}
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
'/all-slow [delay] <cmd>': `Like /all, but starts each bot ${ALL_SLOW_DELAY_MS / 1000}s apart (ALL_SLOW_DELAY_MS). An optional leading delay overrides it for that run, in the same units as sleep: /all-slow 30 /spawners, /all-slow 500ms /status`,
'/all-slow-cancel [id]': 'Cancel a specific running /all-slow broadcast task by ID (e.g. /all-slow-cancel 1), or all tasks if no ID is specified',
'/overview': 'Dashboard of every bot\'s health, food, ping, rank (via /fix + /rank), shards, coins, balance, and inventory slots',
'/stats': 'Runtime stats: memory, event-loop lag, log rate, web viewers, uptime',
'/crates [color]': `Warp to crates, find + walk to the nearest shulker box of [color] (default: ${CRATE_SHULKER_BLOCK.replace(/_/g, ' ')}, within ${CRATE_SCAN_RADIUS} blocks) and right-click it; falls back to ${WARP_AFK} if not found or unreachable. [color] can be a name like "purple" or a full block id like "purple_shulker_box"`,
'/crates-loop [n] [color]': 'Run /crates repeatedly (default: until failure). Specify n for a fixed count and/or a crate [color]',
'/shardshop-loop [slot]': `Repeatedly run ${SHARDSHOP_COMMAND} until the server signals it's empty (grep: SHARDSHOP_STOP_PHRASES) or hits the ${SHARDSHOP_LOOP_MAX_RUNS}-run safety cap; optional [slot] overrides default GUI slot`,
'/crates-all [n] [color] [dump=…] [afk=…]': `Run shardshop → crates → dump on bots 1 through n (default: all bots) targeting crate [color] (default: ${CRATE_SHULKER_BLOCK.replace(/_/g, ' ')}), ${(CRATES_ALL_STAGGER_MS / 1000).toFixed(0)}s apart so they don't hit the server at once. dump=off|tpa|home|hidden|player:<name> chooses the dump step and afk=now|off|<seconds> chooses the AFK warp; both override CRATES_ALL_DUMP / CRATES_ALL_AFK_WARP / CRATES_ALL_AFK_DELAY_MS for that run`,
'/crates-solo [bot] [color] [dump=…] [afk=…]': 'Run shardshop → crates → dump on just one bot (default: active bot) targeting crate [color] — not all bots. Takes the same dump= / afk= flags as /crates-all',
  '/bot-coinflip [run|stats|deep|history|export] [args]': `The whole coinflip suite. \`run [PRICE] [AMOUNT] [BOT|all]\` plays AMOUNT flips (default ${settings.get('COINFLIP_DEFAULT_FLIPS')}) and records every one: PRICE is a fixed wager (500000) or a random range (10k-1m — the COINFLIP_WAGER_MIN–MAX defaults), a busy or rate-limited create is waited for and re-asked (never deleted), and the run stops at COINFLIP_STOP_LOSS. \`stats [BOT]\` is the win/loss picture with the fairness verdict. \`deep [BOT]\` dissects the history fourteen ways (what follows a loss run, transition table and lag correlation, run lengths, wager against balance and against absolute size, richest vs poorest, hour of day on the server clock, pace, session position, raising after a loss, opponents, money curve) with a confidence interval per bucket and p-values corrected across the whole family. \`history [n|clear confirm]\` lists or wipes the raw records. \`export [BOT]\` writes data/coinflip-export.csv. Anything else is refused with the list. The game's own /coinflip (create, delete, …) is a separate server command: this console does not intercept that name at all, so /coinflip create 10k reaches the selected bot untouched. Works with /all-slow: /all-slow /bot-coinflip run 10k-1m 20`,
  '/coinflip …': 'The game\'s own coinflip command, owned by the server. The console never intercepts it — /coinflip, /coinflip create 10k and /coinflip delete all reach the selected bot (or every bot with /all-slow) untouched',
  '/timeseries [sample [ranks]|series <metric> [bucket] [bot]|events|clear confirm|status]': 'The recorded samples of shards, coins, balance, rank and bans over time — a sparkline, the last buckets, and where the JSON lives. \`sample\` records one right now',
  '/analytics': 'Where the read-only analytics page is, plus the JSON endpoints behind it (/api/analytics, /api/coinflip, /api/timeseries, /api/export)',
  '/analyze [open|url|json]': 'Open the analytics page in browser (default), print the URL, or output the full JSON report. The page shows coinflip fairness tests, time-series charts (shards/coins/balance), fleet stats, ban events, and rank changes.',
  '/env [list [filter]|get KEY|set KEY VALUE|reset KEY|reset-all]': 'Show or change a configuration value for THIS run only — nothing is ever written to the .env file and a restart forgets it. Keys marked startup-only were read once at boot. The dashboard has the same thing as the .ENV tab',
'/spawners': `Without moving, right-click every ${SPAWNER_BLOCK.replace(/_/g, ' ')} already within reach (${SPAWNER_REACH} blocks), clicking GUI slot ${SPAWNER_SLOT_FIRST} then slot ${SPAWNER_SLOT_SECOND} on each one`,
'/data': 'Compile all saved bot/spawner data, save the local JSON snapshot, and push the current snapshot to the Google Sheets Apps Script webhook. Subcommands: /data check (verify the webhook deployment end-to-end), /data status (show webhook config + tracked counts)',
'/list': 'Compact one-line-per-bot status list (online / offline / last kick)',
'/auth-retry <bot>': 'Clear a recorded login/register failure for a bot and reconnect it so it can authenticate again (the failure is otherwise only cleared by a restart)',
'/removed': 'List the removed / permanently-banned bots (the removed-bots.json roster)',
'/unban <bot>': 'Take a bot off the removed list and reconnect it',
'/chat <msg>': 'Send a chat message from the active bot (avoids triggering local commands); /-prefixed server commands open their GUI without auto-clicking',
'/disconnect': 'Disconnect the active bot (stops auto-reconnect). Alias: /dc',
'/closeBot': 'Disconnect the active bot and completely remove it from the UI',
'/clear': 'Clear the active bot\'s log view',
'/help': 'List all available commands',
'/status': 'Show active bot\'s connection, position, health, ping, uptime',
'/inv': 'List active bot\'s inventory',
'/tpauto on|off': 'Toggle automatic /tpaccept for trusted bot names only',
'/find <name>': 'Search EVERY bot\'s inventory and open window for an item by display, custom, or registry name',
'/cron': 'List scheduled jobs; /cron add <schedule> <cmd> | rm <id> | on|off <id> | run <id> — add jobs with /cron add <schedule> <command>, optionally prefixed with @BotName to target a single bot; jobs are saved to CRON_STATE_FILE and reloaded on restart. Schedules are 5-field cron or "@every <secs>"; env CRON_JOB_<N>="<schedule>|<command>"',

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
'/pos': 'Show the active bot location (coordinates, facing, dimension)',
'/view first|third': 'Switch the 3D viewer camera: first-person (what the bot sees) or third-person orbit',
'/take <slot|name|all>': 'Shift-click a specific item out of the open GUI into the inventory',
'/take-gui': 'Shift-click every item out of the open GUI into the inventory',
'/dump-gui': 'Shift-click the whole inventory into the open GUI window',
'anything else': 'Sent directly as a chat message/command from the active bot',
'/dump [home|hidden|cancel]': 'Dump inventory: TPA to the configured main player, use /home stash, run the hidden chain, or cancel',
'/dump-spawners': 'Same as /dump, but only transfers SPAWNERS into the chests (everything else stays in the inventory)',
'/ai-chat [start|stop|status] [bot]': 'Start AI chat for a bot — uses FreeLLM API to generate Minecraft-themed messages every 40-150 seconds with occasional grammar mistakes. Start a chat loop for the current bot (or a specific one), stop an active AI chat, or check status. Requires FREE_LLM_API_KEY and FREE_LLM_BASE_URL in .env'
}

// True when an item is a spawner (mob/monster spawner). Matches the registry
// name first, then falls back to display/custom names, 1.20.5+ data components,
// custom lore, and NBT so renamed server spawners like "§bZombie Spawner",
// "Iron Golem Spawner", etc. are recognized.
function isSpawnerItem (item) {
  if (!item) return false
  // 1. Check registry name and display name (vanilla spawner block or item)
  if (/spawner/i.test(item.name || '') || /spawner/i.test(item.displayName || '')) return true

  // 2. Check custom anvil/display name
  const custom = itemCustomName(item)
  if (custom && /spawner/i.test(custom)) return true

  // 3. Check customLore or lore component
  try {
    const lore = item.customLore
    if (lore) {
      const loreStr = typeof lore === 'string' ? lore : JSON.stringify(lore)
      if (/spawner/i.test(loreStr)) return true
    }
  } catch (_) {}

  // 4. Check componentMap for 1.20.5+ (item_name, custom_name, lore, block_entity_data)
  if (item.componentMap && typeof item.componentMap.forEach === 'function') {
    let matched = false
    item.componentMap.forEach((comp) => {
      if (matched) return
      try {
        const compStr = JSON.stringify(comp)
        if (/spawner/i.test(compStr)) matched = true
      } catch (_) {}
    })
    if (matched) return true
  }

  // 5. Check components array if present
  if (Array.isArray(item.components)) {
    try {
      if (/spawner/i.test(JSON.stringify(item.components))) return true
    } catch (_) {}
  }

  // 6. Check legacy NBT if present
  if (item.nbt) {
    try {
      if (/spawner/i.test(JSON.stringify(item.nbt))) return true
    } catch (_) {}
  }

  return false
}

/**
* Sends a TPA command based on an .env variable, then finds the nearest chests
* within a configured radius and dumps the bot's inventory into them.
*
* @param {object} bot - The mineflayer bot instance
* @param {string} id - The bot id (used for logging)
* @param {object} [options]
* @param {boolean} [options.spawnersOnly] - When true (/dump-spawners), only
*   spawner items are deposited; every other item stays in the inventory.
*/
async function tpaAndDump(bot, id, options = {}) {
const spawnersOnly = Boolean(options.spawnersOnly)
const useHome = Boolean(options.home)
const skipWarp = Boolean(options.skipWarp)
const label = spawnersOnly ? '/dump-spawners' : '/dump'
if (bots[id]) bots[id].dumpCancelRequested = false
if (bots[id]?.dumpOperationActive) {
  logFor(id, `{yellow-fg}⚠ ${label}: a dump is already running for this bot.{/yellow-fg}`)
  return
}
// Suppress the generic windowOpen handler (GUI item search, slot auto-click,
// and the delayed AFK warp) while dumping — /dump opens chests only to
// deposit into them, and none of that automation may run on them.
if (bots[id]) bots[id].inDumpRoutine = true
try {

if (bots[id]) bots[id].dumpOperationActive = true

if (!hasInventoryItems(bot.inventory)) {
  logFor(id, `{yellow-fg}⚠ ${label}: inventory is empty — nothing to dump.{/yellow-fg}`)
  return
}

if (spawnersOnly) {
  const spawnerCount = bot.inventory.items().filter(isSpawnerItem).reduce((sum, it) => sum + (it.count || 1), 0)
  logFor(id, `{cyan-fg}› ${label}: transferring SPAWNERS only — ${spawnerCount} in inventory.{/cyan-fg}`)
  if (spawnerCount === 0) {
    logFor(id, `{yellow-fg}⚠ ${label}: no spawners in the inventory — nothing to transfer.{/yellow-fg}`)
    return
  }
}

const tpaTarget = options.target || TPA_MAIN_PLAYER
const scanRadius = CHEST_SCAN_RADIUS

if (useHome) {
  bot.chat(DUMP_HOME_COMMAND)
  logFor(id, `{cyan-fg}› Sent ${DUMP_HOME_COMMAND}. Waiting for teleport...{/cyan-fg}`)
} else {
  if (!tpaTarget) {
    logFor(id, `{yellow-fg}⚠ ${label}: TPA_MAIN_PLAYER is not configured.{/yellow-fg}`)
    return
  }
  bot.chat(`/tpa ${tpaTarget}`)
  logFor(id, `{cyan-fg}› Sent /tpa to ${tpaTarget}. Waiting for teleport...{/cyan-fg}`)
}

try {
await new Promise((resolve, reject) => {
const startPos = bot.entity.position.clone()
const timeout = setTimeout(() => {
bot.removeListener('move', onMove)
reject(new Error(`Teleport timed out after ${DUMP_TPA_TIMEOUT_MS}ms`))
}, DUMP_TPA_TIMEOUT_MS)

function onMove() {
if (bot.entity.position.distanceTo(startPos) > DUMP_TPA_MIN_DISTANCE) {
clearTimeout(timeout)
bot.removeListener('move', onMove)
resolve()
}
}
bot.on('move', onMove)
})
logFor(id, `{cyan-fg}› Teleport detected! Looking for chests...{/cyan-fg}`)
await new Promise(r => setTimeout(r, DUMP_SETTLE_MS))
} catch (err) {
logFor(id, `{yellow-fg}⚠ ${err.message}. Looking for chests nearby anyway...{/yellow-fg}`)
}

if (!bot.entity || bots[id]?.dumpCancelRequested) {
  logFor(id, `{yellow-fg}⚠ ${label}: dump stopped because the bot disconnected or was cancelled.{/yellow-fg}`)
  return
}

const chestIds = [
bot.registry.blocksByName.chest.id,
bot.registry.blocksByName.trapped_chest.id
]

const chestBlocks = bot.findBlocks({
matching: chestIds,
maxDistance: scanRadius,
count: CHEST_SCAN_COUNT
})

if (chestBlocks.length === 0) {
logFor(id, `{yellow-fg}⚠ ${label}: No chests found within ${scanRadius} blocks.{/yellow-fg}`)
} else {
chestBlocks.sort((a, b) => {
return bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b)
})

let chestsOpened = 0
let stacksMoved = 0
for (const chestPos of chestBlocks) {
if (bots[id]?.dumpCancelRequested) {
  logFor(id, `{yellow-fg}⚠ ${label}: cancelled — stopping before the next chest.{/yellow-fg}`)
  break
}
const itemsToDump = spawnersOnly
  ? bot.inventory.items().filter(isSpawnerItem)
  : bot.inventory.items()
if (itemsToDump.length === 0) {
  if (spawnersOnly) logFor(id, `{green-fg}✓ ${label}: no spawners left in the inventory — done.{/green-fg}`)
  break
}

const chestBlock = bot.blockAt(chestPos)
if (!chestBlock) {
  logFor(id, `{yellow-fg}⚠ ${label}: the chest at ${chestPos.x}, ${chestPos.y}, ${chestPos.z} is not loaded — skipping it.{/yellow-fg}`)
  continue
}
let chestContainer
let chestMoved = 0
let openTimer = null

try {
// mineflayer can wait forever when a chest is unreachable, which used to leave
// the whole dump silently stuck; give up on this chest after DUMP_OPEN_TIMEOUT_MS
// and clear the timer as soon as the chest actually opens.
chestContainer = await Promise.race([
  bot.openContainer(chestBlock),
  new Promise((_, reject) => { openTimer = setTimeout(() => reject(new Error(`opening the chest timed out after ${DUMP_OPEN_TIMEOUT_MS}ms`)), DUMP_OPEN_TIMEOUT_MS) })
])
if (openTimer) { clearTimeout(openTimer); openTimer = null }
chestsOpened++

// Slots in chestContainer:
// [0, chestContainer.inventoryStart - 1] are chest slots.
// [chestContainer.inventoryStart, chestContainer.inventoryEnd - 1] are bot inventory slots.
const invStart = chestContainer.inventoryStart
const invEnd = chestContainer.inventoryEnd

for (let s = invStart; s < invEnd; s++) {
  const item = chestContainer.slots[s]
  if (!item) continue
  if (spawnersOnly && !isSpawnerItem(item)) continue

  const initialCount = item.count
  try {
    // Shift-click the item from bot inventory into the chest.
    // Mode 1, button 0 = shift-click in Minecraft protocol.
    await bot.clickWindow(s, 0, 1)
    await new Promise(r => setTimeout(r, DUMP_CLICK_DELAY_MS))
  } catch (err) {
    logFor(id, `{yellow-fg}⚠ ${label}: shift-click failed on slot ${s}: ${sanitize(err && err.message ? err.message : err)}{/yellow-fg}`)
    break
  }

  // Check if item moved into the chest
  const afterItem = chestContainer.slots[s]
  if (afterItem && afterItem.count === initialCount) {
    // Nothing was deposited — chest is full!
    break
  }
  if (afterItem && afterItem.count > 0) {
    // Only partially deposited — chest is full!
    break
  }
  chestMoved++
}

stacksMoved += chestMoved
if (chestMoved) logFor(id, `{cyan-fg}› ${label}: deposited ${chestMoved} stack(s) into the chest at ${chestPos.x}, ${chestPos.y}, ${chestPos.z}.{/cyan-fg}`)

await chestContainer.close()
} catch (err) {
if (openTimer) { clearTimeout(openTimer); openTimer = null }
logFor(id, `{yellow-fg}⚠ ${label}: could not use the chest at ${chestPos.x}, ${chestPos.y}, ${chestPos.z}: ${sanitize(err && err.message ? err.message : err)}{/yellow-fg}`)

if (chestContainer) {
try { await chestContainer.close() } catch (_) {}
}
}
}

const remaining = spawnersOnly
  ? bot.inventory.items().filter(isSpawnerItem)
  : bot.inventory.items()
if (remaining.length === 0) {
  logFor(id, `{green-fg}✓ ${label}: all ${spawnersOnly ? 'spawners' : 'items'} successfully dumped into chests (${stacksMoved} stack(s) across ${chestsOpened} usable chest(s)).{/green-fg}`)
} else {
  logFor(id, `{yellow-fg}⚠ ${label}: ${remaining.length} stack(s) still in the inventory — ${chestsOpened} usable chest(s) took ${stacksMoved} stack(s).{/yellow-fg}`)
}
}

await new Promise(r => setTimeout(r, DUMP_WARP_DELAY_MS))
if (!bot.entity || bots[id]?.dumpCancelRequested) return
if (!skipWarp) {
  logFor(id, `{cyan-fg}› Warping back to AFK…{/cyan-fg}`)
  try { bot.chat(WARP_AFK) } catch (_) {}
}

} finally {
if (bots[id]) {
  bots[id].inDumpRoutine = false
  bots[id].dumpOperationActive = false
}
}
}

function cancelDumpForBot (id, reason = 'cancelled') {
  const entry = bots[id]
  if (!entry) return false
  const hadTimers = entry.dumpTimers?.length > 0
  if (hadTimers) entry.dumpTimers.splice(0).forEach(clearTimeout)
  entry.dumpCancelRequested = true
  if (entry.inDumpRoutine) logFor(id, `{yellow-fg}⚠ Dump routine ${reason}.{/yellow-fg}`)
  return hadTimers || entry.inDumpRoutine
}

function cancelHiddenDump () {
  if (!hiddenDumpRun) return false
  hiddenDumpRun.cancelled = true
  hiddenDumpRun.timers.splice(0).forEach(clearTimeout)
  Object.keys(bots).forEach(id => cancelDumpForBot(id, 'cancelled'))
  logFor(SYSTEM_ID, `{yellow-fg}⚠ Hidden dump cancelled.{/yellow-fg}`)
  hiddenDumpRun = null
  return true
}

function startHiddenDump () {
  if (hiddenDumpRun) {
    logFor(SYSTEM_ID, `{yellow-fg}⚠ A hidden dump is already running.{/yellow-fg}`)
    return true
  }
  if (!TPA_MAIN_PLAYER) {
    logFor(SYSTEM_ID, '{yellow-fg}⚠ Hidden dump requires TPA_MAIN_PLAYER in .env.{/yellow-fg}')
    return true
  }
  const duration = randomInt(DUMP_HIDDEN_MIN_MS, DUMP_HIDDEN_MAX_MS)
  const allBots = Object.keys(bots).filter(id => id !== TPA_MAIN_PLAYER)
  const plan = buildHiddenDumpPlan(allBots, TPA_MAIN_PLAYER)
  const maxActions = Math.min(plan.length, Math.max(1, Math.floor(duration / DUMP_MIN_TPA_GAP_MS) + 1))
  const selected = plan.slice(0, maxActions)
  hiddenDumpRun = { duration, timers: [], cancelled: false }
  logFor(SYSTEM_ID, `{cyan-fg}› Hidden dump started: ${selected.length}/${plan.length} TPA actions over ${(duration / 60000).toFixed(1)} minutes; minimum gap ${(DUMP_MIN_TPA_GAP_MS / 60000).toFixed(1)} minutes.{/cyan-fg}`)
  if (selected.length < plan.length) logFor(SYSTEM_ID, `{yellow-fg}⚠ Hidden dump limited by the 3-minute TPA gap; ${plan.length - selected.length} bot(s) were skipped this run.{/yellow-fg}`)

  selected.forEach((step, index) => {
    const delay = index === 0 ? 0 : index * DUMP_MIN_TPA_GAP_MS + Math.floor(Math.random() * 15000)
    const timer = setTimeout(() => {
      if (!hiddenDumpRun || hiddenDumpRun.cancelled) return
      const entry = bots[step.bot]
      if (!entry?.bot?.entity) {
        logFor(step.bot, `{yellow-fg}⚠ Hidden dump skipped: bot is disconnected.{/yellow-fg}`)
        return
      }
      entry.dumpCancelRequested = false
      logFor(step.bot, `{cyan-fg}› Hidden dump action ${index + 1}/${selected.length}: TPA to ${step.target}.{/cyan-fg}`)
      tpaAndDump(entry.bot, step.bot, { skipWarp: true, target: step.target }).catch(err => logFor(step.bot, `{red-fg}✗ Hidden dump failed: ${sanitize(err.message)}{/red-fg}`))
    }, delay)
    hiddenDumpRun.timers.push(timer)
    const entry = bots[step.bot]
    if (entry) entry.dumpTimers.push(timer)
  })
  const finishTimer = setTimeout(() => {
    if (!hiddenDumpRun || hiddenDumpRun.cancelled) return
    logFor(SYSTEM_ID, `{green-fg}✓ Hidden dump finished after ${(duration / 60000).toFixed(1)} minutes.{/green-fg}`)
    hiddenDumpRun = null
  }, duration)
  hiddenDumpRun.timers.push(finishTimer)
  return true
}

function runLocalCommandForBot(id, cmd) {
const entry = bots[id]
if (!entry) return false
const { bot } = entry

const parts = String(cmd || '').trim().split(/\s+/)
const baseCmd = parts[0]

switch (baseCmd) {
case '/tpauto': {
  const mode = (parts[1] || '').toLowerCase()
  if (mode !== 'on' && mode !== 'off') {
    logFor(id, `{yellow-fg}⚠ Usage: /tpauto on|off (currently ${entry.tpautoEnabled ? 'on' : 'off'}).{/yellow-fg}`)
    return true
  }
  entry.tpautoEnabled = mode === 'on'
  logFor(id, `{green-fg}✓ TPA auto ${entry.tpautoEnabled ? 'enabled' : 'disabled'}; trusted names only.{/green-fg}`)
  return true
}
case '/status': {
if (!bot.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return true }
const pos = bot.entity.position
const uptimeSec = entry.spawnTime ? Math.floor((Date.now() - entry.spawnTime) / 1000) : 0
logFor(id, `{cyan-fg}› Status for ${id}:{/cyan-fg}`)
logFor(id, ` Server: ${entry.host}:${entry.port} (v${entry.version})`)
// The proxy this bot actually resolved to, group included — not the global one.
// The login password is reported by SOURCE only: which variable to edit is the
// whole question when a bot cannot get past /login, and the value itself has no
// business in the dashboard, the log file, or Discord.
logFor(id, ` Proxy: ${describeProxy(resolveBotProxy(id, PROXY_GROUPS, PROXY_DEFAULT))}`)
const loginPw = resolveLoginPassword(id, PROXY_GROUPS, process.env, BOT_PASSWORDS)
// Passwords are never trimmed (a space can be part of one), which means a stray
// space pasted into .env is invisible and shows up only as a server rejection.
// Say so here — the fact, never the value.
const pwSpace = /^\s|\s$/.test(loginPw.password) ? ' {yellow-fg}⚠ has leading/trailing whitespace, which counts as part of the password{/yellow-fg}' : ''
logFor(id, ` Login password: from ${loginPw.source}${pwSpace}`)
const authFailure = authState.get(id)?.failure
if (authFailure) logFor(id, ` Auth: {red-fg}✗ ${sanitize(authFailure.kind)}{/red-fg} — ${sanitize(authFailure.reason)}${authFailure.until == null ? ' (stopped sending auth commands; /auth-retry to clear)' : ` (waiting until ${new Date(authFailure.until).toLocaleTimeString()})`}`)
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
items.forEach(item => {
const shown = itemDisplayName(item) || item.name || 'item'
logFor(id, ` ${item.count}x ${sanitize(shown)} (slot ${item.slot})`)
const alt = itemAltName(item, shown)
if (alt) logFor(id, `    ↳ ${sanitize(alt)}`)
})
}
return true
}
case '/dump': {
const { mode, unknown: unknownMode } = parseDumpMode(parts[1])
if (unknownMode) logFor(id, `{yellow-fg}⚠ Unknown /dump option "${sanitize(unknownMode)}" — running the default TPA dump instead. Options: home, hidden, cancel.{/yellow-fg}`)
if (mode === 'cancel') { cancelHiddenDump(); cancelDumpForBot(id); return true }
if (mode === 'hidden') return startHiddenDump()
if (!bot.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return true }
if (mode === 'home') return tpaAndDump(bot, id, { home: true })
return tpaAndDump(bot, id)
}
case '/dump-spawners': {
if (!bot.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return true }
return tpaAndDump(bot, id, { spawnersOnly: true })
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
return runCrateRoutine(id)
}

case '/crates-loop': {
if (!bot.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return true }
return runCrateLoop(id)
}

case '/spawners': {
if (!bot.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return true }
return runSpawnerRoutine(id)
}

case '/shardshop-loop': {
if (!bot.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return true }
let slot = null
if (parts.length > 1) {
const parsed = parseInt(parts[1], 10)
if (isNaN(parsed) || parsed < 0 || parsed > 53 || String(parsed) !== parts[1]) {
logFor(id, `{yellow-fg}⚠ Invalid slot "${sanitize(parts[1])}". Must be an integer between 0 and 53.{/yellow-fg}`)
return true
}
slot = parsed
}
return shardshopLoopCommand(id, slot)
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

// ── /spawners: click every spawner already within reach (no movement) ──────
// Resolves with the window the bot just opened, or null if none appeared in time.
function waitForWindowOpen (bot, timeoutMs = SPAWNER_WINDOW_WAIT_MS) {
return new Promise((resolve) => {
if (bot.currentWindow) { resolve(bot.currentWindow); return }
let settled = false
const finish = (win) => {
if (settled) return
settled = true
clearTimeout(timer)
bot.removeListener('windowOpen', onOpen)
resolve(win)
}
const onOpen = (win) => finish(win)
const timer = setTimeout(() => finish(null), timeoutMs)
bot.on('windowOpen', onOpen)
})
}

// Right-click one spawner, then click slot 13 → wait → slot 53 in its GUI.
async function clickSpawnerOnce (bot, id, position) {
const balanceBefore = await queryBalance(id, 'Balance', '/bal')
const block = bot.blockAt(position)
if (!block || block.name !== SPAWNER_BLOCK) {
logFor(id, `{yellow-fg}⚠ Block at ${position.x}, ${position.y}, ${position.z} is no longer a ${SPAWNER_BLOCK.replace(/_/g, ' ')} — skipping.{/yellow-fg}`)
return { ok: false, balanceBefore, balanceAfter: null }
}

try {
await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
await bot.activateBlock(block)
} catch (err) {
logFor(id, `{red-fg}✗ Right-click failed at ${position.x}, ${position.y}, ${position.z}: ${sanitize(err.message || String(err))}{/red-fg}`)
return { ok: false, balanceBefore, balanceAfter: null }
}

const window = await waitForWindowOpen(bot)
if (!window) {
logFor(id, `{yellow-fg}⚠ No GUI opened for the spawner at ${position.x}, ${position.y}, ${position.z} — skipping.{/yellow-fg}`)
return { ok: false, balanceBefore, balanceAfter: null }
}

const clickSlot = async (slot) => {
if (!bot.currentWindow) { logFor(id, `{yellow-fg}⚠ Window closed before slot ${slot} could be clicked.{/yellow-fg}`); return false }
if (slot >= bot.currentWindow.slots.length) {
logFor(id, `{yellow-fg}⚠ Slot ${slot} is out of bounds — the window only has ${bot.currentWindow.slots.length} slots.{/yellow-fg}`)
return false
}
try {
await bot.clickWindow(slot, 0, 0)
logFor(id, `{cyan-fg}› Clicked slot ${slot}.{/cyan-fg}`)
return true
} catch (err) {
logFor(id, `{red-fg}✗ Click on slot ${slot} failed: ${sanitize(err.message || String(err))}{/red-fg}`)
return false
}
}

let ok = await clickSlot(SPAWNER_SLOT_FIRST)
if (ok) {
await new Promise(r => setTimeout(r, SPAWNER_SLOT_DELAY_MS))
if (!bot.entity) return { ok: false, balanceBefore, balanceAfter: null }
ok = await clickSlot(SPAWNER_SLOT_SECOND)
}

// Always leave the GUI closed so the next spawner opens a fresh window.
if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow) } catch (_) {} }
const balanceAfter = ok ? await queryBalance(id, 'Balance', '/bal') : null
return { ok, balanceBefore, balanceAfter }
}

async function runSpawnerRoutine (id) {
const entry = bots[id]
if (!entry) return false
if (entry.manualMode) { logFor(id, `{yellow-fg}⚠ Stop manual interact (/manual-stop) before starting /spawners.{/yellow-fg}`); return false }
if (!entry.bot?.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not currently spawned.{/yellow-fg}`); return false }
if (entry.spawnerRoutineRunning) { logFor(id, `{yellow-fg}⚠ /spawners is already running for ${id}.{/yellow-fg}`); return false }

// A GUI session armed by /chat or /gui must not swallow this routine's windows
if (entry.suppressNextWindowClick) entry.suppressNextWindowClick = false
if (entry.suppressWindowTimer) { clearTimeout(entry.suppressWindowTimer); entry.suppressWindowTimer = null }
if (entry.manualWindow) entry.manualWindow = null
if (entry.manualSession) entry.manualSession = false
if (entry.guiSessionTimer) { clearTimeout(entry.guiSessionTimer); entry.guiSessionTimer = null }

entry.spawnerRoutineRunning = true
entry.inSpawnerRoutine = true
const { bot } = entry

try {
if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow) } catch (_) {} }

const spawnerId = bot.registry?.blocksByName?.[SPAWNER_BLOCK]?.id
if (spawnerId === undefined) {
logFor(id, `{red-fg}✗ Unknown block "${SPAWNER_BLOCK}" for this version — set SPAWNER_BLOCK in .env.{/red-fg}`)
return false
}

// No walking: only spawners already inside the bot's reach are considered.
const positions = bot.findBlocks({
matching: spawnerId,
maxDistance: SPAWNER_REACH,
count: SPAWNER_MAX_COUNT
})

if (!positions.length) {
logFor(id, `{yellow-fg}⚠ No ${SPAWNER_BLOCK.replace(/_/g, ' ')} within ${SPAWNER_REACH} blocks — nothing to click.{/yellow-fg}`)
return false
}

positions.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b))
logFor(id, `{cyan-fg}› Found ${positions.length} spawner(s) in reach — clicking slot ${SPAWNER_SLOT_FIRST} then ${SPAWNER_SLOT_SECOND} on each…{/cyan-fg}`)

let done = 0
// A run that finishes knows which spawner rows it did NOT visit; a run cut short
// by a disconnect knows nothing, and must not clear anything.
let completed = true
let earnSum = 0
let sawBalance = false
// The earliest last-sample the run measured from. A spawner's `earned` is the
// balance change since THAT row was last sampled (usually the previous run), so
// the honest elapsed time for the sum is this window — not the duration of the
// clicking itself.
let windowStart = Infinity
const runStartedAt = Date.now()
for (let idx = 0; idx < positions.length; idx++) {
if (!bot.entity) { logFor(id, `{red-fg}✗ ${id} despawned during /spawners — stopping.{/red-fg}`); completed = false; break }
const pos = positions[idx]
logFor(id, `{cyan-fg}› Spawner ${idx + 1}/${positions.length} at ${pos.x}, ${pos.y}, ${pos.z}…{/cyan-fg}`)
const result = await clickSpawnerOnce(bot, id, pos)
if (result.ok) done++
const spawnerNumber = idx + 1
const key = `${id}:${spawnerNumber}`
const previous = dataState.spawners[key]
if (Number.isFinite(previous?.recordedAt)) windowStart = Math.min(windowStart, previous.recordedAt)
const balance = Number.isFinite(result.balanceAfter) ? result.balanceAfter : null
const production = dataStore.calculateProduction(previous, balance, Date.now())
dataStore.upsertSpawner(dataState, {
  bot: id,
  spawnerNumber,
  location: { x: pos.x, y: pos.y, z: pos.z, dimension: bot.game?.dimension || null },
  botPosition: botLocation(bot),
  lastRunAt: new Date().toISOString(),
  recordedAt: Date.now(),
  balanceBefore: result.balanceBefore,
  balance,
  earned: production.earned,
  ratePerHour: production.ratePerHour,
  calculationStatus: production.status,
  successful: result.ok
})
if (Number.isFinite(production.earned)) { earnSum += production.earned; sawBalance = true }
persistData()
if (idx < positions.length - 1) await new Promise(r => setTimeout(r, SPAWNER_NEXT_DELAY_MS))
}

// The number being measured is the bot's WHOLE-player balance, sampled around
// one click at a time. Every spawner row therefore holds a slice of the same
// measurement and only their sum is real, so the window total is accumulated on
// the BOT row — where the measurement belongs — and the old per-spawner
// `lifetimeEarned` is gone. (spawnerNumber is the ordinal in a distance-sorted
// list, not a stable identity, so those per-spawner totals were accumulating the
// wrong windows onto the wrong blocks.)
const runEarned = sawBalance ? earnSum : null
if (completed) {
  Object.values(dataState.spawners).forEach(row => {
    if (row.bot !== id || row.spawnerNumber <= positions.length) return
    if (row.earned == null && row.ratePerHour == null) return
    dataStore.upsertSpawner(dataState, { bot: id, spawnerNumber: row.spawnerNumber, earned: null, ratePerHour: null, calculationStatus: 'not seen this run' })
  })
}

logFor(id, `{green-fg}✓ /spawners finished — ${done}/${positions.length} spawner(s) fully clicked.{/green-fg}`)
const previousBot = dataState.bots[id]
const windowMs = Number.isFinite(windowStart) ? Date.now() - windowStart : 0
dataStore.upsertBot(dataState, {
  bot: id,
  recordedAt: Date.now(),
  balance: await queryBalance(id, 'Balance', '/bal'),
  ...dataStore.flattenPosition(botLocation(bot)),
  // How many spawners were found on this bot's plot — the world truth, owned by
  // the /spawners pass alone.
  spawnerCount: positions.length,
  successfulSpawners: done,
  // The measured window at the level it was measured (this run), the running
  // total that replaces the old Lifetime tab, and the rate derived from the
  // window instead of from a single spawner's slice of it.
  earned: runEarned,
  lifetimeEarned: (Number.isFinite(previousBot?.lifetimeEarned) ? previousBot.lifetimeEarned : 0) + (runEarned || 0),
  ratePerHour: runEarned !== null && windowMs > 0 ? runEarned * 3600000 / windowMs : null,
  ...botInventoryColumns(bot),
  runStartedAt
})
persistData()
return done > 0
} catch (err) {
logFor(id, `{red-fg}✗ /spawners failed: ${sanitize(err.message || String(err))}{/red-fg}`)
return false
} finally {
if (bots[id]) {
bots[id].spawnerRoutineRunning = false
bots[id].inSpawnerRoutine = false
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
function runShardshopLoop(id, customSlot = null) {
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
entry.shardshopSlot = customSlot
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
if (bots[id]) {
bots[id].shardshopLoopRunning = false
bots[id].shardshopSlot = null
}
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

async function shardshopLoopCommand(id, customSlot = null) {
const result = await runShardshopLoop(id, customSlot)
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
// The hidden dump is a fleet-wide chain, so one /crates-all run arms it once
// (on the first bot that reaches the dump step) instead of once per bot.
let cratesAllHiddenStarted = false

// Merges the .env defaults with the per-command `dump=` / `afk=` flags into the
// plan the sequence runs with.
function cratesAllPlan(flags = {}) {
const dump = flags.dump || CRATES_ALL_DUMP_ENV.dump
const target = flags.dumpTarget || CRATES_ALL_DUMP_ENV.target || TPA_MAIN_PLAYER
const afkDelayMs = flags.afkDelayMs == null ? CRATES_ALL_AFK_DELAY_MS : flags.afkDelayMs
let afkWarp = flags.afkWarp == null ? CRATES_ALL_AFK_WARP : flags.afkWarp
// A hidden dump deliberately leaves each bot where it TPA'd to, and the AFK
// warp would undo exactly that — so hidden turns it off unless this run asked
// for one explicitly (afk=now / afk=30).
if (dump === 'hidden' && flags.afkWarp !== true) afkWarp = false
return { dump, target, afkWarp, afkDelayMs }
}

function describeCratesAllPlan(plan) {
const dump = plan.dump === 'off' ? 'no dump'
: plan.dump === 'home' ? `dump via ${DUMP_HOME_COMMAND}`
: plan.dump === 'hidden' ? 'hidden dump chain'
: `dump via /tpa ${plan.target || '(no target configured)'}`
const afk = !plan.afkWarp ? 'stay put afterwards'
: plan.afkDelayMs === 0 ? `immediate ${WARP_AFK}`
: `${WARP_AFK} after ${(plan.afkDelayMs / 1000).toFixed(0)}s`
return `${dump}, ${afk}`
}

async function runCratesAllSequenceForBot(id, blockNameOverride, plan = cratesAllPlan()) {
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

// 3. dump — the mode comes from CRATES_ALL_DUMP or this run's `dump=` flag
if (plan.dump === 'off') {
logFor(id, `{cyan-fg}› Dump step skipped (dump=off) — leaving the inventory as-is.{/cyan-fg}`)
} else if (plan.dump === 'hidden') {
if (cratesAllHiddenStarted) {
logFor(id, `{cyan-fg}› Hidden dump is already armed — this bot's inventory is left for the chain.{/cyan-fg}`)
} else {
logFor(id, `{cyan-fg}› Arming the hidden dump chain for the whole roster (dump=hidden).{/cyan-fg}`)
cratesAllHiddenStarted = true
startHiddenDump()
}
} else {
try {
await tpaAndDump(bot, id, plan.dump === 'home' ? { home: true } : { target: plan.target })
logFor(id, `{green-fg}✓ /crates-all: sequence complete for ${id}.{/green-fg}`)
} catch (err) {
logFor(id, `{red-fg}✗ Dump step failed: ${sanitize(err.message)}{/red-fg}`)
}
}

// 4. Warp back to AFK — afk=now (or CRATES_ALL_AFK_DELAY_MS=0) skips the wait
if (!plan.afkWarp) {
logFor(id, `{cyan-fg}› Staying put (AFK warp off for this run).{/cyan-fg}`)
} else {
if (plan.afkDelayMs > 0) {
logFor(id, `{cyan-fg}› Waiting ${(plan.afkDelayMs / 1000).toFixed(0)}s before warping to AFK…{/cyan-fg}`)
await new Promise(r => setTimeout(r, plan.afkDelayMs))
} else {
logFor(id, `{cyan-fg}› Routine done — warping to AFK now.{/cyan-fg}`)
}
if (bots[id]?.bot?.entity) {
try { bot.chat(WARP_AFK) } catch (_) {}
}
}
}

// Runs the shardshop → crates → dump sequence on bots 1..maxBots (insertion
// order, matching /list and /switch numbering), starting one bot every
// CRATES_ALL_STAGGER_MS so they don't all warp/click/TPA at the exact same
// moment. maxBots omitted/Infinity = every bot currently registered.
async function runCratesAll(maxBots = Infinity, blockNameOverride, plan = cratesAllPlan()) {
if (cratesAllRunning) { logWarn('/crates-all is already running.'); return }
const ids = Object.keys(bots).slice(0, maxBots)
if (ids.length === 0) { logWarn('No bots to run /crates-all on.'); return }

cratesAllRunning = true
cratesAllHiddenStarted = false
logInfo(`Starting /crates-all for ${ids.length} bot(s) [1–${ids.length}], ${(CRATES_ALL_STAGGER_MS / 1000).toFixed(0)}s apart — ${describeCratesAllPlan(plan)}…`)

try {
await Promise.allSettled(
ids.map((id, idx) => new Promise((resolve) => {
setTimeout(() => { runCratesAllSequenceForBot(id, blockNameOverride, plan).finally(resolve) }, idx * CRATES_ALL_STAGGER_MS)
}))
)
logSuccess(`/crates-all finished for all ${ids.length} bot(s).`)
} finally {
cratesAllRunning = false
}
}

// ── Coinflip data run ────────────────────────────────────────────────────────
// /bot-coinflip run plays N coinflips on one bot and records every one of them.
// The rules it follows, and why:
//   • A busy flip is never deleted and remade — remaking cannot succeed while a
//     flip is open, so the run waits and re-asks instead.
//   • A result message is the truth; a balance that moved by exactly the wager
//     is the fallback; a *successful new create* proves the previous one ended,
//     and since the server announces wins, that means it was a loss.
//   • Nothing is inferred from the absence of a message alone — an unreadable
//     flip stays pending and is settled by the next accepted create.
const COINFLIP_USAGE = '/bot-coinflip run [PRICE] [AMOUNT] [BOT] — PRICE is a fixed amount (500000) or a random range (10k-1m), AMOUNT is how many flips per bot (default COINFLIP_DEFAULT_FLIPS), BOT defaults to the current bot (or `all` for every spawned bot). Named forms work too: wager=10k-1m flips=5 bot=BotA'
const COINFLIP_ALL_USAGE = '/bot-coinflip-all run [PRICE] [AMOUNT] [MAX_CONCURRENT] — runs coinflips across the fleet with a concurrency pool. Randomly selects MAX_CONCURRENT bots (default 5), each playing AMOUNT flips (default COINFLIP_DEFAULT_FLIPS). When a bot finishes, another random bot is selected from the queue automatically. PRICE is fixed (500000) or a random range (10k-1m).'
const coinflipObservers = new Map()
const coinflipSessions = new Map() // bot -> session in flight (guards against a second run)
const coinflipLastRun = new Map() // bot -> the finished session, for the bot card


// ── AI Chat configuration ───────────────────────────────────────────────────
const AI_CHAT_ENABLED = true  // Enable AI chat by default
const AI_CHAT_INTERVAL_MIN_MS = parseInt(process.env.AI_CHAT_INTERVAL_MIN_MS || '40000', 10) // 40 seconds
const AI_CHAT_INTERVAL_MAX_MS = parseInt(process.env.AI_CHAT_INTERVAL_MAX_MS || '150000', 10) // 150 seconds
const AI_CHAT_WORD_LIMIT = parseInt(process.env.AI_CHAT_WORD_LIMIT || '15', 10)

// ── AI Chat state ────────────────────────────────────────────────────────────
const aiChatSessions = new Map() // bot -> active AI chat session
const aiChatModelsCache = { models: [], lastFetched: 0 } // Cache for available models
const AI_CHAT_MODELS_CACHE_TTL_MS = 3600000 // Cache for 1 hour

// ── AI Chat functions ─────────────────────────────────────────────────────────
function startAIChatForBot(id) {
  if (!AI_CHAT_ENABLED) return false
  const entry = bots[id]
  if (!entry?.bot?.entity) {
    logFor(id, '{yellow-fg}⚠ AI chat requires the bot to be spawned.{/yellow-fg}')
    return false
  }
  
  if (aiChatSessions.has(id)) {
    logFor(id, '{yellow-fg}⚠ AI chat is already running for this bot.{/yellow-fg}')
    return false
  }
  
  aiChatSessions.set(id, true)

  // Get the bot's actual name from BOT_NAMES
  const botIndex = BOT_NAMES.indexOf(id)
  const botName = botIndex >= 0 ? BOT_NAMES[botIndex] : id
  
  // Start the loop
  const loop = async () => {
    while (aiChatSessions.has(id)) {
      try {
        // Get latest player chat if available
        const latestChat = entry.lastPlayerChat || ''
        const message = await callFreeLLMChat(latestChat, botName)
        if (message && entry.bot?.entity) {
          const words = message.split(/\s+/).filter(Boolean);
          const limited = words.slice(0, 8).join(' ');
          logFor(id, `{cyan-fg}AI → ${limited}{/cyan-fg}`)
          entry.bot.chat(limited)
        }
      } catch (err) {
        // Log different error types with appropriate messages
        if (err.message?.includes('404') || err.message?.includes('Not Found')) {
          logFor(id, `{yellow-fg}⚠ AI chat endpoint not found (404) — check FREE_LLM_BASE_URL in .env{/yellow-fg}`)
          logFor(id, `{gray-fg}⚠ Falling back to random Minecraft messages{/gray-fg}`)
        } else if (err.message?.includes('ECONNREFUSED') || err.message?.includes('connection refused')) {
          logFor(id, `{yellow-fg}⚠ AI chat server unreachable — check FREE_LLM_BASE_URL{/yellow-fg}`)
          logFor(id, `{gray-fg}⚠ Falling back to random Minecraft messages{/gray-fg}`)
        } else {
          logFor(id, `{red-fg}✗ AI chat error: ${sanitize(err.message)}{/red-fg}`)
        }
      }

      // Wait random interval between 40-150 seconds
      const delay = Math.floor(Math.random() * (AI_CHAT_INTERVAL_MAX_MS - AI_CHAT_INTERVAL_MIN_MS)) + AI_CHAT_INTERVAL_MIN_MS
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  
  loop().catch(err => {
    logFor(id, `{red-fg}✗ AI chat loop failed: ${sanitize(err.message)}{/red-fg}`)
    aiChatSessions.delete(id)
  })

  return true
}

function stopAIChatForBot(id) {
  if (!aiChatSessions.has(id)) return false
  aiChatSessions.delete(id)
  logFor(id, '{yellow-fg}⚠ AI chat stopped.{/yellow-fg}')
  return true
}

// ── /ai-chat command ─────────────────────────────────────────────────────────
const AI_CHAT_USAGE = '/ai-chat [start|stop|status] [bot] — starts or stops AI chat for a bot. With no args, starts AI chat for the current bot.'

function handleAIChatCommand (cmd, ctx) {
  const parts = cmd.trim().split(/\s+/)
  const action = parts[1]?.toLowerCase()
  const targetBot = parts[2] || ctx?.selectedId
  
  if (!action || action === 'start') {
    if (!targetBot) {
      logFor(ctx?.selectedId || SYSTEM_ID, `{yellow-fg}⚠ Specify a bot: ${AI_CHAT_USAGE}{/yellow-fg}`)
      return
    }
    startAIChatForBot(targetBot)
  } else if (action === 'stop') {
    if (!targetBot) {
      logFor(ctx?.selectedId || SYSTEM_ID, `{yellow-fg}⚠ Specify a bot: ${AI_CHAT_USAGE}{/yellow-fg}`)
      return
    }
    stopAIChatForBot(targetBot)
  } else if (action === 'status') {
    const status = aiChatSessions.has(targetBot)
      ? '{green-fg}running{/green-fg}'
      : '{yellow-fg}not running{/yellow-fg}'
    logFor(targetBot || SYSTEM_ID, `{cyan-fg}AI chat status for ${targetBot || 'current bot'}: ${status}{/cyan-fg}`)
  } else {
    logFor(ctx?.selectedId || SYSTEM_ID, `{yellow-fg}⚠ Unknown action "${action}". ${AI_CHAT_USAGE}{/yellow-fg}`)
  }
}

// ── /bot-coinflip-all concurrency-pooled fleet engine ───────────────────────
// Runs coinflips across the fleet with a concurrency pool: at most
// MAX_CONCURRENT bots are active at once, and when one finishes another random
// bot is selected from the queue. This prevents server rate-limiting from a
// burst of simultaneous creates while keeping the fleet busy.
const coinflipAllPool = {
  active: new Map(),     // botId -> { session, opts }
  queue: [],             // remaining botIds waiting to run
  completed: 0,          // total flips completed across the fleet
  total: 0,              // total flips planned
  running: false,
  stopRequested: false
}

function cfMoney (value) {
  if (value == null || !Number.isFinite(Number(value))) return 'N/A'
  return '$' + Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function cfDuration (ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const days = Math.floor(ms / 86400000)
  const hours = Math.floor((ms % 86400000) / 3600000)
  const mins = Math.floor((ms % 3600000) / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  if (days) return `${days}d ${hours}h`
  if (hours) return `${hours}h ${mins}m`
  if (mins) return `${mins}m ${secs}s`
  return `${secs}s`
}

// One observer per bot. It is created the first time that bot plays a coinflip
// and lives for the process, so a result block that started before a session
// still lands in the right place.
function coinflipObserverFor (id) {
  let observer = coinflipObservers.get(id)
  if (!observer) {
    observer = coinflip.createCoinflipObserver({
      botName: id,
      settleMs: settings.get('COINFLIP_SETTLE_MS'),
      now: () => Date.now()
    })
    coinflipObservers.set(id, observer)
  }
  return observer
}

function feedCoinflipLine (id, message) {
  try { coinflipObserverFor(id).feed(message) } catch (_) {}
}

function describeWagerSpec (spec) {
  if (!spec) return 'the configured random range'
  if (spec.kind === 'fixed') return cfMoney(spec.amount)
  return `${cfMoney(spec.min)}–${cfMoney(spec.max)} at random`
}

function logCoinflipEvent (id, event) {
  if (event.kind === 'create') {
    logFor(id, `{cyan-fg}› /coinflip create ${cfMoney(event.wager)}{/cyan-fg}`)
    return
  }
  if (event.kind === 'busy') {
    logFor(id, `{yellow-fg}⚠ An active coinflip is still open — waiting ${cfDuration(settings.get('COINFLIP_BUSY_WAIT_MS'))}, then asking again (never deleting it).{/yellow-fg}`)
    return
  }
  if (event.kind === 'cooldown') {
    logFor(id, `{yellow-fg}⚠ The server rate-limited /coinflip create (attempt ${event.attempt}) — waiting ${cfDuration(event.waitMs)} and asking again. Nothing was recorded.{/yellow-fg}`)
    return
  }
  if (event.kind === 'unresolved') {
    logFor(id, `{yellow-fg}⚠ No result and no balance change for a ${cfMoney(event.wager)} flip — leaving it pending; the next accepted create records it as a loss.{/yellow-fg}`)
    return
  }
  if (!event.id) return
  const colour = event.result === 'won' ? 'green-fg' : event.result === 'lost' ? 'red-fg' : 'yellow-fg'
  const mark = event.result === 'won' ? '✓' : event.result === 'lost' ? '✗' : '•'
  const opponent = event.opponent ? ` vs ${sanitize(event.opponent)}` : ''
  const method = event.method !== 'message' ? ` (by ${event.method})` : ''
  logFor(id, `{${colour}}${mark} flip ${event.index}: ${event.result} ${cfMoney(event.wager)}${opponent} — Δ ${cfMoney(event.delta)}${method}{/${colour}}`)
  if (event.mismatched) logFor(id, `{yellow-fg}⚠ ${sanitize(event.note)}{/yellow-fg}`)
}

function persistCoinflipSummary () {
  try {
    const summary = coinflipStore.summary({
      recent: 200,
      minSample: settings.get('COINFLIP_MIN_SAMPLE'),
      suspicionP: settings.get('COINFLIP_SUSPICION_P')
    })
    fs.mkdirSync(path.dirname(COINFLIP_SUMMARY_FILE), { recursive: true })
    fs.writeFileSync(COINFLIP_SUMMARY_FILE, JSON.stringify(summary, null, 2))
    persistCoinflipDeepReport()
  } catch (_) {}
}

// ── Deep dissection report ───────────────────────────────────────────────────
// The dissection walks the whole history and the dashboard asks for it on every
// refresh, so the last report is cached against the history it was computed from
// (length plus the newest timestamp is enough to notice an appended record).
let deepCache = null

function coinflipDeepReport (opts = {}) {
  const rows = coinflipStore.all()
  const bot = opts.bot || null
  const minBucket = settings.get('COINFLIP_DEEP_MIN_BUCKET')
  const q = settings.get('COINFLIP_DEEP_Q')
  const key = [rows.length, rows.length ? rows[rows.length - 1].ts : 0, bot || '', minBucket, q].join('|')
  if (deepCache && deepCache.key === key) return deepCache.report
  const scoped = bot ? rows.filter(row => row.bot === bot) : rows
  const report = analysis.deepAnalysis(scoped, {
    q,
    minBucket,
    tzOffsetMinutes: settings.get('COINFLIP_TZ_OFFSET_MIN')
  })
  report.bot = bot
  deepCache = { key, report }
  return report
}

function persistCoinflipDeepReport () {
  const report = coinflipDeepReport()
  try {
    fs.mkdirSync(path.dirname(COINFLIP_DEEP_FILE), { recursive: true })
    fs.writeFileSync(COINFLIP_DEEP_FILE, JSON.stringify(report, null, 2))
  } catch (_) { /* the report is still returned; the file is best-effort */ }
  return report
}
// Plays `flips` coinflips on one bot and records every outcome. Returns the
// session result, or null when it could not start.
async function runCoinflipForBot (id, opts = {}) {
  const entry = bots[id]
  if (!entry) { logFor(activeId || SYSTEM_ID, `{red-fg}✗ No bot named "${sanitize(id)}".{/red-fg}`); return null }
  if (!entry.bot?.entity) { logFor(id, `{yellow-fg}⚠ ${id} is not spawned — nothing to run.{/yellow-fg}`); return null }
  if (coinflipSessions.has(id)) { logFor(id, `{yellow-fg}⚠ ${id} already has a /bot-coinflip run going (${coinflipSessions.get(id).flips} flip(s) so far).{/yellow-fg}`); return null }
  if (entry.manualMode) { logFor(id, `{yellow-fg}⚠ Stop manual interact (/manual-stop) before running /bot-coinflip run on ${id}.{/yellow-fg}`); return null }
  if (entry.crateRoutineRunning || entry.crateLoopRunning) { logFor(id, `{yellow-fg}⚠ ${id} is busy with a crate routine — skipping /bot-coinflip run.{/yellow-fg}`); return null }

  const planned = opts.flips == null ? settings.get('COINFLIP_DEFAULT_FLIPS') : opts.flips
  const stopLoss = settings.get('COINFLIP_STOP_LOSS')
  const spec = opts.wagerSpec || coinflip.parseWagerSpec('', { min: settings.get('COINFLIP_WAGER_MIN'), max: settings.get('COINFLIP_WAGER_MAX') })
  const session = { startedAt: Date.now(), planned, flips: 0, wins: 0, losses: 0, unresolved: 0, net: 0, stopped: 'running', sessionId: `cf-${Date.now().toString(36)}` }
  coinflipSessions.set(id, session)
  notifyBotsChanged()

  const observer = coinflipObserverFor(id)
  observer.reset()
  logFor(id, `{cyan-fg}› /bot-coinflip run: up to ${planned} flip(s) at ${describeWagerSpec(spec)}, stop loss ${cfMoney(stopLoss)}{/cyan-fg}`)

  let result = null
  try {
    result = await coinflip.runCoinflipSession({
      bot: id,
      botName: id,
      flips: planned,
      wagerSpec: spec,
      stopLoss,
      balanceFraction: settings.get('COINFLIP_BALANCE_FRACTION'),
      sessionId: session.sessionId
    }, {
      send: (cmd) => {
        const live = bots[id]?.bot
        if (!live?.entity) throw new Error(`${id} despawned`)
        live.chat(cmd)
      },
      balance: () => queryBalance(id, 'Balance', '/bal', settings.get('COINFLIP_BALANCE_TIMEOUT_MS')),
      sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
      observer,
      log: (event) => logCoinflipEvent(id, event),
      now: () => Date.now(),
      rand: Math.random,
      busyWaitMs: settings.get('COINFLIP_BUSY_WAIT_MS'),
      busyMaxWaitMs: settings.get('COINFLIP_BUSY_MAX_WAIT_MS'),
      flipTimeoutMs: settings.get('COINFLIP_FLIP_TIMEOUT_MS'),
      pollMs: settings.get('COINFLIP_POLL_MS'),
      // The /bal that answers just before a create is the command that trips the
      // server's rate limit, so the create waits this long after that answer.
      createCooldownMs: settings.get('COINFLIP_CREATE_COOLDOWN_MS')
    })
  } catch (err) {
    result = { bot: id, records: [], net: 0, stopped: 'disconnected', reason: sanitize(err.message || String(err)) }
  }

  coinflipStore.appendAll(result.records || [])
  const stats = coinflip.computeStats(result.records || [])
  session.flips = stats.resolved
  session.wins = stats.wins
  session.losses = stats.losses
  session.unresolved = stats.unresolved
  session.net = stats.net
  session.stopped = result.stopped

  logFor(id, `{cyan-fg}› ${sanitize(coinflip.describeSession({ ...result, records: result.records || [] }))}{/cyan-fg}`)
  // The whole point of recording is the verdict, so it is printed here rather
  // than only being visible on a page nobody opens until something looks odd.
  const botRecords = coinflipStore.all().filter(row => row.bot === id)
  const fairness = coinflip.analyzeFairness(botRecords, {
    minSample: settings.get('COINFLIP_MIN_SAMPLE'),
    suspicionP: settings.get('COINFLIP_SUSPICION_P')
  })
  const colour = fairness.verdict === 'suspicious' ? 'red-fg' : fairness.verdict === 'watch' ? 'yellow-fg' : 'gray-fg'
  const pText = fairness.p == null ? '' : `, p=${fairness.p.toFixed(4)}`
  const flagText = fairness.flags.length ? ` — ${sanitize(fairness.flags[0])}` : ''
  logFor(id, `{${colour}}› Coinflip fairness for ${id}: ${fairness.verdict} — ${stats.wins}W/${stats.losses}L lifetime${pText}${flagText}{/${colour}}`)
  if (stats.mismatches) logFor(id, `{red-fg}✗ ${stats.mismatches} flip(s) where the message and the balance disagreed — see /bot-coinflip history.{/red-fg}`)
  if (result.cooldowns) logFor(id, `{yellow-fg}⚠ The server rate-limited ${result.cooldowns} create(s) during the run — raise COINFLIP_CREATE_COOLDOWN_MS in the .ENV tab if it keeps happening.{/yellow-fg}`)
  if (result.stopped === 'no-opponent') logFor(id, `{yellow-fg}⚠ The flip is still open and will not be remade. Remove it by hand if you want the run to continue, then start it again.{/yellow-fg}`)

  // The session stops being "in flight" the moment it ends — otherwise the next
  // /bot-coinflip run on this bot would be refused as a duplicate forever. The
  // summary stays on the card as the last run instead.
  coinflipSessions.delete(id)
  coinflipLastRun.set(id, { ...session, finishedAt: Date.now() })
  persistCoinflipSummary()
  notifyBotsChanged()
  return { ...result, stats, fairness, session }
}

// `all` (or no bot at all) fans out across the roster, staggered like /all-slow
// so the server does not see a burst of coinflip commands.
async function runCoinflipAcrossBots (ids, opts) {
  const stagger = settings.get('ALL_SLOW_DELAY_MS')
  logFor(SYSTEM_ID, `{cyan-fg}› Starting /bot-coinflip run for ${ids.length} bot(s), ${cfDuration(stagger)} apart…{/cyan-fg}`)
  await Promise.allSettled(ids.map((id, idx) => new Promise(resolve => {
    setTimeout(() => { runCoinflipForBot(id, opts).finally(resolve) }, idx * stagger)
  })))
  logFor(SYSTEM_ID, `{green-fg}✓ /bot-coinflip run finished for ${ids.length} bot(s).{/green-fg}`)
}

// ── /bot-coinflip-all: concurrency-pooled fleet engine ─────────────────────
// Runs coinflips across the fleet with a concurrency pool: at most
// MAX_CONCURRENT bots are active at once. When one finishes, another random
// bot is selected from the queue automatically. This prevents server
// rate-limiting from a burst of simultaneous creates while keeping the fleet
// busy. Uses Fisher-Yates shuffle for random selection.
function shuffleArray (arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

async function runCoinflipAll (ids, opts) {
  const maxConcurrent = Math.max(1, Math.min(opts.maxConcurrent || 5, ids.length))
  const flipsPerBot = opts.flips || settings.get('COINFLIP_DEFAULT_FLIPS')
  const totalFlips = flipsPerBot * ids.length
  
  coinflipAllPool.active.clear()
  coinflipAllPool.queue = shuffleArray(ids)
  coinflipAllPool.completed = 0
  coinflipAllPool.total = totalFlips
  coinflipAllPool.running = true
  coinflipAllPool.stopRequested = false
  
  logFor(SYSTEM_ID, `{cyan-fg}› Starting /bot-coinflip-all: ${ids.length} bot(s), ${maxConcurrent} concurrent, ${flipsPerBot} flips each (${totalFlips} total){/cyan-fg}`)
  
  return new Promise((resolve) => {
    const pump = async () => {
      // Fill the pool up to maxConcurrent
      while (coinflipAllPool.active.size < maxConcurrent && coinflipAllPool.queue.length > 0 && !coinflipAllPool.stopRequested) {
        const botId = coinflipAllPool.queue.shift()
        const entry = bots[botId]
        if (!entry?.bot?.entity) continue
        if (coinflipSessions.has(botId)) continue
        if (entry.manualMode) continue
        if (entry.crateRoutineRunning || entry.crateLoopRunning) continue
        
        const session = { startedAt: Date.now(), planned: flipsPerBot, flips: 0, wins: 0, losses: 0, unresolved: 0, net: 0, stopped: 'running', sessionId: `cf-all-${Date.now().toString(36)}` }
        coinflipSessions.set(botId, session)
        coinflipAllPool.active.set(botId, { session, opts })
        notifyBotsChanged()
        
        // Run the session asynchronously; when done, remove from pool and pump again
        runCoinflipForBot(botId, { flips: flipsPerBot, wagerSpec: opts.wagerSpec }).finally(() => {
          coinflipAllPool.active.delete(botId)
          coinflipAllPool.completed += flipsPerBot
          notifyBotsChanged()
          pump() // refill the pool
        })
      }
      
      // Check if done
      if (coinflipAllPool.active.size === 0 && coinflipAllPool.queue.length === 0) {
        coinflipAllPool.running = false
        logFor(SYSTEM_ID, `{green-fg}✓ /bot-coinflip-all finished: ${coinflipAllPool.completed} flips completed across ${ids.length} bot(s).{/green-fg}`)
        resolve({ completed: coinflipAllPool.completed, total: coinflipAllPool.total })
      }
    }
    pump()
  })
}

async function stopCoinflipAll () {
  coinflipAllPool.stopRequested = true
  // Wait for active sessions to finish
  while (coinflipAllPool.active.size > 0) {
    await new Promise(r => setTimeout(r, 1000))
  }
  coinflipAllPool.running = false
  logFor(SYSTEM_ID, `{yellow-fg}⚠ /bot-coinflip-all stopped by request.{/yellow-fg}`)
}

// ── Time series ──────────────────────────────────────────────────────────────
// Samples are taken on an interval, on demand, and after the routines that
// already queried the server (so a shard count is never asked for twice).
const lastSampleByBot = new Map()
let timeseriesSampling = false

function recordTimeseriesSample (id, sample, source) {
  if (!settings.get('TIMESERIES_ENABLED')) return null
  const row = timeseries.botSample({
    bot: id,
    ...sample,
    // A ban is tracked in the data state; putting it on every sample is what
    // makes "banned bots over time" a chart instead of a guess.
    banned: Boolean(dataState.bots[id]?.banned),
    bannedKind: dataState.bots[id]?.banKind || null,
    source
  }, Date.now())
  timeseriesStore.append(row)
  lastSampleByBot.set(id, { ...row, bot: id })
  return row
}

function recordFleetSample (source) {
  if (!settings.get('TIMESERIES_ENABLED')) return null
  if (!lastSampleByBot.size) return null
  const row = timeseries.fleetSample([...lastSampleByBot.values()], Date.now(), source)
  timeseriesStore.append(row)
  return row
}

function persistTimeseriesSnapshot () {
  try {
    const snapshot = timeseriesStore.snapshot({ bucketMs: settings.get('ANALYTICS_BUCKET_MS') })
    fs.mkdirSync(path.dirname(TIMESERIES_SUMMARY_FILE), { recursive: true })
    fs.writeFileSync(TIMESERIES_SUMMARY_FILE, JSON.stringify(snapshot, null, 2))
  } catch (_) {}
}

async function sampleTimeseriesNow (opts = {}) {
  const source = opts.source || 'manual'
  if (!settings.get('TIMESERIES_ENABLED')) { logFor(SYSTEM_ID, '{yellow-fg}⚠ Time-series sampling is off (TIMESERIES_ENABLED).{/yellow-fg}'); return 0 }
  if (timeseriesSampling) { logFor(SYSTEM_ID, '{yellow-fg}⚠ A time-series sample is already running.{/yellow-fg}'); return 0 }
  timeseriesSampling = true
  try {
    const names = (opts.ids || Object.keys(bots)).filter(id => bots[id]?.bot?.entity)
    if (!names.length) { logFor(SYSTEM_ID, '{yellow-fg}⚠ No spawned bots to sample.{/yellow-fg}'); return 0 }
    logFor(SYSTEM_ID, `{cyan-fg}› Sampling ${names.length} bot(s) for the time series (${source})…{/cyan-fg}`)
    let sampled = 0
    let skipped = 0
    // Sequential on purpose: eleven bots hammering /shards /coins /bal at once
    // is exactly the burst the server rate-limits. Each bot is isolated as well:
    // a bot that is mid-reconnect would otherwise reject its balance queries and
    // throw away every other bot's samples with it, so a bad bot is skipped and
    // the rest are still recorded.
    for (const id of names) {
      if (!bots[id]?.bot?.entity) continue
      try {
        const [shards, coins, money] = await Promise.all([
          queryBalance(id, 'Shards', '/shards'),
          queryBalance(id, 'Coins', '/coins'),
          queryBalance(id, 'Balance', '/bal')
        ])
        const inv = inventorySlotUsage(bots[id].bot)
        recordTimeseriesSample(id, {
          shards,
          coins,
          balance: money,
          rank: dataState.bots[id]?.rank || undefined,
          invUsed: inv.used,
          invFree: inv.free,
          invTotal: inv.total
        }, source)
        sampled++
      } catch (err) {
        skipped++
        logFor(SYSTEM_ID, `{yellow-fg}⚠ Skipped ${sanitize(id)} in the time-series sample: ${sanitize(err.message)}{/yellow-fg}`)
      }
    }
    if (opts.ranks) {
      for (const id of names) {
        if (!bots[id]?.bot?.entity) continue
        try {
          const rank = await queryRank(id)
          if (rank) recordTimeseriesSample(id, { rank }, `${source}:rank`)
        } catch (err) {
          logFor(SYSTEM_ID, `{yellow-fg}⚠ Rank sample for ${sanitize(id)} failed: ${sanitize(err.message)}{/yellow-fg}`)
        }
      }
    }
    recordFleetSample(source)
    persistTimeseriesSnapshot()
    logFor(SYSTEM_ID, `{green-fg}✓ Time-series sample written (${sampled} bot(s)${skipped ? `, ${skipped} skipped` : ''} → ${TIMESERIES_FILE}){/green-fg}`)
    return sampled
  } catch (err) {
    logFor(SYSTEM_ID, `{red-fg}✗ Time-series sample failed: ${sanitize(err.message)}{/red-fg}`)
    return 0
  } finally {
    timeseriesSampling = false
  }
}

function startTimeseriesSampler () {
  if (!settings.get('TIMESERIES_ENABLED')) {
    logFor(SYSTEM_ID, '{cyan-fg}› Time-series sampling is off (TIMESERIES_ENABLED=false in the .ENV tab).{/cyan-fg}')
    return
  }
  const intervalMs = settings.get('TIMESERIES_INTERVAL_MS')
  const intervalTimer = setInterval(() => { sampleTimeseriesNow({ source: 'interval' }).catch(() => {}) }, intervalMs)
  if (intervalTimer.unref) intervalTimer.unref()
  const rankMs = settings.get('TIMESERIES_RANK_INTERVAL_MS')
  if (rankMs > 0) {
    const rankTimer = setInterval(() => { sampleTimeseriesNow({ source: 'rank-interval', ranks: true }).catch(() => {}) }, rankMs)
    if (rankTimer.unref) rankTimer.unref()
  }
  const startupDelay = settings.get('TIMESERIES_STARTUP_DELAY_MS')
  if (startupDelay > 0) {
    const firstTimer = setTimeout(() => { sampleTimeseriesNow({ source: 'startup', ranks: true }).catch(() => {}) }, startupDelay)
    if (firstTimer.unref) firstTimer.unref()
  }
  const rankText = rankMs > 0 ? ` · ranks every ${cfDuration(rankMs)}` : ' · rank sampling off'
  logFor(SYSTEM_ID, `{cyan-fg}› Time-series sampling every ${cfDuration(intervalMs)} → ${TIMESERIES_FILE}${rankText}{/cyan-fg}`)
}

// ── Analytics (read-only) ────────────────────────────────────────────────────
function buildAnalyticsReport (opts = {}) {
  const coinflipSummary = coinflipStore.summary({
    recent: opts.recent == null ? 25 : opts.recent,
    minSample: settings.get('COINFLIP_MIN_SAMPLE'),
    suspicionP: settings.get('COINFLIP_SUSPICION_P')
  })
  const tsSnapshot = timeseriesStore.snapshot({ bucketMs: settings.get('ANALYTICS_BUCKET_MS'), bot: opts.bot || null })
  return analytics.buildReport({
    coinflip: coinflipSummary,
    timeseries: tsSnapshot,
    deep: coinflipDeepReport({ bot: opts.bot || null }),
    config: {
      coinflipFile: COINFLIP_FILE,
      timeseriesFile: TIMESERIES_FILE,
      coinflipSummaryFile: COINFLIP_SUMMARY_FILE,
      coinflipDeepFile: COINFLIP_DEEP_FILE,
      timeseriesSummaryFile: TIMESERIES_SUMMARY_FILE,
      sampleIntervalMs: settings.get('TIMESERIES_INTERVAL_MS'),
      bucketMs: settings.get('ANALYTICS_BUCKET_MS'),
      minSample: settings.get('COINFLIP_MIN_SAMPLE')
    },
    generatedAt: Date.now()
  })
}

function sendJson (res, body, code = 200) {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function hostForLink () {
  return (process.env.ANALYTICS_HOST || process.env.WEB_HOST || '').trim() || 'localhost'
}

// The listening port, or null when the server has not bound yet (or is a stub).
function listeningPort () {
  try {
    return typeof analyticsServer?.address === 'function' ? (analyticsServer.address()?.port || null) : null
  } catch (_) { return null }
}

function analyticsSignInPage (port) {
  const host = escHtml(hostForLink())
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AFK Analytics — sign in</title>
<style>body{background:#0a0e13;color:#c7d2dc;font:14px ui-monospace,Menlo,Consolas,monospace;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#0f151d;border:1px solid #1d2836;border-radius:12px;padding:28px 32px;max-width:470px}
h1{font-size:15px;margin:0 0 8px;color:#e8f0f6}h1 b{color:#2dd4bf}p{color:#5b6b7a;font-size:12px;line-height:1.7;margin:8px 0}a{color:#67e8f9}code{background:#131b25;border:1px solid #1d2836;border-radius:4px;padding:0 5px}</style></head><body>
<div class="card"><h1>⛏ AFK <b>ANALYTICS</b></h1>
<p>This page is read-only, but it is still your data, so it needs the dashboard session.</p>
<p>1. Sign in at <a href="http://${host}/">the dashboard</a>.<br>2. Come back to <a href="http://${host}:${port}/">port ${port}</a> — the cookie is shared across ports on the same host.</p>
<p>Set <code>ANALYTICS_OPEN=true</code> in the .ENV tab to serve it with no login.</p></div></body></html>`
}

function handleAnalyticsRequest (req, res, url) {
  const p = url.pathname
  if (p === '/health') { res.writeHead(200); res.end('ok'); return }
  const authorised = settings.get('ANALYTICS_OPEN') || Boolean(webAuth && webAuth.sessionValid(webAuth.tokenFromReq(req, url)))
  if (!authorised) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(analyticsSignInPage(listeningPort() || settings.get('ANALYTICS_PORT')))
    return
  }
  if (p === '/' || p === '/index.html') {
    const html = analytics.renderHtml(buildAnalyticsReport())
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
    return
  }
  if (p === '/api/analytics') { sendJson(res, buildAnalyticsReport({ recent: 100 })); return }
  if (p === '/api/coinflip') {
    sendJson(res, coinflipStore.summary({
      recent: Math.max(1, Math.min(1000, Number(url.searchParams.get('recent')) || 50)),
      minSample: settings.get('COINFLIP_MIN_SAMPLE'),
      suspicionP: settings.get('COINFLIP_SUSPICION_P')
    }))
    return
  }
  if (p === '/api/coinflip/deep') {
    // The whole dissection, for whoever wants to re-run the statistics
    // elsewhere — the same object the page and /bot-coinflip deep use.
    sendJson(res, coinflipDeepReport({ bot: url.searchParams.get('bot') || null }))
    return
  }
  if (p === '/api/timeseries') {
    const metric = url.searchParams.get('metric') || 'shards'
    const bot = url.searchParams.get('bot') || null
    const bucketMs = analytics.parseBucket(url.searchParams.get('bucket'), settings.get('ANALYTICS_BUCKET_MS'))
    const since = Number(url.searchParams.get('since')) || 0
    sendJson(res, {
      metric,
      bot,
      bucketMs,
      since,
      points: timeseriesStore.bucket(metric, { bucketMs, since, bot, kind: bot ? 'bot' : 'fleet' }),
      summary: timeseriesStore.summarize(metric, { bot, since })
    })
    return
  }
  if (p === '/api/export') {
    // Everything at once, for whoever wants to do the analysis elsewhere.
    sendJson(res, { generatedAt: Date.now(), coinflips: coinflipStore.all(), timeseries: timeseriesStore.all() })
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found — try /, /api/analytics, /api/coinflip, /api/coinflip/deep, /api/timeseries?metric=shards&bucket=1h, /api/export')
}

// The dashboard's session check lives inside startWebGUI's closure, so the
// dashboard hands it out here for the separate analytics listener to use.
let webAuth = null
let analyticsServer = null
function startAnalyticsServer () {
  if (!settings.get('ANALYTICS_ENABLED')) return null
  const preferred = settings.get('ANALYTICS_PORT')
  analyticsServer = http.createServer((req, res) => {
    let url
    try { url = new URL(req.url, 'http://localhost') } catch (_) { res.writeHead(400); res.end(); return }
    try {
      handleAnalyticsRequest(req, res, url)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('analytics error: ' + err.message)
    }
  })
  analyticsServer.on('error', (err) => {
    logFor(SYSTEM_ID, `{yellow-fg}⚠ Analytics server could not listen on ${preferred}: ${sanitize(err.message)} — change ANALYTICS_PORT in the .ENV tab.{/yellow-fg}`)
  })
  analyticsServer.listen(preferred, WEB_BIND, () => {
    const port = listeningPort() || preferred
    const open = settings.get('ANALYTICS_OPEN')
    logFor(SYSTEM_ID, `{green-fg}✓ Analytics on http://${hostForLink()}:${port}/ (read-only${open ? ', unauthenticated' : ', dashboard sign-in required'}){/green-fg}`)
  })
  return analyticsServer
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

// -- Inventory slot usage ---------------------------------------------------
// Player storage = 27 main inventory slots (9-35) + 9 hotbar slots (36-44)
// = 36 slots. Armor (5-8), offhand (45), the crafting grid (1-4) and the
// result (0) are deliberately NOT counted, so "N free" only ever
// refers to real storage.
const INVENTORY_STORAGE_SLOTS = 36

// The same numbers for the spreadsheet: "how full is this bot" is what a filled
// inventory asks, and it is not derivable from anything else the sheet carries.
// Published only while the bot is actually spawned, so 0-of-36 and "no data yet"
// can never look alike.
function botInventoryColumns (bot) {
  const inv = inventorySlotUsage(bot)
  return inv.used === null ? {} : { invUsed: inv.used, invFree: inv.free, invTotal: inv.total }
}
function inventorySlotUsage (bot) {
  const slots = bot?.inventory?.slots
  if (!slots || typeof slots.length !== 'number') {
    return { used: null, total: INVENTORY_STORAGE_SLOTS, free: null }
  }
  let used = 0
  for (let slot = 9; slot <= 44; slot++) {
    if (slots[slot]) used++
  }
  return { used, total: INVENTORY_STORAGE_SLOTS, free: INVENTORY_STORAGE_SLOTS - used }
}

async function compileAndPushData (log = () => {}, onlyIds = null) {
  const names = onlyIds ? onlyIds.filter(id => Object.hasOwn(bots, id)) : Object.keys(bots)
  for (const name of names) {
    const entry = bots[name]
    if (!entry?.bot?.entity) continue
    const [shards, coins, money, rank] = await Promise.all([
      queryBalance(name, 'Shards', '/shards'),
      queryBalance(name, 'Coins', '/coins'),
      queryBalance(name, 'Balance', '/bal'),
      queryRank(name)
    ])
    // spawnerCount is owned by the /spawners pass (spawners found on the plot).
    // Overwriting it here with the local row count silently changed what that
    // column meant depending on which command ran last, so the number of spawner
    // rows being tracked gets its own column instead.
    dataStore.upsertBot(dataState, {
      bot: name,
      recordedAt: Date.now(),
      rank: rank || 'N/A',
      shards, coins, balance: money,
      ...dataStore.flattenPosition(botLocation(entry.bot)),
      ...botInventoryColumns(entry.bot),
      trackedSpawners: Object.values(dataState.spawners).filter(row => row.bot === name).length,
      // Survivors of a ban keep banned:true in the data state, so a bot that is
      // back online must publish an explicit false rather than a blank cell.
      banned: Boolean(dataState.bots[name]?.banned)
    })
    recordTimeseriesSample(name, { shards, coins, balance: money, rank: rank || undefined }, 'data')
  }
  recordFleetSample('data')
  persistData()
  const snapshot = dataStore.buildSnapshot(dataState)
  try {
    const result = await dataStore.pushWebhook(DATA_WEBHOOK_URL, snapshot, globalThis.fetch, {
      secret: DATA_WEBHOOK_SECRET,
      timeoutMs: DATA_WEBHOOK_TIMEOUT_MS
    })
    const written = result.response && result.response.written
    const writtenText = written ? ` — rows written: ${Object.keys(written).map(key => `${key} ${written[key]}`).join(', ')}` : ''
    log(result.pushed
      ? `Data snapshot pushed to Google Sheets webhook (${snapshot.bots.length} bot(s), ${snapshot.spawners.length} spawner(s)${writtenText}).`
      : `Data snapshot saved locally (${DATA_FILE}); no webhook configured.`)
    return snapshot
  } catch (err) {
    log(`Data snapshot saved locally, but Google Sheets push failed: ${err.message}`)
    return snapshot
  }
}

// Shows what /data will do without touching the network — the fastest way to
// confirm which webhook, secret, timeout, and local file are actually in use.
function logDataStatus (log = () => {}) {
  log('{bold}── /data status ──{/bold}')
  log(`webhook: ${DATA_WEBHOOK_URL || '(not set — snapshots stay local)'}`)
  if (DATA_WEBHOOK_URL) {
    // Only the /exec URL of a public web app accepts anonymous calls. The /dev
    // URL always demands a Google sign-in, and pasting it is a classic silent
    // failure — flag the shape before any network call is made.
    const wrongUrl = /\/exec(?:[?#]|$)/.test(DATA_WEBHOOK_URL)
      ? null
      : /\/dev(?:[?#]|$)/.test(DATA_WEBHOOK_URL)
        ? 'this is the /dev URL, which ALWAYS requires a Google sign-in — use Deploy → Manage deployments → the /exec "Web app" URL instead'
        : 'this URL does not end in /exec — copy the "Web app" URL from Apps Script → Deploy → Manage deployments'
    if (wrongUrl) log(`{yellow-fg}⚠ ${wrongUrl}{/yellow-fg}`)
  }
  log(`secret: ${DATA_WEBHOOK_SECRET ? `set (${DATA_WEBHOOK_SECRET.length} chars)` : 'not set'} · timeout: ${DATA_WEBHOOK_TIMEOUT_MS}ms`)
  log(`local file: ${DATA_FILE}`)
  log(`tracked: ${Object.keys(dataState.bots).length} bot(s) and ${Object.keys(dataState.spawners).length} spawner(s) · connected now: ${Object.keys(bots).length} bot(s)`)
  if (DATA_FILE && !fs.existsSync(DATA_FILE)) log('note: the local snapshot file does not exist yet — run /data once to create it.')
}

// Verifies the Apps Script webhook without pushing a snapshot: GETs the /exec
// URL, which Code.gs answers with a JSON health document (doGet). This is what
// tells apart a private deployment (HTML sign-in page served with HTTP 200), a
// missing SPREADSHEET_ID script property, and a genuinely healthy endpoint —
// all three used to look like a successful push against a stale spreadsheet.
async function checkDataWebhook (log = {}) {
  const info = typeof log.info === 'function' ? log.info : () => {}
  const warn = typeof log.warn === 'function' ? log.warn : () => {}
  const error = typeof log.error === 'function' ? log.error : () => {}
  const success = typeof log.success === 'function' ? log.success : info

  if (!DATA_WEBHOOK_URL) {
    warn('DATA_WEBHOOK_URL is not set, so /data only saves locally. Paste the Apps Script /exec URL into .env as DATA_WEBHOOK_URL and restart.')
    return false
  }
  if (typeof globalThis.fetch !== 'function') { error('global fetch is unavailable in this Node build.'); return false }
  info('Checking the webhook with a GET request (this does not write to the sheet)…')

  const options = { method: 'GET', redirect: 'follow' }
  if (DATA_WEBHOOK_TIMEOUT_MS > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') options.signal = AbortSignal.timeout(DATA_WEBHOOK_TIMEOUT_MS)

  let response
  try {
    response = await globalThis.fetch(DATA_WEBHOOK_URL, options)
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
    error(timedOut
      ? `No answer within ${DATA_WEBHOOK_TIMEOUT_MS}ms — check DATA_WEBHOOK_URL and that the deployment is live (raise DATA_WEBHOOK_TIMEOUT_MS if Google is slow).`
      : `Could not reach the webhook: ${sanitize(err && err.message ? err.message : String(err))}`)
    return false
  }

  let text = ''
  try { text = await response.text() } catch (_) {}
  const body = String(text || '').trim()

  if (body.startsWith('<')) {
    // The HTML itself names the fault (sign-in page vs. a missing doGet vs. a
    // thrown exception), so report what the page actually says instead of
    // assuming the deployment is private — that guess sent users chasing the
    // wrong fix while the real problem was a stale deployed version.
    const verdict = dataStore.diagnoseWebhookBody(body, { url: DATA_WEBHOOK_URL, status: response.status, method: 'GET' })
    error(`${verdict.message}\n  diagnosis: ${verdict.kind}`)
    return false
  }
  let health = null
  try { health = JSON.parse(body) } catch (_) {
    error(`The webhook answered with non-JSON content (HTTP ${response.status}): ${sanitize(body.slice(0, 200)) || '(empty body)'}`)
    return false
  }
  if (!health || health.service !== 'openmontage-data') {
    warn(`Reached the URL (HTTP ${response.status}) but the response is not the OpenMontage doGet health document (service: ${health && health.service ? health.service : 'unset'}). Paste the updated google-apps-script/Code.gs, then Deploy → Manage deployments → Version: New version.`)
    return false
  }

  info(`HTTP ${response.status} · spreadsheet: ${health.spreadsheetId || '(unset)'} · version: ${health.version || '?'}`)
  info(`sheets: ${(health.sheets || []).join(', ') || '(none yet)'} · secret required: ${health.secretRequired ? 'yes' : 'no'} · history tab: ${health.historySheet || 'off'}`)

  let ok = true
  if (!health.ok) {
    error(health.spreadsheetError
      ? `Spreadsheet problem: ${sanitize(health.spreadsheetError)}`
      : 'The endpoint reports ok:false — run setSpreadsheetId with the spreadsheet id once in the Apps Script editor (or fill SPREADSHEET_ID_OVERRIDE), then redeploy a new version.')
    ok = false
  }
  if (health.secretRequired && !DATA_WEBHOOK_SECRET) {
    warn('The webhook requires a secret but DATA_WEBHOOK_SECRET is empty in .env — every push will be rejected. Add the value you passed to setWebhookSecret in Apps Script.')
    ok = false
  }
  if (!health.secretRequired && DATA_WEBHOOK_SECRET) {
    warn('DATA_WEBHOOK_SECRET is set but the webhook does not require one — run setWebhookSecret in Apps Script with the same value to enforce it.')
    ok = false
  }
  if (ok) success('Webhook looks healthy: the deployment is public, Code.gs is current, and the spreadsheet opened successfully.')
  return ok
}

// ── Command router (real tail + context routing prologue for the web GUI) ────
function executeCommandChain(chain, ctx, overrides = {}) {
  return executeCommandChainBase(chain, ctx, {
    executeSingle: (cmd, c) => handleSingleCommand(cmd, c, { isChained: true }),
    ...overrides
  })
}

function handleCommand(raw, ctx) {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return

  // /cron add keeps everything after the schedule as the job command, so `&&`
  // and `;` inside it must reach the cron handler intact instead of being split
  // into a command chain here (cron commands support chaining, e.g. `@Bot /data
  // && sleep 5s && /dump`).
  if (/^\/cron\s+add(?:\s|$)/i.test(trimmed)) return handleSingleCommand(trimmed, ctx)

  const chain = parseCommandChain(trimmed)
  if (chain.length === 0) return

  // If chaining operators exist, or sleep command, or escaped operators:
  if (chain.length > 1 || /^sleep(?:\s|$)/i.test(chain[0].command) || chain[0].command !== trimmed) {
    const requestedId = ctx && ctx.selectedId
    const activeId = requestedId || currentActiveId()
    logFor(activeId || SYSTEM_ID, `{bold}{green-fg}❯ ${sanitize(trimmed)}{/green-fg}{/bold}`)

    return executeCommandChain(chain, ctx)
  }

  return handleSingleCommand(trimmed, ctx)
}

function handleSingleCommand(raw, ctx, options = {}) {
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
if (!options.isChained) {
log(`{bold}{green-fg}❯ ${sanitize(trimmed)}{/green-fg}{/bold}`)
}

// ── /find ───────────────────────────────────
const findMatch = trimmed.match(/^\/find(?:\s+([\s\S]*))?$/)
if (findMatch) {
  const term = (findMatch[1] || '').trim()
  if (!term) { logWarn('Usage: /find <name> — search every bot\'s inventory and open window by display, custom, or registry name'); return }
  const needle = term.toLowerCase()
  let foundTotal = 0
  let scanned = 0
  const botNames = Object.keys(bots)
  for (const name of botNames) {
    const entry = bots[name]
    if (!entry?.bot?.entity) { log(`{gray-fg}[${name}] offline — skipped{/gray-fg}`); continue }
    scanned++
    const bot = entry.bot
    const hits = []
    const seen = new Set()
    const consider = (item, where) => {
      if (!item) return
      const display = itemDisplayName(item)
      const alt = itemAltName(item, display)
      const custom = itemCustomName(item)
      const candidates = [display, alt, custom, item.name].filter(Boolean)
      if (!candidates.some(n => n.toLowerCase().includes(needle))) return
      const sig = `${item.type || item.name}:${item.slot}`
      if (seen.has(sig)) return
      seen.add(sig)
      hits.push({ count: item.count || 1, slot: item.slot, display, alt, where })
    }
    try {
      if (bot.inventory && typeof bot.inventory.items === 'function') {
        bot.inventory.items().forEach(it => consider(it, 'inv'))
      }
      if (bot.currentWindow && bot.currentWindow.slots) {
        for (const it of Object.values(bot.currentWindow.slots)) consider(it, 'window')
      }
    } catch (err) {
      logWarn(`${name}: inventory scan failed: ${sanitize(err.message)}`)
    }
    if (hits.length === 0) continue
    foundTotal += hits.reduce((sum, h) => sum + h.count, 0)
    log(`{cyan-fg}[${name}]{/cyan-fg} — ${hits.length} matching stack(s)`)
    hits.forEach(h => {
      const shown = h.display || h.alt || 'item'
      const altLine = h.alt && h.alt !== shown ? ` (${sanitize(h.alt)})` : ''
      log(`  ${h.count}x ${sanitize(shown)}${altLine} — ${h.where} slot ${h.slot}`)
    })
  }
  if (foundTotal === 0) logInfo(`No bot has an item matching "${sanitize(term)}" (${scanned} scanned, ${botNames.length - scanned} offline).`)
  else logSuccess(`Found ${foundTotal} matching item(s) across ${botNames.length} bot(s).`)
  return
}

// ── /cron ───────────────────────────────────
if (trimmed === '/cron' || trimmed.startsWith('/cron ')) {
  const parts = trimmed.slice('/cron'.length).trim().split(/\s+/)
  const sub = (parts[0] || '').toLowerCase()
  if (!sub) {
    const jobs = cronManager.list()
    if (jobs.length === 0) { logInfo('No cron jobs configured. Add them in .env as CRON_JOB_1="<schedule>|<command>" or use /cron add.'); return }
    logInfo('{bold}── Cron jobs ──{/bold}')
    jobs.forEach(job => {
      const state = job.enabled ? (job.running ? '{yellow-fg}● running{/yellow-fg}' : '{green-fg}● on{/green-fg}') : '{red-fg}○ off{/red-fg}'
      const next = job.nextRun ? job.nextRun.toLocaleString() : '—'
      const last = job.lastRun ? job.lastRun.toLocaleString() : 'never'
      log(` [{bold}${job.id}{/bold}] ${state} — ${job.schedule} — ${job.command} (runs: ${job.runs}, last: ${last}, next: ${next})`)
    })
    logInfo(`Usage: /cron add <schedule> <command> · /cron rm <id> · /cron on|off <id> · /cron run <id> — jobs ${CRON_STATE_FILE ? 'are saved to ' + CRON_STATE_FILE : 'live in memory only (CRON_PERSIST=false)'}`)
    return
  }
  if (sub === 'add') {
    // The schedule is a quoted token or the next 5 fields (@every is two);
    // everything after it is the job command. A bot target may sit on either
    // side of the schedule:
    //   /cron add @BotA @every 300 /spawners
    //   /cron add @every 300 @BotA /spawners
    const rest = trimmed.replace(/^\/cron\s+add\b/i, '')
    let parsed
    try {
      parsed = parseCronAddArgs(rest)
    } catch (err) {
      logWarn(`Usage: /cron add <schedule> <command> — schedule = 5-field cron ("0 4 * * *") or "@every <seconds>"; command = anything /all would run, optionally prefixed with @BotName{,BotName} to target specific bots. (${err.message})`)
      return
    }
    try {
      const job = cronManager.add(parsed.schedule, parsed.command)
      logSuccess(`Cron job ${job.id} added: "${job.schedule}" → ${job.command} (next run ${job.nextRun ? job.nextRun.toLocaleString() : '—'})`)
      if (!CRON_ENABLED) logWarn(`CRON_ENABLED is off — job ${job.id} is stored but will not fire until cron is turned back on; /cron run ${job.id} fires it once right now.`)
      // Report unknown targets at add time instead of only when the job skips.
      const targets = parseBotTargetCommand(parsed.command)
      if (targets.botIds) {
        const { unknown, roster } = resolveCronTargets(targets.botIds)
        if (unknown.length) {
          logWarn(`Cron job ${job.id} targets ${describeUnknownTargets(unknown, roster)}, which ${unknown.length === 1 ? 'is not a bot' : 'are not bots'} in this roster. Known bots: ${roster.join(', ') || 'none'}`)
        } else {
          logInfo(`Cron job ${job.id} will run on: ${targets.botIds.join(', ')}`)
        }
      }
    } catch (err) {
      logError(`Could not add cron job: ${err.message}`)
    }
    return
  }

  if (sub === 'rm' || sub === 'remove') {
    const id = parts[1]
    if (!id) { logWarn('Usage: /cron rm <id>'); return }
    if (cronManager.remove(id)) logSuccess(`Removed cron job ${id}.`)
    else logWarn(`No cron job with id ${id}.`)
    return
  }
  if (sub === 'on' || sub === 'off') {
    const id = parts[1]
    if (!id) { logWarn(`Usage: /cron ${sub} <id>`); return }
    if (cronManager.setEnabled(id, sub === 'on')) logSuccess(`Cron job ${id} ${sub === 'on' ? 'enabled' : 'disabled'}.`)
    else logWarn(`No cron job with id ${id}.`)
    return
  }
  if (sub === 'run') {
    const id = parts[1]
    if (!id) { logWarn('Usage: /cron run <id>'); return }
    const result = cronManager.runNow(id)
    if (result.ok) {
      const job = cronManager.list().find(j => j.id === id)
      logSuccess(`Triggered cron job ${id}${job ? ': ' + job.command : ''}.`)
    } else {
      logWarn(`Could not run cron job ${id}: ${result.error}`)
    }
    return
  }
  logWarn(`Unknown /cron subcommand "${sub}". Try: add, rm, on, off, run — or /cron alone to list.`)
  return
}

// ── /all-slow-cancel [id] ────────────────────
const cancelSlowMatch = trimmed.match(/^\/all-slow-cancel(?:\s+([\s\S]*))?$/)
if (cancelSlowMatch) {
  const target = (cancelSlowMatch[1] || '').trim()
  if (target) {
    const parsedId = parseInt(target.replace(/^#/, ''), 10)
    if (isNaN(parsedId)) {
      logWarn(`Usage: /all-slow-cancel [id] — "${sanitize(target)}" is not a valid task ID.`)
      return
    }
    if (slowBroadcast.cancel(parsedId)) {
      logSuccess(`Cancelled /all-slow [Task #${parsedId}].`)
    } else {
      logWarn(`No active /all-slow task with ID #${parsedId}.`)
    }
  } else {
    const count = slowBroadcast.cancelAll()
    if (count > 0) {
      logSuccess(`Cancelled all running /all-slow tasks (${count} task(s)).`)
    } else {
      logWarn('No active /all-slow tasks to cancel.')
    }
  }
  return
}

// ── /all and /all-slow ───────────────────────
const broadcastMatch = trimmed.match(/^\/(all|all-slow)(?:\s+([\s\S]*))?$/)
if (broadcastMatch) {
const command = '/' + broadcastMatch[1]
const msg = (broadcastMatch[2] || '').trim()
if (!msg) { logWarn(`Usage: ${command} <command or message>`); return }
const isLocal = LOCAL_COMMANDS.includes(msg.split(/\s+/)[0])
const ids = Object.keys(bots)
const dispatch = id => dispatchCommandToBot(msg, id)
if (command === '/all-slow') {
// An optional leading delay overrides ALL_SLOW_DELAY_MS for this run:
//   /all-slow 30 /spawners    → 30s apart
//   /all-slow 500ms /status   → half a second
// parseSleepDuration gives it exactly the units `sleep` uses, so 30 means 30s and
// 5000 means 5000ms. The token is only taken as a delay when it is a bare number
// or duration.
let delayMs = settings.get('ALL_SLOW_DELAY_MS')
let body = msg
const splitAt = msg.search(/\s/)
const firstToken = splitAt === -1 ? msg : msg.slice(0, splitAt)
const requested = /^\d+(?:\.\d+)?(?:ms|s)?$/i.test(firstToken) ? parseSleepDuration(firstToken) : null
if (requested !== null) {
if (splitAt === -1) { logWarn('Usage: /all-slow [delay] <command> — a delay needs a command after it'); return }
body = msg.slice(splitAt + 1).trim()
if (!body) { logWarn('Usage: /all-slow [delay] <command>'); return }
// Below a quarter second the dispatches overlap and the point is lost.
delayMs = Math.max(250, requested)
}
const slowDispatch = id => dispatchCommandToBot(body, id)
const taskId = slowBroadcast.start(ids, delayMs, slowDispatch, {
command: body,
onError: (err, id) => logWarn(`[Task #${taskId}] ${id}: ${sanitize(err.message)}`),
onDone: ({ sent, skipped }) => logSuccess(`[Task #${taskId}] Slow broadcast finished: ${sent} dispatched, ${skipped} skipped/failed.`)
})
const apart = delayMs % 1000 === 0 ? `${delayMs / 1000}s` : `${(delayMs / 1000).toFixed(1)}s`
logInfo(`[Task #${taskId}] Slow broadcast to ${ids.length} bot(s), ${apart} apart: ${sanitize(body)}`)
} else {
const onError = (err, id) => logWarn(`${id}: ${sanitize(err.message)}`)
let sent = 0
for (const id of ids) {
try { if (dispatch(id)) sent++ } catch (err) { onError(err, id) }
}
logSuccess(`${isLocal ? 'Ran locally on' : 'Broadcasted to'} ${sent} bots.`)
}
return
}

// ── /data [check|status] ─────────────────────
if (trimmed === '/data' || trimmed.startsWith('/data ')) {
  const dataArgs = parseDataArgs(trimmed.slice('/data'.length))
  if (dataArgs.unknown) {
    logWarn(`Unknown /data option ${sanitize(dataArgs.unknown)} — pushing a snapshot instead. Options: /data check (verify the webhook), /data status (show webhook config + tracked counts)`)
  }
  if (dataArgs.action === 'check') {
    checkDataWebhook({ info: message => logInfo(message), warn: message => logWarn(message), error: message => logError(message), success: message => logSuccess(message) })
      .catch(err => logError(`Webhook check failed: ${sanitize(err.message)}`))
    return
  }
  if (dataArgs.action === 'status') {
    logDataStatus(message => logInfo(message))
    return
  }
  logInfo('Compiling saved bot, spawner, production, location, and inventory data…')
  compileAndPushData(message => logInfo(message)).catch(err => logError(`Data compilation failed: ${sanitize(err.message)}`))
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
recordTimeseriesSample(name, { shards, coins, balance: money, rank: rank || undefined }, 'overview')
const b = bots[name]
if (b?.bot?.entity) {
const hp = Math.round(b.bot.health || 0)
const food = Math.round(b.bot.food || 0)
const ping = b.bot.player?.ping ?? '?'
const sh = shards !== null ? shards.toLocaleString() : 'N/A'
const co = coins !== null ? coins.toLocaleString() : 'N/A'
const mo = money !== null ? `$${money.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/A'
const rk = rank || 'N/A'
const inv = inventorySlotUsage(b.bot)
const invTxt = inv.used === null ? '?' : `${inv.used}/${inv.total} used, ${inv.free} free`
log(`[${idx + 1}] {cyan-fg}${name}{/cyan-fg} : {green-fg}Online{/green-fg} | HP: ${hp} | Food: ${food} | Ping: ${ping}ms | Rank: ${rk} | Shards: ${sh} | Coins: ${co} | Balance: ${mo} | Inv: ${invTxt}`)
} else {
log(`[${idx + 1}] {cyan-fg}${name}{/cyan-fg} : {gray-fg}Offline / Connecting…{/gray-fg}`)
}
})
}).catch(err => logError(`Overview failed: ${sanitize(err.message)}`))
recordFleetSample('overview')
return
}

// ── /auth-retry ─────────────────────────────
if (trimmed === '/auth-retry' || trimmed.startsWith('/auth-retry ')) {
const target = trimmed.slice('/auth-retry'.length).trim() || activeId
if (!target) { logWarn('Usage: /auth-retry <bot name> — or select a bot first'); return }
if (!bots[target]) { logWarn(`No bot named "${sanitize(target)}".`); return }
const had = authState.get(target)?.failure
if (had) logSuccess(`${target}: cleared ${had.kind} (${sanitize(had.reason)}) — reconnecting so it can log in again. If it fails again the password is still wrong.`)
else logInfo(`${target} has no recorded auth failure — reconnecting anyway.`)
authState.delete(target)
const { host, port, version } = bots[target]
try { bots[target].disconnectManually() } catch (_) {}
setTimeout(() => createBotInstance(target, host, port, version), 1000)
notifyBotsChanged()
return
}

// ── /removed and /unban ─────────────────────
if (trimmed === '/removed') {
const entries = removedBots.bots || []
if (!entries.length) { logInfo('Nothing on the removed list — no bot has been permanently banned or removed.'); return }
logInfo(`{bold}── Removed / permanently banned (${entries.length}) ──{/bold}`)
entries.forEach((entry, idx) => log(` [${idx + 1}] {red-fg}${sanitize(entry.bot)}{/red-fg} — ${sanitize(removedBotsStore.describeRemovedBot(entry))}${entry.addedAt ? ` · added ${new Date(entry.addedAt).toLocaleString()}` : ''}`))
logInfo(`File: ${REMOVED_BOTS_FILE} · /unban <bot> puts one back`)
return
}

if (trimmed === '/unban' || trimmed.startsWith('/unban ')) {
const target = trimmed.slice('/unban'.length).trim()
if (!target) { logWarn('Usage: /unban <bot name> — /removed lists them'); return }
const restored = removedBotsStore.removeRemovedBot(removedBots, target)
if (!restored) { logWarn(`"${sanitize(target)}" is not on the removed list. Run /removed to see it.`); return }
persistRemovedBots()
// Clear the hold as well, or the next reconnect would just be held again.
dataStore.upsertBot(dataState, { bot: restored.bot, banned: false, bannedAt: null, banKind: null, banReason: null, banExpiresAt: 0 })
persistData()
logSuccess(`${restored.bot} is off the removed list — reconnecting. Put it back in BOT_NAMES if you had removed it.`)
const { host, port, version } = bots[restored.bot] || { host: HOST, port: PORT, version: VERSION }
try { bots[restored.bot]?.disconnectManually() } catch (_) {}
setTimeout(() => createBotInstance(restored.bot, host, port, version), 1000)
notifyBotsChanged()
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
const ban = dataState.bots[name]?.banned ? ` {red-fg}⛔ banned${dataState.bots[name].banKind ? ' (' + sanitize(dataState.bots[name].banKind) + ')' : ''}{/red-fg}` : ''
const authFail = authState.get(name)?.failure ? ` {red-fg}🔑 auth ${sanitize(authState.get(name).failure.kind)}{/red-fg}` : ''
const kick = b?.lastKickReason ? ` — last kick: ${sanitize(b.lastKickReason).slice(0, 60)}` : ''
log(` [${idx + 1}] {cyan-fg}${name}{/cyan-fg} {red-fg}○ Offline{/red-fg}${ban}${authFail}${kick}`)
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
PROXY_GROUPS.forEach(g => {
// Say where this group's credentials come from without ever printing them.
// Credentials belong to the proxy TARGET, not to the bot: a group that sets
// none sends none, even when the global PROXY_USER/PROXY_PASS is configured.
// Inheriting would hand the global password to a different proxy operator.
const auth = hasProxyAuth(g) ? ` · proxy auth: PROXY_GROUP_${g.index}_USER/_PASS` : (g.host ? ' · proxy auth: none' : '')
const login = g.loginPassword ? ` · login: PROXY_GROUP_${g.index}_LOGIN_PASSWORD` : ''
const target = g.host ? describeProxy(g) : 'no dedicated proxy (uses the default connection)'
logInfo(`  [${g.index}] ${g.bots.join(', ')} → ${target}${auth}${login}`)
})
logInfo(PROXY_DEFAULT ? `  (other bots) → ${describeProxy(PROXY_DEFAULT)}` : '  (other bots) → direct connection')
}
if (PROXY_ENABLED) {
logInfo(`{bold}Outbound proxy:{/bold} ${describeProxy(PROXY_DEFAULT)}${hasProxyAuth(PROXY_DEFAULT) ? ' (authenticated)' : ' (no credentials set)'} (applies to all bots without a dedicated group; these credentials are never shared with a group)`)
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
return runCrateRoutine(activeId, blockName)
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
return runCrateLoop(activeId, count, blockName)
}

// ── /shardshop-loop [slot] ───
if (trimmed === '/shardshop-loop' || trimmed.startsWith('/shardshop-loop ')) {
if (!activeId) { logWarn('No active bot.'); return }
const parts = trimmed.slice('/shardshop-loop'.length).trim().split(/\s+/).filter(Boolean)
let slot = null
if (parts.length > 0) {
const parsed = parseInt(parts[0], 10)
if (isNaN(parsed) || parsed < 0 || parsed > 53 || String(parsed) !== parts[0]) {
logWarn(`Invalid slot "${sanitize(parts[0])}". Must be an integer between 0 and 53.`)
return
}
slot = parsed
}
const entry = bots[activeId]
if (!entry?.bot?.entity) { logWarn(`${activeId} is not currently spawned.`); return }
return shardshopLoopCommand(activeId, slot)
}

// ── /crates-all [n] [color] [dump=…] [afk=…] ───
if (trimmed === '/crates-all' || trimmed.startsWith('/crates-all ')) {
const parts = trimmed.slice('/crates-all'.length).trim().split(/\s+/).filter(Boolean)
let maxBots = Infinity
if (parts.length && /^\d+$/.test(parts[0])) maxBots = parseInt(parts.shift(), 10)
if (maxBots <= 0) { logWarn(`Usage: ${CRATES_ALL_USAGE} — n must be a positive number`); return }
let blockName
// Only a token without `=` can be the colour, so `/crates-all afk=now` works
// without a position for it.
if (parts.length && !parts[0].includes('=')) {
blockName = resolveCrateBlockName(parts.shift())
if (!blockName) { logWarn(`Unknown crate color. Try one of: ${SHULKER_COLORS.join(', ')} — or a full block name like "purple_shulker_box".`); return }
}
const flags = parseCratesAllFlags(parts)
if (flags.unknown.length) { logWarn(`Unknown option "${sanitize(flags.unknown[0])}". Usage: ${CRATES_ALL_USAGE}`); return }
return runCratesAll(maxBots, blockName, cratesAllPlan(flags))
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
if (parts.length && !parts[0].includes('=')) {
blockName = resolveCrateBlockName(parts.shift())
if (!blockName) { logWarn(`Unknown crate color. Try one of: ${SHULKER_COLORS.join(', ')} — or a full block name like "purple_shulker_box".`); return }
}
const flags = parseCratesAllFlags(parts)
if (flags.unknown.length) { logWarn(`Unknown option "${sanitize(flags.unknown[0])}". Usage: ${CRATES_ALL_SOLO_USAGE}`); return }

if (!targetId) { logWarn(`No active bot. Usage: ${CRATES_ALL_SOLO_USAGE}`); return }
if (!bots[targetId]) { logWarn(`No bot named "${sanitize(targetId)}".`); return }

const plan = cratesAllPlan(flags)
logInfo(`Starting /crates-solo (shardshop → crates → dump) for ${targetId}${blockName ? ` targeting ${blockName.replace(/_/g, ' ')}` : ''} — ${describeCratesAllPlan(plan)}…`)
return runCratesAllSequenceForBot(targetId, blockName, plan)
}

// ── /bot-coinflip-all: concurrency-pooled fleet engine ─────────────────────
// Runs coinflips across the fleet with a concurrency pool: at most
// MAX_CONCURRENT bots are active at once. When one finishes, another random
// bot is selected from the queue automatically. This prevents server
// rate-limiting from a burst of simultaneous creates while keeping the fleet
// busy. Uses Fisher-Yates shuffle for random selection.
if (trimmed === '/bot-coinflip-all' || trimmed.startsWith('/bot-coinflip-all ')) {
  const parts = trimmed.slice('/bot-coinflip-all'.length).trim().split(/\s+/).filter(Boolean)
  const sub = parts[0] || 'help'
  
  if (sub === 'help' || sub === '') {
    const summary = coinflipStore.summary({ recent: 0, minSample: settings.get('COINFLIP_MIN_SAMPLE'), suspicionP: settings.get('COINFLIP_SUSPICION_P') })
    const stats = summary.stats
    logInfo('{bold}── /bot-coinflip-all ──{/bold}')
    log(` running: ${coinflipAllPool.running} · active: ${coinflipAllPool.active.size} · queued: ${coinflipAllPool.queue.length} · completed: ${coinflipAllPool.completed}/${coinflipAllPool.total}`)
    log('')
    log(`{cyan-fg}/bot-coinflip-all run [PRICE] [AMOUNT] [MAX_CONCURRENT]{/cyan-fg} {gray-fg}— run coinflips across the fleet with a concurrency pool. Randomly selects MAX_CONCURRENT bots (default 5), each playing AMOUNT flips (default ${settings.get('COINFLIP_DEFAULT_FLIPS')}). When a bot finishes, another random bot is selected from the queue automatically. PRICE is fixed (500000) or a range (10k-1m).{/gray-fg}`)
    log(`{cyan-fg}/bot-coinflip-all stop{/cyan-fg} {gray-fg}— stop the current /bot-coinflip-all run after the active flips finish.{/gray-fg}`)
    log('')
    log(` {gray-fg}/all-slow /bot-coinflip-all run 10k-1m 5000 5 runs it across every bot with 5 concurrent{/gray-fg}`)
    return
  }
  
  if (sub === 'stop') {
    if (!coinflipAllPool.running) { logWarn('/bot-coinflip-all is not running.'); return }
    return stopCoinflipAll()
  }
  
  if (sub === 'run') {
    const rest = parts.slice(1)
    const parsed = coinflip.parseCoinflipRunArgs(rest)
    if (parsed.errors.length) { logWarn(`Unknown option "${sanitize(parsed.errors[0])}". Usage: ${COINFLIP_ALL_USAGE}`); return }
    const wagerSpec = parsed.wager || coinflip.parseWagerSpec('', { min: settings.get('COINFLIP_WAGER_MIN'), max: settings.get('COINFLIP_WAGER_MAX') })
    const flips = parsed.flips || settings.get('COINFLIP_DEFAULT_FLIPS')
    const maxConcurrent = Math.max(1, Math.min(rest.length > 0 && /^\d+$/.test(rest[rest.length - 1]) ? parseInt(rest.pop(), 10) : 5, 30))
    
    const ids = Object.keys(bots).filter(id => bots[id]?.bot?.entity)
    if (!ids.length) { logWarn('No spawned bots to run /bot-coinflip-all on.'); return }
    if (coinflipAllPool.running) { logWarn('/bot-coinflip-all is already running. Use /bot-coinflip-all stop first.'); return }
    
    return runCoinflipAll(ids, { flips, wagerSpec, maxConcurrent })
  }
  
  logWarn(`Unknown /bot-coinflip-all subcommand "${sanitize(sub)}" — try /bot-coinflip-all for the list.`)
  return
}

// ── /bot-coinflip, /timeseries, /analytics, /env ─────────────────────────────
// ── /bot-coinflip — one command for the whole suite ─────────────────────────
// `/bot-coinflip run|stats|deep|history|export|help` is handled here, and nothing
// else. `/coinflip` is a SERVER command — the game's own coinflip — so this
// console never intercepts that name: a bare /coinflip, /coinflip create 10k and
// /coinflip delete all fall through to the selected bot like any other chat.
const COINFLIP_SUBCOMMANDS = ['run', 'stats', 'deep', 'history', 'export', 'help']
const coinflipCall = (() => {
  const match = trimmed.match(/^\/bot-coinflip(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const rest = (match[1] || '').trim()
  if (!rest) return { sub: 'help', args: '' }
  const word = rest.split(/\s+/)[0].toLowerCase()
  if (COINFLIP_SUBCOMMANDS.includes(word)) return { sub: word, args: rest.slice(word.length).trim() }
  return { sub: 'unknown', args: rest }
})()
function textSpark (values) {
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
  const numbers = values.filter(v => typeof v === 'number' && Number.isFinite(v))
  if (numbers.length < 2) return '(not enough points to draw)'
  const min = Math.min(...numbers)
  const max = Math.max(...numbers)
  const span = max - min || 1
  return numbers.map(v => blocks[Math.max(0, Math.min(7, Math.round(((v - min) / span) * 7)))]).join('')
}

if (coinflipCall && coinflipCall.sub === 'run') {
  const parsed = coinflip.parseCoinflipRunArgs(coinflipCall.args.split(/\s+/).filter(Boolean))
  if (parsed.errors.length) { logWarn(`Unknown option "${sanitize(parsed.errors[0])}". Usage: ${COINFLIP_USAGE}`); return }
  const wagerSpec = parsed.wager || coinflip.parseWagerSpec('', { min: settings.get('COINFLIP_WAGER_MIN'), max: settings.get('COINFLIP_WAGER_MAX') })
  const flips = parsed.flips || settings.get('COINFLIP_DEFAULT_FLIPS')
  let target = parsed.bot || null
  if (target) {
    const match = bots[target] ? target : matchBotName(target, Object.keys(bots))
    if (!match) { logWarn(`No bot named "${sanitize(target)}". Known bots: ${Object.keys(bots).join(', ') || 'none'}`); return }
    target = match
  }
  // A per-bot dispatch (e.g. `/all-slow /bot-coinflip run …`) arrives with that
  // bot selected and no BOT argument — it must act on that bot, not on all of them.
  if (!target && !parsed.all && activeId) target = activeId
  if (target) return runCoinflipForBot(target, { flips, wagerSpec })
  const ids = Object.keys(bots).filter(id => bots[id]?.bot?.entity)
  if (!ids.length) { logWarn('No spawned bots to run /bot-coinflip run on.'); return }
  return runCoinflipAcrossBots(ids, { flips, wagerSpec })
}

if (coinflipCall && coinflipCall.sub === 'stats') {
  const wanted = coinflipCall.args
  let rows = coinflipStore.all()
  let label = 'the whole fleet'
  if (wanted) {
    const match = bots[wanted] ? wanted : (matchBotName(wanted, Object.keys(bots)) || wanted)
    rows = rows.filter(row => row.bot === match)
    label = match
  }
  if (!rows.length) { logInfo(`No coinflip history for ${sanitize(label)} yet — run /bot-coinflip run${wanted ? ` ${sanitize(wanted)}` : ''}.`); return }
  const stats = coinflip.computeStats(rows)
  const fairness = coinflip.analyzeFairness(rows, { minSample: settings.get('COINFLIP_MIN_SAMPLE'), suspicionP: settings.get('COINFLIP_SUSPICION_P') })
  const verdictColour = fairness.verdict === 'suspicious' ? 'red-fg' : fairness.verdict === 'watch' ? 'yellow-fg' : fairness.verdict === 'within-noise' ? 'green-fg' : 'gray-fg'
  logInfo(`{bold}── Coinflip statistics (${sanitize(label)}) ──{/bold}`)
  log(` flips: ${stats.resolved} resolved (${stats.wins}W/${stats.losses}L)${stats.unresolved ? `, ${stats.unresolved} unresolved` : ''}`)
  log(` win rate: ${stats.winRate == null ? 'N/A' : `${(stats.winRate * 100).toFixed(2)}%`} · 95% CI ${(fairness.ci.low * 100).toFixed(1)}–${(fairness.ci.high * 100).toFixed(1)}% (a fair coin is 50%)`)
  log(` net: ${cfMoney(stats.net)} on ${cfMoney(stats.wagered)} wagered · average wager ${cfMoney(stats.avgWager)}`)
  log(` streaks: now ${stats.currentStreak.length} ${stats.currentStreak.kind || '-'} · longest ${stats.longestWinStreak}W / ${stats.longestLossStreak}L · worst drawdown ${cfMoney(stats.maxDrawdown)}`)
  if (fairness.p != null) log(` two-sided p: ${fairness.p.toExponential(3)}${fairness.runs && fairness.runs.z != null ? ` · runs test: ${fairness.runs.runs} runs vs ${fairness.runs.expected.toFixed(1)} expected (p=${fairness.runs.p.toFixed(4)})` : ''}`)
  if (stats.mismatches) log(`{red-fg} ✗ ${stats.mismatches} flip(s) where the result message and the balance disagreed{/red-fg}`)
  log(`{${verdictColour}} fairness verdict: ${fairness.verdict}{/${verdictColour}}`)
  fairness.flags.forEach(flag => log(`   {gray-fg}• ${sanitize(flag)}{/gray-fg}`))
  if (stats.opponents.length) {
    log(' {gray-fg}per opponent:{/gray-fg}')
    stats.opponents.slice(0, 10).forEach(opp => log(`   ${sanitize(opp.opponent)}: ${opp.flips} flips · ${opp.wins}W/${opp.losses}L · net ${cfMoney(opp.net)}`))
  }
  if (stats.bots.length > 1) {
    log(' {gray-fg}per bot:{/gray-fg}')
    stats.bots.slice(0, 12).forEach(row => log(`   ${sanitize(row.bot)}: ${row.flips} flips · ${row.wins}W/${row.losses}L · net ${cfMoney(row.net)}`))
  }
  log(` history: ${COINFLIP_FILE} · full page: http://${hostForLink()}:${settings.get('ANALYTICS_PORT')}/`)
  return
}

if (coinflipCall && coinflipCall.sub === 'history') {
  const parts = coinflipCall.args.split(/\s+/).filter(Boolean)
  if (parts[0] === 'clear') {
    if (parts[1] !== 'confirm') { logWarn(`This deletes ${coinflipStore.all().length} recorded flip(s) from ${COINFLIP_FILE}. Run /bot-coinflip history clear confirm to do it.`); return }
    const count = coinflipStore.all().length
    coinflipStore.clear()
    persistCoinflipSummary()
    logSuccess(`Cleared ${count} recorded flip(s). The file is gone; future flips start a new history.`)
    return
  }
  const wanted = Number(parts[0]) || 20
  const rows = coinflipStore.all().slice(-Math.max(1, Math.min(500, wanted))).reverse()
  if (!rows.length) { logInfo('No coinflip history yet — run /bot-coinflip run.'); return }
  logInfo(`{bold}── Last ${rows.length} coinflip(s) ──{/bold}`)
  rows.forEach(row => {
    const colour = row.result === 'won' ? 'green-fg' : row.result === 'lost' ? 'red-fg' : 'yellow-fg'
    const when = new Date(row.ts).toISOString().replace('T', ' ').slice(0, 19)
    log(`{${colour}} ${when} ${sanitize(row.bot)} ${row.result} ${cfMoney(row.wager)}${row.opponent ? ` vs ${sanitize(row.opponent)}` : ''} — Δ ${cfMoney(row.delta)} (${row.method})${row.mismatched ? ' ⚠ mismatch' : ''}{/${colour}}`)
  })
  log(` {gray-fg}${COINFLIP_FILE} · /bot-coinflip stats for the numbers{/gray-fg}`)
  return
}

if (trimmed === '/timeseries' || trimmed.startsWith('/timeseries ')) {
  const parts = trimmed.slice('/timeseries'.length).trim().split(/\s+/).filter(Boolean)
  const sub = parts[0] || 'status'
  if (sub === 'sample') return sampleTimeseriesNow({ source: 'command', ranks: parts.includes('ranks') })
  if (sub === 'clear') {
    if (parts[1] !== 'confirm') { logWarn(`This deletes every time-series sample in ${TIMESERIES_FILE}. Run /timeseries clear confirm to do it.`); return }
    const count = timeseriesStore.all().length
    timeseriesStore.clear()
    logSuccess(`Cleared ${count} sample(s).`)
    return
  }
  if (sub === 'series') {
    const metric = parts[1] || 'shards'
    const bucketMs = analytics.parseBucket(parts[2], settings.get('ANALYTICS_BUCKET_MS'))
    const bot = parts[3] && bots[parts[3]] ? parts[3] : null
    const points = timeseriesStore.bucket(metric, { bucketMs, bot, kind: bot ? 'bot' : 'fleet' })
    if (!points.length) { logWarn(`No ${sanitize(metric)} samples yet${bot ? ` for ${sanitize(bot)}` : ''} — /timeseries sample records one now.`); return }
    const nums = points.map(p => (typeof p.last === 'number' ? p.last : 0))
    logInfo(`{bold}── ${sanitize(metric)}${bot ? ` · ${sanitize(bot)}` : ' (fleet)'} · ${cfDuration(bucketMs)} buckets ──{/bold}`)
    log(` ${textSpark(nums)}`)
    points.slice(-12).forEach(p => log(`  ${new Date(p.t).toISOString().replace('T', ' ').slice(0, 16)}  ${typeof p.last === 'number' ? p.last.toLocaleString() : sanitize(p.last)}`))
    log(` {gray-fg}JSON: /api/timeseries?metric=${sanitize(metric)}&bucket=${Math.round(bucketMs / 1000)}s${bot ? `&bot=${sanitize(bot)}` : ''}{/gray-fg}`)
    return
  }
  if (sub === 'events') {
    const events = timeseriesStore.events()
    logInfo(`{bold}── Time-series events ──{/bold}`)
    log(` bans: ${events.bans.length} · rank changes: ${events.ranks.length}`)
    events.bans.slice(-12).forEach(e => log(`  ${new Date(e.t).toISOString().replace('T', ' ').slice(0, 16)} ${sanitize(e.bot)} ${e.banned ? '{red-fg}banned{/red-fg}' : '{green-fg}unbanned{/green-fg}'}`))
    events.ranks.slice(-12).forEach(e => log(`  ${new Date(e.t).toISOString().replace('T', ' ').slice(0, 16)} ${sanitize(e.bot)} ${sanitize(e.previous || '-')} → {cyan-fg}${sanitize(e.rank)}{/cyan-fg}`))
    return
  }
  const samples = timeseriesStore.all()
  logInfo('{bold}── Time series ──{/bold}')
  log(` file: ${TIMESERIES_FILE}`)
  log(` sampling: ${settings.get('TIMESERIES_ENABLED') ? 'on' : 'off'} · every ${cfDuration(settings.get('TIMESERIES_INTERVAL_MS'))} · ranks ${settings.get('TIMESERIES_RANK_INTERVAL_MS') > 0 ? `every ${cfDuration(settings.get('TIMESERIES_RANK_INTERVAL_MS'))}` : 'off'}`)
  log(` samples: ${samples.length} · bots sampled: ${new Set(samples.filter(s => s.kind === 'bot').map(s => s.bot)).size}`)
  for (const metric of ['shards', 'coins', 'balance', 'regents', 'banned']) {
    const summary = timeseriesStore.summarize(metric)
    log(summary
      ? `  ${metric}: ${typeof summary.last === 'number' ? summary.last.toLocaleString() : sanitize(summary.last)} over ${summary.samples} sample(s)${summary.delta == null ? '' : ` · Δ ${summary.delta.toLocaleString()} since ${new Date(summary.from).toISOString().slice(0, 16)}`}`
      : `  ${metric}: no data yet`)
  }
  log(` {gray-fg}/timeseries sample [ranks] | series <metric> [bucket] [bot] | events | clear confirm{/gray-fg}`)
  log(` {gray-fg}page: http://${hostForLink()}:${settings.get('ANALYTICS_PORT')}/ · snapshot: ${TIMESERIES_SUMMARY_FILE}{/gray-fg}`)
  return
}

if (coinflipCall && coinflipCall.sub === 'deep') {
  const wanted = coinflipCall.args
  let bot = null
  if (wanted && wanted !== 'all') {
    bot = bots[wanted] ? wanted : (matchBotName(wanted, Object.keys(bots)) || wanted)
  }
  const rows = coinflipStore.all()
  const scoped = bot ? rows.filter(row => row.bot === bot) : rows
  if (!scoped.length) { logInfo(`No coinflip history for ${sanitize(bot || 'the fleet')} yet — run /bot-coinflip run first.`); return }
  const report = coinflipDeepReport({ bot })
  const rate = (value) => (value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`)
  const mark = (row) => (row.significant ? '{green-fg}★{/green-fg} ' : row.lowSample ? '{gray-fg}·{/gray-fg} ' : '  ')

  logInfo(`{bold}── Coinflip dissection (${sanitize(bot || 'whole fleet')}) ──{/bold}`)
  log(` sample: ${report.resolved} resolved flip(s) · ${report.wins}W/${report.losses}L = ${rate(report.winRate)} · net ${cfMoney(report.net)}`)
  log(` ${report.tests} statistical test(s) corrected together at q=${report.q} · hours read from the ${sanitize(report.hourSource)} clock`)
  for (const section of report.sections) {
    log('')
    log(`{cyan-fg}${sanitize(section.title)}{/cyan-fg} {gray-fg}— ${sanitize(section.question)}{/gray-fg}`)
    if (!section.rows.length) { log(`  {gray-fg}${sanitize(section.summary)}{/gray-fg}`); continue }
    for (const row of section.rows.slice(0, 12)) {
      const shown = row.rate == null
        ? sanitize(row.note || '—')
        : `${rate(row.rate)} (${row.wins}W/${row.losses}L, n=${row.n})${row.q == null ? '' : ` q=${row.q.toExponential(2)}`}`
      log(`  ${mark(row)}${sanitize(row.label)}: ${shown}${row.lowSample ? ` {gray-fg}(under ${settings.get('COINFLIP_DEEP_MIN_BUCKET')} flips){/gray-fg}` : ''}`)
    }
    if (section.rows.length > 12) log(`  {gray-fg}… ${section.rows.length - 12} more row(s) in the JSON{/gray-fg}`)
    log(`  {gray-fg}${sanitize(section.summary)}{/gray-fg}`)
  }
  log('')
  logInfo('{bold}── What the numbers say ──{/bold}')
  report.takeaways.forEach(line => log(` • ${sanitize(line)}`))
  const file = persistCoinflipDeepReport()
  log(` {gray-fg}full report: ${COINFLIP_DEEP_FILE}${file ? '' : ' (could not be written)'} · page: http://${hostForLink()}:${settings.get('ANALYTICS_PORT')}/ · JSON: /api/coinflip/deep{/gray-fg}`)
  return
}

if (coinflipCall && coinflipCall.sub === 'help') {
  const summary = coinflipStore.summary({ recent: 0, minSample: settings.get('COINFLIP_MIN_SAMPLE'), suspicionP: settings.get('COINFLIP_SUSPICION_P') })
  const stats = summary.stats
  logInfo('{bold}── /bot-coinflip ──{/bold}')
  log(` recorded: ${stats.resolved} resolved flip(s) (${stats.wins}W/${stats.losses}L) · net ${cfMoney(stats.net)} · fairness verdict ${sanitize(summary.fairness.verdict)}`)
  log('')
  log(`{cyan-fg}/bot-coinflip run [PRICE] [AMOUNT] [BOT|all]{/cyan-fg} {gray-fg}— play AMOUNT flips (default ${settings.get('COINFLIP_DEFAULT_FLIPS')}) and record every one. PRICE is fixed (500000) or a range (10k-1m); a busy or rate-limited create is waited for, never deleted{/gray-fg}`)
  log(`{cyan-fg}/bot-coinflip stats [BOT]{/cyan-fg} {gray-fg}— wins, losses, net, streaks, drawdown, per-opponent, fairness verdict{/gray-fg}`)
  log(`{cyan-fg}/bot-coinflip deep [BOT]{/cyan-fg} {gray-fg}— the dissection: what follows a loss run, lag correlation, wager against balance, hour of day, pace, position, opponents, money curve, each with a confidence interval{/gray-fg}`)
  log(`{cyan-fg}/bot-coinflip history [n|clear confirm]{/cyan-fg} {gray-fg}— the raw recorded flips, and how to wipe them{/gray-fg}`)
  log(`{cyan-fg}/bot-coinflip export [BOT]{/cyan-fg} {gray-fg}— ${COINFLIP_EXPORT_FILE} for pandas, R or a spreadsheet{/gray-fg}`)
  log('')
  log(' {gray-fg}/coinflip is the server\'s own coinflip command and is never intercepted — /coinflip create 10k, /coinflip delete and a bare /coinflip all reach the selected bot untouched. This suite only owns /bot-coinflip{/gray-fg}')
  log(` {gray-fg}/all-slow /bot-coinflip run 10k-1m 20 spreads it across every bot · page http://${hostForLink()}:${settings.get('ANALYTICS_PORT')}/ · JSON /api/coinflip, /api/coinflip/deep, /api/export{/gray-fg}`)
  return
}

if (coinflipCall && coinflipCall.sub === 'export') {
  const wanted = coinflipCall.args
  let match = null
  if (wanted && wanted !== 'all') {
    match = bots[wanted] ? wanted : matchBotName(wanted, Object.keys(bots))
    if (!match) { logWarn(`No bot named "${sanitize(wanted)}". Known bots: ${Object.keys(bots).join(', ') || 'none'}`); return }
  }
  const all = coinflipStore.all()
  const rows = match ? all.filter(row => row.bot === match) : all
  if (!rows.length) { logInfo(`No coinflip history for ${sanitize(match || 'the fleet')} yet — /bot-coinflip run records some first.`); return }
  try {
    fs.mkdirSync(path.dirname(COINFLIP_EXPORT_FILE), { recursive: true })
    fs.writeFileSync(COINFLIP_EXPORT_FILE, coinflip.toCsv(rows))
  } catch (err) {
    logError(`Could not write ${COINFLIP_EXPORT_FILE}: ${sanitize(err.message)}`)
    return
  }
  logSuccess(`${rows.length} flip(s) exported to ${COINFLIP_EXPORT_FILE} — one row per flip, ready for pandas, R or a spreadsheet.`)
  log(` {gray-fg}columns: ${coinflip.CSV_COLUMNS.join(', ')}{/gray-fg}`)
  log(' {gray-fg}the JSONL history stays the raw record; /api/export has everything (history + samples + dissection) in one JSON{/gray-fg}')
  return
}

if (coinflipCall && coinflipCall.sub === 'unknown') {
  // Never forwarded: the game's own command is the plain /coinflip name, which
  // this console does not own, so guessing at a prefix would only invent chat.
  logWarn(`Unknown /bot-coinflip subcommand "${sanitize(coinflipCall.args.split(/\s+/)[0])}" — try /bot-coinflip for the list. The game's own command is plain /coinflip (e.g. /coinflip create 10000) and always reaches the selected bot untouched.`)
  return
}
// ── AI Chat ───────────────────────────────────────────────────────────────────
const aiChatMatch = trimmed.match(/^\/ai-chat(?:\[([^\]]+)\])?\s*(.*)/i)
if (aiChatMatch) {
  const sub = (aiChatMatch[1] || 'start').toLowerCase()
  const botArg = aiChatMatch[2]?.trim()

  if (sub === 'start') {
    const targetBot = botArg || ctxId || currentActiveId()
    if (!targetBot) {
      logWarn('/ai-chat [start|stop|status] [bot] — specify a bot to start AI chat')
      return
    }
    startAIChatForBot(targetBot)
  } else if (sub === 'stop') {
    const targetBot = botArg || ctxId || currentActiveId()
    if (!targetBot) {
      logWarn('/ai-chat [start|stop|status] [bot] — specify a bot to stop AI chat')
      return
    }
    stopAIChatForBot(targetBot)
  } else if (sub === 'models') {
    // Query available models from FreeLLM API
    (async () => {
      try {
        logInfo('Querying FreeLLM API for available models...');
        const models = await getAvailableModels();

        if (models.length === 0) {
          logWarn('Could not retrieve models from FreeLLM API. Check FREE_LLM_BASE_URL and FREE_LLM_API_KEY in .env');
        } else {
          models.forEach(model => {
            const fields = [];
            if (model.owned_by) fields.push(`- ${model.owned_by}`);
            if (model.max_model_len) fields.push(`(max: ${model.max_model_len})`);
            if (model.description) fields.push(`- ${model.description}`);

            log(` {cyan-fg}${model.id}{/cyan-fg} ${fields.join(' ')}`);
          });
          log(` {gray-fg}Total: ${models.length} model(s) available{/gray-fg}`);
        }
      } catch (error) {
        logWarn(`Model query failed: ${sanitize(error.message)}`);
      }
    })();
  } else if (sub === 'model-set') {
    const modelArg = botArg?.split(/\s+/)[0];
    if (!modelArg) {
      logWarn('/ai-chat model-set <model> — specify a model name to use');
      return;
    }
    settings.set('AI_CHAT_MODEL', modelArg);
    logSuccess(`AI chat model set to: ${modelArg}`);
  } else if (sub === 'status') {
    const targetBot = botArg || ctxId || currentActiveId()
    const status = aiChatSessions.has(targetBot)
      ? '{green-fg}running{/green-fg}'
      : '{yellow-fg}not running{/yellow-fg}'
    logInfo(`AI chat status for ${sanitize(targetBot || 'current bot')}: ${status}`)
  } else {
    logWarn(`Unknown /ai-chat subcommand "${sub}" — try: start, stop, status, models, model-set`)
  }
  return
}

if (trimmed === '/analytics' || trimmed === '/analytics open') {
  const port = settings.get('ANALYTICS_PORT')
  const summary = coinflipStore.summary({ recent: 0, minSample: settings.get('COINFLIP_MIN_SAMPLE'), suspicionP: settings.get('COINFLIP_SUSPICION_P') })
  const stats = summary.stats
  const fairness = summary.fairness
  logInfo('{bold}── Analytics ──{/bold}')
  log(` page: http://${hostForLink()}:${port}/  (read-only${settings.get('ANALYTICS_OPEN') ? ', no login' : ' — sign in at the dashboard first'})`)
  log(` coinflips: ${stats.resolved} resolved (${stats.wins}W/${stats.losses}L) · net ${cfMoney(stats.net)} · verdict ${fairness.verdict}`)
  log(` time series: ${timeseriesStore.all().length} sample(s) → ${TIMESERIES_FILE}`)
  log(` coinflip history: ${coinflipStore.all().length} flip(s) → ${COINFLIP_FILE}`)
  log(` coinflip dissection: ${COINFLIP_DEEP_FILE}`)
  log(' {gray-fg}JSON: /api/analytics · /api/coinflip · /api/coinflip/deep · /api/timeseries?metric=shards&bucket=1h · /api/export (everything){/gray-fg}')
  return
}

if (trimmed === '/analyze' || trimmed.startsWith('/analyze ')) {
  const args = trimmed.slice('/analyze'.length).trim().split(/\s+/)
  const sub = args[0] || 'open'
  const port = settings.get('ANALYTICS_PORT')
  const baseUrl = `http://${hostForLink()}:${port}`

  if (sub === 'open') {
    const url = `${baseUrl}/`
    logInfo(`Opening analytics page: ${url}`)
    log(' {gray-fg}This page shows coinflip fairness tests, time-series charts (shards/coins/balance), fleet stats, ban events, and rank changes.{/gray-fg}')
    // Use execFile with an argument array — never interpolate user/env-controlled
    // values into a shell string (command injection via ANALYTICS_HOST).
    const { execFile } = require('child_process')
    const openCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    execFile(openCmd, [url], (err) => {
      if (err) logWarn(`Could not auto-open browser: ${sanitize(err.message)} — please visit ${url} manually`)
      else log(`Opened ${url} in default browser`)
    })
    return
  }
  if (sub === 'url') {
    const page = args[1] || '/'
    logInfo(`${baseUrl}${page}`)
    return
  }
  if (sub === 'json') {
    const report = buildAnalyticsReport({ recent: 100 })
    log(JSON.stringify(report, null, 2))
    return
  }
  logWarn(`Unknown /analyze subcommand "${sanitize(sub)}" — try: open, url, json`)
  return
}

if (trimmed === '/env' || trimmed.startsWith('/env ')) {
  const rest = trimmed.slice('/env'.length).trim()
  const parts = rest.split(/\s+/).filter(Boolean)
  const sub = parts[0] || 'list'
  if (sub === 'list') {
    const filter = (parts[1] || '').toLowerCase()
    const groups = settings.grouped()
    logInfo(`{bold}── Settings ──{/bold} {gray-fg}${settings.overrideCount()} temporary override(s); nothing here is written to .env{/gray-fg}`)
    for (const group of groups) {
      const rows = group.rows.filter(row => !filter || row.key.toLowerCase().includes(filter) || group.group.toLowerCase().includes(filter))
      if (!rows.length) continue
      log(`{cyan-fg}${group.group}{/cyan-fg}`)
      for (const row of rows) {
        const value = row.secret ? (row.configured ? '(set)' : '(unset)') : (row.value == null || row.value === '' ? '(unset)' : String(row.value))
        const marks = `${row.overridden ? ' {yellow-fg}*temporary{/yellow-fg}' : ''}${row.live ? '' : ' {gray-fg}(startup-only){/gray-fg}'}`
        log(`  ${row.key} = ${value}${marks}`)
      }
    }
    log(` {gray-fg}/env set KEY VALUE · /env reset KEY · /env reset-all · the dashboard .ENV tab is the same thing with inputs{/gray-fg}`)
    return
  }
  if (sub === 'get') {
    const key = parts[1]
    if (!key) { logWarn('Usage: /env get KEY'); return }
    const row = settings.list().find(entry => entry.key.toLowerCase() === key.toLowerCase())
    if (!row) { logWarn(`No setting named "${sanitize(key)}". /env list shows them all.`); return }
    logInfo(`${row.key}: ${row.secret ? (row.configured ? '(set — value withheld)' : '(unset)') : (row.value == null || row.value === '' ? '(unset)' : String(row.value))} {gray-fg}(${row.source}${row.live ? '' : ', startup-only'}){/gray-fg}`)
    return
  }
  if (sub === 'set') {
    const key = parts[1]
    const value = parts.slice(2).join(' ')
    if (!key || !value) { logWarn('Usage: /env set KEY VALUE'); return }
    const result = settings.set(key, value)
    if (!result.ok) { logError(`Could not set ${sanitize(key)}: ${sanitize(result.error)}`); return }
    logSuccess(result.secret ? `${key} updated (temporary — not saved; value withheld)` : `${key} = ${String(result.value)} {gray-fg}(temporary — not saved){/gray-fg}`)
    if (!result.live) logWarn(`${key} is read once at startup, so the running process keeps its old value. Edit the file and restart for that one.`)
    return
  }
  if (sub === 'reset') {
    const key = parts[1]
    if (!key) { logWarn('Usage: /env reset KEY — or /env reset-all'); return }
    const result = settings.reset(key)
    if (!result.ok) { logWarn(`${sanitize(key)}: ${sanitize(result.error || 'not overridden')}`); return }
    logSuccess(`${key} is back to ${result.secret ? '(set)' : String(result.value)} {gray-fg}(${result.source}){/gray-fg}`)
    return
  }
  if (sub === 'reset-all') {
    const cleared = settings.resetAll()
    logSuccess(`Cleared ${cleared.length} temporary override(s)${cleared.length ? `: ${cleared.join(', ')}` : ''}.`)
    return
  }
  logWarn('Usage: /env [list [filter] | get KEY | set KEY VALUE | reset KEY | reset-all]')
  return
}


// ── Manual interaction commands (bot-manual.js) ─────────────
// After the crate/shardshop parsing above but before the local-command switch
// and the raw Minecraft chat fallback, so /walk, /window-*, /key etc. never
// leak to the server as chat.
// Guard so a bug inside the manual router can never take down the command
// channel — an uncaught throw here would propagate into the WebSocket handler
// and make the UI stop accepting commands.
try {
  if (manual.routeCommand(trimmed, activeId)) return
} catch (err) {
  logError('Manual command failed: ' + sanitize((err && err.message) || String(err)))
  return
}

// ── Single-bot local commands ───────────────
if (activeId && LOCAL_COMMANDS.includes(trimmed.split(/\s+/)[0])) {
return runLocalCommandForBot(activeId, trimmed)
}

switch (trimmed) {
case '/help':
logInfo('{bold}Available commands:{/bold}')
Object.entries(COMMANDS).forEach(([cmd, desc]) => log(` {cyan-fg}${cmd}{/cyan-fg} — ${desc}`))
break

case '/exit':
logWarn('Exiting all bots…')
slowBroadcastManager.cancelAll()
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

// ── Chat activity watchdog loop ──────────────────────────────────────────────
if (CHAT_WATCHDOG_ENABLED) {
  const chatWatchdogTimer = setInterval(() => {
    const now = Date.now()
    for (const id of Object.keys(bots)) {
      const e = bots[id]
      if (!e?.bot?.entity) continue // not spawned — nothing to keep alive
      const idle = now - (e.lastPlayerChatAt || now)
      if (idle >= CHAT_WATCHDOG_TIMEOUT_MS) {
        e.lastPlayerChatAt = now // reset so it does not re-fire every check tick
        const cmd = CHAT_WATCHDOG_COMMAND || SERVER_COMMAND || '/server lifesteal'
        logFor(id, `{yellow-fg}⚠ No player chat for ${Math.round(idle / 60000)} min — running ${cmd}…{/yellow-fg}`)
        try { e.bot.chat(cmd) } catch (err) {
          logFor(id, `{red-fg}✗ Chat watchdog: ${sanitize(err.message)}{/red-fg}`)
        }
      }
    }
  }, CHAT_WATCHDOG_CHECK_MS)
  if (chatWatchdogTimer.unref) chatWatchdogTimer.unref()
}

// ── Interface startup ─────────────────────────────────────────────────────────
tui = startTUI()
webHandle = startWebGUI()
startTimeseriesSampler()
analyticsServer = startAnalyticsServer()

if (tui || webHandle) {
installConsolePlumbing()
} else {
// No interface at all — plain stdout logging so it's never silent
subscribeLog((id, line) => { try { process.stdout.write(stripTags(line) + '\n') } catch (_) {} })
}
