'use strict'

// ── Minecraft version normalization ─────────────────────────────────────────
//
// minecraft-data ships NO 1.21.2 (protocol 768) dataset — upstream merged
// 1.21.2 into 1.21/1.21.1 (767) data, and minecraft-protocol's createClient
// silently downgrades '1.21.2' to that 767 dataset (its own version table
// still knows 1.21.2 = 768, which is why createDeserializer('1.21.2') throws).
//
// That matters more than it sounds: 1.21.2 ADDED the item components
// `minecraft:item_model`, `minecraft:enchantable`, `minecraft:repairable`
// etc. to the component registry and REORDERED existing ones (item_model is
// id 7 in 1.21.2+, while 1.21/1.21.1 data maps id 7 to `lore`). So the 767
// data misparses 1.21.2 items: a 1.21.2 server's plugin-written GUI items
// (e.g. the /ah auction-house window) come in the 1.21.2 registry, and the
// 767 parser reads `item_model`'s string payload as a `lore` NBT array →
// "Invalid tag: 111 > 20" → the bot crashes and auto-reconnects.
//
// ViaVersion / MCProtocolLib / golden_apple all treat 1.21.2 and 1.21.3 as
// the SAME wire protocol (768), so the closest dataset with the correct
// 1.21.2-era component registry is 1.21.3 (769). Map '1.21.2' → '1.21.3'
// unless VERSION_1_21_2_MAP overrides it (set to '1.21' to restore the old
// silent-downgrade behavior, or '1.21.4' if a server rejects 1.21.3).
const VERSION_1_21_2_MAP = process.env.VERSION_1_21_2_MAP || '1.21.3'

function resolveBotVersion (version) {
  if (version === '1.21.2') return VERSION_1_21_2_MAP
  return version
}

module.exports = { resolveBotVersion, VERSION_1_21_2_MAP }