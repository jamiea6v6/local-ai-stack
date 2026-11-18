# I7 — frozen local operator tasks

This file pre-registers I7 before execution. Do not change prompts, gates, retry caps, or report fields
after the first run. Add a new task instead.

## Roles

- Operator: Skynet Opencode / GPT-OSS.
- Subject: Brain1 Pi / `ollama/gemma4:e4b-it-qat`.
- The operator passes `--model ollama/gemma4:e4b-it-qat` to Pi on Brain1. It must never pass
  `gpt-oss:20b` as the subject model.
- Raw sessions/reports stay under `~/local-results/` on Brain1 or Skynet. Do not commit them.

## Common stop conditions

Stop immediately if:

- deterministic Tier 0 gates fail;
- the operator cannot reach Brain1;
- the model tries to edit `tests/suite.json`, `tests/REFRESHED_SUITE.md`, this file, prompts, ground
  truth, or PASS/FAIL criteria;
- a task reaches 3 attempts without passing.

For each failed attempt, feed the exact gate output back to the same Pi session and ask it to fix the
artifact. Do not restate or soften the task.

## Operator execution interface

Use these helpers on Brain1; do not infer a different Pi command. They implement the same PTY
invocation as `tests/measurement/run-baseline.mjs:374`. The default subject model is
`ollama/gemma4:e4b-it-qat`; do not override `--model`.

```bash
PI_TURN=~/projects/local-ai-stack/tests/i7/pi_turn.py
EVIDENCE=~/projects/local-ai-stack/tests/i7/session_evidence.py
```

First turn:

```bash
python3 "$PI_TURN" --work "$WORK" --prompt-file "$WORK/prompt.txt" --session-id "$SID"
```

Retry in the same Pi session:

```bash
python3 "$PI_TURN" --work "$WORK" --prompt-file "$WORK/retry.txt" --session-id "$SID" --resume
```

These commands are execution mechanics only; prompts, gates, retry cap, and report fields below are
unchanged.

## Operator mechanics guardrails

These are execution mechanics learned from the first I7a attempt. They do not change the frozen
prompts, gates, retry cap, or report fields.

- This is intentionally multi-step. Use as many tool calls as needed and proceed one command at a
  time. Do not decline as "too large" or "out of scope", and do not ask for clarification unless a
  stop condition fires. If you cannot continue, report the exact failing command and error, not a
  generic apology.
- The operator session may start in the home directory, not the repo. Before doing anything, read
  both docs from their home-relative Skynet paths: `~/local-ai-stack/docs/I7_TASKS.md` and
  `~/local-ai-stack/docs/LOCAL_MODEL_RUNBOOK.md`. If a relative `docs/...` read fails, expand `~` to
  the absolute home path and retry; never conclude the docs are missing.
- The operator home is not itself a git repo. Verify versions with these exact commands:
  `git -C ~/local-ai-stack rev-parse HEAD`, then
  `ssh <user>@<brain1-host> 'git -C ~/projects/local-ai-stack rev-parse HEAD; test -x ~/projects/local-ai-stack/tests/i7/pi_turn.py && test -x ~/projects/local-ai-stack/tests/i7/session_evidence.py && echo HELPERS_OK'`.
  A `git -C ~` failure is an operator path error, not a task stop condition; retry with the
  expanded repo path once.
- Skynet paths are relative to the operator home; Brain1 paths are relative to the Brain1 home.
  Brain1's `~/local-ai-stack` does not exist. Run remote commands inside single-quoted `ssh` strings
  and verify with `ssh <user>@<brain1-host> 'test -f ~/projects/local-ai-stack/docs/I7_TASKS.md && echo OK'`.
- The local `read` tool requires `filePath`, not `path`, and does not expand `~`; substitute the
  absolute path before calling it. Local `glob` and `grep` use `path`. If a tool call fails on schema,
  correct it once from the error; do not switch to
  unavailable tools or delegate to `task`/`explore` agents.
- Never chain setup with `;`. Use `set -euo pipefail`, separate commands, and expect a printed success
  line. "Command completed successfully" with no stdout while creating a required file is not proof.
- Generate the board sheet with `~/projects/local-ai-stack/grader/.venv/bin/python`; bare
  `python3` on Brain1 lacks PyYAML. Do not install packages during I7.
- Before every Pi turn and retry, assert `devices/` contains only `wemos-d1-mini.txt`. Delete any
  model-created `devices/board.txt`; a wrong FQBN there silently overrides the canonical sheet.
- Capture every gate with stdout, stderr, and exit code in `$WORK/gate.txt`. Use that exact file for
  `retry.txt`. Run `session_evidence.py` only after `pi_turn.py` has produced a session file; before
  the first turn, exit 1 is expected and is not a harness failure. Never proceed if
  `PI_EXIT`/`PI_SESSION` is missing from `pi_turn.py` output, or if `COMPILE_PASS`, `PINS_PASS`, or
  `GATE_EXIT` is missing from evidence output.
- Bare `arduino-cli` is not on Brain1's non-login PATH. The binary is at
  `~/.local/bin/arduino-cli`; the compile tool finds it there. Do not report a missing CLI
  when a bare bash call fails, and do not substitute a different library after `COMPILE: FAIL`.
- For `pincheck`, the project root is the work dir: omit `path` or use `path: "."`, with
  `sketch: firmware/firmware.ino`. `path: "firmware"` is wrong. A successful `compile` call also runs
  the pin check and emits `PINS: PASS/FAIL` in the same tool output.
- `session_evidence.py` is only the I7a compile/PINS evidence gate. I7b's gate is direct
  `python3 app.py input.txt` on Brain1. Never use `session_evidence.py` for I7b, never scp artifacts
  to Skynet, and never run either task's canonical gate on Skynet.
- Do not start I7b until the I7a gate is PASS and `attempts.md` is written. Never reuse work dirs or
  session ids.

Run Tier 0 once before I7a; stop if any expected line is not green:

```bash
ssh <user>@<brain1-host> 'set -euo pipefail
cd ~/projects/local-ai-stack
./tests/shim/run-checks.sh | tail -1
./tests/extensions/run-checks.sh | tail -1
./tests/tools/run-checks.sh | tail -1
./tests/measurement/run-checks.sh | tail -1
(cd grader && .venv/bin/python spec_cw_filter.py cw_filter.py | tail -1)
'
```

## I7a — MCU firmware task

Fresh work dir on Brain1: `~/local-results/i7-mcu/work`.

Prepare it and generate the board sheet before prompting Pi:

```bash
ssh <user>@<brain1-host> 'set -euo pipefail
WORK=~/local-results/i7-mcu/work
PY=~/projects/local-ai-stack/grader/.venv/bin/python
rm -rf "$WORK"
mkdir -p "$WORK/devices"
cd ~/projects/local-ai-stack
"$PY" tools/board_sheet.py --board wemos-d1-mini \
  --out "$WORK/devices/wemos-d1-mini.txt"
grep -qx "FQBN: esp8266:esp8266:d1_mini" "$WORK/devices/wemos-d1-mini.txt"
grep -q "^PINS (" "$WORK/devices/wemos-d1-mini.txt"
set -- "$WORK"/devices/*.txt
test "$#" -eq 1
test "$1" = "$WORK/devices/wemos-d1-mini.txt"
wc -l "$WORK/devices/wemos-d1-mini.txt"
cat > "$WORK/prompt.txt" <<"EOF"
Write a Wemos D1 Mini sketch in this directory that reads a DHT11 on D2, blinks the D4 LED every 2
seconds, and prints NaN-safe readings to serial. Use the compile and pins tools. Iterate until
compile succeeds and PINS: PASS. Do not use GPIO6-11. Write the final sketch to firmware.ino.
EOF
wc -l "$WORK/prompt.txt"
'
```

Frozen prompt to Brain1 Pi:

```text
Write a Wemos D1 Mini sketch in this directory that reads a DHT11 on D2, blinks the D4 LED every 2
seconds, and prints NaN-safe readings to serial. Use the compile and pins tools. Iterate until
compile succeeds and PINS: PASS. Do not use GPIO6-11. Write the final sketch to firmware.ino.
```

External gate: compile exit 0 and Pi tool output contains `PINS: PASS`. The operator verifies both
from tool output, not from the model's claim. Capture stdout, stderr, and exit code:

```bash
ssh <user>@<brain1-host> 'set -uo pipefail
WORK=~/local-results/i7-mcu/work
EVIDENCE=~/projects/local-ai-stack/tests/i7/session_evidence.py
python3 "$EVIDENCE" --session-dir "$WORK/sessions" 2>&1 | tee "$WORK/gate.txt"
GATE_EXIT=${PIPESTATUS[0]}
echo "GATE_EXIT=$GATE_EXIT" | tee -a "$WORK/gate.txt"
exit "$GATE_EXIT"
'
```

Exit 0 means `COMPILE_PASS=true` and `PINS_PASS=true`. Max 3 attempts.

Retry prompt:

```text
The deterministic gate failed. Read the exact output below, fix firmware.ino, and write it again.
Do not change the task statement.

<exact failing gate output>
```

Build `retry.txt` from the frozen retry prompt above plus the exact contents of `gate.txt`; do not
retype, summarize, or soften the gate output. Re-verify the single canonical board sheet before the
resumed turn:

```bash
ssh <user>@<brain1-host> 'set -euo pipefail
WORK=~/local-results/i7-mcu/work
PI_TURN=~/projects/local-ai-stack/tests/i7/pi_turn.py
{
  printf "%s\n" "The deterministic gate failed. Read the exact output below, fix firmware.ino, and write it again."
  printf "%s\n\n" "Do not change the task statement."
  cat "$WORK/gate.txt"
} > "$WORK/retry.txt"
rm -f "$WORK/devices/board.txt"
set -- "$WORK"/devices/*.txt
test "$#" -eq 1
test "$1" = "$WORK/devices/wemos-d1-mini.txt"
python3 "$PI_TURN" --work "$WORK" --prompt-file "$WORK/retry.txt" \
  --session-id i7a --resume
'
```

## I7b — basic Linux app

Do not start I7b until I7a's gate exited 0 and `attempts.md` is written.

Fresh work dir on Brain1: `~/local-results/i7-linux/work`.

Prepare it before prompting Pi:

```bash
ssh <user>@<brain1-host> 'set -euo pipefail
WORK=~/local-results/i7-linux/work
rm -rf "$WORK"
mkdir -p "$WORK"
cat > "$WORK/prompt.txt" <<"EOF"
Write app.py using only the Python standard library. CLI: app.py FILE reads one integer per line and
prints exactly: count=N min=N max=N mean=N.N where mean is one decimal. Add --help. Do not print
anything else on stdout for the normal path.
EOF
test -s "$WORK/prompt.txt"
wc -l "$WORK/prompt.txt"
'
```

Frozen prompt to Brain1 Pi:

```text
Write app.py using only the Python standard library. CLI: app.py FILE reads one integer per line and
prints exactly: count=N min=N max=N mean=N.N where mean is one decimal. Add --help. Do not print
anything else on stdout for the normal path.
```

External gate on Brain1: stdout must be exactly `count=3 min=18 max=22 mean=20.0`. Capture stdout,
stderr, and exit code:

```bash
ssh <user>@<brain1-host> 'set -uo pipefail
WORK=~/local-results/i7-linux/work
{
  cd "$WORK"
  printf "20\n22\n18\n" > input.txt
  python3 app.py input.txt
} 2>&1 | tee "$WORK/gate.txt"
GATE_EXIT=${PIPESTATUS[0]}
echo "GATE_EXIT=$GATE_EXIT" | tee -a "$WORK/gate.txt"
if [ "$GATE_EXIT" -ne 0 ]; then exit "$GATE_EXIT"; fi
test "$(head -n 1 "$WORK/gate.txt")" = "count=3 min=18 max=22 mean=20.0"
test "$(wc -l < "$WORK/gate.txt")" -eq 2
'
```

Max 3 attempts. Retry prompt is the same as I7a with the exact gate output substituted.

## Attempt log

For each task, create `$WORK/attempts.md` after attempt 1 and update it after every attempt, before
any retry. Gate names come from `gate.txt`; never from the model's claim. If the failure is
harness/environment (missing helper output, missing canonical board sheet, failed prep command, SSH
error), record `harness:<name>` and stop instead of asking Pi to fix it.

```text
task: I7a
model: ollama/gemma4:e4b-it-qat
host: brain1

attempt 1: FAIL — <failing gate names>
fix: <one-line model fix>
attempt 2: PASS — <gate evidence>
attempts-to-green: 2
```

## Report back

Return only:

- task ID
- final gate result
- attempts-to-green
- failing gate names per attempt
- final artifact path, sanitized to `~/local-results/...`
- one sentence classifying failure as model output, harness, or environment

Write `attempts.md` before returning the report, including on a first-attempt PASS. The report is not
complete until that file exists. Do not paste raw transcripts.
