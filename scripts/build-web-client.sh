#!/usr/bin/env bash
# ── Build the self-hosted Minecraft web client (zardoy/minecraft-web-client) ──
# Clones the upstream repo (next branch) into web-client/src and runs its
# production build into web-client/dist, which bot.js serves on its own local
# port for the dashboard's /play tab. Re-runs pull latest and rebuild.
#
# Usage:  npm run web-client:build        (or:  sh ./scripts/build-web-client.sh)
set -euo pipefail
cd "$(dirname "$0")/.."

BUILD_DIR="web-client"
SRC_DIR="$BUILD_DIR/src"
DIST_DIR="$BUILD_DIR/dist"

command -v git >/dev/null 2>&1 || { echo "✗ git is required to build the web client" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "✗ node is required to build the web client" >&2; exit 1; }

mkdir -p "$BUILD_DIR"

if [ ! -d "$SRC_DIR/.git" ]; then
  echo "▸ cloning zardoy/minecraft-web-client (next branch)…"
  git clone --depth 1 --branch next https://github.com/zardoy/minecraft-web-client.git "$SRC_DIR"
else
  echo "▸ pulling latest web client…"
  git -C "$SRC_DIR" pull --ff-only origin next 2>/dev/null || true
fi

cd "$SRC_DIR"

# pnpm is pinned via packageManager + corepack (needs corepack on PATH).
corepack enable 2>/dev/null || npm install -g corepack 2>/dev/null || true
command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@10.32.1

echo "▸ preparing + installing dependencies…"
node ./scripts/dockerPrepare.mjs
pnpm i

echo "▸ building (pnpm run build)…"
pnpm run build

# The dashboard never uses auto-connect; make the intent explicit.
printf '{"allowAutoConnect":false}\n' > dist/config.json

mkdir -p "../$DIST_DIR"
cp -r dist/. "../$DIST_DIR/"
echo "✓ web client built → $BUILD_DIR/dist (serve with: npm run web-client:serve)"