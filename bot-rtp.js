const mineflayer = require('mineflayer')
const blessed = require('neo-blessed')

// ---- TUI setup ----
const screen = blessed.screen({
  smartCSR: true,
  title: 'Mineflayer Bot Console',
  fullUnicode: true
})

const header = blessed.box({
  top: 0,
  left: 0,
  width: '100%',
  height: 3,
  content: '{center}{bold}⛏  MINEFLAYER BOT CONSOLE{/bold}{/center}',
  tags: true,
  style: { fg: 'white', bg: 'blue' }
})

const logBox = blessed.log({
  top: 3,
  left: 0,
  width: '100%',
  height: '100%-6',
  border: { type: 'line' },
  label: ' Activity Log ',
  tags: true,
  padding: { left: 1, right: 1 },
  style: {
    border: { fg: 'gray' },
    label: { fg: 'cyan', bold: true }
  },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  scrollbar: { ch: '│', style: { fg: 'cyan' } }
})

const inputBox = blessed.textbox({
  bottom: 0,
  left: 0,
  width: '100%',
  height: 3,
  border: { type: 'line' },
  tags: true,
  style: { border: { fg: 'green' }, fg: 'white' },
  inputOnFocus: true
})
inputBox.setLabel(' {green-fg}{bold}❯{/bold}{/green-fg} Command ')

screen.append(header)
screen.append(logBox)
screen.append(inputBox)
inputBox.focus()

if (typeof fetch !== 'function') {
  logBox.log('{red-fg}[startup] Global fetch not found — Node 18+ is required for Discord webhook alerts.{/red-fg}')
}

// Redirect everything into the log box, nothing leaks to raw terminal
process.stderr.write = (chunk) => {
  logBox.log(`{gray-fg}[stderr] ${chunk.toString().trim()}{/gray-fg}`)
  screen.render()
  return true
}
console.log = (...args) => { logBox.log(`{gray-fg}${args.join(' ')}{/gray-fg}`); screen.render() }
console.warn = (...args) => { logBox.log(`{yellow-fg}[warn] ${args.join(' ')}{/yellow-fg}`); screen.render() }
console.error = (...args) => { logBox.log(`{red-fg}[error] ${args.join(' ')}{/red-fg}`); screen.render() }

screen.key(['C-c'], () => process.exit(0))

function timestamp() {
  const d = new Date()
  return `{gray-fg}${d.toLocaleTimeString()}{/gray-fg}`
}

// ---- Multi-bot state ----
const bots = {}       // username -> { bot, spawnTime, logs: [], host, port, version, ... }
let activeId = null
const rtpLocationHistory = new Map() // shared across ALL bots: bucketKey -> times seen (detects reused RTP spots)

function updateHeader() {
  const names = Object.keys(bots)
  const activeLabel = activeId ? `Active: ${activeId}` : 'No active bot'
  const others = names.filter(n => n !== activeId)
  const othersLabel = others.length ? `  |  Others: ${others.join(', ')}` : ''
  header.setContent(`{center}{bold}⛏  MINEFLAYER BOT CONSOLE{/bold}   —   ${activeLabel}${othersLabel}{/center}`)
  screen.render()
}

function switchTo(id) {
  if (!bots[id]) {
    log(`{red-fg}✗ No bot named "${id}"{/red-fg}`)
    return
  }
  activeId = id

  // Clear and repopulate atomically — no looped .log() calls
  logBox.setContent('')
  logBox.scrollTo(0)

  if (bots[id].logs.length > 0) {
    logBox.setContent(bots[id].logs.join('\n'))
  }

  updateHeader()

  // Jump to bottom
  const bottom = logBox.getScrollHeight()
  if (bottom > 0) logBox.scrollTo(bottom)

  screen.render()
}

// Generic log function — writes to whichever bot ID is passed, only renders if that bot is active
function logFor(id, msg) {
  if (!bots[id]) return
  const line = `${timestamp()} ${msg}`
  bots[id].logs.push(line)
  if (id === activeId) {
    logBox.log(line)
    screen.render()
  }
}

// Convenience: log to whichever bot is currently active (used by command handlers)
function log(msg) { if (activeId) logFor(activeId, msg) }
function logSuccess(msg) { log(`{green-fg}✓ ${msg}{/green-fg}`) }
function logError(msg)   { log(`{red-fg}✗ ${msg}{/red-fg}`) }
function logInfo(msg)    { log(`{cyan-fg}› ${msg}{/cyan-fg}`) }
function logWarn(msg)    { log(`{yellow-fg}⚠ ${msg}{/yellow-fg}`) }

// ---- Discord + base-finder helpers ----

async function sendDiscordAlert(title, description, color = 0x5865F2) {
  if (!DISCORD_WEBHOOK_URL) return
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: DISCORD_USER_ID ? `<@${DISCORD_USER_ID}>` : undefined,
        allowed_mentions: DISCORD_USER_ID ? { users: [DISCORD_USER_ID] } : undefined,
        embeds: [{ title, description, color, timestamp: new Date().toISOString() }]
      })
    })
  } catch (err) {
    const fallbackId = activeId || Object.keys(bots)[0]
    if (fallbackId) logFor(fallbackId, `{red-fg}[discord] Failed to send alert: ${err.message}{/red-fg}`)
  }
}

// Discord RTP Log Updater
const rtpDiscordMessageIds = new Map() // botId -> messageId (one live-updating message PER bot)

async function updateDiscordRtpLog(botId, x, y, z) {
  if (!DISCORD_WEBHOOK_URL) return;

  const title = "📜 RTP LOG";
  const description = `**${botId}** latest RTP location:\n\`${x}, ${y}, ${z}\``;
  const existingId = rtpDiscordMessageIds.get(botId)

  try {
    if (!existingId) {
      // 1. If we haven't made the message yet for THIS bot, create it (must use ?wait=true to get the ID back)
      const res = await fetch(DISCORD_WEBHOOK_URL + "?wait=true", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{ title, description, color: 0x3498DB, timestamp: new Date().toISOString() }]
        })
      });
      if (!res.ok) throw new Error(`Discord POST failed: ${res.status} ${await res.text()}`)
      const data = await res.json();
      rtpDiscordMessageIds.set(botId, data.id); // Save the ID for this bot for next time
    } else {
      // 2. If the message exists for this bot, edit it using PATCH
      const res = await fetch(`${DISCORD_WEBHOOK_URL}/messages/${existingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{ title, description, color: 0x3498DB, timestamp: new Date().toISOString() }]
        })
      });
      if (!res.ok) throw new Error(`Discord PATCH failed: ${res.status} ${await res.text()}`)
    }
  } catch (err) {
    // Surface the failure instead of swallowing it silently
    logFor(botId, `{red-fg}[discord] RTP log update failed: ${err.message}{/red-fg}`)
    // If the message was deleted manually (or was never valid), reset so it creates a new one next time
    if (err.message.includes('Unknown Message') || err.message.includes('404')) {
        rtpDiscordMessageIds.delete(botId);
    }
  }
}

const BASE_INDICATORS = [
  'ender_chest',
  'anvil',
  'chipped_anvil',
  'damaged_anvil',
  'smithing_table',
  'furnace',
  'blast_furnace',
  'smoker',
  'enchanting_table'
]

function getStorageBlockIds(bot) {
  if (!bot.registry) return []
  return Object.keys(bot.registry.blocksByName)
    .filter(name => 
      name === 'chest' || 
      name === 'trapped_chest' || 
      name === 'barrel' || 
      BASE_INDICATORS.includes(name) || 
      name.endsWith('shulker_box')
    )
    .map(name => bot.registry.blocksByName[name].id)
}
function scanForBase(bot, id) {
  if (!bot.entity) return
  const state = bots[id]
  if (!state) return
  try {
    const ids = getStorageBlockIds(bot)
    if (ids.length === 0) return
    const positions = bot.findBlocks({ matching: ids, maxDistance: BASE_SCAN_RADIUS, count: 4096 })
    if (positions.length < BASE_ALERT_THRESHOLD) return

    const buckets = new Map()
    for (const pos of positions) {
      const key = `${Math.floor(pos.x / 16)},${Math.floor(pos.z / 16)}`
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(pos)
    }

    for (const [key, blockPositions] of buckets) {
      if (blockPositions.length < BASE_ALERT_THRESHOLD) continue
      if (state.alertedBases.has(key)) continue
      
      const counts = {}
      let hasIndicator = false // Track if a player-specific block is present

      for (const p of blockPositions) {
        const block = bot.blockAt(p)
        const name = block ? block.name : 'unknown'
        counts[name] = (counts[name] || 0) + 1
        
        // Check if this block is one of our required base indicators
        if (BASE_INDICATORS.includes(name) || name.endsWith('shulker_box')) {
          hasIndicator = true
        }
      }

      // If the cluster is ONLY chests/barrels (e.g. Trial Chamber), skip it
      if (!hasIndicator) continue

      // Only add to alerted bases if it passed the indicator check
      state.alertedBases.add(key)

      const cx = Math.round(blockPositions.reduce((sum, p) => sum + p.x, 0) / blockPositions.length)
      const cy = Math.round(blockPositions.reduce((sum, p) => sum + p.y, 0) / blockPositions.length)
      const cz = Math.round(blockPositions.reduce((sum, p) => sum + p.z, 0) / blockPositions.length)

      const breakdown = Object.entries(counts).map(([n, c]) => `${c}x ${n}`).join(', ')

      logFor(id, `{magenta-fg}{bold}⛺ Possible base near ${cx}, ${cy}, ${cz} — ${blockPositions.length} storage blocks (${breakdown}){/bold}{/magenta-fg}`)
      sendDiscordAlert(
        `⛺ Base found — ${id}`,
        `Location: \`${cx}, ${cy}, ${cz}\`\nStorage blocks: ${blockPositions.length}\nBreakdown: ${breakdown}`,
        0xE67E22
      )
      if (typeof state.pauseRtp === 'function') state.pauseRtp(RTP_PAUSE_ON_BASE_MS)
    }
  } catch (err) {
    logFor(id, `{red-fg}[scan] Error: ${err.message}{/red-fg}`)
  }
}


function manageTotems(bot, id) {
  if (!bot.entity || !bot.registry) return
  const state = bots[id]
  if (!state) return
  try {
    const totemDef = bot.registry.itemsByName['totem_of_undying']
    if (!totemDef) return

    const offhand = bot.inventory.slots[45] 
    const hasOffhandTotem = !!(offhand && offhand.type === totemDef.id)

    if (state.lastOffhandWasTotem && !hasOffhandTotem) {
      logFor(id, `{yellow-fg}{bold}✨ TOTEM POPPED — ${id} was saved from death!{/bold}{/yellow-fg}`)
      sendDiscordAlert(`✨ Totem popped — ${id}`, `${id} used a Totem of Undying to survive near-death.`, 0xF1C40F)
    }

    if (!hasOffhandTotem) {
      const totem = bot.inventory.items().find(item => item.type === totemDef.id)
      if (totem) {
        bot.equip(totem, 'off-hand')
          .then(() => { state.lastOffhandWasTotem = true })
          .catch(err => logFor(id, `{red-fg}[totem] Equip failed: ${err.message}{/red-fg}`))
        return 
      } else if (state.lastOffhandWasTotem) {
        logFor(id, '{yellow-fg}⚠ Out of totems!{/yellow-fg}')
      }
    }

    state.lastOffhandWasTotem = hasOffhandTotem
  } catch (err) {
    logFor(id, `{red-fg}[totem] Error: ${err.message}{/red-fg}`)
  }
}

function checkNearbyPlayers(bot, id) {
  if (!bot.entity) return
  const state = bots[id]
  if (!state) return
  try {
    const now = Date.now()
    for (const [name, player] of Object.entries(bot.players)) {
      if (name === id || bots[name]) continue 
      if (!player.entity) continue            

      const dist = bot.entity.position.distanceTo(player.entity.position)
      if (dist > PLAYER_PROXIMITY_RADIUS) continue

      const lastAlert = state.lastPlayerAlert.get(name) || 0
      if (now - lastAlert < PLAYER_PROXIMITY_COOLDOWN_MS) continue
      state.lastPlayerAlert.set(name, now)

      logFor(id, `{red-fg}{bold}⚠ Player nearby: ${name} (${dist.toFixed(1)} blocks){/bold}{/red-fg}`)
      sendDiscordAlert(`⚠ Player nearby — ${id}`, `${name} is ${dist.toFixed(1)} blocks from ${id}.`, 0xE74C3C)
    }
  } catch (err) {
    logFor(id, `{red-fg}[proximity] Error: ${err.message}{/red-fg}`)
  }
}

function manageFood(bot, id) {
  if (!bot.entity || !bot.registry) return
  const state = bots[id]
  if (!state) return
  if (bot.food === undefined || bot.food === null) return
  if (bot.food >= FOOD_EAT_THRESHOLD) return
  if (bot.currentWindow) return 

  try {
    const edibleItems = bot.inventory.items().filter(item => bot.registry.foodsByName?.[item.name])
    if (edibleItems.length === 0) {
      if (!state.noFoodWarned) {
        logFor(id, '{yellow-fg}⚠ Hungry but no food in inventory!{/yellow-fg}')
        state.noFoodWarned = true
      }
      return
    }
    state.noFoodWarned = false

    edibleItems.sort((a, b) =>
      (bot.registry.foodsByName[b.name].foodPoints || 0) - (bot.registry.foodsByName[a.name].foodPoints || 0))
    const best = edibleItems[0]

    bot.equip(best, 'hand')
      .then(() => bot.consume())
      .then(() => logFor(id, `{green-fg}✓ Ate ${best.displayName || best.name}{/green-fg}`))
      .catch(err => logFor(id, `{red-fg}[food] Eat failed: ${err.message}{/red-fg}`))
  } catch (err) {
    logFor(id, `{red-fg}[food] Error: ${err.message}{/red-fg}`)
  }
}

// ---- Bot creation ----
const HOST = 'play.fatalmc.org'
const PORT = 25565
const VERSION = '1.21.1'

// ---- Discord alert config ----
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1536063570859786383/fJihPygSzeQfWT5mHHGv8riec0cE0ajbxCotcoHj91AJLqpraOCUwOlrUq5230JCcCVL'
const DISCORD_USER_ID = '1262159132887093339'

// ---- Roam / base-finding config ----
const MODE = 'roam'                     
const RTP_COMMAND = '/rtp world world'  
const RTP_INTERVAL_MS = 34.8* 1000       
const BASE_SCAN_INTERVAL_MS = 12 * 1000 
const BASE_SCAN_RADIUS = 256             
const BASE_ALERT_THRESHOLD = 4          
const RTP_PAUSE_ON_BASE_MS = 10 * 60 * 1000 

// ---- Player proximity config ----
const PLAYER_PROXIMITY_RADIUS = 32           
const PLAYER_PROXIMITY_INTERVAL_MS = 5 * 1000
const PLAYER_PROXIMITY_COOLDOWN_MS = 5 * 60 * 1000 

// ---- Auto-eat config ----
const FOOD_CHECK_INTERVAL_MS = 5 * 1000
const FOOD_EAT_THRESHOLD = 18 

function createBotInstance(username, host = HOST, port = PORT, version = VERSION) {
  const id = username
  let connected = false
  let manualDisconnect = false
  let reconnectTimer = null

  const s = (msg) => logFor(id, `{green-fg}✓ ${msg}{/green-fg}`)
  const e = (msg) => logFor(id, `{red-fg}✗ ${msg}{/red-fg}`)
  const i = (msg) => logFor(id, `{cyan-fg}› ${msg}{/cyan-fg}`)
  const w = (msg) => logFor(id, `{yellow-fg}⚠ ${msg}{/yellow-fg}`)
  const c = (msg) => logFor(id, `{white-fg}${msg}{/white-fg}`)

  if (bots[id]?.bot) {
    bots[id].bot.removeAllListeners()
    if (bots[id].bot._client) bots[id].bot._client.removeAllListeners()
  }

  const existingLogs = bots[id]?.logs || []
  const existingAlertedBases = bots[id]?.alertedBases || new Set()

  const bot = mineflayer.createBot({ host, port, username: id, version, hideErrors: true })

  bots[id] = {
    bot, spawnTime: null, logs: existingLogs, host, port, version,
    alertedBases: existingAlertedBases,
    lastOffhandWasTotem: false,
    lastPlayerAlert: new Map(),
    noFoodWarned: false
  }

  const timeouts = []
  const pushT = (fn, delay) => { const t = setTimeout(fn, delay); timeouts.push(t); return t }
  const intervals = []
  const pushI = (fn, delay) => { const iv = setInterval(fn, delay); intervals.push(iv); return iv }
  const clearAll = () => {
    timeouts.forEach(clearTimeout)
    timeouts.length = 0
    intervals.forEach(clearInterval)
    intervals.length = 0
  }

  const scheduleReconnect = (reason) => {
    clearAll()
    connected = false
    if (manualDisconnect || reconnectTimer) return

    const delay = 8000 + Math.floor(Math.random() * 3000)
    w(`${reason}. Auto-reconnecting in ${(delay / 1000).toFixed(1)}s...`)

    reconnectTimer = setTimeout(() => {
      createBotInstance(id, host, port, version)
    }, delay)
  }

  const safeChat = (msg) => {
    if (connected && bot.entity) bot.chat(msg)
  }

  let rtpTimer = null
  const scheduleRtp = (delay) => {
    rtpTimer = pushT(() => {
      safeChat(RTP_COMMAND)
      i(`Sent ${RTP_COMMAND} (periodic)`)
      
      // Wait 5 seconds for the server to process the teleport, then grab coordinates
      pushT(() => {
        if (bot.entity) {
          const pos = bot.entity.position
          const x = Math.round(pos.x)
          const y = Math.round(pos.y)
          const z = Math.round(pos.z)
          
          i(`Arrived at RTP location: ${x}, ${y}, ${z}`)
          updateDiscordRtpLog(id, x, y, z)

          // Track RTP history to see if the server re-uses spots
          const chunkKey = `${Math.floor(x/16)},${Math.floor(z/16)}`
          const timesSeen = (rtpLocationHistory.get(chunkKey) || 0) + 1
          rtpLocationHistory.set(chunkKey, timesSeen)

          if (timesSeen > 1) {
              w(`Notice: We have RTP'd to this chunk area ${timesSeen} times!`)
          }
        }
      }, 5000)

      scheduleRtp(RTP_INTERVAL_MS + Math.random() * 15000)
    }, delay)
  }
  
  bots[id].pauseRtp = (ms) => {
    if (rtpTimer) clearTimeout(rtpTimer)
    w(`Base found — holding position, RTP paused for ${(ms / 60000).toFixed(1)} min.`)
    scheduleRtp(ms)
  }

  const startRoaming = () => {
    i('Entering roam mode: RTP + totem/food management + base & player scanning')
    safeChat(RTP_COMMAND)
    s(`Sent ${RTP_COMMAND}`)

    pushI(() => manageTotems(bot, id), 3000)
    pushI(() => manageFood(bot, id), FOOD_CHECK_INTERVAL_MS)
    pushI(() => scanForBase(bot, id), BASE_SCAN_INTERVAL_MS)
    pushI(() => checkNearbyPlayers(bot, id), PLAYER_PROXIMITY_INTERVAL_MS)
    scheduleRtp(RTP_INTERVAL_MS + Math.random() * 15000)
  }

  bot.once('login', () => {
    i('Connected to server socket. Sending auth commands...')
    pushT(() => bot.chat('/login 123456'), 2220 + Math.random() * 400)
  })

  bot.once('spawn', () => {
    connected = true
    bots[id].spawnTime = Date.now()
    s(`Bot has spawned and is connected to ${host}:${port} (v${version}).`)

    pushT(() => {
      i('Right-clicking compass (server selector)...')
      bot.activateItem()
    }, 3600 + Math.random() * 600)
  })

  bot.on('windowOpen', (window) => {
    const title = window.title?.toString ? window.title.toString() : String(window.title)
    i(`Window opened: ${title} (${window.slots.length} slots)`)

    window.slots.forEach((item, idx) => {
      if (item) i(`  slot ${idx}: ${item.count}x ${item.displayName || item.name}`)
    })

    const targetSlot = 11
    if (targetSlot >= window.slots.length) {
      w(`Slot ${targetSlot} out of bounds — window only has ${window.slots.length} slots`)
      return
    }
    if (!window.slots[targetSlot]) {
      w(`Slot ${targetSlot} is empty — not clicking.`)
      return
    }

    pushT(async () => {
      if (!bot.currentWindow) {
        w('Window closed before click could fire.')
        return
      }
      try {
        await bot.clickWindow(targetSlot, 0, 0)
        i(`Clicked slot ${targetSlot}`)
      } catch (err) {
        e(`Click failed: ${err.message || err}`)
      }

      pushT(() => {
        if (MODE === 'roam') {
          startRoaming()
        } else {
          safeChat('/warp afk')
          s('Sent /warp afk')
        }
      }, 8000 + Math.random() * 4200)
    }, 2000 + Math.random() * 1600)
  })

  bot.on('message', (jsonMsg) => c(jsonMsg.toString()))
  bot.on('kicked', (reason) => e(`Kicked: ${JSON.stringify(reason)}`))
  bot.on('error', (err) => e(`Error: ${err.message || err}`))

  bot.on('end', () => {
    connected = false
    w('Disconnected.')
    scheduleReconnect('Connection lost')
  })

  bots[id].disconnectManually = () => {
    manualDisconnect = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    clearAll()
    bot.quit()
  }

  if (!activeId) activeId = id
  updateHeader()

  return bot
}

const BOT_NAMES = [
  'OnlyAProgrammer',
  'Jt2S1m3ePer',
  'BilihJm289',
  '1evArchUsr2',
  'LnuxOtocael',
  'DevArchUsr99',   // 12 letters
  'PgrMrJt3S21m',   // 12 letters
  'LnuxSysOp808',   // 12 letters
  'NvimScriptr1',   // 12 letters
  'CplusplusDev7'   // 13 letters
]

const CONNECT_DELAY_MS = 39500  

BOT_NAMES.forEach((name, index) => {
  setTimeout(() => {
    createBotInstance(name)
    if (index === 0) switchTo(name) 
  }, index * CONNECT_DELAY_MS)
})

const COMMANDS = {
  '/chat': 'Alternative to chatting, so therefore you can do commmands like /help without using client side one',
  '/disconnect': 'Disconnects the current bot, but doesnt exit the other bots, or just use dc as an alias',
  '/clear': 'Clear the current bot\'s log view',
  '/help': 'List all available commands',
  '/status': 'Show active bot connection, position, health, ping, uptime',
  '/inv': 'List active bot\'s inventory contents',
  '/players': 'List players online (from active bot\'s perspective)',
  '/rtp': 'Manually send the RTP command as the active bot',
  '/exit': 'Disconnect all bots and close the program',
  '/reconnect': 'Reconnect the active bot',
  '/new-bot [username] [host] [port] [version]': 'Create and connect a new bot (host/port/version optional, defaults to the main server)',
  '/switch [username]': 'Switch the TUI view to a different connected bot (does not disconnect anything)',
  'anything else': 'Sent directly as a chat message/command from the active bot'
}

function handleCommand(trimmed) {
  if (trimmed.startsWith('/chat ')) {
    const msg = trimmed.slice(6).trim()
    if (!activeId) { logWarn('No active bot.'); return }
    if (!msg) { logWarn('Usage: /chat <message>'); return }
    bots[activeId].bot.chat(msg)
    log(`{green-fg}❯{/green-fg} Chat: ${msg}`)
    return
  }
  if (trimmed.startsWith('/new-bot ')) {
    const args = trimmed.slice(9).trim().split(/\s+/).filter(Boolean)
    const username = args[0]

    if (!username) { logWarn('Usage: /new-bot [username] [host] [port] [version]'); return }
    if (bots[username]) { logWarn(`Bot "${username}" already exists.`); return }

    const host = args[1] || HOST
    const port = args[2] ? parseInt(args[2], 10) : PORT
    const version = args[3] || VERSION

    logInfo(`Creating new bot: ${username} @ ${host}:${port} (v${version})`)
    createBotInstance(username, host, port, version)
    return
  }

  if (trimmed.startsWith('/switch ')) {
    const username = trimmed.slice(8).trim()
    switchTo(username)
    return
  }

  switch (trimmed) {
    case '/clear':
      if (activeId) bots[activeId].logs = []
      logBox.setContent('')
      screen.render()
      break

    case '/help':
      logInfo('Available commands:')
      Object.entries(COMMANDS).forEach(([cmd, desc]) => {
        log(`  {cyan-fg}${cmd}{/cyan-fg} — ${desc}`)
      })
      break

    case '/status': {
      if (!activeId) { logWarn('No active bot.'); break }
      const { bot, spawnTime, host, port, version } = bots[activeId]
      if (!bot.entity) { logWarn(`${activeId} is not currently spawned.`); break }
      const pos = bot.entity.position
      const uptimeSec = spawnTime ? Math.floor((Date.now() - spawnTime) / 1000) : 0
      logInfo(`Status for ${activeId}:`)
      log(`  Server: ${host}:${port} (v${version})`)
      log(`  Position: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`)
      log(`  Health: ${bot.health ?? 'N/A'}  Food: ${bot.food ?? 'N/A'}`)
      log(`  Ping: ${bot.player?.ping ?? 'N/A'}ms`)
      log(`  Uptime: ${uptimeSec}s`)
      break
    }

    case '/bots': {
      const names = Object.keys(bots)
      if (names.length === 0) {
        logWarn('No bots connected.')
      } else {
        logInfo(`Connected bots (${names.length}):`)
        names.forEach(name => {
          const marker = name === activeId ? '{yellow-fg}⭐{/yellow-fg} ' : '  '
          const status = bots[name].spawnTime ? '{green-fg}online{/green-fg}' : '{gray-fg}connecting{/gray-fg}'
          log(`  ${marker}{cyan-fg}${name}{/cyan-fg} — ${status}`)
        })
      }
      break
    }
    case '/inv': {
      if (!activeId) { logWarn('No active bot.'); break }
      const items = bots[activeId].bot.inventory.items()
      if (items.length === 0) {
        logInfo('Inventory is empty.')
      } else {
        logInfo(`Inventory for ${activeId}:`)
        items.forEach(item => log(`  ${item.count}x ${item.displayName || item.name} (slot ${item.slot})`))
      }
      break
    }

    case '/players': {
      if (!activeId) { logWarn('No active bot.'); break }
      const players = Object.keys(bots[activeId].bot.players)
      logInfo(`Players online (${players.length}):`)
      players.forEach(name => log(`  ${name}`))
      break
    }

    case '/rtp': {
      if (!activeId) { logWarn('No active bot.'); break }
      bots[activeId].bot.chat(RTP_COMMAND)
      logInfo(`Sent ${RTP_COMMAND}`)
      break
    }

    case '/disconnect':
    case '/dc': { 
      if (!activeId) { 
        logWarn('No active bot to disconnect.')
        break 
      }
      
      const targetBot = bots[activeId].bot
      if (targetBot && targetBot._client) {
        logWarn(`Disconnecting ${activeId}...`)
        targetBot.quit()
      } else {
        logWarn(`${activeId} is already disconnected.`)
      }
      break
    }
    case '/exit':
      logWarn('Exiting all bots...')
      Object.values(bots).forEach(({ bot }) => bot.quit())
      setTimeout(() => process.exit(0), 300)
      break

    case '/reconnect': {
      if (!activeId) { logWarn('No active bot.'); break }
      const idToReconnect = activeId
      const { host, port, version } = bots[idToReconnect]
      logWarn(`Reconnecting ${idToReconnect}...`)
      bots[idToReconnect].bot.removeAllListeners()
      bots[idToReconnect].bot.quit()
      setTimeout(() => createBotInstance(idToReconnect, host, port, version), 1000)
      break
    }

    default:
      if (!activeId) { logWarn('No active bot.'); break }
      bots[activeId].bot.chat(trimmed)
      log(`{green-fg}❯{/green-fg} Sent: ${trimmed}`)
  }
}

// ---- Input handling ----
inputBox.on('submit', (input) => {
  const trimmed = input.trim()
  inputBox.clearValue()
  inputBox.focus()
  screen.render()
  if (trimmed.length > 0) handleCommand(trimmed)
})

inputBox.on('cancel', () => {
  // Textbox stops reading input on Escape (or an Escape-prefixed sequence from
  // the terminal, e.g. some Alt/Option combos). Without this handler, typing
  // would randomly stop working until the box was manually re-focused.
  inputBox.clearValue()
  inputBox.focus()
  screen.render()
})

screen.render()
