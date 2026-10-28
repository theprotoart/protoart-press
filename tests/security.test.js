// Regression tests for the pre-release security fixes. Run: npm test
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const fsafe = require('../app/fsafe');
const validate = require('../app/validate');
const png = require('../app/engine/png');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'press-test-'));

// ---------------------------------------------------------------- H1: output writes

test('H1: refuses a "Pressed" folder that is a symlink', async () => {
  const root = tmp(), other = tmp();
  fs.writeFileSync(path.join(root, 'a.jpg'), 'x');
  fs.symlinkSync(other, path.join(root, 'Pressed'));
  await assert.rejects(fsafe.outputDirFor(path.join(root, 'a.jpg')), fsafe.UnsafePathError);
  assert.deepStrictEqual(fs.readdirSync(other), []);
});

test('H1: a symlink at the output name is replaced, never written through', async () => {
  const root = tmp(), outside = tmp();
  const decoy = path.join(outside, 'decoy.txt');
  fs.writeFileSync(decoy, 'unchanged');
  fs.writeFileSync(path.join(root, 'a.jpg'), 'x');
  const dir = await fsafe.outputDirFor(path.join(root, 'a.jpg'));
  fs.symlinkSync(decoy, path.join(dir, 'a.jpg'));
  await fsafe.atomicWrite(dir, 'a.jpg', Buffer.from('new image bytes'));
  assert.strictEqual(fs.readFileSync(decoy, 'utf8'), 'unchanged');
  assert.ok(!fs.lstatSync(path.join(dir, 'a.jpg')).isSymbolicLink());
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.jpg'), 'utf8'), 'new image bytes');
});

test('H1: output names cannot contain path separators', async () => {
  const root = tmp();
  await assert.rejects(fsafe.atomicWrite(root, '../escape.jpg', Buffer.from('x')), fsafe.UnsafePathError);
});

test('H1: no temp files are left behind', async () => {
  const root = tmp();
  await fsafe.atomicWrite(root, 'a.jpg', Buffer.from('x'));
  assert.deepStrictEqual(fs.readdirSync(root), ['a.jpg']);
});

// ---------------------------------------------------------------- M1: folder scanning

test('M1: symlinked folders and files are skipped; loops terminate', () => {
  const root = tmp(), outside = tmp();
  fs.writeFileSync(path.join(outside, 'elsewhere.jpg'), 'x');
  fs.writeFileSync(path.join(root, 'mine.jpg'), 'x');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'deep.png'), 'x');
  fs.symlinkSync(outside, path.join(root, 'link-dir'));
  fs.symlinkSync(path.join(outside, 'elsewhere.jpg'), path.join(root, 'link.jpg'));
  fs.symlinkSync(root, path.join(root, 'sub', 'loop'));
  const found = fsafe.collect([root]).map(f => path.relative(root, f.path)).sort();
  assert.deepStrictEqual(found, ['mine.jpg', path.join('sub', 'deep.png')]);
});

test('M1: existing "Pressed" folders are not rescanned', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'Pressed'));
  fs.writeFileSync(path.join(root, 'Pressed', 'old.jpg'), 'x');
  assert.deepStrictEqual(fsafe.collect([root]), []);
});

// ---------------------------------------------------------------- M2: size limits

function pngFile(width, height, idatPayload) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(png.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(idatPayload)), chunk('IEND', Buffer.alloc(0))]);
}

test('M2: huge declared dimensions are refused before decoding', () => {
  const f = pngFile(60000, 60000, Buffer.alloc(10));
  assert.throws(() => png.peek(f), png.TooLargeError);
  const { optimize } = require('../app/engine/png-optimize');
  const res = optimize(f, { strength: 'balanced', reducePNG: true, maxDimension: 0, minimumSavings: 0.03, metadata: 'keep' });
  assert.strictEqual(res.data, null);
  assert.match(res.detail, /Too large/);
});

test('M2: pixel data that inflates past its declared size is refused', () => {
  const f = pngFile(16, 16, Buffer.alloc(5_000_000)); // 16x16 gray needs 272 bytes
  assert.throws(() => png.decode(f), /buffer|length|larger/i);
});

test('M2: normal images still round-trip exactly', () => {
  const w = 37, h = 23, rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = i % 251; rgba[i * 4 + 1] = (i * 7) % 256; rgba[i * 4 + 2] = 99; rgba[i * 4 + 3] = i % 3 ? 255 : 128; }
  const out = png.decode(png.encode(rgba, w, h));
  assert.deepStrictEqual(Buffer.from(out.rgba), Buffer.from(rgba));
});

// ---------------------------------------------------------------- M3: IPC validation

test('M3: settings keep only known keys with valid values', () => {
  assert.deepStrictEqual(validate.settings({ strength: 'aggressive', outputMode: 'nuke', maxDimension: 99999, minimumSavingsPercent: 4, reducePNG: 'yes', extra: 1 }), {});
  assert.deepStrictEqual(validate.settings({
    outputMode: 'replace', minimumSavingsPercent: 5, metadata: 'stripAll',
    image: { strength: 'gentle', maxDimension: 1920, reducePNG: 'yes', __proto__: { on: true } },
    pdf: { dpi: 150, gray: true, quality: 'max' },
    video: { codec: 'vp9', maxEdge: 1280, on: false },
    audio: 'loud', bogus: { on: true },
  }), {
    outputMode: 'replace', minimumSavingsPercent: 5, metadata: 'stripAll',
    image: { strength: 'gentle', maxDimension: 1920 },
    pdf: { dpi: 150, gray: true },
    video: { maxEdge: 1280, on: false },
  });
  assert.deepStrictEqual(validate.settings(null), {});
  assert.deepStrictEqual(validate.settings(['x']), {});
});

test('M3: paths must be an array of absolute strings', () => {
  assert.strictEqual(validate.paths('not-an-array'), null);
  assert.strictEqual(validate.paths(['relative/path.jpg']), null);
  assert.strictEqual(validate.paths(['/ok.jpg', 42]), null);
  assert.strictEqual(validate.paths(['/a\0b.jpg']), null);
  assert.deepStrictEqual(validate.paths(['/Users/x/../x/a.jpg']), ['/Users/x/a.jpg']);
});

test('M3: JPEG results must look like a JPEG of plausible size', () => {
  const ok = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  assert.ok(validate.jpegBytes(ok, 100));
  assert.ok(!validate.jpegBytes(new Uint8Array([0x23, 0x21, 0x2f, 0x62]), 100));
  assert.ok(!validate.jpegBytes('ffd8ffd9', 100));
});

// ---------------------------------------------------------------- 2.0: PDF, video, audio

const media = require('../app/engine/media');

test('2.0: folder scans route each supported file to its module and skip the rest', () => {
  const root = tmp();
  for (const n of ['a.JPG', 'b.png', 'c.pdf', 'd.mov', 'e.flac', 'f.m4a', 'g.txt', 'h.mkv', '.hidden.wav']) fs.writeFileSync(path.join(root, n), 'x');
  const found = fsafe.collect([root]).map(f => [path.basename(f.path), f.kind]);
  assert.deepStrictEqual(found, [['a.JPG', 'jpeg'], ['b.png', 'png'], ['c.pdf', 'pdf'], ['d.mov', 'video'], ['e.flac', 'audio'], ['f.m4a', 'audio']]);
});

test('2.0: placeFile moves a result into place and never writes through a symlink', async () => {
  const root = tmp(), outside = tmp(), work = tmp();
  const decoy = path.join(outside, 'decoy.m4a');
  fs.writeFileSync(decoy, 'unchanged');
  fs.symlinkSync(decoy, path.join(root, 'song.m4a'));
  const result = path.join(work, 'out.m4a');
  fs.writeFileSync(result, 'NEW');
  const dest = await fsafe.placeFile(result, root, 'song.m4a', { atime: new Date(0), mtime: new Date(1e12) });
  assert.strictEqual(fs.readFileSync(decoy, 'utf8'), 'unchanged');
  assert.ok(!fs.lstatSync(dest).isSymbolicLink());
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'NEW');
  assert.strictEqual(fs.statSync(dest).mtimeMs, 1e12);
  assert.ok(!fs.existsSync(result), 'temp result is moved, not left behind');
  assert.deepStrictEqual(fs.readdirSync(root).filter(n => n.startsWith('.press-')), []);
});

test('2.0: placeFile and placeCopy refuse bad names and folders in the way', async () => {
  const root = tmp(), work = tmp();
  const src = path.join(work, 'x'); fs.writeFileSync(src, 'x');
  for (const bad of ['../evil', 'a/b', '..', '', 'a\0b']) await assert.rejects(fsafe.placeFile(src, root, bad), fsafe.UnsafePathError);
  fs.mkdirSync(path.join(root, 'clip.mov'));
  await assert.rejects(fsafe.placeFile(src, root, 'clip.mov'), fsafe.UnsafePathError);
  await assert.rejects(fsafe.placeCopy(src, root, 'clip.mov'), fsafe.UnsafePathError);
});

test('2.0: freeName never picks an existing name (including dangling symlinks)', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.m4a'), 'x');
  fs.symlinkSync('/nonexistent', path.join(root, 'a 2.m4a'));
  assert.strictEqual(await fsafe.freeName(root, 'a.m4a'), 'a 3.m4a');
  assert.strictEqual(await fsafe.freeName(root, 'b.m4a'), 'b.m4a');
});

test('2.0: helpers run without a shell, so file names are never interpreted', async () => {
  const work = tmp();
  const marker = path.join(work, 'pwned');
  const evil = `$(touch ${marker}); \`touch ${marker}\` | touch ${marker}`;
  const r = await media.runTool(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', evil]);
  assert.strictEqual(r.stdout, evil);
  assert.ok(!fs.existsSync(marker));
});

test('2.0: helpers refuse relative paths and option-like names', async () => {
  for (const kind of ['pdf', 'video', 'audio']) {
    await assert.rejects(media[kind]({ src: '-o.wav', dst: '/tmp/x', tmpDir: '/tmp' }, () => {}), /Bad file path/);
    await assert.rejects(media[kind]({ src: '/a.wav', dst: 'rel/out', tmpDir: '/tmp' }, () => {}), /Bad file path/);
  }
});

test('2.0: helper scripts are not served to the panel', () => {
  const main = fs.readFileSync(path.join(__dirname, '../app/main.js'), 'utf8');
  const SERVED = new RegExp(main.match(/const SERVED = \/(.+)\/;/)[1]);
  assert.ok(SERVED.test('/renderer/rack.js'));
  for (const p of ['/engine/jxa/video.js', '/engine/media.js', '/main.js', '/fsafe.js', '/renderer/../main.js']) assert.ok(!SERVED.test(p), p);
});

test('2.0: helper programs are fixed absolute system paths and spawned without a shell', () => {
  const src = fs.readFileSync(path.join(__dirname, '../app/engine/media.js'), 'utf8');
  assert.match(src, /shell: false/);
  assert.doesNotMatch(src, /execSync|execFile|child_process'\)\.exec|shell: true/);
  assert.match(src, /const \{ spawn \} = require\('child_process'\);/);
  for (const m of src.matchAll(/const (OSASCRIPT|AFCONVERT|AFINFO) = '([^']+)'/g)) assert.ok(m[2].startsWith('/usr/bin/'), m[2]);
});
