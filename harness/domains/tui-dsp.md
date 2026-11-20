# Domain: tui-dsp

Use for Debian Python Textual TUIs with sounddevice duplex audio and scipy
Butterworth filtering. This file is evidence and gate guidance, not code.
The operator's task text overrides the example checklist and suggested steps.

## PREFLIGHT

Run this one command with `bash` before writing PLAN.md:
`$HOME/.pi/agent/bin/preflight.sh`

Do not paste the script text. Do not run BEGIN or END as commands.

printf '=== HOST ===\n'
printf 'hostname=%s\n' "$(hostname)"
printf 'os=%s\n' "$(. /etc/os-release; printf '%s' "$PRETTY_NAME")"
printf 'kernel=%s\n' "$(uname -srm)"
printf 'arch=%s\n' "$(uname -m)"
printf '=== AUDIO STACK ===\n'
pactl info 2>&1 | awk -F': ' '/^Server Name:/{print "server="$2} /^Server Version:/{print "server_version="$2} /^Default Sample Specification:/{print "sample_spec="$2} /^Default Sink:/{print "default_sink="$2} /^Default Source:/{print "default_source="$2}'
systemctl --user list-units --type=service --all --no-pager 2>&1 | awk '/pipewire|pulse|wireplumber/ {print "audio_service="$1" "$3}'
printf '=== DEVICES ===\n'
python3 -c 'import sounddevice as sd; ds=sd.query_devices(); d=sd.default.device; print("device_count=",len(ds)); print("default_input=",d[0]); print("default_output=",d[1]); print("default_samplerate=",sd.default.samplerate)' 2>&1
printf '=== PYTHON ===\n'
python3 -c 'import sys; print("exe=",sys.executable); print("version=",sys.version.split()[0]); import numpy,scipy,sounddevice,textual; print("numpy=",numpy.__version__); print("scipy=",scipy.__version__); print("sounddevice=",sounddevice.__version__); print("textual=",textual.__version__)' 2>&1
printf '=== PEP 668 ===\n'
if [ -f /usr/lib/python3.13/EXTERNALLY-MANAGED ]; then echo 'pep668=managed'; else echo 'pep668=absent'; fi
python3 -m pip --version 2>&1 | head -1
printf '=== DISPLAY ===\n'
printf 'DISPLAY=%s WAYLAND_DISPLAY=%s TERM=%s\n' "${DISPLAY:-unset}" "${WAYLAND_DISPLAY:-unset}" "${TERM:-unset}"
printf '=== FILES ===\n'
printf 'file_count=%s\n' "$(find . -maxdepth 2 -type f -not -path './.git/*' | wc -l)"
find . -maxdepth 2 -type f -not -path './.git/*' -printf '%p\n' | sort | head -20
## Research questions

Ask one at a time when relevant; do not ask all at once:

- CW center frequency: fixed 700 Hz, selectable, or operator-defined?
- Does "bandwidth 50-1000 Hz" mean full width or +/- from center?
- Default bandwidth and step size?
- Input source: mic, PulseAudio monitor of default sink, or file replay?
- Output: default sink, selected device, or none during test?
- Sample-rate fallback when default is None?
- Textual controls: keys, buttons, slider, or numeric entry?
- What must gates verify beyond py_compile?
- No-install constraint: system Python 3.13 only?

## Fact rules

- Treat `pactl` Default Sample Specification as authoritative for stream rate.
- If discovered rate differs from any assumed rate, record QUESTION; do not silently choose.
- If Default Source is a monitor of Default Sink, record QUESTION about intended capture path.
- Do not install packages. If a required import fails, record QUESTION.
- Do not assume PipeWire. Record the actual service from PREFLIGHT output.

## Requirement checklist

Copy these into FACTS or QUESTIONS as appropriate:

- Textual TUI on Debian.
- sounddevice duplex audio.
- SSB bandpass 300-3000 Hz.
- CW bandpass 600 Hz +/- 100 Hz.
- Stateful scipy Butterworth filtering.
- Device selector.
- Live cutoff readout.

## Gate rules

- Python steps use `GATE <n>: bash -lc 'python3 -m py_compile <file>'`.
- Behavior steps use an exact `bash -lc 'python3 -c ...'` command against the file on disk.
- Use `verify(project=".")` only when a project `gates.json` exists.
- Never use `compile()`; that tool builds Arduino sketches only.
- Every STEP must have one GATE line, copied verbatim into GATES.

## Suggested steps

Adapt these to the task; do not write code now:

1. Write the single-file Textual app skeleton. FILES: app.py
   GATE 1: bash -lc 'python3 -m py_compile app.py'
2. Add DSP functions with stateful Butterworth filters. FILES: app.py
   GATE 2: bash -lc 'python3 -c "import app; print(1)"'
3. Add device selector using the discovered device list. FILES: app.py
   GATE 3: bash -lc 'python3 -m py_compile app.py'
4. Add SSB/CW cutoff controls and live readout. FILES: app.py
   GATE 4: bash -lc 'python3 -m py_compile app.py'
