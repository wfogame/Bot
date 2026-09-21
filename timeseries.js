'use strict'

/**
 * Time-series collection for the data folder.
 *
 * One JSON line per sample in `data/timeseries.jsonl`, so the history is
 * append-only and can be read by anything — jq, a spreadsheet, pandas — without
 * going through this program. Sampling happens on an interval, on demand, and
 * after the routines that already query the server, so a shard count is never
 * sampled by a second round of commands.
 *
 * A sample is a point in time, not a state: the same bot appears many times,
 * and the "current" value is simply the last one.
 */

const METRICS = ['shards', 'coins', 'balance', 'rank', 'banned', 'invUsed', 'invFree']

function numeric (value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A per-bot sample. Only defined fields are kept, so a partial pass still records what it knows. */
function botSample (row, t = Date.now()) {
  const sample = { t, kind: 'bot', bot: row.bot }
  for (const key of METRICS) {
    if (row[key] === undefined) continue
    sample[key] = key === 'rank' ? (row[key] || 'N/A') : key === 'banned' ? Boolean(row[key]) : numeric(row[key])
  }
  if (row.source) sample.source = row.source
  return sample
}

/** Fleet totals at one instant — what the graph's "whole operation" line shows. */
function fleetSample (rows, t = Date.now(), source = 'fleet') {
  const sample = { t, kind: 'fleet', bots: rows.length, source }
  for (const key of ['shards', 'coins', 'balance', 'invUsed', 'invFree']) {
    const values = rows.map(r => numeric(r[key])).filter(v => v !== null)
    sample[key] = values.length ? values.reduce((sum, v) => sum + v, 0) : null
  }
  const ranks = rows.map(r => r.rank).filter(Boolean)
  sample.regents = ranks.filter(r => /regent/i.test(r)).length
  sample.banned = rows.filter(r => r.banned).length
  return sample
}

function createTimeseriesStore (opts = {}) {
  const file = opts.file
  const fs = opts.fs || require('fs')
  const path = opts.path || require('path')
  const maxRecords = opts.maxRecords || 500000
  const rotateAt = opts.rotateAt || 1000000
  let records = null

  function load () {
    if (records) return records
    records = []
    try {
      const text = fs.readFileSync(file, 'utf8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const row = JSON.parse(trimmed)
          if (row && typeof row.t === 'number') records.push(row)
        } catch (_) {}
      }
    } catch (_) { records = [] }
    if (records.length > maxRecords) records = records.slice(-maxRecords)
    return records
  }

  function append (sample) {
    load()
    records.push(sample)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      if (records.length > rotateAt) {
        // Rewrite instead of letting one file grow forever; the window is kept.
        fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n')
      } else {
        fs.appendFileSync(file, JSON.stringify(sample) + '\n')
      }
    } catch (_) {}
    return sample
  }

  function all () { return load() }

  function since (ts, filter = {}) {
    return load().filter(row =>
      row.t >= ts &&
      (!filter.kind || row.kind === filter.kind) &&
      (!filter.bot || row.bot === filter.bot)
    )
  }

  function clear () {
    records = []
    try { fs.rmSync(file, { force: true }) } catch (_) {}
  }

  /**
   * Buckets a metric into fixed windows for graphing. Each bucket reports the
   * last reading (what the value *was*), plus min/max so a spike that happened
   * between samples is visible rather than smoothed away.
   */
  function bucket (metric, { bucketMs = 3600000, since: from = 0, bot = null, kind = null, limit = 500 } = {}) {
    const rows = load().filter(row => row.t >= from && (!bot || row.bot === bot) && (!kind || row.kind === kind))
    const buckets = new Map()
    for (const row of rows) {
      const value = metric === 'rank' ? row.rank
        : metric === 'banned' ? (row.banned === undefined ? undefined : row.banned ? 1 : 0)
          : numeric(row[metric])
      if (value === undefined || value === null || value === '') continue
      const key = Math.floor(row.t / bucketMs) * bucketMs
      const b = buckets.get(key) || { t: key, last: value, first: value, min: value, max: value, count: 0, sum: 0 }
      b.last = value
      b.count++
      if (typeof value === 'number') {
        b.min = typeof b.min === 'number' ? Math.min(b.min, value) : value
        b.max = typeof b.max === 'number' ? Math.max(b.max, value) : value
        b.sum += value
        b.mean = b.sum / b.count
      }
      buckets.set(key, b)
    }
    return [...buckets.values()].sort((a, b) => a.t - b.t).slice(-limit)
  }

  /** First/last/min/max/delta/per-hour for one metric — the headline numbers. */
  function summarize (metric, opts2 = {}) {
    const rows = load().filter(row => (!opts2.bot || row.bot === opts2.bot) && row.t >= (opts2.since || 0))
    const points = []
    for (const row of rows) {
      const value = metric === 'rank' ? row.rank : numeric(row[metric])
      if (value === null || value === undefined || value === '') continue
      points.push({ t: row.t, value })
    }
    if (!points.length) return null
    const numbers = points.filter(p => typeof p.value === 'number').map(p => p.value)
    const first = points[0]
    const last = points[points.length - 1]
    const spanMs = last.t - first.t
    const out = {
      metric,
      bot: opts2.bot || null,
      from: first.t,
      to: last.t,
      samples: points.length,
      first: first.value,
      last: last.value,
      points
    }
    if (numbers.length) {
      out.min = Math.min(...numbers)
      out.max = Math.max(...numbers)
      out.mean = numbers.reduce((sum, v) => sum + v, 0) / numbers.length
      out.delta = typeof last.value === 'number' && typeof first.value === 'number' ? last.value - first.value : null
      out.perHour = out.delta != null && spanMs > 0 ? out.delta / (spanMs / 3600000) : null
    }
    return out
  }

  /**
   * Discrete things that happened, read out of the samples themselves: a ban
   * appearing, a ban lifting, a rank changing. Deriving them from samples keeps
   * one source of truth — there is no second event log to fall out of sync.
   */
  function events (opts2 = {}) {
    const rows = load().filter(row => row.kind === 'bot' && row.t >= (opts2.since || 0))
    const byBot = new Map()
    for (const row of rows) {
      if (!byBot.has(row.bot)) byBot.set(row.bot, [])
      byBot.get(row.bot).push(row)
    }
    const bans = []
    const ranks = []
    for (const [bot, samples] of byBot) {
      samples.sort((a, b) => a.t - b.t)
      // The first sample of a series is a baseline, not an event: a bot that was
      // already a Member when tracking started did not "change" to Member. A ban
      // present in the very first sample is the exception — that is a fact worth
      // recording with the time we first saw it.
      let banned
      let rank
      for (const sample of samples) {
        const nowBanned = sample.banned === undefined ? null : Boolean(sample.banned)
        if (nowBanned !== null && nowBanned !== banned) {
          if (banned !== undefined || nowBanned === true) {
            bans.push({ bot, t: sample.t, banned: nowBanned, kind: sample.bannedKind || null })
          }
          banned = nowBanned
        }
        if (sample.rank && sample.rank !== rank) {
          if (rank !== undefined) ranks.push({ bot, t: sample.t, rank: sample.rank, previous: rank })
          rank = sample.rank
        }
      }
    }
    return {
      bans: bans.sort((a, b) => a.t - b.t),
      ranks: ranks.sort((a, b) => a.t - b.t)
    }
  }

  function snapshot (opts2 = {}) {
    const rows = load()
    const bots = [...new Set(rows.filter(r => r.kind === 'bot').map(r => r.bot))].sort()
    const latest = {}
    for (const bot of bots) {
      const mine = rows.filter(r => r.kind === 'bot' && r.bot === bot)
      latest[bot] = mine[mine.length - 1] || null
    }
    const bucketMs = opts2.bucketMs || 3600000
    const from = opts2.since || Math.min(...(rows.length ? rows.map(r => r.t) : [Date.now()]), Date.now()) - 7 * 24 * 3600000
    return {
      file,
      updatedAt: Date.now(),
      totalSamples: rows.length,
      bots,
      latest,
      bucketMs,
      series: {
        shards: bucket('shards', { bucketMs, since: from, bot: opts2.bot || null, kind: opts2.bot ? 'bot' : 'fleet' }),
        coins: bucket('coins', { bucketMs, since: from, bot: opts2.bot || null, kind: opts2.bot ? 'bot' : 'fleet' }),
        balance: bucket('balance', { bucketMs, since: from, bot: opts2.bot || null, kind: opts2.bot ? 'bot' : 'fleet' }),
        regents: bucket('regents', { bucketMs, since: from, kind: 'fleet' }),
        banned: bucket('banned', { bucketMs, since: from, kind: 'fleet' })
      },
      summary: {
        shards: summarize('shards', { since: from }),
        coins: summarize('coins', { since: from }),
        balance: summarize('balance', { since: from, bot: opts2.bot || null }),
        regents: summarize('regents', { since: from }),
        banned: summarize('banned', { since: from })
      },
      events: events({ since: from })
    }
  }

  return { append, all, since, bucket, summarize, events, snapshot, clear, file }
}

module.exports = { METRICS, botSample, fleetSample, createTimeseriesStore }
