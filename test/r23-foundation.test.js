// R23 foundation (31 Oct 2026): the guard options added to lib/safe-fetch.js, the 404 "not covered" branch in lib/tool.js, the refusal helpers and the spend caps.
// safe-fetch is driven through a stubbed https.request / dns.lookup (the real guard refuses loopback, so a local mock server cannot be reached by design).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const http = require('http');
const dns = require('dns');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const express = require('express');
const SF = require('../lib/safe-fetch');
const { makeTool } = require('../lib/tool');
const { unavailable, notCovered, bad, envNum } = require('../tools/r23/common');
const { makeSpend, capsFromEnv } = require('../tools/r23/spend');

const UA = 'agentfeed-test';
function fakeRes(status, headers = {}, body = '') { const r = Readable.from(body === '' ? [] : [Buffer.from(body)]); r.statusCode = status; r.headers = headers; return r; }
/** replace https.request (and http.request) with a stub; script(u, opts) -> fake response or Error. Returns { calls, restore }. */
function stubRequests(script) {
  const calls = []; const real = { https: https.request, http: http.request };
  const stub = (u, opts, cb) => {
    calls.push({ url: String(u.href || u), opts });
    const req = new EventEmitter();
    req.end = () => setImmediate(() => { try { const out = script(u, opts); if (out instanceof Error) req.emit('error', out); else cb(out); } catch (e) { req.emit('error', e); } });
    req.destroy = (e) => req.emit('error', e);
    return req;
  };
  https.request = stub; http.request = stub;
  return { calls, restore() { https.request = real.https; http.request = real.http; } };
}
const kindOf = async (p) => { try { await p; return 'no error'; } catch (e) { return e.kind || (e.status ? `status ${e.status}` : e.message); } };

// ---- checkUrl: every refusal, with a known-positive that passes
test('checkUrl: refuses everything the brief lists, and accepts a public https URL (known positive)', () => {
  assert.equal(SF.checkUrl('https://example.com/a', { httpsOnly: true }).hostname, 'example.com');
  const refused = {
    'http, when https only': ['http://example.com/', { httpsOnly: true }],
    'ftp': ['ftp://example.com/', {}], 'file': ['file:///etc/passwd', {}], 'not a URL': ['example.com', {}],
    'credentials': ['https://user:pw@example.com/', {}], 'port 8080': ['https://example.com:8080/', {}], 'port 22': ['http://example.com:22/', {}],
    'localhost': ['https://localhost/', {}], '127.0.0.1': ['https://127.0.0.1/', {}], '10/8': ['https://10.0.0.5/', {}], '172.16/12': ['https://172.16.0.1/', {}],
    '192.168/16': ['https://192.168.1.1/', {}], 'link-local metadata': ['https://169.254.169.254/latest/meta-data/', {}], 'CGNAT': ['https://100.64.0.1/', {}],
    '0.0.0.0': ['https://0.0.0.0/', {}], 'ipv6 loopback': ['https://[::1]/', {}], 'ipv4-mapped loopback': ['https://[::ffff:127.0.0.1]/', {}], 'ipv6 unique local': ['https://[fd00:ec2::254]/', {}],
    'google metadata name': ['https://metadata.google.internal/', {}], '.internal': ['https://db.internal/', {}], '.local': ['https://printer.local/', {}],
  };
  for (const [what, [url, opts]] of Object.entries(refused)) assert.throws(() => SF.checkUrl(url, opts), (e) => e.kind === 'bad_request', what);
  // negative control: without httpsOnly the same http URL IS accepted (the option is what refuses it)
  assert.equal(SF.checkUrl('http://example.com/', {}).protocol, 'http:');
});

// ---- the DNS-level check: a public NAME that resolves to a private address is refused at connect time
test('guardedLookup: a name that resolves to a private address, alone or among public ones, is refused; a public answer passes', async () => {
  const real = dns.lookup;
  const answer = (addrs) => { dns.lookup = (_h, _o, cb) => cb(null, addrs); };
  const run = (host) => new Promise((resolve) => SF.guardedLookup(host, { all: true }, (err, out) => resolve({ err, out })));
  try {
    answer([{ address: '10.1.2.3', family: 4 }]);
    assert.equal((await run('rebind.example')).err.code, 'EPRIVATE');
    answer([{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }]);
    assert.equal((await run('mixed.example')).err.code, 'EPRIVATE', 'one private address among public ones refuses the name');
    answer([{ address: '::ffff:7f00:1', family: 6 }]);
    assert.equal((await run('mapped.example')).err.code, 'EPRIVATE');
    answer([{ address: '93.184.216.34', family: 4 }]);
    const ok = await run('public.example');
    assert.equal(ok.err, null); assert.equal(ok.out[0].address, '93.184.216.34');
  } finally { dns.lookup = real; }
});

// ---- safeFetch options, through the stubbed transport
test('safeFetch: httpsOnly refuses an http URL before any request, and a redirect to http; without it the same redirect is followed (control)', async () => {
  const s = stubRequests((u) => (u.protocol === 'https:' ? fakeRes(302, { location: 'http://example.org/next' }) : fakeRes(200, { 'content-type': 'text/plain' }, 'hi')));
  try {
    assert.equal(await kindOf(SF.safeFetch('http://example.com/', { maxBytes: 100, userAgent: UA, httpsOnly: true })), 'bad_request');
    assert.equal(s.calls.length, 0, 'no request was made');
    assert.equal(await kindOf(SF.safeFetch('https://example.com/', { maxBytes: 100, userAgent: UA, httpsOnly: true })), 'bad_request', 'redirect to http');
    const r = await SF.safeFetch('https://example.com/', { maxBytes: 100, userAgent: UA });
    assert.equal(r.status, 200); assert.equal(r.body.toString(), 'hi'); assert.equal(s.calls.at(-1).url, 'http://example.org/next');
  } finally { s.restore(); }
});

test('safeFetch: a redirect to a private or metadata address is refused (re-check after redirect); more than 3 redirects is a 503', async () => {
  let s = stubRequests(() => fakeRes(301, { location: 'https://169.254.169.254/latest/meta-data/' }));
  try { assert.equal(await kindOf(SF.safeFetch('https://example.com/', { maxBytes: 100, userAgent: UA })), 'bad_request'); } finally { s.restore(); }
  s = stubRequests(() => fakeRes(302, { location: 'https://example.com/again' }));
  try {
    const e = await SF.safeFetch('https://example.com/', { maxBytes: 100, userAgent: UA }).catch((x) => x);
    assert.equal(e.status, 503); assert.match(e.message, /more than 3 redirects/);
    assert.equal(s.calls.length, 4, 'the original request plus exactly three redirects');
  } finally { s.restore(); }
});

test('safeFetch: HEAD has no body but returns status and headers; acceptStatus returns a 402 with its headers and body; the default still throws', async () => {
  let s = stubRequests((u, o) => fakeRes(402, { 'content-type': 'application/json', 'payment-required': 'abc' }, o.method === 'HEAD' ? '' : '{"x402Version":2}'));
  try {
    const only402 = (c) => c === 402;
    const g = await SF.safeFetch('https://example.com/p', { maxBytes: 1000, userAgent: UA, acceptStatus: only402 });
    assert.equal(g.status, 402); assert.equal(g.headers['payment-required'], 'abc'); assert.equal(g.body.toString(), '{"x402Version":2}');
    const h = await SF.safeFetch('https://example.com/p', { maxBytes: 1000, userAgent: UA, acceptStatus: only402, method: 'HEAD' });
    assert.equal(s.calls.at(-1).opts.method, 'HEAD'); assert.equal(h.status, 402); assert.equal(h.body.length, 0); assert.equal(h.headers['payment-required'], 'abc');
    assert.equal(await kindOf(SF.safeFetch('https://example.com/p', { maxBytes: 1000, userAgent: UA })), 'bad_request', 'default: a 4xx throws');
    assert.equal(await kindOf(SF.safeFetch('https://example.com/p', { maxBytes: 1000, userAgent: UA, acceptStatus: (c) => c === 418 })), 'bad_request', 'a status acceptStatus does not name still throws');
  } finally { s.restore(); }
  s = stubRequests(() => fakeRes(502, {}, 'x'));
  try { assert.equal(await kindOf(SF.safeFetch('https://example.com/', { maxBytes: 100, userAgent: UA })), 'status 503', 'a 5xx is the target being down'); } finally { s.restore(); }
});

test('safeFetch: caller headers pass, but user-agent, accept and identity encoding stay ours; the byte cap and the timeout hold', async () => {
  let s = stubRequests(() => fakeRes(200, { 'content-type': 'text/plain' }, 'x'.repeat(50)));
  try {
    await SF.safeFetch('https://example.com/', { maxBytes: 1000, userAgent: UA, accept: 'text/plain', headers: { 'x-test': '1', 'user-agent': 'evil', 'accept-encoding': 'gzip' } });
    const h = s.calls[0].opts.headers;
    assert.equal(h['x-test'], '1'); assert.equal(h['user-agent'], UA); assert.equal(h['accept-encoding'], 'identity'); assert.equal(h.accept, 'text/plain');
    assert.equal(await kindOf(SF.safeFetch('https://example.com/', { maxBytes: 10, userAgent: UA })), 'bad_request', 'body over the cap');
  } finally { s.restore(); }
  s = stubRequests(() => Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
  try { assert.equal(await kindOf(SF.safeFetch('https://example.com/', { maxBytes: 100, userAgent: UA })), 'status 503', 'a connect timeout is a 503'); } finally { s.restore(); }
});

test('safeFetch: with no R23 option the old behaviour is unchanged (GET, 404 throws bad_request, headers still returned)', async () => {
  const s = stubRequests(() => fakeRes(404, {}, 'nope'));
  try {
    assert.equal(await kindOf(SF.safeFetch('https://example.com/', { maxBytes: 100, userAgent: UA })), 'bad_request');
    assert.equal(s.calls[0].opts.method, 'GET');
  } finally { s.restore(); }
});

// ---- lib/tool.js: the 404 branch
function boot() {
  const audit = [];
  const { tool } = makeTool({ paymentsOn: true, PRICES: { 'GET /api/nc': { usd: 0.02 }, 'GET /api/un': { usd: 0.02 }, 'GET /api/bd': { usd: 0.02 }, 'GET /api/er': { usd: 0.02 } }, decodeSettlement: () => null, logCall: (r) => audit.push(r) });
  const app = express();
  app.use((req, _res, next) => { req.callerIp = '203.0.113.7'; next(); });
  app.get('/api/nc', tool('get_nc', 0.02, () => { throw notCovered('mint X was not scored at entry in the last 7 days'); }));
  app.get('/api/un', tool('get_un', 0.02, () => { throw unavailable('scores are stale', 120); }));
  app.get('/api/bd', tool('get_bd', 0.02, () => { throw bad('mint must be base58'); }));
  app.get('/api/er', tool('get_er', 0.02, () => { throw new Error('boom'); }));
  return { app, audit };
}
test('lib/tool.js: a notCovered throw is a 404 {tool,error} logged as bad_request; 503 keeps Retry-After; 400 and unmarked errors answer as before', async () => {
  const { app, audit } = boot();
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`); return { status: r.status, retry: r.headers.get('retry-after'), body: await r.json() }; };
  try {
    const nc = await get('/api/nc');
    assert.equal(nc.status, 404); assert.deepEqual(Object.keys(nc.body).sort(), ['error', 'tool']); assert.match(nc.body.error, /not covered, not charged\.$/);
    assert.equal(audit.at(-1).status, 'bad_request');
    const un = await get('/api/un');
    assert.equal(un.status, 503); assert.equal(un.retry, '120'); assert.match(un.body.error, /Not charged\.$/);
    assert.equal((await get('/api/bd')).status, 400);
    assert.equal((await get('/api/er')).status, 400, 'an unmarked throw is the same 400 it always was');
    assert.equal(audit.at(-1).status, 'error');
  } finally { server.close(); }
});

// ---- common helpers
test('common: unavailable and notCovered end with their fixed phrase exactly once; envNum falls back on junk', () => {
  assert.equal(unavailable('upstream is down').message, 'upstream is down. Not charged.');
  assert.equal(unavailable('upstream is down. Not charged.').message, 'upstream is down. Not charged.');
  assert.equal(unavailable('x', 30).retryAfter, 30); assert.equal(unavailable('x').status, 503);
  assert.equal(notCovered('mint M was never scored').message, 'mint M was never scored: not covered, not charged.');
  assert.equal(notCovered('a.').status, 404);
  assert.equal(bad('no').kind, 'bad_request');
  assert.equal(envNum('X', 5, { X: '2.5' }), 2.5); assert.equal(envNum('X', 5, { X: '' }), 5); assert.equal(envNum('X', 5, { X: 'abc' }), 5); assert.equal(envNum('X', 5, {}), 5);
});

// ---- spend caps
test('spend: per-call cap, per-day cap, release gives money back, settle clamps to the reservation, the day is UTC, an unknown scope is refused', () => {
  let t = Date.UTC(2026, 9, 31, 23, 0, 0);
  const sp = makeSpend({ file: ':memory:', now: () => t, caps: { a: { perCall: 0.5, perDay: 1 } } });
  assert.throws(() => sp.reserve('a', 0.6), (e) => e.status === 503 && /per-call cap/.test(e.message));
  assert.throws(() => sp.reserve('nope', 0.1), (e) => e.status === 503);
  assert.throws(() => sp.reserve('a', 0), (e) => e.status === 503);
  assert.throws(() => sp.reserve('a', NaN), (e) => e.status === 503);
  const r1 = sp.reserve('a', 0.5); const r2 = sp.reserve('a', 0.5);
  assert.equal(sp.today('a'), 1);
  assert.throws(() => sp.reserve('a', 0.01), (e) => e.status === 503 && /daily spend cap/.test(e.message), 'the day is full');
  sp.release(r2); assert.equal(sp.today('a'), 0.5);
  const r3 = sp.reserve('a', 0.5); sp.settle(r3, 99); assert.equal(sp.today('a'), 1, 'settle never records more than was reserved');
  sp.settle(r1, 0.2); assert.equal(sp.today('a'), 0.7);
  sp.settle(r1, 0.5); assert.equal(sp.today('a'), 0.7, 'a second settle changes nothing');
  sp.release(r3); assert.equal(sp.today('a'), 0.7, 'a settled reservation cannot be released');
  t += 2 * 3600e3; // 01:00 UTC the next day
  assert.equal(sp.today('a'), 0, 'a new UTC day starts at zero'); assert.doesNotThrow(() => sp.reserve('a', 0.5));
  sp.close();
});
test('spend: capsFromEnv reads the two variables and falls back on missing or invalid ones', () => {
  assert.deepEqual(capsFromEnv('FOO', { perCall: 0.05, perDay: 2 }, { FOO_PER_CALL_USD: '0.1', FOO_PER_DAY_USD: 'x' }), { perCall: 0.1, perDay: 2 });
});
