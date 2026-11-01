// test/r24-company-check-guard.test.js: the SSRF guard on every EDGAR read of company-check (R24 item 5), against the REAL lib/safe-fetch.js and the real defaultEdgarFetch.
// Nothing here opens a socket to the outside: https.request is replaced by a script that plays the server (a redirect, a huge body, a silent one) and dns.lookup by a table.
// The hosts the tool reads are fixed (www.sec.gov, data.sec.gov), so a refusal means a redirect, a DNS answer or the SEC went wrong: the tool must say 503 "Not charged." and never
// blame the caller (400). Negative controls: the guard is shown to let a public address through (so "refused" is the guard deciding); the host lock is shown to be separate from safe-fetch's.
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
      // a real socket reports its idle timeout; the fake does the same when the script never answers
      if (opts && opts.timeout) setTimeout(() => { if (!req.responded && !req.destroyed) req.emit('timeout'); }, opts.timeout).unref();
      setImmediate(() => script({
        req, u, opts, seen,
        respond: ({ status = 200, headers = {}, chunks = [], hang = false }) => {
          req.responded = true;
          const res = new EventEmitter();
          res.statusCode = status; res.headers = headers; res.resume = () => {}; res.destroy = () => { res.destroyed = true; };
          cb(res);
          if (hang) return;
          setImmediate(() => { for (const c of chunks) res.emit('data', Buffer.isBuffer(c) ? c : Buffer.from(c)); res.emit('end'); });
        },
      }));
    };
    seen.push({ u: String(u), opts });
    return req;
  };
  return seen;
}
const refused = async (promise, pattern) => {
  const guard = new Promise((_, rej) => { setTimeout(() => rej(new Error('test deadline: the call neither finished nor was refused within 3 s')), 3000).unref(); });
  try { await Promise.race([promise, guard]); } catch (e) { if (pattern) assert.match(e.message, pattern); return e; }
  assert.fail('expected a refusal');
};
const TICKERS = 'https://www.sec.gov/files/company_tickers.json';

const UNSAFE = [
  ['an http URL', 'http://www.sec.gov/files/company_tickers.json'],
  ['a private IPv4 literal', 'https://10.0.0.1/x'], ['loopback', 'https://127.0.0.1/x'], ['the cloud metadata address', 'https://169.254.169.254/latest'],
  ['an IPv6 loopback literal', 'https://[::1]/x'], ['an IPv4-mapped IPv6 literal', 'https://[::ffff:7f00:1]/x'],
  ['credentials in the URL', 'https://user:pw@www.sec.gov/files/company_tickers.json'], ['a port other than 443', 'https://www.sec.gov:8443/files/company_tickers.json'],
  ['a look-alike host', 'https://www.sec.gov.evil.example/x'], ['a host ending in sec.gov that is not the SEC', 'https://evilsec.gov/x'], ['another public host', 'https://example.com/x'], ['a local name', 'https://localhost/x'],
];

test('guard: the host lock refuses every unsafe URL as a 503 before anything is sent', async () => {
  const seen = fakeServer(() => assert.fail('a request was sent'));
  for (const [what, url] of UNSAFE) {
    const e = await refused(E.defaultEdgarFetch(url), undefined);
    assert.equal(e.status, 503, what); assert.match(e.message, /Not charged\.$/, what); assert.notEqual(e.kind, 'bad_request', what);
  }
  assert.equal(seen.length, 0);
});

test('guard: lib/safe-fetch.js refuses the unsafe URLs on its own (the second lock), and the host lock is a separate lock: a public host safe-fetch allows is refused by it (control)', async () => {
  const seen = fakeServer(() => assert.fail('a request was sent'));
  for (const [what, url] of UNSAFE.filter((u) => !/look-alike|ending in sec|another public/.test(u[0]))) {
    const e = await refused(SF.safeFetch(url, { maxBytes: 1000, httpsOnly: true, userAgent: 't' }), undefined);
    assert.equal(e.kind, 'bad_request', what);
  }
  assert.equal(seen.length, 0);
  const pub = fakeServer(({ respond }) => respond({ headers: { 'content-type': 'text/plain' }, chunks: ['ok'] }));
  assert.equal((await SF.safeFetch('https://example.com/x', { maxBytes: 1000, httpsOnly: true, userAgent: 't' })).status, 200);
  assert.equal(pub.length, 1, 'safe-fetch alone lets a public host through');
  await refused(E.defaultEdgarFetch('https://example.com/x'), undefined);
  assert.equal(pub.length, 1, 'the host lock did not send the second request');
});

test('guard: a name that resolves to a private address is refused inside the socket lookup and reaches the caller as a 503; one private address among public ones is enough', async () => {
  dns.lookup = (host, opts, cb) => { if (typeof opts === 'function') cb = opts; cb(null, [{ address: '10.1.2.3', family: 4 }]); };
  const e = await refused(E.defaultEdgarFetch(TICKERS, { timeoutMs: 3000 }), /private or reserved/);
  assert.equal(e.status, 503); assert.match(e.message, /Not charged\.$/); assert.notEqual(e.kind, 'bad_request');
  dns.lookup = (host, opts, cb) => { if (typeof opts === 'function') cb = opts; cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '192.168.0.9', family: 4 }]); };
  await refused(E.defaultEdgarFetch(TICKERS, { timeoutMs: 3000 }), /private or reserved/);
  const answers = [];                                                                       // control: only public addresses are let through by the guard's lookup
  dns.lookup = (host, opts, cb) => { if (typeof opts === 'function') cb = opts; cb(null, [{ address: '93.184.216.34', family: 4 }]); };
  await new Promise((resolve) => SF.guardedLookup('www.sec.gov', {}, (err, addr, fam) => { answers.push([err, addr, fam]); resolve(); }));
  assert.deepEqual(answers, [[null, '93.184.216.34', 4]]);
});

test('guard: a redirect to a private, non-https, credentialed or off-port address is not followed; a redirect to a public host outside sec.gov is followed by safe-fetch and refused by the tool\'s final-host check', async () => {
  for (const target of ['http://169.254.169.254/latest/meta-data/', 'https://10.0.0.1/x', 'https://127.0.0.1:443/x', 'https://www.sec.gov:9999/x', 'https://u:p@www.sec.gov/x', 'http://www.sec.gov/x']) {
    const seen = fakeServer(({ respond }) => respond({ status: 302, headers: { location: target } }));
    const e = await refused(E.defaultEdgarFetch(TICKERS, { timeoutMs: 3000 }), undefined);
    assert.equal(e.status, 503, target); assert.equal(seen.length, 1, `one request, the redirect to ${target} was not followed`);
  }
  let n = 0;
  fakeServer(({ respond, u }) => { n++; if (String(u).includes('www.sec.gov')) respond({ status: 302, headers: { location: 'https://evil.example/files/company_tickers.json' } }); else respond({ headers: { 'content-type': 'application/json' }, chunks: ['{"0":{}}'] }); });
  const e = await refused(E.defaultEdgarFetch(TICKERS, { timeoutMs: 3000 }), /outside sec\.gov/);
  assert.equal(e.status, 503); assert.equal(n, 2, 'safe-fetch followed it (a public host) and the tool refused the answer');
  n = 0;                                                                                    // control: a redirect to the other SEC host is followed and answered
  fakeServer(({ respond, u }) => { n++; if (String(u).includes('www.sec.gov')) respond({ status: 301, headers: { location: 'https://data.sec.gov/files/x.json' } }); else respond({ headers: { 'content-type': 'application/json' }, chunks: ['{"ok":1}'] }); });
  const r = await E.defaultEdgarFetch(TICKERS, { timeoutMs: 3000 }); assert.equal(r.status, 200); assert.equal(r.body.toString(), '{"ok":1}'); assert.equal(n, 2);
});

test('guard: more than 3 redirects ends the fetch as a 503; three are followed (control)', async () => {
  let n = 0;
  fakeServer(({ respond }) => { n++; respond({ status: 302, headers: { location: 'https://www.sec.gov/next' } }); });
  const e = await refused(E.defaultEdgarFetch(TICKERS, { timeoutMs: 3000 }), /more than 3 redirects/); assert.equal(e.status, 503); assert.equal(n, 4);
  n = 0;
  fakeServer(({ respond }) => { n++; if (n <= 3) respond({ status: 302, headers: { location: 'https://www.sec.gov/next' } }); else respond({ headers: { 'content-type': 'application/json' }, chunks: ['{"ok":1}'] }); });
  assert.equal((await E.defaultEdgarFetch(TICKERS, { timeoutMs: 3000 })).status, 200);
});

test('guard: a document over the cap is TOO_LARGE whether the size is declared or only found while reading (the tool decides what that means); just under is read; the cap given by the caller is the one used', async () => {
  const MB = 1024 * 1024;
  fakeServer(({ respond }) => respond({ headers: { 'content-length': String(6 * MB), 'content-type': 'text/html' }, chunks: [] }));
  const a = await refused(E.defaultEdgarFetch('https://www.sec.gov/Archives/edgar/data/1/2/x.htm', { maxBytes: 5 * MB }), /-byte limit/); assert.equal(a.code, 'TOO_LARGE');
  const big = Buffer.alloc(MB, 97);
  fakeServer(({ respond }) => respond({ headers: { 'content-type': 'text/html' }, chunks: [big, big, big, big, big, big] }));
  const b = await refused(E.defaultEdgarFetch('https://www.sec.gov/Archives/edgar/data/1/2/x.htm', { maxBytes: 5 * MB }), /-byte limit/); assert.equal(b.code, 'TOO_LARGE');
  fakeServer(({ respond }) => respond({ headers: { 'content-type': 'text/html' }, chunks: [big, big, big, big] }));
  assert.equal((await E.defaultEdgarFetch('https://www.sec.gov/Archives/edgar/data/1/2/x.htm', { maxBytes: 5 * MB })).body.length, 4 * MB, 'control: under the cap is read');
  fakeServer(({ respond }) => respond({ headers: { 'content-type': 'text/html' }, chunks: [big, big] }));
  await refused(E.defaultEdgarFetch('https://www.sec.gov/Archives/edgar/data/1/2/x.htm', { maxBytes: MB }), /-byte limit/);
  assert.equal(E.MAX_DOC, 40000000, 'v2: documents are scanned as a stream, up to 40 MB'); assert.equal(E.MAX_JSON, 6 * MB, 'JSON documents are still read whole, up to 6 MiB');
});

test('guard: a server that never finishes is cut at the time limit and is a 503', async () => {
  fakeServer(({ respond }) => respond({ headers: { 'content-type': 'application/json' }, hang: true }));
  const t0 = Date.now(); const e = await refused(E.defaultEdgarFetch(TICKERS, { timeoutMs: 80 }), /timed out/); assert.equal(e.status, 503); assert.ok(Date.now() - t0 < 3000);
  fakeServer(() => { /* never answers at all */ });
  const silent = await refused(E.defaultEdgarFetch(TICKERS, { timeoutMs: 60 }), /ETIMEDOUT/); assert.equal(silent.status, 503); assert.match(silent.message, /Not charged\.$/);
});

test('guard: 404 is an answer, 403 and 429 are the SEC limiting us (503, retry in 5 minutes), 5xx is an outage (503), 200 is the body; the request carries the declared User-Agent, the guarded lookup, https and the 10 s limit', async () => {
  fakeServer(({ respond }) => respond({ status: 404, headers: { 'content-type': 'text/html' }, chunks: ['not found'] }));
  assert.equal((await E.defaultEdgarFetch(TICKERS)).status, 404);
  for (const status of [403, 429]) {
    fakeServer(({ respond }) => respond({ status, headers: { 'content-type': 'text/html' }, chunks: ['x'] }));
    const e = await refused(E.defaultEdgarFetch(TICKERS), /limiting requests/); assert.equal(e.status, 503); assert.equal(e.retryAfter, 300);
  }
  for (const status of [500, 502, 503]) {
    fakeServer(({ respond }) => respond({ status, headers: { 'content-type': 'text/html' }, chunks: ['x'] }));
    const e = await refused(E.defaultEdgarFetch(TICKERS), new RegExp(`HTTP ${status}`)); assert.equal(e.status, 503); assert.match(e.message, /Not charged\.$/);
  }
  const seen = fakeServer(({ respond }) => respond({ headers: { 'content-type': 'application/json' }, chunks: ['{"a":1}'] }));
  const ok = await E.defaultEdgarFetch(TICKERS, { timeoutMs: 30000 }); assert.equal(ok.status, 200); assert.equal(ok.body.toString(), '{"a":1}');
  assert.equal(seen[0].opts.lookup, SF.guardedLookup); assert.equal(seen[0].opts.method, 'GET'); assert.ok(seen[0].opts.timeout <= 30000);
  assert.equal(seen[0].opts.headers['user-agent'], 'AgentFeed ochinimus@gmail.com'); assert.equal(seen[0].opts.headers['accept-encoding'], 'identity'); assert.equal(seen[0].opts.headers.accept, 'application/json');
  assert.equal(E.UA, require('fs').readFileSync(require.resolve('../tools/sec.js'), 'utf8').match(/const UA = '([^']+)'/)[1], 'the User-Agent is the one tools/sec.js declares');
});
