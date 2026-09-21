'use strict'

// ── The removed / permanently-banned list ───────────────────────────────────
// A permanent ban means the account is gone, so the bot should leave the roster
// instead of being retried forever. That fact has to outlive the process and has
// to be independent of `.env` — the bot cannot edit BOT_NAMES for you — so it
// lives in its own JSON file next to the data file, saved atomically exactly like
// data-store and cron state (a half-written file would lose the list).
//
// Entries look like:
//   { bot, kind, reason, caseId, addedAt, addedBy, count }
// and are matched case-insensitively, because a name arrives from `.env`, from a
// kick message, and from whatever somebody types at the console.

const fs = require('fs')
const path = require('path')

function emptyList () {
  return { version: 1, updatedAt: null, bots: [] }
}

function normalizeEntry (entry) {
  if (!entry || typeof entry !== 'object') return null
  const bot = String(entry.bot || '').trim()
  if (!bot) return null
  return {
    bot,
    kind: String(entry.kind || 'permanent'),
    reason: String(entry.reason || ''),
    caseId: String(entry.caseId || ''),
    addedAt: Number(entry.addedAt) || 0,
    addedBy: String(entry.addedBy || ''),
    count: Number(entry.count) || 1
  }
}

// Never throws: a missing or corrupt file simply means "nothing removed yet".
// Losing this file must not stop the bots from starting.
function loadRemovedBots (file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const list = Array.isArray(parsed) ? parsed : parsed && parsed.bots
    return {
      version: 1,
      updatedAt: (parsed && parsed.updatedAt) || null,
      bots: (Array.isArray(list) ? list : []).map(normalizeEntry).filter(Boolean)
    }
  } catch (_) {
    return emptyList()
  }
}

function saveRemovedBots (file, list) {
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    bots: (list && list.bots ? list.bots : []).map(normalizeEntry).filter(Boolean)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n')
  fs.renameSync(tmp, file)
  return payload
}

function findRemovedBot (list, bot) {
  const needle = String(bot || '').trim().toLowerCase()
  if (!needle) return null
  return (list && list.bots ? list.bots : []).find(entry => entry.bot.toLowerCase() === needle) || null
}

function isRemovedBot (list, bot) {
  return Boolean(findRemovedBot(list, bot))
}

// Upsert: re-adding an existing bot refreshes the reason but keeps the original
// addedAt, so the list shows when the bot was first removed.
function addRemovedBot (list, entry, { addedBy = 'auto' } = {}) {
  if (!list.bots) list.bots = []
  const normalized = normalizeEntry({ ...entry, addedAt: Date.now(), addedBy })
  if (!normalized) return { added: false, entry: null, list }
  const existing = findRemovedBot(list, normalized.bot)
  if (existing) {
    existing.kind = normalized.kind
    if (normalized.reason) existing.reason = normalized.reason
    if (normalized.caseId) existing.caseId = normalized.caseId
    existing.count = (existing.count || 1) + 1
    return { added: false, entry: existing, list }
  }
  list.bots.push(normalized)
  return { added: true, entry: normalized, list }
}

function removeRemovedBot (list, bot) {
  if (!list.bots) return null
  const needle = String(bot || '').trim().toLowerCase()
  const index = list.bots.findIndex(entry => entry.bot.toLowerCase() === needle)
  if (index === -1) return null
  return list.bots.splice(index, 1)[0]
}

// One line for the console and the Discord embed.
function describeRemovedBot (entry) {
  if (!entry) return ''
  const parts = [entry.kind || 'permanent']
  if (entry.reason) parts.push(entry.reason)
  if (entry.caseId) parts.push(`case ${entry.caseId}`)
  if (entry.addedBy) parts.push(`added by ${entry.addedBy}`)
  return parts.join(' · ')
}

module.exports = {
  emptyList,
  loadRemovedBots,
  saveRemovedBots,
  findRemovedBot,
  isRemovedBot,
  addRemovedBot,
  removeRemovedBot,
  describeRemovedBot
}
