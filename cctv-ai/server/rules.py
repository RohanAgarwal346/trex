"""Automation rules + notifications (browser alert, Telegram, webhook)."""
import json
import threading
import time
from datetime import datetime

import httpx

from . import core
from .core import DATA, bus, get_setting, rows


def notify(text, image_rel=None, speak=False, level="info"):
    bus.publish({"event": "alert", "data": {"text": text, "image": core.media_url(image_rel) if image_rel else None,
                                             "speak": speak, "level": level, "ts": time.time()}})
    tok, chat = get_setting("telegram_token"), get_setting("telegram_chat")
    try:
        if tok and chat:
            if image_rel and (DATA / image_rel).exists():
                with open(DATA / image_rel, "rb") as f:
                    httpx.post(f"https://api.telegram.org/bot{tok}/sendPhoto", data={"chat_id": chat, "caption": text[:900]},
                               files={"photo": f}, timeout=15)
            else:
                httpx.post(f"https://api.telegram.org/bot{tok}/sendMessage", data={"chat_id": chat, "text": text}, timeout=15)
        hook = get_setting("webhook_url")
        if hook:
            httpx.post(hook, json={"text": text, "image": core.media_url(image_rel) if image_rel else None, "ts": time.time()}, timeout=10)
    except Exception as e:  # noqa
        print("notify failed:", e)


def _in_window(win):
    if not win:
        return True
    now = datetime.now().strftime("%H:%M")
    a, b = win
    return (a <= now <= b) if a <= b else (now >= a or now <= b)


class Rules:
    def __init__(self, manager):
        self.m = manager
        self.last = {}
        manager.rules = self

    def _active(self):
        out = []
        for r in rows("SELECT * FROM rules WHERE enabled=1"):
            try:
                out.append({**json.loads(r["cfg"]), "id": r["id"], "name": r["name"]})
            except Exception:
                pass
        return out

    def _match_cam(self, rule, cam):
        c = rule.get("camera")
        return c in (None, "", "all") or int(c) == cam.id

    def _fire(self, rule, cam, text, ev=None):
        now = time.time()
        if now - self.last.get(rule["id"], 0) < rule.get("cooldown", 60):
            return
        self.last[rule["id"]] = now
        threading.Thread(target=self._run, args=(rule, cam, text, ev), daemon=True).start()

    def _run(self, rule, cam, text, ev):
        image = None
        if ev and ev.get("media_id"):
            r = rows("SELECT path FROM media WHERE id=?", (ev["media_id"],))
            image = r[0]["path"] if r else None
        for a in rule.get("actions") or [{"type": "notify"}]:
            try:
                t = a.get("type")
                if t in ("notify", "speak"):
                    notify(f"🔔 {rule['name']}: {text}", image, speak=(t == "speak" or a.get("speak", False)), level="warn")
                elif t == "clip":
                    from . import tools
                    tools.call("get_video_clip", {"camera": cam.id, "last_seconds": 5, "next_seconds": int(a.get("seconds", 10))}, quiet=True)
                elif t == "snapshot":
                    from . import tools
                    tools.call("take_snapshot", {"camera": cam.id}, quiet=True)
            except Exception as e:  # noqa
                print("rule action failed", e)

    def on_event(self, ev, cam):
        for r in self._active():
            trig = r.get("trigger")
            if not self._match_cam(r, cam) or not _in_window(r.get("between")):
                continue
            if trig == "motion" and ev["type"] == "motion":
                self._fire(r, cam, f"Movement on {cam.name}", ev)
            elif trig == "object" and ev["type"] == "object" and r.get("label") in (None, "", "any", ev["label"]):
                self._fire(r, cam, f"{ev['label']} seen on {cam.name}", ev)
            elif trig == "line_cross" and ev["type"] == "line_cross" and r.get("label") in (None, "", "any", ev["label"]):
                self._fire(r, cam, f"{cam.name}: {ev['label']} crossed the line ({ev['detail']})", ev)
            elif trig == "offline" and ev["type"] == "camera_offline":
                self._fire(r, cam, f"{cam.name} went offline", ev)
        from . import plugins
        plugins.dispatch_event(ev)

    def on_counts(self, cam, counts):
        for r in self._active():
            if r.get("trigger") != "count_above" or not self._match_cam(r, cam) or not _in_window(r.get("between")):
                continue
            lb = r.get("label") or "person"
            n = counts.get(lb, 0)
            if n >= int(r.get("min_count", 1)):
                self._fire(r, cam, f"{n} {lb} on {cam.name} at once (limit {r.get('min_count', 1)})")
