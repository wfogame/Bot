'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const analysis = require('../analysis')

// A deterministic pseudo-random sequence, so "a fair sample looks fair" cannot
// pass by luck and cannot fail on a bad seed.
function lcg (seed) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

/**
 * Builds a record set from a list of outcomes. `wagerFor` and `balanceFor` are
 * functions of the flip number, which is how the "bigger share wins more"
 * scenarios are constructed without touching the analysis code.
 */
function records (outcomes, opts = {}) {
  const wagerFor = opts.wagerFor || (() => 10000)
  const balanceFor = opts.balanceFor || (() => 1000000)
  let ts = Date.UTC(2026, 2, 1, 0, 0, 0)
  return outcomes.map((result, i) => {
    const wager = wagerFor(i)
    const won = result === 'won'
    ts += opts.stepMs || 30000
    return {
      id: `rec-${i}`,
      sessionId: `session-${Math.floor(i / 20)}`,
      bot: opts.bot || 'BotA',
      index: (i % 20) + 1,
      ts,
      wager,
      opponent: opts.opponent || 'Rival',
      result,
      balanceBefore: balanceFor(i),
      balanceAfter: null,
      delta: won ? wager : -wager,
      method: 'message',
      mismatched: false,
      serverHour: opts.serverHour ? opts.serverHour(i) : null,
      serverClock: null
    }
  })
}

function outcomesFrom (random, n, pWin = 0.5) {
  const out = []
  for (let i = 0; i < n; i++) out.push(random() < pWin ? 'won' : 'lost')
  return out
}

test('a fair sample is reported as fair in every dissection', () => {
  const fair = outcomesFrom(lcg(7), 3000)
  const report = analysis.deepAnalysis(records(fair), { minBucket: 20 })

  assert.equal(report.resolved, 3000)
  assert.ok(Math.abs(report.winRate - 0.5) < 0.03, `win rate ${report.winRate}`)
  assert.ok(report.tests > 50, 'every bucket is a test in the family')
  assert.ok(report.sections.length >= 13, `${report.sections.length} dissections`)
  assert.ok(report.markov.p > 0.05, `previous flip must not predict the next (p=${report.markov.p})`)
  // No bucket may be called significant once the whole family is corrected.
  assert.equal(report.sections.flatMap(section => section.rows).filter(row => row.significant).length, 0)
  assert.match(report.takeaways[report.takeaways.length - 1], /looks like a fair coin/)
})

test('a streaky sample is caught by the transition table and the streak buckets', () => {
  // A loss makes another loss three times as likely: exactly the "do 3 losses
  // mean another loss?" pattern the dissection exists to find.
  const random = lcg(11)
  const out = []
  let previous = 'won'
  for (let i = 0; i < 4000; i++) {
    const lost = random() < (previous === 'lost' ? 0.7 : 0.3)
    const result = lost ? 'lost' : 'won'
    out.push(result)
    previous = result
  }
  const report = analysis.deepAnalysis(records(out), { minBucket: 20 })

  assert.ok(report.markov.p < 1e-6, `p=${report.markov.p}`)
  // diff is P(win | win) − P(win | loss): 0.7 against 0.3 here.
  assert.ok(report.markov.diff > 0.3, 'a win is followed by more wins, and a loss by fewer')
  assert.ok(report.markov.oddsRatio > 3)
  assert.ok(report.autocorrelation[0].r > 0.3, `lag-1 r=${report.autocorrelation[0].r}`)
  assert.ok(report.runLengths.p < 1e-3, `run lengths are not geometric (p=${report.runLengths.p})`)

  const streakRows = report.sections.find(section => section.key === 'streak').rows
  const afterTwoLosses = streakRows.find(row => row.label === 'after 2× loss, the next flip won')
  assert.equal(afterTwoLosses.significant, true)
  assert.ok(afterTwoLosses.rate < 0.4, `after two losses the next flip won ${afterTwoLosses.rate}`)
  assert.ok(afterTwoLosses.q < 0.01)
  assert.match(report.takeaways.join(' '), /survive the 0.05 false-discovery-rate correction/)
})

test('a windowed streak question is answered as a window, not a single flip', () => {
  const report = analysis.deepAnalysis(records(outcomesFrom(lcg(3), 4000)), { minBucket: 20 })
  const rows = report.sections.find(section => section.key === 'streak').rows
  const windowed = rows.find(row => row.label === 'after 2× loss, a win within 3 flips')
  assert.ok(windowed, 'the "2 losses then 2 wins" question gets its own row')
  // A fair coin gives 1 − 0.5³ = 87.5% of windows containing a win.
  assert.equal(windowed.expected, 0.875)
  assert.ok(Math.abs(windowed.rate - 0.875) < 0.06, `rate ${windowed.rate}`)
  assert.equal(windowed.lowSample, false)

  // "After two losses, did both of the next two win?" is a different question
  // from "did one of them win?", and a fair coin answers it 25% of the time.
  const both = rows.find(row => row.label === 'after 2× loss, both of the next 2 flips won')
  assert.ok(both, 'the two-wins-in-a-row window gets its own row')
  assert.equal(both.expected, 0.25)
  assert.ok(Math.abs(both.rate - 0.25) < 0.05, `rate ${both.rate}`)
  const next = rows.find(row => row.label === 'after 2× loss, the next flip won')
  assert.equal(next.expected, 0.5)
  assert.ok(Math.abs(next.rate - 0.5) < 0.05, `rate ${next.rate}`)
})

test('a bigger share of the balance winning more often is detected as a trend', () => {
  const random = lcg(23)
  const out = []
  const wagers = []
  for (let i = 0; i < 3000; i++) {
    // 1% of balance wins 35% of the time, 50% of balance wins 65% of the time.
    const big = i % 2 === 1
    out.push(random() < (big ? 0.65 : 0.35) ? 'won' : 'lost')
    wagers.push(big ? 500000 : 10000)
  }
  const report = analysis.deepAnalysis(records(out, { wagerFor: i => wagers[i], balanceFor: () => 1000000 }), { minBucket: 20 })

  assert.ok(report.ratioTrend.p < 1e-6, `trend p=${report.ratioTrend.p}`)
  assert.equal(report.ratioTrend.direction, 'more wins as it rises')
  const ratioRows = report.sections.find(section => section.key === 'ratio').rows
  const small = ratioRows.find(row => row.label === '1.0–2.0% of balance')
  const large = ratioRows.find(row => row.label === '50.0–100.0% of balance')
  assert.ok(small && large, 'both constructed ratios land in their own bucket')
  assert.ok(large.rate > small.rate + 0.2)
  assert.equal(report.sections.find(section => section.key === 'ratio').extra.trend.p, report.ratioTrend.p)
})

test('the hour buckets use the server clock and say so', () => {
  const out = []
  for (let i = 0; i < 600; i++) out.push(i % 3 === 0 ? 'lost' : 'won')
  const hourly = records(out, { serverHour: i => (i < 300 ? 3 : 20) })
  const report = analysis.deepAnalysis(hourly, { minBucket: 20 })
  assert.equal(report.hourSource, 'server')
  const rows = report.sections.find(section => section.key === 'hour').rows
  const three = rows.find(row => row.label.startsWith('03:00'))
  const twenty = rows.find(row => row.label.startsWith('20:00'))
  assert.equal(three.n, 300)
  assert.equal(twenty.n, 300)
  assert.equal(three.wins, 200)
  assert.equal(twenty.wins, 200)

  // Without a server hour the local clock is the fallback and is labelled as such.
  const fallback = analysis.deepAnalysis(records(out.slice(0, 40)), { minBucket: 5 })
  assert.equal(fallback.hourSource, 'local')
  assert.equal(analysis.hourOfRecord({ ts: Date.UTC(2026, 2, 1, 5, 30), serverHour: 21 }, -new Date().getTimezoneOffset()).hour, 21)
})

test('the money curve measures drawdown and the stretch below a high', () => {
  const curve = analysis.moneyCurve(records(['won', 'lost', 'lost', 'lost', 'won', 'won']))
  assert.equal(curve.total, 0, 'three wins and three losses at the same stake')
  assert.equal(curve.peak, 10000)
  assert.equal(curve.maxDrawdown, 30000, 'from +10k down to −20k')
  assert.equal(curve.belowPeak, 5, 'the last five flips all sat under the high')
  assert.equal(curve.longestDrawdown, 5)
  assert.equal(curve.atHigh, false)
  assert.equal(curve.currentDrawdown, 10000)
  assert.equal(curve.biggestLoss.net, -10000)
  assert.equal(curve.netPerFlip, curve.total / 6)
})

test('run lengths are compared with the geometric distribution a fair coin gives', () => {
  const alternating = []
  for (let i = 0; i < 400; i++) alternating.push(i % 2 ? 'won' : 'lost')
  const alternatingRuns = analysis.runLengthAnalysis(alternating)
  assert.equal(alternatingRuns.total, 400)
  assert.equal(alternatingRuns.observed[0], 400, 'never two of the same in a row')
  assert.ok(alternatingRuns.p < 1e-6)

  const fair = analysis.runLengthAnalysis(outcomesFrom(lcg(5), 4000))
  assert.ok(fair.p > 0.01, `a fair coin\'s runs are geometric (p=${fair.p})`)
})

test('the transition table and the lag correlation are the same signal', () => {
  const streaky = analysis.markovAnalysis(['won', 'won', 'lost', 'lost', 'won', 'won'])
  assert.deepEqual(streaky.counts, { ww: 2, wl: 1, lw: 1, ll: 1 })
  assert.equal(streaky.pWinAfterWin, 2 / 3)
  assert.equal(streaky.pWinAfterLoss, 1 / 2)

  const alternating = []
  for (let i = 0; i < 100; i++) alternating.push(i % 2 ? 'won' : 'lost')
  assert.equal(analysis.autocorrelation(alternating, 1).r, -1)
  assert.equal(analysis.autocorrelation(alternating, 2).r, 1)
  assert.equal(analysis.autocorrelation(['won', 'lost'], 1).r, null, 'a handful of flips is not a correlation')
})

test('the false-discovery correction is monotone and ranks findings', () => {
  const adjusted = analysis.bhAdjust([0.001, 0.02, 0.5, null], 0.05)
  assert.equal(adjusted[3], null)
  assert.equal(adjusted[0].significant, true)
  assert.equal(adjusted[2].significant, false)
  assert.ok(adjusted[0].q <= adjusted[1].q && adjusted[1].q <= adjusted[2].q)
  // One test on its own is just its p-value; many tests inflate it.
  assert.ok(analysis.bhAdjust([0.04], 0.05)[0].q === 0.04)
  assert.ok(analysis.bhAdjust([0.04, 0.9, 0.9, 0.9], 0.05)[0].q === 0.16)
})

test('the rate test and the two-proportion test agree with the arithmetic', () => {
  assert.ok(Math.abs(analysis.rateTest(50, 100).p - 1) < 1e-6)
  assert.ok(analysis.rateTest(70, 100).p < 0.0001)
  assert.equal(analysis.rateTest(0, 0).p, null)
  const same = analysis.twoProportionTest(50, 100, 50, 100)
  assert.equal(same.diff, 0)
  assert.ok(Math.abs(same.p - 1) < 1e-6)
  const different = analysis.twoProportionTest(70, 100, 30, 100)
  assert.ok(different.diff > 0)
  assert.ok(different.p < 1e-6)
})

test('the wager, pace, position and martingale buckets label themselves', () => {
  // Five edges give six buckets, so the top one is index 5 (edges.length).
  const wagers = [5000, 20000, 100000, 500000, 9000000]
  const rows = analysis.bucketEntries(wagers.map(w => ({ row: { result: 'won', wager: w }, key: w })), [10000, 50000, 250000, 1000000, 5000000], index => String(index))
  assert.deepEqual(rows.map(row => row.label), ['0', '1', '2', '3', '5'])
  assert.equal(rows.reduce((sum, row) => sum + row.n, 0), wagers.length, 'every wager lands in exactly one bucket')
  assert.equal(analysis.bucketIndex(null, [1]), null)

  const paced = analysis.paceEntries(records(['won', 'won', 'won']))
  assert.equal(paced.length, 2, 'one gap per flip after the first')
  assert.equal(paced[0].key, 30000)

  const martingale = analysis.martingaleEntries(records(['lost', 'lost', 'won'], { wagerFor: i => [1000, 3000, 1000][i] }))
  assert.equal(martingale.entries.length, 2)
  assert.equal(martingale.entries[0].direction, 'raised')
  assert.equal(martingale.afterLoss.length, 1, 'only the raise that followed the loss counts')

  const quantities = analysis.quantile([1, 2, 3, 4], 0.5)
  assert.equal(quantities, 2.5)
})

test('records are never mutated and a nonsense record is skipped rather than fatal', () => {
  const input = records(['won', 'lost'])
  input[1].balanceBefore = null
  const copy = JSON.parse(JSON.stringify(input))
  const report = analysis.deepAnalysis(input)
  assert.deepEqual(input, copy, 'the dissection sorts a copy, it does not reorder the history')
  assert.equal(report.resolved, 2)
  assert.deepEqual(analysis.deepAnalysis([]).resolved, 0)
  assert.deepEqual(analysis.deepAnalysis().sections.length, 18)
})
