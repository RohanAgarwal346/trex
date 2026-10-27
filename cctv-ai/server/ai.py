"""AI assistant: Claude with tool-use over the app's tools (+ offline keyword fallback)."""
import base64
import json
import re
import time
from datetime import datetime

from . import tools
from .camera import manager
from .core import get_setting

SYSTEM = """You are Drishti AI, the built-in assistant of a CCTV control app. The owner talks to you in English (often by voice) and you operate their cameras through tools.

Rules:
- Always reply in clear, simple English. Keep replies short, warm and easy to read aloud — 1-3 sentences. No markdown tables.
- Always use tools to act; never pretend. Photos/videos you create are shown to the user automatically — just say what you made. Do not paste URLs.
- Convert spoken times to tool times yourself. "yesterday 9 to 10 am" -> start/end ISO datetimes using the current time below. "last 30 seconds" -> last_seconds=30.
- For "how many people/cars right now" use count_objects. For counting arbitrary things or describing (colours, clothes, is the shutter open) use ask_about_camera and look at the image. For a detailed photo use take_snapshot with details=true.
- If a camera isn't specified and there are several, do it for all ('all') unless it's clearly a single-camera ask. If ambiguous, ask briefly.
- Be honest about limits: recordings exist only for periods when recording mode was on; counting history only since the app started detecting. Say so when a query returns nothing.
- Ask the user to confirm before remove_camera or deleting plugins/rules.
- If the user wants a NEW capability that no tool covers (new report, new page, new rule logic, custom alert, new integration), use create_plugin to write it, then tell them to press Approve in Extensions. For simple things use existing tools (rules, folders, dashboard widgets, settings) which apply instantly.
- Never expose secrets (API keys, passwords) in replies.
- The whole app is English-only: all names, labels and text you create must be in English.
"""


def _context():
    now = datetime.now().astimezone()
    cams = "; ".join(f"[{c.id}] {c.name} ({'online' if c.online else 'offline'}, rec={c.cfg.get('rec_mode')}, now={c.counts_now()})" for c in manager.all())
    return f"Current time: {now.strftime('%A %Y-%m-%d %H:%M:%S %Z')}\nCameras: {cams or 'none'}"


def run(messages, lang="hi"):
    key = get_setting("anthropic_key")
    last = messages[-1]["content"] if messages else ""
    if not key:
        return fallback(last)
    import anthropic
    client = anthropic.Anthropic(api_key=key)
    model = get_setting("model", "claude-sonnet-5-5")
    msgs = [{"role": m["role"], "content": m["content"]} for m in messages[-14:] if m.get("content")]
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    media, actions, pending = [], [], []
    tool_schemas = tools.schemas()
    try:
        for _ in range(10):
            resp = client.messages.create(model=model, max_tokens=1800, system=SYSTEM + "\n" + _context(), tools=tool_schemas, messages=msgs)
            msgs.append({"role": "assistant", "content": resp.content})
            if resp.stop_reason != "tool_use":
                text = "".join(b.text for b in resp.content if b.type == "text").strip()
                return {"reply": text or "Done ✅", "media": _dedupe(media), "actions": actions, "pending": pending}
            results = []
            for b in resp.content:
                if b.type != "tool_use":
                    continue
                r = tools.call(b.name, dict(b.input))
                media += r.pop("media", [])
                images = r.pop("_images", [])
                if r.get("pending_plugin"):
                    pending.append(r["pending_plugin"])
                actions.append({"tool": b.name, "ok": r.get("ok", True), "summary": (r.get("message") or r.get("error") or "")[:160]})
                content = [{"type": "text", "text": json.dumps(r, default=str)[:12000]}]
                for im in images:
                    content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(im).decode()}})
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": content, "is_error": not r.get("ok", True)})
            msgs.append({"role": "user", "content": results})
        return {"reply": "That took too long, please try again.", "media": _dedupe(media), "actions": actions, "pending": pending}
    except Exception as e:  # noqa
        name = e.__class__.__name__
        hint = "The API key is invalid or expired — check Settings." if "Authentication" in name else str(e)[:200]
        return {"reply": f"Could not reach the AI ({name}): {hint}", "media": _dedupe(media), "actions": actions, "pending": pending}


def _dedupe(media):
    seen, out = set(), []
    for m in media:
        if m["url"] not in seen:
            seen.add(m["url"])
            out.append(m)
    return out


# ------------------------------------------------------------------ offline fallback (no API key)


def _seconds(text):
    m = re.search(r"(\d+)\s*(second|sec|s\b|minute|min|m\b|hour|h\b)", text)
    if not m:
        return None
    n, u = int(m.group(1)), m.group(2)
    return n * (3600 if u[0] == "h" else 60 if u[0] == "m" else 1)


def fallback(text):
    t = text.lower()
    note = "\n\n(Basic mode — add an Anthropic API key in Settings for the full AI assistant.)"
    cam = None
    for c in manager.all():
        if c.name.lower().split("/")[0].strip() in t or str(c.id) == (re.search(r"(?:camera|cam)\s*(\d+)", t) or [None, None])[1]:
            cam = c.id
            break
    cam = cam if cam else "all"
    if re.search(r"video|clip|record", t):
        s = _seconds(t) or 15
        r = tools.call("get_video_clip", {"camera": cam, "last_seconds": s})
        return {"reply": (f"Here is the last {s} seconds of video 🎬" if r["ok"] else f"❌ {r['error']}") + note, "media": r.get("media", []), "actions": [], "pending": []}
    if re.search(r"count|how many", t):
        r = tools.call("count_objects", {"camera": cam})
        return {"reply": r.get("message", r.get("error", "")) + note, "media": [], "actions": [], "pending": []}
    if re.search(r"photo|picture|snapshot|still|image|pic", t):
        r = tools.call("take_snapshot", {"camera": cam, "details": True})
        return {"reply": ("Here is your photo with details 📸" if r["ok"] else f"❌ {r['error']}") + note, "media": r.get("media", []), "actions": [], "pending": []}
    if re.search(r"event|activity|who came|when", t):
        r = tools.call("get_activity", {"limit": 5})
        lines = [f"{e['time']} · {e['camera']} · {e['label']}" for e in r.get("events", [])]
        return {"reply": ("Latest activity:\n" + "\n".join(lines) if lines else "No activity yet") + note, "media": [], "actions": [], "pending": []}
    if re.search(r"camera|list", t):
        r = tools.call("list_cameras")
        return {"reply": "\n".join(f"{'🟢' if c['online'] else '🔴'} {c['name']}" for c in r["cameras"]) + note, "media": [], "actions": [], "pending": []}
    return {"reply": "I can do: photo, video, count, activity, camera list. For example: 'photo of the gate', 'video of the last 30 seconds', 'how many people are there'." + note,
            "media": [], "actions": [], "pending": []}
