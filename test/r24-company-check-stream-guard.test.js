// test/r24-company-check-stream-guard.test.js: the address guard on the STREAM reader of company-check v2 (edgar.js streamDocument), against the REAL lib/safe-fetch.js checkUrl and guardedLookup.
// Nothing opens a socket: https.request is replaced by a script that plays the server (a redirect, an oversize body sent in pieces, a silent one) and dns.lookup by a table. As for the JSON reader
// (r24-company-check-guard.test.js) every refusal reaches the caller as the 503 "Not charged." (never a 400), except a document over the cap, which is the error code TOO_LARGE for the tool to decide on.
// Controls: the guard is shown to let a public address through; the host lock is shown to be separate from the guard; the 3 redirects that are followed and the document just under the cap are read.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const dns = require('dns');
const { EventEmitter } = require('events');
const SF = require('../lib/safe-fetch');
const E = require('../tools/r24/company-check/edgar');

const realRequest = https.request;
const realLookup = dns.lookup;
test.afterEach(() => { https.request = realRequest; dns.lookup = realLookup; });

function fakeServer(script) {
  const seen = [];
  https.request = (u, opts, cb) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = (err) => { req.destroyed = true; if (err) setImmediate(() => req.emit('error', err)); };
    req.end = () => {
      if (opts && opts.timeout) setTimeout(() => { if (!req.responded && !req.destroyed) req.emit('timeout'); }, opts.timeout).unref();
      setImmediate(() => script({
        req, u, opts, seen,
        respond: ({ status = 200, headers = {}, chunks = [], hang = false, every = 0 }) => {
          req.responded = true;
          const res = new EventEmitter();
          res.statusCode = status; res.headers = headers; res.resume = () => {}; res.destroy = () => { res.destroyed = true; };
          cb(res);
          if (hang) return;
          setImmediate(() => { for (const c of chunks) { if (res.destroyed) return; res.emit('data', Buffer.isBuffer(c) ? c : Buffer.from(c)); } if (!res.destroyed) res.emit('end'); });
          void every;
        },
      }));
    };
    seen.push({ u: String(u), opts });
    return req;
  };
  return seen;
}
const refused = async (promise, pattern) => {
  const guard = new Promise((_, rej) => { setTimeout(() => rej(new Error('test deadline: neither finished nor refused within 3 s')), 3000).unref(); });
  try { await Promise.race([promise, guard]); } catch (e) { if (pattern) assert.match(e.message, pattern); return e; }
  assert.fail('expected a refusal');
};
const DOC = 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/x.htm';
const read = (url, opts) => { const parts = []; return E.streamDocument(url, opts, (c) => parts.push(c)).then((r) => ({ r, got: Buffer.concat(parts), n: parts.length })); };

const UNSAFE = [
  ['an http URL', 'http://www.sec.gov/Archives/x.htm'], ['a private IPv4 literal', 'https://10.0.0.1/x'], ['loopback', 'https://127.0.0.1/x'], ['the cloud metadata address', 'https://169.254.169.254/latest'],
  ['an IPv6 loopback literal', 'https://[::1]/x'], ['an IPv4-mapped IPv6 literal', 'https://[::ffff:7f00:1]/x'], ['credentials in the URL', 'https://user:pw@www.sec.gov/Archives/x.htm'],
  ['a port other than 443', 'https://www.sec.gov:8443/Archives/x.htm'], ['a look-alike host', 'https://www.sec.gov.evil.example/x'], ['a host ending in sec.gov that is not the SEC', 'https://evilsec.gov/x'],
  ['another public host', 'https://example.com/x'], ['a local name', 'https://localhost/x'],
];

test('stream guard: the host lock refuses every unsafe URL as a 503 before anything is sent or read', async () => {
  const seen = fakeServer(() => assert.fail('a request was sent'));
  for (const [what, url] of UNSAFE) {
    let called = false;
    const e = await refused(E.streamDocument(url, {}, () => { called = true; }), undefined);
    assert.equal(e.status, 503, what); assert.match(e.message, /Not charged\.$/, what); assert.notEqual(e.kind, 'bad_request', what); assert.equal(called, false, what);
  }
  assert.equal(seen.length, 0);
  // control: the same lock lets the two SEC hosts through to the request
  const ok = fakeServer(({ respond }) => respond({ headers: { 'content-type': 'text/html' }, chunks: ['a'] }));
  await read('https://www.sec.gov/Archives/x.htm', {}); await read('https://data.sec.gov/submissions/x.json', {}); assert.equal(ok.length, 2);
});

test('stream guard: the guard of lib/safe-fetch.js is applied on every hop (checkUrl) and inside the socket lookup (guardedLookup): a name that resolves to a private address is refused; the request carries the guarded lookup', async () => {
  dns.lookup = (host, opts, cb) => { if (typeof opts === 'function') cb = opts; cb(null, [{ address: '10.1.2.3', family: 4 }]); };
  const e = await refused(E.streamDocument(DOC, { timeoutMs: 3000 }, () => {}), /private or reserved/); assert.equal(e.status, 503); assert.match(e.message, /Not charged\.$/);
  dns.lookup = (host, opts, cb) => { if (typeof opts === 'function') cb = opts; cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '192.168.0.9', family: 4 }]); };
  await refused(E.streamDocument(DOC, { timeoutMs: 3000 }, () => {}), /private or reserved/);
  const answers = [];
  dns.lookup = (host, opts, cb) => { if (typeof opts === 'function') cb = opts; cb(null, [{ address: '93.184.216.34', family: 4 }]); };
  await new Promise((resolve) => SF.guardedLookup('www.sec.gov', {}, (err, addr, fam) => { answers.push([err, addr, fam]); resolve(); }));
  assert.deepEqual(answers, [[null, '93.184.216.34', 4]], 'control: a public address passes the lookup');
  const seen = fakeServer(({ respond }) => respond({ headers: { 'content-type': 'text/html' }, chunks: ['ok'] }));
  await read(DOC, {}); assert.equal(seen[0].opts.lookup, SF.guardedLookup);
});

test('stream guard: a redirect to a private, non-https, credentialed, off-port or non-SEC address is not followed (one request only); a redirect to the other SEC host is followed (control); more than 3 redirects end the read, 3 are followed', async () => {
  for (const target of ['http://169.254.169.254/latest/meta-data/', 'https://10.0.0.1/x', 'https://127.0.0.1:443/x', 'https://www.sec.gov:9999/x', 'https://u:p@www.sec.gov/x', 'http://www.sec.gov/x', 'https://evil.example/Archives/x.htm']) {
    const seen = fakeServer(({ respond }) => respond({ status: 302, headers: { location: target } }));
    const e = await refused(E.streamDocument(DOC, { timeoutMs: 3000 }, () => {}), undefined);
    assert.equal(e.status, 503, target); assert.equal(seen.length, 1, `one request, the redirect to ${target} was not followed`);
  }
  let n = 0;
  fakeServer(({ respond, u }) => { n++; if (String(u).includes('www.sec.gov')) respond({ status: 301, headers: { location: 'https://data.sec.gov/Archives/x.htm' } }); else respond({ headers: { 'content-type': 'text/html' }, chunks: ['ok'] }); });
  const r = await read(DOC, { timeoutMs: 3000 }); assert.equal(r.r.status, 200); assert.equal(r.got.toString(), 'ok'); assert.equal(n, 2);
  n = 0; fakeServer(({ respond }) => { n++; respond({ status: 302, headers: { location: 'https://www.sec.gov/next' } }); });
  const e4 = await refused(E.streamDocument(DOC, { timeoutMs: 3000 }, () => {}), /more than 3 times/); assert.equal(e4.status, 503); assert.equal(n, 4);
  n = 0; fakeServer(({ respond }) => { n++; if (n <= 3) respond({ status: 302, headers: { location: 'https://www.sec.gov/next' } }); else respond({ headers: { 'content-type': 'text/html' }, chunks: ['done'] }); });
  assert.equal((await read(DOC, { timeoutMs: 3000 })).got.toString(), 'done');
});

test('stream guard: the cap holds whether the size is declared or only found while streaming (the stream is destroyed at the cap, later chunks are never delivered); just under the cap is read in order', async () => {
  const MB = 1024 * 1024;
  let delivered = 0;
  fakeServer(({ respond }) => respond({ headers: { 'content-length': String(50 * MB), 'content-type': 'text/html' }, chunks: [Buffer.alloc(10)] }));
  const a = await refused(E.streamDocument(DOC, { maxBytes: 40 * MB }, () => { delivered++; }), /-byte limit/); assert.equal(a.code, 'TOO_LARGE'); assert.equal(delivered, 0, 'a declared size over the cap reads nothing');
  const piece = Buffer.alloc(MB, 97); delivered = 0; let destroyed = false;
  fakeServer(({ respond }) => respond({ headers: { 'content-type': 'text/html' }, chunks: Array(8).fill(piece) }));
  const b = await refused(E.streamDocument(DOC, { maxBytes: 3 * MB }, () => { delivered++; }), /-byte limit/); assert.equal(b.code, 'TOO_LARGE'); assert.equal(delivered, 3, 'three 1 MB pieces fit, the fourth ends the read');
  void destroyed;
  fakeServer(({ respond }) => respond({ headers: { 'content-type': 'text/html' }, chunks: Array(3).fill(piece) }));
  const ok = await read(DOC, { maxBytes: 3 * MB }); assert.equal(ok.got.length, 3 * MB); assert.equal(ok.r.bytes, 3 * MB); assert.equal(ok.n, 3, 'control: exactly at the cap is read');
  // the default cap is 40 MB (decimal)
  assert.equal(E.MAX_DOC, 40000000);
  fakeServer(({ respond }) => respond({ headers: { 'content-length': '40000001', 'content-type': 'text/html' }, chunks: [] }));
  await refused(E.streamDocument(DOC, {}, () => {}), /-byte limit/);
});

test('stream guard: a body that stalls after its headers is cut at the deadline, a server that never answers at the socket timeout; both are a 503 "Not charged."', async () => {
  fakeServer(({ respond }) => respond({ headers: { 'content-type': 'text/html' }, hang: true }));
  const t0 = Date.now(); const e = await refused(E.streamDocument(DOC, { timeoutMs: 80 }, () => {}), /timed out/); assert.equal(e.status, 503); assert.ok(Date.now() - t0 < 3000);
  fakeServer(() => { /* never answers */ });
  const s = await refused(E.streamDocument(DOC, { timeoutMs: 60 }, () => {}), /timed out/); assert.equal(s.status, 503); assert.match(s.message, /Not charged\.$/);
  assert.equal(E.STREAM_MS, 30000, 'the whole read of a large filing ends at 30 s');
});

test('stream guard: 404 is an answer, 403 and 429 are the SEC limiting us (503, retry in 5 minutes), 5xx is an outage (503); an error thrown by the consumer ends the read and is rethrown; headers carry the declared User-Agent', async () => {
  fakeServer(({ respond }) => respond({ status: 404, headers: { 'content-type': 'text/html' }, chunks: ['x'] }));
  assert.equal((await read(DOC, {})).r.status, 404);
  for (const status of [403, 429]) { fakeServer(({ respond }) => respond({ status, chunks: ['x'] })); const e = await refused(E.streamDocument(DOC, {}, () => {}), /limiting requests/); assert.equal(e.status, 503); assert.equal(e.retryAfter, 300); }
  for (const status of [500, 502, 503]) { fakeServer(({ respond }) => respond({ status, chunks: ['x'] })); const e = await refused(E.streamDocument(DOC, {}, () => {}), new RegExp(`HTTP ${status}`)); assert.equal(e.status, 503); }
  const seen = fakeServer(({ respond }) => respond({ headers: { 'content-type': 'text/html; charset=utf-8' }, chunks: ['a', 'b', 'c'] }));
  const r = await read(DOC, {}); assert.equal(r.got.toString(), 'abc'); assert.equal(r.r.contentType, 'text/html'); assert.equal(r.n, 3);
  assert.equal(seen[0].opts.headers['user-agent'], 'AgentFeed ochinimus@gmail.com'); assert.equal(seen[0].opts.headers['accept-encoding'], 'identity'); assert.equal(seen[0].opts.method, 'GET');
  let k = 0; fakeServer(({ respond }) => respond({ headers: { 'content-type': 'text/html' }, chunks: ['a', 'b', 'c', 'd'] }));
  const boom = await refused(E.streamDocument(DOC, {}, () => { k++; if (k === 2) throw new Error('consumer failed'); }), /consumer failed/); assert.equal(k, 2, 'no chunk after the failing one'); void boom;
});
