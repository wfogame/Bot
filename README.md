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

### TPA and dump automation

Set `TPA_MAIN_PLAYER` to the configured main player's exact username and
`TPA_TRUSTED_BOTS` to the comma-separated bot names allowed to request
teleports. `/tpauto on` and `/tpauto off` control automatic `/tpaccept` for
the selected bot; requests from other names are logged and ignored. The
setting defaults from `TPA_AUTO_DEFAULT` after a restart.

`/dump` sends the selected bot to `TPA_MAIN_PLAYER`, deposits its inventory in
nearby chests, and returns it to `DUMP_WARP_COMMAND` (default `/warp afk`).
`/dump home` uses `DUMP_HOME_COMMAND` (default `/home stash`) instead.
Both modes do nothing when the inventory is empty. `/dump hidden` creates a
randomized multi-bot TPA chain and spreads its actions across a random 8–12
minute run, with at least three minutes between TPA actions. Because that
minimum gap limits how many actions fit in 8–12 minutes, extra bots in a
larger roster are logged as skipped for that run. `/dump cancel` cancels
pending dump timers; disconnecting a bot cancels its own pending work. An
unrecognized option (`/dump hiden`) is reported and then runs the default TPA
dump instead of silently doing something you did not ask for.

Every step of a run is logged: chests opened, stacks deposited per chest, chests
that could not be opened (with the reason), and stacks left behind, so a dump
that finds nothing or gets stuck is diagnosable from the log alone. A chest that
would not open is abandoned after `DUMP_OPEN_TIMEOUT_MS` instead of stalling the
rest of the run.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DUMP_TPA_TIMEOUT_MS` | `45000` | How long to wait for the TPA/home teleport |
| `DUMP_TPA_MIN_DISTANCE` | `10` | Blocks of movement that count as "the teleport happened" |
| `DUMP_SETTLE_MS` | `2500` | Pause after the teleport before scanning for chests |
| `DUMP_WARP_DELAY_MS` | `2500` | Pause after dumping before warping back to AFK |
| `DUMP_CLICK_DELAY_MS` | `120` | Pause between shift-clicks while depositing |
| `DUMP_OPEN_TIMEOUT_MS` | `15000` | Give up on a chest that will not open |
| `CHEST_SCAN_RADIUS` | `30` | Chest search radius around the bot |
| `CHEST_SCAN_COUNT` | `50` | Maximum chests considered per dump |

#### `/crates-all` sequence options

`/crates-all` and `/crates-solo` run shardshop → crates → dump. What happens
after the crate step, and what happens to the bot afterwards, is configurable —
every value keeps its long-standing default, so an existing `.env` behaves
exactly as before:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CRATES_ALL_DUMP` | `tpa` | What follows the crate step: `off` skips the dump, `tpa` deposits into chests near the teleport target, `home` uses `DUMP_HOME_COMMAND`, `hidden` arms the randomized hidden dump chain once for the whole roster, and anything else is a player name (`CRATES_ALL_DUMP=Smith`) |
| `CRATES_ALL_AFK_WARP` | `true` | `false` leaves each bot wherever the sequence finished |
| `CRATES_ALL_AFK_DELAY_MS` | `15000` | `0` warps to AFK the instant the routine ends |

The same two knobs work as per-run flags — `dump=off|tpa|home|hidden|<player>`
and `afk=now|off|<seconds>` — so:

```text
/crates-all 5 purple dump=off afk=now   5 bots, no dump, AFK the moment each finishes
/crates-solo B dump=player:Smith                one bot, dump at Smith
/crates-all dump=home afk=off            dump via /home stash, then stay there
/crates-all dump=hidden                  arm the hidden chain, stay put
```

Flags apply to that run only and beat the `.env` values. `dump=hidden` turns the
AFK warp off unless the run explicitly asks for one (`afk=now`, `afk=30`),
because staying where the bot teleported to is the point of a hidden dump. A
flag that cannot be read is reported and the run does not start, rather than
guessing at a target or a delay.

### Persistent spawner data and `/data`

Every successful `/spawners` run records one current row per bot/spawner number
in `DATA_FILE` (default `data/spawner-data.json`). Each row retains the spawner
number, spawner coordinates, bot position and dimension, balances immediately
before and after the click sequence, raw money earned, and the calculated
money-per-hour rate. The first observation is a baseline, so its rate is
`null`; a later successful run calculates the rate from elapsed time since the
previous observation. A missing `/bal` response is recorded as `N/A` and does
not create a rate. `/data` queries current bot balances, coins, shards, and
rank, compiles the saved spawner history into one latest snapshot, and saves it
locally. It also POSTs the snapshot to `DATA_WEBHOOK_URL` when configured.

### Publishing to Google Sheets

`google-apps-script/Code.gs` is the ready-to-deploy endpoint for `/data`. Paste
it into an Apps Script project, run `setSpreadsheetId('<id>')` once in the
editor, then deploy it as a web app with **Execute as: me** and **Who has
access: Anyone**, and set the resulting `/exec` URL as `DATA_WEBHOOK_URL`.

- `doPost` maintains **only its own columns** on the `Bots`, `Spawners`, and
  `Bans` tabs — never the whole tab. The header row is the union of every row's
  keys, so rows that differ (a baseline row with no rate yet, a bot with no rank
  yet) can no longer throw mid-write and leave the sheet stale. It answers with
  JSON — `{ ok, written: { Bots, Spawners, Bans }, layout, errors: [ ... ] }` —
  and the bot logs the row counts it reported, so a push is verifiable from the
  dashboard log.
- Opening the `/exec` URL in a browser (`doGet`) returns a health JSON with the
  spreadsheet id, tab names, and whether a secret is required. Seeing a Google
  sign-in page instead of JSON means the deployment is not public: that is the
  classic cause of "the bot says it pushed but the spreadsheet never updates".
  The bot now fails loudly when a webhook answers with HTML instead of JSON.
- HTML does **not** always mean "not public", so the bot reads the page and names
  the actual fault. Because all four cases arrive as HTML (usually with HTTP
  200), guessing "permissions" sends you to the wrong fix:

  | What the page says | Real cause | Fix |
  | --- | --- | --- |
  | Google sign-in page (`accounts.google.com`, "Sign in") | Deployment is not reachable anonymously | Deploy → Manage deployments → Execute as: Me **and** Who has access: Anyone, then Version: New version |
  | `Script function not found: doGet` | The live version runs an older `Code.gs` — a public deployment with no `doGet` | Paste the current `Code.gs`, then Version: New version → Deploy |
  | `Exception: …` / a stack trace | The deployed code threw (e.g. `SPREADSHEET_ID` never set) | Run `setSpreadsheetId('<id>')`, or redeploy the current code |
  | Any other HTML | Confirm against the quoted page text in the log | Read the `/data check` excerpt before changing permissions |

  `/data check` prints `diagnosis: <kind>` plus the page's own words, and both
  `/data` and the POST path report the same classification.

#### Your own columns are never touched

Sharing a tab with hand-made content is a supported setup, not an accident. A
push writes the columns whose headers come from its payload (`bot`, `balance`,
`coins`, `shards`, `earned`, …) and nothing else:

- **Your columns keep their own headers, values, formulas, notes, and formats.**
  The script only ever writes the columns it created. Ownership is remembered
  between pushes (`OWNED_COLUMNS_*`, shown by `listSettings()`), so a column the
  payload stopped sending is emptied instead of left stale.
- **A new payload column is appended to the right of yours**, never written over
  the top of one.
- **Only `Bots`, `Spawners`, and `Bans` are ever opened or created.** Your own
  tabs are never read, created, or modified — including a `Lifetime` tab left
  over from an older `Code.gs`, which the script simply stops touching. Run
  `removeLifetimeTab()` once in the editor if you want that leftover tab gone;
  no push ever deletes a sheet for you.
- **Fonts, colours, borders, notes, and conditional formatting are never set or
  cleared.** The script uses `clearContents()`, which preserves formatting, and
  never calls `clear()`. Setting `NUMBER_FORMATS` to `off` also stops it from
  touching number formats.
- **Rename nothing here by hand** — an unrecognised header looks like a new column
  and gets a duplicate next to it. Run `resetLayout()` in the editor to hand those
  columns back to you, then rename freely.

Useful when you keep your own totals, lookups, and diffs next to the data:

- **Row order is append-stable and never re-sorted.** A bot keeps its row for as
  long as it exists; a new bot is appended at the bottom. So `=C3-C2` (this row
  minus the row above) keeps comparing the same pair of bots, and an adjacent-row
  diff is a valid diff. A *disappearing* bot still shifts the rows below it up,
  so for anything that must survive roster changes, key on the `bot` column with
  `VLOOKUP`/`XLOOKUP` instead of a hard-coded row number.
- **Your formulas may read our columns** (`=D2+E2+F2`, `=A2&" "&C2`, a `QUERY`
  over the range). They are never evaluated or rewritten — only our own columns
  are written, so recalculation is Google's problem, not ours.
- **Our TOTAL row is one row of our columns.** If you keep your own totals row
  elsewhere on the tab, nothing collides: yours are in your columns.

#### Totals row

A `TOTAL` row of live `=SUM()` formulas is appended under the data, bolded:
`balance`, `coins`, `shards`, `invUsed`, `earned`, and `lifetimeEarned` on
**Bots**, plus `earned` on **Spawners**. Because they are formulas, they keep
working if you edit a value.

Which of those sums answer "how much have I earned?":

- **`lifetimeEarned` on `Bots` is the all-time number.** It accumulates on the
  bot row, where the balance is actually measured, run after run and restart
  after restart. `SUM(lifetimeEarned)` replaces the old `Lifetime` tab.
- **`earned` on `Bots` is the last `/spawners` pass**, so it is the fresh one to
  plot or alert on.
- **`SUM(earned)` on `Spawners` totals the last pass across every spawner**, not
  all time — see [Lifetime earnings](#lifetime-earnings-and-why-the-sums-add-up).

A tab with a single data row gets no totals row (there is nothing to add up).

| Helper | Effect |
| --- | --- |
| `setTotalsRow('bottom' \| 'top' \| 'off')` | Move the totals row (default `bottom`), or switch it off |
| `setTotalsColumns('balance,coins,shards')` | Choose which columns get a sum |

#### Readable times and number formats

Timestamps are stored as epoch milliseconds internally because production rates
are differences of two of them — `1758067200000` is a fine number and a terrible
cell. So they are published as ISO 8601 and converted to real date values on
write, which means Sheets shows them in your own locale format and `Date`/`Time`
functions work on them. Derived rates are published rounded to two decimals, so a
cell reads `33,333.33` instead of `33333.333333333336`.

Our columns get a sensible number format on write — `#,##0.00` for money and
rates, `#,##0` for counts, nothing for text. Change the map, or turn it off
entirely and keep your own formatting:

| Helper | Effect |
| --- | --- |
| `setNumberFormats({ balance: '#,##0.00' })` | Replace the format map |
| `setNumberFormats('off')` | Never touch number formats (their values still update) |
| `setTimestampFormat('yyyy-mm-dd hh:mm')` | Force one date format everywhere |
| `clearTimestampFormat()` | Go back to the spreadsheet's locale date format |
| `listSettings()` | Print the webhook, layout, totals, and format settings |

#### What the `Bots` tab contains

One row per bot, written by `/data` (and by `/spawners`, which also fills in the
spawner columns). Every cell is a plain scalar you can filter, sort, plot, or use
in a formula:

| Column | Source | Why it is there |
| --- | --- | --- |
| `bot` | bot id | The stable key — look everything else up by this |
| `recordedAt` | snapshot time | Real date, so you can tell a fresh row from a stale one |
| `rank` | `/rank` | Current rank (`N/A` when the query failed) |
| `balance` | `/bal` | Money held |
| `coins` | `/coins` | Coins held |
| `shards` | `/shards` | Shards held |
| `x`, `y`, `z` | live entity position | Three numbers, not one `{"x":1,"y":64,"z":-3}` blob — so you can sort by height, or diff positions to spot a bot that has wandered |
| `dimension` | current world | Coordinates are meaningless without it on a multi-world server |
| `earned` | `/spawners` | Money the bot made over the last pass — the window total, not a per-spawner slice |
| `lifetimeEarned` | `/spawners` | The running all-time total; this is the number the old `Lifetime` tab tried to be |
| `ratePerHour` | `/spawners` | That window's earnings extrapolated to an hour |
| `invUsed` | live inventory | Storage slots in use out of 36 (27 main + 9 hotbar) |
| `invFree` | live inventory | Slots still free — the "is this bot full" number |
| `invTotal` | constant | 36, so `invUsed`/`invTotal` is a percentage you can format directly |
| `spawnerCount` | `/spawners` | How many spawners were found on the plot |
| `successfulSpawners` | `/spawners` | How many of those were fully clicked, so a partial pass is visible instead of implied |
| `runStartedAt` | `/spawners` | When that pass began |
| `trackedSpawners` | local state | How many spawner rows the bot has on record for this bot — the count behind the `Spawners` tab |
| `banned` | kick text | `TRUE`/`FALSE` — see [Ban detection](#ban-detection); survives a restart so a banned bot never reads as merely offline |
| `bannedAt` | ban time | Real date the current ban started (blank once the bot is back) |
| `banKind` | kick text | `permanent`, `temporary`, `blacklist`, or `suspected` |
| `banReason` | kick text | The reason phrase (`Alt Farming (3rd)`), never the raw component tree |
| `banDuration` | kick text | The stated length (`29 days, 11 hours, 17 minutes`) |
| `banExpiresAt` | kick text | Real date the hold ends — blank for a permanent ban. This is the number the ban hold compares against |
| `banCaseId` | kick text | The server's case id (`1129`) when its ban screen carries one |

`spawnerCount` and `trackedSpawners` are deliberately separate columns: they used
to share one name, so `/data` silently replaced "spawners on your plot" with "rows
in my local file" depending on which command ran last.

**Migrating an existing sheet:** `botPosition` is gone from the payload, so run
`resetLayout()` once in the Apps Script editor after redeploying and before the
next `/data`. That hands the old `botPosition` column back to you (delete it
whenever you like) and lets the script append `x`, `y`, `z`, and `dimension` at
the end. Your existing columns are found by header name and keep their place.

#### Lifetime earnings, and why the sums add up

The old `Lifetime` tab summed a `lifetimeEarned` column that sat on **spawner**
rows, and that could not add up:

- `spawnerNumber` is the position in a distance-sorted list, not a stable
  identity — when a bot moved, or a plot changed, the same column accumulated
  different blocks' earnings.
- The number being sampled is the bot's **whole-player** balance (`/bal`),
  measured around one click at a time. Each spawner row only ever held a slice of
  it, so a per-spawner "lifetime" was a share of one measurement pretending to be
  a measurement of its own.

So the running total moved to the row where the measurement happens — the **bot
row** (`lifetimeEarned`, `earned`, `ratePerHour` on `Bots`) — and the sheet's own
`TOTAL` row does the summing. Everything still lines up:

| Column | Window | Adds up to |
| --- | --- | --- |
| `Bots.lifetimeEarned` | all time, per bot | `SUM` = every bot, ever measured — the number the `Lifetime` tab was for |
| `Bots.earned` | the last `/spawners` pass | `SUM` = what the fleet earned since the previous pass |
| `Spawners.earned` | that row's last measured window | `SUM` = the same last pass, split per spawner (bot-level total and spawner-level total are consistent by construction) |
| `Spawners.ratePerHour` | that row's window | not summed — rates are already per hour, and the fleet figure is `Bots.ratePerHour` |

Two details worth knowing when reading the numbers:

- **The first `/spawners` pass only records baselines.** `earned` is a change, so
  it needs a previous balance; the first pass after a restart establishes it and
  `lifetimeEarned` stays put that run.
- **A row a pass did not visit has its `earned` and `ratePerHour` cleared** and is
  marked `not seen this run`, so it cannot keep contributing to the spawner sum
  forever. A pass cut short by a disconnect clears nothing — a partial pass is
  not evidence that a spawner is gone.
- Both numbers are measured in the same unit as `balance` — money the spawners
  produced, not your current holdings — so they will not match a balance sum.

**Migrating:** redeploy `Code.gs` (Deploy → Manage deployments → pencil →
Version: **New version** → Deploy) and the `Lifetime` tab simply stops being
written; the `earned` / `lifetimeEarned` columns then appear on `Bots` on the next
`/data`. Any previous per-spawner `lifetimeEarned` column on `Spawners` is emptied
automatically, because the payload no longer sends it. Run `removeLifetimeTab()`
in the editor if you want the leftover tab deleted as well.

- `setWebhookSecret('<value>')` in the editor plus `DATA_WEBHOOK_SECRET=<value>`
  in `.env` enables the shared-secret check. Apps Script web apps cannot read
  request headers, so the secret is sent as `?secret=...` and in the JSON body.
- `setHistorySheet('<name>')` turns on the append-only history tab; each `/data`
  push appends the current spawner rows with an `appendedAt` stamp. It stays off
  until that script property exists.
- `testWrite()` runs a sample snapshot through the real write path from the
  editor — the fastest way to check sheet permissions and headers.
- `DATA_WEBHOOK_TIMEOUT_MS` (default 15000) bounds each request.
- `/data check` performs that same public-deployment check from the bot: it
  GETs `DATA_WEBHOOK_URL`, prints the health JSON (spreadsheet id, tabs, whether
  a secret is required), and explains exactly which Apps Script step is missing
  when it sees an HTML page, a non-JSON body, or `ok:false`.
  `/data status` prints the active webhook URL, secret length, timeout, local
  snapshot file, and how many bots/spawners are tracked — none of it touches the
  network. It also warns when the configured URL is the `/dev` URL (which always
  requires a Google sign-in) or does not end in `/exec`.

The existing `/cron` command can run `/spawners` on a schedule; run `/data`
afterward when you want to publish the current snapshot.

## Start

```bash
# Browser dashboard plus TUI when a terminal is attached
npm start

# RTP/base-finder variant
node bot-rtp.js
```

`BOT_NAMES` is required by `bot.js`. If it is missing or empty, the process
exits instead of starting with no managed bots.

Docker is not required. A plain checkout runs the whole app with the same
settings; only three things differ, all of them handled for you:

- **No Tor.** `PROXY_HOST` defaults to empty, which means bots connect directly.
  The container's `127.0.0.1:9050` Tor default comes from
  `docker-entrypoint.sh`, not from the app.
- **No privileged port.** `WEB_PORT` still defaults to `80`, but a non-root user
  gets `EACCES` and the server falls back to `81`, `82`, … automatically.
  Set `WEB_PORT=8080` if you would rather pick the port yourself.
- **No baked-in Minecraft web client.** `/play` builds it on demand (see
  [Minecraft web client](#minecraft-web-client-play-tab)).

The plain local run also persists its state next to the checkout
(`data/`, `cron-jobs.json`, `removed-bots.json`), all of which are gitignored.

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

The `.ENV` button in the sidebar opens the settings panel described under
[Coinflip data collection, time series and analytics](#coinflip-data-collection-time-series-and-analytics):
every tunable value, editable for the current run only, nothing written to disk.

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

### `/all-slow [delay] <command or message>`

Like `/all`, but dispatches to the first bot immediately and then one bot per
delay interval (15 seconds by default). For example:

```text
/all-slow /status
/all-slow 30 /spawners        # this run only: 30s apart
/all-slow 500ms /status       # half a second apart
/all-slow /crates purple
/all-slow hello
```

- **An optional leading delay overrides the interval for that run**, using the
  same units as `sleep`: `30` is 30 seconds, `45s`, `500ms`, and `5000` is 5000 ms.
  The token is only read as a delay when it is a bare number or duration, so a
  command that starts with a digit is still dispatched intact. Delays below
  250 ms are raised to 250 ms, since faster dispatch just overlaps the runs.
- `ALL_SLOW_DELAY_MS` is the default in milliseconds. It must be an integer from 1
  through 2147483647; missing, blank, zero, negative, fractional, or invalid values
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
| `LOGIN_PASSWORD` | `123456` | Password sent to register/login prompts. Fallback for bots not covered by a group or per-bot password |
| `BOT_PASSWORDS` | empty | Per-bot passwords: `Bot7:pw,Bot9:pw2`. Beats the group and `LOGIN_PASSWORD` |
| `BOT_PASSWORD_<BOT>` | empty | One variable per bot; beats `BOT_PASSWORDS` for the same bot. Use when the password contains a comma |
| `AUTH_REPLY_WINDOW_MS` | `30000` | How long after sending an auth command a reply is treated as its answer |
| `AUTH_RETRY_MS` | `300000` | How long a throttled login waits before trying again |
| `AUTH_ALREADY_MS` | `60000` | Pause after "already logged in"/"already registered" |
| `AUTH_MAX_THROTTLED_RETRIES` | `2` | Throttled replies tolerated before it is treated as a wrong password |
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
| `PROXY_USER` | empty | Username for the global proxy (SOCKS5 user/pass, or HTTP Basic) |
| `PROXY_PASS` | empty | Password for the global proxy. `PROXY_PASSWORD` also works |
| `PROXY_STALL_WATCHDOG` | enabled | Set to `0` to disable stall recovery |
| `PROXY_STALL_TIMEOUT_MS` | `90000` | Silence period before forcing reconnect |
| `PROXY_STALL_CHECK_MS` | `20000` | Watchdog polling interval |
| `PROXY_STALL_RATIO` | `0.5` | Fraction of stalled bots that triggers proxy restart |
| `PROXY_RESTART_CMD` | local Tor restart when applicable | Optional proxy restart command |
| `PROXY_GROUP_<N>_BOTS` | unset | Comma-separated bot usernames dedicated to group `N` (starts at 1, no gaps) |
| `PROXY_GROUP_<N>_HOST` | unset | Proxy host for group `N`. Optional — without it the group is an account grouping and its bots use the fallback route |
| `PROXY_GROUP_<N>_PORT` | `1080` | Proxy port for group `N` |
| `PROXY_GROUP_<N>_TYPE` | `socks5` | `socks5` or `http` for group `N` |
| `PROXY_GROUP_<N>_USER` | empty | Username for group `N`'s proxy |
| `PROXY_GROUP_<N>_PASS` | empty | Password for group `N`'s proxy. `_PASSWORD` also works |
| `PROXY_GROUP_<N>_LOGIN_PASSWORD` | empty | *Minecraft* password for group `N`'s bots — not a proxy credential |

Bots not listed in any `PROXY_GROUP_<N>_BOTS` fall back to the global `PROXY_HOST` above (or connect directly if it's unset). `/proxy` reports both the configured groups and the fallback.

**A group is defined by its bot list, not by its host.** `PROXY_GROUP_<N>_BOTS` alone is enough, and a group without `PROXY_GROUP_<N>_HOST` is a legitimate *account* grouping: its `LOGIN_PASSWORD` applies and its bots use the default route. This used to be dropped in silence — the whole group, password included — so a group that only separated accounts appeared to work while every bot logged in with the wrong password.

The scan starts at `PROXY_GROUP_1_BOTS` and **stops at the first missing number**, so one gap discards every later group (host, credentials, bot list, password). Startup now says so rather than applying nothing:

```
⚠ PROXY_GROUP_1 has no HOST — its 11 bot(s) use the default route, but its login password still applies.
⚠ ignored, no group declares them: PROXY_GROUP_3_BOTS, PROXY_GROUP_3_LOGIN_PASSWORD
  Groups start at PROXY_GROUP_1_BOTS and stop at the first missing number, so one gap drops every later group.
```

`/proxy` prints the same facts on demand, naming the variables rather than the values:

```
Dedicated proxy groups: 2 configured
  [1] 1evArchUsr2, HyprC0re7 → no dedicated proxy (uses the default connection) · login: PROXY_GROUP_1_LOGIN_PASSWORD
  [2] DaelinFrostV47, … → SOCKS5 provider-two@5.6.7.8:1080 · proxy auth: PROXY_GROUP_2_USER/_PASS · login: PROXY_GROUP_2_LOGIN_PASSWORD
  (other bots) → direct connection
```

Credentials are **per proxy target, not per bot**. Each group sends its own `PROXY_GROUP_<N>_USER` / `PROXY_GROUP_<N>_PASS`, and a group with none sends none — it never borrows the global pair, because that would hand one provider's password to a different provider. A username with no password is valid (some SOCKS5 setups authenticate on the username alone), and so is a password with no username.

```ini
# A proxy per provider, each with its own login
PROXY_HOST=                 # no global proxy -> bots without a group connect directly

PROXY_GROUP_1_BOTS=Bot1,Bot2
PROXY_GROUP_1_HOST=1.2.3.4
PROXY_GROUP_1_PORT=1080
PROXY_GROUP_1_TYPE=socks5
PROXY_GROUP_1_USER=provider-one
PROXY_GROUP_1_PASS=secret-one

PROXY_GROUP_2_BOTS=Bot3
PROXY_GROUP_2_HOST=5.6.7.8
PROXY_GROUP_2_PORT=8080
PROXY_GROUP_2_TYPE=http
PROXY_GROUP_2_USER=provider-two
PROXY_GROUP_2_PASS=secret-two
```

SOCKS5 credentials are negotiated per RFC 1929; HTTP proxies get `Proxy-Authorization: Basic …` on the `CONNECT`. A proxy that answers **407** produces a message naming the exact variables to set (`PROXY_GROUP_2_USER / _PASS`) rather than a bare status line. Passwords are never printed — `/proxy` shows the target and the username, and the log/stderr paths show the target only, so credentials cannot reach the console, the browser panel, or Discord.

### Login passwords per group

`LOGIN_PASSWORD` is the password each bot sends to the server's `/register` and `/login`
prompts. It can be set per group, so a batch of accounts registered with a different
password still gets in:

```ini
LOGIN_PASSWORD=shared-password          # everyone not covered below

PROXY_GROUP_1_BOTS=Bot1,Bot2
PROXY_GROUP_1_HOST=1.2.3.4
PROXY_GROUP_1_LOGIN_PASSWORD=those-accounts-password

PROXY_GROUP_2_BOTS=Bot3
PROXY_GROUP_2_HOST=5.6.7.8
PROXY_GROUP_2_LOGIN_PASSWORD=their-own-password
```

A single bot can override both, which is the form that survives being moved to another
group:

```ini
BOT_PASSWORDS=Bot7:its-own-password,Bot9:another      # Bot7:...,Bot9:... , first colon splits
BOT_PASSWORD_Bot7=its-own-password                   # same thing, one variable per bot
```

Precedence, most specific first: **`BOT_PASSWORD_<BOT>` → `BOT_PASSWORDS` → `PROXY_GROUP_<N>_LOGIN_PASSWORD` → `LOGIN_PASSWORD` → the built-in `123456`**. A group
that sets nothing, and a bot that sets nothing, are both unchanged by this feature.
`LOGIN_PASSWORD` is *not* required when every bot is covered some other way.

Passwords are used **exactly as written** — never trimmed. A password may legitimately
begin or end with a space, and silently editing it would turn a correct credential into a
server-side "wrong password" you cannot reproduce by typing it. A space *before* a bot
name in `BOT_PASSWORDS` is separator formatting and is dropped; nothing else is. If the
resolved password has leading or trailing whitespace, `/status` says so, because that is
otherwise invisible.

`BOT_PASSWORD_<BOT>` is the escape hatch when a password itself contains a comma (which
the comma-separated list cannot express) and is matched case-insensitively, so
`BOT_PASSWORD_bot7` still serves `Bot7`.

This is the **account** password, unrelated to `PROXY_GROUP_<N>_USER` / `_PASS` (the
proxy's login) — the group is only used here as "these bots belong together". The group
is the place to configure it because that is where the bot list already lives.

The password is never logged: `/status` reports which variable supplied it
(`Login password: from PROXY_GROUP_1_LOGIN_PASSWORD`) and the auth prompt does the same,
which is what you need to debug a rejected login without putting the value in the
dashboard, the log file, or Discord.

> Because a group password is attached to the *group*, moving a bot between groups
> changes the password it logs in with. Give a bot that has its own password a
> `BOT_PASSWORD_<BOT>` entry and the move is harmless.

#### Rejected logins stop the bot instead of hammering the server

A wrong password used to be retried forever: the bot answers every `/login` prompt it
sees, the server kicks for repeated failures, and the reconnect loop starts again — which
is how a one-character typo in `.env` became a ban.

Now a rejection is recognised and recorded (per bot, in memory only):

```
BotOne: auth bad-password — Wrong password — stopped sending auth commands
BotOne: fix the password (LOGIN_PASSWORD, PROXY_GROUP_<N>_LOGIN_PASSWORD, or BOT_PASSWORDS), then run /auth-retry BotOne
```

- **`bad-password`** — wrong/incorrect/invalid password, "passwords do not match",
  "authentication failed". Sticky: the bot stops answering prompts, the bot card gets a
  `🔑` badge, `/list` and `/status` say why, and Discord is alerted **once** naming the
  variable to fix.
- **`throttled`** — "too many attempts", "please wait before trying again", "try again
  later". The bot waits, then tries again, but only `AUTH_MAX_THROTTLED_RETRIES` times
  before escalating to `bad-password` — an endlessly repeated "try again later" is a wrong
  password wearing a hat, and no amount of waiting should turn into an infinite retry.
- **`already`** — "already logged in", "already registered". A short pause only, never a
  credential verdict: on a fast reconnect the previous session often has not expired yet.

`/auth-retry <bot>` clears the record and reconnects. A **process restart also clears** it,
deliberately — the fix is an edit to `.env`, and a restart is how that edit lands.

The wording is the only evidence available (the server sends auth failures as ordinary
chat), so the guard is deliberately narrow: a reply only counts as a failure if the bot
sent an auth command within `AUTH_REPLY_WINDOW_MS`, and anything shaped like player chat
(`Name: message`) is ignored. A player typing "wrong password" in chat cannot disable a
bot.

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
| `DASHBOARD_TITLE` | `AFK Console` | Browser tab title for the dashboard and sign-in page |
| `WEB_REFRESH_MS` | `2000` | HTTP fallback poll cadence for dashboards without a WebSocket |
| `LOG_MAX_LINES` | `1500` | Stored lines per bot/system channel (dashboard sends the last `LOG_VIEW_LINES`; lower = less memory) |
| `LOG_VIEW_LINES` | `400` | Lines per channel sent to the dashboard on connect/refresh |
| `LOG_PRUNE_MINUTES` | `20` | Drop log lines older than this; `0` keeps the whole session |
| `LOG_PRUNE_INTERVAL_MS` | `60000` | How often expired log lines are swept |
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

**Running without Docker builds the client on demand.** The container image
bakes the client in, so `/play` works immediately there; `npm run start` on a
bare checkout has no build at all. With `MC_WEB_AUTO_BUILD` on (the default)
the build starts by itself the first time `/play` is opened — lazily, exactly
like the client server itself, so nothing is downloaded or compiled unless you
actually open the tab — and the page shows live build output, refreshing itself
until the client is ready. A failed build shows the tail of the output plus the
command to retry. Set `MC_WEB_AUTO_BUILD=false` to keep the old behaviour and
build by hand.

The build is bash-only (`set -euo pipefail`). Debian and Ubuntu point `/bin/sh`
at dash, which rejects `pipefail` with `set: Illegal option -o pipefail`, so
both `npm run web-client:build` and the on-demand build invoke it with `bash`
(the interpreter the Dockerfile uses). A stray `sh scripts/build-web-client.sh`
fails immediately on those systems.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MC_WEB_ENABLED` | `true` | Show the PLAY button and `/play` route; also gates the on-demand build |
| `MC_WEB_AUTO_BUILD` | `true` | Build the client automatically on the first `/play` when no build exists (the Docker image already has one, so this only matters outside Docker). `false` = never build; `/play` shows the build-not-found page |
| `MC_WEB_BUILD_CMD` | *(empty)* | Override the build command run by the on-demand build (default: `bash scripts/build-web-client.sh`), e.g. a wrapper that adds a proxy or a mirror |
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
# Target one bot; @every remains the schedule.
CRON_JOB_3=@every 3000|@Hypr_7_core /spawners
# Target multiple bots with comma-separated names.
CRON_JOB_4=@every 3000|@BotA,BotB /data
```

The schedule is either a standard 5-field cron expression
(`minute hour day-of-month month day-of-week`; day-of-week 0-6, 7 accepted as
Sunday) or `@every <seconds>` (minimum 5). Fields support `*`, `*/n`, `a-b`,
`a-b/n`, and comma-separated lists.

Jobs are also managed from the terminal or the dashboard with `/cron` (list),
`/cron add <schedule> <command>`, `/cron rm <id>`, `/cron on|off <id>`, and
`/cron run <id>` (run fires immediately, even for a disabled job). Jobs added at
runtime are written to `CRON_STATE_FILE` and reloaded on the next start, so
`/cron add` survives a restart; `.env` jobs load first and win over a saved
copy of the same `schedule|command`. Set `CRON_PERSIST=false` to keep runtime
jobs in memory only.

The schedule may be quoted (`/cron add "0 4 * * *" /crates-all`) or bare
(`/cron add 0 4 * * * /crates-all`, `/cron add @every 60 /status`); the rest
of the line is the command, so chat messages with spaces work too. When both
day-of-month and day-of-week are restricted, cron fires when either matches
(standard OR semantics). A job that is still running when its next trigger
arrives is skipped (no overlapping runs), and dispatcher errors are logged to
the system channel.

`/cron add` treats everything after the schedule as the job command, so chained
commands work exactly like they do in `CRON_JOB_<N>`:

```text
/cron add @every 3600 @Hypr_7_core /spawners && sleep 10s && /data
```

To target specific bots, prefix the command with `@BotName` or a comma-separated
list. The target may sit on either side of the schedule:

```text
/cron add @every 3000 @Hypr_7_core /spawners
/cron add @Hypr_7_core @every 3000 /spawners
/cron add 0 4 * * * @BotA,BotB /data
```

```dotenv
CRON_JOB_3=@every 3000|@Hypr_7_core /spawners
CRON_JOB_4=@every 3000|@BotA,BotB /data
```

Without a target prefix, local commands retain their existing all-bots behavior.
Target names are matched case-insensitively, so `@hypr_7_core` finds
`Hypr_7_core`. Unknown target names cause that job to be skipped and logged
(with the current roster) instead of being sent to the wrong bot, and `/cron add`
warns about them immediately after adding the job.

`CRON_ENABLED=false` stops the scheduler without deleting jobs: they stay listed,
and `/cron run <id>` still fires one by hand. `CRON_TICK_MS` (default 1000)
sets how often due jobs are checked.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CRON_ENABLED` | `true` | Set to `false` to stop firing jobs (they stay listed and runnable by hand) |
| `CRON_TICK_MS` | `1000` | How often due jobs are checked |
| `CRON_PERSIST` | `true` | Set to `false` to keep runtime jobs in memory only |
| `CRON_STATE_FILE` | `cron-jobs.json` | Where `/cron add` jobs are saved and reloaded from |
| `CRON_JOB_<N>` | unset | `"<schedule>|<command>"` job loaded at startup; takes precedence over a saved duplicate |

`cron-jobs.json` holds only the job configuration (schedule, command, enabled),
is written atomically, and is safe to delete — it is recreated on the next
`/cron add`. Startup order is `.env` jobs first, then the state file.

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
| `/cron` | List scheduled jobs; `/cron add <schedule> <cmd>`, `/cron rm <id>`, `/cron on|off <id>`, `/cron run <id>`. Jobs persist to `CRON_STATE_FILE` across restarts |
| `/data [check|status]` | Compile and push the spawner snapshot; `check` verifies the Apps Script deployment, `status` shows the webhook config without touching the network |
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
| `/removed` | List the removed / permanently-banned bots |
| `/auth-retry <bot>` | Clear a recorded login/register failure and reconnect so it can authenticate again |
| `/unban <bot>` | Take a bot off the removed list and reconnect it |
| `/closeBot` | Disconnect and remove the active bot |
| `/dump` | TPA and deposit inventory into nearby chests |
| `/crates [color]` | Run one crate collection cycle |
| `/crates-loop [n] [color]` | Repeat crate collection |
| `/crates-all [n] [color] [dump=…] [afk=…]` | Run shardshop, crates, and dump across bots; `dump=`/`afk=` override the sequence defaults for that run |
| `/crates-solo [bot] [color] [dump=…] [afk=…]` | Run that sequence for one bot, with the same flags |
| `/drop [count]` | Drop the held stack (or `count` items from it) |
| `/pickup [all]` | Pathfind to the nearest dropped item and collect it (`all` = sweep the area) |
| `/gui <server command>` | Open a server GUI and manage it manually (no auto-click/auto-warp) |
| `/take <slot\|name\|all>` | Shift-click an item out of the open GUI into the inventory |
| `/take-gui` / `/dump-gui` | Move all items GUI→inventory, or inventory→GUI |
| `/view first\|third` | Switch the 3D viewer camera (first-person vs orbit) |
| `/pos` | Show the active bot's position, facing, and dimension |
| `/gui-tui` | Toggle the clickable ASCII GUI overlay for the open window |
| `/exit` | Disconnect all bots and exit |
| `/bot-coinflip` | The whole coinflip suite in one command — run, stats, deep, history and export; bare `/bot-coinflip` prints the list and a summary of what has been recorded |
| `/bot-coinflip run [PRICE] [AMOUNT] [BOT]` | Play `AMOUNT` coinflips (default 10) on `BOT` (default: the selected bot) and record every one. `PRICE` is a fixed wager (`500000`) or a random range (`10k-1m`, the `COINFLIP_WAGER_MIN`-`MAX` defaults), and `all` targets the whole roster. A busy or rate-limited create is waited for and re-asked, never deleted. Works with `/all-slow`: `/all-slow /bot-coinflip run 10k-1m 20` |
| `/bot-coinflip stats [BOT]` | Win/loss counts, net, streaks, drawdown, per-opponent and per-bot breakdowns, and the fairness verdict for one bot or the fleet |
| `/bot-coinflip deep [BOT]` | Dissect the recorded flips fourteen ways at once — what follows a run of losses, whether the previous flip predicts the next, run lengths, wager as a share of the balance, hour of day, pace, session position, raising after a loss, opponents and the money curve — with every bucket corrected for multiple testing. Writes `data/coinflip-deep.json` |
| `/bot-coinflip history [n\|clear confirm]` | The last `n` recorded flips (default 20), with how each result was detected and any message/balance mismatch |
| `/bot-coinflip export [BOT]` | Write `data/coinflip-export.csv`, one row per recorded flip, for a spreadsheet, pandas or R |
| `/coinflip …` | The **game's** own coinflip command, owned by the server. The console never intercepts this name, so a bare `/coinflip`, `/coinflip create 10k` and `/coinflip delete` all reach the selected bot (or every bot, under `/all-slow`) as chat |
| `/bot-coinflip help` | The same list from the console (a bare `/bot-coinflip` prints it too) |
| `/timeseries [sample [ranks]\|series <metric> [bucket] [bot]\|events\|clear confirm]` | Shards, coins, balance, rank and ban counts over time - a sparkline, the last buckets, and where the JSON lives |
| `/analytics` | Where the read-only analytics page and its JSON endpoints are |
| `/env [list [filter]\|get KEY\|set KEY VALUE\|reset KEY\|reset-all]` | Show or change a configuration value for this run only - never written to `.env` |

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
| `BAN_MESSAGE_REGEX` | Extra ban-detection pattern for your server's wording |
| `DISCORD_BAN_COOLDOWN_MS` | Ban alert repeat suppression (default `900000`) |
| `BAN_SWEEP_MS` | How often a held ban is checked for expiry (default `60000`) |
| `BAN_RETRY_MS` | Retry window for a ban with no stated length (default `1800000`) |
| `PERMANENT_BAN_ACTION` | `remove` (default, leaves the roster) or `hold` (stays visible) |
| `REMOVED_BOTS_FILE` | Removed / perma-banned list (default `removed-bots.json`) |

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

## Coinflip data collection, time series and analytics

`/bot-coinflip run` exists to answer one question with evidence: **is the coinflip
fair?** It plays a series of flips, records every one of them, and then does the
statistics on the records rather than on a running tally.

The suite owns `/bot-coinflip` and nothing else. It used to live at the bare
`/coinflip`, which meant it shared a name with the **server's** own coinflip
command — so a plain `/coinflip create 10k` could be shadowed by a console
subcommand. The server keeps that name now: anything spelled `/coinflip …` goes
to the bot as chat, and the data commands are reached through `/bot-coinflip`.
The old dash spellings (`/coinflip-data-run`, `/coinflip-stats`,
`/coinflip-history`, `/coinflip-deep`) are gone with it — macros using them need
`/bot-coinflip run`, `/bot-coinflip stats`, `/bot-coinflip history` and
`/bot-coinflip deep`.

### How one flip is detected

The server announces results as ordinary chat lines, so every available signal is
used - and each record says which one settled it:

| Signal | Meaning | Recorded as |
| --- | --- | --- |
| `Result: Won` / `Result: Lost` together with `Amount Bet:`, `Winner:`, `Loser:` | the block the server prints, arriving as four separate lines | `method: message` |
| the balance moved by exactly the wager | no usable message, but `/bal` either side of the flip settles it | `method: balance` |
| a **new create was accepted** | the server announces wins, so silence plus a new create means the previous flip ended in a loss | `method: recreate` |
| nothing at all | the flip stays pending and the next accepted create settles it | - |

Those lines have to be the whole line, so a player typing `Loser: how about that
coinflip` into chat cannot forge a result.

`You already have an active coinflip! Please use /coinflip delete first...` is
**never** answered with a delete and remake: remaking cannot succeed while a flip
is open, so the run waits `COINFLIP_BUSY_WAIT_MS` and re-asks, and gives up after
`COINFLIP_BUSY_MAX_WAIT_MS` without touching the flip. If nobody joins, the flip
is left open and the run stops with `no-opponent` rather than piling up new ones.
A wager above the balance is never sent at all.

The server also rate-limits chat commands: a create sent too soon after the `/bal`
that precedes it is answered with `Error | You are on cooldown`. That reply is
recognised as its own event, so the run waits (`COINFLIP_CREATE_COOLDOWN_MS`,
default **2500ms**, is left in front of every create) and asks again - a
rate-limited create never happened, so it is retried rather than recorded as a
loss. After `COINFLIP_COOLDOWN_MAX_RETRIES` consecutive refusals the run stops
with `cooldown` and says to raise the setting.

A flip whose result message and balance movement disagree is flagged `mismatched`
and printed in red - that is precisely the evidence a rigged game would produce,
and averaging it away would destroy it.

### The fairness verdict

`/bot-coinflip stats` (and the last line of every run) reports:

- **win rate** with a 95% Wilson confidence interval, against the 50% a fair coin gives;
- a **two-sided binomial p-value** over the resolved flips;
- a **runs test** for independence - a fair coin is not an alternating coin, and an implausibly streaky sequence is suspicious in a different way from a biased rate;
- **net per flip** with its confidence interval: a fair even-money game averages exactly 0, so an edge shows up here even when the win rate looks about right;
- **streaks, maximum drawdown, and per-bot / per-opponent breakdowns.**

A verdict is only given after `COINFLIP_MIN_SAMPLE` resolved flips (default 30);
below that it says `insufficient-data`, because a verdict from eight flips is
noise with a label. A p-value below `COINFLIP_SUSPICION_P` (default 0.01) is
`suspicious`; below 0.05 is `watch`.

### Where the data lives

| File | Contents |
| --- | --- |
| `data/coinflip-history.jsonl` | Append-only, one JSON object per flip: bot, timestamp, wager, opponent, result, balance before/after, delta, detection method, contradiction flag |
| `data/coinflip-stats.json` | The derived summary (statistics, fairness verdict, recent flips) written after every run |
| `data/coinflip-deep.json` | The dissection report (every section, bucket, p-value and q-value) rewritten whenever the history changes |
| `data/timeseries.jsonl` | One sample per bot per interval (`kind: bot`) plus a fleet total (`kind: fleet`): shards, coins, balance, rank, ban state, inventory usage |
| `data/timeseries-summary.json` | Bucketed series and the derived ban/rank events, ready to drop into a spreadsheet or a chart |
| `data/coinflip-export.csv` | Written by `/bot-coinflip export`: one row per flip with the wager as a share of the balance, so it opens directly in a spreadsheet |

These are generated files (git-ignored), and nothing here writes to `.env`.

### Sampling cadence

Samples are recorded on `TIMESERIES_INTERVAL_MS` (default hourly), after every
`/data` and `/overview` pass (which already query the server, so nothing is asked
twice), on `/timeseries sample`, and shortly after boot
(`TIMESERIES_STARTUP_DELAY_MS`). Ranks cost a `/fix` probe each, so they have
their own slower interval (`TIMESERIES_RANK_INTERVAL_MS`; `0` disables). Ban and
rank *changes* are derived from the samples themselves, so there is no second
event log to drift out of sync with the first.

### The deep dissection

`/bot-coinflip deep [BOT]` answers the questions the fairness verdict does not: it
slices the same records fourteen ways and reports each bucket with its own
sample size, 95% confidence interval and p-value.

| Dissection | Question it answers |
| --- | --- |
| Runs and what follows them | after *k* losses, does the next flip win, and does a win arrive within two or three flips - one of them, or both of the next two? (a fair coin: 50%, 75%, 87.5% and 25%) |
| The transition table | `P(win \| win)` vs `P(win \| loss)` as a two-proportion test, with the persistence odds ratio |
| Run lengths | the observed streak lengths against the geometric distribution a fair coin gives (chi-square) |
| Serial correlation | the correlation between a flip and the one 1-5 flips before it |
| Wager vs balance | the wager as a share of the balance, bucketed, with a Cochran-Armitage trend test - does betting a bigger slice change the odds? |
| Wager size | the same by absolute amount |
| Rich or poor | win rate in the poorest quartile, the middle half and the richest quartile |
| Time of day | 24 hour buckets plus four six-hour windows, using the **server's own clock** stamped on each result block |
| Pace and idling | the gap since the previous flip on that bot |
| Session position | flip #1 against #2-3, #4-6, #7-10, #11-20 and #21+ |
| Chasing and staking | does a wager raised after a loss win more often? |
| Opponents | each named opponent's win rate |
| The money curve | net, deepest drawdown, the longest stretch below a high, the biggest single win and loss, and net per flip with its interval |
| Per bot | each bot's rate, when more than one is recorded |

Twenty ways of slicing one dataset will hand you a "significant" bucket every
time, so every p-value in the family is corrected together with the
Benjamini-Hochberg step-up and reported as a **q-value**. A bucket under
`COINFLIP_DEEP_MIN_BUCKET` flips (default 20) is marked as an anecdote, and
findings are only called out when they beat `COINFLIP_DEEP_Q` (default 0.05)
*after* the correction. The hour of day comes from the timestamp the server puts
on each result line; a record without one falls back to the local clock shifted
by `COINFLIP_TZ_OFFSET_MIN`.

The command prints the tables and the takeaways, writes the whole report to
`data/coinflip-deep.json`, and shows up on the analytics page and at
`/api/coinflip/deep?bot=Name`.

### Reading the data

Four ways in, depending on the question:

| To answer | Use |
| --- | --- |
| "what happened, in one screen?" | the analytics page on port 8080 (`/analytics` prints the URL) |
| "is a pattern real?" | `/bot-coinflip deep [BOT]` — fourteen lenses, every bucket with a confidence interval, p-values corrected together |
| "is it fair at all?" | `/bot-coinflip stats [BOT]` — win rate, binomial p, runs test, net per flip |
| "I want to do my own statistics" | `/bot-coinflip export [BOT]` for a CSV, or the JSONL files below |

The raw history is append-only JSONL, one object per flip, so `jq`, pandas or R
can read it without going through this program:

```bash
# every flip as a CSV, ready for pandas / R / a spreadsheet
node -e "console.log(require('./bot-coinflip').toCsv(require('./bot-coinflip').createCoinflipStore({ file: 'data/coinflip-history.jsonl' }).all()))" > flips.csv

# the median wager as a share of the balance, which is the "big bet" question
jq -r 'select(.balanceBefore) | .wager / .balanceBefore' data/coinflip-history.jsonl | sort -n | awk '{a[NR]=$1} END {print a[int(NR/2)]}'
```

`/api/export` hands the whole dataset (every flip, every sample, the dissection)
back as one JSON document, which is what to use when the analysis is going
somewhere else entirely.

### The analytics page

`ANALYTICS_PORT` (default **8080**) serves a read-only report built from those
files - no chart library, no CDN, and nothing leaving the machine:

| Route | Contents |
| --- | --- |
| `/` | Coinflip statistics with the fairness verdict and confidence interval, the deep dissection (every bucket corrected for multiple testing), fleet charts for shards / coins / balance / regent ranks / bans, the latest value per bot, and the ban and rank-change tables |
| `/api/analytics` | The whole report as JSON |
| `/api/coinflip` | Coinflip statistics, fairness analysis and recent flips |
| `/api/coinflip/deep[?bot=Name]` | The whole dissection as JSON - every bucket, p-value, q-value and takeaway |
| `/api/timeseries?metric=shards&bucket=1h[&bot=Name]` | Bucketed points (last / min / max / mean per window) plus the summary |
| `/api/export` | Every recorded flip and sample, for analysis elsewhere |

It requires the dashboard session cookie (cookies are shared across ports on the
same host, so signing in on the dashboard is enough). `ANALYTICS_OPEN=true`
serves it with no login at all; `ANALYTICS_ENABLED=false` turns it off. The port
itself is read at boot, so changing it needs a restart - the `.ENV` tab says so.

### `.ENV` tab - temporary settings

The dashboard's `.ENV` tab lists every tunable value with its description and
current value and changes one **for this run only**:

- nothing is ever written to the `.env` file, and a restart forgets every override - edit the file for a permanent change;
- values marked `startup-only` were read once at boot, so the tab says so instead of pretending the change took effect;
- secrets are settable but never displayed: the tab shows `(set)` or `(unset)`, never the value;
- `/env set KEY VALUE`, `/env get KEY`, `/env reset KEY` and `/env reset-all` do the same from the console, and a value that cannot be parsed is refused rather than silently becoming the default.

### Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `COINFLIP_DEFAULT_FLIPS` | `10` | Flips per bot when `/bot-coinflip run` is given no count |
| `COINFLIP_WAGER_MIN` / `COINFLIP_WAGER_MAX` | `10000` / `1000000` | The random wager range (`10k-1m`) |
| `COINFLIP_STOP_LOSS` | `10000000` | Stop a per-bot run once its net loss reaches this |
| `COINFLIP_BALANCE_FRACTION` | `1` | Never wager more than this fraction of the balance |
| `COINFLIP_BUSY_WAIT_MS` / `COINFLIP_BUSY_MAX_WAIT_MS` | `15000` / `900000` | How long to wait on an active coinflip before re-asking / giving up |
| `COINFLIP_FLIP_TIMEOUT_MS` | `600000` | How long one flip may wait for an opponent and a result |
| `COINFLIP_POLL_MS` | `15000` | How often the runner wakes to re-check |
| `COINFLIP_SETTLE_MS` | `1500` | Quiet period that closes a multi-line result block |
| `COINFLIP_MIN_SAMPLE` / `COINFLIP_SUSPICION_P` | `30` / `0.01` | Flips needed for a verdict / the p-value called suspicious |
| `COINFLIP_FILE` / `COINFLIP_SUMMARY_FILE` / `COINFLIP_DEEP_FILE` | `data/coinflip-history.jsonl` / `data/coinflip-stats.json` / `data/coinflip-deep.json` | Where the history, the summary and the dissection report are written |
| `TIMESERIES_ENABLED` | `true` | Record samples at all |
| `TIMESERIES_INTERVAL_MS` | `3600000` | Sampling interval (durations accept `30s`, `15m`, `1h`) |
| `TIMESERIES_RANK_INTERVAL_MS` | `21600000` | Rank probe interval; `0` disables it |
| `TIMESERIES_STARTUP_DELAY_MS` | `120000` | First sample after boot; `0` disables it |
| `TIMESERIES_FILE` / `TIMESERIES_SUMMARY_FILE` | `data/timeseries.jsonl` / `data/timeseries-summary.json` | Where the samples and the snapshot are written |
| `ANALYTICS_ENABLED` / `ANALYTICS_PORT` | `true` / `8080` | The read-only report and the port it listens on |
| `ANALYTICS_OPEN` | `false` | Serve the report with no dashboard login |
| `ANALYTICS_BUCKET_MS` | `3600000` | Chart bucket size (the API also takes `?bucket=30m`) |
| `COINFLIP_CREATE_COOLDOWN_MS` | `2500` | Gap left after the `/bal` answer and before each `/coinflip create` - that balance check is what trips the server rate limit |
| `COINFLIP_COOLDOWN_MAX_RETRIES` | `5` | Consecutive `you are on cooldown` replies tolerated before a run stops |
| `COINFLIP_DEEP_MIN_BUCKET` | `20` | Flips a bucket needs before a dissection treats it as evidence rather than an anecdote |
| `COINFLIP_DEEP_Q` | `0.05` | The false-discovery rate a finding must beat across every test in the family |
| `COINFLIP_TZ_OFFSET_MIN` | local offset | Minutes from UTC used for hour of day when a record has no server timestamp |
| `COINFLIP_EXPORT_FILE` | `data/coinflip-export.csv` | Where `/bot-coinflip export` writes the CSV |
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
| `google-apps-script/Code.gs` | Apps Script webhook behind `DATA_WEBHOOK_URL` (`/data` → Google Sheets) |
| `api.md` | Mineflayer API reference used by the project |
| `settings.js` | The runtime settings registry behind `/env` and the `.ENV` tab: temporary overrides, secret masking |
| `coinflip.js` | Coinflip line parsing, the session runner, statistics, and the fairness analysis |
| `timeseries.js` | The append-only time-series store: samples, buckets, summaries, derived ban and rank events |
| `analytics.js` | The read-only analytics report, page, and SVG charts |

## License

This project is provided as-is. Use it only on servers and accounts you are
authorized to automate.

## Discord Alerts and Memory Watchdog

The main bot runner can send Discord webhook alerts for 30-second server restart warnings, kicks, bans, unexpected disconnects, successful recovery, exhausted reconnect limits, proxy stalls, dashboard login lockouts, fatal process errors, and host memory pressure. Set `DISCORD_WEBHOOK_URL` and `DISCORD_USER_ID` in `.env`.

The restart detector requires both the case-insensitive phrase `SERVER WILL RESTART IN` and the standalone number `30` in the same server message. Duplicate alerts are suppressed for the configured cooldown.

### Ban detection

A server ban reaches the bot as an ordinary kick packet — there is no separate "banned" event — so the kick reason text is the only evidence, and it is classified before the generic kick alert is chosen:

| Classified as | Matches | Discord alert |
| --- | --- | --- |
| `permanent` | `banned`, `you have been banned`, `permaban`, `ban hammer`, or a ban with no expiry at all | **Bot banned**, red, critical |
| `temporary` | `temporarily banned`, `banned for 3 days`, `ban expires <date>`, **`Expires in: 29 days, 11 hours, 17 minutes`** | **Bot temporarily banned**, amber, with the duration in its own field |
| `blacklist` | `blacklisted`, `global ban`, `network-wide ban` | **Bot blacklisted**, dark red, critical |
| `suspected` | `alt detected`, `anti-bot`, `bot detected`, `automatic banned`, `suspicious activity` | **Possible bot ban**, orange, *not* critical |
| *(neither)* | anything else (`not whitelisted`, `AFK too long`, `socketClosed`) | the existing **Bot kicked** alert |

#### Why a branded ban screen needs parsing first

The kick reason is **not always a string**. Servers that brand their ban screen send a serialized chat component, and the text you need is buried in nested leaves:

```json
{"type":"compound","value":{"extra":{"type":"list","value":{"type":"compound","value":[
  {"color":{"type":"string","value":"gray"},"text":{"type":"string","value":"You have been banned due to "}},
  {"text":{"type":"string","value":"Expires in: "}},
  {"text":{"type":"string","value":"29 days, 11 hours, 17 minutes\n"}} ]}}}}
```

Matching patterns against that raw JSON finds the word `banned` and nothing else — no `Expires in:` — so a **29-day tempban was reported as permanent**. The tree is now walked and its text leaves joined before anything is matched (`test/fixtures/fatalmc-ban-kick.json` is the real thing, verbatim):

```
FATALMC
You have been banned due to Alt Farming (3rd) [1129]
Banned on: 16 Sep 2026, 13:34
Expires in: 29 days, 11 hours, 17 minutes
Think there's been a mistake? discord.gg/fatalmc
```

which yields `kind: temporary`, `duration: 29 days, 11 hours, 17 minutes`, `reason: Alt Farming (3rd)`, `caseId: 1129`. The `reason` is the phrase a human wrote — it is what reaches the spreadsheet cell and the Discord embed, never a 1.5 KB JSON blob.

#### The ban hold (it will not reconnect)

Once a bot is known to be banned it is **held**: no reconnect attempts, no backoff loop, no login storm against a server that has already thrown the account out.

- **A temporary ban is held until its expiry.** The ban is a wall-clock fact, so the absolute time is what is stored — a 29-day ban cannot live in a `setTimeout`, and the number has to outlive the process. It does: it is written to the data file, so a restart does not walk straight back into the ban. A periodic sweep (`BAN_SWEEP_MS`, default 60 s) is what ends the hold, reconnecting the bot when the expiry passes.
- **A permanent ban is never released**, and the bot is moved onto the **removed list** (see below). Nothing reconnects it, and it is recorded as `permanent` so it is distinguishable forever.
- **An unstated length is not a permanent ban.** A `temporary` ban with no duration, or a `suspected` one, is retried after `BAN_RETRY_MS` (default 30 min) rather than written off — the server saying "temporarily" is not the same as it saying "forever".
- **The first detection sets the clock.** Later kicks from the same ban cannot push the release time further out.
- **The bot stays visible while held** — as `⛔ banned` in the dashboard and `/list` — rather than being silently deleted like `/closeBot`. If you would rather it disappear from the roster entirely, say so.
- **Startup checks the file first**: a bot still inside its ban window is not connected at all, and says why.

A ban is surfaced in five places, all from the same verdict:

- **Discord** — its own title, colour, and cooldown, so it cannot be mistaken for a disconnect in the feed. Once per bot per ban type: reconnecting against a live ban does not spam the channel.
- **The `Bots` tab** — `banned` (`TRUE`/`FALSE`), `bannedAt` (a real date, when the ban started), `banKind`, plus `banDuration`/`banExpiresAt`/`banCaseId`/`banReason` once there is a ban to report.
- **The `Bans` tab** — one row per banned bot, so the bans and the permanent bans are tracked in the spreadsheet: `kind`, `reason`, `caseId`, `duration`, `expiresAt` (a real date, blank when permanent), `permanent` (`TRUE`/`FALSE`), `firstBannedAt`, `lastBannedAt`, and `count` so repeat bans are visible without a second tab.
- **The dashboard** — a red `⛔ banned` badge on the bot's card, with the kind and kick text in its tooltip, and the offline toast says *was banned* rather than *went offline*.
- **`/list`** — `⛔ banned (temporary)` next to the offline entry.

The flag clears itself on the next successful spawn, which is how a temporary ban expiring (or a manual unban) stops being reported.

Three settings, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BAN_MESSAGE_REGEX` | *(unset)* | Extra case-insensitive pattern for your server's own wording, e.g. `you have been removed from`. An invalid pattern is ignored with a startup warning. |
| `DISCORD_BAN_COOLDOWN_MS` | `900000` | How long one ban alert suppresses repeats for the same bot and type |
| `DISCORD_AUTH_COOLDOWN_MS` | `1800000` | How long one login-rejected alert suppresses repeats for the same bot and kind |
| `BAN_SWEEP_MS` | `60000` | How often a held ban is checked for expiry |
| `BAN_RETRY_MS` | `1800000` | Retry window for a ban whose length the server never stated |
| `PERMANENT_BAN_ACTION` | `remove` | What a permanent ban does to the live roster: `remove` (like `/closeBot`) or `hold` (stays visible with the badge) |
| `REMOVED_BOTS_FILE` | `removed-bots.json` | The removed / permanently-banned list |

#### The removed / permanently-banned list

A permanent ban means the account is gone, so the bot leaves the roster instead of being retried forever. That fact has to outlive the process and cannot live in `.env` — the bot cannot edit `BOT_NAMES` for you — so it is its own file:

```json
{ "version": 1, "updatedAt": "...", "bots": [
  { "bot": "Hypr_7_core", "kind": "permanent", "reason": "cheating", "caseId": "4411",
    "addedAt": 1758067200000, "addedBy": "ban-detection", "count": 1 } ] }
```

The list outranks everything: a bot on it is not connected at startup **and** not reconnected, even while it is still named in `BOT_NAMES` — you get a warning saying so rather than silence. It is saved atomically like the other state files and matched case-insensitively, because a name arrives from `.env`, from a kick message, and from whatever you type.

| Command | Effect |
| --- | --- |
| `/removed` | List the removed / permanently-banned bots with each reason, case id, and when it was added |
| `/unban <bot>` | Take one off the list, clear its ban hold, and reconnect it |

With the default `PERMANENT_BAN_ACTION=remove` the bot is also disconnected and dropped from the dashboard exactly like `/closeBot`, leaving the record in the `Bans` tab and Discord. Set `PERMANENT_BAN_ACTION=hold` to keep it visible with the `⛔ banned` badge instead.

A permanent ban still logs `Remove it from BOT_NAMES too`, because `.env` is yours: the file stops the bot connecting, and tidying `BOT_NAMES` is what stops the startup warning.

The memory watchdog uses Linux `/proc/meminfo` where available so container/host memory availability and swap usage can be monitored. It falls back to Node's OS memory counters on other platforms. Alerts are stateful, rate-limited, and followed by a recovery notice once available memory returns above `MEMORY_RECOVERY_PERCENT`.
