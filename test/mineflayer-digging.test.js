'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const injectDigging = require(path.join(__dirname, '..', 'node_modules', 'mineflayer', 'lib', 'plugins', 'digging.js'))
const registry = require('minecraft-data')('1.21.2')

// Regression tests for the patched mineflayer digging plugin. On 1.20.5+ the
// `enchants` getter returns the raw component object ({ enchantments: [{ id,
// level }] }) instead of an array, and it THROWS on versions it does not
// understand (e.g. an unenchanted item on 1.21.x). mineflayer's digTime used
// to crash with "enchantments.concat is not a function" — the patch normalizes
// to [{ name, lvl }] and never throws.
function makeBot (heldItem) {
  const calls = []
  const block = {
    digTime: (...args) => { calls.push(args); return 123 }
  }
  const bot = {
    heldItem,
    inventory: { slots: [] },
    game: { gameMode: 'survival' },
    registry,
    entity: { position: { offset: () => null } },
    blockAt: () => null,
    getEquipmentDestSlot: () => 5,
    on: () => {},
    digTime: null
  }
  injectDigging(bot)
  const time = bot.digTime(block)
  return { bot, block, calls, time }
}

test('digTime normalizes the 1.20.5+ component shape to [{ name, lvl }]', () => {
  // { enchantments: [{ id, level }] } is exactly what the 1.21.x protocol
  // deserializer puts into item.componentMap for the enchantments component.
  const heldItem = { type: 9, enchants: { enchantments: [{ id: 8, level: 3 }] } }
  const { calls, time } = makeBot(heldItem)
  assert.equal(time, 123)
  assert.deepEqual(calls[0][4], [{ name: 'efficiency', lvl: 3 }])
})

test('digTime survives a throwing enchants getter (unenchanted item on 1.21.x)', () => {
  const heldItem = {
    type: 9,
    get enchants () {
      throw new Error("Don't know how to get the enchants from an item on this mc version")
    }
  }
  const { calls, time } = makeBot(heldItem)
  assert.equal(time, 123)
  assert.deepEqual(calls[0][4], [])
})

test('digTime still handles the classic array shape and concats helmet enchants', () => {
  const heldItem = { type: 9, enchants: [{ name: 'efficiency', lvl: 5 }] }
  const { bot, calls, time } = makeBot(heldItem)
  // Helmet with Aqua Affinity — the concat path that used to crash.
  bot.inventory.slots[5] = { type: 7, enchants: [{ name: 'aqua_affinity', lvl: 1 }] }
  const helmetTime = bot.digTime({ digTime: (...args) => { calls.push(args); return 456 } })
  assert.equal(helmetTime, 456)
  const last = calls[calls.length - 1][4]
  assert.deepEqual(last, [
    { name: 'efficiency', lvl: 5 },
    { name: 'aqua_affinity', lvl: 1 }
  ])
})