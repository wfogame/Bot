/**
 * OpenMontage `/data` webhook — Google Apps Script endpoint.
 *
 * Setup (once):
 *   1. Paste this file into the Apps Script editor bound to (or standalone for)
 *      the target spreadsheet.
 *   2. Run the line below ONCE, with your spreadsheet id inside the quotes
 *      (Apps Script → Run → choose setSpreadsheetId).
 *        setSpreadsheetId('1AbC...your-sheet-id...XyZ')
 *      A no-argument setSpreadsheetId() from an older copy stored nothing, and
 *      openById(null) then threw on every push — that is the classic "it always
 *      fails" cause. The id is the part of the sheet URL between /d/ and /edit.
 *      (You can also hardcode SPREADSHEET_ID_OVERRIDE below instead.)
 *   3. Optional: run setWebhookSecret('...') and put the same value in the bot's
 *      DATA_WEBHOOK_SECRET .env variable.
 *   4. Deploy → New deployment → Web app (Execute as: Me, Who has access:
 *      Anyone). Copy the /exec URL into DATA_WEBHOOK_URL.
 *   5. Open that /exec URL in a browser: doGet returns a health JSON. If you see
 *      a Google sign-in page instead, the deployment is not public and bot.js
 *      cannot write to the sheet. A page reading "Script function not found:
 *      doGet" means the live version is an older Code.gs.
 *   6. Run testWrite() here to verify sheets, headers, and permissions.
 *
 * IMPORTANT — you edited this file after deploying once:
 *   Saving the code does NOT update a live web app. Deploy → Manage deployments
 *   → pencil icon on the existing deployment → Version: **New version** →
 *   Deploy. Keep the same deployment so the /exec URL in DATA_WEBHOOK_URL stays
 *   valid. "Who has access: Anyone" alone is not enough: it only works together
 *   with "Execute as: Me"; with "Execute as: User accessing the web app" an
 *   anonymous call has no permission to the spreadsheet and writes fail.
 *
 * ── What this script touches, and what it never touches ──────────────────────
 * Only the `Bots`, `Spawners`, and `Bans` tabs are written, and
 * inside them only the COLUMNS this script created — the ones whose header names
 * come from the pushed payload (bot, balance, coins, shards, earned, ...).
 *
 *   · Every other column on those tabs is yours. Your headers, values, formulas,
 *     notes, and formatting in them are never read back and never written.
 *   · Row 1 of a column we don't own is never touched, so your layout below a
 *     header you added stays exactly as you left it.
 *   · Other tabs are never opened, created, or modified. Add as many as you like.
 *     A tab we have never written to is left untouched even when a payload is
 *     empty, so a summary tab you keep by hand is never cleared.
 *   · Fonts, colours, borders, notes, and conditional formatting are never set
 *     or cleared. We use clearContents(), which preserves formatting; this script
 *     never calls clear()/clear({format: true}).
 *   · The one formatting change is the NUMBER FORMAT of our own columns (negative
 *     numbers as "-1,234.56", counts as "1,234"). Set NUMBER_FORMATS to "off" to
 *     keep whatever you set yourself, or edit the map — see listSettings().
 *   · Column ownership is remembered between pushes in the OWNED_* script
 *     properties, so a column the payload stopped sending is emptied instead of
 *     left stale. Renaming one of OUR headers makes the script treat it as a new
 *     column and append its own next to it — so rename nothing here by hand, or
 *     run resetLayout() first to hand those columns back to you.
 *
 * A "TOTAL" row of =SUM() formulas is appended under the data (see TOTALS_ROW /
 * TOTALS_COLUMNS). It sums `balance`, `coins`, `shards`, `invUsed`, `earned`,
 * and `lifetimeEarned` on Bots, plus `earned` on Spawners. Those sums are the
 * totals to trust: `lifetimeEarned` on Bots is a running total accumulated where
 * the balance is actually measured (one bot), while a spawner row's `earned` is
 * that row's last measured window, so summing the spawner rows totals the last
 * run rather than all time.
 *
 * ── Readable times ───────────────────────────────────────────────────────────
 * Timestamps (`recordedAt`, `runStartedAt`, `lastRunAt`, ...) arrive as epoch
 * milliseconds — 1758067200000 — which is unreadable in a cell. Any column whose
 * header ends in `At` or `Time` is converted to a real date value, so Sheets
 * shows it in your own locale format (and Date/Time functions work on it). Set
 * TIMESTAMP_FORMAT (e.g. "yyyy-mm-dd hh:mm") to force one format everywhere.
 *
 * Verify the whole path from the bot with: /data check
 *
 * Why writes used to fail silently: Apps Script answers a non-public web app
 * with an HTML login page and HTTP 200, so the bot logged a successful push
 * while the spreadsheet was never touched. doGet + the JSON error list below
 * make that visible.
 */

// Set a string here to skip the SPREADSHEET_ID script property.
var SPREADSHEET_ID_OVERRIDE = ''

var SHEET_BOTS = 'Bots'
var SHEET_SPAWNERS = 'Spawners'
// Retired: an older version of this script wrote a one-row `Lifetime` summary
// here. Nothing writes it any more (the running total lives on the Bots tab, so
// the sheet's own TOTAL row can sum it). The tab itself is left untouched, and
// removeLifetimeTab() below deletes it on request.
var SHEET_LIFETIME_RETIRED = 'Lifetime'
// One row per banned bot: current ban state, its reason, and whether the ban
// expires. Written from the `bans` array the bot keeps in its data file, so the
// record survives a restart even though the bot itself cannot reconnect.
var SHEET_BANS = 'Bans'
var MANAGED_SHEETS = [SHEET_BOTS, SHEET_SPAWNERS, SHEET_BANS]
// Apps Script rejects cells longer than 50,000 characters.
var MAX_CELL_LENGTH = 49000

var MONEY_FORMAT = '#,##0.00'
var COUNT_FORMAT = '#,##0'

// Applied to the columns this script owns. Keys are header names; only columns
// that exist on the sheet are touched, so listing extra names is harmless.
var DEFAULT_NUMBER_FORMATS = {
  balance: MONEY_FORMAT,
  balanceBefore: MONEY_FORMAT,
  balanceAfter: MONEY_FORMAT,
  earned: MONEY_FORMAT,
  lifetimeEarned: MONEY_FORMAT,
  ratePerHour: MONEY_FORMAT,
  coins: COUNT_FORMAT,
  shards: COUNT_FORMAT,
  spawnerCount: COUNT_FORMAT,
  trackedSpawners: COUNT_FORMAT,
  successfulSpawners: COUNT_FORMAT,
  spawnerNumber: COUNT_FORMAT,
  invUsed: COUNT_FORMAT,
  invFree: COUNT_FORMAT,
  invTotal: COUNT_FORMAT,
  count: COUNT_FORMAT,
  // Coordinates are floats, so they get two decimals to line up in a column.
  x: MONEY_FORMAT,
  y: MONEY_FORMAT,
  z: MONEY_FORMAT
}

// Which owned columns get a =SUM() in the TOTAL row. Names not present on the
// sheet are skipped, so one list covers every tab.
var DEFAULT_TOTALS_COLUMNS = ['balance', 'coins', 'shards', 'invUsed', 'earned', 'lifetimeEarned']

var TOTALS_LABEL = 'TOTAL'

function props_ () {
  return PropertiesService.getScriptProperties()
}

function spreadsheetId_ () {
  return String(SPREADSHEET_ID_OVERRIDE || props_().getProperty('SPREADSHEET_ID') || '').trim()
}

function secret_ () {
  return String(props_().getProperty('WEBHOOK_SECRET') || '').trim()
}

function ownedColumnsKey_ (name) { return 'OWNED_COLUMNS_' + name }
function ownedRowsKey_ (name) { return 'OWNED_ROWS_' + name }

// The columns this script owns on a tab: everything it created last time (even
// if the current payload no longer mentions it, so stale cells get cleared) plus
// anything new in this payload.
function ownedColumns_ (name) {
  var stored = String(props_().getProperty(ownedColumnsKey_(name)) || '').trim()
  if (!stored) return []
  return stored.split(',').map(function (header) { return header.trim() }).filter(function (header) { return header !== '' })
}

function totalsRowMode_ () {
  var mode = String(props_().getProperty('TOTALS_ROW') || 'bottom').trim().toLowerCase()
  return mode === 'top' || mode === 'off' ? mode : 'bottom'
}

function totalsColumns_ () {
  var stored = String(props_().getProperty('TOTALS_COLUMNS') || '').trim()
  if (!stored) return DEFAULT_TOTALS_COLUMNS.slice()
  return stored.split(',').map(function (header) { return header.trim() }).filter(function (header) { return header !== '' })
}

// Returns null when formatting is disabled, otherwise a header→format map.
function numberFormats_ () {
  var stored = String(props_().getProperty('NUMBER_FORMATS') || '').trim()
  if (!stored) return DEFAULT_NUMBER_FORMATS
  if (/^off$/i.test(stored)) return null
  try {
    var parsed = JSON.parse(stored)
    return parsed && typeof parsed === 'object' ? parsed : DEFAULT_NUMBER_FORMATS
  } catch (_) {
    return DEFAULT_NUMBER_FORMATS
  }
}

function timestampFormat_ () {
  return String(props_().getProperty('TIMESTAMP_FORMAT') || '').trim()
}

// GET /exec → health check. Never writes anything.
function doGet () {
  var sheetId = spreadsheetId_()
  var sheets = []
  var spreadsheetError = ''
  if (sheetId) {
    try {
      sheets = SpreadsheetApp.openById(sheetId).getSheets().map(function (sheet) { return sheet.getName() })
    } catch (err) {
      spreadsheetError = err.message
    }
  }
  var layout = {}
  MANAGED_SHEETS.forEach(function (name) {
    var owned = ownedColumns_(name)
    if (owned.length) layout[name] = owned
  })
  return json_({
    ok: Boolean(sheetId) && !spreadsheetError,
    service: 'openmontage-data',
    version: 4,
    spreadsheetId: sheetId,
    spreadsheetError: spreadsheetError,
    sheets: sheets,
    secretRequired: Boolean(secret_()),
    historySheet: String(props_().getProperty('HISTORY_SHEET') || ''),
    layout: layout,
    totalsRow: totalsRowMode_(),
    totalsColumns: totalsColumns_(),
    numberFormats: numberFormats_() ? 'custom' : 'off',
    timestampFormat: timestampFormat_() || '(locale default)',
    time: new Date().toISOString()
  })
}

function doPost (e) {
  var sheetId = spreadsheetId_()
  if (!sheetId) {
    return json_({
      ok: false,
      errors: ['SPREADSHEET_ID is not set — run setSpreadsheetId("<spreadsheet id>") once in this editor (or fill SPREADSHEET_ID_OVERRIDE).']
    })
  }
  if (!e || !e.postData || !e.postData.contents) {
    return json_({
      ok: false,
      errors: ['No POST body received. Running doPost by hand (Run button) cannot pass a payload — use testWrite() for an in-editor smoke test.']
    })
  }

  var body
  try {
    body = JSON.parse(e.postData.contents)
  } catch (err) {
    return json_({ ok: false, errors: ['Request body is not valid JSON: ' + err.message] })
  }
  if (!body || typeof body !== 'object') {
    return json_({ ok: false, errors: ['Request body must be a JSON object with bots/spawners/bans keys.'] })
  }

  var expectedSecret = secret_()
  if (expectedSecret) {
    var provided = (e.parameter && e.parameter.secret) || body.secret || ''
    if (String(provided) !== expectedSecret) {
      return json_({ ok: false, errors: ['Invalid or missing secret — set DATA_WEBHOOK_SECRET in .env to the WEBHOOK_SECRET script property value.'] })
    }
  }

  var ss
  try {
    ss = SpreadsheetApp.openById(sheetId)
  } catch (err) {
    return json_({ ok: false, errors: ['Could not open spreadsheet ' + sheetId + ': ' + err.message] })
  }

  var written = {}
  var layout = {}
  var errors = []
  var plan = [
    [SHEET_BOTS, normalizeRows_(body.bots)],
    [SHEET_SPAWNERS, normalizeRows_(body.spawners)],
    [SHEET_BANS, normalizeRows_(body.bans)]
  ]
  // The `Lifetime` tab is gone. An older Code.gs copy wrote it; this one stops
  // touching it entirely, so a tab with that name is simply left as it is
  // (delete it by hand if you want it gone).
  plan.forEach(function (entry) {
    try {
      var result = writeSheet_(ss, entry[0], entry[1])
      written[entry[0]] = result.rows
      layout[entry[0]] = result.columns
    } catch (err) {
      written[entry[0]] = 0
      errors.push(entry[0] + ': ' + err.message)
    }
  })

  try {
    var appended = appendHistory_(ss, plan[1][1])
    if (appended) written[String(props_().getProperty('HISTORY_SHEET') || 'History')] = appended
  } catch (err) {
    errors.push('history: ' + err.message)
  }

  return json_({
    ok: errors.length === 0,
    spreadsheetId: sheetId,
    generatedAt: body.generatedAt || null,
    written: written,
    layout: layout,
    errors: errors,
    time: new Date().toISOString()
  })
}

// Accepts an array of objects, a single object, or null. Non-objects are dropped
// so an unexpected payload can never throw inside the write path.
function normalizeRows_ (value) {
  if (!value) return []
  var list = Array.isArray(value) ? value : [value]
  var out = []
  list.forEach(function (row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return
    if (Object.keys(row).length) out.push(row)
  })
  return out
}

// A column is a time column when its header reads like one. Every timestamp the
// bot publishes is named *At (recordedAt, runStartedAt, lastRunAt, generatedAt).
function isTimestampKey_ (key) {
  return /(?:At|Time)$/.test(String(key || ''))
}

// Epoch milliseconds, epoch seconds, ISO strings, and Date objects all become a
// real Date so the cell shows a date instead of 1758067200000.
function toDateValue_ (value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value
  if (typeof value === 'number' && isFinite(value)) {
    // 1e11 ms is 1973; anything smaller is seconds, not milliseconds.
    var ms = Math.abs(value) < 1e11 ? value * 1000 : value
    var fromNumber = new Date(ms)
    return isNaN(fromNumber.getTime()) ? null : fromNumber
  }
  if (typeof value === 'string' && value) {
    var fromString = new Date(value)
    return isNaN(fromString.getTime()) ? null : fromString
  }
  return null
}

function cell_ (key, value) {
  if (isTimestampKey_(key)) {
    var date = toDateValue_(value)
    if (date) return date
  }
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    var text
    try {
      text = JSON.stringify(value)
    } catch (_) {
      text = String(value)
    }
    return text.length > MAX_CELL_LENGTH ? text.slice(0, MAX_CELL_LENGTH) + '…' : text
  }
  if (typeof value === 'string') return value.length > MAX_CELL_LENGTH ? value.slice(0, MAX_CELL_LENGTH) + '…' : value
  return value
}

function headerUnion_ (rows) {
  var headers = []
  rows.forEach(function (row) {
    Object.keys(row).forEach(function (key) {
      if (headers.indexOf(key) === -1) headers.push(key)
    })
  })
  return headers
}

// Finds the column each owned header lives in, reusing existing columns (yours
// included — that is why renaming one does not duplicate it) and appending new
// ones in the first free gap. Columns that are not owned are never considered.
function resolveColumnPlan_ (sheet, owned) {
  var lastColumn = Math.max(sheet.getLastColumn(), 1)
  var headerRow = sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
  var byName = {}
  var order = []
  var occupied = {}
  headerRow.forEach(function (value, index) {
    var header = String(value === null || value === undefined ? '' : value).trim()
    if (!header) return
    var column = index + 1
    occupied[column] = true
    if (!byName[header]) byName[header] = column
    if (owned.indexOf(header) !== -1 && order.indexOf(header) === -1) order.push(header)
  })
  var nextColumn = 1
  owned.forEach(function (header) {
    if (byName[header]) {
      if (order.indexOf(header) === -1) order.push(header)
      return
    }
    while (occupied[nextColumn]) nextColumn++
    byName[header] = nextColumn
    occupied[nextColumn] = true
    order.push(header)
  })
  return { byName: byName, order: order }
}

// Writes only the columns this script owns, leaving every other column — values,
// formulas, notes, and formatting — exactly as it was.
//
// Returns { rows, columns, totalsRow, cleared } where `rows` is the number of
// data rows written and `columns` maps each owned header to its column letter.
function writeSheet_ (ss, name, rows) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name)
  var list = rows || []
  var payloadHeaders = headerUnion_(list)
  var previous = ownedColumns_(name)
  var owned = previous.slice()
  payloadHeaders.forEach(function (header) { if (owned.indexOf(header) === -1) owned.push(header) })

  if (!owned.length) {
    // Nothing has ever been written here and nothing is being written now, so
    // leave the tab exactly as it is. Clearing here would wipe a tab you have
    // been keeping by hand (an empty payload hits this path).
    return { rows: 0, columns: {}, totalsRow: 0, cleared: 0 }
  }

  var plan = resolveColumnPlan_(sheet, owned)
  var formats = numberFormats_()
  var stampFormat = timestampFormat_()
  var totalsMode = totalsRowMode_()
  var sumColumns = totalsColumns_()

  var dataStart = totalsMode === 'top' ? 3 : 2
  var dataCount = list.length
  var totalsRow = 0
  if (totalsMode !== 'off' && dataCount > 1) totalsRow = totalsMode === 'top' ? 2 : dataStart + dataCount

  var neededLastRow = Math.max(1, dataStart + dataCount - 1, totalsRow)
  // Also cover the rows written last time so a shrinking roster clears its stale
  // cells — but never reach below that, in case you keep your own data further
  // down the page.
  var previousLastRow = parseInt(props_().getProperty(ownedRowsKey_(name)) || '0', 10) || 0
  var spanLastRow = Math.max(neededLastRow, previousLastRow)
  if (sheet.getMaxRows() < spanLastRow) sheet.insertRowsAfter(sheet.getMaxRows(), spanLastRow - sheet.getMaxRows())

  var labelColumn = -1
  plan.order.forEach(function (header) {
    var column = plan.byName[header]
    if (labelColumn === -1 || column < labelColumn) labelColumn = column
  })

  var columnLetters = {}
  plan.order.forEach(function (header) {
    var column = plan.byName[header]
    var values = []
    for (var row = 1; row <= spanLastRow; row++) {
      if (row === 1) { values.push([header]); continue }
      if (totalsRow && row === totalsRow) { values.push(['']); continue }
      var index = row - dataStart
      var source = index >= 0 && index < dataCount ? list[index] : null
      values.push([source ? cell_(header, source[header]) : ''])
    }
    sheet.getRange(1, column, spanLastRow, 1).setValues(values)

    var dataRange = spanLastRow > 1 ? sheet.getRange(2, column, spanLastRow - 1, 1) : null
    if (dataRange) {
      if (formats && formats[header]) dataRange.setNumberFormat(formats[header])
      if (stampFormat && isTimestampKey_(header)) dataRange.setNumberFormat(stampFormat)
    }

    if (totalsRow) {
      var totalCell = sheet.getRange(totalsRow, column)
      if (column === labelColumn) totalCell.setValue(TOTALS_LABEL)
      else if (sumColumns.indexOf(header) !== -1) {
        totalCell.setFormula('=SUM(' + columnLetter_(column) + dataStart + ':' + columnLetter_(column) + (dataStart + dataCount - 1) + ')')
      }
      if (formats && formats[header]) totalCell.setNumberFormat(formats[header])
      totalCell.setFontWeight('bold')
    }

    columnLetters[header] = columnLetter_(column)
  })

  if (spanLastRow > 1) sheet.setFrozenRows(1)
  props_().setProperty(ownedColumnsKey_(name), plan.order.join(','))
  props_().setProperty(ownedRowsKey_(name), String(spanLastRow))

  return { rows: dataCount, columns: columnLetters, totalsRow: totalsRow, cleared: Math.max(0, previousLastRow - neededLastRow) }
}

function columnLetter_ (column) {
  var letters = ''
  var n = column
  while (n > 0) {
    var remainder = (n - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    n = Math.floor((n - 1) / 26)
  }
  return letters
}

// Optional append-only log, enabled only when the HISTORY_SHEET script property
// is set (e.g. "SpawnerHistory"). Uses the sheet's existing header row when it
// already has one, so it never rewrites or clears history.
function appendHistory_ (ss, rows) {
  var name = String(props_().getProperty('HISTORY_SHEET') || '').trim()
  if (!name || !rows || !rows.length) return 0
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name)
  var existing = sheet.getLastRow() > 0
    ? sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0]
    : []
  var headers = existing.filter(function (header) { return header !== '' })
  if (!headers.length) {
    headers = ['appendedAt'].concat(headerUnion_(rows))
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    sheet.setFrozenRows(1)
  } else if (headers[0] !== 'appendedAt') {
    // Keep the existing layout but stamp when each row was appended.
    headers = ['appendedAt'].concat(headers)
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
  }
  var stamp = new Date()
  var values = rows.map(function (row) {
    return headers.map(function (header) {
      if (header === 'appendedAt') return stamp
      return cell_(header, row[header])
    })
  })
  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, headers.length).setValues(values)
  return values.length
}

function json_ (payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON)
}

// ── One-time setup helpers (run these from the editor) ───────────────────────

function setSpreadsheetId (id) {
  var value = String(id || '').trim()
  if (!value) throw new Error('Usage: setSpreadsheetId("<spreadsheet id>") — the ID is the long string in the sheet URL between /d/ and /edit.')
  props_().setProperty('SPREADSHEET_ID', value)
  return 'SPREADSHEET_ID set to ' + value
}

function setWebhookSecret (secret) {
  var value = String(secret || '').trim()
  if (!value) throw new Error('Usage: setWebhookSecret("<shared secret>")')
  props_().setProperty('WEBHOOK_SECRET', value)
  return 'WEBHOOK_SECRET set — put the same value in DATA_WEBHOOK_SECRET in .env'
}

function setHistorySheet (name) {
  var value = String(name || '').trim()
  if (!value) throw new Error('Usage: setHistorySheet("<sheet name>")')
  props_().setProperty('HISTORY_SHEET', value)
  return 'HISTORY_SHEET set to ' + value
}

// "bottom" (default), "top", or "off".
function setTotalsRow (mode) {
  var value = String(mode || '').trim().toLowerCase()
  if (['bottom', 'top', 'off'].indexOf(value) === -1) throw new Error('Usage: setTotalsRow("bottom" | "top" | "off")')
  props_().setProperty('TOTALS_ROW', value)
  return 'TOTALS_ROW set to ' + value + ' — applies on the next /data push'
}

function setTotalsColumns (columns) {
  var value = Array.isArray(columns) ? columns.join(',') : String(columns || '').trim()
  if (!value) throw new Error('Usage: setTotalsColumns("balance,coins,shards") or setTotalsColumns(["balance","coins"])')
  props_().setProperty('TOTALS_COLUMNS', value)
  return 'TOTALS_COLUMNS set to ' + value
}

// setNumberFormats({ balance: '#,##0.00', coins: '#,##0' }) or 'off'.
function setNumberFormats (formats) {
  if (String(formats).toLowerCase() === 'off') {
    props_().setProperty('NUMBER_FORMATS', 'off')
    return 'NUMBER_FORMATS is off — your own number formats will be left alone'
  }
  var json = typeof formats === 'string' ? formats : JSON.stringify(formats || {})
  JSON.parse(json)
  props_().setProperty('NUMBER_FORMATS', json)
  return 'NUMBER_FORMATS set to ' + json
}

function setTimestampFormat (format) {
  var value = String(format || '').trim()
  if (!value) throw new Error('Usage: setTimestampFormat("yyyy-mm-dd hh:mm") — or clearTimestampFormat() to use the spreadsheet locale')
  props_().setProperty('TIMESTAMP_FORMAT', value)
  return 'TIMESTAMP_FORMAT set to ' + value
}

function clearTimestampFormat () {
  props_().deleteProperty('TIMESTAMP_FORMAT')
  return 'TIMESTAMP_FORMAT cleared — dates use the spreadsheet locale format'
}

// Drops the remembered column layout so the next push treats every column as new
// (useful after renaming one of our headers by hand). Your columns are not
// touched; the ones the script owned are released back to you.
function resetLayout () {
  var dropped = []
  MANAGED_SHEETS.forEach(function (name) {
    if (props_().getProperty(ownedColumnsKey_(name))) dropped.push(name)
    props_().deleteProperty(ownedColumnsKey_(name))
    props_().deleteProperty(ownedRowsKey_(name))
  })
  // Memory of the retired Lifetime tab goes too, so nothing lingers once the tab
  // is gone.
  props_().deleteProperty(ownedColumnsKey_(SHEET_LIFETIME_RETIRED))
  props_().deleteProperty(ownedRowsKey_(SHEET_LIFETIME_RETIRED))
  return 'Layout memory cleared for: ' + (dropped.join(', ') || '(nothing was tracked)')
}

// Deletes the retired `Lifetime` tab. Nothing calls this automatically: deleting
// a sheet is not something a /data push should ever decide to do. Run it once
// from the editor if you want the old tab gone.
function removeLifetimeTab () {
  var id = spreadsheetId_()
  if (!id) throw new Error('Run setSpreadsheetId("<spreadsheet id>") first.')
  var ss = SpreadsheetApp.openById(id)
  var sheet = ss.getSheetByName(SHEET_LIFETIME_RETIRED)
  if (!sheet) return 'No ' + SHEET_LIFETIME_RETIRED + ' tab to remove.'
  ss.deleteSheet(sheet)
  props_().deleteProperty(ownedColumnsKey_(SHEET_LIFETIME_RETIRED))
  props_().deleteProperty(ownedRowsKey_(SHEET_LIFETIME_RETIRED))
  return SHEET_LIFETIME_RETIRED + ' tab removed — the running total is on Bots (lifetimeEarned) now.'
}

function listSettings () {
  var lines = [
    'SPREADSHEET_ID: ' + (spreadsheetId_() || '(not set)'),
    'WEBHOOK_SECRET: ' + (secret_() ? 'set' : '(not set)'),
    'HISTORY_SHEET: ' + (String(props_().getProperty('HISTORY_SHEET') || '').trim() || '(off)'),
    'TOTALS_ROW: ' + totalsRowMode_() + '  (data starts at row ' + (totalsRowMode_() === 'top' ? 3 : 2) + ')',
    'TOTALS_COLUMNS: ' + totalsColumns_().join(', '),
    'TIMESTAMP_FORMAT: ' + (timestampFormat_() || "(spreadsheet locale default)"),
    'NUMBER_FORMATS: ' + (numberFormats_() ? JSON.stringify(numberFormats_()) : 'off'),
    'OWNED COLUMNS:'
  ]
  MANAGED_SHEETS.forEach(function (name) {
    lines.push('  ' + name + ': ' + (ownedColumns_(name).join(', ') || '(none yet)'))
  })
  var report = lines.join('\n')
  Logger.log(report)
  return report
}

// In-editor smoke test: writes a sample snapshot and logs the JSON result.
function testWrite () {
  var secret = secret_()
  var result = doPost({
    parameter: {},
    postData: {
      contents: JSON.stringify({
        bots: [
          { bot: 'TestBotA', rank: 'Member', shards: 1200, coins: 900, balance: 1234.5, earned: 40, lifetimeEarned: 400, invUsed: 12, invFree: 24, invTotal: 36, botPosition: { x: 1, y: 2, z: 3 }, spawnerCount: 1, recordedAt: Date.now() },
          { bot: 'TestBotB', rank: 'Regent', shards: 800, coins: 150, balance: 765.25, earned: 12, lifetimeEarned: 120, invUsed: 30, invFree: 6, invTotal: 36, botPosition: { x: 4, y: 5, z: 6 }, spawnerCount: 1, recordedAt: Date.now() }
        ],
        spawners: [{ bot: 'TestBotA', spawnerNumber: 1, earned: 10, ratePerHour: 120.5, balanceBefore: 0, balanceAfter: 10, calculationStatus: 'calculated', recordedAt: Date.now() }],
        generatedAt: new Date().toISOString(),
        secret: secret
      })
    }
  })
  Logger.log(result.getContent())
  return result.getContent()
}
