#!/usr/bin/env bash
# Board-sheet checks: sourced FQBNs, label->GPIO rows, UNKNOWN when there is no
# source, and a non-zero exit for a board that has no ref.
#
#   ./tests/tools/run-checks.sh
#
# Uses the grader venv when it exists (it has PyYAML); falls back to python3.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PY="$REPO/grader/.venv/bin/python"
[ -x "$PY" ] || PY=$(command -v python3)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok()   { pass=$((pass + 1)); printf 'PASS %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

sheet() { "$PY" "$REPO/tools/board_sheet.py" "$@"; }

out=$(sheet --list)
check "list includes wemos-d1" 'grep -qx wemos-d1 <<<"$out"'

out=$(sheet --board wemos-d1)
check "d1 FQBN from arduino-cli"        'grep -qx "FQBN: esp8266:esp8266:d1" <<<"$out"'
check "d1 label maps to its GPIO"       'grep -q "D4 .*-> GPIO4" <<<"$out"'
check "d1 LED_BUILTIN is present"       'grep -q "LED_BUILTIN .*-> GPIO2" <<<"$out"'
check "d1 logic level is stated"        'grep -qx "LOGIC LEVEL: 3.3 V" <<<"$out"'
check "d1 ADC range is not invented"    'grep -q "reference range UNKNOWN" <<<"$out"'
check "d1 label/pin warning"           'grep -q "D8 is GPIO0" <<<"$out"'

out=$(sheet --board arduino-uno)
check "uno FQBN survives UNO/UNO Mini"  'grep -qx "FQBN: arduino:avr:uno" <<<"$out"'
check "uno logic level is 5 V"          'grep -qx "LOGIC LEVEL: 5.0 V" <<<"$out"'

if "$PY" -c 'import yaml' >/dev/null 2>&1; then
  out=$(env -i HOME="$WORK/home" PATH=/nonexistent ARDUINO_CLI= \
        "$PY" "$REPO/tools/board_sheet.py" --board wemos-d1)
  check "no arduino-cli -> FQBN UNKNOWN"  'grep -qx "FQBN: UNKNOWN" <<<"$out"'
  "$PY" "$REPO/tools/board_sheet.py" --board wemos-d1 --out "$WORK/sheet.txt" >/dev/null
  check "--out writes the sheet"        'grep -qx "BOARD: LOLIN(WeMos) D1 R1" "$WORK/sheet.txt"'
else
  printf 'SKIP no arduino-cli -> FQBN UNKNOWN (PyYAML unavailable)\n'
  printf 'SKIP --out writes the sheet (PyYAML unavailable)\n'
fi

if "$PY" "$REPO/tools/board_sheet.py" --board no-such-board >/dev/null 2>&1; then
  bad "unknown board exits non-zero"
else
  ok "unknown board exits non-zero"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
