# I6 baseline findings — 2026-11-17

Host role: `p106`. Model: `gemma4:e4b-it-qat`. Suite version:
`2026-11-17-refresh`. The full raw report and session transcripts remain on the
measurement host under `tests/results/` (ignored by git) because they contain
model-generated paths and example addresses.

## Gate result

The I6 gate is **not met**. The measurement instrument works; the measured
baseline does not.

| Part | Result |
|---|---|
| Suite A–F | 6/18 heuristic passes |
| CW sessions graded 11/11 | 0/5 |
| CW complete | 5/5 sessions, 4 attempts each |
| Offline instrument gate | 11/11 |
| Fresh clone gates | shim/extensions/tools/manifest green |

## Suite detail

| Test | Passed | Dominant failure |
|---|---|---|
| A | 0/3 | fewer than two fetches; missing explicit No/VRAM; driver red herring used as reasoning |
| B | 3/3 | all nine turns completed with non-empty finals |
| C | 0/3 | circuit oracle never reached 21/21 |
| D | 1/3 | isenthalpic-throttling or liquid-slug rationale absent |
| E | 2/3 | one run failed to frame "best" as subjective |
| F | 0/3 | LCD/DHT pin extraction, pull-up note, or delay/NaN heuristics failed |

## CW detail

Attempt scores (out of 11): `[3,3,3,3]`, `[7,7,8,9]`, `[3,3,3,3]`, `[3,3,2,2]`,
`[3,2,2,2]`.

Failure classes across the five sessions: a non-PyAudio library was chosen; no
single input/output stream emitted filtered audio; CLI arguments were ignored;
the default band and rejection targets were missed; and filter state or output
level failed. Grader-feedback retries moved some runs (best 9/11) but never
reached 11/11.

## Decision

Prompts, ground truth and PASS/FAIL criteria were not changed after seeing the
results. I6 remains `blocked`: the runner and baseline exist, but the 5/5 CW
gate is unmet. Any hardening of the harness or feedback loop must be a new,
pre-registered iteration rather than an edit to this measurement.
