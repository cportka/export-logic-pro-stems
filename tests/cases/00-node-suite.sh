#!/usr/bin/env bash
# Run the Node unit tests (pure lib + version sync) inside the bash suite, so a single
# `bash tests/run-tests.sh` (what CI runs) also exercises the JavaScript logic.
set -uo pipefail
if ! command -v node >/dev/null 2>&1; then
  echo "node not found — skipping node --test" >&2
  exit 0
fi
node --test
