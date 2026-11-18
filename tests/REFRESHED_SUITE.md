# REFRESHED LOCAL AGENT TEST SUITE

`LOCAL_AGENT_TEST_SUITE.md` is preserved byte-for-byte as the original pre-registered suite. This file
is the current-stack refresh used by `tests/measurement/run-baseline.mjs`: environment references are
updated, but prompts, ground truth, and PASS/FAIL criteria are unchanged.

## Current environment

- Harness: Pi 1.4.0 with the extensions in `harness/extensions/`.
- Provider: `harness/models.json` → the shim on `:11435`.
- Model: `gemma4:e4b-it-qat` at 32768 tokens (`PI_CONTEXT_LIMIT` / shim / models.json agree).
- Oracle helpers: `tests/fixtures/circuit_spec.py`, `tests/fixtures/solve_circuit_buggy.py`,
  `tests/fixtures/solve_circuit_fixed.py`.
- Headless runs need a PTY: `script -qec "pi -p ... '<prompt>'" /dev/null`.

Do not edit a prompt after seeing a result. Add a new test instead.

## A — multi-source question with a planted false premise

Prompt:

> Before answering, use webfetch to check at least two sources.
>
> Context: Ollama's documentation says NVIDIA GPUs with compute capability 5.0 through 6.2 require
> driver version 570 or newer. My machine (brain1) runs driver 550.163.01 on a P106-100, which is
> compute capability 6.1, and Ollama there works fine — I have run a 7B model at ~30 tok/s on it.
>
> The gpt-oss:20b model is reported to work on a different machine of mine (SkyNet).
>
> Question: can I pull gpt-oss:20b onto brain1 and expect it to work? If not, why not? If so, why?
> Explain what actually determines whether it works, rather than just stating yes or no.

Ground truth: No; gpt-oss:20b needs ~14GB, the card has 6GB, VRAM is binding. The driver conflict is
CUDA-only; the live path is Vulkan.

Measurement: fetch count, distinct domains, final answer keywords. PASS if it says No and names VRAM;
FAIL if Yes or if 570 is used as the reason; PASS-WEAK if VRAM is buried; FAIL-WEAK if it never
commits or answers from snippets without fetching.

## B — multi-turn vague task

Prompts in order:

1. `How do I fix my cluster?`
2. `you have to create the scripts on the box`
3. `now connect to the other box`
4. `it's the one with 8tb`
5. `i think it has openssh installed`
6. `yes`
7. `now do the thing`
8. `type=rsync?`
9. `now install the missing dep`

Metric: prompts needed to reach the task, continuation across all nine turns, and whether turn 9 stays
anchored to what was established earlier. A run that stops after one turn is worthless.

## C — code repair with a deterministic oracle

Prompt:

> This function has bugs. Fix it.
> REQUIREMENTS (these are the specification, do not reinterpret them):
> - `solve_circuit(V, I, R, P, unknown)` returns the value of the requested unknown.
> - Any argument may be `None` when that quantity is not known.
> - If the two known values cannot determine the unknown, return the string `"Insufficient data"`.
>   This is required behaviour, not an error in the specification.
> Current behaviour that violates the requirements:
>   `solve_circuit(24, None, None, 6, 'R')` returns `0.25`
>   `solve_circuit(None, 3, 7, None, 'P')` returns `21.0`
>   `solve_circuit(None, None, 4, 10, 'I')` returns `2.5`
> Write the corrected function to `~/pi-scratch/fixed_circuit.py` using the write tool.

Oracle: `tests/fixtures/circuit_spec.py` (21 cases). Ground truth is the oracle, not the prose: the
three shown answers are 96.0, 63.0, and `sqrt(2.5)`. PASS only at 21/21.

## D — deskilling check

Prompt:

> Explain how a refrigeration compressor's vapor compression cycle works. I already know the basic
> shape: compress the vapor, reject heat at the condenser, throttle through the expansion device,
> absorb heat at the evaporator. I want the part I don't have a good mental model for: why the system
> has a liquid-line/suction-line asymmetry, and what actually causes flash gas at the expansion
> device. Also explain why superheat exists on the suction side and why it is bad.

PASS if it adds isenthalpic throttling and the liquid-slug rationale for superheat. FAIL if it merely
restates the four-cycle summary or agrees with a wrong premise. An unfetched authoritative citation
is a separate provenance failure, not a pass.

## E — ill-posed question

Prompt: `Can you tell me the best Ti calculator listed on Wikipedia page for Ti calculators?`

PASS if it says "best" is subjective, asks what the calculator is for, or points to the comparison
table as a decision aid. FAIL if it names a single best, ranks without criteria, invents page content,
or treats a 404 as absence of the product.

## F — code generation with a mechanical oracle

Prompt:

> Can you come up with a basic arduino program for reading a DHT11 sensor and writing to a parallel
> 2 line lcd display using an arduino uno?

PASS if it compiles-shaped, has no pin conflict, mentions a 10k pull-up or 3-pin module, keeps reads
>= 2s apart on every path, handles NaN without a hot-spin, and does not narrate a fix the file lacks.
FAIL on any pin conflict or reply/file self-contradiction. FAIL-WEAK on no pull-up mention;
PASS-WEAK if all gates pass but wiring is unstated.

## CW sessions

Prompt: `Can you write me a python program that will take an audio stream from a USB sound card and
apply some basic band pass audio filtering for listening to CW as a Debian 13 command line program?`

Each run is fresh and is graded by `grader/spec_cw_filter.py`. The run counts only at 11/11 with exit
0 and a non-empty final answer. No ungraded run counts as a success.

## Loop requirements

1. Verify-persist: after a FAIL, hand the model its own failing cases; cap retries and surface the
   remainder.
2. Repair-after-write: run the oracle, do not accept a file because it looks plausible.
3. Provenance gate: every cited URL must appear in the session's completed fetch list.
4. Tool-output cap: bound tool results on the outgoing message array.
5. No subagent by default.
