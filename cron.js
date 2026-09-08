'use strict'

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

function parseSchedule (schedule) {
  const s = String(schedule || '').trim()
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

class CronManager {
  constructor ({ dispatch, log } = {}) {
    if (typeof dispatch !== 'function') throw new Error('CronManager requires a dispatch function')
    this.dispatch = dispatch
    this.log = typeof log === 'function' ? log : () => {}
    this.jobs = []
    this.nextId = 1
    this.timer = null
  }

  add (schedule, command) {
    const spec = parseSchedule(schedule)
    const cmd = String(command || '').trim()
    if (!cmd) throw new Error('Command is empty')
    const job = {
      id: String(this.nextId++),
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

  remove (id) {
    const idx = this.jobs.findIndex(j => j.id === String(id))
    if (idx < 0) return false
    this.jobs.splice(idx, 1)
    return true
  }

  setEnabled (id, enabled) {
    const job = this.jobs.find(j => j.id === String(id))
    if (!job) return false
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
  }

  // Load CRON_JOB_<N>="<schedule>|<command>" entries from an env-like object.
  loadFromEnv (env = process.env, prefix = 'CRON_JOB_') {
    let loaded = 0
    for (let i = 1; i < 1000; i++) {
      const raw = env[prefix + i]
      if (raw === undefined || raw === null) continue
      const sep = String(raw).indexOf('|')
      if (sep < 0) {
        this.log(`{red-fg}✗ ${prefix}${i} ignored — missing "|" separator, expected "<schedule>|<command>"{/red-fg}`)
        continue
      }
      const schedule = String(raw).slice(0, sep).trim()
      const command = String(raw).slice(sep + 1).trim()
      try {
        this.add(schedule, command)
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

module.exports = { CronManager, parseSchedule, matches, nextCronRun }