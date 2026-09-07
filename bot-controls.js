'use strict'

// Node timers clamp invalid/overflowing delays to 1ms; fall back instead.
function readDelayMs(value, fallback = 15000) {
  if (value == null || String(value).trim() === '') return fallback
  const ms = Number(value)
  return Number.isSafeInteger(ms) && ms >= 1 && ms <= 2147483647 ? ms : fallback
}

function shuffledCopy(values, random = Math.random) {
  const result = values.slice()
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

// One pending timer, regardless of fleet size. Starts are spaced, not completions:
// existing local routines manage their own async lifecycles and report their errors.
function createSlowBroadcast({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let running = false
  let timer = null
  let generation = 0
  return {
    get running() { return running },
    start(ids, delayMs, dispatch, { onError = () => {}, onDone = () => {} } = {}) {
      if (running) return false
      running = true
      const run = ++generation
      const targets = ids.slice()
      let index = 0, sent = 0, skipped = 0
      const next = () => {
        timer = null
        if (run !== generation) return
        if (index < targets.length) {
          const id = targets[index++]
          try {
            if (dispatch(id)) sent++
            else skipped++
          } catch (err) {
            skipped++
            onError(err, id)
          }
        }
        if (run !== generation) return
        if (index < targets.length) timer = setTimer(next, delayMs)
        else {
          running = false
          onDone({ sent, skipped })
        }
      }
      next() // first bot immediately; no unnecessary final wait
      return true
    },
    cancel() {
      generation++
      if (timer !== null) clearTimer(timer)
      timer = null
      running = false
    }
  }
}

// ── Dedicated proxy groups (SOCKS5/HTTP per bot subset) ─────────────────────
// PROXY_GROUP_<N>_BOTS = comma-separated usernames
// PROXY_GROUP_<N>_HOST / _PORT / _TYPE = proxy target for that group
// Unassigned bots fall back to the caller-provided default (global PROXY_* or direct).
function parseProxyGroups(env = process.env) {
  const groups = []
  let n = 1
  while (env[`PROXY_GROUP_${n}_BOTS`] !== undefined) {
    const botsRaw = env[`PROXY_GROUP_${n}_BOTS`] || ''
    const bots = botsRaw.split(',').map(s => s.trim()).filter(Boolean)
    const host = (env[`PROXY_GROUP_${n}_HOST`] || '').trim()
    const port = parseInt(env[`PROXY_GROUP_${n}_PORT`] || '1080', 10)
    const type = (env[`PROXY_GROUP_${n}_TYPE`] || 'socks5').toLowerCase()
    if (bots.length && host) groups.push({ index: n, bots, host, port, type })
    n++
  }
  return groups
}

// Resolves a bot username to its dedicated proxy config, or `fallback` (default
// global proxy config / null for direct) when unmatched or when disabled.
function resolveBotProxy(username, groups, fallback = null) {
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (group.bots.includes(username)) {
        return { host: group.host, port: group.port, type: group.type, group: group.index }
      }
    }
  }
  return fallback
}

module.exports = { readDelayMs, shuffledCopy, createSlowBroadcast, parseProxyGroups, resolveBotProxy }
