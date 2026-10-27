"""Core: paths, SQLite storage, settings, event bus, time helpers."""
import json
import os
import queue
import re
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("DRISHTI_DATA", BASE / "data"))
for _d in ("snapshots", "clips", "recordings", "exports", "plugins/active", "plugins/pending"):
    (DATA / _d).mkdir(parents=True, exist_ok=True)

_lock = threading.RLock()
_db = sqlite3.connect(DATA / "drishti.db", check_same_thread=False)
_db.row_factory = sqlite3.Row
_db.execute("PRAGMA journal_mode=WAL")

_db.executescript("""
CREATE TABLE IF NOT EXISTS cameras(id INTEGER PRIMARY KEY, name TEXT, kind TEXT, source TEXT, enabled INTEGER DEFAULT 1, cfg TEXT DEFAULT '{}');
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, ts REAL, cam_id INTEGER, type TEXT, label TEXT, count INTEGER DEFAULT 1, detail TEXT, media_id INTEGER);
CREATE INDEX IF NOT EXISTS ev_ts ON events(ts);
CREATE TABLE IF NOT EXISTS tracks(id INTEGER PRIMARY KEY, cam_id INTEGER, label TEXT, first REAL, last REAL);
CREATE INDEX IF NOT EXISTS tr_first ON tracks(first);
CREATE TABLE IF NOT EXISTS counts(ts REAL, cam_id INTEGER, label TEXT, n INTEGER);
CREATE INDEX IF NOT EXISTS ct_ts ON counts(ts);
CREATE TABLE IF NOT EXISTS segments(id INTEGER PRIMARY KEY, cam_id INTEGER, start REAL, end REAL, path TEXT);
CREATE INDEX IF NOT EXISTS sg_start ON segments(start);
CREATE TABLE IF NOT EXISTS media(id INTEGER PRIMARY KEY, ts REAL, kind TEXT, cam_id INTEGER, path TEXT, title TEXT, folder_id INTEGER, meta TEXT DEFAULT '{}');
CREATE TABLE IF NOT EXISTS folders(id INTEGER PRIMARY KEY, name TEXT UNIQUE, color TEXT);
CREATE TABLE IF NOT EXISTS rules(id INTEGER PRIMARY KEY, name TEXT, enabled INTEGER DEFAULT 1, cfg TEXT);
CREATE TABLE IF NOT EXISTS plugins(name TEXT PRIMARY KEY, description TEXT, status TEXT, created REAL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS plugin_kv(plugin TEXT, key TEXT, value TEXT, PRIMARY KEY(plugin, key));
""")
_db.commit()


def q(sql, args=(), one=False):
    with _lock:
        cur = _db.execute(sql, args)
        rows = cur.fetchall()
        _db.commit()
    if one:
        return rows[0] if rows else None
    return rows


def ins(sql, args=()):
    with _lock:
        cur = _db.execute(sql, args)
        _db.commit()
        return cur.lastrowid


def rows(sql, args=()):
    return [dict(r) for r in q(sql, args)]


# ---------- settings ----------
DEFAULTS = {
    "model": "claude-sonnet-5-5",
    "retention_days": 7,
    "detector": "auto",
    "target_fps": 10,
    "segment_seconds": 120,
    "preroll_seconds": 8,
    "widgets": [],
    "pin": "",
}
SECRET_KEYS = {"anthropic_key", "telegram_token", "pin"}


def get_setting(key, default=None):
    r = q("SELECT value FROM settings WHERE key=?", (key,), one=True)
    if r is None:
        if key == "anthropic_key":
            return os.environ.get("ANTHROPIC_API_KEY", default)
        if key == "pin":
            return os.environ.get("DRISHTI_PIN", DEFAULTS["pin"])
        return DEFAULTS.get(key, default)
    try:
        return json.loads(r["value"])
    except Exception:
        return r["value"]


def set_setting(key, value):
    ins("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, json.dumps(value)))


# ---------- event bus (SSE) ----------
class Bus:
    def __init__(self):
        self.subs = []
        self.lock = threading.Lock()

    def subscribe(self):
        qq = queue.Queue(maxsize=200)
        with self.lock:
            self.subs.append(qq)
        return qq

    def unsubscribe(self, qq):
        with self.lock:
            if qq in self.subs:
                self.subs.remove(qq)

    def publish(self, msg):
        with self.lock:
            for s in list(self.subs):
                try:
                    s.put_nowait(msg)
                except queue.Full:
                    pass


bus = Bus()


# ---------- time helpers ----------
_REL = re.compile(r"^-?\s*(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day)s?$", re.I)


def parse_time(s, now=None):
    """Accepts epoch, 'now', '-30m', '-2h', 'HH:MM' (today), ISO date/time."""
    now = now or time.time()
    if s is None or s == "":
        return None
    if isinstance(s, (int, float)):
        return float(s)
    s = str(s).strip()
    if s.lower() == "now":
        return now
    m = _REL.match(s)
    if m:
        n, u = float(m.group(1)), m.group(2).lower()
        mult = {"s": 1, "sec": 1, "m": 60, "min": 60, "h": 3600, "hr": 3600, "d": 86400, "day": 86400}[u]
        return now - n * mult
    m = re.match(r"^(\d{1,2}):(\d{2})$", s)
    if m:
        d = datetime.fromtimestamp(now).replace(hour=int(m.group(1)), minute=int(m.group(2)), second=0, microsecond=0)
        return d.timestamp()
    try:
        return float(s)
    except ValueError:
        pass
    return datetime.fromisoformat(s.replace("Z", "")).timestamp()


def fmt_ts(ts):
    return datetime.fromtimestamp(ts).strftime("%d %b %Y, %I:%M:%S %p")


def day_bounds(day=None):
    d = datetime.fromisoformat(day) if day else datetime.now()
    s = d.replace(hour=0, minute=0, second=0, microsecond=0)
    return s.timestamp(), (s + timedelta(days=1)).timestamp()


def media_url(rel):
    return "/media/" + str(rel).replace(os.sep, "/")


def register_media(kind, path, cam_id=None, title="", meta=None, ts=None):
    rel = Path(path).relative_to(DATA)
    mid = ins("INSERT INTO media(ts,kind,cam_id,path,title,meta) VALUES(?,?,?,?,?,?)",
              (ts or time.time(), kind, cam_id, str(rel), title, json.dumps(meta or {})))
    return {"id": mid, "kind": kind, "url": media_url(rel), "title": title, "cam_id": cam_id}
