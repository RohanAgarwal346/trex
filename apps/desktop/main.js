// Drishti AI desktop shell.
// - "Local" mode: starts the bundled Python server on this PC (auto-installs its Python packages on first run) and shows its web UI.
// - "Remote" mode: just shows the web UI of a server running elsewhere.
// The UI itself is always served by the server, so updating the server updates the desktop window and the Android app together.
const { app, BrowserWindow, Menu, dialog, shell, session, ipcMain } = require('electron');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.DRISHTI_PORT || 8800);
const SRC = app.isPackaged ? path.join(process.resourcesPath, 'cctv-ai') : path.join(__dirname, '..', '..', 'cctv-ai');
const unpacked = p => p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch { return {}; } };
const writeCfg = c => fs.writeFileSync(cfgFile(), JSON.stringify(c));

let win = null, server = null, quitting = false;

function splashText(t) { try { win?.webContents.executeJavaScript(`document.getElementById('s') && (document.getElementById('s').textContent=${JSON.stringify(t)})`); } catch { } }

function findPython() {
  const cands = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
  for (const [cmd, pre] of cands) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys;print(sys.version_info[0]*100+sys.version_info[1])'], { encoding: 'utf8' });
    if (r.status === 0 && Number(r.stdout.trim()) >= 310) return [cmd, pre];
  }
  return null;
}

function run(cmd, args, label) {
  return new Promise((resolve, reject) => {
    splashText(label);
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(err.slice(-600) || `${cmd} exited with ${code}`)));
  });
}

async function ensureEnv() {
  const py = findPython();
  if (!py) {
    const r = dialog.showMessageBoxSync({ type: 'error', title: 'Python required', message: 'Drishti AI needs Python 3.10 or newer.', detail: 'Install it from python.org (tick "Add Python to PATH"), then start Drishti AI again.', buttons: ['Open python.org', 'Quit'] });
    if (r === 0) shell.openExternal('https://www.python.org/downloads/');
    app.quit(); return null;
  }
  const venv = path.join(app.getPath('userData'), 'venv');
  const vpy = process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
  if (!fs.existsSync(vpy)) await run(py[0], [...py[1], '-m', 'venv', venv], 'Preparing Python environment (first run)…');
  const req = ['requirements.txt', 'requirements-voice.txt'].map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
  const stamp = path.join(venv, '.req-hash'), hash = crypto.createHash('sha1').update(req).digest('hex');
  if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== hash) {
    await run(vpy, ['-m', 'pip', 'install', '--upgrade', 'pip'], 'Updating pip…').catch(() => { });
    await run(vpy, ['-m', 'pip', 'install', '-r', path.join(SRC, 'requirements.txt')], 'Installing components (first run, a few minutes)…');
    await run(vpy, ['-m', 'pip', 'install', '-r', path.join(SRC, 'requirements-voice.txt')], 'Installing voice engine…').catch(() => { });
    fs.writeFileSync(stamp, hash);
  }
  return vpy;
}

function ping(url) {
  return new Promise(res => { const r = http.get(url + '/api/auth', { timeout: 1500 }, x => { x.resume(); res(x.statusCode < 500); }); r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); }); });
}
async function waitFor(url, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ping(url)) return true; await new Promise(r => setTimeout(r, 500)); } return false; }

function binDirs() {
  const dirs = [];
  try { dirs.push(path.dirname(unpacked(require('ffmpeg-static')))); } catch { }
  try { dirs.push(path.dirname(unpacked(require('ffprobe-static').path))); } catch { }
  return dirs;
}

async function startLocal() {
  if (await ping(`http://127.0.0.1:${PORT}`)) return `http://127.0.0.1:${PORT}`;   // a server is already running
  const vpy = await ensureEnv(); if (!vpy) return null;
  splashText('Starting the camera engine…');
  const env = { ...process.env, DRISHTI_DATA: path.join(app.getPath('userData'), 'data'), PATH: [...binDirs(), process.env.PATH].join(path.delimiter) };
  server = spawn(vpy, ['-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', String(PORT)], { cwd: SRC, env, windowsHide: true });
  let log = ''; server.stderr.on('data', d => { log = (log + d).slice(-2000); });
  server.on('exit', c => { if (!quitting) { dialog.showErrorBox('Drishti AI engine stopped', log || `Exit code ${c}`); app.quit(); } });
  if (!(await waitFor(`http://127.0.0.1:${PORT}`, 60000))) { dialog.showErrorBox('Drishti AI could not start', log || 'The engine did not respond.'); app.quit(); return null; }
  return `http://127.0.0.1:${PORT}`;
}

async function boot() {
  win.loadFile(path.join(__dirname, 'splash.html'));
  await new Promise(r => win.webContents.once('did-finish-load', r));
  const cfg = readCfg();
  let url;
  try { url = cfg.remote ? cfg.remote : await startLocal(); } catch (e) { dialog.showErrorBox('Setup failed', String(e.message || e)); app.quit(); return; }
  if (!url) return;
  if (cfg.remote && !(await waitFor(url, 8000))) {
    dialog.showMessageBoxSync({ type: 'warning', message: `Could not reach ${url}`, detail: 'Check the address and that the server is running. You can change it from the Server menu.' });
    writeCfg({}); return boot();
  }
  win.loadURL(url);
}

function buildMenu() {
  const t = [
    { label: 'File', submenu: [{ role: 'quit' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'toggleDevTools' }] },
    { label: 'Server', submenu: [
      { label: 'Use this computer (local)', click: () => { writeCfg({}); relaunch(); } },
      { label: 'Connect to another server…', click: () => { win.loadFile(path.join(__dirname, 'connect.html')); } },
    ] },
    { label: 'Help', submenu: [
      { label: 'Open data folder', click: () => shell.openPath(path.join(app.getPath('userData'), 'data')) },
      { label: 'Check for updates', click: () => checkUpdates(true) },
      { label: `Version ${app.getVersion()}`, enabled: false },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}
function relaunch() { quitting = true; server?.kill(); app.relaunch(); app.exit(0); }

function checkUpdates(manual) {
  if (!app.isPackaged) { if (manual) dialog.showMessageBox({ message: 'Updates only work in the installed app.' }); return; }
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.on('update-downloaded', () => dialog.showMessageBox({ type: 'info', message: 'A new version of Drishti AI is ready.', detail: 'Restart now to install it.', buttons: ['Restart now', 'Later'] }).then(r => { if (r.response === 0) { quitting = true; autoUpdater.quitAndInstall(); } }));
    autoUpdater.on('update-not-available', () => manual && dialog.showMessageBox({ message: 'You are on the latest version.' }));
    autoUpdater.on('error', e => manual && dialog.showErrorBox('Update check failed', String(e)));
    autoUpdater.checkForUpdates();
  } catch (e) { if (manual) dialog.showErrorBox('Update check failed', String(e)); }
}

ipcMain.on('set-server', (e, url) => {
  if (!e.senderFrame.url.startsWith('file://')) return;   // only the bundled connect page may change the server

  if (url && !/^https?:\/\//i.test(url)) url = 'http://' + url;
  writeCfg(url ? { remote: url.replace(/\/+$/, '') } : {});
  relaunch();
});

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  win = new BrowserWindow({ width: 1440, height: 900, minWidth: 900, minHeight: 600, title: 'Drishti AI', backgroundColor: '#080818', autoHideMenuBar: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') } });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // Only the camera UI itself may use the microphone.
  const ok = (wc, perm) => perm === 'media' || perm === 'fullscreen' || perm === 'notifications';
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(ok(wc, perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => ok(wc, perm));
  buildMenu();
  boot().then(() => setTimeout(() => checkUpdates(false), 8000));
});
app.on('before-quit', () => { quitting = true; server?.kill(); });
app.on('window-all-closed', () => app.quit());
