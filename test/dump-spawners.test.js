'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

// Test isSpawnerItem logic independently
function isSpawnerItem (item) {
  if (!item) return false
  if (/spawner/i.test(item.name || '') || /spawner/i.test(item.displayName || '')) return true

  if (item.customName && /spawner/i.test(String(item.customName))) return true

  try {
    const lore = item.customLore
    if (lore) {
      const loreStr = typeof lore === 'string' ? lore : JSON.stringify(lore)
      if (/spawner/i.test(loreStr)) return true
    }
  } catch (_) {}

  if (item.componentMap && typeof item.componentMap.forEach === 'function') {
    let matched = false
    item.componentMap.forEach((comp) => {
      if (matched) return
      try {
        const compStr = JSON.stringify(comp)
        if (/spawner/i.test(compStr)) matched = true
      } catch (_) {}
    })
    if (matched) return true
  }

  if (Array.isArray(item.components)) {
    try {
      if (/spawner/i.test(JSON.stringify(item.components))) return true
    } catch (_) {}
  }

  if (item.nbt) {
    try {
      if (/spawner/i.test(JSON.stringify(item.nbt))) return true
    } catch (_) {}
  }

  return false
}

test('isSpawnerItem recognizes vanilla and custom spawners', () => {
  // Vanilla spawner block
  assert.equal(isSpawnerItem({ name: 'spawner', displayName: 'Spawner' }), true)
  assert.equal(isSpawnerItem({ name: 'mob_spawner', displayName: 'Monster Spawner' }), true)

  // Custom named spawners (Iron Golem, Enderman)
  assert.equal(isSpawnerItem({ name: 'spawner', customName: '§6Iron Golem Spawner' }), true)
  assert.equal(isSpawnerItem({ name: 'spawner', customName: 'Enderman Spawner' }), true)

  // Modern 1.20.5+ item_name component
  const compItemName = {
    name: 'player_head',
    componentMap: new Map([
      ['item_name', { data: 'Iron Golem Spawner' }]
    ])
  }
  assert.equal(isSpawnerItem(compItemName), true)

  // Modern 1.20.5+ custom_name component
  const compCustomName = {
    name: 'spawner',
    componentMap: new Map([
      ['custom_name', { data: { text: 'Enderman Spawner' } }]
    ])
  }
  assert.equal(isSpawnerItem(compCustomName), true)

  // Lore containing spawner
  const compLore = {
    name: 'custom_block',
    customLore: ['§7Right-click to place', '§bTier 3 Spawner']
  }
  assert.equal(isSpawnerItem(compLore), true)

  // BlockEntityData containing mob_spawner
  const compBlockEntity = {
    name: 'skull',
    componentMap: new Map([
      ['block_entity_data', { data: { id: 'minecraft:mob_spawner', SpawnData: { entity: { id: 'minecraft:iron_golem' } } } }]
    ])
  }
  assert.equal(isSpawnerItem(compBlockEntity), true)

  // Non-spawners must return false
  assert.equal(isSpawnerItem(null), false)
  assert.equal(isSpawnerItem({ name: 'diamond_sword', displayName: 'Diamond Sword' }), false)
  assert.equal(isSpawnerItem({ name: 'stone', displayName: 'Stone' }), false)
  assert.equal(isSpawnerItem({ name: 'iron_ingot', customName: 'Iron Ingot' }), false)
})

test('shift-clicking transfers only spawners and halts when chest is full', async () => {
  // Mock chest container with 27 chest slots and 36 player inventory slots (indices 27..62)
  const clickedSlots = []
  const mockContainer = {
    inventoryStart: 27,
    inventoryEnd: 63,
    slots: new Array(63).fill(null),
    close: async () => {}
  }

  // Place items in player inventory
  // Slot 27: Iron Golem Spawner (x5)
  // Slot 28: Diamond Sword (x1) - not a spawner
  // Slot 29: Enderman Spawner (x2)
  // Slot 30: Zombie Spawner (x1) - will simulate chest full on this one
  mockContainer.slots[27] = { slot: 27, name: 'spawner', count: 5, customName: 'Iron Golem Spawner' }
  mockContainer.slots[28] = { slot: 28, name: 'diamond_sword', count: 1 }
  mockContainer.slots[29] = { slot: 29, name: 'spawner', count: 2, customName: 'Enderman Spawner' }
  mockContainer.slots[30] = { slot: 30, name: 'spawner', count: 1, customName: 'Zombie Spawner' }

  const mockBot = {
    clickWindow: async (slot, btn, mode) => {
      clickedSlots.push({ slot, btn, mode })
      // Simulate shift-click move for slots 27 and 29
      if (slot === 27 || slot === 29) {
        mockContainer.slots[slot] = null
      }
      // Slot 30 is NOT modified, simulating a full chest rejecting the transfer
    }
  }

  // Run the dump loop logic
  let chestFull = false
  for (let s = mockContainer.inventoryStart; s < mockContainer.inventoryEnd; s++) {
    const item = mockContainer.slots[s]
    if (!item) continue
    if (!isSpawnerItem(item)) continue

    const initialCount = item.count
    await mockBot.clickWindow(s, 0, 1)

    const afterItem = mockContainer.slots[s]
    if (afterItem && afterItem.count === initialCount) {
      chestFull = true
      break
    }
  }

  assert.equal(clickedSlots.length, 3)
  assert.equal(clickedSlots[0].slot, 27)
  assert.equal(clickedSlots[0].mode, 1)
  assert.equal(clickedSlots[1].slot, 29)
  assert.equal(clickedSlots[1].mode, 1)
  assert.equal(clickedSlots[2].slot, 30)
  assert.equal(chestFull, true)
  assert.equal(mockContainer.slots[28].name, 'diamond_sword') // sword untouched
  assert.equal(mockContainer.slots[30].count, 1) // zombie spawner left in inv
})
