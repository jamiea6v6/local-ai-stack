"""Fake pyaudio module used by spec_cw_filter.py.

Injected via PYTHONPATH so a candidate program can be driven end-to-end with
a synthetic USB sound card and no real hardware.

The fake reproduces PyAudio's real callback contract, because that contract is
exactly what a candidate can get wrong:

  * the callback is invoked as callback(in_data, frame_count, time_info, status)
    -- FOUR positional arguments, and
  * it must RETURN a (data, flag) tuple.

It also reproduces the rule that for an input-only stream the returned audio
is DISCARDED -- so a program that filters inside an input callback and writes
to a separate output stream produces no audio at all, and is caught here.

Environment variables:

  CW_SPEC_FREQ       frequency of the injected tone (Hz)
  CW_SPEC_CHUNK      frames per callback call (0 = one single call)
  CW_SPEC_RATE       sample rate
  CW_SPEC_EVENTS     path to the JSON-lines event log
  CW_SPEC_OUTPUT_RAW path to the captured output audio (raw int16 mono)
"""

import json
import math
import os
import struct
import sys

paInt16 = 8
paFloat32 = 3
paContinue = 0
paComplete = 1
paAbort = 2

_RATE = int(os.environ.get("CW_SPEC_RATE", "48000"))
_FREQ = float(os.environ.get("CW_SPEC_FREQ", "700"))
_CHUNK = int(os.environ.get("CW_SPEC_CHUNK", "0"))
_EVENTS = os.environ.get("CW_SPEC_EVENTS", "/tmp/cw_spec_events.jsonl")
_OUT_RAW = os.environ.get("CW_SPEC_OUTPUT_RAW", "/tmp/cw_spec_output.raw")

# At most this many bytes of output audio are kept (~16 s at 48 kHz mono int16).
CAPTURE_BYTES = 16 * 1024 * 1024
_captured = 0

# How much audio the fake card will hand over before it stops the program.
#
# A realtime filter loops forever, so without this the spec would have to wait
# out its timeout on every run — six runs times 30 s is three minutes, which
# blew the `verify` tool's own 60 s limit and left the model with a timeout
# instead of an actionable report.
#
# The card stops the program with KeyboardInterrupt, which is what these
# programs already catch as "user pressed ctrl-C". So the program shuts down
# through its normal path, and the spec gets a clean exit in about a second.
MAX_SECONDS = 1.0
_delivered = 0


class _StopProgram(BaseException):
    """Raised to end the candidate cleanly once the fake card's budget is spent.

    BaseException, not Exception: a candidate's own `except Exception` handlers
    must not swallow it. It is converted to SystemExit at the outermost level,
    which exits with status 0 and prints nothing.
    """


def _log(kind, **fields):
    fields["event"] = kind
    try:
        with open(_EVENTS, "a") as fh:
            fh.write(json.dumps(fields) + "\n")
    except OSError:
        pass


def _tone(n, phase=0.0, rate=None):
    r = rate or _RATE
    return [0.30 * math.sin(2 * math.pi * _FREQ * (phase + i) / r) for i in range(n)]


def _pcm(samples):
    return struct.pack("<%dh" % len(samples),
                       *[int(max(-1.0, min(1.0, s)) * 32767) for s in samples])


def _capture(data):
    """Record output audio so the spec can measure it.

    Capped: a candidate that writes in a tight loop without pacing to the sample
    rate can emit tens of millions of samples in the timeout window. The first
    second of audio is all the spec needs to measure the filter response.
    """
    global _captured
    if _captured >= CAPTURE_BYTES:
        return
    room = CAPTURE_BYTES - _captured
    if len(data) > room:
        data = data[:room]
    try:
        with open(_OUT_RAW, "ab") as fh:
            fh.write(data)
        _captured += len(data)
    except OSError:
        pass


class _Stream:
    def __init__(self, manager, **kw):
        self._manager = manager
        self._params = kw
        self._callback = kw.get("stream_callback")
        self._input = bool(kw.get("input"))
        self._output = bool(kw.get("output"))
        # Generate the test tone at the rate the CANDIDATE asked for. If the stub
        # injected 48 kHz audio into a stream the candidate opened at 44.1 kHz,
        # every tone would be pitched wrong and the filter would look broken
        # when it is not.
        self._rate = int(kw.get("rate") or _RATE)
        self._closed = False
        self._polls = 0
        _log("open", input=self._input, output=self._output,
             rate=kw.get("rate"), channels=kw.get("channels"),
             frames_per_buffer=kw.get("frames_per_buffer"),
             input_device_index=kw.get("input_device_index"),
             output_device_index=kw.get("output_device_index"),
             has_callback=self._callback is not None)
        if self._callback is not None:
            self._drive_callback()

    def _drive_callback(self):
        """Simulate the device handing the callback audio, and record what comes back."""
        global _delivered
        total = int(self._rate)  # one second
        call = _CHUNK if _CHUNK > 0 else total
        sent = 0
        while sent < total:
            n = min(call, total - sent)
            raw = _pcm(_tone(n, phase=sent, rate=self._rate))
            try:
                result = self._callback(raw, n, None, 0)
            except Exception as exc:  # noqa: BLE001
                _log("callback_exception", error="%s: %s" % (type(exc).__name__, exc))
                raise
            _log("callback_return", type=type(result).__name__,
                 is_tuple=isinstance(result, tuple),
                 len=len(result) if isinstance(result, (tuple, list)) else None)
            if isinstance(result, tuple) and len(result) == 2:
                data = result[0]
                nbytes = len(data) if data is not None else 0
                _log("callback_data", bytes=nbytes)
                # PyAudio discards the returned audio for an input-only stream.
                if self._output:
                    _capture(data if data is not None else b"")
            sent += n
            _delivered += n
            if _delivered >= int(self._rate * MAX_SECONDS):
                # Budget spent: stop the program the same way ctrl-C would.
                # The interrupt is raised inside open(), so it must not escape
                # as a traceback — it is turned into a clean exit below.
                raise _StopProgram()

    def read(self, frames, exception_on_overflow=False):
        """Hand over audio, then stop the program cleanly once the budget is spent.

        The stop is converted to SystemExit at the outermost level, so the
        program shuts down cleanly instead of the spec having to kill it and
        report a timeout.
        """
        global _delivered
        n = frames
        if _CHUNK > 0:
            n = min(n, _CHUNK)
        if _delivered >= int(self._rate * MAX_SECONDS):
            raise _StopProgram()
        data = _pcm(_tone(n, rate=self._rate))
        _delivered += n
        return data

    def write(self, data):
        _log("output_write", bytes=len(data))
        _capture(data)
        return len(data)

    def is_active(self):
        self._polls += 1
        return self._polls < 50 and not self._closed

    def is_stopped(self):
        return self._closed

    def start_stream(self):
        _log("start_stream")

    def stop_stream(self):
        _log("stop_stream")

    def close(self):
        self._closed = True
        _log("close")

class PyAudio:
    def __init__(self):
        _log("pyaudio_init")
    def get_device_count(self):
        return 2

    def get_device_info_by_index(self, index):
        return {
            "name": "Fake USB Sound Card" if index == 0 else "Fake Speakers",
            "maxInputChannels": 2 if index == 0 else 0,
            "maxOutputChannels": 0 if index == 0 else 2,
            "defaultSampleRate": float(_RATE),
        }

    def get_host_api_info_by_index(self, index):
        return {"name": "Fake ALSA"}

    def get_format_from_width(self, width, unsigned=True):
        return paInt16

    def open(self, *args, **kwargs):
        return _Stream(self, **kwargs)

    def terminate(self):
        _log("terminate")


# ---------------------------------------------------------------------------
# Clean exit.
#
# The fake card raises _StopProgram to end a candidate once its audio budget is
# spent. It has to surface as a normal exit, not a traceback: the spec treats a
# traceback as a crash, and it must not penalise a program that simply ran out
# of audio to process.
#
# Converting it at interpreter shutdown keeps the conversion outside the
# candidate's own try/except blocks, so a candidate cannot swallow it.
# ---------------------------------------------------------------------------


def _install_clean_exit():
    """Make _StopProgram exit the process with status 0 and no output."""
    original_excepthook = sys.excepthook

    def hook(exc_type, exc_value, exc_tb):
        if issubclass(exc_type, _StopProgram):
            raise SystemExit(0)
        original_excepthook(exc_type, exc_value, exc_tb)

    sys.excepthook = hook


_install_clean_exit()
