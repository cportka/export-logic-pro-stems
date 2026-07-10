#!/usr/bin/env bash
#
# run-tests.sh — basic suite scaffolded by repo-bootstrap (Portka standard).
# Binds to the repo's version source of truth (package.json / pyproject.toml / Cargo.toml /
# VERSION / README **Version:**), checks it is SemVer and that CHANGELOG.md and the README
# version line agree, then runs any tests/cases/*.sh. Exit 0 if nothing FAILed, 1 otherwise.
#
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "cannot cd to repo root: $ROOT" >&2; exit 1; }

PASS=0; FAIL=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); }

# Find the version source of truth, preferring a project manifest over a bare VERSION / README.
detect_version() {
  local v=""
  if [[ -f package.json ]]; then
    if command -v node >/dev/null 2>&1; then
      v="$(node -e 'try{process.stdout.write(String(require("./package.json").version||""))}catch(e){}' 2>/dev/null)"
    elif command -v python3 >/dev/null 2>&1; then
      v="$(python3 -c 'import json;print(json.load(open("package.json")).get("version") or "")' 2>/dev/null)"
    else
      v="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1)"
    fi
    if [[ -n "$v" ]]; then printf 'package.json\t%s\n' "$v"; return; fi
  fi
  local f
  for f in pyproject.toml Cargo.toml; do
    if [[ -f "$f" ]]; then
      v="$(sed -n 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1)"
      if [[ -n "$v" ]]; then printf '%s\t%s\n' "$f" "$v"; return; fi
    fi
  done
  if [[ -f VERSION ]]; then
    v="$(tr -d '[:space:]' < VERSION)"
    if [[ -n "$v" ]]; then printf 'VERSION\t%s\n' "$v"; return; fi
  fi
  if [[ -f README.md ]]; then
    v="$(sed -n 's/.*\*\*Version:\*\*[[:space:]]*\([0-9][^ |]*\).*/\1/p' README.md | head -1)"
    if [[ -n "$v" ]]; then printf 'README.md\t%s\n' "$v"; return; fi
  fi
}

SRC_VER="$(detect_version)"
SRC="$(printf '%s' "$SRC_VER" | cut -f1)"
VER="$(printf '%s' "$SRC_VER" | cut -f2-)"

if [[ -z "$SRC_VER" ]]; then
  fail "no version source found (package.json / pyproject.toml / Cargo.toml / VERSION / README **Version:**)"
else
  if [[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.]+)?$ ]]; then
    pass "version is SemVer ($VER from $SRC)"
  else
    fail "version '$VER' (from $SRC) is not SemVer"
  fi
  if [[ -f CHANGELOG.md ]]; then
    # Anchor to a real Keep-a-Changelog heading (## [x.y.z]) — a bare substring match also passed on
    # a URL, a prose mention, or an unrelated version, so a CHANGELOG with no release section for
    # $VER could slip through. Escape dots; brackets are optional (## [1.2.3] or ## 1.2.3).
    _ver_re="^##[[:space:]]+\[?${VER//./\\.}\]?([[:space:]]|\$)"
    if grep -qE "$_ver_re" CHANGELOG.md; then
      pass "CHANGELOG.md has a release section for $VER"
    else
      fail "CHANGELOG.md has no '## [$VER]' release section"
    fi
  fi
  # Cross-check the README version line only when one exists (don't force the convention on repos
  # that track their version elsewhere — requiring it is what made the old scaffold ship red, #59).
  if [[ -f README.md ]] && grep -q '\*\*Version:\*\*' README.md; then
    if grep -qF "**Version:** $VER" README.md; then
      pass "README **Version:** line matches ($VER)"
    else
      fail "README **Version:** line disagrees with $SRC ($VER)"
    fi
  fi
fi

shopt -s nullglob
for t in tests/cases/*.sh; do
  if bash "$t"; then pass "case: $t"; else fail "case: $t"; fi
done

echo
echo "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
