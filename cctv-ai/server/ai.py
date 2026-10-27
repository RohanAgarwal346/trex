"""AI assistant: Claude with tool-use over the app's tools (+ offline keyword fallback)."""
import base64
import json
import re
import time
from datetime import datetime

from . import tools
from .camera import manager
from .core import get_setting

SYSTEM = """You are Drishti AI (दृष्टि), the built-in assistant of a CCTV control app. The owner talks to you (often in Hindi / Hinglish, sometimes by voice) and you operate their cameras through tools.

Rules:
- Reply in the SAME language/script the user used (Hindi in Devanagari, Hinglish, or English). Keep replies short, warm and easy to read aloud — 1-3 sentences. No markdown tables.
- Always use tools to act; never pretend. Photos/videos you create are shown to the user automatically — just say what you made. Do not paste URLs.
- Convert spoken times to tool times yourself. "kal subah 9 se 10" -> start/end ISO datetimes using the current time below. "pichhle 30 second" -> last_seconds=30.
- For "kitne log/gaadi" now use count_objects. For counting arbitrary things or describing (colours, clothes, is the shutter open) use ask_about_camera and look at the image. For a detailed photo use take_snapshot with details=true.
- If a camera isn't specified and there are several, do it for all ('all') unless it's clearly a single-camera ask. If ambiguous, ask briefly.
- Be honest about limits: recordings exist only for periods when recording mode was on; counting history only since the app started detecting. Say so when a query returns nothing.
- Ask the user to confirm before remove_camera or deleting plugins/rules.
- If the user wants a NEW capability that no tool covers (new report, new page, new rule logic, custom alert, new integration), use create_plugin to write it, then tell them to press Approve in Extensions. For simple things use existing tools (rules, folders, dashboard widgets, settings) which apply instantly.
- Never expose secrets (API keys, passwords) in replies.
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
                return {"reply": text or "Ho gaya ✅", "media": _dedupe(media), "actions": actions, "pending": pending}
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
        return {"reply": "Kaam thoda lamba ho gaya, dobara try kijiye.", "media": _dedupe(media), "actions": actions, "pending": pending}
    except Exception as e:  # noqa
        name = e.__class__.__name__
        hint = "API key galat/expire hai — Settings mein check kijiye." if "Authentication" in name else str(e)[:200]
        return {"reply": f"AI se baat nahi ho paayi ({name}): {hint}", "media": _dedupe(media), "actions": actions, "pending": pending}


def _dedupe(media):
    seen, out = set(), []
    for m in media:
        if m["url"] not in seen:
            seen.add(m["url"])
            out.append(m)
    return out


# ------------------------------------------------------------------ offline fallback (no API key)
_NUM = {"ek": 1, "do": 2, "teen": 3, "char": 4, "paanch": 5, "das": 10, "bees": 20, "tees": 30, "saath": 60}


def _seconds(text):
    m = re.search(r"(\d+)\s*(second|sec|सेकंड|सेकेंड|s\b|minute|min|मिनट|m\b|hour|घंटे|घंटा|ghante|h\b)", text)
    if not m:
        return None
    n, u = int(m.group(1)), m.group(2)
    return n * (3600 if u[0] in "hघ" else 60 if u[0] in "mम" else 1)


def fallback(text):
    t = text.lower()
    note = "\n\n(Basic mode — poori AI ke liye Settings mein Anthropic API key daaliye.)"
    cam = None
    for c in manager.all():
        if c.name.lower().split("/")[0].strip() in t or str(c.id) == (re.search(r"(?:camera|cam|कैमरा)\s*(\d+)", t) or [None, None])[1]:
            cam = c.id
            break
    cam = cam if cam else "all"
    if re.search(r"video|clip|वीडियो|रिकॉर्ड|record", t):
        s = _seconds(t) or 15
        r = tools.call("get_video_clip", {"camera": cam, "last_seconds": s})
        return {"reply": (f"Pichhle {s} second ki video taiyaar hai 🎬" if r["ok"] else f"❌ {r['error']}") + note, "media": r.get("media", []), "actions": [], "pending": []}
    if re.search(r"count|गिन|कितने|काउंट|kitne|kitni", t):
        r = tools.call("count_objects", {"camera": cam})
        return {"reply": r.get("message", r.get("error", "")) + note, "media": [], "actions": [], "pending": []}
    if re.search(r"photo|फोटो|फ़ोटो|तस्वीर|snapshot|still|स्टिल|image|pic", t):
        r = tools.call("take_snapshot", {"camera": cam, "details": True})
        return {"reply": ("Ye lijiye details ke saath photo 📸" if r["ok"] else f"❌ {r['error']}") + note, "media": r.get("media", []), "actions": [], "pending": []}
    if re.search(r"event|activity|एक्टिविटी|कौन आया|kaun aaya|kab", t):
        r = tools.call("get_activity", {"limit": 5})
        lines = [f"{e['time']} · {e['camera']} · {e['label']}" for e in r.get("events", [])]
        return {"reply": ("Aakhri activity:\n" + "\n".join(lines) if lines else "Abhi tak koi activity nahi") + note, "media": [], "actions": [], "pending": []}
    if re.search(r"camera|कैमरे|list|सूची", t):
        r = tools.call("list_cameras")
        return {"reply": "\n".join(f"{'🟢' if c['online'] else '🔴'} {c['name']}" for c in r["cameras"]) + note, "media": [], "actions": [], "pending": []}
    return {"reply": "Main ye kar sakta hoon: photo, video, count, activity, camera list. Jaise: 'gate ka photo do', 'pichhle 30 second ki video', 'kitne log hain'." + note,
            "media": [], "actions": [], "pending": []}
