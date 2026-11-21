#!/usr/bin/env bash
# Docs checks: nothing private in published files, and what the docs say about
# the scripts and workflow is true. Runs offline, no Pi session, no GPU.
#
#   ./tests/docs/run-checks.sh
#
# What it catches:
#   - private-range IPs, personal home/data paths, secrets-file paths, token-looking strings
#   - a flag that a doc passes to bootstrap/install-harness/verify-stack but the script lacks
#   - a prompt in harness/prompts/ that install-stack.md never mentions
#   - a repo file named in install-stack.md or vmsetup.md that does not exist
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$REPO"

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf 'PASS %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/     /'; return 0; }

if git ls-files >/dev/null 2>&1; then
  FILES=$(git ls-files | grep -E '\.(md|sh|ts|mjs|py|json|yaml|service|txt)$' || true)
else
  FILES=$(find . -type f -not -path './.git/*' | sed 's#^\./##' | grep -E '\.(md|sh|ts|mjs|py|json|yaml|service|txt)$' || true)
fi
FILES=$(printf '%s\n' "$FILES" | grep -v '^tests/docs/run-checks.sh$' || true)

scan() { # scan LABEL REGEX
  local hits
  hits=$(printf '%s\n' "$FILES" | xargs -r grep -nE -- "$2" 2>/dev/null || true)
  if [ -z "$hits" ]; then ok "$1"; else bad "$1" "$hits"; fi
}

scan "no private-range IPv4 addresses" \
  '(^|[^0-9.])(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})([^0-9]|$)'
scan "no personal home or data paths" '(/home/[a-z][a-z0-9_-]*/|/data/[a-z][a-z0-9_-]*/)'
scan "no secrets-file paths" 'secrets\.env'
scan "no user@private-host ssh lines" '[a-z][a-z0-9_-]*@(10|192|172)\.[0-9]'
scan "no token-looking strings" '(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{24,})'

DOCS="README.md install-stack.md vmsetup.md"
for d in docs/*.md; do [ -f "$d" ] && DOCS="$DOCS $d"; done

# every --flag a doc passes to a script must exist in that script
for s in bootstrap.sh install-harness.sh verify-stack.sh; do
  [ -f "$s" ] || continue
  missing=""
  for flag in $(for d in $DOCS; do [ -f "$d" ] && grep -hoE "\./$s [^\`|&;#)]*" "$d" || true; done | grep -oE -- '--[a-z0-9][a-z0-9-]*' | sort -u); do
    grep -q -- "$flag" "$s" || missing="$missing $flag"
  done
  if [ -z "$missing" ]; then ok "docs only use flags that $s has"; else bad "docs use flags $s lacks:$missing"; fi
done

# every prompt in the repo is documented in install-stack.md
if [ -f install-stack.md ]; then
  missing=""
  for p in harness/prompts/*.md; do
    n=$(basename "$p" .md)
    grep -qE "/$n([^a-z-]|$)" install-stack.md || missing="$missing /$n"
  done
  if [ -z "$missing" ]; then ok "install-stack.md mentions every prompt command"; else bad "install-stack.md omits:$missing"; fi
fi

# repo files named in the install docs exist (files the workflow *produces* are allowed)
PRODUCED='BRIEF.md PLAN.md HANDOFF.md DEBUG.md DEPLOY.md session-content.md gates.json debian.sources'
missing=""
for d in install-stack.md vmsetup.md; do
  [ -f "$d" ] || continue
  for f in $(grep -oE '`[A-Za-z0-9_./-]+\.(md|sh|py|json|ts|mjs)`' "$d" | tr -d '`' | sort -u); do
    case "$f" in /*|~*|*'$'*) continue ;; esac
    case " $PRODUCED " in *" $(basename "$f") "*) continue ;; esac
    [ -e "$f" ] || [ -e "harness/$f" ] || missing="$missing $f"
  done
done
if [ -z "$missing" ]; then ok "files named in the install docs exist"; else bad "install docs name missing files:$missing"; fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
