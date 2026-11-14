// CONVERT (2.2): new names, settings from the panel, the "Converted" folder and what each mode picks up. Run: npm test
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fsafe = require('../app/fsafe');
const validate = require('../app/validate');
const { convertName, looksLike, exifDay } = require('../app/engine/convert');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'press-test-'));
const info = { name: 'IMG_0042.HEIC', seq: 7, day: '2026-11-14', width: 1920, height: 1440, ext: '.jpg' };

test('rename: tokens fill in, and the right extension is added', () => {
  assert.strictEqual(convertName('{name}', info), 'IMG_0042.jpg');
  assert.strictEqual(convertName('Trip-{#}', info), 'Trip-007.jpg');
  assert.strictEqual(convertName('{date} {name} {w}×{h}', info), '2026-11-14 IMG_0042 1920×1440.jpg');
});

test('rename: a pattern can never make a path or a hidden file', () => {
  for (const p of ['../../etc/passwd', 'a/b', 'c:d', 'x\\y', '.secret', '..', '/']) {
    const n = convertName(p, info);
    assert.ok(!n.includes('/') && !n.includes(':') && !n.includes('\\') && !n.startsWith('.'), `${p} → ${n}`);
  }
  assert.strictEqual(convertName('   ', info), 'IMG_0042.jpg');
  assert.ok(convertName('x'.repeat(500), info).length <= 154);
});

test('panel results must look like the format asked for', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, ...Array(12).fill(0), 0xff, 0xd9]);
  assert.ok(looksLike('jpeg', jpeg));
  assert.ok(!looksLike('png', jpeg));
  assert.ok(!looksLike('webp', jpeg));
  assert.ok(!looksLike('jpeg', new Uint8Array(4)));
  assert.strictEqual(exifDay('2025:07:04 09:30:00'), '2025-07-04');
  assert.strictEqual(exifDay('0000:00:00 00:00:00'), '');
});

test('settings: only known CONVERT values pass', () => {
  const ok = validate.settings({ mode: 'convert', convert: { format: 'heic', quality: 85, size: -50, fit: 'width', rename: '{#}',
    mark: { on: true, kind: 'logo', text: '© me', pos: 4, opacity: 75, size: 's', dark: true } } });
  assert.deepStrictEqual(ok.convert.mark, { kind: 'logo', pos: 4, opacity: 75, size: 's', on: true, dark: true, text: '© me' });
  const bad = validate.settings({ mode: 'hack', convert: { format: 'exe', quality: 50, size: 123, rename: 'a\nb', mark: { pos: 9, text: 'x'.repeat(81), path: '/etc' } } });
  assert.deepStrictEqual(bad, {});
});

test('CONVERT writes into "Converted", which refuses symlinks like "Pressed"', async () => {
  const root = tmp(), other = tmp();
  fs.writeFileSync(path.join(root, 'a.heic'), 'x');
  const dir = await fsafe.outputDirFor(path.join(root, 'a.heic'), fsafe.CONVERT_FOLDER);
  assert.strictEqual(path.basename(dir), 'Converted');
  const root2 = tmp();
  fs.writeFileSync(path.join(root2, 'b.heic'), 'x');
  fs.symlinkSync(other, path.join(root2, 'Converted'));
  await assert.rejects(fsafe.outputDirFor(path.join(root2, 'b.heic'), fsafe.CONVERT_FOLDER), fsafe.UnsafePathError);
  await assert.rejects(fsafe.outputDirFor(path.join(root, 'a.heic'), '../x'), fsafe.UnsafePathError);
});

test('dropped folders: photos are found, and earlier results are skipped', () => {
  const root = tmp();
  for (const n of ['a.heic', 'b.TIFF', 'c.dng', 'd.jpg', 'e.txt']) fs.writeFileSync(path.join(root, n), 'x');
  fs.mkdirSync(path.join(root, 'Converted')); fs.writeFileSync(path.join(root, 'Converted', 'old.jpg'), 'x');
  const kinds = fsafe.collect([root]).map(f => `${path.basename(f.path)}:${f.kind}`);
  assert.deepStrictEqual(kinds, ['a.heic:photo', 'b.TIFF:photo', 'c.dng:photo', 'd.jpg:jpeg']);
});
