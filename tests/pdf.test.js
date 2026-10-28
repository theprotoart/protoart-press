// Tests for Press's own PDF reader/writer and picture optimizer. Run: npm test
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { PDFDoc, Stream, Name, decodeStream } = require('../app/engine/pdf/objects');
const { optimize, placements } = require('../app/engine/pdf/optimize');
const { writeGray, readCoefficients, toGray } = require('../app/engine/pdf/jpeg-gray');

/** Builds a PDF from object bodies (index 0 = object 1), with a classic xref table. */
function makePDF(objects, trailerExtra = '') {
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let len = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(len);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n')]);
    parts.push(b); len += b.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${len}\n%%EOF\n`));
  return Buffer.concat(parts);
}

const streamObj = (dict, data) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]);

/** One page with text and a 600×400 RGB picture drawn 2 in wide via a Form XObject. */
function samplePDF(extra = {}) {
  const W = 600, H = 400;
  const raw = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) { raw[i * 3] = (i * 7) & 255; raw[i * 3 + 1] = (i >> 3) & 255; raw[i * 3 + 2] = 90; }
  const content = Buffer.from('BT /F1 12 Tf 72 720 Td (Hello Press) Tj ET\nq 1 0 0 1 72 300 cm /Fm1 Do Q\n');
  const form = Buffer.from('q 144 0 0 96 0 0 cm /Im1 Do Q');
  return makePDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Fm1 6 0 R >> >> >>',
    streamObj('', content),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    streamObj(`/Type /XObject /Subtype /Form /BBox [0 0 144 96] /Resources << /XObject << /Im1 7 0 R >> >>${extra.formSelf ? ' /Resources << /XObject << /Im1 7 0 R /Fm1 6 0 R >> >>' : ''}`, extra.formSelf ? Buffer.from('/Fm1 Do q 144 0 0 96 0 0 cm /Im1 Do Q') : form),
    streamObj(`/Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, zlib.deflateSync(raw)),
  ], extra.trailer || '');
}

/** A small gray JPEG made from DCT coefficients (no image library needed). */
function grayJPEG(w, h) {
  const bw = Math.ceil(w / 8), bh = Math.ceil(h / 8);
  const coef = new Int16Array(bw * bh * 64);
  for (let i = 0; i < bw * bh; i++) { coef[i * 64] = (i % 13) - 6; coef[i * 64 + 1] = (i % 5) - 2; coef[i * 64 + 9] = i % 3; }
  const q = { t: new Uint16Array(64).fill(4), pq: 0 };
  return writeGray({ width: w, height: h, bw, bh, coef, q });
}

test('PDF: finds how large each picture is shown, through Form XObjects', () => {
  const { sizes, pageCount } = placements(new PDFDoc(samplePDF()));
  assert.strictEqual(pageCount, 1);
  const s = sizes.get(7);
  assert.ok(s, 'picture placement found');
  assert.ok(Math.abs(s.w - 2) < 1e-9 && Math.abs(s.h - 4 / 3) < 1e-9, `drawn at ${s.w}×${s.h} in`);
});

test('PDF: a self-referencing Form XObject does not loop forever', () => {
  const { sizes } = placements(new PDFDoc(samplePDF({ formSelf: true })));
  assert.ok(sizes.get(7));
});

test('PDF: replaces the picture, resized for the dpi, and leaves text alone', async () => {
  const src = samplePDF();
  const jobs = [];
  const res = await optimize(src, { dpi: 150, strength: 'balanced', metadata: 'keep' }, async job => {
    jobs.push(job);
    return grayJPEG(300, 200);
  });
  assert.strictEqual(jobs.length, 1);
  assert.strictEqual(jobs[0].kind, 'bmp');
  assert.strictEqual(jobs[0].maxDimension, 300); // 2 in × 150 dpi
  assert.strictEqual(res.replaced, 1);
  assert.strictEqual(res.pages, 1);
  const out = new PDFDoc(res.data);
  const img = out.get(7);
  assert.ok(img instanceof Stream);
  assert.strictEqual(img.dict.get('Width'), 300);
  assert.strictEqual(img.dict.get('Height'), 200);
  assert.strictEqual(img.dict.get('Filter').v, 'DCTDecode');
  assert.strictEqual(img.dict.get('ColorSpace').v, 'DeviceGray');
  const text = decodeStream(out, out.get(4), 1e6).toString('latin1');
  assert.match(text, /\(Hello Press\) Tj/);
  assert.ok(res.data.length < src.length);
});

test('PDF: a picture the encoder cannot shrink is kept as it was', async () => {
  const res = await optimize(samplePDF(), { dpi: 0, strength: 'balanced', metadata: 'keep' }, async () => null);
  assert.strictEqual(res.replaced, 0);
});

test('PDF: password-protected files are left alone', async () => {
  const res = await optimize(samplePDF({ trailer: '/Encrypt << /Filter /Standard >> ' }), { dpi: 150 }, async () => { throw new Error('should not encode'); });
  assert.ok(res.kept);
});

test('PDF: pictures claiming absurd sizes are skipped, not decoded', async () => {
  const pdf = samplePDF().toString('latin1').replace('/Width 600 /Height 400', '/Width 90000 /Height 90000');
  // Keep the xref valid: same length replacement isn't possible, so let the reader recover.
  const res = await optimize(Buffer.from(pdf, 'latin1'), { dpi: 150 }, async () => { throw new Error('should not encode'); });
  assert.strictEqual(res.replaced, 0);
});

test('PDF: ASCII85 streams decode', () => {
  const doc = new PDFDoc(samplePDF());
  const d = new Map([['Filter', new Name('ASCII85Decode')]]);
  const s = new Stream(d, Buffer.from('87cURD]i,"Ebo80~>'));
  assert.strictEqual(decodeStream(doc, s, 1e6).toString('latin1'), 'Hello World!');
  const partial = new Stream(d, Buffer.from('87cURD]i,"Ebo7~>')); // last group short
  assert.strictEqual(decodeStream(doc, partial, 1e6).toString('latin1'), 'Hello World');
});

test('Gray JPEG: coefficients survive a write/read round trip exactly', () => {
  const j = grayJPEG(37, 21);
  const back = readCoefficients(j);
  assert.strictEqual(back.width, 37);
  assert.strictEqual(back.height, 21);
  assert.strictEqual(back.components, 1);
  const again = writeGray(back);
  assert.deepStrictEqual(again, j);
});

test('Gray JPEG: refuses garbage instead of throwing', () => {
  assert.strictEqual(toGray(Buffer.from('not a jpeg')), null);
  const j = grayJPEG(16, 16);
  assert.strictEqual(toGray(j.subarray(0, j.length - 40)), null);
});
