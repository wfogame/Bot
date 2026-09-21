"use strict"

const fs = require('fs')
const os = require('os')

function envBool(name, fallback = false) {
  const value = process.env[name]
  if (value === undefined) return fallback
  return /^(1|true|yes|on)$/i.test(value)
}
function envInt(name, fallback, min = 0) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10)
  return Number.isFinite(value) ? Math.max(min, value) : fallback
}
function envFloat(name, fallback, min = 0, max = Infinity) {
  const value = Number.parseFloat(process.env[name] || String(fallback))
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}
// ── Chat-component flattening ───────────────────────────────────────────────
// A kick reason is not always a string. Servers that brand their ban screen send
// a serialized chat component, and the plain text is buried in nested leaves:
//
//   {"type":"compound","value":{"extra":{"type":"list","value":
//     {"type":"compound","value":[{"color":{...},"text":{"type":"string",
//     "value":"You have been banned due to "}}, ...]}}}
//
// Matching patterns against that raw JSON finds the word "banned" and nothing
// else — no "Expires in: 29 days, 11 hours, 17 minutes" — so a 29-day temporary
// ban was reported as permanent. Walk the tree instead and join the text leaves.
function chatText (node) {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number' || typeof node === 'boolean') return String(node)
  if (Array.isArray(node)) return node.map(chatText).join('')
  if (typeof node !== 'object') return ''
  // NBT-ish wrapper: { type: 'string'|'compound'|'list', value }.
  if (typeof node.type === 'string' && 'value' in node) {
    if (node.type === 'string') return typeof node.value === 'string' ? node.value : chatText(node.value)
    return chatText(node.value)
  }
  // Chat component: { text, extra, ...styling } — styling keys are ignored.
  let out = ''
  if (node.text !== undefined) out += chatText(node.text)
  if (node.extra !== undefined) out += chatText(node.extra)
  return out
}

// Accepts a string, a chat-component object, or a JSON-serialized one (which is
// what bot.js passes after stringifying a non-string kick reason).
function normalizeKickText (message) {
  if (message == null || message === '') return ''
  if (typeof message === 'number' || typeof message === 'boolean') return String(message)
  if (typeof message === 'object') {
    return tidyChatText(chatText(message))
  }
  const trimmed = String(message).trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const flat = tidyChatText(chatText(JSON.parse(trimmed)))
      // Only prefer the flattened form when it actually produced readable text.
      if (flat) return flat
    } catch (_) { /* not JSON after all */ }
  }
  return message
}

// Collapses the padding and blank lines a branded ban screen is full of, while
// keeping line breaks (the reason and the expiry live on their own lines).
function tidyChatText (text) {
  return String(text || '')
    .replace(/[\t\u00a0]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── Ban detection ───────────────────────────────────────────────────────────
// A ban reaches the bot as an ordinary kick packet, so the wording is the only
// evidence available.
const BAN_WORD_RE = /\bbann?ed\b|\bban\b|blacklist|suspended|permaban|ban hammer|blocked by an? anti-?bot|alt (?:account )?detected|bot detected|automatic(?:ally)? banned|suspicious (?:activity|connection)/i
const BLACKLIST_RE = /blacklist|black-list|global ban|network-?wide ban|banned from (?:all|every) servers/i
const TEMP_WORD_RE = /temporar(?:ily|y)[\s-]*bann?ed|\btemp[\s-]?ban\b|banned for\s+\d|expires?\s+in\b|expires?\s+(?:at|on|until)\b|banned until|ban (?:expires|ends)/i
const PERM_WORD_RE = /permanent(?:ly)?[\s-]+bann?ed|permanent ban|permaban|banned permanently|never (?:be )?(?:unbanned|allowed)/i
const SUSPECT_RE = /alt (?:account )?detected|anti-?bot|bot detected|automatic(?:ally)? banned|suspicious (?:activity|connection)/i
var BAN_DURATION_RE = /\bfor\s+(\d+\s*(?:second|minute|hour|day|week|month|year)s?)/i
var BAN_EXPIRES_IN_RE = /expires?\s+in\s*:?\s*([0-9][^\n]*)/i
var BAN_EXPIRES_AT_RE = /expires?\s+(?:at|on|until)?\s*:?\s*(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)/i
var BAN_REASON_RE = /banned\s+(?:due\s+to|for|because\s+of|reason\s*:)\s*:?\s*([^\n]+)/i
var BAN_CASE_ID_RE = /^(.*?)\s*\[([^\]]{1,24})\]\s*$/
var BAN_UNIT_MS = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, year: 31536000000 }

// Operators can add their server's exact wording without touching this file:
// BAN_MESSAGE_REGEX="you have been removed from" in .env.
var EXTRA_BAN_RE = (function () {
  const raw = (process.env.BAN_MESSAGE_REGEX || '').trim()
  if (!raw) return null
  try {
    return new RegExp(raw, 'i')
  } catch (_) {
    return null
  }
})()

// "29 days, 11 hours, 17 minutes" -> milliseconds. 0 when nothing parsed.
function parseBanDuration (text) {
  if (!text) return 0
  const re = /(\d+(?:[.,]\d+)?)\s*(second|minute|hour|day|week|month|year)s?/gi
  let total = 0
  let match
  let found = false
  while ((match = re.exec(String(text))) !== null) {
    const unit = BAN_UNIT_MS[match[2].toLowerCase()]
    if (!unit) continue
    total += parseFloat(match[1].replace(',', '.')) * unit
    found = true
  }
  return found ? Math.round(total) : 0
}

// Pure classifier: no network, no clock, no state, so it can be unit tested
// directly. `durationMs` is returned rather than an absolute expiry so the
// caller decides the reference time; `expiresAt` is only set when the message
// itself names an absolute date.
//
// kind: 'blacklist' | 'temporary' | 'permanent' | 'suspected' | ''
function classifyKick (message) {
  const text = normalizeKickText(message)
  const empty = { banned: false, permanent: false, kind: '', duration: '', durationMs: 0, expiresAt: 0, reason: text || '', caseId: '', text: text || '' }
  if (!text || !text.trim()) return empty

  const blacklist = BLACKLIST_RE.test(text)
  const suspect = !blacklist && SUSPECT_RE.test(text)
  const banWord = blacklist || suspect || BAN_WORD_RE.test(text) || Boolean(EXTRA_BAN_RE && EXTRA_BAN_RE.test(text))
  if (!banWord) return empty

  const relative = text.match(BAN_EXPIRES_IN_RE) || text.match(BAN_DURATION_RE)
  const absolute = text.match(BAN_EXPIRES_AT_RE)
  const duration = relative ? String(relative[1]).replace(/\s+/g, ' ').trim().replace(/[.,]$/, '') : ''
  const durationMs = parseBanDuration(duration)
  const expiresAt = absolute ? Date.parse(absolute[1]) || 0 : 0

  let kind
  if (blacklist) kind = 'blacklist'
  else if (suspect) kind = 'suspected'
  else if (durationMs > 0 || expiresAt > 0 || TEMP_WORD_RE.test(text)) kind = 'temporary'
  else kind = 'permanent'
  // An unexpiring ban is a permanent one even if the wording never says so.
  if (kind === 'temporary' && PERM_WORD_RE.test(text) && !durationMs && !expiresAt) kind = 'permanent'

  let reason = text
  const reasonMatch = text.match(BAN_REASON_RE)
  if (reasonMatch) reason = reasonMatch[1].replace(/\s+/g, ' ').trim().replace(/[.,]$/, '')
  let caseId = ''
  const caseMatch = reason.match(BAN_CASE_ID_RE)
  if (caseMatch) {
    reason = caseMatch[1].trim()
    caseId = caseMatch[2].trim()
  }

  return {
    // An operator-supplied pattern is their own wording, so trust it as a ban.
    banned: true,
    permanent: kind === 'permanent' || kind === 'blacklist',
    kind,
    duration,
    durationMs,
    expiresAt,
    reason,
    caseId,
    text
  }
}

function clampText(value, max = 1800) {
  const text = String(value ?? '').replace(/\0/g, '')
  return text.length > max ? text.slice(0, max - 16) + ' ...[truncated]' : text
}
function formatMiB(bytes) { return `${Math.round(bytes / 1048576)} MiB` }
function parseProcMeminfo() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8')
    const values = Object.create(null)
    for (const line of text.split('\n')) {
      const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/)
      if (match) values[match[1]] = Number(match[2]) * 1024
    }
    if (!values.MemTotal) return null
    const available = values.MemAvailable ?? values.MemFree ?? 0
    const swapTotal = values.SwapTotal ?? 0
    const swapFree = values.SwapFree ?? 0
    return { total: values.MemTotal, available, swapTotal, swapUsed: Math.max(0, swapTotal - swapFree), source: '/proc/meminfo' }
  } catch (_) { return null }
}
function readHostMemory() {
  return parseProcMeminfo() || {
    total: os.totalmem(), available: os.freemem(), swapTotal: 0, swapUsed: 0, source: 'node:os'
  }
}

function createMonitoring({ logFor, systemId, sanitize, getStats, getBotCount }) {
  const cfg = {
    webhook: (process.env.DISCORD_WEBHOOK_URL || '').trim(),
    userId: (process.env.DISCORD_USER_ID || '').trim(),
    discordEnabled: envBool('DISCORD_NOTIFICATIONS', true),
    mentionCriticalOnly: envBool('DISCORD_MENTION_CRITICAL_ONLY', false),
    minSendIntervalMs: envInt('DISCORD_MIN_SEND_INTERVAL_MS', 1200, 250),
    memoryEnabled: envBool('MEMORY_WATCHDOG', true),
    memoryIntervalMs: envInt('MEMORY_CHECK_INTERVAL_MS', 30000, 5000),
    memoryWarnPct: envFloat('MEMORY_AVAILABLE_WARN_PERCENT', 15, 1, 99),
    memoryCriticalPct: envFloat('MEMORY_AVAILABLE_CRITICAL_PERCENT', 8, 1, 99),
    swapWarnPct: envFloat('SWAP_WARN_PERCENT', 10, 0, 100),
    swapWarnMiB: envInt('SWAP_WARN_MIB', 256, 0),
    cooldownMs: envInt('MEMORY_ALERT_COOLDOWN_MS', 900000, 60000),
    recoveryPct: envFloat('MEMORY_RECOVERY_PERCENT', 20, 1, 100),
    restartCooldownMs: envInt('SERVER_RESTART_ALERT_COOLDOWN_MS', 120000, 10000),
    eventCooldownMs: envInt('DISCORD_EVENT_COOLDOWN_MS', 60000, 1000),
    // A ban is a long-lived state, not a blip: one alert per bot per kind, then
    // no repeat spam while reconnect attempts keep failing against the same ban.
    banCooldownMs: envInt('DISCORD_BAN_COOLDOWN_MS', 900000, 60000),
    // A rejected password is a config mistake that a retry cannot fix, so the
    // alert is deliberately long-lived: one message, then quiet until it is
    // actually resolved (or the process restarts with a fixed password).
    authCooldownMs: envInt('DISCORD_AUTH_COOLDOWN_MS', 1800000, 60000)
  }
  if ((process.env.BAN_MESSAGE_REGEX || '').trim() && !EXTRA_BAN_RE) {
    // Warn once at startup rather than silently ignoring a broken pattern.
    setTimeout(() => local('warn', `BAN_MESSAGE_REGEX is not a valid regular expression and is being ignored: ${process.env.BAN_MESSAGE_REGEX}`), 0).unref?.()
  }
  let memory = { level: 'unknown', availablePct: null, swapPct: null, swapUsed: 0, total: 0, available: 0, source: 'unknown', checkedAt: 0 }
  let lastMemoryAlert = 0
  let lastDiscordSend = 0
  let queue = Promise.resolve()
  const eventTimes = new Map()

  function local(level, message) {
    const color = level === 'error' ? 'red' : level === 'warn' ? 'yellow' : level === 'ok' ? 'green' : 'cyan'
    try { logFor(systemId, `{${color}-fg}[monitor] ${sanitize(message)}{/${color}-fg}`) } catch (_) {}
  }
  function mention(critical) {
    if (!cfg.userId || (cfg.mentionCriticalOnly && !critical)) return ''
    return `<@${cfg.userId}>`
  }
  async function postDiscord(payload, attempt = 0) {
    if (!cfg.discordEnabled || !cfg.webhook || typeof fetch !== 'function') return false
    const wait = Math.max(0, cfg.minSendIntervalMs - (Date.now() - lastDiscordSend))
    if (wait) await new Promise(resolve => setTimeout(resolve, wait))
    lastDiscordSend = Date.now()
    let response
    try {
      response = await fetch(cfg.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'wfogamerrgb-bot-monitor/1.0' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000)
      })
    } catch (err) {
      if (attempt < 2) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); return postDiscord(payload, attempt + 1) }
      local('error', `Discord webhook failed: ${err.message}`)
      return false
    }
    if (response.ok) return true
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      const retryAfter = Number(response.headers.get('retry-after')) || (1.5 * (attempt + 1))
      await new Promise(r => setTimeout(r, Math.min(10000, retryAfter * 1000)))
      return postDiscord(payload, attempt + 1)
    }
    local('error', `Discord webhook returned HTTP ${response.status}`)
    return false
  }
  function notify({ key, title, description, color = 0xf59e0b, critical = false, cooldownMs = cfg.eventCooldownMs, fields = [] }) {
    const now = Date.now()
    if (key && now - (eventTimes.get(key) || 0) < cooldownMs) return Promise.resolve(false)
    if (key) eventTimes.set(key, now)
    const payload = {
      content: mention(critical),
      allowed_mentions: { parse: [], users: cfg.userId ? [cfg.userId] : [] },
      embeds: [{
        title: clampText(title, 256), description: clampText(description, 3900), color,
        fields: fields.slice(0, 10).map(f => ({ name: clampText(f.name, 256), value: clampText(f.value, 1024), inline: !!f.inline })),
        timestamp: new Date().toISOString(), footer: { text: 'Minecraft multi-bot monitor' }
      }]
    }
    queue = queue.then(() => postDiscord(payload)).catch(err => { local('error', `Discord queue error: ${err.message}`); return false })
    return queue
  }
  function memoryDescription(snapshot) {
    const processMem = process.memoryUsage()
    const stats = getStats ? getStats() : {}
    return [
      `Available RAM: ${snapshot.availablePct.toFixed(1)}% (${formatMiB(snapshot.available)} of ${formatMiB(snapshot.total)})`,
      `Swap used: ${snapshot.swapTotal ? `${snapshot.swapPct.toFixed(1)}% (${formatMiB(snapshot.swapUsed)} of ${formatMiB(snapshot.swapTotal)})` : 'not reported'}`,
      `Node RSS: ${formatMiB(processMem.rss)} | heap: ${formatMiB(processMem.heapUsed)}`,
      `Bots online: ${stats.online ?? '?'} / ${stats.bots ?? getBotCount?.() ?? '?'} | event-loop lag: ${stats.evlLagMs ?? '?'} ms`
    ].join('\n')
  }
  function checkMemory() {
    const raw = readHostMemory()
    const availablePct = raw.total ? raw.available / raw.total * 100 : 100
    const swapPct = raw.swapTotal ? raw.swapUsed / raw.swapTotal * 100 : 0
    const swapConcern = raw.swapTotal > 0 && raw.swapUsed >= cfg.swapWarnMiB * 1048576 && swapPct >= cfg.swapWarnPct
    let level = 'ok'
    if (availablePct <= cfg.memoryCriticalPct || swapConcern) level = 'critical'
    else if (availablePct <= cfg.memoryWarnPct) level = 'warn'
    const previous = memory.level
    memory = { ...raw, availablePct, swapPct, level, checkedAt: Date.now() }
    const now = Date.now()
    if ((level === 'warn' || level === 'critical') && (previous !== level || now - lastMemoryAlert >= cfg.cooldownMs)) {
      lastMemoryAlert = now
      local(level === 'critical' ? 'error' : 'warn', `${level.toUpperCase()} memory pressure: ${availablePct.toFixed(1)}% RAM available, ${formatMiB(raw.swapUsed)} swap used`)
      notify({
        key: `memory:${level}:${Math.floor(now / cfg.cooldownMs)}`, title: level === 'critical' ? 'Critical memory pressure' : 'Low available memory',
        description: `${memoryDescription(memory)}\n\nSwap can severely slow the bot host.`,
        color: level === 'critical' ? 0xdc2626 : 0xf59e0b, critical: level === 'critical', cooldownMs: cfg.cooldownMs
      })
    } else if ((previous === 'warn' || previous === 'critical') && level === 'ok' && availablePct >= cfg.recoveryPct && !swapConcern) {
      local('ok', `Memory recovered: ${availablePct.toFixed(1)}% RAM available`)
      notify({ key: 'memory:recovered', title: 'Memory pressure recovered', description: memoryDescription(memory), color: 0x22c55e, cooldownMs: 10000 })
    }
    return memory
  }
  function inspectServerMessage(botId, message) {
    const text = String(message || '')
    if (/server\s+will\s+restart\s+in/i.test(text) && /(^|\D)30(\D|$)/.test(text)) {
      local('warn', `${botId} detected a 30-second server restart warning`)
      notify({ key: 'server-restart-30', title: 'Server restart warning', description: `**${clampText(botId, 80)}** received:\n${clampText(text, 1600)}`, color: 0xf97316, critical: true, cooldownMs: cfg.restartCooldownMs })
      return true
    }
    return false
  }
  const BAN_TITLES = { permanent: 'Bot banned', temporary: 'Bot temporarily banned', blacklist: 'Bot blacklisted', suspected: 'Possible bot ban' }
  const BAN_COLORS = { permanent: 0xdc2626, temporary: 0xf59e0b, blacklist: 0x7f1d1d, suspected: 0xf97316 }

  // Ban-specific alert: a different title, colour, and cooldown from a kick, so
  // it cannot be mistaken for an ordinary disconnect in the Discord feed. The
  // caller is expected to persist the ban state alongside this (see bot.js).
  function onBan(botId, verdict) {
    const kind = verdict.kind || 'permanent'
    const duration = verdict.duration ? ` for **${verdict.duration}**` : ''
    const certain = kind !== 'suspected'
    local('error', `${botId} ${certain ? 'banned' : 'possibly banned'} (${kind})${verdict.duration ? ' — ' + verdict.duration : ''}: ${verdict.reason}`)
    return notify({
      key: `ban:${botId}:${kind}`,
      title: BAN_TITLES[kind] || 'Bot banned',
      description: [
        `**${clampText(botId, 80)}** ${certain ? 'was banned' : 'looks like it was banned'}${duration}.`,
        '',
        `Reason: ${clampText(verdict.reason, 1500)}`,
        kind === 'temporary' ? '\nReconnecting keeps retrying — it should recover on its own once the ban expires.' : '',
        kind === 'suspected' ? '\nMatched an anti-bot / alt-detection phrase. Check whether the account still exists.' : ''
      ].filter(Boolean).join('\n'),
      color: BAN_COLORS[kind] || 0xdc2626,
      critical: certain,
      cooldownMs: cfg.banCooldownMs,
      fields: [{ name: 'Ban type', value: kind, inline: true }].concat(
        verdict.duration ? [{ name: 'Duration', value: clampText(verdict.duration, 120), inline: true }] : []
      )
    })
  }

  // Login/register rejected. Distinct from a kick on purpose: the account is
  // not being punished by the server, our own credentials are wrong, and the
  // bot has stopped trying — so the alert must say which variable to fix
  // instead of reading like one more reconnect in the feed.
  function onAuthFailure(botId, failure) {
    const kind = failure.kind || 'bad-password'
    const certain = kind === 'bad-password'
    local('error', `${botId} auth ${kind}: ${failure.reason}${failure.until ? '' : ' — stopped sending auth commands'}`)
    const vars = '`LOGIN_PASSWORD`, `PROXY_GROUP_<N>_LOGIN_PASSWORD`, or `BOT_PASSWORDS`'
    return notify({
      key: `auth:${botId}:${kind}`,
      title: certain ? 'Bot login rejected' : 'Bot auth cannot proceed',
      description: [
        `**${clampText(botId, 80)}** could not authenticate: ${clampText(failure.reason, 400)}`,
        '',
        certain
          ? `It has stopped sending \`/login\` so the account is not rate-limited or banned. Fix the password in ${vars}, then run \`/auth-retry ${clampText(botId, 80)}\`.`
          : `It is waiting before trying again${failure.until ? ` (until <t:${Math.floor(failure.until / 1000)}:t>)` : ''}. Repeated throttling escalates to a wrong-password failure rather than retrying forever.`
      ].filter(Boolean).join('\n'),
      color: certain ? 0xdc2626 : 0xf97316,
      critical: certain,
      cooldownMs: cfg.authCooldownMs,
      fields: [{ name: 'Failure', value: kind, inline: true }]
    })
  }

  function onKick(botId, reason) {
    const text = clampText(reason || 'Unknown reason', 2000)
    const verdict = classifyKick(text)
    if (verdict.banned) return onBan(botId, verdict)
    local('error', `${botId} kicked: ${text}`)
    return notify({ key: `kick:${botId}:${text.slice(0, 120)}`, title: 'Bot kicked', description: `**${botId}** was kicked.\n\nReason: ${text}`, color: 0xdc2626, cooldownMs: 30000 })
  }
  function onDisconnect(botId, reason, manual = false) {
    if (manual) return Promise.resolve(false)
    return notify({ key: `disconnect:${botId}`, title: 'Bot disconnected', description: `**${botId}** disconnected.\nReason: ${clampText(reason || 'Unknown', 1600)}`, color: 0xf97316, cooldownMs: 60000 })
  }
  function onRecovered(botId, attempts) {
    if (!attempts) return Promise.resolve(false)
    return notify({ key: `recovered:${botId}`, title: 'Bot recovered', description: `**${botId}** reconnected successfully after ${attempts} reconnect attempt(s).`, color: 0x22c55e, cooldownMs: 30000 })
  }
  function onReconnectExhausted(botId, max) {
    return notify({ key: `reconnect-exhausted:${botId}`, title: 'Bot permanently offline', description: `**${botId}** reached the reconnect limit (${max}) and needs attention.`, color: 0xdc2626, critical: true, cooldownMs: 300000 })
  }
  function onProxyStall(botId, seconds) {
    return notify({ key: `proxy-stall:${botId}`, title: 'Proxy stall watchdog', description: `**${botId}** received no data for ${seconds}s and is being force-reconnected.`, color: 0xf59e0b, cooldownMs: 300000 })
  }
  function onSecurityLockout(ip) {
    return notify({ key: `web-lockout:${ip}`, title: 'Web console login lockout', description: `Too many failed dashboard logins from **${clampText(ip, 120)}**.`, color: 0xdc2626, critical: true, cooldownMs: 600000 })
  }
  function onFatal(kind, details) {
    return notify({ key: `fatal:${kind}`, title: `Bot process ${kind}`, description: clampText(details, 3500), color: 0xdc2626, critical: true, cooldownMs: 60000 })
  }
  let timer = null
  if (cfg.memoryEnabled) {
    timer = setInterval(checkMemory, cfg.memoryIntervalMs)
    if (timer.unref) timer.unref()
    setTimeout(checkMemory, 1000).unref?.()
  }
  return { cfg, notify, checkMemory, getMemorySnapshot: () => ({ ...memory }), inspectServerMessage, onKick, onBan, onAuthFailure, onDisconnect, onRecovered, onReconnectExhausted, onProxyStall, onSecurityLockout, onFatal, stop: () => timer && clearInterval(timer) }
}

module.exports = { createMonitoring, classifyKick, chatText, parseBanDuration }
