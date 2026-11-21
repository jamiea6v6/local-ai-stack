#!/usr/bin/env bash
# Install harness prompts, domains, and bin scripts to Pi agent config.
#
# Installs from the local-ai-stack harness/ source of truth into
# ~/.pi/agent/ following the same idempotent patterns as bootstrap.sh.
#
#   ./install-harness.sh                 # install everything
#   ./install-harness.sh --dry-run       # print the plan, change nothing
#   ./install-harness.sh --force         # replace symlinks too (existing files are still backed up)
#
# Exit codes: 0 = done (warnings allowed), 1 = a required step failed.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PI_HOME="$HOME/.pi/agent"
DRY=0
FORCE=0

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
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
run()  { if [ "$DRY" = 1 ]; then return 0; fi; "$@"; }

# install_file SRC DST MODE
#   - a symlink at DST is managed elsewhere: left alone unless --force
#   - an identical file is reported as present
#   - a different file is backed up (timestamped) before being replaced
install_file() {
  local src=$1 dst=$2 mode=$3 label
  label=$(basename "$src")
  if [ -L "$dst" ] && [ "$FORCE" = 0 ]; then
    warn "$label is a symlink to $(readlink "$dst"); managed elsewhere, not touching"
    return
  fi
  if [ ! -L "$dst" ] && [ -f "$dst" ] && cmp -s "$src" "$dst"; then ok "$label"; return; fi
  if [ -L "$dst" ]; then
    act "replace symlink $label"
    run rm -f "$dst"
  elif [ -f "$dst" ]; then
    local bak="$dst.bak.$(date +%Y%m%d%H%M%S)"
    act "back up $label -> $(basename "$bak")"
    run cp -p "$dst" "$bak"
  fi
  act "install $label"
  run install -m "$mode" "$src" "$dst"
}

# install_dir KIND SRC_GLOB_DIR DST_DIR MODE PATTERN
install_dir() {
  local kind=$1 srcdir=$2 dstdir=$3 mode=$4 pattern=$5 f found=0
  head_ "Pi $kind"
  if [ "$DRY" = 1 ]; then
    [ -d "$dstdir" ] || act "create $dstdir"
  else
    mkdir -p "$dstdir"
  fi
  for f in "$srcdir"/$pattern; do
    [ -f "$f" ] || continue
    found=1
    install_file "$f" "$dstdir/$(basename "$f")" "$mode"
  done
  [ "$found" = 1 ] || warn "no $kind files found in $srcdir"
}

install_dir "prompts" "$SCRIPT_DIR/harness/prompts" "$PI_HOME/prompts" 0644 '*.md'
install_dir "domains" "$SCRIPT_DIR/harness/domains" "$PI_HOME/domains" 0644 '*.md'
install_dir "bin scripts" "$SCRIPT_DIR/harness/bin" "$PI_HOME/bin" 0755 '*'

head_ "summary"
say "prompts: $PI_HOME/prompts/"
say "domains: $PI_HOME/domains/"
say "bin:     $PI_HOME/bin/"
if [ "$DRY" = 1 ]; then say "dry run: nothing was changed"; fi
say "verify with: $SCRIPT_DIR/verify-stack.sh"

exit 0
