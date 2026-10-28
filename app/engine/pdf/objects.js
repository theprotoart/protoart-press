// Minimal PDF object model, parser and writer for ProtoArt Press's picture optimizer.
// Reads classic and compressed (object-stream / xref-stream) PDFs, recovers damaged
// cross-reference data by scanning, and writes a clean, uncompressed-xref PDF that
// contains only the objects still in use. No dependencies.
'use strict';
const zlib = require('zlib');

const MAX_INFLATE = 512 * 1024 * 1024; // never inflate a single stream past this

class Name { constructor(v) { this.v = v; } }
class Ref { constructor(num, gen) { this.num = num; this.gen = gen; } key() { return `${this.num} ${this.gen}`; } }
class Str { constructor(buf) { this.buf = buf; } }
class Stream { constructor(dict, raw) { this.dict = dict; this.raw = raw; } }
class Keyword { constructor(v) { this.v = v; } }
const EOF = Symbol('eof');
const isName = (v, n) => v instanceof Name && (n === undefined || v.v === n);

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

class Lexer {
  constructor(buf, pos = 0, end = buf.length) { this.b = buf; this.p = pos; this.end = end; }
  skip() {
    const b = this.b;
    while (this.p < this.end) {
      const c = b[this.p];
      if (WS.has(c)) this.p++;
      else if (c === 37) { while (this.p < this.end && b[this.p] !== 10 && b[this.p] !== 13) this.p++; }
      else break;
    }
  }
  /** Next token: a value, or Keyword for bare words / delimiters (">>", "]"). EOF at end. */
  token() {
    this.skip();
    const b = this.b;
    if (this.p >= this.end) return EOF;
    const c = b[this.p];
    if (c === 60 && b[this.p + 1] === 60) { this.p += 2; return new Keyword('<<'); }
    if (c === 62 && b[this.p + 1] === 62) { this.p += 2; return new Keyword('>>'); }
    if (c === 91) { this.p++; return new Keyword('['); }
    if (c === 93) { this.p++; return new Keyword(']'); }
    if (c === 123 || c === 125) { this.p++; return new Keyword(String.fromCharCode(c)); }
    if (c === 47) { // name
      let s = ''; this.p++;
      while (this.p < this.end && !WS.has(b[this.p]) && !DELIM.has(b[this.p])) {
        if (b[this.p] === 35 && this.p + 2 < this.end) { s += String.fromCharCode(parseInt(String.fromCharCode(b[this.p + 1], b[this.p + 2]), 16) || 0); this.p += 3; }
        else s += String.fromCharCode(b[this.p++]);
      }
      return new Name(s);
    }
    if (c === 40) return new Str(this.literal());
    if (c === 60) { // hex string
      this.p++; let hex = '';
      while (this.p < this.end && b[this.p] !== 62) { const ch = b[this.p++]; if (!WS.has(ch)) hex += String.fromCharCode(ch); }
      this.p++;
      if (hex.length % 2) hex += '0';
      return new Str(Buffer.from(hex.replace(/[^0-9a-fA-F]/g, '0'), 'hex'));
    }
    // number or keyword
    const start = this.p;
    while (this.p < this.end && !WS.has(b[this.p]) && !DELIM.has(b[this.p])) this.p++;
    if (this.p === start) { this.p++; return new Keyword(String.fromCharCode(c)); }
    const t = b.toString('latin1', start, this.p);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return Number(t);
    if (/^[+-]?\d*\.\d*[+-]?\d*$/.test(t)) return Number(t.replace(/(\..*)[+-].*$/, '$1')) || 0; // malformed reals like "1.-2"
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    return new Keyword(t);
  }
  literal() {
    const b = this.b; const out = []; let depth = 0; this.p++;
    while (this.p < this.end) {
      let c = b[this.p++];
      if (c === 40) { depth++; out.push(c); }
      else if (c === 41) { if (depth === 0) break; depth--; out.push(c); }
      else if (c === 92) {
        c = b[this.p++];
        const map = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };
        if (map[c] !== undefined) out.push(map[c]);
        else if (c >= 48 && c <= 55) {
          let v = c - 48;
          for (let i = 0; i < 2 && b[this.p] >= 48 && b[this.p] <= 55; i++) v = v * 8 + (b[this.p++] - 48);
          out.push(v & 255);
        } else if (c === 13) { if (b[this.p] === 10) this.p++; }
        else if (c !== 10) out.push(c);
      } else out.push(c);
    }
    return Buffer.from(out);
  }
  /** Parses one complete object (resolving "n g R" references). */
  object(depth = 0) {
    if (depth > 200) throw new Error('PDF nesting too deep');
    const t = this.token();
    if (t === EOF) throw new Error('Unexpected end of data');
    if (t instanceof Keyword) {
      if (t.v === '<<') {
        const d = new Map();
        for (;;) {
          const k = this.token();
          if (k === EOF) throw new Error('Unterminated dictionary');
          if (k instanceof Keyword && k.v === '>>') break;
          if (!(k instanceof Name)) continue; // tolerate junk
          d.set(k.v, this.object(depth + 1));
        }
        return d;
      }
      if (t.v === '[') {
        const a = [];
        for (;;) {
          const save = this.p;
          const k = this.token();
          if (k === EOF) throw new Error('Unterminated array');
          if (k instanceof Keyword && k.v === ']') break;
          this.p = save;
          a.push(this.object(depth + 1));
        }
        return a;
      }
      return t; // bare keyword (caller decides)
    }
    if (typeof t === 'number' && Number.isInteger(t) && t >= 0) {
      const save = this.p;
      const g = this.token();
      if (typeof g === 'number' && Number.isInteger(g) && g >= 0) {
        const r = this.token();
        if (r instanceof Keyword && r.v === 'R') return new Ref(t, g);
      }
      this.p = save;
    }
    return t;
  }
}

// ------------------------------------------------------------------ Filters

function inflate(buf, limit = MAX_INFLATE) {
  try { return zlib.inflateSync(buf, { maxOutputLength: limit }); } catch (e) {
    if (e.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('Stream too large to process safely');
    // Many PDFs have truncated zlib data: take what decodes.
    return zlib.inflateSync(buf, { maxOutputLength: limit, finishFlush: zlib.constants.Z_SYNC_FLUSH });
  }
}

/** PNG predictors (10–15) used by xref streams and images. */
function unpredict(data, parms) {
  const pred = parms instanceof Map ? parms.get('Predictor') || 1 : 1;
  if (pred < 10) { if (pred === 1) return data; throw new Error(`Predictor ${pred} not supported`); }
  const colors = parms.get('Colors') || 1, bpc = parms.get('BitsPerComponent') || 8, cols = parms.get('Columns') || 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8)), row = Math.ceil((colors * bpc * cols) / 8);
  const rows = Math.floor(data.length / (row + 1));
  const out = Buffer.alloc(rows * row);
  for (let y = 0; y < rows; y++) {
    const f = data[y * (row + 1)], src = y * (row + 1) + 1, o = y * row, prev = o - row;
    for (let x = 0; x < row; x++) {
      const raw = data[src + x], a = x >= bpp ? out[o + x - bpp] : 0, b = y > 0 ? out[prev + x] : 0, c = x >= bpp && y > 0 ? out[prev + x - bpp] : 0;
      let v;
      switch (f) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: throw new Error('Bad PNG filter');
      }
      out[o + x] = v & 255;
    }
  }
  return out;
}

const filtersOf = d => { const f = d.get('Filter'); return f === undefined ? [] : Array.isArray(f) ? f.map(x => x.v) : [f.v]; };
const parmsOf = (d, i) => { const p = d.get('DecodeParms') ?? d.get('DP'); return Array.isArray(p) ? p[i] : p; };

function ascii85(data, limit) {
  const out = []; let n = 0, tuple = 0, count = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break; // ~>
    if (c <= 32) continue;
    if (c === 0x7a && count === 0) { out.push(0, 0, 0, 0); n += 4; }
    else {
      if (c < 33 || c > 117) throw new Error('Bad ASCII85 data');
      tuple = tuple * 85 + (c - 33);
      if (++count === 5) { out.push((tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255); n += 4; tuple = 0; count = 0; }
    }
    if (n > limit) throw new Error('Stream too large');
  }
  if (count > 1) {
    for (let k = count; k < 5; k++) tuple = tuple * 85 + 84;
    for (let k = 0; k < count - 1; k++) out.push((tuple >>> (24 - 8 * k)) & 255);
  }
  return Buffer.from(out);
}

function asciiHex(data) {
  const s = data.toString('latin1');
  const end = s.indexOf('>');
  let hex = (end >= 0 ? s.slice(0, end) : s).replace(/[^0-9a-fA-F]/g, '');
  if (hex.length % 2) hex += '0';
  return Buffer.from(hex, 'hex');
}

/**
 * Decodes a stream (Flate with predictors, ASCII85, ASCIIHex). Stops before filter index
 * `upto` (so e.g. a JPEG wrapped in ASCII85 comes back as the JPEG). Throws for others.
 */
function decodeStream(doc, s, limit, upto) {
  let data = s.raw;
  const fs = filtersOf(s.dict);
  const end = upto === undefined ? fs.length : upto;
  for (let i = 0; i < end; i++) {
    const f = fs[i];
    if (f === 'FlateDecode' || f === 'Fl') { data = inflate(data, limit); const p = doc.resolve(parmsOf(s.dict, i)); if (p instanceof Map) data = unpredict(data, p); }
    else if (f === 'ASCII85Decode' || f === 'A85') data = ascii85(data, limit);
    else if (f === 'ASCIIHexDecode' || f === 'AHx') data = asciiHex(data);
    else throw new Error(`Filter ${f} not supported`);
  }
  return data;
}

// ------------------------------------------------------------------ Document

class PDFDoc {
  constructor(buf) {
    this.buf = buf;
    this.offsets = new Map();  // num -> { off, gen }
    this.inStream = new Map(); // num -> { stm, idx }
    this.cache = new Map();
    this.trailer = new Map();
    this.version = (/%PDF-(\d\.\d)/.exec(buf.toString('latin1', 0, 1024)) || [, '1.7'])[1];
    try { this.readXref(); } catch { this.offsets.clear(); this.inStream.clear(); }
    if (!this.trailer.get('Root') || !this.offsets.size) this.recover();
  }

  readXref() {
    const tail = this.buf.toString('latin1', Math.max(0, this.buf.length - 2048));
    const m = /startxref\s+(\d+)/g; let off = -1, x;
    while ((x = m.exec(tail))) off = Number(x[1]);
    if (off < 0) throw new Error('No startxref');
    const seen = new Set();
    while (off >= 0 && off < this.buf.length && !seen.has(off) && seen.size < 64) {
      seen.add(off);
      const trailer = this.readSection(off);
      for (const [k, v] of trailer) if (!this.trailer.has(k)) this.trailer.set(k, v);
      const stm = trailer.get('XRefStm');
      if (typeof stm === 'number') { try { this.readSection(stm); } catch { /* hybrid stream unreadable */ } }
      off = typeof trailer.get('Prev') === 'number' ? trailer.get('Prev') : -1;
    }
  }

  readSection(off) {
    const lx = new Lexer(this.buf, off);
    const first = lx.token();
    if (first instanceof Keyword && first.v === 'xref') {
      for (;;) {
        const save = lx.p;
        const t = lx.token();
        if (t instanceof Keyword && t.v === 'trailer') return lx.object();
        if (typeof t !== 'number') { lx.p = save; throw new Error('Bad xref'); }
        const count = lx.token();
        for (let i = 0; i < count; i++) {
          const o = lx.token(), g = lx.token(), type = lx.token();
          const num = t + i;
          if (type instanceof Keyword && type.v === 'n' && !this.offsets.has(num) && !this.inStream.has(num)) this.offsets.set(num, { off: o, gen: g });
          else if (!this.offsets.has(num) && !this.inStream.has(num)) this.offsets.set(num, null); // free: newest wins
        }
      }
    }
    // Cross-reference stream: "n g obj << /Type /XRef ... >> stream"
    lx.p = off;
    const obj = this.parseIndirectAt(off);
    if (!(obj instanceof Stream) || !isName(obj.dict.get('Type'), 'XRef')) throw new Error('Bad xref stream');
    const d = obj.dict, W = d.get('W'), size = d.get('Size');
    const index = d.get('Index') || [0, size];
    const data = decodeStream(this, obj);
    const rowLen = W[0] + W[1] + W[2];
    let p = 0;
    const field = (n, def) => { if (!n) return def; let v = 0; for (let i = 0; i < n; i++) v = v * 256 + data[p++]; return v; };
    for (let s = 0; s < index.length; s += 2) {
      for (let i = 0; i < index[s + 1]; i++) {
        if (p + rowLen > data.length) break;
        const type = field(W[0], 1), a = field(W[1], 0), b = field(W[2], 0), num = index[s] + i;
        if (this.offsets.has(num) || this.inStream.has(num)) continue;
        if (type === 1) this.offsets.set(num, { off: a, gen: b });
        else if (type === 2) this.inStream.set(num, { stm: a, idx: b });
        else this.offsets.set(num, null);
      }
    }
    return d;
  }

  /** Damaged files: rebuild the object table by scanning for "n g obj". */
  recover() {
    this.offsets.clear(); this.inStream.clear(); this.cache.clear();
    const s = this.buf.toString('latin1');
    const re = /(?:^|[\r\n\s])(\d{1,7})\s+(\d{1,5})\s+obj\b/g; let m;
    while ((m = re.exec(s))) this.offsets.set(Number(m[1]), { off: m.index + m[0].indexOf(m[1]), gen: Number(m[2]) });
    // Objects inside object streams.
    for (const [num] of this.offsets) {
      let o; try { o = this.get(num); } catch { continue; }
      if (o instanceof Stream && isName(o.dict.get('Type'), 'ObjStm')) {
        try { this.objStmIndex(num).forEach((n, idx) => { if (!this.offsets.has(n)) this.inStream.set(n, { stm: num, idx }); }); } catch { /* skip */ }
      }
    }
    const tr = /trailer\s*<</g; let t, last = null;
    while ((t = tr.exec(s))) last = t.index;
    if (last !== null) { try { const lx = new Lexer(this.buf, last + 7); this.trailer = lx.object(); } catch { /* keep */ } }
    // Cross-reference streams carry the trailer keys in their own dictionary.
    if (!(this.trailer.get('Root') instanceof Ref)) {
      for (const [num] of this.offsets) {
        let o; try { o = this.get(num); } catch { continue; }
        if (o instanceof Stream && isName(o.dict.get('Type'), 'XRef') && o.dict.get('Root') instanceof Ref) {
          for (const k of ['Root', 'Info', 'ID']) if (o.dict.has(k)) this.trailer.set(k, o.dict.get(k));
        }
      }
    }
    if (!(this.trailer.get('Root') instanceof Ref)) {
      for (const num of [...this.offsets.keys(), ...this.inStream.keys()]) {
        let o; try { o = this.get(num); } catch { continue; }
        if (o instanceof Map && isName(o.get('Type'), 'Catalog')) { this.trailer.set('Root', new Ref(num, 0)); break; }
      }
    }
    if (!(this.trailer.get('Root') instanceof Ref)) throw new Error('No document catalog');
  }

  parseIndirectAt(off) {
    const lx = new Lexer(this.buf, off);
    const n = lx.token(), g = lx.token(), kw = lx.token();
    if (typeof n !== 'number' || typeof g !== 'number' || !(kw instanceof Keyword) || kw.v !== 'obj') throw new Error(`No object at ${off}`);
    const val = lx.object();
    const save = lx.p;
    const next = lx.token();
    if (next instanceof Keyword && next.v === 'stream' && val instanceof Map) {
      let p = lx.p;
      if (this.buf[p] === 13) p++;
      if (this.buf[p] === 10) p++;
      let len = val.get('Length');
      if (len instanceof Ref) { try { len = this.get(len.num); } catch { len = -1; } }
      let end = typeof len === 'number' && len >= 0 ? p + len : -1;
      if (end < 0 || end > this.buf.length || this.buf.toString('latin1', end, end + 30).indexOf('endstream') < 0) {
        const e = this.buf.indexOf('endstream', p, 'latin1');
        if (e < 0) throw new Error('Unterminated stream');
        end = e;
        while (end > p && (this.buf[end - 1] === 10 || this.buf[end - 1] === 13)) end--;
      }
      return new Stream(val, this.buf.subarray(p, end));
    }
    lx.p = save;
    return val;
  }

  objStmIndex(stmNum) {
    const s = this.get(stmNum);
    const data = decodeStream(this, s);
    const n = s.dict.get('N'), lx = new Lexer(data);
    const nums = [];
    for (let i = 0; i < n; i++) { nums.push(lx.token()); lx.token(); }
    return nums;
  }

  get(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    let v;
    const e = this.offsets.get(num);
    if (e) v = this.parseIndirectAt(e.off);
    else if (this.inStream.has(num)) {
      const { stm } = this.inStream.get(num);
      const s = this.get(stm);
      const data = decodeStream(this, s);
      const n = s.dict.get('N'), first = s.dict.get('First'), lx = new Lexer(data);
      const pairs = [];
      for (let i = 0; i < n; i++) pairs.push([lx.token(), lx.token()]);
      const hit = pairs.find(p => p[0] === num);
      if (!hit) throw new Error(`Object ${num} missing from its object stream`);
      v = new Lexer(data, first + hit[1]).object();
    } else v = null;
    this.cache.set(num, v);
    return v;
  }

  /** Follows a reference (or returns the value itself). */
  resolve(v, depth = 0) {
    while (v instanceof Ref && depth++ < 32) v = this.get(v.num);
    return v;
  }

  /** Pages in order: [{ dict, resources, mediaBox }], with inherited attributes. */
  pages() {
    const out = [];
    const root = this.resolve(this.trailer.get('Root'));
    const walk = (node, inherited, depth, seen) => {
      node = this.resolve(node);
      if (!(node instanceof Map) || depth > 64 || seen.has(node)) return;
      seen.add(node);
      const inh = { ...inherited };
      for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) if (node.has(k)) inh[k] = node.get(k);
      const kids = this.resolve(node.get('Kids'));
      if (Array.isArray(kids) && !isName(node.get('Type'), 'Page')) for (const k of kids) walk(k, inh, depth + 1, seen);
      else out.push({ dict: node, resources: this.resolve(inh.Resources), mediaBox: this.resolve(inh.MediaBox) });
    };
    walk(root.get('Pages'), {}, 0, new Set());
    return out;
  }
}

// ------------------------------------------------------------------ Writer

function fmtNum(n) {
  if (Number.isInteger(n)) return String(n);
  if (!Number.isFinite(n)) return '0';
  let s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}
function fmtName(s) {
  let o = '/';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c < 0x21 || c > 0x7e || c === 35 || DELIM.has(c)) o += '#' + (c & 255).toString(16).padStart(2, '0');
    else o += ch;
  }
  return o;
}
function serialize(v, parts) {
  if (v === null || v === undefined) parts.push('null');
  else if (typeof v === 'boolean') parts.push(v ? 'true' : 'false');
  else if (typeof v === 'number') parts.push(fmtNum(v));
  else if (v instanceof Name) parts.push(fmtName(v.v));
  else if (v instanceof Ref) parts.push(`${v.num} ${v.gen} R`);
  else if (v instanceof Str) parts.push('<' + v.buf.toString('hex') + '>');
  else if (Array.isArray(v)) { parts.push('['); v.forEach((x, i) => { if (i) parts.push(' '); serialize(x, parts); }); parts.push(']'); }
  else if (v instanceof Map) { parts.push('<<'); for (const [k, x] of v) { parts.push(fmtName(k), ' '); serialize(x, parts); parts.push('\n'); } parts.push('>>'); }
  else if (v instanceof Keyword) parts.push(v.v);
  else parts.push('null');
}

/**
 * Writes every object reachable from the trailer's Root and Info. `replace` maps object
 * numbers to new values (e.g. a recompressed image Stream).
 */
function write(doc, { replace = new Map(), dropInfo = false, dropMetadata = false } = {}) {
  const live = new Map();
  const queue = [];
  const visit = v => {
    if (v instanceof Ref) { if (!live.has(v.num)) { live.set(v.num, null); queue.push(v.num); } }
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v instanceof Map) v.forEach(visit);
    else if (v instanceof Stream) v.dict.forEach(visit);
  };
  const root = doc.trailer.get('Root');
  visit(root);
  const info = dropInfo ? null : doc.trailer.get('Info');
  if (info instanceof Ref) visit(info);
  while (queue.length) {
    const num = queue.shift();
    let v = replace.has(num) ? replace.get(num) : doc.get(num);
    if (dropMetadata && v instanceof Map && isName(v.get('Type'), 'Catalog') && v.has('Metadata')) { v = new Map(v); v.delete('Metadata'); }
    live.set(num, v);
    visit(v);
  }
  const chunks = [Buffer.from(`%PDF-${doc.version > '1.7' ? doc.version : '1.7'}\n%\xE2\xE3\xCF\xD3\n`, 'latin1')];
  let pos = chunks[0].length;
  const xref = new Map();
  const nums = [...live.keys()].sort((a, b) => a - b);
  for (const num of nums) {
    const v = live.get(num);
    const parts = [`${num} 0 obj\n`];
    let tail = null;
    if (v instanceof Stream) {
      const d = new Map(v.dict); d.set('Length', v.raw.length);
      serialize(d, parts); parts.push('\nstream\n'); tail = v.raw;
    } else serialize(v, parts);
    const head = Buffer.from(parts.join(''), 'latin1');
    const end = Buffer.from((tail ? '\nendstream' : '') + '\nendobj\n', 'latin1');
    xref.set(num, pos);
    chunks.push(head); pos += head.length;
    if (tail) { chunks.push(tail); pos += tail.length; }
    chunks.push(end); pos += end.length;
  }
  const size = (nums.length ? nums[nums.length - 1] : 0) + 1;
  const lines = [`xref\n0 ${size}\n`, '0000000000 65535 f\r\n'];
  for (let n = 1; n < size; n++) lines.push(xref.has(n) ? `${String(xref.get(n)).padStart(10, '0')} 00000 n\r\n` : '0000000000 00001 f\r\n');
  const trailer = new Map([['Size', size], ['Root', root]]);
  if (info instanceof Ref) trailer.set('Info', info);
  if (Array.isArray(doc.trailer.get('ID'))) trailer.set('ID', doc.trailer.get('ID'));
  const tp = ['trailer\n']; serialize(trailer, tp);
  chunks.push(Buffer.from(lines.join('') + tp.join('') + `\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

module.exports = { EOF, Lexer, PDFDoc, Name, Ref, Str, Stream, Keyword, isName, decodeStream, inflate, unpredict, filtersOf, parmsOf, write, serialize };
