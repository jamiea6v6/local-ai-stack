#!/usr/bin/env bash
# Bootstrap the local-ai-stack on a P106-100 / Debian 13 box.
#
# Installs, user-local by default: Node 22, Pi + config, the Ollama shim and its
# user unit, arduino-cli + cores + libraries, the grader venv, and checks for
# Ollama / libportaudio2 / the GPU. Every step is idempotent: a second run only
# reports what is already present.
#
#   ./bootstrap.sh                  # install everything that does not need root
#   ./bootstrap.sh --dry-run        # print the plan, change nothing
#   ./bootstrap.sh --system         # also do root steps (portaudio, optional ollama)
#   ./bootstrap.sh --pull-models    # ollama pull the models named in models.json
#
# Exit codes: 0 = done (warnings allowed), 1 = a required step failed.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NODE_VERSION=22.23.2
NODE_MIN=22.19.0
PI_VERSION=1.4.0
CLI_VERSION=1.6.0
AVR_CORE="arduino:avr@1.8.8"
ESP_CORE="esp8266:esp8266@3.1.2"
ESP_INDEX="https://arduino.esp8266.com/stable/package_esp8266com_index.json"
NUMPY_VERSION=2.5.5
SCIPY_VERSION=1.18.1
LIBS=("Adafruit BME280 Library@2.3.0" "LiquidCrystal@1.0.7" "LiquidCrystal_I2C@2.0.0")

DRY=0
SYSTEM=0
FORCE_CONFIG=0
PULL_MODELS=0
INSTALL_OLLAMA=0
SKIP_NODE=0
SKIP_PI=0
SKIP_CONFIG=0
SKIP_SHIM=0
SKIP_ARDUINO=0
SKIP_CORES=0
SKIP_VENV=0
SKIP_MODEL=0
ACTIONS=0
PRESENT=0
WARNINGS=0

usage() {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --system) SYSTEM=1 ;;
    --force-config) FORCE_CONFIG=1 ;;
    --pull-models) PULL_MODELS=1 ;;
    --install-ollama) INSTALL_OLLAMA=1 ;;
    --skip-node) SKIP_NODE=1 ;;
    --skip-pi) SKIP_PI=1 ;;
    --skip-config) SKIP_CONFIG=1 ;;
    --skip-shim) SKIP_SHIM=1 ;;
    --skip-arduino) SKIP_ARDUINO=1 ;;
    --skip-cores) SKIP_CORES=1 ;;
    --skip-venv) SKIP_VENV=1 ;;
    --skip-model) SKIP_MODEL=1 ;;
    -h|--help) usage ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '  %s\n' "$*"; }
head_() { printf '\n== %s\n' "$*"; }
ok()   { PRESENT=$((PRESENT+1)); printf '  present: %s\n' "$*"; }
act()  { ACTIONS=$((ACTIONS+1)); printf '  %s: %s\n' "$([ "$DRY" = 1 ] && echo 'would' || echo 'doing')" "$*"; }
warn() { WARNINGS=$((WARNINGS+1)); printf '  WARN: %s\n' "$*"; }
die()  { printf '  FAIL: %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then return 0; fi; "$@"; }

ver_ge() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]; }

SUDO=""
if [ "$SYSTEM" = 1 ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO=sudo; else SUDO=""; fi
fi

OS_NAME=$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}")
ARCH=$(uname -m)
head_ "preflight"
say "repo:   $SCRIPT_DIR"
say "home:   $HOME"
say "os:     $OS_NAME ($ARCH)"
case "$ARCH" in x86_64|aarch64) ;; *) die "unsupported arch: $ARCH" ;; esac
[ -w "$HOME" ] || die "HOME is not writable"

# ---------------------------------------------------------------- node
head_ "node >= $NODE_MIN"
NODE_BIN=""
if [ -x "$HOME/.local/node/bin/node" ]; then
  CUR=$("$HOME/.local/node/bin/node" --version | sed 's/^v//')
  if ver_ge "$CUR" "$NODE_MIN"; then NODE_BIN="$HOME/.local/node/bin/node"; ok "node $CUR (user-local)"; fi
fi
if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then
  CUR=$(node --version | sed 's/^v//')
  if ver_ge "$CUR" "$NODE_MIN"; then NODE_BIN=$(command -v node); ok "node $CUR at $NODE_BIN"; fi
fi
if [ -z "$NODE_BIN" ]; then
  if [ "$SKIP_NODE" = 1 ]; then
    warn "node >= $NODE_MIN missing and --skip-node was given"
  else
    PKG="node-v${NODE_VERSION}-linux-x64"
    [ "$ARCH" = aarch64 ] && PKG="node-v${NODE_VERSION}-linux-arm64"
    act "install node $NODE_VERSION into $HOME/.local/node"
    TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
    run curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${PKG}.tar.xz" -o "$TMP/$PKG.tar.xz"
    run curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
    if [ "$DRY" = 0 ]; then
      ( cd "$TMP" && grep " ${PKG}.tar.xz$" SHASUMS256.txt | sha256sum -c - >/dev/null ) \
        || die "node tarball checksum mismatch"
      tar -xJf "$TMP/$PKG.tar.xz" -C "$TMP"
      mkdir -p "$HOME/.local"
      rm -rf "$HOME/.local/node.new"
      mv "$TMP/$PKG" "$HOME/.local/node.new"
      rm -rf "$HOME/.local/node"
      mv "$HOME/.local/node.new" "$HOME/.local/node"
      rm -rf "$TMP"
    fi
    NODE_BIN="$HOME/.local/node/bin/node"
    say "add to PATH: export PATH=\"\$HOME/.local/node/bin:\$PATH\""
  fi
fi

# ---------------------------------------------------------------- pi config
head_ "Pi harness config"
PI_HOME="$HOME/.pi/agent"
mkdir -p "$PI_HOME" 2>/dev/null || true
install_file() {
  local src=$1 dst=$2
  if [ -L "$dst" ] && [ "$FORCE_CONFIG" = 0 ]; then
    warn "$(basename "$dst") is a symlink to $(readlink "$dst"); managed elsewhere, not touching"
    return
  fi
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then ok "$(basename "$dst")"; return; fi
  if [ "$FORCE_CONFIG" = 1 ] && [ -L "$dst" ]; then run rm -f "$dst"; fi
  if [ -f "$dst" ]; then
    local bak="$dst.bak.$(date +%Y%m%d%H%M%S)"
    act "back up $(basename "$dst") -> $(basename "$bak")"
    run cp -p "$dst" "$bak"
  fi
  act "install $(basename "$dst")"
  run install -m 0644 "$src" "$dst"
}
if [ "$SKIP_CONFIG" = 0 ]; then
  if [ -L "$PI_HOME/extensions" ] && [ "$FORCE_CONFIG" = 0 ]; then
    warn "extensions/ is a symlink to $(readlink "$PI_HOME/extensions"); managed elsewhere, not touching"
  else
    mkdir -p "$PI_HOME/extensions"
    for f in "$SCRIPT_DIR"/harness/extensions/*.ts; do
      install_file "$f" "$PI_HOME/extensions/$(basename "$f")"
    done
  fi
  install_file "$SCRIPT_DIR/harness/models.json" "$PI_HOME/models.json"
  install_file "$SCRIPT_DIR/harness/settings.json" "$PI_HOME/settings.json"
  install_file "$SCRIPT_DIR/harness/pi-AGENTS.md" "$PI_HOME/AGENTS.md"
else
  say "skipped (--skip-config)"
fi

# ---------------------------------------------------------------- pi binary
head_ "Pi $PI_VERSION"
if [ "$SKIP_PI" = 0 ]; then
  if command -v pi >/dev/null 2>&1 && [ "$(pi --version 2>/dev/null | head -1)" = "$PI_VERSION" ]; then
    ok "pi $PI_VERSION at $(command -v pi)"
  else
    command -v npm >/dev/null 2>&1 || die "npm not found (install node first)"
    REL="$PI_HOME/install/releases/$PI_VERSION"
    act "npm install @earendil-works/pi-coding-agent@$PI_VERSION -> $REL"
    run mkdir -p "$REL"
    run npm install --silent --no-audit --no-fund --prefix "$REL" \
      "@earendil-works/pi-coding-agent@$PI_VERSION"
    run sh -c "printf '%s\n' '$PI_VERSION' > '$PI_HOME/install/current-version'"
    LAUNCHER="$HOME/.local/bin/pi"
    act "write launcher $LAUNCHER"
    if [ "$DRY" = 0 ]; then
      mkdir -p "$HOME/.local/bin"
      cat > "$LAUNCHER" <<'EOF'
#!/bin/sh
set -e
PI_ROOT=${PI_ROOT:-$HOME/.pi/agent}
for d in "$HOME/.local/node/bin" "${XDG_DATA_HOME:-$HOME/.local/share}/pi-node/current/bin"; do
  [ -x "$d/node" ] && PATH=$d:$PATH
done
export PATH PI_MANAGED_INSTALL_ROOT="$PI_ROOT/install"
v=$(cat "$PI_ROOT/install/current-version") || { echo "Pi version file missing" >&2; exit 1; }
exec "$PI_ROOT/install/releases/$v/node_modules/.bin/pi" "$@"
EOF
      chmod +x "$LAUNCHER"
    fi
  fi
else
  say "skipped (--skip-pi)"
fi

# ---------------------------------------------------------------- shim
head_ "Ollama shim"
if [ "$SKIP_SHIM" = 0 ]; then
  if [ -z "$NODE_BIN" ]; then
    warn "no node; shim unit not written"
  else
    UNIT_DIR="$HOME/.config/systemd/user"
    UNIT="$UNIT_DIR/ollama-v1-shim.service"
    [ "$SYSTEM" = 1 ] && { UNIT_DIR=/etc/systemd/system; UNIT="$UNIT_DIR/ollama-v1-shim.service"; }
    if [ "$DRY" = 1 ]; then
      act "write unit $UNIT"
    else
      mkdir -p "$UNIT_DIR"
      cat > "$UNIT.tmp" <<EOF
[Unit]
Description=Ollama OpenAI-compatible shim (:11435)
After=network-online.target ollama.service
Wants=ollama.service

[Service]
Type=simple
ExecStart=$NODE_BIN $SCRIPT_DIR/tools/ollama-v1-shim.mjs
Environment=OLLAMA_SHIM_PORT=11435
Environment=OLLAMA_SHIM_TARGET=http://127.0.0.1:11434
Environment=OLLAMA_SHIM_CTX=32768
Restart=on-failure
RestartSec=2

[Install]
WantedBy=$([ "$SYSTEM" = 1 ] && echo multi-user.target || echo default.target)
EOF
      if [ -f "$UNIT" ] && cmp -s "$UNIT.tmp" "$UNIT"; then
        rm -f "$UNIT.tmp"; ok "unit already current"
      else
        ACTIONS=$((ACTIONS+1)); printf '  doing: write unit %s\n' "$UNIT"
        [ -f "$UNIT" ] && cp -p "$UNIT" "$UNIT.bak.$(date +%Y%m%d%H%M%S)"
        mv "$UNIT.tmp" "$UNIT"
      fi
    fi
    if [ "$SYSTEM" = 1 ]; then
      run $SUDO systemctl daemon-reload
      run $SUDO systemctl enable --now ollama-v1-shim
    else
      run systemctl --user daemon-reload || warn "systemctl --user unavailable"
      run systemctl --user enable --now ollama-v1-shim || warn "enable --now failed; start it after login"
    fi
    if [ "$DRY" = 0 ]; then
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        curl -fsS "http://127.0.0.1:11435/v1/models" >/dev/null 2>&1 && { ok "shim responding on :11435"; break; }
        sleep 0.5
      done
      curl -fsS "http://127.0.0.1:11435/v1/models" >/dev/null 2>&1 || warn "shim not responding yet"
    fi
  fi
else
  say "skipped (--skip-shim)"
fi

# ---------------------------------------------------------------- ollama
head_ "Ollama"
if command -v ollama >/dev/null 2>&1; then
  ok "ollama $(ollama --version 2>/dev/null | sed -n 's/.*version is \([0-9.]*\).*/\1/p')"
  if systemctl is-active ollama >/dev/null 2>&1; then ok "ollama.service active"; fi
else
  if [ "$INSTALL_OLLAMA" = 1 ] && [ "$SYSTEM" = 1 ]; then
    act "run the official Ollama installer (root)"
    run sh -c 'curl -fsSL https://ollama.com/install.sh | sh'
  else
    warn "ollama not installed: re-run with --system --install-ollama, or install it manually"
  fi
fi

# ---------------------------------------------------------------- models
head_ "Models"
if [ "$SKIP_MODEL" = 0 ] && command -v ollama >/dev/null 2>&1; then
  mapfile -t MODEL_IDS < <(python3 - "$SCRIPT_DIR/harness/models.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for p in d.get("providers", {}).values():
    for m in p.get("models", []):
        print(m["id"])
PY
)
  HAVE=$(ollama list 2>/dev/null | awk 'NR>1 {print $1}')
  for m in "${MODEL_IDS[@]}"; do
    if printf '%s\n' "$HAVE" | grep -x "$m" >/dev/null; then ok "model $m"
    elif [ "$PULL_MODELS" = 1 ]; then act "ollama pull $m"; run ollama pull "$m"
    else warn "model $m missing (run with --pull-models)"; fi
  done
else
  say "skipped"
fi

# ---------------------------------------------------------------- arduino
head_ "arduino-cli"
CLI=""
if command -v arduino-cli >/dev/null 2>&1; then CLI=$(command -v arduino-cli)
elif [ -x "$HOME/.local/bin/arduino-cli" ]; then CLI="$HOME/.local/bin/arduino-cli"; fi
if [ -n "$CLI" ]; then
  CV=$("$CLI" version | sed -n 's/.*Version: \([0-9.]*\).*/\1/p')
  if ver_ge "$CV" "$CLI_VERSION"; then ok "arduino-cli $CV at $CLI"
  else warn "arduino-cli $CV is older than $CLI_VERSION; remove it and re-run"; CLI=""; fi
fi
if [ -z "$CLI" ] && [ "$SKIP_ARDUINO" = 0 ]; then
  PKG="arduino-cli_${CLI_VERSION}_Linux_64bit.tar.gz"
  [ "$ARCH" = aarch64 ] && PKG="arduino-cli_${CLI_VERSION}_Linux_ARM64.tar.gz"
  act "install arduino-cli $CLI_VERSION into $HOME/.local/bin"
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  run curl -fsSL "https://github.com/arduino/arduino-cli/releases/download/v${CLI_VERSION}/${PKG}" -o "$TMP/$PKG"
  run curl -fsSL "https://github.com/arduino/arduino-cli/releases/download/v${CLI_VERSION}/${CLI_VERSION}-checksums.txt" -o "$TMP/sums"
  if [ "$DRY" = 0 ]; then
    ( cd "$TMP" && grep " ${PKG}$" sums | sha256sum -c - >/dev/null ) || die "arduino-cli checksum mismatch"
    tar -xzf "$TMP/$PKG" -C "$TMP" arduino-cli
    mkdir -p "$HOME/.local/bin"
    install -m 0755 "$TMP/arduino-cli" "$HOME/.local/bin/arduino-cli"
    rm -rf "$TMP"
  fi
  CLI="$HOME/.local/bin/arduino-cli"
fi
if [ -n "$CLI" ]; then
  if [ ! -f "$HOME/.arduino15/arduino-cli.yaml" ]; then
    act "arduino-cli config init"; run "$CLI" config init
  fi
  if ! "$CLI" config get board_manager.additional_urls 2>/dev/null | grep -F "$ESP_INDEX" >/dev/null; then
    act "add esp8266 board index"; run "$CLI" config add board_manager.additional_urls "$ESP_INDEX"
  else ok "esp8266 board index configured"; fi
  if [ "$SKIP_CORES" = 0 ]; then
    CORES=$("$CLI" core list 2>/dev/null | awk 'NR>1 {print $1"@"$2}')
    for c in "$AVR_CORE" "$ESP_CORE"; do
      if printf '%s\n' "$CORES" | grep -x "$c" >/dev/null; then ok "core $c"
      else act "core install $c"; run "$CLI" core update-index; run "$CLI" core install "$c"; fi
    done
    LIBS_NOW=$("$CLI" lib list 2>/dev/null)
    for l in "${LIBS[@]}"; do
      name=${l%@*}
      if printf '%s\n' "$LIBS_NOW" | grep -F "$name" >/dev/null; then ok "library $l"
      else act "lib install $l"; run "$CLI" lib install "$l"; fi
    done
  else
    say "cores/libs skipped (--skip-cores)"
  fi
fi

# ---------------------------------------------------------------- venv
head_ "grader venv"
VENV="$SCRIPT_DIR/grader/.venv"
if [ "$SKIP_VENV" = 1 ]; then
  say "skipped (--skip-venv)"
elif [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c 'import numpy, scipy' >/dev/null 2>&1; then
  ok "venv with numpy $( "$VENV/bin/python" -c 'import numpy;print(numpy.__version__)' )"
else
  act "create $VENV and install numpy==$NUMPY_VERSION scipy==$SCIPY_VERSION"
  run python3 -m venv "$VENV"
  run "$VENV/bin/pip" install --disable-pip-version-check -q "numpy==$NUMPY_VERSION" "scipy==$SCIPY_VERSION"
fi

# ---------------------------------------------------------------- system libs
head_ "system libraries"
LDCONF=$(command -v ldconfig || echo /sbin/ldconfig)
if "$LDCONF" -p 2>/dev/null | grep libportaudio >/dev/null; then ok "libportaudio2"
elif [ "$SYSTEM" = 1 ]; then act "apt-get install libportaudio2"; run $SUDO apt-get install -y libportaudio2
else warn "libportaudio2 missing: re-run with --system"; fi

# ---------------------------------------------------------------- gpu
head_ "GPU"
if command -v lspci >/dev/null 2>&1 && lspci -d 10de:1c07 2>/dev/null | grep . >/dev/null; then
  ok "P106-100 present"
  if command -v nvidia-smi >/dev/null 2>&1; then
    say "VRAM: $(nvidia-smi --query-gpu=memory.total --format=csv,noheader | head -1)"
  fi
else
  warn "no P106-100 (10de:1c07) on this box — install still valid, model speed will differ"
fi
if command -v vulkaninfo >/dev/null 2>&1; then
  if vulkaninfo --summary 2>/dev/null | grep deviceName >/dev/null; then ok "Vulkan device visible"; fi
else
  warn "vulkaninfo not installed (needed to confirm the P106 compute path)"
fi

# ---------------------------------------------------------------- summary
head_ "summary"
say "$PRESENT present, $ACTIONS action(s), $WARNINGS warning(s)$([ "$DRY" = 1 ] && echo ' (dry run)')"
say "verify with: $SCRIPT_DIR/verify-stack.sh"
exit 0
