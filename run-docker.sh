#!/usr/bin/env bash
# ── AFK Console orchestrator: one container per .env.dockerN ──────────────────
# Usage:
#   ./run-docker.sh               build + (re)start every .env.dockerN
#   ./run-docker.sh stop          stop & remove all managed containers
#   ./run-docker.sh status        list managed containers
#   ./run-docker.sh logs [n]      follow logs (default: instance 1)
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
set -euo pipefail

IMAGE="${IMAGE:-afk-console}"
PREFIX="${CONTAINER_PREFIX:-afk-console}"
APP_FILE="${APP_FILE:-bot.js}"
PORT_BASE="${WEB_PORT_HOST:-80}"
PORT_SPAN="${WEB_PORT_HOST_MAX:-40}"
DOCKER_RUN_FLAGS="${DOCKER_RUN_FLAGS:-}"
DOCKER_BUILD_FLAGS="${DOCKER_BUILD_FLAGS:-}"
PERSIST_TOR="${PERSIST_TOR:-0}"

cd "$(dirname "$0")"
say() { printf '%s\n' "$*"; }
err() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; }

# Anything listening on this host port? (bash /dev/tcp probe)
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

cmd="${1:-up}"
case "$cmd" in
  up) ;;
  stop)
    found=0
    for c in $(docker ps -a --format '{{.Names}}' | grep -E "^${PREFIX}-[0-9]+$" || true); do
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
  *)
    err "usage: $0 [up|stop|status|logs [n]]"
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

  say "  ✓ ${PREFIX}-${n}  ←  ${f}  →  http://localhost:${hport}  (container port ${cport})"
  next=$((hport + 1))
done
say "──────────────────────────────────────────────────────────────────"
say "▸ web passwords: WEB_PASSWORD in each .env.dockerN, or the random one printed at startup:"
say "    docker logs ${PREFIX}-1"
say "▸ fresh Tor exit IP for an instance anytime:"
say "    docker exec ${PREFIX}-1 restart-tor   (bots auto-reconnect through the new circuit)"