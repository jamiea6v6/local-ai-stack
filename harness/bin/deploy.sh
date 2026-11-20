#!/bin/bash
set -euo pipefail
cwd="$(pwd)"
out="$cwd/DEPLOY.md"
python3 - "$cwd" "$out" <<'PY'
import os, sys, json, glob, stat
from datetime import datetime

cwd, out = sys.argv[1], sys.argv[2]

def read_text(path, limit=20000):
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read(limit)
    except Exception:
        return ''

def exists(name): return os.path.exists(os.path.join(cwd, name))

skip_dirs = {'.git', '__pycache__', 'node_modules', '.venv', 'venv', 'env', '.mypy_cache', '.pytest_cache', '.ruff_cache'}
files = []
for root, dirs, filenames in os.walk(cwd):
    relroot = os.path.relpath(root, cwd)
    parts = relroot.split(os.sep) if relroot != '.' else []
    dirs[:] = [d for d in dirs if d not in skip_dirs]
    if any(p in skip_dirs for p in parts):
        continue
    for fn in filenames:
        rel = os.path.normpath(os.path.join(relroot, fn)) if relroot != '.' else fn
        files.append(rel)
files = sorted(files)

docs = [f for f in ['README.md','README.txt','README','PLAN.md','BRIEF.md','HANDOFF.md','DESIGN.md','DEPLOY.md','session-content.md'] if exists(f)]
manifests = [f for f in ['requirements.txt','requirements-dev.txt','pyproject.toml','setup.py','setup.cfg','Pipfile','Pipfile.lock','package.json','package-lock.json','Makefile','Dockerfile','docker-compose.yml','compose.yml','gates.json','.env.example'] if exists(f)]
venvs = [d for d in ['.venv','venv','env','.env-venv'] if os.path.isdir(os.path.join(cwd,d))]

entry_candidates = []
for name in ['app.py','main.py','run.py','server.py','index.py','cli.py','__main__.py']:
    if exists(name): entry_candidates.append(name)
# scripts in package.json / pyproject not deeply parsed; note presence
pkg_json = read_text(os.path.join(cwd,'package.json')) if exists('package.json') else ''
makefile = read_text(os.path.join(cwd,'Makefile')) if exists('Makefile') else ''
pyproject = read_text(os.path.join(cwd,'pyproject.toml')) if exists('pyproject.toml') else ''
gates = read_text(os.path.join(cwd,'gates.json')) if exists('gates.json') else ''
plan = read_text(os.path.join(cwd,'PLAN.md')) if exists('PLAN.md') else ''
brief = read_text(os.path.join(cwd,'BRIEF.md')) if exists('BRIEF.md') else ''

def first_lines(text, n=30):
    lines = text.splitlines()
    return '\n'.join(lines[:n])

lines = []
a = lines.append
a('# Deploy / Run Guide')
a('')
a(f'- Generated: `{datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")}`')
a(f'- Project: `{cwd}`')
a('- Source: detected from project files only. Commands below are suggestions; verify before running. No installs performed by this report.')
a('')
a('## Detected files')
a('')
shown = [f for f in files if f != 'DEPLOY.md']
for f in shown[:80]:
    a(f'- `{f}`')
if len(shown) > 80:
    a(f'- ... ({len(shown)-80} more)')
a('')
a('## Docs and manifests')
a('')
a('- Docs: ' + (', '.join(f'`{d}`' for d in docs) if docs else 'none detected'))
a('- Manifests/config: ' + (', '.join(f'`{m}`' for m in manifests) if manifests else 'none detected'))
a('- Virtual env dirs: ' + (', '.join(f'`{v}`' for v in venvs) if venvs else 'none detected'))
a('')
if entry_candidates:
    a('## Likely entrypoints')
    a('')
    for e in entry_candidates:
        a(f'- `{e}`')
    a('')
else:
    a('## Likely entrypoints')
    a('')
    a('- No common Python entrypoint filename detected (`app.py`, `main.py`, etc.). Check docs/manifests below.')
    a('')

a('## Evidence snippets')
a('')
if plan:
    a('### PLAN.md (head)')
    a('')
    a('```')
    a(first_lines(plan, 40))
    a('```')
    a('')
if brief:
    a('### BRIEF.md (head)')
    a('')
    a('```')
    a(first_lines(brief, 40))
    a('```')
    a('')
for name, txt in [('requirements.txt', read_text(os.path.join(cwd,'requirements.txt')) if exists('requirements.txt') else ''),
                  ('pyproject.toml', pyproject), ('package.json', pkg_json), ('Makefile', makefile), ('gates.json', gates)]:
    if txt:
        a(f'### {name} (head)')
        a('')
        a('```')
        a(first_lines(txt, 40))
        a('```')
        a('')

a('## Suggested run steps (verify first)')
a('')
step = 1
if venvs:
    v = venvs[0]
    a(f'{step}. Activate existing virtual environment (if appropriate):')
    a('```bash')
    a(f'source {v}/bin/activate')
    a('```')
    step += 1
if exists('requirements.txt'):
    a(f'{step}. Install dependencies from `requirements.txt` only if needed and approved (may require network/permissions):')
    a('```bash')
    a('python3 -m pip install -r requirements.txt')
    a('```')
    step += 1
elif pyproject:
    a(f'{step}. Project has `pyproject.toml`; install method depends on tooling (pip/poetry/uv). Confirm before running installs.')
    a('')
    step += 1
if exists('package.json'):
    a(f'{step}. Node project detected (`package.json`). Check `scripts` above for run/test commands (e.g. `npm run <script>`), after dependencies are installed.')
    a('')
    step += 1
if exists('Makefile'):
    a(f'{step}. `Makefile` detected; inspect targets above (common: `make run`, `make test`).')
    a('')
    step += 1
# runtime commands
ran = False
for e in entry_candidates:
    a(f'{step}. Run candidate entrypoint:')
    a('```bash')
    if venvs:
        a(f'# with venv activated: python {e}')
    a(f'python3 {e}')
    a('```')
    step += 1
    ran = True
    break
if not ran:
    a(f'{step}. No standard entrypoint detected. Look for run instructions in README/PLAN/BRIEF or manifests above.')
    a('')
    step += 1

a('## Verification / gates')
a('')
if gates:
    a('- `gates.json` detected. If your environment supports it, run:')
    a('```bash')
    a('verify(project=".")  # in Pi, if available')
    a('```')
elif plan and 'GATE' in plan:
    a('- `PLAN.md` contains GATE lines; use the exact gate commands listed there for completed/approved steps.')
else:
    a('- No `gates.json` detected. Verify behavior manually or by running the application/tests specified in docs.')
a('')

a('## Cautions')
a('')
a('- Directions from prior chat may be incomplete; prefer commands evidenced by files above.')
a('- Do not run install/sudo commands without explicit approval and a working package/network setup.')
a('- If audio/hardware devices are involved, confirm device selection, sample rate, and permissions on this machine before testing.')
a('- If behavior is unclear, re-check `PLAN.md`, `BRIEF.md`, and source entrypoints.')
a('')

with open(out, 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines).rstrip() + '\n')
print(f"Wrote {out}")
PY
cat "$out"
