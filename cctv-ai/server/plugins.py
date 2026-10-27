"""Self-extension: AI-written plugins (new tools, dashboard panels, event hooks) behind a human approval gate.

A plugin is a Python file:
    META  = {"title": "...", "icon": "🧪"}
    TOOLS = [{"name": "x", "description": "...", "input_schema": {...JSON schema...}, "run": lambda args, api: {...}}]
    def PANEL(api) -> str            # optional: HTML shown as a new sidebar page
    def ON_EVENT(event, api) -> None # optional: called for every camera event
Plugins run IN-PROCESS with full privileges, so nothing is activated until the user reads and approves the code.
"""
import importlib.util
import json
import re
import shutil
import sqlite3
import time
import traceback

from . import core
from .core import DATA, ins, q, rows

ACTIVE = DATA / "plugins" / "active"
PENDING = DATA / "plugins" / "pending"
NAME_RE = re.compile(r"^[a-z][a-z0-9_]{2,30}$")
LOADED = {}


class PluginAPI:
    """What plugin code may call."""

    def __init__(self, name):
        self.name = name

    def now(self):
        return time.time()

    def cameras(self):
        from .camera import manager
        return [c.status() for c in manager.all()]

    def counts(self, camera=None):
        from . import tools
        return tools.call("count_objects", {"camera": camera}, quiet=True)

    def snapshot(self, camera=None):
        from . import tools
        return tools.call("take_snapshot", {"camera": camera}, quiet=True)

    def events(self, limit=50, type=None, camera=None, start=None, end=None):
        from . import tools
        return tools.call("get_activity", {"limit": limit, "type": type, "camera": camera, "start": start, "end": end}, quiet=True)

    def sql(self, query, args=()):
        """Read-only SQL against the Drishti database."""
        if not re.match(r"^\s*select\b", query, re.I) or ";" in query.strip().rstrip(";"):
            raise ValueError("Only a single SELECT is allowed")
        con = sqlite3.connect(f"file:{core.DATA / 'drishti.db'}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in con.execute(query, args).fetchall()]
        finally:
            con.close()

    def notify(self, text, speak=False):
        from .rules import notify
        notify(f"[{self.name}] {text}", speak=speak)

    def kv_get(self, key, default=None):
        r = q("SELECT value FROM plugin_kv WHERE plugin=? AND key=?", (self.name, key), one=True)
        return json.loads(r["value"]) if r else default

    def kv_set(self, key, value):
        ins("INSERT INTO plugin_kv VALUES(?,?,?) ON CONFLICT(plugin,key) DO UPDATE SET value=excluded.value",
            (self.name, key, json.dumps(value)))


def _import(path, name):
    spec = importlib.util.spec_from_file_location(f"drishti_plugin_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for t in getattr(mod, "TOOLS", []):
        if not (isinstance(t, dict) and {"name", "description", "input_schema", "run"} <= set(t)):
            raise ValueError("Each TOOLS entry needs name, description, input_schema, run")
        if not re.match(r"^[a-zA-Z][a-zA-Z0-9]{0,20}$", t["name"]):
            raise ValueError(f"Tool name '{t['name']}' must be letters/digits only")
    return mod


def load_all():
    for p in ACTIVE.glob("*.py"):
        try:
            LOADED[p.stem] = _import(p, p.stem)
        except Exception as e:  # noqa
            print(f"[plugins] failed to load {p.stem}: {e}")


def validate_code(code):
    if len(code) > 60_000:
        raise ValueError("Plugin code too large (>60KB)")
    compile(code, "<plugin>", "exec")


def propose(name, description, code):
    name = (name or "").strip().lower()
    if not NAME_RE.match(name):
        raise ValueError("Plugin name: lowercase letters/digits/underscore, 3-31 chars, starts with a letter")
    validate_code(code)
    (PENDING / f"{name}.py").write_text(code, encoding="utf-8")
    ins("INSERT INTO plugins(name,description,status,created) VALUES(?,?,?,?) "
        "ON CONFLICT(name) DO UPDATE SET description=excluded.description, status='pending', created=excluded.created",
        (name, description, "pending", time.time()))
    return {"name": name, "status": "pending"}


def approve(name):
    src = PENDING / f"{name}.py"
    if not src.exists():
        raise FileNotFoundError("No pending plugin with that name")
    dst = ACTIVE / f"{name}.py"
    shutil.copy(src, dst)
    try:
        LOADED[name] = _import(dst, name)
    except Exception:
        dst.unlink(missing_ok=True)
        raise
    src.unlink()
    q("UPDATE plugins SET status='active' WHERE name=?", (name,))
    return {"name": name, "status": "active"}


def reject(name):
    (PENDING / f"{name}.py").unlink(missing_ok=True)
    q("DELETE FROM plugins WHERE name=? AND status='pending'", (name,))


def remove(name):
    LOADED.pop(name, None)
    (ACTIVE / f"{name}.py").unlink(missing_ok=True)
    (PENDING / f"{name}.py").unlink(missing_ok=True)
    q("DELETE FROM plugins WHERE name=?", (name,))


def listing(with_code=False):
    out = []
    for r in rows("SELECT * FROM plugins ORDER BY created DESC"):
        d = dict(r)
        mod = LOADED.get(r["name"])
        meta = getattr(mod, "META", {}) if mod else {}
        d.update(title=meta.get("title", r["name"]), icon=meta.get("icon", "🧩"),
                 has_panel=bool(mod and hasattr(mod, "PANEL")), tools=[t["name"] for t in getattr(mod, "TOOLS", [])] if mod else [])
        if with_code:
            for base in (PENDING, ACTIVE):
                p = base / f"{r['name']}.py"
                if p.exists():
                    d["code"] = p.read_text(encoding="utf-8")
                    break
        out.append(d)
    return out


def tool_schemas():
    out = []
    for pname, mod in LOADED.items():
        for t in getattr(mod, "TOOLS", []):
            out.append({"name": f"{pname}__{t['name']}", "description": f"[plugin {pname}] {t['description']}", "input_schema": t["input_schema"]})
    return out


def call_tool(full, args):
    pname, _, tname = full.partition("__")
    mod = LOADED.get(pname)
    if not mod:
        raise KeyError(full)
    for t in getattr(mod, "TOOLS", []):
        if t["name"] == tname:
            res = t["run"](args, PluginAPI(pname))
            return res if isinstance(res, dict) else {"ok": True, "result": res}
    raise KeyError(full)


def panel_html(name):
    mod = LOADED.get(name)
    if not mod or not hasattr(mod, "PANEL"):
        raise KeyError(name)
    try:
        return str(mod.PANEL(PluginAPI(name)))
    except Exception:
        return f"<pre style='color:#f66'>{traceback.format_exc()}</pre>"


def dispatch_event(ev):
    for name, mod in list(LOADED.items()):
        fn = getattr(mod, "ON_EVENT", None)
        if fn:
            try:
                fn(ev, PluginAPI(name))
            except Exception as e:  # noqa
                print(f"[plugin {name}] ON_EVENT error: {e}")
