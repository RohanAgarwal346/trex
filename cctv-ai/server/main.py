"""FastAPI app: REST + MJPEG + SSE + static UI."""
import asyncio
import hashlib
import ipaddress
import hmac
import json
import os
import secrets
import threading
import time
from pathlib import Path

from fastapi import Body, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import ai, core, plugins, tools
from .camera import manager, validate_source
from .core import DATA, SECRET_KEYS, get_setting, q, rows, set_setting
from .rules import Rules

WEB = core.BASE / "web"
app = FastAPI(title="Drishti AI")
_SECRET = secrets.token_bytes(32)


def _token(pin):
    return hmac.new(_SECRET, pin.encode(), hashlib.sha256).hexdigest()


@app.on_event("startup")
def _startup():
    manager.load()
    Rules(manager)
    plugins.load_all()


def _local_host(host):
    h = (host or "").rsplit(":", 1)[0].strip("[]") if not (host or "").startswith("[") else host.split("]")[0].strip("[")
    if h in ("localhost", "::1"):
        return True
    try:
        ip = ipaddress.ip_address(h)
        return ip.is_loopback or ip.is_private
    except ValueError:
        return False


@app.middleware("http")
async def auth_mw(request: Request, call_next):
    pin = get_setting("pin")
    p = request.url.path
    # Anything reachable from outside the home network MUST be PIN-protected (also blocks DNS-rebinding on localhost).
    if not pin and not _local_host(request.headers.get("host", "")):
        return JSONResponse({"error": "Set a PIN in Settings (from your local network) before accessing remotely."}, status_code=403)
    # CSRF guard: state-changing calls must come from our own UI (custom header forces a CORS preflight for other sites).
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and p.startswith("/api") and request.headers.get("x-requested-with") != "drishti":
        return JSONResponse({"error": "bad request origin"}, status_code=403)
    if pin and not p.startswith(("/api/login", "/api/auth")) and (p.startswith(("/api", "/media"))):
        if not hmac.compare_digest(request.cookies.get("dt", ""), _token(pin)):
            return JSONResponse({"error": "login required"}, status_code=401)
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


# ---------------- auth
@app.get("/api/auth")
def auth_state(request: Request):
    pin = get_setting("pin")
    ok = (not pin) or hmac.compare_digest(request.cookies.get("dt", ""), _token(pin))
    return {"pin_required": bool(pin), "ok": ok}


@app.post("/api/login")
def login(resp: Response, body: dict = Body(...)):
    pin = get_setting("pin")
    if pin and not hmac.compare_digest(str(body.get("pin", "")), pin):
        time.sleep(1)
        raise HTTPException(401, "Wrong PIN")
    resp.set_cookie("dt", _token(pin or ""), httponly=True, samesite="strict", max_age=86400 * 30)
    return {"ok": True}


# ---------------- status & cameras
@app.get("/api/status")
def status():
    cams = [c.status() for c in manager.all()]
    t0, t1 = core.day_bounds()
    today = {r["label"]: r["n"] for r in rows("SELECT label, COUNT(*) n FROM tracks WHERE first BETWEEN ? AND ? GROUP BY label", (t0, t1))}
    ev_today = q("SELECT COUNT(*) c FROM events WHERE ts BETWEEN ? AND ? AND type IN ('motion','object')", (t0, t1), one=True)["c"]
    live = {}
    for c in cams:
        for k, v in c["counts"].items():
            live[k] = live.get(k, 0) + v
    return {"cameras": cams, "today_unique": today, "events_today": ev_today, "live_counts": live, "ai": bool(get_setting("anthropic_key")),
            "system": tools.system_status(), "widgets": get_setting("widgets", []), "accent": get_setting("accent", None),
            "plugins": [p for p in plugins.listing() if p["status"] == "active"], "now": time.time()}


@app.post("/api/cameras/test")
def test_camera(body: dict = Body(...)):
    import cv2
    try:
        src = validate_source(body["kind"], body.get("source", ""))
    except Exception as e:
        return {"ok": False, "error": str(e)}
    if body["kind"] == "demo":
        return {"ok": True}
    cap = cv2.VideoCapture(int(src) if body["kind"] == "webcam" else src)
    ok, fr = (cap.read() if cap.isOpened() else (False, None))
    cap.release()
    return {"ok": bool(ok), "error": "" if ok else "Could not connect — check the URL, IP and password", "size": list(fr.shape[1::-1]) if ok else None}


@app.post("/api/cameras")
def add_camera(body: dict = Body(...)):
    return tools.call("add_camera", {k: body.get(k) for k in ("name", "kind", "source", "location")})


@app.put("/api/cameras/{cid}")
def put_camera(cid: int, body: dict = Body(...)):
    args = {k: body.get(k) for k in ("name", "source", "enabled", "location", "detect", "sensitivity", "labels")}
    r = tools.call("update_camera", {"camera": str(cid), **args})
    if body.get("rec_mode"):
        tools.call("set_recording", {"camera": str(cid), "mode": body["rec_mode"]})
    if "zone" in body or "line" in body:
        manager.update(cid, cfg={k: body[k] for k in ("zone", "line") if k in body})
    return r


@app.delete("/api/cameras/{cid}")
def del_camera(cid: int):
    return tools.call("remove_camera", {"camera": str(cid)})


@app.get("/api/cameras/{cid}/mjpeg")
async def mjpeg(cid: int, request: Request, ann: int = 0):
    cam = manager.cams.get(cid)
    if not cam:
        raise HTTPException(404)

    async def gen():
        last = -1
        while not await request.is_disconnected():
            if cam.frame_id != last and cam.jpeg:
                last = cam.frame_id
                jp = cam.get_jpeg(bool(ann))
                yield b"--f\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(jp)).encode() + b"\r\n\r\n" + jp + b"\r\n"
            await asyncio.sleep(0.08)
    return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=f", headers={"Cache-Control": "no-store"})


@app.get("/api/cameras/{cid}/frame.jpg")
def frame(cid: int, ann: int = 0):
    cam = manager.cams.get(cid)
    jp = cam and cam.wait_frame(4) is not None and cam.get_jpeg(bool(ann))
    if not jp:
        raise HTTPException(503, "no frame")
    return Response(jp, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


# ---------------- tools via REST (used by UI buttons)
@app.post("/api/tool/{name}")
def run_tool(name: str, body: dict = Body(default={})):
    return tools.call(name, body)


@app.get("/api/events")
def events(camera: str = None, type: str = None, label: str = None, start: str = None, end: str = None, limit: int = 100):
    return tools.call("get_activity", {"camera": camera, "type": type, "label": label, "start": start, "end": end, "limit": limit})


@app.get("/api/hourly")
def hourly(camera: str = None, day: str = None, label: str = "person"):
    return tools.call("hourly_summary", {"camera": camera, "day": day, "label": label})


# ---------------- media & folders
@app.get("/api/media")
def media_list(kind: str = None, folder: str = None, limit: int = 120):
    cond, args = ["1=1"], []
    if kind:
        cond.append("m.kind=?")
        args.append(kind)
    else:
        cond.append("m.kind IN ('snapshot','clip','export')")
    if folder == "none":
        cond.append("m.folder_id IS NULL")
    elif folder:
        cond.append("f.name=?")
        args.append(folder)
    r = rows(f"SELECT m.*, f.name folder FROM media m LEFT JOIN folders f ON f.id=m.folder_id WHERE {' AND '.join(cond)} ORDER BY m.ts DESC LIMIT ?", (*args, limit))
    names = {c.id: c.name for c in manager.all()}
    return {"items": [{"id": x["id"], "kind": x["kind"], "title": x["title"], "ts": x["ts"], "url": core.media_url(x["path"]), "folder": x["folder"],
                       "camera": names.get(x["cam_id"], "")} for x in r],
            "folders": rows("SELECT f.*, (SELECT COUNT(*) FROM media WHERE folder_id=f.id) n FROM folders f ORDER BY name")}


@app.delete("/api/media/{mid}")
def media_del(mid: int):
    m = q("SELECT * FROM media WHERE id=?", (mid,), one=True)
    if m:
        (DATA / m["path"]).unlink(missing_ok=True)
        q("DELETE FROM media WHERE id=?", (mid,))
    return {"ok": True}


@app.get("/media/{path:path}")
def media_file(path: str):
    p = (DATA / path).resolve()
    if DATA.resolve() not in p.parents or not p.is_file() or p.suffix.lower() not in (".jpg", ".mp4", ".csv", ".png"):
        raise HTTPException(404)
    return FileResponse(p, headers={"Content-Disposition": "inline" if p.suffix != ".csv" else f'attachment; filename="{p.name}"'})


# ---------------- rules
@app.get("/api/rules")
def rules_list():
    return tools.call("list_rules")


@app.post("/api/rules")
def rules_add(body: dict = Body(...)):
    return tools.call("create_rule", body)


@app.patch("/api/rules/{rid}")
def rules_patch(rid: int, body: dict = Body(...)):
    return tools.call("update_rule", {"rule_id": rid, **body})


# ---------------- settings
@app.get("/api/settings")
def settings_get():
    keys = ["model", "retention_days", "detector", "target_fps", "preroll_seconds", "segment_seconds", "telegram_chat", "webhook_url"]
    out = {k: get_setting(k) for k in keys}
    out.update({"anthropic_key_set": bool(get_setting("anthropic_key")), "telegram_token_set": bool(get_setting("telegram_token")), "pin_set": bool(get_setting("pin"))})
    return out


@app.put("/api/settings")
def settings_put(body: dict = Body(...)):
    allowed = {"model", "retention_days", "detector", "target_fps", "preroll_seconds", "segment_seconds", "telegram_chat", "webhook_url",
               "anthropic_key", "telegram_token", "pin", "accent", "stt_model"}
    for k, v in body.items():
        if k in allowed and v is not None:
            if k in SECRET_KEYS and v == "":
                continue
            set_setting(k, v)
    if body.get("clear_pin"):
        set_setting("pin", "")
    return {"ok": True}


# ---------------- speech-to-text (desktop/Android shells can't use the browser's built-in recognizer)
_stt = {"model": None, "lock": threading.Lock()}


@app.post("/api/transcribe")
async def transcribe(request: Request):
    audio = await request.body()
    if not audio or len(audio) > 12_000_000:
        raise HTTPException(400, "No audio received (or too large)")

    def work():
        import tempfile
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            raise HTTPException(501, "Offline voice is not installed. Run: pip install faster-whisper")
        with _stt["lock"]:
            if _stt["model"] is None:
                try:
                    _stt["model"] = WhisperModel(get_setting("stt_model", "base.en"), device="cpu", compute_type="int8")
                except Exception as e:  # noqa
                    raise HTTPException(503, f"Could not load the speech model (first run needs internet): {e}")
            with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as f:
                f.write(audio)
            try:
                segs, _ = _stt["model"].transcribe(f.name, language="en", vad_filter=True, beam_size=1)
                return " ".join(s.text.strip() for s in segs).strip()
            finally:
                Path(f.name).unlink(missing_ok=True)
    text = await asyncio.get_event_loop().run_in_executor(None, work)
    return {"text": text}


# ---------------- AI chat & plugins
@app.post("/api/chat")
def chat(body: dict = Body(...)):
    return ai.run(body.get("messages", []), body.get("lang", "hi"))


@app.get("/api/plugins")
def plugins_list():
    return {"plugins": plugins.listing(with_code=True)}


@app.post("/api/plugins/{name}/{action}")
def plugins_action(name: str, action: str):
    try:
        if action == "approve":
            return plugins.approve(name)
        if action == "reject":
            return plugins.reject(name) or {"ok": True}
        if action == "remove":
            return plugins.remove(name) or {"ok": True}
    except Exception as e:  # noqa
        raise HTTPException(400, str(e))
    raise HTTPException(404)


@app.get("/api/plugins/{name}/panel", response_class=HTMLResponse)
def plugin_panel(name: str):
    try:
        html = plugins.panel_html(name)
    except KeyError:
        raise HTTPException(404)
    return HTMLResponse(html, headers={"Content-Security-Policy": "sandbox allow-scripts"})


# ---------------- live push (alerts, events)
@app.get("/api/stream")
async def stream(request: Request):
    qq = core.bus.subscribe()

    async def gen():
        try:
            yield "retry: 3000\n\n"
            while not await request.is_disconnected():
                try:
                    m = await asyncio.get_event_loop().run_in_executor(None, lambda: qq.get(timeout=15))
                    yield f"event: {m['event']}\ndata: {json.dumps(m['data'], default=str)}\n\n"
                except Exception:
                    yield ": ping\n\n"
        finally:
            core.bus.unsubscribe(qq)
    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
