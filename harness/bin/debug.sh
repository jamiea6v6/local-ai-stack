#!/bin/bash
set -euo pipefail
cwd="$(pwd)"
out="$cwd/DEBUG.md"
run_cmd=""
if [[ "${1:-}" == "run" ]]; then
  shift
  run_cmd="$*"
fi
ts="$(date '+%Y-%m-%d %H:%M:%S %Z')"
timeout_s="${DEBUG_TIMEOUT:-20}"

{
  echo "# Debug Snapshot"
  echo
  echo "- Generated: \`$ts\`"
  echo "- Project: \`$cwd\`"
  echo "- Host: \`$(hostname 2>/dev/null || echo unknown)\`"
  echo "- OS: \`$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-}" || uname -sr)\`"
  echo "- Kernel/arch: \`$(uname -srm 2>/dev/null || true)\` / \`$(uname -m 2>/dev/null || true)\`"
  echo
  echo "## Python environment"
  echo
  echo '```'
  echo "python3: $(command -v python3 2>/dev/null || echo missing)"
  python3 --version 2>&1 || true
  echo "pip3: $(command -v pip3 2>/dev/null || echo missing)"
  python3 -m pip --version 2>&1 || true
  for v in .venv venv env; do
    if [[ -x "$cwd/$v/bin/python" ]]; then
      echo "venv: $v"
      "$cwd/$v/bin/python" --version 2>&1 || true
      "$cwd/$v/bin/python" -m pip --version 2>&1 || true
    fi
  done
  echo '```'
  echo
  echo "## Package checks (best effort)"
  echo
  echo '```'
  check_py() {
    local py="$1" label="$2"
    if [[ -x "$py" || "$py" == "python3" ]]; then
      echo "[$label]"
      "$py" - <<'PY' 2>&1 || true
import importlib, sys
mods=["pyaudio","numpy","scipy","sounddevice","textual","curses"]
for m in mods:
    try:
        mod=importlib.import_module(m)
        v=getattr(mod,"__version__",getattr(mod,"Pa_GetVersionText",lambda:"ok")() if m=="pyaudio" else "ok")
        print(f"{m}: {v}")
    except Exception as e:
        print(f"{m}: MISSING/ERR ({e.__class__.__name__}: {e})")
print("executable:", sys.executable)
PY
    fi
  }
  check_py "python3" "python3"
  for v in .venv venv env; do
    if [[ -x "$cwd/$v/bin/python" ]]; then check_py "$cwd/$v/bin/python" "$v"; fi
  done
  echo '```'
  echo
  echo "## Audio/system hints"
  echo
  echo '```'
  pactl info 2>&1 | sed -n '1,12p' || echo "pactl: unavailable"
  echo "---"
  (aplay -l 2>&1 || echo "aplay: unavailable") | sed -n '1,20p'
  echo "---"
  dpkg -l 2>/dev/null | grep -E 'portaudio|pyaudio|libasound|pulseaudio|pipewire' | head -20 || echo "dpkg query unavailable/no matches"
  echo '```'
  echo
  echo "## Project files"
  echo
  echo '```'
  find . -maxdepth 3 \
    \( -path './.git/*' -o -path './.venv/*' -o -path './venv/*' -o -path './env/*' -o -path './__pycache__/*' -o -path './*/__pycache__/*' -o -path './node_modules/*' \) -prune -o -type f -print \
    | sed 's#^\./##' | sort | head -120
  echo '```'
  echo
  for f in PLAN.md BRIEF.md DEPLOY.md HANDOFF.md README.md README.txt; do
    if [[ -f "$f" ]]; then
      echo "## $f (head)"
      echo
      echo '```'
      sed -n '1,80p' "$f"
      echo '```'
      echo
    fi
  done
  echo "## Entrypoints (detected)"
  echo
  found=0
  for f in app.py main.py run.py server.py cli.py __main__.py; do
    if [[ -f "$f" ]]; then echo "- \`$f\`"; found=1; fi
  done
  [[ $found -eq 0 ]] && echo "- none of app.py/main.py/run.py/server.py/cli.py/__main__.py found"
  echo
  if [[ -n "$run_cmd" ]]; then
    echo "## Command run"
    echo
    echo "- Command: \`$run_cmd\`"
    echo "- Timeout: ${timeout_s}s, stdin: /dev/null"
    echo "- Note: interactive TUIs, audio/device access, and long-running services may not behave correctly in this capture."
    echo
    echo '```'
    set +e
    timeout "${timeout_s}s" bash -lc "$run_cmd" </dev/null 2>&1
    rc=$?
    set -e
    echo
    echo "EXIT=$rc"
    if [[ $rc -eq 124 ]]; then echo "(timed out after ${timeout_s}s)"; fi
    echo '```'
    echo
  else
    echo "## Command run"
    echo
    echo "- No command executed. To capture a runtime/startup error, run: \`/debug run <command>\` (e.g. \`/debug run .venv/bin/python main.py\`)."
    echo "- Capture is timeout-limited and non-interactive; TUIs/audio/live devices may need manual testing."
    echo
  fi
  echo "## Cautions"
  echo
  echo "- This snapshot is evidence from local files and the optional command above; it does not prove full runtime correctness."
  echo "- Do not run destructive or privileged commands via \`/debug run\` without reviewing them."
} > "$out"

echo "Wrote $out"
if [[ -n "$run_cmd" ]]; then echo "ran: $run_cmd (timeout ${timeout_s}s)"; else echo "snapshot only (no command run)"; fi
