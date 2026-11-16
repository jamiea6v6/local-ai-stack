# Board maps — generated, not recalled

`pins.yaml` and `specs.yaml` here are produced by `tools/board_meta.py` from real toolchain
sources, and `provenance.json` records the sha256 of every input. Nothing is typed from memory.

This is the **exact-lookup** layer. Prose retrieval (RAG) is a separate, later layer; pin numbers
must never come from an embedding search.

| board | pin source | specs source | pin count |
|---|---|---|---|
| `wemos-d1-mini` | esp8266 core 3.1.2 variant `d1_mini` + `generic/common.h` | same + board details | 19 |
| `nodemcu` | esp8266 core 3.1.2 variant `nodemcu` + `generic/common.h` | same + board details | 19 |
| `arduino-uno` | avr core 1.8.8 variant `standard` | same + board details | 27 |
| `pico` | MicroPython `v1.24.1` + CircuitPython `9.2.1` | PlatformIO `platform-raspberrypi` `v1.20.0` | 40 |
| `pico2` | MicroPython `v1.24.1` + CircuitPython `9.2.1` | pico-sdk `2.3.1` (`pico2.h`) + CP chip variant | 40 |
| `esp32-devkit` | CircuitPython `9.2.1` (`espressif_esp32_devkitc_v4_wroom_32e`) | PlatformIO `espressif32` + MP `board.json` | 44 |

## Files

`pins.yaml`

- `name` — the identifier the framework exposes (`D4`, `A0`, `GP25`, `IO34`, `LED_BUILTIN`).
- `gpio` — the MCU pin number.
- `kinds` — `digital`, `adc`, `i2c`, `led`.
- `frameworks` — which toolchains expose this exact name.
- `source` — file and line, or URL and line, the entry was parsed from.
- `notes` — literal comments from the source that mention boot straps, flash pins, input-only
  pins or reserved use. Quoted, not paraphrased.

`specs.yaml`

- `mcu`, `f_cpu_hz`, `flash_bytes`, `ram_bytes`, `upload_max_bytes`, `logic_v`.
- `frameworks.<name>.coverage` — `pins+specs`, `pins`, or `specs`; absence means not covered.
- `spec_gaps` — fields no fetched source stated. A gap is a fact about the sources, not a TODO to
  fill from memory.
- `notes` — variant definitions excluded from the count (e.g. Uno `A6`/`A7`).

`provenance.json` — one entry per input: `role`, `ref`, `sha256`, `bytes`, plus `location`
(`~/…`), `url` + `cache_key`, or `cli`. `logic_v` entries are marked `extraction: curated`; the
number comes from the cited datasheet, not from a parser.

## Regenerate and verify

```sh
./tools/board_meta.py --all              # writes refs/boards/<id>/
./tools/board_meta.py --board pico       # one board
./tools/board_meta.py --check            # re-hash every source, exit 1 on drift
./tools/board_meta.py --all --refresh    # re-download remotes
```

Remote files are cached in `~/.cache/board_meta`, so `--check` works offline. Arduino inputs are
read from `ARDUINO15_DIR` (default `~/.arduino15`) via `arduino-cli`; PlatformIO from
`PLATFORMIO_CORE_DIR` (default `~/.platformio`). `arduino-cli board details` embeds
`extra.time.local/utc`; the digest deliberately excludes those keys.

## Traps this layer exists to catch

- **ESP32-DevKitC silkscreen is not GPIO.** In CircuitPython `board.D0` is **GPIO7** (`D1` is
  GPIO8); the flash pins have both `CLK`/`IO6` names. A model recalling "D0 = 0" is wrong here.
- **ESP8266 `A0` is 17, not 0**, and the D1 mini variant does not define it — it comes from
  `variants/generic/common.h`, so a one-file parser silently loses the analog pin.
- **Wemos D1 pin names are not GPIO numbers**: `D4` is GPIO2, `D8` is GPIO15, `D1` is GPIO5.
- **Uno has 14 digital pins**, not 20: `NUM_DIGITAL_PINS=20` includes `A0`–`A5`, and the variant
  also defines `A6`/`A7` that the board does not expose.

## Adding a board

Add an entry to `BOARDS` in `tools/board_meta.py` (an `arduino_fqbn` and/or
`micropython`/`circuitpython` port+board, optional `pio_board`/`sdk_board`, and a `logic_v` with a
datasheet URL), then run `--all` and `--check`. Pin conflicts and zero-pin parses abort on purpose.
