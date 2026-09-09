#!/usr/bin/env bash
# ── Build the self-hosted Minecraft web client (zardoy/minecraft-web-client) ──
# Clones the upstream repo at its LATEST RELEASE TAG (v2.3.0 — verified against
# the GitHub releases page on 2026-09-09; the `next` branch is the project's
# live dev branch, "usually newer, but might be less stable", and its moving
# head made Docker images non-reproducible) into web-client/src and runs its
# production build into web-client/dist, which bot.js serves on its own local
# port for the dashboard's /play tab. Re-runs check out the tag again and
# rebuild. Override the tag with MC_WEB_CLIENT_TAG if you ever need a
# different upstream version.
#
# Before building, scripts/patch-web-client-enchants.js is applied: on
# 1.20.5+ servers prismarine-item's `enchants` getter returns the raw
# component object instead of an array (and throws on versions it doesn't
# know), which crashes mineflayer's digTime with "(enchantments ?? []) is not
# iterable" — so the browser client could never break blocks while holding an
# enchanted item. The patch normalizes the getter; see
# test/web-client-enchants.test.js.
#
# Usage:  npm run web-client:build        (or:  sh ./scripts/build-web-client.sh)
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_ROOT="$(pwd)"

BUILD_DIR="web-client"
SRC_DIR="$BUILD_DIR/src"
DIST_DIR="$BUILD_DIR/dist"

# Latest upstream release (see the Releases page / tags). The `next` branch
# head is identical to v2.3.0 right now, but pinning the tag keeps builds
# reproducible and immune to future dev-branch regressions.
MC_WEB_CLIENT_TAG="${MC_WEB_CLIENT_TAG:-v2.3.0}"

command -v git >/dev/null 2>&1 || { echo "✗ git is required to build the web client" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "✗ node is required to build the web client" >&2; exit 1; }

mkdir -p "$BUILD_DIR"

if [ ! -d "$SRC_DIR/.git" ]; then
  echo "▸ cloning zardoy/minecraft-web-client (${MC_WEB_CLIENT_TAG})…"
  git clone --depth 1 --branch "$MC_WEB_CLIENT_TAG" https://github.com/zardoy/minecraft-web-client.git "$SRC_DIR"
else
  echo "▸ checking out ${MC_WEB_CLIENT_TAG}…"
  git -C "$SRC_DIR" fetch --depth 1 origin tag "$MC_WEB_CLIENT_TAG" --force 2>/dev/null \
    || git -C "$SRC_DIR" fetch --tags --force origin
  git -C "$SRC_DIR" checkout --force "$MC_WEB_CLIENT_TAG"
fi

cd "$SRC_DIR"

# pnpm is pinned via packageManager + corepack (needs corepack on PATH).
corepack enable 2>/dev/null || npm install -g corepack 2>/dev/null || true
command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@10.32.1

echo "▸ preparing + installing dependencies…"
node ./scripts/dockerPrepare.mjs
pnpm i

# Fix block breaking on 1.20.5+ servers BEFORE building (see header comment).
echo "▸ applying prismarine-item enchants fix (digging on 1.20.5+ servers)…"
node "$PROJECT_ROOT/scripts/patch-web-client-enchants.js" "$SRC_DIR"

echo "▸ building (pnpm run build)…"
pnpm run build

# The dashboard never uses auto-connect; make the intent explicit.
printf '{"allowAutoConnect":false}\n' > dist/config.json

# Use the absolute project root captured above rather than a relative "../"
# count — SRC_DIR is two levels below PROJECT_ROOT (web-client/src) while
# DIST_DIR is only one level below it (web-client/dist), so a plain "../"
# from inside SRC_DIR previously landed one directory too deep
# (web-client/web-client/dist instead of web-client/dist).
mkdir -p "$PROJECT_ROOT/$DIST_DIR"
cp -r dist/. "$PROJECT_ROOT/$DIST_DIR/"
echo "✓ web client built (${MC_WEB_CLIENT_TAG}) → $DIST_DIR (serve with: npm run web-client:serve)"
