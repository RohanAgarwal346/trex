/* Drishti AI — front-end (no build step, no dependencies) */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { } } };
let ST = null, page = '', timer = null, pendingCount = 0;

async function api(path, opt = {}) {
  const o = { ...opt, headers: { 'X-Requested-With': 'drishti', ...(opt.headers || {}) } };
  if (o.body && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); o.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(path, o);
  if (r.status === 401) { showLogin(); throw new Error('login'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || j.error || r.statusText);
  return j;
}
const tool = (n, a = {}) => api('/api/tool/' + n, { method: 'POST', body: a });
const ago = ts => { const s = Date.now() / 1000 - ts; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : new Date(ts * 1000).toLocaleDateString('en-US', { day: 'numeric', month: 'short' }); };
const clock = ts => new Date(ts * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
const EMO = { person: '🚶', car: '🚗', motorcycle: '🏍️', bus: '🚌', truck: '🚚', bicycle: '🚲', dog: '🐕', cat: '🐈', movement: '💨', camera: '📷' };

function toast(text, { img, level, ms = 6000 } = {}) {
  const t = document.createElement('div'); t.className = 'toast ' + (level || '');
  t.innerHTML = `${img ? `<img src="${esc(img)}">` : ''}<div style="flex:1">${esc(text)}</div><button class="btn sm" style="padding:4px 9px">✕</button>`;
  t.querySelector('button').onclick = () => t.remove(); $('#toasts').appendChild(t); setTimeout(() => t.remove(), ms);
}
function beep() { try { const c = new (window.AudioContext || window.webkitAudioContext)(), o = c.createOscillator(), g = c.createGain(); o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.value = .08; o.start(); setTimeout(() => { o.frequency.value = 660 }, 150); setTimeout(() => { o.stop(); c.close() }, 320); } catch { } }
function modal(html, wide) {
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="box ${wide ? 'wide' : ''}">${html}</div>`;
  m.addEventListener('mousedown', e => { if (e.target === m) m.remove(); });
  document.body.appendChild(m); return m;
}
function lightbox(m) {
  const isV = m.kind === 'clip' || /\.mp4/.test(m.url);
  const x = modal(isV ? `<video src="${esc(m.url)}" controls autoplay></video>` : `<img src="${esc(m.url)}">`);
  x.classList.add('lightbox'); $('.box', x).style.cssText = 'background:none;border:0;padding:0;box-shadow:none;width:auto;text-align:center';
  $('.box', x).insertAdjacentHTML('beforeend', `<div class="row" style="justify-content:center;margin-top:12px"><span class="hint">${esc(m.title || '')}</span><a class="btn sm c" href="${esc(m.url)}" download>⬇ Download</a></div>`);
}

/* ------------------------------------------------------------ navigation */
const NAV = [
  ['dashboard', '🏠', 'Dashboard', 'Overview & stats'], ['live', '📺', 'Live View', 'All cameras'], ['gallery', '🖼️', 'Gallery', 'Photos & videos'],
  ['events', '⏱️', 'Activity', 'Timeline & events'], ['cameras', '📷', 'Cameras', 'Add & manage'], ['rules', '⚡', 'Automations', 'Alerts & rules'],
  ['extensions', '🧩', 'Extensions', 'Add features with AI'], ['settings', '⚙️', 'Settings', 'AI, alerts, security'],
];
function renderNav() {
  const plug = (ST?.plugins || []).filter(p => p.has_panel);
  $('#nav').innerHTML = NAV.map(([id, ic, hi, en]) => `${id === 'extensions' ? '<div class="sep"></div>' : ''}<a data-p="${id}" class="${page === id ? 'on' : ''}"><div class="ic">${ic}</div><span class="t">${hi}<i>${en}</i></span>${id === 'extensions' && pendingCount ? `<span class="badge">${pendingCount}</span>` : ''}</a>`).join('')
    + (plug.length ? '<div class="sep"></div>' : '') + plug.map(p => `<a data-p="plugin/${esc(p.name)}" class="${page === 'plugin/' + p.name ? 'on' : ''}"><div class="ic">${esc(p.icon)}</div><span class="t">${esc(p.title)}<i>Extension</i></span></a>`).join('');
  $$('#nav a').forEach(a => a.onclick = () => { location.hash = a.dataset.p; $('#side').classList.remove('open'); });
}
function head(hi, en, extra = '') { return `<div class="top"><button class="menu-btn" onclick="$('#side').classList.toggle('open')">☰</button><h1>${hi}<small>${en}</small></h1><div class="sp"></div>${extra}</div>`; }
const PAGES = {};
async function route() {
  const p = location.hash.slice(1) || 'dashboard'; page = p; clearInterval(timer); timer = null; unmountLive();
  renderNav(); const m = $('#main'); m.scrollTop = 0;
  const key = p.split('/')[0];
  try { await (PAGES[key] || PAGES.dashboard)(m, p); } catch (e) { if (e.message !== 'login') m.innerHTML = `<div class="empty"><div class="big">😕</div>${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);

async function refresh() { ST = await api('/api/status'); if (ST.accent) document.documentElement.style.setProperty('--a1', ST.accent); sideFoot(); return ST; }
function sideFoot() {
  const on = ST.cameras.filter(c => c.online).length;
  $('#sidefoot').innerHTML = `<div><span class="dot ${on ? '' : 'off'}"></span><b>${on}/${ST.cameras.length}</b> cameras online</div><div style="margin-top:6px">💾 ${ST.system.app_storage_mb} MB · ${ST.system.disk_free_gb} GB free</div><div style="margin-top:6px">${ST.ai ? '✨ AI ON' : '⚠️ No AI key (see Settings)'}</div>`;
}

/* ------------------------------------------------------------ dashboard */
PAGES.dashboard = async m => {
  await refresh();
  const hr = new Date().getHours(), greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  m.innerHTML = head(`${greet} 👋`, new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' }), `<button class="btn p" id="askAI">✨ Ask the AI</button>`) + `<div class="grid g4" id="stats"></div>
  <div class="grid g2" style="margin-top:16px"><div class="card"><h3>📊 Today's traffic <small>unique people per hour</small></h3><div id="chart"></div></div>
  <div class="card"><h3>🔔 Latest activity <small><a href="#events">View all →</a></small></h3><div id="recent"></div></div></div>
  <div class="card" style="margin-top:16px"><h3>🗣️ Try saying <small>tap one to send it to the AI</small></h3><div class="chips" id="qk"></div></div>`;
  $('#askAI').onclick = () => openChat();
  const draw = () => {
    const s = ST, on = s.cameras.filter(c => c.online).length, tp = s.today_unique, ppl = tp.person || 0, veh = (tp.car || 0) + (tp.motorcycle || 0) + (tp.truck || 0) + (tp.bus || 0) + (tp.bicycle || 0);
    const stat = (cls, em, label, val) => `<div class="stat ${cls}"><small>${label}</small><b>${val}</b><span class="em">${em}</span></div>`;
    const w = (s.widgets || []).map(w => {
      if (w.type === 'snapshot') { const c = s.cameras.find(c => c.id === w.camera) || s.cameras[0]; return c ? `<div class="stat thumb"><img src="/api/cameras/${c.id}/frame.jpg?ann=1&t=${Date.now()}"><span>${esc(w.title)}</span><button class="x" data-w="${w.id}">✕</button></div>` : ''; }
      const cams = w.camera ? s.cameras.filter(c => c.id === w.camera) : s.cameras;
      const val = w.type === 'live_count' ? cams.reduce((a, c) => a + (c.counts[w.label] || 0), 0) : (tp[w.label] || 0);
      return `<div class="stat ${esc(w.color || 'violet')}"><small>${esc(w.title)}</small><b>${val}</b><span class="em">${EMO[w.label] || '✨'}</span><button class="x" data-w="${w.id}">✕</button></div>`;
    }).join('');
    $('#stats').innerHTML = stat('violet', '📷', 'Cameras online', `${on}<span style="font-size:20px;opacity:.7"> / ${s.cameras.length}</span>`) + stat('pink', '🚶', 'People now (live)', s.live_counts.person || 0) + stat('cyan', '👥', 'People today', ppl) + stat('orange', '🚗', 'Vehicles today', veh) + stat('green', '⚡', 'Events today', s.events_today) + w;
    $$('.stat .x').forEach(b => b.onclick = async () => { await tool('remove_dashboard_widget', { widget: b.dataset.w }); await refresh(); draw(); });
  };
  draw(); chart(); recent();
  $('#qk').innerHTML = ['Take a photo from every camera', 'How many people are there right now?', 'Video of the last 30 seconds', 'When was it busiest today?', 'Alert me if anyone appears at night', 'Add a vehicles card to the dashboard', 'Record on motion for all cameras'].map(t => `<span class="chip">${esc(t)}</span>`).join('');
  $$('#qk .chip').forEach(c => c.onclick = () => openChat(c.textContent, true));
  let tick = 0;
  timer = setInterval(async () => { await refresh(); draw(); recent(); if (++tick % 5 === 0) chart(); }, 4000);
};
async function chart() {
  const r = await api('/api/hourly'), mx = Math.max(1, ...r.hours.map(h => h.unique));
  $('#chart').innerHTML = `<div class="bars">${r.hours.map(h => `<div style="height:${Math.max(2, h.unique / mx * 100)}%" data-t="${h.hour}:00 → ${h.unique} people"></div>`).join('')}</div><div class="axis">${r.hours.map(h => `<span>${h.hour % 3 ? '' : h.hour}</span>`).join('')}</div><p class="hint" style="margin-top:10px"><b>${r.total_unique}</b> people today · busiest hour <b>${r.busiest_hour}:00</b></p>`;
}
async function recent() {
  const r = await api('/api/events?limit=6'); const el = $('#recent'); if (!el) return;
  el.innerHTML = r.events.length ? r.events.map(evRow).join('') : '<div class="empty">No activity yet</div>'; bindEv(el);
}
const EVC = { object: 'pink', motion: 'orange', line_cross: 'cyan', camera_offline: 'yellow', camera_online: 'green' };
function evRow(e) {
  const t = { object: `${e.label} detected`, motion: 'Movement', line_cross: `${e.label} crossed line · ${e.detail === 'in' ? 'IN ⬅' : 'OUT ➡'}`, camera_offline: 'Camera offline', camera_online: 'Camera online' }[e.type] || e.type;
  return `<div class="ev"><div class="em ${EVC[e.type] || 'violet'}">${EMO[e.label] || '🔔'}</div><div style="flex:1;min-width:0"><b>${esc(t)}</b><br><small>${esc(e.camera)} · ${clock(e.ts)} · ${ago(e.ts)}</small></div>${e.image ? `<img src="${esc(e.image)}" data-img="${esc(e.image)}">` : ''}</div>`;
}
const bindEv = el => $$('[data-img]', el).forEach(i => i.onclick = () => lightbox({ url: i.dataset.img, kind: 'snapshot' }));

/* ------------------------------------------------------------ live */
let liveImgs = [];
function unmountLive() { liveImgs.forEach(i => i.src = ''); liveImgs = []; }
PAGES.live = async m => {
  await refresh();
  const ann = LS.get('ann', 1);
  m.innerHTML = head('Live View', 'Boxes show AI detections', `<label class="row chip"><span class="sw"><input type="checkbox" id="ann" ${ann ? 'checked' : ''}><i></i></span> Detection boxes</label><button class="btn g" id="allsnap">📸 Photo of all</button>`) + `<div class="grid g3" id="tiles" style="grid-template-columns:repeat(auto-fit,minmax(${ST.cameras.length > 1 ? 420 : 760}px,1fr))"></div>`;
  const build = () => {
    $('#tiles').innerHTML = ST.cameras.map(c => `<div class="tile" data-c="${c.id}">${c.online ? `<img class="v" data-src="/api/cameras/${c.id}/mjpeg?ann=${$('#ann').checked ? 1 : 0}">` : `<div class="off"><div><div style="font-size:42px">📴</div>${c.enabled ? 'Offline — reconnecting…' : 'Disabled'}<br><small>${esc(c.error)}</small></div></div>`}
      <div class="bar"><span class="${c.online ? 'dot' : 'dot off'}"></span>${esc(c.name)}${c.recording ? '<span class="rec"></span><small>REC</small>' : ''}<span style="flex:1"></span>${Object.entries(c.counts).map(([k, v]) => `<span class="pill c">${EMO[k] || ''} ${v}</span>`).join('')}${c.motion ? '<span class="pill y">motion</span>' : ''}</div>
      <div class="acts"><button class="btn sm g" data-a="snap">📸 Photo</button><button class="btn sm o" data-a="clip">🎬 15s clip</button><button class="btn sm" data-a="full">⛶</button></div></div>`).join('') || '<div class="empty"><div class="big">📷</div>Add a camera first</div>';
    liveImgs = $$('#tiles img.v'); liveImgs.forEach(i => i.src = i.dataset.src);
    $$('#tiles .tile').forEach(t => t.onclick = async e => {
      const a = e.target.dataset.a, id = t.dataset.c; if (!a) return;
      if (a === 'full') return (t.requestFullscreen || t.webkitRequestFullscreen).call(t);
      e.target.disabled = true; const old = e.target.textContent; e.target.textContent = '…';
      try { const r = await tool(a === 'snap' ? 'take_snapshot' : 'get_video_clip', a === 'snap' ? { camera: id } : { camera: id, last_seconds: 15 }); if (r.ok) lightbox(r.media[0]); else toast(r.error); } finally { e.target.disabled = false; e.target.textContent = old; }
    });
  };
  build(); $('#ann').onchange = () => { LS.set('ann', $('#ann').checked ? 1 : 0); build(); };
  $('#allsnap').onclick = async () => { const r = await tool('take_snapshot', { camera: 'all' }); r.media?.forEach(lightbox); };
  timer = setInterval(async () => { const before = ST.cameras.map(c => c.online + '' + c.recording).join(); await refresh(); if (before !== ST.cameras.map(c => c.online + '' + c.recording).join()) build(); }, 5000);
};

/* ------------------------------------------------------------ gallery */
PAGES.gallery = async (m, p) => {
  let kind = LS.get('gk', ''), folder = LS.get('gf', '');
  const load = async () => {
    const r = await api(`/api/media?${kind ? 'kind=' + kind : ''}&${folder ? 'folder=' + encodeURIComponent(folder) : ''}`);
    $('#gfold').innerHTML = `<span class="chip ${!folder ? 'on' : ''}" data-f="">📁 All</span>` + r.folders.map(f => `<span class="chip ${folder === f.name ? 'on' : ''}" data-f="${esc(f.name)}" style="${folder === f.name ? '' : `border-color:${esc(f.color)}`}">📁 ${esc(f.name)} (${f.n})</span>`).join('') + `<span class="chip" id="newf">＋ New folder</span>`;
    $$('#gfold .chip[data-f]').forEach(c => c.onclick = () => { folder = c.dataset.f; LS.set('gf', folder); load(); });
    $('#newf').onclick = async () => { const n = prompt('Folder name?'); if (n) { await tool('create_folder', { name: n }); load(); } };
    $('#gitems').innerHTML = r.items.map(x => `<div class="media" data-id="${x.id}">${x.kind === 'clip' ? `<video src="${esc(x.url)}#t=0.5" preload="metadata" muted></video>` : x.kind === 'export' ? '<div class="empty big">📄</div>' : `<img loading="lazy" src="${esc(x.url)}">`}<span class="kind pill ${x.kind === 'clip' ? 'o' : 'v'}">${x.kind === 'clip' ? '🎬 Video' : x.kind === 'export' ? '📄 File' : '📸 Photo'}</span><div class="tools"><button class="btn sm" data-a="mv" title="Folder">📁</button><button class="btn sm d" data-a="del" title="Delete">🗑️</button></div><div class="cap">${esc(x.title)}${x.folder ? ` · 📁${esc(x.folder)}` : ''}</div></div>`).join('') || '<div class="empty"><div class="big">🖼️</div>Nothing here yet. Ask the AI: "take a photo of the gate"</div>';
    $$('#gitems .media').forEach(el => el.onclick = async e => {
      const it = r.items.find(i => i.id == el.dataset.id), a = e.target.dataset.a;
      if (a === 'del') { e.stopPropagation(); if (confirm('Delete this item?')) { await api('/api/media/' + it.id, { method: 'DELETE' }); load(); } return; }
      if (a === 'mv') { e.stopPropagation(); const n = prompt('Which folder? (type a new name to create one, empty = remove from folder)', it.folder || ''); if (n !== null) { await tool('save_to_folder', { media_id: it.id, folder: n }); load(); } return; }
      if (it.kind === 'export') return window.open(it.url); lightbox(it);
    });
  };
  m.innerHTML = head('Gallery', 'Photos, videos & folders', `<div class="chips">${[['', 'All'], ['snapshot', '📸 Photos'], ['clip', '🎬 Videos'], ['export', '📄 Files']].map(([k, l]) => `<span class="chip ${kind === k ? 'on' : ''}" data-k="${k}">${l}</span>`).join('')}</div>`) + `<div class="chips" id="gfold" style="margin-bottom:16px"></div><div class="grid g3" id="gitems"></div>`;
  $$('[data-k]').forEach(c => c.onclick = () => { kind = c.dataset.k; LS.set('gk', kind); PAGES.gallery(m, p); });
  load();
};

/* ------------------------------------------------------------ events */
PAGES.events = async m => {
  await refresh();
  const f = LS.get('evf', { camera: '', type: '', label: '', range: '-1d' });
  m.innerHTML = head('Activity Timeline', 'Everything your cameras saw', `<button class="btn c" id="csv">⬇ CSV export</button>`) + `<div class="card row" style="margin-bottom:16px">
    <select id="fc" style="width:auto"><option value="">All cameras</option>${ST.cameras.map(c => `<option value="${c.id}" ${f.camera == c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    <select id="ft" style="width:auto">${[['', 'All types'], ['object', 'Object detected'], ['motion', 'Movement'], ['line_cross', 'Line crossing'], ['camera_offline', 'Offline']].map(([v, l]) => `<option value="${v}" ${f.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <select id="fl" style="width:auto">${[['', 'Everything'], ['person', '🚶 People'], ['car', '🚗 Cars'], ['motorcycle', '🏍️ Bikes'], ['truck', '🚚 Trucks']].map(([v, l]) => `<option value="${v}" ${f.label === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <select id="fr" style="width:auto">${[['-1h', 'Last hour'], ['-1d', 'Last 24 hours'], ['-7d', 'Last 7 days'], ['-30d', 'Last 30 days']].map(([v, l]) => `<option value="${v}" ${f.range === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div id="evl"></div>`;
  const load = async () => {
    const f = { camera: $('#fc').value, type: $('#ft').value, label: $('#fl').value, range: $('#fr').value }; LS.set('evf', f);
    const qs = new URLSearchParams({ start: f.range, limit: 150 }); ['camera', 'type', 'label'].forEach(k => f[k] && qs.set(k, f[k]));
    const r = await api('/api/events?' + qs);
    $('#evl').innerHTML = r.events.length ? r.events.map(evRow).join('') : '<div class="empty"><div class="big">🕊️</div>Nothing found</div>'; bindEv($('#evl'));
  };
  ['fc', 'ft', 'fl', 'fr'].forEach(i => $('#' + i).onchange = load); load();
  $('#csv').onclick = async () => { const r = await tool('export_events_csv', { start: $('#fr').value }); if (r.ok) window.open(r.media[0].url); };
  timer = setInterval(load, 8000);
};

/* ------------------------------------------------------------ cameras */
const BRANDS = [['Hikvision', 'rtsp://USER:PASS@IP:554/Streaming/Channels/101'], ['Dahua / CP Plus / Godrej', 'rtsp://USER:PASS@IP:554/cam/realmonitor?channel=1&subtype=0'], ['TP-Link Tapo', 'rtsp://USER:PASS@IP:554/stream1'], ['Reolink', 'rtsp://USER:PASS@IP:554/h264Preview_01_main'], ['Ezviz / Imou', 'rtsp://admin:CODE@IP:554/H.264'], ['Generic ONVIF/NVR', 'rtsp://USER:PASS@IP:554/stream']];
PAGES.cameras = async m => {
  await refresh();
  m.innerHTML = head('Cameras', 'Add & manage cameras', `<button class="btn p" id="add">＋ Add camera</button>`) + `<div class="grid g3" id="cl"></div>`;
  $('#cl').innerHTML = ST.cameras.map(c => `<div class="card"><div class="row"><div class="em ${c.online ? 'green' : 'orange'}" >${c.kind === 'demo' ? '🧪' : '📷'}</div><div style="flex:1;min-width:0"><b>${esc(c.name)}</b><br><small class="hint">${esc(c.kind.toUpperCase())} · ${esc(c.source || 'built-in demo')}</small></div><span class="pill ${c.online ? 'g' : 'r'}">${c.online ? 'ONLINE' : 'OFFLINE'}</span></div>
    <div class="chips" style="margin:14px 0"><span class="pill v">${c.fps} fps</span><span class="pill ${c.cfg.rec_mode === 'off' ? '' : 'r'}">REC: ${c.cfg.rec_mode}</span><span class="pill c">${c.cfg.detect ? 'AI detect ON' : 'detect OFF'}</span>${c.cfg.zone ? '<span class="pill y">zone</span>' : ''}${c.cfg.line ? '<span class="pill y">count-line</span>' : ''}</div>
    ${c.error ? `<p class="hint" style="color:#fda4af">${esc(c.error)}</p>` : ''}<div class="row"><button class="btn sm g" data-a="snap" data-id="${c.id}">📸</button><button class="btn sm" data-a="edit" data-id="${c.id}">⚙️ Settings</button><button class="btn sm c" data-a="zone" data-id="${c.id}">✏️ Zone / Line</button></div></div>`).join('') || '<div class="empty"><div class="big">📷</div>No cameras yet</div>';
  $$('#cl [data-a]').forEach(b => b.onclick = async () => { const c = ST.cameras.find(c => c.id == b.dataset.id); if (b.dataset.a === 'snap') { const r = await tool('take_snapshot', { camera: String(c.id) }); r.media ? lightbox(r.media[0]) : toast(r.error); } else if (b.dataset.a === 'edit') editCam(c); else zoneEditor(c); });
  $('#add').onclick = addCam;
};
function addCam() {
  const x = modal(`<h2>＋ New camera</h2><p class="hint">IP cameras, NVR/DVR channels, a phone, a webcam or a video file all work.</p>
  <label class="f">Name</label><input id="cn" placeholder="Main Gate">
  <label class="f">Type</label><select id="ck"><option value="rtsp">📡 IP Camera / NVR (RTSP)</option><option value="url">🌐 HTTP / MJPEG / IP-Webcam app URL</option><option value="webcam">💻 USB / Laptop webcam</option><option value="file">🎞️ Video file (testing)</option><option value="demo">🧪 Demo camera</option></select>
  <div id="brandw"><label class="f">Brand template (tap one)</label><div class="chips">${BRANDS.map(([n, u]) => `<span class="chip" data-u="${esc(u)}">${esc(n)}</span>`).join('')}</div></div>
  <label class="f" id="srcl">URL / source</label><input id="cs" placeholder="rtsp://admin:pass@192.168.1.64:554/Streaming/Channels/101">
  <label class="f">Location (optional — lets you say \"the gate camera\")</label><input id="cloc" placeholder="gate, parking, shop, warehouse…">
  <p class="hint" id="ctr" style="margin-top:10px"></p>
  <div class="row" style="margin-top:16px"><button class="btn c" id="ct">🔍 Test</button><button class="btn p" id="cok">Save</button><button class="btn" onclick="this.closest('.modal').remove()">Cancel</button></div>`);
  $$('[data-u]', x).forEach(c => c.onclick = () => { $('#cs', x).value = c.dataset.u; });
  const upd = () => { const k = $('#ck', x).value; $('#brandw', x).hidden = k !== 'rtsp'; $('#cs', x).hidden = $('#srcl', x).hidden = k === 'demo'; $('#cs', x).placeholder = { webcam: '0', file: '/path/to/video.mp4', url: 'http://192.168.1.5:8080/video' }[k] || 'rtsp://…'; };
  $('#ck', x).onchange = upd; upd();
  const body = () => ({ name: $('#cn', x).value || 'Camera', kind: $('#ck', x).value, source: $('#cs', x).value.trim(), location: $('#cloc', x).value });
  $('#ct', x).onclick = async () => { $('#ctr', x).textContent = 'Testing…'; const r = await api('/api/cameras/test', { method: 'POST', body: body() }); $('#ctr', x).textContent = r.ok ? '✅ Connected' + (r.size ? ` (${r.size[0]}×${r.size[1]})` : '') : '❌ ' + r.error; };
  $('#cok', x).onclick = async () => { const r = await api('/api/cameras', { method: 'POST', body: body() }); if (r.ok) { x.remove(); toast('Camera added ✅'); PAGES.cameras($('#main')); } else $('#ctr', x).textContent = '❌ ' + r.error; };
}
function editCam(c) {
  const labs = ['person', 'car', 'motorcycle', 'bus', 'truck', 'bicycle', 'dog', 'cat'];
  const x = modal(`<h2>⚙️ ${esc(c.name)}</h2>
  <label class="f">Name</label><input id="en" value="${esc(c.name)}"><label class="f">Location</label><input id="el" value="${esc(c.cfg.location || '')}">
  ${c.kind !== 'demo' ? `<label class="f">Source URL (leave empty to keep)</label><input id="es" placeholder="${esc(c.source)}">` : ''}
  <label class="f">Recording</label><select id="er">${[['off', '⏹ Off'], ['motion', '🎯 Only on movement (saves storage)'], ['continuous', '🔴 24×7 continuous']].map(([v, l]) => `<option value="${v}" ${c.cfg.rec_mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
  <label class="f">Sensitivity: <span id="sv">${Math.round(c.cfg.sensitivity * 100)}%</span></label><input type="range" id="esn" min="0.1" max="0.95" step="0.05" value="${c.cfg.sensitivity}" oninput="$('#sv').textContent=Math.round(this.value*100)+'%'">
  <label class="f">What to detect and count</label><div class="chips">${labs.map(l => `<label class="chip"><input type="checkbox" class="el" value="${l}" ${c.cfg.labels.includes(l) ? 'checked' : ''} style="width:auto;margin-right:6px">${EMO[l]} ${l}</label>`).join('')}</div>
  <label class="row f" style="margin-top:14px"><span class="sw"><input type="checkbox" id="ed" ${c.cfg.detect ? 'checked' : ''}><i></i></span> AI detection ON</label>
  <label class="row f"><span class="sw"><input type="checkbox" id="ee" ${c.enabled ? 'checked' : ''}><i></i></span> Camera enabled</label>
  <div class="row" style="margin-top:18px"><button class="btn p" id="eok">Save</button><button class="btn d" id="edel">🗑️ Remove</button><button class="btn" onclick="this.closest('.modal').remove()">Cancel</button></div>`);
  $('#eok', x).onclick = async () => {
    await api('/api/cameras/' + c.id, { method: 'PUT', body: { name: $('#en', x).value, location: $('#el', x).value, source: $('#es', x)?.value || null, rec_mode: $('#er', x).value, sensitivity: +$('#esn', x).value, labels: $$('.el:checked', x).map(i => i.value), detect: $('#ed', x).checked, enabled: $('#ee', x).checked } });
    x.remove(); toast('Saved ✅'); PAGES.cameras($('#main'));
  };
  $('#edel', x).onclick = async () => { if (confirm(`Remove '${c.name}'?`)) { await api('/api/cameras/' + c.id, { method: 'DELETE' }); x.remove(); PAGES.cameras($('#main')); } };
}
function zoneEditor(c) {
  const x = modal(`<h2>✏️ Zone & Counting line</h2><p class="hint"><b>Zone</b>: only people and vehicles inside this area are counted. <b>Line</b>: anyone crossing it is counted as IN or OUT.</p>
  <div class="row" style="margin:10px 0"><button class="btn sm c" data-m="line">📏 Draw a line (2 clicks)</button><button class="btn sm o" data-m="zone">⬠ Draw a zone (click points)</button><button class="btn sm g" id="zdone">✔ Finish zone</button><button class="btn sm d" id="zclr">Clear</button></div>
  <canvas id="zc" style="width:100%;border-radius:14px;cursor:crosshair;background:#000"></canvas>
  <div class="row" style="margin-top:14px"><button class="btn p" id="zsave">Save</button><button class="btn" onclick="this.closest('.modal').remove()">Cancel</button></div>`, true);
  const cv = $('#zc', x), ctx = cv.getContext('2d'), img = new Image(); let mode = 'line', zone = c.cfg.zone ? [...c.cfg.zone] : [], line = c.cfg.line ? [...c.cfg.line] : [], tmp = [];
  img.onload = () => { cv.width = img.width; cv.height = img.height; draw(); }; img.src = `/api/cameras/${c.id}/frame.jpg?ann=0&t=${Date.now()}`;
  function draw() {
    const W = cv.width, H = cv.height; ctx.drawImage(img, 0, 0, W, H); ctx.lineWidth = Math.max(3, W / 300);
    const pts = zone.length ? zone : (mode === 'zone' ? tmp : []);
    if (pts.length) { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0] * W, p[1] * H) : ctx.moveTo(p[0] * W, p[1] * H)); if (zone.length) ctx.closePath(); ctx.fillStyle = 'rgba(251,146,60,.22)'; if (zone.length) ctx.fill(); ctx.strokeStyle = '#fb923c'; ctx.stroke(); pts.forEach(p => { ctx.fillStyle = '#fb923c'; ctx.beginPath(); ctx.arc(p[0] * W, p[1] * H, W / 150, 0, 7); ctx.fill(); }); }
    const L = line.length === 4 ? line : (tmp.length && mode === 'line' ? [tmp[0][0], tmp[0][1], tmp[0][0], tmp[0][1]] : null);
    if (L) { ctx.strokeStyle = '#22d3ee'; ctx.beginPath(); ctx.moveTo(L[0] * W, L[1] * H); ctx.lineTo(L[2] * W, L[3] * H); ctx.stroke(); }
  }
  cv.onclick = e => {
    const r = cv.getBoundingClientRect(), p = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
    if (mode === 'line') { tmp.push(p); if (tmp.length === 2) { line = [...tmp[0], ...tmp[1]]; tmp = []; } } else { zone = []; tmp.push(p); } draw();
  };
  $$('[data-m]', x).forEach(b => b.onclick = () => { mode = b.dataset.m; tmp = []; if (mode === 'line') line = []; else zone = []; draw(); });
  $('#zdone', x).onclick = () => { if (tmp.length >= 3) { zone = tmp; tmp = []; draw(); } else toast('A zone needs at least 3 points'); };
  $('#zclr', x).onclick = () => { zone = []; line = []; tmp = []; draw(); };
  $('#zsave', x).onclick = async () => { await api('/api/cameras/' + c.id, { method: 'PUT', body: { zone: zone.length >= 3 ? zone : null, line: line.length === 4 ? line : null } }); x.remove(); toast('Zone/Line saved ✅'); PAGES.cameras($('#main')); };
}

/* ------------------------------------------------------------ rules */
PAGES.rules = async m => {
  await refresh();
  const load = async () => {
    const r = await api('/api/rules'); const T = { object: '👀 Object appears', motion: '💨 Movement', line_cross: '📏 Line crossed', count_above: '👥 Crowd (count ≥)', offline: '📴 Camera offline' };
    $('#rl').innerHTML = r.rules.map(x => `<div class="card"><div class="row"><b style="flex:1">${esc(x.name)}</b><label class="sw"><input type="checkbox" ${x.enabled ? 'checked' : ''} data-t="${x.id}"><i></i></label></div>
      <div class="chips" style="margin:12px 0"><span class="pill v">${T[x.trigger] || x.trigger}</span>${x.label ? `<span class="pill c">${EMO[x.label] || ''} ${esc(x.label)}</span>` : ''}${x.min_count ? `<span class="pill y">≥ ${x.min_count}</span>` : ''}${x.between ? `<span class="pill o">🕒 ${esc(x.between.join(' → '))}</span>` : ''}<span class="pill">${x.camera ? 'cam ' + x.camera : 'all cameras'}</span></div>
      <div class="chips">${(x.actions || []).map(a => `<span class="pill g">${{ notify: '🔔 Notify', speak: '🗣️ Speak aloud', snapshot: '📸 Photo', clip: '🎬 Clip' }[a.type] || a.type}</span>`).join('')}</div><button class="btn sm d" style="margin-top:12px" data-d="${x.id}">Delete</button></div>`).join('') || '<div class="empty" style="grid-column:1/-1"><div class="big">⚡</div>No rules yet. Create one below or tell the AI: "alert me if anyone appears after 10 pm"</div>';
    $$('[data-t]').forEach(i => i.onchange = () => api('/api/rules/' + i.dataset.t, { method: 'PATCH', body: { enabled: i.checked } }));
    $$('[data-d]').forEach(b => b.onclick = async () => { await api('/api/rules/' + b.dataset.d, { method: 'PATCH', body: { delete: true } }); load(); });
  };
  m.innerHTML = head('Alerts & Automations', 'When X happens → do Y') + `<div class="grid g3" id="rl"></div><div class="card" style="margin-top:18px"><h3>＋ New rule</h3><div class="grid g4">
    <div><label class="f">Name</label><input id="rn" placeholder="Night alert"></div>
    <div><label class="f">When…</label><select id="rt"><option value="object">👀 An object appears</option><option value="motion">💨 There is movement</option><option value="line_cross">📏 A line is crossed</option><option value="count_above">👥 Crowd (count ≥)</option><option value="offline">📴 A camera goes offline</option></select></div>
    <div><label class="f">What</label><select id="rlb"><option value="person">🚶 Person</option><option value="car">🚗 Car</option><option value="motorcycle">🏍️ Bike</option><option value="truck">🚚 Truck</option><option value="">Anything</option></select></div>
    <div><label class="f">Count ≥ (for crowd)</label><input id="rc" type="number" value="5" min="1"></div>
    <div><label class="f">Camera</label><select id="rcam"><option value="">All cameras</option>${ST.cameras.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
    <div><label class="f">Only between (optional)</label><input id="rf" type="time"></div><div><label class="f">and</label><input id="rto" type="time"></div>
    <div><label class="f">Cooldown (seconds)</label><input id="rcd" type="number" value="60"></div></div>
    <label class="f">Then…</label><div class="chips">${[['notify', '🔔 Notify me', 1], ['speak', '🗣️ Speak aloud', 0], ['snapshot', '📸 Take a photo', 0], ['clip', '🎬 Record 10s video', 0]].map(([v, l, d]) => `<label class="chip"><input type="checkbox" class="ra" value="${v}" ${d ? 'checked' : ''} style="width:auto;margin-right:6px">${l}</label>`).join('')}</div>
    <button class="btn p" id="rok" style="margin-top:16px">Create rule</button></div>`;
  $('#rok').onclick = async () => {
    const f = $('#rf').value, t = $('#rto').value, a = $$('.ra:checked').map(i => ({ type: i.value, seconds: 10 }));
    const r = await api('/api/rules', { method: 'POST', body: { name: $('#rn').value || 'Rule', trigger: $('#rt').value, label: $('#rlb').value || null, min_count: +$('#rc').value, camera: $('#rcam').value || null, between: f && t ? [f, t] : null, cooldown: +$('#rcd').value, actions: a.length ? a : [{ type: 'notify' }] } });
    r.ok ? (toast(r.message), load()) : toast(r.error);
  };
  load();
};

/* ------------------------------------------------------------ extensions (AI studio) */
PAGES.extensions = async m => {
  const r = await api('/api/plugins'); pendingCount = r.plugins.filter(p => p.status === 'pending').length; renderNav();
  const pend = r.plugins.filter(p => p.status === 'pending'), act = r.plugins.filter(p => p.status === 'active');
  m.innerHTML = head('AI Extensions', 'Add new features just by asking') + `<div class="card" style="background:linear-gradient(135deg,rgba(139,92,246,.35),rgba(236,72,153,.25))"><h3>✨ What would you like to add?</h3><p class="hint" style="margin-bottom:12px">Say or type what you need. The AI will build the new feature (a page, report, alert logic, folder or dashboard card). Anything that involves code appears here first and waits for <b>your approval</b> — nothing runs until you approve it.</p>
    <div class="row"><input id="xi" placeholder="e.g. Build a page that lists every vehicle seen today" style="flex:1;min-width:240px"><button class="btn p" id="xg">🪄 Build it</button></div>
    <div class="chips" style="margin-top:12px">${['Build a visitor log page', 'Tell me when the shop first opened each day', 'Create a daily report of the busiest hour', 'Make a separate counter page for cars and bikes'].map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div></div>
    <h3 style="margin:24px 0 12px">⏳ Waiting for approval <span class="pill r">${pend.length}</span></h3><div id="pl">${pend.map(plugCard).join('') || '<p class="hint">Nothing pending.</p>'}</div>
    <h3 style="margin:24px 0 12px">✅ Active extensions <span class="pill g">${act.length}</span></h3><div class="grid g3">${act.map(plugCard).join('') || '<p class="hint">None yet.</p>'}</div>
    <div class="card" style="margin-top:24px"><h3>🛡️ Safety</h3><p class="hint">Extensions run on your server with full permissions, so read the code before approving. Only approve extensions you trust. Instant changes (rules, folders, dashboard cards, settings) need no code and no approval.</p></div>`;
  $('#xg').onclick = () => $('#xi').value && openChat('I want to add a new feature to the app: ' + $('#xi').value, true);
  $$('.chip', m).forEach(c => { if (!c.closest('#side')) c.onclick = () => openChat(c.textContent, true); });
  $$('[data-pa]', m).forEach(b => b.onclick = async () => {
    const [a, n] = b.dataset.pa.split(':');
    if (a === 'code') { const p = r.plugins.find(p => p.name === n); modal(`<h2>${esc(n)}</h2><p class="hint">${esc(p.description)}</p><div class="code">${esc(p.code || '')}</div>`, true); return; }
    if (a === 'remove' && !confirm('Remove this extension?')) return;
    try { await api(`/api/plugins/${n}/${a}`, { method: 'POST' }); toast(a === 'approve' ? 'Extension is now active 🎉' : 'Done'); await refresh(); PAGES.extensions(m); } catch (e) { toast('❌ ' + e.message); }
  });
};
const plugCard = p => `<div class="card" style="margin-bottom:12px"><div class="row"><div class="em violet" >${esc(p.icon || '🧩')}</div><div style="flex:1;min-width:0"><b>${esc(p.title || p.name)}</b><br><small class="hint">${esc(p.description)}</small></div></div>
  <div class="chips" style="margin:10px 0">${(p.tools || []).map(t => `<span class="pill c">🔧 ${esc(t)}</span>`).join('')}${p.has_panel ? '<span class="pill v">📄 page</span>' : ''}</div>
  <div class="row"><button class="btn sm" data-pa="code:${esc(p.name)}">👁 View code</button>${p.status === 'pending' ? `<button class="btn sm g" data-pa="approve:${esc(p.name)}">✔ Approve</button><button class="btn sm d" data-pa="reject:${esc(p.name)}">✕ Reject</button>` : `<button class="btn sm d" data-pa="remove:${esc(p.name)}">Remove</button>`}</div></div>`;
PAGES.plugin = async (m, p) => {
  const n = p.split('/')[1], pl = (ST.plugins || []).find(x => x.name === n);
  m.innerHTML = head(`${esc(pl?.icon || '🧩')} ${esc(pl?.title || n)}`, 'Extension page') + `<iframe class="panel" sandbox="allow-scripts" src="/api/plugins/${encodeURIComponent(n)}/panel"></iframe>`;
};

/* ------------------------------------------------------------ settings */
PAGES.settings = async m => {
  const s = await api('/api/settings'); await refresh();
  const sec = (t, body) => `<div class="card"><h3>${t}</h3>${body}</div>`;
  m.innerHTML = head('Settings', 'AI, alerts, security, storage', `<button class="btn p" id="ssave">💾 Save</button>`) + `<div class="grid g2">
  ${sec('✨ AI (Claude)', `<p class="hint">The voice/chat AI needs an Anthropic API key (console.anthropic.com). The key is stored only on your server.</p><label class="f">API key ${s.anthropic_key_set ? '<span class="pill g">saved</span>' : '<span class="pill r">missing</span>'}</label><input id="k" type="password" placeholder="sk-ant-… (leave empty to keep)"><label class="f">Model</label><input id="md" value="${esc(s.model)}">`)}
  ${sec('🔔 Notifications', `<label class="f">Telegram bot token ${s.telegram_token_set ? '<span class="pill g">saved</span>' : ''}</label><input id="tt" type="password" placeholder="123456:ABC…"><label class="f">Telegram chat id</label><input id="tc" value="${esc(s.telegram_chat || '')}"><label class="f">Webhook URL (Slack/Discord/Zapier/WhatsApp gateway)</label><input id="wh" value="${esc(s.webhook_url || '')}"><button class="btn sm c" id="tn" style="margin-top:12px">📨 Test alert</button>`)}
  ${sec('🎯 Detection & Storage', `<label class="f">Detector</label><select id="dt">${['auto', 'yolo', 'hog'].map(v => `<option ${s.detector === v ? 'selected' : ''}>${v}</option>`).join('')}</select><p class="hint">auto = YOLO (if you ran <code>pip install ultralytics</code>), otherwise OpenCV HOG (people only). Restart the app after changing.</p><label class="f">Processing FPS: <span id="fv">${s.target_fps}</span></label><input type="range" id="fp" min="3" max="25" value="${s.target_fps}" oninput="$('#fv').textContent=this.value"><label class="f">Keep recordings for (days)</label><input id="rd" type="number" value="${s.retention_days}"><label class="f">Pre-roll before motion (seconds)</label><input id="pr" type="number" value="${s.preroll_seconds}">`)}
  ${sec('🔐 Security & Look', `<p class="hint">Set a PIN so nobody can view your cameras without it. A PIN is required before exposing the app to the internet.</p><label class="f">App PIN ${s.pin_set ? '<span class="pill g">ON</span>' : '<span class="pill r">OFF</span>'}</label><input id="pn" type="password" inputmode="numeric" placeholder="new PIN (leave empty to keep)">${s.pin_set ? '<button class="btn sm d" id="pnx" style="margin-top:10px">Remove PIN</button>' : ''}${/DrishtiApp/.test(navigator.userAgent) ? '<a class="btn sm c" href="http://localhost/index.html?change=1" style="margin-top:14px">Change server</a>' : ''}<label class="f">Accent color</label><input type="color" id="ac" value="${ST.accent || '#8b5cf6'}" style="height:46px;padding:4px">`)}
  </div>`;
  $('#tn').onclick = async () => { await save(true); await tool('send_test_alert'); };
  async function save(quiet) {
    const b = { model: $('#md').value, telegram_chat: $('#tc').value, webhook_url: $('#wh').value, detector: $('#dt').value, target_fps: +$('#fp').value, retention_days: +$('#rd').value, preroll_seconds: +$('#pr').value, accent: $('#ac').value };
    [['k', 'anthropic_key'], ['tt', 'telegram_token'], ['pn', 'pin']].forEach(([i, k]) => $('#' + i).value && (b[k] = $('#' + i).value));
    await api('/api/settings', { method: 'PUT', body: b }); if (b.pin) { await api('/api/login', { method: 'POST', body: { pin: b.pin } }); } if (!quiet) { toast('Settings saved ✅'); PAGES.settings(m); }
  }
  $('#ssave').onclick = () => save(); $('#pnx')?.addEventListener('click', async () => { await api('/api/settings', { method: 'PUT', body: { clear_pin: true } }); PAGES.settings(m); });
};

/* ------------------------------------------------------------ AI chat + voice */
let hist = LS.get('chat', []), busy = false, speak = LS.get('tts', true), vlang = 'en-IN', rec = null, listening = false;
const QUICK = ['📸 Photo of all cameras', '👥 How many people now?', '🎬 Video of the last 30 seconds', '📊 Today\'s report', '➕ Add a new feature', '📁 Create an "Important" folder'];
function openChat(text, send) { $('#chat').classList.add('open'); $('#orb').style.display = 'none'; if (text) { $('#inp').value = text; send && sendMsg(); } else $('#inp').focus(); }
function closeChat() { $('#chat').classList.remove('open'); $('#orb').style.display = ''; stopListen(); speechSynthesis?.cancel(); }
function renderMsgs() {
  const box = $('#msgs');
  box.innerHTML = hist.length ? hist.map(msgHTML).join('') : `<div class="m a">Hi! 👋 I'm <b>Drishti AI</b>.<br>Try saying:<br>• "Take a photo of the gate"<br>• "Give me the last 1 minute of video"<br>• "How many people came yesterday between 9 and 10 am?"<br>• "Alert me if anyone appears at night"<br>• "Add a new report page to the app"<br><br>🎤 Tap the mic and speak, or type below.</div>`;
  box.scrollTop = box.scrollHeight; bindMsgs();
}
function msgHTML(m) {
  const att = (m.media || []).map(x => x.kind === 'clip' ? `<video src="${esc(x.url)}" controls playsinline></video>` : x.kind === 'export' ? `<a class="btn sm c" href="${esc(x.url)}" target="_blank">⬇ ${esc(x.title)}</a>` : `<img src="${esc(x.url)}" data-lb="${esc(x.url)}" alt="">`).join('');
  const acts = (m.actions || []).map(a => `<span class="${a.ok ? '' : 'bad'}">${a.ok ? '✓' : '✕'} ${esc(a.tool)}</span>`).join('');
  const pend = (m.pending || []).map(n => `<div class="acts"><button class="btn sm g" data-ap="${esc(n)}">✔ Approve '${esc(n)}'</button><button class="btn sm" data-vc="${esc(n)}">👁 Code</button><button class="btn sm d" data-rj="${esc(n)}">✕</button></div>`).join('');
  return `<div class="m ${m.role === 'user' ? 'u' : 'a'}">${esc(m.content)}${att ? `<div class="att">${att}</div>` : ''}${acts ? `<div class="acts">${acts}</div>` : ''}${pend}</div>`;
}
function bindMsgs() {
  $$('#msgs [data-lb]').forEach(i => i.onclick = () => lightbox({ url: i.dataset.lb, kind: 'snapshot' }));
  $$('#msgs [data-ap]').forEach(b => b.onclick = async () => { try { await api(`/api/plugins/${b.dataset.ap}/approve`, { method: 'POST' }); b.parentElement.innerHTML = '<span>✓ Now active 🎉</span>'; await refresh(); renderNav(); } catch (e) { toast('❌ ' + e.message); } });
  $$('#msgs [data-rj]').forEach(b => b.onclick = async () => { await api(`/api/plugins/${b.dataset.rj}/reject`, { method: 'POST' }); b.parentElement.innerHTML = '<span>Rejected</span>'; });
  $$('#msgs [data-vc]').forEach(b => b.onclick = async () => { const r = await api('/api/plugins'), p = r.plugins.find(p => p.name === b.dataset.vc); p && modal(`<h2>${esc(p.name)}</h2><p class="hint">${esc(p.description)}</p><div class="code">${esc(p.code || '')}</div><p class="hint" style="margin-top:10px">⚠️ Read the code before approving it.</p>`, true); });
}
async function sendMsg() {
  const t = $('#inp').value.trim(); if (!t || busy) return; $('#inp').value = ''; stopListen(); speechSynthesis?.cancel();
  hist.push({ role: 'user', content: t }); renderMsgs(); busy = true;
  $('#msgs').insertAdjacentHTML('beforeend', '<div class="m a typing" id="typ"><i></i><i></i><i></i></div>'); $('#msgs').scrollTop = 1e9; $('#aistate').textContent = 'Thinking…';
  try {
    const r = await api('/api/chat', { method: 'POST', body: { messages: hist.slice(-14).map(m => ({ role: m.role, content: m.content })), lang: vlang } });
    hist.push({ role: 'assistant', content: r.reply, media: r.media, actions: r.actions, pending: r.pending });
    if ((r.pending || []).length) { pendingCount += r.pending.length; renderNav(); }
    if (r.actions?.some(a => /widget|plugin|camera|rule|folder|setting/.test(a.tool))) refresh().then(renderNav);
    if (speak) say(r.reply);
  } catch (e) { hist.push({ role: 'assistant', content: '❌ ' + e.message }); }
  busy = false; $('#aistate').textContent = 'Speak or type'; LS.set('chat', hist.slice(-30).map(m => ({ ...m, media: (m.media || []).slice(0, 4) }))); renderMsgs();
}
function say(t) {
  if (!('speechSynthesis' in window)) return; const u = new SpeechSynthesisUtterance(t.replace(/[\u{1F300}-\u{1FAFF}☀-➿]/gu, '')); u.lang = 'en-IN'; u.rate = 1.02;
  const v = speechSynthesis.getVoices().find(v => v.lang === u.lang); if (v) u.voice = v; speechSynthesis.speak(u);
}
const SHELL = /Electron|DrishtiApp/.test(navigator.userAgent);   // desktop / Android wrappers have no browser speech engine
let recorder = null;
function startListen() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || SHELL) return startRecording();
  speechSynthesis?.cancel(); rec = new SR(); rec.lang = vlang; rec.interimResults = true; rec.continuous = false;
  rec.onresult = e => { let s = ''; for (const r of e.results) s += r[0].transcript; $('#inp').value = s; if (e.results[e.results.length - 1].isFinal) { stopListen(); sendMsg(); } };
  rec.onerror = e => { stopListen(); if (e.error === 'not-allowed') toast('Please allow microphone access (HTTPS or localhost required).', { level: 'warn' }); else if (e.error === 'network' || e.error === 'service-not-allowed') startRecording(); };
  rec.onend = () => { if (listening && !recorder) stopListen(); }; rec.start(); listening = true; $('#mic').classList.add('rec'); $('#aistate').textContent = '🎤 Listening…';
}
// Fallback: record audio in the page and transcribe on the server (offline Whisper, English).
async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('This device cannot record audio. Type your request instead (the keyboard microphone also works).', { level: 'warn' });
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast('Please allow microphone access, or type your request.', { level: 'warn' }); }
  speechSynthesis?.cancel(); const chunks = [], mr = new MediaRecorder(stream), ctx = new (window.AudioContext || window.webkitAudioContext)(), an = ctx.createAnalyser();
  ctx.createMediaStreamSource(stream).connect(an); const buf = new Uint8Array(an.fftSize); let last = Date.now(), heard = false, t0 = Date.now();
  const tick = setInterval(() => { an.getByteTimeDomainData(buf); const lvl = Math.max(...buf.map(v => Math.abs(v - 128))); if (lvl > 14) { heard = true; last = Date.now(); } if ((heard && Date.now() - last > 1300) || Date.now() - t0 > 15000) stopListen(); }, 120);
  mr.ondataavailable = e => chunks.push(e.data);
  mr.onstop = async () => {
    clearInterval(tick); stream.getTracks().forEach(t => t.stop()); ctx.close(); recorder = null; if (!heard) return;
    $('#aistate').textContent = 'Transcribing…';
    try { const r = await fetch('/api/transcribe', { method: 'POST', headers: { 'X-Requested-With': 'drishti' }, body: new Blob(chunks, { type: mr.mimeType }) }); const j = await r.json(); if (!r.ok) throw new Error(j.detail || 'failed'); if (j.text) { $('#inp').value = j.text; sendMsg(); } else toast("Didn't catch that — try again."); }
    catch (e) { toast('Voice: ' + e.message, { level: 'warn' }); }
    $('#aistate').textContent = 'Speak or type';
  };
  recorder = mr; mr.start(); listening = true; $('#mic').classList.add('rec'); $('#aistate').textContent = '🎤 Listening…';
}
function stopListen() { try { rec?.stop(); } catch { } try { if (recorder?.state === 'recording') recorder.stop(); } catch { } listening = false; $('#mic')?.classList.remove('rec'); if (!busy && !recorder) $('#aistate').textContent = 'Speak or type'; }
function initChat() {
  $('#chips').innerHTML = QUICK.map(q => `<span class="chip">${esc(q)}</span>`).join(''); $$('#chips .chip').forEach(c => c.onclick = () => { $('#inp').value = c.textContent.replace(/^\S+\s/, '').replace(/"/g, ''); sendMsg(); });
  $('#orb').onclick = () => openChat(); $('#close').onclick = closeChat; $('#send').onclick = sendMsg; $('#inp').onkeydown = e => e.key === 'Enter' && sendMsg();
  $('#mic').onclick = () => listening ? stopListen() : startListen();
  $('#clear').onclick = () => { hist = []; LS.set('chat', []); renderMsgs(); };
  const sl = () => { $('#tts').textContent = speak ? '🔊' : '🔇'; };
  $('#tts').onclick = () => { speak = !speak; LS.set('tts', speak); sl(); if (!speak) speechSynthesis?.cancel(); };
  sl(); renderMsgs();
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('.modal')?.remove(); } if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); openChat(); } });
}

/* ------------------------------------------------------------ live push */
function connectSSE() {
  const es = new EventSource('/api/stream');
  es.addEventListener('alert', e => { const d = JSON.parse(e.data); toast(d.text, { img: d.image, level: 'warn', ms: 12000 }); beep(); if (d.speak) say(d.text.replace(/^🔔\s*/, '')); try { if (Notification.permission === 'granted') new Notification('Drishti AI', { body: d.text, icon: d.image || undefined }); } catch { } });
  es.addEventListener('plugin_pending', e => { pendingCount++; renderNav(); toast('🧩 A new extension is waiting for your approval'); });
  es.addEventListener('cctv', e => { const d = JSON.parse(e.data); if (page === 'dashboard') recent(); if (d.type === 'camera_offline') toast('📴 ' + d.camera + ' went offline', { level: 'warn' }); });
}

/* ------------------------------------------------------------ boot */
function showLogin() {
  $('#login').hidden = false; const go = async () => { try { await api('/api/login', { method: 'POST', body: { pin: $('#pin').value } }); location.reload(); } catch (e) { $('#pinErr').textContent = 'Wrong PIN'; } };
  $('#pinGo').onclick = go; $('#pin').onkeydown = e => e.key === 'Enter' && go(); $('#pin').focus();
}
(async () => {
  const a = await fetch('/api/auth').then(r => r.json());
  if (a.pin_required && !a.ok) return showLogin();
  initChat(); await refresh().catch(() => { }); connectSSE();
  try { if ('Notification' in window && Notification.permission === 'default') setTimeout(() => Notification.requestPermission(), 4000); } catch { }
  api('/api/plugins').then(r => { pendingCount = r.plugins.filter(p => p.status === 'pending').length; renderNav(); }).catch(() => { });
  route();
})();
