// ProtoArt Press video engine (JavaScript for Automation, run by /usr/bin/osascript).
// Re-encodes the video track with AVFoundation at a constant quality and copies the
// audio tracks untouched. argv[0] is a JSON job; progress goes to stderr as
// "PROGRESS 0.123" lines and the result is printed as JSON on stdout.
ObjC.import('Foundation');

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function fromB64(s) {
  s = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let bits = 0, acc = 0, o = 0;
  for (let i = 0; i < s.length; i++) {
    acc = (acc << 6) | B64.indexOf(s[i]); bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
  }
  return out;
}
function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return s;
}

/** Objective-C BOOLs can arrive as booleans, numbers or strings ("0"/"1") without BridgeSupport. */
function yes(v) {
  if (typeof v === 'string') return v !== '' && v !== '0' && v !== 'false' && v !== 'NO';
  return !!v;
}
function isNil(x) {
  if (x === null || x === undefined) return true;
  if (typeof x.isNil === 'function') return x.isNil();
  try { const o = ObjC.castRefToObject(x); return !o || o.isNil(); } catch (e) { return false; }
}

/** Calls a method that returns a C struct (CMTime, CGSize, ...) and returns its raw bytes. */
function structGet(target, sel) {
  const sig = target.methodSignatureForSelector(sel);
  const inv = $.NSInvocation.invocationWithMethodSignature(sig);
  inv.selector = sel; inv.target = target; inv.invoke;
  const n = Number(sig.methodReturnLength);
  const buf = $.NSMutableData.dataWithLength(n);
  inv.getReturnValue(buf.mutableBytes);
  return fromB64(buf.base64EncodedStringWithOptions(0).js);
}
/** Calls a one-argument method whose argument is a C struct given as raw bytes. */
function structCall(target, sel, bytes) {
  const sig = target.methodSignatureForSelector(sel);
  const inv = $.NSInvocation.invocationWithMethodSignature(sig);
  inv.selector = sel; inv.target = target;
  const buf = $.NSMutableData.dataWithData($.NSData.alloc.initWithBase64EncodedStringOptions(toB64(bytes), 0));
  inv.setArgumentAtIndex(buf.mutableBytes, 2);
  inv.invoke;
}
const view = b => new DataView(b.buffer, b.byteOffset, b.length);
function seconds(cmtime) {
  const d = view(cmtime);
  const value = d.getInt32(4, true) * 4294967296 + d.getUint32(0, true), scale = d.getInt32(8, true);
  return (d.getUint32(12, true) & 1) && scale > 0 ? value / scale : 0;
}
const CMTIME_ZERO = fromB64('AAAAAAAAAAABAAAAAQAAAAAAAAAAAAAA');
const even = v => Math.max(2, 2 * Math.round(v / 2));
const progress = f => console.log('PROGRESS ' + Math.min(1, Math.max(0, f)).toFixed(3));

function encode(job) {
  $.NSBundle.bundleWithPath('/System/Library/Frameworks/AVFoundation.framework').load;
  const C = n => { const c = $.NSClassFromString(n); if (isNil(c)) throw new Error('AVFoundation is unavailable'); return c; };
  const t0 = Date.now();
  $.NSFileManager.defaultManager.removeItemAtPathError(job.dst, $()); // the writer won't replace a file

  const asset = C('AVURLAsset').URLAssetWithURLOptions($.NSURL.fileURLWithPath(job.src), $({ AVURLAssetPreferPreciseDurationAndTimingKey: true }));
  if (isNil(asset) || !yes(asset.isReadable)) return { ok: true, kept: "macOS can't read this video, kept as is" };
  if (yes(asset.hasProtectedContent)) return { ok: true, kept: 'Copy-protected video, kept as is' };
  const vts = asset.tracksWithMediaType('vide');
  if (Number(vts.count) === 0) return { ok: true, kept: 'No video track, kept as is' };
  if (Number(vts.count) > 1) return { ok: true, kept: 'Several video tracks, kept as is' };
  const vt = vts.objectAtIndex(0);
  const fds = vt.formatDescriptions;
  const desc = Number(fds.count) ? String(ObjC.unwrap(fds.objectAtIndex(0).description)) : '';
  if (/ITU_R_2100|SMPTE_ST_2084|HLG|DolbyVision|'dvh1'|'dvhe'/.test(desc)) return { ok: true, kept: 'HDR video, kept as is' };

  const size = view(structGet(vt, 'naturalSize'));
  const w = size.getFloat64(0, true), h = size.getFloat64(8, true);
  if (!(w > 0 && h > 0)) throw new Error('Unreadable video size');
  const duration = seconds(structGet(asset, 'duration'));
  const fps = Number(vt.nominalFrameRate) || 30;
  const expected = Math.max(1, duration * fps);

  const s = job.maxEdge > 0 && Math.max(w, h) > job.maxEdge ? job.maxEdge / Math.max(w, h) : 1;
  const ow = s < 1 ? even(w * s) : even(w), oh = s < 1 ? even(h * s) : even(h);

  // Rotation (phone videos): carry the transform over, scaling its offsets with the frame.
  const tf = job.testTransform ? new Uint8Array(new Float64Array(job.testTransform).buffer) : structGet(vt, 'preferredTransform');
  const t = view(tf);
  const m = [0, 1, 2, 3, 4, 5].map(i => t.getFloat64(i * 8, true));
  m[4] *= ow / w; m[5] *= oh / h;
  const tfOut = new Uint8Array(new Float64Array(m).buffer);
  const rotated = Math.abs(m[1]) > 0.5;

  const reader = C('AVAssetReader').alloc.initWithAssetError(asset, $());
  if (isNil(reader)) throw new Error("Couldn't open the video for reading");
  const vout = C('AVAssetReaderTrackOutput').alloc.initWithTrackOutputSettings(vt, $({ PixelFormatType: 875704438 }));
  vout.alwaysCopiesSampleData = false;
  reader.addOutput(vout);

  const writer = C('AVAssetWriter').alloc.initWithURLFileTypeError($.NSURL.fileURLWithPath(job.dst), job.fileType, $());
  if (isNil(writer)) throw new Error("Couldn't create the output file");
  writer.shouldOptimizeForNetworkUse = true;
  const hevc = job.codec === 'hevc';
  const vin = C('AVAssetWriterInput').alloc.initWithMediaTypeOutputSettings('vide', $({
    AVVideoCodecKey: hevc ? 'hvc1' : 'avc1', AVVideoWidthKey: ow, AVVideoHeightKey: oh,
    AVVideoScalingModeKey: 'AVVideoScalingModeResizeAspect',
    AVVideoCompressionPropertiesKey: {
      Quality: job.quality, ExpectedFrameRate: Math.round(fps),
      ProfileLevel: hevc ? 'HEVC_Main_AutoLevel' : 'H264_High_AutoLevel',
      AllowFrameReordering: true,
      // Keyframes every few seconds (like HandBrake) instead of the encoder's frequent default.
      MaxKeyFrameIntervalDuration: job.keyframeSeconds > 0 ? job.keyframeSeconds : 5,
    },
  }));
  vin.expectsMediaDataInRealTime = false;
  structCall(vin, 'setTransform:', tfOut);
  if (!yes(writer.canAddInput(vin))) throw new Error("This video format can't be written");
  writer.addInput(vin);

  // Audio: copied as is, unless it's big (uncompressed or high bitrate) and job.audioKbps is set:
  // then it's re-encoded to AAC at that bitrate, as HandBrake's presets do.
  const audio = [];
  let audioNote = 'copied';
  const ats = asset.tracksWithMediaType('soun');
  for (let i = 0; i < Number(ats.count); i++) {
    const at = ats.objectAtIndex(i);
    const afd = at.formatDescriptions;
    const desc = Number(afd.count) ? String(ObjC.unwrap(afd.objectAtIndex(0).description)) : '';
    const rate = Number(at.estimatedDataRate) || 0;
    const reencode = job.audioKbps > 0 && (/'lpcm'|'alac'|'fLaC'/.test(desc) || rate > job.audioKbps * 1000 * 1.4);
    let out, input;
    if (reencode) {
      const chans = /ChannelsPerFrame: (\d+)|mChannelsPerFrame: (\d+)/.exec(desc);
      const nch = Math.min(2, chans ? Number(chans[1] || chans[2]) : 2) || 2;
      out = C('AVAssetReaderTrackOutput').alloc.initWithTrackOutputSettings(at, $({ AVFormatIDKey: 1819304813 /* lpcm */ }));
      input = C('AVAssetWriterInput').alloc.initWithMediaTypeOutputSettings('soun', $({
        AVFormatIDKey: 1633772320 /* aac */, AVNumberOfChannelsKey: nch, AVSampleRateKey: 48000,
        AVEncoderBitRateKey: job.audioKbps * 1000 * nch / 2,
      }));
      audioNote = `AAC ${job.audioKbps}k`;
    } else {
      out = C('AVAssetReaderTrackOutput').alloc.initWithTrackOutputSettings(at, $());
      input = C('AVAssetWriterInput').alloc.initWithMediaTypeOutputSettingsSourceFormatHint('soun', $(), Number(afd.count) ? afd.objectAtIndex(0) : $());
    }
    if (!yes(reader.canAddOutput(out))) continue;
    input.expectsMediaDataInRealTime = false;
    if (!yes(writer.canAddInput(input))) return { ok: true, kept: "Its audio can't be copied into this format, kept as is" };
    reader.addOutput(out); writer.addInput(input);
    audio.push({ out, input, done: false });
  }

  if (job.metadata !== 'stripAll') {
    const keep = $.NSMutableArray.array;
    const md = asset.metadata;
    for (let i = 0; i < Number(md.count); i++) {
      const item = md.objectAtIndex(i);
      const id = isNil(item.identifier) ? '' : String(ObjC.unwrap(item.identifier));
      if (job.metadata === 'noGPS' && /location|6709|xyz|gps/i.test(id)) continue;
      keep.addObject(item);
    }
    writer.metadata = keep;
  }

  if (!yes(reader.startReading)) throw new Error("Couldn't read the video");
  if (!yes(writer.startWriting)) throw new Error("Couldn't start writing: " + (isNil(writer.error) ? '' : writer.error.localizedDescription.js));
  structCall(writer, 'startSessionAtSourceTime:', CMTIME_ZERO);

  const rl = $.NSRunLoop.currentRunLoop;
  let vDone = false, frames = 0;
  while (!vDone || audio.some(a => !a.done)) {
    let worked = false;
    if (!vDone && yes(vin.readyForMoreMediaData)) {
      const sb = vout.copyNextSampleBuffer;
      if (isNil(sb)) { vin.markAsFinished; vDone = true; } else {
        if (!yes(vin.appendSampleBuffer(sb))) break;
        if (++frames % 15 === 0) progress(frames / expected);
      }
      worked = true;
    }
    for (const a of audio) {
      if (a.done || !yes(a.input.readyForMoreMediaData)) continue;
      const sb = a.out.copyNextSampleBuffer;
      if (isNil(sb)) { a.input.markAsFinished; a.done = true; } else if (!yes(a.input.appendSampleBuffer(sb))) { a.done = true; }
      worked = true;
    }
    if (Number(writer.status) === 3 || Number(reader.status) === 3) break;
    if (!worked) rl.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.002));
  }
  if (Number(reader.status) === 3) throw new Error('Reading failed: ' + reader.error.localizedDescription.js);
  if (Number(writer.status) === 3) throw new Error('Writing failed: ' + writer.error.localizedDescription.js);
  writer.finishWriting;
  if (Number(writer.status) !== 2) throw new Error('Writing failed: ' + (isNil(writer.error) ? 'unknown' : writer.error.localizedDescription.js));

  // Check what we wrote: one video track, the same length.
  const check = C('AVURLAsset').URLAssetWithURLOptions($.NSURL.fileURLWithPath(job.dst), $({ AVURLAssetPreferPreciseDurationAndTimingKey: true }));
  const d2 = seconds(structGet(check, 'duration'));
  if (Number(check.tracksWithMediaType('vide').count) !== 1 || Math.abs(d2 - duration) > Math.max(0.5, duration * 0.02)) {
    throw new Error('The re-encoded video did not check out, so nothing was written');
  }
  progress(1);
  return {
    ok: true, frames, seconds: (Date.now() - t0) / 1000, duration,
    width: rotated ? oh : ow, height: rotated ? ow : oh, resized: s < 1,
    audioTracks: audio.length, audio: audioNote,
  };
}

function run(argv) {
  let job;
  try { job = JSON.parse(argv[0]); } catch (e) { return JSON.stringify({ ok: false, error: 'Bad job' }); }
  try { return JSON.stringify(encode(job)); } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
}
