'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const analytics = require('../analytics')
const cf = require('../coinflip')

const HOUR = 3600000 // ms in an hour
const T0 = 1700000000000

function flip (result, wager = 1000, extra = {}) {
  return { bot: 'BotA', ts: T0, wager, result, delta: result === 'won' ? wager : -wager, opponent: 'Rival', method: 'message', ...extra }
}

function report () {
  const records = [flip('won'), flip('lost'), flip('won', 2000), { ...flip('unresolved', 500), delta: null }]
  return analytics.buildReport({
    coinflip: { stats: cf.computeStats(records), fairness: cf.analyzeFairness(records), recent: records.slice().reverse() },
    timeseries: {
      totalSamples: 8,
      bots: ['BotA', 'BotB'],
      bucketMs: HOUR,
      latest: { BotA: { shards: 10, coins: 2, balance: 100, rank: 'Regent', invUsed: 12, invTotal: 36 }, BotB: { shards: 4, coins: 0, balance: 50, rank: 'Member', banned: true } },
      series: {
        shards: [{ t: T0, last: 5, min: 5, max: 9, count: 3 }, { t: T0 + HOUR, last: 14, min: 6, max: 14, count: 5 }],
        coins: [{ t: T0, last: 1 }, { t: T0 + HOUR, last: 2 }],
        balance: [{ t: T0, last: 100 }, { t: T0 + HOUR, last: 150 }],
        regents: [{ t: T0, last: 1 }, { t: T0 + HOUR, last: 2 }],
        banned: [{ t: T0, last: 0 }, { t: T0 + HOUR, last: 1 }]
      },
      summary: {
        shards: { last: 14, delta: 9, from: T0, to: T0 + HOUR },
        balance: { last: 150, delta: 50 },
        regents: { last: 2 },
        banned: { last: 1 },
        coins: { last: 2, delta: 1 }
      },
      events: { bans: [{ bot: 'BotB', t: T0 + HOUR, banned: true }], ranks: [{ bot: 'BotA', t: T0, rank: 'Regent', previous: 'Member' }] }
    },
    config: { coinflipFile: 'data/coinflip-history.jsonl', timeseriesFile: 'data/timeseries.jsonl' },
    generatedAt: T0 + HOUR
  })
}

test('bucket sizes accept 1h / 30m / 15m and a bare number of milliseconds', () => {
  assert.equal(analytics.parseBucket('1h'), 3600000)
  assert.equal(analytics.parseBucket('30m'), 1800000)
  assert.equal(analytics.parseBucket('15m'), 900000)
  assert.equal(analytics.parseBucket('45s'), 45000)
  assert.equal(analytics.parseBucket('3600000'), 3600000)
  assert.equal(analytics.parseBucket('nonsense', 3600000), 3600000)
  assert.equal(analytics.parseBucket(null, 3600000), 3600000)
})

test('a chart with fewer than two points says so instead of drawing a line', () => {
  assert.match(analytics.lineChart([{ t: T0, last: 1 }], { label: 'Shards' }), /not enough samples yet/)
  const svg = analytics.lineChart([{ t: T0, last: 1 }, { t: T0 + HOUR, last: 5 }], { label: 'Shards' })
  assert.match(svg, /<svg/)
  assert.match(svg, /Shards/)
  assert.match(svg, /class="grid"/)
})

test('the report has a headline that answers the questions at a glance', () => {
  const built = report()
  assert.equal(built.headline.coinflips, 3)
  // +1000 -1000 +2000; the unresolved flip contributes nothing.
  assert.equal(built.headline.coinflipNet, 2000)
  assert.equal(built.headline.trackedBots, 2)
  assert.equal(built.headline.samples, 8)
  assert.equal(built.headline.shardsNow, 14)
  assert.equal(built.headline.coinflipVerdict, 'insufficient-data')
  assert.equal(typeof built.generatedAtIso, 'string')
})

test('the page renders the coinflip statistics, the charts and every table', () => {
  const html = analytics.renderHtml(report())
  assert.match(html, /Fairness verdict/)
  assert.match(html, /BotA/)
  assert.match(html, /Rival/)
  assert.match(html, /Shards \(fleet\)/)
  assert.match(html, /Ban events/)
  assert.match(html, /Rank changes/)
  assert.match(html, /\/api\/analytics/)
  assert.match(html, /Regent/)
})

test('an empty history still renders a page that explains what to do', () => {
  const html = analytics.renderHtml(analytics.buildReport({ coinflip: { stats: cf.computeStats([]), fairness: cf.analyzeFairness([]), recent: [] }, timeseries: { totalSamples: 0, bots: [], series: {}, summary: {}, events: { bans: [], ranks: [] } } }))
  assert.match(html, /No resolved coinflips recorded yet/)
  assert.match(html, /No samples yet/)
})

test('nothing from the data can inject markup into the page', () => {
  const records = [flip('won', 1000, { opponent: '<script>alert(1)</script>', bot: '<img src=x onerror=alert(1)>' })]
  const html = analytics.renderHtml(analytics.buildReport({
    coinflip: { stats: cf.computeStats(records), fairness: cf.analyzeFairness(records), recent: records },
    timeseries: { totalSamples: 0, bots: [], series: {}, summary: {}, events: { bans: [], ranks: [] } }
  }))
  assert.equal(html.includes('<script>alert(1)</script>'), false)
  assert.equal(html.includes('<img src=x'), false)
  assert.match(html, /&lt;script&gt;/)
})

test('numbers are shortened for the page but never lied about', () => {
  assert.equal(analytics.fmt(12345), '12.3k')
  assert.equal(analytics.fmt(2500000), '2.50M')
  assert.equal(analytics.fmt(null), '–')
  assert.equal(analytics.pct(0.5123), '51.2%')
  assert.equal(analytics.pct(null), '–')
})

test('the verdict drives the colour of the badge', () => {
  assert.equal(analytics.verdictClass('suspicious'), 'bad')
  assert.equal(analytics.verdictClass('watch'), 'warn')
  assert.equal(analytics.verdictClass('within-noise'), 'good')
  assert.equal(analytics.verdictClass('insufficient-data'), 'dim')
})
