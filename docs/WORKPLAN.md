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
| I3 | `bootstrap.sh` + `verify-stack.sh` (P106/Debian 13) | fresh SkyNet run installs/verifies all pieces; a second run is a no-op; `verify-stack.sh` prints PASS/FAIL per check | pending |
| I4 | Harness seam: `verify` accepts a project dir; routing + env paths | a project dir runs the three MCU gates; a candidate file still works; no absolute host paths in `pi-AGENTS.md` | pending |
| I5 | Empty final answer: repro + fix (only open P0) | replay reproduces `content: []`, fix yields non-empty content, regression test in `tests/` | pending |
| I6 | Measurement runner + baseline | refreshed suite (no 8192 refs), suite A–F x3, 5 fresh CW sessions each graded 11/11, report JSON | pending |
| I7 | Two end-to-end runs on e4b | MCU firmware task + basic Linux app, natural prompt to gated artifact; iterations-to-green logged | pending |
| I8 | Ship: DECK.md, FRIEND-KIT, publish mcu-domain, revoke PAT | public clone URLs work for all three repos; deck numbers come from I6/I7 output | pending |

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

### I5 — empty final answer
Symptom from the 2026-11-14 run: `content: []`, 1 output token, `stopReason: stop`. Replay the saved
request shape through the shim with instrumentation (`finish_reason`, `max_tokens`, template
`<channel|>` artifact) before changing code.

## Physical items (not in this queue; owner: Jamie)
- T5500 slot survey; brain1 front panel + BIOS AC-restore.
- Bench answers that unblock the worked example: BME280 address (0x76 vs 0x77), VMA203 3.3 V logic.

## Log
- 2026-11-16 — I1 done (commit e03322c).
- 2026-11-16 — I2 done: 6 boards generated under `refs/boards/`, `--check` green three runs in a row, fresh-clone check pending. Next: I3.
