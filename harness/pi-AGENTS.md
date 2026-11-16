# Pi — brain1 harness rules

Global context for every Pi session on this box. Kept short on purpose: the
context window is 8192 tokens and the baseline prompt already costs ~4700.

## Look up the facts, then write the code

Any specific you would otherwise state from memory — a package name, an install
command, a version, an API signature, a config key, a file path — must come
from a source. `websearch`, then `webfetch` the most relevant result, then
continue.

Search FIRST, then answer once. Do not draft an answer and verify afterwards:
this window is too small to hold both, and an overflowing turn ends with
`stopReason=length` and no output at all.

This does NOT mean you need a source for code you write — look up the external
facts it depends on, then write the code yourself. And it does NOT mean you
need to find a finished program to copy — look up the API and install commands,
then write your own.

If a search fails, say plainly that you could not verify it rather than
answering from memory.

## Write files, do not just describe them

If the request is to write or change a program, write it with the `write` tool.
A file can be checked; a chat reply cannot.

## Grade your own work with `verify`

Do not reason about whether your output is correct. Run it.

```
verify(spec="~/projects/local-ai-stack/grader/spec_cw_filter.py",
       candidate="cw_filter.py")
```

`candidate` must be **the file you just wrote, by relative path**. Verifying a
different file — especially a reference implementation — proves nothing about
your work, and the harness cannot tell the difference for you.

Deterministic: it drives the program against a fake USB sound card and
measures the real audio output. Exit 0 means every check passed. If it reports
failures, fix the case named — do not rewrite the file.

`~/projects/local-ai-stack/grader/cw_filter.py` is a known-good reference
implementation (11/11). Read it for ideas if you are stuck — but verify **your**
file, not that one.

## Machine facts

- Debian 13, i5-6500T, 23 GB RAM, P106-100 (6 GB) on the Vulkan path
- Ollama 0.32.15 on `127.0.0.1:11434`, `gemma4:e4b-it-qat` (~30 tok/s)
- Node 22 is in `~/.local/node`; the system Node 20 cannot run Pi
- No passwordless sudo
- Python with numpy/scipy: `~/projects/local-ai-stack/grader/.venv/bin/python3` (system
  python3 has neither; `pip install` is blocked by PEP 668)
- Context window is **8192** and cannot be raised from Pi (`/v1` ignores
  `num_ctx`). Measurements: `~/.pi/agent/gate-log.md`
