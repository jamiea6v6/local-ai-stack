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

## I7a — MCU firmware task

Fresh work dir on Brain1: `~/local-results/i7-mcu/work`.

Before prompting Pi, generate the board sheet in that work dir:

```bash
cd ~/projects/local-ai-stack
python3 tools/board_sheet.py --board wemos-d1-mini \
  --out ~/local-results/i7-mcu/work/devices/wemos-d1-mini.txt
```

Frozen prompt to Brain1 Pi:

```text
Write a Wemos D1 Mini sketch in this directory that reads a DHT11 on D2, blinks the D4 LED every 2
seconds, and prints NaN-safe readings to serial. Use the compile and pins tools. Iterate until
compile succeeds and PINS: PASS. Do not use GPIO6-11. Write the final sketch to firmware.ino.
```

External gate: compile exit 0 and Pi tool output contains `PINS: PASS`. The operator verifies both
from tool output, not from the model's claim. Max 3 attempts.

Retry prompt:

```text
The deterministic gate failed. Read the exact output below, fix firmware.ino, and write it again.
Do not change the task statement.

<exact failing gate output>
```

## I7b — basic Linux app

Fresh work dir on Brain1: `~/local-results/i7-linux/work`.

Frozen prompt to Brain1 Pi:

```text
Write app.py using only the Python standard library. CLI: app.py FILE reads one integer per line and
prints exactly: count=N min=N max=N mean=N.N where mean is one decimal. Add --help. Do not print
anything else on stdout for the normal path.
```

External gate on Brain1:

```bash
printf '20\n22\n18\n' > input.txt
python3 app.py input.txt
# expected exactly: count=3 min=18 max=22 mean=20.0
```

Max 3 attempts. Retry prompt is the same as I7a with the exact gate output substituted.

## Attempt log

For each task, maintain `attempts.md` beside the work dir:

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

Do not paste raw transcripts.
