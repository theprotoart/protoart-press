// High-quality downscaling (Lanczos-3, separable, premultiplied alpha) for RGBA8 pixels.
(function (root) {
  'use strict';

  function lanczos(x) {
    if (x === 0) return 1;
    if (x <= -3 || x >= 3) return 0;
    const px = Math.PI * x;
    return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
  }

  /** Precomputes filter taps for one axis. */
  function weights(src, dst) {
    const scale = src / dst;
    const support = 3 * Math.max(scale, 1);
    const taps = [];
    for (let i = 0; i < dst; i++) {
      const center = (i + 0.5) * scale;
      const start = Math.max(0, Math.floor(center - support));
      const end = Math.min(src - 1, Math.ceil(center + support));
      const w = [];
      let sum = 0;
      for (let j = start; j <= end; j++) {
        const v = lanczos((j + 0.5 - center) / Math.max(scale, 1));
        w.push(v); sum += v;
      }
      for (let k = 0; k < w.length; k++) w[k] /= sum;
      taps.push({ start, w: Float32Array.from(w) });
    }
    return taps;
  }

  /** Long edge fits `maxDimension`; returns the input unchanged when it already fits. */
  function fit(rgba, width, height, maxDimension) {
    const longEdge = Math.max(width, height);
    if (!maxDimension || longEdge <= maxDimension) return { rgba, width, height, scale: 1 };
    const scale = maxDimension / longEdge;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    // Premultiply into floats.
    const src = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const a = rgba[i * 4 + 3] / 255;
      src[i * 4] = rgba[i * 4] * a; src[i * 4 + 1] = rgba[i * 4 + 1] * a;
      src[i * 4 + 2] = rgba[i * 4 + 2] * a; src[i * 4 + 3] = rgba[i * 4 + 3];
    }
    // Horizontal pass.
    const hx = weights(width, w);
    const mid = new Float32Array(w * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < w; x++) {
        const { start, w: k } = hx[x];
        let r = 0, g = 0, b = 0, a = 0;
        let p = (y * width + start) * 4;
        for (let t = 0; t < k.length; t++, p += 4) {
          const f = k[t];
          r += src[p] * f; g += src[p + 1] * f; b += src[p + 2] * f; a += src[p + 3] * f;
        }
        const o = (y * w + x) * 4;
        mid[o] = r; mid[o + 1] = g; mid[o + 2] = b; mid[o + 3] = a;
      }
    }
    // Vertical pass, un-premultiply.
    const vy = weights(height, h);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const { start, w: k } = vy[y];
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let t = 0; t < k.length; t++) {
          const p = ((start + t) * w + x) * 4, f = k[t];
          r += mid[p] * f; g += mid[p + 1] * f; b += mid[p + 2] * f; a += mid[p + 3] * f;
        }
        const o = (y * w + x) * 4;
        const alpha = Math.min(255, Math.max(0, a));
        const inv = alpha > 0.5 ? 255 / alpha : 0;
        out[o] = Math.round(r * inv);
        out[o + 1] = Math.round(g * inv);
        out[o + 2] = Math.round(b * inv);
        out[o + 3] = Math.round(alpha);
      }
    }
    return { rgba: new Uint8Array(out.buffer), width: w, height: h, scale };
  }

  const api = { fit };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PressResize = api;
})(typeof self !== 'undefined' ? self : this);
