# local-ai-stack — a small local LLM agent stack, captured so it can be rebuilt

A cheap mining GPU (P106-100, 6 GB), a small quantised model, and a coding-agent harness that is
forced to check its own work. This repo is the **configuration half**: the harness extensions, the
model provider config, the Ollama `/v1` shim, the systemd unit, and the manifest that explains every
version pin.

The **measurement half** — a deterministic grader for a CW band-pass filter, a fake sound card, and
six deliberately broken mutants — lives in `grader/`. It is a worked example of the rule the whole
stack is built on: *the model must never be the judge of its own output.*

> Sanitized copy. IPv4 addresses are documentation placeholders, home-directory paths are reduced to
> `~`, and personal names are removed. Everything else is byte-for-byte as captured.

## Layout

```
MANIFEST.md            every version pin + why it is pinned   ← read this first
harness/extensions/    the Pi extensions (the actual IP)
harness/models.json    provider, model, context window, sampling
harness/pi-AGENTS.md   the harness rules (short on purpose — every line costs per turn)
harness/settings.json  pi's own settings
systemd/               the shim's user unit
tools/                 Ollama /v1 shim, raise-context.sh, board_meta.py, board_sheet.py (fact sheets)
tests/                 local-agent suite (snapshot + refreshed) + measurement runner + extension/tool/shim gates
grader/                the worked example: CW filter + deterministic grader + mutants
docs/FRIEND-KIT.md     build guide for a 2× P106-100 box
```

## Deploying

```bash
git clone <this repo> ~/projects/local-ai-stack
cd ~/projects/local-ai-stack
./bootstrap.sh          # idempotent; installs Node/Pi/shim/arduino-cli/venv user-local
./verify-stack.sh       # read-only; completion + GPU attribution + PASS/FAIL per check
```

`bootstrap.sh --system` adds the root bits (`libportaudio2`, optionally Ollama via
`--install-ollama`). `--pull-models` pulls every model named in `harness/models.json`.
The first completion after a cold start can take a minute on a P106-100.

The scripts automate the manual sequence in `MANIFEST.md` §2–3. The short version:
NVIDIA driver **550.163.01** → Ollama **0.32.15+** → Node **22** in `~/.local/node` → Pi **1.4.0** →
copy `harness/` into `~/.pi/agent/` → install the shim unit (rewrite its `ExecStart` to this repo) →
pull `gemma4:e4b-it-qat` → `apt install libportaudio2`.

### Hardware profiles

`verify-stack.sh` picks a profile from the hardware, or you can name it:

| Profile | Requires | Proves |
|---|---|---|
| `p106` | P106-100 (`10de:1c07`), 6144 MiB | 100% GPU, 32768 ctx, real completion |
| `gpu` | any NVIDIA GPU with >= 6 GB | 100% GPU, 32768 ctx, real completion |
| `cpu` | nothing (slow, still correct) | real completion; GPU checks skipped |
| `auto` (default) | — | `p106` if fitted, else `gpu`, else `cpu` |

The model under test is the **first entry** in `harness/models.json`; swap that file to
re-target Pi (and the smoke test) at a different tier. `--no-inference` keeps CI-like runs
to state checks only.

The same scripts run inside a Debian 13 VM on Proxmox: pass the GPU through, confirm
`lspci`/`nvidia-smi` see it *inside the guest*, then run them there. The host only supplies
the driver.

For a new P106 box (e.g. the two-card build):

```bash
git clone https://github.com/jamiea6v6/local-ai-stack.git
cd local-ai-stack
./bootstrap.sh --system --install-ollama --pull-models
./verify-stack.sh --profile p106
```

## The three ideas this encodes

1. **The model must never be the judge of its own output.** A separate process decides pass/fail;
   the model reads the failures and fixes the case named. That is what `verify` is for, and what
   `grader/spec_cw_filter.py` is an example of.
2. **Measure the harness, not the vibe.** The test suite fixes prompts, ground truth and PASS/FAIL
   *before* the run, so a result is falsifiable instead of a matter of opinion.
3. **Context is the scarce resource, not VRAM.** 32K tokens of context costs 228 MiB of VRAM on a
   6 GB card. The prompt budget is what runs out.

## Running the grader

```bash
cd grader
python3 -m venv .venv && .venv/bin/pip install numpy scipy
.venv/bin/python spec_cw_filter.py cw_filter.py ; echo "exit=$?"   # expect 11/11, exit=0
```

The bugs the grader exists to catch, and the harsher variant designed to fail, are in
`grader/README.md` and `grader/mutants/`.

## Board fact sheets

`tools/board_sheet.py --board wemos-d1 --out devices/wemos-d1.txt` renders what the repo can source:
display name, FQBN (from `arduino-cli board listall`), logic level, flash/RAM, and a label→GPIO table.
Anything without a source is `UNKNOWN` on purpose, so a build prompt has to ask instead of invent it.
`--list` shows the boards with refs under `refs/boards/`.

On a green build, `compile` also runs the pin gate: labels resolve through the sheet (`D8` → GPIO0),
`RESERVED` ranges (ESP8266 GPIO6-11, the SPI flash) and pins absent from the sheet fail with
`PINS: FAIL`, and the `pincheck` tool runs that check alone. Projects with no sheet, no sketch, or no
pin calls report `PINS: SKIP` — a Python or Linux app pays nothing.

## Headless Pi runs

Pi 1.4.0 blocks without a PTY even in `-p` mode, and prints nothing when it does. Wrap a headless run:

```
script -qec "pi -p --model ollama/gemma4:e4b-it-qat '<prompt>'" /dev/null
```

That is how the 2026-11-16 end-to-end check ran: prompt → `firmware/blink/blink.ino` → `compile` PASS on
`esp8266:esp8266:d1`, with the FQBN read from `devices/wemos-d1.txt` and no web search.

## Running the measurement baseline

```bash
./tests/measurement/run-checks.sh
./tests/measurement/run-baseline.sh --host-role p106
```

The runner executes the pre-registered suite in fresh PTY sessions, grades CW candidates with the
deterministic spec, feeds grader failures back into the same session (bounded retries), and writes a
sanitized JSON report under `tests/results/`. Tests A–F x3 and five CW sessions are the baseline;
the refreshed prompts and fixed ground truth live in `tests/REFRESHED_SUITE.md`.

## Review fixes (2026-11-16)

A static review of the capture found real defects; these are patched here, not just noted:

- `verify-package.ts`'s PyPI probe built a python one-liner inside a JavaScript template literal, so
  Node evaluated `${encodeURIComponent(sys.argv[1])}` and threw before python ran — every PyPI name
  became "DOES NOT EXIST". It now uses Node's `fetch`, and all three probes report **COULD NOT CHECK**
  for timeouts and network failures instead of calling a real package fake.
- The 8192-token assumption lived in `context-budget.ts`, `enforce-search.ts`, and `pi-AGENTS.md`.
  All three now derive from `PI_CONTEXT_LIMIT` (default 32768), and the trim loop recomputes headroom
  after each file instead of truncating every large file to 12%.
- `verify-persist.ts` ignored errored verify calls, so a mistyped or hung verify created no
  obligation. An error is now treated as a failure.
- `verify.ts` refuses to grade a candidate under `grader/`, so the model cannot submit the reference
  implementation as its own work.
- The shim: `finish_reason` no longer reports "stop" when tools were called, `length` is reported on
  truncation, `max_tokens` maps to `num_predict`, abandoned clients abort the upstream request,
  unhandled-rejection paths were closed, tool-call ids/indices no longer collide, and `developer`
  messages are not demoted to `user`.
- The shim also recovers the empty final answer: a completion with no content and no tool call is
  re-asked (bounded, with a trailing nudge not visible to Pi) instead of ending the turn as
  "Command completed successfully". Regression gate: `./tests/shim/run-checks.sh`.

## Provenance

The stack was captured 2026-11-14 from a working Debian 13 install; the 14 captured files were
sha256-verified byte-identical to their live counterparts (table in `MANIFEST.md` §4). The grader was
merged in from a separate repo and is kept as a worked example, not as a dependency of the stack.
