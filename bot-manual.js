'use strict'
// ── Manual interact mode engine (loaded by bot.js) ────────────────────────────
// /manual-interact gives one bot a slow, hand-driven avatar:
//   • a browser 3D view (prismarine-viewer) streams the bot's world and turns
//     clicks in the view into dig / place / open-container actions,
//   • the dashboard gets a hold-to-move pad + hotbar over a tiny 'key' channel,
//   • commands (/walk, /dig, /place, /window-*, /move, /key…) give the same
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
    try {
      factory(bot, { port, firstPerson: false, viewDistance: VIEW_DISTANCE, prefix: '' })
    } catch (err) {
      fail(id, `3D viewer failed to start: ${sanitize(err.message)}`)
      return null
    }
    entry.manualViewer = { port }
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
      okMsg(id, 'Manual interact ON — automatic GUI slot clicking + AFK warp are suppressed for this bot.')
      // Clicks inside the browser 3D view act on the world (left=dig, right=place, middle=open)
      if (bot.viewer && typeof bot.viewer.on === 'function') {
        bot.viewer.on('blockClicked', (block, face, button) => handleViewerClick(id, block, face, button))
      }
      hint(id, 'Movement: /walk <x> <y> <z> [range] · /walk stop · /look <yaw> <pitch> · /lookat <x> <y> <z> · /hotbar <1-9>')
      hint(id, 'Actions: /dig · /place · /use · /attack — Windows: /window-open · /window · /window-click <slot> [l|r] · /move <src> <dst> · /window-close')
    }
    startManualViewer(id)
    notifyBotsChanged()
  }

  function stopManualMode (id) {
    const entry = bots[id]
    if (!entry) return
    entry.suppressNextWindowClick = false
    if (entry.manualWindow) {
      try { if (entry.bot?.currentWindow === entry.manualWindow) entry.bot.closeWindow(entry.manualWindow) } catch (_) {}
      entry.manualWindow = null
    }
    if (entry.manualMode) {
      entry.manualMode = false
      try { entry.bot?.clearControlStates() } catch (_) {}
      i(id, 'Manual interact OFF — automatic behavior restored.')
    }
    stopManualViewer(id)
    notifyBotsChanged()
  }

  // ── Window tracking (auto-click suppression hooks for bot.js) ───────────────
  // Returns true when bot.js must NOT run its automatic windowOpen logic.
  function onWindowOpen (id, window) {
    const entry = bots[id]
    if (!entry) return false
    if (entry.suppressNextWindowClick) {
      entry.suppressNextWindowClick = false
      entry.manualWindow = window
      i(id, `Window "${windowTitle(window)}" opened manually (${window.slots.length} slots) — auto-click suppressed. /window to inspect · /window-close when done.`)
      notifyBotsChanged()
      return true
    }
    if (entry.manualMode) {
      entry.manualWindow = window
      i(id, `Manual mode: "${windowTitle(window)}" open (${window.slots.length} slots) — auto-click suppressed. /window to inspect · /window-click <slot> [l|r] · /move <src> <dst> · /window-close`)
      notifyBotsChanged()
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
      entry.suppressNextWindowClick = true
      bot.openBlock(block).catch(err => {
        entry.suppressNextWindowClick = false
        fail(id, `Open failed: ${sanitize(err.message || String(err))}`)
      })
      setTimeout(() => { if (entry.suppressNextWindowClick) entry.suppressNextWindowClick = false }, 5000)
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
      logFor(id, ` ${label(idx)} (slot ${idx}): ${item.count}x ${sanitize(item.displayName || item.name)}`)
      printed++
    })
    if (!printed) i(id, '(empty)')
    hint(id, 'Rearrange with /move <src> <dst> · raw click: /window-click <slot> [l|r]')
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
        entry.suppressNextWindowClick = true
        bot.openBlock(block).catch(err => {
          entry.suppressNextWindowClick = false
          fail(activeId, `Open failed: ${sanitize(err.message || String(err))}`)
        })
        setTimeout(() => { if (entry.suppressNextWindowClick) entry.suppressNextWindowClick = false }, 5000)
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
        if (!bot.currentWindow) { i(activeId, 'No extra window open.'); return true }
        const win = bot.currentWindow
        bot.closeWindow(win).then(() => okMsg(activeId, `Closed "${windowTitle(win)}".`))
          .catch(err => fail(activeId, `Close failed: ${sanitize(err.message)}`))
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
        bot.clickWindow(slot, button, 0).then(() => okMsg(activeId, `Clicked slot ${slot} (${button ? 'right' : 'left'}).`))
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
        bot.moveSlotItem(pair[0], pair[1]).then(() => okMsg(activeId, `Moved slot ${pair[0]} → ${pair[1]}.`))
          .catch(err => fail(activeId, `Move failed: ${sanitize(err.message)}`))
        return true
      }
      default:
        return false
    }
  }

  function snapshotFor (entry) {
    if (!entry?.manualMode) return null
    return { viewerPort: entry.manualViewer ? entry.manualViewer.port : null }
  }

  return {
    MANUAL_CONTROLS,
    routeCommand,
    startManualMode,
    stopManualMode,
    key: manualKey,
    onWindowOpen,
    onWindowClose,
    snapshotFor
  }
}
