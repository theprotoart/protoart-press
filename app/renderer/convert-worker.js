// CONVERT, run as a Web Worker inside the app window (Chromium's codecs): decode a picture upright, resize it,
// add a watermark, and encode it as JPEG, PNG or WebP (or a PNG that macOS turns into HEIC or TIFF).
'use strict';
importScripts('../engine/resize.js', 'jpeg-meta.js');

const MAX_PIXELS = 150_000_000; // refuse before decoding where the header says how big it is
const TYPES = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const MARK_SIZE = { s: 0.035, m: 0.05, l: 0.075 };   // text height, as a share of the short edge
const LOGO_SIZE = { s: 0.12, m: 0.18, l: 0.26 };     // logo width, as a share of the short edge

/** Width × height from a PNG's IHDR or a JPEG's SOF, so a small file claiming huge dimensions is refused early. */
function headerSize(bytes, type) {
  if (type === 'image/png' && bytes.length > 24 && bytes[12] === 0x49 && bytes[13] === 0x48) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (type === 'image/jpeg') { try { const p = parseJPEG(bytes); return { width: p.width, height: p.height }; } catch { return null; } }
  return null;
}

/** "2026:11:14 12:35:07" → "2026-11-14" from a JPEG's EXIF (DateTimeOriginal, else DateTime), or ''. */
function jpegTaken(segments) {
  const s = segments.find(isEXIF);
  if (!s) return '';
  const d = s.data, t = 10;
  if (d.length < t + 8) return '';
  const little = d[t] === 0x49;
  const u16 = o => (little ? d[o] | (d[o + 1] << 8) : (d[o] << 8) | d[o + 1]);
  const u32 = o => (little ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0
    : ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0);
  const ascii = (e) => { const n = u32(e + 4), at = n > 4 ? t + u32(e + 8) : e + 8; let r = ''; for (let i = 0; i < Math.min(n, 32) && at + i < d.length; i++) { const c = d[at + i]; if (!c) break; r += String.fromCharCode(c); } return r; };
  const scan = (ifd, tag) => {
    if (ifd + 2 > d.length) return null;
    const n = u16(ifd);
    for (let i = 0; i < n && ifd + 2 + i * 12 + 12 <= d.length; i++) { const e = ifd + 2 + i * 12; if (u16(e) === tag) return e; }
    return null;
  };
  try {
    const ifd0 = t + u32(t + 4);
    let value = '';
    const exifPtr = scan(ifd0, 0x8769);
    if (exifPtr) { const e = scan(t + u32(exifPtr + 8), 0x9003); if (e) value = ascii(e); }
    if (!value) { const e = scan(ifd0, 0x0132); if (e) value = ascii(e); }
    const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(value);
    return m && m[1] !== '0000' ? `${m[1]}-${m[2]}-${m[3]}` : '';
  } catch { return ''; }
}

/** The scale (≤ 1, never enlarging) that a SIZE setting asks for. size > 0: pixels; size < 0: percent. */
function scaleFor(w, h, size, fit) {
  if (!size) return 1;
  if (size < 0) return Math.min(1, -size / 100);
  const edge = fit === 'width' ? w : fit === 'height' ? h : Math.max(w, h);
  return Math.min(1, size / edge);
}

/** Corner, edge or centre: 0 1 2 / 3 4 5 / 6 7 8. Returns the top-left for a box of bw × bh. */
function place(pos, w, h, bw, bh, margin) {
  const col = pos % 3, row = Math.floor(pos / 3);
  const x = col === 0 ? margin : col === 1 ? (w - bw) / 2 : w - margin - bw;
  const y = row === 0 ? margin : row === 1 ? (h - bh) / 2 : h - margin - bh;
  return [Math.round(x), Math.round(y)];
}

async function drawMark(ctx, w, h, mark, logo) {
  if (!mark || !mark.on) return '';
  const short = Math.min(w, h), margin = Math.round(short * 0.03);
  const pos = Number.isInteger(mark.pos) && mark.pos >= 0 && mark.pos <= 8 ? mark.pos : 8;
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0.05, (mark.opacity || 50) / 100));
  if (mark.kind === 'logo') {
    if (!logo) { ctx.restore(); return 'no logo chosen'; }
    const bmp = await createImageBitmap(new Blob([logo]));
    const lw = Math.max(8, Math.round(short * (LOGO_SIZE[mark.size] || LOGO_SIZE.m)));
    const lh = Math.max(1, Math.round((bmp.height / bmp.width) * lw));
    const [x, y] = place(pos, w, h, lw, lh, margin);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, x, y, lw, lh);
    bmp.close();
  } else {
    const text = String(mark.text || '').slice(0, 80).trim();
    if (!text) { ctx.restore(); return ''; }
    const px = Math.max(10, Math.round(short * (MARK_SIZE[mark.size] || MARK_SIZE.m)));
    ctx.font = `600 ${px}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    ctx.textBaseline = 'top';
    const tw = Math.min(w - 2 * margin, ctx.measureText(text).width);
    const [x, y] = place(pos, w, h, tw, px, margin);
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = Math.max(1, px * 0.12); ctx.shadowOffsetY = Math.max(1, px * 0.04);
    ctx.fillStyle = mark.dark ? '#111' : '#fff';
    ctx.fillText(text, x, y, w - 2 * margin);
  }
  ctx.restore();
  return '';
}

async function convert(bytes, opts, logo, progress) {
  const type = opts.srcType;
  const hs = headerSize(bytes, type);
  if (hs && hs.width * hs.height > MAX_PIXELS) return { kept: 'Too large to process safely, kept as is' };
  let segments = [];
  if (type === 'image/jpeg') { try { segments = parseJPEG(bytes).segments; } catch { segments = []; } }
  const taken = jpegTaken(segments);

  // Decode upright, in sRGB (the standard for sharing), straight alpha.
  const bmp = await createImageBitmap(new Blob([bytes], { type }), { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
  const W0 = bmp.width, H0 = bmp.height;
  if (W0 * H0 > MAX_PIXELS) { bmp.close(); return { kept: 'Too large to process safely, kept as is' }; }
  const c0 = new OffscreenCanvas(W0, H0);
  const x0 = c0.getContext('2d', { willReadFrequently: true });
  x0.drawImage(bmp, 0, 0);
  bmp.close();
  progress(0.25);
  let rgba = new Uint8Array(x0.getImageData(0, 0, W0, H0).data.buffer), w = W0, h = H0;
  const s = scaleFor(W0, H0, opts.size, opts.fit);
  if (s < 1) {
    const r = PressResize.fit(rgba, W0, H0, Math.max(1, Math.round(Math.max(W0, H0) * s)));
    rgba = r.rgba; w = r.width; h = r.height;
  }
  progress(0.55);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const out = opts.format;            // 'jpeg' | 'png' | 'webp'
  if (out === 'jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); } // JPEG has no transparency: white behind
  const layer = new OffscreenCanvas(w, h);
  layer.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), w, h), 0, 0);
  ctx.drawImage(layer, 0, 0);
  const note = await drawMark(ctx, w, h, opts.mark, logo);
  progress(0.75);

  const quality = Math.min(1, Math.max(0.3, (opts.quality || 85) / 100));
  const blob = await canvas.convertToBlob({ type: TYPES[out] || TYPES.png, ...(out === 'png' ? {} : { quality }) });
  let data = new Uint8Array(await blob.arrayBuffer());
  if (blob.type !== (TYPES[out] || TYPES.png)) throw new Error(`This Mac can't write ${String(out).toUpperCase()} here`);

  // JPEG → JPEG: carry the camera details the METADATA switch allows (orientation reset: pixels are upright).
  let carried = false;
  if (out === 'jpeg' && segments.length && opts.metadata !== 'stripAll') {
    const keep = { app0: null, segments: [] };
    for (const seg of segments.filter(isEXIF)) { const c = cleanEXIF(seg, opts.metadata === 'noGPS'); if (c) keep.segments.push(c); }
    if (opts.metadata === 'keep') keep.segments.push(...segments.filter(isXMP), ...segments.filter(isIPTC));
    if (keep.segments.length) { data = assemble(data, keep); carried = true; }
  }
  progress(0.95);
  return { data, width: w, height: h, taken, carried, note };
}

self.onmessage = async (e) => {
  const { id, bytes, opts, logo } = e.data;
  try {
    const r = await convert(new Uint8Array(bytes), opts || {}, logo ? new Uint8Array(logo) : null, f => self.postMessage({ id, progress: f }));
    if (r.kept) return self.postMessage({ id, done: true, kept: r.kept });
    const buffer = r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.length);
    self.postMessage({ id, done: true, data: buffer, width: r.width, height: r.height, taken: r.taken, carried: r.carried, note: r.note }, [buffer]);
  } catch (err) {
    self.postMessage({ id, done: true, error: String((err && err.message) || err) });
  }
};
