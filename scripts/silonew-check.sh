#!/usr/bin/env bash
# Typecheck and lint ~/horizon/horizon-ts on silonew.
#   silonew-check.sh
set -uo pipefail

export PATH="$HOME/.local/node-v24.22.1/bin:$PATH"
cd "$HOME/horizon/horizon-ts"

npx --no-install pnpm -s typecheck
tc=$?
npx --no-install pnpm -s lint
lint=$?
echo "typecheck exit $tc, lint exit $lint"
exit $((tc || lint))
