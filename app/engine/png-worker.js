// worker_threads entry: runs the PNG pipeline off the main thread.
'use strict';
const { parentPort } = require('worker_threads');
const { optimize } = require('./png-optimize');

parentPort.on('message', ({ bytes, opts }) => {
  try {
    const res = optimize(Buffer.from(bytes), opts, f => parentPort.postMessage({ progress: f }));
    if (res.data) {
      const out = res.data.buffer.slice(res.data.byteOffset, res.data.byteOffset + res.data.length);
      parentPort.postMessage({ data: out, detail: res.detail }, [out]);
    } else {
      parentPort.postMessage({ data: null, detail: res.detail });
    }
  } catch (err) {
    parentPort.postMessage({ error: String((err && err.message) || err) });
  }
});
