#!/usr/bin/env bash
# Horizon's development server on a build host (silonew).
#
# The code is synced to ~/horizon/horizon-ts by rsync from the workstation;
# this script installs the toolchain, installs dependencies and runs the web
# dev server in the background. The browser reaches it through an SSH tunnel
# as http://127.0.0.1:8081, which OAuth needs.
#
# Usage:
#   silonew-dev.sh setup                  install Node 24 and pnpm (once)
#   silonew-dev.sh install                pnpm install --frozen-lockfile
#   silonew-dev.sh start [mode]           start the dev server; mode is the
#                                         OAuth client: loopback (default,
#                                         Bluesky's PDS) or hosted-dev
#                                         (aurora-locus)
#   silonew-dev.sh stop                   stop the dev server
#   silonew-dev.sh status                 is it running, and the log's tail
#   silonew-dev.sh logs                   follow the log
set -euo pipefail

NODE_VERSION="24.22.1"
PNPM_VERSION="11.28.5"
BASE="$HOME/horizon"
APP="$BASE/horizon-ts"
NODE_DIR="$HOME/.local/node-v$NODE_VERSION"
LOG="$BASE/expo.log"
PID_FILE="$BASE/expo.pid"
PORT=8081

export PATH="$NODE_DIR/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

setup() {
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    echo "Installing Node $NODE_VERSION into $NODE_DIR"
    mkdir -p "$HOME/.local"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" \
      | tar -xJ -C "$HOME/.local"
    mv "$HOME/.local/node-v$NODE_VERSION-linux-x64" "$NODE_DIR"
  fi
  corepack enable
  corepack install -g "pnpm@$PNPM_VERSION"
  echo "node $(node --version), pnpm $(pnpm --version)"
}

install() {
  cd "$APP"
  pnpm install --frozen-lockfile
}

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

start() {
  local mode="${1:-loopback}"
  case "$mode" in
    loopback|hosted-dev) ;;
    *) echo "unknown mode: $mode (loopback or hosted-dev)"; exit 1 ;;
  esac
  if is_running; then
    echo "already running (pid $(cat "$PID_FILE")); run stop first to change mode"
    exit 1
  fi
  cd "$APP"
  : > "$LOG"
  # setsid detaches it from this SSH session so it keeps running after the
  # call returns; stdin from /dev/null keeps Expo from waiting on a terminal.
  EXPO_PUBLIC_OAUTH_CLIENT="$mode" setsid nohup pnpm web --port "$PORT" \
    < /dev/null >> "$LOG" 2>&1 &
  echo $! > "$PID_FILE"
  echo "started in $mode mode (pid $(cat "$PID_FILE")), log: $LOG"
}

stop() {
  if is_running; then
    # Kill the whole process group (pnpm, expo, metro workers).
    kill -- "-$(cat "$PID_FILE")" 2>/dev/null || kill "$(cat "$PID_FILE")"
    echo "stopped"
  else
    echo "not running"
  fi
  rm -f "$PID_FILE"
}

status() {
  if is_running; then
    echo "running (pid $(cat "$PID_FILE"))"
  else
    echo "not running"
  fi
  [ -f "$LOG" ] && tail -n 25 "$LOG"
}

case "${1:-}" in
  setup) setup ;;
  install) install ;;
  start) start "${2:-}" ;;
  stop) stop ;;
  status) status ;;
  logs) tail -f "$LOG" ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
