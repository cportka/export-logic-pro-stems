#!/usr/bin/env bash
# Run the companion daemon tests.
set -uo pipefail
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found — skipping companion tests" >&2
  exit 0
fi
python3 tests/test_companion.py
