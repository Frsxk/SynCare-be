#!/usr/bin/env bash
# Guard against the UI silently failing to boot.
#
# A syntax error inside public/index.html's <script> block stops the ENTIRE
# script from running: the page still renders its static HTML, so it looks fine
# in a screenshot while every button is dead. That exact failure shipped once
# (an unbraced for-loop), so this check is now part of the test suite.
#
# Usage: bash scripts/check-ui-js.sh
set -uo pipefail
cd "$(dirname "$0")/.."

export PATH="$HOME/.bun/bin:$PATH"
HTML="public/index.html"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! grep -q '<script>' "$HTML"; then
  echo "check-ui-js: no <script> block found in $HTML" >&2
  exit 1
fi

python3 - "$HTML" "$TMP/ui.js" <<'PY'
import re, sys, pathlib
html = pathlib.Path(sys.argv[1]).read_text()
blocks = re.findall(r'<script>(.*?)</script>', html, re.S)
if not blocks:
    sys.exit('no inline script extracted')
pathlib.Path(sys.argv[2]).write_text('\n'.join(blocks))
print(f'check-ui-js: extracted {len(blocks)} inline script block(s)')
PY

if bun build "$TMP/ui.js" --target=browser --outfile="$TMP/out.js" 2>&1 | grep -qE '^error|error:'; then
  echo "check-ui-js: FAILED — inline JS does not parse:" >&2
  bun build "$TMP/ui.js" --target=browser --outfile="$TMP/out.js" 2>&1 | tail -15 >&2
  exit 1
fi

echo "check-ui-js: OK — inline JS parses cleanly"