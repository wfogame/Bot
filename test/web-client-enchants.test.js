'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { mapEnchants, normalizeEnchants, patchItemsJs } = require(path.join(__dirname, '..', 'scripts', 'patch-web-client-enchants.js'))

// The browser client bundles prismarine-item 1.18.0, whose `enchants` getter
// returns the raw 1.20.5+ component object ({ enchantments: [{ id, level }] })
// instead of a flat array and throws on versions it doesn't know. mineflayer's
// digTime then crashes with "(enchantments ?? []) is not iterable" and the web
// client cannot break blocks on 1.20.5+ servers (this repo already patches the
// same class of bug for its own Node mineflayer — see mineflayer-digging.test.js).
// These tests lock down the build-time patch that normalizes the getter.

test('mapEnchants normalizes component entries to { name, lvl }', () => {
  assert.deepEqual(
    mapEnchants([{ id: 'minecraft:efficiency', level: 3 }]),
    [{ name: 'efficiency', lvl: 3 }]
  )
  // Legacy NBT entries already carry { name, lvl }.
  assert.deepEqual(mapEnchants([{ name: 'efficiency', lvl: 3 }]), [{ name: 'efficiency', lvl: 3 }])
  // Numeric ids keep name null (matches prismarine-item's legacy behavior).
  assert.deepEqual(mapEnchants([{ id: 8, level: 1 }]), [{ name: null, lvl: 1 }])
  // Garbage entries are dropped instead of crashing.
  assert.deepEqual(mapEnchants([null, undefined, 'x']), [])
})

test('normalizeEnchants handles array, component object, and junk shapes', () => {
  assert.deepEqual(normalizeEnchants([{ id: 'minecraft:efficiency', level: 3 }]), [{ name: 'efficiency', lvl: 3 }])
  assert.deepEqual(
    normalizeEnchants({ enchantments: [{ id: 'minecraft:efficiency', level: 3 }] }),
    [{ name: 'efficiency', lvl: 3 }]
  )
  assert.deepEqual(normalizeEnchants(null), [])
  assert.deepEqual(normalizeEnchants(undefined), [])
  assert.deepEqual(normalizeEnchants({}), [])
})

test('patchItemsJs replaces the componentMap branch and the throwing fallback', () => {
  const original = `const nbt = require('prismarine-nbt')
function loader (registryOrVersion) {
  class Item {
    get enchants () {
      if (this.componentMap?.has('enchantments')) {
        return this.componentMap.get('enchantments').data
      }
      throw new Error("Don't know how to get the enchants from an item on this mc version")
    }
  }
}
`
  const { changed, content } = patchItemsJs(original)
  assert.equal(changed, true)
  assert.match(content, /normalizeEnchants\(this\.componentMap\.get\('enchantments'\)\.data\)/)
  assert.ok(!content.includes("Don't know how to get the enchants"))
  assert.match(content, /function normalizeEnchants \(data\)/)
})

test('patchItemsJs is idempotent', () => {
  const original = `const nbt = require('prismarine-nbt')
function loader (registryOrVersion) {
  class Item {
    get enchants () {
      if (this.componentMap?.has('enchantments')) {
        return this.componentMap.get('enchantments').data
      }
      throw new Error("Don't know how to get the enchants from an item on this mc version")
    }
  }
}
`
  const once = patchItemsJs(original)
  assert.equal(once.changed, true)
  const twice = patchItemsJs(once.content)
  assert.equal(twice.changed, false)
})

test('patchItemsJs fails loudly if the upstream layout changes', () => {
  const unknown = `const somethingElse = require('other')
module.exports = () => {}
`
  assert.throws(() => patchItemsJs(unknown), /refusing to patch an unknown layout/)
})

// Mirror of the exact crash this patch prevents: the mineflayer fork's digTime
// spreads item.enchants, so a non-iterable getter result must never be produced
// for the 1.20.5+ component shape.
test('normalized enchants are spreadable (the digTime crash regression)', () => {
  const enchants = normalizeEnchants({ enchantments: [{ id: 'minecraft:efficiency', level: 3 }] })
  assert.doesNotThrow(() => { return [...enchants, ...[]] })
  assert.deepEqual([...enchants, ...[]], [{ name: 'efficiency', lvl: 3 }])
})