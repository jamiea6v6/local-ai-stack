---
description: Gather evidence and write PLAN.md only; no implementation
argument-hint: "<domain> [task description]"
---
You are in a project directory. The only deliverable of this command is PLAN.md.

Arguments: `$1` = domain id, `${@:2}` = task (optional if BRIEF.md provides it).

CRITICAL TOOL RULE: Pi's `read` tool does not expand `$HOME`. Never pass a path
containing `$HOME` to `read`. Use `bash` for reads.

## Step 1 — resolve domain
Run with `bash`:
`if [ -z "${1:-}" ]; then echo 'ERR: missing domain'; ls "$HOME/.pi/agent/domains"; else if [ -f "$HOME/.pi/agent/domains/$1.md" ]; then echo "DOMAIN_OK=$1"; cat "$HOME/.pi/agent/domains/$1.md"; else echo "ERR: unknown domain '$1'"; ls "$HOME/.pi/agent/domains"; fi; fi`

- If output shows `ERR: missing domain` or `ERR: unknown domain`: stop and ask for `/plan <domain> "<task>"` using one of the listed domains. Do not run PREFLIGHT or write PLAN.md.
- If the user passed a long task sentence as `$1` (not a domain file), treat it as unknown domain and ask for the correct domain + quoted task.
- If `DOMAIN_OK=...`: continue using that domain file for evidence/gate rules (task text overrides example requirements/steps). Never repeat a failed `bash` call.

## Step 2 — resolve task (before PREFLIGHT)
Run with `bash`:
`if [ -f BRIEF.md ]; then echo '---BRIEF---'; cat BRIEF.md; else echo NO_BRIEF; fi`

Determine the task string:
- If `${@:2}` is non-empty: use it as the task.
- Else if BRIEF.md has a non-empty `READY_PLAN_PROMPT:`: use that value.
- Else: reply `TASK missing; supply a quoted task or run /research first.` and stop. **Do not run PREFLIGHT and do not write PLAN.md.**

BRIEF.md is context, not EVIDENCE. Use its CONSTRAINTS/DECISIONS/ACCEPTANCE_CRITERIA/OPEN_QUESTIONS to shape GOAL, STEPS, GATES, QUESTIONS.

## Step 3 — gather evidence (PREFLIGHT)
Run the domain file's PREFLIGHT block with `bash`, exactly as written, as one command. Run it exactly once.
- If it succeeds, do not run PREFLIGHT again.
- Do not summarize before writing PLAN.md. Do not write PLAN.md until raw PREFLIGHT output is in the conversation.
- If PREFLIGHT fails, paste the exact error under EVIDENCE and continue.

Use `bash` for fact commands as needed. Paste commands and raw output into EVIDENCE. Write `(no output)` when a command prints nothing. Do not invent output.

## Rules
- Do not write code, install packages, create venvs, flash hardware, or edit files other than PLAN.md.
- Do not start implementation. Do not write DESIGN.md.

## PLAN.md format (exact top-level sections, in order; first line must be `GOAL:`)
All sections required, including `GATES:` and `APPROVED: none`. If long, shorten prose/evidence but never omit a section.
`DOMAIN:` and every `GATE <n>:` value must be machine-readable (no trailing period/comma/semicolon/explanation).

GOAL: <resolved task string>
DOMAIN: $1
EVIDENCE: paste PREFLIGHT raw tool result verbatim inside a fenced block (do not renumber/rename/summarize/merge/reword). Add other command+output evidence if used.
FACTS: only facts directly supported by EVIDENCE, with evidence refs.
QUESTIONS: unresolved facts; write `QUESTION: ...` for each (include unresolved OPEN_QUESTIONS from BRIEF.md).
STEPS: numbered implementation steps, each with `FILES:` and `GATE <n>:`.
GATES: copy every `GATE <n>:` line from STEPS verbatim. Never use `compile()` for Python. Use an exact bash command runnable from project dir, or `verify(project=".")` only when gates.json exists. Gate must produce PASS/FAIL from a real tool.
APPROVED: none

## Tool sequence (mandatory)
1. `bash` Step 1 (domain resolve/cat)
2. `bash` Step 2 (read BRIEF/resolve task) — stop here if task missing
3. `bash` Step 3 (PREFLIGHT once)
4. `write(path="PLAN.md", content=<complete plan text>)`
No other tool call between step 3 and step 4. If `write` fails validation because `path` is missing, retry once with both args.

## Stop conditions
- If PREFLIGHT was not run (when required), reply `PREFLIGHT missing; stopped.`
- If you do not call `write`, reply `WRITE missing; stopped.` A validation error is not success.
- After successful `write` tool result, stop with exactly: `Plan written; waiting for approval.`
