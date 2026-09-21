'use strict'

/**
 * Coinflip data collection and analysis.
 *
 * The point of this module is a question the server will never answer: is the
 * coinflip fair? Everything here exists to make that answerable from evidence —
 * every wager, every result, and the balance either side of it is recorded, and
 * the statistics are computed from those records rather than from a running
 * tally nobody can audit.
 *
 * The code is deliberately free of mineflayer and of timers it does not own:
 * chat, delays and the clock are injected, so a whole 200-flip session can be
 * driven deterministically in a test.
 */

const STREAK = { WON: 'won', LOST: 'lost', UNRESOLVED: 'unresolved' }

// ── Message parsing ──────────────────────────────────────────────────────────

// "2:50:43 AM Result: Lost" — the server prefixes each line with its own
// timestamp, and the lines of one result arrive as separate chat messages.
const TIMESTAMP_RE = /^\s*\[?\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?\]?\s*/
const SECTION_RE = /\u00a7./g
const NAME = '[A-Za-z0-9_]{1,16}'

// The server stamps every coinflip line with its own local clock. Keeping that
// stamp is what makes "does the time of day matter" answerable without guessing
// which timezone the game server runs in — the hour is the server's, not ours.
// A.M./P.M. is optional so a server that stamps 24-hour times works too;
// without it the hour is read as-is.
const CLOCK_RE = /^\[?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?[Mm]\.?)?\]?/

/** "2:50:43 AM Result: Lost" → { hour: 2, minute: 50, second: 43, label: '2:50 A.M.' }. */
function parseServerClock (raw) {
  const text = String(raw == null ? '' : raw).replace(SECTION_RE, '').trim()
  const match = text.match(CLOCK_RE)
  if (!match) return null
  let hour = Number(match[1])
  const minute = Number(match[2])
  const second = match[3] == null ? null : Number(match[3])
  const meridiem = match[4] ? match[4].toLowerCase() : null
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return null
  if (meridiem) {
    if (hour < 1 || hour > 12) return null
    hour = (hour % 12) + (meridiem === 'p' ? 12 : 0)
  } else if (hour > 23) return null
  return {
    hour,
    minute,
    second,
    label: meridiem
      ? `${match[1]}:${match[2]} ${match[4].toUpperCase()}.M.`
      : `${String(match[1]).padStart(2, '0')}:${match[2]}`
  }
}

function cleanLine (text) {
  return String(text == null ? '' : text)
    .replace(SECTION_RE, '')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TIMESTAMP_RE, '')
    .trim()
}

/** "10k" → 10000, "$20,000" → 20000, "1.5m" → 1500000. */
function parseAmount (raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  const text = String(raw == null ? '' : raw).trim().replace(/[$,]/g, '')
  const match = text.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i)
  if (!match) return null
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[(match[2] || '').toLowerCase()] || 1
  const value = Number(match[1]) * scale
  return Number.isFinite(value) ? value : null
}

/**
 * Classify one chat line. Returns null for anything that is not coinflip
 * traffic — an unrelated line must never disturb an in-flight block, or a
 * player saying "result: lost" in chat could forge a result.
 */
function classifyCoinflipLine (text) {
  const line = cleanLine(text)
  if (!line) return null
  const lower = line.toLowerCase()

  // The bottom of the list: a line only counts if it is shaped like the
  // server's, not merely a sentence containing the word "coinflip".
  let match

  // The result lines have to be the whole line. A player typing "Loser: how
  // about that coinflip" into chat must not be able to forge one, and the
  // server's lines are exactly "Result: Lost" / "Amount Bet: $20,000".
  if ((match = line.match(/^result\s*:?\s*(won|win|victory|lost|lose|loss|defeat)\s*[.!]?$/i))) {
    const word = match[1].toLowerCase()
    return { kind: 'result', result: /won|win|victory/.test(word) ? STREAK.WON : STREAK.LOST, line }
  }
  if ((match = line.match(/^amount\s*bet\s*:?\s*\$?\s*([\d,.]+(?:\s*[kmb])?)\s*[.!]?$/i))) {
    const amount = parseAmount(match[1])
    if (amount != null) return { kind: 'bet', amount, line }
  }
  if ((match = line.match(new RegExp(`^winner\\s*:?\\s*(${NAME}|you)\\s*[.!]?$`, 'i')))) {
    return { kind: 'winner', name: match[1], line }
  }
  if ((match = line.match(new RegExp(`^loser\\s*:?\\s*(${NAME}|you)\\s*[.!]?$`, 'i')))) {
    return { kind: 'loser', name: match[1], line }
  }
  if (/already have an active coinflip|use \/coinflip delete first/i.test(line)) {
    return { kind: 'busy', line }
  }
  // The server rate-limits chat commands and answers a command sent too soon
  // with "✘ Error ┃ You are on cooldown". The section glyphs are stripped above,
  // so what arrives here is "Error You are on cooldown". A rate-limited create
  // never happened, so this is a wait-and-retry, not a result — and it is worth
  // recognising precisely, because the /bal that precedes every create is what
  // trips it. Anchored so a player chatting "I'm on cooldown lol" cannot stall a
  // run by accident.
  if (/^(?:error\b[\s:]*)?(?:you\s+(?:are|'?re)\s+)?on\s+cool\s?down\b/i.test(line)) {
    return { kind: 'cooldown', line }
  }
  // Servers write this both ways ("You don't have enough" / "You do not have
  // enough money"), and the context words stop a random player's line matching.
  if (/(?:do not|does not|don'?t|doesn'?t) have enough|not enough (?:money|balance|funds)|insufficient (?:money|funds|balance)/i.test(line) && /coinflip|bet|wager/i.test(line)) {
    return { kind: 'insufficient', line }
  }
  // "Steve joined the game" is a server line, not a coinflip line — the join has
  // to name a coinflip or it is just people arriving.
  if ((match = line.match(new RegExp(`^(${NAME})\\s+(?:has\\s+)?joined (?:your|the) coinflip`, 'i'))) || /joined (?:your|the) coinflip/i.test(line)) {
    return { kind: 'join', name: match ? match[1] : null, line }
  }
  if (/coinflip/i.test(line) && /(created|started|has been|waiting for|awaiting|opponent)/i.test(line)) {
    return { kind: 'created', line }
  }
  if (/coinflip/i.test(line) && /^usage|invalid amount|minimum (?:bet|amount|wager)|maximum (?:bet|amount|wager)|cannot|unable/i.test(line)) {
    return { kind: 'error', reason: lower, line }
  }
  return null
}

function isUs (name, botName) {
  const value = String(name || '').trim().toLowerCase()
  if (!value) return false
  if (value === 'you' || value === 'yourself') return true
  return value === String(botName || '').trim().toLowerCase()
}

/**
 * Watches one bot's chat for coinflip traffic and hands out events one at a
 * time. Lines of a single result are accumulated into a block and settled
 * either as soon as we are named (decisive) or after a short quiet period,
 * because "Result:" arrives before "Amount Bet:" and "Loser:".
 */
function createCoinflipObserver (opts = {}) {
  const botName = String(opts.botName || '')
  const settleMs = opts.settleMs == null ? 1500 : opts.settleMs
  const setT = opts.setTimeout || setTimeout
  const clearT = opts.clearTimeout || clearTimeout
  const now = opts.now || Date.now

  let block = null
  let settleTimer = null
  let waiter = null
  const queue = []

  function reset () {
    block = null
    queue.length = 0
    if (settleTimer) { clearT(settleTimer); settleTimer = null }
  }

  function emit (event) {
    if (waiter) {
      const w = waiter
      waiter = null
      clearT(w.timer)
      w.resolve(event)
      return
    }
    // A bot that plays coinflips without a session running must not grow this
    // list forever; the oldest events are the least interesting ones.
    queue.push(event)
    if (queue.length > 50) queue.splice(0, queue.length - 50)
  }

  function settle () {
    settleTimer = null
    if (!block) return
    const finished = block
    block = null
    const result = finished.explicit || (isUs(finished.winner, botName) ? STREAK.WON : isUs(finished.loser, botName) ? STREAK.LOST : null)
    const opponentName = isUs(finished.winner, botName) ? finished.loser : finished.winner
    emit({
      kind: 'result',
      result,
      amount: finished.amount,
      opponent: opponentName && !isUs(opponentName, botName) ? opponentName : null,
      serverHour: finished.clock ? finished.clock.hour : null,
      serverClock: finished.clock ? finished.clock.label : null,
      lines: finished.lines,
      at: now()
    })
  }

  function scheduleSettle () {
    if (settleTimer) clearT(settleTimer)
    settleTimer = setT(settle, settleMs)
  }

  function feed (text) {
    const cls = classifyCoinflipLine(text)
    if (!cls) return null

    if (cls.kind === 'result' || cls.kind === 'bet' || cls.kind === 'winner' || cls.kind === 'loser') {
      if (!block) block = { explicit: null, amount: null, winner: null, loser: null, clock: null, lines: [] }
      // The block's own clock comes off its first line; the server repeats it on
      // every line of the block, but the first one is the flip's.
      if (!block.clock) block.clock = parseServerClock(text)
      block.lines.push(cls.line)
      if (cls.kind === 'result') block.explicit = cls.result
      else if (cls.kind === 'bet') block.amount = cls.amount
      else if (cls.kind === 'winner') block.winner = cls.name
      else block.loser = cls.name
      // Settle the moment the block can no longer improve: both names, or a
      // verdict plus a name. Otherwise wait out the quiet period, because
      // "Winner: You" alone would lose the opponent line arriving right after.
      const complete = (block.winner && block.loser) || (block.explicit && (block.winner || block.loser))
      if (complete) settle()
      else scheduleSettle()
      return cls
    }

    emit({ kind: cls.kind, name: cls.name, reason: cls.reason, line: cls.line, at: now() })
    return cls
  }

  /** Next event, or { kind: 'timeout' } when nothing arrives in time. */
  function next (timeoutMs) {
    if (queue.length) return Promise.resolve(queue.shift())
    return new Promise((resolve) => {
      // Deliberately not unref'd: a caller waiting for the next event is
      // asking for a timer, and a timer that never fires would leave the
      // promise pending forever.
      const timer = setT(() => {
        if (waiter && waiter.resolve === resolve) waiter = null
        resolve({ kind: 'timeout', at: now() })
      }, timeoutMs)
      waiter = { resolve, timer }
    })
  }

  return { feed, next, reset, settle, pending: () => block != null }
}

// ── Wager selection ──────────────────────────────────────────────────────────

/**
 * Parses a wager argument: "500000" (fixed) or "10k-1m" (random in range),
 * the latter being the shape the .env defaults use too.
 */
function parseWagerSpec (raw, fallback = {}) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text) return { kind: 'range', min: fallback.min, max: fallback.max, raw: 'default' }
  const range = text.match(/^([\d.,]+\s*[kmb]?)\s*(?:-|\.\.|to)\s*([\d.,]+\s*[kmb]?)$/i)
  if (range) {
    const min = parseAmount(range[1])
    const max = parseAmount(range[2])
    if (min == null || max == null) return { error: `could not read the range "${text}"` }
    if (min > max) return { error: `the range "${text}" starts above where it ends` }
    return { kind: 'range', min, max, raw: text }
  }
  const fixed = parseAmount(text)
  if (fixed == null || fixed <= 0) return { error: `"${text}" is not an amount (try 500000, 10k-1m, or 20,000)` }
  return { kind: 'fixed', amount: Math.floor(fixed), raw: text }
}

/** A random point in the range, never more than the bot can afford. */
function randomWager ({ min, max, balance = null, fraction = 1, rand = Math.random }) {
  const lo = Math.max(1, Math.floor(min))
  const hi = Math.max(lo, Math.floor(max))
  const available = balance == null ? null : Math.floor(balance * fraction)
  const cap = available == null ? hi : Math.min(hi, available)
  if (cap < lo) return null
  return lo + Math.floor(rand() * (cap - lo + 1))
}

/** `10k-1m` / `500000` / named forms from `flips=` `bot=` `wager=`. */
function parseCoinflipRunArgs (args = []) {
  const out = { flips: null, bot: null, wager: null, errors: [], all: false }
  const positional = []
  for (const token of args) {
    const named = String(token).match(/^(wager|price|bet|flips|count|amount|bot|bots)\s*=\s*(.+)$/i)
    if (named) {
      const key = named[1].toLowerCase()
      const value = named[2].trim()
      if (key === 'bot' || key === 'bots') {
        if (/^(all|\*)$/i.test(value)) out.all = true
        else out.bot = value
      } else if (key === 'flips' || key === 'count' || key === 'amount') {
        const n = parseAmount(value)
        if (n == null || n < 1) out.errors.push(`"${value}" is not a flip count`)
        else out.flips = Math.floor(n)
      } else {
        const spec = parseWagerSpec(value)
        if (spec.error) out.errors.push(spec.error)
        else out.wager = spec
      }
      continue
    }
    positional.push(String(token))
  }
  for (const token of positional) {
    if (/^(all|\*)$/i.test(token)) { out.all = true; continue }
    if (out.wager == null) {
      const spec = parseWagerSpec(token)
      if (!spec.error) { out.wager = spec; continue }
      // Not an amount — the only remaining positional in the usage is the bot.
      if (out.bot == null && !/^[\d.,]/.test(token)) { out.bot = token; continue }
      out.errors.push(spec.error)
      continue
    }
    if (out.flips == null) {
      const n = parseAmount(token)
      if (n == null || n < 1) { out.errors.push(`"${token}" is not a flip count`); continue }
      out.flips = Math.floor(n)
      continue
    }
    if (out.bot == null) { out.bot = token; continue }
    out.errors.push(`unexpected argument "${token}"`)
  }
  return out
}

// ── Session runner ───────────────────────────────────────────────────────────

/**
 * Runs `flips` coinflips on one bot.
 *
 * The rules, in the order they matter:
 *   - A result message is the truth when there is one.
 *   - A balance that moved by exactly the wager is the fallback.
 *   - A *successful new create* proves the previous flip ended — and since the
 *     server announces losses, silence plus a new create means a loss.
 *   - "active coinflip" is never a reason to delete and remake: it is a reason
 *     to wait, because remaking cannot succeed while a flip is open.
 */
async function runCoinflipSession (opts, deps) {
  const {
    bot: botId,
    botName = botId,
    flips = 10,
    wagerSpec = { kind: 'fixed', amount: 100000 },
    stopLoss = 10000000,
    balanceFraction = 1,
    sessionId = `cf-${Date.now().toString(36)}`,
    maxNoResponseRetries = 3,
    maxCooldownRetries = 5
  } = opts
  const {
    send, balance, sleep, observer, log = () => {}, now = Date.now, rand = Math.random,
    busyWaitMs = 15000, busyMaxWaitMs = 900000, flipTimeoutMs = 600000, pollMs = 15000,
    // The server rate-limits chat commands, and the /bal that answers just
    // before each create is the command that trips it. This is the gap left
    // after that answer and before "create" goes out.
    createCooldownMs = 0,
    cooldownWaitMs = null
  } = deps

  // How long to wait when the server answers "you are on cooldown": at least
  // the configured gap, and never less than the busy wait, which is already
  // tuned to this server's limits.
  const cooldownPause = () => Math.max(createCooldownMs, cooldownWaitMs == null ? 1000 : cooldownWaitMs)

  const records = []
  let net = 0
  let stopped = 'completed'
  let reason = ''
  let pending = null // a flip we made but have not been told the result of
  let busyWaited = 0
  let noResponse = 0
  let cooldownWaits = 0 // consecutive rate-limited creates
  let cooldowns = 0 // rate-limited creates over the whole session

  const record = (entry) => {
    const row = {
      id: `${sessionId}-${records.length + 1}`,
      sessionId,
      bot: botId,
      index: records.length + 1,
      ts: now(),
      wager: entry.wager,
      opponent: entry.opponent || null,
      result: entry.result,
      // The server's own clock, when the result block carried a timestamp — the
      // only time-of-day signal that does not depend on our timezone.
      serverHour: entry.serverHour == null ? null : entry.serverHour,
      serverClock: entry.serverClock || null,
      balanceBefore: entry.balanceBefore == null ? null : entry.balanceBefore,
      balanceAfter: entry.balanceAfter == null ? null : entry.balanceAfter,
      delta: entry.delta == null ? null : entry.delta,
      method: entry.method,
      mismatched: Boolean(entry.mismatched),
      note: entry.note || '',
      lines: entry.lines || []
    }
    records.push(row)
    net += row.delta != null ? row.delta : (row.result === STREAK.WON ? row.wager : row.result === STREAK.LOST ? -row.wager : 0)
    log(row)
    return row
  }

  while (records.length < flips) {
    if (net <= -Math.abs(stopLoss)) { stopped = 'stop-loss'; reason = `net ${net.toFixed(2)} hit the ${stopLoss} stop loss`; break }

    const wager = wagerSpec.kind === 'fixed'
      ? Math.floor(wagerSpec.amount)
      : randomWager({ min: wagerSpec.min, max: wagerSpec.max, balance: await balance(), fraction: balanceFraction, rand })
    if (wager == null) { stopped = 'insufficient-balance'; reason = 'the random range is above what the bot can afford'; break }

    const balanceBefore = await balance()
    if (balanceBefore != null && wager > balanceBefore) {
      stopped = 'insufficient-balance'
      reason = `a ${wager} wager is more than the ${balanceBefore} balance`
      break
    }

    // The rate-limit gap. Sleeping HERE (after the balance answer, before the
    // create) is what stops the server answering a fresh create with
    // "You are on cooldown" — the cooldown is per command, and /bal is the one
    // that just went out.
    if (createCooldownMs > 0) await sleep(createCooldownMs)

    observer.reset()
    log({ kind: 'create', wager, bot: botId, sessionId })
    send(`/coinflip create ${wager}`)

    let created = false
    let joined = false
    const startedAt = now()
    let outcome = null
    while (!outcome) {
      const ev = await observer.next(pollMs)
      if (ev.kind === 'busy') { outcome = { kind: 'busy' }; break }
      if (ev.kind === 'cooldown') { outcome = { kind: 'cooldown' }; break }
      if (ev.kind === 'insufficient') { outcome = { kind: 'insufficient' }; break }
      if (ev.kind === 'error') { outcome = { kind: 'error', reason: ev.reason }; break }
      if (ev.kind === 'created') { created = true; continue }
      if (ev.kind === 'join') { created = true; joined = true; continue }
      if (ev.kind === 'result') {
        outcome = {
          kind: 'result',
          result: ev.result,
          amount: ev.amount,
          opponent: ev.opponent,
          serverHour: ev.serverHour == null ? null : ev.serverHour,
          serverClock: ev.serverClock || null,
          lines: ev.lines
        }
        continue
      }
      // Nothing arrived in this window.
      if (now() - startedAt >= flipTimeoutMs) { outcome = { kind: 'timeout', created, joined }; break }
    }

    if (outcome.kind === 'busy') {
      // Never delete and remake — an open flip has to end on its own.
      pending = pending || { wager, balanceBefore }
      busyWaited += busyWaitMs
      if (busyWaited >= busyMaxWaitMs) {
        stopped = 'busy-stuck'
        reason = `a coinflip has been active for ${Math.round(busyWaited / 1000)}s without a result`
        break
      }
      log({ kind: 'busy', waitedMs: busyWaited, bot: botId, sessionId })
      await sleep(busyWaitMs)
      // Re-asking is what tells us the old flip finally ended; if it did, the
      // create lands and the previous flip is recorded as a loss below.
      continue
    }
    if (outcome.kind === 'cooldown') {
      // A rate-limited create never happened, so nothing is recorded: retry the
      // same flip after the cooldown instead of counting it as a loss.
      cooldownWaits += 1
      cooldowns += 1
      if (cooldownWaits > maxCooldownRetries) {
        stopped = 'cooldown'
        reason = `the server rate-limited /coinflip create ${cooldownWaits} times — raise COINFLIP_CREATE_COOLDOWN_MS`
        break
      }
      const wait = cooldownPause()
      log({ kind: 'cooldown', attempt: cooldownWaits, waitMs: wait, bot: botId, sessionId })
      await sleep(wait)
      continue
    }
    if (outcome.kind === 'insufficient') {
      stopped = 'insufficient-balance'
      reason = 'the server refused the wager for lack of funds'
      break
    }
    if (outcome.kind === 'error') {
      stopped = 'server-refused'
      reason = outcome.reason || 'the server rejected the coinflip command'
      break
    }
    if (outcome.kind === 'timeout' && !outcome.created) {
      noResponse += 1
      if (noResponse > maxNoResponseRetries) {
        stopped = 'no-response'
        reason = `the server did not answer the create after ${noResponse} tries`
        break
      }
      await sleep(busyWaitMs)
      continue
    }
    if (outcome.kind === 'timeout' && outcome.created) {
      // Nobody joined. Leave the flip open — remaking cannot help — and stop.
      pending = pending || { wager, balanceBefore }
      stopped = 'no-opponent'
      reason = `nobody joined a ${wager} coinflip within ${Math.round(flipTimeoutMs / 1000)}s — leaving it open (do not delete/remake)`
      record({ wager: pending.wager, balanceBefore: pending.balanceBefore, balanceAfter: await balance(), result: STREAK.UNRESOLVED, method: 'timeout', note: reason })
      pending = null
      break
    }

    noResponse = 0
    busyWaited = 0
    cooldownWaits = 0

    // A create that landed while a previous flip was somehow still open is proof
    // the old one ended in a loss — the server only announces wins and losses.
    if (pending) {
      record({ wager: pending.wager, balanceBefore: pending.balanceBefore, result: STREAK.LOST, method: 'recreate', note: 'a new coinflip was accepted, so the previous one ended without a win' })
      pending = null
    }

    const balanceAfter = await balance()
    const amount = outcome.amount != null ? outcome.amount : wager
    let result = outcome.result
    let method = 'message'
    if (!result) {
      // No usable message: the balance is the evidence.
      if (balanceBefore != null && balanceAfter != null) {
        const delta = balanceAfter - balanceBefore
        if (Math.abs(delta - amount) < 0.005) result = STREAK.WON
        else if (Math.abs(delta + amount) < 0.005) result = STREAK.LOST
        method = 'balance'
      }
      if (!result) {
        // Neither message nor balance: leaving the flip pending means the next
        // successful create records it as a loss, which is the known rule.
        pending = { wager: amount, balanceBefore }
        log({ kind: 'unresolved', wager: amount, bot: botId, sessionId })
        continue
      }
    }

    const delta = balanceBefore != null && balanceAfter != null ? balanceAfter - balanceBefore : null
    const expected = result === STREAK.WON ? amount : -amount
    record({
      wager: amount,
      opponent: outcome.opponent,
      result,
      balanceBefore,
      balanceAfter,
      delta,
      method,
      serverHour: outcome.serverHour,
      serverClock: outcome.serverClock,
      // A message that contradicts the money is exactly the kind of thing worth
      // seeing in the log rather than averaging away.
      mismatched: delta != null && Math.abs(delta - expected) > 0.005,
      note: delta != null && Math.abs(delta - expected) > 0.005
        ? `balance moved ${delta.toFixed(2)} but a ${result} of ${amount} predicts ${expected.toFixed(2)}`
        : ''
    })
  }

  return { bot: botId, sessionId, records, net, stopped, reason, flips: records.length, cooldowns }
}

// ── Statistics ───────────────────────────────────────────────────────────────

function erf (x) {
  // Abramowitz & Stegun 7.1.26 — |error| < 1.5e-7, plenty for a verdict.
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax)
  return sign * y
}

function normalCdf (z) { return 0.5 * (1 + erf(z / Math.SQRT2)) }
function twoSidedP (z) { return Math.max(0, Math.min(1, 2 * (1 - normalCdf(Math.abs(z))))) }

function wilsonInterval (wins, n, z = 1.96) {
  if (!n) return { low: 0, high: 1 }
  const p = wins / n
  const denom = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) }
}

/** Wald–Wolfowitz runs test: are wins and losses independent, or streaky? */
function runsTest (outcomes) {
  const n = outcomes.length
  if (n < 2) return null
  const wins = outcomes.filter(o => o === STREAK.WON).length
  const losses = n - wins
  if (!wins || !losses) return { runs: 1, expected: 1, z: null, p: null }
  let runs = 1
  for (let i = 1; i < n; i++) if (outcomes[i] !== outcomes[i - 1]) runs++
  const expected = (2 * wins * losses) / n + 1
  const variance = (2 * wins * losses * (2 * wins * losses - n)) / (n * n * (n - 1))
  const z = variance > 0 ? (runs - expected) / Math.sqrt(variance) : null
  return { runs, expected, z, p: z == null ? null : twoSidedP(z) }
}

function mean (values) {
  if (!values.length) return null
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

function stdev (values, avg = mean(values)) {
  if (values.length < 2 || avg == null) return null
  const sum = values.reduce((acc, v) => acc + (v - avg) ** 2, 0)
  return Math.sqrt(sum / (values.length - 1))
}

function resolvedRecords (records) {
  return (records || []).filter(r => r && (r.result === STREAK.WON || r.result === STREAK.LOST))
}

function computeStats (records = []) {
  const resolved = resolvedRecords(records)
  const outcomes = resolved.map(r => r.result)
  const wins = outcomes.filter(o => o === STREAK.WON).length
  const losses = outcomes.length - wins
  const wagered = resolved.reduce((sum, r) => sum + (Number(r.wager) || 0), 0)
  const net = resolved.reduce((sum, r) => sum + (r.delta != null ? r.delta : r.result === STREAK.WON ? r.wager : -r.wager), 0)

  let longestWinStreak = 0
  let longestLossStreak = 0
  let run = 0
  let last = null
  for (const o of outcomes) {
    if (o === last) run++
    else { run = 1; last = o }
    if (o === STREAK.WON) longestWinStreak = Math.max(longestWinStreak, run)
    else longestLossStreak = Math.max(longestLossStreak, run)
  }
  const currentStreak = outcomes.length
    ? { kind: outcomes[outcomes.length - 1], length: run }
    : { kind: null, length: 0 }

  // Max drawdown of the cumulative curve — the pain, not the profit.
  let peak = 0
  let cumulative = 0
  let maxDrawdown = 0
  for (const r of resolved) {
    cumulative += r.delta != null ? r.delta : r.result === STREAK.WON ? r.wager : -r.wager
    peak = Math.max(peak, cumulative)
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative)
  }

  const perBot = {}
  const perOpponent = {}
  for (const r of resolved) {
    const bot = perBot[r.bot] || (perBot[r.bot] = { bot: r.bot, flips: 0, wins: 0, losses: 0, net: 0, wagered: 0 })
    bot.flips++
    bot.wagered += Number(r.wager) || 0
    bot.net += r.delta != null ? r.delta : r.result === STREAK.WON ? r.wager : -r.wager
    if (r.result === STREAK.WON) bot.wins++
    else bot.losses++

    const key = r.opponent || '(unknown)'
    const opp = perOpponent[key] || (perOpponent[key] = { opponent: key, flips: 0, wins: 0, losses: 0, net: 0 })
    opp.flips++
    opp.net += r.delta != null ? r.delta : r.result === STREAK.WON ? r.wager : -r.wager
    if (r.result === STREAK.WON) opp.wins++
    else opp.losses++
  }

  return {
    flips: records.length,
    resolved: resolved.length,
    wins,
    losses,
    unresolved: records.length - resolved.length,
    wagered,
    net,
    winRate: resolved.length ? wins / resolved.length : null,
    currentStreak,
    longestWinStreak,
    longestLossStreak,
    maxDrawdown,
    avgWager: resolved.length ? wagered / resolved.length : null,
    mismatches: records.filter(r => r && r.mismatched).length,
    firstAt: records.length ? records[0].ts : null,
    lastAt: records.length ? records[records.length - 1].ts : null,
    bots: Object.values(perBot).sort((a, b) => b.net - a.net),
    opponents: Object.values(perOpponent).sort((a, b) => b.flips - a.flips)
  }
}

/**
 * The rigging question, answered with numbers.
 *
 * A fair even-money coinflip means: a win rate of 0.5, outcomes that are
 * independent of each other, and a net of zero. Each of those gets its own
 * test here, because a game can pass one and fail another — a fair rate with
 * streaky outcomes is suspicious in a different way from a biased rate.
 */
function analyzeFairness (records = [], opts = {}) {
  const minSample = opts.minSample == null ? 30 : opts.minSample
  const suspicionP = opts.suspicionP == null ? 0.01 : opts.suspicionP
  const resolved = resolvedRecords(records)
  const outcomes = resolved.map(r => r.result)
  const n = outcomes.length
  const wins = outcomes.filter(o => o === STREAK.WON).length
  const losses = n - wins

  const deltas = resolved.map(r => (r.delta != null ? r.delta : r.result === STREAK.WON ? r.wager : -r.wager))
  const avgDelta = mean(deltas)
  const sd = stdev(deltas)
  const se = sd != null && n ? sd / Math.sqrt(n) : null

  const analysis = {
    n,
    wins,
    losses,
    winRate: n ? wins / n : null,
    expectedRate: 0.5,
    z: n ? (wins - n / 2) / Math.sqrt(n / 4) : null,
    p: n ? twoSidedP((wins - n / 2) / Math.sqrt(n / 4)) : null,
    ci: wilsonInterval(wins, n),
    runs: runsTest(outcomes),
    wagered: resolved.reduce((sum, r) => sum + (Number(r.wager) || 0), 0),
    net: deltas.reduce((sum, v) => sum + v, 0),
    netPerFlip: avgDelta,
    netCi: se == null ? null : { low: avgDelta - 1.96 * se, high: avgDelta + 1.96 * se },
    verdict: 'insufficient-data',
    flags: []
  }

  if (n >= minSample) {
    if (analysis.p < suspicionP) {
      analysis.verdict = 'suspicious'
      analysis.flags.push(`win rate ${(analysis.winRate * 100).toFixed(1)}% differs from 50% (p=${analysis.p.toExponential(2)})`)
    } else if (analysis.p < 0.05) {
      analysis.verdict = 'watch'
      analysis.flags.push(`win rate ${(analysis.winRate * 100).toFixed(1)}% is drifting from 50% (p=${analysis.p.toFixed(4)})`)
    } else {
      analysis.verdict = 'within-noise'
    }
    const runsP = analysis.runs && analysis.runs.p
    if (runsP != null && runsP < 0.01) {
      analysis.flags.push(`outcomes are ${analysis.runs.runs < analysis.runs.expected ? 'streakier' : 'more alternating'} than chance (runs ${analysis.runs.runs} vs ${analysis.runs.expected.toFixed(1)}, p=${runsP.toFixed(4)})`)
      if (analysis.verdict === 'within-noise') analysis.verdict = 'watch'
    }
    // Money that should average zero: a game with a hidden edge shows up here
    // even when the win rate looks about right (payout odds, rounding, fees).
    if (analysis.netCi && (analysis.netCi.high < 0 || analysis.netCi.low > 0)) {
      analysis.flags.push(`net per flip is ${analysis.netPerFlip.toFixed(2)} (95% CI ${analysis.netCi.low.toFixed(2)}…${analysis.netCi.high.toFixed(2)}) — a fair game averages 0`)
      if (analysis.verdict === 'within-noise') analysis.verdict = 'watch'
    }
  } else {
    analysis.flags.push(`only ${n} resolved flip(s) — ${minSample} are needed before the numbers mean anything`)
  }

  return analysis
}

function describeSession (result) {
  const stats = computeStats(result.records)
  const parts = [
    `${result.bot}: ${stats.resolved} resolved (${stats.wins}W/${stats.losses}L)`,
    `net ${stats.net >= 0 ? '+' : ''}${stats.net.toFixed(2)}`,
    stats.winRate == null ? 'no win rate yet' : `win rate ${(stats.winRate * 100).toFixed(1)}%`
  ]
  if (stats.unresolved) parts.push(`${stats.unresolved} unresolved`)
  if (result.cooldowns) parts.push(`${result.cooldowns} create(s) rate-limited`)
  parts.push(`stopped: ${result.stopped}${result.reason ? ` (${result.reason})` : ''}`)
  return parts.join(' · ')
}

// ── Storage ──────────────────────────────────────────────────────────────────

/**
 * Append-only history on disk plus an in-memory window for the statistics.
 * Append-only because a measurement that can be edited is not evidence.
 */
function createCoinflipStore (opts = {}) {
  const file = opts.file
  const fs = opts.fs || require('fs')
  const path = opts.path || require('path')
  const maxRecords = opts.maxRecords || 200000
  let records = []
  let loaded = false

  function load () {
    if (loaded) return records
    loaded = true
    try {
      const text = fs.readFileSync(file, 'utf8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const row = JSON.parse(trimmed)
          if (row && row.bot) records.push(row)
        } catch (_) { /* a half-written last line is not a reason to lose the file */ }
      }
    } catch (_) { records = [] }
    if (records.length > maxRecords) records = records.slice(-maxRecords)
    return records
  }

  function append (record) {
    load()
    records.push(record)
    if (records.length > maxRecords) records = records.slice(-maxRecords)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, JSON.stringify(record) + '\n')
    } catch (_) { /* the in-memory record still counts; the file is best-effort */ }
    return record
  }

  function appendAll (rows) {
    for (const row of rows) append(row)
    return rows.length
  }

  function all () {
    return load()
  }

  function clear () {
    records = []
    try { fs.rmSync(file, { force: true }) } catch (_) {}
  }

  function summary (opts2 = {}) {
    const rows = all()
    const recent = opts2.recent == null ? 25 : opts2.recent
    return {
      file,
      updatedAt: Date.now(),
      stats: computeStats(rows),
      fairness: analyzeFairness(rows, opts2),
      recent: rows.slice(-recent).reverse()
    }
  }

  return { append, appendAll, all, clear, summary, file }
}

// ── CSV export ───────────────────────────────────────────────────────────────
// One row per recorded flip, wide enough to be analysed without the JSONL: the
// derived columns (share of the balance, UTC time) are the ones a spreadsheet or
// pandas would have to work out by hand otherwise.
const CSV_COLUMNS = [
  'index', 'ts', 'utc', 'bot', 'result', 'wager', 'opponent', 'delta',
  'balanceBefore', 'balanceAfter', 'wagerShareOfBalance', 'method',
  'serverHour', 'serverClock', 'mismatched'
]

function csvCell (value) {
  if (value == null) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv (rows) {
  const lines = [CSV_COLUMNS.join(',')]
  for (const row of rows) {
    const share = row.wager != null && row.balanceBefore ? row.wager / row.balanceBefore : null
    lines.push([
      row.index, row.ts, row.ts == null ? '' : new Date(row.ts).toISOString(), row.bot,
      row.result, row.wager, row.opponent, row.delta, row.balanceBefore, row.balanceAfter,
      share == null ? '' : share.toFixed(6), row.method, row.serverHour, row.serverClock,
      row.mismatched ? 1 : 0
    ].map(csvCell).join(','))
  }
  return lines.join('\n') + '\n'
}

module.exports = {
  STREAK,
  cleanLine,
  toCsv,
  CSV_COLUMNS,
  parseServerClock,
  parseAmount,
  parseWagerSpec,
  classifyCoinflipLine,
  createCoinflipObserver,
  randomWager,
  parseCoinflipRunArgs,
  runCoinflipSession,
  computeStats,
  analyzeFairness,
  describeSession,
  createCoinflipStore,
  runsTest,
  mean,
  stdev,
  resolvedRecords,
  wilsonInterval,
  twoSidedP,
  normalCdf,
  erf
}
