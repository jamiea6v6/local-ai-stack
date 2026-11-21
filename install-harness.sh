#!/usr/bin/env bash
# Install harness prompts, domains, and bin scripts to Pi agent config.
#
# Installs from the local-ai-stack harness/ source of truth into
# ~/.pi/agent/ following the same idempotent patterns as bootstrap.sh.
#
#   ./install-harness.sh                 # install everything
#   ./install-harness.sh --dry-run       # print the plan, change nothing
#   ./install-harness.sh --force         # overwrite existing (no backup)
#
# Exit codes: 0 = done (warnings allowed), 1 = a required step failed.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PI_HOME="$HOME/.pi/agent"
DRY=0
FORCE=0

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --force) FORCE=1 ;;
    -h|--help) usage ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '  %s\n' "$*"; }
head_() { printf '\n== %s\n' "$*"; }
ok()   { printf '  present: %s\n' "$*"; }
act()  { printf '  %s: %s\n' "$([ "$DRY" = 1 ] && echo 'would' || echo 'doing')" "$*"; }
warn() { printf '  WARN: %s\n' "$*"; }
die()  { printf '  FAIL: %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then return 0; fi; "$@"; }

# ---------------------------------------------------------------- prompts
head_ "Pi prompts harness"
mkdir -p "$PI_HOME/prompts"

install_prompt() {
  local src=$1 dst=$2 label=${3:-$(basename "$1")}
  if [ -L "$dst" ] && [ "$FORCE" = 0 ]; then
    warn "$label is a symlink to $(readlink "$dst"); managed elsewhere, not touching"
    return
  fi
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then ok "$label"; return; fi
  if [ "$FORCE" = 1 ] && [ -L "$dst" ]; then run rm -f "$dst"; fi
  if [ -f "$dst" ]; then
    local bak="$dst.bak.$(date +%Y%m%d%H%M%S)"
    act "back up $label -> $(basename "$bak")"
    run cp -p "$dst" "$bak"
  fi
  act "install $label"
  run install -m 0644 "$src" "$dst"
}

for f in "$SCRIPT_DIR"/harness/prompts/*.md; do
  [ -f "$f" ] || { warn "no prompt files found"; continue; }
  install_prompt "$f" "$PI_HOME/prompts/$(basename "$f")"
done

# ---------------------------------------------------------------- domains
head_ "Pi domains harness"
mkdir -p "$PI_HOME/domains"

install_domain() {
  local src=$1 dst=$2 label=${3:-$(basename "$1")}
  if [ -L "$dst" ] && [ "$FORCE" = 0 ]; then
    warn "$label is a symlink to $(readlink "$dst"); managed elsewhere, not touching"
    return
  fi
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then ok "$label"; return; fi
  if [ "$FORCE" = 1 ] && [ -L "$dst" ]; then run rm -f "$dst"; fi
  if [ -f "$dst" ]; then
    local bak="$dst.bak.$(date +%Y%m%d%H%M%S)"
    act "back up $label -> $(basename "$bak")"
    run cp -p "$dst" "$bak"
  fi
  act "install $label"
  run install -m 0644 "$src" "$dst"
}

for f in "$SCRIPT_DIR"/harness/domains/*.md; do
  [ -f "$f" ] || { warn "no domain files found"; continue; }
  install_domain "$f" "$PI_HOME/domains/$(basename "$f")"
done

# ---------------------------------------------------------------- bin scripts
head_ "Pi bin harness"
mkdir -p "$PI_HOME/bin"

install_bin() {
  local src=$1 dst=$2 label=${3:-$(basename "$1")}
  if [ -L "$dst" ] && [ "$FORCE" = 0 ]; then
    warn "$label is a symlink to $(readlink "$dst"); managed elsewhere, not touching"
    return
  fi
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then ok "$label"; return; fi
  if [ "$FORCE" = 1 ] && [ -L "$dst" ]; then run rm -f "$dst"; fi
  if [ -f "$dst" ]; then
    local bak="$dst.bak.$(date +%Y%m%d%H%M%S)"
    act "back up $label -> $(basename "$bak")"
    run cp -p "$dst" "$bak"
  fi
  act "install $label"
  run install -m 0755 "$src" "$dst"
}

for f in "$SCRIPT_DIR"/harness/bin/*; do
  [ -f "$f" ] || { warn "no bin files found"; continue; }
  install_bin "$f" "$PI_HOME/bin/$(basename "$f")"
done

# ---------------------------------------------------------------- summary
head_ "summary"
say "prompts installed to $PI_HOME/prompts/"
say "domains installed to $PI_HOME/domains/"
say "bin scripts installed to $PI_HOME/bin/"
say "verify with: $SCRIPT_DIR/verify-stack.sh"

exit 0