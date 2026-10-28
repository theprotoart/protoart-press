// Bridge between the rack panel and the main process. Runs sandboxed: only
// these narrow functions are exposed; the page never sees Node or Electron.
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('press', {
  sandboxed: process.sandboxed === true,
  setSettings: s => ipcRenderer.send('settings', s),
  addFiles: files => ipcRenderer.send('add-paths', Array.from(files, f => webUtils.getPathForFile(f)).filter(Boolean)),
  choose: () => ipcRenderer.invoke('choose'),
  clear: () => ipcRenderer.send('clear'),
  reveal: id => ipcRenderer.send('reveal', id),
  onQueue: cb => ipcRenderer.on('queue', (_e, q) => cb(q)),
  onMenu: cb => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
  // JPEG jobs run in the panel's web workers (Chromium's codecs).
  onJpegJob: cb => ipcRenderer.on('jpeg-job', (_e, job) => cb(job)),
  jpegProgress: (id, progress) => ipcRenderer.send('jpeg-progress', { id, progress }),
  jpegResult: (id, result) => ipcRenderer.send('jpeg-result', { id, ...result }),
});
