# The 2× P106-100 Local AI Box — a build guide

Written from brain1, which runs one P106-100 and is now a working reference.
Target: an i7-7th-gen box with **two** P106-100s and **16 GB RAM**, built to
learn local AI/LLM running rather than to be a production server.

Everything here was measured on brain1 unless marked as guidance.

---

## 0. The thing that will waste your weekend

**A P106-100 is not a CUDA card. It runs Ollama on the Vulkan path.**

The P106-100 is a mining card: GP106, compute capability 6.1, no tensor cores.
Ollama's docs say NVIDIA GPUs with compute capability 5.0–6.2 need driver
570+. Brain1 runs **driver 550.163.01** and works fine.

That contradiction is the single most confusing thing for a newcomer, and the
answer is precise:

> The 570 requirement applies to the **CUDA** path only. Brain1 uses **Vulkan**,
> which has no such requirement. The thing that actually decides whether a
> model runs is **VRAM**, not the driver.

So: do not chase the driver. Check the VRAM. This exact false premise cost
brain1 a debugging cycle before it was pinned down.

Confirm your own card:

```bash
nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv
```

`compute_cap` may be missing on some drivers; `nvidia-smi -q | grep -i "compute cap"`
always works.

---

## 1. Hardware notes

| Part | Why it matters |
|---|---|
| **2× P106-100** | 6 GB each = **12 GB total VRAM**. Two cards do NOT make one 12 GB card — Ollama splits a model across them. See §5. |
| **i7-7th gen** | AVX2, no AVX-512. Ollama's CPU fallback is fine but slow. **16 GB RAM is the real limit for loading models** — see §5. |
| **16 GB RAM** | Ollama stages model weights through RAM on load. A 12 GB model needs ~12 GB of RAM free, plus ~1.5 GB overhead. Tight but workable. See §5. |
| **NVMe / SSD** | Model blobs. A 12B Q4 is ~8 GB on disk. Budget 20 GB+ free. |
| **Power** | Two 200 W cards are a space heater. Mining cards are often 2-slot and loud. Consider one card to start. |

**The P106-100 has no tensor cores and no native FP16.** Pascal consumer parts
run FP16 at **1/64 of FP32**. This does not stop Ollama (it quantises to Q4),
but it means: do not expect fp16 paths, and do not expect 3070-Ti-class
throughput. Brain1 gets ~30 tok/s on a 4B-active model.

---

## 2. Install Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
systemctl enable ollama
```

**Then set the context window.** This is the single most important
configuration step, and the default will disappoint you.

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null <<'EOF'
[Service]
Environment="OLLAMA_CONTEXT_LENGTH=16384"
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
EOF
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

Why each one:

- **`OLLAMA_CONTEXT_LENGTH`** — Ollama otherwise guesses from VRAM. Measured on a
  6 GB P106-100: it picked **4096**. That is nowhere near enough to work. The
  KV rate for a 4B-active model is ~**9.5 MiB per 1k tokens**, so context is
  cheap in VRAM:
  ```
  ctx= 8192  ->  4086 MiB
  ctx=16384  ->  4162 MiB   (+76 MiB)
  ctx=32768  ->  4314 MiB   (+228 MiB)
  ```
  Set it explicitly. **Do not try to change it per-request through the
  OpenAI-compatible `/v1` endpoint — that endpoint ignores `num_ctx`.** Only
  the native `/api/generate` and `/api/chat` honour it. If your client speaks
  `/v1` (most do), the server env var is the only knob.

- **`OLLAMA_FLASH_ATTENTION=1`** — attention on a Pascal card is expensive
  without it.

- **`OLLAMA_KV_CACHE_TYPE=q8_0`** — halves KV memory versus f16. On 6 GB of
  VRAM, that is the difference between 16K and 8K of context.

Verify:

```bash
curl -s http://127.0.0.1:11434/api/ps | python3 -m json.tool
# context_length should be 16384, not 4096
```

---

## 3. Pick models that fit

**VRAM is the binding constraint, and with two cards it is a per-card
constraint, not a pooled one.**

Ollama's `OLLAMA_SCHED_SPREAD` decides whether a model is split across both
cards. **Do not enable it by default.** Brain1 measured the failure: with
`OLLAMA_SCHED_SPREAD=1`, a model straddling a fast card and a slow one
collapsed from 21.6 tok/s to 2.6 tok/s as the context grew, because decode is
bound by KV-cache read bandwidth, not compute. Two *identical* P106-100s will
not be as lopsided as a fast+slow pair, but the mechanism is the same, and
splitting also costs you the single-card simplicity.

Start with **one card and one model that fits comfortably**:

| Model | Size | Notes |
|---|---|---|
| `gemma4:e4b-it-qat` | 6.1 GB | ~30 tok/s on one P106-100. Brain1's daily driver. Good at tool use when QAT. |
| `gemma4:12b-it-qat` | 7.2 GB | Fits one card. Needs both cards only if you raise the context. |
| `gemma4:26b` | 19 GB | **Does not fit** 12 GB of VRAM. It will spill to RAM and crawl. |

```bash
ollama pull gemma4:e4b-it-qat
ollama run gemma4:e4b-it-qat
```

**On 16 GB of RAM:** a 12 GB model needs most of it staged, leaving little for
everything else. Keep the daily model small (6 GB) and treat bigger models as
occasional experiments that need the machine to itself.

---

## 4. Ollama with two cards

Both cards are visible to Ollama automatically. Useful commands:

```bash
nvidia-smi --query-gpu=index,name,memory.used --format=csv   # which card holds what
ollama ps                                                  # model, size, and VRAM split
```

Two deliberate, different strategies:

**Strategy A — one card, one model (recommended to start).**
Unset `OLLAMA_SCHED_SPREAD`. Ollama loads a model onto the first card that
fits. Leave the second card free. This is the fast, predictable option and it
is what brain1 does with one card.

**Strategy B — spread, deliberately.**
```bash
sudo systemctl edit ollama
# [Service]
# Environment="OLLAMA_SCHED_SPREAD=1"
```
Only worth it when a model *must* be split (a 12B at 32K context, say).
Measure before and after:

```bash
ollama run gemma4:12b-it-qat --verbose "count from 1 to 100"
```
Read `eval rate` from the output. If it is under ~10 tok/s, split is hurting you
— the KV is being read over PCIe. Revert.

**Never put a model on both cards while another is loaded.** Ollama's
`MAX_LOADED_MODELS` default is fine; leave it.

---

## 5. RAM and VRAM: the arithmetic that matters

For a model of size S (GB) at context C:

```
VRAM needed  ≈ S  +  C/1000 × 9.5 MiB   (×1.1 for the compute buffer)
RAM needed   ≈ S  +  ~1.5 GB            (staging + runtime)
```

Examples for the 2× P106-100 / 16 GB box:

| Model | Context | VRAM | RAM | Verdict |
|---|---|---|---|---|
| gemma4:e4b (6.1 GB) | 16K | ~6.4 GB | ~7.6 GB | **comfortable** |
| gemma4:e4b (6.1 GB) | 32K | ~6.4 GB | ~7.6 GB | comfortable, +0.2 GB |
| gemma4:12b (7.2 GB) | 16K | ~7.5 GB | ~8.7 GB | fits one card, tight on RAM |
| gemma4:12b (7.2 GB) | 32K | ~7.6 GB | ~8.7 GB | fine |
| gemma4:26b (19 GB) | any | — | ~20.5 GB | **does not fit 16 GB RAM** |

Note the 12B needs **both** cards only if the context demands it — at 7.2 GB
of weights it fits on one 6 GB card only if the context is small; otherwise it
must split, and see Strategy B's warning.

---

## 6. The harness: this is the part people skip and shouldn't

A local 4B model will write you a broken program and describe it confidently.
On brain1, a single prompt produced code that **crashed on startup** (wrong
PyAudio callback arity), **produced no audio at all** (filtered data written to
a buffer the library discards), **restarted the filter every chunk** (audible
click train), and recommended **package names that do not exist on Debian 13**.
All of it looked completely plausible.

The fix is not a better model. It is a **deterministic grader** that the model
must run, plus a **harness that forces lookups**.

### 6a. A deterministic spec

Any Python script that takes the candidate path as `argv[1]`, imports it, runs
assertions, and exits 0 on success works as a grader. A worked example is in
`spec_cw_filter.py` in brain1's `~/projects/local-ai-stack/grader/` — it drives a program
against a **fake sound card** (a stub `pyaudio` injected via `PYTHONPATH`),
measures the actual audio output, and catches every one of the failure classes
above. The key trick:

> **Mock the hardware, not the logic.** The stub reproduces the library's real
> contract (callback arity, return shape, "input-only streams discard returned
> audio"), so a program that misunderstands the API dies exactly the way it
> would die against real hardware — deterministically, with no sound card.

### 6b. A harness that forces verification

Two hooks on brain1's Pi harness (the `pi` coding agent):

- **`before_agent_start`** injects a "look this up first" instruction *before*
  the model's first token. This matters more than it sounds: when the same
  instruction was injected *after* the model answered (a settle-time hook), the
  model had already spent ~2600 tokens on an unverified answer and the
  conversation had no room left for the evidence. It died with
  `stopReason=length` and **no output at all**. Searching first, then
  answering once, is what fits.
- **`before_agent_start`** also tells the model to **write code to a file**, and
  to **run the grader** rather than reasoning about whether its output is right.

The general principle, which is what you should actually copy:

> **The model must never be the judge of its own output.** A separate process
> decides pass/fail. The model reads the failures and fixes them.

### 6c. A rule for the model's own context budget

On a small card the context window is the scarcest resource you have — scarcer
than VRAM, because VRAM you can measure and context you cannot. Two rules:

1. **Keep the harness's AGENTS.md short.** Every line is paid for on every turn.
   Brain1's Pi baseline prompt was ~4700 tokens of an 8192 window; ~2340 of
   that was one doc file and ~929 another. Measure your own:
   ```bash
   # run a one-word prompt in a directory with no AGENTS.md in its ancestry,
   # then the same in a directory with one, and compare `input` token counts
   ```
2. **Cap what your tools return.** A web fetch that returns 8 KB costs ~2000
   tokens. On brain1 that cap was cut to 3 KB, and web search results from 8
   down to 5 — which bought back enough room for search + fetch + program +
   verification to fit in one window.

---

## 7. Debian specifics that will bite you

- **PEP 668.** `pip install` into the system Python fails with
  `externally-managed-environment`. Use a venv, or `apt install python3-numpy
  python3-scipy` (Debian packages them), or `pipx`.
- **`pyaudio` needs the headers.** `pip install pyaudio` fails with
  `portaudio.h: No such file or directory` unless you install
  `sudo apt install portaudio19-dev`. Better: `sudo apt install python3-pyaudio`
  (0.2.13 in trixie), which needs no compiler. Note the package is
  **`portaudio19-dev`** — there is no package called `portaudio`.
- **Package names are worth verifying.** On Debian 13 the real answers are
  `python3-pyaudio`, `python3-numpy`, `python3-scipy`. A model that says
  `apt install portaudio` is wrong; the library is `portaudio19-dev` and the
  binding is `python3-pyaudio`.
- **`arecord -l` / `aplay -l`** to see sound cards; `aplay -L` for formats.

---

## 8. A worked sanity check

Prove the whole stack before trusting it:

```bash
# 1. the GPU is visible and Ollama is on the Vulkan path
nvidia-smi --query-gpu=name,memory.total --format=csv
curl -s http://127.0.0.1:11434/api/ps | python3 -m json.tool

# 2. the model actually generates
ollama run gemma4:e4b-it-qat "reply with the word ok"

# 3. the context window is what you think it is
curl -s http://127.0.0.1:11434/api/ps | grep -o '"context_length":[0-9]*'

# 4. VRAM headroom after loading
nvidia-smi --query-gpu=memory.used,memory.total --format=csv

# 5. the harness grades its own output
python3 spec_cw_filter.py candidate.py ; echo "exit=$?"   # 0 = every check passed
```

If step 3 says 4096, your `OLLAMA_CONTEXT_LENGTH` did not take effect.

---

## 9. What to expect

- A 4B model on one P106-100: **~30 tok/s**. Fine for tool-calling agents
  with a deterministic grader. Not fine for open-ended research.
- Two cards **do not double your speed** for one model. They mostly give you
  *room* — a bigger model, or a bigger context, or two models at once.
- The KV-cache bandwidth cliff (C-04 in brain1's ledger) is real: decode speed
  falls off a cliff as context grows on a card whose VRAM is reached over
  PCIe. If your numbers collapse as the conversation gets long, that is why.
- The most valuable thing you will build is **not** the model. It is the
  grader.

---

## 10. Where the details live

brain1's `~/projects/local-ai-stack/grader/`:
- `cw_filter.py` — a working reference implementation (passes 11/11)
- `spec_cw_filter.py` — the deterministic grader, and the pattern to copy
- `stub_pyaudio.py` — the fake sound card
- `mutants/` — deliberately broken variants, one per bug class, used to prove
  the grader actually catches them
- `tools/raise-context.sh` — the measured context-window bump

brain1's Pi harness:
- `~/.pi/agent/extensions/enforce-search.ts` — forces lookups before answers
- `~/.pi/agent/AGENTS.md` — the harness rules (keep it short!)
- `~/.pi/agent/gate-log.md` — what the gates decided and why
