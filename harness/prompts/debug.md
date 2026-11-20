---
description: Write DEBUG.md with env/project snapshot and optionally run a command to capture runtime errors
argument-hint: "[run <command>]"
---
Run exactly this with `bash`:
`"$HOME/.pi/agent/bin/debug.sh" $ARGUMENTS`

Rules:
- Do not call `write` or `edit`. Do not invent errors or command output.
- Reply only with the command's stdout.
- If no command was run, remind the user they can use `/debug run <command>` to attempt a timeout-limited, non-interactive capture of startup/runtime errors.
