# Pi — local harness rules

Global context for every Pi session on this box. Kept short on purpose: the
context window is 32768 tokens (the shim requests it) and the baseline prompt
already costs ~4700.

## Pick a mode first

**Research** (no local facts on disk): `websearch`, then `webfetch` the most
relevant result, then answer once and cite the URL. Search first — do not draft
an answer and verify afterwards; this window is too small to hold both.

**Build from facts** (firmware, wiring, any task with a `devices/` folder):
every hardware fact — pin, bus, address, voltage, library, FQBN — comes from the
files under `devices/`. Read them first. Do **not** search the web for hardware
facts. If a fact is missing or says UNKNOWN, write `QUESTION: ...` and stop.
Never guess a pin, an I2C address, a board FQBN, or a library. A board label is
not a pin number: `D8` is GPIO0, so use the macro `D8` or `0`, never bare `8`.

This does NOT mean every line of code needs a source: look up the external
facts it depends on, then write the code yourself.

## Do not fetch PDFs

A PDF fetched as text decodes as binary garbage and can add ~20k tokens in one
turn (measured: one datasheet forced a compaction and the task never recovered).
`webfetch` now refuses them. If a fact exists only in a PDF, convert it once with
`pdftotext -layout file.pdf out.txt` and read `out.txt`, or ask for a text sheet.

## Write files, do not just describe them

Use `write` to create or replace a file, `edit` for an exact replacement. The
fields are exact — do not invent alternatives:

- `write(path, content)`
- `edit(path, oldString, newString)` — not `file_path`/`filePath`, and not an
  `edits` array. If an edit is rejected once, rewrite the whole file with `write`
  instead of retrying the schema.
- `read(path)`, `bash(command)`
- `verify(spec, candidate, project, python)`
- `compile(path, fqbn)`

If the request is to write or change a program, write it. A file can be checked;
a chat reply cannot.

## Compile firmware with `compile`

One live sketch per project, at `firmware/<name>/<name>.ino`. arduino-cli
requires the directory and file names to match; a flat `<name>.ino` fails with
"main file missing from sketch". `compile` applies that rule, moves a single
stray file into place, and reads the board from `devices/<board>.txt`
(`FQBN: esp8266:esp8266:d1`) or `BRIEF.md`.

```
compile(path=".", fqbn="esp8266:esp8266:d1")
```

If the project needs a board sheet, generate it instead of typing pins:
`@STACK_DIR@/tools/board_sheet.py --board wemos-d1 --out devices/wemos-d1.txt`
(it fills the FQBN too).

A green build also checks the pins against the sheet. `compile` reports
`PINS: PASS/FAIL/SKIP`; `pincheck` runs that check alone. Labels resolve through
the sheet, so `D8` becomes GPIO0; GPIO6-11 (ESP8266 flash) and any pin not on the
sheet fail. Projects with no board sheet or no sketch SKIP — that is normal.

Never answer "it should compile" — run it and fix the error the compiler names.

## Grade your own work with `verify`

Do not reason about whether your output is correct. Run it.

- `verify(project=".")` runs every gate in the project's `gates.json` (pins,
  libraries, compile, behavior) and reports PASS/FAIL per gate.
- `verify(spec="<spec>.py", candidate="<file>")` runs one python spec. Pass the
  file you just wrote, by relative path — never a reference implementation.
  If its imports live in a venv, pass `python="<venv>/bin/python3"` or set
  `PI_VERIFY_PYTHON`.

The CW audio spec is only for the CW task:
`verify(spec="@STACK_DIR@/grader/spec_cw_filter.py", candidate="cw_filter.py")`.
`@STACK_DIR@/grader/cw_filter.py` is the known-good reference (11/11) — do not
copy or submit it.

## Machine facts

- Debian 13, i5-6500T, 23 GB RAM, P106-100 (6 GB) on the Vulkan path
- Ollama 0.32.15 on `127.0.0.1:11434`, `gemma4:e4b-it-qat` (~30 tok/s)
- Node 22 is required; `bootstrap.sh` installs it under `~/.local/node` when the
  system Node is older
- No passwordless sudo
- Python with numpy/scipy: `@STACK_DIR@/grader/.venv/bin/python3` (system
  python3 has neither; `pip install` is blocked by PEP 668)
- `arduino-cli` may live in `~/.local/bin`; `compile` finds it there
- Context window is **32768**, set per request by the shim (`/v1` ignores
  `num_ctx` on its own). Override with `PI_CONTEXT_LIMIT` if the shim changes.
  Measurements: `~/.pi/agent/gate-log.md`
