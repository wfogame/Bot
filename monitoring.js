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
    eventCooldownMs: envInt('DISCORD_EVENT_COOLDOWN_MS', 60000, 1000)
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
  function onKick(botId, reason) {
    const text = clampText(reason || 'Unknown reason', 2000)
    const severe = /bann|blacklist|suspend|blocked|alt detected|anti.?bot/i.test(text)
    local('error', `${botId} kicked: ${text}`)
    return notify({ key: `kick:${botId}:${text.slice(0, 120)}`, title: severe ? 'Critical bot kick' : 'Bot kicked', description: `**${botId}** was kicked.\n\nReason: ${text}`, color: 0xdc2626, critical: severe, cooldownMs: 30000 })
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
  return { cfg, notify, checkMemory, getMemorySnapshot: () => ({ ...memory }), inspectServerMessage, onKick, onDisconnect, onRecovered, onReconnectExhausted, onProxyStall, onSecurityLockout, onFatal, stop: () => timer && clearInterval(timer) }
}

module.exports = { createMonitoring }
