#!/bin/sh
# Restart Tor before launching the bot, so a fresh circuit/exit IP is in
# place when the app starts. Works both on a systemd host and inside the
# container, where Tor is a bare process rather than a service.
#
#   npm run start   →   restart-tor.sh   →   node bot.js
#
# Only touches Tor when the app actually routes through a local SOCKS
# proxy (PROXY_HOST=localhost/127.0.0.1/::1, or unset = the docker default).
# A remote proxy or direct mode skips the restart, matching the app's own
# PROXY_IS_LOCAL guard.

set -e

PROXY_HOST="${PROXY_HOST:-127.0.0.1}"
PORT="${PROXY_PORT:-9050}"

case "$PROXY_HOST" in
  127.0.0.1|localhost|::1) ;;
  *)
    echo "[restart-tor] PROXY_HOST='${PROXY_HOST}' is not local — skipping Tor restart, starting the app."
    exec node bot.js
    ;;
esac

restart_tor() {
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^tor\.service'; then
    systemctl restart tor
  elif [ -x /usr/local/bin/restart-tor ]; then
    # Container helper: pkill + relaunch against /etc/tor/torrc
    /usr/local/bin/restart-tor
  elif command -v tor >/dev/null 2>&1; then
    pkill -x tor 2>/dev/null || true
    sleep 1
    tor -f /etc/tor/torrc >/dev/null 2>&1 &
  else
    echo "[restart-tor] WARNING: no Tor restart path found (systemctl/tor binary absent) — starting the app anyway."
    return
  fi
}

restart_tor

# Wait for the SOCKS port to accept connections so the first bot connection
# doesn't race the proxy bootstrap (mirrors docker-entrypoint.sh).
i=0
until node -e "const net=require('net'),s=net.connect(process.env.PORT,'127.0.0.1',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "[restart-tor] WARNING: Tor not accepting connections after 60s — starting the app anyway."
    break
  fi
  sleep 1
done
[ "$i" -lt 60 ] && echo "[restart-tor] Tor is up on 127.0.0.1:${PORT}."

exec node bot.js