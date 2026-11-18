# Local-operator runbook — Skynet Opencode / GPT-OSS operator, Brain1 Pi subject

Purpose: move token-heavy orchestration to Skynet's local Opencode/GPT-OSS session while the cloud
session keeps the important work. The model under test is whatever Pi on Brain1 is configured to use.

## Roles

- **Skynet Opencode/GPT-OSS:20b** is the **operator**. It reads this file, runs shell commands,
  launches the runner on Brain1, collects reports, and writes a short summary.
- **Brain1 Pi** is the **subject**. It runs the prompts and gets its local model/harness rated.
- The runner's `--model` flag selects the **subject** model. With this setup, **omit `--model`** so
  the suite default (`ollama/gemma4:e4b-it-qat`) is used on Brain1.
- Do **not** pass `ollama/gpt-oss:20b` to the Pi runner on Brain1. GPT-OSS runs the operator session
  on Skynet; it is not installed on Brain1 and would not fit Brain1's 6 GB card.
- If you want to rate GPT-OSS itself, that is a separate experiment: run Pi on Skynet with a Pi model
  config entry for `gpt-oss:20b`. Do not mix that with the Brain1 run.

## Rules

Do not edit `tests/suite.json`, `tests/REFRESHED_SUITE.md`, prompts, ground truth, or PASS/FAIL
criteria. Do not run the full baseline unless explicitly asked. Keep raw sessions and reports under
`tests/results/` (gitignored) or `~/local-results/`. Report only sanitized summaries: no home paths,
LAN IPs, secrets, or raw transcripts.

## Preflight — do this first

On Skynet (operator):

```bash
hostname
ollama ls | grep -i gpt-oss
grep -n 'gpt-oss' ~/.config/opencode/opencode.jsonc | head -5
```

On Brain1 (subject), from Skynet:

```bash
export BRAIN1=jamie@<brain1-host>
ssh "$BRAIN1" 'cd ~/projects/local-ai-stack && git rev-parse HEAD && grep -n id ~/.pi/agent/models.json'
```

If the operator cannot reach Brain1, stop and ask. Do not switch the subject to Skynet silently.

## Tier 0 — deterministic gates, no model tokens

Run on Brain1:

```bash
ssh "$BRAIN1" 'cd ~/projects/local-ai-stack && \
  ./tests/shim/run-checks.sh | tail -1 && \
  ./tests/extensions/run-checks.sh | tail -1 && \
  ./tests/tools/run-checks.sh | tail -1 && \
  ./tests/measurement/run-checks.sh | tail -1 && \
  (cd grader && .venv/bin/python spec_cw_filter.py cw_filter.py | tail -1)'
```

Expected: shim/extensions/tools/measurement green; grader `11/11 checks passed`. If any fail, stop —
the problem is the harness, not the model.

## Tier 1 — cheapest real signal: one CW prompt, one grader run

Run on Brain1 with its configured Pi model:

```bash
ssh "$BRAIN1" 'cd ~/projects/local-ai-stack && mkdir -p ~/local-results && \
  ./tests/measurement/run-baseline.sh \
    --cw-only --cw-runs 1 --repeats 0 \
    --max-cw-retries 0 \
    --host-role brain1-pi-tier1 \
    --timeout-ms 600000 \
    --work-root ~/local-results/i6-brain1-tier1 \
    --out ~/local-results/i6-brain1-tier1-report.json'
scp "$BRAIN1":~/local-results/i6-brain1-tier1-report.json ~/local-results/ 2>/dev/null || true
```

This is one Pi prompt plus one deterministic grade. It answers: does Brain1's configured model produce
a CW program that grades 11/11 without feedback? It is not the I6 baseline (which required 5 CW runs).

## Tier 2 — one CW run with grader feedback

```bash
ssh "$BRAIN1" 'cd ~/projects/local-ai-stack && \
  ./tests/measurement/run-baseline.sh \
    --cw-only --cw-runs 1 --repeats 0 \
    --max-cw-retries 2 \
    --host-role brain1-pi-tier2 \
    --timeout-ms 600000 \
    --work-root ~/local-results/i6-brain1-tier2 \
    --out ~/local-results/i6-brain1-tier2-report.json'
```

This measures loop-assisted repair on Brain1. Report it as a separate experiment; do not change the
baseline result.

## Tier 3 — suite A–F once, no repeats

```bash
ssh "$BRAIN1" 'cd ~/projects/local-ai-stack && \
  ./tests/measurement/run-baseline.sh \
    --suite-only --repeats 1 --cw-runs 0 \
    --max-cw-retries 0 \
    --host-role brain1-pi-suite1 \
    --timeout-ms 600000 \
    --work-root ~/local-results/i6-brain1-suite1 \
    --out ~/local-results/i6-brain1-suite1-report.json'
```

Six Pi prompts total. Use this after Tier 1/2 if you want a cheap profile of which capability classes
hold up on Brain1.

## Do not run unless asked: full I6 baseline

```bash
ssh "$BRAIN1" 'cd ~/projects/local-ai-stack && \
  ./tests/measurement/run-baseline.sh \
    --repeats 3 --cw-runs 5 --max-cw-retries 3 \
    --host-role brain1-pi-full \
    --timeout-ms 1200000 \
    --work-root ~/local-results/i6-brain1-full \
    --out ~/local-results/i6-brain1-full-report.json'
```

That is 18 suite sessions plus up to 20 CW turns. It is a benchmark, not a development loop.

## Report back

From the report JSON, paste only:

1. `report.summary` (one line) and `report.model` (confirms the subject model).
2. For CW: score per attempt and the exact failing check names.
3. For suite A–F: pass count per test.
4. One short sentence on whether the failure was model output, harness, or environment.
5. Report path, sanitized to `~/local-results/...`.

## Paste this into Skynet Opencode / GPT-OSS

```text
Read docs/LOCAL_MODEL_RUNBOOK.md. You are the operator on Skynet; Brain1 Pi is the subject. Run Tier 0,
then Tier 1 only, on Brain1. Do not pass --model ollama/gpt-oss:20b to the Pi runner; omit --model so
Brain1's configured model is rated. Do not edit prompts, ground truth, PASS/FAIL criteria, or
tests/suite.json. Do not run the full baseline. Write outputs under ~/local-results/ on Brain1 and
report only the fields in the "Report back" section.
```

## I7 on the same operator/subject split

I7 can use this pattern, but it needs its own fresh work dirs and external gates. Do not fold it into
the I6 report. Skynet Opencode still operates; Brain1 Pi is still the subject.

### I7a — MCU firmware task

Fresh cwd on Brain1: `~/local-results/i7-mcu/work`. Prompt to Brain1 Pi:

```text
Write a D1 mini sketch in this directory that reads a DHT11 on D2, blinks the D4 LED every 2 seconds,
and prints NaN-safe readings to serial. Use the compile and pins tools. Iterate until compile succeeds
and PINS: PASS. Do not use GPIO6-11. Write the final sketch to firmware.ino.
```

External gate: compile exit 0 and tool output contains `PINS: PASS`. Cap at 3 iterations. Log
attempts-to-green as `attempt N: failing gate -> fix`.

### I7b — basic Linux app

Fresh cwd on Brain1: `~/local-results/i7-linux/work`. Prompt to Brain1 Pi:

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

Cap at 3 iterations. Log attempts-to-green the same way. Report the two gate results and the attempt
counts, not the full transcripts.
