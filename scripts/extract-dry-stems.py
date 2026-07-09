#!/usr/bin/env python3
"""extract-dry-stems.py — extract dry per-track stems from Logic Pro projects.

"Dry" means the raw recorded audio stored in a project's ``Media/`` (and ``Audio Files/``)
folder — WITHOUT the channel-strip effects or automation. Rendering those requires Logic
Pro itself; use ``scripts/bounce-wet-stems.sh`` for wet stems.

This is the command-line counterpart to the browser app (docs/). It is dependency-free
(Python 3 standard library only): by default it copies each track's audio to
``<output>/<Project>/`` renamed by a template, losslessly. With ``--split`` it can slice a
multi-take overdub file into takes by a reference track's length (WAV only, via the stdlib
``wave`` module).

Usage:
    extract-dry-stems.py -o OUTPUT [options] <project_or_folder> [more ...]

Examples:
    extract-dry-stems.py -o ./Stems "MySong.logicx"
    extract-dry-stems.py -o ./Stems --split --ref COMP ./Projects
    extract-dry-stems.py -o ./Stems --template "{project}_{track}" ./Bounced
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import struct
import sys
import wave

AUDIO_EXT = (".wav", ".wave", ".aif", ".aiff", ".aifc", ".caf", ".mp3", ".m4a", ".aac", ".flac", ".ogg")
MEDIA_ROOTS = ("media", "audio files")
EXCLUDED_ROOTS = ("freeze files", "undo data", "projectdata", "resources", "movies")
REF_KEYWORDS = ("COMP", "ROUGH")


def is_audio(name: str) -> bool:
    return name.lower().endswith(AUDIO_EXT)


def strip_ext(name: str) -> str:
    return re.sub(r"\.[^./\\]+$", "", name)


def sanitize(name: str) -> str:
    out = re.sub(r'[/\\:*?"<>|\x00-\x1f]', "_", str(name)).strip()
    out = out.lstrip(".").rstrip(".")
    return out or "untitled"


def build_name(template: str, project: str, track: str, take=None, ext: str = "") -> str:
    out = (template or "{project}_{track}")
    out = out.replace("{project}", project).replace("{track}", track)
    out = out.replace("{take}", f"Take{take}" if take is not None else "")
    out = out.replace("{index}", str(take) if take is not None else "")
    out = re.sub(r"_{2,}", "_", sanitize(out)).strip("_") or "stem"
    if ext:
        out += ext if ext.startswith(".") else "." + ext
    return out


def is_reference(name: str, project: str) -> bool:
    up = name.upper()
    keys = list(REF_KEYWORDS) + ([project.upper()] if project else [])
    return any(k and k in up for k in keys)


def uniquify(name: str, used: set) -> str:
    """Return a filename unique within `used`, appending _2, _3, … before the extension
    (mirrors the web app's uniquifyNames so two sources with the same basename don't clobber)."""
    if name not in used:
        used.add(name)
        return name
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    else:
        ext = "." + ext
    n = 2
    while f"{stem}_{n}{ext}" in used:
        n += 1
    final = f"{stem}_{n}{ext}"
    used.add(final)
    return final


def classify(parts):
    """Classify path segments (including the filename) the way the web app's classifyPath does.

    Returns (project_or_None, in_media, in_excluded, is_logic). A .logicx package is detected at
    ANY depth, so pointing the tool at a parent folder still excludes Freeze Files/ etc. and names
    the project after the package rather than the parent folder.
    """
    logic_idx = next((i for i, p in enumerate(parts) if p.lower().endswith(".logicx")), -1)
    if logic_idx >= 0:
        project = strip_ext(parts[logic_idx])
        rest = [s.lower() for s in parts[logic_idx + 1:]]
        seg0 = rest[0] if rest else ""
        in_media = len(rest) > 1 and seg0 in MEDIA_ROOTS
        in_excluded = seg0 in EXCLUDED_ROOTS
        return project, in_media, in_excluded, True
    return None, True, False, False


def read_extended_float80(b: bytes) -> float:
    """Decode an 80-bit IEEE 754 extended float (AIFF sample rate)."""
    sign = -1 if b[0] & 0x80 else 1
    exp = ((b[0] & 0x7F) << 8) | b[1]
    mant = int.from_bytes(b[2:10], "big")
    if exp == 0 and mant == 0:
        return 0.0
    return sign * mant * 2.0 ** (exp - 16383 - 63)


def wav_duration(path: str):
    try:
        with wave.open(path, "rb") as w:
            fr = w.getframerate()
            return w.getnframes() / fr if fr else None
    except Exception:
        return None


def aiff_duration(path: str):
    """Parse an AIFF/AIFC COMM chunk for duration without the deprecated aifc module."""
    try:
        with open(path, "rb") as f:
            if f.read(4) != b"FORM":
                return None
            f.read(4)
            if f.read(4) not in (b"AIFF", b"AIFC"):
                return None
            while True:
                hdr = f.read(8)
                if len(hdr) < 8:
                    return None
                cid, size = hdr[:4], struct.unpack(">I", hdr[4:8])[0]
                if cid == b"COMM":
                    body = f.read(size)
                    frames = struct.unpack(">I", body[2:6])[0]
                    sr = read_extended_float80(body[8:18])
                    return frames / sr if sr else None
                f.seek(size + (size & 1), os.SEEK_CUR)
    except Exception:
        return None


def duration_of(path: str):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".wav", ".wave"):
        return wav_duration(path)
    if ext in (".aif", ".aiff", ".aifc"):
        return aiff_duration(path)
    return None


def split_wav(src: str, ref_seconds: float, out_dir: str, project: str, track: str, template: str, dry_run: bool, used: set):
    """Slice a WAV into equal takes of ref_seconds. Returns the number of files written, or 0 to
    signal the caller should fall back to a whole-file copy (too short, or unparseable by stdlib
    `wave` — e.g. a 24-bit WAVE_FORMAT_EXTENSIBLE or float WAV, common in real DAW exports)."""
    try:
        wav_in = wave.open(src, "rb")
    except Exception as e:
        print(f"  warning: cannot split {os.path.basename(src)} ({e}); copying whole instead.", file=sys.stderr)
        return 0
    with wav_in as w:
        params = w.getparams()
        take_frames = round(ref_seconds * params.framerate)
        n = params.nframes // take_frames if take_frames > 0 else 0
        if n < 1:
            return 0
        written = 0
        tpl = template if "{take}" in template else template + "_{take}"
        for i in range(n):
            w.setpos(i * take_frames)
            frames = w.readframes(take_frames)
            name = uniquify(build_name(tpl, project, track, take=i + 1, ext=".wav"), used)
            dest = os.path.join(out_dir, name)
            print(f"  split  {name}")
            if not dry_run:
                with wave.open(dest, "wb") as o:
                    o.setparams(params)
                    o.writeframes(frames)
            written += 1
        return written


def collect_inputs(inputs, include_all: bool):
    """Yield (project, track, path) for every dry audio file across the given inputs."""
    for raw in inputs:
        path = os.path.abspath(os.path.expanduser(raw))
        if not os.path.exists(path):
            print(f"warning: skipping missing input: {raw}", file=sys.stderr)
            continue
        if os.path.isfile(path):
            if is_audio(path):
                project = os.path.basename(os.path.dirname(path)) or "audio"
                yield project, strip_ext(os.path.basename(path)), path
            continue
        # Walk any directory and classify each file by whether a .logicx package encloses it,
        # so a nested package is handled correctly (not walked as flat audio).
        base_parent = os.path.dirname(path.rstrip("/\\"))
        default_project = os.path.basename(path.rstrip("/\\")) or "audio"
        for root, _dirs, files in os.walk(path):
            for fn in files:
                if not is_audio(fn):
                    continue
                full = os.path.join(root, fn)
                parts = os.path.relpath(full, base_parent).replace("\\", "/").split("/")
                project, in_media, in_excluded, is_logic = classify(parts)
                if is_logic:
                    if not include_all and (in_excluded or not in_media):
                        continue
                    yield project, strip_ext(fn), full
                else:
                    yield default_project, strip_ext(fn), full


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Extract dry per-track stems from Logic Pro projects.")
    ap.add_argument("inputs", nargs="+", help=".logicx project(s), folder(s) of audio, or audio file(s)")
    ap.add_argument("-o", "--out", default="./Stems", help="output directory (default: ./Stems)")
    ap.add_argument("--template", default="{project}_{track}", help="filename template: {project} {track} {take}")
    ap.add_argument("--split", action="store_true", help="split multi-take files into takes by a reference length (WAV only)")
    ap.add_argument("--ref", default="", help="reference keyword or filename substring (default: COMP/ROUGH/project)")
    ap.add_argument("--include-all", action="store_true", help="include all audio inside a .logicx package, not just Media/")
    ap.add_argument("--dry-run", action="store_true", help="print what would be written without writing")
    args = ap.parse_args(argv)

    items = list(collect_inputs(args.inputs, args.include_all))
    if not items:
        print("No audio files found in the given inputs.", file=sys.stderr)
        return 1

    # Group by project so reference detection is per-project.
    projects: dict[str, list] = {}
    for project, track, path in items:
        projects.setdefault(project, []).append((track, path))

    total_written = 0
    for project, tracks in projects.items():
        out_dir = os.path.join(os.path.abspath(os.path.expanduser(args.out)), sanitize(project))
        if not args.dry_run:
            os.makedirs(out_dir, exist_ok=True)
        print(f"\n{project}  ->  {out_dir}")

        ref_seconds = None
        ref_path = None
        if args.split:
            for track, path in tracks:
                fname = os.path.basename(path)
                match = (args.ref.upper() in fname.upper()) if args.ref else is_reference(fname, project)
                if match:
                    ref_seconds = duration_of(path)
                    ref_path = path
                    if ref_seconds:
                        print(f"  reference: {os.path.basename(path)}  ({ref_seconds:.3f}s)")
                        break
            if not ref_seconds:
                print("  warning: no usable reference length found — exporting whole files.", file=sys.stderr)

        used = set()  # de-duplicate output names within this project
        for track, path in tracks:
            ext = os.path.splitext(path)[1].lower()
            do_split = bool(args.split and ref_seconds and path != ref_path and ext in (".wav", ".wave"))
            if do_split:
                wrote = split_wav(path, ref_seconds, out_dir, project, track, args.template, args.dry_run, used)
                if wrote:
                    total_written += wrote
                    continue
                # fall through to a whole-file copy if it was too short or unreadable to split
            name = uniquify(build_name(args.template, project, track, ext=ext), used)
            dest = os.path.join(out_dir, name)
            print(f"  copy   {name}")
            if not args.dry_run:
                shutil.copy2(path, dest)
            total_written += 1

    print(f"\nDone: {total_written} file(s){' (dry-run)' if args.dry_run else ''}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
