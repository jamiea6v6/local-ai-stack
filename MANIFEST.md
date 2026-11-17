# MANIFEST — every pin, and why it is pinned

Captured 2026-11-14 from the working brain1 stack. The point of this file is that **no version here is
arbitrary.** Each one is there because something specific breaks without it, and the "why" is recorded
so the next person (or the next box) does not have to rediscover it.

Source of truth for the live stack: `brain1` (address omitted), Debian 13.

> **This copy is redacted for publication.** IPv4 addresses are placeholders, home-directory paths are
> reduced to `~`, and personal names are removed. The sha256 values in §4 are of the *pre-redaction*
> originals, so the running install's hashes will differ where a redaction touched a file.

---

## 1. Baseline

| Item | Value | Note |
|---|---|---|
| OS | Debian 13 (trixie) | kernel 6.12.90+deb13.1-amd64 |
| CPU | Intel Core i5-6500T (4c) | AVX2, no AVX-512. Slow, but the GPU does the math |
| RAM | 23 GB | staging limit for model loading — see §3 |
| GPU | NVIDIA P106-100, **6144 MiB** | GP106, compute_cap 6.1, **no display outputs**, no tensor cores, no native FP16 |
| Driver | **550.163.01** | see §2 — the number that looks wrong but isn't |
| Model | `gemma4:e4b-it-qat` (6.1 GB) | QAT build, ~30 tok/s, the daily driver |
| Pi | **1.4.0** (managed install, `~/.pi/agent`) | `install/current-version` |
| Node | **v22.20.0** at `~/.local/node` | Debian's nodejs is 20.19.2 and ships no npm |
| Ollama | **0.32.15+** (0.40.12 verified) | `127.0.0.1:11434` |
| Python | 3.13.5 | system python is externally managed (PEP 668) |

---

## 2. The pins that look wrong but are not

### Driver 550.163.01 — do not "upgrade" this blindly

Ollama's docs say NVIDIA GPUs with compute capability 5.0–6.2 need driver **570+**. The P106-100 is
compute capability **6.1** and runs on **550.163.01**. The contradiction resolves precisely:

> The 570 requirement applies to the **CUDA** path only. brain1 runs the **Vulkan** path, which has no
> such requirement. What actually decides whether a model runs is **VRAM**, not the driver.

Evidence on the box: `/usr/share/vulkan/icd.d/nvidia_icd.json` present, `/dev/dri/renderD128` +
`renderD129` present. Changing the driver is not free — it changes which Vulkan ICD and which card
enumeration the shim and Ollama see.

### The shim exists because `/v1` ignores `num_ctx`

Measured on brain1: `POST /v1/chat/completions {"options":{"num_ctx":32768}}` → the server still
reports `context_length 8192`. The **native** endpoint honours it (even against the server's own env
cap). `tools/ollama-v1-shim.mjs` sits between Pi and Ollama, translating OpenAI `/v1` requests to
native `/api/chat` with `num_ctx` injected, and converting the response back.

Two details in the shim that are not obvious and will bite if changed:
- the assistant's `tool_calls` **must** be carried through — drop them and the model is blind to tool
  results and loops on the same search (measured: 20 repeats of one websearch);
- Ollama's native API wants `arguments` as a JSON **object**, not a string — pass the string through
  and Ollama rejects the whole request.

### The window has three truths — one of them is wrong

| Where | Value | Status |
|---|---|---|
| `harness/models.json` → `contextWindow` | 32768 | correct (what the shim actually gives) |
| `systemd/ollama-v1-shim.service` → `OLLAMA_SHIM_CTX` | 32768 | correct (what the shim requests) |
| ollama systemd env `OLLAMA_CONTEXT_LENGTH` | 8192 | server default; the shim overrides per request |
| `harness/extensions/context-budget.ts` → `CONTEXT_LIMIT` | 32768 | correct since 2026-11-16 (`PI_CONTEXT_LIMIT` overrides) |
| `harness/extensions/enforce-search.ts` → `CONTEXT_LIMIT` | 32768 | correct since 2026-11-16; room-for-lookup is 80% of it |

All three harness constants (and the rules text in `pi-AGENTS.md`) now derive from the same number:
`PI_CONTEXT_LIMIT` if set, otherwise 32768 — matching the shim's `OLLAMA_SHIM_CTX` and `models.json`.
Do not "fix" a small-window symptom by raising the ollama env var — the shim already does the job.

### Context is cheap; VRAM is the constraint — but not the constraint you think

Measured on the P106 with `gemma4:e4b-it-qat`:

| Context | VRAM used |
|---|---|
| 8192 | 4086 MiB |
| 16384 | 4162 MiB (+76) |
| 32768 | **4314 MiB (+228)** of 6144 |

KV rate ≈ **9.5 MiB per 1k tokens**. The window is nearly free in VRAM; the *prompt budget* is the
scarce resource, and the baseline prompt is already ~4700 tokens (2378 with no `AGENTS.md` in the
ancestry, +2340 for the doc-store `AGENTS.md`, +929 for the Pi harness `AGENTS.md`).

### Ports

| Port | What | Who talks to it |
|---|---|---|
| 11434 | Ollama native API | the shim only |
| 11435 | the shim's OpenAI-compatible API | Pi (`models.json` baseUrl) |

---

## 3. The pins that will bite during install

- **PEP 668**: `pip install` into system python fails. Use the venv (`~/projects/local-ai-stack/grader/.venv`,
  numpy 2.5.4 / scipy 1.18.1) or Debian packages (`python3-numpy`, `python3-scipy`).
- **PortAudio**: there is **no package called `portaudio`**. The library is `portaudio19-dev`, the
  Debian binding is `python3-pyaudio`. For the *runtime* only, the package is **`libportaudio2`**.
  **brain1 does not have `libportaudio2` installed today** — that is exactly why the 2026-11-14 Pi
  run's program died at import with `OSError: PortAudio library not found`. Install it.
- **RAM staging** (`S` = model GB, `C` = context): VRAM ≈ `S + C/1000 × 9.5 MiB`; RAM ≈ `S + ~1.5 GB`.
  A 6.1 GB model needs ~7.6 GB RAM free. The 12B (7.2 GB) does not fit one 6 GB card and spills to
  CPU — which on a no-AVX2 box is hopeless.
- **Ollama auto-picks context from VRAM**: a 6 GB card defaults to **4096**. Set it explicitly.
- **The MCU toolchain is not part of the stack** but is needed for the firmware work
  (installed 2026-11-14 on brain1 and SkyNet): `arduino-cli` **1.6.0** user-local at
  `~/bin/arduino-cli`; cores `arduino:avr` 1.8.8 and `esp8266:esp8266` 3.1.2 (the ESP8266
  core is third-party and needs
  `--additional-urls https://arduino.esp8266.com/stable/package_esp8266com_index.json`);
  libraries Adafruit BME280 2.3.0, LiquidCrystal 1.0.7, LiquidCrystal_I2C 2.0.0.
  **arduino-cli refuses a sketch whose primary .ino is not named after its folder**.
- **Do not enable `OLLAMA_SCHED_SPREAD`** with two cards unless a model *must* split. Splitting puts
  the KV cache behind PCIe: measured collapse from 21.6 tok/s to 2.6 tok/s on a straddled pair.
  One model per card is the fast, predictable configuration.

---

## 4. File inventory — captured 2026-11-14, sha256 verified against the live files

| File | sha256 (first 16) | What it is |
|---|---|---|
| `harness/extensions/context-budget.ts` | `00c59057a816175e` | trims oversized context files to fit the window |
| `harness/extensions/enforce-fetch.ts` | `fc06d571ac5b6beb` | requires a webfetch after every websearch |
| `harness/extensions/enforce-search.ts` | `e7b9e56017b99bba` | requires a lookup before a factual answer |
| `harness/extensions/think-control.ts` | `3c163ca406938203` | sends Ollama's per-request `think:false` |
| `harness/extensions/verify-package.ts` | `4ef26d695abfb4f0` | npm/PyPI/URL existence check |
| `harness/extensions/verify-persist.ts` | `9dcf5d5653fe56f2` | forces a second look after a failing verify |
| `harness/extensions/verify.ts` | `0c9245e578cf422b` | runs a deterministic spec against a candidate file |
| `harness/extensions/webfetch.ts` | `b779af06c43bbac0` | fetch a URL, HTML reduced to text, output capped |
| `harness/extensions/websearch.ts` | `bf0b0d8abda4388` | DDG-HTML → Bing, 5 results, 140-char snippets |
| `harness/models.json` | `8b3058152e7efc25` | provider + model + context + sampling |
| `harness/settings.json` | `b4d46800dc25a3fe` | pi's `lastChangelogVersion` |
| `harness/pi-AGENTS.md` | `2b47af1db0f9464b` | the harness rules (keep short — every line costs per turn) |
| `systemd/ollama-v1-shim.service` | `5d16d333ebc4357b` | the shim's user unit |
| `tools/ollama-v1-shim.mjs` | `e1d5b438f8f4bca6` | the shim itself |

All 14 verified byte-identical to `brain1:~/.pi/agent/...` on 2026-11-14.

### §4a — patched after the 2026-11-16 review

Seven files changed. The hashes in §4 describe the 2026-11-14 capture; these are the current ones.

| File | sha256 (first 16) | Change |
|---|---|---|
| `harness/extensions/context-budget.ts` | `4daa9c218ba37351` | window constant from `PI_CONTEXT_LIMIT`/32768; trim loop recomputes headroom per file |
| `harness/extensions/enforce-search.ts` | `383bc8b3e35994aa` | same window source; lookup room scales with it; gate log uses `os.homedir()` |
| `harness/extensions/verify-package.ts` | `5f184ce26e907fcc` | PyPI probe is Node `fetch` (the old python-in-a-template-literal threw before running); three verdicts incl. `COULD NOT CHECK` |
| `harness/extensions/verify-persist.ts` | `b1c5f4263fb29a10` | an errored verify is a failure, not a pass |
| `harness/extensions/verify.ts` | `c7b40dd6c77d6741` | refuses candidates under `grader/` unless `PI_VERIFY_ALLOW_REFERENCE=1` |
| `harness/pi-AGENTS.md` | `d4523d6d5e1b3b89` | window is 32768; the reference implementation must not be copied or submitted |
| `tools/ollama-v1-shim.mjs` | `7e137f69e8069126` | finish_reason/`length`, `max_tokens`, abort propagation, unhandled-rejection paths, id/index collisions, role/precision edge cases |

### §4b — seams after the 2026-11-17 MCU and DSP sessions

| File | sha256 (first 16) | Change |
|---|---|---|
| `harness/extensions/compile.ts` | `dc2ba583752e64b5` | NEW: arduino-cli build; `<name>/<name>.ino` layout, FQBN from `devices/`, compiler verdict + NEXT hint |
| `harness/extensions/verify.ts` | `45d276e980252059` | project mode (`gates.json` argv arrays), `python=` interpreter, `spec` now optional |
| `harness/extensions/webfetch.ts` | `439111720285830c` | refuses PDF/octet-stream/binary bodies before decode (~21k-token injection measured) |
| `harness/extensions/enforce-search.ts` | `8fb56caa3e06d4e8` | compile/build prompts and projects with `devices/` skip the lookup gate |
| `harness/pi-AGENTS.md` | `ed23bb6f8ddd9bc9` | research vs build-from-facts modes, exact tool fields, compile/verify usage, board-sheet generator, `@STACK_DIR@` template |
| `bootstrap.sh` | `a97be60a7ec4fa28` | renders `@STACK_DIR@`; `--skip-pio` no longer runs the pio platform probe |
| `tests/extensions/run-checks.sh` | — | 13-check regression suite driven without a Pi session |
| `tools/board_sheet.py` | `68a12d95b9c232d6` | NEW: renders `devices/<board>.txt` from refs + `arduino-cli board listall`; UNKNOWN where unsourced |
| `tools/board_meta.py` | `c62a7e43ee153157` | adds the `wemos-d1` (R1) board definition |
| `refs/boards/wemos-d1/pins.yaml` | `fd171b27cfa3b633` | D-label→GPIO map extracted from `variants/d1/pins_arduino.h` (24 pins) |
| `refs/boards/wemos-d1/specs.yaml` | `c428e56c86c7f70d` | R1 specs: esp8266, 3.3 V, 4 MiB / 80 KiB |
| `tests/tools/run-checks.sh` | `ad317df772a9da50` | 11 board-sheet checks: FQBN sourcing, label→GPIO, UNKNOWN fallback |

---

## 5. Known drift risk — read before deploying

**The running shim on brain1 was NOT this copy.** Its unit's `ExecStart` still pointed at an older
checkout; **this repo's `tools/` copy is the canonical source going forward**.

`bootstrap.sh` therefore: (a) installs this copy, (b) rewrites the unit's `ExecStart` to this repo's
path, (c) restarts the shim, (d) checks that `:11435/v1/models` answers. `verify-stack.sh` reads the
deployed unit's `ExecStart`, hashes the script it names, and fails if it differs from
`tools/ollama-v1-shim.mjs` — the detector for the two-copies drift.

---

## 6. Not in this repo yet (the remaining work)

| Missing | Why it matters | When |
|---|---|---|
| `bootstrap.sh`, `verify-stack.sh` | install + prove: node/pi/harness/shim/arduino/venv, real completion through the shim, `100% GPU` + 32768 ctx attribution, `--profile p106|gpu|cpu` | done 2026-11-16 |
| `DECK.md` | the explainable presentation (house deck format: `## Slide N —`) | Thursday |
| the grader example | `grader/` now holds `spec_cw_filter.py` + `stub_pyaudio.py` + `mutants/` (moved in from the old `cw-dsp` repo) | done |
| updated test suite | `tests/LOCAL_AGENT_TEST_SUITE.md` is a snapshot; its harness refs are stale | Sunday/Monday |
| the three harness bugs | `verify_package` 404-vs-error, the 8192/32768 window truth, the empty final answer | 2 of 3 fixed 2026-11-16; empty-final-answer still open |

---

## 7. Deploy targets

| Target | Cards | Shape |
|---|---|---|
| brain1 (current) | 1 × P106-100 | one model, one card, one agent |
| a friend's box | 2 × P106-100 | **one card per model** — consumer cards cannot be shared without vGPU, which GeForce does not support |
| T5500 | 0–2 × P106-100 | Proxmox passthrough; slots/VT-d unverified (see TODO.md, 2026-11-14) |
