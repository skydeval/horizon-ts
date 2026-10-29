#!/usr/bin/env bash
# Export committed HEAD's horizon-ts into a fresh folder and sync it to
# silonew's ~/horizon/horizon-ts, so builds there never pick up uncommitted
# work. Run from anywhere:
#   sync-head-to-silonew.sh [scratch-dir]
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SHA="$(git -C "$REPO" rev-parse --short=9 HEAD)"
SCRATCH="${1:-${TMPDIR:-/tmp}}"
OUT="$SCRATCH/deploy-$SHA"

rm -rf "$OUT"
mkdir -p "$OUT"
git -C "$REPO" archive HEAD:horizon-ts | tar -x -C "$OUT"

rsync -az --delete \
  --exclude node_modules --exclude dist --exclude .expo --exclude web-build \
  --exclude junit.xml --exclude android --exclude ios \
  --exclude google-services.json --exclude bskyweb/static \
  "$OUT/" silonew:horizon/horizon-ts/

echo "synced $SHA"
