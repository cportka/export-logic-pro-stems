#!/usr/bin/env bash
# Assert the web app + processing scripts are present and parse cleanly.
set -uo pipefail
fail=0
need() { [[ -e "$1" ]] || { echo "missing: $1" >&2; fail=1; }; }

for f in \
  docs/index.html docs/css/style.css docs/js/stem-lib.js docs/js/app.js docs/.nojekyll \
  docs/manifest.webmanifest docs/sw.js \
  docs/icons/icon-192.png docs/icons/icon-512.png docs/icons/icon-maskable-512.png docs/icons/apple-touch-icon.png \
  scripts/extract-dry-stems.py scripts/bounce-wet-stems.sh scripts/bounce-wet-stems.applescript; do
  need "$f"
done

if command -v node >/dev/null 2>&1; then
  node --check docs/js/stem-lib.js || fail=1
  node --check docs/js/app.js || fail=1
  node --check docs/sw.js || fail=1
  # manifest must be valid JSON
  node -e "JSON.parse(require('fs').readFileSync('docs/manifest.webmanifest','utf8'))" || fail=1
fi
if command -v python3 >/dev/null 2>&1; then
  python3 -m py_compile scripts/extract-dry-stems.py || fail=1
fi
bash -n scripts/bounce-wet-stems.sh || fail=1

exit "$fail"
