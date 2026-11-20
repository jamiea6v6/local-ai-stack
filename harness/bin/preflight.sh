#!/bin/bash
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
