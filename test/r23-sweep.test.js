// ops/r23-unpaid-sweep.mjs: it passes a route that is always a 402, and it FAILS a route that serves one spelling (negative control), a route whose canonical spelling is not a 402, and a leaked answer.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { variants, CHALLENGE_INDEXES } = require('../ops/r23-spellings.cjs');

function stub(handler) { return new Promise((r) => { const s = http.createServer(handler); s.listen(0, () => r(s)); }); }
const origin = (s) => `http://127.0.0.1:${s.address().port}`;
const chall = (res) => { res.writeHead(402, { 'content-type': 'application/json' }); res.end('{"x402Version":2}'); };

test('the spelling list has 24 entries and the four challenge indexes are the plain, slash, upper-case and /API/ forms', () => {
  const v = variants('/api/pkg-check');
  assert.equal(v.length, 24); assert.equal(new Set(v).size, 24);
  assert.deepEqual(CHALLENGE_INDEXES.map((i) => v[i]), ['/api/pkg-check', '/api/pkg-check/', '/API/PKG-CHECK', '/API/pkg-check']);
});

test('sweepRoute: passes an always-402 route; fails a route that serves HEAD, one whose canonical form is not a 402, and one that leaks an answer', async () => {
  const { sweepRoute } = await import('../ops/r23-unpaid-sweep.mjs');
  const good = await stub((q, res) => chall(res));
  const leakyHead = await stub((q, res) => (q.method === 'HEAD' && q.url === '/api/x-y' ? (res.writeHead(200), res.end()) : chall(res)));
  const noChallenge = await stub((q, res) => (q.url === '/api/x-y/' ? (res.writeHead(404), res.end('nf')) : chall(res)));
  const leaksBody = await stub((q, res) => (q.url === '/api/x-y%20' ? (res.writeHead(404, { 'content-type': 'application/json' }), res.end('{"tool":"x","data":{"secret":1}}')) : chall(res)));
  try {
    const a = await sweepRoute(origin(good), '/api/x-y', { pace: 0 });
    assert.equal(a.ok, true); assert.equal(a.requests, 48); assert.deepEqual(a.statuses, { 402: 48 });
    const b = await sweepRoute(origin(leakyHead), '/api/x-y', { pace: 0 });
    assert.equal(b.ok, false); assert.deepEqual(b.served, ['HEAD /api/x-y -> 200']);
    const c = await sweepRoute(origin(noChallenge), '/api/x-y', { pace: 0 });
    assert.equal(c.ok, false); assert.ok(c.notChallenge.some((x) => x.includes('/api/x-y/ -> 404')));
    const d = await sweepRoute(origin(leaksBody), '/api/x-y', { pace: 0 });
    assert.equal(d.ok, false); assert.equal(d.answers.length, 1);
  } finally { for (const s of [good, leakyHead, noChallenge, leaksBody]) s.close(); }
});
