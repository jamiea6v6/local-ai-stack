# DECK — what the local-agent work actually proved

## The claim

A 6 GB quantised local model can drive a useful coding agent **if the harness never asks the model to
judge its own output**. A separate process decides pass/fail; the model only reads the failure and
fixes the named artifact.

## The stack

- P106-100 (6 GB), Debian 13, Ollama on the Vulkan path.
- Pi 1.4.0 plus small extensions: lookup-first injection, write-to-file discipline, deterministic
  gates.
- An OpenAI-`/v1` shim because `/v1` ignores `num_ctx`; the shim translates to native `/api/chat`.

## I6 baseline — measured, not passed

| Measure | Result |
|---|---|
| Suite A–F | 6/18 heuristic passes |
| CW sessions graded 11/11 | 0/5 |
| CW sessions completed | 5/5, four attempts each |
| Best CW score | 9/11 |
| Offline instrument gate | 11/11 |
| Fresh-clone gates | green |

The instrument works; the measured baseline does not clear the bar. Prompts, ground truth and
PASS/FAIL criteria were not changed after seeing results. I6 remains `blocked` by design.

## I7 end-to-end local operator — passed

| Task | Result | Attempts-to-green |
|---|---|---|
| I7a — Wemos D1 Mini DHT11 firmware | `COMPILE_PASS=true`, `PINS_PASS=true`, `GATE_EXIT=0` | 1 |
| I7b — Python standard-library CLI | `count=3 min=18 max=22 mean=20.0`, `GATE_EXIT=0` | 1 |

Both artifacts were produced by the Brain1 Pi subject from natural prompts, with deterministic gates.
The operator sessions needed mechanics fixes first: executable helpers, a missing Arduino library, a
PATH quirk, and correct gate arguments. None of those changed the frozen prompts or criteria.

## What transfers

1. Mock the hardware, not the logic; a bad API contract then fails deterministically.
2. Keep harness instructions short — every line is paid for on every turn.
3. Search first, answer once; injecting the rule after the answer is too late.
4. Separate operator from subject so the model under test cannot rewrite its own gates.
5. Log attempts from gate output, never from the model's claim.

## Public repos

- `https://github.com/jamiea6v6/local-ai-stack.git`
- `https://github.com/jamiea6v6/brain1-stack.git`
- `https://github.com/jamiea6v6/mcu-domain.git`

Full build notes are in `docs/FRIEND-KIT.md`; the measurement detail is in
`tests/BASELINE_FINDINGS.md` and `docs/WORKPLAN.md`.
