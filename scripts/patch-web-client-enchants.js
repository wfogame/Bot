'use strict'
// ── Fix block breaking + build memory in the self-hosted Minecraft web client ──
// This script runs inside scripts/build-web-client.sh right after `pnpm i` and
// before `pnpm run build`, and applies source patches to the upstream client
// (zardoy/minecraft-web-client, pinned to the latest release tag):
//
// 1. prismarine-item (block breaking): the `enchants` getter returns the RAW
//    1.20.5+ component object ({ enchantments: [{ id, level }] }) instead of a
//    flat array — and throws on versions it does not recognize. mineflayer's
//    digTime then crashes with "(enchantments ?? []) is not iterable" while
//    spreading item.enchants, so the dig packet is never sent and blocks can
//    never be broken (holding an enchanted tool on a 1.20.5+ server
//    reproduces it 100%). The web client's inventory UI hits the same getter
//    and crashes on `.enchants.map(...)`.
//
// 2. scripts/makeOptimizedMcData.mjs (build memory): the build-time data prep
//    loads the minecraft-data corpus for EVERY supported MC version
//    (1.8 → 1.21.11) into memory at once — a fresh build peaks at ~2.3 GB RSS
//    (measured), which OOMs / swap-thrashes small machines. The patch makes it
//    load only the current 1.21.x generation by default (1.21 → latest, ~10
//    versions; fresh-build peak ~1.8 GB, also measured). Going stricter than
//    the 1.21.x range (e.g. 1.21.11 only) would BREAK connecting to other
//    server versions: when a version is absent from the blob the client
//    silently falls back to the base version's protocol data (restoreData in
//    src/optimizeJson.ts never throws). MIN_MC_VERSION / MAX_MC_VERSION
//    override the range. Patching the source (not just exporting env vars)
//    means even a manual `pnpm run build` inside web-client/src is clipped.
//
// 3. src/index.ts (Velocity /server transfers): the stock client has NO
//    handling for the 1.20.5+ clientbound Transfer packet, so Velocity
//    /server commands never complete and the server kicks the session with
//    "Internal Exception: io.netty..." (the web client simply ignores the
//    transfer and never reconnects). The patch listens for the transfer
//    packet and reconnects to the destination through the same proxy using
//    the client's own reconnectOptions mechanism.
//
// 4. src/resourcePack.ts (server resource pack downloads): the client
//    downloads packs with a plain fetch(url). GitHub URLs redirect
//    (github.com → codeload/raw) without CORS headers, which browsers refuse
//    to follow, so the download fails with "Failed to fetch". The patch falls
//    back to the same-origin /resource-pack-proxy endpoint served by
//    web-client.js (Node fetch has no CORS and follows redirects), which
//    streams the pack back.
//
// All patches are no-ops (idempotent) if already applied, and fail loudly if
// the upstream file layout changes so they can be re-baselined.
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

// ── Second patch: makeOptimizedMcData.mjs (build-time mc-data prep) ──
// Upstream defaults to loading the full corpus (every supported MC version,
// 1.8 → latest) into memory at once. Measured on fresh builds: peak RSS
// 2.3 GB (full corpus) vs 1.8 GB (1.21.x generation). Patch the source so ANY
// build invocation is clipped by default; MIN_MC_VERSION / MAX_MC_VERSION
// override the range. Anchor is the exact v2.3.0 snippet.
const CLIP_ANCHOR = `// Version clipping support
const minVersion = process.env.MIN_MC_VERSION
const maxVersion = process.env.MAX_MC_VERSION`

const CLIP_NEW = `// Version clipping support
const supportedVersionsList = Object.keys(versions)
// Default: only the current 1.21.x generation (1.21 -> latest, ~10 versions).
// Loading every supported version (1.8 -> latest, ~40) peaks at ~2.3 GB during
// a fresh build (measured) and OOMs small machines. A single version would
// break other server versions — the client silently falls back to the base
// version's protocol data when a version is absent from the blob (restoreData
// in src/optimizeJson.ts never throws). Set MIN_MC_VERSION / MAX_MC_VERSION
// to override, e.g. MIN_MC_VERSION=1.21.11 MAX_MC_VERSION=1.21.11 for a
// strictly single-version build.
const minVersion = process.env.MIN_MC_VERSION || '1.21'
const maxVersion = process.env.MAX_MC_VERSION || supportedVersionsList.at(-1)`

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

// Transform the content of makeOptimizedMcData.mjs so the mc-data prep loads
// only the latest supported MC version by default. Returns { changed, content }.
// Throws if the expected upstream snippet is absent (layout changed) or the
// file already looks patched in an unverifiable way.
function patchMakeOptimizedMcData (content) {
  if (content.includes('const supportedVersionsList = Object.keys(versions)')) {
    return { changed: false, content }
  }
  if (!content.includes(CLIP_ANCHOR)) {
    throw new Error('makeOptimizedMcData.mjs no longer contains the expected version-clipping anchor — update scripts/patch-web-client-enchants.js')
  }
  return { changed: true, content: content.replace(CLIP_ANCHOR, CLIP_NEW) }
}

// ── Third patch: src/index.ts — Velocity /server transfers ─────────────────
// Upstream has no handling for the 1.20.5+ clientbound Transfer packet, so
// Velocity /server transfers never complete and the server kicks the session
// with "Internal Exception: io.netty...". Listen for the transfer packet and
// reconnect to the destination through the same proxy (Velocity routes via
// the routing-token hostname in the re-login handshake), reusing the client's
// own reconnectOptions/reload mechanism.
const TRANSFER_ANCHOR = `  bot._client.on('state', playStateSwitch)

  bot.on('end', (endReason) => {`

const TRANSFER_HANDLER = `  bot._client.on('state', playStateSwitch)

  // Velocity /server transfers: the server sends the 1.20.5+ Transfer packet
  // and vanilla clients reconnect to the destination. The stock client ignores
  // it, so the transfer never completes and the server kicks the session with
  // "Internal Exception: io.netty...". Reconnect to the destination through
  // the same proxy — for Velocity networks the destination hostname carries
  // the routing token and the re-login handshake routes to the target server.
  bot._client.on('transfer' as any, (packet: any) => {
    console.log('Server requested transfer to', packet.host, packet.port)
    if (!packet || typeof packet.host !== 'string' || !packet.host) {
      console.warn('Ignoring transfer packet with no destination', packet)
      return
    }
    const prev = (globalThis as any).lastConnectOptions?.value
    let base = prev
    if (!base) {
      try { base = JSON.parse(localStorage.getItem('lastConnectOptions') || 'null') } catch (_) { base = null }
    }
    const value = { ...(base || {}), server: \`\${packet.host}\${packet.port ? ':' + packet.port : ''}\`, ignoreQs: true }
    sessionStorage.setItem('reconnectOptions', JSON.stringify({ value, timestamp: Date.now() }))
    location.reload()
  })

  bot.on('end', (endReason) => {`

function patchTransferSupport (content) {
  if (content.includes("bot._client.on('transfer' as any")) {
    return { changed: false, content }
  }
  if (!content.includes(TRANSFER_ANCHOR)) {
    throw new Error('web-client src/index.ts no longer contains the expected transfer anchor — update scripts/patch-web-client-enchants.js')
  }
  const out = content.replace(TRANSFER_ANCHOR, TRANSFER_HANDLER)
  if (out === content) {
    throw new Error('patchTransferSupport: anchor matched but replacement was a no-op')
  }
  return { changed: true, content: out }
}

// ── Fourth patch: src/resourcePack.ts — resource pack download CORS fallback ─
// The client downloads server packs with a plain fetch(url). GitHub URLs
// (github.com/.../raw/...) respond with a 302 whose redirect carries no
// Access-Control-Allow-Origin, so browsers refuse to follow it and the fetch
// dies with "Failed to fetch" (raw.githubusercontent.com works because it
// sends ACAO: *). The patch falls back to the same-origin /resource-pack-
// proxy endpoint served by web-client.js, which fetches server-side (no
// CORS, redirects followed) and streams the pack back.
const PACK_ANCHOR = `    const response = await fetch(url).catch((err) => {
      console.error(err)
      if (err.message === 'Failed to fetch') {
        err.message = \`Check internet connection and ensure server on \${url} support CORS which is not required for the vanilla client, but is required for the web client.\`
      }
      progressReporter.error('Failed to download resource pack: ' + err.message)
    })
    console.timeEnd('downloadServerResourcePack')
    if (!response) return`

const PACK_HANDLER = `    let response = await fetch(url).catch((err) => {
      console.error(err)
      return null
    })
    // GitHub URLs redirect without CORS headers (browsers refuse to follow),
    // so fall back to the same-origin proxy served by web-client.js, which
    // fetches server-side (no CORS) and streams the pack back.
    if (!response || !response.ok) {
      console.log('Direct resource pack fetch failed, falling back to same-origin proxy')
      response = await fetch(\`\${location.origin}/resource-pack-proxy?url=\${encodeURIComponent(url)}\`).catch((err) => {
        console.error(err)
        if (err.message === 'Failed to fetch') {
          err.message = \`Check internet connection and ensure server on \${url} support CORS which is not required for the vanilla client, but is required for the web client.\`
        }
        progressReporter.error('Failed to download resource pack: ' + err.message)
      })
    }
    console.timeEnd('downloadServerResourcePack')
    if (!response) return`

function patchResourcePackCors (content) {
  if (content.includes('/resource-pack-proxy?url=')) {
    return { changed: false, content }
  }
  if (!content.includes(PACK_ANCHOR)) {
    throw new Error('web-client src/resourcePack.ts no longer contains the expected fetch anchor — update scripts/patch-web-client-enchants.js')
  }
  const out = content.replace(PACK_ANCHOR, PACK_HANDLER)
  if (out === content) {
    throw new Error('patchResourcePackCors: anchor matched but replacement was a no-op')
  }
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
  // Resolve to an absolute path: the build script passes the src dir while its
  // own cwd is already inside it, so a relative arg would resolve one level
  // too deep ("web-client/src/web-client/src/...") and fail with ENOENT.
  const srcDir = path.resolve(argv[2] || path.resolve(__dirname, '..', 'web-client', 'src'))
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
  if (changed) {
    try {
      fs.writeFileSync(indexFile, out)
    } catch (err) {
      console.error(`✗ could not write ${indexFile}: ${err.message}`)
      process.exit(1)
    }
    console.log(`✓ patched ${path.relative(process.cwd(), indexFile)} — enchants normalized, block breaking fixed on 1.20.5+ servers`)
  } else {
    console.log(`✓ ${path.relative(process.cwd(), indexFile)} already patched`)
  }

  // Second patch: the build-time mc-data prep (upstream source file in the
  // cloned repo, not node_modules). Runs every time — both patches are
  // idempotent, so rebuilds just re-confirm them.
  const mcDataScript = path.join(srcDir, 'scripts', 'makeOptimizedMcData.mjs')
  let mcContent
  try {
    mcContent = fs.readFileSync(mcDataScript, 'utf8')
  } catch (err) {
    console.error(`✗ could not read ${mcDataScript}: ${err.message}`)
    process.exit(1)
  }
  const mcRes = patchMakeOptimizedMcData(mcContent)
  if (mcRes.changed) {
    try {
      fs.writeFileSync(mcDataScript, mcRes.content)
    } catch (err) {
      console.error(`✗ could not write ${mcDataScript}: ${err.message}`)
      process.exit(1)
    }
    console.log('✓ patched scripts/makeOptimizedMcData.mjs — mc-data prep now loads only the 1.21.x generation by default (override with MIN_MC_VERSION/MAX_MC_VERSION)')

  } else {
    console.log('✓ scripts/makeOptimizedMcData.mjs already patched')
  }

  // Third patch: src/index.ts — Velocity /server transfers. Also idempotent,
  // so rebuilds just re-confirm it.
  const indexTs = path.join(srcDir, 'src', 'index.ts')
  let indexContent
  try {
    indexContent = fs.readFileSync(indexTs, 'utf8')
  } catch (err) {
    console.error(`✗ could not read ${indexTs}: ${err.message}`)
    process.exit(1)
  }
  const txRes = patchTransferSupport(indexContent)
  if (txRes.changed) {
    try {
      fs.writeFileSync(indexTs, txRes.content)
    } catch (err) {
      console.error(`✗ could not write ${indexTs}: ${err.message}`)
      process.exit(1)
    }
    console.log('✓ patched src/index.ts — Velocity /server transfers now reconnect to the destination')
  } else {
    console.log('✓ src/index.ts already patched (transfer support)')
  }

  // Fourth patch: src/resourcePack.ts — resource pack downloads fall back to
  // the same-origin proxy when the direct browser fetch fails (GitHub
  // redirects lack CORS headers). Also idempotent.
  const packTs = path.join(srcDir, 'src', 'resourcePack.ts')
  let packContent
  try {
    packContent = fs.readFileSync(packTs, 'utf8')
  } catch (err) {
    console.error(`✗ could not read ${packTs}: ${err.message}`)
    process.exit(1)
  }
  const packRes = patchResourcePackCors(packContent)
  if (packRes.changed) {
    try {
      fs.writeFileSync(packTs, packRes.content)
    } catch (err) {
      console.error(`✗ could not write ${packTs}: ${err.message}`)
      process.exit(1)
    }
    console.log('✓ patched src/resourcePack.ts — resource pack downloads fall back to the same-origin proxy when direct fetch fails (GitHub redirects)')
  } else {
    console.log('✓ src/resourcePack.ts already patched (resource pack proxy fallback)')
  }
}

if (require.main === module) main(process.argv)

module.exports = { mapEnchants, normalizeEnchants, patchItemsJs, patchMakeOptimizedMcData, patchTransferSupport, patchResourcePackCors, findPrismarineItem }