const { contextBridge, ipcRenderer } = require('electron');
// Exposed to every page, but only the bundled connect.html uses it.
contextBridge.exposeInMainWorld('drishti', { setServer: url => ipcRenderer.send('set-server', String(url || '')) });
