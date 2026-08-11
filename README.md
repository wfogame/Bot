# Mineflayer TUI Multi-Bot Manager

A terminal-based multi-bot manager for Minecraft, built with Node.js, [Mineflayer](https://github.com/PrismarineJS/mineflayer) and [neo-blessed](https://github.com/chjj/blessed).

It connects and manages multiple Minecraft bots at once through a single Terminal User Interface (TUI), with automatic server authentication, GUI navigation (compass clicking), independent per-bot log views, and automatic reconnection with exponential backoff.

## Features

- **Interactive TUI** — view logs, send commands, and monitor bots without terminal spam.
- **Multi-bot management** — connect any number of bots, staggered on startup to avoid anti-bot throttling.
- **Auto-authentication** — sends `/register` and `/login` automatically before spawning in.
- **Auto-navigation** — right-clicks a server-selector compass and clicks a configured GUI slot after spawn.
- **Auto-reconnect** — any disconnect (kick, error, dropped socket) is retried automatically, with the wait time growing exponentially on repeated failures.
- **Login audit log** — every *successful* login is appended to `bot.log`.
- **Isolated state** — each bot keeps its own log history, connection state, and timers.

## Prerequisites

- Node.js v18+
- A Minecraft server to connect to

## Installation

1. Clone or download this repository.
2. Install dependencies:

```
npm install mineflayer neo-blessed mineflayer-armor-manager dotenv
```

1. Create the two config files described below in the same folder as `bot.js`.

## Configuration

Bot accounts are no longer hardcoded or passed through `.env` — they're read from two plain text files next to `bot.js`.

### `botnames.txt`

One username per line. Every name here gets connected on startup.

```
OnlyAProgrammer
Jt2S1m3ePer
BilihJm289
1evArchUsr2
LnuxOtocael
```

### `passwords.txt`

One password per line, **matched by line number** to `botnames.txt` — line 1 here is the password for line 1 in `botnames.txt`, and so on. Both files must have at least as many lines as there are bots, or the program exits at startup with an error telling you the mismatch.

```
correcthorse1
correcthorse2
correcthorse3
correcthorse4
correcthorse5
```

### `.env` (optional overrides)

Everything else still falls back to sane defaults if you don't set it:

| Variable | Default | Description |
|---|---|---|
| `HOST` | `play.fatalmc.org` | Target server address |
| `PORT` | `25565` | Target server port |
| `VERSION` | `1.21.1` | Minecraft protocol version |
| `CONNECT_DELAY_MS` | `39500` | Delay between each bot's initial connection |
| `GUI_SLOT` | `11` | Inventory slot clicked in the server-selector GUI |

## Running

```
node bot.js
```

## bot.log

A line is appended to `bot.log` **only** when a bot successfully authenticates and spawns in — not on failed attempts, kicks, or errors. It's a simple audit trail of confirmed logins:

```
[2026-08-11T14:23:11.203Z] OnlyAProgrammer logged in successfully (play.fatalmc.org:25565)
[2026-08-11T14:23:51.220Z] Jt2S1m3ePer logged in successfully (play.fatalmc.org:25565)
```

## The Interface

- **Header** — the currently active bot and a list of the others connected.
- **Log Box** — events, chat, and errors for the currently active bot only. Scrollable with the mouse or terminal scroll binds.
- **Input Box** — type `/commands` or plain chat messages. Up/Down arrows cycle through command history; Tab autocompletes a partial `/command`.

Anything typed that isn't a recognized `/command` is sent as a chat message from the active bot.

## Commands

| Command | Description |
|---|---|
| `/all <cmd>` | Run a local command on every bot, or broadcast a raw chat/command to all |
| `/list` | Compact one-line-per-bot status (online / offline / last kick reason) |
| `/chat <msg>` | Send a chat message from the active bot (won't be misread as a local command) |
| `/disconnect`, `/dc` | Disconnect the active bot and stop its auto-reconnect |
| `/reconnect` | Reconnect the active bot |
| `/reconnect-all` | Reconnect every currently offline bot |
| `/new-bot <name> <password> [host] [port] [ver]` | Create and connect an additional bot at runtime |
| `/switch <id>` | Switch the TUI view to another bot, by name or list number |
| `/status` | Active bot's position, health, food, ping, uptime |
| `/inv` | Active bot's inventory contents |
| `/players` | Players online, from the active bot's perspective |
| `/uptime` | Uptime for every bot |
| `/clear` | Clear the active bot's log view |
| `/help` | List all commands |
| `/exit` | Disconnect all bots and close the program |

## Event Flow & Customization

Each bot follows a fixed sequence on connect. To change this behavior, edit the `bot.once('login')`, `bot.once('spawn')`, and `bot.on('windowOpen')` blocks inside `createBotInstance()`:

1. **Login** — sends `/register <password> <password>` then `/login <password>`.
2. **Spawn** — right-clicks the held item (compass) after a short randomized delay.
3. **Window Open** — detects the resulting GUI, clicks the configured `GUI_SLOT` (default `11`), and waits for the server transfer that click triggers.

## Reconnect Behavior

Every disconnect — kick, socket error, or dropped connection — schedules a reconnect. Each consecutive failure for that bot waits longer than the last:

```
delay = min(8000ms × 1.3^attempt, 300000ms)
```

A connection that stays stable for 60 seconds resets that bot's attempt counter back to the base delay. Reconnection continues indefinitely; there's no give-up point.

## Troubleshooting

- **Partial packet / protocol crashes during a server transfer** — a known issue with Mineflayer 1.21+ handling Velocity/BungeeCord proxy transfers. If you see crashes right around the compass GUI click, try setting `VERSION` to `1.21.1` or `1.20.4`. The bot will still auto-reconnect either way, just on the standard backoff schedule above rather than instantly.
- **Bots getting kicked immediately on connect** — raise `CONNECT_DELAY_MS` so bots don't trip the server's anti-bot connection throttling.
- **Program exits immediately on startup** — check the error message; it's almost always `botnames.txt` missing/empty, or `passwords.txt` having fewer lines than `botnames.txt`.

## Companion Scripts

### `bot-rtp.js`

A separate script (not included in this doc) that automatically RTPs bots and scans for player bases. Per its description: auto-eat, notifications for important events (totem pop, player in range, base found), auto-totem, and RTP location logging.

## Dependencies

- [Mineflayer](https://github.com/PrismarineJS/mineflayer)
- [neo-blessed](https://github.com/chjj/blessed)
- [mineflayer-armor-manager](https://github.com/PrismarineJS/mineflayer-armor-manager)
