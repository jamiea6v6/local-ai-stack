#!/usr/bin/env python3
"""cw_filter - band-pass filter a USB sound card for CW listening on Debian 13.

Reads mono 16-bit PCM from an ALSA input device, band-pass filters it, and
plays the result on the output device in real time.

The filter state is carried across chunk boundaries. This matters: an IIR
filter restarted every chunk produces a discontinuity at every block edge,
which is audible as a click train at the block rate.

Usage:
    cw_filter.py --low 600 --high 900
    cw_filter.py --list-devices
"""

import argparse
import sys
import time

import numpy as np
from scipy import signal


def build_filter(low, high, rate, order=4):
    """Return (sos, zi) for a band-pass. sos form is numerically stable."""
    sos = signal.butter(order, [low, high], btype="band", fs=rate, output="sos")
    return sos, signal.sosfilt_zi(sos)


def process_chunk(sos, zi, chunk):
    """Filter one chunk of int16 PCM. Returns (out_int16_bytes, new_zi).

    The caller must carry new_zi into the next call. Dropping it restarts the
    filter every chunk, which clicks at the chunk rate.
    """
    samples = np.frombuffer(chunk, dtype=np.int16).astype(np.float64) / 32768.0
    filtered, new_zi = signal.sosfilt(sos, samples, zi=zi)
    out = np.clip(filtered * 32768.0, -32768.0, 32767.0).astype(np.int16)
    return out.tobytes(), new_zi


def build_parser():
    p = argparse.ArgumentParser(
        prog="cw_filter",
        description="Band-pass filter audio from a USB sound card for CW listening.",
    )
    p.add_argument("--low", type=float, default=100.0,
                   help="lower band edge in Hz (default: 600)")
    p.add_argument("--high", type=float, default=1000.0,
                   help="upper band edge in Hz (default: 900)")
    p.add_argument("--rate", type=int, default=48000,
                   help="sample rate in Hz (default: 48000)")
    p.add_argument("--chunk", type=int, default=1024,
                   help="frames per callback (default: 1024)")
    p.add_argument("--order", type=int, default=4,
                   help="Butterworth order (default: 4)")
    p.add_argument("--input-device", type=int, default=None,
                   help="ALSA input device index (default: system default)")
    p.add_argument("--output-device", type=int, default=None,
                   help="ALSA output device index (default: system default)")
    p.add_argument("--list-devices", action="store_true",
                   help="list audio devices with input/output channel counts")
    return p


def list_devices(pa):
    for i in range(pa.get_device_count()):
        d = pa.get_device_info_by_index(i)
        print(f"{i}: {d['name']}  in={d['maxInputChannels']} out={d['maxOutputChannels']} "
              f"rate={d['defaultSampleRate']:.0f}")


def main(argv=None):
    args = build_parser().parse_args(argv)

    if args.low <= 0 or args.high <= args.low:
        print("error: need 0 < --low < --high", file=sys.stderr)
        return 2
    if args.high >= args.rate / 2:
        print(f"error: --high must be below Nyquist ({args.rate / 2:.0f} Hz)", file=sys.stderr)
        return 2

    import pyaudio

    pa = pyaudio.PyAudio()
    try:
        if args.list_devices:
            list_devices(pa)
            return 0

        sos, zi = build_filter(args.low, args.high, args.rate, args.order)
        state = {"zi": zi}

        def callback(in_data, frame_count, time_info, status):
            if status:
                print(f"stream status: {status}", file=sys.stderr)
            try:
                out_bytes, state["zi"] = process_chunk(sos, state["zi"], in_data)
            except Exception as exc:  # keep the stream alive on a bad chunk
                print(f"filter error: {exc}", file=sys.stderr)
                out_bytes = bytes(len(in_data))
            # PyAudio requires (data, flag); returning None aborts the stream.
            return (out_bytes, pyaudio.paContinue)

        # One duplex stream. A separate output stream would never receive data:
        # PyAudio ignores the audio payload returned by an input-only callback.
        stream = pa.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=args.rate,
            input=True,
            output=True,
            input_device_index=args.input_device,
            output_device_index=args.output_device,
            frames_per_buffer=args.chunk,
            stream_callback=callback,
        )
        try:
            print(f"band {args.low:.0f}-{args.high:.0f} Hz @ {args.rate} Hz "
                  f"(Ctrl-C to stop)", file=sys.stderr)
            while stream.is_active():
                time.sleep(0.1)
        except KeyboardInterrupt:
            pass
        finally:
            stream.stop_stream()
            stream.close()
    finally:
        pa.terminate()
    return 0


if __name__ == "__main__":
    sys.exit(main())
