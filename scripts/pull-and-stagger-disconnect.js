'use strict'

// Pull the latest code, then disconnect the currently online bots one at a time
// over a randomized 4–12 minute window. The dashboard's existing /disconnect
// command is used so each bot's automatic reconnect is disabled as well.
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const DEFAULT_MIN_WINDOW_MS = 4 * 60_000
const DEFAULT_MAX_WINDOW_MS = 12 * 60_000
const DEFAULT_MIN_GAP_MS = 1_000

function numberEnv (value, fallback, minimum) {
  const n = Number(value)
  return Number.isFinite(n) && n >= minimum ? n : fallback
}

function randomInt (min, max, random = Math.random) {
  if (max <= min) return min
  return min + Math.floor(random() * (max - min + 1))
}

function shuffle (items, random = Math.random) {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const temp = out[i]
    out[i] = out[j]
    out[j] = temp
  }
  return out
}

// Creates one randomized order and one randomized offset per bot. Offsets are
// kept roughly even so a random draw cannot accidentally create a burst of 50
// requests, while the order itself remains unpredictable.
function buildSchedule (ids, {
  minWindowMs = DEFAULT_MIN_WINDOW_MS,
  maxWindowMs = DEFAULT_MAX_WINDOW_MS,
  minGapMs = DEFAULT_MIN_GAP_MS,
  random = Math.random
} = {}) {
  const order = shuffle(ids, random)
  if (order.length === 0) return []

  const lowerWindowMs = Math.max(0, minWindowMs)
  const upperWindowMs = Math.max(lowerWindowMs, maxWindowMs)
  const gapMs = Math.max(0, minGapMs)
  const requiredWindowMs = gapMs * (order.length - 1)
  const windowMs = Math.max(requiredWindowMs, randomInt(lowerWindowMs, upperWindowMs, random))
  if (order.length === 1) return [{ id: order[0], offsetMs: randomInt(0, windowMs, random) }]

  const spacing = windowMs / (order.length - 1)
  const jitter = spacing * 0.42
  let previous = -gapMs

  return order.map((id, index) => {
    const center = spacing * index
    const candidate = center + ((random() * 2) - 1) * jitter
    const offsetMs = Math.min(windowMs, Math.max(previous + gapMs, Math.round(candidate)))
    previous = offsetMs
    return { id, offsetMs }
  })
}

function parseArgs (argv) {
  const args = new Set(argv.slice(2))
  return { dryRun: args.has('--dry-run') }
}

function pullRepository () {
  console.log('[pull-disconnect] pulling latest changes (fast-forward only)…')
  try {
    execFileSync('git', ['pull', '--ff-only'], { stdio: 'inherit' })
  } catch (err) {
    throw new Error(`git pull failed; no bots were disconnected (${err.status == null ? err.message : `exit ${err.status}`})`)
  }
}

function loadEnvFile (file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (!match || process.env[match[1]] !== undefined) continue
      let value = match[2]
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      process.env[match[1]] = value
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

function loadConfig () {
  loadEnvFile(process.env.ENV_FILE || path.join(process.cwd(), '.env'))
  const password = process.env.WEB_PASSWORD
  if (!password) {
    throw new Error('WEB_PASSWORD is required. The app generates an undiscoverable random password when it is unset.')
  }

  return {
    password,
    host: process.env.CONTROL_HOST || '127.0.0.1',
    port: numberEnv(process.env.CONTROL_PORT || process.env.WEB_PORT, 80, 1),
    attempts: numberEnv(process.env.WEB_PORT_MAX_ATTEMPTS, 20, 1),
    minWindowMs: numberEnv(process.env.DISCONNECT_MIN_WINDOW_MS, DEFAULT_MIN_WINDOW_MS, 0),
    maxWindowMs: numberEnv(process.env.DISCONNECT_MAX_WINDOW_MS, DEFAULT_MAX_WINDOW_MS, 0),
    minGapMs: numberEnv(process.env.DISCONNECT_MIN_GAP_MS, DEFAULT_MIN_GAP_MS, 0)
  }
}

async function request (url, options = {}) {
  const response = await fetch(url, { redirect: 'manual', ...options })
  const text = await response.text()
  return { response, text }
}

async function findDashboard (config) {
  for (let i = 0; i < config.attempts; i++) {
    const port = config.port + i
    try {
      const health = await fetch(`http://${config.host}:${port}/health`, { signal: AbortSignal.timeout(5_000) })
      if (health.ok) return `http://${config.host}:${port}`
    } catch (_) {}
  }
  throw new Error(`could not find the dashboard on ${config.host}:${config.port}-${config.port + config.attempts - 1}`)
}

function sessionCookie (response) {
  const header = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()[0]
    : response.headers.get('set-cookie')
  const match = header && header.match(/(?:^|,\s*)sid=([^;]+)/)
  return match ? `sid=${match[1]}` : null
}

async function login (base, password) {
  const { response } = await request(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password })
  })
  const cookie = sessionCookie(response)
  if (response.status !== 303 || !cookie) throw new Error('dashboard login failed; check WEB_PASSWORD')
  return cookie
}

async function dashboardState (base, cookie) {
  const { response, text } = await request(`${base}/api/state?view=all`, {
    headers: { cookie }
  })
  if (!response.ok) throw new Error(`dashboard state request failed (${response.status})`)
  try {
    return JSON.parse(text)
  } catch (_) {
    throw new Error('dashboard returned invalid state JSON')
  }
}

async function disconnect (base, cookie, id) {
  const { response, text } = await request(`${base}/api/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text: '/disconnect', selectedId: id })
  })
  if (!response.ok && response.status !== 202) {
    throw new Error(`command request failed (${response.status}): ${text.slice(0, 120)}`)
  }
}

async function main () {
  const { dryRun } = parseArgs(process.argv)
  if (!dryRun) pullRepository()

  const config = loadConfig()
  const base = await findDashboard(config)
  const cookie = await login(base, config.password)
  const state = await dashboardState(base, cookie)
  const online = Array.isArray(state.bots) ? state.bots.filter(bot => bot && bot.online && bot.id).map(bot => bot.id) : []
  const schedule = buildSchedule(online, config)

  console.log(`[pull-disconnect] ${dryRun ? 'dry run: ' : ''}${online.length} online bot(s); randomized window ${config.minWindowMs / 60_000}-${config.maxWindowMs / 60_000} minutes`)
  if (schedule.length === 0) {
    console.log('[pull-disconnect] no online bots found')
    return
  }

  const startedAt = Date.now()
  let cursor = 0
  let timer = null
  let stopped = false

  const stop = () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  await new Promise(resolve => {
    const runNext = () => {
      if (stopped || cursor >= schedule.length) {
        resolve()
        return
      }
      const item = schedule[cursor++]
      const waitMs = Math.max(0, item.offsetMs - (Date.now() - startedAt))
      timer = setTimeout(async () => {
        timer = null
        const elapsed = Math.round((Date.now() - startedAt) / 1000)
        try {
          if (!dryRun) await disconnect(base, cookie, item.id)
          console.log(`[pull-disconnect] ${dryRun ? 'would disconnect' : 'disconnected'} ${item.id} at +${elapsed}s`)
        } catch (err) {
          console.error(`[pull-disconnect] ${item.id}: ${err.message}`)
        }
        runNext()
      }, waitMs)
    }
    runNext()
  })

  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  if (stopped) console.log('[pull-disconnect] stopped; no further bots will be disconnected')
  else console.log('[pull-disconnect] schedule complete')
}

module.exports = { buildSchedule, shuffle, randomInt }

if (require.main === module) {
  main().catch(err => {
    console.error(`[pull-disconnect] ${err.message}`)
    process.exitCode = 1
  })
}
