'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const removed = require('../removed-bots')

function tempFile () {
  return path.join(os.tmpdir(), `removed-bots-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
}

// A missing file means "nothing removed yet" — it must never stop startup.
test('loading a missing or corrupt file yields an empty list', () => {
  const file = tempFile()
  assert.deepEqual(removed.loadRemovedBots(file).bots, [])

  fs.writeFileSync(file, '{not json')
  assert.deepEqual(removed.loadRemovedBots(file).bots, [], 'a corrupt file must not throw')

  fs.writeFileSync(file, JSON.stringify({ bots: [{ bot: '' }, { nope: 1 }, 'nonsense', { bot: 'Kept' }] }))
  assert.deepEqual(removed.loadRemovedBots(file).bots.map(entry => entry.bot), ['Kept'], 'junk entries are dropped')

  fs.unlinkSync(file)
})

test('adding a bot persists it and reads back with its reason', () => {
  const file = tempFile()
  const list = removed.emptyList()
  const result = removed.addRemovedBot(list, { bot: 'Hypr_7_core', kind: 'permanent', reason: 'cheating', caseId: '4411' })
  assert.equal(result.added, true)
  assert.equal(result.entry.addedBy, 'auto')
  assert.ok(result.entry.addedAt > 0)
  removed.saveRemovedBots(file, list)

  const reloaded = removed.loadRemovedBots(file)
  fs.unlinkSync(file)
  assert.equal(reloaded.bots.length, 1)
  assert.equal(reloaded.bots[0].bot, 'Hypr_7_core')
  assert.equal(reloaded.bots[0].reason, 'cheating')
  assert.equal(reloaded.bots[0].caseId, '4411')
  assert.equal(reloaded.bots[0].kind, 'permanent')
})

// Names come from .env, from a kick message, and from a typed command, so casing
// must not decide whether a bot is skipped.
test('lookups are case-insensitive', () => {
  const list = removed.emptyList()
  removed.addRemovedBot(list, { bot: 'Hypr_7_Core' })
  assert.equal(removed.isRemovedBot(list, 'hypr_7_core'), true)
  assert.equal(removed.isRemovedBot(list, 'HYPR_7_CORE'), true)
  assert.equal(removed.isRemovedBot(list, ' hypr_7_core '), true)
  assert.equal(removed.isRemovedBot(list, 'hypr_7_alt'), false)
  assert.equal(removed.isRemovedBot(list, ''), false)
  assert.equal(removed.isRemovedBot(list, null), false)
})

test('re-adding a bot refreshes the reason but keeps when it was first removed', () => {
  const list = removed.emptyList()
  const first = removed.addRemovedBot(list, { bot: 'A', kind: 'permanent', reason: 'cheating' }, { addedBy: 'ban-detection' })
  const firstAt = first.entry.addedAt
  const again = removed.addRemovedBot(list, { bot: 'a', kind: 'blacklist', reason: 'alt farming' }, { addedBy: 'manual' })
  assert.equal(list.bots.length, 1, 'no duplicate row')
  assert.equal(again.added, false)
  assert.equal(again.entry.addedAt, firstAt)
  assert.equal(again.entry.kind, 'blacklist')
  assert.equal(again.entry.reason, 'alt farming')
  assert.equal(again.entry.count, 2, 'repeat removals stay visible')
})

test('a bot can be taken back off the list', () => {
  const list = removed.emptyList()
  removed.addRemovedBot(list, { bot: 'Hypr_7_core', reason: 'mistake' })
  const removedEntry = removed.removeRemovedBot(list, 'HYPR_7_CORE')
  assert.equal(removedEntry.bot, 'Hypr_7_core')
  assert.equal(removed.isRemovedBot(list, 'Hypr_7_core'), false)
  assert.equal(removed.removeRemovedBot(list, 'Hypr_7_core'), null, 'removing twice is harmless')
})

test('addRemovedBot refuses an entry with no bot name', () => {
  const list = removed.emptyList()
  assert.equal(removed.addRemovedBot(list, {}).added, false)
  assert.equal(list.bots.length, 0)
})

// The whole point of the file: a restart must still skip the bot, and losing the
// file must not lose the ability to start.
test('the list survives a save/load round trip', () => {
  const file = tempFile()
  const list = removed.emptyList()
  removed.addRemovedBot(list, { bot: 'Gone1', kind: 'blacklist', reason: 'network ban', caseId: '9' })
  removed.addRemovedBot(list, { bot: 'Gone2', kind: 'permanent', reason: 'cheating' })
  removed.saveRemovedBots(file, list)

  const reloaded = removed.loadRemovedBots(file)
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.unlinkSync(file)

  assert.equal(payload.version, 1)
  assert.ok(payload.updatedAt, 'the file records when it changed')
  assert.equal(reloaded.bots.length, 2)
  assert.equal(removed.isRemovedBot(reloaded, 'gone1'), true, 'a restart still skips it')
  assert.equal(removed.isRemovedBot(reloaded, 'Gone2'), true)
})

test('describeRemovedBot summarises an entry for the console', () => {
  const list = removed.emptyList()
  const { entry } = removed.addRemovedBot(list, { bot: 'A', kind: 'permanent', reason: 'cheating', caseId: '4411' }, { addedBy: 'ban-detection' })
  const text = removed.describeRemovedBot(entry)
  assert.match(text, /permanent/)
  assert.match(text, /cheating/)
  assert.match(text, /case 4411/)
  assert.match(text, /ban-detection/)
  assert.equal(removed.describeRemovedBot(null), '')
})
