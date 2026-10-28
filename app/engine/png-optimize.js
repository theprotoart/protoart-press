// PNG pipeline: lossless re-encode always; palette reduction only when it measures as invisible.
'use strict';
const png = require('./png');
const SSIM = require('./ssim');
const Resize = require('./resize');

// Fixed limits (no near-lossless baseline exists for PNG). Calibrated: UI
// screenshots/icons ≈ 0.9995+, smooth gradients ≈ 0.983 worst region, photos ≈ 0.97.
const LIMITS = {
  gentle: null, // lossless only
  balanced: { minMean: 0.995, minWorst: 0.985, maxShift: 1.0 },
  aggressive: { minMean: 0.990, minWorst: 0.975, maxShift: 1.5 },
};

const COLOR_CHUNKS = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM']);
const TEXT_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt']);

function isXMP(c) {
  return c.type === 'iTXt' && c.data.toString('latin1', 0, 17) === 'XML:com.adobe.xmp';
}

function carriedChunks(chunks, metadata, scale) {
  const out = [];
  for (const c of chunks) {
    if (COLOR_CHUNKS.has(c.type)) out.push(c);
    else if (c.type === 'pHYs') {
      const d = Buffer.from(c.data);
      if (scale < 1) {
        d.writeUInt32BE(Math.max(1, Math.round(d.readUInt32BE(0) * scale)), 0);
        d.writeUInt32BE(Math.max(1, Math.round(d.readUInt32BE(4) * scale)), 4);
      }
      out.push({ type: 'pHYs', data: d });
    } else if (metadata === 'keep' && (TEXT_CHUNKS.has(c.type) || c.type === 'eXIf' || c.type === 'tIME')) out.push(c);
    else if (metadata === 'noGPS' && TEXT_CHUNKS.has(c.type) && !isXMP(c)) out.push(c);
  }
  // sRGB and iCCP are mutually exclusive; prefer the explicit profile.
  if (out.some(c => c.type === 'iCCP')) return out.filter(c => c.type !== 'sRGB');
  return out;
}

function looksIdentical(a, b, w, h, opaque, limits) {
  for (const bg of opaque ? [255] : [255, 0]) {
    const s = SSIM.compare(SSIM.lumaFromRGBA(a, w, h, bg), SSIM.lumaFromRGBA(b, w, h, bg), w, h);
    if (s.mean < limits.minMean || s.worstRegion < limits.minWorst || s.worstShift > limits.maxShift) return false;
  }
  return true;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * opts: { strength, reducePNG, maxDimension, minimumSavings, metadata }
 * Returns { data: Buffer|null, detail }.
 */
function optimize(original, opts, progress = () => {}) {
  let head;
  try {
    head = png.peek(original);
  } catch (err) {
    if (err instanceof png.TooLargeError) return { data: null, detail: 'Too large to process safely, kept as is' };
    throw err;
  }
  if (head.animated) return { data: null, detail: 'Animated PNG, kept as is' };
  if (head.bitDepth > 8) return { data: null, detail: '16-bit PNG, kept as is' };

  const decoded = png.decode(original);
  progress(0.15);
  const fitted = Resize.fit(decoded.rgba, decoded.width, decoded.height, opts.maxDimension);
  const { width: w, height: h } = fitted;
  const pixels = fitted.rgba;
  // Fully transparent pixels are invisible; normalize them so they compress
  // better and don't count as extra colors.
  let opaque = true;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] !== 255) opaque = false;
    if (pixels[i] === 0) { pixels[i - 3] = 0; pixels[i - 2] = 0; pixels[i - 1] = 0; }
  }
  const resized = fitted.scale < 1;
  const sizeNote = resized ? ` · ${Math.max(w, h)}px` : '';
  const extra = carriedChunks(decoded.chunks, opts.metadata, fitted.scale);
  const allowGray = !extra.some(c => c.type === 'iCCP');
  progress(0.25);

  const candidates = [];
  candidates.push({ data: png.encode(pixels, w, h, { extra, allowGray }), pixels, detail: 'Lossless' + sizeNote });
  progress(0.55);

  const limits = LIMITS[opts.strength];
  if (opts.reducePNG && limits) {
    const reduced = png.quantize(pixels);
    progress(0.7);
    if (reduced && looksIdentical(pixels, reduced.rgba, w, h, opaque, limits)) {
      candidates.push({
        data: png.encode(reduced.rgba, w, h, { extra, allowGray }),
        pixels: reduced.rgba,
        detail: `${reduced.colorCount} colors${sizeNote}`,
      });
    }
  }
  progress(0.9);

  candidates.sort((a, b) => a.data.length - b.data.length);
  for (const c of candidates) {
    if (!resized && c.data.length > original.length * (1 - opts.minimumSavings)) break;
    // Decode what we wrote and confirm it is exactly the pixels we meant.
    const check = png.decode(c.data);
    if (check.width === w && check.height === h && sameBytes(check.rgba, c.pixels)) {
      return { data: c.data, detail: c.detail };
    }
  }
  return { data: null, detail: 'Already optimal' };
}

module.exports = { optimize };
