// Front-panel controller: the four format modules, settings, queue display, meters, and the JPEG worker pool.
(() => {
'use strict';
const { el, screw, sevenSegment, tape, VUMeter, compactKnob, buttonGroup, latchButton } = window.Parts;
const $ = id => document.getElementById(id);
const api = window.press || null; // null when previewed outside the app

// ------------------------------------------------------------------ Settings

const STRENGTHS = ['gentle', 'balanced', 'aggressive'];
const METADATA = ['keep', 'noGPS', 'stripAll'];
const SAVINGS = [1, 3, 5, 10];
const DEFAULTS = {
  minimumSavingsPercent: 3, outputMode: 'copy', metadata: 'noGPS',
  image: { on: true, strength: 'balanced', maxDimension: 0, reducePNG: true },
  pdf: { on: true, quality: 'balanced', dpi: 150, gray: false },
  video: { on: true, quality: 'balanced', maxEdge: 0, codec: 'hevc' },
  audio: { on: true, quality: 'balanced', sampleRate: 0, lossless: false },
};
const clone = o => JSON.parse(JSON.stringify(o));

let settings = clone(DEFAULTS);
try {
  const saved = JSON.parse(localStorage.getItem('press-settings-v2') || '{}');
  for (const k of Object.keys(DEFAULTS)) {
    if (saved[k] === undefined) continue;
    settings[k] = typeof DEFAULTS[k] === 'object' ? { ...DEFAULTS[k], ...saved[k] } : saved[k];
  }
  if (saved.finish) settings.finish = saved.finish;
  else { const old = JSON.parse(localStorage.getItem('press-settings') || '{}'); if (old.finish) settings.finish = old.finish; }
} catch {}
function saveSettings() {
  try { localStorage.setItem('press-settings-v2', JSON.stringify(settings)); } catch {}
  if (api) {
    const { finish, ...forMain } = settings;
    api.setSettings(forMain);
  }
  renderTapes();
  renderModules();
}

// ------------------------------------------------------------------ Build the panel

const W = 1180, H = 780;
const DEFAULT_FINISH = 'black';
function applyFinish() {
  const finish = settings.finish === 'silver' ? 'silver' : DEFAULT_FINISH;
  document.body.classList.toggle('finish-black', finish === 'black');
  PressTexture.drawFaceplate($('metal'), W, H, 0x50524553, finish);
}
applyFinish();

// Rack-ear screws, each turned a little differently.
document.querySelectorAll('.slot').forEach((slot, i) => slot.appendChild(screw(24, [33, -12, 71, 8][i])));

// Brand plate: corner screws and worn anodizing.
(() => {
  const brand = $('brand');
  [[5, 5, 10], [229, 5, 47], [5, 131, 84], [229, 131, 121]].forEach(([x, y, a]) => {
    const s = screw(10, a); s.style.left = x + 'px'; s.style.top = y + 'px'; brand.appendChild(s);
  });
  const c = el('canvas', { class: 'scuffs' }, brand);
  const dpr = window.devicePixelRatio || 1;
  c.width = 244 * dpr; c.height = 146 * dpr; c.style.width = '244px'; c.style.height = '146px';
  const ctx = c.getContext('2d'); ctx.scale(dpr, dpr);
  const rng = PressTexture.seededRandom(77);
  for (let i = 0; i < 26; i++) {
    const x = rng() * 244, y = rng() * 146, a = rng.range(-0.5, 0.5), len = rng.range(4, 40);
    ctx.strokeStyle = `rgba(255,255,255,${rng.range(0.04, 0.14)})`; ctx.lineWidth = rng.range(0.4, 0.9);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); ctx.stroke();
  }
  for (let i = 0; i < 6; i++) {
    const top = rng.chance(0.5);
    ctx.fillStyle = 'rgba(180,180,180,0.35)';
    ctx.fillRect(rng() * 230, top ? 0 : 143, rng.range(6, 26), rng.range(1.5, 3));
  }
})();

const vu = new VUMeter($('vu-canvas'), 280, 148, $('vu'));

// ------------------------------------------------------------------ Modules

// One hardware module per format: IN button, quality buttons, one stepped knob, one blue button pair.
const MODULES = [
  { key: 'image', name: 'IMAGE', fmt: 'JPG · PNG', finish: 'graphite', badges: ['IMG'],
    quality: { field: 'strength', title: 'Strength' },
    knob: { field: 'maxDimension', title: 'Max size · px', labels: ['FULL', '3840', '2560', '1920', '1600', '1280', '1024'], values: [0, 3840, 2560, 1920, 1600, 1280, 1024] },
    pair: { field: 'reducePNG', title: 'PNG', labels: ['LOSSLESS', 'REDUCE'], values: [false, true] },
    hints: {
      quality: 'How much measurable change is allowed. All three aim to look identical: about JPEG quality 90 / 85 / 80.',
      knob: 'Shrinks images whose long edge is bigger than this. FULL keeps the original size.',
      pair: 'LOSSLESS keeps every pixel; REDUCE allows 256 colors when that is invisible (screenshots, graphics).',
    } },
  { key: 'pdf', name: 'PDF', fmt: 'TEXT STAYS SHARP', finish: 'slate', badges: ['PDF'],
    quality: { field: 'quality', title: 'Image quality' },
    knob: { field: 'dpi', title: 'Resolution · dpi', labels: ['KEEP', '300', '220', '150', '110', '72'], values: [0, 300, 220, 150, 110, 72] },
    pair: { field: 'gray', title: 'Color', labels: ['KEEP', 'GRAY'], values: [false, true] },
    hints: {
      quality: 'How hard the pictures inside the PDF are compressed. Text and drawings are never touched.',
      knob: 'Caps picture resolution. 150 dpi suits screens and office printing; 300 keeps print quality.',
      pair: 'GRAY makes every picture black-and-white (one channel), which saves a lot of space. Text keeps its color.',
    } },
  { key: 'video', name: 'VIDEO', fmt: 'MP4 · MOV · M4V', finish: 'bone', badges: ['VID'],
    quality: { field: 'quality', title: 'Quality' },
    knob: { field: 'maxEdge', title: 'Resolution', labels: ['KEEP', '4K', '1440', '1080', '720', '540'], values: [0, 3840, 2560, 1920, 1280, 960] },
    pair: { field: 'codec', title: 'Codec', labels: ['H.264', 'HEVC'], values: ['h264', 'hevc'] },
    hints: {
      quality: 'Picture quality of the re-encode. The sound is copied untouched.',
      knob: 'Scales video down to this size. KEEP never changes it, and nothing is ever enlarged.',
      pair: 'HEVC is about a third smaller; H.264 plays on everything, including old devices.',
    } },
  { key: 'audio', name: 'AUDIO', fmt: 'WAV · AIFF · FLAC · MP3', finish: 'oxblood', badges: ['AUD'],
    quality: { field: 'quality', title: 'Quality', subs: ['256k', '192k', '128k'] },
    knob: { field: 'sampleRate', title: 'Sample rate', labels: ['KEEP', '48k', '44.1', '32k', '22k'], values: [0, 48000, 44100, 32000, 22050] },
    pair: { field: 'lossless', title: 'Format', labels: ['AAC', 'LOSSLESS'], values: [false, true] },
    hints: {
      quality: 'AAC bitrate for stereo (mono files get half). Ignored when FORMAT is LOSSLESS.',
      knob: 'Lowers the sample rate. KEEP never changes it; nothing is ever raised.',
      pair: 'AAC is small and plays everywhere; LOSSLESS (Apple Lossless) is bit-perfect, about half the size of WAV.',
    } },
];

const controls = { modules: {} };
const moduleEls = {};
for (const m of MODULES) {
  const conf = () => settings[m.key];
  const set = (field, value) => { settings[m.key] = { ...conf(), [field]: value }; saveSettings(); };
  const mod = el('div', { class: `module f-${m.finish}` }, $('modules'));
  el('div', { class: 'mscrew t' }, mod).appendChild(screw(14, 20 + m.name.length * 13));
  el('div', { class: 'mscrew b' }, mod).appendChild(screw(14, -35 + m.name.length * 7));
  const head = el('div', { class: 'mhead' }, mod);
  const lamp = el('span', { class: 'led mini amber mlamp' }, head);
  el('div', { class: 'mname', text: m.name }, head);
  el('div', { class: 'engr mfmt', text: m.fmt }, head);
  moduleEls[m.key] = { mod, lamp };

  const c = {};
  const sec = () => el('div', { class: 'msec' }, mod);
  c.on = latchButton(sec(), { label: 'IN', on: conf().on, lamp: 'green', title: 'Module in',
    onChange: v => set('on', v) });
  c.on.el.title = `IN: when lit, ${m.name.toLowerCase()} files are pressed. Switch it off to skip them.`;
  c.quality = buttonGroup(sec(), { title: m.quality.title, labels: ['GENTLE', 'BALANCED', 'AGGRESSIVE'], subs: m.quality.subs,
    index: Math.max(0, STRENGTHS.indexOf(conf()[m.quality.field])), vertical: true,
    onChange: i => set(m.quality.field, STRENGTHS[i]),
    onReset: () => c.quality.change(STRENGTHS.indexOf(DEFAULTS[m.key][m.quality.field])) });
  c.quality.el.title = m.hints.quality;
  const ks = sec();
  c.knob = compactKnob(ks, { title: m.knob.title, labels: m.knob.labels, index: Math.max(0, m.knob.values.indexOf(conf()[m.knob.field])),
    size: 42, radius: 42, onChange: i => set(m.knob.field, m.knob.values[i]),
    onReset: () => c.knob.change(m.knob.values.indexOf(DEFAULTS[m.key][m.knob.field])) });
  ks.title = m.knob.title + ': ' + m.hints.knob + ' Double-click to reset.';
  c.pair = buttonGroup(sec(), { title: m.pair.title, labels: m.pair.labels, index: Math.max(0, m.pair.values.indexOf(conf()[m.pair.field])),
    width: 58, lamp: 'blue', onChange: i => set(m.pair.field, m.pair.values[i]) });
  c.pair.el.title = m.hints.pair;
  c.reset = () => {
    const d = DEFAULTS[m.key];
    c.on.set(d.on);
    c.quality.set(STRENGTHS.indexOf(d[m.quality.field]));
    c.knob.set(m.knob.values.indexOf(d[m.knob.field]));
    c.pair.set(m.pair.values.indexOf(d[m.pair.field]));
  };
  controls.modules[m.key] = c;
}

// The global row: minimum saving, output, metadata.
const g = $('globals');
controls.saving = buttonGroup(g, { title: 'Minimum saving', labels: SAVINGS.map(v => v + '%'), index: Math.max(0, SAVINGS.indexOf(settings.minimumSavingsPercent)),
  width: 38, lamp: 'amber', caption: 'IF A FILE SHRINKS LESS, THE ORIGINAL IS KEPT',
  onChange: i => { settings.minimumSavingsPercent = SAVINGS[i]; saveSettings(); } });
controls.saving.el.title = 'Minimum saving: a result has to be at least this much smaller to be used. Otherwise the original is kept as is (KEPT in the log). Quality is never affected.';
controls.output = buttonGroup(g, { title: 'Output', labels: ['COPY', 'REPLACE'], index: settings.outputMode === 'replace' ? 1 : 0,
  width: 56, lamp: 'blue', caption: 'COPY → "PRESSED" FOLDER',
  onChange: i => { settings.outputMode = i ? 'replace' : 'copy'; saveSettings(); } });
controls.output.el.title = 'COPY writes results into a "Pressed" folder beside the originals. REPLACE swaps files in place and moves the originals to the Trash.';
controls.meta = buttonGroup(g, { title: 'Metadata', labels: ['KEEP', 'NO GPS', 'STRIP'], index: Math.max(0, METADATA.indexOf(settings.metadata)),
  width: 48, lamp: 'red', caption: 'NO GPS REMOVES LOCATION ONLY',
  onChange: i => { settings.metadata = METADATA[i]; saveSettings(); } });
controls.meta.el.title = 'KEEP everything · NO GPS removes only the location · STRIP removes camera, date, location and document info.';

function renderModules() {
  for (const m of MODULES) moduleEls[m.key].mod.classList.toggle('off', !settings[m.key].on);
}

function updateModuleLamps(items) {
  for (const m of MODULES) {
    const busy = items.some(i => i.status === 'working' && m.badges.includes(i.badge));
    moduleEls[m.key].lamp.classList.toggle('on', busy);
  }
}

// ------------------------------------------------------------------ Masking tape

const tapes = $('tapes');
function placeTape(t, x, y) { t.style.left = x + 'px'; t.style.top = y + 'px'; tapes.appendChild(t); return t; }
const trashTape = placeTape(tape('originals → Trash!', { size: 11.5, angle: -4, seed: 33 }), 624, 708);
trashTape.classList.add('fade');
const emptyTapes = $('log-empty');
emptyTapes.appendChild(tape('drop files here', { size: 25, angle: -3, seed: 3 }));
emptyTapes.appendChild(tape('images · PDFs · video · audio', { size: 15, angle: 2.5, seed: 9 }));
emptyTapes.appendChild(tape('…or a whole folder. or hit LOAD', { size: 13, angle: -1.5, seed: 14 }));

function renderTapes() {
  trashTape.classList.toggle('hidden', settings.outputMode !== 'replace');
}

// ------------------------------------------------------------------ Readouts

function setSeg(id, text) {
  const host = $(id);
  if (host.dataset.text === text) return;
  host.dataset.text = text;
  host.replaceChildren(sevenSegment(text, 24));
}

let queue = { items: [], batchStart: null, working: false };

function batchProgress() {
  const batch = queue.items.filter(i => i.batch);
  if (!batch.length) return 0;
  let total = 0, done = 0;
  for (const i of batch) {
    const w = Math.max(i.originalBytes, 1);
    const c = i.status === 'queued' ? 0 : i.status === 'working' ? i.progress : 1;
    total += w; done += w * c;
  }
  return done / total;
}

function updateMeters() {
  const items = queue.items;
  const finished = items.filter(i => ['done', 'kept', 'failed'].includes(i.status));
  const saved = items.reduce((n, i) => n + (i.status === 'done' ? i.originalBytes - i.newBytes : 0), 0);
  const origTotal = finished.reduce((n, i) => n + i.originalBytes, 0);

  // Time left
  let time = '00:00';
  if (queue.working) {
    const p = batchProgress();
    const elapsed = (Date.now() - (queue.batchStart || Date.now())) / 1000;
    if (p > 0.02 && elapsed > 1) {
      const s = Math.min(Math.round((elapsed * (1 - p)) / p), 99 * 60 + 59);
      time = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    } else time = '--:--';
  }
  setSeg('ro-time', time);

  const mb = saved / 1e6;
  if (mb >= 1000) { setSeg('ro-saved', (mb / 1000).toFixed(2)); $('ro-saved-unit').textContent = 'GB'; }
  else { setSeg('ro-saved', mb.toFixed(1)); $('ro-saved-unit').textContent = 'MB'; }
  setSeg('ro-pct', origTotal ? String(Math.round((saved / origTotal) * 100)) : '0');

  // LEDs
  $('led-power').classList.add('on');
  const active = $('led-active'); active.classList.add('blink'); active.classList.toggle('on', queue.working);
  $('led-done').classList.toggle('on', !queue.working && finished.length > 0);
  $('led-fault').classList.toggle('on', items.some(i => i.status === 'failed'));

  updateModuleLamps(items);
  updateVU();
}

// VU: lamp on and needle tracking overall completion while working. When a
// batch finishes the needle holds at 100 for a moment, then the lamp goes out
// and the needle falls back to rest.
let wasWorking = false, holdUntil = 0, holdTimer = null;
function updateVU() {
  if (queue.working) {
    wasWorking = true; holdUntil = 0;
    vu.set(batchProgress(), true);
    return;
  }
  if (wasWorking) {
    wasWorking = false;
    holdUntil = Date.now() + 1800;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(updateVU, 1850);
  }
  if (Date.now() < holdUntil) vu.set(1, true);
  else vu.set(0, false);
}
setInterval(updateMeters, 1000);

// ------------------------------------------------------------------ Session log

const list = $('log-list');
const rows = new Map();
const fmt = n => (n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B');

function rowFor(item) {
  let r = rows.get(item.id);
  if (!r) {
    const root = el('div', { class: 'row' });
    const led = el('span', { class: 'led mini amber' }, root);
    const mid = el('div', {}, root);
    const name = el('div', { class: 'name' }, mid);
    const badge = el('span', { class: 'badge' }, name);
    const label = el('span', {}, name);
    const detail = el('div', { class: 'detail' }, mid);
    const result = el('div', { class: 'result' }, root);
    root.addEventListener('dblclick', () => api && r.hasOutput && api.reveal(item.id));
    r = { root, led, name, badge, label, detail, result, hasOutput: false };
    rows.set(item.id, r);
    list.appendChild(root);
  }
  return r;
}

function renderLog() {
  const items = queue.items;
  $('log-empty').style.display = items.length ? 'none' : 'flex';
  const live = new Set(items.map(i => i.id));
  for (const [id, r] of rows) if (!live.has(id)) { r.root.remove(); rows.delete(id); }
  let firstWorking = null;
  for (const it of items) {
    const r = rowFor(it);
    r.hasOutput = it.hasOutput;
    r.badge.textContent = it.badge || '';
    const sameBase = it.outputName && it.outputName.replace(/\.[^.]*$/, '') === it.name.replace(/\.[^.]*$/, '');
    r.label.textContent = !it.outputName ? it.name : sameBase ? `${it.name} → ${it.outputName.slice(it.outputName.lastIndexOf('.'))}` : `${it.name} → ${it.outputName}`;
    const pct = Math.round((1 - it.newBytes / Math.max(it.originalBytes, 1)) * 100);
    let detail = fmt(it.originalBytes), result = '', cls = '', led = 'amber', on = true, blink = false;
    switch (it.status) {
      case 'queued': result = 'WAIT'; on = false; break;
      case 'working': result = `${Math.round(it.progress * 100)}%`; blink = true; firstWorking = firstWorking || r.root; break;
      case 'done': detail = `${fmt(it.originalBytes)} → ${fmt(it.newBytes)}  ${it.detail}`; result = `−${pct}%`; cls = 'good'; led = 'green'; break;
      case 'kept': detail = `${fmt(it.originalBytes)}  ${it.detail}`; result = 'KEPT'; break;
      case 'failed': detail = it.detail; result = 'FAULT'; cls = 'bad'; led = 'red'; break;
    }
    r.detail.textContent = detail;
    r.result.textContent = result;
    r.result.className = 'result ' + cls;
    r.led.className = `led mini ${led}${on ? ' on' : ''}${blink ? ' blink' : ''}`;
    r.root.title = it.status === 'failed' || it.status === 'kept' ? it.detail : it.hasOutput ? 'Double-click to show in Finder' : '';
  }
  if (firstWorking) {
    const lt = list.getBoundingClientRect(), rt = firstWorking.getBoundingClientRect();
    if (rt.bottom > lt.bottom || rt.top < lt.top) firstWorking.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// ------------------------------------------------------------------ Files in

const log = $('log');
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; log.classList.add('target'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; log.classList.remove('target'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; log.classList.remove('target');
  if (api && e.dataTransfer.files.length) api.addFiles([...e.dataTransfer.files]);
});
$('btn-load').addEventListener('click', () => api && api.choose());
$('btn-clear').addEventListener('click', () => api && api.clear());

// RESET: every control back to its default (the panel finish is a preference and stays).
function resetAll() {
  const finish = settings.finish;
  settings = clone(DEFAULTS);
  if (finish) settings.finish = finish;
  for (const c of Object.values(controls.modules)) c.reset();
  controls.saving.set(SAVINGS.indexOf(DEFAULTS.minimumSavingsPercent));
  controls.output.set(DEFAULTS.outputMode === 'replace' ? 1 : 0);
  controls.meta.set(METADATA.indexOf(DEFAULTS.metadata));
  saveSettings();
}
$('btn-reset').addEventListener('click', resetAll);
if (api && api.onMenu) api.onMenu(cmd => {
  if (cmd === 'about') showAbout(true);
  else if (cmd === 'reset') resetAll();
  else if (cmd === 'clear') api.clear();
});

// Operator's card
const about = $('about');
const sandboxNote = $('about-sandbox');
if (sandboxNote) sandboxNote.textContent = api ? (api.sandboxed ? 'Image decoding is sandboxed.' : 'Warning: sandbox is off.') : '';
function showAbout(show) {
  about.hidden = !show;
  about.querySelectorAll('[data-finish]').forEach(b => b.classList.toggle('sel', b.dataset.finish === (settings.finish || DEFAULT_FINISH)));
}
$('btn-about').addEventListener('click', () => showAbout(true));
$('about-close').addEventListener('click', () => showAbout(false));
about.addEventListener('click', e => { if (e.target === about) showAbout(false); });
window.addEventListener('keydown', e => { if (e.key === 'Escape' && !about.hidden) showAbout(false); });
about.querySelectorAll('[data-finish]').forEach(b => b.addEventListener('click', () => {
  settings.finish = b.dataset.finish; saveSettings(); applyFinish(); showAbout(true);
}));

// Short hover hints on the meters.
const HINTS = {
  'vu': 'Overall completion of the current batch. Lit while working.',
  'readouts': 'Time left in this batch, space saved this session, and overall reduction.',
  'leds': 'Power · Active (working) · Done (batch finished) · Fault (a file failed)',
};
for (const [id, text] of Object.entries(HINTS)) $(id).title = text;

// ------------------------------------------------------------------ JPEG worker pool

const workers = [new Worker('jpeg-worker.js'), new Worker('jpeg-worker.js')].map(w => ({ w, busy: false }));
const jobs = [];
function dispatch() {
  for (const slot of workers) {
    if (slot.busy || !jobs.length) continue;
    const job = jobs.shift();
    slot.busy = true;
    slot.w.onmessage = e => {
      const m = e.data;
      if (!m.done) return api.jpegProgress(job.id, m.progress);
      slot.busy = false;
      api.jpegResult(job.id, m.error ? { error: m.error } : { data: m.data ? new Uint8Array(m.data) : null, detail: m.detail });
      dispatch();
    };
    const bytes = job.bytes.buffer.slice(job.bytes.byteOffset, job.bytes.byteOffset + job.bytes.byteLength);
    slot.w.postMessage({ id: job.id, bytes, opts: job.opts }, [bytes]);
  }
}

// ------------------------------------------------------------------ Go

if (api) {
  api.onQueue(q => { queue = q; renderLog(); updateMeters(); });
  api.onJpegJob(job => { jobs.push(job); dispatch(); });
}
window.__preview = q => { queue = q; renderLog(); updateMeters(); };
saveSettings();
updateMeters();
})();
