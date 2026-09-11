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

It also fixes mineflayer's dig-time calculation on 1.20.5+ servers, where the
enchantments component arrives as an object instead of an array and every dig
used to fail with "enchantments.concat is not a function" (see
test/mineflayer-digging.test.js).

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
section headings that Docker rejects. All app settings work here, including
cron jobs (`CRON_JOB_1=0 4 * * *|/crates-all` — the `|` separator and spaces
are fine in a Docker env file):

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

## Slow broadcasts and bot selection

These settings apply to `bot.js`, not `bot-rtp.js`. Restart the process after
editing `.env` and refresh browser tabs after upgrading.

### `/all-slow <command or message>`

Like `/all`, but dispatches to the first bot immediately and then one bot per
delay interval (15 seconds by default). For example:

```text
/all-slow /status
/all-slow /crates purple
/all-slow hello
```

- `ALL_SLOW_DELAY_MS` is in milliseconds. It must be an integer from 1 through
  2147483647; missing, blank, zero, negative, fractional, or invalid values
  fall back to 15000 rather than being clamped to a rapid timer by Node.
- The roster is captured when the command starts. Bots added later are not
  included. Removed bots are skipped; raw chat skips bots that are not spawned
  at dispatch time. Local commands retain their own offline handling.
- Arguments to local commands are preserved for both `/all` and `/all-slow`.
- The delay spaces command *starts*, not completion of asynchronous routines.
  Long-running routines may overlap and retain their existing per-bot guards.
- Only one slow broadcast may be active at a time. A second request is rejected
  with a warning; `/exit` cancels pending dispatches. Normal `/all` stays immediate.
- The scheduler holds only one pending timeout, rather than one timeout per bot.

### Random initial connection order

`RANDOMIZE_BOT_ORDER` defaults to `true`. A Fisher-Yates shuffle creates a copy
of `BOT_NAMES` at startup; the configured list itself is not mutated. Existing
`CONNECT_DELAY_MS` and `CONNECT_DELAY_RANDOM_MS` spacing still applies.

Set `RANDOMIZE_BOT_ORDER=false` to connect in the configured order. `0`, `no`,
and `off` also disable shuffling (case-insensitive). Reconnect ordering is not
changed. Bot list numbers follow creation order, so use `/list` before numeric
`/switch` commands or use an exact name for a stable target.

### `/switch <name or number>` in the WebGUI

Switching selects and highlights the bot, updates its log subscription/history,
and targets following commands to that bot. Selection belongs to the requesting
browser tab; it does not change another tab or the TUI's active bot.

Both WebSocket and HTTP fallback send the selected bot with each command.
`/api/command` returns JSON `{ "accepted": true, "selectedId": null }`; a
successful switch returns the selected bot name instead of `null`. The form
fallback preserves selection through a `?view=` redirect. Invalid switch
targets produce a warning rather than being sent to the game server. Commands
aimed at a removed bot are not silently redirected to another bot.

An ambiguous HTTP failure is no longer automatically replayed on reconnect:
check logs before retrying to avoid accidentally executing a command twice.

## `bot.js` Configuration

### Connection and startup

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `play.fatalmc.org` | Minecraft server host |
| `PORT` | `25565` | Minecraft server port |
| `VERSION` | `1.21.2` | Minecraft protocol version, passed to mineflayer unchanged |
| `LOGIN_PASSWORD` | `123456` | Password sent to register/login prompts |
| `BOT_NAMES` | required | Comma-separated bot usernames |
| `CONNECT_DELAY_MS` | `39500` | Delay between initial bot connections |
| `CONNECT_DELAY_RANDOM_MS` | `0` | Additional random delay range |
| `MAX_RECONNECT` | `17` | Maximum normal reconnect attempts |
| `SERVER_COMMAND` | empty | Command sent after spawn instead of compass navigation |
| `CLICK_COMPASS` | empty | Set to enable compass activation after spawn |
| `RANDOMIZE_BOT_ORDER` | `true` | Shuffle the initial connection order (Fisher-Yates); `false`/`0`/`no`/`off` keep the configured order |

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
| `PROXY_GROUP_<N>_BOTS` | unset | Comma-separated bot usernames dedicated to group `N` (starts at 1, no gaps) |
| `PROXY_GROUP_<N>_HOST` | unset | Proxy host for group `N` |
| `PROXY_GROUP_<N>_PORT` | `1080` | Proxy port for group `N` |
| `PROXY_GROUP_<N>_TYPE` | `socks5` | `socks5` or `http` for group `N` |

Bots not listed in any `PROXY_GROUP_<N>_BOTS` fall back to the global `PROXY_HOST` above (or connect directly if it's unset). `/proxy` reports both the configured groups and the fallback.

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
| `LOG_MAX_LINES` | `1500` | Stored lines per bot/system channel (dashboard renders the last 400; lower = less memory) |
| `WINDOW_DEBUG` | `false` | Include complete inventory slot dumps |
| `CONFIG_PACKET_LOG_LIMIT` | `120` | Configuration packet log limit; `0` means unlimited |

Resource-fix notes:

- Filtered browser logs remain bounded even if none of the incoming lines match.
- The all-channel history sort considers only the newest 400 entries per channel.
- WebSocket log batches are not allocated or scheduled without connected viewers.
- Stale HTTP poll responses do not overwrite the newly selected channel's logs.
- Clients that fall too far behind (over 1 MB of buffered WebSocket output) are
  skipped until they catch up, so a slow dashboard tab can never OOM the process.

### Minecraft web client (`/play` tab)

The dashboard's **PLAY** button opens a browser-based Minecraft client
([zardoy/minecraft-web-client](https://github.com/zardoy/minecraft-web-client))
embedded on `/play` — **fully self-hosted**: the client is built from source
and served by this app on its own local port (`web-client.js`); nothing is
loaded from a third-party hosted client. The client server is **started lazily**
on the first `/play` request and **stopped completely when you leave `/play`**
(page-exit beacon plus a heartbeat watchdog), so on small hosts it only exists
in memory while you are actually playing. Assets are gzipped with **streaming
compression — nothing is cached in memory** (the multi-MB bundle never sits in
RAM). It connects through a WebSocket → TCP
bridge, works with **offline-mode (cracked) servers** — any username, no
account needed — and supports server versions 1.8 through 1.21.5
(first-class 1.21.4; the default build ships data for the full 1.21.x
generation — widen `MIN_MC_VERSION`/`MAX_MC_VERSION` to include older
servers). No server-side plugins required.

The client is pinned to the **latest upstream release tag** (`v2.3.0`,
verified against the GitHub releases page — the upstream `next` branch is the
project's live dev branch, "usually newer, but might be less stable", and its
moving head used to make Docker images non-reproducible). Rebuilds check the
tag back out, so a stale or drifting dev-branch build can never sneak in.

**Building the client.** Both the Docker image and local builds use the same
script — `scripts/build-web-client.sh` — so they can never drift apart. The
Docker image builds it automatically (set `BUILD_WEB_CLIENT=0` as a
`--build-arg` to skip that stage) and the script is also copied into the
image, so you can rebuild the client inside a running container and it takes
effect immediately:

```bash
npm run web-client:build      # checkout upstream v2.3.0 + pnpm build → web-client/dist
npm run web-client:serve      # optional standalone: serve it on :8090 by itself
# inside a container (script ships in the image):
docker exec <container> npm run web-client:build
```

**Docker disk usage is kept small.** The Dockerfile runs the build in two
cacheable phases — `prepare` (clone upstream + `pnpm install`, cached as its
own layer) and `build` (apply patches + build + copy `dist`) — and then
deletes the client's `node_modules`/`.git`/`generated` inside the stage, so
the ~2 GB dependency tree never lingers in the builder cache. Without the
split, every script tweak forced a full re-download of ~1,600 packages on top
of the previous failed layers, which filled small Docker VMs with
`ENOSPC: no space left on device` (the client's install alone needs ~2.5 GB
of working space). If a build still dies with ENOSPC, reclaim the builder
cache once:

```bash
docker system df                # see what is holding space
# docker builder prune -af      # drop cached webclient-stage layers
# docker image prune -a         # drop old images if no longer needed
```

**Block breaking on 1.20.5+ servers is fixed at build time.** The browser
client bundles prismarine-item, whose `enchants` getter returns the raw
1.20.5+ component object (`{ enchantments: [...] }`) instead of a flat array
and throws on versions it doesn't recognize. That crashed mineflayer's
digTime with "(enchantments ?? []) is not iterable" — so holding an enchanted
tool meant the dig packet was never sent and blocks could never be broken.
`scripts/patch-web-client-enchants.js` (run by the build script after
`pnpm i`, covered by `test/web-client-enchants.test.js`) normalizes the
getter to the classic `[{ name, lvl }]` array so digging and the inventory
UI work again.

**Build memory is capped by default.** The upstream build loads the full
minecraft-data corpus (every version 1.8 → 1.21.11) into memory at once — a
fresh build peaks at **~2.3 GB RSS** (measured), which OOMs or swap-thrashes
a 4 GB machine. The same patch script defaults the build-time prep to the
current **1.21.x generation only** (1.21 → 1.21.11, measured fresh-build peak
~1.8 GB) — and because the patch rewrites the upstream source, it applies to
*any* build invocation (script, Docker, or a manual `pnpm run build` inside
`web-client/src`). Going stricter than 1.21.x (e.g. 1.21.11 only) would break
connecting to other server versions: when a version is absent from the bundle
the client silently falls back to the base version's protocol data. To cover
older servers, widen the range, e.g. `MIN_MC_VERSION=1.8
MAX_MC_VERSION=1.21.11 npm run web-client:build`.

**Velocity `/server` transfers work.** The stock client ignores the 1.20.5+
Transfer packet, so on Velocity networks a `/server lifesteal`-style command
never completes and the server kicks the session with "Internal Exception:
io.netty...". The same patch script adds a transfer handler that reconnects
to the destination through the same proxy (reusing the client's own
reconnect mechanism), so server switches work like on a vanilla client.

**Server resource packs download through GitHub URLs.** GitHub redirects
(`github.com/.../raw/...`) carry no CORS headers, so a browser `fetch` of a
pack hosted on GitHub dies with "Failed to fetch" (the vanilla client is
unaffected — only browsers enforce CORS). The client patch falls back to a
same-origin `/resource-pack-proxy` endpoint on the web-client server
(`web-client.js`), which fetches server-side (no CORS, redirects followed)
and streams the pack back.

If the build is missing, `/play` shows a "build not found" page with these
instructions instead of embedding anything remote.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MC_WEB_ENABLED` | `true` | Show the PLAY button and `/play` route |
| `MC_WEB_CLIENT_URL` | *(empty)* | Override client page URL (e.g. `https://client.example.com`); empty = serve the local build |
| `MC_WEB_CLIENT_PORT` | `8090` | Local port serving the client build (bound only while `/play` is open; freed when you leave) |
| `MC_WEB_CLIENT_PORT_MAX_ATTEMPTS` | `10` | Fallback ports tried if 8090 is taken |
| `MC_WEB_CLIENT_DIR` | `web-client/dist` | Directory of the client build (the Docker image bakes it there too, so no override is needed in containers) |
| `MC_WEB_CLIENT_HOST_PORT` | *(empty)* | Host-side client port when Docker maps it (set by `run-docker.sh`) |
| `MC_WEB_SERVER` | *(empty)* | Server address prefilled in the connect screen, e.g. `play.example.com:25565` |
| `MC_WEB_CLIENT_TAG` | `v2.3.0` | Upstream release tag the build script checks out (override if a newer release is wanted) |
| `MC_WEB_VERSION` | `1.21.4` | Protocol version prefilled in the client |
| `MC_WEB_USERNAME` | *(empty)* | Offline-mode username prefilled in the client |
| `MC_WEB_PROXY` | *(empty)* | Your self-hosted mwc-proxy URL (see below) |

**Proxy setup.** Browsers cannot open raw TCP sockets, so the browser client
talks WebSocket and a bridge relays to the Minecraft server over TCP. For a
publicly reachable server, the hosted client's public proxies work out of the
box — just open PLAY and connect. For a private/LAN server, self-host the
bridge next to it:

```bash
./run-docker.sh proxy          # runs ghcr.io/zardoy/mwc-proxy on :8080
# or, without Docker:
npx minecraft-web-proxy
```

Then set `MC_WEB_PROXY` in `.env` / `.env.dockerN`:

```dotenv
MC_WEB_SERVER=play.example.com:25565
MC_WEB_VERSION=1.21.4
MC_WEB_USERNAME=PlayerName
MC_WEB_PROXY=ws://localhost:8080
```

**`ws://` vs `wss://`, and https dashboards.** If the dashboard is served over
**https**, browsers block insecure `ws://` *and* plain-`http://` iframe pages
(mixed content) — so serve the client page over TLS too (point
`MC_WEB_CLIENT_URL` at an https URL via a reverse proxy / Cloudflare Tunnel,
and use `wss://` for `MC_WEB_PROXY`). Over plain http everything is fine as
shipped. Optional proxy env vars: `MWC_PORT`, `MWC_HOST_PORT`,
`MWC_ALLOW_ORIGIN`, `MWC_ACCESS_CODE`, `MWC_MAX_CONNECTIONS_PER_IP`,
`MWC_SIGNAL_URL` (mcraft.fun listing).

### Cron jobs

Scheduled jobs run any command with `/all` semantics: known local commands run
per bot, manual commands route through their own router, and everything else
broadcasts as chat to every spawned bot. Define them in `.env` as
`CRON_JOB_<N>=<schedule>|<command>`:

```dotenv
CRON_JOB_1=0 4 * * *|/crates-all
CRON_JOB_2=@every 60|/status
```

The schedule is either a standard 5-field cron expression
(`minute hour day-of-month month day-of-week`; day-of-week 0-6, 7 accepted as
Sunday) or `@every <seconds>` (minimum 5). Fields support `*`, `*/n`, `a-b`,
`a-b/n`, and comma-separated lists.

Jobs are also managed from the terminal with `/cron` (list), `/cron add
<schedule> <command>`, `/cron rm <id>`, `/cron on|off <id>`, and `/cron run
<id>` (run fires immediately, even for a disabled job). Terminal-added jobs
last until the process exits; `.env` jobs reload on restart.

The schedule may be quoted (`/cron add "0 4 * * *" /crates-all`) or bare
(`/cron add 0 4 * * * /crates-all`, `/cron add @every 60 /status`); the rest
of the line is the command, so chat messages with spaces work too. When both
day-of-month and day-of-week are restricted, cron fires when either matches
(standard OR semantics). A job that is still running when its next trigger
arrives is skipped (no overlapping runs), and dispatcher errors are logged to
the system channel.

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
| `/find <name>` | Search every bot's inventory and open window for an item by display, custom, or registry name |
| `/cron` | List scheduled jobs; `/cron add <schedule> <cmd>`, `/cron rm <id>`, `/cron on|off <id>`, `/cron run <id>` |
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
| `/drop [count]` | Drop the held stack (or `count` items from it) |
| `/pickup [all]` | Pathfind to the nearest dropped item and collect it (`all` = sweep the area) |
| `/gui <server command>` | Open a server GUI and manage it manually (no auto-click/auto-warp) |
| `/take <slot\|name\|all>` | Shift-click an item out of the open GUI into the inventory |
| `/take-gui` / `/dump-gui` | Move all items GUI→inventory, or inventory→GUI |
| `/view first\|third` | Switch the 3D viewer camera (first-person vs orbit) |
| `/pos` | Show the active bot's position, facing, and dimension |
| `/gui-tui` | Toggle the clickable ASCII GUI overlay for the open window |
| `/exit` | Disconnect all bots and exit |

Valid crate colors include `white`, `orange`, `magenta`, `light_blue`,
`yellow`, `lime`, `pink`, `gray`, `light_gray`, `cyan`, `purple`, `blue`,
`brown`, `green`, `red`, and `black`. A color may be written as a bare name or
as a full block name such as `purple_shulker_box`.

## `/find <name>` — search the whole fleet

`/find` scans every bot's inventory **and** any open window and lists matching
items, matching against the display name, the anvil custom name, and the
registry/alternative name (`netherite_sword`), case-insensitively. Offline bots
are reported as skipped. Example output:

```text
❯ /find sword
[A] — 1 matching stack(s)
  3x Sword (netherite_sword) — inv slot 12
✓ Found 3 matching item(s) across 3 bot(s).
```

## Manual interact (items and server-command GUIs)

- `/drop [count]` — drop the whole held stack, or `count` items from it.
- `/pickup [all]` — pathfind to the nearest dropped item entity and wait until
  it is collected (`all` sweeps everything within `MANUAL_PICKUP_RANGE`, default
  16 blocks, capped at `MANUAL_PICKUP_MAX_ITEMS`). Item collection is passive in
  Minecraft, so the bot walks onto the item and waits for it to vanish.
- `/gui <server command>` — send a server command (e.g. `/gui /shardshop`) and
  treat the window it opens as a **manual window session**: the automatic
  slot-scan/click and the delayed AFK warp are suppressed, and `/window` /
  `/window-click` / `/move` / `/window-close` take over. The session stays
  manual for as long as the window is open — even when the server closes and
  re-opens the GUI on click (which shop GUIs do) the auto-click and fatal-crate
  search stay off, and this holds whether or not `/gui-tui` was toggled. The
  session ends on `/window-close`, `/manual-stop`, or the auto-close below.
- `/chat /<command>` — the same suppression is armed for `/`-prefixed server
  commands sent through `/chat` (e.g. `/chat /shardshop`). Plain `/chat`
  messages are unaffected, and the suppression expires after 5 seconds if no
  window opens. Crate/shardshop routines clear it defensively at startup so a
  stale arm can never swallow a routine's window.
- `/take <slot|name|all>` — take a specific item out of the open GUI into the
  bot's inventory: by raw slot (`/take 12`), by name match (`/take netherite`
  matches the display, custom, or registry name), or `all`. Uses shift-clicks.
- `/take-gui` — shift-click every item out of the open GUI into the inventory.
- `/dump-gui` — shift-click the whole bot's inventory into the open GUI window
  (the reverse of `/take-gui`). All three refuse to run while a crate/shardshop
  routine is active, and abort safely if the window closes mid-way.
- `/view first|third` — switch the 3D viewer camera. `first` shows the bot's
  own view (what the bot sees, with the camera following its head); `third`
  returns to the free orbit camera. The switch restarts the viewer server on
  the same port — re-open the 🌍 viewer tab if it was already open.
- `/pos` — show the active bot's location: X/Y/Z, facing yaw/pitch in degrees,
  and dimension.
- **Item names** — Minecraft items carry two names: the registry/base name
  (e.g. `netherite_chestplate` / "Netherite Chestplate") and an optional custom
  name set through an anvil or similar (e.g. a chestplate renamed "Fatal
  Chestplate"). The dashboard GUI TUI, the `/window` listing, and `/inv` all
  show the custom name as the primary name with the alternative name (the
  registry key, e.g. `netherite_chestplate`) underneath, so renamed items are
  identifiable and nothing silently keeps its base name.
- **Auto-close** — if a manual GUI session is still open after
  `MANUAL_GUI_TIMEOUT_MS` (default 20 minutes), the window is closed
  automatically and automatic GUI handling (slot-scan/click, fatal-crate
  search, AFK warp) is restored.
- `/gui-tui` — with a window open, toggles the dashboard's ASCII GUI overlay
  (a clickable slot grid that shrinks the log view). Left-click a slot for a
  left click, right-click for a right click; `✕ close` closes the window and
  `hide` dismisses the panel. Each slot shows both the display name and the
  internal (alternative) name. The panel refreshes automatically: server slot
  updates push live, clicks sent from the panel update the window, and if the
  server closes/reopens the GUI on click the session is re-tracked so the
  panel keeps following it.

## `/overview` rank detection

`/overview` detects each bot's rank with a single `/fix` probe (no `/rank`):

- An access-denied reply (`You do not have access to the command`,
  `no permission`) means the bot is a **Member**.
- A `you are on cool down` reply (case-insensitive) means the probe itself was
  rate-limited, so the rank shows **N/A**.
- Any other reply — including generic errors like
  `Error: This item cannot be repaired` — means the bot passed the `/fix` rank
  gate, so the rank is **Regent**.

`RANK_COOLDOWN_MS` (default 4500ms — 3× the server's `/fix` cooldown) is
waited *before* `/fix` fires, because the balance queries that precede it send
several commands back-to-back and would otherwise trip the server cooldown
(the old code only spaced `/fix` → `/rank`, so `/fix` still got rate-limited
and showed N/A). Override the command and spacing with `RANK_FIX_COMMAND` and
`RANK_COOLDOWN_MS`.

## Chat activity watchdog

If no player chat has been seen for a while, the bot runs a server command
(default `/server lifesteal`) to nudge itself back onto the right server.

- Every `CHAT_WATCHDOG_CHECK_MS` (default 60s) each spawned bot checks how long
  it has been since the last player chat message; if that exceeds
  `CHAT_WATCHDOG_TIMEOUT_MS` (default 10 minutes) it sends
  `CHAT_WATCHDOG_COMMAND` (default: `/server lifesteal`, falling back to
  `SERVER_COMMAND`) and resets its timer.
- Player chat is detected as `<name>: message` after stripping § color codes
  and non-ASCII characters — the server can prefix usernames with odd unicode,
  so the detector normalizes the line first. Messages from the fleet's own
  bots (names that match a bot key) do not count.
- Turn it off with `CHAT_WATCHDOG_ENABLED=0`; tune the cadence with
  `CHAT_WATCHDOG_TIMEOUT_MS` and `CHAT_WATCHDOG_CHECK_MS`.

Note: short server replies that look like `<word>: value` (e.g. `Shards: 123`)
can also reset the timer; the watchdog is meant for servers where the chat is
otherwise completely silent.

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

## Tests

```sh
npm test
node --check bot.js
```

Tests use Node's built-in runner with mocked Minecraft/network dependencies —
they never connect to a live game server or require credentials. They cover
delay validation, ordering, timing, cancellation, errors, local arguments,
browser-tab isolation, HTTP/form routing, stale targets, immediate `/all`
behavior, cron scheduling, `/find` matching, and the patched mineflayer
dig-time calculation.

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
| `cron.js` | Dependency-free cron scheduler (`/cron`, `CRON_JOB_<N>` env jobs) |
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
