#!/usr/bin/env python3
"""Deterministic spec for a CW band-pass filter program.

Run:  python3 spec_cw_filter.py /path/to/candidate.py

Ground truth is fixed in advance. The candidate is driven as a real CLI
process against a FAKE USB sound card (a stub `pyaudio` injected via
PYTHONPATH), so no hardware and no model judgement are involved. The pass/fail
decision lives entirely in this file.

The fake reproduces PyAudio's real callback contract, because that is exactly
what candidates get wrong:

  * the callback is invoked as callback(in_data, frame_count, time_info, status)
    -- FOUR positional arguments, and
  * it must RETURN a (data, flag) tuple.

It also reproduces the rule that for an input-only stream the returned audio
is DISCARDED -- so a program that filters in an input callback and writes to a
separate output stream produces no audio at all, and is caught here.

Checks:

  1. exits without an unhandled traceback
  2. the audio callback is called with PyAudio's 4-argument signature
  3. the callback returns a 2-tuple
  4. filtered audio actually reaches an output (bytes are emitted)
  5. the requested band is honoured: the tone inside --low/--high survives
  6. the requested band is honoured: a tone outside it is rejected >= 18 dB
  7. filter state is carried across chunk boundaries (no click train)
  8. the band is configurable by CLI, and the default band suits CW

Pure stdlib: no numpy, no scipy. The candidate is run under an interpreter
that has them (auto-detected; see _candidate_python).

Exit code 0 when every check passes, non-zero otherwise, so Pi's `verify`
tool can use the exit code directly.
"""

import json
import math
import re
import os
import struct
import subprocess
import sys
import tempfile

# ---------------------------------------------------------------- constants

RATE = 48000
SECONDS = 1.0
CHUNK = 1024            # frames per callback call during the continuity run

# A band that is NOT the default, used to prove the CLI args are honoured.
TEST_LOW = 600.0
TEST_HIGH = 900.0
TEST_TONE = 700.0       # inside 600-900
TEST_OTHER = 300.0      # outside 600-900

# The band the program must default to when given no arguments: a CW sidetone
# filter. 700 Hz in, 300 Hz out.
DEFAULT_TONE = 700.0
DEFAULT_OTHER = 300.0

# A band deliberately different from the default. If the program honours the
# CLI, a tone inside this band passes and the default-band tone is rejected.
ALT_LOW = 1500.0
ALT_HIGH = 2100.0
ALT_TONE = 1800.0

MIN_REJECTION_DB = 18.0

# A pure sine of amplitude A at frequency f sampled at fs has a maximum
# sample-to-sample step of 2*A*sin(pi*f/fs). A filter that resets its state
# every chunk produces a much larger step at the boundary. Factor 4 leaves
# room for legitimate filter ringing while catching the reset.
CONTINUITY_FACTOR = 4.0

# ---------------------------------------------------------------- helpers

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print("%-4s %-52s %s" % ("PASS" if ok else "FAIL", name, detail))
    return bool(ok)


def goertzel(samples, freq, rate):
    """Magnitude of `freq` in `samples` (single-bin DFT)."""
    n = len(samples)
    if n == 0:
        return 0.0
    w = 2.0 * math.pi * freq / rate
    coeff = 2.0 * math.cos(w)
    s1 = s2 = 0.0
    for x in samples:
        s0 = x + coeff * s1 - s2
        s2 = s1
        s1 = s0
    real = s1 - s2 * math.cos(w)
    imag = s2 * math.sin(w)
    return math.sqrt(real * real + imag * imag) / n


def read_pcm16(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    count = len(raw) // 2
    return list(struct.unpack("<%dh" % count, raw[: count * 2]))


def candidate_python():
    """Find an interpreter that has numpy and scipy.

    The spec itself needs neither. The candidate does, so the candidate is
    run under whichever interpreter can import them.
    """
    candidates = []
    env = os.environ.get("CW_SPEC_PYTHON")
    if env:
        candidates.append(env)
    candidates.append(sys.executable)
    candidates += [
        os.path.expanduser("~/projects/local-ai-stack/grader/.venv/bin/python3"),
        os.path.expanduser("~/miniconda3/bin/python3"),
        "/usr/bin/python3",
    ]
    probe = "import numpy, scipy.signal"
    for exe in candidates:
        if not exe or not os.path.exists(exe):
            continue
        try:
            r = subprocess.run([exe, "-c", probe], capture_output=True, timeout=60)
            if r.returncode == 0:
                return exe
        except (OSError, subprocess.SubprocessError):
            continue
    return None


def parses_argv(exe, candidate, stub_dir, extra_args=()):
    """Does the candidate actually look at its command line?

    Measured gap: a candidate that hardcodes `parse_args([])` ignores every
    flag. Flag discovery then finds nothing (its --help is never reached), the
    band tests fall back to whatever the defaults are, and a program whose
    default band happens to be right looks perfect. It must be caught
    explicitly.

    The probe: pass a flag that cannot exist. A program that parses argv
    rejects it with "unrecognized arguments"; a program that ignores argv runs
    happily. This is decided by the program's own behaviour, not by guessing.

    extra_args must carry any REQUIRED flags. argparse checks missing required
    arguments before it complains about an unknown one, so a candidate that
    demands --input-device would otherwise exit with "the following arguments
    are required" and the probe would misread that as "does not parse argv".
    """
    env = dict(os.environ)
    env["PYTHONPATH"] = stub_dir + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    try:
        r = subprocess.run(
            [exe, candidate] + list(extra_args) + ["--cw-spec-nonexistent-flag-xyzzy"],
            env=env, capture_output=True, timeout=20, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        # It kept running: it accepted the junk flag, so it ignores argv.
        return False
    except (OSError, subprocess.SubprocessError):
        return True
    text = ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", "replace").lower()
    if "unrecognized" in text or "unknown option" in text or "invalid choice" in text:
        return True
    # argparse stops at missing required arguments before it reaches the unknown
    # flag, so an unrecognised-flag complaint is absent even though argv IS
    # being parsed. Treat "required arguments" as proof that argv is parsed.
    return "required" in text and ("argument" in text or "arguments" in text)


def discover_flags(exe, candidate, stub_dir):
    """Find the candidate's own flag names by reading its --help output.

    The spec must test BEHAVIOUR, not a particular flag spelling. A measured
    attempt used --low-cut/--high-cut and required --input-device/--output-device;
    a spec that hardcoded --low/--high simply could not run it, and reported
    "no audio" for a program that was never given a chance to produce any.
    """
    env = dict(os.environ)
    env["PYTHONPATH"] = stub_dir + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    try:
        r = subprocess.run([exe, candidate, "--help"], env=env, capture_output=True,
                           timeout=30, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return {}
    text = (r.stdout or b"").decode("utf-8", "replace") + "\n" + \
           (r.stderr or b"").decode("utf-8", "replace")
    low = high = None
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("-"):
            continue
        name = line.split()[0].lstrip("-").split("=")[0]
        lowish = name.lower()
        if "low" in lowish and "cut" not in lowish or lowish in ("lowcut", "low-cut", "low_hz"):
            if low is None:
                low = name
        if "high" in lowish and "cut" not in lowish or lowish in ("highcut", "high-cut", "high_hz"):
            if high is None:
                high = name
    flags = {}
    if low and high:
        flags["low"] = low
        flags["high"] = high
    return flags


def discover_required(exe, candidate, stub_dir):
    """Find required flags the candidate refuses to run without.

    A candidate may require --input-device/--output-device. The fake sound card
    exposes device 0 (input) and device 1 (output), so those can be supplied.
    Anything else required is reported so the spec can fail loudly rather than
    silently scoring a program that never ran.
    """
    env = dict(os.environ)
    env["PYTHONPATH"] = stub_dir + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    try:
        r = subprocess.run([exe, candidate, "--help"], env=env, capture_output=True,
                           timeout=30, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return []
    text = (r.stdout or b"").decode("utf-8", "replace")
    required = []
    # argparse prints required options on their own line, with the metavar on the
    # NEXT line. So the option line itself carries no "required" marker; the
    # invocation line at the top does: "--input-device INPUT_DEVICE".
    #
    # The usage block WRAPS, so the required option may land on a continuation
    # line. Collect the whole block (until the first blank line) rather than one
    # line.
    usage_lines = []
    in_usage = False
    for line in text.splitlines():
        if line.strip().startswith("usage:"):
            in_usage = True
            usage_lines.append(line)
            continue
        if in_usage:
            if not line.strip():
                break
            usage_lines.append(line)
    invocation = " ".join(usage_lines)

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("-"):
            continue
        name = stripped.split()[0].lstrip("-").split("=")[0]
        if "device" not in name.lower():
            continue
        # Required if the usage block lists it WITHOUT brackets.
        if re.search(r"--" + re.escape(name) + r"(?![^\s]*\])", invocation):
            required.append(name)
    return required


def build_band_args(flags, required, low, high):
    """Band args plus any required device flags the candidate insists on."""
    args = []
    if flags:
        args += ["--" + flags["low"], str(low), "--" + flags["high"], str(high)]
    for name in required:
        # The fake card 0 has inputs, card 1 has outputs.
        value = "1" if "output" in name.lower() else "0"
        args += ["--" + name, value]
    return args


def dedupe_args(args):
    """Drop repeated flags, keeping the last occurrence of each.

    The usage block and the option list can both name the same required option,
    so discovery can return it twice. Passing it twice makes argparse exit with
    an error, which would look like a program failure rather than a spec bug.
    """
    seen = {}
    order = []
    i = 0
    while i < len(args):
        if args[i].startswith("--"):
            name = args[i]
            if i + 1 < len(args) and not args[i + 1].startswith("--"):
                seen[name] = [name, args[i + 1]]
                i += 2
                continue
            seen[name] = [name]
            i += 1
            continue
        i += 1
    out = []
    for name, val in seen.items():
        out.extend(val)
    return out


def run_candidate(exe, candidate, stub_dir, tone, chunk, extra_args, timeout=45):
    """Run the candidate against the fake sound card.

    Returns dict with events, output samples, returncode and stderr.

    The fake card stops the program with KeyboardInterrupt once it has handed
    over its audio budget, so a realtime filter exits through its normal
    "ctrl-C" path in about a second. The timeout here is only a backstop for a
    program that ignores the interrupt; it must stay well under the `verify`
    tool's own 60 s limit, because the spec runs six programs and the model
    needs a report rather than a timeout.
    """
    events_path = os.path.join(stub_dir, "events.jsonl")
    out_raw = os.path.join(stub_dir, "out.raw")
    for p in (events_path, out_raw):
        if os.path.exists(p):
            os.remove(p)

    env = dict(os.environ)
    # The stub must WIN over any real pyaudio, and over a copy of the stub
    # sitting next to the candidate. PYTHONPATH comes after the script's own
    # directory in sys.path, so a candidate directory containing pyaudio.py
    # would shadow it — which is how a candidate ended up importing the REAL
    # pyaudio and failing with "PortAudio library not found".
    #
    # The fix: run the candidate with the stub dir as its WORKING DIRECTORY
    # and put the stub first on PYTHONPATH. Python puts the script's directory
    # ahead of PYTHONPATH, so the candidate is invoked by absolute path from a
    # different cwd — then its own directory is not on sys.path at all.
    env["PYTHONPATH"] = stub_dir + os.pathsep + env.get("PYTHONPATH", "")
    env["CW_SPEC_FREQ"] = str(tone)
    env["CW_SPEC_CHUNK"] = str(chunk)
    env["CW_SPEC_RATE"] = str(RATE)
    env["CW_SPEC_EVENTS"] = events_path
    env["CW_SPEC_OUTPUT_RAW"] = out_raw
    env["PYTHONDONTWRITEBYTECODE"] = "1"

    cmd = [exe, candidate] + list(extra_args)
    timed_out = False
    try:
        r = subprocess.run(cmd, env=env, capture_output=True, timeout=timeout,
                           stdin=subprocess.DEVNULL, cwd=stub_dir)
        rc, stderr = r.returncode, r.stderr.decode("utf-8", "replace")
    except subprocess.TimeoutExpired as exc:
        rc = None
        timed_out = True
        stderr = (exc.stderr or b"").decode("utf-8", "replace")

    events = []
    if os.path.exists(events_path):
        with open(events_path) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except ValueError:
                    pass

    out_samples = read_pcm16(out_raw) if os.path.exists(out_raw) else []

    return {"events": events, "out": out_samples, "rc": rc, "stderr": stderr,
            "timed_out": timed_out}


def events_of(events, kind):
    return [e for e in events if e.get("event") == kind]


def used_rate(run, fallback=RATE):
    """The sample rate the candidate actually opened its stream with.

    A candidate may pick 44100 while the stub defaults to 48000. Measuring the
    output at the wrong rate pitches every tone wrong and makes a working
    filter look broken.
    """
    for e in run["events"]:
        if e.get("event") == "open" and e.get("rate"):
            return int(e["rate"])
    return fallback


def amplitude(run, freq):
    """Magnitude of `freq` in the captured output.

    Only the first second of output is measured. A candidate that writes in a
    tight loop without pacing to the sample rate can emit far more audio than
    the stub injected, and averaging over all of it dilutes the tone.
    """
    samples = run["out"]
    rate = used_rate(run)
    limit = int(rate)
    if len(samples) > limit:
        samples = samples[:limit]
    return goertzel(samples, freq, rate)


def rejection_db(run, keep_freq, kill_freq):
    """dB between the kept and rejected tones, measured from two separate runs."""
    a_keep = amplitude(run["keep"], keep_freq)
    a_kill = amplitude(run["kill"], kill_freq)
    if a_keep <= 1e-9:
        return 0.0
    if a_kill <= 1e-12:
        return 99.0
    return 20.0 * math.log10(a_keep / a_kill)


# -------------------------------------------------------------- main spec

def main(argv):
    if len(argv) < 2:
        print("usage: spec_cw_filter.py <candidate.py>", file=sys.stderr)
        return 2
    candidate = os.path.abspath(argv[1])
    if not os.path.exists(candidate):
        print("candidate not found: %s" % candidate, file=sys.stderr)
        return 2

    exe = candidate_python()
    if not exe:
        check("environment: numpy+scipy available", False,
              "no interpreter with numpy and scipy; set CW_SPEC_PYTHON")
        return report()
    check("environment: numpy+scipy available", True, exe)

    here = os.path.dirname(os.path.abspath(__file__))
    stub_src = os.path.join(here, "stub_pyaudio.py")
    with open(stub_src) as fh:
        stub_text = fh.read()

    def new_stub():
        d = tempfile.mkdtemp(prefix="cw_spec_")
        with open(os.path.join(d, "pyaudio.py"), "w") as fh:
            fh.write(stub_text)
        return d

    # Discover the candidate's own flag names rather than assuming --low/--high.
    #
    # Order matters: required flags are found first, because the argv probe has
    # to supply them, and only then can the probe answer the real question.
    d0 = new_stub()
    required = discover_required(exe, candidate, d0)
    device_args = dedupe_args(
        [x for n in required for x in ("--" + n, "1" if "output" in n.lower() else "0")])
    argv_aware = parses_argv(exe, candidate, d0, device_args)
    flags = discover_flags(exe, candidate, d0) if argv_aware else {}
    band_args = dedupe_args(build_band_args(flags, required, TEST_LOW, TEST_HIGH))
    alt_args = dedupe_args(build_band_args(flags, required, ALT_LOW, ALT_HIGH))
    print("     parses argv: %s" % argv_aware)
    print("     discovered band flags: %s" % (flags or "none (defaults only)"))
    print("     required device flags: %s" % (required or "none"))
    print("     band args used: %s" % (" ".join(band_args) or "(none)"))

    # ---- explicit band: tone inside, tone outside, and chunked continuity
    d1 = new_stub()
    r_in = run_candidate(exe, candidate, d1, TEST_TONE, 0, band_args)
    r_out = run_candidate(exe, candidate, d1, TEST_OTHER, 0, band_args)
    r_cont = run_candidate(exe, candidate, d1, TEST_TONE, CHUNK, band_args)

    # ---- default band (no CLI args): tone inside, tone outside
    d2 = new_stub()
    r_def_in = run_candidate(exe, candidate, d2, DEFAULT_TONE, 0, device_args)
    r_def_out = run_candidate(exe, candidate, d2, DEFAULT_OTHER, 0, device_args)

    # ---- a band deliberately different from the default, to prove the CLI
    #      arguments are actually honoured rather than ignored.
    d3 = new_stub()
    r_alt_in = run_candidate(exe, candidate, d3, ALT_TONE, 0, alt_args)
    r_alt_out = run_candidate(exe, candidate, d3, TEST_TONE, 0, alt_args)

    # 1. no unhandled crash
    #
    # The fake card stops the program with KeyboardInterrupt, which these
    # programs catch as "ctrl-C". So a clean exit is the expected path. What
    # matters is whether it died some other way: a traceback in stderr is a
    # hard fail.
    err = r_in["stderr"] or ""
    trace = "Traceback (most recent call last)" in err
    check("1. runs without an unhandled traceback", not trace,
          err.strip().splitlines()[-1][:80] if trace else
          ("still running at timeout" if r_in["timed_out"] else "clean"))

    # 2. callback arity: the fake calls with 4 positional args
    #
    # Only applies if the candidate uses a stream_callback. A candidate may instead use
    # blocking read()/write(), which is a legitimate PyAudio pattern and needs no
    # callback. The check is therefore conditional on a callback being registered.
    # A callback that raises is a hard fail regardless.
    arity_exc = events_of(r_in["events"], "callback_exception")
    used_callback = any(e.get("has_callback") for e in events_of(r_in["events"], "open"))
    if used_callback:
        check("2. audio callback takes PyAudio's 4-arg signature", not arity_exc,
              arity_exc[0].get("error", "")[:70] if arity_exc else "ok")
    else:
        check("2. audio callback takes PyAudio's 4-arg signature", True,
              "no stream_callback used (blocking read/write)")

    # 3. callback returns a tuple
    rets = events_of(r_in["events"], "callback_return")
    bad_ret = [x for x in rets if not x.get("is_tuple") or x.get("len") != 2]
    if used_callback:
        check("3. callback returns a (data, flag) tuple", bool(rets) and not bad_ret,
              "no callback invoked" if not rets else
              ("returned %s" % rets[0].get("type")) if bad_ret else "ok")
    else:
        check("3. callback returns a (data, flag) tuple", True,
              "not applicable (no stream_callback)")

    # 4. audio reaches an output
    #
    # The detail matters as much as the verdict: a model that is told only
    # "0 samples emitted" has to guess what that means. Measured on a real Pi
    # run — the model correctly diagnosed that its filtered audio was being
    # thrown away, but could not tell WHICH call was wrong and burned several
    # turns guessing. Naming the cause turns a guess into an edit.
    if len(r_in["out"]) > 0:
        check("4. filtered audio reaches an output", True,
              "%d samples emitted" % len(r_in["out"]))
    else:
        opened = events_of(r_in["events"], "open")
        detail = "0 samples emitted"
        for o in opened:
            if o.get("input") and not o.get("output"):
                detail = ("0 samples emitted — the stream that receives the audio is "
                          "input-only. PyAudio DISCARDS the audio returned by an "
                          "input-only callback, so the filtered samples never reach "
                          "an output. Open ONE stream with input=True AND output=True "
                          "and return (bytes, paContinue) from its callback; or write "
                          "to a separate output stream explicitly.")
                break
            if o.get("output") and not o.get("input"):
                detail = ("0 samples emitted — an output-only stream was opened but "
                          "nothing was ever written to it. Write the filtered bytes "
                          "to it, or use a single duplex stream instead.")
                break
        if detail == "0 samples emitted":
            detail = ("0 samples emitted — no output stream received any data. "
                      "Open ONE stream with input=True AND output=True and return "
                      "(bytes, paContinue) from its callback.")
        check("4. filtered audio reaches an output", False, detail)

    if not r_in["out"]:
        return report()

    # 5. the requested band passes its interior tone
    a_in = amplitude(r_in, TEST_TONE)
    check("5. tone inside the band survives (700 Hz)", a_in > 0.02,
          "amplitude %.1f" % a_in)

    # 5b. the output LEVEL is sane.
    #
    # A filter has roughly unity gain, so an injected 0.3-amplitude tone should
    # come out at about 0.3 * 32767 = 9830. Two ways to get this wrong, both
    # measured on a real attempt:
    #   * scaling the int16 samples by 32767 a second time, which overflows
    #     int16 and wraps the waveform into noise
    #   * clipping, which flattens the wave and raises the out-of-band floor
    # Either way the tone "survives" while the audio is garbage, so the level has
    # to be checked separately from the tone.
    rate_in = used_rate(r_in)
    out_samples = r_in["out"][:int(rate_in)]
    if out_samples:
        peak = max(abs(s) for s in out_samples)
        clipped = sum(1 for s in out_samples if abs(s) >= 32700)
        clip_frac = clipped / len(out_samples)
        expected = 0.30 * 32767.0
        level_ok = 0.3 * expected <= peak <= 3.0 * expected and clip_frac < 0.01
        check("5b. output level is sane (no overflow, no clipping)",
              level_ok,
              "peak %.0f (expected ~%.0f), clipped %.2f%%" % (peak, expected, clip_frac * 100))
    else:
        check("5b. output level is sane (no overflow, no clipping)", False,
              "no output to measure")

    # 6. the requested band rejects a tone outside it
    rej = rejection_db({"keep": r_in, "kill": r_out}, TEST_TONE, TEST_OTHER)
    check("6. tone outside --low/--high rejected >= %d dB" % MIN_REJECTION_DB,
          rej >= MIN_REJECTION_DB, "%.1f dB down" % rej)

    # 7. filter state carried across chunk boundaries
    out_cont = r_cont["out"]
    if len(out_cont) > 2:
        max_step = max(abs(out_cont[i] - out_cont[i - 1])
                       for i in range(1, len(out_cont)))
        ideal = 2.0 * 0.30 * 32767.0 * math.sin(math.pi * TEST_TONE / used_rate(r_cont))
        limit = ideal * CONTINUITY_FACTOR
        check("7. filter state carried across chunk boundaries",
              max_step <= limit,
              "max step %.0f (limit %.0f)" % (max_step, limit))
    else:
        check("7. filter state carried across chunk boundaries", False,
              "not enough output to test")
    # 8. the band is configurable by CLI, and the default suits CW
    rejects_args = ("unrecognized arguments" in (r_def_in["stderr"] or "").lower())
    if rejects_args:
        check("8. band configurable via CLI (args required)", True,
              "program requires explicit --low/--high")
    else:
        a_def_in = amplitude(r_def_in, DEFAULT_TONE)
        rej_def = rejection_db({"keep": r_def_in, "kill": r_def_out},
                                DEFAULT_TONE, DEFAULT_OTHER)
        ok = a_def_in > 0.02 and rej_def >= MIN_REJECTION_DB
        check("8. default band suits CW (700 Hz in, 300 Hz out)", ok,
              "in %.1f, rejection %.1f dB" % (a_def_in, rej_def))

    # 9. the CLI arguments are honoured, not ignored
    #
    # A candidate that ignores argv entirely is a failure, even if its default
    # band happens to be correct: the user asked for a command line program.
    if not argv_aware:
        check("9. command line arguments are parsed and honoured", False,
              "program ignored an unknown flag, so it does not parse argv at all")
    elif flags:
        a_alt_in = amplitude(r_alt_in, ALT_TONE)
        a_alt_out = amplitude(r_alt_out, TEST_TONE)
        honours = (a_alt_in > 0.02 and a_alt_out <= a_alt_in * 0.13)
        check("9. CLI band args are honoured (band can be moved)", honours,
              "1800 Hz in %.1f, 700 Hz out %.1f" % (a_alt_in, a_alt_out))
    else:
        check("9. CLI band args are honoured (band can be moved)", False,
              "program parses argv but exposes no band flags to move")

    return report()


def report():
    failed = [name for name, ok, _ in RESULTS if not ok]
    print("\n%d/%d checks passed" % (len(RESULTS) - len(failed), len(RESULTS)))
    if failed:
        for name in failed:
            print("  FAILED: %s" % name)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
