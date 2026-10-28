// worker_threads entry: reads and rewrites a PDF off the main thread. Each picture is sent
// back to the main process to be re-encoded by the panel's JPEG engine.
'use strict';
const { parentPort } = require('worker_threads');
const { optimize } = require('./optimize');

let seq = 1;
const waiting = new Map();

function encode(job) {
  return new Promise(resolve => {
    const id = seq++;
    waiting.set(id, resolve);
    const copy = job.bytes.buffer.slice(job.bytes.byteOffset, job.bytes.byteOffset + job.bytes.length);
    parentPort.postMessage({ encode: id, bytes: copy, maxDimension: job.maxDimension, strength: job.strength }, [copy]);
  });
}

parentPort.on('message', async msg => {
  if (msg.encoded !== undefined) {
    const resolve = waiting.get(msg.encoded);
    waiting.delete(msg.encoded);
    if (resolve) resolve(msg.data ? Buffer.from(msg.data) : null);
    return;
  }
  try {
    const res = await optimize(Buffer.from(msg.bytes), msg.opts, encode, f => parentPort.postMessage({ progress: f }));
    if (res.data) {
      const out = res.data.buffer.slice(res.data.byteOffset, res.data.byteOffset + res.data.length);
      parentPort.postMessage({ done: true, data: out, pages: res.pages, pictures: res.pictures, replaced: res.replaced, resized: res.resized }, [out]);
    } else parentPort.postMessage({ done: true, kept: res.kept });
  } catch (err) {
    parentPort.postMessage({ done: true, error: String((err && err.message) || err).slice(0, 300) });
  }
});
