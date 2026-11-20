---
description: Gather evidence and write PLAN.md only; no implementation
argument-hint: "<domain> [task description]"
---
You are in a project directory. The only deliverable of this command is PLAN.md.

Arguments: `$1` is the domain id; `${@:2}` is the task when supplied. If `$1` is
empty, run `ls "$HOME/.pi/agent/domains"` and stop; ask for
`/plan <domain> [task]`.

CRITICAL TOOL RULE: Pi's `read` tool does not expand `$HOME`. Never pass a path
containing `$HOME` to `read`. Use `bash` for all reads.

Step 1 — run this with `bash`:
`cat "$HOME/.pi/agent/domains/$1.md"`

Pi has already substituted `$1`, so the command must name a real file. If it
fails, run `ls "$HOME/.pi/agent/domains"` and stop. Use that domain file for
evidence and gate rules; the task text overrides its example requirements and
suggested steps. Never repeat a failed `bash` call.

Step 1b — run this with `bash`:
`if [ -f BRIEF.md ]; then cat BRIEF.md; else echo NO_BRIEF; fi`

BRIEF.md is context, not EVIDENCE. If it exists, use its CONSTRAINTS, DECISIONS,
ACCEPTANCE_CRITERIA, and OPEN_QUESTIONS to shape GOAL, STEPS, GATES, and
QUESTIONS. If no task was supplied and BRIEF.md has READY_PLAN_PROMPT, run:
`awk -F': ' '/^READY_PLAN_PROMPT:/ {sub(/^READY_PLAN_PROMPT: /, ""); print; exit}' BRIEF.md`
Use that output as the task. If it is empty or BRIEF.md is missing, reply
`TASK missing; supply a quoted task or run /research first.` and stop.

Step 2 — before writing anything, run the domain file's PREFLIGHT block with
`bash`, exactly as written, as one command. Run it exactly once. If it succeeds,
do not run PREFLIGHT again. Do not summarize it first. Do not write PLAN.md until
its raw output is in the conversation. If PREFLIGHT fails, paste the exact error
under EVIDENCE and continue.

Use `bash` for all fact commands. Paste each command and its raw output into
PLAN.md under EVIDENCE. Write `(no output)` when a command prints nothing.
Do not invent output.

Do not write code, install packages, create venvs, flash hardware, or edit files
other than PLAN.md. Do not start implementation. Do not write DESIGN.md.

Write PLAN.md with exactly these top-level sections, in this order.
The first line of the file must be `GOAL:`. Do not emit a preamble. Emit
exactly one `DOMAIN:` line, in its listed position. All eight sections,
including `GATES:` and `APPROVED: none`, are required. If the plan is too
long, shorten prose and evidence; never omit a required section.
VALUE RULE: `DOMAIN:` and every `GATE <n>:` value must be machine-readable.
Do not append periods, commas, semicolons, or explanatory words to those values.
If no task was supplied, the GOAL line must contain the READY_PLAN_PROMPT value
from BRIEF.md. Never write instruction words such as "one paragraph from".

GOAL: ${@:2}
DOMAIN: `$1`
EVIDENCE: paste the PREFLIGHT tool result verbatim inside a fenced block.
Do not renumber, rename, summarize, merge, or reword any PREFLIGHT line.
FACTS: only facts directly supported by EVIDENCE, with evidence numbers.
QUESTIONS: facts not established; write `QUESTION: ...` for each. Include
  unresolved OPEN_QUESTIONS from BRIEF.md.
STEPS: numbered implementation steps, each with `FILES:` and `GATE <n>:`.
GATES: copy every `GATE <n>:` line from STEPS verbatim into this section. Never
  use `compile()` for Python work. Use an exact bash command runnable from the
  project directory, or `verify(project=".")` only when gates.json exists.
  A gate must produce PASS/FAIL from a real tool. Put the exact command after
  `GATE <n>:` with no trailing punctuation.
APPROVED: none

TOOL SEQUENCE IS MANDATORY:
1. `bash` to cat the domain file.
2. `bash` to read BRIEF.md or print NO_BRIEF.
3. `bash` to run PREFLIGHT exactly once.
4. `write(path="PLAN.md", content=<complete plan text>)`. Both arguments are
   required. A `write` call without `path` is invalid.
No other tool call is allowed between step 3 and step 4. If `write` fails
validation because `path` is missing, retry once with both `path` and
`content`. After a successful `write` tool result, stop. Do not call `bash`
again.

If PREFLIGHT was not run, reply `PREFLIGHT missing; stopped.` If you do not call
`write`, you have not completed the task: reply `WRITE missing; stopped.` A
validation error is not success; do not say `Plan written` after an error.

Only after the `write` tool result, stop with exactly:
`Plan written; waiting for approval.`
