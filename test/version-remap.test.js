'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const mp = require('minecraft-protocol')
const { resolveBotVersion } = require(path.join(__dirname, '..', 'lib', 'version-remap'))

// minecraft-data ships no 1.21.2 (protocol 768) dataset, and minecraft-protocol
// refuses the 768/767 mismatch, so '1.21.2' must never reach createBot as-is.
// It maps to 1.21.3 — ViaVersion / MCProtocolLib / golden_apple all treat
// 1.21.2 and 1.21.3 as the same wire protocol, and 1.21.3 (769) is the closest
// dataset carrying the 1.21.2-era item component registry.

test('resolveBotVersion maps 1.21.2 to 1.21.3 and leaves other versions alone', () => {
  assert.equal(resolveBotVersion('1.21.2'), '1.21.3')
  for (const v of ['1.21', '1.21.1', '1.21.3', '1.21.4', '1.21.11', '1.20.6', undefined, null, '']) {
    assert.equal(resolveBotVersion(v), v)
  }
})

// The wire-format proof. A 1.21.2 server sends item components in the
// 1.21.2-era registry, where component id 7 = `item_model` (a string). The
// 1.21/1.21.1 data maps id 7 to `lore` (an NBT array), so it misreads the
// string as NBT — the root cause of the /ah "Invalid tag: 111 > 20" crash.
function buildOneTwoTwoStyleWindowItems () {
  // Hand-rolled 1.21.2 (768) window_items (0x13):
  //   windowId=1, stateId=2, 1 item, carriedItem empty.
  //   Item: present, itemId=733, added=1, removed=0,
  //         component id 7 = item_model -> string "minecraft:diamond_sword"
  const model = 'minecraft:diamond_sword'
  const payload = [
    0x01,                 // windowId
    0x02,                 // stateId
    0x01,                 // item count
    0x01,                 // slot present
    0xDD, 0x05,           // itemId 733 (varint)
    0x01, 0x00,           // addedComponentCount=1, removedComponentCount=0
    0x07,                 // component type 7 → 1.21.2: item_model; 1.21.1 data: lore
    model.length, ...Buffer.from(model, 'ascii'),
    0x00                  // carriedItem empty
  ]
  return Buffer.concat([Buffer.from([0x13]), Buffer.from(payload)])
}

test('1.21.3 data parses 1.21.2-style items (item_model at id 7) correctly', async () => {
  const buf = buildOneTwoTwoStyleWindowItems()
  const packet = await new Promise((resolve, reject) => {
    const d = mp.createDeserializer({ state: 'play', isServer: false, version: '1.21.3' })
    d.on('error', reject)
    d.on('data', resolve)
    d.write(buf)
  })
  assert.equal(packet.data.name, 'window_items')
  const item = packet.data.params.items[0]
  assert.equal(item.components[0].type, 'item_model')
  assert.equal(item.components[0].data, 'minecraft:diamond_sword')
})

test('1.21 data misreads 1.21.2-style items as lore (the crash this remap prevents)', async () => {
  const buf = buildOneTwoTwoStyleWindowItems()
  const packet = await new Promise((resolve, reject) => {
    const d = mp.createDeserializer({ state: 'play', isServer: false, version: '1.21' })
    d.on('error', reject)
    d.on('data', resolve)
    d.write(buf)
  })
  const item = packet.data.params.items[0]
  // 767 data has no item_model — id 7 is `lore`, so the model string is read as NBT.
  assert.notEqual(item.components[0].type, 'item_model')
  assert.equal(item.components[0].type, 'lore')
})