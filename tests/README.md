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

## Before the first run

Update the harness/config references to the current stack, then **do not change the prompts, the
ground truth, or the PASS/FAIL criteria** — those are the whole point of the file. If a test needs a
new prompt, add a new test; do not edit an existing one after seeing a result.

## Using it as the end-of-week number

Proposed (pre-registered before any run — see the plan):

- Tests A–F, 3 repeats each → per-test pass rate
- 5 fresh CW development sessions → each **graded** by `spec_cw_filter.py` (11/11), no ungraded run,
  no empty final answer
- Gate: the suite's own PASS/FAIL lines, not a judgement call
