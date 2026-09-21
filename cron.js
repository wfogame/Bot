'use strict'

const fs = require('fs')
const path = require('path')

// Minimal cron scheduler for bot.js — no external dependencies.
//
// Schedule formats accepted everywhere (terminal /cron and .env CRON_JOB_<N>):
//   "0 4 * * *"    standard 5-field cron: minute hour day-of-month month day-of-week
//                  (day-of-week 0-6, 0 = Sunday; 7 is accepted as Sunday too)
//   "@every 30"    every 30 seconds (minimum 5 seconds)
//
// Field syntax: * | */n | a-b | a-b/n | value | comma-separated combinations.
// When BOTH day-of-month and day-of-week are restricted, cron fires when EITHER
// matches (classic cron OR semantics).
//
// Jobs added at runtime with `/cron add` are saved to CRON_STATE_FILE (default
// cron-jobs.json) and reloaded on startup, so they survive a restart.

function parseField (field, min, max, name) {
  const s = String(field).trim()
  if (s === '*') return null
  const values = new Set()
  for (const part of s.split(',')) {
    const m = part.match(/^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/)
    if (!m) throw new Error(`Invalid ${name} field "${field}"`)
    let start
    let end
    if (m[1] === '*') {
      start = min
      end = max
    } else if (m[1].includes('-')) {
      const [a, b] = m[1].split('-').map(Number)
      start = a
      end = b
    } else {
      start = end = Number(m[1])
    }
    const step = m[2] ? Number(m[2]) : 1
    if (step < 1) throw new Error(`Invalid step in ${name} field "${field}"`)
    if (start < min || end > max || start > end) throw new Error(`Value out of range in ${name} field "${field}" (allowed ${min}-${max})`)
    for (let v = start; v <= end; v += step) values.add(v)
  }
  return values
}

function stripQuotes (str) {
  let s = String(str || '').trim()
  while ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    if (s.length < 2) break
    s = s.slice(1, -1).trim()
  }
  if (s.startsWith('"') || s.startsWith("'")) s = s.slice(1).trim()
  if (s.endsWith('"') || s.endsWith("'")) s = s.slice(0, -1).trim()
  return s
}

function parseSchedule (schedule) {
  const s = stripQuotes(schedule)
  if (!s) throw new Error('Schedule is empty')
  if (/^@every\b/i.test(s)) {
    const secs = Number(s.split(/\s+/)[1])
    if (!Number.isFinite(secs) || secs < 5) throw new Error('@every needs a number of seconds >= 5 (e.g. "@every 60")')
    return { type: 'interval', seconds: Math.floor(secs) }
  }
  const fields = s.split(/\s+/)
  if (fields.length !== 5) throw new Error(`Cron schedule needs 5 fields (minute hour day month weekday), got ${fields.length}: "${s}"`)
  const [minute, hour, dom, month, dow] = fields
  const dowValues = parseField(dow, 0, 7, 'day-of-week')
  if (dowValues && dowValues.has(7)) { dowValues.delete(7); dowValues.add(0) }
  return {
    type: 'cron',
    minute: parseField(minute, 0, 59, 'minute'),
    hour: parseField(hour, 0, 23, 'hour'),
    dom: parseField(dom, 1, 31, 'day-of-month'),
    month: parseField(month, 1, 12, 'month'),
    dow: dowValues
  }
}

function matches (spec, date) {
  if (spec.type === 'interval') return true
  const inSet = (set, v) => set === null || set.has(v)
  if (!inSet(spec.minute, date.getMinutes())) return false
  if (!inSet(spec.hour, date.getHours())) return false
  if (!inSet(spec.month, date.getMonth() + 1)) return false
  const dayOfWeek = date.getDay()
  if (spec.dom !== null && spec.dow !== null) {
    // Both restricted → fire when either matches.
    return inSet(spec.dom, date.getDate()) || inSet(spec.dow, dayOfWeek)
  }
  return inSet(spec.dom, date.getDate()) && inSet(spec.dow, dayOfWeek)
}

function nextCronRun (spec, from = new Date()) {
  if (spec.type === 'interval') return new Date(from.getTime() + spec.seconds * 1000)
  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  // Scan up to ~3 years ahead; a valid schedule always matches within a year.
  for (let i = 0; i < 60 * 24 * 366 * 3; i++) {
    d.setMinutes(d.getMinutes() + 1)
    if (matches(spec, d)) return new Date(d.getTime())
  }
  return null
}

// Jobs are kept in memory and, when a state file is configured, mirrored to
// disk after every change so `/cron add` survives a restart (CRON_JOB_<N> in
// .env is still loaded first and always wins on an exact schedule+command
// duplicate, so env can be used to pin a job while the file holds the rest).
class CronManager {
  constructor ({ dispatch, log, stateFile = '' } = {}) {
    if (typeof dispatch !== 'function') throw new Error('CronManager requires a dispatch function')
    this.dispatch = dispatch
    this.log = typeof log === 'function' ? log : () => {}
    this.jobs = []
    this.nextId = 1
    this.timer = null
    this.stateFile = String(stateFile || '').trim()
  }

  // Internal add: validates, assigns the next free id, no disk write. Used by
  // the loader paths (env and state file), which must never rewrite the file.
  _add (schedule, command, preferredId = null) {
    const spec = parseSchedule(schedule)
    const cmd = String(command || '').trim()
    if (!cmd) throw new Error('Command is empty')
    let id = preferredId === null || preferredId === undefined ? '' : String(preferredId)
    if (id && this.jobs.some(j => j.id === id)) id = ''
    if (!id) id = String(this.nextId)
    const numeric = Number(id)
    if (Number.isFinite(numeric) && numeric >= this.nextId) this.nextId = Math.floor(numeric) + 1
    const job = {
      id,
      schedule: String(schedule).trim(),
      spec,
      command: cmd,
      enabled: true,
      lastRun: null,
      nextRun: null,
      runs: 0,
      running: false
    }
    job.nextRun = this._computeNext(job)
    this.jobs.push(job)
    return job
  }

  add (schedule, command) {
    const job = this._add(schedule, command)
    this.save()
    return job
  }

  remove (id) {
    const idx = this.jobs.findIndex(j => j.id === String(id))
    if (idx < 0) return false
    this.jobs.splice(idx, 1)
    this.save()
    return true
  }

  setEnabled (id, enabled) {
    const job = this.jobs.find(j => j.id === String(id))
    if (!job) return false
    job.enabled = !!enabled
    job.nextRun = this._computeNext(job)
    this.save()
    return true
  }

  // Writes the job config (schedule/command/enabled/id) to the state file.
  // Called automatically after every add/remove/setEnabled/clear.
  // Runtime counters (runs, lastRun) are not persisted — the point is that a
  // restart keeps your jobs, not that it resumes tick counters. Never throws:
  // a read-only or missing directory must not take the bot down.
  save (file = this.stateFile) {
    const target = String(file || '').trim()
    if (!target) return false
    try {
      const dir = path.dirname(path.resolve(target))
      fs.mkdirSync(dir, { recursive: true })
      const payload = {
        version: 1,
        savedAt: new Date().toISOString(),
        jobs: this.jobs.map(job => ({ id: job.id, schedule: job.schedule, command: job.command, enabled: job.enabled }))
      }
      const tmp = `${path.resolve(target)}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n')
      fs.renameSync(tmp, path.resolve(target))
      return true
    } catch (err) {
      this.log(`{yellow-fg}⚠ Could not save cron jobs to ${target}: ${err && err.message ? err.message : err}{/yellow-fg}`)
      return false
    }
  }

  // Restores jobs saved by save(). Missing file is normal (first run). Jobs
  // whose schedule+command already came from CRON_JOB_<N> are skipped so the
  // two sources cannot double-register the same job. Loading never writes: the
  // file is only rewritten by a real mutation (add/remove/on/off/clear), so a
  // failed or partial load can never clobber a working state file.
  loadFromFile (file = this.stateFile) {
    const target = String(file || '').trim()
    if (!target) return 0
    let raw
    try {
      raw = fs.readFileSync(path.resolve(target), 'utf8')
    } catch (_) {
      return 0
    }
    let payload
    try {
      payload = JSON.parse(raw)
    } catch (err) {
      this.log(`{red-fg}✗ ${target} is not valid JSON (${err && err.message ? err.message : err}) — saved cron jobs were ignored{/red-fg}`)
      return 0
    }
    const entries = Array.isArray(payload) ? payload : (Array.isArray(payload && payload.jobs) ? payload.jobs : [])
    let loaded = 0
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      const schedule = stripQuotes(entry.schedule)
      const command = stripQuotes(entry.command)
      if (!schedule || !command) continue
      if (this.jobs.some(j => j.schedule === schedule && j.command === command)) continue
      try {
        const job = this._add(schedule, command, entry.id)
        if (entry.enabled === false) this.setEnabledSilently(job, false)
        loaded++
      } catch (err) {
        this.log(`{red-fg}✗ Saved cron job ignored — ${err && err.message ? err.message : err}{/red-fg}`)
      }
    }
    return loaded
  }

  // setEnabled without a disk write, for use while loading.
  setEnabledSilently (job, enabled) {
    job.enabled = !!enabled
    job.nextRun = this._computeNext(job)
    return true
  }

  // Run a job immediately (works even when disabled — handy for testing).
  runNow (id) {
    const job = this.jobs.find(j => j.id === String(id))
    if (!job) return { ok: false, error: `no cron job with id ${id}` }
    if (job.running) return { ok: false, error: `job ${id} is already running` }
    this._fire(job)
    return { ok: true }
  }

  list () {
    return this.jobs.map(j => ({ ...j }))
  }

  clear () {
    this.jobs = []
    this.save()
  }

  // Load CRON_JOB_<N>="<schedule>|<command>" entries from an env-like object.
  loadFromEnv (env = process.env, prefix = 'CRON_JOB_') {
    let loaded = 0
    for (let i = 1; i < 1000; i++) {
      const val = env[prefix + i]
      if (val === undefined || val === null) continue
      const raw = String(val).trim()
      const sep = raw.indexOf('|')
      if (sep < 0) {
        this.log(`{red-fg}✗ ${prefix}${i} ignored — missing "|" separator, expected "<schedule>|<command>"{/red-fg}`)
        continue
      }
      const schedule = stripQuotes(raw.slice(0, sep))
      const command = stripQuotes(raw.slice(sep + 1))
      try {
        this._add(schedule, command)
        loaded++
      } catch (err) {
        this.log(`{red-fg}✗ ${prefix}${i} ignored — ${err && err.message ? err.message : err}{/red-fg}`)
      }
    }
    return loaded
  }

  start (tickMs = 1000) {
    if (this.timer) return
    this.timer = setInterval(() => this._tick(), tickMs)
    if (this.timer.unref) this.timer.unref()
  }

  stop () {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  _computeNext (job) {
    if (!job.enabled) return null
    const now = Date.now()
    if (job.spec.type === 'interval') {
      const base = job.lastRun ? job.lastRun.getTime() : now
      return new Date(Math.max(now, base) + job.spec.seconds * 1000)
    }
    return nextCronRun(job.spec, new Date(now))
  }

  _tick () {
    const now = Date.now()
    for (const job of this.jobs) {
      if (!job.enabled || job.running) continue
      if (job.nextRun !== null && now >= job.nextRun.getTime()) this._fire(job)
    }
  }

  _fire (job) {
    job.running = true
    job.lastRun = new Date()
    job.runs++
    job.nextRun = this._computeNext(job)
    this.log(`{cyan-fg}› Cron job ${job.id} (${job.schedule}) firing: ${job.command}{/cyan-fg}`)
    let result
    try {
      result = this.dispatch(job.command, job)
    } catch (err) {
      job.running = false
      this.log(`{red-fg}✗ Cron job ${job.id} (${job.command}) failed: ${err && err.message ? err.message : err}{/red-fg}`)
      return
    }
    Promise.resolve(result).catch(err => {
      this.log(`{red-fg}✗ Cron job ${job.id} (${job.command}) failed: ${err && err.message ? err.message : err}{/red-fg}`)
    }).finally(() => { job.running = false })
  }
}

// A cron command may optionally target one or more bot names:
//   @Hypr_7_core /spawners
//   @BotA,BotB /spawners
// Without this prefix, callers retain the existing all-bots behavior.
// `@every` is a schedule token, never a bot target.
function parseBotTargetCommand (command) {
  const text = String(command || '').trim()
  if (/^@every\b/i.test(text)) return { botIds: null, command: text }
  const match = text.match(/^@([A-Za-z0-9_.-]+(?:,[A-Za-z0-9_.-]+)*)\s+([\s\S]+)$/)
  if (!match) return { botIds: null, command: text }
  return {
    botIds: match[1].split(',').map(s => s.trim()).filter(Boolean),
    command: match[2].trim()
  }
}

// Case-insensitive roster lookup so `@hypr_7_core` still finds `Hypr_7_core`.
// Returns the real roster key, or null when nothing matches.
function matchBotName (name, roster = []) {
  const want = String(name || '').trim().toLowerCase()
  if (!want) return null
  return roster.find(id => String(id).toLowerCase() === want) || null
}

// Parses the arguments of `/cron add`. The schedule is either a quoted token or
// the next 5 fields (`@every <secs>` is two); everything after it is the job
// command, kept verbatim so chained commands (`&& sleep 5s && /dump`) survive.
// The bot-target prefix may sit on EITHER side of the schedule:
//   /cron add @every 300 @BotA /spawners
//   /cron add @BotA @every 300 /spawners
//   /cron add "0 4 * * *" /crates-all
function parseCronAddArgs (rest) {
  let text = String(rest || '').trim()
  if (!text) throw new Error('Usage: /cron add <schedule> <command>')

  let leadTarget = ''
  const leading = text.match(/^@([A-Za-z0-9_.-]+(?:,[A-Za-z0-9_.-]+)*)\s+([\s\S]+)$/)
  if (leading && !/^every$/i.test(leading[1])) {
    leadTarget = leading[1]
    text = leading[2].trim()
  }

  let schedule = ''
  let command = ''
  const quoted = text.match(/^"([^"]*)"\s*([\s\S]*)$/) || text.match(/^'([^']*)'\s*([\s\S]*)$/)
  if (quoted) {
    schedule = quoted[1].trim()
    command = quoted[2].trim()
  } else {
    const tokens = text.split(/\s+/)
    if (/^@every$/i.test(tokens[0] || '')) {
      schedule = tokens.slice(0, 2).join(' ')
      command = tokens.slice(2).join(' ')
    } else {
      schedule = tokens.slice(0, 5).join(' ')
      command = tokens.slice(5).join(' ')
    }
  }

  if (!schedule) throw new Error('Missing schedule — use 5-field cron ("0 4 * * *") or "@every <seconds>"')
  parseSchedule(schedule) // throws with a specific reason when invalid
  if (!command) throw new Error(`Missing command after the schedule "${schedule}"`)
  if (leadTarget) command = `@${leadTarget} ${command}`
  return { schedule, command }
}

module.exports = {
  CronManager,
  parseSchedule,
  matches,
  nextCronRun,
  parseBotTargetCommand,
  matchBotName,
  parseCronAddArgs
}
