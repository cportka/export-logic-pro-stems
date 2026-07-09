#!/usr/bin/env bash
#
# bounce-wet-stems.sh — render "wet" stems (channel-strip effects + automation baked in)
# from Logic Pro projects on macOS.
#
# WHY THIS EXISTS: a browser cannot run Logic's Audio Unit plugins, so stems that include
# the effects chain and automation must be bounced by Logic Pro itself. This companion
# drives Logic's  File ▸ Export ▸ "All Tracks as Audio Files…"  via AppleScript GUI
# scripting, one project at a time, into <out>/<Project>/.
#
# REQUIREMENTS
#   • macOS with Logic Pro installed.
#   • Accessibility permission for your terminal (System Settings ▸ Privacy & Security ▸
#     Accessibility) — GUI scripting is blocked without it.
#
# HONEST CAVEAT: Logic's export sheet layout differs between versions, so the automated
# dialog handling in bounce-wet-stems.applescript is BEST-EFFORT. If it can't complete, it
# leaves the project open with the export dialog up so you can finish by hand — the script
# tells you exactly which controls to set. Use --manual to skip automation entirely and just
# open each project at the right menu.
#
# Usage:
#   bounce-wet-stems.sh --out DIR [--format wav|aiff|caf] [--bit-depth 16|24] \
#                       [--manual] [--dry-run] <Project.logicx> [more ...]
#
set -euo pipefail

OUT="$HOME/Desktop/Stems"
FORMAT="wav"
BIT_DEPTH="24"
MANUAL=""
DRY_RUN=""
PROJECTS=()

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLESCRIPT="$SCRIPT_DIR/bounce-wet-stems.applescript"

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="${2:?}"; shift 2 ;;
    --format) FORMAT="${2:?}"; shift 2 ;;
    --bit-depth) BIT_DEPTH="${2:?}"; shift 2 ;;
    --manual) MANUAL="1"; shift ;;
    --dry-run) DRY_RUN="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) PROJECTS+=("$1"); shift ;;
  esac
done

OUT="${OUT/#\~/$HOME}"

if [[ ${#PROJECTS[@]} -eq 0 ]]; then
  echo "Error: no .logicx projects given." >&2
  usage
  exit 2
fi

case "$FORMAT" in wav|aiff|caf) ;; *) echo "Error: --format must be wav|aiff|caf." >&2; exit 2 ;; esac
case "$BIT_DEPTH" in 16|24) ;; *) echo "Error: --bit-depth must be 16 or 24." >&2; exit 2 ;; esac

if [[ "$(uname)" != "Darwin" ]]; then
  echo "Error: wet-stem export needs macOS + Logic Pro (this is $(uname))." >&2
  echo "For dry stems on any OS, use scripts/extract-dry-stems.py or the web app." >&2
  exit 1
fi

if ! osascript -e 'id of application "Logic Pro"' >/dev/null 2>&1; then
  echo "Error: Logic Pro was not found on this Mac." >&2
  exit 1
fi

mkdir -p "$OUT"
echo "Output: $OUT   Format: $FORMAT ${BIT_DEPTH}-bit   Projects: ${#PROJECTS[@]}"

status=0
for raw in "${PROJECTS[@]}"; do
  proj="${raw/#\~/$HOME}"
  if [[ ! -e "$proj" ]]; then
    echo "warning: skipping missing project: $raw" >&2
    status=1
    continue
  fi
  # Resolve to an absolute path (a .logicx is a package/directory).
  proj="$(cd "$(dirname "$proj")" && pwd)/$(basename "$proj")"
  name="$(basename "${proj%.logicx}")"
  dest="$OUT/$name"
  mkdir -p "$dest"

  echo ""
  echo "▶ $name"
  if [[ -n "$DRY_RUN" ]]; then
    echo "  [dry-run] would bounce all tracks of \"$proj\" -> \"$dest\" ($FORMAT ${BIT_DEPTH}-bit)"
    continue
  fi
  if [[ -n "$MANUAL" ]]; then
    echo "  Opening in Logic Pro. Then: File ▸ Export ▸ All Tracks as Audio Files…"
    echo "  Destination: $dest   Format: $FORMAT   Bit depth: $BIT_DEPTH"
    osascript -e 'on run {p}' -e 'tell application "Logic Pro" to (activate & open (POSIX file p))' -e 'end run' "$proj" || true
    continue
  fi

  if [[ ! -f "$APPLESCRIPT" ]]; then
    echo "  Error: missing $APPLESCRIPT" >&2
    status=1
    continue
  fi
  if osascript "$APPLESCRIPT" "$proj" "$dest" "$FORMAT" "$BIT_DEPTH"; then
    echo "  Bounced -> $dest"
  else
    echo "  Automation did not complete for \"$name\". Finish the open export dialog by hand," >&2
    echo "  or re-run with --manual. (Check Accessibility permission for your terminal.)" >&2
    status=1
  fi
done

exit "$status"
