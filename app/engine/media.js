// PDF, video and audio engines. Each one runs a built-in macOS tool as a child
// process: a fixed program path, an argument array (never a shell), a minimal
// environment, and output written only into a private temp folder that the
// caller then moves into place with fsafe. No Electron imports (unit-testable).
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const OSASCRIPT = '/usr/bin/osascript';
const AFCONVERT = '/usr/bin/afconvert';
const AFINFO = '/usr/bin/afinfo';
const JXA = path.join(__dirname, 'jxa');

// What each STRENGTH/QUALITY button means per format.
const PDF_QUALITY = { gentle: 0.85, balanced: 0.75, aggressive: 0.6 };
const VIDEO_QUALITY = { gentle: 0.65, balanced: 0.5, aggressive: 0.38 };
const AUDIO_KBPS_PER_CHANNEL = { gentle: 128, balanced: 96, aggressive: 64 };
const VIDEO_TYPES = { '.mp4': 'public.mpeg-4', '.m4v': 'com.apple.m4v-video', '.mov': 'com.apple.quicktime-movie' };

const children = new Set();

/** Runs a program without a shell. Resolves { code, stdout, stderr }; never rejects on exit code. */
function runTool(file, args, { onLine, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME || '/', TMPDIR: process.env.TMPDIR || '/tmp', LANG: 'en_US.UTF-8' },
    });
    children.add(child);
    let stdout = '', stderr = '', partial = '', timer = null;
    const LIMIT = 1 << 20;
    child.stdout.on('data', d => { if (stdout.length < LIMIT) stdout += d; });
    child.stderr.on('data', d => {
      if (stderr.length < LIMIT) stderr += d;
      if (!onLine) return;
      partial += d;
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const l of lines) onLine(l);
    });
    if (timeoutMs) timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', err => { children.delete(child); clearTimeout(timer); reject(err); });
    child.on('close', (code, signal) => {
      children.delete(child); clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** Stops every running helper (app quit). */
function stopAll() { for (const c of children) c.kill('SIGTERM'); }

/** Smooth progress for tools that don't report any: approaches 95% over `est` seconds. */
function ramp(onProgress, estSeconds) {
  const t0 = Date.now();
  const timer = setInterval(() => onProgress(0.95 * (1 - Math.exp(-((Date.now() - t0) / 1000) / estSeconds))), 250);
  return () => clearInterval(timer);
}

/** Helpers only ever get absolute paths, so a file name can never be read as an option ("-x"). */
function checkPaths(job) {
  for (const p of [job.src, job.dst]) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) throw new Error('Bad file path');
  }
}

function parseResult(r, what) {
  let out = null;
  try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* fall through */ }
  if (!out) {
    if (r.signal) throw new Error(`The ${what} engine was stopped`);
    const msg = r.stderr.split('\n').filter(l => l && !l.startsWith('PROGRESS')).pop() || `exit ${r.code}`;
    throw new Error(`The ${what} engine failed: ${msg.slice(0, 200)}`);
  }
  if (!out.ok) throw new Error(String(out.error || `The ${what} engine failed`).slice(0, 300));
  return out;
}

/** job: { src, dst, tmpDir, quality, dpi, gray, metadata, bytes }. Returns { kept? , detail }. */
async function pdf(job, onProgress) {
  checkPaths(job);
  const stop = ramp(onProgress, Math.max(2, job.bytes / (6 * 1024 * 1024)));
  try {
    const r = await runTool(OSASCRIPT, ['-l', 'JavaScript', path.join(JXA, 'pdf.js'), JSON.stringify({
      src: job.src, dst: job.dst, filter: path.join(job.tmpDir, 'press.qfilter'),
      quality: PDF_QUALITY[job.quality] || PDF_QUALITY.balanced, dpi: job.dpi, gray: !!job.gray, metadata: job.metadata,
    })], { timeoutMs: 30 * 60 * 1000 });
    const out = parseResult(r, 'PDF');
    if (out.kept) return { kept: out.kept };
    const bits = [job.dpi ? `${job.dpi} dpi` : 'Pictures recompressed', job.gray ? 'gray' : '', `${out.pages} page${out.pages === 1 ? '' : 's'}`];
    return { detail: bits.filter(Boolean).join(' · ') };
  } finally { stop(); }
}

/** job: { src, dst, quality, maxEdge, codec, metadata }. */
async function video(job, onProgress) {
  checkPaths(job);
  const ext = path.extname(job.dst).toLowerCase();
  const r = await runTool(OSASCRIPT, ['-l', 'JavaScript', path.join(JXA, 'video.js'), JSON.stringify({
    src: job.src, dst: job.dst, fileType: VIDEO_TYPES[ext] || VIDEO_TYPES['.mp4'],
    codec: job.codec === 'h264' ? 'h264' : 'hevc', quality: VIDEO_QUALITY[job.quality] || VIDEO_QUALITY.balanced,
    maxEdge: job.maxEdge || 0, metadata: job.metadata,
    // A keyframe at least every 5 s (as HandBrake does) keeps seeking quick; uncompressed
    // or oversized soundtracks become 160 kbps AAC.
    keyframeSeconds: 5, audioKbps: 160,
  })], {
    onLine: l => { const m = /^PROGRESS ([\d.]+)$/.exec(l.trim()); if (m) onProgress(Math.min(0.99, +m[1])); },
  });
  const out = parseResult(r, 'video');
  if (out.kept) return { kept: out.kept };
  const bits = [job.codec === 'h264' ? 'H.264' : 'HEVC', `${out.width}×${out.height}`, out.audio || ''];
  return { detail: bits.filter(Boolean).join(' · '), resized: !!out.resized };
}

/** Reads channel count, sample rate and sample type with afinfo. */
async function audioInfo(src) {
  const r = await runTool(AFINFO, [src], { timeoutMs: 60 * 1000 });
  const m = /(\d+)\s*ch,\s*(\d+)\s*Hz/.exec(r.stdout);
  if (r.code !== 0 || !m) return null;
  return { channels: +m[1], rate: +m[2], float: /Float/.test(r.stdout.slice(m.index, m.index + 120)) };
}

/** job: { src, dst, quality, sampleRate, lossless, bytes }. */
async function audio(job, onProgress) {
  checkPaths(job);
  const info = await audioInfo(job.src);
  if (!info) return { kept: "macOS can't read this audio file, kept as is" };
  if (info.channels > 2) return { kept: 'Surround audio, kept as is' };
  let rate = job.sampleRate > 0 ? Math.min(job.sampleRate, info.rate) : info.rate; // never upsample
  if (!job.lossless && rate > 48000) rate = 48000; // AAC tops out at 48 kHz
  const at = rate !== info.rate ? `@${rate}` : '';
  const args = ['-f', 'm4af'];
  let detail;
  if (job.lossless) {
    args.push('-d', `alac${at}${info.float ? '/3' : ''}`); // ALAC stores integers: float audio becomes 24-bit
    detail = 'Lossless (ALAC)';
  } else {
    const kbps = (AUDIO_KBPS_PER_CHANNEL[job.quality] || AUDIO_KBPS_PER_CHANNEL.balanced) * info.channels;
    args.push('-d', `aac${at}`, '-b', String(kbps * 1000), '-q', '127');
    detail = `AAC ${kbps} kbps`;
  }
  if (at) { args.push('-r', '127'); detail += ` · ${rate / 1000} kHz`; }
  args.push(job.src, job.dst);
  const stop = ramp(onProgress, Math.max(1, job.bytes / (30 * 1024 * 1024)));
  try {
    const r = await runTool(AFCONVERT, args, { timeoutMs: 60 * 60 * 1000 });
    if (r.code !== 0) throw new Error(`The audio engine failed: ${(r.stderr.trim().split('\n').pop() || `exit ${r.code}`).slice(0, 200)}`);
    const check = await audioInfo(job.dst);
    if (!check || check.channels !== info.channels) throw new Error('The converted audio did not check out, so nothing was written');
  } finally { stop(); }
  return { detail };
}

module.exports = { pdf, video, audio, runTool, stopAll, PDF_QUALITY, VIDEO_QUALITY, AUDIO_KBPS_PER_CHANNEL, VIDEO_TYPES };
