"""Footage helpers: build clips from stored segments, extract a still at a past time."""
import json
import subprocess
import tempfile
import time
from pathlib import Path

from .core import DATA, rows

MAX_OUT_SECONDS = 2 * 3600


def _dur(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
                       capture_output=True, text=True)
    try:
        return float(json.loads(r.stdout)["format"]["duration"])
    except Exception:
        return None


def segments_between(cam_id, t0, t1):
    return rows("SELECT * FROM segments WHERE cam_id=? AND end>=? AND start<=? ORDER BY start", (cam_id, t0, t1))


def clip_range(cam_id, t0, t1, out_path, speed=1.0):
    """Cut [t0,t1] (epoch) out of recorded segments. Raises LookupError if nothing was recorded."""
    segs = segments_between(cam_id, t0, t1)
    if not segs:
        raise LookupError("There is no recording for that time (recording was not on).")
    if (t1 - t0) / max(speed, 0.1) > MAX_OUT_SECONDS:
        raise ValueError("That clip is too long; use a shorter time range or a higher speed.")
    lines = []
    for s in segs:
        p = DATA / s["path"]
        if not p.exists():
            continue
        vd = _dur(p) or (s["end"] - s["start"])
        scale = vd / max(0.1, s["end"] - s["start"])
        a = max(0.0, (max(t0, s["start"]) - s["start"]) * scale)
        b = min(vd, (min(t1, s["end"]) - s["start"]) * scale)
        if b - a > 0.2:
            lines.append(f"file '{p}'\ninpoint {a:.2f}\noutpoint {b:.2f}")
    if not lines:
        raise LookupError("Recording files were not found.")
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write("\n".join(lines))
        lst = f.name
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-an"]
    if speed != 1.0:
        cmd += ["-vf", f"setpts=PTS/{speed}"]
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out_path)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True)
    finally:
        Path(lst).unlink(missing_ok=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-300:])
    return segs[0]["start"], segs[-1]["end"]


def frame_at(cam_id, ts, out_path):
    segs = segments_between(cam_id, ts, ts)
    if not segs:
        raise LookupError("There is no recording for that time.")
    s = segs[0]
    p = DATA / s["path"]
    vd = _dur(p) or (s["end"] - s["start"])
    off = (ts - s["start"]) * vd / max(0.1, s["end"] - s["start"])
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{max(0, off):.2f}", "-i", str(p), "-frames:v", "1", "-q:v", "2", str(out_path)],
                       capture_output=True, text=True)
    if r.returncode != 0 or not Path(out_path).exists():
        raise RuntimeError("Could not extract the frame")
