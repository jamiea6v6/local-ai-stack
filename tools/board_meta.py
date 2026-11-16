#!/usr/bin/env python3
"""Generate board pin/spec maps from real toolchain sources.

Sources, never model memory:
  arduino-cli  board details --format json  +  variants/<variant>/pins_arduino.h
  PlatformIO   platforms/<platform>/boards/<id>.json
  MicroPython  ports/<port>/boards/<board>/pins.csv (pinned tag)
  CircuitPython ports/<port>/boards/<board>/pins.c   (pinned tag)
  pico-sdk     src/boards/include/boards/<board>.h  (pinned tag)

Each board directory gets:
  pins.yaml        name -> gpio, kinds, frameworks, source line, notes
  specs.yaml       mcu, clock, memory, logic level, framework coverage
  provenance.json  every source with sha256, so --check can prove freshness

Usage:
  ./board_meta.py --all
  ./board_meta.py --board pico --board pico2
  ./board_meta.py --check
  ./board_meta.py --all --refresh

ARDUINO15_DIR and PLATFORMIO_CORE_DIR are honoured; defaults are ~/.arduino15
and ~/.platformio. Remote files are cached in ~/.cache/board_meta.
Requires PyYAML (Debian: python3-yaml).

Note: `arduino-cli board details` embeds extra.time.local/utc and absolute toolchain
paths (~/.arduino15/..., the arduino-cli binary path) in its JSON. The provenance
digest drops the timestamps, replaces the home directory with <HOME>, and drops any
remaining absolute-path value, so the same core version hashes identically on any host.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

import yaml

VERSION = "1"
REFRESH = False
REPO = Path(__file__).resolve().parent.parent
OUT_DEFAULT = REPO / "refs" / "boards"
CACHE = Path.home() / ".cache" / "board_meta"
ARDUINO_DATA = Path(os.environ.get("ARDUINO15_DIR", Path.home() / ".arduino15"))
PIO_DATA = Path(os.environ.get("PLATFORMIO_CORE_DIR", Path.home() / ".platformio"))

MP_TAG = "v1.24.1"
CP_TAG = "9.2.1"
PIO_RP_TAG = "v1.20.0"
SDK_TAG = "2.3.1"

MP = "https://raw.githubusercontent.com/micropython/micropython/{tag}/"
CP = "https://raw.githubusercontent.com/adafruit/circuitpython/{tag}/"
PIO_RP = "https://raw.githubusercontent.com/platformio/platform-raspberrypi/{tag}/"
SDK = "https://raw.githubusercontent.com/raspberrypi/pico-sdk/{tag}/"

DATASHEETS = {
    "uno": "https://docs.arduino.cc/hardware/uno-rev3/",
    "wemos": "https://www.wemos.cc/en/latest/d1/d1_mini.html",
    "esp8266": "https://www.espressif.com/sites/default/files/documentation/0a-esp8266ex_datasheet_en.pdf",
    "esp32": "https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/esp32-devkitc/user_guide.html",
    "pico": "https://datasheets.raspberrypi.com/pico/pico-datasheet.pdf",
    "pico2": "https://datasheets.raspberrypi.com/pico/pico-2-datasheet.pdf",
}

BOARDS = {
    "wemos-d1-mini": {
        "display_name": "LOLIN(WEMOS) D1 R2 & mini",
        "arduino_fqbn": "esp8266:esp8266:d1_mini",
        "logic_v": (3.3, "wemos"),
        "frameworks": ["arduino"],
    },
    "nodemcu": {
        "display_name": "NodeMCU 1.0 (ESP-12E)",
        "arduino_fqbn": "esp8266:esp8266:nodemcuv2",
        "logic_v": (3.3, "esp8266"),
        "frameworks": ["arduino"],
    },
    "arduino-uno": {
        "display_name": "Arduino Uno",
        "arduino_fqbn": "arduino:avr:uno",
        "logic_v": (5.0, "uno"),
        "frameworks": ["arduino"],
    },
    "pico": {
        "display_name": "Raspberry Pi Pico",
        "micropython": ("rp2", "RPI_PICO"),
        "circuitpython": ("raspberrypi", "raspberry_pi_pico"),
        "pio_board": (PIO_RP.format(tag=PIO_RP_TAG) + "boards/pico.json", "pico"),
        "logic_v": (3.3, "pico"),
        "frameworks": ["micropython", "circuitpython", "arduino"],
    },
    "pico2": {
        "display_name": "Raspberry Pi Pico 2",
        "micropython": ("rp2", "RPI_PICO2"),
        "circuitpython": ("raspberrypi", "raspberry_pi_pico2"),
        "sdk_board": ("pico2", SDK.format(tag=SDK_TAG)),
        "logic_v": (3.3, "pico2"),
        "frameworks": ["micropython", "circuitpython"],
    },
    "esp32-devkit": {
        "display_name": "ESP32-DevKitC v4 (WROOM-32E)",
        "micropython": ("esp32", "ESP32_GENERIC"),
        "circuitpython": ("espressif", "espressif_esp32_devkitc_v4_wroom_32e"),
        "pio_board": (None, "esp32dev"),
        "logic_v": (3.3, "esp32"),
        "frameworks": ["micropython", "circuitpython", "arduino"],
    },
}

NOTE_WORDS = re.compile(
    r"(?i)boot|strap|reserved|flash|input.only|internal|do not|pull|used by|silkscreen"
)
STATIC_RE = re.compile(r"static\s+const\s+uint8_t\s+(\w+)\s*=\s*([A-Za-z_]\w*|\d+)\s*;")
DEFINE_RE = re.compile(r"#define\s+(\w+)\s+\(?\s*(\d+)\s*\)?")
CP_ENTRY_RE = re.compile(
    r"\{\s*MP_ROM_QSTR\(MP_QSTR_(\w+)\)\s*,\s*MP_ROM_PTR\(&pin_(\w+)\)\s*\}"
)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def cache_key(url):
    return sha256(url.encode())[:20]


def fetch(url, refresh=False):
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / cache_key(url)
    if not path.exists() or refresh:
        req = urllib.request.Request(
            url, headers={"User-Agent": "board_meta/1 local-ai-stack"}
        )
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                data = r.read()
        except urllib.error.URLError as e:
            raise SystemExit(f"FETCH FAILED {url}: {e}")
        path.write_bytes(data)
    return path.read_bytes()


def local_source(path, role, ref, root, root_label):
    data = path.read_bytes()
    rel = path.relative_to(root)
    return {
        "role": role,
        "ref": ref,
        "location": f"{root_label}/{rel}",
        "sha256": sha256(data),
        "bytes": len(data),
    }, data


def remote_source(data, role, ref, url):
    return {
        "role": role,
        "ref": ref,
        "url": url,
        "cache_key": cache_key(url),
        "sha256": sha256(data),
        "bytes": len(data),
    }


def arduino_cli():
    for cand in (os.environ.get("ARDUINO_CLI"), shutil.which("arduino-cli"),
                 str(Path.home() / "bin" / "arduino-cli")):
        if cand and Path(cand).exists():
            return cand
    raise SystemExit("arduino-cli not found (set ARDUINO_CLI or install it)")


def cli_digest(details):
    home = str(Path.home())
    cli_dir = str(Path(arduino_cli()).resolve().parent)

    def portable(entry):
        if entry.startswith("extra.time."):
            return None
        key, _, value = entry.partition("=")
        if key == "runtime.ide.path":  # where arduino-cli happens to live
            return None
        value = value.replace(cli_dir, "<CLI_DIR>").replace(home, "<HOME>")
        if value.startswith("/") or value.startswith("~"):
            return None
        return key + "=" + value

    doc = {
        "fqbn": details.get("fqbn"),
        "name": details.get("name"),
        "platform": details.get("platform"),
        "build_properties": sorted(
            x for x in map(portable, details.get("build_properties") or []) if x
        ),
    }
    return sha256(json.dumps(doc, sort_keys=True, separators=(",", ":")).encode())


def arduino_adapter(fqbn):
    proc = subprocess.run(
        [arduino_cli(), "board", "details", "--fqbn", fqbn, "--format", "json"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise SystemExit(f"arduino-cli failed for {fqbn}: {proc.stderr.strip()}")
    details = json.loads(proc.stdout)
    props = dict(x.split("=", 1) for x in details.get("build_properties", []) if "=" in x)

    src = [{
        "role": "board_properties",
        "ref": fqbn,
        "cli": "arduino-cli board details --format json",
        "sha256": cli_digest(details),
        "bytes": len(json.dumps(details, sort_keys=True, separators=(",", ":")).encode()),
    }]
    platform_path = Path(props["runtime.platform.path"])
    header = platform_path / "variants" / props["build.variant"] / "pins_arduino.h"
    if not header.exists():
        raise SystemExit(f"variant header missing: {header}")
    s, data = local_source(
        header, "pins_header", f"variants/{props['build.variant']}/pins_arduino.h",
        ARDUINO_DATA, "~/.arduino15",
    )
    src.append(s)
    texts = [(s["ref"], data.decode(errors="replace"))]
    for inc in re.finditer(r'#include\s+"([^"]+)"', texts[0][1]):
        inc_path = (header.parent / inc.group(1)).resolve()
        if inc_path.exists() and platform_path.resolve() in inc_path.parents:
            s2, d2 = local_source(
                inc_path, "pins_header_include",
                "variants/" + str(inc_path.relative_to(platform_path / "variants")),
                ARDUINO_DATA, "~/.arduino15",
            )
            src.append(s2)
            texts.append((s2["ref"], d2.decode(errors="replace")))
    pins, notes_extra = [], []
    avr = props.get("build.arch") == "AVR"
    for ref, text in texts:
        p2, n2 = parse_arduino_header(text, ref, avr=avr)
        pins += p2
        notes_extra += n2
    specs = {
        "mcu": props.get("build.mcu"),
        "f_cpu_hz": int(props["build.f_cpu"].rstrip("L")) if "build.f_cpu" in props else None,
        "arch": props.get("build.arch"),
    }
    if "upload.maximum_data_size" in props:
        specs["ram_bytes"] = int(props["upload.maximum_data_size"])
    if "upload.maximum_size" in props:
        specs["upload_max_bytes"] = int(props["upload.maximum_size"])
    if "build.flash_size" in props and re.fullmatch(r"\d+M", props["build.flash_size"]):
        specs["flash_bytes"] = int(props["build.flash_size"][:-1]) * 1024 * 1024
    if notes_extra:
        specs["notes"] = notes_extra
    return src, pins, specs, f"{props.get('build.arch', '').lower()}@{platform_path.name}"


def parse_arduino_header(text, ref, avr=False):
    defines = {m.group(1): int(m.group(2)) for m in DEFINE_RE.finditer(text)}
    pins = []
    notes = []
    section = None
    pending = []
    for lineno, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith("//"):
            pending.append(stripped.lstrip("/ ").strip())
            continue
        if stripped and pending:
            hits = [x for x in pending if NOTE_WORDS.search(x)]
            section = hits[-1][:160] if hits else None
            pending = []
        m = STATIC_RE.search(line)
        if m:
            raw = m.group(2)
            gpio = int(raw) if raw.isdigit() else defines.get(raw)
            if gpio is not None:
                pins.append((m.group(1), gpio, f"{ref}:{lineno}", section))
        m = DEFINE_RE.search(line)
        if m and m.group(1) == "LED_BUILTIN":
            pins.append(("LED_BUILTIN", int(m.group(2)), f"{ref}:{lineno}", section))

    num_digital = defines.get("NUM_DIGITAL_PINS")
    num_analog = defines.get("NUM_ANALOG_INPUTS")
    if avr and num_digital and num_analog:
        keep = []
        for name, gpio, src, note in pins:
            if re.fullmatch(r"A\d+", name) and gpio - (num_digital - num_analog) >= num_analog:
                notes.append(f"{name} defined in the variant but beyond NUM_ANALOG_INPUTS "
                             f"({num_analog}); not counted")
                continue
            keep.append((name, gpio, src, note))
        pins = keep
        digital_count = num_digital - num_analog
        for n in range(digital_count):
            pins.append((f"D{n}", n,
                         f"{ref} (NUM_DIGITAL_PINS={num_digital}, "
                         f"NUM_ANALOG_INPUTS={num_analog})", None))
    return pins, notes


def mp_adapter(port, board):
    url = MP.format(tag=MP_TAG) + f"ports/{port}/boards/{board}/pins.csv"
    try:
        data = fetch(url, REFRESH)
    except SystemExit as e:
        if "404" not in str(e):
            raise
        bj = MP.format(tag=MP_TAG) + f"ports/{port}/boards/{board}/board.json"
        bdata = fetch(bj, REFRESH)
        src = [remote_source(bdata, "board_json",
                             f"ports/{port}/boards/{board}/board.json", bj)]
        meta = json.loads(bdata)
        specs = {"mcu": meta.get("mcu")}
        return src, [], specs, "specs"
    src = [remote_source(data, "pins_csv", f"ports/{port}/boards/{board}/pins.csv", url)]
    pins = []
    for lineno, line in enumerate(data.decode(errors="replace").splitlines(), 1):
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        name, _, symbol = line.partition(",")
        m = re.search(r"(\d+)$", symbol.strip())
        if m:
            pins.append((name.strip(), int(m.group(1)), f"{url}:{lineno}", None))
    if not pins:
        raise SystemExit(f"MP adapter parsed 0 pins for {port}/{board} (fail closed)")
    return src, pins, {}, "pins"


def cp_meta_adapter(port, board):
    url = CP.format(tag=CP_TAG) + f"ports/{port}/boards/{board}/mpconfigboard.mk"
    data = fetch(url, REFRESH)
    src = [remote_source(data, "mpconfigboard_mk",
                         f"ports/{port}/boards/{board}/mpconfigboard.mk", url)]
    text = data.decode(errors="replace")
    specs = {}
    m = re.search(r"^CHIP_VARIANT\s*=\s*(\w+)", text, re.M)
    if m:
        specs["mcu"] = m.group(1).lower()
    return src, specs


def cp_adapter(port, board):
    url = CP.format(tag=CP_TAG) + f"ports/{port}/boards/{board}/pins.c"
    data = fetch(url, REFRESH)
    src = [remote_source(data, "pins_c", f"ports/{port}/boards/{board}/pins.c", url)]
    pins = []
    section = None
    pending = []
    for lineno, line in enumerate(data.decode(errors="replace").splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith("//"):
            pending.append(stripped.lstrip("/ ").strip())
            continue
        if stripped and pending:
            hits = [x for x in pending if NOTE_WORDS.search(x)]
            section = hits[-1][:160] if hits else None
            pending = []
        for m in CP_ENTRY_RE.finditer(line):
            name, symbol = m.group(1), m.group(2)
            g = re.search(r"(\d+)$", symbol)
            if g:
                pins.append((name, int(g.group(1)), f"{url}:{lineno}", section))
    if not pins:
        raise SystemExit(f"CP adapter parsed 0 pins for {port}/{board} (fail closed)")
    return src, pins


def pio_adapter(remote_url, board_id):
    if remote_url:
        url = remote_url
        data = fetch(url, REFRESH)
        src = [remote_source(data, "pio_board", f"boards/{board_id}.json", url)]
    else:
        cands = sorted(PIO_DATA.glob("platforms/espressif32*/boards/" + board_id + ".json"))
        plain = [c for c in cands if "@" not in c.parent.parent.name]
        path = (plain or cands)[-1] if cands else None
        if path is None:
            raise SystemExit(f"PlatformIO board file not installed: {board_id}")
        s, data = local_source(path, "pio_board",
                               f"platforms/espressif32/boards/{path.name}",
                               PIO_DATA, "~/.platformio")
        src = [s]
    d = json.loads(data)
    build = d.get("build", {})
    upload = d.get("upload", {})
    specs = {
        "mcu": build.get("mcu"),
        "f_cpu_hz": int(build["f_cpu"].rstrip("L")) if "f_cpu" in build else None,
    }
    if upload.get("maximum_ram_size"):
        specs["ram_bytes"] = int(upload["maximum_ram_size"])
    if upload.get("maximum_size"):
        specs["flash_bytes"] = int(upload["maximum_size"])
    return src, specs


def sdk_adapter(board, base):
    url = base + f"src/boards/include/boards/{board}.h"
    data = fetch(url, REFRESH)
    src = [remote_source(data, "sdk_board", f"src/boards/include/boards/{board}.h", url)]
    text = data.decode(errors="replace")
    specs = {}
    m = re.search(r"PICO_FLASH_SIZE_BYTES,\s*\((\d+)\s*\*\s*1024\s*\*\s*1024\)", text)
    if m:
        specs["flash_bytes"] = int(m.group(1)) * 1024 * 1024
    return src, specs


def kind_of(name):
    if name == "LED_BUILTIN":
        return "led"
    if name in ("SDA", "SCL"):
        return "i2c"
    if re.fullmatch(r"A\d+", name):
        return "adc"
    return "digital"


def build_board(board_id, cfg):
    sources, pin_rows, specs, platform = [], [], {}, None
    frameworks = {}

    if "arduino_fqbn" in cfg:
        s, p, sp, platform = arduino_adapter(cfg["arduino_fqbn"])
        sources += s
        pin_rows += [(n, g, src, note, "arduino") for n, g, src, note in p]
        specs.update(sp)
        frameworks["arduino"] = "pins+specs"

    if "micropython" in cfg:
        port, board = cfg["micropython"]
        s, p, sp, coverage = mp_adapter(port, board)
        sources += s
        pin_rows += [(n, g, src, note, "micropython") for n, g, src, note in p]
        for k, v in sp.items():
            if v is not None and specs.get(k) is None:
                specs[k] = v
        frameworks["micropython"] = coverage

    if "circuitpython" in cfg:
        port, board = cfg["circuitpython"]
        s, p = cp_adapter(port, board)
        sources += s
        pin_rows += [(n, g, src, note, "circuitpython") for n, g, src, note in p]
        s2, sp = cp_meta_adapter(port, board)
        sources += s2
        for k, v in sp.items():
            if v is not None and specs.get(k) is None:
                specs[k] = v
        frameworks["circuitpython"] = "pins"

    if "pio_board" in cfg:
        url, pio_id = cfg["pio_board"]
        s, sp = pio_adapter(url, pio_id)
        sources += s
        for k, v in sp.items():
            if v is not None and specs.get(k) is None:
                specs[k] = v
        frameworks.setdefault("arduino", "specs")

    if "sdk_board" in cfg:
        board, base = cfg["sdk_board"]
        s, sp = sdk_adapter(board, base)
        sources += s
        for k, v in sp.items():
            if v is not None and specs.get(k) is None:
                specs[k] = v

    merged = {}
    for name, gpio, src, note, fw in pin_rows:
        key = (gpio, name)
        e = merged.setdefault(key, {
            "name": name, "gpio": gpio, "kinds": set(),
            "frameworks": set(), "source": src, "notes": set(),
        })
        e["kinds"].add(kind_of(name))
        e["frameworks"].add(fw)
        if note:
            e["notes"].add(note)

    by_name = {}
    for (gpio, name), e in merged.items():
        if name in by_name and by_name[name] != gpio:
            raise SystemExit(f"conflict for {board_id}: {name} -> {by_name[name]} vs {gpio}")
        by_name[name] = gpio

    pins = []
    for (gpio, name) in sorted(merged, key=lambda k: (k[0], k[1])):
        e = merged[(gpio, name)]
        pins.append({
            "name": name,
            "gpio": gpio,
            "kinds": sorted(e["kinds"]),
            "frameworks": sorted(e["frameworks"]),
            "source": e["source"],
            "notes": sorted(e["notes"]),
        })

    logic_v, ds_key = cfg["logic_v"]
    ds_url = DATASHEETS[ds_key]
    ds_data = fetch(ds_url, REFRESH)
    sources.append(dict(remote_source(ds_data, "logic_v", ds_key, ds_url),
                        extraction="curated"))

    gaps = [k for k in ("mcu", "f_cpu_hz", "flash_bytes", "ram_bytes")
            if specs.get(k) is None]

    spec_doc = {
        "board": board_id,
        "display_name": cfg["display_name"],
        "mcu": specs.get("mcu"),
        "platform": platform,
        "f_cpu_hz": specs.get("f_cpu_hz"),
        "flash_bytes": specs.get("flash_bytes"),
        "ram_bytes": specs.get("ram_bytes"),
        "upload_max_bytes": specs.get("upload_max_bytes"),
        "logic_v": logic_v,
        "logic_v_extraction": "curated from the cited datasheet",
        "frameworks": {k: {"coverage": v} for k, v in sorted(frameworks.items())},
        "spec_gaps": gaps,
        "notes": specs.get("notes", []),
    }

    pin_doc = {
        "board": board_id,
        "display_name": cfg["display_name"],
        "pin_model": "named",
        "pins": pins,
    }

    provenance = {
        "tool": f"board_meta.py v{VERSION}",
        "board": board_id,
        "sources": sorted(sources, key=lambda s: (s["role"], s["ref"])),
    }
    return pin_doc, spec_doc, provenance


def write_board(board_id, cfg, out_dir):
    pin_doc, spec_doc, prov = build_board(board_id, cfg)
    d = out_dir / board_id
    d.mkdir(parents=True, exist_ok=True)
    dump(pin_doc, d / "pins.yaml")
    dump(spec_doc, d / "specs.yaml")
    (d / "provenance.json").write_text(json.dumps(prov, indent=2, sort_keys=True) + "\n")
    print(f"wrote {d.relative_to(REPO) if d.is_relative_to(REPO) else d}  "
          f"({len(pin_doc['pins'])} pins, gaps={spec_doc['spec_gaps'] or 'none'})")


def dump(doc, path):
    path.write_text(yaml.safe_dump(doc, sort_keys=False, allow_unicode=True, width=100))


def verify_source(s):
    if "url" in s:
        p = CACHE / s["cache_key"]
        if not p.exists():
            return f"MISSING cache for {s['ref']} (run --refresh)"
        data = p.read_bytes()
    elif "cli" in s:
        proc = subprocess.run(
            [arduino_cli(), "board", "details", "--fqbn", s["ref"], "--format", "json"],
            capture_output=True,
        )
        if proc.returncode != 0:
            return f"CLI FAILED for {s['ref']}"
        try:
            details = json.loads(proc.stdout)
        except json.JSONDecodeError:
            return f"CLI garbage for {s['ref']}"
        got = cli_digest(details)
        if got != s["sha256"]:
            return f"DRIFT {s['ref']}: {s['sha256'][:12]} -> {got[:12]}"
        return None
    else:
        p = Path(str(s["location"]).replace("~", str(Path.home()), 1))
        if not p.exists() and s.get("role") == "pio_board":
            cands = sorted((Path.home() / ".platformio" / "platforms").glob(
                "espressif32*/boards/" + p.name))
            plain = [c for c in cands if "@" not in c.parent.parent.name]
            if plain or cands:
                p = (plain or cands)[-1]
        if not p.exists():
            return f"MISSING {s['location']}"
        data = p.read_bytes()
    got = sha256(data)
    if got != s["sha256"]:
        return f"DRIFT {s['ref']}: {s['sha256'][:12]} -> {got[:12]}"
    return None


def check(out_dir):
    failures = 0
    for board_dir in sorted(p for p in out_dir.iterdir() if p.is_dir()):
        prov_path = board_dir / "provenance.json"
        if not prov_path.exists():
            print(f"FAIL {board_dir.name}: no provenance.json")
            failures += 1
            continue
        prov = json.loads(prov_path.read_text())
        for name in ("pins.yaml", "specs.yaml"):
            try:
                yaml.safe_load((board_dir / name).read_text())
            except Exception as e:
                print(f"FAIL {board_dir.name}/{name}: {e}")
                failures += 1
        local_fail = 0
        for s in prov["sources"]:
            problem = verify_source(s)
            if problem:
                print(f"FAIL {board_dir.name}: {problem}")
                local_fail += 1
        if local_fail == 0:
            print(f"OK   {board_dir.name}: {len(prov['sources'])} sources verified")
        failures += local_fail
    return 1 if failures else 0


def seed_cache(out_dir):
    urls = set()
    for prov_path in sorted(out_dir.glob("*/provenance.json")):
        prov = json.loads(prov_path.read_text())
        for s in prov["sources"]:
            if "url" in s:
                urls.add(s["url"])
    fetched = 0
    for url in sorted(urls):
        if not (CACHE / cache_key(url)).exists():
            fetch(url)
            fetched += 1
    print(f"cache: {len(urls)} remote sources, {fetched} fetched")


def main():
    global REFRESH
    ap = argparse.ArgumentParser()
    ap.add_argument("--board", action="append", default=[], choices=sorted(BOARDS))
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--seed-cache", action="store_true")
    ap.add_argument("--out", default=str(OUT_DEFAULT))
    args = ap.parse_args()
    REFRESH = args.refresh
    out = Path(args.out).expanduser().resolve()

    if args.seed_cache:
        seed_cache(out)
        raise SystemExit(0)
    if args.check:
        raise SystemExit(check(out))
    ids = sorted(BOARDS) if args.all or not args.board else sorted(set(args.board))
    if not ids:
        ap.error("choose --all or --board <id>")
    for b in ids:
        write_board(b, BOARDS[b], out)


if __name__ == "__main__":
    main()
