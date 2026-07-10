"""Tests for companion/stem-companion.py (run: python3 tests/test_companion.py).

Starts the real server on an ephemeral port in a background thread and exercises the HTTP API:
token auth, CORS + Private-Network preflight, origin allow-listing, dry extraction to disk, and
input validation.
"""
import importlib.util
import json
import pathlib
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import wave

ROOT = pathlib.Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("cx", ROOT / "companion" / "stem-companion.py")
cx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cx)

TOKEN = "unit-token"


def write_wav(path, seconds, sr=44100):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"\x00\x00" * int(seconds * sr))


def req(method, port, path, token=None, origin=None, body=None):
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    if token:
        r.add_header("X-Companion-Token", token)
    if origin:
        r.add_header("Origin", origin)
    if data is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


class Companion(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cx.CONFIG["token"] = TOKEN
        cx.CONFIG["allow_origins"] = {"http://app.test"}
        cx.CONFIG["app_origin"] = "https://cportka.github.io"
        cx.CONFIG["scripts_dir"] = str(ROOT / "scripts")
        cls.httpd = cx.build_server("127.0.0.1", 0)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def test_health_requires_token(self):
        code, _, _ = req("GET", self.port, "/health")
        self.assertEqual(code, 401)
        code, _, body = req("GET", self.port, "/health", token=TOKEN)
        self.assertEqual(code, 200)
        self.assertTrue(json.loads(body)["ok"])

    def test_preflight_cors_and_private_network(self):
        code, headers, _ = req("OPTIONS", self.port, "/extract-dry", origin="http://app.test")
        self.assertEqual(code, 204)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "http://app.test")
        self.assertEqual(headers.get("Access-Control-Allow-Private-Network"), "true")

    def test_bad_origin_rejected(self):
        code, _, _ = req("GET", self.port, "/health", token=TOKEN, origin="http://evil.test")
        self.assertEqual(code, 403)

    def test_localhost_origin_allowed(self):
        code, _, _ = req("GET", self.port, "/health", token=TOKEN, origin="http://127.0.0.1:5500")
        self.assertEqual(code, 200)

    def test_unknown_route_404(self):
        code, _, _ = req("GET", self.port, "/nope", token=TOKEN)
        self.assertEqual(code, 404)

    def test_extract_dry_writes_files(self):
        with tempfile.TemporaryDirectory() as d:
            media = pathlib.Path(d) / "T.logicx" / "Media"
            media.mkdir(parents=True)
            write_wav(media / "COMP.wav", 1.0)
            write_wav(media / "Gtr.wav", 2.0)
            out = pathlib.Path(d) / "out"
            code, _, body = req("POST", self.port, "/extract-dry", token=TOKEN,
                                body={"project": str(media.parent), "out": str(out)})
            self.assertEqual(code, 200)
            data = json.loads(body)
            self.assertTrue(data["ok"], data)
            self.assertEqual(len(data["files"]), 2)

    def test_extract_dry_missing_project_is_400(self):
        code, _, _ = req("POST", self.port, "/extract-dry", token=TOKEN,
                         body={"project": "/nope/x.logicx", "out": "/tmp/x"})
        self.assertEqual(code, 400)

    def test_bounce_requires_projects(self):
        code, _, _ = req("POST", self.port, "/bounce-wet", token=TOKEN, body={"out": "/tmp/x"})
        self.assertEqual(code, 400)


class Settle(unittest.TestCase):
    def test_waits_for_files_to_appear_and_stabilize(self):
        with tempfile.TemporaryDirectory() as d:
            def writer():
                time.sleep(0.15)
                (pathlib.Path(d) / "a.wav").write_bytes(b"x" * 10)
                time.sleep(0.15)
                (pathlib.Path(d) / "a.wav").write_bytes(b"x" * 100)  # grow
                (pathlib.Path(d) / "b.wav").write_bytes(b"y" * 50)   # then a second file, then stop
            t = threading.Thread(target=writer)
            t.start()
            files = cx.wait_for_settle(d, appear_timeout=3, stable_secs=0.3, total_timeout=5, poll=0.05)
            t.join()
            self.assertEqual(sorted(files), ["a.wav", "b.wav"])

    def test_returns_empty_when_nothing_appears(self):
        with tempfile.TemporaryDirectory() as d:
            files = cx.wait_for_settle(d, appear_timeout=0.3, stable_secs=0.2, total_timeout=1, poll=0.05)
            self.assertEqual(files, [])


if __name__ == "__main__":
    unittest.main()
