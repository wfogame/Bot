# syntax=docker/dockerfile:1
# ── AFK Console image: Node app + its own Tor SOCKS5 proxy, one per container ──
# Build/run in bulk:  ./run-docker.sh
# Manual single run:  docker run -d --name afk-console-1 --env-file .env.docker1 -p 80:80 afk-console
FROM node:22-bookworm-slim

# tor            → the SOCKS5 proxy every bot tunnels through
# procps         → pkill for the tor restart helper
# git + ca-certs → npm needs to fetch the mineflayer GitHub fork (plainprince/mineflayer)
ARG APP_FILE=bot.js

RUN apt-get update \
 && apt-get install -y --no-install-recommends tor procps git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies in their own layer so app edits don't trigger reinstalls.
# patches* is a glob — copied only if present, BEFORE npm install so the
# postinstall (npx patch-package mineflayer) can apply them at build time.
COPY package*.json patches* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY expose-terminal.js ./expose-terminal.js
COPY bot-controls.js ./bot-controls.js
COPY monitoring.js ./monitoring.js
COPY bot-manual.js ./bot-manual.js
COPY ${APP_FILE} ./index.js

# Tor config: local SOCKS5 on 127.0.0.1:9050, drops privileges to debian-tor.
# SocksPort is rewritten by the entrypoint if PROXY_PORT is overridden.
RUN printf 'SocksPort 127.0.0.1:9050\nDataDirectory /var/lib/tor\nUser debian-tor\nLog notice stdout\n' > /etc/tor/torrc \
 && install -d -m 700 -o debian-tor -g debian-tor /var/lib/tor

# restart-tor: used by the app's proxy-stall watchdog (PROXY_RESTART_CMD)
# and by hand:  docker exec afk-console-1 restart-tor  → fresh exit IP
RUN printf '#!/bin/sh\npkill -x tor 2>/dev/null\nsleep 1\nnohup tor -f /etc/tor/torrc >/dev/null 2>&1 &\n' > /usr/local/bin/restart-tor \
 && chmod +x /usr/local/bin/restart-tor

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Web GUI port (container-internal; run-docker.sh maps host 80/81/82… onto it)
EXPOSE 80

# Manual-mode 3D viewer ports (prismarine-viewer). /manual-interact picks the
# first free port starting at MANUAL_VIEWER_PORT (default 3000, up to 10
# attempts). run-docker.sh maps a free 10-port host block onto this range per
# instance; a plain `docker run` can map it manually with -p 3000-3009:3000-3009.
EXPOSE 3000-3009

# Liveness via the app's unauthenticated /health endpoint
HEALTHCHECK --interval=60s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||80)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
