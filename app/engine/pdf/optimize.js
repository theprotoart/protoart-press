// ProtoArt Press PDF picture optimizer. Finds every picture in a PDF, works out how large
// it is actually shown on the page, and has each one resized (to the chosen dpi) and
// re-encoded by the same perceptual JPEG search Press uses for photos. Text, fonts and
// vector drawings are copied untouched. Runs inside a worker thread.
'use strict';
const { toGray } = require('./jpeg-gray');
const { PDFDoc, Lexer, EOF, Name, Ref, Stream, Keyword, isName, decodeStream, filtersOf, write } = require('./objects');

const MAX_OPS = 3e6;          // content-stream operators examined per document
const MAX_PIXELS = 100e6;     // pictures larger than this are left alone
const MIN_BYTES = 6 * 1024;   // pictures smaller than this aren't worth re-encoding
const RESIZE_MARGIN = 1.1;    // only downsample when at least 10% above the target dpi

const mul = (m, c) => [
  m[0] * c[0] + m[1] * c[2], m[0] * c[1] + m[1] * c[3],
  m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3],
  m[4] * c[0] + m[5] * c[2] + c[4], m[4] * c[1] + m[5] * c[3] + c[5],
];
const IDENTITY = [1, 0, 0, 1, 0, 0];

/**
 * Walks page content and records, per image object number, the largest size it is drawn
 * at (in inches). Form XObjects are followed with their own matrix and resources.
 */
function placements(doc) {
  const sizes = new Map();     // num -> { w, h } inches
  const unknown = new Set();   // images on pages whose content couldn't be read
  let ops = 0;
  const resolve = v => doc.resolve(v);

  const walk = (content, resources, ctm, depth) => {
    if (depth > 12 || ops > MAX_OPS) return;
    const xobjects = resolve(resources instanceof Map ? resources.get('XObject') : null);
    const lx = new Lexer(content);
    const stack = [], gs = [];
    let cur = ctm;
    for (;;) {
      const save = lx.p;
      let t;
      try { t = lx.token(); } catch { break; }
      if (t === EOF) break;
      if (t instanceof Keyword) {
        if (t.v === '[' || t.v === '<<') { lx.p = save; try { stack.push(lx.object()); } catch { break; } continue; }
        ops++;
        switch (t.v) {
          case 'q': gs.push(cur); break;
          case 'Q': cur = gs.length ? gs.pop() : ctm; break;
          case 'cm': if (stack.length >= 6 && stack.slice(-6).every(n => typeof n === 'number')) cur = mul(stack.slice(-6), cur); break;
          case 'BI': { // inline image: skip its data
            const id = content.indexOf('ID', lx.p, 'latin1');
            if (id < 0) return;
            let p = id + 3;
            for (;;) {
              const e = content.indexOf('EI', p, 'latin1');
              if (e < 0) { lx.p = content.length; break; }
              const before = content[e - 1], after = content[e + 2];
              if ((before === 10 || before === 13 || before === 32) && (after === undefined || after === 10 || after === 13 || after === 32)) { lx.p = e + 2; break; }
              p = e + 2;
            }
            break;
          }
          case 'Do': {
            const name = stack[stack.length - 1];
            if (!(name instanceof Name) || !(xobjects instanceof Map)) break;
            const ref = xobjects.get(name.v);
            const x = resolve(ref);
            if (!(x instanceof Stream)) break;
            const sub = x.dict.get('Subtype');
            if (isName(sub, 'Image') && ref instanceof Ref) {
              const w = Math.hypot(cur[0], cur[1]) / 72, h = Math.hypot(cur[2], cur[3]) / 72;
              const prev = sizes.get(ref.num) || { w: 0, h: 0 };
              sizes.set(ref.num, { w: Math.max(prev.w, w), h: Math.max(prev.h, h) });
            } else if (isName(sub, 'Form')) {
              const m = resolve(x.dict.get('Matrix'));
              const fm = Array.isArray(m) && m.length === 6 && m.every(n => typeof n === 'number') ? m : IDENTITY;
              let data; try { data = decodeStream(doc, x, 64 * 1024 * 1024); } catch { break; }
              walk(data, resolve(x.dict.get('Resources')) || resources, mul(fm, cur), depth + 1);
            }
            break;
          }
          default: break;
        }
        stack.length = 0;
      } else stack.push(t);
    }
  };

  const pages = doc.pages();
  for (const pg of pages) {
    const contents = resolve(pg.dict.get('Contents'));
    const list = Array.isArray(contents) ? contents : [contents];
    const parts = [];
    let ok = true;
    for (const c of list) {
      const s = resolve(c);
      if (!(s instanceof Stream)) continue;
      try { parts.push(decodeStream(doc, s, 128 * 1024 * 1024)); parts.push(Buffer.from('\n')); } catch { ok = false; }
    }
    if (ok) walk(Buffer.concat(parts), pg.resources, IDENTITY, 0);
    else {
      const xo = resolve(pg.resources instanceof Map ? pg.resources.get('XObject') : null);
      if (xo instanceof Map) for (const v of xo.values()) if (v instanceof Ref) unknown.add(v.num);
    }
  }
  return { sizes, unknown, pageCount: pages.length };
}

/** Color model of an image's ColorSpace: 'rgb', 'gray', or null (left alone). */
function colorModel(doc, cs) {
  cs = doc.resolve(cs);
  if (isName(cs, 'DeviceRGB') || isName(cs, 'RGB')) return 'rgb';
  if (isName(cs, 'DeviceGray') || isName(cs, 'G')) return 'gray';
  if (Array.isArray(cs) && cs[0] instanceof Name) {
    if (cs[0].v === 'CalRGB') return 'rgb';
    if (cs[0].v === 'CalGray') return 'gray';
    if (cs[0].v === 'ICCBased') {
      const s = doc.resolve(cs[1]);
      const n = s instanceof Stream ? s.dict.get('N') : 0;
      return n === 3 ? 'rgb' : n === 1 ? 'gray' : null;
    }
  }
  return null;
}

/** Removes APP1 (EXIF/XMP) segments, which PDF ignores but decoders might apply. */
function stripApp1(jpeg) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  const parts = [jpeg.subarray(0, 2)];
  let p = 2;
  while (p + 4 <= jpeg.length && jpeg[p] === 0xff) {
    const m = jpeg[p + 1];
    if (m === 0xda) break;
    const len = (jpeg[p + 2] << 8) | jpeg[p + 3];
    if (len < 2 || p + 2 + len > jpeg.length) return null;
    if (m !== 0xe1) parts.push(jpeg.subarray(p, p + 2 + len));
    p += 2 + len;
  }
  parts.push(jpeg.subarray(p));
  return Buffer.concat(parts);
}

/** 24-bit BMP (which Chromium decodes as is) holding raw 8-bit RGB or gray pixels. */
function bmp(data, W, H, ch) {
  const row = (W * 3 + 3) & ~3, size = 54 + row * H;
  const b = Buffer.alloc(size);
  b.write('BM', 0, 'latin1'); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(W, 18); b.writeInt32LE(-H, 22); // top-down rows
  b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(row * H, 34);
  for (let y = 0; y < H; y++) {
    let o = 54 + y * row, j = y * W * ch;
    for (let x = 0; x < W; x++, j += ch, o += 3) {
      if (ch === 3) { b[o] = data[j + 2]; b[o + 1] = data[j + 1]; b[o + 2] = data[j]; }
      else b[o] = b[o + 1] = b[o + 2] = data[j];
    }
  }
  return b;
}

/** Width/height from a JPEG's frame header. */
function jpegSize(b) {
  let p = 2;
  while (p + 9 < b.length && b[p] === 0xff) {
    const m = b[p + 1], len = (b[p + 2] << 8) | b[p + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[p + 5] << 8) | b[p + 6], w: (b[p + 7] << 8) | b[p + 8], comps: b[p + 9] };
    p += 2 + len;
  }
  return null;
}

/**
 * What can be done with one image object: returns a job for the encoder, or a reason it's skipped.
 * job: { kind: 'jpeg' | 'bmp', bytes, maxDimension }.
 */
function prepare(doc, num, s, place, dpi, unknownPlacement) {
  const d = s.dict;
  if (d.get('ImageMask') === true || d.has('Decode') || d.has('Mask')) return { skip: 'mask or decode array' };
  const W = doc.resolve(d.get('Width')), H = doc.resolve(d.get('Height')), bpc = doc.resolve(d.get('BitsPerComponent'));
  if (!(W > 0 && H > 0) || W * H > MAX_PIXELS) return { skip: 'size' };
  if (s.raw.length < MIN_BYTES) return { skip: 'tiny' };
  const model = colorModel(doc, d.get('ColorSpace'));
  if (!model) return { skip: 'color space' };
  const fs = filtersOf(d);
  let job;
  const last = fs[fs.length - 1];
  if (last === 'DCTDecode' || last === 'DCT') {
    const data = decodeStream(doc, s, 256 * 1024 * 1024, fs.length - 1);
    const stripped = stripApp1(data);
    const info = stripped && jpegSize(stripped);
    if (!info || (info.comps !== 1 && info.comps !== 3)) return { skip: 'jpeg type' };
    job = { kind: 'jpeg', bytes: stripped };
  } else if (bpc === 8) {
    const ch = model === 'rgb' ? 3 : 1;
    const data = decodeStream(doc, s, W * H * ch + 16 * H + 1024);
    if (data.length < W * H * ch) return { skip: 'short data' };
    job = { kind: 'bmp', bytes: bmp(data, W, H, ch) };
  } else return { skip: 'filter' };

  let maxDimension = 0;
  const smask = doc.resolve(d.get('SMask'));
  const matte = smask instanceof Stream && smask.dict.has('Matte'); // soft mask must keep matching size
  if (dpi > 0 && !matte && place && !unknownPlacement && place.w > 0 && place.h > 0) {
    const scale = Math.max((place.w * dpi) / W, (place.h * dpi) / H);
    if (scale < 1 / RESIZE_MARGIN) maxDimension = Math.max(16, Math.round(Math.max(W, H) * scale));
  }
  return { job: { ...job, maxDimension }, model, W, H };
}

/**
 * opts: { dpi, strength, metadata }. encode(job) -> Promise<Uint8Array|null> (JPEG).
 * Returns { data, pages, pictures, replaced, resized } or { kept }.
 */
async function optimize(buf, opts, encode, progress = () => {}) {
  const doc = new PDFDoc(buf);
  if (doc.trailer.has('Encrypt')) return { kept: 'Password-protected PDF, kept as is' };
  const { sizes, unknown, pageCount } = placements(doc);
  if (!pageCount) return { kept: 'No pages found, kept as is' };

  const nums = [...new Set([...sizes.keys(), ...unknown])];
  const replace = new Map();
  let done = 0, replaced = 0, resized = 0;
  for (const num of nums) {
    const s = doc.get(num);
    if (s instanceof Stream && isName(s.dict.get('Subtype'), 'Image')) {
      let prep;
      try { prep = prepare(doc, num, s, sizes.get(num), opts.dpi, unknown.has(num) && !sizes.has(num)); } catch { prep = { skip: 'unreadable' }; }
      if (prep.job) {
        let out = await encode({ ...prep.job, strength: opts.strength });
        // Gray pictures (or every picture, with GRAY on) become one-channel JPEGs: the
        // colour channels are dropped losslessly, keeping the luminance exactly.
        if (out) {
          const gray = toGray(out, { force: prep.model === 'gray' || !!opts.gray });
          if (gray && gray.length < out.length) out = gray;
        }
        const info = out && jpegSize(out);
        if (out && info && out.length < s.raw.length * 0.95) {
          const d = new Map(s.dict);
          for (const k of ['Filter', 'DecodeParms', 'DP', 'Length', 'DL', 'F', 'FFilter', 'FDecodeParms']) d.delete(k);
          d.set('Filter', new Name('DCTDecode'));
          d.set('Width', info.w); d.set('Height', info.h); d.set('BitsPerComponent', 8);
          if (info.comps === 1) d.set('ColorSpace', new Name('DeviceGray'));
          else if (prep.model === 'gray') d.set('ColorSpace', new Name('DeviceRGB'));
          d.delete('Intent'); d.delete('Interpolate');
          replace.set(num, new Stream(d, Buffer.from(out)));
          replaced++;
          if (info.w < prep.W) resized++;
        }
      }
    }
    progress(++done / Math.max(1, nums.length));
  }
  const strip = opts.metadata === 'stripAll';
  const data = write(doc, { replace, dropInfo: strip, dropMetadata: strip });
  // Read back what we wrote: same pages, every replaced picture present.
  const check = new PDFDoc(data);
  if (check.pages().length !== pageCount) throw new Error('The rewritten PDF did not check out');
  return { data, pages: pageCount, pictures: nums.length, replaced, resized };
}

module.exports = { optimize, bmp, placements, prepare, colorModel, jpegSize, stripApp1 };
