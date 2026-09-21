'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cf = require('../coinflip')

// ── Parsing ──────────────────────────────────────────────────────────────────

test('money parses the way the server and a human write it', () => {
  assert.equal(cf.parseAmount('20000'), 20000)
  assert.equal(cf.parseAmount('$20,000'), 20000)
  assert.equal(cf.parseAmount('10k'), 10000)
  assert.equal(cf.parseAmount('1.5m'), 1500000)
  assert.equal(cf.parseAmount('2b'), 2000000000)
  assert.equal(cf.parseAmount('nonsense'), null)
})

test('the timestamp the server prefixes to every line is stripped before matching', () => {
  assert.equal(cf.cleanLine('2:50:43 AM Result: Lost'), 'Result: Lost')
  assert.equal(cf.cleanLine('[23:59] Amount Bet: $1,000'), 'Amount Bet: $1,000')
  assert.equal(cf.cleanLine('12:05:01 PM Winner: BotA'), 'Winner: BotA')
})

// The exact block the user pasted, one line per chat message.
test('a real result block is classified line by line', () => {
  assert.deepEqual(cf.classifyCoinflipLine('2:50:43 AM Result: Lost'), { kind: 'result', result: 'lost', line: 'Result: Lost' })
  assert.equal(cf.classifyCoinflipLine('Amount Bet: $20,000').amount, 20000)
  assert.deepEqual(cf.classifyCoinflipLine('Winner: Jt2S1m3ePer'), { kind: 'winner', name: 'Jt2S1m3ePer', line: 'Winner: Jt2S1m3ePer' })
  assert.equal(cf.classifyCoinflipLine('Loser: Eryx_ThorneFY').name, 'Eryx_ThorneFY')
})

test('the busy line the user quoted is recognised', () => {
  const verdict = cf.classifyCoinflipLine('You already have an active coinflip! Please use /coinflip delete first, if you wish to create a new one!')
  assert.equal(verdict.kind, 'busy')
})

test('unrelated chat is never mistaken for coinflip traffic', () => {
  assert.equal(cf.classifyCoinflipLine('BotA: wrong password'), null)
  assert.equal(cf.classifyCoinflipLine('Steve joined the game'), null)
  assert.equal(cf.classifyCoinflipLine('Result: something else entirely'), null)
  // A line that only mentions the word must not count as a result.
  assert.equal(cf.classifyCoinflipLine('Loser: how about that coinflip huh'), null)
})

test('a wager argument is either a fixed amount or a range', () => {
  assert.deepEqual(cf.parseWagerSpec('500000'), { kind: 'fixed', amount: 500000, raw: '500000' })
  assert.deepEqual(cf.parseWagerSpec('10k-1m'), { kind: 'range', min: 10000, max: 1000000, raw: '10k-1m' })
  assert.equal(cf.parseWagerSpec('1m-10k').error !== undefined, true)
  assert.equal(cf.parseWagerSpec('banana').error !== undefined, true)
  assert.deepEqual(cf.parseWagerSpec('', { min: 10000, max: 1000000 }), { kind: 'range', min: 10000, max: 1000000, raw: 'default' })
})

test('parseCoinflipRunArgs reads PRICE, AMOUNT, BOT in that order and by name', () => {
  assert.deepEqual(cf.parseCoinflipRunArgs(['10k-1m', '5', 'BotA']), { flips: 5, bot: 'BotA', wager: { kind: 'range', min: 10000, max: 1000000, raw: '10k-1m' }, errors: [], all: false })
  assert.deepEqual(cf.parseCoinflipRunArgs([]), { flips: null, bot: null, wager: null, errors: [], all: false })
  const named = cf.parseCoinflipRunArgs(['wager=250000', 'flips=3', 'bot=BotB'])
  assert.equal(named.flips, 3)
  assert.equal(named.bot, 'BotB')
  assert.deepEqual(named.wager, { kind: 'fixed', amount: 250000, raw: '250000' })
  assert.equal(cf.parseCoinflipRunArgs(['all']).all, true)
  assert.equal(cf.parseCoinflipRunArgs(['10k-1m', '5', 'BotA', 'extra']).errors.length, 1)
})

test('a random wager stays inside its range and inside the balance', () => {
  assert.equal(cf.randomWager({ min: 10000, max: 20000, rand: () => 0 }), 10000)
  const high = cf.randomWager({ min: 10000, max: 20000, rand: () => 0.999 })
  assert.ok(high > 10000 && high <= 20000, `expected a wager inside the range, got ${high}`)
  // Never more than the bot can afford — a wager above the balance is a
  // guaranteed rejection and a wasted round trip.
  const capped = cf.randomWager({ min: 10000, max: 1000000, balance: 50000, rand: () => 0.999 })
  assert.ok(capped > 10000 && capped <= 50000, `expected the wager to be capped by the balance, got ${capped}`)
  assert.equal(cf.randomWager({ min: 10000, max: 1000000, balance: 5000 }), null)
  const half = cf.randomWager({ min: 10000, max: 1000000, balance: 100000, fraction: 0.5, rand: () => 0.999 })
  assert.ok(half > 10000 && half <= 50000, `expected the fraction to cap it, got ${half}`)
})

// ── Observer ─────────────────────────────────────────────────────────────────

function fakeClock () {
  let seq = 0
  const timers = new Map()
  return {
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id },
    clearTimeout: (id) => timers.delete(id),
    advance (ms) {
      for (const [id, timer] of [...timers]) {
        if (timer.ms <= ms) { timers.delete(id); timer.fn() }
      }
    },
    pending: () => [...timers.values()]
  }
}

test('an incomplete block settles after the quiet period, once all four lines have arrived', async () => {
  const clock = fakeClock()
  const observer = cf.createCoinflipObserver({ botName: 'BotA', settleMs: 1000, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
  observer.feed('Result: Won')
  observer.feed('Amount Bet: $20,000')
  assert.equal(clock.pending().length, 1, 'the result waits for the rest of the block')
  clock.advance(1000)
  const ev = await observer.next(10)
  assert.equal(ev.kind, 'result')
  assert.equal(ev.result, 'won')
  assert.equal(ev.amount, 20000)
})

test('being named in the block is decisive and needs no wait', async () => {
  const clock = fakeClock()
  const observer = cf.createCoinflipObserver({ botName: 'Eryx_ThorneFY', settleMs: 60000, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
  observer.feed('Result: Lost')
  observer.feed('Amount Bet: $20,000')
  observer.feed('Winner: Jt2S1m3ePer')
  observer.feed('Loser: Eryx_ThorneFY')
  const ev = await observer.next(10)
  assert.equal(ev.result, 'lost')
  assert.equal(ev.amount, 20000)
  assert.equal(ev.opponent, 'Jt2S1m3ePer')
})

test('the bot can be the winner, and "You" counts as us', async () => {
  const observer = cf.createCoinflipObserver({ botName: 'BotA', settleMs: 10 })
  observer.feed('Winner: BotA')
  observer.feed('Loser: Rival')
  const ev = await observer.next(10)
  assert.equal(ev.result, 'won')
  assert.equal(ev.opponent, 'Rival')

  const other = cf.createCoinflipObserver({ botName: 'BotA', settleMs: 10 })
  other.feed('Winner: You')
  other.feed('Loser: Rival')
  assert.equal((await other.next(10)).result, 'won')
})

test('busy, created and join events are handed over as they arrive', async () => {
  const observer = cf.createCoinflipObserver({ botName: 'BotA', settleMs: 10 })
  observer.feed('You already have an active coinflip! Please use /coinflip delete first, if you wish to create a new one!')
  assert.equal((await observer.next(10)).kind, 'busy')
  observer.feed('A coinflip has been created, waiting for an opponent to join')
  assert.equal((await observer.next(10)).kind, 'created')
  observer.feed('Rival has joined your coinflip')
  const join = await observer.next(10)
  assert.equal(join.kind, 'join')
  assert.equal(join.name, 'Rival')
})

test('reset drops the block so a stale result cannot be charged to the next flip', async () => {
  // Real timers here on purpose: reset must also cancel the pending settle, so
  // the only thing that can resolve is the caller's own timeout.
  const observer = cf.createCoinflipObserver({ botName: 'BotA', settleMs: 5000 })
  observer.feed('Result: Won')
  observer.reset()
  const ev = await observer.next(20)
  assert.equal(ev.kind, 'timeout')
})

// ── Session runner ───────────────────────────────────────────────────────────

// The clock advances by a poll window on every message, so "the flip timed out"
// is reachable in a test without waiting ten real minutes for it.
function runnerDeps ({ events, balances = [], log = () => {}, sent = [] }) {
  const remaining = balances.slice()
  const queue = events.slice()
  let clock = 1700000000000
  return {
    sent,
    deps: {
      send: (cmd) => sent.push(cmd),
      balance: async () => (remaining.length ? remaining.shift() : 0),
      sleep: async () => {},
      observer: {
        reset () {},
        feed () {},
        pending: () => false,
        next: async () => { clock += 20000; return queue.shift() || { kind: 'timeout' } }
      },
      log,
      now: () => clock,
      rand: () => 0
    }
  }
}

test('a win is recorded from the result message with the balance as corroboration', async () => {
  const { deps, sent } = runnerDeps({ events: [{ kind: 'created' }, { kind: 'result', result: 'won', amount: 1000, opponent: 'Rival' }], balances: [10000, 11000] })
  const result = await cf.runCoinflipSession({ bot: 'BotA', flips: 1, wagerSpec: { kind: 'fixed', amount: 1000 }, stopLoss: 1e9 }, deps)
  assert.deepEqual(sent, ['/coinflip create 1000'])
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].result, 'won')
  assert.equal(result.records[0].delta, 1000)
  assert.equal(result.records[0].method, 'message')
  assert.equal(result.records[0].mismatched, false)
  assert.equal(result.stopped, 'completed')
})

test('a result message that contradicts the balance is flagged rather than averaged away', async () => {
  const { deps } = runnerDeps({ events: [{ kind: 'created' }, { kind: 'result', result: 'won', amount: 1000 }], balances: [10000, 9500] })
  const result = await cf.runCoinflipSession({ bot: 'BotA', flips: 1, wagerSpec: { kind: 'fixed', amount: 1000 } }, deps)
  assert.equal(result.records[0].mismatched, true)
  assert.match(result.records[0].note, /balance moved/)
})

test('with no result message the balance decides', async () => {
  const { deps } = runnerDeps({ events: [{ kind: 'created' }, { kind: 'result', result: null, amount: 1000 }], balances: [5000, 6000] })
  const result = await cf.runCoinflipSession({ bot: 'BotA', flips: 1, wagerSpec: { kind: 'fixed', amount: 1000 } }, deps)
  assert.equal(result.records[0].result, 'won')
  assert.equal(result.records[0].method, 'balance')
})

test('an active coinflip makes the run wait and re-ask — never delete and remake', async () => {
  const { deps, sent } = runnerDeps({ events: [{ kind: 'busy' }, { kind: 'created' }, { kind: 'result', result: 'lost', amount: 1000 }], balances: [10000, 9000] })
  const sleeps = []
  deps.sleep = async (ms) => sleeps.push(ms)
  const result = await cf.runCoinflipSession({ bot: 'BotA', flips: 1, wagerSpec: { kind: 'fixed', amount: 1000 } }, deps)
  assert.equal(result.records[0].result, 'lost')
  assert.deepEqual(sent, ['/coinflip create 1000', '/coinflip create 1000'])
  assert.ok(!sent.some(cmd => /delete/i.test(cmd)), 'a busy flip is never deleted')
  assert.deepEqual(sleeps, [15000])
})

test('a create that lands while an unresolved flip is open proves that flip was a loss', async () => {
  const events = [
    { kind: 'created' },
    // A result block we cannot read a verdict from, and no balance movement.
    { kind: 'result', result: null, amount: 1000 },
    { kind: 'created' },
    { kind: 'result', result: 'won', amount: 1000, opponent: 'Rival' }
  ]
  const { deps } = runnerDeps({ events, balances: [10000, null, 10000, 11000] })
  const result = await cf.runCoinflipSession({ bot: 'BotA', flips: 2, wagerSpec: { kind: 'fixed', amount: 1000 } }, deps)
  assert.equal(result.records.length, 2)
  assert.equal(result.records[0].result, 'lost')
  assert.equal(result.records[0].method, 'recreate')
  assert.equal(result.records[1].result, 'won')
})

test('nobody joining leaves the flip open and stops the run instead of deleting it', async () => {
  const { deps, sent } = runnerDeps({ events: [{ kind: 'created' }, { kind: 'timeout' }], balances: [10000, 10000] })
  const result = await cf.runCoinflipSession({ bot: 'BotA', flips: 5, wagerSpec: { kind: 'fixed', amount: 1000 }, flipTimeoutMs: 60000 }, deps)
  assert.equal(result.stopped, 'no-opponent')
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].result, 'unresolved')
  assert.deepEqual(sent, ['/coinflip create 1000'])
})

test('the stop loss ends the run at the configured net loss', async () => {
  const events = []
  for (let i = 0; i < 10; i++) events.push({ kind: 'created' }, { kind: 'result', result: 'lost', amount: 1000 })
  const balances = []
  for (let i = 0; i < 10; i++) balances.push(100000, 99000)
  const { deps, sent } = runnerDeps({ events, balances })
  const result = await cf.runCoinflipSession({ bot: 'BotA', flips: 10, wagerSpec: { kind: 'fixed', amount: 1000 }, stopLoss: 2000 }, deps)
  assert.equal(result.stopped, 'stop-loss')
  assert.equal(result.records.length, 2)
  assert.equal(sent.length, 2, 'the third flip is never sent once the stop loss is hit')
})

test('the server refusing the wager for lack of funds stops the run', async () => {
  const { deps } = runnerDeps({ events: [{ kind: 'insufficient' }], balances: [500] })
  const result = await cf.runCoinflipSession({ bot: 'BotA', flips: 3, wagerSpec: { kind: 'fixed', amount: 1000 } }, deps)
  assert.equal(result.stopped, 'insufficient-balance')
  assert.equal(result.records.length, 0)
})

test('a wager above the balance is never even sent', async () => {
  const { deps, sent } = runnerDeps({ events: [], balances: [500] })
  const result = await cf.runCoinflipSession({ bot: 'BotA', flips: 3, wagerSpec: { kind: 'fixed', amount: 1000 } }, deps)
  assert.equal(result.stopped, 'insufficient-balance')
  assert.deepEqual(sent, [])
})

// ── The server's rate limit and its clock ────────────────────────────────────

test('the rate-limit reply is its own event, and player chat cannot forge it', () => {
  // This is the line the user hit: /bal then /coinflip create too soon.
  assert.equal(cf.classifyCoinflipLine('✘ Error ┃ You are on cooldown').kind, 'cooldown')
  assert.equal(cf.classifyCoinflipLine('Error You are on cooldown').kind, 'cooldown')
  assert.equal(cf.classifyCoinflipLine('You are on cooldown').kind, 'cooldown')
  assert.equal(cf.classifyCoinflipLine('you are on cool down').kind, 'cooldown')
  // A player saying it in chat is not an error line, and a cooldown only ever
  // delays a run — it must never be mistaken for a result either.
  assert.equal(cf.classifyCoinflipLine("Steve: I'm on cooldown lol"), null)
  assert.equal(cf.classifyCoinflipLine('Steve: you are on cooldown mate'), null)
})

test('the server clock is read off a result line and off an error line', () => {
  assert.deepEqual(cf.parseServerClock('2:50:43 AM Result: Lost'), { hour: 2, minute: 50, second: 43, label: '2:50 A.M.' })
  assert.equal(cf.parseServerClock('3:03:52 PM ✘ Error ┃ You are on cooldown').hour, 15)
  assert.equal(cf.parseServerClock('12:05:01 AM Winner: BotA').hour, 0)
  assert.equal(cf.parseServerClock('12:05:01 PM Winner: BotA').hour, 12)
  assert.equal(cf.parseServerClock('no clock here'), null)
  assert.equal(cf.parseServerClock('[23:59] Amount Bet: $1,000').hour, 23)
})

test('a result block carries the server hour through to its event', async () => {
  const observer = cf.createCoinflipObserver({ botName: 'BotA', settleMs: 10 })
  observer.feed('2:50:43 AM Result: Lost')
  observer.feed('2:50:43 AM Amount Bet: $20,000')
  observer.feed('2:50:43 AM Winner: Rival')
  observer.feed('2:50:43 AM Loser: BotA')
  const ev = await observer.next(10)
  assert.equal(ev.result, 'lost')
  assert.equal(ev.serverHour, 2)
  assert.equal(ev.serverClock, '2:50 A.M.')
})

test('the configured cooldown is waited before every create, after the balance', async () => {
  const { deps, sent } = runnerDeps({ events: [{ kind: 'created' }, { kind: 'result', result: 'won', amount: 1000 }], balances: [10000, 11000] })
  const waits = []
  deps.sleep = async (ms) => waits.push(ms)
  await cf.runCoinflipSession({ bot: 'BotA', flips: 1, wagerSpec: { kind: 'fixed', amount: 1000 } }, { ...deps, createCooldownMs: 2500 })
  assert.deepEqual(waits, [2500], 'the /bal that just answered is the command that trips the rate limit')
  assert.deepEqual(sent, ['/coinflip create 1000'])
})

test('a rate-limited create is retried, never recorded as a loss', async () => {
  const events = [
    { kind: 'cooldown' },
    { kind: 'created' },
    { kind: 'result', result: 'won', amount: 1000 }
  ]
  const { deps, sent } = runnerDeps({ events, balances: [10000, 10000, 11000] })
  const result = await cf.runCoinflipSession({ bot: 'BotA', flips: 1, wagerSpec: { kind: 'fixed', amount: 1000 } }, { ...deps, createCooldownMs: 2500 })
  assert.equal(result.records.length, 1, 'the rejected create is not a flip')
  assert.equal(result.records[0].result, 'won')
  assert.equal(result.cooldowns, 1)
  assert.deepEqual(sent, ['/coinflip create 1000', '/coinflip create 1000'])
})

test('persistent rate limiting stops the run with a reason instead of spinning', async () => {
  const events = []
  for (let i = 0; i < 10; i++) events.push({ kind: 'cooldown' })
  const { deps } = runnerDeps({ events, balances: Array(12).fill(10000) })
  const result = await cf.runCoinflipSession({ bot: 'BotA', flips: 3, wagerSpec: { kind: 'fixed', amount: 1000 }, maxCooldownRetries: 2 }, { ...deps, createCooldownMs: 2500 })
  assert.equal(result.stopped, 'cooldown')
  assert.match(result.reason, /rate-limited/)
  assert.equal(result.records.length, 0)
})

test('the server hour is stored on the record so time of day can be dissected', async () => {
  const { deps } = runnerDeps({ events: [{ kind: 'created' }, { kind: 'result', result: 'won', amount: 1000, serverHour: 22, serverClock: '10:14 P.M.' }], balances: [10000, 11000] })
  const result = await cf.runCoinflipSession({ bot: 'BotA', flips: 1, wagerSpec: { kind: 'fixed', amount: 1000 } }, deps)
  assert.equal(result.records[0].serverHour, 22)
  assert.equal(result.records[0].serverClock, '10:14 P.M.')
})

// ── Statistics ───────────────────────────────────────────────────────────────

function flip (result, wager = 1000, extra = {}) {
  return { bot: 'BotA', ts: 1700000000000, wager, result, delta: result === 'won' ? wager : -wager, opponent: 'Rival', ...extra }
}

test('streaks, drawdown and net are computed from the records, not a running tally', () => {
  const records = [flip('won'), flip('won'), flip('lost'), flip('lost'), flip('lost'), flip('won')]
  const stats = cf.computeStats(records)
  assert.equal(stats.resolved, 6)
  assert.equal(stats.wins, 3)
  assert.equal(stats.losses, 3)
  assert.equal(stats.net, 0)
  assert.equal(stats.longestWinStreak, 2)
  assert.equal(stats.longestLossStreak, 3)
  assert.deepEqual(stats.currentStreak, { kind: 'won', length: 1 })
  assert.equal(stats.winRate, 0.5)
  // Peak of +2000 down to a trough of -1000 is 3000 of pain before it recovers.
  assert.equal(stats.maxDrawdown, 3000)
  assert.equal(stats.wagered, 6000)
})

test('unresolved flips are counted but never enter the win rate', () => {
  const stats = cf.computeStats([flip('won'), { ...flip('unresolved'), delta: null }])
  assert.equal(stats.unresolved, 1)
  assert.equal(stats.resolved, 1)
  assert.equal(stats.winRate, 1)
  assert.equal(stats.net, 1000)
})

test('per-bot and per-opponent breakdowns add up to the total', () => {
  const stats = cf.computeStats([flip('won'), flip('lost', 1000, { bot: 'BotB' }), flip('won', 500, { opponent: 'Other' })])
  assert.equal(stats.bots.length, 2)
  assert.equal(stats.bots.reduce((sum, b) => sum + b.net, 0), stats.net)
  assert.equal(stats.opponents.length, 2)
  assert.equal(stats.opponents.find(o => o.opponent === 'Rival').flips, 2)
})

// ── Fairness ─────────────────────────────────────────────────────────────────

test('the fairness verdict stays non-committal until there is enough data', () => {
  const analysis = cf.analyzeFairness([flip('won'), flip('won'), flip('won')])
  assert.equal(analysis.verdict, 'insufficient-data')
  assert.match(analysis.flags[0], /only 3 resolved/)
})

// A deterministic pseudo-random sequence: a fair coin is not an alternating
// coin, and the runs test below is precisely there to notice the difference.
function lcg (seed) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

test('a 50/50 sample with typical noise reads as within-noise', () => {
  const random = lcg(42)
  const records = []
  for (let i = 0; i < 100; i++) records.push(flip(random() < 0.5 ? 'won' : 'lost'))
  const analysis = cf.analyzeFairness(records)
  assert.equal(analysis.n, 100)
  assert.equal(analysis.verdict, 'within-noise')
  assert.ok(analysis.p > 0.05)
  assert.ok(analysis.ci.low < 0.5 && analysis.ci.high > 0.5)
})

test('an implausible win rate is called out as suspicious', () => {
  const records = []
  for (let i = 0; i < 40; i++) records.push(flip('won'))
  const analysis = cf.analyzeFairness(records)
  assert.equal(analysis.verdict, 'suspicious')
  assert.ok(analysis.p < 0.01)
  assert.match(analysis.flags[0], /differs from 50%/)
})

test('an even win rate with money that only ever moves one way is still a flag', () => {
  // 60/40 in wins, but every loss costs three times what a win pays: the win
  // rate looks fair and the money says otherwise.
  const records = []
  for (let i = 0; i < 60; i++) records.push(flip('won', 100))
  for (let i = 0; i < 40; i++) records.push({ ...flip('lost', 100), delta: -300 })
  const analysis = cf.analyzeFairness(records)
  assert.equal(analysis.verdict, 'watch')
  assert.ok(analysis.flags.some(flag => /net per flip/.test(flag)))
})

test('the runs test sees alternation and streaks', () => {
  const alternating = []
  for (let i = 0; i < 100; i++) alternating.push(i % 2 ? 'won' : 'lost')
  const perfect = cf.runsTest(alternating)
  assert.equal(perfect.runs, 100)
  assert.ok(perfect.p < 0.001)

  const streaky = []
  for (let i = 0; i < 50; i++) streaky.push('won')
  for (let i = 0; i < 50; i++) streaky.push('lost')
  assert.equal(cf.runsTest(streaky).runs, 2)
  assert.equal(cf.runsTest(['won']), null)
})

test('wilsonInterval brackets the observed rate and widens as the sample shrinks', () => {
  const wide = cf.wilsonInterval(3, 10)
  const narrow = cf.wilsonInterval(300, 1000)
  assert.ok(wide.low < 0.3 && wide.high > 0.3)
  assert.ok(narrow.high - narrow.low < wide.high - wide.low)
  assert.deepEqual(cf.wilsonInterval(0, 0), { low: 0, high: 1 })
})

test('describeSession reads like the log line a person has to scan', () => {
  const text = cf.describeSession({ bot: 'BotA', stopped: 'stop-loss', reason: 'net -2000 hit the 2000 stop loss', records: [flip('won'), flip('lost'), flip('lost')] })
  assert.match(text, /BotA: 3 resolved \(1W\/2L\)/)
  assert.match(text, /net -1000.00/)
  assert.match(text, /stop-loss/)
})

// ── Store ────────────────────────────────────────────────────────────────────

test('the history is append-only on disk and survives a corrupt line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinflip-'))
  const file = path.join(dir, 'coinflip-history.jsonl')
  const store = cf.createCoinflipStore({ file })
  store.append(flip('won'))
  store.append(flip('lost'))
  fs.appendFileSync(file, '{"half written\n')
  store.append(flip('won', 2000))

  const reloaded = cf.createCoinflipStore({ file })
  assert.equal(reloaded.all().length, 3)
  assert.equal(reloaded.summary().stats.resolved, 3)
  assert.equal(reloaded.summary().fairness.n, 3)
  assert.equal(reloaded.summary().recent[0].wager, 2000)

  reloaded.clear()
  assert.equal(fs.existsSync(file), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a missing history file is an empty history, not a crash', () => {
  const store = cf.createCoinflipStore({ file: path.join(os.tmpdir(), 'does-not-exist-coinflip', 'x.jsonl') })
  assert.deepEqual(store.all(), [])
  assert.equal(store.summary().stats.resolved, 0)
})

// ── CSV export ───────────────────────────────────────────────────────────────

// Reads a CSV line back the way a spreadsheet would, so a quoting bug shows up
// as a shifted column rather than as a still-valid-looking line.
function parseCsvLine (line) {
  const cells = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { cells.push(cell); cell = '' } else cell += ch
  }
  cells.push(cell)
  return cells
}

// A name the server hands us verbatim can contain a comma, a quote or both, and
// a CSV that silently shifts a column is worse than no CSV.
test('the CSV export quotes what it must and leaves the rest alone', () => {
  const rows = [
    flip('won', 1000, { index: 1, balanceBefore: 50000, balanceAfter: 51000, method: 'message' }),
    flip('lost', 2000, { index: 2, opponent: 'Rival, "the" bold', balanceBefore: 40000, method: 'recreate', mismatched: true })
  ]
  const lines = cf.toCsv(rows).trim().split('\n')
  assert.equal(lines[0], cf.CSV_COLUMNS.join(','))
  assert.deepEqual(cf.CSV_COLUMNS.slice(0, 6), ['index', 'ts', 'utc', 'bot', 'result', 'wager'])
  assert.equal(lines.length, 3)

  // A plain name is written unquoted; quoting it anyway would be noise.
  assert.match(lines[1], /,Rival,/, 'an ordinary opponent name is not quoted')
  assert.match(lines[2], /"Rival, ""the"" bold"/, 'a comma and a quote are both escaped')
  const cells = parseCsvLine(lines[2])
  assert.equal(cells.length, cf.CSV_COLUMNS.length, 'the quoted row still has one cell per column')
  assert.equal(cells[cf.CSV_COLUMNS.indexOf('opponent')], 'Rival, "the" bold')
})

// The share column is the whole point of exporting rather than reading the JSONL:
// "did a bigger bet relative to the balance win more" needs wager/balanceBefore.
test('the CSV export derives the wager share and an ISO timestamp per row', () => {
  const [header, row] = cf.toCsv([
    flip('won', 2500, { index: 7, ts: 1700000000000, balanceBefore: 50000, balanceAfter: 52500, method: 'message' })
  ]).trim().split('\n')
  const cells = Object.fromEntries(header.split(',').map((key, i) => [key, row.split(',')[i]]))
  assert.equal(cells.wagerShareOfBalance, '0.050000')
  assert.equal(cells.utc, '2023-11-14T22:13:20.000Z')
  assert.equal(cells.bot, 'BotA')
  assert.equal(cells.mismatched, '0')
  assert.equal(cells.serverHour, '', 'a missing field is empty, not "undefined"')
  // No balance to divide by — the share is left blank rather than a division by zero.
  const [, unknown] = cf.toCsv([flip('won', 1000, { balanceBefore: null })]).trim().split('\n')
  assert.equal(unknown.split(',')[10], '')
})

test('the CSV export of an empty history is just the header', () => {
  const rows = cf.toCsv([]).trim().split('\n')
  assert.equal(rows.length, 1)
  assert.equal(rows[0], cf.CSV_COLUMNS.join(','))
})
