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

// Multi-task broadcast manager supporting concurrent /all-slow broadcasts
function createSlowBroadcastManager({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let nextTaskId = 1
  const tasks = new Map()

  return {
    get running() {
      return tasks.size > 0
    },
    start(ids, delayMs, dispatch, { command = '', onError = () => {}, onDone = () => {} } = {}) {
      const taskId = nextTaskId++
      const targets = ids.slice()
      const task = {
        id: taskId,
        command,
        timer: null,
        generation: 0,
        targets,
        sent: 0,
        skipped: 0
      }
      tasks.set(taskId, task)

      const run = ++task.generation
      let index = 0

      const next = () => {
        task.timer = null
        if (task.generation !== run || !tasks.has(taskId)) return
        if (index < task.targets.length) {
          const id = task.targets[index++]
          try {
            if (dispatch(id, taskId)) task.sent++
            else task.skipped++
          } catch (err) {
            task.skipped++
            onError(err, id, taskId)
          }
        }
        if (task.generation !== run || !tasks.has(taskId)) return
        if (index < task.targets.length) {
          task.timer = setTimer(next, delayMs)
        } else {
          tasks.delete(taskId)
          onDone({ taskId, sent: task.sent, skipped: task.skipped })
        }
      }

      next() // first bot immediately; no unnecessary final wait
      return taskId
    },
    cancel(id) {
      const taskId = Number(id)
      const task = tasks.get(taskId)
      if (!task) return false
      task.generation++
      if (task.timer !== null) clearTimer(task.timer)
      task.timer = null
      tasks.delete(taskId)
      return true
    },
    cancelAll() {
      const count = tasks.size
      for (const task of tasks.values()) {
        task.generation++
        if (task.timer !== null) clearTimer(task.timer)
        task.timer = null
      }
      tasks.clear()
      return count
    },
    list() {
      return Array.from(tasks.values()).map(t => ({
        id: t.id,
        command: t.command,
        sent: t.sent,
        skipped: t.skipped,
        total: t.targets.length,
        remaining: t.targets.length - (t.sent + t.skipped)
      }))
    }
  }
}

// ── Command Chaining & Sleep Parsing ───────────────────────────────────────
function parseSleepDuration(durationStr) {
  if (durationStr == null) return null
  const s = String(durationStr).trim().toLowerCase()
  if (!s) return null
  if (s.endsWith('ms')) {
    const val = parseFloat(s.slice(0, -2))
    return (!isNaN(val) && val >= 0) ? Math.round(val) : null
  }
  if (s.endsWith('s')) {
    const val = parseFloat(s.slice(0, -1))
    return (!isNaN(val) && val >= 0) ? Math.round(val * 1000) : null
  }
  const val = parseFloat(s)
  if (isNaN(val) || val < 0) return null
  // Values >= 1000 are treated as milliseconds (e.g. 5000 -> 5000ms),
  // values < 1000 are treated as seconds (e.g. 5 -> 5000ms, 1 -> 1000ms, 2.5 -> 2500ms).
  return val >= 1000 ? Math.round(val) : Math.round(val * 1000)
}

function parseCommandChain(raw) {
  if (typeof raw !== 'string') return []
  const str = raw.trim()
  if (!str) return []

  const tokens = []
  let current = ''
  let i = 0

  while (i < str.length) {
    if (str[i] === '\\') {
      if (str.startsWith('\\&&', i)) {
        current += '&&'
        i += 3
        continue
      }
      if (str.startsWith('\\;', i)) {
        current += ';'
        i += 2
        continue
      }
      current += '\\'
      i += 1
      continue
    }

    if (str.startsWith('&&', i)) {
      if (current.trim()) {
        tokens.push({ command: current.trim(), separator: '&&' })
      }
      current = ''
      i += 2
      continue
    }

    if (str[i] === ';') {
      if (current.trim()) {
        tokens.push({ command: current.trim(), separator: ';' })
      }
      current = ''
      i += 1
      continue
    }

    current += str[i]
    i++
  }

  if (current.trim()) {
    tokens.push({ command: current.trim(), separator: null })
  } else if (tokens.length > 0) {
    tokens[tokens.length - 1].separator = null
  }

  return tokens
}

async function executeCommandChain(chain, ctx, { executeSingle = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!Array.isArray(chain) || chain.length === 0) return

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i]
    const cmd = step.command
    if (!cmd) continue

    let executionPromise
    const sleepMatch = cmd.match(/^sleep(?:\s+([\s\S]*))?$/i)
    if (sleepMatch) {
      const ms = parseSleepDuration(sleepMatch[1])
      executionPromise = (ms !== null && ms > 0) ? sleep(ms) : Promise.resolve()
    } else {
      try {
        executionPromise = Promise.resolve(executeSingle(cmd, ctx))
      } catch (err) {
        executionPromise = Promise.reject(err)
      }
    }

    if (step.separator === '&&') {
      try {
        await executionPromise
      } catch (_) {}
    } else if (step.separator === ';') {
      executionPromise.catch(() => {})
    } else {
      try {
        await executionPromise
      } catch (_) {}
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

module.exports = {
  readDelayMs,
  shuffledCopy,
  createSlowBroadcast,
  createSlowBroadcastManager,
  parseProxyGroups,
  resolveBotProxy,
  parseSleepDuration,
  parseCommandChain,
  executeCommandChain
}
