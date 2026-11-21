---
description: No-code discovery dialogue that writes BRIEF.md and a ready /plan command
argument-hint: "<domain> [topic]"
---
You are in RESEARCH MODE. The only file you may write is BRIEF.md.

Arguments: `$1` = domain id, `${@:2}` = topic/task seed.

CRITICAL TOOL RULE: Pi's `read` tool does not expand `$HOME`. Never pass a path
containing `$HOME` to `read`. Use `bash` for reads.

## Step A — validate domain (required before anything else)
Run with `bash`:
`if [ -z "${1:-}" ]; then echo 'ERR: missing domain'; ls "$HOME/.pi/agent/domains"; else if [ -f "$HOME/.pi/agent/domains/$1.md" ]; then echo "DOMAIN_OK=$1"; else echo "ERR: unknown domain '$1'"; ls "$HOME/.pi/agent/domains"; fi; fi`

- If output shows `ERR: missing domain` or `ERR: unknown domain`: stop and ask the user to run `/research <domain> <topic>` using one of the listed domains. Do not write BRIEF.md.
- If output shows `DOMAIN_OK=...`: continue.

## Step B — read context
Run with `bash`:
`cat "$HOME/.pi/agent/domains/$1.md"`

Run with `bash`:
`if [ -f BRIEF.md ]; then echo '---BRIEF---'; cat BRIEF.md; else echo NO_BRIEF; fi`

- If `NO_BRIEF` and `${@:2}` is empty: ask the user for a topic and stop. Do not write BRIEF.md.
- If `BRIEF.md` exists: continue from its `OPEN_QUESTIONS` (do not restart). Keep `DOMAIN:` consistent with `$1` unless correcting an obvious mismatch.
- Topic/context: use `${@:2}` if provided; otherwise use existing BRIEF content.

## Rules
- Do not write code, install packages, run PREFLIGHT, create venvs, or edit files other than BRIEF.md.
- Do not call `edit`. Use only `bash` to read context and `write(path="BRIEF.md", content=...)` to save BRIEF.md.
- Ask exactly one question per turn. End non-ready turns with `QUESTION: ...`
- After each user answer, update BRIEF.md with the new decision and next question.
- Do not invent facts. Mark unconfirmed items `UNVERIFIED`.
- Keep prose concise.

## BRIEF.md format (exact section headers, in order)
TOPIC:
DOMAIN: $1
CONSTRAINTS:
ASSUMPTIONS:
OPTIONS:
DECISIONS:
OPEN_QUESTIONS:
ACCEPTANCE_CRITERIA:
READY_PLAN_PROMPT:
READY_COMMAND:

`READY_PLAN_PROMPT` must be one concrete task string containing platform, I/O, behavior, UI/controls, constraints, and acceptance criteria (no extra wrapping quotes on that line).
`READY_COMMAND` must be exactly:
`/plan $1 "<READY_PLAN_PROMPT>"`

## Completion
- When `OPEN_QUESTIONS` is empty: `write` the final BRIEF.md, then reply with exactly:
  `READY: /plan $1 "<READY_PLAN_PROMPT>"`
- Do not ask more questions once READY.

## Tool sequence per turn
1. `bash` domain validation (Step A) if not already confirmed this turn/session context is unclear.
2. `bash` read domain file.
3. `bash` read BRIEF.md or print NO_BRIEF.
4. `write(path="BRIEF.md", content=<complete updated brief>)` when there is enough info to create/update it.
Do not call `write` without `path`. A validation error is not success.
