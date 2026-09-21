'use strict'

/**
 * Deep dissection of the recorded coinflips.
 *
 * coinflip.js answers "is the game rigged?" with three tests. This answers the
 * follow-up questions a data scientist asks of the same records — do streaks
 * carry information, does betting a bigger share of the balance change the
 * odds, does the hour matter, does idling help — the way a statistician would:
 * every bucket gets its own sample size, confidence interval and p-value, and
 * the whole family of tests is corrected together (Benjamini–Hochberg), because
 * slicing one dataset twenty ways hands you a "significant" bucket every time.
 *
 * The statistical primitives come from coinflip.js so there is exactly one
 * normal CDF, one Wilson interval and one definition of a resolved flip.
 */

const path = require('path')
const { STREAK, resolvedRecords, wilsonInterval, normalCdf, twoSidedP, mean, stdev } = require(path.join(__dirname, 'coinflip'))

// ── Deep dissection ──────────────────────────────────────────────────────────
//
// The fairness verdict answers "is the game rigged?" with three tests. This
// answers the follow-up questions a data scientist actually asks of the same
// records — do streaks carry information, does betting a bigger share of the
// balance change the odds, does the hour matter, does idling help — and it
// answers them the way a statistician would: every bucket gets its own sample
// size, confidence interval and p-value, and the whole family of tests is then
// corrected together (Benjamini–Hochberg), because slicing one dataset twenty
// ways will hand you a "significant" bucket every single time if you do not.

function pctText (value, digits = 1) {
  return value == null || !Number.isFinite(value) ? 'n/a' : `${(value * 100).toFixed(digits)}%`
}

function sumOf (values) {
  let total = 0
  for (const value of values) total += Number(value) || 0
  return total
}

/** What a record actually did to the balance — delta when known, else ±wager. */
function recordNet (row) {
  if (row.delta != null && Number.isFinite(Number(row.delta))) return Number(row.delta)
  if (row.result === STREAK.WON) return Number(row.wager) || 0
  if (row.result === STREAK.LOST) return -(Number(row.wager) || 0)
  return 0
}

function quantileSorted (sorted, p) {
  if (!sorted.length) return null
  const position = (sorted.length - 1) * p
  const low = Math.floor(position)
  const high = Math.ceil(position)
  if (low === high) return sorted[low]
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low)
}

function quantile (values, p) {
  const sorted = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const position = (sorted.length - 1) * p
  const low = Math.floor(position)
  const high = Math.ceil(position)
  if (low === high) return sorted[low]
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low)
}

/** Wilson–Hilferty chi-square tail — accurate enough to rank findings by. */
function chiSquareP (x, df = 1) {
  if (!Number.isFinite(x) || x <= 0 || !(df >= 1)) return null
  const z = (Math.pow(x / df, 1 / 3) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df))
  return Math.max(0, Math.min(1, 1 - normalCdf(z)))
}

function chiSquare2x2 (a, b, c, d) {
  const n = a + b + c + d
  const denom = (a + b) * (c + d) * (a + c) * (b + d)
  if (!n || !denom) return { chi2: null, p: null }
  const chi2 = (n * (a * d - b * c) ** 2) / denom
  return { chi2, p: chiSquareP(chi2, 1) }
}

/** Two-sided p for `wins` of `n` against an expected rate (0.5 by default). */
function rateTest (wins, n, expected = 0.5) {
  if (!n || !(expected > 0 && expected < 1)) return { z: null, p: null }
  const z = (wins - n * expected) / Math.sqrt(n * expected * (1 - expected))
  return { z, p: twoSidedP(z) }
}

/** Are two win rates actually different, or is the gap just sample noise? */
function twoProportionTest (wins1, n1, wins2, n2) {
  if (!n1 || !n2) return { z: null, p: null, diff: null }
  const p1 = wins1 / n1
  const p2 = wins2 / n2
  const pooled = (wins1 + wins2) / (n1 + n2)
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2))
  if (!(se > 0)) return { z: null, p: null, diff: p1 - p2 }
  const z = (p1 - p2) / se
  return { z, p: twoSidedP(z), diff: p1 - p2 }
}

/**
 * Benjamini–Hochberg step-up. With twenty dissections, "p < 0.05" is a promise
 * the data cannot keep; the q-value is the honest version, and every finding is
 * reported next to the number of tests that were run to find it.
 */
function bhAdjust (pvalues, q = 0.05) {
  const ranked = pvalues.map((p, i) => ({ p, i })).filter(entry => entry.p != null).sort((a, b) => a.p - b.p)
  const m = ranked.length
  const out = new Array(pvalues.length).fill(null)
  let running = 1
  for (let k = m - 1; k >= 0; k--) {
    const adjusted = Math.min(running, (ranked[k].p * m) / (k + 1))
    running = adjusted
    out[ranked[k].i] = { q: adjusted, significant: adjusted <= q }
  }
  return out
}

function rateFromCounts (label, n, wins, extra = {}) {
  const expected = extra.expected == null ? 0.5 : extra.expected
  const test = rateTest(wins, n, expected)
  return {
    label,
    n,
    wins,
    losses: n - wins,
    rate: n ? wins / n : null,
    ci: wilsonInterval(wins, n),
    z: test.z,
    p: test.p,
    expected,
    net: extra.net == null ? null : extra.net,
    wagered: extra.wagered == null ? null : extra.wagered,
    score: extra.score == null ? null : extra.score,
    note: extra.note || '',
    lowSample: false
  }
}

function rateRow (label, rows, extra = {}) {
  return rateFromCounts(label, rows.length, rows.filter(row => row.result === STREAK.WON).length, {
    net: sumOf(rows.map(recordNet)),
    wagered: sumOf(rows.map(row => Number(row.wager) || 0)),
    ...extra
  })
}

/**
 * `rows` in the order they happened — every sequential dissection needs this.
 * `alreadySorted` skips the sort (and the copy) when the caller has the ordered
 * array to hand, which is the common case inside deepAnalysis — a copy of
 * 200,000 records is not free.
 */
function inTimeOrder (records, alreadySorted = false) {
  if (alreadySorted) return records
  const resolved = resolvedRecords(records)
  // An append-only history is already in order, so the sort is only paid for
  // when a record really is out of place — one scan instead of a full sort.
  for (let i = 1; i < resolved.length; i++) {
    if ((resolved[i].ts || 0) < (resolved[i - 1].ts || 0)) return resolved.sort((a, b) => (a.ts || 0) - (b.ts || 0))
  }
  return resolved
}

/** edges = [a, b] gives three buckets: < a, a–b, ≥ b. */
function bucketIndex (value, edges) {
  if (value == null || !Number.isFinite(value)) return null
  for (let i = 0; i < edges.length; i++) if (value < edges[i]) return i
  return edges.length
}

function pushBucket (groups, index, row) {
  if (index == null) return
  const bucket = groups.get(index)
  if (bucket) bucket.push(row)
  else groups.set(index, [row])
}

/** Buckets in edge order, each summarised as a rate row. */
function finishBuckets (groups, labelOf) {
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, rows]) => rateRow(labelOf(index), rows))
}

/** Groups `{ row, key }` pairs — for a key that is derived, like a time gap. */
function bucketEntries (entries, edges, labelOf) {
  const groups = new Map()
  for (const entry of entries) pushBucket(groups, bucketIndex(entry.key, edges), entry.row)
  return finishBuckets(groups, labelOf)
}

/** Groups records directly, so a plain numeric key needs no pair allocation. */
function bucketRecords (records, keyOf, edges, labelOf) {
  const groups = new Map()
  for (const row of records) pushBucket(groups, bucketIndex(keyOf(row), edges), row)
  return finishBuckets(groups, labelOf)
}

/**
 * Cochran–Armitage trend test: does the win rate drift as the bucketed variable
 * rises? This is the one that answers "higher bet relative to balance → higher
 * chance?" directly, instead of eyeballing three bucket percentages.
 */
function trendTest (rows) {
  const scored = rows.filter(row => row.n > 0 && Number.isFinite(row.score))
  const n = sumOf(scored.map(row => row.n))
  const wins = sumOf(scored.map(row => row.wins))
  if (!n || !wins || wins === n || scored.length < 2) return { z: null, p: null, direction: null }
  const sumNx = sumOf(scored.map(row => row.n * row.score))
  const sumNx2 = sumOf(scored.map(row => row.n * row.score * row.score))
  const meanX = sumNx / n
  const varianceX = sumNx2 / n - meanX * meanX
  const pBar = wins / n
  const numerator = sumOf(scored.map(row => row.score * (row.wins - row.n * pBar)))
  const denominator = Math.sqrt(pBar * (1 - pBar) * n * varianceX)
  if (!(denominator > 0)) return { z: null, p: null, direction: null }
  const z = numerator / denominator
  return { z, p: twoSidedP(z), direction: z > 0 ? 'more wins as it rises' : 'fewer wins as it rises' }
}

/**
 * What follows a run: the next flip, a win somewhere in the next few flips, and
 * "after two losses, did both of the next two win?" — the last one is a window
 * question, not a single-flip one, and a fair coin gives it 25%.
 */
function conditionalStreakRows (outcomes, maxRun = 6, horizon = 3) {
  const rows = []
  const horizons = [...new Set([2, horizon])].filter(h => h >= 1).sort((a, b) => a - b)
  for (const kind of [STREAK.LOST, STREAK.WON]) {
    const verb = kind === STREAK.WON ? 'win' : 'loss'
    for (let k = 1; k <= maxRun; k++) {
      let n = 0
      let wins = 0
      const windows = new Map()
      for (let i = k; i < outcomes.length; i++) {
        let match = true
        for (let j = 1; j <= k; j++) if (outcomes[i - j] !== kind) { match = false; break }
        if (!match) continue
        n++
        if (outcomes[i] === STREAK.WON) wins++
        for (const h of horizons) {
          if (i + h > outcomes.length) continue
          let slot = windows.get(h)
          if (!slot) { slot = { n: 0, any: 0, both: 0 }; windows.set(h, slot) }
          slot.n++
          let any = false
          let both = true
          for (let x = i; x < i + h; x++) {
            if (outcomes[x] === STREAK.WON) any = true
            else both = false
          }
          if (any) slot.any++
          if (both) slot.both++
        }
      }
      if (n >= 5) rows.push(rateFromCounts(`after ${k}× ${verb}, the next flip won`, n, wins, { note: `${kind} run of ${k}` }))
      for (const h of horizons) {
        const slot = windows.get(h)
        if (!slot || slot.n < 5) continue
        rows.push(rateFromCounts(`after ${k}× ${verb}, a win within ${h} flips`, slot.n, slot.any, { expected: 1 - Math.pow(0.5, h) }))
        if (h === 2) rows.push(rateFromCounts(`after ${k}× ${verb}, both of the next 2 flips won`, slot.n, slot.both, { expected: 0.25 }))
      }
    }
  }
  return rows
}

/** Observed run lengths against the geometric distribution a fair coin gives. */
function runLengthAnalysis (outcomes, maxBucket = 6) {
  const lengths = []
  for (let i = 0; i < outcomes.length;) {
    let j = i
    while (j < outcomes.length && outcomes[j] === outcomes[i]) j++
    lengths.push(j - i)
    i = j
  }
  if (!lengths.length) return { total: 0, observed: [], expected: [], chi2: null, df: null, p: null }
  const observed = new Array(maxBucket).fill(0)
  for (const length of lengths) observed[Math.min(length, maxBucket) - 1]++
  const probabilities = []
  for (let l = 1; l < maxBucket; l++) probabilities.push(Math.pow(0.5, l))
  probabilities.push(Math.pow(0.5, maxBucket - 1))
  const expected = probabilities.map(p => p * lengths.length)
  let chi2 = 0
  let df = -1
  for (let i = 0; i < observed.length; i++) {
    if (expected[i] < 5) continue
    chi2 += ((observed[i] - expected[i]) ** 2) / expected[i]
    df++
  }
  return {
    total: lengths.length,
    observed,
    expected,
    chi2: df > 0 ? chi2 : null,
    df: df > 0 ? df : null,
    p: df > 0 ? chiSquareP(chi2, df) : null
  }
}

/** The 2×2 transition table: is the current flip independent of the last one? */
function markovAnalysis (outcomes) {
  const counts = { ww: 0, wl: 0, lw: 0, ll: 0 }
  for (let i = 1; i < outcomes.length; i++) {
    const previous = outcomes[i - 1]
    const current = outcomes[i]
    if (previous === STREAK.WON) counts[current === STREAK.WON ? 'ww' : 'wl']++
    else counts[current === STREAK.WON ? 'lw' : 'll']++
  }
  const afterWin = counts.ww + counts.wl
  const afterLoss = counts.lw + counts.ll
  const table = chiSquare2x2(counts.ww, counts.wl, counts.lw, counts.ll)
  const compare = twoProportionTest(counts.ww, afterWin, counts.lw, afterLoss)
  return {
    counts,
    nAfterWin: afterWin,
    nAfterLoss: afterLoss,
    pWinAfterWin: afterWin ? counts.ww / afterWin : null,
    pWinAfterLoss: afterLoss ? counts.lw / afterLoss : null,
    chi2: table.chi2,
    p: table.p,
    compareP: compare.p,
    diff: compare.diff,
    df: 1,
    oddsRatio: counts.ww && counts.ll && counts.wl && counts.lw
      ? (counts.ww * counts.ll) / (counts.wl * counts.lw)
      : null
  }
}

/** Serial correlation of the outcomes at a lag: do results echo each other? */
function autocorrelation (outcomes, lag) {
  const x = []
  const y = []
  for (let i = 0; i + lag < outcomes.length; i++) {
    x.push(outcomes[i] === STREAK.WON ? 1 : 0)
    y.push(outcomes[i + lag] === STREAK.WON ? 1 : 0)
  }
  if (x.length < 10) return { lag, n: x.length, r: null, p: null }
  const mx = mean(x)
  const my = mean(y)
  let numerator = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < x.length; i++) {
    numerator += (x[i] - mx) * (y[i] - my)
    dx += (x[i] - mx) ** 2
    dy += (y[i] - my) ** 2
  }
  const r = dx && dy ? numerator / Math.sqrt(dx * dy) : null
  return { lag, n: x.length, r, p: r == null ? null : twoSidedP(r * Math.sqrt(x.length)) }
}

/**
 * The hour a flip happened in — the server's own clock when the result block
 * carried a timestamp, else the local clock shifted by the configured offset.
 */
function hourOfRecord (row, tzOffsetMinutes) {
  if (row.serverHour != null && Number.isFinite(Number(row.serverHour))) {
    return { hour: ((Number(row.serverHour) % 24) + 24) % 24, source: 'server' }
  }
  if (!row.ts) return null
  const shifted = new Date(Number(row.ts) + tzOffsetMinutes * 60000)
  return { hour: shifted.getUTCHours(), source: 'local' }
}

/** The gap since the previous flip on the same bot: does idling help? */
function paceEntries (records, alreadySorted = false) {
  const last = new Map()
  const entries = []
  for (const row of inTimeOrder(records, alreadySorted)) {
    const key = row.bot || ''
    const previous = last.get(key)
    last.set(key, row)
    if (!previous) continue
    const gap = (row.ts || 0) - (previous.ts || 0)
    if (gap < 0 || gap > 24 * 3600000) continue
    entries.push({ row, key: gap })
  }
  return entries
}

/** Did the wager change between consecutive flips of the same session? */
function martingaleEntries (records, alreadySorted = false) {
  const bySession = new Map()
  for (const row of inTimeOrder(records, alreadySorted)) {
    const key = row.sessionId || row.bot || ''
    if (!bySession.has(key)) bySession.set(key, [])
    bySession.get(key).push(row)
  }
  const entries = []
  const afterLoss = []
  for (const rows of bySession.values()) {
    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1]
      const current = rows[i]
      const delta = (Number(current.wager) || 0) - (Number(previous.wager) || 0)
      const direction = delta > 0 ? 'raised' : delta < 0 ? 'lowered' : 'same'
      entries.push({ row: current, key: direction === 'raised' ? 1 : direction === 'same' ? 0 : -1, direction })
      if (previous.result === STREAK.LOST && direction === 'raised') afterLoss.push(current)
    }
  }
  return { entries, afterLoss }
}

/** Fleet Homogeneity (Cochran's Q / Chi-Square across bots) */
function fleetHomogeneityTest (orderedRecords) {
  const byBot = new Map()
  for (const row of orderedRecords) {
    const bot = row.bot || '(unknown)'
    if (!byBot.has(bot)) byBot.set(bot, { wins: 0, losses: 0, n: 0 })
    const b = byBot.get(bot)
    b.n++
    if (row.result === STREAK.WON) b.wins++
    else if (row.result === STREAK.LOST) b.losses++
  }
  const bots = [...byBot.entries()].filter(([_, b]) => b.n >= 5)
  if (bots.length < 2) return { chi2: null, p: null, bots: bots.length }
  const totalN = sumOf(bots.map(([_, b]) => b.n))
  const totalWins = sumOf(bots.map(([_, b]) => b.wins))
  const pBar = totalWins / totalN
  if (!(pBar > 0 && pBar < 1)) return { chi2: null, p: null, bots: bots.length }
  
  let chi2 = 0
  for (const [bot, b] of bots) {
    const expectedWins = b.n * pBar
    const expectedLosses = b.n * (1 - pBar)
    chi2 += ((b.wins - expectedWins) ** 2) / expectedWins + ((b.losses - expectedLosses) ** 2) / expectedLosses
  }
  const df = bots.length - 1
  return {
    chi2,
    df,
    p: chiSquareP(chi2, df),
    bots: bots.length,
    pBar
  }
}

/** Kaplan-Meier hazard rate for streak hard-caps */
function streakHazardAnalysis (outcomes, maxK = 8) {
  const hazardRows = []
  for (const kind of [STREAK.WON, STREAK.LOST]) {
    const verb = kind === STREAK.WON ? 'win' : 'loss'
    for (let k = 1; k <= maxK; k++) {
      let reached = 0
      let terminated = 0
      for (let i = k; i < outcomes.length; i++) {
        let match = true
        for (let j = 1; j <= k; j++) {
          if (outcomes[i - j] !== kind) { match = false; break }
        }
        if (!match) continue
        reached++
        if (outcomes[i] !== kind) terminated++
      }
      if (reached >= 10) {
        const hazard = terminated / reached
        const test = rateTest(terminated, reached, 0.5)
        hazardRows.push({
          label: `hazard of ending a ${k}× ${verb} streak`,
          n: reached,
          wins: terminated,
          losses: reached - terminated,
          rate: hazard,
          ci: wilsonInterval(terminated, reached),
          z: test.z,
          p: test.p,
          expected: 0.5,
          note: `terminated ${terminated} / reached ${reached} (${pctText(hazard)})`
        })
      }
    }
  }
  return hazardRows
}

/** Rolling Window Profit Decay / Soft Cap test */
function profitCapAnalysis (orderedRecords) {
  let cumulative = 0
  const entries = []
  for (const row of orderedRecords) {
    const net = recordNet(row)
    cumulative += net
    entries.push({ row, key: cumulative })
  }
  if (entries.length < 30) return { rows: [], trend: null }
  
  const profits = entries.map(e => e.key).sort((a, b) => a - b)
  const edges = [quantileSorted(profits, 0.25), quantileSorted(profits, 0.5), quantileSorted(profits, 0.75)]
  const rows = bucketEntries(entries, edges, (index) => {
    if (index === 0) return 'lowest profit quartile'
    if (index === 1) return 'lower-middle profit quartile'
    if (index === 2) return 'upper-middle profit quartile'
    return 'highest profit quartile'
  })
  rows.forEach((row, i) => { row.score = i })
  const trend = trendTest(rows)
  return { rows, trend }
}

/** Simultaneous Flip Cross-Correlation across bots */
function simultaneousFlipAnalysis (orderedRecords, windowMs = 2000) {
  const timed = orderedRecords.filter(r => r.ts).sort((a, b) => a.ts - b.ts)
  let simultaneousPairs = 0
  let sameOutcomePairs = 0
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const dt = timed[j].ts - timed[i].ts
      if (dt > windowMs) break
      if (timed[i].bot !== timed[j].bot) {
        simultaneousPairs++
        if (timed[i].result === timed[j].result) sameOutcomePairs++
      }
    }
  }
  const agreementRate = simultaneousPairs ? sameOutcomePairs / simultaneousPairs : null
  const test = rateTest(sameOutcomePairs, simultaneousPairs, 0.5)
  return {
    pairs: simultaneousPairs,
    sameOutcomePairs,
    agreementRate,
    p: test.p
  }
}

/** Opponent Binomial Disparity Matrix (House Bot / Shill detection) */
function opponentDisparityAnalysis (orderedRecords, minBucket = 10) {
  const byOpponent = new Map()
  for (const row of orderedRecords) {
    const opp = row.opponent || '(unnamed)'
    if (!byOpponent.has(opp)) byOpponent.set(opp, { winsAgainstUs: 0, lossesAgainstUs: 0, n: 0, wagered: 0, net: 0 })
    const o = byOpponent.get(opp)
    o.n++
    const net = recordNet(row)
    o.net += net
    o.wagered += Number(row.wager) || 0
    if (row.result === STREAK.WON) o.lossesAgainstUs++
    else o.winsAgainstUs++
  }
  const rows = []
  for (const [opp, o] of byOpponent.entries()) {
    if (o.n < minBucket) continue
    const test = rateTest(o.winsAgainstUs, o.n, 0.5)
    rows.push({
      label: `opponent ${opp}`,
      n: o.n,
      wins: o.winsAgainstUs,
      losses: o.lossesAgainstUs,
      rate: o.winsAgainstUs / o.n,
      ci: wilsonInterval(o.winsAgainstUs, o.n),
      z: test.z,
      p: test.p,
      expected: 0.5,
      net: -o.net,
      note: `net impact on us: ${Number(o.net).toFixed(2)}`
    })
  }
  return rows.sort((a, b) => b.rate - a.rate)
}

function moneyCurve (ordered) {
  let cumulative = 0
  let peak = 0
  let maxDrawdown = 0
  let belowPeak = 0 // flips spent under the running high
  let currentRun = 0
  let longestDrawdown = 0
  let longestDrawdownStart = null
  let worst = null
  let best = null
  ordered.forEach((row, index) => {
    const net = recordNet(row)
    if (!worst || net < worst.net) worst = { net, row, index }
    if (!best || net > best.net) best = { net, row, index }
    cumulative += net
    if (cumulative >= peak) {
      // A new high ends the current stretch below it.
      peak = cumulative
      if (currentRun > longestDrawdown) { longestDrawdown = currentRun; longestDrawdownStart = index - currentRun }
      currentRun = 0
    } else {
      currentRun += 1
      belowPeak += 1
      if (peak - cumulative > maxDrawdown) maxDrawdown = peak - cumulative
    }
  })
  if (currentRun > longestDrawdown) { longestDrawdown = currentRun; longestDrawdownStart = ordered.length - currentRun }
  const nets = ordered.map(recordNet)
  const average = mean(nets)
  const sd = stdev(nets, average)
  const se = sd != null && nets.length ? sd / Math.sqrt(nets.length) : null
  return {
    total: cumulative,
    peak,
    maxDrawdown,
    currentDrawdown: peak - cumulative,
    belowPeak,
    longestDrawdown,
    longestDrawdownStart,
    atHigh: currentRun === 0,
    biggestWin: best ? { net: best.net, at: best.row.ts, bot: best.row.bot } : null,
    biggestLoss: worst ? { net: worst.net, at: worst.row.ts, bot: worst.row.bot } : null,
    netPerFlip: average,
    netCi: se == null ? null : { low: average - 1.96 * se, high: average + 1.96 * se }
  }
}

/** Helper to format numbers for row notes. */
function fmt (value) {
  if (value == null || !Number.isFinite(value)) return '–'
  const n = Number(value)
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + 'k'
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

/**
 * 1. Session-Level Monte Carlo Simulation
 * Simulates fair-coin sessions with the exact observed wager sequence.
 * Measures how likely the observed net loss and max drawdown are under a fair coin.
 *
 * Deterministic: accepts an optional `rng` function (default: xoshiro256** seeded from
 * the session ID) so results are reproducible.
 * Async: yields to event loop every `yieldEvery` iterations to avoid blocking.
 */
function sessionMonteCarlo (ordered, opts = {}) {
  const iterations = opts.iterations ?? 10000
  const rng = opts.rng ?? xoshiro256ss(seedFromSession(ordered))
  const yieldEvery = opts.yieldEvery ?? 1000

  if (!ordered.length) return { pNet: null, pDrawdown: null, simSummary: null }
  const wagers = ordered.map(row => Number(row.wager) || 0)
  const actualNet = sumOf(ordered.map(recordNet))
  const actualCurve = moneyCurve(ordered)
  const actualDrawdown = actualCurve.maxDrawdown

  let worseNetCount = 0
  let worseDrawdownCount = 0

  for (let sim = 0; sim < iterations; sim++) {
    let simNet = 0
    let simPeak = 0
    let simMaxDD = 0
    for (let i = 0; i < wagers.length; i++) {
      const win = rng() < 0.5
      const outcome = win ? wagers[i] : -wagers[i]
      simNet += outcome
      if (simNet > simPeak) simPeak = simNet
      const dd = simPeak - simNet
      if (dd > simMaxDD) simMaxDD = dd
    }
    // Two-tailed: count simulations with |net| >= |actualNet|
    if (Math.abs(simNet) >= Math.abs(actualNet)) worseNetCount++
    if (simMaxDD >= actualDrawdown) worseDrawdownCount++

    // Yield to event loop periodically for large sessions
    if (yieldEvery > 0 && sim % yieldEvery === yieldEvery - 1) {
      // await not possible here — caller wraps in Promise if needed
      // but we at least allow the loop to be interrupted via setImmediate
      // in the async wrapper below
    }
  }

  // Single continuity correction: (count + 0.5) / (iterations + 1)
  // Avoids double-correction from both <= comparison and +1/+1
  const pNet = (worseNetCount + 0.5) / (iterations + 1)
  const pDrawdown = (worseDrawdownCount + 0.5) / (iterations + 1)

  return {
    iterations,
    actualNet,
    actualDrawdown,
    pNet,
    pDrawdown,
    pCombined: Math.min(pNet, pDrawdown)
  }
}

/**
 * xoshiro256** PRNG — fast, good quality, seedable.
 * Returns a closure that yields [0,1) doubles.
 * Uses BigInt for 64-bit arithmetic without Uint64Array.
 */
function xoshiro256ss (seed) {
  // Splitmix64 to derive 4×64-bit state from a single 64-bit seed
  let x = BigInt(seed)
  let s = [0n, 0n, 0n, 0n]
  for (let i = 0; i < 4; i++) {
    x = (x + 0x9E3779B97F4A7C15n) & 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFn
    let z = x
    z = (z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n
    z = (z ^ (z >> 27n)) * 0x94D049BB133111EBn
    z = z ^ (z >> 31n)
    s[i] = z & 0xFFFFFFFFFFFFFFFFn
  }
  return () => {
    const s0 = s[0], s1 = s[1], s2 = s[2], s3 = s[3]
    const result = (s0 + s3) & 0xFFFFFFFFFFFFFFFFn
    const t = (s1 << 17n) & 0xFFFFFFFFFFFFFFFFn
    s[2] = (s[2] ^ s[0]) & 0xFFFFFFFFFFFFFFFFn
    s[3] = (s[3] ^ s[1]) & 0xFFFFFFFFFFFFFFFFn
    s[1] = (s[1] ^ s[2]) & 0xFFFFFFFFFFFFFFFFn
    s[0] = (s[0] ^ s[3]) & 0xFFFFFFFFFFFFFFFFn
    s[2] = (s[2] ^ t) & 0xFFFFFFFFFFFFFFFFn
    s[3] = ((s[3] << 45n) | (s[3] >> (64n - 45n))) & 0xFFFFFFFFFFFFFFFFn
    // Convert to [0,1) double using 53-bit mantissa
    return Number(result & 0x1FFFFFFFFFFFFFn) / 0x20000000000000
  }
}

function seedFromSession (ordered) {
  // Hash session ID + first flip timestamp for deterministic seed
  const first = ordered[0]
  const sessionId = first?.sessionId || 'unknown'
  const ts = first?.ts || Date.now()
  let hash = 0
  for (let i = 0; i < sessionId.length; i++) {
    hash = ((hash << 5) - hash + sessionId.charCodeAt(i)) | 0
  }
  return (Math.abs(hash) + ts) >>> 0
}

/**
 * Async wrapper that yields to the event loop every `yieldEvery` iterations.
 * Use when calling from request handlers to avoid blocking.
 */
async function sessionMonteCarloAsync (ordered, opts = {}) {
  const iterations = opts.iterations ?? 10000
  const rng = opts.rng ?? xoshiro256ss(seedFromSession(ordered))
  const yieldEvery = opts.yieldEvery ?? 1000

  if (!ordered.length) return { pNet: null, pDrawdown: null, simSummary: null }
  const wagers = ordered.map(row => Number(row.wager) || 0)
  const actualNet = sumOf(ordered.map(recordNet))
  const actualCurve = moneyCurve(ordered)
  const actualDrawdown = actualCurve.maxDrawdown

  let worseNetCount = 0
  let worseDrawdownCount = 0

  for (let sim = 0; sim < iterations; sim++) {
    let simNet = 0
    let simPeak = 0
    let simMaxDD = 0
    for (let i = 0; i < wagers.length; i++) {
      const win = rng() < 0.5
      const outcome = win ? wagers[i] : -wagers[i]
      simNet += outcome
      if (simNet > simPeak) simPeak = simNet
      const dd = simPeak - simNet
      if (dd > simMaxDD) simMaxDD = dd
    }
    // Two-tailed: count simulations with |net| >= |actualNet|
    if (Math.abs(simNet) >= Math.abs(actualNet)) worseNetCount++
    if (simMaxDD >= actualDrawdown) worseDrawdownCount++

    if (yieldEvery > 0 && sim % yieldEvery === yieldEvery - 1) {
      await new Promise(r => setImmediate(r))
    }
  }

  const pNet = (worseNetCount + 0.5) / (iterations + 1)
  const pDrawdown = (worseDrawdownCount + 0.5) / (iterations + 1)

  return {
    iterations,
    actualNet,
    actualDrawdown,
    pNet,
    pDrawdown,
    pCombined: Math.min(pNet, pDrawdown)
  }
}

/**
 * 2. Kelly Criterion Efficiency / Bet Sizing Optimality
 * Compares actual wager fractions (wager/balance) against Kelly-optimal fractions.
 */
function kellyEfficiency (ordered) {
  const validFlips = ordered.filter(r => r.balanceBefore != null && r.balanceBefore > 0 && r.wager != null)
  if (validFlips.length < 5) return { efficiency: null, rows: [] }

  const fractions = validFlips.map(r => Number(r.wager) / Number(r.balanceBefore))
  const avgFraction = mean(fractions)
  const wins = validFlips.filter(r => r.result === STREAK.WON).length
  const winRate = wins / validFlips.length

  // Kelly fraction f* = 2p - 1 for 1:1 odds
  const kellyOptimal = Math.max(0, 2 * winRate - 1)

  // Growth rate: E[log(1 + f * X)] where X in {+1, -1}
  // For f >= 1 (all-in), log(1-f) = log(negative) = NaN; treat as -Infinity (ruin)
  let actualLogGrowth = 0
  let hasRuin = false
  for (const f of fractions) {
    if (f >= 1) {
      hasRuin = true
      break
    }
    actualLogGrowth += winRate * Math.log(1 + f) + (1 - winRate) * Math.log(1 - f)
  }
  if (hasRuin) actualLogGrowth = -Infinity
  else actualLogGrowth /= validFlips.length

  let kellyLogGrowth = 0
  if (kellyOptimal > 0 && kellyOptimal < 1) {
    kellyLogGrowth = winRate * Math.log(1 + kellyOptimal) + (1 - winRate) * Math.log(1 - kellyOptimal)
  }

  let efficiency
  if (kellyOptimal <= 0) {
    // No edge → Kelly says bet 0; any positive bet is inefficient
    efficiency = avgFraction > 0 ? 0 : 1
  } else if (!Number.isFinite(actualLogGrowth) || actualLogGrowth <= 0) {
    // Ruin or non-positive growth
    efficiency = 0
  } else if (kellyLogGrowth <= 0) {
    // Kelly optimal is at boundary (p=1) or undefined
    efficiency = 1
  } else {
    efficiency = Math.min(1, Math.max(0, actualLogGrowth / kellyLogGrowth))
  }

  const rows = bucketRecords(validFlips, r => Number(r.wager) / Number(r.balanceBefore), [0.05, 0.2, 0.5], index => (
    index === 0 ? 'conservative (<5% balance)' : index === 1 ? 'moderate (5–20% balance)' : index === 2 ? 'aggressive (20–50% balance)' : 'all-in (>50% balance)'
  ))

  return {
    n: validFlips.length,
    winRate,
    avgFraction,
    kellyOptimal,
    actualLogGrowth,
    kellyLogGrowth,
    efficiency,
    rows
  }
}

/**
 * 3. Change-Point / Structural Break Detection
 * Scans candidate split points to detect mid-session win rate shifts.
 * Applies Bonferroni correction across candidate splits to avoid selection bias.
 */
function changePointAnalysis (ordered, minSegment = 15) {
  const outcomes = ordered.map(row => row.result)
  const n = outcomes.length
  if (n < minSegment * 2) return { breakPoint: null, rows: [] }

  let bestSplit = null
  let minP = 1.0
  const candidateRows = []

  // Check every split point; apply Bonferroni correction for selection bias
  const numCandidates = n - 2 * minSegment + 1
  for (let split = minSegment; split <= n - minSegment; split++) {
    const leftWins = outcomes.slice(0, split).filter(o => o === STREAK.WON).length
    const leftN = split
    const rightWins = outcomes.slice(split).filter(o => o === STREAK.WON).length
    const rightN = n - split

    const test = twoProportionTest(leftWins, leftN, rightWins, rightN)
    if (test.p != null && test.p < minP) {
      minP = test.p
      bestSplit = { split, leftWins, leftN, rightWins, rightN, p: test.p, z: test.z, diff: test.diff }
    }
  }

  if (bestSplit) {
    // Bonferroni-adjusted p-value for the minimum over all candidates
    const adjustedP = Math.min(1, bestSplit.p * numCandidates)
    candidateRows.push(rateFromCounts(`segment 1 (flips 1…${bestSplit.split})`, bestSplit.leftN, bestSplit.leftWins, { note: `raw p=${bestSplit.p.toExponential(3)}, Bonferroni×${numCandidates}=${adjustedP.toExponential(3)}` }))
    candidateRows.push(rateFromCounts(`segment 2 (flips ${bestSplit.split + 1}…${n})`, bestSplit.rightN, bestSplit.rightWins))
    bestSplit.pAdjusted = adjustedP
  }

  return {
    breakPoint: bestSplit,
    rows: candidateRows
  }
}

/**
 * 4. Adversarial Opponent Clustering
 * Groups opponents by behavioral similarity (win rate, average wager) to detect opponent rings.
 */
function opponentClusterAnalysis (ordered, minFlips = 5) {
  const byOpponent = new Map()
  for (const row of ordered) {
    const opp = row.opponent || '(unnamed)'
    if (!byOpponent.has(opp)) byOpponent.set(opp, [])
    byOpponent.get(opp).push(row)
  }

  const qualified = [...byOpponent.entries()]
    .filter(([_, rows]) => rows.length >= minFlips)
    .map(([opp, rows]) => {
      const wins = rows.filter(r => r.result === STREAK.WON).length
      const wagers = rows.map(r => Number(r.wager) || 0)
      return {
        opp,
        n: rows.length,
        wins,
        winRate: wins / rows.length,
        avgWager: mean(wagers),
        rows
      }
    })

  if (qualified.length < 2) return { opponentsTested: qualified.length, clusters: [], rows: [] }

  // Simple feature-based 2-cluster partitioning (aggressive vs passive)
  const medianWager = quantile(qualified.map(q => q.avgWager), 0.5) || 0
  const highWagerGroup = qualified.filter(q => q.avgWager >= medianWager)
  const lowWagerGroup = qualified.filter(q => q.avgWager < medianWager)

  const rows = []
  if (highWagerGroup.length) {
    const totalN = sumOf(highWagerGroup.map(g => g.n))
    const totalWins = sumOf(highWagerGroup.map(g => g.wins))
    rows.push(rateFromCounts(`high-wager opponents (≥${fmt(medianWager)})`, totalN, totalWins, { note: `${highWagerGroup.length} opponent accounts` }))
  }
  if (lowWagerGroup.length) {
    const totalN = sumOf(lowWagerGroup.map(g => g.n))
    const totalWins = sumOf(lowWagerGroup.map(g => g.wins))
    rows.push(rateFromCounts(`low-wager opponents (<${fmt(medianWager)})`, totalN, totalWins, { note: `${lowWagerGroup.length} opponent accounts` }))
  }

  return {
    opponentsTested: qualified.length,
    rows
  }
}

/**
 * 5. Sequential Probability Ratio Test (SPRT) Live Monitor
 * Wald's SPRT: H0 (p = 0.5) vs H1 (p = 0.45 house edge).
 */
function sprtMonitor (ordered, p0 = 0.5, p1 = 0.45, alpha = 0.01, beta = 0.10) {
  const outcomes = ordered.map(row => row.result)
  const n = outcomes.length
  if (!n) return { llr: 0, decision: 'continue', rows: [] }

  const wins = outcomes.filter(o => o === STREAK.WON).length
  const losses = n - wins

  // Log-Likelihood Ratio
  const llr = wins * Math.log(p1 / p0) + losses * Math.log((1 - p1) / (1 - p0))

  const lowerBound = Math.log(beta / (1 - alpha)) // Reject H1 (accept H0 = fair)
  const upperBound = Math.log((1 - beta) / alpha) // Accept H1 (reject H0 = rigged)

  let decision = 'continue'
  if (llr <= lowerBound) decision = 'accept_fair (H0)'
  else if (llr >= upperBound) decision = 'reject_fair (H1)'

  const rows = [
    rateFromCounts(`SPRT sequential test (n=${n})`, n, wins, {
      expected: p0,
      note: `LLR=${llr.toFixed(3)}, bounds [${lowerBound.toFixed(2)}, ${upperBound.toFixed(2)}], state: ${decision}`
    })
  ]

  return {
    n,
    wins,
    losses,
    llr,
    lowerBound,
    upperBound,
    decision,
    rows
  }
}

/**
 * Every dissection, in one report. `sections` is a uniform shape on purpose, so
 * the chat digest and the HTML page render the same numbers without either of
 * them owning the statistics.
 */
function deepAnalysis (records = [], opts = {}) {
  const q = opts.q == null ? 0.05 : opts.q
  const minBucket = opts.minBucket == null ? 20 : opts.minBucket
  const maxRun = opts.maxRun == null ? 6 : opts.maxRun
  const horizon = opts.horizon == null ? 3 : opts.horizon
  const tzOffsetMinutes = opts.tzOffsetMinutes == null ? -new Date().getTimezoneOffset() : opts.tzOffsetMinutes

  const ordered = inTimeOrder(records)
  const outcomes = ordered.map(row => row.result)
  const resolved = ordered.length
  const wins = outcomes.filter(o => o === STREAK.WON).length
  const overall = rateFromCounts('all resolved flips', resolved, wins, { net: sumOf(ordered.map(recordNet)) })

  // The hour is resolved once per record. Deriving it again inside each bucket
  // (and inside all four windows) would allocate a quarter of a million objects
  // for no extra information.
  const hours = ordered.map(row => hourOfRecord(row, tzOffsetMinutes))
  const knownHours = hours.filter(Boolean)
  const hourSource = !knownHours.length ? 'none'
    : knownHours.every(h => h.source === 'server') ? 'server'
      : knownHours.every(h => h.source === 'local') ? 'local' : 'mixed'

  const sections = []

  // 1 — streaks.
  const streakRows = conditionalStreakRows(outcomes, maxRun, horizon)
  const streakWorst = [...streakRows].sort((a, b) => (a.p == null ? 1 : a.p) - (b.p == null ? 1 : b.p))[0]
  sections.push({
    key: 'streak',
    title: 'Runs and what follows them',
    question: 'Does a run of losses (or wins) change the next flip, and does N losses usually become a win within a few flips?',
    summary: streakWorst
      ? `Strongest row: ${streakWorst.label} — ${pctText(streakWorst.rate)} over n=${streakWorst.n} (p=${streakWorst.p == null ? 'n/a' : streakWorst.p.toExponential(3)})`
      : 'Not enough runs to test.',
    rows: streakRows
  })

  // NEW — Session Monte Carlo: how likely is this path under a fair coin?
  const monte = sessionMonteCarlo(ordered)
  if (monte.pNet != null) {
    sections.push({
      key: 'montecarlo',
      title: 'Monte Carlo path test',
      question: 'How likely is the observed net and drawdown under a fair coin with these exact wagers?',
      summary: `10,000 simulations with identical wagers: P(|net| ≥ ${Math.abs(monte.actualNet).toFixed(2)}) = ${monte.pNet.toExponential(2)}; P(drawdown ≥ ${monte.actualDrawdown.toFixed(2)}) = ${monte.pDrawdown.toExponential(2)}. Combined p = ${monte.pCombined.toExponential(2)}.`,
      rows: [{
        label: 'Monte Carlo two-tailed path test',
        n: monte.iterations,
        wins: null,
        losses: null,
        rate: null,
        ci: null,
        z: null,
        p: monte.pCombined,
        expected: null,
        net: null,
        wagered: null,
        score: null,
        note: `net two-tailed p=${monte.pNet.toExponential(3)}, drawdown p=${monte.pDrawdown.toExponential(3)}, combined p=${monte.pCombined.toExponential(3)}`,
        lowSample: false
      }],
      extra: { noCorrection: true }
    })
  }

  // 2 — the transition table.
  const markov = markovAnalysis(outcomes)
  const markovRows = [
    rateFromCounts('after a win → win', markov.nAfterWin, markov.counts.ww, { note: `P(win | win) = ${pctText(markov.pWinAfterWin, 2)}` }),
    rateFromCounts('after a loss → win', markov.nAfterLoss, markov.counts.lw, { note: `P(win | loss) = ${pctText(markov.pWinAfterLoss, 2)}` })
  ]
  sections.push({
    key: 'markov',
    title: 'Does the previous flip predict the next one?',
    question: 'If the last flip was a loss, is the next one different from when the last flip was a win?',
    summary: markov.diff == null
      ? 'Not enough consecutive flips.'
      : `P(win | win) ${pctText(markov.pWinAfterWin, 2)} vs P(win | loss) ${pctText(markov.pWinAfterLoss, 2)} — difference ${(markov.diff * 100).toFixed(2)} pp (p=${markov.p == null ? 'n/a' : markov.p.toFixed(4)}); persistence odds ratio ${markov.oddsRatio == null ? 'n/a' : markov.oddsRatio.toFixed(3)}`,
    rows: markovRows,
    extra: { chi2: markov.chi2, chi2p: markov.p, df: markov.df }
  })

  // 3 — run lengths against the geometric distribution.
  const runLengths = runLengthAnalysis(outcomes)
  const runRows = runLengths.observed.map((count, i) => {
    const length = i + 1
    const label = length >= runLengths.observed.length ? `${length}+ in a row` : `exactly ${length} in a row`
    return rateFromCounts(label, runLengths.total, count, {
      expected: runLengths.expected[i] / (runLengths.total || 1),
      note: `expected ${runLengths.expected[i].toFixed(1)}`
    })
  })
  sections.push({
    key: 'runs',
    title: 'How long the runs are',
    question: 'A fair coin self-corrects by chopping streaks off; a rigged one lets them run.',
    summary: runLengths.p == null
      ? `${runLengths.total} run(s) — too few to compare with the geometric expectation.`
      : `${runLengths.total} runs vs a geometric expectation (χ²=${runLengths.chi2.toFixed(2)}, df=${runLengths.df}, p=${runLengths.p.toFixed(4)})`,
    rows: runRows,
    extra: { chi2: runLengths.chi2, chi2p: runLengths.p, df: runLengths.df }
  })

  // 4 — serial correlation at several lags.
  const lags = []
  for (let lag = 1; lag <= (opts.maxLag == null ? 5 : opts.maxLag); lag++) lags.push(autocorrelation(outcomes, lag))
  // A lag row is a correlation rather than a win rate, so it does not go
  // through rateFromCounts — but its p-value belongs to the same family.
  const lagRows = lags.map(entry => ({
    label: `lag ${entry.lag}`,
    n: entry.n,
    wins: null,
    losses: null,
    rate: null,
    ci: null,
    z: null,
    p: entry.p,
    expected: null,
    net: null,
    wagered: null,
    score: null,
    note: entry.r == null ? 'not enough pairs' : `r = ${entry.r.toFixed(4)}`,
    lowSample: false
  }))
  sections.push({
    key: 'lag',
    title: 'Serial correlation',
    question: 'Is any flip correlated with the one N flips before it?',
    summary: lags.filter(l => l.p != null).length
      ? lags.filter(l => l.p != null).map(l => `lag ${l.lag}: r=${l.r.toFixed(3)} (p=${l.p.toFixed(3)})`).join(' · ')
      : 'Not enough flips to correlate.',
    rows: lagRows
  })

  // NEW — Change-point detection: did the win rate shift mid-session?
  const changePoint = changePointAnalysis(ordered)
  if (changePoint.breakPoint) {
    sections.push({
      key: 'changepoint',
      title: 'Structural break detection',
      question: 'Did the win rate change abruptly during the session (server change, account switch)?',
      summary: `Most likely break at flip #${changePoint.breakPoint.split}: before ${pctText(changePoint.breakPoint.leftWins / changePoint.breakPoint.leftN)} (n=${changePoint.breakPoint.leftN}) vs after ${pctText(changePoint.breakPoint.rightWins / changePoint.breakPoint.rightN)} (n=${changePoint.breakPoint.rightN}), p=${changePoint.breakPoint.p.toExponential(3)}.`,
      rows: changePoint.rows
    })
  }

  // 5 — the share of the balance staked.
  const ratioEdges = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 1]
  const ratioLabel = (index) => {
    if (index === 0) return `< 0.5% of balance`
    if (index >= ratioEdges.length) return `≥ 100% of balance`
    return `${(ratioEdges[index - 1] * 100).toFixed(1)}–${(ratioEdges[index] * 100).toFixed(1)}% of balance`
  }
  const ratioScores = (index) => {
    if (index === 0) return ratioEdges[0] / 2
    if (index >= ratioEdges.length) return ratioEdges[ratioEdges.length - 1] * 1.5
    return (ratioEdges[index - 1] + ratioEdges[index]) / 2
  }
  const ratioRows = bucketRecords(ordered, row => (
    Number(row.balanceBefore) > 0 && Number(row.wager) > 0 ? Number(row.wager) / Number(row.balanceBefore) : null
  ), ratioEdges, ratioLabel)
  // The trend test needs a numeric position per bucket, so the bucket order is
  // the score — not the label, which is a range written for a human.
  ratioRows.forEach((row, i) => { row.score = ratioScores(i) })
  const ratioTrend = trendTest(ratioRows)
  // One pass for the mean share staked either side of the coin.
  let winShare = 0
  let winShareCount = 0
  let lossShare = 0
  let lossShareCount = 0
  for (const row of ordered) {
    const balance = Number(row.balanceBefore)
    const wager = Number(row.wager)
    if (!(balance > 0) || !(wager > 0)) continue
    if (row.result === STREAK.WON) { winShare += wager / balance; winShareCount++ }
    else { lossShare += wager / balance; lossShareCount++ }
  }
  sections.push({
    key: 'ratio',
    title: 'Wager as a share of the balance',
    question: 'Does betting a bigger slice of the balance change the odds?',
    summary: ratioTrend.p == null
      ? 'Needs a balance before each flip (recorded from the next run onwards).'
      : `Trend across buckets: ${ratioTrend.direction} (z=${ratioTrend.z.toFixed(3)}, p=${ratioTrend.p.toFixed(4)}). Mean share staked: ${pctText(winShare / Math.max(1, winShareCount), 2)} when winning vs ${pctText(lossShare / Math.max(1, lossShareCount), 2)} when losing.`,
    rows: ratioRows,
    extra: { trend: ratioTrend }
  })

  // NEW — Kelly Criterion Efficiency: are we overbetting relative to optimal?
  const kelly = kellyEfficiency(ordered)
  if (kelly.efficiency != null) {
    sections.push({
      key: 'kelly',
      title: 'Kelly criterion efficiency',
      question: 'Is the bet sizing optimal for long-term growth, or are we overbetting?',
      summary: `Average fraction staked: ${pctText(kelly.avgFraction, 2)}; Kelly-optimal: ${pctText(kelly.kellyOptimal, 2)}; growth efficiency: ${pctText(kelly.efficiency, 1)}. ${kelly.efficiency < 1 ? `Overbetting costs ${((1 - kelly.efficiency) * 100).toFixed(1)}% in growth per flip.` : 'Sizing is Kelly-optimal or conservative.'}`,
      rows: kelly.rows
    })
  }

  // 6 — absolute wager size.
  const wagerEdges = [10000, 50000, 250000, 1000000, 5000000]
  const wagerRows = bucketRecords(ordered, row => Number(row.wager), wagerEdges, (index) => (
    index === 0 ? '< 10k' : index >= wagerEdges.length ? '≥ 5m' : `${wagerEdges[index - 1] / 1000}k–${wagerEdges[index] / 1000}k`
  ))
  wagerRows.forEach((row, i) => { row.score = i })
  sections.push({
    key: 'wager',
    title: 'Wager size (absolute)',
    question: 'Do bigger bets win less often?',
    summary: trendTest(wagerRows).p == null
      ? 'Not enough flips spread across wager sizes.'
      : `Trend: ${trendTest(wagerRows).direction} (p=${trendTest(wagerRows).p.toFixed(4)})`,
    rows: wagerRows,
    extra: { trend: trendTest(wagerRows) }
  })

  // 7 — how rich the bot was at the time.
  const balances = ordered.map(row => Number(row.balanceBefore)).filter(v => Number.isFinite(v) && v > 0)
  const sortedBalances = balances.length ? balances.slice().sort((a, b) => a - b) : []
  const balanceEdges = balances.length >= 4
    ? [quantileSorted(sortedBalances, 0.25), quantileSorted(sortedBalances, 0.75)]
    : []
  const balanceRows = balanceEdges.length === 2 && balanceEdges[0] !== balanceEdges[1]
    ? bucketRecords(ordered, row => (Number(row.balanceBefore) > 0 ? Number(row.balanceBefore) : null), balanceEdges, (index) => (
        index === 0 ? 'poorest quartile' : index === 1 ? 'middle half' : 'richest quartile'
      ))
    : []
  balanceRows.forEach((row, i) => { row.score = i })
  sections.push({
    key: 'balance',
    title: 'Does being rich or poor matter?',
    question: 'Is the win rate different when the bot is on its richest vs its poorest days?',
    summary: balanceRows.length
      ? `Quartile boundaries: ${balanceEdges.map(v => v.toLocaleString(undefined, { maximumFractionDigits: 0 })).join(' / ')}`
      : 'Not enough recorded balances yet.',
    rows: balanceRows
  })

  // 8 — the hour of day.
  const hourBuckets = new Map()
  for (let i = 0; i < ordered.length; i++) {
    if (!hours[i]) continue
    pushBucket(hourBuckets, hours[i].hour, ordered[i])
  }
  const hourKeys = [...hourBuckets.keys()].sort((a, b) => a - b)
  const hourRows = finishBuckets(hourBuckets, (hour) => `${String(hour).padStart(2, '0')}:00–${String(hour).padStart(2, '0')}:59`)
    .map((row, i) => { row.score = hourKeys[i]; return row })
  const windows = [['00:00–05:59', 0, 6], ['06:00–11:59', 6, 12], ['12:00–17:59', 12, 18], ['18:00–23:59', 18, 24]]
  const windowRows = windows.map(([label, from, to]) => rateRow(label, ordered.filter((row, i) => hours[i] && hours[i].hour >= from && hours[i].hour < to), { score: from })).filter(row => row.n > 0)
  const bestHour = [...hourRows].filter(row => row.p != null).sort((a, b) => a.p - b.p)[0]
  sections.push({
    key: 'hour',
    title: 'Time of day',
    question: 'Do some hours win more? People gaming the system would show up here.',
    summary: hourSource === 'none'
      ? 'No timestamps recorded.'
      : `${hourRows.length} hour bucket(s) on the ${hourSource} clock${bestHour ? `; most extreme ${bestHour.label} at ${pctText(bestHour.rate)} (n=${bestHour.n}, p=${bestHour.p.toFixed(4)}, before correction)` : ''}. With 24 buckets, expect at least one to look surprising by chance alone.`,
    rows: [...windowRows, ...hourRows],
    extra: { hourSource }
  })

  // 9 — pace.
  const paceValues = paceEntries(ordered, true)
  const paceEdges = [5000, 15000, 60000, 300000, 1800000]
  const paceRows = bucketEntries(paceValues, paceEdges, (index) => (
    index === 0 ? 'under 5s later' : index === 1 ? '5–15s later' : index === 2 ? '15–60s later' : index === 3 ? '1–5 min later' : index === 4 ? '5–30 min later' : '30+ min later'
  ))
  paceRows.forEach((row, i) => { row.score = i })
  sections.push({
    key: 'pace',
    title: 'Pace and idling',
    question: 'Does leaving a longer gap between flips change the odds?',
    summary: paceRows.length
      ? ['Gap since the previous flip on the same bot.', trendTest(paceRows).p == null ? '' : `Trend: ${trendTest(paceRows).direction} (p=${trendTest(paceRows).p.toFixed(4)})`].filter(Boolean).join(' ')
      : 'Not enough flips in a sequence yet.',
    rows: paceRows,
    extra: { trend: trendTest(paceRows) }
  })

  // 10 — where in the session the flip fell.
  const positionEdges = [1, 3, 6, 10, 20]
  const positionRows = bucketRecords(ordered, row => (Number.isFinite(Number(row.index)) ? Number(row.index) : null), positionEdges, (index) => (
    index === 0 ? 'flip #1' : index === 1 ? 'flips #2–3' : index === 2 ? 'flips #4–6' : index === 3 ? 'flips #7–10' : index === 4 ? 'flips #11–20' : 'flips #21+'
  ))
  positionRows.forEach((row, i) => { row.score = i })
  sections.push({
    key: 'position',
    title: 'Position in the session',
    question: 'Does the first flip behave differently from the tenth?',
    summary: positionRows.length > 1
      ? `First flip ${pctText(positionRows[0].rate)} (n=${positionRows[0].n}) vs the rest. ${trendTest(positionRows).p == null ? '' : `Trend: ${trendTest(positionRows).direction} (p=${trendTest(positionRows).p.toFixed(4)})`}`
      : 'Not enough flips with a session position yet.',
    rows: positionRows,
    extra: { trend: trendTest(positionRows) }
  })

  // 11 — martingale behaviour.
  const { entries: martingale, afterLoss } = martingaleEntries(ordered, true)
  const martingaleRows = bucketEntries(martingale.map(entry => ({ row: entry.row, key: entry.key })), [-0.5, 0.5], (index) => (
    index === 0 ? 'wager was lowered' : index === 1 ? 'wager was unchanged' : 'wager was raised'
  ))
  martingaleRows.forEach((row, i) => { row.score = i })
  const afterLossRows = afterLoss.length >= 5 ? [rateRow('after a loss, the wager was raised', afterLoss)] : []
  sections.push({
    key: 'martingale',
    title: 'Chasing and staking patterns',
    question: 'When the bet is raised after a loss, does it win more often?',
    summary: afterLoss.length
      ? `${afterLoss.length} flip(s) followed a loss with a raised wager and won ${pctText(afterLoss.filter(r => r.result === STREAK.WON).length / afterLoss.length)} of the time.`
      : 'No raised-after-a-loss flips recorded.',
    rows: [...martingaleRows, ...afterLossRows]
  })

  // 12 — opponents.
  const byOpponent = new Map()
  for (const row of ordered) {
    const key = row.opponent || '(unnamed)'
    if (!byOpponent.has(key)) byOpponent.set(key, [])
    byOpponent.get(key).push(row)
  }
  const opponentRows = [...byOpponent.entries()]
    .map(([name, rows]) => rateRow(name, rows))
    .sort((a, b) => b.n - a.n)
  const worstOpponent = [...opponentRows].filter(row => row.p != null && row.n >= minBucket).sort((a, b) => a.p - b.p)[0]
  sections.push({
    key: 'opponent',
    title: 'Opponents',
    question: 'Is one opponent beating us far more than the coin says they should?',
    summary: opponentRows.length
      ? `${opponentRows.length} named opponent(s); in a fair game any of them landing at p<0.05 is normal — the most extreme with n≥${minBucket} is ${worstOpponent ? `${worstOpponent.label} at ${pctText(worstOpponent.rate)} (n=${worstOpponent.n}, p=${worstOpponent.p.toFixed(4)}, before correction)` : 'not large enough yet'}`
      : 'No named opponents recorded.',
    rows: opponentRows
  })

  // 13 — the money curve.
  const curve = moneyCurve(ordered)
  sections.push({
    key: 'money',
    title: 'The money curve',
    question: 'What does the cumulative net actually look like — drawdowns, swings, and drift?',
    summary: `Net ${curve.total.toFixed(2)} over ${resolved} flip(s); deepest drawdown ${curve.maxDrawdown.toFixed(2)} (longest stretch below a high: ${curve.longestDrawdown} flips, ${curve.belowPeak} flips in total); currently ${curve.atHigh ? 'at a new high' : `${curve.currentDrawdown.toFixed(2)} below the high`}; net per flip ${curve.netPerFlip == null ? 'n/a' : curve.netPerFlip.toFixed(2)}${curve.netCi ? ` (95% CI ${curve.netCi.low.toFixed(2)}…${curve.netCi.high.toFixed(2)})` : ''}`,
    rows: [],
    extra: { curve }
  })

  // NEW — SPRT Live Monitor: sequential decision boundaries for live monitoring
  const sprt = sprtMonitor(ordered)
  if (sprt.decision !== 'continue') {
    sections.push({
      key: 'sprt',
      title: 'SPRT sequential test',
      question: 'Can we already reject the fair-coin hypothesis with statistical rigor?',
      summary: `LLR = ${sprt.llr.toFixed(3)}, bounds [${sprt.lowerBound.toFixed(2)}, ${sprt.upperBound.toFixed(2)}]; decision: ${sprt.decision.replace('_', ' ')}. ${sprt.decision === 'reject_fair (H1)' ? 'Stop the session — statistically significant evidence of house edge.' : 'Session passes sequential fairness test so far.'}`,
      rows: sprt.rows
    })
  }

  // 14 — fleet homogeneity: are all accounts on the same luck curve?
  const fleetHomogeneity = fleetHomogeneityTest(ordered)
  sections.push({
    key: 'fleet',
    title: 'Fleet homogeneity',
    question: 'Do all bots share the same win rate, or does the server hand out luck per account?',
    summary: fleetHomogeneity.chi2 == null
      ? 'Not enough bots with enough flips to compare.'
      : `${fleetHomogeneity.bots} bot(s) compared (χ²=${fleetHomogeneity.chi2.toFixed(2)}, df=${fleetHomogeneity.df}, p=${fleetHomogeneity.p == null ? 'n/a' : fleetHomogeneity.p.toFixed(4)}). Pooled p=${pctText(fleetHomogeneity.pBar, 2)}. A p<0.01 means the bots are NOT on the same luck curve — some accounts are blessed or cursed.`,
    rows: [],
    extra: { chi2: fleetHomogeneity.chi2, chi2p: fleetHomogeneity.p, df: fleetHomogeneity.df }
  })

  // 15 — Kaplan-Meier hazard rate: are streaks cut off at a hard cap?
  const hazardRows = streakHazardAnalysis(outcomes, 8)
  sections.push({
    key: 'hazard',
    title: 'Streak hard-caps',
    question: 'Does the server force a loss after N consecutive wins (or a win after N losses)?',
    summary: hazardRows.length
      ? `Hazard of streak ending at each step: ${hazardRows.slice(0, 4).map(r => `${r.label.split(' ')[2]}× = ${pctText(r.rate, 1)} (n=${r.n})`).join(' · ')}`
      : 'Not enough streaks of length ≥1 to measure.',
    rows: hazardRows
  })

  // 16 — rolling profit decay: does the win rate collapse after a big run?
  const profitCap = profitCapAnalysis(ordered)
  sections.push({
    key: 'profit',
    title: 'Profit soft-caps',
    question: 'Does the win rate fall off as cumulative profit rises — a daily or session cap?',
    summary: profitCap.rows.length
      ? `Win rate across profit quartiles: ${profitCap.rows.map(r => `${r.label}: ${pctText(r.rate, 1)} (n=${r.n})`).join(' · ')}${profitCap.trend.p == null ? '' : ` · trend p=${profitCap.trend.p.toFixed(4)}`}`
      : 'Not enough cumulative profit spread to bucket.',
    rows: profitCap.rows,
    extra: { trend: profitCap.trend }
  })

  // 17 — simultaneous flip cross-correlation across bots
  const simultaneous = simultaneousFlipAnalysis(ordered)
  sections.push({
    key: 'simultaneous',
    title: 'Simultaneous flips',
    question: 'Do bots flipping on the same server tick share the same outcome (shared PRNG state)?',
    summary: simultaneous.pairs == null || simultaneous.pairs < 10
      ? `${simultaneous.pairs || 0} simultaneous pairs — not enough to test for a shared PRNG.`
      : `${simultaneous.pairs} simultaneous pairs across different bots; ${pctText(simultaneous.agreementRate, 1)} agreed on the same outcome (p=${simultaneous.p == null ? 'n/a' : simultaneous.p.toExponential(2)}). A fair coin with independent PRNGs gives 50%.`,
    rows: [],
    extra: { pairs: simultaneous.pairs, sameOutcomePairs: simultaneous.sameOutcomePairs, agreementRate: simultaneous.agreementRate, p: simultaneous.p }
  })

  // 18 — opponent binomial disparity matrix (house bot / shill detection)
  const opponentDisparity = opponentDisparityAnalysis(ordered, minBucket)
  sections.push({
    key: 'disparity',
    title: 'Opponent disparity',
    question: 'Is one opponent account winning far more than the coin says they should (a house bot or staff account)?',
    summary: opponentDisparity.length
      ? `${opponentDisparity.length} opponent(s) with n≥${minBucket}. Most extreme: ${opponentDisparity[0].label} at ${pctText(opponentDisparity[0].rate, 1)} (n=${opponentDisparity[0].n}, p=${opponentDisparity[0].p == null ? 'n/a' : opponentDisparity[0].p.toExponential(2)}).`
      : 'No opponents with enough flips to test.',
    rows: opponentDisparity
  })

  // NEW — Adversarial Opponent Clustering: find coordinated opponent rings
  const opponentClusters = opponentClusterAnalysis(ordered)
  if (opponentClusters.rows.length) {
    sections.push({
      key: 'opponent_clusters',
      title: 'Opponent behavioral clusters',
      question: 'Do opponent accounts cluster into coordinated groups with different win rates?',
      summary: `Found ${opponentClusters.opponentsTested} opponents with enough flips; split into ${opponentClusters.rows.length} behavioral clusters by wager style. ${opponentClusters.rows.map(r => `${r.label}: ${pctText(r.rate)} (n=${r.n})`).join(' · ')}.`,
      rows: opponentClusters.rows
    })
  }

  // 14 — per bot, which is only a dissection when there is a fleet.
  const byBot = new Map()
  for (const row of ordered) {
    const key = row.bot || '(unknown)'
    if (!byBot.has(key)) byBot.set(key, [])
    byBot.get(key).push(row)
  }
  const botRows = [...byBot.entries()].map(([name, rows]) => rateRow(name, rows)).sort((a, b) => b.n - a.n)
  if (botRows.length > 1) {
    sections.push({
      key: 'bot',
      title: 'Per bot',
      question: 'Is one bot winning far more than the others?',
      summary: botRows.map(row => `${row.label}: ${pctText(row.rate)} (n=${row.n})`).join(' · '),
      rows: botRows
    })
  }

  // One family of tests, one correction. Every bucket p-value above is in here.
  // Sections marked with extra.noCorrection are excluded from the BH family.
  const flat = []
  for (const section of sections) {
    if (section.extra && section.extra.noCorrection) continue
    if (Array.isArray(section.rows)) {
      for (const row of section.rows) flat.push(row)
    }
    if (section.extra && section.extra.chi2p != null) flat.push({ p: section.extra.chi2p })
    if (section.extra && section.extra.trend && section.extra.trend.p != null) flat.push({ p: section.extra.trend.p })
  }
  const adjusted = bhAdjust(flat.map(row => row.p), q)
  flat.forEach((row, i) => {
    if (adjusted[i]) { row.q = adjusted[i].q; row.significant = adjusted[i].significant }
    if (row.n != null && row.n < minBucket) row.lowSample = true
  })

  const survivors = sections.flatMap(section => (Array.isArray(section.rows) ? section.rows : []).map(row => ({ section: section.key, ...row })))
    .filter(row => row && row.significant && row.q != null)
    .sort((a, b) => a.q - b.q)

  const takeaways = []
  takeaways.push(`Overall ${wins}W/${resolved - wins}L = ${pctText(overall.rate)} over ${resolved} resolved flip(s); a fair coin is 50% (two-sided p=${overall.p == null ? 'n/a' : overall.p.toExponential(3)}).`)
  takeaways.push(markov.diff == null
    ? 'Not enough consecutive flips to say whether the previous result predicts the next.'
    : `After a loss the next flip won ${pctText(markov.pWinAfterLoss)} of the time (n=${markov.nAfterLoss}); after a win ${pctText(markov.pWinAfterWin)} (n=${markov.nAfterWin}). P(win|win) − P(win|loss) = ${(markov.diff * 100).toFixed(2)} pp, p=${markov.p == null ? 'n/a' : markov.p.toFixed(4)}.`)
  takeaways.push(ratioTrend.p == null
    ? 'Wager-to-balance ratio needs balanceBefore on the records (from this version onwards).'
    : `Staking a bigger share of the balance ${ratioTrend.direction} (trend p=${ratioTrend.p.toFixed(4)}).`)
  const afterTwoLosses = streakRows.find(row => row.label === 'after 2× loss, the next flip won')
  const bothAfterTwoLosses = streakRows.find(row => row.label === 'after 2× loss, both of the next 2 flips won')
  if (afterTwoLosses && afterTwoLosses.n >= minBucket) {
    takeaways.push(`After two losses: the next flip won ${pctText(afterTwoLosses.rate)} of the time, and both of the next two won ${bothAfterTwoLosses ? `${pctText(bothAfterTwoLosses.rate)} (n=${bothAfterTwoLosses.n})` : 'n/a'} — a fair coin gives 50% and 25%.`)
  }
  if (hourSource !== 'none') {
    takeaways.push(hourRows.length
      ? `Time of day: ${hourRows.length} hour bucket(s) recorded; the most extreme is ${[...hourRows].filter(r => r.p != null).sort((a, b) => a.p - b.p)[0].label}. Surviving the multiple-testing correction needs far more flips.`
      : 'Time of day: no hour buckets yet.')
  }
  if (survivors.length) {
    takeaways.push(`${survivors.length} finding(s) survive the ${q} false-discovery-rate correction across ${flat.length} tests: ${survivors.slice(0, 5).map(row => `${row.label} (${pctText(row.rate)}, n=${row.n}, q=${row.q.toExponential(2)})`).join('; ')}.`)
  } else {
    takeaways.push(`No dissection survives the ${q} false-discovery-rate correction across ${flat.length} tests — with this sample the coinflip looks like a fair coin in every slicing.`)
  }

  return {
    generatedAt: Date.now(),
    resolved,
    wins,
    losses: resolved - wins,
    unresolved: (records || []).length - resolved,
    winRate: overall.rate,
    ci: overall.ci,
    p: overall.p,
    z: overall.z,
    net: overall.net,
    hourSource,
    q,
    minBucket,
    tests: flat.length,
    sections,
    markov,
    runLengths,
    autocorrelation: lags,
    ratioTrend,
    curve,
    takeaways
  }
}

module.exports = {
  deepAnalysis,
  fleetHomogeneityTest,
  streakHazardAnalysis,
  profitCapAnalysis,
  simultaneousFlipAnalysis,
  opponentDisparityAnalysis,
  conditionalStreakRows,
  runLengthAnalysis,
  markovAnalysis,
  autocorrelation,
  trendTest,
  chiSquare2x2,
  chiSquareP,
  twoProportionTest,
  rateTest,
  rateFromCounts,
  rateRow,
  bhAdjust,
  bucketEntries,
  bucketRecords,
  bucketIndex,
  quantileSorted,
  hourOfRecord,
  inTimeOrder,
  moneyCurve,
  paceEntries,
  martingaleEntries,
  quantile,
  recordNet,
  sessionMonteCarlo,
  kellyEfficiency,
  changePointAnalysis,
  sprtMonitor,
  opponentClusterAnalysis,
  sumOf,
  pctText
}
