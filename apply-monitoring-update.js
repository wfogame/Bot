#!/usr/bin/env node
"use strict"

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const root = process.cwd()
const botPath = path.join(root, 'bot.js')
const envPath = path.join(root, '.env.example')
const readmePath = path.join(root, 'README.md')
const monitoringSource = path.join(__dirname, 'monitoring.js')
const monitoringTarget = path.join(root, 'monitoring.js')

function fail(message) { console.error(`ERROR: ${message}`); process.exit(1) }
function replaceOnce(text, needle, replacement, label) {
  const count = text.split(needle).length - 1
  if (count !== 1) fail(`${label}: expected exactly one anchor, found ${count}. No files were changed.`)
  return text.replace(needle, replacement)
}
function insertBefore(text, needle, addition, label) { return replaceOnce(text, needle, addition + needle, label) }
function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.before-monitoring-${stamp}.bak`
  fs.copyFileSync(file, target)
  return target
}
function appendSection(text, marker, section) { return text.includes(marker) ? text : text.replace(/\s*$/, '') + '\n\n' + section.trim() + '\n' }

if (!fs.existsSync(botPath)) fail('Run this script from the repository root containing bot.js.')
if (!fs.existsSync(monitoringSource)) fail('monitoring.js must be next to this updater.')
let bot = fs.readFileSync(botPath, 'utf8')
if (bot.includes("require('./monitoring')")) fail('bot.js already appears to contain this monitoring update.')

bot = insertBefore(bot, "const net = require('net')\n", "const os = require('os')\nconst { createMonitoring } = require('./monitoring')\n", 'imports')

const logAnchor = "function logWarn(msg) { log(`{yellow-fg}⚠ ${msg}{/yellow-fg}`) }\n"
const init = `\n// Centralized Discord alerts and host memory/swap monitoring.\nlet monitoring\n`
bot = insertBefore(bot, logAnchor, init, 'monitoring declaration')

const statsReturn = "bots: Object.keys(bots).length, online: Object.values(bots).filter(b => b.bot && b.bot.entity).length\n"
bot = replaceOnce(bot, statsReturn, statsReturn.replace('\n', ',\n') + "memory: monitoring ? monitoring.getMemorySnapshot() : null\n", 'globalStats memory')

const afterStats = "}\nfunction botSnapshot() {"
const monitoringInit = `}\n\nmonitoring = createMonitoring({\n  logFor, systemId: SYSTEM_ID, sanitize,\n  getStats: () => globalStats(),\n  getBotCount: () => Object.keys(bots).length\n})\n\nfunction botSnapshot() {`
bot = replaceOnce(bot, afterStats, monitoringInit, 'monitoring initialization')

bot = replaceOnce(bot,
"try { logFor(SYSTEM_ID, `{red-fg}[UNCAUGHT] ${sanitize(err.stack || err.message)}{/red-fg}`) } catch (_) {}\n",
"try { logFor(SYSTEM_ID, `{red-fg}[UNCAUGHT] ${sanitize(err.stack || err.message)}{/red-fg}`); monitoring?.onFatal('uncaught exception', err.stack || err.message) } catch (_) {}\n",
'uncaught alert')
bot = replaceOnce(bot,
"try { logFor(SYSTEM_ID, `{red-fg}[UNHANDLED REJECTION] ${sanitize(reason instanceof Error ? reason.message : String(reason))}{/red-fg}`) } catch (_) {}\n",
"try { const detail = reason instanceof Error ? (reason.stack || reason.message) : String(reason); logFor(SYSTEM_ID, `{red-fg}[UNHANDLED REJECTION] ${sanitize(detail)}{/red-fg}`); monitoring?.onFatal('unhandled rejection', detail) } catch (_) {}\n",
'unhandled rejection alert')

bot = replaceOnce(bot,
"if (cnt >= WEB_LOGIN_MAX_FAILS) logFor(SYSTEM_ID, `{red-fg}✗ Web login locked out for ${ip} (10 min){/red-fg}`)\n",
"if (cnt >= WEB_LOGIN_MAX_FAILS) { logFor(SYSTEM_ID, `{red-fg}✗ Web login locked out for ${ip} (10 min){/red-fg}`); monitoring?.onSecurityLockout(ip) }\n",
'web lockout alert')

bot = replaceOnce(bot,
"e(`${id} reached max reconnects (${MAX_RECONNECT}). Disconnected permanently. Use /reconnect to try again.`)\nreturn\n",
"e(`${id} reached max reconnects (${MAX_RECONNECT}). Disconnected permanently. Use /reconnect to try again.`)\nmonitoring?.onReconnectExhausted(id, MAX_RECONNECT)\nreturn\n",
'reconnect exhausted alert')

bot = replaceOnce(bot,
"bot.once('spawn', () => {\nconnected = true\nif (bots[id]) bots[id].spawnTime = Date.now()\n",
"bot.once('spawn', () => {\nconnected = true\nconst recoveredAfter = bots[id]?.reconnectAttempts || 0\nif (bots[id]) bots[id].spawnTime = Date.now()\nmonitoring?.onRecovered(id, recoveredAfter)\n",
'recovery alert')

bot = replaceOnce(bot,
"bot.on('messagestr', (message) => {\nconst text = message.toLowerCase()\n",
"bot.on('messagestr', (message) => {\nconst text = message.toLowerCase()\nmonitoring?.inspectServerMessage(id, message)\n",
'server restart detector')

bot = replaceOnce(bot,
"e(`Kicked: ${sanitize(text)}`)\nnotifyBotsChanged()\n",
"e(`Kicked: ${sanitize(text)}`)\nmonitoring?.onKick(id, text)\nnotifyBotsChanged()\n",
'kick alert')

bot = replaceOnce(bot,
"scheduleReconnect('Connection lost', classificationReason)\nlastRawError = null\n",
"monitoring?.onDisconnect(id, classificationReason, manualDisconnect)\nscheduleReconnect('Connection lost', classificationReason)\nlastRawError = null\n",
'disconnect alert')

bot = replaceOnce(bot,
"console.warn(`[proxy-watchdog] \"${id}\" has received nothing for ${Math.round((now - entry.lastActivity) / 1000)}s — forcing reconnect.`)\nentry.forceKilled = true\n",
"const stalledSeconds = Math.round((now - entry.lastActivity) / 1000)\nconsole.warn(`[proxy-watchdog] \"${id}\" has received nothing for ${stalledSeconds}s — forcing reconnect.`)\nmonitoring?.onProxyStall(id, stalledSeconds)\nentry.forceKilled = true\n",
'proxy stall alert')

bot = replaceOnce(bot,
"logInfo(`Runtime: RSS ${s.rssMB}MB · heap ${s.heapMB}MB · event-loop lag ${s.evlLagMs}ms · logs ${s.logPerSec}/s · web viewers ${s.clients} · bots ${s.online}/${s.bots} online · uptime ${formatUptime(s.uptimeSec * 1000)}`)\n",
"const mem = s.memory\nconst hostMem = mem && mem.availablePct != null ? ` · host RAM free ${mem.availablePct.toFixed(1)}% · swap ${mem.swapPct.toFixed(1)}% · pressure ${mem.level}` : ''\nlogInfo(`Runtime: RSS ${s.rssMB}MB · heap ${s.heapMB}MB · event-loop lag ${s.evlLagMs}ms · logs ${s.logPerSec}/s · web viewers ${s.clients} · bots ${s.online}/${s.bots} online · uptime ${formatUptime(s.uptimeSec * 1000)}${hostMem}`)\n",
'stats memory output')

const backupPath = backup(botPath)
fs.copyFileSync(monitoringSource, monitoringTarget)
fs.writeFileSync(botPath, bot)

if (fs.existsSync(envPath)) {
  let env = fs.readFileSync(envPath, 'utf8')
  env = appendSection(env, '# Discord and memory monitoring', `# Discord and memory monitoring\nDISCORD_NOTIFICATIONS=true\nDISCORD_WEBHOOK_URL=\nDISCORD_USER_ID=\nDISCORD_MENTION_CRITICAL_ONLY=false\nDISCORD_MIN_SEND_INTERVAL_MS=1200\nDISCORD_EVENT_COOLDOWN_MS=60000\nSERVER_RESTART_ALERT_COOLDOWN_MS=120000\n\nMEMORY_WATCHDOG=true\nMEMORY_CHECK_INTERVAL_MS=30000\nMEMORY_AVAILABLE_WARN_PERCENT=15\nMEMORY_AVAILABLE_CRITICAL_PERCENT=8\nSWAP_WARN_PERCENT=10\nSWAP_WARN_MIB=256\nMEMORY_ALERT_COOLDOWN_MS=900000\nMEMORY_RECOVERY_PERCENT=20`)
  fs.writeFileSync(envPath, env)
}
if (fs.existsSync(readmePath)) {
  let readme = fs.readFileSync(readmePath, 'utf8')
  readme = appendSection(readme, '## Discord Alerts and Memory Watchdog', `## Discord Alerts and Memory Watchdog\n\nThe main bot runner can send Discord webhook alerts for 30-second server restart warnings, kicks, unexpected disconnects, successful recovery, exhausted reconnect limits, proxy stalls, dashboard login lockouts, fatal process errors, and host memory pressure. Set \`DISCORD_WEBHOOK_URL\` and \`DISCORD_USER_ID\` in \`.env\`.\n\nThe restart detector requires both the case-insensitive phrase \`SERVER WILL RESTART IN\` and the standalone number \`30\` in the same server message. Duplicate alerts are suppressed for the configured cooldown.\n\nThe memory watchdog uses Linux \`/proc/meminfo\` where available so container/host memory availability and swap usage can be monitored. It falls back to Node's OS memory counters on other platforms. Alerts are stateful, rate-limited, and followed by a recovery notice once available memory returns above \`MEMORY_RECOVERY_PERCENT\`.`)
  fs.writeFileSync(readmePath, readme)
}

console.log(`Updated bot.js successfully. Backup: ${backupPath}`)
console.log(`New SHA-256: ${crypto.createHash('sha256').update(bot).digest('hex')}`)
console.log('Run: node --check bot.js && node --check monitoring.js')
