"""Camera workers: capture, motion/object detection, tracking, recording, clips, event emission."""
import json
import os
import random
import subprocess
import threading
import time
from collections import deque
from pathlib import Path

import cv2
import numpy as np

from . import core
from .core import DATA, bus, get_setting, ins, q, rows
from .detect import put_text, DEFAULT_LABELS, Motion, Tracker, draw_overlay, in_zone, make_detector, centroid

os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp|stimeout;8000000")

DEFAULT_CFG = {"rec_mode": "off", "detect": True, "labels": DEFAULT_LABELS, "zone": None, "line": None,
               "sensitivity": 0.5, "location": ""}
ALLOWED_SCHEMES = ("rtsp://", "rtsps://", "http://", "https://", "rtmp://")


# ------------------------------------------------------------------ demo camera
class DemoSource:
    """Synthetic CCTV scene (gate + road) with moving people/cars so the whole app works with no hardware."""
    w, h = 960, 540

    def __init__(self, seed=1):
        self.rng = random.Random(seed)
        self.actors, self.truth = [], []
        self.next_spawn = time.time() + 1
        self.t = time.time()
        self.bg = self._bg()

    def _bg(self):
        img = np.zeros((self.h, self.w, 3), np.uint8)
        for y in range(self.h):
            k = y / self.h
            img[y, :] = (int(70 + 60 * k), int(60 + 50 * k), int(50 + 40 * k))
        cv2.rectangle(img, (0, 330), (self.w, 480), (60, 60, 66), -1)       # road
        for x in range(0, self.w, 90):
            cv2.rectangle(img, (x, 402), (x + 45, 408), (200, 200, 210), -1)
        cv2.rectangle(img, (0, 480), (self.w, self.h), (50, 90, 60), -1)      # lawn
        cv2.rectangle(img, (60, 120), (330, 330), (110, 80, 140), -1)         # building
        cv2.rectangle(img, (640, 150), (900, 330), (80, 120, 150), -1)
        for bx in (90, 170, 250):
            cv2.rectangle(img, (bx, 160), (bx + 45, 220), (200, 230, 255), -1)
        cv2.rectangle(img, (720, 230), (800, 330), (40, 40, 60), -1)          # door
        cv2.line(img, (self.w // 2, 330), (self.w // 2, 480), (0, 230, 255), 1)
        return img

    def _spawn(self):
        kind = "person" if self.rng.random() < 0.7 else "car"
        ltr = self.rng.random() < 0.5
        if kind == "person":
            y = self.rng.randint(380, 470)
            self.actors.append({"label": "person", "x": -30 if ltr else self.w + 30, "y": y, "vx": self.rng.uniform(55, 95) * (1 if ltr else -1),
                                "col": (self.rng.randint(60, 255), self.rng.randint(60, 255), self.rng.randint(60, 255)), "w": 26, "h": 70})
        else:
            y = 400 if ltr else 440
            self.actors.append({"label": self.rng.choice(["car", "car", "truck", "motorcycle"]), "x": -80 if ltr else self.w + 80, "y": y,
                                "vx": self.rng.uniform(160, 260) * (1 if ltr else -1),
                                "col": (self.rng.randint(40, 255), self.rng.randint(40, 255), self.rng.randint(40, 255)), "w": 110, "h": 52})

    def read(self):
        time.sleep(max(0, 1 / 12 - (time.time() - self.t)))
        now = time.time()
        dt, self.t = now - self.t, now
        if now > self.next_spawn:
            self._spawn()
            self.next_spawn = now + self.rng.uniform(2.5, 7)
        img = self.bg.copy()
        self.truth = []
        for a in list(self.actors):
            a["x"] += a["vx"] * max(dt, 1 / 12)
            if a["x"] < -150 or a["x"] > self.w + 150:
                self.actors.remove(a)
                continue
            x, y, aw, ah = int(a["x"]), int(a["y"]), a["w"], a["h"]
            if a["label"] == "person":
                cv2.rectangle(img, (x - aw // 2, y - ah), (x + aw // 2, y), a["col"], -1)
                cv2.circle(img, (x, y - ah - 10), 11, (170, 200, 230), -1)
                box = [x - aw // 2, y - ah - 21, x + aw // 2, y]
            else:
                cv2.rectangle(img, (x - aw // 2, y - ah), (x + aw // 2, y), a["col"], -1)
                cv2.rectangle(img, (x - aw // 4, y - ah - 20), (x + aw // 4, y - ah), a["col"], -1)
                cv2.circle(img, (x - aw // 3, y), 10, (20, 20, 20), -1)
                cv2.circle(img, (x + aw // 3, y), 10, (20, 20, 20), -1)
                box = [x - aw // 2, y - ah - 20, x + aw // 2, y + 10]
            self.truth.append({"label": a["label"], "conf": 0.9, "box": [max(0, box[0] / self.w), max(0, box[1] / self.h), min(1, box[2] / self.w), min(1, box[3] / self.h)]})
        noise = np.random.randint(0, 6, img.shape, np.uint8)
        return True, cv2.add(img, noise)


class Writer:
    def __init__(self, path, fps, size):
        self.path = Path(path)
        self.vw = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), max(1.0, fps), size)
        self.size = size
        self.start = time.time()

    def write(self, frame):
        if (frame.shape[1], frame.shape[0]) != self.size:
            frame = cv2.resize(frame, self.size)
        self.vw.write(frame)

    def close(self):
        self.vw.release()


def transcode(src, dst, speed=1.0):
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src)]
    if speed != 1.0:
        cmd += ["-vf", f"setpts=PTS/{speed}", "-an"]
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(dst)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-300:])
    try:
        Path(src).unlink()
    except OSError:
        pass


def stamp(frame, name, ts):
    return put_text(frame, f"{name}  {time.strftime('%d-%m-%Y %H:%M:%S', time.localtime(ts))}", (8, frame.shape[0] - 10),
                    max(0.4, frame.shape[1] / 1800), (255, 255, 255))


# ------------------------------------------------------------------ camera
class Camera:
    def __init__(self, mgr, row):
        self.mgr = mgr
        self.id = row["id"]
        self.name = row["name"]
        self.kind = row["kind"]
        self.source = row["source"]
        self.enabled = bool(row["enabled"])
        self.cfg = {**DEFAULT_CFG, **json.loads(row["cfg"] or "{}")}
        self.stop_flag = threading.Event()
        self.lock = threading.Lock()
        self.source_obj = None
        self.online = False
        self.error = ""
        self.frame = None
        self.frame_ts = 0
        self.frame_id = 0
        self.jpeg = None
        self.fps = 0.0
        self.ring = deque()
        self.jobs = []
        self.dets, self.dets_ts = [], 0
        self.motion = Motion()
        self.motion_on, self.last_motion = False, 0
        self.last_activity = 0
        self.tracker = Tracker()
        self.cool = {}
        self.writer, self.writer_start = None, 0
        self._ann_cache = (None, -1)
        self._last_proc, self._fps_t, self._fps_n = 0, time.time(), 0
        self._last_count_sample = 0
        self._offline_since = None
        self._was_online = False
        self.threads = []

    # ----- lifecycle
    def start(self):
        if not self.enabled:
            return
        for fn in (self._capture_loop, self._detect_loop):
            t = threading.Thread(target=fn, daemon=True, name=f"cam{self.id}-{fn.__name__}")
            t.start()
            self.threads.append(t)

    def stop(self):
        self.stop_flag.set()
        self._close_writer()

    def _open(self):
        if self.kind == "demo":
            self.source_obj = DemoSource(self.id)
            return True
        src = int(self.source) if self.kind == "webcam" else self.source
        cap = cv2.VideoCapture(src)
        if not cap.isOpened():
            self.error = "Camera se connect nahi ho paya / could not connect"
            return False
        self.source_obj = cap
        return True

    def _read(self):
        s = self.source_obj
        if isinstance(s, DemoSource):
            return s.read()
        ok, f = s.read()
        if not ok and self.kind == "file":
            s.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, f = s.read()
        if ok and self.kind == "file":
            time.sleep(1 / max(5, s.get(cv2.CAP_PROP_FPS) or 25))
        return ok, f

    def _capture_loop(self):
        backoff = 2
        while not self.stop_flag.is_set():
            if not self._open():
                self._set_online(False)
                self.stop_flag.wait(backoff)
                backoff = min(30, backoff * 2)
                continue
            backoff, fails = 2, 0
            while not self.stop_flag.is_set():
                try:
                    ok, frame = self._read()
                except Exception as e:  # noqa
                    ok, frame, self.error = False, None, str(e)
                if not ok or frame is None:
                    fails += 1
                    if fails > 25:
                        break
                    time.sleep(0.1)
                    continue
                fails = 0
                self._set_online(True)
                try:
                    self._on_frame(frame, time.time())
                except Exception as e:  # noqa
                    print(f"[cam {self.id}] frame error: {e!r}")
            if isinstance(self.source_obj, cv2.VideoCapture):
                self.source_obj.release()
            self._set_online(False)
        self._close_writer()

    def _set_online(self, on):
        if on:
            self._offline_since = None
            if not self.online and self._was_online:
                self.mgr.record_event(self, "camera_online", "camera", 1, "Camera wapas online", snap=False)
            self.online, self._was_online, self.error = True, True, ""
        else:
            if self._offline_since is None:
                self._offline_since = time.time()
            if self.online and time.time() - self._offline_since > 0:
                self.online = False
                if self._was_online:
                    self.mgr.record_event(self, "camera_offline", "camera", 1, self.error or "Camera offline ho gaya", snap=False)

    # ----- per-frame processing
    def _on_frame(self, frame, now):
        h, w = frame.shape[:2]
        if w > 1280:
            frame = cv2.resize(frame, (1280, int(1280 * h / w)))
        self._fps_n += 1
        if now - self._fps_t >= 2:
            self.fps = round(self._fps_n / (now - self._fps_t), 1)
            self._fps_t, self._fps_n = now, 0
        tf = float(get_setting("target_fps", 10))
        if now - self._last_proc < 1 / tf:
            return
        self._last_proc = now
        self.frame, self.frame_ts = frame, now
        if isinstance(self.source_obj, DemoSource):
            self.frame_truth = list(self.source_obj.truth)
        self.frame_id += 1
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not ok:
            return
        jpeg = buf.tobytes()
        self.jpeg = jpeg
        ring_s = 30
        self.ring.append((now, jpeg))
        while self.ring and now - self.ring[0][0] > ring_s:
            self.ring.popleft()
        with self.lock:
            for job in list(self.jobs):
                job["frames"].append((now, jpeg))
                if now >= job["until"]:
                    job["done"].set()
                    self.jobs.remove(job)
        # motion
        ratio, boxes = self.motion.update(frame, self.cfg["sensitivity"])
        thr = 0.002 + (1 - self.cfg["sensitivity"]) * 0.02
        active = ratio > thr and bool(boxes)
        if active:
            self.last_motion = self.last_activity = now
            if not self.motion_on:
                self.motion_on = True
                if self._cooled("motion", 30):
                    self.mgr.record_event(self, "motion", "movement", len(boxes), f"Movement detected ({ratio * 100:.1f}% of frame)")
        elif self.motion_on and now - self.last_motion > 5:
            self.motion_on = False
        self._record(frame, now)

    def _cooled(self, key, seconds):
        now = time.time()
        if now - self.cool.get(key, 0) < seconds:
            return False
        self.cool[key] = now
        return True

    # ----- object detection thread
    def _detect_loop(self):
        det = None
        last_id = -1
        while not self.stop_flag.is_set():
            if not self.cfg.get("detect") or self.frame is None or self.frame_id == last_id:
                self.stop_flag.wait(0.3)
                continue
            if det is None:
                det = make_detector(get_setting("detector", "auto"), self.kind)
            last_id = self.frame_id
            frame, ts = self.frame, self.frame_ts
            t0 = time.time()
            try:
                dets = det.detect(frame, self)
            except Exception as e:  # noqa
                print(f"[cam {self.id}] detect error: {e!r}")
                dets = []
            labels = set(self.cfg.get("labels") or DEFAULT_LABELS)
            zone = self.cfg.get("zone")
            dets = [d for d in dets if d["label"] in labels and in_zone(centroid(d["box"]), zone)]
            self.dets, self.dets_ts = dets, ts
            if dets:
                self.last_activity = ts
            self._handle_tracks(dets, ts)
            self.mgr.on_counts(self, self.counts_now())
            if time.time() - self._last_count_sample > 10:
                self._last_count_sample = time.time()
                for lb, n in self.counts_now().items():
                    ins("INSERT INTO counts(ts,cam_id,label,n) VALUES(?,?,?,?)", (ts, self.id, lb, n))
            self.stop_flag.wait(max(0.15, 0.6 - (time.time() - t0)))

    def _handle_tracks(self, dets, ts):
        new, ended, crossings = self.tracker.update(dets, ts, self.cfg.get("line"))
        for t in new:
            tid = ins("INSERT INTO tracks(cam_id,label,first,last) VALUES(?,?,?,?)", (self.id, t["label"], ts, ts))
            t["db"] = tid
            if self._cooled("obj:" + t["label"], 12):
                n = self.counts_now().get(t["label"], 1)
                self.mgr.record_event(self, "object", t["label"], n, f"{t['label']} dikha ({n} abhi frame mein)")
        for t in ended:
            if t.get("db"):
                q("UPDATE tracks SET last=? WHERE id=?", (t["last"], t["db"]))
        for tid, t in self.tracker.tracks.items():
            if t.get("db") and ts - t.get("saved", 0) > 5:
                t["saved"] = ts
                q("UPDATE tracks SET last=? WHERE id=?", (ts, t["db"]))
        for c in crossings:
            self.mgr.record_event(self, "line_cross", c["label"], 1, c["dir"], snap=False)

    def counts_now(self):
        if time.time() - self.dets_ts > 6:
            return {}
        out = {}
        for d in self.dets:
            out[d["label"]] = out.get(d["label"], 0) + 1
        return out

    # ----- recording
    def _record(self, frame, now):
        mode = self.cfg.get("rec_mode", "off")
        want = mode == "continuous" or (mode == "motion" and now - self.last_activity < 8)
        seg = float(get_setting("segment_seconds", 120))
        if self.writer and (not want or now - self.writer_start >= seg):
            self._close_writer()
        if want and not self.writer:
            day = time.strftime("%Y%m%d", time.localtime(now))
            d = DATA / "recordings" / str(self.id) / day
            d.mkdir(parents=True, exist_ok=True)
            self.writer_path = d / f"{time.strftime('%H%M%S', time.localtime(now))}.raw.mp4"
            h, w = frame.shape[:2]
            self.writer = Writer(self.writer_path, float(get_setting("target_fps", 10)), (w, h))
            self.writer_start = now
            if mode == "motion":  # pre-roll
                pre = float(get_setting("preroll_seconds", 8))
                for ts, jp in list(self.ring)[:-1]:
                    if now - ts <= pre:
                        f = cv2.imdecode(np.frombuffer(jp, np.uint8), cv2.IMREAD_COLOR)
                        self.writer.write(stamp(f, self.name, ts))
                self.writer_start = now - pre
        if self.writer:
            self.writer.write(stamp(frame.copy(), self.name, now))
            self.writer_end = now

    def _close_writer(self):
        w, self.writer = self.writer, None
        if not w:
            return
        start, end, path = self.writer_start, getattr(self, "writer_end", time.time()), w.path
        w.close()

        def fin():
            final = path.with_name(path.name.replace(".raw", ""))
            try:
                transcode(path, final)
                ins("INSERT INTO segments(cam_id,start,end,path) VALUES(?,?,?,?)", (self.id, start, end, str(final.relative_to(DATA))))
            except Exception as e:  # noqa
                print(f"[cam {self.id}] segment transcode failed: {e}")
        threading.Thread(target=fin, daemon=True).start()

    # ----- outputs
    def get_jpeg(self, annotate=False):
        if not annotate or self.frame is None:
            return self.jpeg
        fid = self.frame_id
        if self._ann_cache[1] == fid:
            return self._ann_cache[0]
        dets = self.dets
        if self.kind == "demo":  # exact boxes for the synthetic scene (no detector lag)
            labels = set(self.cfg.get("labels") or DEFAULT_LABELS)
            dets = [d for d in getattr(self, "frame_truth", []) if d["label"] in labels and in_zone(centroid(d["box"]), self.cfg.get("zone"))]
        img = draw_overlay(self.frame, dets, self.name, self.counts_now(), self.frame_ts,
                           zone=self.cfg.get("zone"), line=self.cfg.get("line"), motion_boxes=None, bar_on=False)
        jp = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 75])[1].tobytes()
        self._ann_cache = (jp, fid)
        return jp

    def wait_frame(self, timeout=6):
        t0 = time.time()
        while self.frame is None and time.time() - t0 < timeout:
            time.sleep(0.1)
        return self.frame

    def snapshot_image(self, annotate=True, details=False, crop=None):
        frame = self.wait_frame()
        if frame is None:
            raise RuntimeError(f"'{self.name}' abhi offline hai ({self.error or 'no frame'})")
        counts = self.counts_now()
        if annotate:
            note = f"motion: {'YES' if self.motion_on else 'no'} ({self.motion.ratio * 100:.1f}%)" if details else ""
            img = draw_overlay(frame, self.dets, self.name, counts, time.time(), details=details,
                               zone=self.cfg.get("zone"), line=self.cfg.get("line"), note=note)
        else:
            img = stamp(frame.copy(), self.name, time.time())
        if crop:
            h, w = img.shape[:2]
            x1, y1, x2, y2 = [max(0.0, min(1.0, float(v))) for v in crop]
            if x2 > x1 and y2 > y1:
                img = img[int(y1 * h):int(y2 * h), int(x1 * w):int(x2 * w)]
                img = cv2.resize(img, None, fx=max(1.0, 960 / max(1, img.shape[1])), fy=max(1.0, 960 / max(1, img.shape[1])), interpolation=cv2.INTER_CUBIC)
        return img, counts

    def make_clip(self, pre, post, out_path, speed=1.0):
        """Clip from ring-buffer pre-roll plus `post` seconds of live footage."""
        now = time.time()
        job = {"frames": [(ts, jp) for ts, jp in self.ring if now - ts <= pre], "until": now + post, "done": threading.Event()}
        if post > 0:
            with self.lock:
                self.jobs.append(job)
            job["done"].wait(post + 8)
        frames = job["frames"]
        if len(frames) < 2:
            raise RuntimeError("Is camera se abhi footage nahi mil rahi (offline?)")
        dur = max(0.5, frames[-1][0] - frames[0][0])
        fps = len(frames) / dur
        f0 = cv2.imdecode(np.frombuffer(frames[0][1], np.uint8), cv2.IMREAD_COLOR)
        h, w = f0.shape[:2]
        raw = Path(str(out_path) + ".raw.mp4")
        wr = Writer(raw, fps, (w, h))
        for ts, jp in frames:
            wr.write(stamp(cv2.imdecode(np.frombuffer(jp, np.uint8), cv2.IMREAD_COLOR), self.name, ts))
        wr.close()
        transcode(raw, out_path, speed)
        return frames[0][0], frames[-1][0]

    def status(self):
        return {"id": self.id, "name": self.name, "kind": self.kind, "enabled": self.enabled, "online": self.online,
                "fps": self.fps, "error": self.error, "motion": self.motion_on, "recording": bool(self.writer),
                "counts": self.counts_now(), "cfg": self.cfg, "source": _mask(self.source),
                "detector": "demo" if self.kind == "demo" else get_setting("detector", "auto")}


def _mask(url):
    try:
        if "@" in url:
            scheme, rest = url.split("://", 1)
            return f"{scheme}://***:***@{rest.split('@', 1)[1]}"
    except Exception:
        pass
    return url


def validate_source(kind, source):
    if kind == "demo":
        return ""
    if kind == "webcam":
        if not str(source).isdigit():
            raise ValueError("Webcam source ek number hona chahiye (0, 1, ...)")
        return str(source)
    if kind == "file":
        p = Path(source).expanduser()
        if not p.is_file():
            raise ValueError(f"File nahi mili: {source}")
        return str(p)
    if kind in ("rtsp", "url"):
        if not str(source).lower().startswith(ALLOWED_SCHEMES):
            raise ValueError("URL rtsp://, http:// ya https:// se shuru hona chahiye")
        return str(source)
    raise ValueError(f"Unknown camera type: {kind}")


# ------------------------------------------------------------------ manager
class Manager:
    def __init__(self):
        self.cams = {}
        self.rules = None  # set by rules module
        self._ev_lock = threading.Lock()

    def load(self):
        if not q("SELECT 1 FROM cameras LIMIT 1"):
            self.add("Demo Gate / डेमो गेट", "demo", "", {"rec_mode": "off", "line": [0.5, 0.6, 0.5, 0.9]})
            self.add("Demo Parking / डेमो पार्किंग", "demo", "", {})
        for r in rows("SELECT * FROM cameras"):
            self._spawn(r)
        threading.Thread(target=self._janitor, daemon=True).start()

    def _spawn(self, r):
        c = Camera(self, r)
        self.cams[c.id] = c
        c.start()
        return c

    def add(self, name, kind, source, cfg=None, enabled=True):
        source = validate_source(kind, source)
        cid = ins("INSERT INTO cameras(name,kind,source,enabled,cfg) VALUES(?,?,?,?,?)",
                  (name, kind, source, int(enabled), json.dumps(cfg or {})))
        return self._spawn(rows("SELECT * FROM cameras WHERE id=?", (cid,))[0])

    def update(self, cid, name=None, kind=None, source=None, enabled=None, cfg=None):
        old = self.cams[cid]
        newcfg = {**old.cfg, **(cfg or {})}
        kind = kind or old.kind
        source = validate_source(kind, source if source is not None else old.source) if (kind != old.kind or source is not None) else old.source
        q("UPDATE cameras SET name=?,kind=?,source=?,enabled=?,cfg=? WHERE id=?",
          (name or old.name, kind, source, int(old.enabled if enabled is None else enabled), json.dumps(newcfg), cid))
        restart = kind != old.kind or source != old.source or (enabled is not None and bool(enabled) != old.enabled)
        if restart:
            old.stop()
            del self.cams[cid]
            return self._spawn(rows("SELECT * FROM cameras WHERE id=?", (cid,))[0])
        old.name = name or old.name
        old.cfg = newcfg
        return old

    def remove(self, cid):
        c = self.cams.pop(cid, None)
        if c:
            c.stop()
        q("DELETE FROM cameras WHERE id=?", (cid,))

    def get(self, ref):
        """Find a camera by id, exact/partial name (Hindi or English) or 1-based index."""
        if ref is None or ref == "":
            if len(self.cams) == 1:
                return next(iter(self.cams.values()))
            raise KeyError("Kaun sa camera? " + ", ".join(f"{c.id}:{c.name}" for c in self.cams.values()))
        if isinstance(ref, int) or str(ref).isdigit():
            if int(ref) in self.cams:
                return self.cams[int(ref)]
        s = str(ref).strip().lower()
        for c in self.cams.values():
            if c.name.lower() == s:
                return c
        for c in self.cams.values():
            if s in c.name.lower() or c.name.lower() in s:
                return c
        for c in self.cams.values():
            loc = (c.cfg.get("location") or "").lower()
            if loc and (s in loc or loc in s):
                return c
        raise KeyError(f"Camera '{ref}' nahi mila. Available: " + ", ".join(f"{c.id}:{c.name}" for c in self.cams.values()))

    def all(self):
        return list(self.cams.values())

    # ----- events
    def record_event(self, cam, etype, label, count, detail="", snap=True):
        ts = time.time()
        media_id = None
        if snap and cam.frame is not None:
            try:
                img, _ = cam.snapshot_image(annotate=True)
                p = DATA / "snapshots" / f"ev_{cam.id}_{int(ts * 1000)}.jpg"
                cv2.imwrite(str(p), img, [cv2.IMWRITE_JPEG_QUALITY, 85])
                media_id = core.register_media("event", p, cam.id, f"{etype}: {label}", ts=ts)["id"]
            except Exception as e:  # noqa
                print("event snapshot failed", e)
        eid = ins("INSERT INTO events(ts,cam_id,type,label,count,detail,media_id) VALUES(?,?,?,?,?,?,?)",
                  (ts, cam.id, etype, label, count, detail, media_id))
        ev = {"id": eid, "ts": ts, "cam_id": cam.id, "camera": cam.name, "type": etype, "label": label, "count": count,
              "detail": detail, "media_id": media_id}
        if media_id:
            ev["image"] = core.media_url(rows("SELECT path FROM media WHERE id=?", (media_id,))[0]["path"])
        bus.publish({"event": "cctv", "data": ev})
        if self.rules:
            try:
                self.rules.on_event(ev, cam)
            except Exception as e:  # noqa
                print("rules error", e)
        return ev

    def on_counts(self, cam, counts):
        if self.rules:
            self.rules.on_counts(cam, counts)

    def _janitor(self):
        while True:
            time.sleep(600)
            try:
                days = float(get_setting("retention_days", 7))
                cutoff = time.time() - days * 86400
                for s in rows("SELECT * FROM segments WHERE end<?", (cutoff,)):
                    (DATA / s["path"]).unlink(missing_ok=True)
                q("DELETE FROM segments WHERE end<?", (cutoff,))
                for m in rows("SELECT * FROM media WHERE kind='event' AND ts<?", (cutoff,)):
                    (DATA / m["path"]).unlink(missing_ok=True)
                q("DELETE FROM media WHERE kind='event' AND ts<?", (cutoff,))
                q("DELETE FROM counts WHERE ts<?", (cutoff,))
            except Exception as e:  # noqa
                print("janitor error", e)


manager = Manager()
