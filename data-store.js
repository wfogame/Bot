'use strict'

const fs = require('fs')
const path = require('path')

function emptyState () {
  return { version: 1, updatedAt: null, bots: {}, spawners: {}, bans: [], events: [] }
}

function loadState (file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { ...emptyState(), ...parsed, bots: parsed.bots || {}, spawners: parsed.spawners || {}, bans: parsed.bans || [], events: parsed.events || [] }
  } catch (_) { return emptyState() }
}

// Ban records exist for two readers: the ban hold (bot.js reads `banExpiresAt`
// to decide whether a bot may reconnect) and the `Bans` tab in the spreadsheet.
//
// One row per bot, not one per event: the sheet is a roster you act on, and an
// event log would grow without bound. `count` plus the first/last timestamps keep
// repeat bans visible without a second tab.
// Decides whether a banned bot may reconnect. Kept here (not in bot.js) so the
// rule is unit-testable: a ban is held until its expiry passes, and 0/absent
// expiry means "never ends" — a permanent ban, or one whose length the server
// never stated — so it is held indefinitely rather than read as already expired.
// Accepts either row shape: the bot row's `banExpiresAt` or a bans[] `expiresAt`.
function isBanActive (row, now = Date.now()) {
  if (!row || !row.banned) return { held: false, expired: false, expiresAt: 0, permanent: false }
  const expiresAt = Number(row.banExpiresAt ?? row.expiresAt) || 0
  if (expiresAt && now >= expiresAt) return { held: false, expired: true, expiresAt, permanent: false }
  return { held: true, expired: false, expiresAt, permanent: !expiresAt }
}

function recordBan (state, record) {
  if (!Array.isArray(state.bans)) state.bans = []
  const key = String((record && record.bot) || '').trim()
  if (!key) return null
  const now = Date.now()
  const existing = state.bans.find(row => row.bot === key)
  if (existing) {
    if (record.kind) existing.kind = record.kind
    if (record.reason) existing.reason = record.reason
    if (record.caseId) existing.caseId = record.caseId
    if (record.duration) existing.duration = record.duration
    if (record.expiresAt) existing.expiresAt = record.expiresAt
    existing.permanent = Boolean(record.permanent)
    existing.lastBannedAt = now
    existing.count = (existing.count || 1) + 1
    return existing
  }
  const row = {
    bot: key,
    kind: record.kind || 'permanent',
    reason: record.reason || '',
    caseId: record.caseId || '',
    duration: record.duration || '',
    // 0 means "never expires" — a permanent ban or one whose length the server
    // never stated. Kept as a number so the ban hold can compare against now.
    expiresAt: Number(record.expiresAt) || 0,
    permanent: Boolean(record.permanent),
    firstBannedAt: now,
    lastBannedAt: now,
    count: 1
  }
  state.bans.push(row)
  return row
}

function saveState (file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

function calculateProduction (previous, balance, now = Date.now()) {
  if (!Number.isFinite(balance)) return { earned: null, ratePerHour: null, status: 'N/A balance' }
  const earned = Number.isFinite(previous?.balance) ? balance - previous.balance : null
  const elapsedMs = Number.isFinite(previous?.recordedAt) ? now - previous.recordedAt : null
  const ratePerHour = earned !== null && elapsedMs > 0 ? earned * 3600000 / elapsedMs : null
  return { earned, ratePerHour, status: ratePerHour === null ? 'baseline' : 'calculated' }
}

function upsertBot (state, row) {
  state.bots[row.bot] = { ...state.bots[row.bot], ...row }
}

function upsertSpawner (state, row) {
  const key = `${row.bot}:${row.spawnerNumber}`
  state.spawners[key] = { ...state.spawners[key], ...row }
}

// Money and rates are published to two decimals. A derived rate such as
// 33333.333333333336 is noise in a spreadsheet cell, and the exact float is only
// ever needed internally (the local state file keeps it untouched).
function roundPublished (value) {
  if (typeof value !== 'number' || !isFinite(value) || Number.isInteger(value)) return value
  return Math.round(value * 100) / 100
}

// A { x, y, z, dimension } location is a single unreadable cell in a sheet
// ({"x":1,"y":64,"z":-3}) that you cannot filter, plot, sort, or diff. Flatten it
// into plain scalar columns. Returns null when there is nothing to publish, so
// spreading the result into a row adds no columns at all.
function flattenPosition (location) {
  if (!location) return null
  const out = {}
  ;['x', 'y', 'z'].forEach(axis => {
    if (Number.isFinite(location[axis])) out[axis] = location[axis]
  })
  if (typeof location.dimension === 'string' && location.dimension) out.dimension = location.dimension
  return Object.keys(out).length ? out : null
}

// Converts one row for publication. `*At` fields are stored as epoch
// milliseconds internally (production rates are differences of them), which is
// an unreadable 1758067200000 in a cell, so they are published as ISO 8601 —
// readable in any viewer and convertible to a real date by Apps Script.
function publishRow (row) {
  const out = {}
  Object.keys(row).forEach(key => {
    const value = row[key]
    if (/(?:At|Time)$/.test(key) && typeof value === 'number' && isFinite(value)) {
      // 0 is how "no expiry" is stored, and it must not publish as 1970-01-01.
      out[key] = value > 0 ? new Date(value).toISOString() : ''
      return
    }
    out[key] = roundPublished(value)
  })
  return out
}

// One object per tab. There is no `lifetime` block any more: it was a single
// row summing a per-spawner `lifetimeEarned` that could not add up (the balance
// it came from is the whole bot's, sampled around one click at a time), so the
// running total lives on the Bots tab, where the measurement is actually taken,
// and the sheet's own TOTAL row sums it.
function buildSnapshot (state, now = Date.now()) {
  return {
    version: state.version,
    generatedAt: new Date(now).toISOString(),
    bots: Object.values(state.bots).map(publishRow),
    spawners: Object.values(state.spawners).map(publishRow),
    bans: (state.bans || []).map(publishRow)
  }
}

// Appends the shared secret as a query parameter. Apps Script web apps expose
// query parameters (e.parameter) but never request headers, so the secret has to
// travel in the URL and/or the JSON body.
function withSecret (url, secret) {
  if (!secret) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}secret=${encodeURIComponent(secret)}`
}

// Strips an HTML document down to its visible text so an Apps Script error page
// can be quoted instead of silently discarded.
function htmlToText (html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function htmlTitle (html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match ? htmlToText(match[1]).slice(0, 120) : ''
}

// "The body is HTML" is only half a diagnosis: Google's page says WHICH fault
// happened, and the three cases need completely different fixes. Classify it so
// the bot never again blames permissions for a missing doGet.
//
// Returns { kind, message } where kind is one of:
//   'dev-url'       — DATA_WEBHOOK_URL is the /dev URL, which always needs sign-in
//   'login'         — deployment is not public (or "Execute as" is wrong)
//   'missing-doget' — the deployed code is stale: no doGet exists
//   'script-error'  — the deployed code threw (the page carries the exception)
//   'html'          — some other HTML page
function diagnoseWebhookBody (text, { url = '', status = 0, method = 'POST' } = {}) {
  const raw = String(text || '')
  const visible = htmlToText(raw)
  const title = htmlTitle(raw)
  const statusText = status ? `HTTP ${status}` : 'no HTTP status'
  const pageText = visible.slice(0, 240) || '(empty body)'
  const titleSuffix = title ? ` — page title: "${title}"` : ''
  const excerpt = `\n  Page said: ${pageText}${titleSuffix}`

  if (/\/dev(?:\/)?(?:[?#]|$)/.test(String(url || '')) && !/\/exec(?:[?#]|$)/.test(String(url || ''))) {
    return {
      kind: 'dev-url',
      message: `DATA_WEBHOOK_URL points at the Apps Script /dev URL, which ALWAYS requires a Google sign-in — even on a public deployment. Use the /exec URL instead: Apps Script → Deploy → Manage deployments → copy the "Web app" URL (it ends in /exec), then put that in DATA_WEBHOOK_URL and restart.${excerpt}`
    }
  }
  if (/ServiceLogin|accounts\.google\.com|Sign in - Google Accounts|Choose an account|Google Account/i.test(raw)) {
    return {
      kind: 'login',
      message: `Google served a sign-in page (${statusText}) — the deployment is not reachable anonymously, so bot.js can never write to the sheet. In Apps Script → Deploy → Manage deployments → pencil icon set "Execute as: Me" AND "Who has access: Anyone", then Version: New version → Deploy. Both settings must be on the SAME deployment you copied the /exec URL from.${excerpt}`
    }
  }
  if (/Script function not found/i.test(raw)) {
    const fn = (raw.match(/Script function not found:?\s*([A-Za-z0-9_]+)/i) || [])[1] || 'doGet'
    return {
      kind: 'missing-doget',
      message: `The deployment is public, but its code has no ${fn}() — so the LIVE web app is an older version of Code.gs (${statusText}, ${method} request). Saving Code.gs does not update a deployed web app: paste the current google-apps-script/Code.gs, then Deploy → Manage deployments → pencil icon → Version: **New version** → Deploy (keep the same deployment so the /exec URL stays valid).${excerpt}`
    }
  }
  if (/Exception|TypeError|ReferenceError|Cannot read|is not a function|Unexpected error|Authorization is required|ScriptError/i.test(raw)) {
    return {
      kind: 'script-error',
      message: `The Apps Script deployment is public but its code threw an exception while handling the ${method} (${statusText}) — this is a bug inside Code.gs, not a permissions problem. Paste the current google-apps-script/Code.gs and redeploy a New version.${excerpt}`
    }
  }
  return {
    kind: 'html',
    message: `Got an HTML answer (${statusText}) instead of JSON. Usually the deployment is not public (Apps Script → Deploy → Manage deployments → Execute as: Me, Who has access: Anyone, Version: New version → Deploy) — but confirm against the page text below before changing permissions.${excerpt}`
  }
}

// POSTs a snapshot to the configured webhook (normally a Google Apps Script
// doPost). The response body is parsed and validated, because a web app that is
// not deployed with "Who has access: Anyone" answers with an HTML login page and
// HTTP 200 — the push looked successful while the sheet never updated.
//
// Resolves with { pushed, status, response } where `response` is the parsed JSON
// body (null when the endpoint returned no body, e.g. in unit tests).
async function pushWebhook (url, payload, fetchImpl = globalThis.fetch, { secret = '', timeoutMs = 0 } = {}) {
  if (!url) return { pushed: false, skipped: true, response: null }
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable')

  const body = JSON.stringify(secret ? { ...payload, secret } : payload)
  const options = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  }
  if (timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    options.signal = AbortSignal.timeout(timeoutMs)
  }

  let response
  try {
    response = await fetchImpl(withSecret(url, secret), options)
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
    const reason = timedOut ? `timed out after ${timeoutMs}ms` : (err && err.message ? err.message : String(err))
    throw new Error(`data webhook request failed: ${reason}`)
  }
  if (!response) throw new Error('data webhook returned no response')

  // Read the body BEFORE judging the status code: an Apps Script error page
  // arrives as HTTP 500 with an HTML body that names the real fault, and
  // reporting a bare "HTTP 500" throws that away.
  const text = typeof response.text === 'function' ? await response.text() : ''
  if (!response.ok) {
    const trimmed = text.trim()
    if (trimmed.startsWith('<')) throw new Error(diagnoseWebhookBody(trimmed, { url, status: response.status, method: 'POST' }).message)
    const detail = trimmed ? ` — ${trimmed.replace(/\s+/g, ' ').slice(0, 200)}` : ''
    throw new Error(`data webhook returned HTTP ${response.status}${detail}`)
  }

  let parsed = null
  if (text && text.trim()) {
    try {
      parsed = JSON.parse(text)
    } catch (_) {
      throw new Error(diagnoseWebhookBody(text, { url, status: response.status, method: 'POST' }).message)
    }
  }
  if (parsed && parsed.ok === false) {
    const detail = Array.isArray(parsed.errors) && parsed.errors.length ? parsed.errors.join('; ') : 'no detail reported'
    throw new Error(`Apps Script reported a failure: ${detail}`)
  }
  return { pushed: true, status: response.status, response: parsed }
}

module.exports = { emptyState, loadState, saveState, calculateProduction, upsertBot, upsertSpawner, recordBan, isBanActive, buildSnapshot, pushWebhook, withSecret, diagnoseWebhookBody, htmlToText, publishRow, roundPublished, flattenPosition }
