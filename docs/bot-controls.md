# Slow broadcasts and browser bot selection

These settings apply to `bot.js`, not `bot-rtp.js`. Restart the process after
editing `.env` and refresh browser tabs after upgrading.

```dotenv
ALL_SLOW_DELAY_MS=15000
RANDOMIZE_BOT_ORDER=true
```

## `/all-slow <command or message>`

Like `/all`, but dispatches to the first bot immediately and then one bot per
delay interval (15 seconds by default). For example:

```text
/all-slow /status
/all-slow /crates purple
/all-slow hello
```

- `ALL_SLOW_DELAY_MS` is in milliseconds. It must be an integer from 1 through
  2147483647; missing, blank, zero, negative, fractional, or invalid values fall
  back to 15000 rather than being clamped to a rapid timer by Node.
- The roster is captured when the command starts. Bots added later are not
  included. Removed bots are skipped; raw chat skips bots that are not spawned
  at dispatch time. Local commands retain their own offline handling.
- Arguments to local commands are preserved for both `/all` and `/all-slow`.
- The delay spaces command *starts*, not completion of asynchronous routines.
  Long-running routines may overlap and retain their existing per-bot guards.
- Only one slow broadcast may be active at a time. A second request is rejected
  with a warning; `/exit` cancels pending dispatches. Normal `/all` stays immediate.
- The scheduler holds only one pending timeout, rather than one timeout per bot.

## Random initial connection order

`RANDOMIZE_BOT_ORDER` defaults to `true`. A Fisher-Yates shuffle creates a copy
of `BOT_NAMES` at startup; the configured list itself is not mutated. Existing
`CONNECT_DELAY_MS` and `CONNECT_DELAY_RANDOM_MS` spacing still applies.

Set `RANDOMIZE_BOT_ORDER=false` to connect in the configured order. `0`, `no`,
and `off` also disable shuffling (case-insensitive). Reconnect ordering is not
changed. Bot list numbers follow creation order, so use `/list` before numeric
`/switch` commands or use an exact name for a stable target.

## `/switch <name or number>` in the WebGUI

Switching selects and highlights the bot, updates its log subscription/history,
and targets following commands to that bot. Selection belongs to the requesting
browser tab; it does not change another tab or the TUI's active bot.

Both WebSocket and HTTP fallback send the selected bot with each command.
`/api/command` returns JSON `{ "accepted": true, "selectedId": null }`; a
successful switch returns the selected bot name instead of `null`.
The form fallback preserves selection through a `?view=` redirect. Invalid
switch targets produce a warning rather than being sent to the game server.
Commands aimed at a removed bot are not silently redirected to another bot.

An ambiguous HTTP failure is no longer automatically replayed on reconnect:
check logs before retrying to avoid accidentally executing a command twice.

## Resource fixes

- Filtered browser logs remain bounded even if none of the incoming lines match.
- The all-channel history sort considers only the newest 400 entries per channel,
  rather than every retained line, while returning the same newest-400 history.
- WebSocket log batches are not allocated or scheduled without connected viewers.
- Stale HTTP poll responses do not overwrite the newly selected channel's logs.

## Manual interact: items and server-command GUIs

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

## Tests

```sh
npm test
node --check bot.js
```

Tests use Node's built-in runner and mocked Minecraft/network dependencies; they
never connect to a live game server or require credentials. They cover delay
validation, ordering, timing, cancellation, errors, local arguments, browser-tab
isolation, HTTP/form routing, stale targets, and immediate `/all` behavior.
