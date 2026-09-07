# Minecraft Multi-Bot Console

Node.js tools for running and supervising multiple Mineflayer bots. The main
entry point, `bot.js`, provides both a browser dashboard and an optional
terminal UI. `bot-rtp.js` is the exploration-oriented variant with RTP,
base detection, survival helpers, and Discord alerts.

## What This Repository Does

### `bot.js`

- Connects multiple Minecraft accounts with staggered startup timing.
- Automatically responds to `/register` and `/login` prompts.
- Handles server-selector GUI navigation and configurable crate selection.
- Keeps per-bot logs, status, reconnect state, and command history.
- Reconnects after kicks, socket failures, and common proxy-transfer crashes.
- Supports direct connections, SOCKS5 proxies, and HTTP CONNECT proxies.
- Serves an authenticated browser dashboard over HTTP/WebSocket.
- Provides an optional `neo-blessed` terminal UI when attached to a TTY.

### `bot-rtp.js`

The RTP variant shares the connection and management model, then adds:

- Scheduled random teleporting.
- Storage/base scanning.
- Nearby-player alerts.
- Auto-eating and totem handling.
- Discord webhook notifications.
- RTP location history.

## Requirements

- Node.js 18 or newer.
- Access to the Minecraft server you want to connect to.
- One or more bot usernames.
- A `.env` file in the repository root.

## Install

```bash
npm install
```

The `postinstall` script applies the repository's Mineflayer patch:

```bash
npm run postinstall
```

The patch is included for the server/proxy behavior this project targets. Do
not omit it when setting up a fresh environment.

## Minimal Configuration

Create `.env` in the repository root:

```dotenv
HOST=play.example.com
PORT=25565
VERSION=1.21.2
LOGIN_PASSWORD=replace-me
BOT_NAMES=BotOne,BotTwo
```

Never commit `.env`, passwords, proxy credentials, or Discord webhook URLs.

## Start

```bash
# Browser dashboard plus TUI when a terminal is attached
npm start

# RTP/base-finder variant
node bot-rtp.js
```

`BOT_NAMES` is required by `bot.js`. If it is missing or empty, the process
exits instead of starting with no managed bots.

## Docker

The Docker helper uses numbered environment files. Create `.env.docker1`,
`.env.docker2`, and so on; each file starts one container. Copy only valid
`KEY=VALUE` lines into these files; the repository `.env` may contain notes or
section headings that Docker rejects:

```bash
# Create .env.docker1 manually, or copy it and remove all non-KEY=VALUE lines.
./run-docker.sh
```

The helper builds the image, starts Tor when the local proxy is enabled, and
maps each container's web port to the next available host port. Use these
commands to inspect or stop the managed containers:

```bash
./run-docker.sh status
./run-docker.sh logs 1
./run-docker.sh stop
```

Do not use a plain `.env.docker`; only `.env.dockerN` files are discovered.
Docker env files must contain `KEY=VALUE` lines or comments beginning with
`#`.

### SSH terminal

The browser TERMINAL tab is disabled unless both `SSH=true` and
`WEB_TERMINAL_ENABLED=true` are set. When enabled, it opens a shell on the
configured main host through SSH; it does not open a shell in the bot
container. The main host must already run an SSH service reachable from the
container:

```dotenv
SSH=true
WEB_TERMINAL_ENABLED=true
SSH_HOST=host.docker.internal
SSH_PORT=22
SSH_USER=replace-me
SSH_PASSWORD=replace-me
# Required unless SSH_SKIP_HOST_KEY_VERIFY=true is explicitly chosen.
SSH_HOST_KEY_FINGERPRINT=SHA256:replace-me
# Optional key authentication instead of SSH_PASSWORD.
# SSH_PRIVATE_KEY_FILE=/run/secrets/main-host-key
# SSH_KEY_PASSPHRASE=replace-me
SSH_READY_TIMEOUT_MS=10000
```

Host-key verification is required by default. Set `SSH_HOST_KEY_FINGERPRINT`
to the main host's SSH SHA-256 fingerprint. Disabling verification with
`SSH_SKIP_HOST_KEY_VERIFY=true` is insecure. For production, use a dedicated
unprivileged SSH account and key-based authentication. SSH passwords and keys
are never written to logs or documentation. When `SSH=false`, no SSH or local
shell process is started.
The Docker helper adds the Linux host-gateway mapping when the default
`host.docker.internal` address is used.

## Interfaces

### Browser dashboard

The web dashboard is enabled by default. It provides:

- Bot cards with online state, health, food, ping, uptime, and ping history.
- `ALL`, `SYSTEM`, and per-bot log views.
- Searchable logs and command suggestions.
- A browser terminal when explicitly enabled.
- WebSocket updates with HTTP polling fallback.
- Persistent command history shared with the terminal UI.

The dashboard listens on `WEB_BIND` and starts at `WEB_PORT`. If the selected
port is unavailable, it tries subsequent ports automatically. At startup, a
random login password is generated when `WEB_PASSWORD` is not set; read the
startup output and set a fixed password for long-running deployments.

The log view follows new messages automatically. Scrolling upward pauses
following so older messages can be read; sending a command or selecting the
bottom action resumes following.

### Terminal UI

The TUI is enabled automatically when stdout is a TTY. Set it explicitly when
needed:

```dotenv
TUI_GUI=true
WEB_GUI=true
```

For a web-only process:

```dotenv
TUI_GUI=false
WEB_GUI=true
```

## `bot.js` Configuration

### Connection and startup

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `play.fatalmc.org` | Minecraft server host |
| `PORT` | `25565` | Minecraft server port |
| `VERSION` | `1.21.2` | Minecraft protocol version |
| `LOGIN_PASSWORD` | `123456` | Password sent to register/login prompts |
| `BOT_NAMES` | required | Comma-separated bot usernames |
| `CONNECT_DELAY_MS` | `39500` | Delay between initial bot connections |
| `CONNECT_DELAY_RANDOM_MS` | `0` | Additional random delay range |
| `MAX_RECONNECT` | `17` | Maximum normal reconnect attempts |
| `SERVER_COMMAND` | empty | Command sent after spawn instead of compass navigation |
| `CLICK_COMPASS` | empty | Set to enable compass activation after spawn |

### GUI and crate automation

| Variable | Default | Purpose |
| --- | --- | --- |
| `GUI_SLOT` | `11` | Fallback inventory slot, zero-indexed |
| `GUI_ITEM_SEARCH_ENABLED` | `false` | Search GUI item names instead of using only `GUI_SLOT` |
| `GUI_ITEM_SEARCH_TERMS` | `fatal\|red;crate\|key\|candle` | Semicolon-separated AND groups, pipe-separated OR terms |
| `WARP_COMMAND` | `/warp afk` | Destination after GUI/crate handling |
| `WARP_BEFORE_CRATE` | `true` | Warp to the crate location before scanning |
| `CRATE_COMMAND` | `/warp crates` | Command used to reach the crate area |
| `CRATE_SHULKER_BLOCK` | `red_shulker_box` | Default shulker block target |
| `CRATE_SCAN_RADIUS` | `20` | Maximum crate scan distance |
| `CRATE_REACH` | `3.5` | Maximum walking distance from a crate |

Search terms are case-insensitive. For example:

```dotenv
GUI_ITEM_SEARCH_ENABLED=true
GUI_ITEM_SEARCH_TERMS=legendary;crate|box
```

This matches an item containing `legendary` and either `crate` or `box`. If no
item matches, the bot falls back to `GUI_SLOT`.

### Proxy

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_HOST` | empty | Enables outbound proxying when set |
| `PROXY_PORT` | `1080` | Proxy port |
| `PROXY_TYPE` | `socks5` | `socks5` or `http` |
| `PROXY_STALL_WATCHDOG` | enabled | Set to `0` to disable stall recovery |
| `PROXY_STALL_TIMEOUT_MS` | `90000` | Silence period before forcing reconnect |
| `PROXY_STALL_CHECK_MS` | `20000` | Watchdog polling interval |
| `PROXY_STALL_RATIO` | `0.5` | Fraction of stalled bots that triggers proxy restart |
| `PROXY_RESTART_CMD` | local Tor restart when applicable | Optional proxy restart command |

### Web dashboard

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEB_GUI` | `true` | Enable the browser dashboard |
| `WEB_BIND` | `0.0.0.0` | Listening interface |
| `WEB_PORT` | `80` | Starting HTTP port |
| `WEB_PORT_MAX_ATTEMPTS` | `20` | Number of fallback ports |
| `WEB_PASSWORD` | generated | Dashboard login password |
| `WEB_SESSION_HOURS` | `12` | Sliding session lifetime |
| `WEB_LOGIN_MAX_FAILS` | `10` | Failed logins before temporary lockout |
| `WEB_TERMINAL_ENABLED` | `false` | Allow the browser terminal |
| `WEB_TERMINAL_LOG` | `true` | Include web server trace messages |
| `WS_BROADCAST_INTERVAL_MS` | `100` | WebSocket log batching interval |
| `LOG_MAX_LINES` | `5000` | Stored lines per bot/system channel |
| `WINDOW_DEBUG` | `false` | Include complete inventory slot dumps |
| `CONFIG_PACKET_LOG_LIMIT` | `120` | Configuration packet log limit; `0` means unlimited |

## Commands

Commands typed in the browser or TUI apply to the selected bot unless noted.
Any unrecognized input is sent as a Minecraft chat message or command.

| Command | Description |
| --- | --- |
| `/help` | Show the command list |
| `/list` | Show all bots and their connection state |
| `/status` | Show position, health, food, ping, and uptime |
| `/stats` | Show process memory, event-loop lag, log rate, viewers, and uptime |
| `/overview` | Query shards, coins, and balance for every bot |
| `/inv` | List the active bot's inventory |
| `/players` | List players visible to the active bot |
| `/uptime` | Show uptime for every bot |
| `/proxy` | Show proxy and stall-watchdog configuration |
| `/switch <id>` | Select a bot by name or list number |
| `/new-bot <name> [host] [port] [version]` | Create a bot at runtime |
| `/chat <message>` | Send a chat message without local command parsing |
| `/all <command>` | Run a local command on every bot or broadcast chat |
| `/clear` | Clear the active bot's stored log view |
| `/disconnect`, `/dc` | Stop the active bot and automatic reconnect |
| `/reconnect` | Reconnect the active bot |
| `/reconnect-all` | Reconnect currently offline bots |
| `/reconnect-all-slow` | Reconnect all bots with a configurable stagger |
| `/closeBot` | Disconnect and remove the active bot |
| `/dump` | TPA and deposit inventory into nearby chests |
| `/crates [color]` | Run one crate collection cycle |
| `/crates-loop [n] [color]` | Repeat crate collection |
| `/crates-all [n] [color]` | Run shardshop, crates, and dump across bots |
| `/crates-solo [bot] [color]` | Run that sequence for one bot |
| `/exit` | Disconnect all bots and exit |

Valid crate colors include `white`, `orange`, `magenta`, `light_blue`,
`yellow`, `lime`, `pink`, `gray`, `light_gray`, `cyan`, `purple`, `blue`,
`brown`, `green`, `red`, and `black`. A color may be written as a bare name or
as a full block name such as `purple_shulker_box`.

## Reconnect Behavior

Normal disconnects use exponential backoff, capped at five minutes. Common
Velocity/Bungee transfer failures use a fast reconnect path and do not consume
the normal retry budget. After a bot remains stable for 60 seconds, its normal
retry counter is reset.

The proxy stall watchdog can destroy a silent raw socket so the existing
reconnect flow can recover it. When many bots stall together, the configured
proxy restart command may run.

## `bot-rtp.js` Settings

The RTP variant has additional settings, including:

| Variable | Purpose |
| --- | --- |
| `BOT_RTP_BOTS` | Bot names for the RTP runner |
| `MODE` | `roam` for exploration or `afk` for idle operation |
| `RTP_COMMAND` | Random teleport command |
| `RTP_INTERVAL_MS` | Time between RTP attempts |
| `BASE_SCAN_INTERVAL_MS` | Base scan interval |
| `BASE_SCAN_RADIUS` | Base scan radius |
| `BASE_ALERT_THRESHOLD` | Storage count required for an alert |
| `RTP_PAUSE_ON_BASE_MS` | Pause duration after a base finding |
| `PLAYER_PROXIMITY_RADIUS` | Nearby-player distance |
| `PLAYER_PROXIMITY_INTERVAL_MS` | Nearby-player check interval |
| `PLAYER_PROXIMITY_COOLDOWN_MS` | Repeat-alert cooldown |
| `FOOD_CHECK_INTERVAL_MS` | Hunger check interval |
| `FOOD_EAT_THRESHOLD` | Hunger threshold for auto-eating |
| `DISCORD_WEBHOOK_URL` | Discord webhook; empty disables alerts |
| `DISCORD_USER_ID` | Optional Discord mention target |

## Keep-Alive Hosting

For a free hosted deployment, configure [UptimeRobot](https://uptimerobot.com/)
to request the bot's `/health` endpoint. Set the monitor interval to **12
minutes**, not 5 minutes. The endpoint returns `ok` and does not require a
dashboard login.

## Troubleshooting

### The process exits immediately

Check that `.env` exists and contains a non-empty `BOT_NAMES` value. Then run
`npm install` and confirm Node.js is version 18 or newer.

### The browser dashboard does not open

Read the startup log for the actual fallback port. Port 80 may be unavailable
for an unprivileged process, in which case the server automatically tries the
next ports. Also check the container or host port-forwarding rules.

### The browser log will not scroll

Restart the process after source changes so the embedded dashboard HTML is
regenerated, then refresh the browser. The dashboard follows new logs until
you scroll upward manually; sending a command resumes following.

### Bots are kicked during connection or transfer

Increase `CONNECT_DELAY_MS`, confirm `VERSION` matches the server, and inspect
the per-bot log for protocol or proxy-transfer errors. If a proxy is used,
check its stability and the stall-watchdog settings.

### GUI navigation does not select the expected item

Confirm `GUI_SLOT` is zero-indexed and inspect the opened inventory. Enable
`WINDOW_DEBUG=true` temporarily for slot details, or enable item search with
`GUI_ITEM_SEARCH_ENABLED=true` and suitable search terms.

### Discord alerts are missing in the RTP runner

Check `DISCORD_WEBHOOK_URL`, verify that the webhook is active, and inspect the
RTP log for webhook errors. Node.js 18+ is required for the built-in `fetch`.

## Project Files

| File | Role |
| --- | --- |
| `bot.js` | Main multi-bot manager and web/TUI dashboard |
| `bot-rtp.js` | RTP, scanning, survival helpers, and Discord alerts |
| `package.json` | Dependencies and startup/postinstall scripts |
| `Dockerfile` | Container image definition |
| `docker-entrypoint.sh` | Container startup entrypoint |
| `run-docker.sh` | Local Docker run helper |
| `patches/` | Mineflayer compatibility patches |
| `api.md` | Mineflayer API reference used by the project |

## License

This project is provided as-is. Use it only on servers and accounts you are
authorized to automate.

## Discord Alerts and Memory Watchdog

The main bot runner can send Discord webhook alerts for 30-second server restart warnings, kicks, unexpected disconnects, successful recovery, exhausted reconnect limits, proxy stalls, dashboard login lockouts, fatal process errors, and host memory pressure. Set `DISCORD_WEBHOOK_URL` and `DISCORD_USER_ID` in `.env`.

The restart detector requires both the case-insensitive phrase `SERVER WILL RESTART IN` and the standalone number `30` in the same server message. Duplicate alerts are suppressed for the configured cooldown.

The memory watchdog uses Linux `/proc/meminfo` where available so container/host memory availability and swap usage can be monitored. It falls back to Node's OS memory counters on other platforms. Alerts are stateful, rate-limited, and followed by a recovery notice once available memory returns above `MEMORY_RECOVERY_PERCENT`.
