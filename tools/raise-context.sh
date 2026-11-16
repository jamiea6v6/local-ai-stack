#!/bin/bash
# Raise brain1's Ollama context window from 8192 to 16384.
#
# WHY: brain1's Pi window is pinned at 8192 by OLLAMA_CONTEXT_LENGTH in
# /etc/systemd/system/ollama.service.d/override.conf. The baseline prompt alone
# costs ~4700 tokens (2378 without any AGENTS.md, +2340 for the doc-store
# AGENTS.md, +929 for the Pi harness AGENTS.md). That leaves ~3400 tokens for the
# whole conversation, which is not enough for the model to search, write a
# program, read the verification output, and fix what it finds. Measured runs
# ended with stopReason=length and produced zero output.
#
# WHY IT IS SAFE ON THIS CARD — measured on brain1 (P106-100, 6144 MiB total),
# gemma4:e4b-it-qat, via the native /api/generate endpoint with per-request
# num_ctx:
#
#     num_ctx= 8192   VRAM 4086 MiB
#     num_ctx=16384   VRAM 4162 MiB   (+76 MiB)
#     num_ctx=32768   VRAM 4314 MiB   (+228 MiB)
#     num_ctx=65536   VRAM ~4618 MiB  (+304 MiB, extrapolated)
#
# 16384 leaves ~1980 MiB free. 32768 leaves ~1830 MiB free. Either fits with
# room to spare; 16384 is the conservative choice and is what this script sets.
#
# WHY 16384 AND NOT MORE: the KV rate is ~9.5 MiB per 1k tokens, so the window
# is cheap in VRAM but not free in CONTEXT. A bigger window does not make the
# model smarter, it just lets a long conversation survive. 16K is enough to
# search, write, verify, and fix.
#
# Pi talks to Ollama's OpenAI-compatible /v1 endpoint, which IGNORES num_ctx
# (confirmed on this box: requesting num_ctx=32768 over /v1 still reported
# context_length 8192). So the ONLY way to change Pi's window is this
# server-side environment variable. That is why this needs sudo.
#
# NOTE: brain1's Ollama is 0.32.15. SkyNet is on 0.40.12. This script does not
# change the version.

set -euo pipefail

DROPIN=/etc/systemd/system/ollama.service.d/override.conf

echo "=== current ==="
cat "$DROPIN"
cp -a "$DROPIN" "$DROPIN.bak.$(date +%Y%m%d-%H%M%S)"

if grep -q "OLLAMA_CONTEXT_LENGTH" "$DROPIN"; then
    sed -i 's/^Environment="OLLAMA_CONTEXT_LENGTH=.*"/Environment="OLLAMA_CONTEXT_LENGTH=16384"/' "$DROPIN"
else
    sed -i '1a Environment="OLLAMA_CONTEXT_LENGTH=16384"' "$DROPIN"
fi

echo
echo "=== updated ==="
cat "$DROPIN"

systemctl daemon-reload
systemctl restart ollama
sleep 3

echo
echo "=== verify ==="
systemctl show ollama --property=Environment --no-pager | tr ' ' '\n' | grep -i context
echo "--- warm the model and read back the live context length ---"
curl -s http://127.0.0.1:11434/api/generate \
    -d '{"model":"gemma4:e4b-it-qat","prompt":"hi","stream":false,"keep_alive":"30m"}' >/dev/null
sleep 2
curl -s http://127.0.0.1:11434/api/ps | python3 -c "
import json,sys
for m in json.load(sys.stdin).get('models',[]):
    print('  model:', m['name'], 'context_length:', m.get('context_length'))
"
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader

cat <<'EOF'

Done. The window is now 16384.

If you want to go further, 32768 measured 4314 MiB of 6144 and also fits:
    sed -i 's/OLLAMA_CONTEXT_LENGTH=.*/OLLAMA_CONTEXT_LENGTH=32768"/' \
        /etc/systemd/system/ollama.service.d/override.conf
    systemctl daemon-reload && systemctl restart ollama

Do NOT go past 32768 without measuring. The headroom above 32768 is thin and
brain1 is the low-power box that has to stay headless and quiet.
EOF
