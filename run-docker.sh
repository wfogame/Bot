#!/usr/bin/env bash
# ── AFK Console orchestrator: one container per .env.dockerN ──────────────────
# Usage:
#   ./run-docker.sh               build + (re)start every .env.dockerN
#   ./run-docker.sh stop          stop & remove all managed containers
#   ./run-docker.sh status        list managed containers
#   ./run-docker.sh logs [n]      follow logs (default: instance 1)
#   ./run-docker.sh proxy         run the Minecraft web-client proxy (mwc-proxy)
#
# Host port allocation: first free port starting at WEB_PORT_HOST (default 80),
# so instance 1 usually lands on :80, instance 2 on :81, etc. — skipping
# anything already listening on the host. Re-runs are stable: each instance's
# old container is removed BEFORE probing, so it keeps "its" port instead of
# being pushed up by its own previous run.
#
# Optional env:
#   WEB_PORT_HOST=8080     start host-port scan elsewhere
#   APP_FILE=bot.js        app script name (default bot.js)
#   IMAGE / CONTAINER_PREFIX
#   PERSIST_TOR=1          keep Tor identity across container recreation (named volume)
#   DOCKER_RUN_FLAGS="..." extra flags for docker run (e.g. --memory 2g)
#   DOCKER_BUILD_FLAGS="..." extra flags for docker build (e.g. --no-cache)
#   MANUAL_VIEWER_HOST_PORT=3000  first candidate host port for the manual 3D
#      viewer. Each instance gets the next free block of 10 (container ports
#      MANUAL_VIEWER_PORT..+9), so the dashboard's viewer button works from the
#      host even with several containers running.
#   MC_WEB_CLIENT_HOST_PORT=8090  first candidate host port for the self-hosted
#      Minecraft web client (dashboard /play tab). Each instance maps its
#      container MC_WEB_CLIENT_PORT onto the next free host port, and
#      MC_WEB_CLIENT_HOST_PORT is injected so /play builds the right URL.
set -euo pipefail

IMAGE="${IMAGE:-afk-console}"
PREFIX="${CONTAINER_PREFIX:-afk-console}"
APP_FILE="${APP_FILE:-bot.js}"
PORT_BASE="${WEB_PORT_HOST:-80}"
PORT_SPAN="${WEB_PORT_HOST_MAX:-40}"
VIEWER_HOST_BASE="${MANUAL_VIEWER_HOST_PORT:-3000}"
vnext="$VIEWER_HOST_BASE"
CLIENT_HOST_BASE="${MC_WEB_CLIENT_HOST_PORT:-8090}"
cnext="$CLIENT_HOST_BASE"
DOCKER_RUN_FLAGS="${DOCKER_RUN_FLAGS:-}"
DOCKER_BUILD_FLAGS="${DOCKER_BUILD_FLAGS:-}"
PERSIST_TOR="${PERSIST_TOR:-0}"

cd "$(dirname "$0")"
say() { printf '%s\n' "$*"; }
err() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; }

# Anything listening on this host port? (bash /dev/tcp probe)
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# Are all 10 ports of a viewer block free? (one 10-port block per instance)
block_free() {
  local k
  for k in $(seq 0 9); do
    port_free "$(($1 + k))" || return 1
  done
  return 0
}

cmd="${1:-up}"
case "$cmd" in
  up) ;;
  stop)
    found=0
    for c in $(docker ps -a --format '{{.Names}}' | grep -E "^${PREFIX}-(proxy|[0-9]+)$" || true); do
      docker rm -f "$c" >/dev/null && say "removed $c"; found=1
    done
    [ "$found" -eq 0 ] && say "no managed containers found"
    exit 0
    ;;
  status)
    docker ps -a --filter "name=${PREFIX}-" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    exit 0
    ;;
  logs)
    exec docker logs -f "${PREFIX}-${2:-1}"
    ;;
  proxy)
    # Minecraft web client proxy — WebSocket→TCP bridge for the dashboard's /play
    # tab (zardoy/minecraft-web-client). Browsers speak WebSocket; the proxy
    # relays to any Java server over plain TCP, so your server needs no plugins
    # and works with offline-mode (cracked) servers. Point MC_WEB_PROXY at it:
    #   ws://localhost:8080        when testing locally (page served over http)
    #   wss://your-proxy.example   when the dashboard is served over https
    # Optional env: MWC_PORT (container+host default 8080), MWC_HOST_PORT,
    #   MWC_ALLOW_ORIGIN (default *), MWC_ACCESS_CODE, MWC_MAX_CONNECTIONS_PER_IP,
    #   MWC_SIGNAL_URL / MWC_SIGNAL_DESCRIPTION / MWC_SIGNAL_DOMAIN (mcraft.fun listing),
    #   MWC_RUN_FLAGS (extra docker run flags).
    MWC_PORT="${MWC_PORT:-8080}"
    MWC_HOST_PORT="${MWC_HOST_PORT:-$MWC_PORT}"
    MWC_ALLOW_ORIGIN="${MWC_ALLOW_ORIGIN:-*}"
    MWC_MAX_CONNECTIONS_PER_IP="${MWC_MAX_CONNECTIONS_PER_IP:-5}"
    docker pull ghcr.io/zardoy/mwc-proxy >/dev/null 2>&1 || true
    docker rm -f "${PREFIX}-proxy" >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    docker run -d --name "${PREFIX}-proxy" --restart unless-stopped \
      -e PORT="${MWC_PORT}" \
      -e ALLOW_ORIGIN="${MWC_ALLOW_ORIGIN}" \
      -e MAX_CONNECTIONS_PER_IP="${MWC_MAX_CONNECTIONS_PER_IP}" \
      ${MWC_ACCESS_CODE:+-e ACCESS_CODE="${MWC_ACCESS_CODE}"} \
      ${MWC_SIGNAL_URL:+-e SIGNAL_SERVER_URL="${MWC_SIGNAL_URL}"} \
      ${MWC_SIGNAL_DESCRIPTION:+-e SIGNAL_DESCRIPTION="${MWC_SIGNAL_DESCRIPTION}"} \
      ${MWC_SIGNAL_DOMAIN:+-e SIGNAL_DOMAIN="${MWC_SIGNAL_DOMAIN}"} \
      ${MWC_RUN_FLAGS:-} \
      -p "${MWC_HOST_PORT}:${MWC_PORT}" \
      ghcr.io/zardoy/mwc-proxy
    say "✓ mwc-proxy running as ${PREFIX}-proxy → ws://localhost:${MWC_HOST_PORT} (set MC_WEB_PROXY=ws://localhost:${MWC_HOST_PORT} in your .env.dockerN, then re-run ./run-docker.sh)"
    exit 0
    ;;
  *)
    err "usage: $0 [up|stop|status|logs [n|proxy]|proxy]"
    exit 1
    ;;
esac

# ── sanity + build ────────────────────────────────────────────────────────────
[ -f "$APP_FILE" ] || { err "app script '$APP_FILE' not found (set APP_FILE=<name>)"; exit 1; }
command -v docker >/dev/null 2>&1 || { err "docker not found in PATH"; exit 1; }
[ -f package.json ] || { err "package.json not found next to run-docker.sh"; exit 1; }

say "▸ building ${IMAGE}:latest …"
# shellcheck disable=SC2086
docker build --build-arg APP_FILE="${APP_FILE}" -t "${IMAGE}:latest" $DOCKER_BUILD_FLAGS .

# ── discover .env.dockerN files ───────────────────────────────────────────────
shopt -s nullglob
files=(.env.docker[0-9]*)
shopt -u nullglob

if [ ${#files[@]} -eq 0 ]; then
  if [ -f .env ]; then
    cp .env .env.docker1
    say "▸ no .env.dockerN found — copied .env → .env.docker1 (edit it, then re-run)"
    files=(.env.docker[0-9]*)
  else
    cat > .env.docker1 <<'EOF'
# AFK Console instance 1 — plain KEY=VALUE lines, NO quotes, no spaces around =
BOT_NAMES=
LOGIN_PASSWORD=123456
# Optional cron jobs: CRON_JOB_<N>=<schedule>|<command> (5-field cron or "@every <secs>")
# CRON_JOB_1=0 4 * * *|/crates-all
# CRON_JOB_2=@every 60|/status
# Minecraft web client (/play tab): the client is self-hosted — baked into the
# image and served on MC_WEB_CLIENT_PORT (8090, host-mapped per instance).
# Prefill the connect screen:
# MC_WEB_SERVER=play.example.com:25565
# MC_WEB_VERSION=1.21.4
# MC_WEB_USERNAME=PlayerName
# MC_WEB_PROXY=ws://localhost:8080   # ./run-docker.sh proxy; wss://… if https
# Tor is the default outbound proxy inside Docker (127.0.0.1:9050).
# Set PROXY_HOST= (empty) to connect directly instead.
# WEB_PASSWORD=change-me    # unset = random password printed in `docker logs`
# WEB_PORT=80               # port INSIDE the container; host port is auto-picked
EOF
    say "▸ created starter .env.docker1 — set BOT_NAMES in it, then re-run ./run-docker.sh"
    exit 0
  fi
fi

# numeric order so .env.docker10 comes after .env.docker9
ordered=$(for f in "${files[@]}"; do printf '%s %s\n' "${f#.env.docker}" "$f"; done | sort -n | awk '{print $2}')

# ── one container per env file, each on the next free host port ───────────────
say ""
say "── instances ──────────────────────────────────────────────────────"
next="$PORT_BASE"
for f in $ordered; do
  n="${f#.env.docker}"

  # container port = WEB_PORT from the env file (default 80)
  cport=$(grep -E '^ *WEB_PORT *=' "$f" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -dc '0-9' || true)
  cport="${cport:-80}"

  # container viewer start = MANUAL_VIEWER_PORT from the env file (default 3000)
  vport=$(grep -E '^ *MANUAL_VIEWER_PORT *=' "$f" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -dc '0-9' || true)
  vport="${vport:-3000}"

  # Manual 3D viewer: map this instance's container viewer range (vport..+9)
  # onto the next free 10-port host block starting no earlier than vnext, and
  # inject MANUAL_VIEWER_HOST_PORT so the dashboard can build the host URL.
  viewer_pflags=""
  vcand="$vnext"
  while [ "$vcand" -lt "$((VIEWER_HOST_BASE + PORT_SPAN * 10))" ]; do
    if block_free "$vcand"; then
      viewer_pflags="-p ${vcand}-$((vcand + 9)):${vport}-$((vport + 9)) -e MANUAL_VIEWER_HOST_PORT=${vcand}"
      vnext=$((vcand + 10))
      break
    fi
    vcand=$((vcand + 10))
  done

  # Self-hosted Minecraft web client: map this instance's container client port
  # (MC_WEB_CLIENT_PORT, default 8090) onto the next free host port, and inject
  # MC_WEB_CLIENT_HOST_PORT so /play builds the URL for the browser.
  mcport=$(grep -E '^ *MC_WEB_CLIENT_PORT *=' "$f" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -dc '0-9' || true)
  mcport="${mcport:-8090}"
  client_pflags=""
  mcand="$cnext"
  while ! port_free "$mcand" && [ "$mcand" -lt "$((CLIENT_HOST_BASE + PORT_SPAN))" ]; do
    mcand=$((mcand + 1))
  done
  if port_free "$mcand"; then
    client_pflags="-p ${mcand}:${mcport} -e MC_WEB_CLIENT_HOST_PORT=${mcand}"
    cnext=$((mcand + 1))
  fi

  bn=$(grep -E '^ *BOT_NAMES *=' "$f" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d ' ,' || true)
  [ -n "$bn" ] || say "  ⚠ ${f}: BOT_NAMES is empty — ${PREFIX}-${n} will exit until you fill it in"

  # free this instance's old container (and its host port) before probing
  docker rm -f "${PREFIX}-${n}" >/dev/null 2>&1 || true

  vol_flags=""
  [ "$PERSIST_TOR" = "1" ] && vol_flags="-v ${PREFIX}-tor-${n}:/var/lib/tor"

  extra_host_flags=""
  ssh_enabled=$(grep -E '^ *SSH *=' "$f" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '[:space:]' || true)
  ssh_host=$(grep -E '^ *SSH_HOST *=' "$f" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '[:space:]' || true)
  if [[ "$ssh_enabled" =~ ^(1|true|yes|on)$ ]] && [[ -z "$ssh_host" || "$ssh_host" == "host.docker.internal" ]]; then
    extra_host_flags="--add-host host.docker.internal:host-gateway"
  fi

  hport=""
  for attempt in 1 2 3 4 5 6; do
    tried=0
    while ! port_free "$next" && [ "$tried" -lt "$PORT_SPAN" ]; do
      next=$((next + 1)); tried=$((tried + 1))
    done
    if ! port_free "$next"; then
      err "no free host port in ${PORT_BASE}–$((PORT_BASE + PORT_SPAN)); set WEB_PORT_HOST to start elsewhere"
      exit 1
    fi
    # shellcheck disable=SC2086
    out=$(docker run -d --name "${PREFIX}-${n}" \
      --init --restart unless-stopped \
      --env-file "$f" \
      -p "${next}:${cport}" \
      $viewer_pflags \
      $client_pflags \
      $vol_flags $extra_host_flags $DOCKER_RUN_FLAGS \
      "${IMAGE}:latest" 2>&1) && { hport="$next"; break; }
    # start failed — only retry if the port was snatched in the race window
    if port_free "$next"; then
      err "docker run failed for ${f}: ${out}"
      exit 1
    fi
    next=$((next + 1))
  done
  [ -n "$hport" ] || { err "could not allocate a host port for ${f}"; exit 1; }

  if [ -n "$viewer_pflags" ]; then
    say "  ✓ ${PREFIX}-${n}  ←  ${f}  →  http://localhost:${hport}  (container port ${cport}) · 3D viewer http://localhost:${vcand} (container ${vport})"
  else
    say "  ✓ ${PREFIX}-${n}  ←  ${f}  →  http://localhost:${hport}  (container port ${cport})"
    say "  ⚠ ${f}: no free 10-port block for the manual 3D viewer from host port ${VIEWER_HOST_BASE} — set MANUAL_VIEWER_HOST_PORT to start elsewhere, or use the viewer without host mapping"
  fi
  if [ -n "$client_pflags" ]; then
    say "     Minecraft web client (PLAY tab): http://localhost:${mcand} (container port ${mcport})"
  fi
  next=$((hport + 1))
done
say "──────────────────────────────────────────────────────────────────"
say "▸ web passwords: WEB_PASSWORD in each .env.dockerN, or the random one printed at startup:"
say "    docker logs ${PREFIX}-1"
say "▸ fresh Tor exit IP for an instance anytime:"
say "    docker exec ${PREFIX}-1 restart-tor   (bots auto-reconnect through the new circuit)"