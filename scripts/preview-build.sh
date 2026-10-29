#!/usr/bin/env bash
# Horizon's public preview on a build host (silonew), for Cloudflare Pages.
#
# The code is synced to ~/horizon/horizon-ts by rsync from the workstation
# (dependencies installed with silonew-dev.sh install). build makes the
# production web build in preview mode for one https origin and leaves a
# ready-to-upload directory; deploy uploads it with wrangler.
#
# Usage:
#   preview-build.sh build [origin]       production web build for the https
#                                         origin (default
#                                         https://horizon-preview2.pages.dev)
#                                         into ~/horizon/preview-dist
#   preview-build.sh project [project]    create the Pages project (once;
#                                         default horizon-preview2)
#   preview-build.sh deploy [project]     upload ~/horizon/preview-dist to the
#                                         Pages project (default
#                                         horizon-preview2), branch main
#   preview-build.sh info                 what is in ~/horizon/preview-dist
#
# project and deploy sign in with ~/.horizon-cloudflare.env when it exists
# (CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, chmod 600), otherwise with
# an earlier `npx wrangler login`. The token is never printed.
set -euo pipefail

NODE_VERSION="24.22.1"
BASE="$HOME/horizon"
APP="$BASE/horizon-ts"
NODE_DIR="$HOME/.local/node-v$NODE_VERSION"
OUT="$BASE/preview-dist"
ORIGIN_FILE="$BASE/preview-dist.origin"
CF_ENV="$HOME/.horizon-cloudflare.env"
DEFAULT_PROJECT="horizon-preview2"
DEFAULT_ORIGIN="https://horizon-preview2.pages.dev"
WRANGLER="wrangler@${WRANGLER_VERSION:-4}"

export PATH="$NODE_DIR/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

usage() {
  sed -n '2,24p' "$0"
  exit 1
}

build() {
  local origin="${1:-$DEFAULT_ORIGIN}"
  origin="${origin%/}"
  case "$origin" in
    https://*) ;;
    *) echo "the origin must be https: $origin"; exit 1 ;;
  esac
  cd "$APP"
  # A production build drops each string's English and looks it up in the
  # compiled catalogs, so Horizon's own strings must be extracted first or
  # they show as message ids. Done on this build copy only: the repo keeps
  # upstream's .po files, so merges stay clean; every locale falls back to
  # English for strings it has no translation of.
  echo "Extracting and compiling translation catalogs"
  pnpm intl:extract:all
  pnpm intl:compile
  echo "Building the web app for $origin"
  NODE_OPTIONS=--max-old-space-size=8192 \
    EXPO_PUBLIC_ENV=production \
    EXPO_PUBLIC_OAUTH_CLIENT=preview \
    EXPO_PUBLIC_PREVIEW_ORIGIN="$origin" \
    pnpm build-web
  EXPO_PUBLIC_OAUTH_CLIENT=preview \
    EXPO_PUBLIC_PREVIEW_ORIGIN="$origin" \
    node scripts/horizon-preview-pages.js dist
  # A copy outside dist/, so a later build does not change what deploy sends.
  rm -rf "$OUT"
  cp -a dist "$OUT"
  echo "$origin" > "$ORIGIN_FILE"
  echo "ready: $OUT for $origin"
}

info() {
  if [ ! -f "$OUT/index.html" ]; then
    echo "nothing built; run build first"
    exit 1
  fi
  echo "origin: $(cat "$ORIGIN_FILE" 2>/dev/null || echo unknown)"
  echo "files: $(find "$OUT" -type f | wc -l)"
  echo "client document:"
  cat "$OUT/oauth-client-metadata.json"
}

load_credentials() {
  if [ -f "$CF_ENV" ]; then
    if [ -n "$(find "$CF_ENV" -perm /077)" ]; then
      echo "$CF_ENV is readable by others; run chmod 600 $CF_ENV"
      exit 1
    fi
    set -a
    # shellcheck disable=SC1090
    . "$CF_ENV"
    set +a
    if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
      echo "$CF_ENV must set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID"
      exit 1
    fi
    echo "Signing in with the token in $CF_ENV"
  else
    echo "No $CF_ENV; using the wrangler login"
  fi
}

project() {
  local project="${1:-$DEFAULT_PROJECT}"
  load_credentials
  cd "$BASE"
  npx --yes "$WRANGLER" pages project create "$project" \
    --production-branch main
}

deploy() {
  local project="${1:-$DEFAULT_PROJECT}"
  if [ ! -f "$OUT/index.html" ] || [ ! -f "$OUT/_redirects" ]; then
    echo "nothing to deploy; run build first"
    exit 1
  fi
  load_credentials
  echo "Deploying $OUT (for $(cat "$ORIGIN_FILE" 2>/dev/null || echo unknown)) to Pages project $project"
  # From the app: wrangler bundles its functions/ (link cards) with the upload.
  cd "$APP"
  npx --yes "$WRANGLER" pages deploy "$OUT" \
    --project-name "$project" --branch main --commit-dirty=true
}

case "${1:-}" in
  build) build "${2:-}" ;;
  project) project "${2:-}" ;;
  deploy) deploy "${2:-}" ;;
  info) info ;;
  *) usage ;;
esac
