# The CW-DSP grader — a CW band-pass filter, and the harness that checks it

A Debian 13 command-line program that takes audio from a USB sound card,
band-pass filters it, and plays the result — plus a deterministic test harness
that decides whether it actually works.

## Why this exists

On 2026-11-12 a Pi session on this box was asked for exactly this program.
The answer it produced was fluent, well-organised, and **broken in four ways
at once**:

| Bug | Effect | Caught by |
|---|---|---|
| PyAudio callback with 5 params | `TypeError` on the first callback — the program dies at startup | spec check 2 |
| Callback returned `None` | `SystemError: new style getargs format but argument is not a tuple` | spec check 3 |
| Filtered bytes written to an input stream's buffer | **no audio ever reaches the output** | spec check 4 |
| `lfilter` with default `zi` per chunk | filter restarts every 1024 samples — audible click train | spec check 7 |

Plus it recommended `apt install portaudio` (no such package on Debian 13) and
`pip install numpy scipy` (blocked by PEP 668), both from memory.

None of that was visible without running it. That is the point of this directory.

## Layout

```
cw_filter.py        the reference implementation — passes 11/11
spec_cw_filter.py   the grader. Deterministic; the pass/fail decision is here
stub_pyaudio.py     a fake USB sound card, injected via PYTHONPATH
mutants/            deliberately broken variants, one per bug class
model_attempt_*.py  real output from real Pi sessions, graded
tools/raise-context.sh   measured context-window bump (needs sudo)
FRIEND-KIT.md       build guide for a 2x P106-100 box
```

## Running the grader

```bash
export CW_SPEC_PYTHON=~/projects/local-ai-stack/grader/.venv/bin/python3
.venv/bin/python spec_cw_filter.py cw_filter.py ; echo "exit=$?"
```

Exit 0 means every check passed. The spec finds its own interpreter, so plain
`python3 spec_cw_filter.py <file>` works too.

### Why it is a fake sound card

The spec does not mock the *logic* — it mocks the *hardware*. The stub
reproduces PyAudio's real contract:

- the callback is called with **four** positional args
  (`in_data, frame_count, time_info, status`)
- it must **return** a `(data, flag)` tuple
- for an **input-only** stream, the returned audio is **discarded**

So a program that misunderstands the API dies the same way it would against
real PortAudio, deterministically, with no sound card and no hardware. The
spec then measures the actual output audio — band response, out-of-band
rejection, level sanity, and chunk-boundary continuity.

It is also **implementation-agnostic**: it discovers the candidate's own flag
names from `--help` and supplies any required device flags, so it grades a
program that uses `--low-cut/--high-cut` and blocking `read()`/`write()` just
as fairly as one that uses `--low/--high` and a callback.

## The checks

| # | Check |
|---|---|
| 1 | runs without an unhandled traceback (a realtime filter running at timeout is fine) |
| 2 | audio callback takes PyAudio's 4-arg signature |
| 3 | callback returns a `(data, flag)` tuple |
| 4 | filtered audio actually reaches an output |
| 5 | a tone inside the band survives |
| 5b | output level is sane — no int16 overflow, no clipping |
| 6 | a tone outside the band is rejected by >= 18 dB |
| 7 | filter state is carried across chunk boundaries (no click train) |
| 8 | the default band suits CW (700 Hz in, 300 Hz out) |
| 9 | command line arguments are parsed and honoured |

## Provenance

The grader is falsified, not asserted. Every bug class above has a mutant in
`mutants/`, and each mutant is caught:

```
cw_filter.py                    11/11 checks passed
broken_reference.py               1/5    (the original Pi output)
mutants/m1_arity.py               1/5
mutants/m2_return_none.py         3/5
mutants/m3_stateless.py          10/11
mutants/m4_wrong_band.py         10/11
mutants/m5_no_audio_path.py       4/5
mutants/m6_no_cli.py             10/11
model_attempt_2026-11-13.py      6/11   (a real Pi attempt, graded)
```

`m6_no_cli.py` is worth noting: it hardcodes `parse_args([])`, so it ignores
every flag. The spec catches it with a direct probe (pass a flag that cannot
exist and see whether the program rejects it) rather than by assuming a
particular flag spelling.

## Using it from the Pi harness

The harness is wired to this grader in `~/.pi/agent/AGENTS.md`:

```
verify(spec="~/projects/local-ai-stack/grader/spec_cw_filter.py",
       candidate="~/projects/local-ai-stack/grader/cw_filter.py")
```

The rule the harness enforces: **the model must never be the judge of its own
output.** A separate process decides pass/fail; the model reads the failures
and fixes them.
