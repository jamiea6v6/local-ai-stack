#!/usr/bin/env bash
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

node22() { "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; }
NODE_BIN=""
for candidate in "${NODE:-}" "$(command -v node 2>/dev/null || true)" "$HOME/.local/node/bin/node"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && node22 "$candidate"; then NODE_BIN=$candidate; break; fi
done
[ -n "$NODE_BIN" ] || { echo "FAIL: node >= 22 not found (set NODE=/path/to/node)" >&2; exit 1; }

exec "$NODE_BIN" "$REPO/tests/measurement/run-baseline.mjs" "$@"
