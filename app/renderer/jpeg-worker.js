// JPEG optimizer, run as a Web Worker inside the app window (uses Chromium's codecs).
'use strict';
importScripts('../engine/ssim.js', '../engine/resize.js');

// Damage allowed relative to this photo's own near-lossless baseline.
// Calibrated with libjpeg-turbo: 10× ≈ q90, 15× ≈ q85, 21× ≈ q80.
const ALLOWANCE = { gentle: 10, balanced: 15, aggressive: 21 };
// Pictures inside PDFs: the same perceptual search, with a quality floor so smooth or
// downsampled pictures (whose baseline damage is tiny) don't slide to blocky settings.
// PDF Squeezer Medium writes q75; Acrobat's "medium" is about q70.
const PDF_ALLOWANCE = { gentle: 12, balanced: 18, aggressive: 26 };
const PDF_FLOOR_Q = { gentle: 0.80, balanced: 0.75, aggressive: 0.56 };
const BASELINE_Q = 0.96, LOWEST_Q = 0.30, STEPS = 7;
const MAX_PIXELS = 150_000_000; // refuse before decoding: a small file can claim huge dimensions

// ------------------------------------------------------------ JPEG segments

/** Splits a JPEG into its header segments (before SOS) and the rest. */
function parseJPEG(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a JPEG');
  const segments = [];
  let p = 2, components = 0, width = 0, height = 0;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) throw new Error('Corrupt JPEG');
    const marker = bytes[p + 1];
    if (marker === 0xff) { p++; continue; }
    if (marker === 0xda) break; // SOS: entropy data follows
    const len = (bytes[p + 2] << 8) | bytes[p + 3];
    if (len < 2 || p + 2 + len > bytes.length) throw new Error('Corrupt JPEG');
    const seg = { marker, data: bytes.subarray(p, p + 2 + len) };
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      height = (bytes[p + 5] << 8) | bytes[p + 6];
      width = (bytes[p + 7] << 8) | bytes[p + 8];
      components = bytes[p + 9];
    }
    segments.push(seg);
    p += 2 + len;
  }
  return { segments, bodyStart: p, components, width, height };
}

function startsWith(seg, text) {
  for (let i = 0; i < text.length; i++) if (seg.data[4 + i] !== text.charCodeAt(i)) return false;
  return true;
}

const isAPP0 = s => s.marker === 0xe0;
const isEXIF = s => s.marker === 0xe1 && startsWith(s, 'Exif\0\0');
const isXMP = s => s.marker === 0xe1 && startsWith(s, 'http://ns.adobe.com/');
const isICC = s => s.marker === 0xe2 && startsWith(s, 'ICC_PROFILE\0');
const isIPTC = s => s.marker === 0xed;

/**
 * Returns a cleaned copy of an EXIF APP1 segment: orientation reset to 1
 * (pixels are stored upright), and optionally the GPS IFD emptied.
 * Returns null if the EXIF can't be parsed, so it gets dropped rather than
 * risk carrying a stale rotation or a location.
 */
function cleanEXIF(seg, removeGPS) {
  const d = Uint8Array.from(seg.data);
  const t = 10; // after FFE1, length, "Exif\0\0"
  const little = d[t] === 0x49;
  const u16 = o => (little ? d[o] | (d[o + 1] << 8) : (d[o] << 8) | d[o + 1]);
  const u32 = o => (little ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0
    : ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0);
  const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
  try {
    const w16 = (o, v) => { if (little) { d[o] = v & 255; d[o + 1] = v >> 8; } else { d[o] = v >> 8; d[o + 1] = v & 255; } };
    const ifd0 = t + u32(t + 4);
    const n0 = u16(ifd0);
    for (let i = 0; i < n0; i++) {
      const e = ifd0 + 2 + i * 12;
      if (u16(e) === 0x0112) w16(e + 8, 1); // Orientation: normal
      if (!removeGPS || u16(e) !== 0x8825) continue;
      const gps = t + u32(e + 8);
      const n = u16(gps);
      for (let k = 0; k < n; k++) {
        const g = gps + 2 + k * 12;
        const size = (SIZES[u16(g + 2)] || 1) * u32(g + 4);
        if (size > 4) {
          const at = t + u32(g + 8);
          if (at + size <= d.length) d.fill(0, at, at + size);
        }
      }
      d.fill(0, gps, Math.min(d.length, gps + 2 + n * 12 + 4)); // zero entries; count 0, no next IFD
    }
    return { marker: seg.marker, data: d };
  } catch {
    return null; // unreadable EXIF: drop it rather than risk leaking location
  }
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Rebuilds the encoder's output with the metadata segments we chose. */
function assemble(encoded, carried) {
  const parsed = parseJPEG(encoded);
  const keepFromEncoder = parsed.segments.filter(s => s.marker < 0xe0 || s.marker > 0xef); // DQT, SOF, DHT...
  const encoderAPP0 = parsed.segments.find(isAPP0);
  const app0 = carried.app0 || encoderAPP0;
  return concat([
    new Uint8Array([0xff, 0xd8]),
    ...(app0 ? [app0.data] : []),
    ...carried.segments.map(s => s.data),
    ...keepFromEncoder.map(s => s.data),
    encoded.subarray(parsed.bodyStart),
  ]);
}

// ------------------------------------------------------------ Pixels

async function decodeToRGBA(blob) {
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: 'none', premultiplyAlpha: 'none', imageOrientation: 'from-image',
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { rgba: new Uint8Array(img.data.buffer), width: img.width, height: img.height };
}

async function encodeJPEG(rgba, width, height, quality) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

// ------------------------------------------------------------ Optimize

/** Shared quality search: the smallest JPEG whose damage stays within k× the baseline's. */
async function search(rgba, w, h, k, progress, lowest = LOWEST_Q) {
  const reference = PressSSIM.lumaFromRGBA(rgba, w, h, 255);
  const total = STEPS + 1;
  async function score(bytes) {
    const d = await decodeToRGBA(new Blob([bytes], { type: 'image/jpeg' }));
    return PressSSIM.compare(reference, PressSSIM.lumaFromRGBA(d.rgba, w, h, 255), w, h);
  }
  const baselineData = await encodeJPEG(rgba, w, h, BASELINE_Q);
  const baseline = await score(baselineData);
  progress(1 / total);
  const maxMean = Math.max((1 - baseline.mean) * k, 0.002);
  const maxRegion = Math.max((1 - baseline.worstRegion) * k, 0.004);
  let best = { data: baselineData, q: BASELINE_Q };
  let lo = lowest, hi = BASELINE_Q;
  for (let i = 0; i < STEPS; i++) {
    const mid = (lo + hi) / 2;
    const data = await encodeJPEG(rgba, w, h, mid);
    const s = await score(data);
    if (1 - s.mean <= maxMean && 1 - s.worstRegion <= maxRegion) {
      if (data.length < best.data.length) best = { data, q: mid };
      hi = mid;
    } else lo = mid;
    progress((i + 2) / total);
  }
  return best;
}

/**
 * A picture taken out of a PDF (a JPEG, or a BMP holding raw pixels): resized to the
 * size it needs at the chosen dpi, then re-encoded. No metadata is carried.
 */
async function optimizePicture(original, opts, progress) {
  const isJPEG = original[0] === 0xff && original[1] === 0xd8;
  const isBMP = original[0] === 0x42 && original[1] === 0x4d;
  if (!isJPEG && !isBMP) throw new Error('Unknown picture data');
  if (isJPEG) {
    const parsed = parseJPEG(original);
    if (parsed.components !== 1 && parsed.components !== 3) return { data: null, detail: 'kept' };
    if (parsed.width * parsed.height > MAX_PIXELS) return { data: null, detail: 'kept' };
  }
  const src = await decodeToRGBA(new Blob([original], { type: isJPEG ? 'image/jpeg' : 'image/bmp' }));
  const fitted = PressResize.fit(src.rgba, src.width, src.height, opts.maxDimension || 0);
  for (let i = 3; i < fitted.rgba.length; i += 4) fitted.rgba[i] = 255;
  const strength = PDF_ALLOWANCE[opts.strength] ? opts.strength : 'balanced';
  const lowest = PDF_FLOOR_Q[strength];
  let best = await search(fitted.rgba, fitted.width, fitted.height, PDF_ALLOWANCE[strength], progress, lowest);
  // The bisection only probes midpoints; if every probe passed, try the floor itself.
  if (best.q < lowest + 0.02) {
    const data = await encodeJPEG(fitted.rgba, fitted.width, fitted.height, lowest);
    if (data.length < best.data.length) best = { data, q: lowest };
  }
  return { data: best.data, detail: `Quality ${Math.round(best.q * 100)}` };
}

async function optimize(original, opts, progress) {
  if (opts.mode === 'pdf') return optimizePicture(original, opts, progress);
  const parsed = parseJPEG(original);
  if (parsed.components === 4) return { data: null, detail: 'CMYK JPEG, kept as is' };
  if (!parsed.width || !parsed.height) throw new Error('Not a readable JPEG');
  if (parsed.width * parsed.height > MAX_PIXELS) return { data: null, detail: 'Too large to process safely, kept as is' };

  // Chromium applies the EXIF rotation when decoding, so pixels are stored
  // upright and any kept EXIF gets its orientation reset to normal.
  const src = await decodeToRGBA(new Blob([original], { type: 'image/jpeg' }));
  const fitted = PressResize.fit(src.rgba, src.width, src.height, opts.maxDimension);
  const { width: w, height: h } = fitted;
  for (let i = 3; i < fitted.rgba.length; i += 4) fitted.rgba[i] = 255;

  const carried = { app0: null, segments: [] };
  const segs = parsed.segments;
  if (fitted.scale === 1) carried.app0 = segs.find(isAPP0) || null;
  if (opts.metadata !== 'stripAll') {
    for (const s of segs.filter(isEXIF)) {
      const clean = cleanEXIF(s, opts.metadata === 'noGPS');
      if (clean) carried.segments.push(clean);
    }
  }
  if (opts.metadata === 'keep') carried.segments.push(...segs.filter(isXMP));
  carried.segments.push(...segs.filter(isICC)); // color profile always stays
  if (opts.metadata === 'keep') carried.segments.push(...segs.filter(isIPTC));

  const best = await search(fitted.rgba, w, h, ALLOWANCE[opts.strength] || ALLOWANCE.balanced, progress);

  const result = assemble(best.data, carried);
  const resized = fitted.scale < 1;
  if (!resized && result.length > original.length * (1 - opts.minimumSavings)) {
    return { data: null, detail: 'Already optimal' };
  }
  // Make sure the final file decodes at the expected size.
  const check = await decodeToRGBA(new Blob([result], { type: 'image/jpeg' }));
  if (check.width !== w || check.height !== h) throw new Error('Verification failed');
  const sizeNote = resized ? ` · ${Math.max(w, h)}px` : '';
  return { data: result, detail: `Quality ${Math.round(best.q * 100)}${sizeNote}` };
}

self.onmessage = async (e) => {
  const { id, bytes, opts } = e.data;
  try {
    const res = await optimize(new Uint8Array(bytes), opts, f => self.postMessage({ id, progress: f }));
    const buffer = res.data ? res.data.buffer.slice(res.data.byteOffset, res.data.byteOffset + res.data.length) : null;
    self.postMessage({ id, done: true, data: buffer, detail: res.detail }, buffer ? [buffer] : []);
  } catch (err) {
    self.postMessage({ id, done: true, error: String(err && err.message || err) });
  }
};
