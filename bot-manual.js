'use strict'
// ── Manual interact mode engine (loaded by bot.js) ────────────────────────────
// /manual-interact gives one bot a slow, hand-driven avatar:
//   • a browser 3D view (prismarine-viewer) streams the bot's world and turns
//     clicks in the view into dig / place / open-container actions,
//   • the dashboard gets a hold-to-move pad + hotbar over a tiny 'key' channel,
//   • commands (/walk, /drop, /pickup, /dig, /place, /window-*, /gui…) give the same
//     manual control from the TUI.
// While manual mode is ON for a bot, bot.js suppresses its automatic
// windowOpen click-slot + AFK-warp handler for that bot.

const net = require('net')
const { Vec3 } = require('vec3')

const MANUAL_CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']
const DEG = Math.PI / 180

const VIEWER_PORT = envInt(process.env.MANUAL_VIEWER_PORT, 3000)
const VIEWER_PORT_ATTEMPTS = envInt(process.env.MANUAL_VIEWER_PORT_MAX_ATTEMPTS, 10)
const REACH = envFloat(process.env.MANUAL_REACH, 4.5) // blocks for /dig, /place, /window-open
const VIEW_DISTANCE = envInt(process.env.MANUAL_VIEW_DISTANCE, 6) // viewer chunk radius
const PICKUP_RANGE = envFloat(process.env.MANUAL_PICKUP_RANGE, 16) // blocks scanned by /pickup
const PICKUP_TIMEOUT_MS = envInt(process.env.MANUAL_PICKUP_TIMEOUT_MS, 10000) // max wait for item collection
const PICKUP_MAX_ITEMS = envInt(process.env.MANUAL_PICKUP_MAX_ITEMS, 32) // /pickup all safety cap
const GUI_SESSION_TIMEOUT_MS = envInt(process.env.MANUAL_GUI_TIMEOUT_MS, 20 * 60 * 1000) // auto-close a /gui window after 20 min of no /window-close

function envInt (value, fallback) { const n = parseInt(value, 10); return Number.isFinite(n) ? n : fallback }
function envFloat (value, fallback) { const n = parseFloat(value, 10); return Number.isFinite(n) ? n : fallback }

module.exports = function createManualControls (deps) {
  const {
    bots, logFor, sanitize, notifyBotsChanged, SYSTEM_ID, WEB_BIND, loadViewerFactory
  } = deps

  const i = (id, msg) => logFor(id, `{cyan-fg}› ${msg}{/cyan-fg}`)
  const okMsg = (id, msg) => logFor(id, `{green-fg}✓ ${msg}{/green-fg}`)
  const warn = (id, msg) => logFor(id, `{yellow-fg}⚠ ${msg}{/yellow-fg}`)
  const fail = (id, msg) => logFor(id, `{red-fg}✗ ${msg}{/red-fg}`)
  const hint = (id, msg) => logFor(id, `{gray-fg}  ${msg}{/gray-fg}`)
  const chan = id => id || SYSTEM_ID

  const windowTitle = win => sanitize((win && win.title && win.title.toString ? win.title.toString() : win && win.title) || win && win.type || 'window')

  // Best human-readable name for an item: a server/anvil-set custom name
  // (1.20.5+ custom_name component or NBT display.Name — e.g. a netherite
  // chestplate the server renamed "Fatal Chestplate") wins over the registry
  // displayName. Custom names can arrive as JSON text components or plain
  // strings; strip § codes from whatever we extract.
  // Flatten any text-component shape into plain text: plain strings, JSON text
  // components ({text, extra, …}), NBT tags ({type, value} — 1.20.5+ components
  // arrive as prismarine-nbt), NBT compounds (custom_name's data is a compound
  // like {type:'compound', value:{text:{type:'string', value:'Sword'}}}), and
  // arrays (extra lists).
  function textParts (node, out) {
    if (node == null) return out
    if (typeof node === 'string') {
      try {
        const parsed = JSON.parse(node)
        if (typeof parsed === 'string') { out.push(parsed); return out }
        return textParts(parsed, out)
      } catch (_) { out.push(node); return out }
    }
    if (typeof node === 'number' || typeof node === 'boolean') { out.push(String(node)); return out }
    if (Array.isArray(node)) { node.forEach(n => textParts(n, out)); return out }
    if (typeof node === 'object') {
      // NBT tag wrapper: { type: 'string'|'compound'|'list'|…, value: … }
      if (typeof node.type === 'string' && Object.prototype.hasOwnProperty.call(node, 'value')) {
        if (node.type === 'string') {
          const rawStr = String(node.value)
          try { return textParts(JSON.parse(rawStr), out) } catch (_) { out.push(rawStr); return out }
        }
        return textParts(node.value, out)
      }
      // Plain JSON text component (or NBT compound's inner object)
      if (node.text !== undefined) textParts(node.text, out)
      if (node.extra !== undefined) textParts(node.extra, out)
      if (node.with !== undefined) textParts(node.with, out)
      if (node.translate !== undefined && out.length === 0 && node.fallback !== undefined) textParts(node.fallback, out)
    }
    return out
  }
  function itemCustomName (item) {
    if (!item) return null
    let raw = null
    try { raw = item.customName } catch (_) {}
    if (raw == null && item.nbt) {
      // Belt-and-braces: if the getter surfaced nothing (older item instances,
      // items built by hand), read legacy NBT display.Name directly.
      try {
        raw = item.nbt.value?.display?.value?.Name?.value ?? null
      } catch (_) { raw = null }
    }
    if (raw == null) return null
    const parts = []
    textParts(raw, parts)
    const text = parts.length ? parts.join('') : null
    if (!text) return null
    const out = String(text).replace(/\u00a7./g, '').trim()
    return out || null
  }
  const itemDisplayName = item => itemCustomName(item) || (item && (item.displayName || item.name)) || null
  // The "other" name when an item carries two (anvil custom name vs base item):
  // prefer the registry key (netherite_sword), skip anything identical to shown.
  const itemAltName = (item, shown) => {
    if (!item) return null
    const candidates = [item.name, item.displayName].filter(Boolean)
    const base = String(shown || '').toLowerCase()
    for (const c of candidates) {
      if (String(c).toLowerCase() !== base) return String(c)
    }
    return null
  }
  const itemLabel = item => item ? `${item.count}x ${itemDisplayName(item) || 'item'}` : 'item'

  // ── 3D viewer (prismarine-viewer web client) ────────────────────────────────
  let viewerFactory = null
  let viewerProbed = false
  function getViewerFactory () {
    if (!viewerProbed) {
      viewerProbed = true
      try { viewerFactory = loadViewerFactory() || null } catch (err) {
        warn(SYSTEM_ID, `prismarine-viewer could not load: ${sanitize(err.message)} — manual commands still work, but there is no 3D view.`)
      }
    }
    return viewerFactory
  }

  // Attach the browser-view click→world-action handler. prismarine-viewer's
  // 'blockClicked' listener can only be bound once the viewer exists, so this
  // is called from startManualMode AND again after the viewer starts.
  function bindViewerClicks (id) {
    const entry = bots[id]
    const viewer = entry?.bot?.viewer
    if (!viewer || typeof viewer.on !== 'function') return false
    if (entry.manualViewerClicksBound) return true
    viewer.on('blockClicked', (block, face, button) => handleViewerClick(id, block, face, button))
    entry.manualViewerClicksBound = true
    return true
  }

  // The viewer's own HTTP server would crash unhandled on a busy port, so find
  // a genuinely free port first (same fallback idea as the dashboard's listen).
  function probeFreePort (startPort, bind, attemptsLeft) {
    return new Promise(resolve => {
      let port = startPort
      let tries = attemptsLeft
      const tryOne = () => {
        if (tries-- < 0) { resolve(null); return }
        const srv = net.createServer()
        srv.once('error', () => { port++; tryOne() })
        srv.listen(port, bind, () => { srv.close(() => resolve(port)) })
      }
      tryOne()
    })
  }

  async function startManualViewer (id) {
    const entry = bots[id]
    const bot = entry?.bot
    if (!bot?.entity) return null
    if (entry.manualViewer?.port) return entry.manualViewer
    const factory = getViewerFactory()
    if (!factory) {
      warn(id, '3D viewer unavailable (prismarine-viewer missing) — manual commands and dashboard controls still work.')
      return null
    }
    const bind = WEB_BIND || '0.0.0.0'
    const port = await probeFreePort(VIEWER_PORT, bind, VIEWER_PORT_ATTEMPTS)
    if (port == null) {
      fail(id, `3D viewer: no free port in ${VIEWER_PORT}–${VIEWER_PORT + VIEWER_PORT_ATTEMPTS}`)
      return null
    }
    const firstPerson = !!entry.manualViewerFirstPerson
    try {
      factory(bot, { port, firstPerson, viewDistance: VIEW_DISTANCE, prefix: '' })
    } catch (err) {
      fail(id, `3D viewer failed to start: ${sanitize(err.message)}`)
      return null
    }
    entry.manualViewer = { port, firstPerson }
    // First start: the viewer is only created after startManualMode checked for
    // it — and a /view switch replaces bot.viewer with a fresh emitter — so
    // bind the click handler to the live viewer now (retry once if needed).
    entry.manualViewerClicksBound = false
    if (!bindViewerClicks(id)) {
      setTimeout(() => { if (bots[id]?.manualMode) bindViewerClicks(id) }, 250)
    }
    okMsg(id, `3D viewer live on port ${port} — open it from the dashboard (🌍 viewer button) or http://<this-host>:${port}`)
    hint(id, 'In the 3D view: LEFT click = mine block · RIGHT click = place held block · MIDDLE click = open container (no auto-clicks).')
    notifyBotsChanged()
    return entry.manualViewer
  }

  function stopManualViewer (id) {
    const entry = bots[id]
    if (!entry?.manualViewer) return
    try { entry.bot?.viewer?.close?.() } catch (_) {}
    try { if (entry.bot && entry.bot.viewer) delete entry.bot.viewer } catch (_) {}
    entry.manualViewer = null
    i(id, '3D viewer stopped.')
  }

  // /view first|third — prismarine-viewer picks the camera mode when the viewer
  // server starts (firstPerson sends yaw+pitch so the web client renders the
  // bot's actual view; orbit keeps the free camera), so switching modes means a
  // quick viewer restart on the same port. The click handler is re-bound to the
  // fresh viewer by startManualViewer.
  function setViewerMode (id, firstPerson) {
    const entry = bots[id]
    if (!entry?.bot?.entity) { warn(chan(id), `${id} is not currently spawned.`); return }
    if (!entry.manualMode) { warn(id, 'The 3D viewer is part of manual interact mode — run /manual-interact first.'); return }
    const want = !!firstPerson
    entry.manualViewerFirstPerson = want
    const viewer = entry.manualViewer
    if (!viewer?.port) {
      startManualViewer(id)
      okMsg(id, `3D viewer starting in ${want ? 'first-person (the bot view)' : 'third-person orbit'} — open it from the dashboard (🌍 viewer button).`)
      return
    }
    if (viewer.firstPerson === want) {
      i(id, `3D viewer is already in ${want ? 'first-person' : 'third-person'} mode.`)
      return
    }
    i(id, `Switching 3D viewer to ${want ? 'first-person' : 'third-person'}…`)
    stopManualViewer(id)
    setTimeout(() => {
      startManualViewer(id)
      if (bots[id]?.manualViewer?.port) okMsg(id, `3D viewer restarted on port ${bots[id].manualViewer.port} — re-open the 🌍 viewer tab if it was already open.`)
    }, 400)
  }

  // ── Mode lifecycle ──────────────────────────────────────────────────────────
  function startManualMode (id) {
    const entry = bots[id]
    const bot = entry?.bot
    if (!bot?.entity) { warn(chan(id), `Not spawned — cannot enter manual interact mode.`); return }
    if (entry.crateRoutineRunning || entry.crateLoopRunning || entry.shardshopLoopRunning || entry.inCrateRoutine) {
      warn(id, 'A crates/shardshop routine is running on this bot — stop it before using manual interact.')
      return
    }
    if (!entry.manualMode) {
      entry.manualMode = true
      entry.manualViewerClicksBound = false
      okMsg(id, 'Manual interact ON — automatic GUI slot clicking + AFK warp are suppressed for this bot.')
      // Clicks inside the browser 3D view act on the world (left=dig, right=place, middle=open)
      bindViewerClicks(id)
      hint(id, 'Movement: /walk <x> <y> <z> [range] · /walk stop · /look <yaw> <pitch> · /lookat <x> <y> <z> · /hotbar <1-9>')
      hint(id, 'Actions: /dig · /place · /use · /attack — Windows: /window-open · /window · /window-click <slot> [l|r] · /move <src> <dst> · /window-close')
      hint(id, 'Items: /drop [count] · /pickup [all] · /take <slot|name> · /take-gui · /dump-gui — GUIs: /gui /shardshop (or /chat /shardshop) opens without auto scan/click')
      hint(id, 'View: /view first|third switches the 3D camera to first-person (what the bot sees) or orbit — /pos shows the bot location')
      hint(id, 'Dashboard GUI TUI: /gui-tui — shows the open window as a clickable ASCII panel that shrinks the log view')
    }
    startManualViewer(id)
    notifyBotsChanged()
  }

  function stopManualMode (id) {
    const entry = bots[id]
    if (!entry) return
    const wasManual = entry.manualMode
    entry.suppressNextWindowClick = false
    if (entry.suppressWindowTimer) {
      clearTimeout(entry.suppressWindowTimer)
      entry.suppressWindowTimer = null
    }
    if (entry.manualWindow) {
      try { if (entry.bot?.currentWindow === entry.manualWindow) entry.bot.closeWindow(entry.manualWindow) } catch (_) {}
      entry.manualWindow = null
    }
    endGuiSession(entry)
    entry.manualMode = false
    entry.manualViewerClicksBound = false
    // /manual-stop must also cancel a /walk pathfinder goal, not just release
    // the direct control states.
    try { entry.bot?.pathfinder?.stop?.() } catch (_) {}
    try { entry.bot?.clearControlStates() } catch (_) {}
    if (wasManual) {
      i(id, 'Manual interact OFF — automatic behavior restored.')
    }
    stopManualViewer(id)
    notifyBotsChanged()
  }

  // Arm "treat the next windowOpen as a manual window" for one window. Used by
  // /window-open, the 3D-viewer middle click, /gui, and /chat server commands.
  // Expires after 5s so a command that does NOT open a GUI can't suppress a
  // later automatic window.
  function armWindowSuppression (entry) {
    entry.suppressNextWindowClick = true
    if (entry.suppressWindowTimer) clearTimeout(entry.suppressWindowTimer)
    entry.suppressWindowTimer = setTimeout(() => {
      entry.suppressNextWindowClick = false
      entry.suppressWindowTimer = null
    }, 5000)
    if (entry.suppressWindowTimer.unref) entry.suppressWindowTimer.unref()
  }

  // ── Manual GUI session lifecycle ───────────────────────────────────────────
  // A window opened via /gui (or /chat server-command) stays "manual" for its
  // whole session: even if the server closes and re-opens the GUI on click, the
  // automatic slot-scan/click and the delayed AFK warp stay off until the user
  // runs /window-close, stops manual mode, or the session times out (default
  // 20 min) and the window is auto-closed, restoring automatic behavior. The
  // session is tracked independently of /gui-tui so it holds even when the
  // ASCII overlay was never toggled on.
  function startGuiSessionTimer (entry, id) {
    if (entry.guiSessionTimer) clearTimeout(entry.guiSessionTimer)
    entry.guiSessionTimer = setTimeout(() => autoCloseGuiSession(id), GUI_SESSION_TIMEOUT_MS)
    if (entry.guiSessionTimer.unref) entry.guiSessionTimer.unref()
  }

  function endGuiSession (entry) {
    entry.manualSession = false
    if (entry.guiSessionTimer) {
      clearTimeout(entry.guiSessionTimer)
      entry.guiSessionTimer = null
    }
  }

  function autoCloseGuiSession (id) {
    const entry = bots[id]
    if (!entry) return
    entry.guiSessionTimer = null
    if (!entry.manualSession && !entry.manualWindow) return
    entry.manualSession = false
    const win = entry.manualWindow || entry.bot?.currentWindow
    if (win && entry.bot?.currentWindow === win) {
      try { entry.bot.closeWindow(win) } catch (_) {}
    }
    entry.manualWindow = null
    i(id, `Manual GUI session timed out (${Math.round(GUI_SESSION_TIMEOUT_MS / 60000)} min) — window closed, automatic GUI handling restored.`)
    notifyBotsChanged()
  }

  // ── Window tracking (auto-click suppression hooks for bot.js) ───────────────
  // Track a manually-opened window and keep the dashboard GUI TUI fresh as the
  // server updates slots (shop stock, moved items, etc.).
  function trackManualWindow (entry, window) {
    entry.manualWindow = window
    try {
      if (window && typeof window.on === 'function') {
        window.on('updateSlot', notifyBotsChanged)
        window.on('windowUpdate', notifyBotsChanged)
      }
    } catch (_) {}
    notifyBotsChanged()
  }

  // Returns true when bot.js must NOT run its automatic windowOpen logic.
  function onWindowOpen (id, window) {
    const entry = bots[id]
    if (!entry) return false
    if (entry.suppressNextWindowClick) {
      entry.suppressNextWindowClick = false
      if (entry.suppressWindowTimer) {
        clearTimeout(entry.suppressWindowTimer)
        entry.suppressWindowTimer = null
      }
      trackManualWindow(entry, window)
      // The manual session stays active for this whole GUI — even if the
      // server closes and re-opens the window on click — until /window-close,
      // /manual-stop, or the session timeout auto-close.
      entry.manualSession = true
      startGuiSessionTimer(entry, id)
      i(id, `Window "${windowTitle(window)}" opened manually (${window.slots.length} slots) — auto-click suppressed. /window to inspect · /window-close when done.`)
      return true
    }
    // A manual GUI session is already open (/gui, /chat, /window-open, or
    // manual mode). Some shop GUIs close and reopen the window when you click —
    // re-track the fresh instance so the dashboard TUI keeps following it, and
    // keep the automatic scan/click suppressed for the whole session. Never
    // claim a window while a crate/shardshop routine is running.
    const inRoutine = entry.inCrateRoutine || entry.crateRoutineRunning || entry.crateLoopRunning || entry.shardshopLoopRunning
    if (entry.manualSession && !inRoutine) {
      trackManualWindow(entry, window)
      i(id, `Window "${windowTitle(window)}" re-opened (${window.slots.length} slots) — still manual.`)
      return true
    }
    if (entry.manualMode) {
      trackManualWindow(entry, window)
      entry.manualSession = true
      startGuiSessionTimer(entry, id)
      i(id, `Manual mode: "${windowTitle(window)}" open (${window.slots.length} slots) — auto-click suppressed. /window to inspect · /window-click <slot> [l|r] · /move <src> <dst> · /window-close`)
      return true
    }
    return false
  }

  function onWindowClose (id, window) {
    const entry = bots[id]
    if (entry && (!window || entry.manualWindow === window)) entry.manualWindow = null
  }

  // ── Controls ────────────────────────────────────────────────────────────────
  // Hold-to-move from the dashboard (t:'key' WebSocket messages) and /key.
  function manualKey (id, control, state) {
    const entry = bots[id]
    if (!entry?.bot || !MANUAL_CONTROLS.includes(control)) return false
    if (!entry.manualMode) return false
    const on = state === true || state === 'down' || state === 'on'
    try { entry.bot.setControlState(control, on); return true } catch (_) { return false }
  }

  // Browser 3D view click → world action. face is the clicked block face (Vec3);
  // button: 0 left / 1 middle / 2 right.
  function handleViewerClick (id, block, face, button) {
    const entry = bots[id]
    if (!entry?.bot?.entity || !entry.manualMode || !block) return
    const bot = entry.bot
    const pos = block.position ? `${block.position.x},${block.position.y},${block.position.z}` : '?'
    const name = sanitize(block.name || 'block')
    if (button === 0) {
      i(id, `Viewer: mining ${name} at ${pos}…`)
      bot.dig(block).then(() => okMsg(id, `Mined ${name}.`))
        .catch(err => fail(id, `Mine failed: ${sanitize(err.message)}`))
    } else if (button === 1) {
      i(id, `Viewer: opening ${name} at ${pos} (manual — no auto-clicks)`)
      armWindowSuppression(entry)
      bot.openBlock(block).catch(err => {
        entry.suppressNextWindowClick = false
        fail(id, `Open failed: ${sanitize(err.message || String(err))}`)
      })
    } else {
      if (!bot.heldItem) { warn(id, 'Right-click with an empty hand — select a slot holding a block first (/hotbar <1-9>).'); return }
      i(id, `Viewer: placing ${sanitize(bot.heldItem.displayName || bot.heldItem.name)} against ${name} at ${pos}…`)
      bot.placeBlock(block, face || new Vec3(0, 1, 0)).then(() => okMsg(id, 'Placed.'))
        .catch(err => fail(id, `Place failed: ${sanitize(err.message)}`))
    }
  }

  // Pick the face of `block` whose neighboring air cell is closest to the bot's
  // eyes — a sensible default when no browser-click face is available (/place).
  function manualPlaceFace (bot, block) {
    const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0)
    const dirs = [new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
    let best = null, bestDist = Infinity
    for (const d of dirs) {
      const adj = block.position.plus(d)
      const adjBlock = bot.blockAt(adj)
      if (adjBlock && adjBlock.boundingBox !== 'empty') continue
      const dist = eye.distanceTo(adj.offset(0.5, 0.5, 0.5))
      if (dist < bestDist) { bestDist = dist; best = d }
    }
    return best
  }

  function printWindowSlots (id, bot, win) {
    const isInventory = win === bot.inventory
    logFor(id, `{cyan-fg}› ${isInventory ? 'Inventory' : windowTitle(win)} — ${win.slots.length} protocol slots (empty omitted){/cyan-fg}`)
    const containerCount = isInventory ? 0 : Math.max(0, win.slots.length - 36)
    const label = idx => {
      if (containerCount && idx < containerCount) return `container[${idx}]`
      if (idx >= 36 && idx < 45) return `hotbar[${idx - 36}]`
      if (idx === 45) return 'offhand'
      if (idx >= 9 && idx < 36) return `main[${idx - 9}]`
      if (idx >= 5 && idx < 9) return `armor[${idx - 5}]`
      return `slot ${idx}`
    }
    let printed = 0
    win.slots.forEach((item, idx) => {
      if (!item) return
      logFor(id, ` ${label(idx)} (slot ${idx}): ${sanitize(itemLabel(item))}`)
      const alt = itemAltName(item, itemDisplayName(item))
      if (alt) hint(id, `↳ ${sanitize(alt)}`)
      printed++
    })
    if (!printed) i(id, '(empty)')
    hint(id, 'Rearrange with /move <src> <dst> · raw click: /window-click <slot> [l|r]')
  }

  // ── dropped-item pickup (/pickup) ──────────────────────────────────────────
  // Mineflayer has no "collect this entity" API — the server picks up dropped
  // items when the bot stands close enough. So /pickup pathfinds onto the item
  // and waits for its entity to vanish (collected), with a timeout.
  function nearbyItems (bot, maxDist) {
    const items = []
    const selfPos = bot?.entity?.position
    if (!selfPos) return items
    for (const entity of Object.values(bot.entities)) {
      if (entity === bot.entity) continue
      if (entity.type !== 'object') continue
      if (entity.name !== 'item' && entity.objectType !== 'Item') continue
      const dist = selfPos.distanceTo(entity.position)
      if (dist <= maxDist) items.push({ entity, dist })
    }
    return items.sort((a, b) => a.dist - b.dist)
  }

  function collectItem (id, entry, label) {
    const bot = entry.bot
    if (!bot?.entity) return Promise.resolve(false)
    const items = nearbyItems(bot, PICKUP_RANGE)
    if (!items.length) return Promise.resolve(false)
    const target = items[0]
    const eid = target.entity.id
    const name = sanitize(target.entity.displayName || target.entity.name || 'item')
    i(id, `[${label}] Walking to collect ${name} (${target.dist.toFixed(1)} blocks away)…`)
    try {
      const { goals: { GoalNear } } = require('mineflayer-pathfinder')
      bot.pathfinder.setGoal(new GoalNear(target.entity.position.x, target.entity.position.y, target.entity.position.z, 1))
    } catch (err) {
      fail(id, `Pickup pathfinding failed: ${sanitize(err.message)}`)
      return Promise.resolve(false)
    }
    return new Promise(resolve => {
      const start = Date.now()
      const poll = () => {
        if (!bot.entities[eid]) { okMsg(id, `Collected ${name}.`); resolve(true); return }
        if (!bot.entity || Date.now() - start > PICKUP_TIMEOUT_MS) { resolve(false); return }
        setTimeout(poll, 250)
      }
      poll()
    })
  }

  async function pickupItems (id, entry, limit) {
    const bot = entry.bot
    const max = Math.min(limit, PICKUP_MAX_ITEMS)
    let collected = 0
    let attempted = 0
    while (attempted < max) {
      if (!bot?.entity) { fail(id, 'Bot despawned during pickup.'); return }
      if (!nearbyItems(bot, PICKUP_RANGE).length) break
      attempted++
      const label = limit === Infinity ? `${attempted}/${max}` : `${attempted}/${limit}`
      const okItem = await collectItem(id, entry, label)
      if (okItem) collected++
      else {
        warn(id, 'Item not collected (timed out) — it may be out of reach. Use /walk to get closer, then /pickup again.')
        break
      }
    }
    const remaining = bot?.entity ? nearbyItems(bot, PICKUP_RANGE).length : 0
    if (collected) okMsg(id, `Pickup done: ${collected} item${collected === 1 ? '' : 's'} collected.`)
    if (remaining) hint(id, `${remaining} item${remaining === 1 ? '' : 's'} still within ${PICKUP_RANGE} blocks — /walk closer and /pickup again if needed.`)
    if (!collected && !remaining) i(id, 'No dropped items within reach to pick up.')
  }

  // ── GUI bulk moves (/take, /take-gui, /dump-gui) ───────────────────────────
  // A shift-click (clickWindow mode 1) moves an item between the open window
  // and the player inventory: from a container slot into the inventory, or from
  // an inventory slot into the container. Clicks are spaced out so the server
  // can keep up with fast bulk operations.
  function routineBusy (entry) {
    return !!(entry && (entry.inCrateRoutine || entry.crateRoutineRunning || entry.crateLoopRunning || entry.shardshopLoopRunning))
  }

  function shiftMoveSlots (id, entry, slots, label) {
    const bot = entry.bot
    const win = bot.currentWindow
    if (!win) { warn(id, 'No GUI window is open.'); return }
    const queue = slots.slice()
    if (!queue.length) { i(id, `${label}: nothing to move.`); return }
    i(id, `${label}: shift-clicking ${queue.length} slot${queue.length === 1 ? '' : 's'} (150ms apart)…`)
    let moved = 0
    const step = () => {
      if (!bot.entity || !bot.currentWindow) { fail(id, `${label}: window closed mid-way (${moved} moved).`); return }
      if (!queue.length) { okMsg(id, `${label} done — ${moved} slot${moved === 1 ? '' : 's'} moved.`); notifyBotsChanged(); return }
      const slot = queue.shift()
      if (!win.slots[slot]) { step(); return } // already empty (stack merged by an earlier click)
      bot.clickWindow(slot, 0, 1).then(() => {
        moved++
        setTimeout(step, 150)
      }).catch(err => fail(id, `${label}: slot ${slot} failed — ${sanitize(err.message)} (${moved} moved so far).`))
    }
    step()
  }

  // ── Command router (returns true when the command was handled here) ─────────
  function routeCommand (trimmed, activeId) {
    const sp = trimmed.indexOf(' ')
    const cmd = sp === -1 ? trimmed : trimmed.slice(0, sp)
    const rest = sp === -1 ? '' : trimmed.slice(sp + 1).trim()
    const needsBot = () => {
      if (!activeId) { warn(SYSTEM_ID, 'No active bot.'); return null }
      const entry = bots[activeId]
      if (!entry?.bot?.entity) { warn(chan(activeId), `${activeId} is not currently spawned.`); return null }
      return entry
    }
    const nums = (text, count) => {
      const parts = text.split(/\s+/).filter(Boolean)
      const out = parts.slice(0, count).map(Number)
      return out.length === count && out.every(Number.isFinite) ? out : null
    }

    switch (cmd) {
      // ── mode ──
      case '/manual-interact':
      case '/manual': {
        if (!activeId) { warn(SYSTEM_ID, 'No active bot.'); return true }
        const entry = bots[activeId]
        if (!entry) { warn(SYSTEM_ID, 'No active bot.'); return true }
        if (entry.manualMode) stopManualMode(activeId)
        else startManualMode(activeId)
        return true
      }
      case '/manual-stop': {
        if (!activeId) { warn(SYSTEM_ID, 'No active bot.'); return true }
        if (!bots[activeId]?.manualMode) { i(chan(activeId), 'Manual interact is not currently ON for this bot.'); return true }
        stopManualMode(activeId)
        return true
      }

      // ── movement ──
      case '/walk': {
        const entry = needsBot()
        if (!entry) return true
        const bot = entry.bot
        if (!rest) { warn(activeId, 'Usage: /walk <x> <y> <z> [range] — or /walk stop'); return true }
        if (rest.toLowerCase() === 'stop') {
          try { bot.pathfinder.stop() } catch (_) {}
          try { bot.clearControlStates() } catch (_) {}
          okMsg(activeId, 'Pathfinding stopped.')
          return true
        }
        const target = nums(rest, 3)
        if (!target) { warn(activeId, 'Usage: /walk <x> <y> <z> [range] — or /walk stop'); return true }
        let range = 1
        const extra = rest.split(/\s+/).filter(Boolean)[3]
        if (extra !== undefined) {
          range = Number(extra)
          if (!Number.isFinite(range) || range < 0) { warn(activeId, 'Usage: /walk <x> <y> <z> [range] — range must be a number ≥ 0'); return true }
        }
        range = Math.min(range, 16)
        try {
          const { goals: { GoalNear } } = require('mineflayer-pathfinder')
          bot.pathfinder.setGoal(new GoalNear(target[0], target[1], target[2], range))
          okMsg(activeId, `Walking to ${target[0]}, ${target[1]}, ${target[2]} (within ${range} block${range === 1 ? '' : 's'}) — /walk stop to cancel.`)
        } catch (err) {
          fail(activeId, `Walk failed: ${sanitize(err.message)}`)
        }
        return true
      }
      case '/look': {
        const entry = needsBot()
        if (!entry) return true
        const angles = nums(rest, 2)
        if (!angles) { warn(activeId, 'Usage: /look <yaw> <pitch> (degrees, e.g. /look 90 0)'); return true }
        entry.bot.look(angles[0] * DEG, angles[1] * DEG, false)
          .then(() => okMsg(activeId, `Facing yaw ${angles[0]}° pitch ${angles[1]}°.`))
          .catch(err => fail(activeId, `Look failed: ${sanitize(err.message)}`))
        return true
      }
      case '/lookat': {
        const entry = needsBot()
        if (!entry) return true
        const bot = entry.bot
        const target = nums(rest, 3)
        if (!target) { warn(activeId, 'Usage: /lookat <x> <y> <z>'); return true }
        const pos = bot.entity.position
        bot.lookAt(pos.offset(target[0] - pos.x, target[1] - pos.y, target[2] - pos.z), false)
          .then(() => okMsg(activeId, `Looking at ${target[0]}, ${target[1]}, ${target[2]}.`))
          .catch(err => fail(activeId, `LookAt failed: ${sanitize(err.message)}`))
        return true
      }
      case '/view': {
        const entry = needsBot()
        if (!entry) return true
        const mode = rest.toLowerCase()
        if (!mode) {
          const current = entry.manualViewerFirstPerson ? 'first-person (what the bot sees)' : 'third-person orbit'
          i(activeId, `3D viewer is set to ${current}${entry.manualViewer?.port ? ` (port ${entry.manualViewer.port})` : ' — not running yet'}. Usage: /view first|third`)
          return true
        }
        if (mode === 'first' || mode === 'firstperson' || mode === 'fp') {
          setViewerMode(activeId, true)
        } else if (mode === 'third' || mode === 'thirdperson' || mode === 'orbit' || mode === 'tp') {
          setViewerMode(activeId, false)
        } else {
          warn(activeId, 'Usage: /view first|third — switches the 3D viewer camera between first-person and third-person orbit')
        }
        return true
      }
      case '/pos': {
        const entry = needsBot()
        if (!entry) return true
        const bot = entry.bot
        const pos = bot.entity.position
        const yawDeg = Math.round(bot.entity.yaw * 180 / Math.PI)
        const pitchDeg = Math.round(bot.entity.pitch * 180 / Math.PI)
        const dim = (bot.game && bot.game.dimension) || 'unknown'
        okMsg(activeId, `Position: X ${pos.x.toFixed(1)} Y ${pos.y.toFixed(1)} Z ${pos.z.toFixed(1)} — facing ${yawDeg}°/${pitchDeg}° — ${dim}`)
        return true
      }
      case '/hotbar': {
        const entry = needsBot()
        if (!entry) return true
        const slot = Number(rest)
        if (!Number.isInteger(slot) || slot < 1 || slot > 9) { warn(activeId, 'Usage: /hotbar <1-9>'); return true }
        try {
          entry.bot.setQuickBarSlot(slot - 1)
          okMsg(activeId, `Hotbar slot ${slot} selected.`)
        } catch (err) { fail(activeId, `Hotbar failed: ${sanitize(err.message)}`) }
        return true
      }
      case '/key': {
        const entry = bots[activeId]
        if (!entry) { warn(SYSTEM_ID, 'No active bot.'); return true }
        const parts = rest.split(/\s+/).filter(Boolean)
        if (!entry.manualMode) { warn(activeId, 'Movement keys only work in manual interact mode (/manual-interact).'); return true }
        if (parts.length !== 2 || !manualKey(activeId, parts[0], parts[1])) {
          warn(activeId, `Usage: /key <${MANUAL_CONTROLS.join('|')}> <down|up>`)
        }
        return true
      }

      // ── world actions ──
      case '/dig': {
        const entry = needsBot()
        if (!entry) return true
        const bot = entry.bot
        const block = bot.blockAtCursor(REACH)
        if (!block || block.boundingBox === 'empty') { warn(activeId, `No diggable block in reach (${REACH} blocks) — turn with /look or walk closer.`); return true }
        i(activeId, `Mining ${sanitize(block.name)} at ${block.position}…`)
        bot.dig(block).then(() => okMsg(activeId, `Mined ${sanitize(block.name)}.`))
          .catch(err => fail(activeId, `Mine failed: ${sanitize(err.message)}`))
        return true
      }
      case '/place': {
        const entry = needsBot()
        if (!entry) return true
        const bot = entry.bot
        if (!bot.heldItem) { warn(activeId, 'Nothing in hand — select a slot holding a block first (/hotbar <1-9>).'); return true }
        const block = bot.blockAtCursor(REACH)
        if (!block) { warn(activeId, `No block in reach (${REACH} blocks) to place against.`); return true }
        const face = manualPlaceFace(bot, block)
        if (!face) { warn(activeId, `No free face on ${sanitize(block.name)} — all neighbors are solid.`); return true }
        i(activeId, `Placing ${sanitize(bot.heldItem.displayName || bot.heldItem.name)} against ${sanitize(block.name)} at ${block.position}…`)
        bot.placeBlock(block, face).then(() => okMsg(activeId, 'Placed.'))
          .catch(err => fail(activeId, `Place failed: ${sanitize(err.message)}`))
        return true
      }
      case '/use': {
        const entry = needsBot()
        if (!entry) return true
        try {
          entry.bot.activateItem()
          okMsg(activeId, entry.bot.heldItem ? `Used ${sanitize(entry.bot.heldItem.displayName || entry.bot.heldItem.name)}.` : 'Used item (empty hand).')
        } catch (err) { fail(activeId, `Use failed: ${sanitize(err.message)}`) }
        return true
      }
      case '/attack': {
        const entry = needsBot()
        if (!entry) return true
        const bot = entry.bot
        const entity = bot.entityAtCursor(3.5)
        if (!entity) { warn(activeId, 'No entity at cursor (within 3.5 blocks).'); return true }
        try {
          bot.attack(entity)
          okMsg(activeId, `Attacked ${sanitize(entity.username || entity.name || 'entity')}.`)
        } catch (err) { fail(activeId, `Attack failed: ${sanitize(err.message)}`) }
        return true
      }

      // ── items / server-command GUIs ──
      case '/gui-tui': {
        const entry = needsBot()
        if (!entry) return true
        const bot = entry.bot
        const win = entry.manualWindow || bot.currentWindow
        if (!win || !win.slots) {
          warn(activeId, 'No GUI is open — open one first (/window-open, /gui /shardshop, or /chat /shardshop).')
          return true
        }
        entry.guiTui = !entry.guiTui
        if (entry.guiTui) {
          okMsg(activeId, `GUI TUI shown for "${windowTitle(win)}" (${win.slots.length} slots) — the dashboard renders it as a clickable ASCII panel.`)
          printWindowSlots(activeId, bot, win)
        } else {
          i(activeId, 'GUI TUI hidden.')
        }
        notifyBotsChanged()
        return true
      }
      case '/gui': {
        const entry = needsBot()
        if (!entry) return true
        if (!rest) { warn(activeId, 'Usage: /gui <server command> — e.g. /gui /shardshop or /gui /shop'); return true }
        const bot = entry.bot
        if (bot.currentWindow) { i(activeId, 'A window is already open — /window-close it first.'); return true }
        armWindowSuppression(entry)
        try {
          bot.chat(rest)
          i(activeId, `Sent server command: ${sanitize(rest)} — its GUI opens in manual mode (no auto scan/click or warp). /window to inspect.`)
        } catch (err) {
          entry.suppressNextWindowClick = false
          fail(activeId, `Send failed: ${sanitize(err.message)}`)
        }
        return true
      }
      case '/drop': {
        const entry = needsBot()
        if (!entry) return true
        const bot = entry.bot
        const item = bot.heldItem
        if (!item) { warn(activeId, 'Nothing in hand to drop.'); return true }
        const name = sanitize(item.displayName || item.name || 'item')
        if (rest === '') {
          bot.tossStack(item).then(() => okMsg(activeId, `Dropped ${item.count}x ${name}.`))
            .catch(err => fail(activeId, `Drop failed: ${sanitize(err.message)}`))
        } else {
          const count = Number(rest)
          if (!Number.isInteger(count) || count <= 0) {
            warn(activeId, 'Usage: /drop [count] — drops the whole held stack, or [count] items from it')
          } else {
            bot.toss(item.type, item.metadata ?? null, Math.min(count, item.count))
              .then(() => okMsg(activeId, `Dropped ${Math.min(count, item.count)}x ${name}.`))
              .catch(err => fail(activeId, `Drop failed: ${sanitize(err.message)}`))
          }
        }
        return true
      }
      case '/pickup': {
        const entry = needsBot()
        if (!entry) return true
        const all = rest.toLowerCase() === 'all'
        if (rest && !all) { warn(activeId, 'Usage: /pickup [all]'); return true }
        pickupItems(id, entry, all ? Infinity : 1)
        return true
      }

      case '/take': {
        const entry = needsBot()
        if (!entry) return true
        if (routineBusy(entry)) { warn(activeId, 'A crates/shardshop routine is running on this bot — stop it before taking from a GUI.'); return true }
        const bot = entry.bot
        const win = bot.currentWindow
        if (!win) { warn(activeId, 'No GUI window is open — /window-open or /gui first.'); return true }
        const containerCount = Math.max(0, win.slots.length - 36)
        if (containerCount === 0) { warn(activeId, 'The open window has no container region to take from.'); return true }
        if (!rest) { warn(activeId, 'Usage: /take <slot|item name|all> — shift-clicks the item out of the GUI into your inventory. /take-gui takes everything.'); return true }
        if (rest.toLowerCase() === 'all') {
          const targets = []
          for (let i = 0; i < containerCount; i++) if (win.slots[i]) targets.push(i)
          shiftMoveSlots(activeId, entry, targets, 'Take all')
          return true
        }
        const slotNum = Number(rest)
        if (Number.isInteger(slotNum) && slotNum >= 0 && slotNum < win.slots.length) {
          if (slotNum >= containerCount) { warn(activeId, `Slot ${slotNum} is player inventory, not GUI — container slots are 0–${containerCount - 1}.`); return true }
          if (!win.slots[slotNum]) { warn(activeId, `Slot ${slotNum} is empty.`); return true }
          shiftMoveSlots(activeId, entry, [slotNum], `Take ${itemLabel(win.slots[slotNum])}`)
          return true
        }
        const q = rest.toLowerCase()
        let found = -1
        for (let i = 0; i < containerCount; i++) {
          const it = win.slots[i]
          if (!it) continue
          const names = [itemCustomName(it), it.displayName, it.name].filter(Boolean).map(n => String(n).toLowerCase())
          if (names.some(n => n.includes(q))) { found = i; break }
        }
        if (found === -1) { warn(activeId, `No item matching "${sanitize(rest)}" in the GUI (slots 0–${containerCount - 1}).`); return true }
        shiftMoveSlots(activeId, entry, [found], `Take ${itemLabel(win.slots[found])} (slot ${found})`)
        return true
      }
      case '/take-gui': {
        const entry = needsBot()
        if (!entry) return true
        if (routineBusy(entry)) { warn(activeId, 'A crates/shardshop routine is running on this bot — stop it before taking from a GUI.'); return true }
        const win = entry.bot.currentWindow
        if (!win) { warn(activeId, 'No GUI window is open — /window-open or /gui first.'); return true }
        const containerCount = Math.max(0, win.slots.length - 36)
        if (containerCount === 0) { warn(activeId, 'The open window has no container region to take from.'); return true }
        const targets = []
        for (let i = 0; i < containerCount; i++) if (win.slots[i]) targets.push(i)
        shiftMoveSlots(activeId, entry, targets, 'Take GUI')
        return true
      }
      case '/dump-gui': {
        const entry = needsBot()
        if (!entry) return true
        if (routineBusy(entry)) { warn(activeId, 'A crates/shardshop routine is running on this bot — stop it before dumping into a GUI.'); return true }
        const win = entry.bot.currentWindow
        if (!win) { warn(activeId, 'No GUI window is open — /window-open or /gui first.'); return true }
        const containerCount = Math.max(0, win.slots.length - 36)
        if (containerCount === 0) { warn(activeId, 'The open window has no container region to dump into.'); return true }
        const targets = []
        for (let i = containerCount; i < win.slots.length; i++) if (win.slots[i]) targets.push(i)
        shiftMoveSlots(activeId, entry, targets, 'Dump inventory')
        return true
      }

      // ── windows / inventory ──
      case '/window-open': {
        const entry = needsBot()
        if (!entry) return true
        const bot = entry.bot
        if (bot.currentWindow) {
          i(activeId, `Window already open: "${windowTitle(bot.currentWindow)}" — /window to inspect, /window-close first.`)
          return true
        }
        const block = bot.blockAtCursor(REACH)
        if (!block) { warn(activeId, `No block in reach (${REACH} blocks) — look at a chest/furnace/etc. first.`); return true }
        i(activeId, `Opening ${sanitize(block.name)} at ${block.position} (manual — no auto-clicks)…`)
        armWindowSuppression(entry)
        bot.openBlock(block).catch(err => {
          entry.suppressNextWindowClick = false
          fail(activeId, `Open failed: ${sanitize(err.message || String(err))}`)
        })
        return true
      }
      case '/window': {
        const entry = needsBot()
        if (!entry) return true
        const bot = entry.bot
        printWindowSlots(activeId, bot, bot.currentWindow || bot.inventory)
        return true
      }
      case '/window-close': {
        const entry = needsBot()
        if (!entry) return true
        const bot = entry.bot
        // Explicit close ends the manual GUI session (even if no window is
        // open anymore) so automatic GUI handling comes back.
        endGuiSession(entry)
        if (!bot.currentWindow) { i(activeId, 'No extra window open — manual GUI session ended, automatic GUI handling restored.'); notifyBotsChanged(); return true }
        const win = bot.currentWindow
        // mineflayer's closeWindow() is synchronous (writes close_window and
        // emits 'windowClose') and returns nothing — never chain a promise.
        try {
          bot.closeWindow(win)
          okMsg(activeId, `Closed "${windowTitle(win)}" — automatic GUI handling restored.`)
          notifyBotsChanged()
        } catch (err) {
          fail(activeId, `Close failed: ${sanitize(err.message)}`)
        }
        return true
      }
      case '/window-click': {
        const entry = needsBot()
        if (!entry) return true
        const bot = entry.bot
        const win = bot.currentWindow || bot.inventory
        const parts = rest.split(/\s+/).filter(Boolean)
        const slot = Number(parts[0])
        if (!Number.isInteger(slot) || slot < 0 || slot >= win.slots.length) {
          warn(activeId, `Usage: /window-click <slot> [l|r] — valid slots: 0–${win.slots.length - 1}`)
          return true
        }
        const button = parts[1] === 'r' ? 1 : 0
        bot.clickWindow(slot, button, 0).then(() => { okMsg(activeId, `Clicked slot ${slot} (${button ? 'right' : 'left'}).`); notifyBotsChanged() })
          .catch(err => fail(activeId, `Click failed: ${sanitize(err.message)}`))
        return true
      }
      case '/move': {
        const entry = needsBot()
        if (!entry) return true
        const bot = entry.bot
        const win = bot.currentWindow || bot.inventory
        const pair = nums(rest, 2)
        if (!pair || pair[0] < 0 || pair[1] < 0 || pair[0] >= win.slots.length || pair[1] >= win.slots.length) {
          warn(activeId, `Usage: /move <src> <dst> — valid slots: 0–${win.slots.length - 1} (${bot.currentWindow ? 'open window' : 'inventory'})`)
          return true
        }
        bot.moveSlotItem(pair[0], pair[1]).then(() => { okMsg(activeId, `Moved slot ${pair[0]} → ${pair[1]}.`); notifyBotsChanged() })
          .catch(err => fail(activeId, `Move failed: ${sanitize(err.message)}`))
        return true
      }
      default:
        return false
    }
  }

  // Compact, dashboard-safe description of an open window for the GUI TUI.
  function describeWindow (win, bot) {
    const isInventory = win === bot?.inventory
    const containerCount = isInventory ? 0 : Math.max(0, win.slots.length - 36)
    const label = idx => {
      if (containerCount && idx < containerCount) return `container[${idx}]`
      if (idx >= 36 && idx < 45) return `hotbar[${idx - 36}]`
      if (idx === 45) return 'offhand'
      if (idx >= 9 && idx < 36) return `main[${idx - 9}]`
      if (idx >= 5 && idx < 9) return `armor[${idx - 5}]`
      return `slot ${idx}`
    }
    const slots = []
    win.slots.forEach((item, idx) => {
      // Prefer a server/anvil-set custom name (e.g. "Fatal Chestplate" for a
      // netherite chestplate the server renamed) over the registry displayName.
      const shown = item ? itemDisplayName(item) : null
      const primary = shown ? `${item.count}x ${sanitize(shown)}` : null
      // Alternative/internal registry name (displayName "Diamond Sword" vs name
      // "diamond_sword", or a custom name vs its base item) — shown on its own
      // line in the dashboard GUI TUI when it differs from what is displayed.
      const alt = itemAltName(item, shown)
      slots.push({
        slot: idx,
        label: label(idx),
        item: primary,
        alt
      })
    })
    return { title: windowTitle(win), isInventory, slots }
  }

  // Dashboard snapshot. Returns null when there is nothing manual to show. The
  // shape changed to carry `mode` separately from the GUI TUI, because /gui and
  // /chat /shardshop track windows even when manual mode is OFF.
  function snapshotFor (entry) {
    const win = entry?.manualWindow && entry.manualWindow.slots ? entry.manualWindow : null
    const hasMode = !!entry?.manualMode
    const hasSession = !!entry?.manualSession
    const hasTui = !!entry?.guiTui && !!win
    if (!hasMode && !hasSession && !hasTui) return null
    const out = { mode: hasMode, session: hasSession }
    if (hasMode) {
      const viewerPort = entry.manualViewer ? entry.manualViewer.port : null
      // Docker/run-docker.sh maps the container viewer range to a per-instance
      // host block and injects MANUAL_VIEWER_HOST_PORT — translate so the
      // dashboard's viewer button opens the right host URL (falls back to the
      // container port when unset, i.e. plain local runs).
      let viewerHostPort = null
      const hostBase = parseInt(process.env.MANUAL_VIEWER_HOST_PORT, 10)
      if (viewerPort && Number.isFinite(hostBase)) {
        const containerBase = parseInt(process.env.MANUAL_VIEWER_PORT, 10)
        const base = Number.isFinite(containerBase) ? containerBase : VIEWER_PORT
        viewerHostPort = hostBase + (viewerPort - base)
      }
      out.viewerPort = viewerPort
      out.viewerHostPort = viewerHostPort
    }
    if (hasTui) {
      out.guiTui = true
      out.window = describeWindow(win, entry.bot)
    }
    return out
  }

  return {
    MANUAL_CONTROLS,
    routeCommand,
    startManualMode,
    stopManualMode,
    key: manualKey,
    onWindowOpen,
    onWindowClose,
    armWindowSuppression,
    snapshotFor
  }
}
