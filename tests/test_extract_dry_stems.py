"""Unit tests for scripts/extract-dry-stems.py (run: python3 tests/test_extract_dry_stems.py)."""
import importlib.util
import os
import pathlib
import struct
import tempfile
import unittest
import wave

ROOT = pathlib.Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("eds", ROOT / "scripts" / "extract-dry-stems.py")
eds = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(eds)


def write_pcm_wav(path, seconds=1.0, sr=44100):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"\x00\x00" * int(seconds * sr))


def write_float_wav(path, sr=44100):
    """A minimal IEEE-float (format tag 3) WAV — valid audio, but stdlib `wave` refuses it."""
    data = b"\x00\x00\x00\x00" * 16
    fmt = struct.pack("<HHIIHH", 3, 1, sr, sr * 4, 4, 32)
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(data)) + data
    path.write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)


class Classify(unittest.TestCase):
    def test_logicx_media_vs_excluded(self):
        proj, in_media, in_excluded, is_logic = eds.classify(["SongA.logicx", "Media", "Vocal.wav"])
        self.assertEqual((proj, in_media, in_excluded, is_logic), ("SongA", True, False, True))
        _, in_media, in_excluded, _ = eds.classify(["SongA.logicx", "Freeze Files", "x.wav"])
        self.assertFalse(in_media)
        self.assertTrue(in_excluded)

    def test_plain_folder(self):
        self.assertEqual(eds.classify(["Stems", "kick.wav"]), (None, True, False, False))


class CollectInputs(unittest.TestCase):
    def test_nested_logicx_excludes_freeze_and_names_project(self):
        with tempfile.TemporaryDirectory() as d:
            base = pathlib.Path(d) / "Projects" / "SongA.logicx"
            (base / "Media").mkdir(parents=True)
            (base / "Freeze Files").mkdir(parents=True)
            write_pcm_wav(base / "Media" / "Vocal.wav")
            write_pcm_wav(base / "Freeze Files" / "Vocal.wav")

            got = list(eds.collect_inputs([str(pathlib.Path(d) / "Projects")], include_all=False))
            self.assertEqual(len(got), 1)  # freeze file excluded
            self.assertEqual(got[0][0], "SongA")  # project = package, not "Projects"
            self.assertIn("Media", got[0][2])

            all_got = list(eds.collect_inputs([str(pathlib.Path(d) / "Projects")], include_all=True))
            self.assertEqual(len(all_got), 2)  # include_all lifts the exclusion


class Uniquify(unittest.TestCase):
    def test_collisions_get_suffixed(self):
        used = set()
        self.assertEqual(eds.uniquify("a.wav", used), "a.wav")
        self.assertEqual(eds.uniquify("a.wav", used), "a_2.wav")
        self.assertEqual(eds.uniquify("a.wav", used), "a_3.wav")
        self.assertEqual(eds.uniquify("noext", used), "noext")
        self.assertEqual(eds.uniquify("noext", used), "noext_2")


class SplitFallback(unittest.TestCase):
    def test_unreadable_wav_returns_zero_not_crash(self):
        with tempfile.TemporaryDirectory() as d:
            src = pathlib.Path(d) / "float.wav"
            write_float_wav(src)
            # must not raise; returns 0 so the caller falls back to a whole-file copy
            wrote = eds.split_wav(str(src), 1.0, d, "P", "T", "{project}_{track}", True, set())
            self.assertEqual(wrote, 0)

    def test_pcm_wav_splits(self):
        with tempfile.TemporaryDirectory() as d:
            src = pathlib.Path(d) / "over.wav"
            write_pcm_wav(src, seconds=3.0)
            wrote = eds.split_wav(str(src), 1.0, d, "P", "Over", "{project}_{track}", False, set())
            self.assertEqual(wrote, 3)
            self.assertTrue(os.path.exists(os.path.join(d, "P_Over_Take1.wav")))


class Format(unittest.TestCase):
    def test_convert_24_to_16(self):
        # 24-bit LE 0x7FFFFF (ff ff 7f) -> 16-bit high bytes (ff 7f)
        self.assertEqual(eds.convert_pcm_depth(b"\xff\xff\x7f", 3, 2), b"\xff\x7f")

    def test_convert_16_to_24(self):
        self.assertEqual(eds.convert_pcm_depth(b"\xff\x7f", 2, 3), b"\x00\xff\x7f")

    def test_convert_passthrough_and_unsupported(self):
        self.assertEqual(eds.convert_pcm_depth(b"\x01\x02", 2, 2), b"\x01\x02")
        self.assertEqual(eds.convert_pcm_depth(b"\x01", 1, 2), b"\x01")  # unsupported width -> unchanged

    def test_reencode_wav_24_to_16_preserves_frames_and_channels(self):
        with tempfile.TemporaryDirectory() as d:
            src = pathlib.Path(d) / "s.wav"
            with wave.open(str(src), "wb") as w:
                w.setnchannels(2)
                w.setsampwidth(3)
                w.setframerate(48000)
                w.writeframes(b"\xff\xff\x7f" * 20)  # 10 stereo frames
            dst = pathlib.Path(d) / "o.wav"
            self.assertTrue(eds.reencode_wav_depth(str(src), str(dst), 2))
            with wave.open(str(dst), "rb") as r:
                self.assertEqual(r.getsampwidth(), 2)
                self.assertEqual(r.getnframes(), 10)
                self.assertEqual(r.getnchannels(), 2)

    def test_reencode_noop_when_same_width(self):
        with tempfile.TemporaryDirectory() as d:
            src = pathlib.Path(d) / "s.wav"
            with wave.open(str(src), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(44100)
                w.writeframes(b"\x00\x00" * 5)
            self.assertFalse(eds.reencode_wav_depth(str(src), str(pathlib.Path(d) / "o.wav"), 2))


if __name__ == "__main__":
    unittest.main()
