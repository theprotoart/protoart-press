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
  mode: 'compress',
  convert: { format: 'jpeg', quality: 85, size: 0, fit: 'long', rename: '{name}',
    mark: { on: false, kind: 'text', text: '', pos: 8, opacity: 50, size: 'm', dark: false } },
};
const clone = o => JSON.parse(JSON.stringify(o));

let settings = clone(DEFAULTS);
try {
  const saved = JSON.parse(localStorage.getItem('press-settings-v2') || '{}');
  for (const k of Object.keys(DEFAULTS)) {
    if (saved[k] === undefined) continue;
    settings[k] = typeof DEFAULTS[k] === 'object' ? { ...DEFAULTS[k], ...saved[k] } : saved[k];
  }
  if (saved.convert) settings.convert.mark = { ...DEFAULTS.convert.mark, ...(saved.convert.mark || {}) };
  if (settings.mode !== 'convert') settings.mode = 'compress';
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
  renderMode();
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

// ------------------------------------------------------------------ MODE and the CONVERT unit

// MODE: COMPRESS (the four format modules) or CONVERT (one wide unit: format, size, name, watermark, recipes).
const modeBox = el('div', { id: 'mode' }, $('rack'));
controls.mode = buttonGroup(modeBox, { title: 'Mode', labels: ['COMPRESS', 'CONVERT'], index: settings.mode === 'convert' ? 1 : 0,
  width: 56, lamp: 'green', onChange: i => { settings.mode = i ? 'convert' : 'compress'; saveSettings(); } });
controls.mode.el.title = 'COMPRESS makes files smaller with the four modules. CONVERT changes photos to another format, size or name, and can add a watermark.';

const CV = {
  formats: ['jpeg', 'png', 'heic', 'webp', 'tiff'], formatLabels: ['JPEG', 'PNG', 'HEIC', 'WEBP', 'TIFF'],
  qualities: [60, 70, 80, 85, 90, 95, 100], qualityLabels: ['60', '70', '80', '85', '90', '95', 'MAX'],
  sizes: [0, 3840, 2560, 1920, 1600, 1280, 1080, 800, -50, -25], sizeLabels: ['FULL', '3840', '2560', '1920', '1600', '1280', '1080', '800', '50%', '25%'],
  fits: ['long', 'width', 'height'],
};
const cv = () => settings.convert;
const setCV = (field, value) => { settings.convert = { ...cv(), [field]: value }; saveSettings(); };
const setMark = (field, value) => { settings.convert = { ...cv(), mark: { ...cv().mark, [field]: value } }; saveSettings(); };

const unit = el('div', { class: 'module wide f-graphite', id: 'convert' }, $('rack'));
el('div', { class: 'mscrew t' }, unit).appendChild(screw(14, 52));
el('div', { class: 'mscrew b' }, unit).appendChild(screw(14, -21));
const uhead = el('div', { class: 'mhead' }, unit);
const ulamp = el('span', { class: 'led mini amber mlamp' }, uhead);
el('div', { class: 'mname', text: 'CONVERT' }, uhead);
el('div', { class: 'engr mfmt', text: 'IN: JPG · PNG · HEIC · TIFF · WEBP · AVIF · RAW · PSD' }, uhead);
const ucols = el('div', { class: 'ucols' }, unit);
const ucol = () => el('div', { class: 'ucol' }, ucols);
const usec = (col, title) => { const s = el('div', { class: 'msec' }, col); if (title) el('div', { class: 'engr bg-title', text: title }, s); return s; };

// 1 · format and quality
const c1 = ucol();
controls.cvFormat = buttonGroup(usec(c1), { title: 'Format', labels: CV.formatLabels, index: Math.max(0, CV.formats.indexOf(cv().format)),
  vertical: true, lamp: 'blue', onChange: i => setCV('format', CV.formats[i]) });
controls.cvFormat.el.title = 'JPEG plays everywhere · PNG keeps every pixel and transparency · HEIC is about half the size of JPEG (Apple devices) · WEBP for the web · TIFF for print and editing (lossless).';
const qk = usec(c1);
controls.cvQuality = compactKnob(qk, { title: 'Quality', labels: CV.qualityLabels, index: Math.max(0, CV.qualities.indexOf(cv().quality)),
  size: 40, radius: 40, onChange: i => setCV('quality', CV.qualities[i]), onReset: () => controls.cvQuality.change(CV.qualities.indexOf(85)) });
qk.title = 'Quality for JPEG, HEIC and WEBP (PNG and TIFF are lossless). 85 looks the same as the original for most photos. Double-click to reset.';

// 2 · size
const c2 = ucol();
const sk = usec(c2);
controls.cvSize = compactKnob(sk, { title: 'Size · px', labels: CV.sizeLabels, index: Math.max(0, CV.sizes.indexOf(cv().size)),
  size: 44, radius: 46, onChange: i => setCV('size', CV.sizes[i]), onReset: () => controls.cvSize.change(0) });
sk.title = 'Shrinks pictures to this many pixels (along the side picked below), or to a percentage. FULL keeps the size; nothing is ever enlarged. Double-click to reset.';
controls.cvFit = buttonGroup(usec(c2), { title: 'Fit', labels: ['LONG', 'WIDTH', 'HEIGHT'], index: Math.max(0, CV.fits.indexOf(cv().fit)),
  width: 44, lamp: 'blue', onChange: i => setCV('fit', CV.fits[i]), caption: 'WHICH SIDE THE SIZE MEANS' });
controls.cvFit.el.title = 'LONG: the longer side · WIDTH or HEIGHT: that side, whatever the shape. Percentages scale both.';

// 3 · rename and recipes
const c3 = ucol();
const rn = usec(c3, 'Rename');
const renameIn = el('input', { class: 'dymo', type: 'text', maxlength: 120, spellcheck: 'false' }, rn);
renameIn.value = cv().rename;
const tokRow = el('div', { class: 'tokens' }, rn);
const example = el('div', { class: 'engr example' }, rn);
const renderExample = () => {
  const n = (renameIn.value || '{name}').replace(/\{name\}/g, 'IMG_0042').replace(/\{#\}/g, '001').replace(/\{date\}/g, '2026-11-14')
    .replace(/\{w\}/g, '1920').replace(/\{h\}/g, '1440').replace(/[\/:\\]/g, '-');
  example.textContent = (n.trim() || 'IMG_0042') + ({ jpeg: '.jpg', png: '.png', heic: '.heic', webp: '.webp', tiff: '.tif' }[cv().format] || '');
};
const putToken = t => {
  const a = renameIn.selectionStart ?? renameIn.value.length, b = renameIn.selectionEnd ?? a;
  renameIn.setRangeText(t, a, b, 'end'); renameIn.focus(); renameIn.dispatchEvent(new Event('input'));
};
for (const [label, t, tip] of [['NAME', '{name}', 'The original name'], ['#', '{#}', 'Numbers in the order added: 001, 002…'],
  ['DATE', '{date}', 'The day the photo was taken (or the file’s date)'], ['W×H', '{w}×{h}', 'The new width and height']]) {
  const b = el('button', { class: 'chip', type: 'button', text: label, title: `${tip}: ${t}` }, tokRow);
  b.addEventListener('click', () => putToken(t));
}
renameIn.addEventListener('input', () => {
  const v = renameIn.value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
  if (v !== renameIn.value) renameIn.value = v;
  renderExample(); setCV('rename', v || '{name}');
});
renameIn.title = 'The new name. Use the buttons to add the original name, a number, the date or the size. Existing files are never overwritten in place.';

const rc = usec(c3, 'Recipes');
const recipeSel = el('select', { class: 'dymo' }, rc);
const recipeName = el('input', { class: 'dymo', type: 'text', maxlength: 30, placeholder: 'name this recipe', spellcheck: 'false' }, rc);
const recipeBtns = el('div', { class: 'tokens' }, rc);
const saveB = el('button', { class: 'chip', type: 'button', text: 'SAVE', title: 'Save every CONVERT setting under this name' }, recipeBtns);
const delB = el('button', { class: 'chip', type: 'button', text: 'DELETE', title: 'Delete the chosen recipe' }, recipeBtns);
const loadRecipes = () => { try { const r = JSON.parse(localStorage.getItem('press-recipes') || '[]'); return Array.isArray(r) ? r.filter(x => x && typeof x.name === 'string' && x.convert) : []; } catch { return []; } };
const storeRecipes = r => { try { localStorage.setItem('press-recipes', JSON.stringify(r.slice(0, 30))); } catch {} };
function renderRecipes(selected = '') {
  const list = loadRecipes();
  recipeSel.replaceChildren(el('option', { text: list.length ? 'Choose a recipe…' : 'No recipes yet' }));
  for (const r of list) { const o = el('option', { text: r.name }, recipeSel); o.value = r.name; }
  recipeSel.value = selected;
  if (recipeSel.selectedIndex < 0) recipeSel.selectedIndex = 0;
  delB.disabled = !recipeSel.value || recipeSel.selectedIndex === 0;
}
recipeSel.addEventListener('change', () => {
  const r = loadRecipes().find(x => x.name === recipeSel.value);
  delB.disabled = !r;
  if (!r) return;
  settings.convert = { ...clone(DEFAULTS.convert), ...r.convert, mark: { ...DEFAULTS.convert.mark, ...(r.convert.mark || {}) } };
  recipeName.value = r.name;
  syncConvertControls(); saveSettings();
});
saveB.addEventListener('click', () => {
  const name = recipeName.value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 30) || `Recipe ${loadRecipes().length + 1}`;
  const list = loadRecipes().filter(x => x.name !== name);
  list.push({ name, convert: clone(cv()) });
  list.sort((a, b) => a.name.localeCompare(b.name));
  storeRecipes(list); recipeName.value = name; renderRecipes(name);
});
delB.addEventListener('click', () => {
  const name = recipeSel.value;
  storeRecipes(loadRecipes().filter(x => x.name !== name)); recipeName.value = ''; renderRecipes();
});
rc.title = 'A recipe remembers every CONVERT setting (format, quality, size, name, watermark). Pick one to use it again.';

// 4 · watermark
const c4 = ucol();
const wm = usec(c4);
controls.cvMark = latchButton(wm, { label: 'ON', on: cv().mark.on, lamp: 'amber', title: 'Watermark', onChange: v => setMark('on', v) });
controls.cvKind = buttonGroup(usec(c4), { labels: ['TEXT', 'LOGO'], index: cv().mark.kind === 'logo' ? 1 : 0, width: 48, lamp: 'blue',
  onChange: i => { setMark('kind', i ? 'logo' : 'text'); renderMarkKind(); } });
const markText = el('input', { class: 'dymo', type: 'text', maxlength: 80, placeholder: '© your name', spellcheck: 'false' }, c4);
markText.value = cv().mark.text;
markText.addEventListener('input', () => { const v = markText.value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80); if (v !== markText.value) markText.value = v; setMark('text', v); });
const logoB = el('button', { class: 'chip wide', type: 'button', text: 'CHOOSE LOGO…', title: 'A PNG (transparent background works best) or JPEG' }, c4);
logoB.addEventListener('click', async () => {
  if (!api) return;
  const r = await api.chooseLogo();
  if (r) showLogo(r.logo, r.error);
});
function showLogo(name, error) { logoB.textContent = error ? error.toUpperCase() : name ? name : 'CHOOSE LOGO…'; logoB.classList.toggle('bad', !!error); }
function renderMarkKind() { const logo = cv().mark.kind === 'logo'; markText.hidden = logo; logoB.hidden = !logo; }
const ps = usec(c4, 'Position');
const grid = el('div', { class: 'posgrid' }, ps);
const posBtns = Array.from({ length: 9 }, (_, i) => {
  const b = el('button', { class: 'pbtn lamp-amber', type: 'button', title: ['Top left', 'Top', 'Top right', 'Left', 'Centre', 'Right', 'Bottom left', 'Bottom', 'Bottom right'][i] }, grid);
  el('span', { class: 'cap-face' }, b);
  b.addEventListener('click', () => { setMark('pos', i); renderPos(); });
  return b;
});
const renderPos = () => posBtns.forEach((b, i) => b.classList.toggle('lit', i === cv().mark.pos));
controls.cvOpacity = buttonGroup(usec(c4), { title: 'Opacity', labels: ['25', '50', '75', '100'], index: Math.max(0, [25, 50, 75, 100].indexOf(cv().mark.opacity)),
  width: 30, onChange: i => setMark('opacity', [25, 50, 75, 100][i]) });
const sz = el('div', { class: 'pairs' }, c4);
controls.cvMarkSize = buttonGroup(sz, { title: 'Size', labels: ['S', 'M', 'L'], index: Math.max(0, ['s', 'm', 'l'].indexOf(cv().mark.size)),
  width: 22, onChange: i => setMark('size', ['s', 'm', 'l'][i]) });
controls.cvInk = buttonGroup(sz, { title: 'Ink', labels: ['LIGHT', 'DARK'], index: cv().mark.dark ? 1 : 0, width: 38, lamp: 'blue',
  onChange: i => setMark('dark', i === 1) });
c4.title = 'A watermark on every converted picture: your text, or a logo, in a corner or the centre.';

/** After a recipe or RESET: every CONVERT control shows the settings. */
function syncConvertControls() {
  const c = cv();
  controls.cvFormat.set(Math.max(0, CV.formats.indexOf(c.format)));
  controls.cvQuality.set(Math.max(0, CV.qualities.indexOf(c.quality)));
  controls.cvSize.set(Math.max(0, CV.sizes.indexOf(c.size)));
  controls.cvFit.set(Math.max(0, CV.fits.indexOf(c.fit)));
  renameIn.value = c.rename; renderExample();
  controls.cvMark.set(c.mark.on);
  controls.cvKind.set(c.mark.kind === 'logo' ? 1 : 0);
  markText.value = c.mark.text;
  controls.cvOpacity.set(Math.max(0, [25, 50, 75, 100].indexOf(c.mark.opacity)));
  controls.cvMarkSize.set(Math.max(0, ['s', 'm', 'l'].indexOf(c.mark.size)));
  controls.cvInk.set(c.mark.dark ? 1 : 0);
  renderMarkKind(); renderPos();
}
renderExample(); renderMarkKind(); renderPos(); renderRecipes();
if (api && api.convertInfo) api.convertInfo().then(r => r && showLogo(r.logo));

/** Shows the four modules or the CONVERT unit, and labels the shared controls for the mode. */
function renderMode() {
  const convert = settings.mode === 'convert';
  $('modules').hidden = convert;
  unit.hidden = !convert;
  controls.saving.el.classList.toggle('dim', convert);
  controls.output.el.querySelector('.bg-caption').textContent = convert ? 'COPY → "CONVERTED" FOLDER' : 'COPY → "PRESSED" FOLDER';
  controls.meta.el.querySelector('.bg-caption').textContent = convert ? 'CAMERA DETAILS: JPEG → JPEG ONLY' : 'NO GPS REMOVES LOCATION ONLY';
  $('brand').querySelector('.paint.small').textContent = convert ? 'Model PA-2 · Media Converter' : 'Model PA-2 · Media Compressor';
  renderEmptyTapes();
  renderExample();
}

function renderModules() {
  for (const m of MODULES) moduleEls[m.key].mod.classList.toggle('off', !settings[m.key].on);
}

function updateModuleLamps(items) {
  for (const m of MODULES) {
    const busy = items.some(i => i.status === 'working' && m.badges.includes(i.badge));
    moduleEls[m.key].lamp.classList.toggle('on', busy);
  }
  ulamp.classList.toggle('on', items.some(i => i.status === 'working' && i.converted));
}

// ------------------------------------------------------------------ Masking tape

const tapes = $('tapes');
function placeTape(t, x, y) { t.style.left = x + 'px'; t.style.top = y + 'px'; tapes.appendChild(t); return t; }
const trashTape = placeTape(tape('originals → Trash!', { size: 11.5, angle: -4, seed: 33 }), 624, 708);
trashTape.classList.add('fade');
const emptyTapes = $('log-empty');
let tapesFor = '';
function renderEmptyTapes() {
  const convert = settings.mode === 'convert';
  if (tapesFor === settings.mode) return;
  tapesFor = settings.mode;
  emptyTapes.replaceChildren(
    tape(convert ? 'drop photos here' : 'drop files here', { size: 25, angle: -3, seed: 3 }),
    tape(convert ? 'HEIC · JPG · PNG · TIFF · WebP · RAW' : 'images · PDFs · video · audio', { size: 15, angle: 2.5, seed: 9 }),
    tape('…or a whole folder. or hit LOAD', { size: 13, angle: -1.5, seed: 14 }));
}

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
      case 'done': detail = `${fmt(it.originalBytes)} → ${fmt(it.newBytes)}  ${it.detail}`; result = it.converted ? (pct >= 0 ? `−${pct}%` : `+${-pct}%`) : `−${pct}%`; cls = 'good'; led = 'green'; break;
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
  const finish = settings.finish, mode = settings.mode;
  settings = clone(DEFAULTS);
  if (finish) settings.finish = finish;
  settings.mode = mode; // RESET keeps the mode you're in (and your saved recipes)
  for (const c of Object.values(controls.modules)) c.reset();
  syncConvertControls();
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

// ------------------------------------------------------------------ CONVERT worker pool

const cworkers = [new Worker('convert-worker.js'), new Worker('convert-worker.js')].map(w => ({ w, busy: false }));
const cjobs = [];
function dispatchConvert() {
  for (const slot of cworkers) {
    if (slot.busy || !cjobs.length) continue;
    const job = cjobs.shift();
    slot.busy = true;
    slot.w.onmessage = e => {
      const m = e.data;
      if (!m.done) return api.convertProgress(job.id, m.progress);
      slot.busy = false;
      api.convertResult(job.id, m.error ? { error: m.error } : m.kept ? { kept: m.kept }
        : { data: new Uint8Array(m.data), width: m.width, height: m.height, taken: m.taken, carried: m.carried, note: m.note });
      dispatchConvert();
    };
    const bytes = job.bytes.buffer.slice(job.bytes.byteOffset, job.bytes.byteOffset + job.bytes.byteLength);
    const logo = job.logo ? job.logo.buffer.slice(job.logo.byteOffset, job.logo.byteOffset + job.logo.byteLength) : null;
    slot.w.postMessage({ id: job.id, bytes, opts: job.opts, logo }, logo ? [bytes, logo] : [bytes]);
  }
}

// ------------------------------------------------------------------ Go

if (api) {
  api.onQueue(q => { queue = q; renderLog(); updateMeters(); });
  api.onJpegJob(job => { jobs.push(job); dispatch(); });
  if (api.onConvertJob) api.onConvertJob(job => { cjobs.push(job); dispatchConvert(); });
}
window.__preview = q => { queue = q; renderLog(); updateMeters(); };
saveSettings();
updateMeters();
})();
