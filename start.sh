#!/bin/sh
( while true; do
    tor -f /etc/tor/torrc
    echo "[tor] died, restarting in 5s" >&2
    sleep 5
  done ) &
sleep 3
exec node bot.js
