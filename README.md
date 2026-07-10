# Export Logic Pro Stems

> **Version:** 0.4.0 · **App:** [cportka.github.io/export-logic-pro-stems](https://cportka.github.io/export-logic-pro-stems/) · **License:** [MIT](./LICENSE) · **Changelog:** [CHANGELOG.md](./CHANGELOG.md)

Export stems from Logic Pro projects — **both** the dry recorded audio **and** wet stems with the
channel-strip effects and automation baked in.

It has two halves that share one idea of a "stem":

| | **Dry stems** (no effects/automation) | **Wet stems** (effects + automation) |
| :-- | :-- | :-- |
| What | The raw audio recorded into the project | Each track rendered through its channel strip |
| Where it runs | **Your browser** — the [GitHub Pages app](https://cportka.github.io/export-logic-pro-stems/), or the Python CLI | **macOS + Logic Pro** — the bounce companion drives Logic |
| Why | A browser can read the project's `Media/` folder directly | A browser can't run Logic's Audio Unit plugins; only Logic can render them |

Nothing is uploaded anywhere — the web app processes every file locally in your browser.

## The web app (dry stems, any OS)

Open **[the app](https://cportka.github.io/export-logic-pro-stems/)** and:

1. **Drop** a `.logicx` project folder (it reads audio from the package's `Media/` folder) or any
   folder of exported audio.
2. **Choose settings** — output format (lossless passthrough, or convert to 16/24-bit WAV), an
   optional **reference-length take split** for multi-take overdubs, and a filename template.
3. **List** the detected tracks, tick the ones you want.
4. **Download** them individually or as a single ZIP.

Everything runs client-side; your audio never leaves your machine.

### Install it as a desktop app (PWA)

The app is a **Progressive Web App**: in a Chromium browser (Chrome / Edge / Arc / Brave) click the
install icon in the address bar to add it to your dock or home screen. It then opens in its own
window, works **offline**, and — via the File System Access API — offers **"Save to folder…"**,
which writes the exported stems straight into a folder you pick once (remembered across launches)
instead of downloading a ZIP. Other browsers (Safari, Firefox) use the ZIP download.

> A browser — even an installed PWA — can't run Logic Pro. The PWA fully handles **dry** stems; for
> **wet** stems it still hands you the [companion command](#wet-stems-effects--automation--macos--logic-pro).
> Driving Logic from inside the UI needs a native shell (e.g. Tauri/Electron) around this same
> front-end — a natural next step.

### The same thing from the command line

`scripts/extract-dry-stems.py` is a dependency-free (Python 3 stdlib only) batch version:

```bash
# copy each track's audio out of the project, renamed
python3 scripts/extract-dry-stems.py -o ./Stems "MySong.logicx"

# split multi-take overdub files into takes by a reference track's length (WAV)
python3 scripts/extract-dry-stems.py -o ./Stems --split --ref COMP ./Projects

# organise a folder of already-exported audio
python3 scripts/extract-dry-stems.py -o ./Stems --template "{project}_{track}" ./Bounced
```

## Wet stems (effects + automation) — macOS + Logic Pro

Stems with the effects chain and automation rendered in must be bounced by Logic Pro itself. The
companion script drives Logic's **File ▸ Export ▸ All Tracks as Audio Files…**:

```bash
scripts/bounce-wet-stems.sh --out "~/Desktop/Stems" --format wav --bit-depth 24 "MySong.logicx"
```

Requirements: macOS with Logic Pro, and Accessibility permission for your terminal
(System Settings ▸ Privacy & Security ▸ Accessibility). The dialog automation is **best-effort** —
Logic's export sheet varies between versions, so if it can't complete it leaves the dialog open for
you to finish, and `--manual` just opens each project at the right menu. The web app's "Wet stems"
card generates the exact command for your chosen settings; drop the bounced folder back into the app
to rename, split, and ZIP it.

## Drive everything from the UI — the local companion

Want to stay in the app and have it run the scripts and Logic Pro for you? Run the
**[local companion](./companion/)** on your Mac:

```bash
python3 companion/stem-companion.py --open
```

It opens the app already paired. The app's **"Local companion"** card can then **extract dry stems
straight to disk** and **bounce wet stems through Logic Pro** — you never leave the browser. The
companion binds `127.0.0.1` only and is gated by a per-run pairing token (details + security notes in
[`companion/README.md`](./companion/README.md)).

## Development

This repo follows the **Portka standard workflow** (see [.claude/CLAUDE.md](./.claude/CLAUDE.md)) and
uses the `portka-tools` Claude Code marketplace (see [.claude/settings.json](./.claude/settings.json)).
Every change goes on a branch, updates tests + CI, and merges on green. The version follows
[SemVer](https://semver.org) and stays in sync across `package.json`, `CHANGELOG.md`, and the
`**Version:**` line above.

```bash
npm test                 # Node unit tests (pure lib: ZIP/WAV/naming/splitting) + version sync
bash tests/run-tests.sh  # version sync + file/syntax checks + the Node suite
```

The audio/ZIP/naming logic lives in [`docs/js/stem-lib.js`](./docs/js/stem-lib.js) as a pure ES
module so it can be unit-tested outside a browser and reused by the app and the CLI's shared
conventions.

### Project layout

```
docs/                     GitHub Pages app + PWA (static, no build)
  index.html  css/  manifest.webmanifest  sw.js  icons/
  js/stem-lib.js (pure)  js/app.js (browser UI)  js/companion.js (companion client)
scripts/
  extract-dry-stems.py    dry stems on any OS (stdlib)
  bounce-wet-stems.sh     wet stems on macOS via Logic Pro
  bounce-wet-stems.applescript
companion/
  stem-companion.py       local daemon the web UI calls (runs the scripts / drives Logic)
tests/                    node --test + python unittest suites, run-tests.sh
```
