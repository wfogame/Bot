'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('../timeseries')

const HOUR = 3600000
const T0 = 1700000000000

function store () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeseries-'))
  return { dir, store: ts.createTimeseriesStore({ file: path.join(dir, 'timeseries.jsonl') }) }
}

test('a sample keeps the fields it has and drops the ones it does not', () => {
  const sample = ts.botSample({ bot: 'BotA', shards: 10, coins: null, balance: 5.5, rank: 'Regent', banned: false, source: 'data' }, T0)
  assert.deepEqual(sample, { t: T0, kind: 'bot', bot: 'BotA', shards: 10, coins: null, balance: 5.5, rank: 'Regent', banned: false, source: 'data' })
  const partial = ts.botSample({ bot: 'BotA', shards: 3 }, T0)
  assert.deepEqual(Object.keys(partial).sort(), ['bot', 'kind', 'shards', 't'])
})

test('a fleet sample totals what it can and counts the rest', () => {
  const fleet = ts.fleetSample([
    { bot: 'A', shards: 10, coins: 2, balance: 100.5, rank: 'Regent', banned: false },
    { bot: 'B', shards: 5, coins: 3, balance: 200.25, rank: 'Member', banned: true },
    { bot: 'C', shards: null, coins: 1, balance: null, rank: 'N/A', banned: false }
  ], T0)
  assert.equal(fleet.kind, 'fleet')
  assert.equal(fleet.bots, 3)
  assert.equal(fleet.shards, 15)
  assert.equal(fleet.coins, 6)
  assert.equal(fleet.balance, 300.75)
  assert.equal(fleet.regents, 1)
  assert.equal(fleet.banned, 1)
})

test('samples survive a round trip through the file and a corrupt line is skipped', () => {
  const { dir, store: s } = store()
  s.append(ts.botSample({ bot: 'BotA', shards: 1 }, T0))
  fs.appendFileSync(s.file, 'not json\n')
  s.append(ts.botSample({ bot: 'BotA', shards: 2 }, T0 + HOUR))

  const reloaded = ts.createTimeseriesStore({ file: s.file })
  assert.equal(reloaded.all().length, 2)
  assert.equal(reloaded.since(T0 + 1).length, 1)
  assert.equal(reloaded.since(T0, { bot: 'BotB' }).length, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('buckets group by window and keep the last reading, plus the spike', () => {
  const { dir, store: s } = store()
  s.append({ t: T0, kind: 'fleet', shards: 10 })
  s.append({ t: T0 + 1000, kind: 'fleet', shards: 25 })
  s.append({ t: T0 + 2000, kind: 'fleet', shards: 12 })
  s.append({ t: T0 + HOUR, kind: 'fleet', shards: 40 })

  const buckets = s.bucket('shards', { bucketMs: HOUR, kind: 'fleet' })
  assert.equal(buckets.length, 2)
  assert.equal(buckets[0].last, 12, 'the bucket reports where the hour ended up')
  assert.equal(buckets[0].max, 25, 'and the spike inside it is not smoothed away')
  assert.equal(buckets[0].count, 3)
  assert.equal(buckets[1].last, 40)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('buckets can be scoped to one bot, which is what the per-bot chart needs', () => {
  const { dir, store: s } = store()
  s.append(ts.botSample({ bot: 'BotA', shards: 1 }, T0))
  s.append(ts.botSample({ bot: 'BotB', shards: 99 }, T0))
  const onlyA = s.bucket('shards', { bucketMs: HOUR, kind: 'bot', bot: 'BotA' })
  assert.equal(onlyA.length, 1)
  assert.equal(onlyA[0].last, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a summary reports first, last, delta and the hourly rate', () => {
  const { dir, store: s } = store()
  s.append({ t: T0, kind: 'fleet', shards: 100 })
  s.append({ t: T0 + 2 * HOUR, kind: 'fleet', shards: 400 })
  const summary = s.summarize('shards')
  assert.equal(summary.first, 100)
  assert.equal(summary.last, 400)
  assert.equal(summary.delta, 300)
  assert.equal(summary.perHour, 150)
  assert.equal(summary.min, 100)
  assert.equal(summary.max, 400)
  assert.equal(s.summarize('coins'), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('ban and rank changes are derived from the samples rather than a second log', () => {
  const { dir, store: s } = store()
  s.append(ts.botSample({ bot: 'BotA', banned: false, rank: 'Member' }, T0))
  s.append(ts.botSample({ bot: 'BotA', banned: true, rank: 'Member' }, T0 + HOUR))
  s.append(ts.botSample({ bot: 'BotA', banned: true, rank: 'Regent' }, T0 + 2 * HOUR))
  s.append(ts.botSample({ bot: 'BotA', banned: false, rank: 'Regent' }, T0 + 3 * HOUR))

  const events = s.events()
  assert.equal(events.bans.length, 2)
  assert.equal(events.bans[0].banned, true)
  assert.equal(events.bans[1].banned, false)
  assert.equal(events.ranks.length, 1)
  assert.deepEqual(events.ranks[0], { bot: 'BotA', t: T0 + 2 * HOUR, rank: 'Regent', previous: 'Member' })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the snapshot carries the series, the latest value per bot and the events', () => {
  const { dir, store: s } = store()
  s.append(ts.botSample({ bot: 'BotA', shards: 5, balance: 10, rank: 'Regent' }, T0))
  s.append(ts.botSample({ bot: 'BotA', shards: 7, balance: 20, rank: 'Regent' }, T0 + HOUR))
  s.append(ts.fleetSample([{ shards: 7, coins: 1, balance: 20, rank: 'Regent' }], T0 + HOUR))
  const snap = s.snapshot({ bucketMs: HOUR, since: T0 - 1 })
  assert.deepEqual(snap.bots, ['BotA'])
  assert.equal(snap.latest.BotA.shards, 7)
  assert.equal(snap.totalSamples, 3)
  assert.equal(snap.series.shards.length, 1)
  assert.equal(snap.summary.shards.last, 7)
  assert.equal(snap.summary.shards.delta, 2)
  assert.equal(snap.series.regents.length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a missing data file is an empty history, not a crash', () => {
  const s = ts.createTimeseriesStore({ file: path.join(os.tmpdir(), 'nope-timeseries', 'x.jsonl') })
  assert.deepEqual(s.all(), [])
  assert.equal(s.summarize('shards'), null)
  assert.deepEqual(s.bucket('shards'), [])
  assert.deepEqual(s.events(), { bans: [], ranks: [] })
})
