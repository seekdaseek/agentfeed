// test/r24-company-check-cache.test.js: the disk cache of the gate runs (ops/r24-company-check-cache.js), stream side (R24 item 5, v2): a replay makes 0 calls, an entry made by one reader is a hit for the
// other, the byte cap applies to a replay as to the first read, and a failed read leaves nothing behind.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeDiskFetch, makeDiskStream } = require('../ops/r24-company-check-cache');

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'r24cache-'));
const body = Buffer.from('x'.repeat(200000));
const fakeInner = (calls, behaviour = {}) => async (url, opts, onChunk) => {
  calls.push(url);
  if (behaviour.status) return { status: behaviour.status, url, contentType: '', bytes: 0 };
  let size = 0;
  for (let p = 0; p < body.length; p += 50000) {
    if (behaviour.failAfter != null && p >= behaviour.failAfter) throw Object.assign(new Error('reset'), { status: 503 });
    const c = body.subarray(p, p + 50000); size += c.length;
    if (opts.maxBytes && size > opts.maxBytes) throw Object.assign(new Error('over'), { code: 'TOO_LARGE' });
    onChunk(Buffer.from(c));
  }
  return { status: 200, url, contentType: 'text/html', bytes: size };
};
const collect = async (fn, url, opts) => { const parts = []; const r = await fn(url, opts, (c) => parts.push(Buffer.from(c))); return { r, got: Buffer.concat(parts) }; };

test('a miss streams and stores; the replay makes no call and gives the same bytes in pieces of at most 64 KB; offline replay of something never read is a 503', async () => {
  const dir = mkdir(); const calls = [];
  const a = makeDiskStream({ dir, inner: fakeInner(calls) });
  const first = await collect(a, 'https://www.sec.gov/Archives/x.htm', { maxBytes: 1e6 });
  assert.deepEqual(first.got, body); assert.equal(calls.length, 1); assert.equal(a.stats.misses, 1);
  const pieces = []; const b = makeDiskStream({ dir, inner: fakeInner(calls), offline: true });
  const second = await b('https://www.sec.gov/Archives/x.htm', { maxBytes: 1e6 }, (c) => pieces.push(c.length));
  assert.equal(calls.length, 1, 'the replay made no call'); assert.equal(second.fromCache, true); assert.equal(second.bytes, body.length); assert.ok(Math.max(...pieces) <= 65536 && pieces.reduce((x, y) => x + y) === body.length);
  await assert.rejects(b('https://www.sec.gov/Archives/never.htm', { maxBytes: 1e6 }, () => {}), (e) => e.status === 503 && /offline replay/.test(e.message));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the cap applies to a replay: an entry bigger than this call\'s cap is refused (TOO_LARGE); a refusal is stored for the cap that made it and a bigger cap reads the document again', async () => {
  const dir = mkdir(); const calls = [];
  const a = makeDiskStream({ dir, inner: fakeInner(calls) });
  await collect(a, 'https://www.sec.gov/Archives/big.htm', { maxBytes: 1e6 });
  await assert.rejects(a('https://www.sec.gov/Archives/big.htm', { maxBytes: 100000 }, () => {}), (e) => e.code === 'TOO_LARGE');
  assert.equal(calls.length, 1, 'refused from the cache, no call');
  await assert.rejects(a('https://www.sec.gov/Archives/other.htm', { maxBytes: 100000 }, () => {}), (e) => e.code === 'TOO_LARGE'); assert.equal(calls.length, 2);
  await assert.rejects(a('https://www.sec.gov/Archives/other.htm', { maxBytes: 90000 }, () => {}), (e) => e.code === 'TOO_LARGE'); assert.equal(calls.length, 2, 'the stored refusal stands for a cap no bigger');
  const ok = await collect(a, 'https://www.sec.gov/Archives/other.htm', { maxBytes: 1e6 }); assert.equal(ok.got.length, body.length); assert.equal(calls.length, 3, 'a bigger cap reads again');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a read that fails stores nothing and leaves no file; a 404 is stored; the stream and the JSON caches share entries', async () => {
  const dir = mkdir(); const calls = [];
  const bad = makeDiskStream({ dir, inner: fakeInner(calls, { failAfter: 100000 }) });
  await assert.rejects(bad('https://www.sec.gov/Archives/fail.htm', { maxBytes: 1e6 }, () => {}), (e) => e.status === 503);
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing left behind');
  const nf = makeDiskStream({ dir, inner: fakeInner(calls, { status: 404 }) });
  assert.equal((await nf('https://www.sec.gov/Archives/gone.htm', {}, () => {})).status, 404); assert.equal((await nf('https://www.sec.gov/Archives/gone.htm', {}, () => {})).status, 404); assert.equal(calls.length, 2, 'the second 404 came from the cache');
  const good = makeDiskStream({ dir, inner: fakeInner(calls) });
  await collect(good, 'https://www.sec.gov/Archives/both.htm', { maxBytes: 1e6 });
  const json = makeDiskFetch({ dir, inner: async () => { throw new Error('no call expected'); }, offline: true });
  const viaFetch = await json('https://www.sec.gov/Archives/both.htm', { maxBytes: 1e6 }); assert.deepEqual(viaFetch.body, body);
  fs.rmSync(dir, { recursive: true, force: true });
});
