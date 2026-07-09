#!/usr/bin/env bash
# Run the Python unit tests for the dry-stem extractor.
set -uo pipefail
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found — skipping python tests" >&2
  exit 0
fi
python3 tests/test_extract_dry_stems.py
