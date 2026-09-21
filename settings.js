'use strict'

/**
 * Runtime settings with TEMPORARY overrides.
 *
 * Two kinds of value live here:
 *
 *   1. Keys read through `settings.get(...)` at the moment of use. An override
 *      takes effect immediately — no restart, no file write.
 *   2. Keys a module read once at startup into a `const`. Those are registered
 *      with `live: false` so the .env tab can still show and set them, while
 *      saying plainly that a running process will not pick the change up.
 *
 * Nothing here ever writes to disk. The point of the tab is to try a value out
 * (a wager range, a bigger delay) and let it evaporate on the next restart,
 * which is exactly the opposite of an edit to `.env` — so an override is only
 * ever kept in memory, and `process.env` is mutated in memory too (never
 * written back) so any code that reads `process.env.X` late still sees it.
 *
 * Secrets are never echoed back: `list()` reports them as set/unset with the
 * value withheld, and `set()` accepts a new one without returning it. That is
 * why the tab can be shown at all.
 */

// Anything matching this is treated as a credential: settable, never displayed.
const SECRET_RE = /(PASSWORD|PASSWD|TOKEN|SECRET|API_?KEY|WEBHOOK|CREDENTIAL|_KEY$|^SSH_|PRIVATE)/i

// process.env is mostly the host's, not the project's. These prefixes/names are
// the container's own plumbing and listing them would bury the real settings.
const NOISE_RE = /^(PATH|HOME|PWD|OLDPWD|SHELL|SHLVL|_|TERM|TERM_PROGRAM|COLORTERM|LS_COLORS|LANG|LANGUAGE|LC_.*|HOSTNAME|USER|LOGNAME|MAIL|TMPDIR|XDG_.*|NODE_.*|npm_.*|NPM_.*|DAYTONA.*|FREEBUFF.*|VSCODE.*|CODESPACE.*|DEBIAN.*|STAGE_.*|CAAS_.*|GIT_.*|GITHUB_.*|HOST_|PAPERTRAIL.*|KUBERNETES.*|MEMORY_LIMIT|SERVICE_.*|DOTENV_.*)$/

const TYPES = new Set(['string', 'int', 'number', 'ms', 'bool', 'list'])

const registry = new Map()

function define (key, spec = {}) {
  const type = TYPES.has(spec.type) ? spec.type : 'string'
  registry.set(key, {
    key,
    type,
    def: spec.def,
    group: spec.group || 'General',
    desc: spec.desc || '',
    live: spec.live !== false,
    min: spec.min,
    max: spec.max
  })
}

/** Coerce a raw string to the declared type. Returns null when unusable. */
function coerce (type, raw) {
  if (raw == null) return null
  const text = String(raw)
  switch (type) {
    case 'bool': {
      if (/^(1|true|yes|on)$/i.test(text.trim())) return true
      if (/^(0|false|no|off)$/i.test(text.trim())) return false
      return null
    }
    case 'int':
    case 'ms': {
      // A duration may be written as "30s" / "1500ms"; ints are plain.
      const match = type === 'ms' ? text.trim().match(/^(-?\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i) : null
      if (match) {
        const unit = (match[2] || '').toLowerCase()
        const scale = unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 1
        const value = Number(match[1]) * scale
        return Number.isFinite(value) ? Math.round(value) : null
      }
      if (!/^[+-]?\d+$/.test(text.trim())) return null
      const value = Number.parseInt(text.trim(), 10)
      return Number.isFinite(value) ? value : null
    }
    case 'number': {
      const value = Number(text.trim())
      return Number.isFinite(value) ? value : null
    }
    case 'list':
      return text.split(',').map(part => part.trim()).filter(Boolean)
    default:
      return text
  }
}

function isSecret (key) {
  return SECRET_RE.test(key)
}

// Temporary values, and the value each key had before the first override so
// /env reset can put it back exactly (including "it was not set at all").
const overrides = new Map()
const originals = new Map()

function specFor (key) {
  return registry.get(key) || {
    key,
    type: 'string',
    def: undefined,
    group: 'Other (.env)',
    desc: 'Read from the environment; not registered as tunable, so only code that re-reads it will see a change.',
    live: false,
    unknown: true
  }
}

/** Effective value: override → process.env → registered default. */
function get (key) {
  const spec = specFor(key)
  const raw = overrides.has(key) ? overrides.get(key)
    : process.env[key] !== undefined && process.env[key] !== '' ? process.env[key]
      : spec.def
  const value = coerce(spec.type, raw)
  if (value === null && spec.def !== undefined) return coerce(spec.type, spec.def)
  return value
}

function getRaw (key) {
  const spec = specFor(key)
  if (overrides.has(key)) return overrides.get(key)
  if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key]
  return spec.def
}

function source (key) {
  if (overrides.has(key)) return 'override'
  if (process.env[key] !== undefined && process.env[key] !== '') return 'env'
  return 'default'
}

/**
 * Store a temporary override. Validation is strict for registered keys — a
 * value that cannot be parsed is refused rather than silently becoming a
 * default, because "I typed 10k and it bet 10000" is the class of bug this
 * whole module exists to avoid.
 */
function set (key, raw) {
  const name = String(key || '').trim()
  if (!name) return { ok: false, error: 'a setting name is required' }
  const spec = specFor(name)
  const secret = isSecret(name)
  const text = String(raw == null ? '' : raw)

  // Clearing a value is a reset, not an override to the empty string.
  if (text === '' && spec.def !== undefined) return reset(name)

  const value = coerce(spec.type, text)
  if (value === null) {
    return { ok: false, error: `"${text}" is not a valid ${spec.type} value` }
  }
  if ((spec.type === 'int' || spec.type === 'ms' || spec.type === 'number') &&
      (spec.min != null || spec.max != null)) {
    if (spec.min != null && value < spec.min) return { ok: false, error: `must be at least ${spec.min}` }
    if (spec.max != null && value > spec.max) return { ok: false, error: `must be at most ${spec.max}` }
  }

  if (!overrides.has(name)) {
    // Remember whether it was set at all, so reset can unset rather than blank it.
    originals.set(name, process.env[name] !== undefined ? process.env[name] : null)
  }
  overrides.set(name, text)
  process.env[name] = text // in memory only — never written to .env
  return {
    ok: true,
    key: name,
    live: spec.live,
    value: secret ? null : value,
    secret,
    source: 'override'
  }
}

function reset (key) {
  const name = String(key || '').trim()
  if (!overrides.has(name)) return { ok: false, error: `${name} has no temporary override` }
  const original = originals.get(name)
  overrides.delete(name)
  originals.delete(name)
  if (original == null) delete process.env[name]
  else process.env[name] = original
  const spec = specFor(name)
  const raw = getRaw(name)
  return { ok: true, key: name, live: spec.live, value: isSecret(name) ? null : coerce(spec.type, raw), source: source(name) }
}

function resetAll () {
  const keys = [...overrides.keys()]
  for (const key of keys) reset(key)
  return keys
}

/**
 * Everything the .env tab shows: the registered settings in registration
 * order, then any other environment key that looks like a project setting.
 * Secret values are withheld (the key and whether it is set are still shown).
 */
function list ({ includeUnknown = true } = {}) {
  const rows = []
  const push = (key, spec) => {
    const secret = isSecret(key)
    const raw = getRaw(key)
    rows.push({
      key,
      group: spec.group,
      type: spec.type,
      desc: spec.desc,
      live: spec.live,
      secret,
      overridden: overrides.has(key),
      source: source(key),
      default: secret ? undefined : spec.def,
      // A secret is reported as configured or not, never as its value.
      value: secret ? null : coerce(spec.type, raw),
      // "configured" means someone actually set it — a registered default is not
      // a configuration, and showing it as one makes an unset key look set.
      configured: source(key) !== 'default' && raw !== ''
    })
  }
  for (const spec of registry.values()) push(spec.key, spec)
  if (includeUnknown) {
    const known = new Set(rows.map(row => row.key))
    for (const key of Object.keys(process.env).sort()) {
      if (known.has(key)) continue
      if (NOISE_RE.test(key)) continue
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue
      push(key, specFor(key))
    }
  }
  return rows
}

/** Grouped view for rendering; groups keep the registration order. */
function grouped () {
  const groups = new Map()
  for (const row of list()) {
    if (!groups.has(row.group)) groups.set(row.group, [])
    groups.get(row.group).push(row)
  }
  return [...groups.entries()].map(([group, rows]) => ({ group, rows }))
}

function overrideCount () {
  return overrides.size
}

function has (key) {
  return registry.has(key)
}

function registered () {
  return [...registry.keys()]
}

module.exports = {
  define,
  get,
  getRaw,
  set,
  reset,
  resetAll,
  list,
  grouped,
  overrideCount,
  has,
  registered,
  coerce,
  isSecret,
  source
}
