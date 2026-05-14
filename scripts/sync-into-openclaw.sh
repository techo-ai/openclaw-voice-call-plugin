#!/usr/bin/env bash
# Copy this plugin into the OpenClaw monorepo bundled extension path (for Docker / CI).
# Canonical source: this repo (openclaw-voice-call-plugin). Run before rsync-to-server.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${ROOT}/../openclaw/extensions/voice-call"
if [[ ! -d "$DEST" ]]; then
  echo "Expected OpenClaw checkout at $DEST — adjust path or clone openclaw next to this repo." >&2
  exit 1
fi
rsync -av --delete \
  --filter='protect package-manifest.contract.test.ts' \
  --exclude=node_modules \
  --exclude='.git' \
  --exclude=package.json \
  --exclude=README.md \
  --exclude=LICENSE \
  --exclude=docs \
  "$ROOT/" "$DEST/"
echo "Synced voice-call plugin -> $DEST"
