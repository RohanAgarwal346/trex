"""Detection backends, simple tracker, zones/lines and overlay drawing."""
import time

import cv2
import numpy as np

COLORS = {  # BGR
    "person": (120, 220, 90), "car": (60, 140, 255), "motorcycle": (255, 120, 40), "bus": (200, 80, 220),
    "truck": (40, 200, 240), "bicycle": (240, 200, 60), "dog": (180, 120, 255), "cat": (255, 160, 200),
    "movement": (0, 200, 255),
}
DEFAULT_LABELS = ["person", "car", "motorcycle", "bus", "truck", "bicycle", "dog", "cat"]


_FONT = None


def _font(px):
    """A Devanagari-capable TTF (OpenCV's Hershey fonts can't draw Hindi)."""
    global _FONT
    from PIL import ImageFont
    if _FONT is None:
        import glob
        cands = ["/usr/share/fonts/truetype/freefont/FreeSans.ttf", "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf",
                 "/usr/share/fonts/truetype/lohit-devanagari/Lohit-Devanagari.ttf", "/usr/share/fonts/opentype/inter/Inter-Regular.otf",
                 "/Library/Fonts/Arial Unicode.ttf", "C:/Windows/Fonts/mangal.ttf", "C:/Windows/Fonts/arial.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"] + glob.glob("/usr/share/fonts/**/*Devanagari*.ttf", recursive=True)
        _FONT = next((c for c in cands if __import__("os").path.exists(c)), "")
    return ImageFont.truetype(_FONT, int(px)) if _FONT else ImageFont.load_default()


def put_text(img, text, org, scale, color, bold=False):
    """cv2.putText replacement that handles any Unicode (Hindi names)."""
    if text.isascii():
        cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, color, 2 if bold else 1, cv2.LINE_AA)
        return img
    from PIL import Image, ImageDraw
    px = max(12, int(scale * 28))
    f = _font(px)
    x0, y0 = max(0, org[0]), max(0, org[1] - px - 4)
    x1, y1 = min(img.shape[1], x0 + int(f.getlength(text)) + 6), min(img.shape[0], org[1] + px // 3)
    if x1 <= x0 or y1 <= y0:
        return img
    reg = img[y0:y1, x0:x1]
    im = Image.fromarray(cv2.cvtColor(reg, cv2.COLOR_BGR2RGB))
    ImageDraw.Draw(im).text((0, 2), text, font=f, fill=(color[2], color[1], color[0]))
    img[y0:y1, x0:x1] = cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)
    return img


def text_width(text, scale):
    if text.isascii():
        return cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, 1)[0][0]
    return int(_font(max(12, int(scale * 28))).getlength(text))


class HogDetector:
    """People detection with OpenCV's built-in HOG — zero downloads, modest accuracy."""
    name = "hog"

    def __init__(self):
        self.hog = cv2.HOGDescriptor()
        self.hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

    def detect(self, frame, cam):
        h, w = frame.shape[:2]
        sc = 640 / w if w > 640 else 1.0
        small = cv2.resize(frame, None, fx=sc, fy=sc) if sc != 1.0 else frame
        rects, weights = self.hog.detectMultiScale(small, winStride=(8, 8), padding=(8, 8), scale=1.07)
        out = []
        for (x, y, rw, rh), wt in zip(rects, np.array(weights).reshape(-1)):
            if wt < 0.6:
                continue
            out.append({"label": "person", "conf": float(min(0.99, wt / 2)),
                        "box": [x / sc / w, y / sc / h, (x + rw) / sc / w, (y + rh) / sc / h]})
        return out


class YoloDetector:
    """Uses ultralytics YOLO when `pip install ultralytics` is present (people, vehicles, animals...)."""
    name = "yolo"

    def __init__(self, weights="yolov8n.pt"):
        from ultralytics import YOLO  # noqa
        self.m = YOLO(weights)

    def detect(self, frame, cam):
        h, w = frame.shape[:2]
        res = self.m.predict(frame, verbose=False, conf=0.35, imgsz=640)[0]
        out = []
        for b in res.boxes:
            label = self.m.names[int(b.cls)]
            x1, y1, x2, y2 = b.xyxy[0].tolist()
            out.append({"label": label, "conf": float(b.conf), "box": [x1 / w, y1 / h, x2 / w, y2 / h]})
        return out


class DemoDetector:
    name = "demo"

    def detect(self, frame, cam):
        return list(getattr(cam, "frame_truth", []))


def make_detector(kind, cam_kind=None):
    if cam_kind == "demo":
        return DemoDetector()
    if kind in ("auto", "yolo"):
        try:
            return YoloDetector()
        except Exception:
            if kind == "yolo":
                print("[detect] ultralytics not available, falling back to HOG")
    return HogDetector()


class Motion:
    def __init__(self):
        self.bg = cv2.createBackgroundSubtractorMOG2(history=200, varThreshold=32, detectShadows=False)
        self.ratio = 0.0
        self.boxes = []

    def update(self, frame, sensitivity=0.5):
        h, w = frame.shape[:2]
        small = cv2.resize(frame, (320, int(320 * h / w)))
        small = cv2.GaussianBlur(small, (5, 5), 0)
        mask = self.bg.apply(small)
        mask = cv2.threshold(mask, 200, 255, cv2.THRESH_BINARY)[1]
        mask = cv2.dilate(mask, None, iterations=2)
        self.ratio = float(np.count_nonzero(mask)) / mask.size
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        min_area = mask.size * (0.004 + (1 - sensitivity) * 0.01)
        sh, sw = mask.shape
        self.boxes = []
        for c in cnts:
            if cv2.contourArea(c) >= min_area:
                x, y, bw, bh = cv2.boundingRect(c)
                self.boxes.append([x / sw, y / sh, (x + bw) / sw, (y + bh) / sh])
        return self.ratio, self.boxes


def centroid(box):
    return ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)


def in_zone(pt, zone):
    if not zone or len(zone) < 3:
        return True
    poly = np.array([[p[0], p[1]] for p in zone], dtype=np.float32)
    return cv2.pointPolygonTest(poly, (float(pt[0]), float(pt[1])), False) >= 0


def line_side(pt, line):
    x1, y1, x2, y2 = line
    return (x2 - x1) * (pt[1] - y1) - (y2 - y1) * (pt[0] - x1)


class Tracker:
    """Greedy nearest-centroid tracker; reports new tracks, finished tracks and line crossings."""

    def __init__(self, max_age=3.0):
        self.tracks = {}
        self.next_id = 1
        self.max_age = max_age

    def update(self, dets, now, line=None):
        new, crossings = [], []
        used = set()
        for d in dets:
            c = centroid(d["box"])
            size = max(d["box"][2] - d["box"][0], d["box"][3] - d["box"][1], 0.05)
            best, bd = None, 1e9
            for tid, t in self.tracks.items():
                if tid in used or t["label"] != d["label"]:
                    continue
                dist = ((t["c"][0] - c[0]) ** 2 + (t["c"][1] - c[1]) ** 2) ** 0.5
                if dist < bd and dist < max(0.12, size * 1.5):
                    best, bd = tid, dist
            if best is None:
                t = {"id": self.next_id, "label": d["label"], "c": c, "first": now, "last": now, "side": None, "saved": 0}
                self.tracks[t["id"]] = t
                self.next_id += 1
                new.append(t)
                best = t["id"]
            t = self.tracks[best]
            used.add(best)
            if line:
                s = line_side(c, line)
                if t["side"] is not None and s * t["side"] < 0:
                    crossings.append({"track": t["id"], "label": t["label"], "dir": "in" if s > 0 else "out"})
                if abs(s) > 1e-6:
                    t["side"] = s
            t["c"], t["last"] = c, now
            d["track"] = best
        ended = [t for t in self.tracks.values() if now - t["last"] > self.max_age]
        for t in ended:
            del self.tracks[t["id"]]
        return new, ended, crossings


def draw_overlay(frame, dets, title, counts, ts, details=False, zone=None, line=None, motion_boxes=None, note="", bar_on=True):
    img = frame.copy()
    h, w = img.shape[:2]
    th = max(1, w // 700)
    if zone and len(zone) >= 3:
        pts = np.array([[int(p[0] * w), int(p[1] * h)] for p in zone], np.int32)
        ov = img.copy()
        cv2.fillPoly(ov, [pts], (255, 120, 60))
        img = cv2.addWeighted(ov, 0.12, img, 0.88, 0)
        cv2.polylines(img, [pts], True, (255, 160, 80), th + 1)
    if line:
        p1, p2 = (int(line[0] * w), int(line[1] * h)), (int(line[2] * w), int(line[3] * h))
        cv2.line(img, p1, p2, (0, 230, 255), th + 2)
    for b in motion_boxes or []:
        cv2.rectangle(img, (int(b[0] * w), int(b[1] * h)), (int(b[2] * w), int(b[3] * h)), COLORS["movement"], 1)
    for d in dets:
        x1, y1, x2, y2 = int(d["box"][0] * w), int(d["box"][1] * h), int(d["box"][2] * w), int(d["box"][3] * h)
        col = COLORS.get(d["label"], (255, 255, 255))
        cv2.rectangle(img, (x1, y1), (x2, y2), col, th + 1)
        txt = f'{d["label"]} {int(d.get("conf", 1) * 100)}%'
        (tw, tht), _ = cv2.getTextSize(txt, cv2.FONT_HERSHEY_SIMPLEX, 0.5 * th ** 0.3 + 0.2, 1)
        cv2.rectangle(img, (x1, max(0, y1 - tht - 8)), (x1 + tw + 8, y1), col, -1)
        cv2.putText(img, txt, (x1 + 4, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5 * th ** 0.3 + 0.2, (0, 0, 0), 1, cv2.LINE_AA)
    # header bar
    bar = int(max(26, h * 0.05))
    if bar_on:
        cv2.rectangle(img, (0, 0), (w, bar), (30, 20, 20), -1)
    stamp = time.strftime("%d-%m-%Y %H:%M:%S", time.localtime(ts))
    fs = bar / 42
    if bar_on:
        put_text(img, f"{title}", (10, int(bar * 0.78)), fs, (255, 255, 255))
        put_text(img, stamp, (w - text_width(stamp, fs) - 10, int(bar * 0.78)), fs, (120, 230, 255))
    if details:
        lines = [f"{k}: {v}" for k, v in sorted(counts.items())] or ["no objects detected"]
        if note:
            lines.append(note)
        ph = int(bar * 0.8) * (len(lines) + 1)
        ov = img.copy()
        cv2.rectangle(ov, (0, h - ph), (int(w * 0.34), h), (20, 10, 30), -1)
        img = cv2.addWeighted(ov, 0.7, img, 0.3, 0)
        cv2.putText(img, "DETAILS", (10, h - ph + int(bar * 0.7)), cv2.FONT_HERSHEY_SIMPLEX, fs, (80, 200, 255), 1, cv2.LINE_AA)
        for i, ln in enumerate(lines):
            cv2.putText(img, ln, (10, h - ph + int(bar * 0.8) * (i + 1) + int(bar * 0.7)), cv2.FONT_HERSHEY_SIMPLEX, fs * 0.9, (255, 255, 255), 1, cv2.LINE_AA)
    return img
