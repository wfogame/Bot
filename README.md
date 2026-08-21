# Mineflayer TUI Multi-Bot Manager

A terminal-based multi-bot manager for Minecraft, built with Node.js, [Mineflayer](https://github.com/PrismarineJS/mineflayer) and [neo-blessed](https://github.com/chjj/blessed).

It connects and manages multiple Minecraft bots at once through a single Terminal User Interface (TUI), with automatic server authentication, GUI navigation (compass clicking), independent per-bot logging, and advanced features like base detection, player tracking, and Discord alerts.

## Features

### `bot.js` — AFK Console

- **Interactive TUI** — view logs, send commands, and monitor bots without terminal spam.
- **Multi-bot management** — connect any number of bots, staggered on startup to avoid anti-bot throttling.
- **Auto-authentication** — sends `/register` and `/login` automatically before spawning in.
- **Auto-navigation** — right-clicks a server-selector compass and clicks a configured GUI slot after spawn.
- **Auto-reconnect** — any disconnect (kick, error, dropped socket) is retried automatically, with exponential backoff.
- **Isolated state** — each bot keeps its own log history, connection state, and timers.
- **Outbound proxy support** — route all bot connections through a SOCKS5 or HTTP proxy.

### `bot-rtp.js` — RTP + Base Finder

- Everything from `bot.js` **plus**:
- **Automatic Random Teleport (RTP)** — bots RTP at configurable intervals to explore and gather resources.
- **Base detection** — scans for storage blocks (chests, barrels, shulker boxes, anvils, enchanting tables) and alerts when a base is found.
- **Totem management** — automatically equips Totems of Undying in the offhand; alerts when one pops.
- **Auto-eat** — keeps hunger above a threshold by automatically consuming food.
- **Player proximity alerts** — warns when other players come within range.
- **Discord webhook integration** — sends real-time alerts for bases, totem pops, player proximity, and RTP locations.
- **RTP location history** — tracks visited chunk areas to detect repeated spawns.

## Prerequisites

- Node.js v18+
- A Minecraft server to connect to
- A `.env` file with configuration (see below)

## Quick Start

### 1. Clone and Install

```bash
git clone <repository-url>
cd Bot
npm install
```

### 2. Create `.env` File

**You MUST create a `.env` file after cloning.** Copy the example below and customize it:

```bash
# Server connection
HOST=play.fatalmc.org
PORT=25565
VERSION=1.21.2
LOGIN_PASSWORD=your_password_here

# Bot names (comma-separated, no spaces after commas)
BOT_NAMES=Bot1,Bot2,Bot3

# Connection timing
CONNECT_DELAY_MS=39500

# GUI navigation
GUI_SLOT=11

# Optional: Outbound proxy
# PROXY_HOST=proxy.example.com
# PROXY_PORT=1080
# PROXY_TYPE=socks5
```

### 3. Run

```bash
# Run the AFK bot console
node bot.js

# OR run the RTP + base finder (with bot-rtp.js settings)
node bot-rtp.js
```

## Configuration

### `.env` Variables

All configuration is done via the `.env` file in the root directory.

#### Common to Both Scripts

| Variable | Default | Description |
|---|---|---|
| `HOST` | `play.fatalmc.org` | Target server address |
| `PORT` | `25565` | Target server port |
| `VERSION` | `1.21.2` (bot.js) / `1.21.1` (bot-rtp.js) | Minecraft protocol version |
| `LOGIN_PASSWORD` | `123456` | Password for all bots to use for `/register` and `/login` |
| `BOT_NAMES` | (required) | Comma-separated bot usernames (e.g., `Bot1,Bot2,Bot3`) |
| `CONNECT_DELAY_MS` | `39500` | Milliseconds to wait between each bot's initial connection |
| `GUI_SLOT` | `11` | Inventory slot number to click in the server-selector GUI (0-indexed) |

#### Proxy (Optional)

| Variable | Default | Description |
|---|---|---|
| `PROXY_HOST` | (empty) | Outbound proxy server address; leave empty for direct connection |
| `PROXY_PORT` | `1080` | Outbound proxy port |
| `PROXY_TYPE` | `socks5` | Proxy type: `socks5` or `http` |

> **Note:** If `PROXY_TYPE=socks5`, you need to install the `socks` package: `npm install socks`

#### `bot-rtp.js` Only

| Variable | Default | Description |
|---|---|---|
| `BOT_RTP_BOTS` | `S3gF4ult_0x00, Hypr_P4ck3t_X, Nul1_P01nt3r, H3adl3ss_T1ck, F1shyShellArch` | Override default RTP bot names |
| `MODE` | `roam` | `roam` to enable RTP/base scanning, or `afk` for idle mode |
| `RTP_COMMAND` | `/rtp world world` | Command to send for random teleport |
| `RTP_INTERVAL_MS` | `34800` | Milliseconds between RTP commands (plus random jitter) |
| `BASE_SCAN_INTERVAL_MS` | `12000` | Milliseconds between base scans |
| `BASE_SCAN_RADIUS` | `256` | Maximum block distance for base detection |
| `BASE_ALERT_THRESHOLD` | `4` | Minimum storage blocks in a chunk to trigger an alert |
| `RTP_PAUSE_ON_BASE_MS` | `600000` | How long to pause RTP after finding a base (10 minutes default) |
| `PLAYER_PROXIMITY_RADIUS` | `32` | Blocks away to consider a player "nearby" |
| `PLAYER_PROXIMITY_INTERVAL_MS` | `5000` | Milliseconds between player proximity checks |
| `PLAYER_PROXIMITY_COOLDOWN_MS` | `300000` | Cooldown between alerts for the same player |
| `FOOD_CHECK_INTERVAL_MS` | `5000` | Milliseconds between food checks |
| `FOOD_EAT_THRESHOLD` | `18` | Hunger level below which the bot auto-eats |

#### Discord Alerts (`bot-rtp.js` only)

| Variable | Default | Description |
|---|---|---|
| `DISCORD_WEBHOOK_URL` | (empty) | Discord webhook URL for alerts; leave empty to disable |
| `DISCORD_USER_ID` | (empty) | Discord user ID to mention in alerts (optional) |

> To get a Discord webhook URL: [Create a webhook in your Discord server](https://support.discord.com/hc/en-us/articles/228383668-Webhooks-Basics)

### Example `.env` for `bot.js`

```
HOST=localhost
PORT=25565
VERSION=1.21.2
LOGIN_PASSWORD=secretpassword
BOT_NAMES=Alice,Bob,Charlie
CONNECT_DELAY_MS=40000
GUI_SLOT=11
```

### Example `.env` for `bot-rtp.js`

```
HOST=play.example.com
PORT=25565
VERSION=1.21.1
LOGIN_PASSWORD=mysecret
BOT_RTP_BOTS=Scout1,Scout2,Scout3
MODE=roam
RTP_COMMAND=/rtp world world
RTP_INTERVAL_MS=35000
BASE_SCAN_INTERVAL_MS=10000
BASE_SCAN_RADIUS=256
BASE_ALERT_THRESHOLD=3
PLAYER_PROXIMITY_RADIUS=48
FOOD_EAT_THRESHOLD=15
DISCORD_WEBHOOK_URL=https://discordapp.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
DISCORD_USER_ID=123456789
PROXY_HOST=
PROXY_PORT=1080
```

## Running the Bots

### Start `bot.js`

```bash
node bot.js
```

The console will:

1. Load all `BOT_NAMES` from `.env`
2. Connect them in staggered intervals (`CONNECT_DELAY_MS`)
3. Auto-authenticate each bot
4. Navigate to the warp/teleport GUI

### Start `bot-rtp.js`

```bash
node bot-rtp.js
```

Same startup sequence, but after GUI navigation:

- Begins RTP exploration
- Scans for bases and logs findings to Discord
- Manages food and totems automatically
- Checks for nearby players

## The Interface

### Layout

```
┌─────────────────────────────────────────────────────┐
│  ⛏  MINEFLAYER AFK CONSOLE  —  Active: [1] Bot1    │
├─────────────────────────────────────────────────────┤
│                                                       │
│  [Activity Log - scrollable]                        │
│                                                       │
│  [← scroll up to see older logs]                    │
│                                                       │
├─────────────────────────────────────────────────────┤
│ ❯ Command: _                                        │
└─────────────────────────────────────────────────────┘
```

- **Header** — shows active bot and list of other connected bots (switch with `/switch`)
- **Log Box** — displays events, chat, and errors for the active bot only; scrollable with mouse or arrow keys
- **Input Box** — type commands or chat messages; use `Up`/`Down` arrows to cycle history; `Tab` to autocomplete

## Commands

### Universal Commands (Both Scripts)

| Command | Description |
|---|---|
| `/help` | List all available commands |
| `/list` | Show online/offline status for all bots |
| `/status` | Active bot's position, health, food, ping, uptime |
| `/inv` | Active bot's inventory contents |
| `/players` | Online players from the active bot's view |
| `/disconnect`, `/dc` | Disconnect active bot (stops auto-reconnect) |
| `/reconnect` | Manually reconnect the active bot |
| `/reconnect-all` | Reconnect all offline bots |
| `/switch <id>` | Switch view to another bot by name or list number |
| `/uptime` | Show uptime for all bots |
| `/proxy` | Display current proxy configuration |
| `/all <cmd>` | Run a local command on every bot, or broadcast chat to all |
| `/chat <msg>` | Send a message (won't be misread as a command) |
| `/new-bot <name>` | Create and connect a new bot at runtime |
| `/clear` | Clear active bot's log view |
| `/exit` | Disconnect all bots and close the program |

### RTP-Only Commands (`bot-rtp.js`)

| Command | Description |
|---|---|
| `/rtp` | Manually send the RTP command from active bot |
| `/overview` | Dashboard showing all bots' health, food, ping, shard count |
| `/mem` | Show memory usage and log/history statistics |

## Event Flow & Startup Sequence

### On Connect

1. **Login** — bot connects to server socket
2. **Auth** — listens for `/register` or `/login` prompts; sends `LOGIN_PASSWORD` automatically
3. **Spawn** — bot appears in world; right-clicks compass (held item)
4. **Window Open** — detects GUI window; clicks `GUI_SLOT`; waits for server transfer

### After Spawn (bot.js)

- Bot stays idle, listening for commands via the TUI

### After Spawn (bot-rtp.js, if `MODE=roam`)

- Sends `RTP_COMMAND` and waits 5 seconds for teleport
- Enters roaming loop:
  - Scans for bases every `BASE_SCAN_INTERVAL_MS`
  - Checks for nearby players every `PLAYER_PROXIMITY_INTERVAL_MS`
  - Manages food every `FOOD_CHECK_INTERVAL_MS`
  - Auto-equips totems continuously
  - Schedules next RTP at `RTP_INTERVAL_MS` (plus random jitter)

## Reconnect Behavior

Every disconnect triggers a reconnect with exponential backoff:

```
delay = min(base_delay × 1.3^attempt, max_delay)
```

- **Proxy transfer crash** (detected via pattern matching): flat 3–10 second delay, no backoff increment
- **Real kick / error**: exponential backoff starting at 8–10 seconds, up to 5 minutes
- **Stable for 60 seconds**: attempt counter resets to 0

This continues indefinitely; there is no give-up point.

## Troubleshooting

### Program exits immediately on startup

**"No BOT_NAMES defined in .env"**

- Create a `.env` file with `BOT_NAMES=Bot1,Bot2`
- Do not include spaces after commas

**"Failed to load module"**

- Run `npm install` to install dependencies
- Check that Node.js v18+ is installed: `node --version`

### Bots get kicked immediately

- Increase `CONNECT_DELAY_MS` to spread out connections (try `60000`)
- Server may have anti-bot throttling enabled

### "Cannot read properties of null" or "socket hang up"

- This often happens during Velocity/BungeeCord server transfers
- The bot detects these as "proxy transfer crashes" and retries automatically with a fast reconnect (3–10 seconds)
- If it repeats, check server logs or increase `RTP_PAUSE_ON_BASE_MS` to pause exploration longer

### Bots connect but don't proceed past spawn

- Check that `GUI_SLOT` is correct for your server's compass GUI (usually 11)
- Verify the GUI has at least `GUI_SLOT + 1` items
- Check server logs; the bot may need a delay between compass click and GUI slot click

### Discord webhook alerts aren't sending

- Verify `DISCORD_WEBHOOK_URL` is valid and not expired
- Check that Node.js v18+ supports `fetch()` globally
- Look in the bot's log for `[discord]` error messages

### High memory usage

- Use `/mem` command to see breakdown
- Increase `BASE_SCAN_RADIUS` to reduce block checks (or lower it to scan more)
- Restart the bot to clear accumulated logs

## Dependencies

- **[mineflayer](https://github.com/PrismarineJS/mineflayer)** — Minecraft bot API
- **[neo-blessed](https://github.com/chjj/blessed)** — Terminal UI framework
- **[mineflayer-armor-manager](https://github.com/PrismarineJS/mineflayer-armor-manager)** — Auto-equip armor plugin
- **[dotenv](https://github.com/motdotla/dotenv)** — `.env` file loader
- **[socks](https://github.com/JoshGlazebrook/socks)** — SOCKS5 proxy support (optional, only needed if `PROXY_TYPE=socks5`)

## Installation Command

```bash
npm install mineflayer neo-blessed mineflayer-armor-manager dotenv
```

For SOCKS5 proxy support:

```bash
npm install socks
```

## License

This project is provided as-is. Use it at your own risk on your Minecraft servers.

---

**Questions or issues?** Check the server logs and the bot's activity log in the TUI for error messages. Most issues are related to:

1. Missing or incorrect `.env` file
2. Wrong server address / port / version
3. `BOT_NAMES` format (no spaces, comma-separated)
4. Firewall or proxy blocking connections
FOR THE RENDER BRANCH MAKE SURE TO SETUP UPTIME bot, to ping it otherwise it will go offline in 15 minutes DW IT IS FREE <https://uptimerobot.com/> NOT SPONSERED set it to 12 minutes not 5 minutes
