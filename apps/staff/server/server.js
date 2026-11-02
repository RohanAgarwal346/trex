'use strict';
// Ropo Staff server: staff login (mobile + PIN), godown geofenced attendance, receipts queue for Tally,
// admin panel, and a bridge API that a small script on the Tally PC polls. No npm dependencies.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'ropo.db'));
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS staff(id INTEGER PRIMARY KEY, name TEXT NOT NULL, mobile TEXT UNIQUE NOT NULL, pin_hash TEXT NOT NULL, pin_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff', active INTEGER NOT NULL DEFAULT 1, device_id TEXT, fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,
  can_receipt INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, last_login INTEGER);
CREATE TABLE IF NOT EXISTS godowns(id INTEGER PRIMARY KEY, name TEXT NOT NULL, lat REAL, lng REAL, radius_m INTEGER NOT NULL DEFAULT 100, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS attendance(id INTEGER PRIMARY KEY, staff_id INTEGER NOT NULL, godown_id INTEGER NOT NULL, type TEXT NOT NULL, ts INTEGER NOT NULL, day TEXT NOT NULL,
  lat REAL, lng REAL, accuracy REAL, distance_m REAL);
CREATE INDEX IF NOT EXISTS att_day ON attendance(day, staff_id);
CREATE TABLE IF NOT EXISTS receipts(id INTEGER PRIMARY KEY, client_id TEXT NOT NULL, staff_id INTEGER NOT NULL, ts INTEGER NOT NULL, vdate TEXT NOT NULL, party TEXT NOT NULL,
  amount REAL NOT NULL, mode TEXT NOT NULL, bills TEXT NOT NULL DEFAULT '[]', narration TEXT, lat REAL, lng REAL, status TEXT NOT NULL DEFAULT 'pending',
  error TEXT, voucher_no TEXT, synced_at INTEGER, UNIQUE(staff_id, client_id));
CREATE INDEX IF NOT EXISTS rc_status ON receipts(status);
CREATE TABLE IF NOT EXISTS ledgers(name TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, staff_id INTEGER, role TEXT NOT NULL, expires INTEGER NOT NULL);
`);

// ---------- settings ----------
const getSetting = (k, d = '') => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : d; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
const rand = (n = 24) => crypto.randomBytes(n).toString('base64url');
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || getSetting('admin_password');
if (!ADMIN_PASSWORD) { ADMIN_PASSWORD = rand(9); setSetting('admin_password', ADMIN_PASSWORD); console.log(`\n  Generated admin password: ${ADMIN_PASSWORD}\n  (set ADMIN_PASSWORD env var to choose your own)\n`); }
let BRIDGE_KEY = getSetting('bridge_key'); if (!BRIDGE_KEY) { BRIDGE_KEY = rand(18); setSetting('bridge_key', BRIDGE_KEY); }
const DEFAULT_MODE_LEDGERS = { cash: 'Cash', upi: 'Bank Account', bank: 'Bank Account', cheque: 'Bank Account' };
const modeLedgers = () => { try { return { ...DEFAULT_MODE_LEDGERS, ...JSON.parse(getSetting('mode_ledgers', '{}')) }; } catch { return DEFAULT_MODE_LEDGERS; } };

// ---------- helpers ----------
const IST = 19800000;
const istDay = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
const timingSafeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = (d) => d * Math.PI / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
class HttpError extends Error { constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra; } }
const bad = (msg, extra) => new HttpError(400, msg, extra);
const cleanMobile = (m) => { const d = String(m || '').replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; };
const validMobile = (m) => /^[6-9]\d{9}$/.test(m);
const validPin = (p) => /^\d{4,6}$/.test(String(p || ''));
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

function newSession(staffId, role, days) {
  const token = rand(32);
  db.prepare('INSERT INTO sessions(token_hash,staff_id,role,expires) VALUES(?,?,?,?)').run(sha(token), staffId, role, Date.now() + days * 864e5);
  return token;
}
function sessionFrom(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(sha(h.slice(7)));
  if (!s || s.expires < Date.now()) return null;
  return s;
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, access, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), access, handler });
const staffPublic = (s) => ({ id: s.id, name: s.name, mobile: s.mobile, role: s.role, active: !!s.active, can_receipt: !!s.can_receipt, has_device: !!s.device_id, last_login: s.last_login });

function todayStatus(staffId) {
  const day = istDay(Date.now());
  const rows = db.prepare('SELECT a.*, g.name AS godown FROM attendance a JOIN godowns g ON g.id=a.godown_id WHERE staff_id=? AND day=? ORDER BY ts').all(staffId, day);
  return { day, punches: rows, state: rows.length && rows[rows.length - 1].type === 'in' ? 'in' : 'out' };
}

route('POST', '/api/login', 'public', ({ body }) => {
  const mobile = cleanMobile(body.mobile), pin = String(body.pin || ''), device = str(body.deviceId, 100);
  const s = db.prepare('SELECT * FROM staff WHERE mobile=?').get(mobile);
  if (!s || !s.active) throw new HttpError(401, 'Mobile number or PIN is wrong');
  if (s.locked_until > Date.now()) throw new HttpError(429, `Too many wrong attempts. Try again in ${Math.ceil((s.locked_until - Date.now()) / 60000)} min.`);
  if (!timingSafeEq(hashPin(pin, s.pin_salt), s.pin_hash)) {
    const fails = s.fails + 1;
    db.prepare('UPDATE staff SET fails=?, locked_until=? WHERE id=?').run(fails >= 5 ? 0 : fails, fails >= 5 ? Date.now() + 10 * 60000 : 0, s.id);
    throw new HttpError(401, 'Mobile number or PIN is wrong');
  }
  if (device) {
    if (s.device_id && s.device_id !== device) throw new HttpError(403, 'This account is locked to another phone. Ask the owner to reset your device.');
    if (!s.device_id) db.prepare('UPDATE staff SET device_id=? WHERE id=?').run(device, s.id);
  }
  db.prepare('UPDATE staff SET fails=0, locked_until=0, last_login=? WHERE id=?').run(Date.now(), s.id);
  return { token: newSession(s.id, s.role === 'manager' ? 'manager' : 'staff', 30), staff: staffPublic(s) };
});

route('GET', '/api/me', 'staff', ({ user }) => ({
  staff: staffPublic(user.staff), today: todayStatus(user.staff.id),
  godowns: db.prepare('SELECT id,name,lat,lng,radius_m FROM godowns WHERE active=1 AND lat IS NOT NULL').all(),
  modes: Object.keys(modeLedgers()), parties_synced: db.prepare('SELECT COUNT(*) c FROM ledgers').get().c > 0,
}));

route('POST', '/api/attendance', 'staff', ({ body, user }) => {
  const type = body.type;
  if (type !== 'in' && type !== 'out') throw bad('type must be in or out');
  const lat = num(body.lat), lng = num(body.lng), acc = Number.isFinite(num(body.accuracy)) ? num(body.accuracy) : null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw bad('Location not received. Turn on GPS and try again.');
  if (acc !== null && acc > 150) throw bad(`GPS is not accurate enough (${Math.round(acc)} m). Go outside / near a window and try again.`);
  const gs = db.prepare('SELECT * FROM godowns WHERE active=1 AND lat IS NOT NULL AND lng IS NOT NULL').all()
    .map((g) => ({ ...g, distance: haversine(lat, lng, g.lat, g.lng) })).sort((a, b) => a.distance - b.distance);
  if (!gs.length) throw bad('No godown location is set yet. Ask the owner.');
  const near = gs[0];
  if (near.distance > near.radius_m) throw bad(`You are ${Math.round(near.distance)} m from ${near.name}. You must be within ${near.radius_m} m of a godown.`, { nearest: { name: near.name, distance_m: Math.round(near.distance), radius_m: near.radius_m } });
  const st = todayStatus(user.staff.id);
  if (type === 'in' && st.state === 'in') throw new HttpError(409, 'You are already punched in.');
  if (type === 'out' && st.state !== 'in') throw new HttpError(409, 'You have not punched in yet.');
  const ts = Date.now();
  const info = db.prepare('INSERT INTO attendance(staff_id,godown_id,type,ts,day,lat,lng,accuracy,distance_m) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(user.staff.id, near.id, type, ts, istDay(ts), lat, lng, acc, near.distance);
  sendWebhook({ event: 'attendance', id: Number(info.lastInsertRowid), type, staff: user.staff.name, mobile: user.staff.mobile, godown: near.name, time: new Date(ts + IST).toISOString().replace('Z', '+05:30'), distance_m: Math.round(near.distance) });
  return { ok: true, godown: near.name, distance_m: Math.round(near.distance), today: todayStatus(user.staff.id) };
});

route('GET', '/api/attendance', 'staff', ({ query, user }) => {
  const month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month : istDay(Date.now()).slice(0, 7);
  return db.prepare("SELECT a.id,a.type,a.ts,a.day,g.name AS godown,a.distance_m FROM attendance a JOIN godowns g ON g.id=a.godown_id WHERE staff_id=? AND day LIKE ? ORDER BY ts DESC").all(user.staff.id, month + '%');
});

route('GET', '/api/parties', 'staff', ({ query }) => {
  const q = str(query.q, 60).toLowerCase();
  return db.prepare('SELECT name FROM ledgers WHERE lower(name) LIKE ? ORDER BY name LIMIT 30').all('%' + q + '%').map((r) => r.name);
});

function parseBills(raw, amount) {
  if (!Array.isArray(raw)) return [];
  const out = raw.map((b) => ({ ref: str(b.ref, 60), amount: Math.round(num(b.amount) * 100) / 100 })).filter((b) => b.ref || b.amount);
  for (const b of out) if (!b.ref || !(b.amount > 0)) throw bad('Each bill needs a bill number and an amount.');
  if (out.reduce((s, b) => s + b.amount, 0) > amount + 0.005) throw bad('Bill amounts add up to more than the amount received.');
  return out;
}

route('POST', '/api/receipts', 'staff', ({ body, user }) => {
  if (!user.staff.can_receipt) throw new HttpError(403, 'Receipts are not enabled for your account.');
  const clientId = str(body.client_id, 64); if (!clientId) throw bad('client_id missing');
  const exist = db.prepare('SELECT * FROM receipts WHERE staff_id=? AND client_id=?').get(user.staff.id, clientId);
  if (exist) return { ok: true, duplicate: true, receipt: exist };
  const amount = Math.round(num(body.amount) * 100) / 100;
  if (!(amount > 0) || amount > 1e8) throw bad('Enter a valid amount.');
  const mode = str(body.mode, 10); if (!(mode in modeLedgers())) throw bad('Choose Cash, UPI, Bank or Cheque.');
  let party = str(body.party, 120); if (!party) throw bad('Choose the customer.');
  if (db.prepare('SELECT COUNT(*) c FROM ledgers').get().c > 0) {
    const m = db.prepare('SELECT name FROM ledgers WHERE lower(name)=lower(?)').get(party);
    if (!m) throw bad('This customer is not in Tally. Pick the name from the list.');
    party = m.name;
  }
  const bills = parseBills(body.bills, amount);
  const ts = Date.now(), lat = num(body.lat), lng = num(body.lng);
  const info = db.prepare('INSERT INTO receipts(client_id,staff_id,ts,vdate,party,amount,mode,bills,narration,lat,lng) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(clientId, user.staff.id, ts, istDay(ts), party, amount, mode, JSON.stringify(bills), str(body.narration, 250), Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null);
  const rec = db.prepare('SELECT * FROM receipts WHERE id=?').get(info.lastInsertRowid);
  sendWebhook({ event: 'receipt', id: rec.id, staff: user.staff.name, party, amount, mode });
  return { ok: true, receipt: rec };
});

route('GET', '/api/receipts', 'staff', ({ user }) =>
  db.prepare('SELECT id,client_id,ts,party,amount,mode,bills,narration,status,error,voucher_no FROM receipts WHERE staff_id=? ORDER BY id DESC LIMIT 100').all(user.staff.id));

// a manager standing at a godown can fix its GPS point from the phone
route('POST', '/api/godowns/:id/here', 'manager', ({ params, body }) => {
  const lat = num(body.lat), lng = num(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw bad('Location not received.');
  const r = db.prepare('UPDATE godowns SET lat=?, lng=? WHERE id=?').run(lat, lng, params.id);
  if (!r.changes) throw new HttpError(404, 'Godown not found');
  return { ok: true };
});
route('GET', '/api/godowns', 'manager', () => db.prepare('SELECT * FROM godowns ORDER BY name').all());

// ---------- admin ----------
route('POST', '/api/admin/login', 'public', ({ body }) => {
  if (!timingSafeEq(body.password || '', ADMIN_PASSWORD)) throw new HttpError(401, 'Wrong password');
  return { token: newSession(null, 'admin', 1) };
});
route('GET', '/api/admin/summary', 'admin', () => {
  const day = istDay(Date.now());
  const present = db.prepare('SELECT COUNT(DISTINCT staff_id) c FROM attendance WHERE day=?').get(day).c;
  const total = db.prepare('SELECT COUNT(*) c FROM staff WHERE active=1').get().c;
  const r = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM receipts WHERE vdate=?").get(day);
  const pend = db.prepare("SELECT COUNT(*) c FROM receipts WHERE status='pending'").get().c;
  const failed = db.prepare("SELECT COUNT(*) c FROM receipts WHERE status='failed'").get().c;
  const lastBridge = Number(getSetting('bridge_seen', 0));
  return { day, present, total, receipts_today: r.n, amount_today: r.s, pending: pend, failed, bridge_last_seen: lastBridge || null, ledgers: db.prepare('SELECT COUNT(*) c FROM ledgers').get().c };
});

route('GET', '/api/admin/staff', 'admin', () => db.prepare('SELECT * FROM staff ORDER BY name').all().map(staffPublic));
function staffFields(body, creating) {
  const name = str(body.name, 80), mobile = cleanMobile(body.mobile);
  if (creating || body.name !== undefined) if (!name) throw bad('Name is required');
  if (creating || body.mobile !== undefined) if (!validMobile(mobile)) throw bad('Enter a valid 10-digit mobile number');
  if ((creating || body.pin) && !validPin(body.pin)) throw bad('PIN must be 4 to 6 digits');
  return { name, mobile };
}
route('POST', '/api/admin/staff', 'admin', ({ body }) => {
  const { name, mobile } = staffFields(body, true);
  if (db.prepare('SELECT 1 FROM staff WHERE mobile=?').get(mobile)) throw new HttpError(409, 'This mobile number already exists');
  const salt = rand(8);
  const info = db.prepare('INSERT INTO staff(name,mobile,pin_hash,pin_salt,role,can_receipt,created) VALUES(?,?,?,?,?,?,?)')
    .run(name, mobile, hashPin(body.pin, salt), salt, body.role === 'manager' ? 'manager' : 'staff', body.can_receipt === false ? 0 : 1, Date.now());
  return { id: Number(info.lastInsertRowid) };
});
route('PUT', '/api/admin/staff/:id', 'admin', ({ params, body }) => {
  const s = db.prepare('SELECT * FROM staff WHERE id=?').get(params.id); if (!s) throw new HttpError(404, 'Not found');
  const { name, mobile } = staffFields(body, false);
  if (body.mobile !== undefined && mobile !== s.mobile && db.prepare('SELECT 1 FROM staff WHERE mobile=?').get(mobile)) throw new HttpError(409, 'This mobile number already exists');
  const salt = body.pin ? rand(8) : s.pin_salt;
  db.prepare('UPDATE staff SET name=?,mobile=?,pin_hash=?,pin_salt=?,role=?,active=?,can_receipt=?,device_id=?,fails=0,locked_until=0 WHERE id=?').run(
    body.name !== undefined ? name : s.name, body.mobile !== undefined ? mobile : s.mobile, body.pin ? hashPin(body.pin, salt) : s.pin_hash, salt,
    body.role !== undefined ? (body.role === 'manager' ? 'manager' : 'staff') : s.role, body.active !== undefined ? (body.active ? 1 : 0) : s.active,
    body.can_receipt !== undefined ? (body.can_receipt ? 1 : 0) : s.can_receipt, body.reset_device ? null : s.device_id, s.id);
  if (body.pin || body.active === false || body.reset_device) db.prepare('DELETE FROM sessions WHERE staff_id=?').run(s.id);
  return { ok: true };
});

route('GET', '/api/admin/godowns', 'admin', () => db.prepare('SELECT * FROM godowns ORDER BY name').all());
function godownFields(b) {
  const name = str(b.name, 80); if (!name) throw bad('Godown name is required');
  const lat = num(b.lat), lng = num(b.lng);
  if ((b.lat !== '' && b.lat != null) || (b.lng !== '' && b.lng != null)) if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw bad('Latitude / longitude is not valid');
  const radius = Math.round(num(b.radius_m ?? 100)); if (!(radius >= 20 && radius <= 2000)) throw bad('Radius must be between 20 and 2000 m');
  return { name, lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null, radius };
}
route('POST', '/api/admin/godowns', 'admin', ({ body }) => {
  const g = godownFields(body);
  return { id: Number(db.prepare('INSERT INTO godowns(name,lat,lng,radius_m) VALUES(?,?,?,?)').run(g.name, g.lat, g.lng, g.radius).lastInsertRowid) };
});
route('PUT', '/api/admin/godowns/:id', 'admin', ({ params, body }) => {
  const g = godownFields(body);
  const r = db.prepare('UPDATE godowns SET name=?,lat=?,lng=?,radius_m=?,active=? WHERE id=?').run(g.name, g.lat, g.lng, g.radius, body.active === false ? 0 : 1, params.id);
  if (!r.changes) throw new HttpError(404, 'Not found'); return { ok: true };
});

function attendanceRows(q) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : istDay(Date.now()), to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : from;
  return db.prepare(`SELECT a.id,a.day,a.type,a.ts,s.name staff,s.mobile,g.name godown,a.distance_m,a.accuracy,a.lat,a.lng FROM attendance a
    JOIN staff s ON s.id=a.staff_id JOIN godowns g ON g.id=a.godown_id WHERE a.day BETWEEN ? AND ? ORDER BY a.day DESC, s.name, a.ts`).all(from, to);
}
const hhmm = (ts) => new Date(ts + IST).toISOString().slice(11, 16);
function dailySummary(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = r.day + '|' + r.mobile; const e = m.get(k) || { day: r.day, staff: r.staff, mobile: r.mobile, in_time: '', in_godown: '', out_time: '', out_godown: '', ms: 0, open: null };
    if (r.type === 'in') { if (!e.in_time) { e.in_time = hhmm(r.ts); e.in_godown = r.godown; } e.open = r.ts; }
    else { e.out_time = hhmm(r.ts); e.out_godown = r.godown; if (e.open) { e.ms += r.ts - e.open; e.open = null; } }
    m.set(k, e);
  }
  return [...m.values()].map((e) => ({ ...e, hours: Math.round(e.ms / 36000) / 100 }));
}
const csv = (rows, cols) => [cols.join(','), ...rows.map((r) => cols.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','))].join('\r\n');
route('GET', '/api/admin/attendance', 'admin', ({ query }) => { const rows = attendanceRows(query); return { punches: rows, days: dailySummary(rows) }; });
route('GET', '/api/admin/attendance.csv', 'admin', ({ query }) => ({ __csv: csv(dailySummary(attendanceRows(query)), ['day', 'staff', 'mobile', 'in_time', 'in_godown', 'out_time', 'out_godown', 'hours']), name: 'attendance.csv' }));

route('GET', '/api/admin/receipts', 'admin', ({ query }) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : '2000-01-01', to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : '2999-12-31';
  const st = ['pending', 'synced', 'failed'].includes(query.status) ? query.status : null;
  return db.prepare(`SELECT r.*, s.name staff FROM receipts r JOIN staff s ON s.id=r.staff_id WHERE r.vdate BETWEEN ? AND ? AND (? IS NULL OR r.status=?) ORDER BY r.id DESC LIMIT 500`).all(from, to, st, st);
});
route('GET', '/api/admin/receipts.csv', 'admin', ({ query }) => {
  const rows = db.prepare('SELECT r.id,r.vdate,s.name staff,r.party,r.amount,r.mode,r.bills,r.narration,r.status,r.voucher_no FROM receipts r JOIN staff s ON s.id=r.staff_id WHERE r.vdate BETWEEN ? AND ? ORDER BY r.id')
    .all(/^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : '2000-01-01', /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : '2999-12-31');
  return { __csv: csv(rows, ['id', 'vdate', 'staff', 'party', 'amount', 'mode', 'bills', 'narration', 'status', 'voucher_no']), name: 'receipts.csv' };
});
route('POST', '/api/admin/receipts/:id/retry', 'admin', ({ params }) => {
  const r = db.prepare("UPDATE receipts SET status='pending', error=NULL WHERE id=? AND status='failed'").run(params.id);
  return { ok: r.changes > 0 };
});
route('DELETE', '/api/admin/receipts/:id', 'admin', ({ params }) => {
  const r = db.prepare("DELETE FROM receipts WHERE id=? AND status IN ('pending','failed')").run(params.id);
  if (!r.changes) throw bad('Only pending or failed receipts can be deleted (synced ones are already in Tally).'); return { ok: true };
});

route('GET', '/api/admin/settings', 'admin', () => ({ mode_ledgers: modeLedgers(), webhook_url: getSetting('webhook_url'), bridge_key: BRIDGE_KEY, tally_company: getSetting('tally_company') }));
route('PUT', '/api/admin/settings', 'admin', ({ body }) => {
  if (body.mode_ledgers) { const m = {}; for (const k of Object.keys(DEFAULT_MODE_LEDGERS)) m[k] = str(body.mode_ledgers[k], 100) || DEFAULT_MODE_LEDGERS[k]; setSetting('mode_ledgers', JSON.stringify(m)); }
  if (body.webhook_url !== undefined) { const u = str(body.webhook_url, 300); if (u && !/^https?:\/\//.test(u)) throw bad('Webhook must start with http:// or https://'); setSetting('webhook_url', u); }
  if (body.tally_company !== undefined) setSetting('tally_company', str(body.tally_company, 120));
  return { ok: true };
});

// ---------- Tally bridge (runs on the PC where Tally is open) ----------
route('GET', '/api/bridge/pending', 'bridge', () => {
  setSetting('bridge_seen', Date.now());
  const rows = db.prepare("SELECT r.*, s.name staff FROM receipts r JOIN staff s ON s.id=r.staff_id WHERE r.status='pending' ORDER BY r.id LIMIT 25").all();
  return { receipts: rows.map((r) => ({ ...r, bills: JSON.parse(r.bills) })), mode_ledgers: modeLedgers(), company: getSetting('tally_company') };
});
route('POST', '/api/bridge/ack', 'bridge', ({ body }) => {
  const id = Number(body.id);
  if (body.ok) db.prepare("UPDATE receipts SET status='synced', error=NULL, voucher_no=?, synced_at=? WHERE id=?").run(str(body.voucher_no, 40) || null, Date.now(), id);
  else db.prepare("UPDATE receipts SET status='failed', error=? WHERE id=?").run(str(body.error, 500), id);
  return { ok: true };
});
route('POST', '/api/bridge/ledgers', 'bridge', ({ body }) => {
  const names = [...new Set((Array.isArray(body.names) ? body.names : []).map((n) => str(n, 120)).filter(Boolean))];
  if (!names.length) throw bad('No ledger names received');
  db.exec('BEGIN');
  try { db.exec('DELETE FROM ledgers'); const ins = db.prepare('INSERT INTO ledgers(name) VALUES(?)'); for (const n of names) ins.run(n); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  setSetting('bridge_seen', Date.now());
  return { ok: true, count: names.length };
});

// ---------- webhook (e.g. to feed another attendance tool) ----------
function sendWebhook(payload) {
  const url = getSetting('webhook_url'); if (!url) return;
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) }).catch((e) => console.warn('webhook failed:', e.message));
}

// ---------- server ----------
const ROLE_OK = { public: () => true, staff: (s) => s.role === 'staff' || s.role === 'manager', manager: (s) => s.role === 'manager', admin: (s) => s.role === 'admin' };
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 200000) { reject(new HttpError(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!n) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(bad('Invalid JSON')); } });
    req.on('error', reject);
  });
}
const SEC = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...SEC }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = url.pathname.replace(/\/+$/, '') || '/';
  try {
    res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'authorization,content-type,x-bridge-key'); res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (p === '/' || p === '/admin') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SEC }); return res.end(fs.readFileSync(path.join(__dirname, 'public', 'admin.html'))); }
    if (p === '/logo.png' && fs.existsSync(path.join(__dirname, 'public', 'logo.png'))) { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' }); return res.end(fs.readFileSync(path.join(__dirname, 'public', 'logo.png'))); }
    for (const r of routes) {
      if (r.method !== req.method) continue; const m = r.re.exec(p); if (!m) continue;
      let user = null;
      if (r.access === 'bridge') { if (!timingSafeEq(req.headers['x-bridge-key'] || '', BRIDGE_KEY)) throw new HttpError(401, 'Bad bridge key'); }
      else if (r.access !== 'public') {
        const s = sessionFrom(req); if (!s || !ROLE_OK[r.access](s)) throw new HttpError(401, 'Please log in again');
        user = { role: s.role };
        if (s.role !== 'admin') { const st = db.prepare('SELECT * FROM staff WHERE id=?').get(s.staff_id); if (!st || !st.active) throw new HttpError(401, 'Account disabled'); user.staff = st; }
      }
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const out = await r.handler({ req, res, body, params: { ...m.groups }, query: Object.fromEntries(url.searchParams), user });
      if (out && out.__csv !== undefined) { res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${out.name}"`, ...SEC }); return res.end('﻿' + out.__csv); }
      return send(res, 200, out ?? { ok: true });
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message, ...(e.extra || {}) });
    console.error(e); send(res, 500, { error: 'Server error' });
  }
});

if (require.main === module) {
  setInterval(() => db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now()), 3600000).unref();
  server.listen(PORT, () => console.log(`Ropo Staff server running on http://localhost:${PORT}  (admin panel: /admin)`));
}
module.exports = { server, db, haversine };
