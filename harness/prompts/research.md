---
description: No-code discovery dialogue that writes BRIEF.md and a ready /plan command
argument-hint: "<domain> [topic]"
---
You are in RESEARCH MODE. The only file you may write is BRIEF.md.

Arguments: `$1` is the domain id; `${@:2}` is the topic. If `$1` is empty, run
`ls "$HOME/.pi/agent/domains"` and stop; ask for `/research <domain> <topic>`.

CRITICAL TOOL RULE: Pi's `read` tool does not expand `$HOME`. Never pass a path
containing `$HOME` to `read`. Use `bash` for these reads.

Step 1 — run this with `bash`:
`cat "$HOME/.pi/agent/domains/$1.md"`

Step 2 — run this with `bash`:
`if [ -f BRIEF.md ]; then cat BRIEF.md; else echo NO_BRIEF; fi`

If NO_BRIEF and the topic is empty, ask for a topic and stop. If BRIEF.md exists,
continue from its OPEN_QUESTIONS; do not restart from scratch.

Rules:
- Do not write code, install packages, run PREFLIGHT, create venvs, or edit files.
- Do not call `edit`. Use only `bash` to read context and `write` to save BRIEF.md.
- Ask exactly one question per turn. End the turn with `QUESTION: ...`.
- After each user answer, update BRIEF.md with the new decision and the next question.
- Do not invent facts. Mark unconfirmed items `UNVERIFIED`.
- Keep prose concise.

BRIEF.md sections, in this order:
TOPIC:
DOMAIN:
CONSTRAINTS:
ASSUMPTIONS:
OPTIONS:
DECISIONS:
OPEN_QUESTIONS:
ACCEPTANCE_CRITERIA:
READY_PLAN_PROMPT:
READY_COMMAND:

READY_PLAN_PROMPT must be one task string containing the platform, I/O, DSP
behavior, UI controls, constraints, and acceptance criteria. Do not wrap it in
extra quotes on the READY_PLAN_PROMPT line. READY_COMMAND must be:
`/plan $1 "<READY_PLAN_PROMPT>"`

When OPEN_QUESTIONS is empty, write BRIEF.md and reply:
`READY: copy READY_COMMAND into pi`
Do not ask more questions once READY.

Tool sequence for every turn:
1. `bash` to read the domain file.
2. `bash` to read BRIEF.md or print NO_BRIEF.
3. `write(path="BRIEF.md", content=<complete updated brief>)`.
Do not call `write` without `path`. A validation error is not success.
