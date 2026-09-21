'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const store = require('../data-store')

test('first observation is a baseline and later observation calculates earnings and hourly rate', () => {
  const first = store.calculateProduction(undefined, 100, 1000)
  assert.equal(first.earned, null)
  assert.equal(first.ratePerHour, null)
  assert.equal(first.status, 'baseline')
  const second = store.calculateProduction({ balance: 100, recordedAt: 1000 }, 125, 3700)
  assert.equal(second.earned, 25)
  assert.equal(second.ratePerHour, 33333.333333333336)
  assert.equal(second.status, 'calculated')
})

test('N/A balance skips production calculation', () => {
  const result = store.calculateProduction({ balance: 100, recordedAt: 1000 }, null, 2000)
  assert.equal(result.earned, null)
  assert.equal(result.ratePerHour, null)
  assert.equal(result.status, 'N/A balance')
})

test('snapshot carries the bot and spawner rows and nothing that pretends to total them', () => {
  const state = store.emptyState()
  store.upsertBot(state, { bot: 'A', rank: 'Member', lifetimeEarned: 10 })
  store.upsertSpawner(state, { bot: 'A', spawnerNumber: 1, earned: 4 })
  store.upsertSpawner(state, { bot: 'A', spawnerNumber: 2, earned: 6 })
  const snapshot = store.buildSnapshot(state, 0)
  assert.equal(snapshot.bots.length, 1)
  assert.equal(snapshot.spawners.length, 2)
  // The old `lifetime` block was a sheet tab summed from a per-spawner column
  // that could not add up. The running total now lives on the bot row, and the
  // spreadsheet's TOTAL row does the summing.
  assert.equal(snapshot.lifetime, undefined)
  assert.equal(snapshot.bots[0].lifetimeEarned, 10)
  assert.deepEqual(Object.keys(snapshot).sort(), ['bans', 'bots', 'generatedAt', 'spawners', 'version'])
})

// What lands in the Google Sheet is a display document: a raw epoch millisecond
// count and a float with 12 decimals are both unreadable in a cell.
test('the published snapshot carries readable times and rounded money', () => {
  const state = store.emptyState()
  store.upsertBot(state, { bot: 'A', recordedAt: Date.UTC(2026, 8, 17, 0, 45, 43), balance: 1234.5678 })
  store.upsertBot(state, { bot: 'A', recordedAt: Date.UTC(2026, 8, 17, 0, 45, 43), lifetimeEarned: 10.006 })
  store.upsertSpawner(state, { bot: 'A', spawnerNumber: 1, recordedAt: 1000, ratePerHour: 33333.333333333336 })

  const snapshot = store.buildSnapshot(state, Date.UTC(2026, 8, 17, 0, 45, 43))
  assert.equal(snapshot.bots[0].recordedAt, '2026-09-17T00:45:43.000Z', 'epoch ms is not readable in a cell')
  assert.equal(snapshot.bots[0].balance, 1234.57)
  assert.equal(snapshot.bots[0].lifetimeEarned, 10.01)
  assert.equal(snapshot.spawners[0].recordedAt, '1970-01-01T00:00:01.000Z')
  assert.equal(snapshot.spawners[0].ratePerHour, 33333.33)
})

// The local state file is what production rates are calculated from, so it must
// keep full precision — only the published copy is rounded.
test('publishing does not mutate the stored state', () => {
  const state = store.emptyState()
  store.upsertSpawner(state, { bot: 'A', spawnerNumber: 1, recordedAt: 1000, ratePerHour: 33333.333333333336 })
  store.buildSnapshot(state, 2000)
  assert.equal(state.spawners['A:1'].recordedAt, 1000)
  assert.equal(state.spawners['A:1'].ratePerHour, 33333.333333333336)
})

test('publishRow leaves text, objects, booleans, and whole numbers alone', () => {
  const row = store.publishRow({ bot: 'A', rank: 'Member', banned: true, bannedAt: null, spawnerNumber: 2, location: { x: 1, y: 2, z: 3 }, balance: 5 })
  assert.deepEqual(row, { bot: 'A', rank: 'Member', banned: true, bannedAt: null, spawnerNumber: 2, location: { x: 1, y: 2, z: 3 }, balance: 5 })
})

// A ban arrives as a kick and is remembered in the data state, so it survives a
// restart and reaches the sheet. TRUE/FALSE is a real cell value, while a null
// ban date becomes an empty cell rather than "null".
test('a banned bot publishes a boolean flag and a readable ban date', () => {
  const state = store.emptyState()
  store.upsertBot(state, { bot: 'A', banned: true, bannedAt: Date.UTC(2026, 8, 17, 1, 2, 3), banKind: 'temporary' })
  store.upsertBot(state, { bot: 'B', banned: false, bannedAt: null, banKind: null })
  const [a, b] = store.buildSnapshot(state, 0).bots
  assert.equal(a.banned, true)
  assert.equal(a.bannedAt, '2026-09-17T01:02:03.000Z', 'epoch ms would be unreadable in the cell')
  assert.equal(a.banKind, 'temporary')
  assert.equal(b.banned, false, 'an explicit false, not a blank cell')
  assert.equal(b.bannedAt, null)
})

test('roundPublished keeps two decimals and ignores non-numbers', () => {
  assert.equal(store.roundPublished(1.006), 1.01)
  assert.equal(store.roundPublished(12.5), 12.5)
  assert.equal(store.roundPublished(7), 7)
  assert.equal(store.roundPublished(null), null)
  assert.equal(store.roundPublished('12.5'), '12.5')
})

// A location object used to land in one cell as {"x":1,"y":64,"z":-3}, which
// cannot be filtered, sorted, plotted, or diffed.
// ── Ban hold ────────────────────────────────────────────────────────────────

// The gate that stops a banned account from reconnect-storming the server.
test('a ban is held until it expires, and a permanent ban is held forever', () => {
  const now = 1_000_000
  const live = store.isBanActive({ banned: true, banExpiresAt: now + 60_000 }, now)
  assert.equal(live.held, true)
  assert.equal(live.permanent, false)
  assert.equal(live.expired, false)

  const lapsed = store.isBanActive({ banned: true, banExpiresAt: now - 1 }, now)
  assert.equal(lapsed.held, false)
  assert.equal(lapsed.expired, true, 'the sweep reconnects once this is true')

  for (const row of [{ banned: true, banExpiresAt: 0 }, { banned: true }]) {
    const held = store.isBanActive(row, now)
    assert.equal(held.held, true, JSON.stringify(row))
    assert.equal(held.permanent, true, 'an unstated length must not read as already expired')
  }
})

test('isBanActive only holds bots that are actually banned', () => {
  assert.equal(store.isBanActive(null).held, false)
  assert.equal(store.isBanActive(undefined).held, false)
  assert.equal(store.isBanActive({ bot: 'A' }).held, false)
  assert.equal(store.isBanActive({ banned: false, banExpiresAt: Date.now() + 1e9 }).held, false)
})

test('isBanActive reads both ban row shapes', () => {
  const now = 1_000_000
  assert.equal(store.isBanActive({ banned: true, banExpiresAt: now + 1 }, now).held, true)
  assert.equal(store.isBanActive({ banned: true, expiresAt: now + 1 }, now).held, true)
  assert.equal(store.isBanActive({ banned: true, expiresAt: now - 1 }, now).expired, true)
})

// One row per bot, so the Bans tab stays a roster you act on rather than an
// unbounded event log.
test('recordBan keeps one row per bot and counts repeats', () => {
  const state = store.emptyState()
  const first = store.recordBan(state, { bot: 'Hypr_7_alt', kind: 'temporary', reason: 'Alt Farming (3rd)', caseId: '1129', duration: '29 days', expiresAt: 123, permanent: false })
  assert.equal(state.bans.length, 1)
  assert.equal(first.count, 1)
  assert.equal(first.reason, 'Alt Farming (3rd)')

  store.recordBan(state, { bot: 'Hypr_7_alt', kind: 'temporary', reason: 'Alt Farming (3rd)', permanent: false })
  assert.equal(state.bans.length, 1, 'a second kick from the same ban does not add a row')
  assert.equal(first.count, 2)
  assert.equal(first.expiresAt, 123, 'a later detection without an expiry keeps the known one')

  store.recordBan(state, { bot: 'Other', kind: 'permanent', reason: 'cheating', permanent: true })
  assert.equal(state.bans.length, 2)
  assert.equal(store.recordBan(state, {}), null, 'a record with no bot is ignored')
  assert.equal(state.bans.length, 2)
})

// The hold is file-backed: the bot row carries `banned` + `banExpiresAt`, and it
// has to still be there after a restart or the bot would reconnect into a live ban.
test('a ban hold survives a save/load round trip', () => {
  const file = path.join(os.tmpdir(), `data-store-bans-${process.pid}-${Date.now()}.json`)
  const state = store.emptyState()
  store.upsertBot(state, { bot: 'A', banned: true, bannedAt: 1000, banKind: 'temporary', banReason: 'alt farming', banExpiresAt: 9_999_999_999_999 })
  store.recordBan(state, { bot: 'A', kind: 'temporary', reason: 'alt farming', expiresAt: 9_999_999_999_999, permanent: false })
  store.saveState(file, state)
  const reloaded = store.loadState(file)
  fs.unlinkSync(file)

  assert.equal(reloaded.bans.length, 1, 'the Bans-tab roster is saved too')
  const hold = store.isBanActive(reloaded.bots.A)
  assert.equal(hold.held, true, 'a restart must not walk back into the ban')
  assert.equal(hold.expiresAt, 9_999_999_999_999)
})

test('a bans roster row is distinguishable from a bot hold row', () => {
  const state = store.emptyState()
  store.recordBan(state, { bot: 'A', kind: 'permanent', reason: 'cheating', permanent: true })
  // bans[] rows describe history; only the bot row gates reconnecting.
  assert.equal(store.isBanActive(state.bans[0]).held, false)
  assert.equal(store.isBanActive({ banned: true, banExpiresAt: 0 }).held, true)
})

test('the published snapshot carries ban records with readable times', () => {
  const state = store.emptyState()
  const expiresAt = Date.UTC(2026, 9, 16, 12, 41, 25)
  store.recordBan(state, { bot: 'A', kind: 'temporary', reason: 'Alt Farming (3rd)', duration: '29 days, 11 hours, 17 minutes', expiresAt, permanent: false })
  store.recordBan(state, { bot: 'B', kind: 'permanent', reason: 'cheating', permanent: true })
  const [a, b] = store.buildSnapshot(state, 0).bans
  assert.equal(a.expiresAt, '2026-10-16T12:41:25.000Z')
  assert.equal(a.permanent, false)
  assert.equal(a.count, 1)
  assert.equal(b.permanent, true)
  assert.equal(b.expiresAt, '', 'no expiry is an empty cell, not 1970-01-01')
})

test('flattenPosition turns a location blob into plain scalar columns', () => {
  assert.deepEqual(
    store.flattenPosition({ x: 12.5, y: 64, z: -3, dimension: 'minecraft:overworld' }),
    { x: 12.5, y: 64, z: -3, dimension: 'minecraft:overworld' }
  )
  assert.deepEqual(store.flattenPosition({ x: 1, y: 2, z: 3 }), { x: 1, y: 2, z: 3 })
  // A disconnected bot has a dimension but no position; keep what is real.
  assert.deepEqual(store.flattenPosition({ dimension: 'minecraft:the_end' }), { dimension: 'minecraft:the_end' })
  assert.equal(store.flattenPosition(null), null, 'a missing location adds no columns at all')
  assert.deepEqual({ ...store.flattenPosition(null), bot: 'A' }, { bot: 'A' })
  assert.deepEqual(store.flattenPosition({ x: 'nope', y: NaN }), null)
})

// Row position is part of the published contract: a sheet formula that diffs two
// adjacent rows, or looks a value up by position, has to keep pointing at the
// same bot. Rows are therefore append-stable, never re-sorted alphabetically.
test('bot row order is append-stable and survives a restart', () => {
  const file = path.join(os.tmpdir(), `data-store-order-${process.pid}-${Date.now()}.json`)
  const state = store.emptyState()
  store.upsertBot(state, { bot: 'Zeta' })
  store.upsertBot(state, { bot: 'Alpha' })
  assert.deepEqual(store.buildSnapshot(state, 0).bots.map(row => row.bot), ['Zeta', 'Alpha'], 'insertion order, not alphabetical')

  store.upsertBot(state, { bot: 'Beta' })
  assert.deepEqual(store.buildSnapshot(state, 0).bots.map(row => row.bot), ['Zeta', 'Alpha', 'Beta'], 'a new bot appends; existing rows do not move')

  store.upsertBot(state, { bot: 'Zeta', balance: 5 })
  assert.deepEqual(store.buildSnapshot(state, 0).bots.map(row => row.bot), ['Zeta', 'Alpha', 'Beta'], 'updating a bot does not move its row')

  store.saveState(file, state)
  const reloaded = store.loadState(file)
  fs.unlinkSync(file)
  assert.deepEqual(store.buildSnapshot(reloaded, 0).bots.map(row => row.bot), ['Zeta', 'Alpha', 'Beta'], 'and the order survives a restart')
})

test('webhook posts JSON payload', async () => {
  let request
  const response = await store.pushWebhook('https://example.test', { bots: [] }, async (url, options) => {
    request = { url, options }
    return { ok: true, status: 200 }
  })
  assert.equal(response.pushed, true)
  assert.equal(request.options.method, 'POST')
  assert.deepEqual(JSON.parse(request.options.body), { bots: [] })
  assert.equal(request.url, 'https://example.test', 'no secret means no query parameter')
})

// Apps Script web apps never expose request headers, so the shared secret has to
// ride along in the URL (e.parameter.secret) and the JSON body.
test('webhook sends the shared secret as a query parameter and a body field', async () => {
  let request
  await store.pushWebhook('https://script.test/exec?foo=1', { bots: [] }, async (url, options) => {
    request = { url, options }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, written: { Bots: 0, Spawners: 0, Bans: 0 } }) }
  }, { secret: 's3cret value' })
  assert.equal(request.url, 'https://script.test/exec?foo=1&secret=s3cret%20value')
  assert.equal(JSON.parse(request.options.body).secret, 's3cret value')
})

test('webhook reports the rows the Apps Script endpoint actually wrote', async () => {
  const response = await store.pushWebhook('https://script.test/exec', { bots: [] }, async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, written: { Bots: 3, Spawners: 8, Bans: 1 } })
  }))
  assert.equal(response.pushed, true)
  assert.deepEqual(response.response.written, { Bots: 3, Spawners: 8, Bans: 1 })
})

// A web app that is not deployed with "Who has access: Anyone" answers with an
// HTML sign-in page and HTTP 200 — the old code reported a successful push while
// the spreadsheet was never touched.
test('webhook rejects a non-JSON response instead of claiming success', async () => {
  await assert.rejects(
    store.pushWebhook('https://script.test/exec', { bots: [] }, async () => ({
      ok: true,
      status: 200,
      text: async () => '<!DOCTYPE html><html><body>Sign in to continue</body></html>'
    })),
    /HTML answer/)
})

// The HTML body names the fault, and the three faults need different fixes, so
// the diagnosis must not collapse them into "the deployment is not public".
test('diagnoses a Google sign-in page as a non-public deployment', () => {
  const page = '<!DOCTYPE html><html><head><title>Sign in - Google Accounts</title></head><body><a href="https://accounts.google.com/ServiceLogin">Sign in</a></body></html>'
  const verdict = store.diagnoseWebhookBody(page, { url: 'https://script.google.com/macros/s/AK/exec', status: 200, method: 'GET' })
  assert.equal(verdict.kind, 'login')
  assert.match(verdict.message, /Execute as: Me/)
  assert.match(verdict.message, /Who has access: Anyone/)
})

// This is the case that used to be misreported as a permissions problem: the
// deployment IS public, it just runs an older Code.gs with no doGet.
test('diagnoses a missing doGet as a stale deployed version', () => {
  const page = '<html><head><title>Error</title></head><body><div>Script function not found: doGet</div></body></html>'
  const verdict = store.diagnoseWebhookBody(page, { url: 'https://script.google.com/macros/s/AK/exec', status: 200, method: 'GET' })
  assert.equal(verdict.kind, 'missing-doget')
  assert.match(verdict.message, /no doGet\(\)/)
  assert.match(verdict.message, /New version/)
  assert.match(verdict.message, /Script function not found: doGet/, 'quotes the page so the user can verify it')
})

test('diagnoses an exception page as a bug inside Code.gs', () => {
  const page = '<html><body><h1>Exception: Cannot read property \'length\' of null</h1><p>at replaceSheet_ (Code:12)</p></body></html>'
  const verdict = store.diagnoseWebhookBody(page, { url: 'https://script.google.com/macros/s/AK/exec', status: 500, method: 'POST' })
  assert.equal(verdict.kind, 'script-error')
  assert.match(verdict.message, /HTTP 500/)
  assert.match(verdict.message, /Exception: Cannot read property/)
})

test('flags the /dev URL, which always requires a sign-in', () => {
  const verdict = store.diagnoseWebhookBody('<html><body>Sign in</body></html>', {
    url: 'https://script.google.com/macros/s/AKfycbx/dev',
    status: 200,
    method: 'GET'
  })
  assert.equal(verdict.kind, 'dev-url')
  assert.match(verdict.message, /\/exec/)
})

// An Apps Script error page arrives as HTTP 500, and reporting a bare status code
// threw away the exception text that names the real problem.
test('classifies an HTML error page that arrives with HTTP 500', async () => {
  await assert.rejects(
    store.pushWebhook('https://script.test/exec', { bots: [] }, async () => ({
      ok: false,
      status: 500,
      text: async () => '<html><body>Exception: SPREADSHEET_ID is not set</body></html>'
    })),
    /script-error|SPREADSHEET_ID is not set/)
})

test('a non-HTML HTTP error still reports the status code and detail', async () => {
  await assert.rejects(
    store.pushWebhook('https://script.test/exec', { bots: [] }, async () => ({
      ok: false,
      status: 502,
      text: async () => 'bad gateway'
    })),
    /HTTP 502 \u2014 bad gateway/)
})

test('htmlToText strips markup and decodes the common entities', () => {
  assert.equal(store.htmlToText('<b>A &amp; B</b><br>\n<c>1 &lt; 2</c>'), 'A & B 1 < 2')
  assert.equal(store.htmlToText('<script>var x = 1</script>visible'), 'visible')
})

test('webhook surfaces errors reported by the Apps Script endpoint', async () => {
  await assert.rejects(
    store.pushWebhook('https://script.test/exec', { bots: [] }, async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: false, errors: ['Bots: cannot write to sheet'] })
    })),
    /Bots: cannot write to sheet/)
})

test('webhook applies the configured timeout', async () => {
  let request
  await store.pushWebhook('https://script.test/exec', { bots: [] }, async (url, options) => {
    request = { url, options }
    return { ok: true, status: 200 }
  }, { timeoutMs: 5000 })
  assert.ok(request.options.signal instanceof AbortSignal, 'a timeout must abort the request')
})

test('webhook request failures carry the reason', async () => {
  await assert.rejects(
    store.pushWebhook('https://script.test/exec', { bots: [] }, async () => { throw new Error('getaddrinfo ENOTFOUND script.test') }),
    /data webhook request failed: getaddrinfo ENOTFOUND/)
})

test('withSecret only appends when a secret is set', () => {
  assert.equal(store.withSecret('https://x/exec', ''), 'https://x/exec')
  assert.equal(store.withSecret('https://x/exec', 'a b'), 'https://x/exec?secret=a%20b')
  assert.equal(store.withSecret('https://x/exec?v=1', 'k'), 'https://x/exec?v=1&secret=k')
})
