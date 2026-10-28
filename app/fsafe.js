// File-system helpers that never follow symlinks out of the folder the user chose.
// No Electron imports, so this module is unit-testable with plain Node.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUTPUT_FOLDER = 'Pressed';
// File types ProtoArt Press handles, by module.
const KINDS = {
  '.jpg': 'jpeg', '.jpeg': 'jpeg', '.jpe': 'jpeg', '.png': 'png',
  '.pdf': 'pdf',
  '.mp4': 'video', '.m4v': 'video', '.mov': 'video',
  '.wav': 'audio', '.wave': 'audio', '.aif': 'audio', '.aiff': 'audio', '.aifc': 'audio',
  '.flac': 'audio', '.caf': 'audio', '.mp3': 'audio', '.m4a': 'audio',
};
const kindOf = p => KINDS[path.extname(p).toLowerCase()] || null;
const MAX_DEPTH = 64;

class UnsafePathError extends Error {}

/**
 * Finds supported files under the given paths. Symlinks (files or folders) are skipped,
 * so a dropped folder can't pull in files from elsewhere or loop forever.
 * Returns [{ path, size, kind }] in natural sort order per folder.
 */
function collect(paths) {
  const out = [];
  const seen = new Set(); // dev:ino of visited folders
  const walk = (target, depth) => {
    let st;
    try { st = fs.lstatSync(target); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      if (depth > MAX_DEPTH || path.basename(target) === OUTPUT_FOLDER) return;
      const key = `${st.dev}:${st.ino}`;
      if (seen.has(key)) return;
      seen.add(key);
      let names = [];
      try { names = fs.readdirSync(target); } catch { return; }
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      for (const n of names) if (!n.startsWith('.')) walk(path.join(target, n), depth + 1);
    } else if (st.isFile() && kindOf(target)) {
      out.push({ path: target, size: st.size, kind: kindOf(target) });
    }
  };
  for (const p of paths) walk(p, 0);
  return out;
}

/**
 * Returns the "Pressed" folder beside `srcFile`, creating it if needed. Refuses
 * if it is a symlink, not a directory, or resolves anywhere other than directly
 * inside the source file's real folder.
 */
async function outputDirFor(srcFile) {
  const srcDir = path.dirname(srcFile);
  const dir = path.join(srcDir, OUTPUT_FOLDER);
  try {
    const st = await fs.promises.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new UnsafePathError('"Pressed" is not a normal folder, so nothing was written');
  } catch (err) {
    if (err instanceof UnsafePathError) throw err;
    if (err.code !== 'ENOENT') throw err;
    await fs.promises.mkdir(dir); // not recursive: the source folder must already exist
  }
  const [realDir, realSrc] = await Promise.all([fs.promises.realpath(dir), fs.promises.realpath(srcDir)]);
  if (path.dirname(realDir) !== realSrc) throw new UnsafePathError('"Pressed" points outside this folder, so nothing was written');
  return dir;
}

/**
 * Writes `data` to `dir/name` without ever following a symlink: the bytes go
 * to a new, randomly named temp file opened with O_CREAT|O_EXCL (which fails
 * on any existing entry, including a symlink), then rename() swaps it into
 * place. rename() replaces a symlink itself rather than writing through it.
 */
async function atomicWrite(dir, name, data, times) {
  const dest = checkName(dir, name);
  try {
    const st = await fs.promises.lstat(dest);
    if (st.isDirectory()) throw new UnsafePathError('A folder with this name is in the way, so nothing was written');
  } catch (err) {
    if (err instanceof UnsafePathError) throw err;
    if (err.code !== 'ENOENT') throw err;
  }
  const tmp = path.join(dir, `.press-${crypto.randomBytes(8).toString('hex')}.tmp`);
  const fh = await fs.promises.open(tmp, 'wx', 0o644);
  try {
    await fh.writeFile(data);
    if (times) await fh.utimes(times.atime, times.mtime);
  } finally {
    await fh.close();
  }
  try {
    await fs.promises.rename(tmp, dest);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
  return dest;
}

/** Temp file next to `srcFile` for REPLACE mode (same volume, so rename is atomic). */
async function writeTempBeside(srcFile, data, times) {
  const tmp = path.join(path.dirname(srcFile), `.press-${crypto.randomBytes(8).toString('hex')}.tmp`);
  const fh = await fs.promises.open(tmp, 'wx', 0o644);
  try {
    await fh.writeFile(data);
    if (times) await fh.utimes(times.atime, times.mtime);
  } finally {
    await fh.close();
  }
  return tmp;
}

function checkName(dir, name) {
  if (typeof name !== 'string' || !name || name !== path.basename(name) || name === '.' || name === '..' || name.includes('\0')) {
    throw new UnsafePathError('Bad file name');
  }
  return path.join(dir, name);
}

/**
 * Moves a finished file from our private temp folder to `dir/name`, the same
 * symlink-safe way as atomicWrite: it lands under a new random name first
 * (rename on the same volume, otherwise an exclusive copy), then rename()
 * swaps it into place. Used for PDF/video/audio results, which can be huge.
 */
async function placeFile(srcTemp, dir, name, times) {
  const dest = checkName(dir, name);
  try {
    const st = await fs.promises.lstat(dest);
    if (st.isDirectory()) throw new UnsafePathError('A folder with this name is in the way, so nothing was written');
  } catch (err) {
    if (err instanceof UnsafePathError) throw err;
    if (err.code !== 'ENOENT') throw err;
  }
  const tmp = await stageInto(srcTemp, dir);
  try {
    if (times) await fs.promises.lutimes(tmp, times.atime, times.mtime);
    await fs.promises.rename(tmp, dest);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
  return dest;
}

/** Puts `srcFile` into `dir` under a fresh random name and returns that path. */
async function stageInto(srcFile, dir) {
  const st = await fs.promises.lstat(srcFile);
  if (!st.isFile()) throw new UnsafePathError('The result is not a regular file');
  const tmp = path.join(dir, `.press-${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    await fs.promises.link(srcFile, tmp); // same volume: instant, and fails if tmp exists
    await fs.promises.rm(srcFile, { force: true });
  } catch (err) {
    if (err.code !== 'EXDEV' && err.code !== 'EPERM' && err.code !== 'ENOTSUP') throw err;
    await fs.promises.copyFile(srcFile, tmp, fs.constants.COPYFILE_EXCL); // other volume
  }
  await fs.promises.chmod(tmp, 0o644);
  return tmp;
}

/** Copies an existing file (an original that was kept) to `dir/name` safely. */
async function placeCopy(srcFile, dir, name, times) {
  const dest = checkName(dir, name);
  const st = await fs.promises.lstat(dest).catch(err => { if (err.code === 'ENOENT') return null; throw err; });
  if (st && st.isDirectory()) throw new UnsafePathError('A folder with this name is in the way, so nothing was written');
  const tmp = path.join(dir, `.press-${crypto.randomBytes(8).toString('hex')}.tmp`);
  await fs.promises.copyFile(srcFile, tmp, fs.constants.COPYFILE_EXCL);
  try {
    if (times) await fs.promises.lutimes(tmp, times.atime, times.mtime);
    await fs.promises.rename(tmp, dest);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
  return dest;
}

/** `name` if nothing is at dir/name, otherwise "name 2.ext", "name 3.ext"... */
async function freeName(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : `${base} ${n}${ext}`;
    try { await fs.promises.lstat(path.join(dir, candidate)); } catch (err) {
      if (err.code === 'ENOENT') return candidate;
      throw err;
    }
  }
  throw new UnsafePathError('Too many files with this name');
}

/** True when `p` is a regular file (not a symlink). */
async function isRegularFile(p) {
  try { const st = await fs.promises.lstat(p); return st.isFile(); } catch { return false; }
}

module.exports = {
  collect, kindOf, outputDirFor, atomicWrite, writeTempBeside, placeFile, placeCopy, stageInto, freeName,
  isRegularFile, UnsafePathError, OUTPUT_FOLDER, KINDS,
};
