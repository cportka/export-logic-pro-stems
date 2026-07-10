# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog
(https://keepachangelog.com) and the project uses Semantic Versioning (https://semver.org).
Every change bumps the version and adds an entry below.

## [0.3.0] - 2026-07-10

### Added
- **Local companion** (`companion/stem-companion.py`) — a small Python-stdlib daemon that lets the
  web UI run native work on your Mac while you stay in the browser: it extracts dry stems straight
  to disk and bounces **wet** stems through Logic Pro. It binds `127.0.0.1` only, is gated by a
  per-run **pairing token**, allow-lists request origins, answers CORS + Private-Network preflights
  (so the GitHub Pages app can reach it), and exposes only fixed, validated endpoints — no arbitrary
  shell.
- A **Companion card** in the app: pair via the URL fragment (from `--open`) or by hand, see the
  connection + whether Logic Pro was detected, scan a folder for `.logicx` projects, and run
  "Extract dry stems → disk" or "Export wet stems (Logic Pro)" — with the run output shown inline.

## [0.2.0] - 2026-07-10

### Added
- The web app is now an installable **PWA**: add it to your dock / home screen, it runs **offline**
  (a service worker caches the app shell), and it ships app icons + a web manifest.
- **"Save to folder…"** — in Chromium desktop browsers, the File System Access API writes the
  exported stems straight into a folder you pick once (remembered across launches via IndexedDB),
  instead of downloading a ZIP. The ZIP download remains the universal fallback everywhere else.

## [0.1.0] - 2026-07-09

Initial release of the restarted project — proper stem export from Logic Pro projects, both dry and
wet.

### Added
- **GitHub Pages web app** (`docs/`): drop a `.logicx` project folder or an audio folder, list the
  detected tracks with durations, choose settings (lossless passthrough or 16/24-bit WAV, optional
  reference-length take splitting, filename template), and download individually or as a ZIP — all
  processed locally in the browser, nothing uploaded.
- **`docs/js/stem-lib.js`**: a pure, environment-agnostic ES module for the tricky logic — store-only
  ZIP + CRC-32, PCM WAV encoding, cheap WAV/AIFF header probing, take-splitting math, reference-track
  detection, and filename templating — unit-tested outside the browser.
- **`scripts/extract-dry-stems.py`**: a dependency-free (stdlib) CLI that extracts dry per-track
  stems and can split multi-take WAVs by a reference length, mirroring the app's conventions.
- **`scripts/bounce-wet-stems.sh` + `.applescript`**: a macOS companion that drives Logic Pro's
  *Export All Tracks as Audio Files* to render wet stems (effects + automation), with a `--manual`
  fallback and honest, version-tolerant GUI scripting.
- **Portka standard** integration via `repo-bootstrap`: workflow `CLAUDE.md`, the `portka-tools`
  marketplace + enabled plugins, a git/`gh` permissions allowlist, enforced SemVer version sync, a
  test suite (`tests/`), and CI.
- **CI + GitHub Pages** deploy workflow.

### Removed
- The old `export-overdubs.py` / `run-export-overdubs.sh` overdub-splitting scripts, superseded by
  the web app and `extract-dry-stems.py`.
