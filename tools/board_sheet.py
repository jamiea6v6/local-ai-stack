#!/usr/bin/env python3
"""Render a board fact sheet from refs/boards + arduino-cli.

The sheet is the file a brief points the agent at. It contains only facts the
repo can source: the pin map comes from refs/boards/<id>/pins.yaml (extracted
from the installed core), the FQBN from `arduino-cli board listall`, and the
logic level from specs.yaml. Anything unknown is written as UNKNOWN so the
model must ask instead of guessing.

Usage:
  tools/board_sheet.py --board wemos-d1
  tools/board_sheet.py --board wemos-d1 --out devices/wemos-d1.txt
  tools/board_sheet.py --list

Requires PyYAML (the grader venv has it).
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent
REFS = REPO / "refs" / "boards"


def find_cli():
    candidates = [os.environ.get("ARDUINO_CLI"), shutil.which("arduino-cli")]
    home = Path.home()
    candidates += [str(home / ".local/bin/arduino-cli"), str(home / "bin/arduino-cli")]
    for c in candidates:
        if c and Path(c).is_file() and os.access(c, os.X_OK):
            return c
    return None


def fqbn_for(display_name):
    """Exact display-name match from arduino-cli, never a guess."""
    cli = find_cli()
    if not cli:
        return None
    try:
        out = subprocess.run(
            [cli, "board", "listall"], capture_output=True, text=True, timeout=60, check=False
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None

    exact = []
    loose = []
    want = display_name.casefold()
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        fqbn = parts[-1]
        if ":" not in fqbn:
            continue
        name = " ".join(parts[:-1]).strip()
        key = name.casefold()
        if key == want:
            exact.append(fqbn)
        elif want in key or key in want:
            loose.append(fqbn)
    # arduino-cli spells names its own way ("Arduino UNO"); only accept a loose
    # hit when it is the single candidate, so "UNO Mini"/"UNO WiFi" never win.
    found = exact or loose
    return found[0] if len(found) == 1 else None


def human_bytes(n):
    if not n:
        return "UNKNOWN"
    if n % (1024 * 1024) == 0:
        return f"{n // (1024 * 1024)} MiB"
    if n % 1024 == 0:
        return f"{n // 1024} KiB"
    return f"{n} B"


def render(board_id, spec, pins_doc, fqbn):
    name = spec.get("display_name") or board_id
    logic = spec.get("logic_v")
    platform = spec.get("platform") or "UNKNOWN"
    pins = pins_doc.get("pins") or []
    adc = [p["name"] for p in pins if "adc" in (p.get("kinds") or [])]
    gaps = spec.get("spec_gaps") or []

    lines = [
        "# BOARD FACT SHEET — generated, do not edit",
        "# Rerun: tools/board_sheet.py --board %s" % board_id,
        "# If a value says UNKNOWN, write `QUESTION: ...` and stop. Do not search for hardware facts.",
        "",
        f"BOARD: {name}",
        f"REF: {board_id}",
        f"MCU: {spec.get('mcu') or 'UNKNOWN'}",
        f"FQBN: {fqbn or 'UNKNOWN'}",
        f"PLATFORM: {platform}",
        f"LOGIC LEVEL: {logic} V" if logic else "LOGIC LEVEL: UNKNOWN",
        f"FLASH: {human_bytes(spec.get('flash_bytes'))}",
        f"RAM: {human_bytes(spec.get('ram_bytes'))}",
        "ADC: " + (f"pins {', '.join(adc)}; reference range UNKNOWN — do not assume 5 V" if adc else "none in the ref"),
        "TOOLCHAIN: arduino-cli compile --fqbn " + (fqbn or "<FQBN>"),
        "",
        f"PINS (board label -> GPIO; source: {pins[0]['source'].split(':')[0] if pins else 'refs'})",
    ]

    for p in sorted(pins, key=lambda x: (x.get("gpio", 999), x["name"])):
        kinds = ",".join(p.get("kinds") or [])
        line = f"  {p['name']:<12} -> GPIO{p.get('gpio')}"
        if kinds:
            line += f"  ({kinds})"
        if p.get("notes"):
            line += "  NOTE: " + "; ".join(p["notes"])
        lines.append(line)

    notes = list(spec.get("notes") or [])
    if gaps:
        notes.append("spec gaps: " + ", ".join(gaps))
    if spec.get("logic_v_extraction"):
        notes.append("logic level source: " + spec["logic_v_extraction"])

    lines += ["", "NOTES"]
    lines += ["  - " + n for n in notes] if notes else ["  - none"]
    lines.append("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--board", help="board id under refs/boards/")
    ap.add_argument("--out", help="write the sheet here instead of stdout")
    ap.add_argument("--fqbn", help="override the FQBN looked up from arduino-cli")
    ap.add_argument("--list", action="store_true", help="list available board refs")
    args = ap.parse_args()

    if args.list:
        for d in sorted(p for p in REFS.iterdir() if p.is_dir()):
            print(d.name)
        return 0
    if not args.board:
        ap.error("--board <id> is required (see --list)")

    root = REFS / args.board
    if not root.is_dir():
        ap.error(f"no such ref: {root} (see --list)")
    try:
        spec = yaml.safe_load((root / "specs.yaml").read_text())
        pins_doc = yaml.safe_load((root / "pins.yaml").read_text())
    except FileNotFoundError as exc:
        ap.error(str(exc))
    except yaml.YAMLError as exc:
        ap.error(f"invalid YAML in {root}: {exc}")

    fqbn = args.fqbn or fqbn_for(spec.get("display_name") or "")
    text = render(args.board, spec, pins_doc, fqbn)

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text)
        print(f"wrote {out} ({len(text.splitlines())} lines, FQBN {fqbn or 'UNKNOWN'})")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
