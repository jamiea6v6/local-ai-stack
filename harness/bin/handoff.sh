#!/bin/bash
set -u
if [[ ! -f PLAN.md ]]; then
  echo 'PLAN.md missing'
  exit 1
fi
goal="$(awk '/^GOAL:/ {sub(/^GOAL: /, ""); print; exit}' PLAN.md)"
domain="$(awk '/^DOMAIN:/ {sub(/^DOMAIN: /, ""); print; exit}' PLAN.md)"
approval="$(grep -m1 '^APPROVED:' PLAN.md || true)"
[[ -z "$approval" ]] && approval='APPROVED: missing'
done_lines="$(grep '^DONE ' PLAN.md || true)"
if [[ -z "$done_lines" ]]; then
  done='None'
else
  done="$(printf '%s\n' "$done_lines" | paste -sd '; ' -)"
fi
next="$(awk '
  /^DONE [0-9]+: PASS/ { pass[$2]=1 }
  /^STEPS:/ { steps=1; next }
  /^GATES:/ { steps=0 }
  steps && /^[[:space:]]*[0-9]+\./ {
    n=$0; sub(/[^0-9].*/, "", n); n=n+0
    if (!pass[n] && !found) { print n; found=1 }
  }
  END { if (!found) print "none" }
' PLAN.md)"
facts="$(awk '
  /^EVIDENCE:/ { evid=1; next }
  /^FACTS:/ { evid=0 }
  evid && NF>0 { if (c<3) { printf "PLAN.md:%d %s\n", NR, $0; c++ } }
' PLAN.md)"
[[ -z "$facts" ]] && facts='none'
open="$(awk '
  /^QUESTIONS:/ { q=1; next }
  /^STEPS:/ { q=0 }
  q && NF>0 { printf "%s; ", $0 }
' PLAN.md)"
[[ -z "$open" ]] && open='none'
files="$(find . -maxdepth 2 -type f -not -path './.git/*' -printf '%p\n' | sort | paste -sd ' ' -)"
cat > HANDOFF.md <<EOF
GOAL: $goal
DOMAIN: $domain
APPROVAL: ${approval#APPROVED: }
STATE: files present: $files
DONE: $done
NEXT: $next
FACTS: $facts
OPEN: $open
FILES: $files
EOF
echo 'Handoff written. In a new session, read HANDOFF.md and continue with NEXT.'
