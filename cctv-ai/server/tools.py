"""Tool layer: every capability of the app. Used by both the REST API and the AI assistant."""
import csv
import json
import time
import traceback
from datetime import datetime

import cv2

from . import core, media, plugins
from .camera import manager, DEFAULT_CFG
from .core import DATA, fmt_ts, get_setting, ins, parse_time, q, register_media, rows, set_setting

REGISTRY = {}
S = {"type": "string"}
CAM = {"type": "string", "description": "Camera id, name or location (e.g. '1', 'gate', 'parking'). Use 'all' for every camera where supported."}
TIME = {"type": "string", "description": "Time: ISO like '2026-10-27T21:30:00', 'HH:MM' (today), 'now', or relative '-30m', '-2h', '-1d'."}


def tool(name, description, props=None, required=()):
    def deco(fn):
        REGISTRY[name] = ({"name": name, "description": description,
                           "input_schema": {"type": "object", "properties": props or {}, "required": list(required)}}, fn)
        return fn
    return deco


def schemas():
    return [s for s, _ in REGISTRY.values()] + plugins.tool_schemas()


def call(name, args=None, quiet=False):
    args = args or {}
    try:
        if name in REGISTRY:
            res = REGISTRY[name][1](**{k: v for k, v in args.items() if v is not None})
        else:
            res = plugins.call_tool(name, args)
        res.setdefault("ok", True)
        return res
    except TypeError as e:
        return {"ok": False, "error": f"Bad arguments: {e}"}
    except Exception as e:  # noqa
        if not quiet:
            traceback.print_exc()
        return {"ok": False, "error": str(e) if str(e) else e.__class__.__name__}


def _cams(camera):
    if camera in (None, "") and len(manager.cams) > 1:
        return manager.all()
    if str(camera).lower() in ("all", "sab", "saare", "*"):
        return manager.all()
    return [manager.get(camera)]


def _since_label(t0, t1):
    return f"{fmt_ts(t0)} → {fmt_ts(t1)}"


# ------------------------------------------------------------------ viewing
@tool("list_cameras", "List all cameras with live status (online, recording, objects currently visible).")
def list_cameras():
    cams = [c.status() for c in manager.all()]
    return {"cameras": cams, "message": f"{len(cams)} cameras, {sum(c['online'] for c in cams)} online"}


@tool("take_snapshot",
      "Take a still photo from a camera (live) or from a past time if recorded. With details=true the image has bounding boxes, object counts, motion info, timestamp. crop=[x1,y1,x2,y2] (0-1 fractions) zooms into a region.",
      {"camera": CAM, "annotate": {"type": "boolean"}, "details": {"type": "boolean"},
       "crop": {"type": "array", "items": {"type": "number"}, "description": "[x1,y1,x2,y2] normalized 0..1"}, "at_time": TIME})
def take_snapshot(camera=None, annotate=True, details=True, crop=None, at_time=None):
    out_media, summaries = [], []
    for cam in _cams(camera):
        ts = time.time()
        p = DATA / "snapshots" / f"snap_{cam.id}_{int(ts * 1000)}.jpg"
        if at_time:
            t = parse_time(at_time)
            media.frame_at(cam.id, t, p)
            counts, title = {}, f"{cam.name} @ {fmt_ts(t)}"
            if crop:
                img = cv2.imread(str(p))
                h, w = img.shape[:2]
                img = img[int(crop[1] * h):int(crop[3] * h), int(crop[0] * w):int(crop[2] * w)]
                cv2.imwrite(str(p), cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC))
        else:
            img, counts = cam.snapshot_image(annotate=annotate, details=details, crop=crop)
            cv2.imwrite(str(p), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
            title = f"{cam.name} — {fmt_ts(ts)}"
        m = register_media("snapshot", p, cam.id, title, {"counts": counts})
        out_media.append(m)
        summaries.append({"camera": cam.name, "counts": counts, "motion": cam.motion_on, "file": m["url"]})
    return {"message": f"{len(out_media)} snapshot(s) ready", "snapshots": summaries, "media": out_media}


@tool("get_video_clip",
      "Make a video clip. Options: last_seconds (clip of the past N seconds), next_seconds (record the next N seconds from now; add last_seconds for pre-roll), or start+end (any past period from continuous/motion recordings). speed>1 makes a time-lapse.",
      {"camera": CAM, "last_seconds": {"type": "number"}, "next_seconds": {"type": "number"}, "start": TIME, "end": TIME,
       "speed": {"type": "number", "description": "1 = normal, 8 = 8x timelapse"}})
def get_video_clip(camera=None, last_seconds=None, next_seconds=None, start=None, end=None, speed=1.0):
    speed = max(0.25, min(float(speed or 1), 240))
    out_media, notes = [], []
    for cam in _cams(camera):
        ts = time.time()
        p = DATA / "clips" / f"clip_{cam.id}_{int(ts * 1000)}.mp4"
        if start or end:
            t0 = parse_time(start) if start else ts - 60
            t1 = parse_time(end) if end else ts
            if t1 <= t0:
                raise ValueError("end time is before start time")
            try:
                a, b = media.clip_range(cam.id, t0, t1, p, speed)
            except LookupError as e:
                if ts - t1 < 25 and cam.online:  # recent window -> use live ring buffer
                    a, b = cam.make_clip(ts - t0, 0, p, speed)
                    notes.append("recording was off; clip made from the live buffer only")
                else:
                    raise e
        elif next_seconds:
            n = min(float(next_seconds), 600)
            a, b = cam.make_clip(float(last_seconds or 0), n, p, speed)
        else:
            n = float(last_seconds or 15)
            if n > 28:
                try:
                    a, b = media.clip_range(cam.id, ts - n, ts, p, speed)
                except LookupError:
                    a, b = cam.make_clip(28, 0, p, speed)
                    notes.append("Recording was not on, so only the last ~28 seconds were available")
            else:
                a, b = cam.make_clip(n, 0, p, speed)
        m = register_media("clip", p, cam.id, f"{cam.name} — {_since_label(a, b)}", {"speed": speed})
        out_media.append(m)
    return {"message": f"{len(out_media)} clip(s) ready. " + " ".join(notes), "media": out_media}


@tool("ask_about_camera",
      "Look at a camera RIGHT NOW (or at a past time) with your own vision to answer any question: count anything (bikes, boxes, shutters open?), describe people/clothes/colors, read signs, check if something is happening. The image is shown to you.",
      {"camera": CAM, "at_time": TIME}, required=["camera"])
def ask_about_camera(camera, at_time=None):
    cam = manager.get(camera)
    ts = time.time()
    p = DATA / "snapshots" / f"look_{cam.id}_{int(ts * 1000)}.jpg"
    if at_time:
        media.frame_at(cam.id, parse_time(at_time), p)
        jpeg = p.read_bytes()
    else:
        img, _ = cam.snapshot_image(annotate=False)
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 88])
        jpeg = buf.tobytes()
        p.write_bytes(jpeg)
    m = register_media("snapshot", p, cam.id, f"{cam.name} — {fmt_ts(ts)}")
    return {"message": "Image attached; look at it to answer.", "media": [m], "_images": [jpeg],
            "detector_counts": cam.counts_now()}


# ------------------------------------------------------------------ counting & history
@tool("count_objects",
      "Count people/vehicles/animals. Without start/end: what is visible right now. With start/end: unique objects that appeared in that period (plus peak at once and line in/out counts). label optional (person, car, motorcycle, bus, truck, bicycle, dog, cat).",
      {"camera": CAM, "label": S, "start": TIME, "end": TIME})
def count_objects(camera=None, label=None, start=None, end=None):
    cams = _cams(camera)
    if not start and not end:
        per = {c.name: c.counts_now() for c in cams}
        tot = {}
        for d in per.values():
            for k, v in d.items():
                tot[k] = tot.get(k, 0) + v
        if label:
            tot = {label: tot.get(label, 0)}
        return {"mode": "live", "total": tot, "per_camera": per,
                "message": "Right now: " + (", ".join(f"{v} {k}" for k, v in tot.items()) or "no objects visible")}
    t1 = parse_time(end) if end else time.time()
    t0 = parse_time(start) if start else t1 - 3600
    ids = [c.id for c in cams]
    ph = ",".join("?" * len(ids))
    lab = " AND label=?" if label else ""
    la = [label] if label else []
    uniq = rows(f"SELECT label, COUNT(*) n FROM tracks WHERE cam_id IN ({ph}) AND first<=? AND last>=?{lab} GROUP BY label", (*ids, t1, t0, *la))
    peak = rows(f"SELECT label, MAX(total) n FROM (SELECT ts,label,SUM(n) total FROM counts WHERE cam_id IN ({ph}) AND ts BETWEEN ? AND ?{lab} GROUP BY ts,label) GROUP BY label", (*ids, t0, t1, *la))
    cross = rows(f"SELECT label, detail dir, COUNT(*) n FROM events WHERE type='line_cross' AND cam_id IN ({ph}) AND ts BETWEEN ? AND ?{lab} GROUP BY label, detail", (*ids, t0, t1, *la))
    first = q("SELECT MIN(first) f FROM tracks", one=True)["f"]
    note = "" if first is None or first <= t0 else f"Note: counting data only starts from {fmt_ts(first)}."
    return {"mode": "range", "period": _since_label(t0, t1), "unique_counts": {r["label"]: r["n"] for r in uniq},
            "peak_at_once": {r["label"]: r["n"] for r in peak}, "line_crossings": cross, "note": note,
            "message": f"{_since_label(t0, t1)}: " + (", ".join(f"{r['n']} {r['label']}" for r in uniq) or "nothing found") + f" {note}"}


@tool("get_activity", "List recent events (motion, object detected, line crossing, camera offline). Filter by camera/type/time.",
      {"camera": CAM, "type": {"type": "string", "enum": ["motion", "object", "line_cross", "camera_offline", "camera_online"]},
       "label": S, "start": TIME, "end": TIME, "limit": {"type": "integer"}})
def get_activity(camera=None, type=None, label=None, start=None, end=None, limit=30):
    cond, args = ["1=1"], []
    if camera and str(camera).lower() not in ("all",):
        cond.append("e.cam_id=?")
        args.append(manager.get(camera).id)
    if type:
        cond.append("e.type=?")
        args.append(type)
    if label:
        cond.append("e.label=?")
        args.append(label)
    if start:
        cond.append("e.ts>=?")
        args.append(parse_time(start))
    if end:
        cond.append("e.ts<=?")
        args.append(parse_time(end))
    r = rows(f"SELECT e.*, m.path img FROM events e LEFT JOIN media m ON m.id=e.media_id WHERE {' AND '.join(cond)} ORDER BY e.ts DESC LIMIT ?",
             (*args, min(int(limit or 30), 200)))
    names = {c.id: c.name for c in manager.all()}
    ev = [{"id": x["id"], "time": fmt_ts(x["ts"]), "ts": x["ts"], "camera": names.get(x["cam_id"], x["cam_id"]), "type": x["type"],
           "label": x["label"], "count": x["count"], "detail": x["detail"], "image": core.media_url(x["img"]) if x["img"] else None} for x in r]
    return {"events": ev, "message": f"{len(ev)} events"}


@tool("hourly_summary", "Hour-by-hour counts of unique objects and events for a day (for charts, busiest hour, daily report).",
      {"camera": CAM, "day": {"type": "string", "description": "YYYY-MM-DD, default today"}, "label": S})
def hourly_summary(camera=None, day=None, label="person"):
    t0, t1 = core.day_bounds(day)
    ids = [c.id for c in _cams(camera)]
    ph = ",".join("?" * len(ids))
    tr = rows(f"SELECT CAST((first-?)/3600 AS INT) h, COUNT(*) n FROM tracks WHERE cam_id IN ({ph}) AND label=? AND first BETWEEN ? AND ? GROUP BY h", (t0, *ids, label, t0, t1))
    evs = rows(f"SELECT CAST((ts-?)/3600 AS INT) h, COUNT(*) n FROM events WHERE cam_id IN ({ph}) AND type IN ('motion','object') AND ts BETWEEN ? AND ? GROUP BY h", (t0, *ids, t0, t1))
    a, b = {r["h"]: r["n"] for r in tr}, {r["h"]: r["n"] for r in evs}
    hours = [{"hour": h, "unique": a.get(h, 0), "events": b.get(h, 0)} for h in range(24)]
    busiest = max(hours, key=lambda x: x["unique"] + x["events"] * 0.01)
    return {"day": datetime.fromtimestamp(t0).strftime("%Y-%m-%d"), "label": label, "hours": hours, "total_unique": sum(a.values()),
            "total_events": sum(b.values()), "busiest_hour": busiest["hour"],
            "message": f"{label}: {sum(a.values())} unique, busiest hour {busiest['hour']}:00"}


@tool("export_events_csv", "Export events in a time range to a CSV file the user can download.", {"start": TIME, "end": TIME, "camera": CAM})
def export_events_csv(start=None, end=None, camera=None):
    r = get_activity(camera=camera, start=start or "-1d", end=end, limit=200)["events"]
    p = DATA / "exports" / f"events_{int(time.time())}.csv"
    with open(p, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["time", "camera", "type", "label", "count", "detail"])
        for e in r:
            w.writerow([e["time"], e["camera"], e["type"], e["label"], e["count"], e["detail"]])
    return {"message": f"{len(r)} rows exported", "media": [register_media("export", p, None, p.name)]}


# ------------------------------------------------------------------ camera management
@tool("add_camera", "Add a camera. kind: rtsp (rtsp:// URL), url (http MJPEG/HLS URL), webcam (device number), file (video file path), demo.",
      {"name": S, "kind": {"type": "string", "enum": ["rtsp", "url", "webcam", "file", "demo"]}, "source": S, "location": S}, required=["name", "kind"])
def add_camera(name, kind, source="", location=""):
    c = manager.add(name, kind, source, {"location": location} if location else {})
    return {"message": f"Camera '{c.name}' (id {c.id}) added", "camera": c.status()}


@tool("update_camera", "Rename a camera, change its URL, enable/disable it, set location, detection on/off, sensitivity (0-1), or objects to track.",
      {"camera": CAM, "name": S, "source": S, "enabled": {"type": "boolean"}, "location": S, "detect": {"type": "boolean"},
       "sensitivity": {"type": "number"}, "labels": {"type": "array", "items": S}}, required=["camera"])
def update_camera(camera, name=None, source=None, enabled=None, location=None, detect=None, sensitivity=None, labels=None):
    c = manager.get(camera)
    cfg = {k: v for k, v in dict(location=location, detect=detect, sensitivity=sensitivity, labels=labels).items() if v is not None}
    c = manager.update(c.id, name=name, source=source, enabled=enabled, cfg=cfg)
    return {"message": f"'{c.name}' updated", "camera": c.status()}


@tool("remove_camera", "Delete a camera (ask the user to confirm first!). Recordings stay on disk until retention expires.", {"camera": CAM}, required=["camera"])
def remove_camera(camera):
    c = manager.get(camera)
    manager.remove(c.id)
    return {"message": f"'{c.name}' removed"}


@tool("set_recording", "Set recording mode: off, motion (records only when something moves/appears, with pre-roll) or continuous. Optionally set global retention_days.",
      {"camera": CAM, "mode": {"type": "string", "enum": ["off", "motion", "continuous"]}, "retention_days": {"type": "number"}}, required=["camera", "mode"])
def set_recording(camera, mode, retention_days=None):
    msgs = []
    for c in _cams(camera):
        manager.update(c.id, cfg={"rec_mode": mode})
        msgs.append(c.name)
    if retention_days:
        set_setting("retention_days", retention_days)
    return {"message": f"Recording '{mode}' set for: {', '.join(msgs)}" + (f"; retention {retention_days} days" if retention_days else "")}


@tool("set_counting_zone",
      "Define a polygon zone (only objects inside are detected/counted) and/or a counting line (in/out crossings). Coordinates are fractions 0..1 of the image. Pass null/omit to leave unchanged; clear_zone / clear_line to remove.",
      {"camera": CAM, "zone": {"type": "array", "items": {"type": "array", "items": {"type": "number"}}, "description": "[[x,y],...] at least 3 points"},
       "line": {"type": "array", "items": {"type": "number"}, "description": "[x1,y1,x2,y2]"}, "clear_zone": {"type": "boolean"}, "clear_line": {"type": "boolean"}}, required=["camera"])
def set_counting_zone(camera, zone=None, line=None, clear_zone=False, clear_line=False):
    c = manager.get(camera)
    cfg = {}
    if zone:
        if len(zone) < 3:
            raise ValueError("a zone needs at least 3 points")
        cfg["zone"] = zone
    if line:
        if len(line) != 4:
            raise ValueError("line = [x1,y1,x2,y2]")
        cfg["line"] = line
    if clear_zone:
        cfg["zone"] = None
    if clear_line:
        cfg["line"] = None
    manager.update(c.id, cfg=cfg)
    return {"message": f"Zone/line updated for '{c.name}'"}


# ------------------------------------------------------------------ automations
@tool("create_rule",
      "Create an automation. trigger: object (a person/car... appears), motion, line_cross, count_above (min_count of label at once), offline. Optional between=['22:00','06:00'] time window, camera, cooldown seconds. actions: notify, speak (alert read aloud in the app), snapshot, clip.",
      {"name": S, "trigger": {"type": "string", "enum": ["object", "motion", "line_cross", "count_above", "offline"]}, "camera": CAM, "label": S,
       "min_count": {"type": "integer"}, "between": {"type": "array", "items": S}, "cooldown": {"type": "integer"},
       "actions": {"type": "array", "items": {"type": "object", "properties": {"type": {"type": "string", "enum": ["notify", "speak", "snapshot", "clip"]}, "seconds": {"type": "number"}}}}},
      required=["name", "trigger"])
def create_rule(name, trigger, camera=None, label=None, min_count=None, between=None, cooldown=60, actions=None):
    cam = None if camera in (None, "", "all") else manager.get(camera).id
    cfg = {"trigger": trigger, "camera": cam, "label": label, "min_count": min_count, "between": between, "cooldown": cooldown,
           "actions": actions or [{"type": "notify"}]}
    rid = ins("INSERT INTO rules(name,enabled,cfg) VALUES(?,1,?)", (name, json.dumps(cfg)))
    return {"message": f"Rule '{name}' (id {rid}) is ON", "rule_id": rid}


@tool("list_rules", "List automations.")
def list_rules():
    return {"rules": [{"id": r["id"], "name": r["name"], "enabled": bool(r["enabled"]), **json.loads(r["cfg"])} for r in rows("SELECT * FROM rules")]}


@tool("update_rule", "Enable/disable or delete a rule.", {"rule_id": {"type": "integer"}, "enabled": {"type": "boolean"}, "delete": {"type": "boolean"}}, required=["rule_id"])
def update_rule(rule_id, enabled=None, delete=False):
    if delete:
        q("DELETE FROM rules WHERE id=?", (rule_id,))
        return {"message": "Rule deleted"}
    q("UPDATE rules SET enabled=? WHERE id=?", (int(bool(enabled)), rule_id))
    return {"message": "Rule updated"}


@tool("set_notifications", "Configure alert delivery: Telegram bot token + chat id, and/or a webhook URL. Pass empty string to clear.",
      {"telegram_token": S, "telegram_chat": S, "webhook_url": S})
def set_notifications(telegram_token=None, telegram_chat=None, webhook_url=None):
    for k, v in dict(telegram_token=telegram_token, telegram_chat=telegram_chat, webhook_url=webhook_url).items():
        if v is not None:
            set_setting(k, v)
    return {"message": "Notification settings saved"}


@tool("send_test_alert", "Send a test alert to the app, Telegram and webhook so the user can verify notifications work.")
def send_test_alert():
    from .rules import notify
    notify("✅ Test alert — Drishti AI notifications are working", speak=True)
    return {"message": "Test alert sent"}


# ------------------------------------------------------------------ organise & customise the app
@tool("create_folder", "Create a gallery folder (album) for photos/videos.", {"name": S, "color": S}, required=["name"])
def create_folder(name, color="#8b5cf6"):
    try:
        fid = ins("INSERT INTO folders(name,color) VALUES(?,?)", (name, color))
    except Exception:
        raise ValueError("A folder with this name already exists")
    return {"message": f"Folder '{name}' created", "folder_id": fid}


@tool("list_media", "List saved photos/videos (newest first). Optional kind (snapshot|clip|event|export) or folder name.",
      {"kind": S, "folder": S, "limit": {"type": "integer"}})
def list_media(kind=None, folder=None, limit=30):
    cond, args = ["1=1"], []
    if kind:
        cond.append("m.kind=?")
        args.append(kind)
    if folder:
        cond.append("f.name=?")
        args.append(folder)
    r = rows(f"SELECT m.*, f.name folder FROM media m LEFT JOIN folders f ON f.id=m.folder_id WHERE {' AND '.join(cond)} ORDER BY m.ts DESC LIMIT ?", (*args, int(limit or 30)))
    return {"items": [{"id": x["id"], "kind": x["kind"], "title": x["title"], "time": fmt_ts(x["ts"]), "url": core.media_url(x["path"]), "folder": x["folder"]} for x in r],
            "media": [{"id": x["id"], "kind": x["kind"], "title": x["title"], "url": core.media_url(x["path"])} for x in r[:6]]}


@tool("save_to_folder", "Put a photo/video (media id) into a folder (created if missing). Pass folder='' to remove from folder.", {"media_id": {"type": "integer"}, "folder": S}, required=["media_id", "folder"])
def save_to_folder(media_id, folder):
    fid = None
    if folder:
        r = q("SELECT id FROM folders WHERE name=?", (folder,), one=True)
        fid = r["id"] if r else ins("INSERT INTO folders(name,color) VALUES(?,?)", (folder, "#8b5cf6"))
    q("UPDATE media SET folder_id=? WHERE id=?", (fid, media_id))
    return {"message": f"Media {media_id} → '{folder}'"}


@tool("add_dashboard_widget", "Add a card to the dashboard. type: live_count (current count of a label on a camera), snapshot (live thumbnail), today_total (unique count today).",
      {"type": {"type": "string", "enum": ["live_count", "snapshot", "today_total"]}, "title": S, "camera": CAM, "label": S, "color": {"type": "string", "description": "pink|violet|cyan|orange|green|blue"}}, required=["type", "title"])
def add_dashboard_widget(type, title, camera=None, label="person", color="violet"):
    ws = get_setting("widgets", []) or []
    cid = None if camera in (None, "", "all") else manager.get(camera).id
    w = {"id": int(time.time() * 1000), "type": type, "title": title, "camera": cid, "label": label, "color": color}
    set_setting("widgets", ws + [w])
    return {"message": f"Added the '{title}' card to the dashboard", "widget": w}


@tool("remove_dashboard_widget", "Remove a dashboard card by id or title.", {"widget": S}, required=["widget"])
def remove_dashboard_widget(widget):
    ws = get_setting("widgets", []) or []
    keep = [w for w in ws if str(w["id"]) != str(widget) and w["title"].lower() != str(widget).lower()]
    set_setting("widgets", keep)
    return {"message": f"{len(ws) - len(keep)} card(s) removed"}


@tool("set_app_setting", "Change app settings: detector (auto|yolo|hog), target_fps (3-25), retention_days, preroll_seconds, segment_seconds, accent (hex color for UI).",
      {"key": {"type": "string", "enum": ["detector", "target_fps", "retention_days", "preroll_seconds", "segment_seconds", "accent"]}, "value": S}, required=["key", "value"])
def set_app_setting(key, value):
    v = value
    if key != "detector" and key != "accent":
        v = float(value)
    set_setting(key, v)
    return {"message": f"{key} = {value}" + (" (restart the app for the detector change to apply)" if key == "detector" else "")}


@tool("system_status", "Disk usage, number of recordings/photos/events, detector in use, uptime.")
def system_status():
    import shutil
    du = shutil.disk_usage(DATA)
    size = sum(f.stat().st_size for f in DATA.rglob("*") if f.is_file())
    n = lambda t: q(f"SELECT COUNT(*) c FROM {t}", one=True)["c"]  # noqa
    return {"disk_free_gb": round(du.free / 1e9, 1), "disk_total_gb": round(du.total / 1e9, 1), "app_storage_mb": round(size / 1e6, 1),
            "cameras": len(manager.cams), "events": n("events"), "media": n("media"), "segments": n("segments"),
            "retention_days": get_setting("retention_days"), "detector": get_setting("detector"), "has_ai_key": bool(get_setting("anthropic_key"))}


# ------------------------------------------------------------------ self-extension
@tool("create_plugin",
      "ADD A NEW FEATURE to the app by writing a Python plugin (new tools, a dashboard page, event hooks). It is saved as PENDING and the user must approve it in the UI. Code format: META dict, TOOLS list of {name, description, input_schema, run(args, api)}, optional PANEL(api)->HTML string for a new sidebar page, optional ON_EVENT(event, api). api has: cameras(), counts(camera), snapshot(camera), events(...), sql(select, args), notify(text, speak), kv_get/kv_set, now(). Keep it small and safe; no file deletion, no network calls unless the user asked.",
      {"name": {"type": "string", "description": "snake_case id, e.g. vehicle_log"}, "description": S, "code": S}, required=["name", "description", "code"])
def create_plugin(name, description, code):
    r = plugins.propose(name, description, code)
    core.bus.publish({"event": "plugin_pending", "data": r})
    return {"message": f"Plugin '{r['name']}' is ready — review the code on the Extensions page and press Approve.", "pending_plugin": r["name"]}


@tool("list_plugins", "List installed/pending plugins.")
def list_plugins():
    return {"plugins": plugins.listing()}


@tool("manage_plugin", "Disable/delete an installed plugin (action=remove).", {"name": S, "action": {"type": "string", "enum": ["remove"]}}, required=["name", "action"])
def manage_plugin(name, action):
    plugins.remove(name)
    return {"message": f"Plugin '{name}' removed"}


@tool("read_plugin_code", "Read the source of an existing plugin before modifying it.", {"name": S}, required=["name"])
def read_plugin_code(name):
    for p in plugins.listing(with_code=True):
        if p["name"] == name:
            return {"code": p.get("code", ""), "status": p["status"]}
    raise KeyError("plugin not found")
