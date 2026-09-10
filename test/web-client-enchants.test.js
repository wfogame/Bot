'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { mapEnchants, normalizeEnchants, patchItemsJs, patchMakeOptimizedMcData, patchTransferSupport } = require(path.join(__dirname, '..', 'scripts', 'patch-web-client-enchants.js'))

// The browser client bundles prismarine-item 1.18.0, whose `enchants` getter
// returns the raw 1.20.5+ component object ({ enchantments: [{ id, level }] })
// instead of a flat array and throws on versions it doesn't know. mineflayer's
// digTime then crashes with "(enchantments ?? []) is not iterable" and the web
// client cannot break blocks on 1.20.5+ servers (this repo already patches the
// same class of bug for its own Node mineflayer — see mineflayer-digging.test.js).
// These tests lock down the build-time patches: (1) the getter normalization,
// and (2) the makeOptimizedMcData.mjs default-clip that stops the build from
// loading every supported MC version into memory (fresh-build peak RSS
// ~2.3 GB full corpus vs ~1.5 GB single latest version, measured).

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

// ── Second patch: makeOptimizedMcData.mjs default version clipping ─────────
// Upstream loads the corpus for EVERY supported MC version into memory at once
// (~2.3 GB fresh-build peak). The patch defaults to the current 1.21.x
// generation only (1.21 -> latest, ~10 versions; ~1.8 GB measured) — going
// stricter (a single version) would break connecting to other server versions,
// because restoreData silently falls back to the base version's data when a
// version is absent (it never throws).
const UPSTREAM_PREP_SAMPLE = `let versions = {}
for (const [version, dataSet] of Object.entries(dataPaths.pc)) {
  if (!supportedVersions.includes(version)) continue
  versions[version] = dataSet
}
// Version clipping support
const minVersion = process.env.MIN_MC_VERSION
const maxVersion = process.env.MAX_MC_VERSION

if (minVersion || maxVersion) {
  // filter versions...
}
`

test('patchMakeOptimizedMcData defaults the clip to the 1.21.x generation', () => {
  const { changed, content } = patchMakeOptimizedMcData(UPSTREAM_PREP_SAMPLE)
  assert.equal(changed, true)
  assert.ok(content.includes('const supportedVersionsList = Object.keys(versions)'), 'declares the version list')
  // min defaults to the 1.21 generation floor, max to the latest supported
  // version — instead of both being undefined (full corpus).
  assert.match(content, /process\.env\.MIN_MC_VERSION \|\| '1\.21'/)
  assert.match(content, /process\.env\.MAX_MC_VERSION \|\| supportedVersionsList\.at\(-1\)/)
  assert.ok(!content.includes('const minVersion = process.env.MIN_MC_VERSION\nconst maxVersion'), 'bare env anchor replaced')
})

test('patchMakeOptimizedMcData is idempotent', () => {
  const once = patchMakeOptimizedMcData(UPSTREAM_PREP_SAMPLE)
  assert.equal(once.changed, true)
  const twice = patchMakeOptimizedMcData(once.content)
  assert.equal(twice.changed, false)
})

test('patchMakeOptimizedMcData fails loudly if the upstream layout changes', () => {
  const unknown = `const somethingElse = require('other')
module.exports = () => {}
`
  assert.throws(() => patchMakeOptimizedMcData(unknown), /no longer contains the expected version-clipping anchor/)
})

// ── Third patch: src/index.ts — Velocity /server transfers ────────────────
// The stock web client has no handling for the 1.20.5+ clientbound Transfer
// packet, so Velocity /server transfers never complete and the server kicks
// the session with "Internal Exception: io.netty...". The patch reconnects to
// the transfer destination through the same proxy using the client's own
// reconnectOptions/reload mechanism.
const TRANSFER_SAMPLE = `  bot._client.on('state', playStateSwitch)

  bot.on('end', (endReason) => {
`

test('patchTransferSupport inserts the transfer-reconnect handler', () => {
  const { changed, content } = patchTransferSupport(TRANSFER_SAMPLE)
  assert.equal(changed, true)
  assert.match(content, /bot\._client\.on\('transfer' as any/)
  assert.match(content, /Server requested transfer to/)
  assert.match(content, /reconnectOptions/)
  assert.match(content, /location\.reload\(\)/)
  assert.ok(content.includes("bot.on('end', (endReason) => {"), 'the end handler anchor stays intact')
})

test('patchTransferSupport is idempotent', () => {
  const once = patchTransferSupport(TRANSFER_SAMPLE)
  assert.equal(once.changed, true)
  const twice = patchTransferSupport(once.content)
  assert.equal(twice.changed, false)
})

test('patchTransferSupport fails loudly if the upstream layout changes', () => {
  assert.throws(() => patchTransferSupport('const somethingElse = 1\n'), /no longer contains the expected transfer anchor/)
})

// Simulate the filter math the patched prep uses: the defaults must keep the
// whole current 1.21.x generation (covers 1.21.2 / 1.21.4 servers) while
// dropping the old 1.8-1.20 versions that dominate the memory peak.
test('default clip keeps the 1.21.x generation and drops older versions (filter semantics)', () => {
  const versions = ['1.8', '1.9', '1.12.2', '1.16.5', '1.20.4', '1.21', '1.21.2', '1.21.4', '1.21.11']
  const versionToNumber = (ver) => {
    const [x, y = '0', z = '0'] = ver.split('.')
    return +`${x.padStart(2, '0')}${y.padStart(2, '0')}${z.padStart(2, '0')}`
  }
  const min = '1.21'
  const max = versions.at(-1) // what supportedVersionsList.at(-1) yields
  const kept = versions.filter((v) => versionToNumber(v) >= versionToNumber(min) && versionToNumber(v) <= versionToNumber(max))
  assert.deepEqual(kept, ['1.21', '1.21.2', '1.21.4', '1.21.11'])
  // And a deliberately narrow build (MIN=MAX=1.21.11) keeps exactly one.
  const single = versions.filter((v) => versionToNumber(v) >= versionToNumber('1.21.11') && versionToNumber(v) <= versionToNumber('1.21.11'))
  assert.deepEqual(single, ['1.21.11'])
})