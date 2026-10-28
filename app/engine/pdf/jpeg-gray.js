// Lossless JPEG colour → grayscale transcoder (like `jpegtran -grayscale`). Keeps the
// luminance channel's coefficients exactly and drops the two colour channels, then writes
// a one-channel baseline JPEG with optimized Huffman tables. Used for pictures in PDFs that
// are gray (or that the user asked to make gray), which then need a third less space or more.
'use strict';

const ZIGZAG_LEN = 64;

class BitReader {
  constructor(b, p) { this.b = b; this.p = p; this.acc = 0; this.n = 0; this.marker = null; }
  bit() {
    if (this.n === 0) {
      if (this.p >= this.b.length) throw new Error('JPEG data ended early');
      let v = this.b[this.p];
      if (v === 0xff) {
        const nx = this.b[this.p + 1];
        if (nx === 0) this.p += 2;
        else { this.marker = nx; v = 0; } // hit a marker: feed zeros, don't advance
      } else this.p++;
      this.acc = v; this.n = 8;
    }
    this.n--;
    return (this.acc >> this.n) & 1;
  }
  bits(k) { let v = 0; for (let i = 0; i < k; i++) v = (v << 1) | this.bit(); return v; }
  /** Skips to the next RSTn marker. */
  restart() {
    this.n = 0; this.marker = null;
    while (this.p + 1 < this.b.length && !(this.b[this.p] === 0xff && this.b[this.p + 1] >= 0xd0 && this.b[this.p + 1] <= 0xd7)) this.p++;
    if (this.p + 1 >= this.b.length) throw new Error('Missing restart marker');
    this.p += 2;
  }
}

/** Huffman decoding table from DHT counts/symbols. */
function decoder(counts, symbols) {
  const maxcode = new Int32Array(18).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    valptr[l] = k; mincode[l] = code;
    code += counts[l - 1]; k += counts[l - 1];
    maxcode[l] = counts[l - 1] ? code - 1 : -1;
    code <<= 1;
  }
  return { maxcode, valptr, mincode, symbols };
}

function decodeSym(br, t) {
  let code = 0;
  for (let l = 1; l <= 16; l++) {
    code = (code << 1) | br.bit();
    if (t.maxcode[l] >= 0 && code <= t.maxcode[l]) return t.symbols[t.valptr[l] + code - t.mincode[l]];
  }
  throw new Error('Bad Huffman code');
}

const extend = (v, s) => (s && v < 1 << (s - 1) ? v - (1 << s) + 1 : v);

/**
 * Reads a baseline (or extended sequential) Huffman JPEG. Returns the luminance
 * coefficients plus how much colour the chroma channels carry.
 */
function readCoefficients(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('Not a JPEG');
  const qt = [], dc = [], ac = [];
  let frame = null, restartInterval = 0, p = 2, adobe = null;
  for (;;) {
    if (p + 4 > b.length) throw new Error('JPEG ended before image data');
    if (b[p] !== 0xff) throw new Error('Corrupt JPEG');
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; }
    const len = (b[p + 2] << 8) | b[p + 3], s = p + 4, e = p + 2 + len;
    if (e > b.length) throw new Error('Corrupt JPEG');
    if (m === 0xdb) {
      for (let q = s; q < e;) {
        const pq = b[q] >> 4, tq = b[q] & 15; q++;
        const t = new Uint16Array(64);
        for (let i = 0; i < 64; i++) { t[i] = pq ? (b[q] << 8) | b[q + 1] : b[q]; q += pq ? 2 : 1; }
        qt[tq] = { t, pq };
      }
    } else if (m === 0xc4) {
      for (let q = s; q < e;) {
        const tc = b[q] >> 4, th = b[q] & 15; q++;
        const counts = b.subarray(q, q + 16); q += 16;
        const n = counts.reduce((x, y) => x + y, 0);
        const syms = b.subarray(q, q + n); q += n;
        (tc ? ac : dc)[th] = decoder(counts, syms);
      }
    } else if (m === 0xc0 || m === 0xc1) {
      if (b[s] !== 8) throw new Error('Only 8-bit JPEGs');
      const comps = [];
      for (let i = 0, q = s + 6; i < b[s + 5]; i++, q += 3) comps.push({ id: b[q], h: b[q + 1] >> 4, v: b[q + 1] & 15, tq: b[q + 2] });
      frame = { height: (b[s + 1] << 8) | b[s + 2], width: (b[s + 3] << 8) | b[s + 4], comps };
    } else if (m >= 0xc2 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      throw new Error('Progressive or arithmetic JPEG');
    } else if (m === 0xdd) {
      restartInterval = (b[s] << 8) | b[s + 1];
    } else if (m === 0xee && len >= 12 && b.toString('latin1', s, s + 5) === 'Adobe') {
      adobe = b[s + 11];
    } else if (m === 0xda) {
      if (!frame || !frame.height || !frame.width) throw new Error('No frame');
      const ns = b[s];
      if (ns !== frame.comps.length) throw new Error('Multi-scan JPEG');
      const scomps = [];
      for (let i = 0, q = s + 1; i < ns; i++, q += 2) {
        const c = frame.comps.find(x => x.id === b[q]);
        if (!c) throw new Error('Bad scan');
        scomps.push({ ...c, dc: dc[b[q + 1] >> 4], ac: ac[b[q + 1] & 15] });
      }
      if (b[s + 1 + ns * 2] !== 0 || b[s + 2 + ns * 2] !== 63 || b[s + 3 + ns * 2] !== 0) throw new Error('Not a sequential scan');
      if (scomps.some(c => !c.dc || !c.ac)) throw new Error('Missing Huffman table');
      return decodeScan(b, e, frame, scomps, restartInterval, qt, adobe);
    } else if (m === 0xd9) throw new Error('No image data');
    p = e;
  }
}

function decodeScan(b, start, frame, scomps, restartInterval, qt, adobe) {
  const hmax = Math.max(...frame.comps.map(c => c.h)), vmax = Math.max(...frame.comps.map(c => c.v));
  const mcuX = Math.ceil(frame.width / (8 * hmax)), mcuY = Math.ceil(frame.height / (8 * vmax));
  const y = scomps[0];
  if (scomps.length === 1 && (y.h !== 1 || y.v !== 1)) { y.h = 1; y.v = 1; } // single-component scans are non-interleaved
  const single = scomps.length === 1;
  const bw = single ? Math.ceil(frame.width / 8) : mcuX * y.h, bh = single ? Math.ceil(frame.height / 8) : mcuY * y.v;
  if (bw * bh > 4_000_000) throw new Error('Too large');
  const coef = new Int16Array(bw * bh * 64);
  const pred = new Int32Array(scomps.length);
  let chromaAC = 0, chromaDC = 0, chromaBlocks = 0;
  const br = new BitReader(b, start);
  const block = new Int32Array(64);

  const readBlock = (c, ci) => {
    block.fill(0);
    const t = decodeSym(br, c.dc);
    const diff = t ? extend(br.bits(t), t) : 0;
    pred[ci] += diff;
    block[0] = pred[ci];
    for (let k = 1; k < 64;) {
      const rs = decodeSym(br, c.ac), r = rs >> 4, s = rs & 15;
      if (s === 0) { if (r === 15) { k += 16; continue; } break; }
      k += r;
      if (k > 63) throw new Error('Bad AC data');
      block[k++] = extend(br.bits(s), s);
    }
  };

  const total = single ? bw * bh : mcuX * mcuY;
  for (let n = 0; n < total; n++) {
    if (restartInterval && n > 0 && n % restartInterval === 0) { br.restart(); pred.fill(0); }
    if (single) {
      readBlock(scomps[0], 0);
      for (let k = 0; k < 64; k++) coef[n * 64 + k] = block[k];
      continue;
    }
    const mx = n % mcuX, my = (n / mcuX) | 0;
    for (let ci = 0; ci < scomps.length; ci++) {
      const c = scomps[ci];
      for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) {
        readBlock(c, ci);
        if (ci === 0) {
          const o = ((my * c.v + v) * bw + mx * c.h + h) * 64;
          for (let k = 0; k < 64; k++) coef[o + k] = block[k];
        } else {
          chromaBlocks++;
          const q0 = qt[c.tq] ? qt[c.tq].t[0] : 1;
          chromaDC = Math.max(chromaDC, Math.abs(block[0] * q0));
          for (let k = 1; k < 64; k++) if (block[k]) chromaAC++;
        }
      }
    }
  }
  const lumaQ = qt[y.tq];
  if (!lumaQ) throw new Error('Missing quantization table');
  // An Adobe transform-0 three-channel JPEG is RGB, not YCbCr: channel 0 isn't luminance.
  if (scomps.length === 3 && adobe === 0) throw new Error('RGB JPEG');
  if (scomps.length === 4) throw new Error('CMYK JPEG');
  return {
    width: frame.width, height: frame.height, bw, bh, coef, q: lumaQ,
    components: scomps.length,
    // DC is in units of 1/8 of a level: 8 ≈ one 8-bit level of average tint per block.
    chroma: { maxDC: chromaDC / 8, acPerBlock: chromaBlocks ? chromaAC / chromaBlocks : 0 },
  };
}

// ------------------------------------------------------------------ writing

const category = v => { v = Math.abs(v); let s = 0; while (v) { s++; v >>= 1; } return s; };

/** Optimal-ish Huffman code lengths limited to 16 bits (JPEG Annex K.2). */
function buildTable(freq) {
  const f = Array.from(freq); f[256] = 1; // reserved so no code is all ones
  const size = new Array(257).fill(0), others = new Array(257).fill(-1);
  for (;;) {
    let c1 = -1, c2 = -1, v1 = Infinity, v2 = Infinity;
    for (let i = 0; i <= 256; i++) {
      if (f[i] <= 0) continue;
      if (f[i] <= v1) { v2 = v1; c2 = c1; v1 = f[i]; c1 = i; } else if (f[i] <= v2) { v2 = f[i]; c2 = i; }
    }
    if (c2 < 0) break;
    f[c1] += f[c2]; f[c2] = 0;
    size[c1]++; while (others[c1] >= 0) { c1 = others[c1]; size[c1]++; }
    others[c1] = c2;
    size[c2]++; while (others[c2] >= 0) { c2 = others[c2]; size[c2]++; }
  }
  const bits = new Array(33).fill(0);
  for (let i = 0; i <= 256; i++) if (size[i]) bits[size[i]]++;
  for (let i = 32; i > 16; i--) {
    while (bits[i] > 0) {
      let j = i - 2; while (bits[j] === 0) j--;
      bits[i] -= 2; bits[i - 1]++; bits[j + 1] += 2; bits[j]--;
    }
  }
  let i = 16; while (bits[i] === 0) i--; bits[i]--; // drop the reserved code
  const symbols = [];
  for (let len = 1; len <= 32; len++) for (let s = 0; s < 256; s++) if (size[s] === len) symbols.push(s);
  const counts = bits.slice(1, 17);
  // canonical codes
  const code = new Uint32Array(256), length = new Uint8Array(256);
  let c = 0, k = 0;
  for (let l = 1; l <= 16; l++) { for (let n = 0; n < counts[l - 1]; n++) { code[symbols[k]] = c++; length[symbols[k]] = l; k++; } c <<= 1; }
  return { counts, symbols, code, length };
}

class BitWriter {
  constructor() { this.out = []; this.acc = 0; this.n = 0; }
  put(v, k) {
    for (let i = k - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((v >> i) & 1);
      if (++this.n === 8) { this.out.push(this.acc); if (this.acc === 0xff) this.out.push(0); this.acc = 0; this.n = 0; }
    }
  }
  flush() { while (this.n) this.put(1, 1); return Buffer.from(this.out); }
}

/** Walks the luminance blocks, calling dcSym/acSym for each symbol (with extra bits). */
function walkSymbols(img, onDC, onAC) {
  const bx = Math.ceil(img.width / 8), by = Math.ceil(img.height / 8);
  let prev = 0;
  for (let y = 0; y < by; y++) for (let x = 0; x < bx; x++) {
    const o = (y * img.bw + x) * 64, c = img.coef;
    const diff = c[o] - prev; prev = c[o];
    const s = category(diff);
    onDC(s, diff < 0 ? diff - 1 : diff);
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = c[o + k];
      if (v === 0) { run++; continue; }
      while (run > 15) { onAC(0xf0, 0, 0); run -= 16; }
      const sz = category(v);
      onAC((run << 4) | sz, v < 0 ? v - 1 : v, sz);
      run = 0;
    }
    if (run) onAC(0, 0, 0);
  }
}

function writeGray(img) {
  const dcF = new Array(256).fill(0), acF = new Array(256).fill(0);
  walkSymbols(img, s => dcF[s]++, sym => acF[sym]++);
  const dcT = buildTable(dcF), acT = buildTable(acF);
  const bw = new BitWriter();
  walkSymbols(img,
    (s, extra) => { bw.put(dcT.code[s], dcT.length[s]); if (s) bw.put(extra & ((1 << s) - 1), s); },
    (sym, extra, sz) => { bw.put(acT.code[sym], acT.length[sym]); if (sz) bw.put(extra & ((1 << sz) - 1), sz); });
  const data = bw.flush();
  const seg = (m, body) => { const h = Buffer.from([0xff, m, (body.length + 2) >> 8, (body.length + 2) & 255]); return Buffer.concat([h, body]); };
  const q = img.q;
  const dqt = q.pq ? Buffer.concat([Buffer.from([0x10]), Buffer.from(Array.from(q.t).flatMap(v => [v >> 8, v & 255]))]) : Buffer.concat([Buffer.from([0x00]), Buffer.from(q.t)]);
  const dht = (tc, t) => Buffer.concat([Buffer.from([tc << 4]), Buffer.from(t.counts), Buffer.from(t.symbols)]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xdb, dqt),
    seg(q.pq ? 0xc1 : 0xc0, Buffer.from([8, img.height >> 8, img.height & 255, img.width >> 8, img.width & 255, 1, 1, 0x11, 0])),
    seg(0xc4, Buffer.concat([dht(0, dcT), dht(1, acT)])),
    seg(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0])),
    data,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/**
 * opts.force: convert even if the picture has colour. Otherwise only when the colour
 * channels are (near) empty. Returns a one-channel JPEG, or null when it doesn't apply.
 */
function toGray(jpeg, opts = {}) {
  let img;
  try { img = readCoefficients(Buffer.from(jpeg.buffer, jpeg.byteOffset, jpeg.length)); } catch { return null; }
  if (img.components !== 3 && img.components !== 1) return null;
  if (!opts.force && img.components === 3 && (img.chroma.maxDC > 3 || img.chroma.acPerBlock > 0.05)) return null;
  return writeGray(img);
}

module.exports = { toGray, readCoefficients, writeGray, buildTable };
