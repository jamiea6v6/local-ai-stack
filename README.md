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
harness/extensions/    the 9 Pi extensions (the actual IP)
harness/models.json    provider, model, context window, sampling
harness/pi-AGENTS.md   the harness rules (short on purpose — every line costs per turn)
harness/settings.json  pi's own settings
systemd/               the shim's user unit
tools/                 the Ollama /v1 shim + raise-context.sh (why /v1 needs a shim: MANIFEST §2)
tests/                 the pre-registered local-agent test suite (snapshot)
grader/                the worked example: CW filter + deterministic grader + mutants
docs/FRIEND-KIT.md     build guide for a 2× P106-100 box
```

## Deploying

```bash
git clone <this repo> ~/projects/local-ai-stack
cd ~/projects/local-ai-stack
./bootstrap.sh          # coming — Wednesday
./verify-stack.sh       # coming — Wednesday; prints PASS/FAIL per check
```

Until `bootstrap.sh` lands, the manual sequence is in `MANIFEST.md` §2–3. The short version:
NVIDIA driver **550.163.01** → Ollama **0.32.15** → Node **22** in `~/.local/node` → Pi **1.1.0** →
copy `harness/` into `~/.pi/agent/` → install the shim unit (rewrite its `ExecStart` to this repo) →
pull `gemma4:e4b-it-qat` → `apt install libportaudio2`.

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

## Known bugs in the captured harness

Fixed in the source of truth, not yet in this capture — see `MANIFEST.md` §6:

- `context-budget.ts` still assumes an 8192-token window while the shim provides 32768, so it trims
  ~2340 tokens per turn for a window the box does not have.
- `verify-package.ts` reports "DOES NOT EXIST" when its probe fails, not only when a package is
  genuinely absent (it produced three false negatives on numpy/scipy/sounddevice).

## Provenance

The stack was captured 2026-11-14 from a working Debian 13 install; the 14 captured files were
sha256-verified byte-identical to their live counterparts (table in `MANIFEST.md` §4). The grader was
merged in from a separate repo and is kept as a worked example, not as a dependency of the stack.
