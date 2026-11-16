#!/usr/bin/env bash
# Verify a local-ai-stack install. Read-only: it changes nothing.
#
#   ./verify-stack.sh                 # P106 absence is a SKIP (non-target box)
#   ./verify-stack.sh --require-p106  # P106 absence is a FAIL
#
# Exit 0 when no check FAILs; SKIPs are reported but do not fail the run.

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PI_VERSION=1.4.0
NODE_MIN=22.19.0
REQUIRE_P106=0
for arg in "$@"; do
  case "$arg" in
    --require-p106) REQUIRE_P106=1 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

PASS=0; FAIL=0; SKIP=0
p() { PASS=$((PASS+1)); printf 'PASS  %s\n' "$*"; }
f() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$*"; }
s() { SKIP=$((SKIP+1)); printf 'SKIP  %s\n' "$*"; }
ver_ge() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]; }

printf 'verify: %s\n' "$SCRIPT_DIR"

# 1 OS
if . /etc/os-release 2>/dev/null && [ "${ID:-}" = debian ] && [ "${VERSION_ID:-}" = 13 ]; then
  p "Debian 13 ($(uname -m))"
else
  f "expected Debian 13, found ${PRETTY_NAME:-unknown}"
fi

# 2 node
NODE_BIN=""
if command -v node >/dev/null 2>&1; then NODE_BIN=$(command -v node)
elif [ -x "$HOME/.local/node/bin/node" ]; then NODE_BIN="$HOME/.local/node/bin/node"; fi
if [ -n "$NODE_BIN" ]; then
  V=$("$NODE_BIN" --version | sed 's/^v//')
  if ver_ge "$V" "$NODE_MIN"; then p "node $V"; else f "node $V < $NODE_MIN"; fi
else
  f "node not found (bootstrap.sh installs it)"
fi

# 3 ollama service + API
if command -v ollama >/dev/null 2>&1; then
  p "ollama $(ollama --version 2>/dev/null | sed -n 's/.*version is \([0-9.]*\).*/\1/p')"
  if systemctl is-active ollama >/dev/null 2>&1; then p "ollama.service active"
  else s "ollama.service not active under systemd"; fi
  if curl -fsS --max-time 3 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then p "native API :11434"
  else f "native API :11434 not answering"; fi
else
  f "ollama not installed"
fi

# 4 shim
UNIT=""
for u in "$HOME/.config/systemd/user/ollama-v1-shim.service" /etc/systemd/system/ollama-v1-shim.service; do
  [ -f "$u" ] && UNIT=$u
done
if [ -n "$UNIT" ]; then
  p "unit $(basename "$(dirname "$UNIT")")/$(basename "$UNIT")"
  if [ "$UNIT" = "/etc/systemd/system/ollama-v1-shim.service" ]; then
    systemctl is-active ollama-v1-shim >/dev/null 2>&1 && p "shim active" || f "shim unit not active"
  else
    systemctl --user is-active ollama-v1-shim >/dev/null 2>&1 && p "shim active (user)" || f "shim unit not active"
  fi
else
  f "shim unit not installed"
fi
if curl -fsS --max-time 3 http://127.0.0.1:11435/v1/models >/dev/null 2>&1; then
  p "shim API :11435"
else
  f "shim API :11435 not answering"
fi
if [ -n "$UNIT" ]; then
  RUNNING=$(sed -n 's/^ExecStart=//p' "$UNIT" | awk '{print $NF}' | head -1)
  if [ -n "$RUNNING" ] && [ -f "$RUNNING" ] && cmp -s "$RUNNING" "$SCRIPT_DIR/tools/ollama-v1-shim.mjs"; then
    p "shim script matches repo"
  else
    f "shim script drift: unit runs ${RUNNING:-nothing}, repo has tools/ollama-v1-shim.mjs"
  fi
fi

# 5 models from models.json
MODEL_IDS=()
if [ -f "$SCRIPT_DIR/harness/models.json" ]; then
  mapfile -t MODEL_IDS < <(python3 - "$SCRIPT_DIR/harness/models.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for prov in d.get("providers", {}).values():
    for m in prov.get("models", []):
        print(m["id"])
PY
)
fi
if [ ${#MODEL_IDS[@]} -eq 0 ]; then
  f "no models declared in harness/models.json"
elif command -v ollama >/dev/null 2>&1; then
  HAVE=$(ollama list 2>/dev/null | awk 'NR>1 {print $1}')
  for m in "${MODEL_IDS[@]}"; do
    if printf '%s\n' "$HAVE" | grep -x "$m" >/dev/null; then p "model $m"; else f "model $m not pulled"; fi
  done
fi

# 6 pi + config drift
if command -v pi >/dev/null 2>&1; then
  PV=$(pi --version 2>/dev/null | head -1)
  if [ "$PV" = "$PI_VERSION" ]; then p "pi $PV"; else f "pi $PV (want $PI_VERSION)"; fi
else
  f "pi not on PATH"
fi
PI_HOME="$HOME/.pi/agent"
if [ -L "$PI_HOME/extensions" ]; then
  s "extensions/ is a symlink to $(readlink "$PI_HOME/extensions"); not comparable"
else
  drift=0
  for src in "$SCRIPT_DIR"/harness/extensions/*.ts; do
    dst="$PI_HOME/extensions/$(basename "$src")"
    if [ ! -f "$dst" ]; then f "extension missing: $(basename "$dst")"; drift=1
    elif ! cmp -s "$src" "$dst"; then f "extension drift: $(basename "$dst")"; drift=1; fi
  done
  [ "$drift" = 0 ] && p "9 extensions match the repo"
fi
for pair in "models.json:models.json" "settings.json:settings.json" "pi-AGENTS.md:AGENTS.md"; do
  src="$SCRIPT_DIR/harness/${pair%%:*}"; dst="$PI_HOME/${pair##*:}"
  if [ -L "$dst" ]; then s "$(basename "$dst") is a symlink; not comparable"
  elif [ ! -f "$dst" ]; then f "$(basename "$dst") missing"
  elif ! cmp -s "$src" "$dst"; then f "$(basename "$dst") drift"
  else p "$(basename "$dst") matches"; fi
done

# 7 window truth
if python3 - "$SCRIPT_DIR/harness/models.json" "$SCRIPT_DIR/tools/ollama-v1-shim.mjs" <<'PY'
import json, re, sys
models = json.load(open(sys.argv[1]))
ctx = {m.get("contextWindow") for p in models["providers"].values() for m in p["models"]}
shim = open(sys.argv[2]).read()
m = re.search(r"OLLAMA_SHIM_CTX \|\| (\d+)", shim)
sys.exit(0 if ctx == {32768} and m and m.group(1) == "32768" else 1)
PY
then p "context window 32768 in models.json and shim"; else f "context window is not 32768 everywhere"; fi

# 8 arduino-cli
CLI=""
if command -v arduino-cli >/dev/null 2>&1; then CLI=$(command -v arduino-cli)
elif [ -x "$HOME/.local/bin/arduino-cli" ]; then CLI="$HOME/.local/bin/arduino-cli"; fi
if [ -n "$CLI" ]; then
  CV=$("$CLI" version | sed -n 's/.*Version: \([0-9.]*\).*/\1/p')
  if ver_ge "$CV" "1.6.0"; then p "arduino-cli $CV"; else f "arduino-cli $CV < 1.6.0"; fi
  CORES=$("$CLI" core list 2>/dev/null | awk 'NR>1 {print $1"@"$2}')
  for c in "arduino:avr@1.8.8" "esp8266:esp8266@3.1.2"; do
    printf '%s\n' "$CORES" | grep -x "$c" >/dev/null && p "core $c" || f "core $c missing"
  done
  LIBS=$("$CLI" lib list 2>/dev/null)
  for l in "Adafruit BME280 Library" "LiquidCrystal" "LiquidCrystal_I2C"; do
    printf '%s\n' "$LIBS" | grep -F "$l" >/dev/null && p "library $l" || f "library $l missing"
  done
else
  f "arduino-cli not found"
fi

# 9 board maps
if [ -f "$SCRIPT_DIR/tools/board_meta.py" ] && [ -d "$SCRIPT_DIR/refs/boards" ]; then
  if [ -z "$CLI" ]; then s "board maps: arduino-cli missing"
  elif python3 "$SCRIPT_DIR/tools/board_meta.py" --check >/tmp/verify-board-maps.$$ 2>&1; then
    p "board maps: $(grep -c '^OK' /tmp/verify-board-maps.$$) boards verified"
    rm -f /tmp/verify-board-maps.$$
  else
    f "board maps drift (see /tmp/verify-board-maps.$$)"
  fi
else
  s "board maps not present"
fi

# 10 grader
GV="$SCRIPT_DIR/grader/.venv/bin/python"
if [ -x "$GV" ] && "$GV" -c 'import numpy, scipy' >/dev/null 2>&1; then
  out=$(cd "$SCRIPT_DIR/grader" && "$GV" spec_cw_filter.py cw_filter.py 2>&1) || true
  if printf '%s' "$out" | grep "11/11 checks passed" >/dev/null; then p "grader 11/11"
  else f "grader did not report 11/11"; fi
else
  f "grader venv missing numpy/scipy"
fi

# 11 mcu domain gates
MCU="${MCU_DOMAIN:-}"
[ -z "$MCU" ] && [ -d "$HOME/domains/mcu" ] && MCU="$HOME/domains/mcu"
[ -z "$MCU" ] && [ -d "$SCRIPT_DIR/../domains/mcu" ] && MCU="$SCRIPT_DIR/../domains/mcu"
if [ -n "$MCU" ] && [ -f "$MCU/check_reqs.py" ]; then
  ( cd "$MCU" && python3 check_reqs.py --selftest >/dev/null 2>&1 ) && p "MCU REQS gate selftest" || f "MCU REQS gate selftest"
  ( cd "$MCU" && python3 check_pins_src.py --selftest >/dev/null 2>&1 ) && p "MCU PINS gate selftest" || f "MCU PINS gate selftest"
else
  s "mcu-domain not found (set MCU_DOMAIN)"
fi

# 12 GPU
if command -v lspci >/dev/null 2>&1 && lspci -d 10de:1c07 2>/dev/null | grep . >/dev/null; then
  p "P106-100 present"
  if command -v nvidia-smi >/dev/null 2>&1; then
    line=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | grep -i p106 | head -1)
    if [ -n "$line" ]; then
      mem=$(printf '%s' "$line" | awk -F', ' '{print $2}')
      [ "$mem" = "6144 MiB" ] && p "P106 VRAM 6144 MiB" || f "P106 VRAM is $mem (expected 6144 MiB)"
    else
      s "nvidia-smi does not list a P106"
    fi
  fi
else
  [ "$REQUIRE_P106" = 1 ] && f "P106-100 (10de:1c07) not present" || s "no P106-100 on this box (not a target box)"
fi

# 13 vulkan
if command -v vulkaninfo >/dev/null 2>&1; then
  n=$(vulkaninfo --summary 2>/dev/null | grep -c deviceName)
  [ "$n" -ge 1 ] && p "Vulkan: $n device(s)" || f "Vulkan devices not visible"
else
  s "vulkaninfo not installed"
fi

# 14 portaudio
LDCONF=$(command -v ldconfig || echo /sbin/ldconfig)
"$LDCONF" -p 2>/dev/null | grep libportaudio >/dev/null && p "libportaudio2" || f "libportaudio2 missing"

# summary
printf '\n%d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ] || exit 1
