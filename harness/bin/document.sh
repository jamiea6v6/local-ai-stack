#!/bin/bash
set -euo pipefail
cwd="$(pwd)"
key="$(printf '%s' "${cwd#/}" | tr '/' '-')"
sdir="$HOME/.pi/agent/sessions/--${key}--"
sfile=""
if [[ -d "$sdir" ]]; then
  sfile="$(ls -t "$sdir"/*.jsonl 2>/dev/null | head -1 || true)"
fi
if [[ -z "${sfile}" || ! -f "$sfile" ]]; then
  sfile="$(grep -rlF "\"cwd\":\"$cwd\"" "$HOME/.pi/agent/sessions" 2>/dev/null | xargs -r ls -t 2>/dev/null | head -1 || true)"
fi
if [[ -z "${sfile}" || ! -f "$sfile" ]]; then
  echo "No session found for $cwd" >&2
  exit 1
fi
out="$cwd/session-content.md"
python3 - "$sfile" "$out" "$cwd" <<'PY'
import json, sys, os
from collections import Counter, defaultdict
from datetime import datetime

path, out, cwd = sys.argv[1], sys.argv[2], sys.argv[3]

def fence(text):
    if text is None: text = ""
    if not isinstance(text, str): text = json.dumps(text, ensure_ascii=False, indent=2)
    m = 3
    for i in range(len(text)):
        if text[i] == '`':
            j = i
            while j < len(text) and text[j] == '`': j += 1
            m = max(m, j - i + 1)
            i = j
    f = '`' * m
    return f + "\n" + text + ("\n" if not text.endswith("\n") else "") + f

events = []
with open(path, encoding='utf-8', errors='replace') as f:
    for i, line in enumerate(f, 1):
        line = line.rstrip('\n')
        if not line: continue
        try:
            events.append((i, json.loads(line)))
        except Exception as e:
            events.append((i, {"type":"_parse_error","error":str(e),"raw":line[:2000]}))

meta = {"session_id": None, "cwd": cwd, "timestamp": None, "models": [], "thinking": None}
messages = []
for i, e in events:
    et = e.get('type')
    if et == 'session':
        meta["session_id"] = e.get('id') or meta["session_id"]
        meta["cwd"] = e.get('cwd') or meta["cwd"]
        meta["timestamp"] = e.get('timestamp') or meta["timestamp"]
    elif et == 'model_change':
        meta["models"].append({"provider": e.get('provider'), "modelId": e.get('modelId'), "timestamp": e.get('timestamp')})
    elif et == 'thinking_level_change':
        meta["thinking"] = e.get('thinkingLevel', meta["thinking"])
    elif et == 'message':
        messages.append((i, e))

# summary
user_n = asst_n = tool_n = sys_n = 0
tool_calls = Counter(); tool_errs = 0; asst_errs = 0
writes = []; edits = []; bash_cmds = []
total_in = total_out = total_cache = total_reason = 0
for i, e in messages:
    m = e.get('message', {})
    role = m.get('role')
    if role == 'user': user_n += 1
    elif role == 'assistant':
        asst_n += 1
        u = m.get('usage') or {}
        total_in += u.get('input', 0) or 0
        total_out += u.get('output', 0) or 0
        total_cache += u.get('cacheRead', 0) or 0
        total_reason += u.get('reasoning', 0) or 0
        if m.get('stopReason') == 'error' or m.get('errorMessage'): asst_errs += 1
        for c in (m.get('content') or []):
            if isinstance(c, dict) and c.get('type') == 'toolCall':
                name = c.get('name') or '?'
                tool_calls[name] += 1
                args = c.get('arguments') or {}
                if name == 'write':
                    writes.append(args.get('path') or args.get('filePath'))
                elif name == 'edit':
                    edits.append(args.get('path') or args.get('filePath'))
                elif name == 'bash':
                    cmd = args.get('command')
                    if cmd: bash_cmds.append(cmd)
    elif role == 'toolResult':
        tool_n += 1
        if m.get('isError'): tool_errs += 1
    elif role == 'system':
        sys_n += 1

out_lines = []
w = out_lines.append
w(f"# Session Content")
w("")
w(f"- Session ID: `{meta.get('session_id') or 'unknown'}`")
w(f"- CWD: `{meta.get('cwd')}`")
w(f"- Started: `{meta.get('timestamp')}`")
if meta.get('models'):
    last = meta['models'][-1]
    w(f"- Model: `{last.get('provider')}/{last.get('modelId')}`")
w(f"- Thinking level: `{meta.get('thinking')}`")
w(f"- Source: `{path}`")
w(f"- Exported: `{datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S %Z')}`")
w("")
w("## Summary")
w("")
w(f"- Events: {len(events)} total, {len(messages)} messages")
w(f"- Messages by role: user={user_n}, assistant={asst_n}, toolResult={tool_n}, system={sys_n}")
w(f"- Tool calls: {sum(tool_calls.values())} " + (", ".join(f"{k}={v}" for k,v in tool_calls.most_common()) if tool_calls else "(none)"))
w(f"- Errors: assistant={asst_errs}, toolResult={tool_errs}")
w(f"- Token usage totals: input={total_in}, output={total_out}, cacheRead={total_cache}, reasoning={total_reason}")
if writes:
    w(f"- Files written: " + ", ".join(f"`{x}`" for x in writes))
if edits:
    w(f"- Files edited: " + ", ".join(f"`{x}`" for x in edits))
w("")
w("## Transcript")
w("")

msg_idx = 0
for i, e in messages:
    m = e.get('message', {})
    role = m.get('role', 'unknown')
    ts = e.get('timestamp') or ''
    msg_idx += 1
    w(f"### {msg_idx}. {role} (event {i}, {ts})")
    w("")
    if role == 'assistant':
        if m.get('model') or m.get('provider'):
            w(f"- model: `{m.get('provider','')}/{m.get('model','')}` stop=`{m.get('stopReason')}`")
        u = m.get('usage')
        if u: w(f"- usage: `{json.dumps(u, ensure_ascii=False)}`")
        if m.get('errorMessage'): w(f"- errorMessage: {m.get('errorMessage')}")
    if role == 'toolResult':
        w(f"- tool: `{m.get('toolName')}` callId=`{m.get('toolCallId')}` isError=`{m.get('isError')}`")
    content = m.get('content')
    if isinstance(content, str):
        w(fence(content))
    elif isinstance(content, list):
        for c in content:
            if not isinstance(c, dict):
                w(fence(c)); continue
            ct = c.get('type')
            if ct == 'text':
                w("**text**")
                w(fence(c.get('text','')))
            elif ct == 'thinking':
                w("**thinking**")
                w(fence(c.get('thinking', c.get('text',''))))
            elif ct == 'toolCall':
                name = c.get('name')
                args = c.get('arguments', {})
                w(f"**toolCall:** `{name}` id=`{c.get('id')}`")
                w(fence(json.dumps(args, ensure_ascii=False, indent=2)))
            elif ct == 'image':
                w(f"**image** `{c.get('mimeType','')}` (omitted)")
            else:
                w(f"**{ct}**")
                w(fence(json.dumps(c, ensure_ascii=False, indent=2)))
    elif content is not None:
        w(fence(content))
    # extra fields sometimes present
    for k in ('details','attachments'):
        if k in m and m[k]:
            w(f"**{k}**")
            w(fence(json.dumps(m[k], ensure_ascii=False, indent=2)))
    w("")

with open(out, 'w', encoding='utf-8') as f:
    f.write('\n'.join(out_lines) + '\n')
print(f"session_id={meta.get('session_id')} messages={len(messages)} tool_calls={sum(tool_calls.values())}")
PY
echo "Wrote $out (source: $sfile)"
