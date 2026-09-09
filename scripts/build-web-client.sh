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
# Before building, scripts/patch-web-client-enchants.js applies two source
# patches to the upstream client:
# 1. prismarine-item's `enchants` getter (on 1.20.5+ servers it returns the raw
#    component object instead of an array and throws on unknown versions, which
#    crashes mineflayer's digTime with "(enchantments ?? []) is not iterable"
#    — so the browser client could never break blocks while holding an
#    enchanted item). The patch normalizes the getter.
# 2. makeOptimizedMcData.mjs so the build-time mc-data prep loads only the
#    current 1.21.x generation (1.21 → latest, ~10 versions) by default
#    instead of every version (1.8 → 1.21.11): a fresh build peaks at
#    ~2.3 GB RSS with the full corpus vs ~1.8 GB with the 1.21.x range (both
#    measured). Going stricter than 1.21.x would break connecting to other
#    server versions. Patching the source means even a manual `pnpm run build`
#    inside web-client/src is clipped.
# Both are covered by test/web-client-enchants.test.js.
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

# Version-range clipping for the build-time minecraft-data prep
# (scripts/makeOptimizedMcData.mjs). The patch script above already makes the
# prep load only the current 1.21.x generation (1.21 → latest, ~10 versions)
# by default — no env vars needed. These exports are belt-and-braces (they
# apply even if the source patch fails to land) and let you override the
# range, e.g.:
#   MIN_MC_VERSION=1.21.11 MAX_MC_VERSION=1.21.11 → exactly 1.21.11 (only if
#                                                    ALL your servers are that
#                                                    exact version!)
#   MIN_MC_VERSION= MAX_MC_VERSION=               → full corpus (every version)
# A range narrower than the 1.21.x generation breaks connecting to servers
# outside it — the client silently falls back to the base version's protocol
# data when a version is absent from the blob (restoreData never throws).
# Equal min/max values mean EXACTLY that version (verified against the real
# minecraft-data version list).
MIN_MC_VERSION="${MIN_MC_VERSION:-1.21}"
MAX_MC_VERSION="${MAX_MC_VERSION:-}"

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

echo "▸ minecraft-data corpus: ${MIN_MC_VERSION:-all} → ${MAX_MC_VERSION:-all}"
export MIN_MC_VERSION MAX_MC_VERSION

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
