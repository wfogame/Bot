'use strict'
// ── Fix block breaking in the self-hosted Minecraft web client ──────────────
// The browser client (zardoy/minecraft-web-client) bundles prismarine-item,
// whose `enchants` getter returns the RAW 1.20.5+ component object
// ({ enchantments: [{ id, level }] }) instead of a flat array — and throws on
// versions it does not recognize. mineflayer's digTime then crashes with
// "(enchantments ?? []) is not iterable" while spreading item.enchants, so the
// dig packet is never sent and blocks can never be broken (holding an
// enchanted tool on a 1.20.5+ server reproduces it 100%). The web client's
// inventory UI hits the same getter and crashes on `.enchants.map(...)`.
//
// This script runs inside scripts/build-web-client.sh right after `pnpm i` and
// before `pnpm run build`, patching the installed prismarine-item so the
// getter always returns the classic [{ name, lvl }] array and never throws.
// It is a no-op (idempotent) if the patch is already applied, and fails loudly
// if the upstream file layout changes so the fix can be re-baselined.
//
// Usage: node scripts/patch-web-client-enchants.js [web-client/src-dir]
//   (defaults to <repo root>/web-client/src — what build-web-client.sh passes)
//
// Covered by test/web-client-enchants.test.js.
const fs = require('fs')
const path = require('path')

// Normalize one enchant entry to the classic { name, lvl } shape.
// Component entries arrive as { id: 'minecraft:efficiency', level: 3 } (or
// { id: <numeric>, level } on some versions); legacy NBT entries are already
// { name, lvl }. Prefer the string id (minus the minecraft: prefix), mirroring
// prismarine-item's own legacy normalization.
function mapEnchants (list) {
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object') return null
    let name = entry.name
    if (name == null && entry.id != null) {
      name = typeof entry.id === 'string' ? entry.id.replace(/^minecraft:/, '') : null
    }
    return { name: name ?? null, lvl: entry.lvl ?? entry.level ?? 1 }
  }).filter(Boolean)
}

// Accepts either a flat array, the 1.20.5+ component object
// ({ enchantments: [...] }), or a stored_enchantments variant, and always
// returns a plain [{ name, lvl }] array.
function normalizeEnchants (data) {
  if (Array.isArray(data)) return mapEnchants(data)
  if (!data || typeof data !== 'object') return []
  const list = data.enchantments ?? data.stored_enchantments
  return Array.isArray(list) ? mapEnchants(list) : []
}

// ── Exact upstream snippets (prismarine-item 1.18.0, the version the web
// client's pnpm-lock.yaml resolves). Any mismatch means the upstream layout
// changed and the patch must be re-baselined, so we fail loudly. ──
const HEAD_ANCHOR = "const nbt = require('prismarine-nbt')"

const COMPONENT_BRANCH_OLD = `      if (this.componentMap?.has('enchantments')) {
        return this.componentMap.get('enchantments').data
      }`

const COMPONENT_BRANCH_NEW = `      if (this.componentMap?.has('enchantments')) {
        // 1.20.5+ deserializes the enchantments component as an object
        // ({ enchantments: [{ id, level }] }) instead of an array. Normalize to
        // a flat [{ name, lvl }] array — otherwise mineflayer's digTime
        // crashes ("(enchantments ?? []) is not iterable") and blocks can
        // never be broken (see scripts/patch-web-client-enchants.js).
        return normalizeEnchants(this.componentMap.get('enchantments').data)
      }`

const THROW_OLD = `      throw new Error("Don't know how to get the enchants from an item on this mc version")`

const THROW_NEW = `      // Never throw: an unenchanted item on a version this path does not
      // recognize used to crash every digTime call — and with it, digging.
      return []`

const HELPER_BLOCK = `const nbt = require('prismarine-nbt')

// 1.20.5+ deserializes the enchantments item component as an object
// ({ enchantments: [{ id, level }] }) instead of the classic [{ name, lvl }]
// array, and the legacy NBT branch throws on versions it does not know.
// Normalize to [{ name, lvl }] and never throw, otherwise mineflayer's
// digTime crashes ("(enchantments ?? []) is not iterable") and the web client
// cannot break blocks on 1.20.5+ servers. See test/web-client-enchants.test.js.
function normalizeEnchants (data) {
  if (Array.isArray(data)) return mapEnchants(data)
  if (!data || typeof data !== 'object') return []
  const list = data.enchantments ?? data.stored_enchantments
  return Array.isArray(list) ? mapEnchants(list) : []
}

function mapEnchants (list) {
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object') return null
    let name = entry.name
    if (name == null && entry.id != null) {
      name = typeof entry.id === 'string' ? entry.id.replace(/^minecraft:/, '') : null
    }
    return { name: name ?? null, lvl: entry.lvl ?? entry.level ?? 1 }
  }).filter(Boolean)
}
`

// Transform the content of prismarine-item's index.js. Returns
// { changed, content }. Throws if the expected upstream snippets are absent
// (upstream layout changed) or if the file looks already patched in a way we
// can't verify.
function patchItemsJs (content) {
  if (content.includes('function normalizeEnchants (data)') && content.includes('normalizeEnchants(this.componentMap')) {
    return { changed: false, content }
  }
  if (!content.includes(HEAD_ANCHOR)) {
    throw new Error('prismarine-item index.js does not start with the expected require — refusing to patch an unknown layout')
  }
  if (!content.includes(COMPONENT_BRANCH_OLD)) {
    throw new Error('prismarine-item index.js no longer contains the expected componentMap branch — update scripts/patch-web-client-enchants.js')
  }
  if (!content.includes(THROW_OLD)) {
    throw new Error('prismarine-item index.js no longer contains the expected fallback throw — update scripts/patch-web-client-enchants.js')
  }
  let out = content
  out = out.replace(HEAD_ANCHOR, HELPER_BLOCK.replace(/^\n/, '')) // insert helpers after the nbt require
  out = out.replace(COMPONENT_BRANCH_OLD, COMPONENT_BRANCH_NEW)
  out = out.replace(THROW_OLD, THROW_NEW)
  return { changed: true, content: out }
}

// Locate the installed prismarine-item under the web client source dir
// (pnpm: usually a root symlink; falls back to a .pnpm store scan).
function findPrismarineItem (srcDir) {
  try {
    const pkgJson = require.resolve('prismarine-item/package.json', { paths: [srcDir] })
    return path.join(path.dirname(pkgJson), 'index.js')
  } catch (_) {}
  const direct = path.join(srcDir, 'node_modules', 'prismarine-item', 'index.js')
  if (fs.existsSync(direct)) return direct
  const pnpmDir = path.join(srcDir, 'node_modules', '.pnpm')
  if (fs.existsSync(pnpmDir)) {
    const dirs = fs.readdirSync(pnpmDir).filter((d) => d.startsWith('prismarine-item@')).sort()
    for (const d of dirs.reverse()) {
      const candidate = path.join(pnpmDir, d, 'node_modules', 'prismarine-item', 'index.js')
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

function main (argv) {
  const srcDir = argv[2] || path.resolve(__dirname, '..', 'web-client', 'src')
  const indexFile = findPrismarineItem(srcDir)
  if (!indexFile) {
    console.error(`✗ prismarine-item not found under ${srcDir} — did "pnpm i" run inside the web client source?`)
    process.exit(1)
  }
  let content
  try {
    content = fs.readFileSync(indexFile, 'utf8')
  } catch (err) {
    console.error(`✗ could not read ${indexFile}: ${err.message}`)
    process.exit(1)
  }
  const { changed, content: out } = patchItemsJs(content)
  if (!changed) {
    console.log(`✓ ${path.relative(process.cwd(), indexFile)} already patched`)
    return
  }
  try {
    fs.writeFileSync(indexFile, out)
  } catch (err) {
    console.error(`✗ could not write ${indexFile}: ${err.message}`)
    process.exit(1)
  }
  console.log(`✓ patched ${path.relative(process.cwd(), indexFile)} — enchants normalized, block breaking fixed on 1.20.5+ servers`)
}

if (require.main === module) main(process.argv)

module.exports = { mapEnchants, normalizeEnchants, patchItemsJs, findPrismarineItem }