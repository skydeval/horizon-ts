#!/usr/bin/env bash
# Run oxlint's autofix on silonew for the given files (paths relative to
# horizon-ts), so they can be copied back.
#   silonew-lint-fix.sh src/a.ts src/b.tsx
set -uo pipefail

export PATH="$HOME/.local/node-v24.22.1/bin:$PATH"
cd "$HOME/horizon/horizon-ts"

npx --no-install pnpm exec oxlint --fix "$@"
