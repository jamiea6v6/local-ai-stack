# tests/ — the measurement instrument

`LOCAL_AGENT_TEST_SUITE.md` here is a **snapshot** of the copy in the doc store
(`~/.config/opencode/homelab/LOCAL_AGENT_TEST_SUITE.md`, sha256 `00dabf48477e904c…` as of
2026-11-14). The original says "Preserve this file" — so this copy is left byte-identical rather than
edited, and these notes live here instead.

## What it is

Seven tests (A–F, plus one added 2026-10-19), each with a verbatim prompt, **fixed ground truth
written before the run**, a deterministic measurement method (grep counts, not eyeballing), and
PASS/FAIL criteria defined in advance. That is what makes a reliability claim falsifiable.

## What is stale in this snapshot

| Stale | Why it matters |
|---|---|
| References `pi-scratch/.claude/agents/pi-pi.yaml` as the harness | the harness is now Pi 1.1.0 with the 9 extensions in `../harness/extensions/` |
| References ollama configs `brain1-p106.json` / `brain1-p106-8bit.json` on port 3001 | the live config is `../harness/models.json` → the shim on **:11435** |
| The "SECTION DEPTH matcher bug" it flags as broken on the brain1 copy | fixed — `gate.py` now passes 8/8 |

## Current suite

`REFRESHED_SUITE.md` carries the same prompts, ground truth and PASS/FAIL criteria with current
harness references. `suite.json` is the machine-readable form used by the runner, and
`fixtures/` holds the circuit oracle plus its known-good and seeded-broken candidates.

`measurement/run-baseline.mjs` runs each fresh session in its own PTY and session directory, grades
the artifacts externally, and writes a sanitized JSON report. CW sessions get grader feedback on
failure (bounded by `--max-cw-retries`, default 3) so a failure can be repaired instead of only
recorded. Tests A–E report heuristic keyword/tool-count verdicts; the human-readable criteria in
`REFRESHED_SUITE.md` remain the authority for interpretation.

```bash
./tests/measurement/run-checks.sh
./tests/measurement/run-baseline.sh --host-role p106
./tests/measurement/run-baseline.sh --cw-only --cw-runs 1 --host-role smoke
```

Do not edit a prompt after seeing a result. Add a new test instead.

## End-of-week number

- Tests A–F, 3 repeats each → per-test pass rate
- 5 fresh CW development sessions → each graded by `spec_cw_filter.py` (11/11), no ungraded run,
  no empty final answer
- Gate: the suite's own PASS/FAIL lines, not a judgement call
