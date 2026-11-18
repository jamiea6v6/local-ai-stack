# WORKPLAN — resumable backlog

Purpose: if a session is lost, read this file, run `git log --oneline -5`, and continue at the first
item whose state is not `done`. One item at a time; one commit per item; update the State column in
the same commit.

## Rules

- Work happens in **this repo** (`local-ai-stack`) and in `mcu-domain`. `brain1-stack` is a frozen
  capture — do not extend it.
- Nothing is considered done until it runs on a **fresh clone** on SkyNet and the check in
  "Done when" passes.
- Every item ends with a commit `I<n>: <what landed>` pushed to `origin/main`, plus a State update.
- Never commit secrets, LAN IPs, `/home` paths, or real names (this repo is public).
- `bootstrap.sh`/`verify-stack.sh` must be **host-agnostic**: the target is any P106-100 + Debian 13
  box. No brain1-specific paths. Deployment to brain1 is a later sync item, not part of any item here.

## Backlog

| ID | Item | Done when | State |
|---|---|---|---|
| I1 | This workplan + recovery protocol | file committed, push succeeds | done |
| I2 | Board metadata extractor `tools/board_meta.py` | generates `pins.yaml` + `specs.yaml` + `provenance.json` for d1_mini, nodemcu, uno, pico, pico2, esp32-devkit from real core files; `--check` re-verifies sha256 | done |
| I3 | `bootstrap.sh` + `verify-stack.sh` (P106/Debian 13) | fresh SkyNet run installs/verifies all pieces; a second run is a no-op; `verify-stack.sh` prints PASS/FAIL per check | done |
| I4a | Research guard: `webfetch` refuses PDF/binary bodies | a served `%PDF` is refused before decode; text/HTML still works | done |
| I4b | Compile gate + project gates + tool contract | `compile` builds `firmware/<n>/<n>.ino` with the sheet's FQBN and returns the compiler verdict; `verify(project=...)` runs `gates.json`; no absolute host paths in `pi-AGENTS.md`; `tests/extensions/run-checks.sh` green | done |
| I4c | Board fact-sheet generator | `tools/board_sheet.py --board <id>` emits `devices/<board>.txt` from `refs/boards` + `arduino-cli board listall` (label→GPIO, FQBN, logic, ADC), UNKNOWN where unsourced; `tests/tools/run-checks.sh` green | done |
| I4d | Pin gate: sketch pins vs the board sheet | `compile` reports `PINS: PASS/FAIL/SKIP`; GPIO6-11 (ESP8266 flash) and pins not on the sheet fail; labels resolve (D8→GPIO0); non-GPIO projects skip; `tests/extensions/run-checks.sh` green | done |
| I5 | Empty final answer: repro + fix (only open P0) | replay reproduces `content: []`, fix yields non-empty content, regression test in `tests/` | done |
| I6 | Measurement runner + baseline | refreshed suite (no 8192 refs), suite A–F x3, 5 fresh CW sessions each graded 11/11, report JSON | blocked |
| I7 | Two end-to-end runs on e4b | MCU firmware task + basic Linux app, natural prompt to gated artifact; iterations-to-green logged | done |
| I8 | Ship: DECK.md, FRIEND-KIT, publish three repos | public clone URLs work for all three repos; deck numbers come from I6/I7 output | done |

## Item detail

### I2 — board metadata extractor
Reuse existing toolchains instead of hand-writing pin maps:

- **arduino-cli**: `board details --fqbn <fqbn> --format json` returns `build_properties` as a
  `key=value` list (376 entries for `esp8266:esp8266:d1_mini`, e.g. `build.arch=ESP8266`); the
  variant header is under `~/.arduino15/packages/<vendor>/hardware/<arch>/<ver>/variants/<variant>/pins_arduino.h`.
  Parse `static const uint8_t X = n;`, `#define X n`, `LED_BUILTIN`, `A0..`, and reserved/strapping
  notes from the header comments.
- **PlatformIO**: `pio boards --json-output` gives `id/mcu/fcpu/ram/rom/frameworks/platform`;
  per-board JSON at `~/.platformio/platforms/<platform>/boards/<id>.json` (`build`, `upload`).
- **CircuitPython / MicroPython**: fetch board defs from the pinned upstream release
  (`ports/*/boards/<id>/pins.c`, `mpconfigboard.h`, `pins.csv`), never from model memory.
- Output per board: `pins.yaml` (name, gpio, function, reserved/boot-strap), `specs.yaml`
  (mcu, flash, ram, f_cpu, logic V), `provenance.json` (source, version, sha256, fetched).
- Gate use: `check_pins_src.py --board <id>` resolves against generated maps, fail closed.
- RAG use: these maps are **exact lookup**, not embeddings; prose stays for Phase 2.

### I4a — PDF/binary guard
The 2026-11-17 VMA203 session fetched a datasheet PDF as text and read the saved dump: one turn went
5.2K → 26.4K input tokens, forced a compaction, and the task never recovered. `webfetch` now rejects
`application/pdf`, `%PDF-`, ZIP/octet-stream, and bodies with >2 % U+FFFD before the model sees them,
and names the conversion path (`pdftotext -layout`). `tests/extensions` serves a `%PDF` locally and
asserts the refusal.

### I4b — compile gate, project gates, tool contract
The same session wrote a flat `VMA203_Hello.ino`; arduino-cli then demanded `<cwd>/<cwd>.ino` and the
model retried four times before calling the environment broken. `compile(path, fqbn)`:

- applies the `<dir>/<name>.ino` rule and moves a single stray `.ino` into place;
- takes `FQBN:` from `devices/*.txt` or `BRIEF.md` (conflicting sheets are an error), never guesses;
- finds `arduino-cli` via `ARDUINO_CLI`, `PATH`, `~/.local/bin`, `~/bin`, `/usr/bin`;
- returns the compiler's output plus a NEXT hint for layout / bad FQBN / missing header.

`verify(project=...)` runs the project's `gates.json` as argv arrays (no shell), one PASS/FAIL per gate;
spec mode keeps working and accepts `python=` (or `PI_VERIFY_PYTHON`) so a venv candidate can import its
packages. `pi-AGENTS.md` now has research vs build-from-facts modes, exact tool field names, and no
absolute host paths — `bootstrap.sh` substitutes `@STACK_DIR@` at install time. The regression gate is
`tests/extensions/run-checks.sh` (13 checks, no Pi session).

### I4c — board fact sheets
Explain to the agent and the human in one file what the machine already knows: `tools/board_sheet.py`
renders `devices/<board>.txt` from `refs/boards/<id>/` and `arduino-cli board listall` — display name,
FQBN, logic level, flash/RAM, and a pin table with the board label and the GPIO number. Values without
a source stay UNKNOWN so the model must ask. Generated once per project; `RESULT.md` measurements fold
back into a project override, not into the shared ref.

Shipped: the generator plus a `wemos-d1` ref (the R1 board, `esp8266:esp8266:d1`) — its D-labels do
not follow GPIO order (D8=GPIO0, D9=GPIO2), so a hand-typed table is exactly the kind of fact that gets
invented. `arduino-cli` spells the Uno "Arduino UNO", so name matching is case-insensitive with a
single-loose-hit rule; no CLI means `FQBN: UNKNOWN`, never a guess. `tests/tools/run-checks.sh` has 11
checks (sourced FQBN, label→GPIO, no invented ADC range, UNKNOWN fallback, `--out`, bad board id).

### I4d — pin gate, with a non-GPIO bypass

A green build is not a correct pin map: `LiquidCrystal lcd(8, 9, 4, 5, 6, 7)` compiled on the D1,
where 8/9 are not pins on the board and 6-11 are the SPI flash. `pins.ts` parses the board sheet
(label→GPIO, `RESERVED: GPIO6-11`), extracts pin uses from the sketch (pin/digital/analog calls,
`attachInterrupt`, Servo/Wire/SPI, LiquidCrystal/SoftwareSerial constructors), resolves sketch
constants, and fails any pin that is reserved, absent from the sheet, or unresolvable. `compile` runs
it after a green build and prints `PINS: ...`; the `pincheck` tool runs it alone.

The bypass is structural, not a flag: no board sheet with a `PINS` section, no `.ino`, or no pin
calls means `SKIP`. A Python/Linux-app project has none of those, so it pays nothing. Fixture tests
cover both directions, including run 1's exact constructor (FAIL) and run 3's GPIO list (PASS).

### I5 — empty final answer
Symptom: `content: []`, `stopReason: stop`, no tool calls — Pi prints only "Command completed
successfully" and the task dies. Captured from brain1's `vma203-hello` session JSONL
(`13-11-26`, 12 output tokens, empty assistant content).

Cause, isolated by replaying the exact request through a logging proxy between the shim and Ollama:
with `think:false` and the full ~9.5K-char Pi system prompt, gemma4:e4b-it-qat emits a channel
artifact and stops — 12 tokens, `content: ""`, no tool call, `done_reason: stop`. Reproduced 8/8;
a naive identical retry failed 10/10 (deterministic, not flaky). Thinking on, a raised temperature,
or a one-line trailing nudge all broke the loop (nudge 3/3). The model was not being swallowed by
Pi: Ollama itself returned empty content.

Fix in the shim, not in Pi's install: buffer one completion before emitting (SSE cannot be taken
back), detect no-content-and-no-tool-call, then re-ask with a trailing user nudge that Pi never
sees. Bounded by `OLLAMA_SHIM_EMPTY_RETRIES` (default 2); a cut-off answer (`length`, content
present) is not retried. Live proof on SkyNet: 3 of 5 replay runs needed the retry, all 5 ended
with a non-empty answer.    Offline gate: `tests/shim/run-checks.sh` (15 checks, fake upstream, no GPU).

### I6 — measurement runner + baseline
Keep `LOCAL_AGENT_TEST_SUITE.md` byte-identical; use `REFRESHED_SUITE.md` + `suite.json` for current
harness refs without touching prompts, ground truth, or criteria. The runner gives each session a
fresh cwd/session dir, grades artifacts externally, and feeds failing grader lines back into the same
CW session (bounded by `--max-cw-retries`, default 3). Offline gate: `tests/measurement/run-checks.sh`
(11 checks, both oracles, no Pi session). Baseline gate: A–F x3 + five CW sessions, report JSON under
`tests/results/`, with host role in place of a hostname.

## Physical items (not in this queue; owner: the operator)
- T5500 slot survey; brain1 front panel + BIOS AC-restore.
- Bench answers that unblock the worked example: BME280 address (0x76 vs 0x77), VMA203 3.3 V logic.

## Log
- 2026-11-16 — I1 done (commit e03322c).
- 2026-11-16 — I2 done: 6 boards generated under `refs/boards/`, `--check` green three runs in a row and on an anonymous fresh clone. Next: I3.
- 2026-11-16 — I3 done (commit 0b0eb44): `bootstrap.sh` (user-local, idempotent, downloads checksum-verified) + `verify-stack.sh`
  (read-only, PASS/FAIL/SKIP, `--require-p106`). SkyNet: 26 PASS / 0 FAIL / 4 SKIP — the skips are the three ai-stack config
  symlinks (managed elsewhere) and no P106 on this box. Second run: 0 actions. Anonymous fresh clone: bootstrap created only its
  venv, verify 26/0/4 exit 0. Also installed libportaudio2, pulled `gemma4:e4b-it-qat` (6.1 GB) and `llama3.2:3b`, and started
  the shim as a user unit. Next: I4.
- 2026-11-16 — I3 addendum (commit 932ae64): `verify-stack.sh` gained hardware profiles (`auto|p106|gpu|cpu`), a real
  completion through `:11435`, and `/api/ps` attribution (100% VRAM, context 32768), plus `--no-inference`. On SkyNet auto
  resolves to `gpu`: 30 PASS / 0 FAIL / 3 SKIP; `--profile p106` fails on purpose there; anonymous fresh clone 30/0/3. README
  now documents the tiers, the Proxmox-VM passthrough rule, and the new-P106-box recipe.
- 2026-11-16 — brain1 (P106-100) updated from the public repo: `git clone` → `bootstrap.sh` (Pi 1.4.0, 9 extensions,
  AGENTS/models/settings, shim unit repointed and restarted, arduino-cli 1.6.0 + cores + libs, PlatformIO 6.2.0 +
  espressif32, venv with numpy/scipy/pyyaml) → rerun **0 actions**. `verify-stack.sh --profile p106`: **31 PASS / 1 FAIL /
  3 SKIP**, completion through the shim, `loaded: 2974/2974 MiB ctx=32768`. Only FAIL is `libportaudio2` (needs the sudo
  password); SKIPs are pi-not-on-non-login-PATH (login shell resolves `~/.pi/agent/bin/pi`), no mcu-domain, no
  vulkaninfo. Config backups: `~/pi-agent-config-backup-20261116-212417.tgz`; old `~/projects/cw-dsp` untouched.
- 2026-11-16 — I4a + I4b done: `webfetch` refuses PDF/binary bodies (measured 21k-token injection);
  `compile(path,fqbn)` enforces `<name>/<name>.ino`, sources the FQBN from `devices/`, discovers
  arduino-cli, and returns a NEXT hint; `verify(project=...)` runs a project's `gates.json` and spec mode
  accepts `python=`. `pi-AGENTS.md` split research vs build-from-facts and is host-agnostic
  (`@STACK_DIR@` substituted by `bootstrap.sh`); `--skip-pio` no longer runs the pio platform probe.
  `tests/extensions/run-checks.sh`: 13/13. CW grader still 11/11. Next: I4c.
- 2026-11-16 — I4b follow-up: `enforce-search` stands down for compile/build prompts and inside a project
  with `devices/` — it had forced a websearch before the compile that then failed on sketch layout.
  Fresh anonymous clone: extension checks 13/13, bootstrap rerun 0 actions, `@STACK_DIR@` substituted.
  brain1 pulled the same commit: config rerun 0 actions, extension checks 13/13 (compile PASS on
  `esp8266:esp8266:d1` with the real core). Next: I4c.
- 2026-11-16 — I4d done: the pin gate. `compile` now prints `PINS: PASS/FAIL/SKIP`; `pincheck` runs the
  check alone; auto-SKIP when there is no sheet/sketch/pin use. Fixtures include run 1's `lcd(8,9,4,5,6,7)`
  (FAIL) and run 3's `lcd(0,2,4,14,12,13)` (PASS). All extension checks green. Proven on brain1: run 1's
  sketch now reports `COMPILE: PASS` **and** `PINS: FAIL — GPIO8/9/6/7 reserved`; run 3 reports
  `PINS: PASS — 7 pin use(s)`. One run came back with an empty final answer (I5 evidence). Next: I5.
- 2026-11-16 — brain1 rerun of the VMA203 scenario (same prompt, project layout), three runs. Run 1 read
  the sheets, wrote one sketch and compiled first try with zero web calls (~5.9k input/turn) — but passed
  the manual's Uno numbers (8,9,4,5,6,7) to LiquidCrystal; GPIO8/9 are flash pins and it still compiled.
  Run 2 had correct GPIOs but invented backlight polarity and burned 5 edit retries (`edits` array). Fixes:
  sheets say "a label is not a pin number"; the VMA203 sheet carries the 6-arg constructor; AGENTS names
  the `edits` mistake. Run 3: 4 reads → 1 write → 1 compile PASS, GPIOs 0,2,4,14,12,13, no backlight, no
  web calls, 53.9k input total. The D1 header-position map is still a bench note (not meter-checked).
- 2026-11-16 — I4c done: `tools/board_sheet.py` renders a board sheet from `refs/boards` + a live
  `arduino-cli board listall`; added the `wemos-d1` ref. 11/11 tool checks. Next: the brain1 rerun, then I5.
- 2026-11-16 — I4b live proof on SkyNet: a PTY-wrapped `pi -p` run (build-from-facts prompt) wrote
  `firmware/blink/blink.ino` and `compile` passed with the sheet's `esp8266:esp8266:d1`, no web search.
  Pi 1.4.0 needs a PTY even with `-p` (documented in README). Live extensions on SkyNet and brain1 now
  include `compile.ts`; both boxes' config reruns are 0 actions.
- 2026-11-16 — board_meta became host-independent: digests drop `extra.time.*`, normalize `<HOME>`/`<CLI_DIR>`, ignore
  `runtime.ide.path`; `--seed-cache` fills the remote cache so a fresh box can `--check`; pio falls back across
  `espressif32*` dirs. Proven by brain1 `--check` green against refs generated on SkyNet.
- 2026-11-17 — I5 done: isolated the empty final answer by proxying the shim↔Ollama traffic and
  replaying brain1's `vma203-hello` prompt — Ollama itself returned 12 output tokens with
  `content: ""`, no tool call, `done_reason: stop` (8/8 on the full system prompt; an identical
  retry failed 10/10). The shim now buffers one completion, detects no-content/no-tool-call, and
  re-asks with a trailing nudge invisible to Pi (bounded 2 retries; `length` answers untouched).
  Live SkyNet replay: 3/5 runs needed the retry, all 5 ended non-empty. New offline gate
  `tests/shim/run-checks.sh`: 15/15 against a fake upstream. Extension 24/24, tools 12/12, grader
  11/11 still green. Next: I6.
- 2026-11-17 — I6 runner implemented and full P106 baseline completed: offline gate 11/11, suite
  6/18 heuristic passes, CW 0/5 graded 11/11 (best 9/11 after grader-feedback retries). Prompts and
  criteria were not changed after the run. Raw report stays with the measurement host;
  `tests/BASELINE_FINDINGS.md` carries the sanitized findings. I6 is blocked on the 5/5 CW gate.
- 2026-11-18 — I7 pre-registered in `docs/I7_TASKS.md`: Skynet GPT-OSS is the operator, Brain1 Pi/e4b
  is the subject; two frozen tasks (MCU firmware, basic Linux app) with external gates, 3-attempt cap,
  and attempts-to-green logging. Execution pending.
- 2026-11-18 09:29 — first operator session aborted before task execution because the Pi invocation
  interface was implicit. Added helper commands to `docs/I7_TASKS.md` and ran a fake-Pi smoke test;
  prompts, gates, retry cap, and report fields are unchanged.
- 2026-11-18 11:03 — second operator session (`ses_e1085f88fffeeMuTzbfL6QIqyg`) got past SSH and
  commit checks but failed I7a on operator mechanics: wrong `read` schema/path assumptions, bare
  `python3` board-sheet failure, a stray `devices/board.txt` with the wrong FQBN, and no captured
  gate output or attempts log. Added operator mechanics guardrails to `docs/I7_TASKS.md`: absolute
  Skynet/Brain1 paths, `filePath` for `read`, Tier 0 preflight, grader-venv board-sheet generation,
  canonical-sheet assertions, `gate.txt` capture, exact retry construction, and I7b sequencing.
  Prompts, gates, retry cap, and report fields are unchanged; raw session stays off-repo.
- 2026-11-18 11:17 — third operator session (`ses_e105edafbffec50iLDO2abCmNY`) stopped after 8
  messages because it started in `~` and read relative `docs/I7_TASKS.md`, concluded the
  docs were missing, and never reached SSH/Tier 0/I7. Added absolute Skynet doc paths to the operator
  guardrails and the runbook paste-prompt. No Brain1 artifacts changed.
- 2026-11-18 11:23 — fourth operator session (`ses_e1054f2f1ffeIeMociolNvp46k`) read both absolute
  docs, then refused the work as too large for one response before any SSH/Tier 0/I7 command. Added
  an explicit multi-step/no-scope-refusal guardrail. No Brain1 artifacts changed.
- 2026-11-18 11:29 — fifth operator session (`ses_e104fb8ffffeFY6GofOXVf97ai`) read both docs, then
  ran `git -C ~ rev-parse HEAD` and stopped when it hit the non-repo directory. Added exact
  version-check commands for Skynet and Brain1 to the operator guardrails. No Brain1 artifacts changed.
- 2026-11-18 11:56 — sixth operator session (`ses_e104996a9ffeyjycNGUfOy0uWY`) completed version
  checks, chmod'ed non-executable helpers, passed Tier 0, generated the board sheet, and ran one Pi
  turn. Compile failed on the missing DHT library (user installed it afterward); PINS SKIP came from
  bad `pincheck` args, and the gate was run before the first turn. Fixed helper file modes in git and
  added guardrails for gate sequencing, absolute `arduino-cli` path, and `pincheck` project root.
- 2026-11-18 12:12 — seventh operator session (`ses_e102c9630ffeZFqgYs7vDlMDmr`) passed I7a on
  attempt 1 (`COMPILE_PASS=true`, `PINS_PASS=true`, `GATE_EXIT=0`) after the DHT library install. The
  operator ran the gate once before the first Pi turn but self-corrected, and omitted `attempts.md`;
  the missing attempt log was written from gate evidence and an explicit first-attempt-PASS guardrail
  was added. I7b has not started.
- 2026-11-18 12:24 — eighth operator session (`ses_e1020bf98ffe8jHhJfmphT5Hd0`) produced a passing
  I7b `app.py`, but incorrectly applied the I7a `session_evidence.py` gate, copied the artifact to
  Skynet, ran the output check locally, and wrote `attempts.md` on Skynet. Re-ran the canonical Brain1
  gate (`count=3 min=18 max=22 mean=20.0`, `GATE_EXIT=0`), wrote the canonical `attempts.md`, removed
  the Skynet stray copy, and added a guardrail separating I7a evidence from I7b's direct gate. I7 is
  complete.
- 2026-11-18 13:36 — I8 shipped: added `DECK.md`, extended `docs/FRIEND-KIT.md` and `README.md` with
  the public clone URLs, removed PAT revocation from scope (tracked separately with the MCP setup),
  and sanitized host paths/IPs from the public docs before publication. Published `brain1-stack` and
  `mcu-domain` as public GitHub repos alongside the existing `local-ai-stack`.
- 2026-11-18 13:46 — fresh-clone verification found the tools gate falling back to a bare `python3`
  name that vanished under its own `env -i` check. Resolved the fallback to an absolute path and
  republished; the measurement gate still needs the bootstrapped venv for numpy/scipy.
