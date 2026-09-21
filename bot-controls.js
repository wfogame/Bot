'use strict'

// Node timers clamp invalid/overflowing delays to 1ms; fall back instead.
function readDelayMs(value, fallback = 15000) {
  if (value == null || String(value).trim() === '') return fallback
  const ms = Number(value)
  return Number.isSafeInteger(ms) && ms >= 1 && ms <= 2147483647 ? ms : fallback
}

// Integer env reader with range clamping: missing, non-numeric, or out-of-range
// values fall back instead of silently becoming NaN/0.
function readInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (value == null || String(value).trim() === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) return fallback
  return Math.round(n)
}

// Same contract as readInt, but keeps fractional values (distances, radii).
function readNumber(value, fallback, min = -Infinity, max = Infinity) {
  if (value == null || String(value).trim() === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback
}

// `/dump` accepts an optional mode. A typo must not silently start a real TPA
// dump, so unknown tokens are reported back instead of being ignored.
function parseDumpMode(args) {
  const mode = String(args || '').trim().toLowerCase()
  if (!mode) return { mode: 'tpa', unknown: null }
  if (mode === 'home' || mode === 'hidden' || mode === 'cancel') return { mode, unknown: null }
  return { mode: 'tpa', unknown: mode }
}

// `/data` takes an optional subcommand. `check` verifies the Apps Script
// webhook end-to-end (GET health + a note about what the answer means) instead
// of pushing a snapshot; an unknown token must not silently trigger a push.
function parseDataArgs(args) {
  const tokens = String(args || '').trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return { action: 'push', unknown: null }
  const sub = tokens[0].toLowerCase()
  if (sub === 'check' || sub === 'doctor') return { action: 'check', unknown: null }
  if (sub === 'status') return { action: 'status', unknown: null }
  return { action: 'push', unknown: sub }
}

// `/crates-all` and `/crates-solo` accept trailing `key=value` flags on top of
// their positional args. Parsed here — beside the other arg parsers — so the
// .env defaults and the per-command overrides share one vocabulary:
//   dump=off | tpa | home | hidden | player:<name>   what happens after crates
//   afk=now | off | <seconds>                       what happens after the dump
function parseCratesAllDump(value) {
  const raw = String(value == null ? '' : value).trim()
  const lower = raw.toLowerCase()
  if (!lower) return { dump: 'tpa', target: null, unknown: null }
  if (lower === 'off' || lower === 'none' || lower === 'skip') return { dump: 'off', target: null, unknown: null }
  if (lower === 'tpa' || lower === 'default') return { dump: 'tpa', target: null, unknown: null }
  if (lower === 'home') return { dump: 'home', target: null, unknown: null }
  if (lower === 'hidden') return { dump: 'hidden', target: null, unknown: null }
  if (lower.startsWith('player:')) {
    const name = raw.slice('player:'.length).trim()
    return name ? { dump: 'tpa', target: name, unknown: null } : { dump: 'tpa', target: null, unknown: raw }
  }
  // Anything else is a typo, not a player name. A target must say so
  // (`dump=player:Smith`) because a mistyped keyword that silently teleports a
  // bot to a player named "hmeo" is exactly what this parser exists to prevent.
  return { dump: 'tpa', target: null, unknown: raw }
}

function parseCratesAllAfk(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase()
  if (!raw) return { warp: null, delayMs: null, unknown: null }
  if (/^(now|immediate|immediately|asap)$/.test(raw)) return { warp: true, delayMs: 0, unknown: null }
  if (/^(off|none|no|false|never)$/.test(raw)) return { warp: false, delayMs: null, unknown: null }
  const m = raw.match(/^(\d+)(ms|s)?$/)
  if (m) {
    const n = Number(m[1])
    const ms = m[2] === 'ms' ? n : n * 1000 // a bare number means seconds
    if (Number.isSafeInteger(ms) && ms <= 2147483647) return { warp: true, delayMs: ms, unknown: null }
  }
  return { warp: null, delayMs: null, unknown: raw }
}

// Nulls mean "not specified here" so the caller can fall back to .env; a token
// that is not understood is reported back rather than silently ignored.
function parseCratesAllFlags(tokens) {
  const out = { dump: null, dumpTarget: null, afkWarp: null, afkDelayMs: null, unknown: [] }
  for (const token of Array.isArray(tokens) ? tokens : []) {
    const text = String(token)
    const eq = text.indexOf('=')
    if (eq <= 0 || eq === text.length - 1) { out.unknown.push(token); continue }
    const key = text.slice(0, eq).toLowerCase()
    const value = text.slice(eq + 1)
    if (key === 'dump') {
      const parsed = parseCratesAllDump(value)
      if (parsed.unknown) { out.unknown.push(token); continue }
      out.dump = parsed.dump
      if (parsed.target) out.dumpTarget = parsed.target
    } else if (key === 'afk') {
      const parsed = parseCratesAllAfk(value)
      if (parsed.unknown) { out.unknown.push(token); continue }
      out.afkWarp = parsed.warp
      if (parsed.delayMs != null) out.afkDelayMs = parsed.delayMs
    } else {
      out.unknown.push(token)
    }
  }
  return out
}

function shuffledCopy(values, random = Math.random) {
  const result = values.slice()
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

function parseNameList(value) {
  return Array.from(new Set(String(value || '').split(',').map(name => name.trim()).filter(Boolean)))
}

function hasInventoryItems(inventory) {
  return Boolean(inventory && typeof inventory.items === 'function' && inventory.items().length > 0)
}

function randomInt(min, max, random = Math.random) {
  return min + Math.floor(random() * (max - min + 1))
}

// Builds the breadth-first hidden TPA chain. The first layer has 1–3 bots;
// subsequent layers contain up to two bots, each assigned to a prior target.
function buildHiddenDumpPlan(botNames, mainPlayer, random = Math.random) {
  const names = shuffledCopy(botNames.filter(Boolean), random)
  if (!names.length) return []
  const firstCount = Math.min(names.length, randomInt(1, 3, random))
  const plan = []
  const frontier = [mainPlayer]
  let cursor = 0
  const first = names.splice(0, firstCount)
  first.forEach(name => plan.push({ bot: name, target: mainPlayer, layer: 0 }))
  frontier.push(...first)
  while (names.length) {
    const target = frontier[cursor++ % frontier.length]
    const batch = names.splice(0, Math.min(2, names.length))
    batch.forEach(name => plan.push({ bot: name, target, layer: 1 + Math.floor(plan.length / 2) }))
    frontier.push(...batch)
  }
  return plan
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
// PROXY_GROUP_<N>_USER / _PASS = credentials for that group (optional)
// PROXY_GROUP_<N>_LOGIN_PASSWORD = the Minecraft account password for those bots
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
    // Credentials are per group, so one provider's login never follows the bots
    // that were moved onto a different provider. A group with a username but no
    // password is legitimate (some SOCKS5 setups are username-only).
    const user = (env[`PROXY_GROUP_${n}_USER`] || '').trim()
    const rawPass = env[`PROXY_GROUP_${n}_PASS`] !== undefined
      ? env[`PROXY_GROUP_${n}_PASS`]
      : env[`PROXY_GROUP_${n}_PASSWORD`]
    const pass = rawPass == null ? '' : String(rawPass)
    // The ACCOUNT password these bots log in with — nothing to do with the proxy
    // login above. Not trimmed: a password may legitimately start or end with a
    // space, and silently altering it would lock the account out.
    const rawLogin = env[`PROXY_GROUP_${n}_LOGIN_PASSWORD`]
    const loginPassword = rawLogin == null ? '' : String(rawLogin)
    // A group is defined by its BOT LIST, not by its host. Requiring a host here
    // used to discard the whole group — including its LOGIN_PASSWORD — for
    // anyone using a group only to separate accounts, and the only symptom was
    // bots logging in with the wrong password. `host: ''` now means "no dedicated
    // proxy": the group exists, its login password applies, and its bots use the
    // default connection.
    if (bots.length) groups.push({ index: n, bots, host, port, type, user, pass, loginPassword })
    n++
  }
  return groups
}

// Any PROXY_GROUP_<N>_* variable whose index has no group is ignored. The loop
// stops at the first missing PROXY_GROUP_<N>_BOTS, so one typo there silently
// discards the host, credentials, bot list and login password of every group
// after it. Returns the offending keys so startup can name them instead of
// pretending they were applied.
function findIgnoredProxyGroupVars(env = process.env, groups = []) {
  const known = new Set((groups || []).map(g => g.index))
  const ignored = []
  for (const key of Object.keys(env || {})) {
    const match = /^PROXY_GROUP_(\d+)_/.exec(key)
    if (!match) continue
    if (!known.has(parseInt(match[1], 10))) ignored.push(key)
  }
  return ignored.sort()
}

// Resolves a bot username to its dedicated proxy config, or `fallback` (default
// global proxy config / null for direct) when unmatched or when disabled.
function resolveBotProxy(username, groups, fallback = null) {
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (group.bots.includes(username)) {
        // A group with no host is a bot grouping, not a proxy route: use the
        // default connection rather than a made-up host:port.
        if (!group.host) return fallback
        return {
          host: group.host,
          port: group.port,
          type: group.type,
          user: group.user || '',
          pass: group.pass || '',
          group: group.index
        }
      }
    }
  }
  return fallback
}

// Per-bot login passwords, in two spellings. The comma list is convenient for a
// whole roster; the per-name variable is the only unambiguous one when the
// password itself contains a comma or a colon:
//
//   BOT_PASSWORDS=BotOne:secret-one,BotTwo:secret-two
//   BOT_PASSWORD_BotOne=secret-one
//
// The per-name variable wins when both describe the same bot. Lookups are
// case-insensitive, because BOT_PASSWORD_botone silently missing would fall
// through to a different password and surface as "wrong password" instead of
// as the typo it is.
function parseBotPasswords(env = process.env) {
  const map = new Map()
  const list = env && env.BOT_PASSWORDS
  if (list) {
    for (const entry of String(list).split(',')) {
      // The entry itself is NOT trimmed: only the bot name is, so that
      // "Bot1:pw1, Bot2:pw2" survives the leading space without quietly editing a
      // password that ends in one. A space is a legal password character, and
      // rewriting it is how a correct credential turns into "wrong password".
      if (!entry || !entry.trim()) continue
      const at = entry.indexOf(':') // first colon only: the password may contain more
      if (at <= 0) continue
      const bot = entry.slice(0, at).trim()
      if (!bot) continue
      map.set(bot.toLowerCase(), { bot, password: entry.slice(at + 1), source: 'BOT_PASSWORDS' })
    }
  }
  for (const key of Object.keys(env || {})) {
    if (!key.startsWith('BOT_PASSWORD_')) continue
    const bot = key.slice('BOT_PASSWORD_'.length)
    if (!bot || env[key] == null) continue
    map.set(bot.toLowerCase(), { bot, password: String(env[key]), source: key })
  }
  return map
}

// The password a bot sends to /register and /login prompts. Resolved per bot: a
// per-bot entry beats the group, which beats the global LOGIN_PASSWORD, which
// beats the built-in default every existing setup already relies on.
//
// The proxy group is used here purely as "these bots belong together" — this is
// the Minecraft account password, never the proxy's. Returns the source label as
// well, so a failed /login can be traced to the variable that supplied it
// without the password itself ever reaching a log line.
function resolveLoginPassword(username, groups, env = process.env, botPasswords = null) {
  // Most specific answer first: this bot by name.
  const perBot = botPasswords || parseBotPasswords(env)
  const hit = perBot.get(String(username || '').toLowerCase())
  if (hit) return { password: hit.password, source: hit.source }
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (group.bots.includes(username) && group.loginPassword) {
        return { password: group.loginPassword, source: `PROXY_GROUP_${group.index}_LOGIN_PASSWORD` }
      }
    }
  }
  if (env && env.LOGIN_PASSWORD) return { password: String(env.LOGIN_PASSWORD), source: 'LOGIN_PASSWORD' }
  return { password: '123456', source: 'built-in default' }
}

// ── Login / register failure guard ───────────────────────────────────────────
// A rejected /login is not a network blip: the bot replies to every prompt it
// sees, so a wrong password gets the account rate-limited and then kicked, which
// is how a one-character typo in .env becomes a ban. The wording is the only
// evidence available — the server sends it as ordinary chat, there is no
// distinct packet — so it has to be matched conservatively. bot.js only consults
// this within a short window of sending an auth command, and ignores anything
// that looks like player chat, so a player typing "wrong password" cannot
// disable a bot.
//
// Three kinds, because they need different responses:
//   bad-password  the password is wrong; retrying can only make things worse,
//                 so stop until the config is fixed.
//   throttled     the server is rate-limiting; waiting is correct, but only a
//                 bounded number of times — an endlessly repeated "try again
//                 later" is a wrong password wearing a hat.
//   already       an existing session or a registered account. Usually the
//                 previous connection's session has not expired yet, so this is
//                 a short pause, never a credential verdict.
const AUTH_REPLY_PATTERNS = [
  { kind: 'bad-password', re: /(?:wrong|incorrect|invalid|bad) password/i },
  { kind: 'bad-password', re: /password (?:is )?not correct/i },
  { kind: 'bad-password', re: /passwords? (?:do not|don't|does not|doesn't) match/i },
  { kind: 'bad-password', re: /(?:authentication|login|register(?:ation)?) failed/i },
  { kind: 'bad-password', re: /password is too (?:short|long)/i },
  { kind: 'throttled', re: /too many (?:failed |wrong )?(?:attempts|tries|logins)/i },
  { kind: 'throttled', re: /please wait .{0,40}(?:before|then) (?:trying|try)/i },
  { kind: 'throttled', re: /temporarily (?:blocked|locked) (?:from|out of) (?:logging in|login)/i },
  { kind: 'throttled', re: /try again (?:in|after|later)/i },
  { kind: 'already', re: /already (?:logged in|authenticated|registered)/i }
]

// Returns { kind, reason } for a recognised failure reply, or null for ordinary
// chat. First match wins, so the specific patterns come before the broad ones.
function classifyAuthReply(message) {
  const text = String(message || '')
  for (const { kind, re } of AUTH_REPLY_PATTERNS) {
    const match = text.match(re)
    if (match) return { kind, reason: match[0].trim() }
  }
  return null
}

// Folds a verdict into the bot's auth state. `previous` is the state so far (or
// null). A throttled failure is tolerated `maxThrottled` times and then treated
// as a wrong password, so no amount of "try again later" can become an infinite
// retry loop. `until === null` means sticky: only /auth-retry or a restart
// clears it, because only a config change can fix it.
function nextAuthFailure(previous, verdict, now, { throttleMs = 300000, alreadyMs = 60000, maxThrottled = 2 } = {}) {
  if (!verdict) return previous || null
  const count = (previous && previous.count ? previous.count : 0) + 1
  if (verdict.kind === 'throttled') {
    if (count <= maxThrottled) {
      return { kind: 'throttled', reason: verdict.reason, at: now, until: now + throttleMs, count }
    }
    return {
      kind: 'bad-password',
      reason: `${verdict.reason} (repeated ${count} times — treating it as a wrong password)`,
      at: now, until: null, count
    }
  }
  if (verdict.kind === 'already') {
    return { kind: 'already', reason: verdict.reason, at: now, until: now + alreadyMs, count }
  }
  return { kind: verdict.kind, reason: verdict.reason, at: now, until: null, count }
}

function isAuthBlocked(failure, now = Date.now()) {
  if (!failure) return false
  return failure.until == null || now < failure.until
}

// True when a resolved proxy carries credentials worth sending.
function hasProxyAuth(proxy) {
  return Boolean(proxy && (proxy.user || proxy.pass))
}

// `Proxy-Authorization` value for an HTTP CONNECT proxy, or '' when there are
// no credentials. Basic auth is `base64(user:pass)`, and the empty username is
// still encoded (":pass") because some proxies accept a password-only login.
function proxyAuthHeader(proxy) {
  if (!hasProxyAuth(proxy)) return ''
  const raw = `${proxy.user || ''}:${proxy.pass || ''}`
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`
}

// The CONNECT request an HTTP proxy is sent. Kept here rather than inline in the
// connect handler so the credential line is verifiable: the header must be
// omitted entirely when there are no credentials (an empty Proxy-Authorization
// makes some proxies answer 407 instead of tunnelling), and the request must
// terminate with a blank line or the proxy waits forever.
function buildHttpConnectRequest(targetHost, targetPort, proxy = {}) {
  const auth = proxyAuthHeader(proxy)
  return `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
    `Host: ${targetHost}:${targetPort}\r\n` +
    (auth ? `Proxy-Authorization: ${auth}\r\n` : '') +
    'Connection: keep-alive\r\n\r\n'
}

// One-line proxy target for logs, `/proxy`, and error messages. The password is
// never included: these strings reach the TUI, the browser console panel, the
// Discord notifier, and scrollback — a credential in a log line is a leaked
// credential. The username is shown, because "which login is this bot using?"
// is exactly the question those lines exist to answer.
function describeProxy(proxy) {
  if (!proxy) return 'direct (no proxy)'
  const type = String(proxy.type || 'socks5').toUpperCase()
  const creds = proxy.user ? `${proxy.user}@` : (hasProxyAuth(proxy) ? '***@' : '')
  return `${type} ${creds}${proxy.host}:${proxy.port}`
}

module.exports = {
  readDelayMs,
  readInt,
  readNumber,
  parseDumpMode,
  parseDataArgs,
  parseCratesAllDump,
  parseCratesAllAfk,
  parseCratesAllFlags,
  shuffledCopy,
  parseNameList,
  hasInventoryItems,
  randomInt,
  buildHiddenDumpPlan,
  createSlowBroadcast,
  createSlowBroadcastManager,
  parseProxyGroups,
  findIgnoredProxyGroupVars,
  resolveBotProxy,
  hasProxyAuth,
  proxyAuthHeader,
  buildHttpConnectRequest,
  describeProxy,
  resolveLoginPassword,
  parseBotPasswords,
  classifyAuthReply,
  nextAuthFailure,
  isAuthBlocked,
  parseSleepDuration,
  parseCommandChain,
  executeCommandChain
}
