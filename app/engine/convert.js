// CONVERT helpers with no Electron imports (unit-testable): the new file name, and checks on what the panel returns.
'use strict';
const path = require('path');

const MAX_OUT = 1024 ** 3;
const two = n => String(n).padStart(2, '0');
const isoDay = d => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
/** "2026:11:14 12:35:07" (EXIF) → "2026-11-14", else ''. */
const exifDay = v => { const m = /^(\d{4})[:-](\d{2})[:-](\d{2})/.exec(v || ''); return m && m[1] !== '0000' ? `${m[1]}-${m[2]}-${m[3]}` : ''; };

/**
 * The new name from the RENAME pattern: {name} the original name, {#} the file's number in this batch (001…),
 * {date} the day the photo was taken (or the file's date), {w} and {h} the new size. Characters macOS
 * can't use in a name become "-"; an empty result falls back to the original name.
 */
function convertName(pattern, { name, seq, day, width, height, ext }) {
  const base = name.slice(0, name.length - path.extname(name).length);
  let out = String(pattern || '{name}').replace(/\{(name|#|date|w|h)\}/g, (_m, t) =>
    t === 'name' ? base : t === '#' ? String(seq).padStart(3, '0') : t === 'date' ? day : t === 'w' ? String(width) : String(height));
  out = out.replace(/[\/:\\\u0000-\u001f\u007f]/g, '-').replace(/^[.\s]+/, '').trim().slice(0, 150).trim();
  return (out || base || 'picture') + ext;
}

/** The bytes look like the format we asked for. */
function looksLike(format, d) {
  if (!(d instanceof Uint8Array) || d.length < 16 || d.length > MAX_OUT) return false;
  if (format === 'jpeg') return d[0] === 0xff && d[1] === 0xd8 && d[d.length - 2] === 0xff && d[d.length - 1] === 0xd9;
  if (format === 'webp') return String.fromCharCode(...d.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...d.subarray(8, 12)) === 'WEBP';
  return d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47; // PNG (also the step before HEIC / TIFF)
}

module.exports = { convertName, looksLike, exifDay, isoDay, MAX_OUT };
