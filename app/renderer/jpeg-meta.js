// JPEG header tools shared by the JPEG optimizer and CONVERT (both Web Workers): splitting a JPEG into its
// segments, cleaning EXIF (orientation reset, location removed) and putting chosen metadata back.
'use strict';

// ------------------------------------------------------------ JPEG segments

/** Splits a JPEG into its header segments (before SOS) and the rest. */
function parseJPEG(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a JPEG');
  const segments = [];
  let p = 2, components = 0, width = 0, height = 0;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) throw new Error('Corrupt JPEG');
    const marker = bytes[p + 1];
    if (marker === 0xff) { p++; continue; }
    if (marker === 0xda) break; // SOS: entropy data follows
    const len = (bytes[p + 2] << 8) | bytes[p + 3];
    if (len < 2 || p + 2 + len > bytes.length) throw new Error('Corrupt JPEG');
    const seg = { marker, data: bytes.subarray(p, p + 2 + len) };
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      height = (bytes[p + 5] << 8) | bytes[p + 6];
      width = (bytes[p + 7] << 8) | bytes[p + 8];
      components = bytes[p + 9];
    }
    segments.push(seg);
    p += 2 + len;
  }
  return { segments, bodyStart: p, components, width, height };
}

function startsWith(seg, text) {
  for (let i = 0; i < text.length; i++) if (seg.data[4 + i] !== text.charCodeAt(i)) return false;
  return true;
}

const isAPP0 = s => s.marker === 0xe0;
const isEXIF = s => s.marker === 0xe1 && startsWith(s, 'Exif\0\0');
const isXMP = s => s.marker === 0xe1 && startsWith(s, 'http://ns.adobe.com/');
const isICC = s => s.marker === 0xe2 && startsWith(s, 'ICC_PROFILE\0');
const isIPTC = s => s.marker === 0xed;

/**
 * Returns a cleaned copy of an EXIF APP1 segment: orientation reset to 1
 * (pixels are stored upright), and optionally the GPS IFD emptied.
 * Returns null if the EXIF can't be parsed, so it gets dropped rather than
 * risk carrying a stale rotation or a location.
 */
function cleanEXIF(seg, removeGPS) {
  const d = Uint8Array.from(seg.data);
  const t = 10; // after FFE1, length, "Exif\0\0"
  const little = d[t] === 0x49;
  const u16 = o => (little ? d[o] | (d[o + 1] << 8) : (d[o] << 8) | d[o + 1]);
  const u32 = o => (little ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0
    : ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0);
  const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
  try {
    const w16 = (o, v) => { if (little) { d[o] = v & 255; d[o + 1] = v >> 8; } else { d[o] = v >> 8; d[o + 1] = v & 255; } };
    const ifd0 = t + u32(t + 4);
    const n0 = u16(ifd0);
    for (let i = 0; i < n0; i++) {
      const e = ifd0 + 2 + i * 12;
      if (u16(e) === 0x0112) w16(e + 8, 1); // Orientation: normal
      if (!removeGPS || u16(e) !== 0x8825) continue;
      const gps = t + u32(e + 8);
      const n = u16(gps);
      for (let k = 0; k < n; k++) {
        const g = gps + 2 + k * 12;
        const size = (SIZES[u16(g + 2)] || 1) * u32(g + 4);
        if (size > 4) {
          const at = t + u32(g + 8);
          if (at + size <= d.length) d.fill(0, at, at + size);
        }
      }
      d.fill(0, gps, Math.min(d.length, gps + 2 + n * 12 + 4)); // zero entries; count 0, no next IFD
    }
    return { marker: seg.marker, data: d };
  } catch {
    return null; // unreadable EXIF: drop it rather than risk leaking location
  }
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Rebuilds the encoder's output with the metadata segments we chose. */
function assemble(encoded, carried) {
  const parsed = parseJPEG(encoded);
  const keepFromEncoder = parsed.segments.filter(s => s.marker < 0xe0 || s.marker > 0xef); // DQT, SOF, DHT...
  const encoderAPP0 = parsed.segments.find(isAPP0);
  const app0 = carried.app0 || encoderAPP0;
  return concat([
    new Uint8Array([0xff, 0xd8]),
    ...(app0 ? [app0.data] : []),
    ...carried.segments.map(s => s.data),
    ...keepFromEncoder.map(s => s.data),
    encoded.subarray(parsed.bodyStart),
  ]);
}
