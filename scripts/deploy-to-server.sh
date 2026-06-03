#!/usr/bin/env bash
# Deploy the voice-call plugin to an OpenClaw host that loads plugins from a
# directory on disk (the canonical pattern — see README and openclaw's own
# `plugins.load.paths` config field).
#
# This script does NOT touch the OpenClaw monorepo or any bundled extensions.
# The plugin lives wholly outside core; upgrading OpenClaw never requires
# changes here.
#
# Usage:
#   ./scripts/deploy-to-server.sh <ssh-target> <remote-plugin-dir>
# Example:
#   ./scripts/deploy-to-server.sh ubuntu@host /opt/openclaw-stack/voice-call-plugin
#
# Auth: relies on the ssh agent / config / sshpass-in-env that the caller has
# already set up. Do not bake credentials into this script.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <ssh-target> <remote-plugin-dir>" >&2
  exit 2
fi

TARGET="$1"
REMOTE_DIR="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[deploy] syncing $ROOT/ → $TARGET:$REMOTE_DIR/"
rsync -av --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='dist' \
  --exclude='*.tsbuildinfo' \
  --rsync-path="sudo rsync" \
  "$ROOT/" "$TARGET:$REMOTE_DIR/"

echo "[deploy] restarting openclaw container on $TARGET"
ssh "$TARGET" "cd /opt/openclaw-stack && sudo docker compose restart openclaw"

echo "[deploy] done. Tail logs with: ssh $TARGET 'sudo docker logs openclaw -f --since 30s'"
