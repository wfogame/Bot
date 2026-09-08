#!/bin/sh
# Starts Tor, waits for the SOCKS port, then execs the Node app.
#
# Env precedence (highest wins):
#   1. .env.dockerN  (injected by docker --env-file before this runs)
#   2. defaults set below (only for variables that are UNSET — the "${VAR-default}"
#      form — so an explicitly EMPTY value like PROXY_HOST= stays empty = direct mode)
#   3. built-in defaults in the app code

export PROXY_HOST="${PROXY_HOST-127.0.0.1}"
export PROXY_PORT="${PROXY_PORT-9050}"
export PROXY_TYPE="${PROXY_TYPE-socks5}"
export PROXY_RESTART_CMD="${PROXY_RESTART_CMD-/usr/local/bin/restart-tor}"

# Manual interact 3D viewer: first free port from here, up to 10 attempts
# (prismarine-viewer; served from the same node process, bound to WEB_BIND).
export MANUAL_VIEWER_PORT="${MANUAL_VIEWER_PORT-3000}"

is_local_proxy() {
  [ "$PROXY_HOST" = "127.0.0.1" ] || [ "$PROXY_HOST" = "localhost" ] || [ "$PROXY_HOST" = "::1" ]
}

if [ -n "$PROXY_HOST" ] && is_local_proxy; then
  # keep tor's SocksPort in sync with PROXY_PORT if it was overridden
  sed -i "s/^SocksPort .*/SocksPort 127.0.0.1:${PROXY_PORT}/" /etc/tor/torrc
  echo "[entrypoint] starting Tor (SOCKS5 ${PROXY_HOST}:${PROXY_PORT})…"
  tor -f /etc/tor/torrc &

  # Wait until the SOCKS port accepts connections (up to 90 s) so the first
  # bot connection doesn't race the proxy bootstrap.
  i=0
  until node -e "const net=require('net'),s=net.connect(process.env.PROXY_PORT,'127.0.0.1',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 90 ]; then
      echo "[entrypoint] WARNING: Tor not accepting connections after 90s — starting the app anyway; its reconnect logic will retry."
      break
    fi
    sleep 1
  done
  [ "$i" -lt 90 ] && echo "[entrypoint] Tor is up."
else
  echo "[entrypoint] PROXY_HOST='${PROXY_HOST}' — not starting local Tor (direct or remote proxy mode)."
fi

echo "[entrypoint] starting app — manual 3D viewer will bind ${WEB_BIND:-0.0.0.0}:${MANUAL_VIEWER_PORT}+ when /manual-interact is used (map host ports to reach it)"
exec node index.js
