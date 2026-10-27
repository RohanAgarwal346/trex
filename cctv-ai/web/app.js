/* दृष्टि AI — front-end (no build step, no dependencies) */
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
const ago = ts => { const s = Date.now() / 1000 - ts; return s < 60 ? 'abhi' : s < 3600 ? Math.floor(s / 60) + ' min pehle' : s < 86400 ? Math.floor(s / 3600) + ' ghante pehle' : new Date(ts * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); };
const clock = ts => new Date(ts * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
const EMO = { person: '🚶', car: '🚗', motorcycle: '🏍️', bus: '🚌', truck: '🚚', bicycle: '🚲', dog: '🐕', cat: '🐈', movement: '💨', camera: '📷' };
const LBL = { person: 'लोग · People', car: 'कार · Cars', motorcycle: 'बाइक · Bikes', truck: 'ट्रक · Trucks', bus: 'बस · Bus', bicycle: 'साइकिल', dog: 'कुत्ते', cat: 'बिल्ली' };

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
  ['dashboard', '🏠', 'डैशबोर्ड', 'Dashboard'], ['live', '📺', 'लाइव कैमरा', 'Live View'], ['gallery', '🖼️', 'फोटो / वीडियो', 'Gallery'],
  ['events', '⏱️', 'गतिविधि', 'Timeline & Events'], ['cameras', '📷', 'कैमरे', 'Cameras'], ['rules', '⚡', 'ऑटोमेशन', 'Alerts & Rules'],
  ['extensions', '🧩', 'एक्सटेंशन', 'AI Extensions'], ['settings', '⚙️', 'सेटिंग्स', 'Settings'],
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
  $('#sidefoot').innerHTML = `<div><span class="dot ${on ? '' : 'off'}"></span><b>${on}/${ST.cameras.length}</b> camera online</div><div style="margin-top:6px">💾 ${ST.system.app_storage_mb} MB · ${ST.system.disk_free_gb} GB free</div><div style="margin-top:6px">${ST.ai ? '✨ AI ON' : '⚠️ AI key nahi (Settings)'}</div>`;
}

/* ------------------------------------------------------------ dashboard */
PAGES.dashboard = async m => {
  await refresh();
  const hr = new Date().getHours(), greet = hr < 12 ? 'सुप्रभात' : hr < 17 ? 'नमस्ते' : 'शुभ संध्या';
  m.innerHTML = head(`${greet} 👋`, new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }), `<button class="btn p" id="askAI">✨ AI se pucho</button>`) + `<div class="grid g4" id="stats"></div>
  <div class="grid g2" style="margin-top:16px"><div class="card"><h3>📊 आज का ट्रैफिक <small>unique people / घंटा</small></h3><div id="chart"></div></div>
  <div class="card"><h3>🔔 ताज़ा गतिविधि <small><a href="#events">sab dekho →</a></small></h3><div id="recent"></div></div></div>
  <div class="card" style="margin-top:16px"><h3>🗣️ बोलकर देखो <small>tap karke AI ko bhejo</small></h3><div class="chips" id="qk"></div></div>`;
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
    $('#stats').innerHTML = stat('violet', '📷', 'कैमरे ऑनलाइन', `${on}<span style="font-size:20px;opacity:.7"> / ${s.cameras.length}</span>`) + stat('pink', '🚶', 'अभी लोग (live)', s.live_counts.person || 0) + stat('cyan', '👥', 'आज कुल लोग', ppl) + stat('orange', '🚗', 'आज कुल वाहन', veh) + stat('green', '⚡', 'आज की गतिविधियाँ', s.events_today) + w;
    $$('.stat .x').forEach(b => b.onclick = async () => { await tool('remove_dashboard_widget', { widget: b.dataset.w }); await refresh(); draw(); });
  };
  draw(); chart(); recent();
  $('#qk').innerHTML = ['सब कैमरों का फोटो दो', 'अभी कितने लोग हैं?', 'पिछले 30 सेकंड की वीडियो', 'आज सबसे ज्यादा भीड़ कब थी?', 'अगर रात में कोई आए तो अलर्ट दो', 'डैशबोर्ड पर गाड़ियों का कार्ड जोड़ो', 'Record on motion for all cameras'].map(t => `<span class="chip">${esc(t)}</span>`).join('');
  $$('#qk .chip').forEach(c => c.onclick = () => openChat(c.textContent, true));
  timer = setInterval(async () => { await refresh(); draw(); recent(); }, 4000);
};
async function chart() {
  const r = await api('/api/hourly'), mx = Math.max(1, ...r.hours.map(h => h.unique));
  $('#chart').innerHTML = `<div class="bars">${r.hours.map(h => `<div style="height:${Math.max(2, h.unique / mx * 100)}%" data-t="${h.hour}:00 → ${h.unique} log"></div>`).join('')}</div><div class="axis">${r.hours.map(h => `<span>${h.hour % 3 ? '' : h.hour}</span>`).join('')}</div><p class="hint" style="margin-top:10px">Aaj kul <b>${r.total_unique}</b> log · sabse busy ghanta <b>${r.busiest_hour}:00</b></p>`;
}
async function recent() {
  const r = await api('/api/events?limit=6'); const el = $('#recent'); if (!el) return;
  el.innerHTML = r.events.length ? r.events.map(evRow).join('') : '<div class="empty">Abhi koi activity nahi</div>'; bindEv(el);
}
const EVC = { object: 'pink', motion: 'orange', line_cross: 'cyan', camera_offline: 'yellow', camera_online: 'green' };
function evRow(e) {
  const t = { object: `${e.label} dikha`, motion: 'Movement', line_cross: `${e.label} line cross · ${e.detail === 'in' ? 'अंदर ⬅' : 'बाहर ➡'}`, camera_offline: 'Camera offline', camera_online: 'Camera online' }[e.type] || e.type;
  return `<div class="ev"><div class="em ${EVC[e.type] || 'violet'}">${EMO[e.label] || '🔔'}</div><div style="flex:1;min-width:0"><b>${esc(t)}</b><br><small>${esc(e.camera)} · ${clock(e.ts)} · ${ago(e.ts)}</small></div>${e.image ? `<img src="${esc(e.image)}" data-img="${esc(e.image)}">` : ''}</div>`;
}
const bindEv = el => $$('[data-img]', el).forEach(i => i.onclick = () => lightbox({ url: i.dataset.img, kind: 'snapshot' }));

/* ------------------------------------------------------------ live */
let liveImgs = [];
function unmountLive() { liveImgs.forEach(i => i.src = ''); liveImgs = []; }
PAGES.live = async m => {
  await refresh();
  const ann = LS.get('ann', 1);
  m.innerHTML = head('लाइव कैमरा', 'Live view · boxes = AI detection', `<label class="row chip"><span class="sw"><input type="checkbox" id="ann" ${ann ? 'checked' : ''}><i></i></span> Detection boxes</label><button class="btn g" id="allsnap">📸 सबका फोटो</button>`) + `<div class="grid g3" id="tiles" style="grid-template-columns:repeat(auto-fit,minmax(${ST.cameras.length > 1 ? 420 : 760}px,1fr))"></div>`;
  const build = () => {
    $('#tiles').innerHTML = ST.cameras.map(c => `<div class="tile" data-c="${c.id}">${c.online ? `<img class="v" data-src="/api/cameras/${c.id}/mjpeg?ann=${$('#ann').checked ? 1 : 0}">` : `<div class="off"><div><div style="font-size:42px">📴</div>${c.enabled ? 'Offline — reconnecting…' : 'Disabled'}<br><small>${esc(c.error)}</small></div></div>`}
      <div class="bar"><span class="${c.online ? 'dot' : 'dot off'}"></span>${esc(c.name)}${c.recording ? '<span class="rec"></span><small>REC</small>' : ''}<span style="flex:1"></span>${Object.entries(c.counts).map(([k, v]) => `<span class="pill c">${EMO[k] || ''} ${v}</span>`).join('')}${c.motion ? '<span class="pill y">motion</span>' : ''}</div>
      <div class="acts"><button class="btn sm g" data-a="snap">📸 Photo</button><button class="btn sm o" data-a="clip">🎬 15s clip</button><button class="btn sm" data-a="full">⛶</button></div></div>`).join('') || '<div class="empty"><div class="big">📷</div>Pehle camera jodiye</div>';
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
    $('#gfold').innerHTML = `<span class="chip ${!folder ? 'on' : ''}" data-f="">📁 Sab</span>` + r.folders.map(f => `<span class="chip ${folder === f.name ? 'on' : ''}" data-f="${esc(f.name)}" style="${folder === f.name ? '' : `border-color:${esc(f.color)}`}">📁 ${esc(f.name)} (${f.n})</span>`).join('') + `<span class="chip" id="newf">＋ Naya folder</span>`;
    $$('#gfold .chip[data-f]').forEach(c => c.onclick = () => { folder = c.dataset.f; LS.set('gf', folder); load(); });
    $('#newf').onclick = async () => { const n = prompt('Folder ka naam?'); if (n) { await tool('create_folder', { name: n }); load(); } };
    $('#gitems').innerHTML = r.items.map(x => `<div class="media" data-id="${x.id}">${x.kind === 'clip' ? `<video src="${esc(x.url)}#t=0.5" preload="metadata" muted></video>` : x.kind === 'export' ? '<div class="empty big">📄</div>' : `<img loading="lazy" src="${esc(x.url)}">`}<span class="kind pill ${x.kind === 'clip' ? 'o' : 'v'}">${x.kind === 'clip' ? '🎬 Video' : x.kind === 'export' ? '📄 File' : '📸 Photo'}</span><div class="tools"><button class="btn sm" data-a="mv" title="Folder">📁</button><button class="btn sm d" data-a="del" title="Delete">🗑️</button></div><div class="cap">${esc(x.title)}${x.folder ? ` · 📁${esc(x.folder)}` : ''}</div></div>`).join('') || '<div class="empty"><div class="big">🖼️</div>Abhi kuch nahi. AI se bolo: "gate ka photo do"</div>';
    $$('#gitems .media').forEach(el => el.onclick = async e => {
      const it = r.items.find(i => i.id == el.dataset.id), a = e.target.dataset.a;
      if (a === 'del') { e.stopPropagation(); if (confirm('Delete karein?')) { await api('/api/media/' + it.id, { method: 'DELETE' }); load(); } return; }
      if (a === 'mv') { e.stopPropagation(); const n = prompt('Kis folder mein? (naya naam bhi likh sakte hain, khali = hatao)', it.folder || ''); if (n !== null) { await tool('save_to_folder', { media_id: it.id, folder: n }); load(); } return; }
      if (it.kind === 'export') return window.open(it.url); lightbox(it);
    });
  };
  m.innerHTML = head('फोटो और वीडियो', 'Snapshots, clips & folders', `<div class="chips">${[['', 'Sab'], ['snapshot', '📸 Photos'], ['clip', '🎬 Videos'], ['export', '📄 Files']].map(([k, l]) => `<span class="chip ${kind === k ? 'on' : ''}" data-k="${k}">${l}</span>`).join('')}</div>`) + `<div class="chips" id="gfold" style="margin-bottom:16px"></div><div class="grid g3" id="gitems"></div>`;
  $$('[data-k]').forEach(c => c.onclick = () => { kind = c.dataset.k; LS.set('gk', kind); PAGES.gallery(m, p); });
  load();
};

/* ------------------------------------------------------------ events */
PAGES.events = async m => {
  await refresh();
  const f = LS.get('evf', { camera: '', type: '', label: '', range: '-1d' });
  m.innerHTML = head('गतिविधि टाइमलाइन', 'Everything your cameras saw', `<button class="btn c" id="csv">⬇ CSV export</button>`) + `<div class="card row" style="margin-bottom:16px">
    <select id="fc" style="width:auto"><option value="">Sab camera</option>${ST.cameras.map(c => `<option value="${c.id}" ${f.camera == c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    <select id="ft" style="width:auto">${[['', 'Sab type'], ['object', 'Object dikha'], ['motion', 'Movement'], ['line_cross', 'Line cross'], ['camera_offline', 'Offline']].map(([v, l]) => `<option value="${v}" ${f.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <select id="fl" style="width:auto">${[['', 'Sab cheezein'], ['person', '🚶 Log'], ['car', '🚗 Car'], ['motorcycle', '🏍️ Bike'], ['truck', '🚚 Truck']].map(([v, l]) => `<option value="${v}" ${f.label === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <select id="fr" style="width:auto">${[['-1h', 'Pichhla 1 ghanta'], ['-1d', 'Pichhle 24 ghante'], ['-7d', 'Pichhle 7 din'], ['-30d', '30 din']].map(([v, l]) => `<option value="${v}" ${f.range === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div id="evl"></div>`;
  const load = async () => {
    const f = { camera: $('#fc').value, type: $('#ft').value, label: $('#fl').value, range: $('#fr').value }; LS.set('evf', f);
    const qs = new URLSearchParams({ start: f.range, limit: 150 }); ['camera', 'type', 'label'].forEach(k => f[k] && qs.set(k, f[k]));
    const r = await api('/api/events?' + qs);
    $('#evl').innerHTML = r.events.length ? r.events.map(evRow).join('') : '<div class="empty"><div class="big">🕊️</div>Kuch nahi mila</div>'; bindEv($('#evl'));
  };
  ['fc', 'ft', 'fl', 'fr'].forEach(i => $('#' + i).onchange = load); load();
  $('#csv').onclick = async () => { const r = await tool('export_events_csv', { start: $('#fr').value }); if (r.ok) window.open(r.media[0].url); };
  timer = setInterval(load, 8000);
};

/* ------------------------------------------------------------ cameras */
const BRANDS = [['Hikvision', 'rtsp://USER:PASS@IP:554/Streaming/Channels/101'], ['Dahua / CP Plus / Godrej', 'rtsp://USER:PASS@IP:554/cam/realmonitor?channel=1&subtype=0'], ['TP-Link Tapo', 'rtsp://USER:PASS@IP:554/stream1'], ['Reolink', 'rtsp://USER:PASS@IP:554/h264Preview_01_main'], ['Ezviz / Imou', 'rtsp://admin:CODE@IP:554/H.264'], ['Generic ONVIF/NVR', 'rtsp://USER:PASS@IP:554/stream']];
PAGES.cameras = async m => {
  await refresh();
  m.innerHTML = head('कैमरे', 'Add & manage cameras', `<button class="btn p" id="add">＋ Camera jodo</button>`) + `<div class="grid g3" id="cl"></div>`;
  $('#cl').innerHTML = ST.cameras.map(c => `<div class="card"><div class="row"><div class="em ${c.online ? 'green' : 'orange'}" >${c.kind === 'demo' ? '🧪' : '📷'}</div><div style="flex:1;min-width:0"><b>${esc(c.name)}</b><br><small class="hint">${esc(c.kind.toUpperCase())} · ${esc(c.source || 'built-in demo')}</small></div><span class="pill ${c.online ? 'g' : 'r'}">${c.online ? 'ONLINE' : 'OFFLINE'}</span></div>
    <div class="chips" style="margin:14px 0"><span class="pill v">${c.fps} fps</span><span class="pill ${c.cfg.rec_mode === 'off' ? '' : 'r'}">REC: ${c.cfg.rec_mode}</span><span class="pill c">${c.cfg.detect ? 'AI detect ON' : 'detect OFF'}</span>${c.cfg.zone ? '<span class="pill y">zone</span>' : ''}${c.cfg.line ? '<span class="pill y">count-line</span>' : ''}</div>
    ${c.error ? `<p class="hint" style="color:#fda4af">${esc(c.error)}</p>` : ''}<div class="row"><button class="btn sm g" data-a="snap" data-id="${c.id}">📸</button><button class="btn sm" data-a="edit" data-id="${c.id}">⚙️ Settings</button><button class="btn sm c" data-a="zone" data-id="${c.id}">✏️ Zone / Line</button></div></div>`).join('') || '<div class="empty"><div class="big">📷</div>Koi camera nahi</div>';
  $$('#cl [data-a]').forEach(b => b.onclick = async () => { const c = ST.cameras.find(c => c.id == b.dataset.id); if (b.dataset.a === 'snap') { const r = await tool('take_snapshot', { camera: String(c.id) }); r.media ? lightbox(r.media[0]) : toast(r.error); } else if (b.dataset.a === 'edit') editCam(c); else zoneEditor(c); });
  $('#add').onclick = addCam;
};
function addCam() {
  const x = modal(`<h2>＋ Naya camera</h2><p class="hint">IP camera, NVR/DVR channel, phone, webcam ya video file — sab chalega.</p>
  <label class="f">Naam</label><input id="cn" placeholder="Main Gate / मुख्य गेट">
  <label class="f">Type</label><select id="ck"><option value="rtsp">📡 IP Camera / NVR (RTSP)</option><option value="url">🌐 HTTP / MJPEG / IP-Webcam app URL</option><option value="webcam">💻 USB / Laptop webcam</option><option value="file">🎞️ Video file (testing)</option><option value="demo">🧪 Demo camera</option></select>
  <div id="brandw"><label class="f">Brand template (tap karo)</label><div class="chips">${BRANDS.map(([n, u]) => `<span class="chip" data-u="${esc(u)}">${esc(n)}</span>`).join('')}</div></div>
  <label class="f" id="srcl">URL / source</label><input id="cs" placeholder="rtsp://admin:pass@192.168.1.64:554/Streaming/Channels/101">
  <label class="f">Jagah (voice mein bulane ke liye, optional)</label><input id="cloc" placeholder="gate, parking, dukaan, godown…">
  <p class="hint" id="ctr" style="margin-top:10px"></p>
  <div class="row" style="margin-top:16px"><button class="btn c" id="ct">🔍 Test</button><button class="btn p" id="cok">Save</button><button class="btn" onclick="this.closest('.modal').remove()">Cancel</button></div>`);
  $$('[data-u]', x).forEach(c => c.onclick = () => { $('#cs', x).value = c.dataset.u; });
  const upd = () => { const k = $('#ck', x).value; $('#brandw', x).hidden = k !== 'rtsp'; $('#cs', x).hidden = $('#srcl', x).hidden = k === 'demo'; $('#cs', x).placeholder = { webcam: '0', file: '/path/to/video.mp4', url: 'http://192.168.1.5:8080/video' }[k] || 'rtsp://…'; };
  $('#ck', x).onchange = upd; upd();
  const body = () => ({ name: $('#cn', x).value || 'Camera', kind: $('#ck', x).value, source: $('#cs', x).value.trim(), location: $('#cloc', x).value });
  $('#ct', x).onclick = async () => { $('#ctr', x).textContent = 'Testing…'; const r = await api('/api/cameras/test', { method: 'POST', body: body() }); $('#ctr', x).textContent = r.ok ? '✅ Connect ho gaya' + (r.size ? ` (${r.size[0]}×${r.size[1]})` : '') : '❌ ' + r.error; };
  $('#cok', x).onclick = async () => { const r = await api('/api/cameras', { method: 'POST', body: body() }); if (r.ok) { x.remove(); toast('Camera add ho gaya ✅'); PAGES.cameras($('#main')); } else $('#ctr', x).textContent = '❌ ' + r.error; };
}
function editCam(c) {
  const labs = ['person', 'car', 'motorcycle', 'bus', 'truck', 'bicycle', 'dog', 'cat'];
  const x = modal(`<h2>⚙️ ${esc(c.name)}</h2>
  <label class="f">Naam</label><input id="en" value="${esc(c.name)}"><label class="f">Jagah / location</label><input id="el" value="${esc(c.cfg.location || '')}">
  ${c.kind !== 'demo' ? `<label class="f">Source URL (khali = same)</label><input id="es" placeholder="${esc(c.source)}">` : ''}
  <label class="f">Recording</label><select id="er">${[['off', '⏹ Off'], ['motion', '🎯 Sirf movement par (storage bachao)'], ['continuous', '🔴 24×7 continuous']].map(([v, l]) => `<option value="${v}" ${c.cfg.rec_mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
  <label class="f">Sensitivity: <span id="sv">${Math.round(c.cfg.sensitivity * 100)}%</span></label><input type="range" id="esn" min="0.1" max="0.95" step="0.05" value="${c.cfg.sensitivity}" oninput="$('#sv').textContent=Math.round(this.value*100)+'%'">
  <label class="f">Kya detect/count karna hai</label><div class="chips">${labs.map(l => `<label class="chip"><input type="checkbox" class="el" value="${l}" ${c.cfg.labels.includes(l) ? 'checked' : ''} style="width:auto;margin-right:6px">${EMO[l]} ${l}</label>`).join('')}</div>
  <label class="row f" style="margin-top:14px"><span class="sw"><input type="checkbox" id="ed" ${c.cfg.detect ? 'checked' : ''}><i></i></span> AI detection ON</label>
  <label class="row f"><span class="sw"><input type="checkbox" id="ee" ${c.enabled ? 'checked' : ''}><i></i></span> Camera enabled</label>
  <div class="row" style="margin-top:18px"><button class="btn p" id="eok">Save</button><button class="btn d" id="edel">🗑️ Hatao</button><button class="btn" onclick="this.closest('.modal').remove()">Cancel</button></div>`);
  $('#eok', x).onclick = async () => {
    await api('/api/cameras/' + c.id, { method: 'PUT', body: { name: $('#en', x).value, location: $('#el', x).value, source: $('#es', x)?.value || null, rec_mode: $('#er', x).value, sensitivity: +$('#esn', x).value, labels: $$('.el:checked', x).map(i => i.value), detect: $('#ed', x).checked, enabled: $('#ee', x).checked } });
    x.remove(); toast('Save ho gaya ✅'); PAGES.cameras($('#main'));
  };
  $('#edel', x).onclick = async () => { if (confirm(`'${c.name}' hatana hai?`)) { await api('/api/cameras/' + c.id, { method: 'DELETE' }); x.remove(); PAGES.cameras($('#main')); } };
}
function zoneEditor(c) {
  const x = modal(`<h2>✏️ Zone & Counting line</h2><p class="hint"><b>Zone</b>: sirf is hisse ke log/gaadi count honge. <b>Line</b>: jo is line ko paar karega, andar/bahar count hoga (aane-jaane ki ginti).</p>
  <div class="row" style="margin:10px 0"><button class="btn sm c" data-m="line">📏 Line kheencho (2 click)</button><button class="btn sm o" data-m="zone">⬠ Zone banao (click points)</button><button class="btn sm g" id="zdone">✔ Zone poora</button><button class="btn sm d" id="zclr">Saaf karo</button></div>
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
  $('#zdone', x).onclick = () => { if (tmp.length >= 3) { zone = tmp; tmp = []; draw(); } else toast('Kam se kam 3 points chahiye'); };
  $('#zclr', x).onclick = () => { zone = []; line = []; tmp = []; draw(); };
  $('#zsave', x).onclick = async () => { await api('/api/cameras/' + c.id, { method: 'PUT', body: { zone: zone.length >= 3 ? zone : null, line: line.length === 4 ? line : null } }); x.remove(); toast('Zone/Line save ✅'); PAGES.cameras($('#main')); };
}

/* ------------------------------------------------------------ rules */
PAGES.rules = async m => {
  await refresh();
  const load = async () => {
    const r = await api('/api/rules'); const T = { object: '👀 Object dikhe', motion: '💨 Movement', line_cross: '📏 Line cross', count_above: '👥 Bheed (count ≥)', offline: '📴 Camera offline' };
    $('#rl').innerHTML = r.rules.map(x => `<div class="card"><div class="row"><b style="flex:1">${esc(x.name)}</b><label class="sw"><input type="checkbox" ${x.enabled ? 'checked' : ''} data-t="${x.id}"><i></i></label></div>
      <div class="chips" style="margin:12px 0"><span class="pill v">${T[x.trigger] || x.trigger}</span>${x.label ? `<span class="pill c">${EMO[x.label] || ''} ${esc(x.label)}</span>` : ''}${x.min_count ? `<span class="pill y">≥ ${x.min_count}</span>` : ''}${x.between ? `<span class="pill o">🕒 ${esc(x.between.join(' → '))}</span>` : ''}<span class="pill">${x.camera ? 'cam ' + x.camera : 'sab camera'}</span></div>
      <div class="chips">${(x.actions || []).map(a => `<span class="pill g">${{ notify: '🔔 Notify', speak: '🗣️ Bolke batao', snapshot: '📸 Photo', clip: '🎬 Clip' }[a.type] || a.type}</span>`).join('')}</div><button class="btn sm d" style="margin-top:12px" data-d="${x.id}">Hatao</button></div>`).join('') || '<div class="empty" style="grid-column:1/-1"><div class="big">⚡</div>Koi rule nahi. Neeche banao ya AI se bolo: "raat 10 baje ke baad koi aaye to alert do"</div>';
    $$('[data-t]').forEach(i => i.onchange = () => api('/api/rules/' + i.dataset.t, { method: 'PATCH', body: { enabled: i.checked } }));
    $$('[data-d]').forEach(b => b.onclick = async () => { await api('/api/rules/' + b.dataset.d, { method: 'PATCH', body: { delete: true } }); load(); });
  };
  m.innerHTML = head('अलर्ट और ऑटोमेशन', 'When X happens → do Y') + `<div class="grid g3" id="rl"></div><div class="card" style="margin-top:18px"><h3>＋ Naya rule</h3><div class="grid g4">
    <div><label class="f">Naam</label><input id="rn" placeholder="Raat ka alert"></div>
    <div><label class="f">Jab…</label><select id="rt"><option value="object">👀 Koi object dikhe</option><option value="motion">💨 Movement ho</option><option value="line_cross">📏 Line cross ho</option><option value="count_above">👥 Bheed ho (count ≥)</option><option value="offline">📴 Camera offline ho</option></select></div>
    <div><label class="f">Kaun (label)</label><select id="rlb"><option value="person">🚶 Person</option><option value="car">🚗 Car</option><option value="motorcycle">🏍️ Bike</option><option value="truck">🚚 Truck</option><option value="">Koi bhi</option></select></div>
    <div><label class="f">Count ≥ (bheed ke liye)</label><input id="rc" type="number" value="5" min="1"></div>
    <div><label class="f">Camera</label><select id="rcam"><option value="">Sab</option>${ST.cameras.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
    <div><label class="f">Time (optional) se</label><input id="rf" type="time"></div><div><label class="f">tak</label><input id="rto" type="time"></div>
    <div><label class="f">Kitni der baad dobara (sec)</label><input id="rcd" type="number" value="60"></div></div>
    <label class="f">Phir…</label><div class="chips">${[['notify', '🔔 Notification', 1], ['speak', '🗣️ Bolkar batao', 0], ['snapshot', '📸 Photo lo', 0], ['clip', '🎬 10s video lo', 0]].map(([v, l, d]) => `<label class="chip"><input type="checkbox" class="ra" value="${v}" ${d ? 'checked' : ''} style="width:auto;margin-right:6px">${l}</label>`).join('')}</div>
    <button class="btn p" id="rok" style="margin-top:16px">Rule banao</button></div>`;
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
  m.innerHTML = head('AI एक्सटेंशन', 'Bolkar app mein naye features jodo') + `<div class="card" style="background:linear-gradient(135deg,rgba(139,92,246,.35),rgba(236,72,153,.25))"><h3>✨ Kya naya chahiye?</h3><p class="hint" style="margin-bottom:12px">Apni zaroorat bolo ya likho. AI naya feature (page, report, alert logic, folder, dashboard card) khud bana dega. Code wala feature pehle yahan <b>aapke approval</b> ke liye aayega — tab tak kuch nahi chalta.</p>
    <div class="row"><input id="xi" placeholder="जैसे: हर रात 9 बजे दिनभर की रिपोर्ट बनाओ / गाड़ियों की गिनती का नया पेज बनाओ" style="flex:1;min-width:240px"><button class="btn p" id="xg">🪄 Banao</button></div>
    <div class="chips" style="margin-top:12px">${['Visitor log ka naya page banao', 'Dukaan khulne ka time batane wala tool banao', 'Sabse busy ghante ki daily report banao', 'Gaadi aur bike ka alag-alag counter page'].map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div></div>
    <h3 style="margin:24px 0 12px">⏳ Approval ka intezaar <span class="pill r">${pend.length}</span></h3><div id="pl">${pend.map(plugCard).join('') || '<p class="hint">Koi pending nahi.</p>'}</div>
    <h3 style="margin:24px 0 12px">✅ Chalu extensions <span class="pill g">${act.length}</span></h3><div class="grid g3">${act.map(plugCard).join('') || '<p class="hint">Abhi koi nahi.</p>'}</div>
    <div class="card" style="margin-top:24px"><h3>🛡️ Safety</h3><p class="hint">Extensions aapke server par chalte hain, isliye har code ko approve karne se pehle padh lijiye. Sirf apne bharose ke extensions approve karein. Instant changes (rules, folders, dashboard cards, settings) bina code ke hote hain aur approval nahi maangte.</p></div>`;
  $('#xg').onclick = () => $('#xi').value && openChat('Mujhe app mein ek naya feature chahiye: ' + $('#xi').value, true);
  $$('.chip', m).forEach(c => { if (!c.closest('#side')) c.onclick = () => openChat(c.textContent, true); });
  $$('[data-pa]', m).forEach(b => b.onclick = async () => {
    const [a, n] = b.dataset.pa.split(':');
    if (a === 'code') { const p = r.plugins.find(p => p.name === n); modal(`<h2>${esc(n)}</h2><p class="hint">${esc(p.description)}</p><div class="code">${esc(p.code || '')}</div>`, true); return; }
    if (a === 'remove' && !confirm('Hatana hai?')) return;
    try { await api(`/api/plugins/${n}/${a}`, { method: 'POST' }); toast(a === 'approve' ? 'Extension chalu ho gaya 🎉' : 'Ho gaya'); await refresh(); PAGES.extensions(m); } catch (e) { toast('❌ ' + e.message); }
  });
};
const plugCard = p => `<div class="card" style="margin-bottom:12px"><div class="row"><div class="em violet" >${esc(p.icon || '🧩')}</div><div style="flex:1;min-width:0"><b>${esc(p.title || p.name)}</b><br><small class="hint">${esc(p.description)}</small></div></div>
  <div class="chips" style="margin:10px 0">${(p.tools || []).map(t => `<span class="pill c">🔧 ${esc(t)}</span>`).join('')}${p.has_panel ? '<span class="pill v">📄 page</span>' : ''}</div>
  <div class="row"><button class="btn sm" data-pa="code:${esc(p.name)}">👁 Code dekho</button>${p.status === 'pending' ? `<button class="btn sm g" data-pa="approve:${esc(p.name)}">✔ Approve</button><button class="btn sm d" data-pa="reject:${esc(p.name)}">✕ Reject</button>` : `<button class="btn sm d" data-pa="remove:${esc(p.name)}">Hatao</button>`}</div></div>`;
PAGES.plugin = async (m, p) => {
  const n = p.split('/')[1], pl = (ST.plugins || []).find(x => x.name === n);
  m.innerHTML = head(`${esc(pl?.icon || '🧩')} ${esc(pl?.title || n)}`, 'Extension page') + `<iframe class="panel" sandbox="allow-scripts" src="/api/plugins/${encodeURIComponent(n)}/panel"></iframe>`;
};

/* ------------------------------------------------------------ settings */
PAGES.settings = async m => {
  const s = await api('/api/settings'); await refresh();
  const sec = (t, body) => `<div class="card"><h3>${t}</h3>${body}</div>`;
  m.innerHTML = head('सेटिंग्स', 'AI, alerts, security, storage', `<button class="btn p" id="ssave">💾 Save</button>`) + `<div class="grid g2">
  ${sec('✨ AI (Claude)', `<p class="hint">Voice/chat AI ke liye Anthropic API key chahiye (console.anthropic.com). Key sirf aapke server par save hoti hai.</p><label class="f">API key ${s.anthropic_key_set ? '<span class="pill g">saved</span>' : '<span class="pill r">missing</span>'}</label><input id="k" type="password" placeholder="sk-ant-… (khali = same)"><label class="f">Model</label><input id="md" value="${esc(s.model)}">`)}
  ${sec('🔔 Notifications', `<label class="f">Telegram bot token ${s.telegram_token_set ? '<span class="pill g">saved</span>' : ''}</label><input id="tt" type="password" placeholder="123456:ABC…"><label class="f">Telegram chat id</label><input id="tc" value="${esc(s.telegram_chat || '')}"><label class="f">Webhook URL (Slack/Discord/Zapier/WhatsApp gateway)</label><input id="wh" value="${esc(s.webhook_url || '')}"><button class="btn sm c" id="tn" style="margin-top:12px">📨 Test alert</button>`)}
  ${sec('🎯 Detection & Storage', `<label class="f">Detector</label><select id="dt">${['auto', 'yolo', 'hog'].map(v => `<option ${s.detector === v ? 'selected' : ''}>${v}</option>`).join('')}</select><p class="hint">auto = YOLO (agar <code>pip install ultralytics</code> kiya ho) warna OpenCV HOG (sirf log). Badalne ke baad app restart.</p><label class="f">Processing FPS: <span id="fv">${s.target_fps}</span></label><input type="range" id="fp" min="3" max="25" value="${s.target_fps}" oninput="$('#fv').textContent=this.value"><label class="f">Recordings kitne din rakhein</label><input id="rd" type="number" value="${s.retention_days}"><label class="f">Motion se pehle ke seconds (pre-roll)</label><input id="pr" type="number" value="${s.preroll_seconds}">`)}
  ${sec('🔐 Security & Look', `<p class="hint">PIN lagayein taaki bina PIN koi cameras na dekh sake. Internet par kholne se pehle PIN zaroori hai.</p><label class="f">App PIN ${s.pin_set ? '<span class="pill g">ON</span>' : '<span class="pill r">OFF</span>'}</label><input id="pn" type="password" inputmode="numeric" placeholder="naya PIN (khali = same)">${s.pin_set ? '<button class="btn sm d" id="pnx" style="margin-top:10px">PIN hatao</button>' : ''}<label class="f">Accent color</label><input type="color" id="ac" value="${ST.accent || '#8b5cf6'}" style="height:46px;padding:4px">`)}
  </div>`;
  $('#tn').onclick = async () => { await save(true); await tool('send_test_alert'); };
  async function save(quiet) {
    const b = { model: $('#md').value, telegram_chat: $('#tc').value, webhook_url: $('#wh').value, detector: $('#dt').value, target_fps: +$('#fp').value, retention_days: +$('#rd').value, preroll_seconds: +$('#pr').value, accent: $('#ac').value };
    [['k', 'anthropic_key'], ['tt', 'telegram_token'], ['pn', 'pin']].forEach(([i, k]) => $('#' + i).value && (b[k] = $('#' + i).value));
    await api('/api/settings', { method: 'PUT', body: b }); if (b.pin) { await api('/api/login', { method: 'POST', body: { pin: b.pin } }); } if (!quiet) { toast('Settings save ✅'); PAGES.settings(m); }
  }
  $('#ssave').onclick = () => save(); $('#pnx')?.addEventListener('click', async () => { await api('/api/settings', { method: 'PUT', body: { clear_pin: true } }); PAGES.settings(m); });
};

/* ------------------------------------------------------------ AI chat + voice */
let hist = LS.get('chat', []), busy = false, speak = LS.get('tts', true), vlang = LS.get('vlang', 'hi-IN'), rec = null, listening = false;
const QUICK = ['📸 सबका फोटो दो', '👥 अभी कितने लोग?', '🎬 पिछले 30 सेकंड की वीडियो', '📊 आज की रिपोर्ट', '➕ नया फीचर जोड़ो', '📁 "Important" फोल्डर बनाओ'];
function openChat(text, send) { $('#chat').classList.add('open'); $('#orb').style.display = 'none'; if (text) { $('#inp').value = text; send && sendMsg(); } else $('#inp').focus(); }
function closeChat() { $('#chat').classList.remove('open'); $('#orb').style.display = ''; stopListen(); speechSynthesis?.cancel(); }
function renderMsgs() {
  const box = $('#msgs');
  box.innerHTML = hist.length ? hist.map(msgHTML).join('') : `<div class="m a">नमस्ते! 👋 मैं <b>दृष्टि AI</b> हूँ।<br>बोलिए जैसे —<br>• "गेट का फोटो दो"<br>• "पिछले 1 मिनट की वीडियो दो"<br>• "कल सुबह 9 से 10 बजे के बीच कितने लोग आए?"<br>• "रात में कोई आए तो अलर्ट दो"<br>• "ऐप में नया रिपोर्ट पेज जोड़ दो"<br><br>🎤 दबाकर बोलिए या नीचे लिखिए।</div>`;
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
  $$('#msgs [data-ap]').forEach(b => b.onclick = async () => { try { await api(`/api/plugins/${b.dataset.ap}/approve`, { method: 'POST' }); b.parentElement.innerHTML = '<span>✓ Chalu ho gaya 🎉</span>'; await refresh(); renderNav(); } catch (e) { toast('❌ ' + e.message); } });
  $$('#msgs [data-rj]').forEach(b => b.onclick = async () => { await api(`/api/plugins/${b.dataset.rj}/reject`, { method: 'POST' }); b.parentElement.innerHTML = '<span>Reject kiya</span>'; });
  $$('#msgs [data-vc]').forEach(b => b.onclick = async () => { const r = await api('/api/plugins'), p = r.plugins.find(p => p.name === b.dataset.vc); p && modal(`<h2>${esc(p.name)}</h2><p class="hint">${esc(p.description)}</p><div class="code">${esc(p.code || '')}</div><p class="hint" style="margin-top:10px">⚠️ Isko approve karne se pehle code padh lijiye.</p>`, true); });
}
async function sendMsg() {
  const t = $('#inp').value.trim(); if (!t || busy) return; $('#inp').value = ''; stopListen(); speechSynthesis?.cancel();
  hist.push({ role: 'user', content: t }); renderMsgs(); busy = true;
  $('#msgs').insertAdjacentHTML('beforeend', '<div class="m a typing" id="typ"><i></i><i></i><i></i></div>'); $('#msgs').scrollTop = 1e9; $('#aistate').textContent = 'Soch raha hoon…';
  try {
    const r = await api('/api/chat', { method: 'POST', body: { messages: hist.slice(-14).map(m => ({ role: m.role, content: m.content })), lang: vlang } });
    hist.push({ role: 'assistant', content: r.reply, media: r.media, actions: r.actions, pending: r.pending });
    if ((r.pending || []).length) { pendingCount += r.pending.length; renderNav(); }
    if (r.actions?.some(a => /widget|plugin|camera|rule|folder|setting/.test(a.tool))) refresh().then(renderNav);
    if (speak) say(r.reply);
  } catch (e) { hist.push({ role: 'assistant', content: '❌ ' + e.message }); }
  busy = false; $('#aistate').textContent = 'Bolo ya likho'; LS.set('chat', hist.slice(-30).map(m => ({ ...m, media: (m.media || []).slice(0, 4) }))); renderMsgs();
}
function say(t) {
  if (!('speechSynthesis' in window)) return; const u = new SpeechSynthesisUtterance(t.replace(/[\u{1F300}-\u{1FAFF}☀-➿]/gu, '')); u.lang = /[ऀ-ॿ]/.test(t) ? 'hi-IN' : (vlang === 'hi-IN' ? 'hi-IN' : 'en-IN'); u.rate = 1.02;
  const v = speechSynthesis.getVoices().find(v => v.lang === u.lang); if (v) u.voice = v; speechSynthesis.speak(u);
}
function startListen() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast('Is browser mein voice support nahi. Chrome/Edge use karein (https ya localhost par).', { level: 'warn' });
  speechSynthesis?.cancel(); rec = new SR(); rec.lang = vlang; rec.interimResults = true; rec.continuous = false;
  rec.onresult = e => { let s = ''; for (const r of e.results) s += r[0].transcript; $('#inp').value = s; if (e.results[e.results.length - 1].isFinal) { stopListen(); sendMsg(); } };
  rec.onerror = e => { stopListen(); if (e.error === 'not-allowed') toast('Mic ki permission dijiye (https ya localhost zaroori).', { level: 'warn' }); };
  rec.onend = () => stopListen(); rec.start(); listening = true; $('#mic').classList.add('rec'); $('#aistate').textContent = '🎤 Sun raha hoon…';
}
function stopListen() { try { rec?.stop(); } catch { } listening = false; $('#mic')?.classList.remove('rec'); if (!busy) $('#aistate').textContent = 'Bolo ya likho'; }
function initChat() {
  $('#chips').innerHTML = QUICK.map(q => `<span class="chip">${esc(q)}</span>`).join(''); $$('#chips .chip').forEach(c => c.onclick = () => { $('#inp').value = c.textContent.replace(/^\S+\s/, '').replace(/"/g, ''); sendMsg(); });
  $('#orb').onclick = () => openChat(); $('#close').onclick = closeChat; $('#send').onclick = sendMsg; $('#inp').onkeydown = e => e.key === 'Enter' && sendMsg();
  $('#mic').onclick = () => listening ? stopListen() : startListen();
  $('#clear').onclick = () => { hist = []; LS.set('chat', []); renderMsgs(); };
  const sl = () => { $('#lang').textContent = vlang === 'hi-IN' ? 'हिं' : 'EN'; $('#tts').textContent = speak ? '🔊' : '🔇'; };
  $('#lang').onclick = () => { vlang = vlang === 'hi-IN' ? 'en-IN' : 'hi-IN'; LS.set('vlang', vlang); sl(); toast(vlang === 'hi-IN' ? 'Voice: हिंदी / Hinglish' : 'Voice: English (India)'); };
  $('#tts').onclick = () => { speak = !speak; LS.set('tts', speak); sl(); if (!speak) speechSynthesis?.cancel(); };
  sl(); renderMsgs();
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('.modal')?.remove(); } if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); openChat(); } });
}

/* ------------------------------------------------------------ live push */
function connectSSE() {
  const es = new EventSource('/api/stream');
  es.addEventListener('alert', e => { const d = JSON.parse(e.data); toast(d.text, { img: d.image, level: 'warn', ms: 12000 }); beep(); if (d.speak) say(d.text.replace(/^🔔\s*/, '')); try { if (Notification.permission === 'granted') new Notification('दृष्टि AI', { body: d.text, icon: d.image || undefined }); } catch { } });
  es.addEventListener('plugin_pending', e => { pendingCount++; renderNav(); toast('🧩 Naya extension approval ke liye taiyaar hai'); });
  es.addEventListener('cctv', e => { const d = JSON.parse(e.data); if (page === 'dashboard') recent(); if (d.type === 'camera_offline') toast('📴 ' + d.camera + ' offline ho gaya', { level: 'warn' }); });
}

/* ------------------------------------------------------------ boot */
function showLogin() {
  $('#login').hidden = false; const go = async () => { try { await api('/api/login', { method: 'POST', body: { pin: $('#pin').value } }); location.reload(); } catch (e) { $('#pinErr').textContent = 'Galat PIN'; } };
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
