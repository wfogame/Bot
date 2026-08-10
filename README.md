# Mineflayer TUI Multi-Bot Manager

A terminal-based multi-bot manager for Minecraft, built with Node.js, [Mineflayer](https://github.com/PrismarineJS/mineflayer), and [neo-blessed](https://github.com/chjj/blessed).

This program allows you to connect and manage multiple Minecraft bots simultaneously through a clean Terminal User Interface (TUI). It features automatic server authentication, GUI navigation (compass clicking), and independent log views for each bot.

## Features

* **Interactive TUI:** View logs, send commands, and monitor bots without terminal spam.
* **Multi-Bot Management:** Spin up multiple bots with staggered connection delays to avoid rate limits.
* **Auto-Authentication:** Automatically sends `/register` and `/login` before spawning in.
* **Auto-Navigation:** Automatically uses a server selector compass, clicks specific GUI slots, and executes warp commands.
* **Isolated State:** Each bot maintains its own isolated event logs, connection state, and timeout handlers.

## Prerequisites

* **Node.js** (v18+ recommended)
* A Minecraft server to connect to.

## Installation

1. Clone or download this repository.
2. Install the required dependencies:

   ```bash
   npm install mineflayer neo-blessed

You can adjust default settings before running

```js

const HOST = 'play.fatalmc.org'   // Target server IP
const PORT = 25565                // Target server Port
const VERSION = '1.21.1'          // Target Minecraft version

// List of bots to connect automatically on startup
const BOT_NAMES = [
  'OnlyAProgrammer',
  'Jt2S1m3ePer',
  'BilihJm289',
  '1evArchUsr2',
  'LnuxOtocael'
]

const CONNECT_DELAY_MS = 39500    // Delay between each bot connecting

```

to run, run

```
node bot.js

```

The Interface

    Header: Displays the currently active bot and a list of other connected bots.

    Log Box: Displays events, chats, and errors specific to the currently active bot. Scrollable using the mouse or terminal scroll binds.

    Input Box: Send chat messages or execute internal / commands.

Commands

Type these commands into the bottom input box. Commands starting with / are processed by the TUI. Anything else is sent as a chat message to the Minecraft server from the active bot.
Command Description
/switch [username] Switch the TUI log view and control to a different connected bot.
/new-bot [name] [ip] [port] [ver] Create and connect a new bot. (IP, port, and version default to main server if omitted).
/bots List all connected bots and their current spawn status.
/status Show the active bot's position, health, ping, and uptime.
/inv List the active bot's inventory contents.
/players List all online players (from the active bot's perspective).
/clear Clear the active bot's TUI log view.
/disconnect or /dc Disconnect the currently active bot without closing the program.
/reconnect Reconnect the currently active bot to the server.
/exit Gracefully disconnect all bots and close the program.
/help List all available commands in the log box.
Event Flow & Customization

The bots follow a strict automated sequence upon connection. To modify this behavior, look for the bot.once('login') and bot.once('spawn') blocks inside createBotInstance():

    Login: Sends /register and /login commands.

    Spawn: Activates held item (Compass).

    Window Open: Detects GUI, clicks slot 11, waits, and sends /warp afk.

Troubleshooting

    partial packet / Protocol crashes during server transfer: This is a known issue with Mineflayer 1.21+ handling Proxy (Velocity/BungeeCord) server transfers. If you experience random crashes when clicking the compass GUI, downgrade the VERSION constant to 1.21.1 or 1.20.4.

    Bots getting kicked immediately: Ensure CONNECT_DELAY_MS is high enough to bypass the server's anti-bot connection throttling.

Dependencies Links

    Mineflayer API

    Neo-Blessed
In addition, bot-rtp.js simply automatically rtp the bots and scans for bases.
Features
Auto eat, notifcation for improtant events such as totem popping, player in range, and base found, auto totem, as well as rtp location logging
