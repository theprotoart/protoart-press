// JPEG optimizer, run as a Web Worker inside the app window (uses Chromium's codecs).
'use strict';
importScripts('../engine/ssim.js', '../engine/resize.js', 'jpeg-meta.js');

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
