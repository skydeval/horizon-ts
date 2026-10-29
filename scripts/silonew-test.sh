#!/usr/bin/env bash
# Run Jest on silonew against ~/horizon/horizon-ts (synced from the working
# tree or an export). Compiles the locale messages first, since a sync wipes
# them. Arguments are passed to Jest (none: the full suite).
#   silonew-test.sh [jest args...]
# The full output goes to ~/horizon/jest.log; failing suites and the totals
# are printed.
set -uo pipefail

export PATH="$HOME/.local/node-v24.22.1/bin:$PATH"
cd "$HOME/horizon/horizon-ts"

npx --no-install pnpm intl:extract:all > /dev/null 2>&1
npx --no-install pnpm intl:compile > /dev/null 2>&1

NODE_ENV=test npx --no-install pnpm exec jest --forceExit --testTimeout=60000 "$@" \
  > "$HOME/horizon/jest.log" 2>&1
status=$?

grep -E "^FAIL|✕|^Tests:|^Test Suites:" "$HOME/horizon/jest.log" | sort -u
exit $status
