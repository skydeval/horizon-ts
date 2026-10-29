#!/usr/bin/env bash
# Keep only the newest two horizon-*.apk builds in a folder (by time),
# deleting older APKs and their .map files. Other files are left alone.
#   prune-apks.sh <dir> [keep]
set -euo pipefail

dir="$1"
keep="${2:-2}"

mapfile -t apks < <(ls -t "$dir"/horizon-*.apk 2>/dev/null || true)
for ((i = keep; i < ${#apks[@]}; i++)); do
  apk="${apks[$i]}"
  rm -f -- "$apk" "${apk%.apk}.map"
  echo "removed $(basename "$apk")"
done
# Maps whose APK is gone
for map in "$dir"/horizon-*.map; do
  [ -e "$map" ] || continue
  if [ ! -e "${map%.map}.apk" ]; then
    rm -f -- "$map"
    echo "removed $(basename "$map")"
  fi
done
