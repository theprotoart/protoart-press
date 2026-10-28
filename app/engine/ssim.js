// Windowed SSIM on luminance, shared by the JPEG web worker and the PNG Node worker.
(function (root) {
  'use strict';

  /** Luma plane (Uint8Array) of RGBA pixels composited over a gray background (255 white, 0 black). */
  function lumaFromRGBA(rgba, width, height, background) {
    const n = width * height;
    const out = new Uint8Array(n);
    const bg = background === undefined ? 255 : background;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const y = (77 * rgba[p] + 150 * rgba[p + 1] + 29 * rgba[p + 2] + 128) >> 8;
      const a = rgba[p + 3];
      out[i] = a === 255 ? y : ((y * a + bg * (255 - a) + 127) / 255) | 0;
    }
    return out;
  }

  /**
   * 8×8 windows on a 4px stride (straddling the JPEG block grid). Returns the
   * mean, the worst 64×64 region, and the largest mean-brightness shift in any
   * region (SSIM forgives flat shifts; this catches banding).
   */
  function compare(a, b, width, height) {
    const win = 8, step = 4, perTile = 16;
    const nx = Math.floor((width - win) / step) + 1;
    const ny = Math.floor((height - win) / step) + 1;
    if (nx <= 0 || ny <= 0) return { mean: 1, worstRegion: 1, worstShift: 0 };
    const tilesX = Math.ceil(nx / perTile), tilesY = Math.ceil(ny / perTile);
    const tSum = new Float64Array(tilesX * tilesY);
    const tShift = new Float64Array(tilesX * tilesY);
    const tCount = new Int32Array(tilesX * tilesY);
    const c1 = 6.5025, c2 = 58.5225, n = 64;
    let total = 0;
    for (let wy = 0; wy < ny; wy++) {
      const y0 = wy * step;
      const tileRow = Math.floor(wy / perTile) * tilesX;
      for (let wx = 0; wx < nx; wx++) {
        const x0 = wx * step;
        let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
        for (let dy = 0; dy < win; dy++) {
          let o = (y0 + dy) * width + x0;
          for (let dx = 0; dx < win; dx++, o++) {
            const va = a[o], vb = b[o];
            sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
          }
        }
        const ma = sa / n, mb = sb / n;
        const va = saa / n - ma * ma, vb = sbb / n - mb * mb, cv = sab / n - ma * mb;
        const s = ((2 * ma * mb + c1) * (2 * cv + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
        total += s;
        const t = tileRow + Math.floor(wx / perTile);
        tSum[t] += s; tShift[t] += Math.abs(ma - mb); tCount[t]++;
      }
    }
    const full = perTile * perTile;
    let worst = 1, worstAny = 1, shift = 0, shiftAny = 0, sawFull = false;
    for (let i = 0; i < tSum.length; i++) {
      if (!tCount[i]) continue;
      const avg = tSum[i] / tCount[i], sh = tShift[i] / tCount[i];
      worstAny = Math.min(worstAny, avg); shiftAny = Math.max(shiftAny, sh);
      if (tCount[i] >= full / 2) { sawFull = true; worst = Math.min(worst, avg); shift = Math.max(shift, sh); }
    }
    if (!sawFull) { worst = worstAny; shift = shiftAny; }
    return { mean: total / (nx * ny), worstRegion: worst, worstShift: shift };
  }

  const api = { lumaFromRGBA, compare };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PressSSIM = api;
})(typeof self !== 'undefined' ? self : this);
