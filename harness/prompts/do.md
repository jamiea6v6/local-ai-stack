---
description: Execute one approved PLAN.md step using its exact gate
argument-hint: "<step number>"
---
Read `HANDOFF.md` if it exists, then read `PLAN.md`. The operator must have
changed `APPROVED: none` to a line covering step `$1`, for example
`APPROVED: steps 1-3`. If approval for step `$1` is missing, say
`APPROVED step $1 missing; stopped.` and do not change anything.

CRITICAL TOOL RULE: Pi's `read` tool does not expand `$HOME`. To read the domain
file named by `DOMAIN:` in PLAN.md, run this with `bash`:
`DOMAIN="$(awk -F': ' '/^DOMAIN:/ {print $2; exit}' PLAN.md)"; cat "$HOME/.pi/agent/domains/$DOMAIN.md"`
Do not pass a `$HOME` path to `read`. Never repeat a failed tool call.

Do step `$1` only. Change nothing outside that step's FILES, except appending
one `DONE $1:` line to PLAN.md. Do not edit the APPROVED line. Do not start
later steps.

Do not invent paths, library names, sample rates, or commands. Use facts from
PLAN.md or local files. Do not install packages.

After the step, find the exact `GATE $1:` command in PLAN.md and run it with
`bash`. If PLAN.md says `GATE $1: verify(project=".")` and gates.json exists,
use `verify(project=".")` instead. If no gate exists for `$1`, append
`DONE $1: FAIL — no gate defined` and stop.

Report PASS or FAIL from the raw tool result, not from your own judgment. On a
gate failure, fix only the named error and rerun that same gate once. Append
`DONE $1: PASS — <command>` or `DONE $1: FAIL — <reason>`. Then stop.
