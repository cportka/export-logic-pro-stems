#!/usr/bin/env python3
"""stem-companion.py — a tiny local daemon that lets the web app run native work on your Mac.

The GitHub Pages app can't run scripts or drive Logic Pro (browser sandbox). This companion runs
on your machine and exposes a small, locked-down HTTP API on 127.0.0.1 that the web UI calls. It
shells out to the same scripts shipped in scripts/:
  • /extract-dry  → extract-dry-stems.py  (dry per-track stems, any OS)
  • /bounce-wet   → bounce-wet-stems.sh    (wet stems via Logic Pro, macOS)

SECURITY — a localhost server that can run scripts and drive your OS is powerful, so:
  • It binds 127.0.0.1 only (never exposed on your network).
  • Every request needs a per-run PAIRING TOKEN (printed on startup; a random website can't read
    it — it lives in the app URL's fragment, which is never sent over the network).
  • Browser requests must come from an allow-listed Origin (the app + localhost by default).
  • There is NO "run an arbitrary command" endpoint — only the fixed operations below, invoked with
    argument arrays (never a shell string).

Usage:
  python3 companion/stem-companion.py                 # start; prints the pairing link
  python3 companion/stem-companion.py --open          # …and open the app in your browser
  python3 companion/stem-companion.py --port 8765 --app-url https://cportka.github.io/export-logic-pro-stems/
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import subprocess
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "0.3.0"
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_APP_URL = "https://cportka.github.io/export-logic-pro-stems/"

CONFIG = {
    "token": "",
    "scripts_dir": os.path.join(REPO_ROOT, "scripts"),
    "allow_origins": set(),   # explicit extra origins
    "app_origin": "",         # origin derived from --app-url
}


# ----------------------------------------------------------------------------- helpers

def is_macos() -> bool:
    return sys.platform == "darwin"


def has_logic() -> bool:
    if not is_macos():
        return False
    try:
        return subprocess.run(["osascript", "-e", 'id of application "Logic Pro"'],
                              capture_output=True, timeout=10).returncode == 0
    except Exception:
        return False


def origin_allowed(origin: str) -> bool:
    """Browser requests carry an Origin; non-browser (curl) requests don't. Allow the app origin,
    any localhost/127.0.0.1 page (the user's own machine), and any explicitly allow-listed origin."""
    if not origin:
        return True  # not a browser CSRF vector; the token still gates the request
    if origin in CONFIG["allow_origins"] or origin == CONFIG["app_origin"]:
        return True
    try:
        host = urllib.parse.urlparse(origin).hostname
    except Exception:
        return False
    return host in ("localhost", "127.0.0.1", "::1")


def run_script(argv, timeout=1800):
    """Run a script with an argument array (never a shell string). Returns (code, stdout, stderr)."""
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd=REPO_ROOT)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"
    except FileNotFoundError as e:
        return 127, "", str(e)


def list_files(root):
    out = []
    for base, _dirs, files in os.walk(root):
        for f in files:
            full = os.path.join(base, f)
            out.append(os.path.relpath(full, root))
    return sorted(out)


# ---------------------------------------------------------------------------- request handler

class Handler(BaseHTTPRequestHandler):
    server_version = f"stem-companion/{VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter logging
        sys.stderr.write("  %s - %s\n" % (self.address_string(), fmt % args))

    # -- CORS / responses --
    def _cors(self, origin):
        if origin and origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Companion-Token")
            self.send_header("Access-Control-Allow-Private-Network", "true")  # Chrome PNA preflight
            self.send_header("Access-Control-Max-Age", "600")

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        origin = self.headers.get("Origin", "")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors(origin)
        self.end_headers()
        self.wfile.write(body)

    def _guard(self):
        """Return None if OK to proceed, else send an error and return the error code."""
        origin = self.headers.get("Origin", "")
        if origin and not origin_allowed(origin):
            self._send(403, {"ok": False, "error": "origin not allowed"})
            return 403
        token = self.headers.get("X-Companion-Token", "")
        if not token:
            # allow token via query string as a fallback
            q = urllib.parse.urlparse(self.path).query
            token = urllib.parse.parse_qs(q).get("token", [""])[0]
        if not (CONFIG["token"] and secrets.compare_digest(token, CONFIG["token"])):
            self._send(401, {"ok": False, "error": "missing or invalid pairing token"})
            return 401
        return None

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return None

    # -- routes --
    def do_OPTIONS(self):
        origin = self.headers.get("Origin", "")
        self.send_response(204)
        self._cors(origin)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/health":
            if self._guard():
                return
            self._send(200, {
                "ok": True,
                "version": VERSION,
                "platform": sys.platform,
                "macos": is_macos(),
                "logic": has_logic(),
                "scriptsDir": CONFIG["scripts_dir"],
            })
            return
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if self._guard():
            return
        body = self._body()
        if body is None:
            self._send(400, {"ok": False, "error": "invalid JSON body"})
            return
        if path == "/projects":
            self._projects(body)
        elif path == "/extract-dry":
            self._extract_dry(body)
        elif path == "/bounce-wet":
            self._bounce_wet(body)
        else:
            self._send(404, {"ok": False, "error": "not found"})

    # -- handlers --
    def _projects(self, body):
        d = os.path.abspath(os.path.expanduser(str(body.get("dir", "")).strip()))
        if not d or not os.path.isdir(d):
            self._send(400, {"ok": False, "error": "dir not found"})
            return
        found = []
        for base, dirs, _files in os.walk(d):
            for name in list(dirs):
                if name.lower().endswith(".logicx"):
                    p = os.path.join(base, name)
                    media = os.path.join(p, "Media")
                    n = len(os.listdir(media)) if os.path.isdir(media) else 0
                    found.append({"name": name[:-len(".logicx")], "path": p, "mediaCount": n})
                    dirs.remove(name)  # don't descend into the package
        self._send(200, {"ok": True, "projects": sorted(found, key=lambda x: x["name"].lower())})

    def _extract_dry(self, body):
        project = os.path.abspath(os.path.expanduser(str(body.get("project", "")).strip()))
        out = os.path.abspath(os.path.expanduser(str(body.get("out", "")).strip()))
        if not project or not os.path.exists(project):
            self._send(400, {"ok": False, "error": "project not found"})
            return
        if not out:
            self._send(400, {"ok": False, "error": "out is required"})
            return
        argv = [sys.executable, os.path.join(CONFIG["scripts_dir"], "extract-dry-stems.py"), "-o", out]
        if body.get("template"):
            argv += ["--template", str(body["template"])]
        if body.get("split"):
            argv += ["--split"]
            if body.get("ref"):
                argv += ["--ref", str(body["ref"])]
        if body.get("includeAll"):
            argv += ["--include-all"]
        argv.append(project)
        code, so, se = run_script(argv, timeout=1800)
        self._send(200, {"ok": code == 0, "code": code, "stdout": so, "stderr": se,
                         "out": out, "files": list_files(out) if os.path.isdir(out) else []})

    def _bounce_wet(self, body):
        projects = [str(p) for p in body.get("projects", []) if str(p).strip()]
        out = os.path.abspath(os.path.expanduser(str(body.get("out", "")).strip()))
        if not projects:
            self._send(400, {"ok": False, "error": "projects is required"})
            return
        if not out:
            self._send(400, {"ok": False, "error": "out is required"})
            return
        fmt = str(body.get("format", "wav"))
        depth = str(body.get("bitDepth", "24"))
        argv = ["bash", os.path.join(CONFIG["scripts_dir"], "bounce-wet-stems.sh"),
                "--out", out, "--format", fmt, "--bit-depth", depth]
        if body.get("manual"):
            argv += ["--manual"]
        if body.get("dryRun"):
            argv += ["--dry-run"]
        argv += [os.path.abspath(os.path.expanduser(p)) for p in projects]
        code, so, se = run_script(argv, timeout=3600)
        self._send(200, {"ok": code == 0, "code": code, "stdout": so, "stderr": se,
                         "out": out, "files": list_files(out) if os.path.isdir(out) else []})


def build_server(host, port):
    return ThreadingHTTPServer((host, port), Handler)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Local companion for the Logic Pro stem exporter.")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1; keep it local)")
    ap.add_argument("--port", type=int, default=8765, help="port (default 8765; 0 picks a free one)")
    ap.add_argument("--app-url", default=DEFAULT_APP_URL, help="web app URL to pair with")
    ap.add_argument("--allow-origin", action="append", default=[], help="extra allowed Origin (repeatable)")
    ap.add_argument("--token", default=os.environ.get("STEM_COMPANION_TOKEN", ""), help="pairing token (default: random)")
    ap.add_argument("--open", action="store_true", help="open the app in your browser once started")
    args = ap.parse_args(argv)

    CONFIG["token"] = args.token or secrets.token_urlsafe(24)
    CONFIG["allow_origins"] = set(args.allow_origin)
    CONFIG["app_origin"] = "{u.scheme}://{u.netloc}".format(u=urllib.parse.urlparse(args.app_url)) if args.app_url else ""

    httpd = build_server(args.host, args.port)
    port = httpd.server_address[1]
    base = f"http://{args.host}:{port}"
    pair_url = f"{args.app_url}#companion={args.host}:{port}&token={CONFIG['token']}"

    print(f"stem-companion {VERSION} listening on {base}  (macOS={is_macos()}, Logic={has_logic()})")
    print(f"Pairing token: {CONFIG['token']}")
    print("Open this to connect the app:")
    print(f"  {pair_url}")
    print("Keep this window open while you work; press Ctrl-C to stop.")

    if args.open:
        opener = "open" if is_macos() else ("xdg-open" if sys.platform.startswith("linux") else "")
        if opener:
            try:
                subprocess.Popen([opener, pair_url])
            except Exception:
                pass

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
