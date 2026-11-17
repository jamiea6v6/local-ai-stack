#!/usr/bin/env bash
# Run the harness-extension checks without starting Pi.
#
# The extensions import Pi's own packages, so the test copies them into a
# scratch dir with minimal stubs and drives the registered tools directly.
# This is not a substitute for a live session — it is the regression gate for
# the seams a small model actually hits: sketch layout, FQBN sourcing, project
# gates, venv interpreter, and the PDF guard.
#
#   ./tests/extensions/run-checks.sh
#
# Requires node >= 22 for --experimental-strip-types. The compile cases need
# arduino-cli (and the board core); they are skipped if it is not installed.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

stub() {
  local pkg=$1
  mkdir -p "$WORK/node_modules/$pkg"
  printf '{"name":"%s","type":"module","main":"index.js"}\n' "$pkg" > "$WORK/node_modules/$pkg/package.json"
  cat > "$WORK/node_modules/$pkg/index.js"
}

stub @earendil-works/pi-coding-agent <<'EOF'
export function formatSize(n){ return `${Math.round(n/1024)} KB`; }
export function truncateHead(text,{maxLines,maxBytes}){
  const lines=text.split("\n");
  let out=lines.slice(0,maxLines).join("\n");
  if(Buffer.byteLength(out)>maxBytes){ out=Buffer.from(out).subarray(0,maxBytes).toString("utf8"); }
  return {content:out,truncated:out.length<text.length,outputLines:out.split("\n").length,
          totalLines:lines.length,outputBytes:Buffer.byteLength(out),totalBytes:Buffer.byteLength(text)};
}
EOF
stub @earendil-works/pi-tui <<'EOF'
export class Text { constructor(text){ this.text=text; } }
EOF
stub typebox <<'EOF'
export const Type = {
  Object:(p)=>({type:"object",properties:p}),
  String:(o)=>({type:"string",...o}),
  Number:(o)=>({type:"number",...o}),
  Optional:(t)=>t,
};
EOF

cp "$REPO/harness/extensions/compile.ts" "$REPO/harness/extensions/verify.ts" \
   "$REPO/harness/extensions/webfetch.ts" "$WORK/"
cp "$REPO/tests/extensions/cases.mjs" "$WORK/test.mjs"

cd "$WORK"
exec node --experimental-strip-types test.mjs
