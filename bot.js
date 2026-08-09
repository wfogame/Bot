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
const bots = {}       // username -> { bot, spawnTime, logs: [], host, port, version }
let activeId = null

function updateHeader() {
  const names = Object.keys(bots)
  const activeLabel = activeId ? `Active: ${activeId}` : 'No active bot'
  const others = names.filter(n => n !== activeId)
  const othersLabel = others.length ? `  |  Others: ${others.join(', ')}` : ''
  header.setContent(`{center}{bold}⛏  MINEFLAYER BOT CONSOLE{/bold}   —   ${activeLabel}${othersLabel}{/center}`)
  screen.render()
}

/**function switchTo(id) {
  if (!bots[id]) {
    log(`{red-fg}✗ No bot named "${id}"{/red-fg}`)
    return
  }
  activeId = id
  logBox.setContent('')
  bots[id].logs.forEach(line => logBox.log(line))
  updateHeader()
  screen.render()
}
*/
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

// ---- Bot creation ----
const HOST = 'play.fatalmc.org'
const PORT = 25565
const VERSION = '1.21.1'

/**function createBotInstance(username, host = HOST, port = PORT, version = VERSION) {
  const id = username

  const s = (msg) => logFor(id, `{green-fg}✓ ${msg}{/green-fg}`)
  const e = (msg) => logFor(id, `{red-fg}✗ ${msg}{/red-fg}`)
  const i = (msg) => logFor(id, `{cyan-fg}› ${msg}{/cyan-fg}`)
  const w = (msg) => logFor(id, `{yellow-fg}⚠ ${msg}{/yellow-fg}`)
  const c = (msg) => logFor(id, `{white-fg}${msg}{/white-fg}`)

  const bot = mineflayer.createBot({
    host,
    port,
    username: id,
    version
  })

  bots[id] = { bot, spawnTime: null, logs: [], host, port, version }

  bot.once('spawn', () => {
    bots[id].spawnTime = Date.now()
    s(`Bot has spawned and is connected to ${host}:${port} (v${version}).`)

    setTimeout(() => {
    bot.chat('/register 123456 123456')
    }, 270);

    setTimeout(() => {
    bot.chat('/login 123456')
    }, 1300);
    setTimeout(() => {
      i('Right-clicking compass (server selector)...')
      bot.activateItem()
    }, 3600)
  })

  bot.on('windowOpen', (window) => {
    i(`Window opened: ${window.title}`)
    const targetSlot = 11
    setTimeout(async () => {
      try {
        await bot.clickWindow(targetSlot, 0, 0)
        i(`Clicked slot ${targetSlot}`)
      } catch (err) {
        e(`Click failed: ${err}`)
      }
      setTimeout(() => {
        bot.chat('/warp afk')
        s('Sent /warp afk')
      }, 10000)
    }, 2000)
  })

  bot.on('message', (jsonMsg) => c(jsonMsg.toString()))
  bot.on('kicked', (reason) => e(`Kicked: ${JSON.stringify(reason)}`))
  bot.on('error', (err) => e(`Error: ${err}`))
  bot.on('end', () => w('Disconnected.'))

  if (!activeId) activeId = id
  updateHeader()

  return bot
}
*/
/**function createBotInstance(username, host = HOST, port = PORT, version = VERSION) {
  const id = username

  const s = (msg) => logFor(id, `{green-fg}✓ ${msg}{/green-fg}`)
  const e = (msg) => logFor(id, `{red-fg}✗ ${msg}{/red-fg}`)
  const i = (msg) => logFor(id, `{cyan-fg}› ${msg}{/cyan-fg}`)
  const w = (msg) => logFor(id, `{yellow-fg}⚠ ${msg}{/yellow-fg}`)
  const c = (msg) => logFor(id, `{white-fg}${msg}{/white-fg}`)

  const bot = mineflayer.createBot({
    host,
    port,
    username: id,
    version,
    hideErrors: true
  })

  bots[id] = { bot, spawnTime: null, logs: [], host, port, version }

  // ---- Timeout tracking for cleanup ----
  const timeouts = []
  const pushT = (fn, delay) => {
    const t = setTimeout(fn, delay)
    timeouts.push(t)
    return t
  }
  const clearAll = () => {
    timeouts.forEach(clearTimeout)
    timeouts.length = 0
  }

  // Only send chat if bot is actually spawned and socket is alive
  const safeChat = (msg) => {
    if (bot.entity && bot._client?.writable) bot.chat(msg)
  }

*/
/*
function createBotInstance(username, host = HOST, port = PORT, version = VERSION) {
  const id = username
  let connected = false   // <-- track real state ourselves

  const s = (msg) => logFor(id, `{green-fg}✓ ${msg}{/green-fg}`)
  const e = (msg) => logFor(id, `{red-fg}✗ ${msg}{/red-fg}`)
  const i = (msg) => logFor(id, `{cyan-fg}› ${msg}{/cyan-fg}`)
  const w = (msg) => logFor(id, `{yellow-fg}⚠ ${msg}{/yellow-fg}`)
  const c = (msg) => logFor(id, `{white-fg}${msg}{/white-fg}`)

  const bot = mineflayer.createBot({ host, port, username: id, version, hideErrors: true })

  bots[id] = { bot, spawnTime: null, logs: [], host, port, version }

  const timeouts = []
  const pushT = (fn, delay) => { const t = setTimeout(fn, delay); timeouts.push(t); return t }
  const clearAll = () => { timeouts.forEach(clearTimeout); timeouts.length = 0 }

  const safeChat = (msg) => {
    if (connected && bot.entity) bot.chat(msg)

  }


  bot.once('login', () => {
    connected = true
    i('Server accepted connection, sending auth...')
    pushT(() => bot.chat('/register 123456 123456'), 200 + Math.random() * 300)
    pushT(() => bot.chat('/login 123456'), 1220 + Math.random() * 400)
  })

  bot.once('spawn', () => {
    connected = true
    bots[id].spawnTime = Date.now()
    s(`Bot has spawned and is connected to ${host}:${port} (v${version}).`)

    pushT(() => { i('Right-clicking compass (server selector)...'); bot.activateItem() }, 3600 + Math.random() * 600)

  })
 bot._client.on('error', (err) => {
  if (err.message.includes('partial packet') || err.message.includes('Chunk size')) {
    // Silently eat the parser error caused by the proxy transfer
    logWarn(`Swallowed proxy transfer parser error: ${err.message}`);
    return;
  }
  // Let other errors pass through
  e(`Client Error: ${err.message}`);
}); 
  bot.on('windowOpen', (window) => {
    const title = window.title?.toString ? window.title.toString() : String(window.title)
    i(`Window opened: ${title} (${window.slots.length} slots)`)

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
        safeChat('/warp afk')
        s('Sent /warp afk')
      }, 8000 + Math.random() * 4200)
    }, 2000 + Math.random() * 1600)
  })

  bot.on('message', (jsonMsg) => c(jsonMsg.toString()))
 bot.on('kicked', (reason) => { connected = false; e(`Kicked: ${JSON.stringify(reason)}`); clearAll() })
  bot.on('error', (err) => { connected = false; e(`Error: ${err.message || err}`); clearAll() })
  bot.on('end', () => { connected = false; w('Disconnected.'); clearAll() })
  if (!activeId) activeId = id
  updateHeader()

  return bot
}
*/
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

  // 1. Clean up existing bot listeners before re-instantiating
  if (bots[id]?.bot) {
    bots[id].bot.removeAllListeners()
    if (bots[id].bot._client) bots[id].bot._client.removeAllListeners()
  }

  // Preserve existing log history across reconnects
  const existingLogs = bots[id]?.logs || []

  const bot = mineflayer.createBot({ host, port, username: id, version, hideErrors: true })

  bots[id] = { bot, spawnTime: null, logs: existingLogs, host, port, version }

  const timeouts = []
  const pushT = (fn, delay) => { const t = setTimeout(fn, delay); timeouts.push(t); return t }
  const clearAll = () => { timeouts.forEach(clearTimeout); timeouts.length = 0 }

  const scheduleReconnect = (reason) => {
    clearAll()
    connected = false
    if (manualDisconnect || reconnectTimer) return

    const delay = 5000 + Math.floor(Math.random() * 3000)
    w(`${reason}. Auto-reconnecting in ${(delay / 1000).toFixed(1)}s...`)

    reconnectTimer = setTimeout(() => {
      createBotInstance(id, host, port, version)
    }, delay)
  }

  const safeChat = (msg) => {
    if (connected && bot.entity) bot.chat(msg)
  }

  // 2. Auth triggers immediately on socket connection
  bot.once('login', () => {
    i('Connected to server socket. Sending auth commands...')
    pushT(() => bot.chat('/register 123456 123456'), 200 + Math.random() * 300)
    pushT(() => bot.chat('/login 123456'), 1220 + Math.random() * 400)
  })

  // 3. World interactions trigger only after physical spawn
  bot.once('spawn', () => {
    connected = true
    bots[id].spawnTime = Date.now()
    s(`Bot has spawned and is connected to ${host}:${port} (v${version}).`)

    pushT(() => { 
      i('Right-clicking compass (server selector)...')
      bot.activateItem() 
    }, 3600 + Math.random() * 600)
  })

  // 4. GUI Navigation
  bot.on('windowOpen', (window) => {
    const title = window.title?.toString ? window.title.toString() : String(window.title)
    i(`Window opened: ${title} (${window.slots.length} slots)`)

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
        safeChat('/warp afk')
        s('Sent /warp afk')
      }, 8000 + Math.random() * 4200)
    }, 2000 + Math.random() * 1600)
  })

  // 5. Output logging & automatic reconnection trigger
  bot.on('message', (jsonMsg) => c(jsonMsg.toString()))
  bot.on('kicked', (reason) => e(`Kicked: ${JSON.stringify(reason)}`))
  bot.on('error', (err) => e(`Error: ${err.message || err}`))
  
  bot.on('end', () => {
    connected = false
    w('Disconnected.')
    scheduleReconnect('Connection lost')
  })

  // 6. Manual disconnect method attached to object
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
  'LnuxOtocael'
]

const CONNECT_DELAY_MS = 39500  // tweak this if needed (3-5s usually safe)

BOT_NAMES.forEach((name, index) => {
  setTimeout(() => {
    createBotInstance(name)
    if (index === 0) switchTo(name)  // switch to first once it starts
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

    case '/disconnect':
    case '/dc': { // Allowing /dc as a quick alias
      if (!activeId) { 
        logWarn('No active bot to disconnect.')
        break 
      }
      
      const targetBot = bots[activeId].bot
      if (targetBot && targetBot._client) {
        logWarn(`Disconnecting ${activeId}...`)
        targetBot.quit()
        // Your existing bot.on('end') event will automatically fire 
        // to handle state cleanup and log "Disconnected."
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

screen.render()
