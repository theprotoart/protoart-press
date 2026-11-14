// Validation for everything that crosses from the panel (renderer) into the main process.
'use strict';
const path = require('path');

const STRENGTH = ['gentle', 'balanced', 'aggressive'];
const ENUMS = {
  outputMode: ['copy', 'replace'],
  metadata: ['keep', 'noGPS', 'stripAll'],
  mode: ['compress', 'convert'],
};
// CONVERT's controls. size: pixels, or a negative number for a percentage.
const CONVERT = {
  format: ['jpeg', 'png', 'heic', 'webp', 'tiff'],
  quality: [60, 70, 80, 85, 90, 95, 100],
  size: [0, 3840, 2560, 1920, 1600, 1280, 1080, 800, -50, -25],
  fit: ['long', 'width', 'height'],
};
const MARK = { kind: ['text', 'logo'], pos: [0, 1, 2, 3, 4, 5, 6, 7, 8], opacity: [25, 50, 75, 100], size: ['s', 'm', 'l'] };
/** Free text from the panel: a short single line with no control characters. */
const line = (v, max) => (typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : undefined);
const SIZE_STOPS = [0, 3840, 2560, 2048, 1920, 1600, 1280, 1024];
const SAVING_STOPS = [1, 3, 5, 10];
const BOOL = 'bool';
// Every control on every module, with the values it may take.
const MODULES = {
  image: { on: BOOL, strength: STRENGTH, maxDimension: SIZE_STOPS, reducePNG: BOOL },
  pdf: { on: BOOL, quality: STRENGTH, dpi: [0, 300, 220, 150, 110, 72], gray: BOOL },
  video: { on: BOOL, quality: STRENGTH, maxEdge: [0, 3840, 2560, 1920, 1280, 960], codec: ['hevc', 'h264'] },
  audio: { on: BOOL, quality: STRENGTH, sampleRate: [0, 48000, 44100, 32000, 22050], lossless: BOOL },
};
const MAX_PATHS = 10000;

const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

/** Returns a cleaned partial settings object containing only known, valid keys. */
function settings(input) {
  const out = {};
  if (!isPlainObject(input)) return out;
  const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined); // never read inherited values
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (allowed.includes(own(input, key))) out[key] = input[key];
  }
  if (SAVING_STOPS.includes(own(input, 'minimumSavingsPercent'))) out.minimumSavingsPercent = input.minimumSavingsPercent;
  for (const [mod, fields] of Object.entries(MODULES)) {
    const sub = own(input, mod);
    if (!isPlainObject(sub)) continue;
    const clean = {};
    for (const [key, allowed] of Object.entries(fields)) {
      const v = own(sub, key);
      if (allowed === BOOL ? typeof v === 'boolean' : allowed.includes(v)) clean[key] = v;
    }
    if (Object.keys(clean).length) out[mod] = clean;
  }
  const conv = own(input, 'convert');
  if (isPlainObject(conv)) {
    const clean = {};
    for (const [key, allowed] of Object.entries(CONVERT)) if (allowed.includes(own(conv, key))) clean[key] = conv[key];
    const rename = line(own(conv, 'rename'), 120);
    if (rename !== undefined) clean.rename = rename;
    const mark = own(conv, 'mark');
    if (isPlainObject(mark)) {
      const m = {};
      for (const [key, allowed] of Object.entries(MARK)) if (allowed.includes(own(mark, key))) m[key] = mark[key];
      for (const key of ['on', 'dark']) if (typeof own(mark, key) === 'boolean') m[key] = mark[key];
      const text = line(own(mark, 'text'), 80);
      if (text !== undefined) m.text = text;
      if (Object.keys(m).length) clean.mark = m;
    }
    if (Object.keys(clean).length) out.convert = clean;
  }
  return out;
}

/** Array of absolute path strings, or null. */
function paths(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_PATHS) return null;
  const out = [];
  for (const p of input) {
    if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p.includes('\0') || !path.isAbsolute(p)) return null;
    out.push(path.normalize(p));
  }
  return out;
}

const isId = v => Number.isSafeInteger(v) && v > 0;
const isFraction = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * A JPEG produced by the panel must start with SOI and end with EOI and be a
 * plausible size relative to the original. Anything else is rejected.
 */
function jpegBytes(data, originalLength) {
  if (!(data instanceof Uint8Array) || data.length < 4) return false;
  if (data.length > originalLength * 4 + 1024 * 1024) return false;
  return data[0] === 0xff && data[1] === 0xd8 && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9;
}

module.exports = { settings, paths, isId, isFraction, jpegBytes, ENUMS, MODULES, SIZE_STOPS, SAVING_STOPS, CONVERT, MARK };
