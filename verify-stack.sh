#!/usr/bin/env bash
# Verify a local-ai-stack install. Read-only: it changes nothing.
#
#   ./verify-stack.sh                     # auto: p106 if fitted, else gpu, else cpu
#   ./verify-stack.sh --profile p106      # require a P106-100 + 6144 MiB + 100% GPU
#   ./verify-stack.sh --profile gpu       # any NVIDIA GPU >= 6 GB + 100% GPU
#   ./verify-stack.sh --profile cpu       # no GPU required (slow, still correct)
#   ./verify-stack.sh --no-inference      # state checks only (CI / CI-like runs)
#
# Profiles also prove a real completion through the shim, that Ollama put the
# model 100% in VRAM (except cpu), and that it loaded at 32768 context.
# Exit 0 when no check FAILs; SKIPs are reported but do not fail the run.

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PI_VERSION=1.4.0
NODE_MIN=22.19.0
PROFILE=auto
INFER=1
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE=${2:-}; shift 2 ;;
    --profile=*) PROFILE=${1#*=}; shift ;;
    --require-p106) PROFILE=p106; shift ;;
    --no-inference) INFER=0; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done
case "$PROFILE" in auto|p106|gpu|cpu) ;; *) echo "bad profile: $PROFILE (auto|p106|gpu|cpu)" >&2; exit 2 ;; esac

PASS=0; FAIL=0; SKIP=0
p() { PASS=$((PASS+1)); printf 'PASS  %s\n' "$*"; }
f() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$*"; }
s() { SKIP=$((SKIP+1)); printf 'SKIP  %s\n' "$*"; }
ver_ge() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]; }

p106_present() { command -v lspci >/dev/null 2>&1 && lspci -d 10de:1c07 2>/dev/null | grep . >/dev/null; }
has_nvidia() { command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L 2>/dev/null | grep '^GPU' >/dev/null; }
max_vram_mib() { nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | sort -n | tail -1; }

if [ "$PROFILE" = auto ]; then
  if p106_present; then PROFILE=p106
  elif has_nvidia; then PROFILE=gpu
  else PROFILE=cpu; fi
  printf 'verify: %s (profile: %s, auto)\n' "$SCRIPT_DIR" "$PROFILE"
else
  printf 'verify: %s (profile: %s)\n' "$SCRIPT_DIR" "$PROFILE"
fi

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

# 5b inference: a real completion through the shim, then GPU attribution
SMOKE_MODEL=${MODEL_IDS[0]:-}
if [ "$INFER" = 0 ]; then
  s "inference skipped (--no-inference)"
elif [ -z "$SMOKE_MODEL" ]; then
  f "inference: no model declared"
elif ! curl -fsS --max-time 3 http://127.0.0.1:11435/v1/models >/dev/null 2>&1; then
  s "inference: shim not answering (see above)"
else
  BODY=$(python3 - "$SMOKE_MODEL" <<'PYBODY'
import json, sys
print(json.dumps({
    "model": sys.argv[1],
    "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
    "max_tokens": 32, "temperature": 0, "keep_alive": "2m",
}))
PYBODY
)
  OUT=$(curl -sS --max-time 240 http://127.0.0.1:11435/v1/chat/completions \
        -H 'Content-Type: application/json' -d "$BODY" 2>/dev/null)
  VERDICT=$(printf '%s' "$OUT" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("bad-json"); raise SystemExit
ch = (d.get("choices") or [{}])[0]
msg = ch.get("message") or {}
content = (msg.get("content") or "").strip()
reason = ch.get("finish_reason")
if not content:
    print("empty-content" + (" (reasoning_content present)" if msg.get("reasoning_content") else ""))
elif reason != "stop":
    print("finish_reason=" + str(reason))
else:
    print("ok")
')
  case "$VERDICT" in
    ok) p "completion via shim: $SMOKE_MODEL, non-empty, stop" ;;
    *)  f "completion via shim: $VERDICT" ;;
  esac

  PS=$(curl -sS --max-time 5 http://127.0.0.1:11434/api/ps 2>/dev/null)
  ATTR=$(printf '%s' "$PS" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("absent"); raise SystemExit
name, prof = sys.argv[1], sys.argv[2]
ms = [m for m in d.get("models", []) if m.get("name") == name]
if not ms:
    print("absent"); raise SystemExit
m = ms[0]
size, vram = m.get("size") or 0, m.get("size_vram") or 0
ctx = m.get("context_length")
if ctx != 32768:
    print("context=" + str(ctx))
elif prof in ("p106", "gpu") and vram < size * 0.99:
    print("split %d/%d MiB" % (vram // 1048576, size // 1048576))
else:
    print("ok %d/%d MiB ctx=%s" % (vram // 1048576, size // 1048576, ctx))
' "$SMOKE_MODEL" "$PROFILE")
  case "$ATTR" in
    ok*) p "loaded: ${ATTR#ok }" ;;
    absent) f "model not loaded after completion (keep_alive not honoured?)" ;;
    context=*) f "loaded ${ATTR#context=} context (want 32768)" ;;
    split*) f "processor ${ATTR#split } VRAM of model (want 100% for $PROFILE)" ;;
    *) f "attribution: $ATTR" ;;
  esac
fi

# 6 pi + config drift
PI_BIN=""
if command -v pi >/dev/null 2>&1; then PI_BIN=$(command -v pi)
elif [ -x "$HOME/.local/bin/pi" ]; then PI_BIN="$HOME/.local/bin/pi"; fi
if [ -n "$PI_BIN" ]; then
  PV=$("$PI_BIN" --version 2>/dev/null | head -1)
  if [ "$PV" = "$PI_VERSION" ]; then
    p "pi $PV"
    command -v pi >/dev/null 2>&1 || s "pi not on PATH (add \$HOME/.local/bin)"
  else
    f "pi $PV (want $PI_VERSION)"
  fi
else
  f "pi not installed"
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

# 8b platformio (board_meta needs ~/.platformio/platforms/espressif32)
PIO=""
if command -v pio >/dev/null 2>&1; then PIO=$(command -v pio)
elif [ -x "$HOME/.local/bin/pio" ]; then PIO="$HOME/.local/bin/pio"; fi
if [ -n "$PIO" ]; then
  p "pio $("$PIO" --version 2>/dev/null | sed -n 's/.*version \([0-9.]*\).*/\1/p')"
  "$PIO" pkg list -g 2>/dev/null | grep "espressif32" >/dev/null && p "platform espressif32" || f "platform espressif32 missing"
else
  f "PlatformIO not found (board_meta needs it for esp32)"
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

# 12 GPU, by profile
case "$PROFILE" in
  p106)
    if p106_present; then
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
      f "p106 profile: P106-100 (10de:1c07) not present"
    fi
    ;;
  gpu)
    if has_nvidia; then
      p "NVIDIA GPU present ($(nvidia-smi -L 2>/dev/null | wc -l) device(s))"
      MEM=$(max_vram_mib)
      [ "${MEM:-0}" -ge 6144 ] && p "max VRAM $MEM MiB" || f "max VRAM ${MEM:-0} MiB < 6144"
    else
      f "gpu profile: no NVIDIA GPU visible"
    fi
    ;;
  cpu)
    s "cpu profile: no GPU required"
    ;;
esac

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
