# Local companion

A small daemon that lets the [web app](https://cportka.github.io/export-logic-pro-stems/) run native
work on your Mac while you stay in the browser UI. It shells out to the scripts in `../scripts/`:
dry-stem extraction (any OS) and — the reason it exists — **wet**-stem bounces through Logic Pro
(macOS). A browser can't do either; this can.

## Run it

Needs Python 3 (macOS: `xcode-select --install`, or Homebrew). No dependencies.

```bash
python3 companion/stem-companion.py --open
```

It prints a **pairing token** and a URL. `--open` launches that URL, which connects the app
automatically. Or open the app, expand **"Local companion"**, and paste the address + token by hand.
Keep the window open while you work; `Ctrl-C` stops it.

```
python3 companion/stem-companion.py [--port 8765] [--open] \
    [--app-url https://cportka.github.io/export-logic-pro-stems/] [--allow-origin URL] [--token TOKEN]
```

## What it exposes

`POST` bodies are JSON; every request needs the `X-Companion-Token` header.

| Endpoint | Does |
| :-- | :-- |
| `GET /health` | version, platform, whether Logic Pro was detected |
| `POST /projects` `{dir}` | list `.logicx` packages under a folder |
| `POST /extract-dry` `{project,out,template?,split?,ref?,includeAll?}` | run `extract-dry-stems.py` |
| `POST /bounce-wet` `{projects[],out,format?,bitDepth?,manual?}` | run `bounce-wet-stems.sh` (drives Logic) |

## Security

A localhost server that runs scripts and can drive your OS is powerful, so it is deliberately locked
down:

- **Binds `127.0.0.1` only** — never exposed on your network.
- **Pairing token** — every request must present the per-run token. It travels in the app URL's
  **fragment**, which browsers never send over the network, so another website can't read it.
- **Origin allow-list** — browser requests must come from the app origin or `localhost`/`127.0.0.1`;
  others get `403`.
- **CORS + Private-Network preflight** — answered so the `https://` GitHub Pages app can reach
  `http://127.0.0.1` (a browser exception for localhost), including Chrome's PNA check.
- **No arbitrary commands** — only the fixed endpoints above, each invoked with an argument array
  (never a shell string), with validated paths.

Even so: only run the companion on a machine you trust, and stop it when you're done.
