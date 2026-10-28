// ProtoArt Press: Electron main process. Owns the file queue, file I/O, the PNG worker pool,
// and the macOS helper processes for PDF, video and audio.
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const fsafe = require('./fsafe');
const validate = require('./validate');
const media = require('./engine/media');

const APP_ORIGIN = 'app://press';
const PANEL_URL = `${APP_ORIGIN}/renderer/index.html`;

// Every renderer runs in Chromium's OS sandbox (it decodes untrusted images).
app.enableSandbox();

// The panel is served from app://press/ instead of file://, so the page gets no
// file-system privileges and can only load the files listed in servePanelFile.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win = null;
const DEFAULTS = {
  minimumSavingsPercent: 3, outputMode: 'copy', metadata: 'noGPS',
  image: { on: true, strength: 'balanced', maxDimension: 0, reducePNG: true },
  pdf: { on: true, quality: 'balanced', dpi: 150, gray: false },
  video: { on: true, quality: 'balanced', maxEdge: 0, codec: 'hevc' },
  audio: { on: true, quality: 'balanced', sampleRate: 0, lossless: false },
};
let settings = structuredClone(DEFAULTS);
function mergeSettings(clean) {
  for (const [k, v] of Object.entries(clean)) {
    settings[k] = v && typeof v === 'object' ? { ...settings[k], ...v } : v;
  }
}

// ------------------------------------------------------------------ Queue

const MODULE_OF = { jpeg: 'image', png: 'image', pdf: 'pdf', video: 'video', audio: 'audio' };
const BADGE = { jpeg: 'IMG', png: 'IMG', pdf: 'PDF', video: 'VID', audio: 'AUD' };
const MAX_BYTES = { jpeg: 512 * 1024 ** 2, png: 512 * 1024 ** 2, pdf: 2 * 1024 ** 3, audio: 8 * 1024 ** 3, video: Infinity };
const LIMIT = { jpeg: 2, png: 2, pdf: 1, video: 1, audio: 2 };

let nextId = 1;
const items = [];          // { id, path, name, kind, originalBytes, status, progress, newBytes, detail, output, outputName, batch }
const pending = [];
let batchStart = null;
const running = { jpeg: 0, png: 0, pdf: 0, video: 0, audio: 0 };
const claimed = new Map(); // output path -> source path, so two sources never write the same file

function isWorking() { return pending.length > 0 || Object.values(running).some(n => n > 0); }

// What the panel sees: no full paths, just names and results.
function publicItem(i) {
  return {
    id: i.id, name: i.name, badge: BADGE[i.kind], originalBytes: i.originalBytes, status: i.status, progress: i.progress,
    newBytes: i.newBytes, detail: i.detail, hasOutput: !!i.output, batch: i.batch,
    outputName: i.outputName && i.outputName !== i.name ? i.outputName : '',
  };
}

let updateTimer = null;
function sendUpdate() {
  if (updateTimer) return;
  updateTimer = setTimeout(() => {
    updateTimer = null;
    if (win && !win.isDestroyed()) {
      win.webContents.send('queue', { items: items.map(publicItem), batchStart, working: isWorking() });
    }
  }, 80);
}

function addPaths(paths) {
  if (!isWorking()) {
    for (const it of items) it.batch = false;
    batchStart = Date.now();
  }
  const active = new Set(items.filter(i => i.status === 'queued' || i.status === 'working').map(i => i.path));
  for (const f of fsafe.collect(paths)) {
    if (active.has(f.path) || !settings[MODULE_OF[f.kind]].on) continue; // module switched out
    const item = {
      id: nextId++, path: f.path, name: path.basename(f.path), kind: f.kind, originalBytes: f.size,
      status: 'queued', progress: 0, newBytes: 0, detail: '', output: null, outputName: '', batch: true,
    };
    items.push(item);
    pending.push(item);
  }
  sendUpdate();
  pump();
}

/** A snapshot of the settings that apply to one file, taken when it starts. */
function optionsFor(kind) {
  const m = settings[MODULE_OF[kind]];
  const common = { minimumSavings: settings.minimumSavingsPercent / 100, metadata: settings.metadata, outputMode: settings.outputMode };
  if (kind === 'jpeg' || kind === 'png') {
    return { ...common, strength: m.strength, maxDimension: m.maxDimension || 0, reducePNG: m.reducePNG };
  }
  return { ...common, ...m };
}

function pump() {
  for (let i = 0; i < pending.length;) {
    const item = pending[i];
    const kind = item.kind;
    if (running[kind] >= LIMIT[kind]) { i++; continue; }
    pending.splice(i, 1);
    running[kind]++;
    item.status = 'working';
    item.progress = 0;
    sendUpdate();
    run(item, optionsFor(kind)).finally(() => {
      running[kind]--;
      sendUpdate();
      pump();
    });
  }
  if (!isWorking()) sendUpdate();
}

async function run(item, opts) {
  try {
    if (!(await fsafe.isRegularFile(item.path))) throw new Error('No longer a regular file, so it was skipped');
    const stat = await fs.promises.stat(item.path);
    if (stat.size > MAX_BYTES[item.kind]) {
      item.status = 'kept'; item.detail = 'Too large to process safely, kept as is';
      return;
    }
    const onProgress = f => { item.progress = f; sendUpdate(); };
    if (item.kind === 'jpeg' || item.kind === 'png') {
      const original = await fs.promises.readFile(item.path);
      const result = item.kind === 'png' ? await runPNG(original, opts, onProgress) : await runJPEG(original, opts, onProgress);
      await writeResult(item, original, result, opts.outputMode, stat);
    } else {
      await runMedia(item, opts, stat, onProgress);
    }
  } catch (err) {
    item.status = 'failed';
    item.detail = String((err && err.message) || err);
  }
}

async function writeResult(item, original, result, outputMode, stat) {
  const times = { atime: stat.atime, mtime: stat.mtime };

  if (outputMode === 'replace') {
    if (!result.data) { item.status = 'kept'; item.detail = result.detail; item.output = item.path; return; }
    const temp = await fsafe.writeTempBeside(item.path, result.data, times);
    await swapInPlace(item, temp);
  } else {
    const dir = await fsafe.outputDirFor(item.path);
    item.output = await fsafe.atomicWrite(dir, item.name, result.data || original, times); // keep the folder complete
  }
  if (result.data) {
    item.status = 'done';
    item.newBytes = result.data.length;
  } else {
    item.status = 'kept';
  }
  item.detail = result.detail;
}

/** REPLACE with the same name: original to the Trash, then the temp file (already beside it) takes its place. */
async function swapInPlace(item, temp) {
  try {
    await shell.trashItem(item.path);
  } catch {
    await fs.promises.rm(temp, { force: true });
    throw new Error("Couldn't move the original to the Trash, so it was left untouched");
  }
  await fs.promises.rename(temp, item.path);
  item.output = item.path;
}

// ------------------------------------------------------------------ PDF, video, audio (macOS tools)

/** Output name: audio becomes .m4a; everything else keeps its name. */
function outputNameFor(item) {
  if (item.kind !== 'audio') return item.name;
  const ext = path.extname(item.name);
  return item.name.slice(0, item.name.length - ext.length) + '.m4a';
}

/** Picks a name in `dir` that no other source file in this session is writing to. */
async function claimName(dir, name, src, mustBeFree) {
  let candidate = mustBeFree ? await fsafe.freeName(dir, name) : name;
  const owner = claimed.get(path.join(dir, candidate));
  if (owner && owner !== src) candidate = await fsafe.freeName(dir, candidate);
  claimed.set(path.join(dir, candidate), src);
  return candidate;
}

async function runMedia(item, opts, stat, onProgress) {
  const times = { atime: stat.atime, mtime: stat.mtime };
  const outName = outputNameFor(item);
  const tmpDir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'protoart-press-'));
  try {
    const tmpOut = path.join(tmpDir, 'out' + path.extname(outName).toLowerCase());
    const job = { ...opts, src: item.path, dst: tmpOut, tmpDir, bytes: stat.size };
    const res = item.kind === 'pdf' ? await runPDF(job, onProgress) : await media[item.kind](job, onProgress);
    let kept = res.kept;
    let outSize = 0;
    if (!kept) {
      const st = await fs.promises.lstat(tmpOut);
      if (!st.isFile() || st.size === 0) throw new Error('The engine produced no file, so nothing was written');
      outSize = st.size;
      if (!res.resized && outSize > stat.size * (1 - opts.minimumSavings)) kept = 'Already optimal';
    }
    if (kept) {
      item.status = 'kept'; item.detail = kept;
      if (opts.outputMode === 'replace') { item.output = item.path; return; }
      const dir = await fsafe.outputDirFor(item.path);
      item.output = await fsafe.placeCopy(item.path, dir, await claimName(dir, item.name, item.path, false), times);
      return;
    }

    if (opts.outputMode === 'replace') {
      const dir = path.dirname(item.path);
      if (outName === item.name) {
        const temp = await fsafe.stageInto(tmpOut, dir);
        await fs.promises.lutimes(temp, times.atime, times.mtime);
        await swapInPlace(item, temp);
      } else {
        // New extension: write the new file first, then send the original to the Trash.
        const name = await claimName(dir, outName, item.path, true);
        item.output = await fsafe.placeFile(tmpOut, dir, name, times);
        item.outputName = name;
        try { await shell.trashItem(item.path); } catch { res.detail += ' · original kept (Trash unavailable)'; }
      }
    } else {
      const dir = await fsafe.outputDirFor(item.path);
      const name = await claimName(dir, outName, item.path, false);
      item.output = await fsafe.placeFile(tmpOut, dir, name, times);
      item.outputName = name;
    }
    item.status = 'done';
    item.newBytes = outSize;
    item.detail = res.detail;
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Removes temp folders left behind if the app was force-quit mid-file. */
async function sweepOldTemp() {
  const root = app.getPath('temp');
  try {
    for (const n of await fs.promises.readdir(root)) {
      if (!/^protoart-press-[A-Za-z0-9]{6}$/.test(n)) continue;
      const p = path.join(root, n);
      const st = await fs.promises.lstat(p);
      if (st.isDirectory() && Date.now() - st.mtimeMs > 6 * 3600 * 1000) await fs.promises.rm(p, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
}

// ------------------------------------------------------------------ PNG workers (Node)

const pngWorkers = [];
function pngWorker() {
  let w = pngWorkers.find(x => !x.busy);
  if (!w) {
    w = {
      worker: new Worker(path.join(__dirname, 'engine', 'png-worker.js'), {
        resourceLimits: { maxOldGenerationSizeMb: 1024 },
      }),
      busy: false,
    };
    pngWorkers.push(w);
  }
  return w;
}

function runPNG(original, opts, onProgress) {
  return new Promise((resolve, reject) => {
    const w = pngWorker();
    w.busy = true;
    const done = () => {
      w.worker.off('message', onMessage);
      w.worker.off('error', onError);
      w.worker.off('exit', onExit);
    };
    const retire = () => { const i = pngWorkers.indexOf(w); if (i >= 0) pngWorkers.splice(i, 1); };
    const onMessage = m => {
      if (m.progress !== undefined) return onProgress(m.progress);
      done();
      w.busy = false;
      if (m.error) reject(new Error(m.error));
      else resolve({ data: m.data ? Buffer.from(m.data) : null, detail: m.detail });
    };
    const onError = err => { done(); retire(); reject(new Error(`PNG engine stopped: ${err.message}`)); };
    const onExit = code => { done(); retire(); reject(new Error(`PNG engine stopped (code ${code})`)); };
    w.worker.on('message', onMessage);
    w.worker.on('error', onError);
    w.worker.on('exit', onExit);
    const copy = original.buffer.slice(original.byteOffset, original.byteOffset + original.length);
    w.worker.postMessage({ bytes: copy, opts }, [copy]);
  });
}

// ------------------------------------------------------------------ JPEG jobs (renderer web workers)

const jpegJobs = new Map();
let jobSeq = 1;

function runJPEG(original, opts, onProgress) {
  return new Promise((resolve, reject) => {
    if (!win || win.isDestroyed()) return reject(new Error('Window closed'));
    const id = jobSeq++;
    jpegJobs.set(id, { resolve, reject, onProgress, originalLength: original.length });
    win.webContents.send('jpeg-job', { id, bytes: original, opts });
  });
}

// ------------------------------------------------------------------ PDF (own optimizer, macOS fallback)

const NATIVE_PDF_MAX = 768 * 1024 ** 2;
const pdfWorkers = new Set();

/**
 * Press's own PDF picture optimizer: a worker thread reads the PDF and rewrites it, and
 * each picture is re-encoded by the panel's JPEG engine. Returns null when it can't help
 * (unusual or damaged file, nothing to improve), so the macOS (Quartz) path takes over.
 */
function nativePDF(job, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'engine', 'pdf', 'pdf-worker.js'), {
      resourceLimits: { maxOldGenerationSizeMb: 2048 },
    });
    pdfWorkers.add(worker);
    let finished = false;
    const finish = (fn, v) => {
      if (finished) return;
      finished = true;
      pdfWorkers.delete(worker);
      worker.terminate().catch(() => {});
      fn(v);
    };
    worker.on('message', async m => {
      if (m.progress !== undefined) return onProgress(Math.min(0.97, m.progress));
      if (m.encode !== undefined) {
        let data = null;
        try {
          const r = await runJPEG(Buffer.from(m.bytes), { mode: 'pdf', strength: job.quality, maxDimension: m.maxDimension | 0 }, () => {});
          data = r.data ? r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.length) : null;
        } catch (err) {
          if (/Window closed/.test(err.message)) return finish(reject, err);
          data = null; // this picture stays as it was
        }
        if (!finished) worker.postMessage({ encoded: m.encode, data }, data ? [data] : []);
        return;
      }
      if (!m.done) return;
      if (m.error || m.kept || !m.data || !m.replaced) return finish(resolve, null);
      finish(resolve, m);
    });
    worker.on('error', () => finish(resolve, null));
    worker.on('exit', () => finish(resolve, null));
    fs.promises.readFile(job.src).then(buf => {
      const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
      worker.postMessage({ bytes, opts: { dpi: job.dpi, strength: job.quality, gray: !!job.gray, metadata: job.metadata } }, [bytes]);
    }, err => finish(reject, err));
  });
}

async function runPDF(job, onProgress) {
  if (job.bytes <= NATIVE_PDF_MAX) {
    const res = await nativePDF(job, onProgress);
    if (res) {
      await fs.promises.writeFile(job.dst, Buffer.from(res.data), { flag: 'wx', mode: 0o600 });
      const bits = [
        job.dpi ? `${job.dpi} dpi` : '',
        `${res.replaced} picture${res.replaced === 1 ? '' : 's'}`,
        job.gray ? 'gray' : '',
        `${res.pages} page${res.pages === 1 ? '' : 's'}`,
      ];
      return { detail: bits.filter(Boolean).join(' · '), resized: res.resized > 0 };
    }
  }
  return media.pdf(job, onProgress);
}

function stopPDF() {
  for (const w of pdfWorkers) w.terminate().catch(() => {});
  pdfWorkers.clear();
}

// ------------------------------------------------------------------ IPC from the panel

/** Only the panel page in our own window may talk to the main process. */
function fromPanel(event) {
  return !!win && !win.isDestroyed() && event.sender === win.webContents &&
    !!event.senderFrame && event.senderFrame.url === PANEL_URL;
}
const on = (channel, fn) => ipcMain.on(channel, (event, ...args) => { if (fromPanel(event)) fn(...args); });

on('jpeg-progress', msg => {
  if (!msg || !validate.isId(msg.id) || !validate.isFraction(msg.progress)) return;
  const job = jpegJobs.get(msg.id);
  if (job) job.onProgress(msg.progress);
});

on('jpeg-result', msg => {
  if (!msg || !validate.isId(msg.id)) return;
  const job = jpegJobs.get(msg.id);
  if (!job) return;
  jpegJobs.delete(msg.id);
  if (typeof msg.error === 'string') return job.reject(new Error(msg.error.slice(0, 300)));
  const detail = typeof msg.detail === 'string' ? msg.detail.slice(0, 120) : '';
  if (msg.data == null) return job.resolve({ data: null, detail });
  if (!validate.jpegBytes(msg.data, job.originalLength)) return job.reject(new Error('The JPEG engine returned an invalid file, so nothing was written'));
  job.resolve({ data: Buffer.from(msg.data), detail });
});

on('settings', s => mergeSettings(validate.settings(s)));
on('add-paths', p => { const clean = validate.paths(p); if (clean) addPaths(clean); });
on('clear', () => {
  for (let i = items.length - 1; i >= 0; i--) {
    if (['done', 'kept', 'failed'].includes(items[i].status)) items.splice(i, 1);
  }
  if (!isWorking()) batchStart = null;
  sendUpdate();
});
on('reveal', id => {
  if (!validate.isId(id)) return;
  const item = items.find(i => i.id === id);
  if (item && item.output) shell.showItemInFolder(item.output);
});
ipcMain.handle('choose', event => (fromPanel(event) ? choose() : undefined));

async function choose() {
  if (!win) return;
  const r = await dialog.showOpenDialog(win, {
    buttonLabel: 'Press',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [{ name: 'Images, PDFs, video and audio', extensions: Object.keys(fsafe.KINDS).map(e => e.slice(1)) }],
  });
  if (!r.canceled) addPaths(r.filePaths);
}

// ------------------------------------------------------------------ Panel files

const PANEL_ROOT = __dirname;
const SERVED = /^\/(renderer\/[a-z-]+\.(html|js|css)|engine\/(ssim|resize)\.js)$/;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

async function servePanelFile(request) {
  const url = new URL(request.url);
  if (url.host !== 'press' || !SERVED.test(url.pathname)) return new Response('Not found', { status: 404 });
  const file = path.join(PANEL_ROOT, url.pathname);
  try {
    const body = await fs.promises.readFile(file);
    return new Response(body, { headers: { 'Content-Type': TYPES[path.extname(file)] } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// ------------------------------------------------------------------ App

// One copy at a time: a second launch goes to this window.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

const menuCommand = cmd => { if (win) win.webContents.send('menu', cmd); };
function buildMenu() {
  const name = app.name;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: name, submenu: [
      { label: `About ${name}`, click: () => menuCommand('about') },
      { type: 'separator' },
      { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
      { role: 'quit' },
    ] },
    { label: 'File', submenu: [
      { label: 'Add Files…', accelerator: 'CmdOrCtrl+O', click: () => choose() },
      { type: 'separator' },
      { label: 'Clear Log', accelerator: 'CmdOrCtrl+K', click: () => menuCommand('clear') },
      { label: 'Reset Controls to Defaults', click: () => menuCommand('reset') },
      { type: 'separator' },
      { role: 'close' },
    ] },
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
    { role: 'help', submenu: [{ label: `${name} Help`, click: () => menuCommand('about') }] },
  ]));
}

const pendingOpen = [];
app.on('open-file', (e, p) => {   // Dock-icon drops and "Open With"
  e.preventDefault();
  const clean = validate.paths([p]);
  if (!clean) return;
  if (win) addPaths(clean); else pendingOpen.push(...clean);
});

function lockDownSession() {
  const ses = session.defaultSession;
  // The panel needs no camera, microphone, location, notifications, etc.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // No network: block any request that isn't one of our own panel files.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const u = details.url;
    callback({ cancel: !(u.startsWith(`${APP_ORIGIN}/`) || u.startsWith('blob:') || u.startsWith('data:')) });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, useContentSize: true, resizable: false, fullscreenable: false,
    maximizable: false, titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 12 },
    backgroundColor: '#1b1b1d', show: false, title: 'ProtoArt Press',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false,
      webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, devTools: false,
    },
  });
  // The panel never navigates or opens other windows (e.g. a file dropped outside the drop handler).
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('will-redirect', e => e.preventDefault());
  win.webContents.on('will-attach-webview', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Don't lose a batch by accident.
  win.on('close', e => {
    if (!isWorking()) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Keep Working', 'Quit Anyway'], defaultId: 0, cancelId: 0,
      message: 'ProtoArt Press is still working.',
      detail: 'Files that are finished are already saved. Quitting now stops the rest of the batch.',
    });
    if (choice === 0) e.preventDefault();
  });
  win.loadURL(PANEL_URL);
  win.once('ready-to-show', () => {
    win.show();
    if (pendingOpen.length) addPaths(pendingOpen.splice(0));
  });
  win.on('closed', () => {
    win = null;
    for (const job of jpegJobs.values()) job.reject(new Error('Window closed'));
    jpegJobs.clear();
  });
}

app.whenReady().then(() => {
  protocol.handle('app', servePanelFile);
  sweepOldTemp();
  lockDownSession();
  buildMenu();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { stopPDF(); media.stopAll(); });
