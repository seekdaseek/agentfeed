// test/r23-pkgcheck-guard.test.js: the SSRF guard on every upstream call of /api/pkg-check (R23 T5), against the REAL lib/safe-fetch.js and the real POST helper.
// Nothing here opens a socket to the outside: https.request is replaced by a script that plays the server (a redirect, a huge body, a silent one), and dns.lookup by a table.
// The hosts the tool calls are fixed, so a refusal means a registry, a CDN redirect or a DNS answer went wrong; the tool must then say 503 "Not charged." and never blame the caller (400).
// Negative controls: guardedLookup is shown to let a public address through (so "refused" is the guard's decision, not a broken lookup); the allowed-URL lock is shown to be separate from safe-fetch's.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const dns = require('dns');
const { EventEmitter } = require('events');
const SF = require('../lib/safe-fetch');
const H = require('../tools/r23/pkg-check-http');
const P = require('../tools/r23/pkg-check');
const W = require('./fixtures/r23/pkgcheck/world');

const realRequest = https.request;
const realLookup = dns.lookup;
test.afterEach(() => { https.request = realRequest; dns.lookup = realLookup; });

/** https.request replacement: `script({ req, respond, u, opts, payload })` runs when the request is ended */
function fakeServer(script) {
  const seen = [];
  https.request = (u, opts, cb) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = (err) => { req.destroyed = true; if (err) setImmediate(() => req.emit('error', err)); };
    req.end = (payload) => {
      setImmediate(() => script({
        req, u, opts, payload, seen,
        respond: ({ status = 200, headers = {}, chunks = [], hang = false }) => {
          const res = new EventEmitter();
          res.statusCode = status; res.headers = headers; res.resume = () => {}; res.destroy = () => { res.destroyed = true; };
          cb(res);
          if (hang) return;
          setImmediate(() => { for (const c of chunks) res.emit('data', Buffer.isBuffer(c) ? c : Buffer.from(c)); res.emit('end'); });
        },
      }));
    };
    seen.push({ u, opts });
    return req;
  };
  return seen;
}
// (raced with a hard deadline: a missing timer or cap must FAIL a test, not hang it)
const refused = async (promise, pattern) => {
  const guard = new Promise((_, rej) => { setTimeout(() => rej(new Error('test deadline: the call neither finished nor was refused within 3 s')), 3000).unref(); });
  try { await Promise.race([promise, guard]); } catch (e) { if (pattern) assert.match(e.message, pattern); return e; }
  assert.fail('expected a refusal');
};

const GETS = [
  ['an http URL', 'http://registry.npmjs.org/x', /https/],
  ['a private IPv4 literal', 'https://10.0.0.1/x', /fixed hosts|private/],
  ['loopback', 'https://127.0.0.1/x', /fixed hosts|private/],
  ['the cloud metadata address', 'https://169.254.169.254/latest', /fixed hosts|private/],
  ['an IPv6 loopback literal', 'https://[::1]/x', /fixed hosts|private/],
  ['an IPv4-mapped IPv6 literal', 'https://[::ffff:7f00:1]/x', /fixed hosts|private/],
  ['credentials in the URL', 'https://user:pw@registry.npmjs.org/x', /fixed hosts|credentials/],
  ['a port other than 80 and 443', 'https://registry.npmjs.org:8443/x', /fixed hosts|ports/],
  ['a host that is not one of the five', 'https://registry.npmjs.org.evil.example/x', /fixed hosts/],
  ['a local name', 'https://localhost/x', /fixed hosts|local/],
];

test('guard: the outer lock refuses every unsafe URL for GET and POST before anything is sent', async () => {
  const seen = fakeServer(() => assert.fail('a request was sent'));
  for (const [what, url] of GETS) {
    await refused(H.get(url), undefined); await refused(H.post(url, { a: 1 }), undefined);
    assert.equal(seen.length, 0, what);
  }
});

test('guard: lib/safe-fetch.js refuses the same URLs on its own (the second lock; the outer lock is not what is being relied on)', async () => {
  const seen = fakeServer(() => assert.fail('a request was sent'));
  for (const [what, url, pattern] of GETS.filter((g) => g[0] !== 'a host that is not one of the five')) {
    const e = await refused(SF.safeFetch(url, { maxBytes: 1000, httpsOnly: true, userAgent: 't' }), undefined);
    assert.equal(e.kind, 'bad_request', what);
    void pattern;
  }
  assert.equal(seen.length, 0);
  // the POST helper calls the same checkUrl(url, { httpsOnly: true }) after the outer lock: it refuses an http OSV URL, credentials and a port on its own
  for (const url of ['http://api.osv.dev/v1/query', 'https://u:p@api.osv.dev/v1/query', 'https://api.osv.dev:8443/v1/query']) assert.throws(() => SF.checkUrl(url, { httpsOnly: true }), (e) => e.kind === 'bad_request', url);
  assert.doesNotThrow(() => SF.checkUrl('https://api.osv.dev/v1/query', { httpsOnly: true }), 'negative control: the real OSV URL passes');
});

test('guard: a name that resolves to a private address is refused inside the socket lookup, for GET and for POST, and no data is sent', async () => {
  dns.lookup = (host, opts, cb) => { if (typeof opts === 'function') cb = opts; cb(null, [{ address: '10.1.2.3', family: 4 }]); };
  const e = await refused(H.get('https://registry.npmjs.org/lodash', { timeoutMs: 3000 }), undefined);
  assert.match(e.message, /private|reserved/, 'GET: the guard said no, not a connection error');
  const p = await refused(H.post('https://api.osv.dev/v1/query', { a: 1 }, { timeoutMs: 3000 }), undefined);
  assert.match(p.message, /private|reserved/, 'POST: the guard said no');
  // one private address among public ones is enough to refuse (rebinding mix)
  dns.lookup = (host, opts, cb) => { if (typeof opts === 'function') cb = opts; cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '192.168.0.9', family: 4 }]); };
  await refused(H.get('https://registry.npmjs.org/lodash', { timeoutMs: 3000 }), /private|reserved/);
});

test('guard (negative control): the same lookup with only public addresses is let through, so the refusals above are the guard deciding', async () => {
  const answers = [];
  dns.lookup = (host, opts, cb) => { if (typeof opts === 'function') cb = opts; cb(null, [{ address: '93.184.216.34', family: 4 }]); };
  await new Promise((resolve) => SF.guardedLookup('registry.npmjs.org', {}, (err, addr, fam) => { answers.push([err, addr, fam]); resolve(); }));
  assert.deepEqual(answers, [[null, '93.184.216.34', 4]]);
  dns.lookup = (host, opts, cb) => { if (typeof opts === 'function') cb = opts; cb(null, [{ address: '10.0.0.8', family: 4 }]); };
  await new Promise((resolve) => SF.guardedLookup('registry.npmjs.org', {}, (err) => { answers.push([err && err.code]); resolve(); }));
  assert.deepEqual(answers[1], ['EPRIVATE']);
});

test('guard: a redirect to a private or non-https address is refused (GET re-checks every hop); a POST does not follow redirects at all', async () => {
  for (const target of ['http://169.254.169.254/latest/meta-data/', 'https://10.0.0.1/x', 'https://127.0.0.1:443/x', 'https://registry.npmjs.org:9999/x', 'https://u:p@registry.npmjs.org/x', 'http://registry.npmjs.org/x']) {
    const seen = fakeServer(({ respond }) => respond({ status: 302, headers: { location: target } }));
    await refused(H.get('https://registry.npmjs.org/lodash', { timeoutMs: 3000 }), undefined);
    assert.equal(seen.length, 1, `GET: one request, the redirect to ${target} was not followed`);
  }
  const seen = fakeServer(({ respond }) => respond({ status: 307, headers: { location: 'https://registry.npmjs.org/elsewhere' } }));
  await refused(H.post('https://api.osv.dev/v1/query', { a: 1 }), /redirect.*not followed/);
  assert.equal(seen.length, 1, 'POST: the 307 target was not requested');
});

test('guard: more than 3 redirects ends the fetch; three are followed (negative control)', async () => {
  let n = 0;
  fakeServer(({ respond }) => { n++; respond({ status: 302, headers: { location: 'https://registry.npmjs.org/next' } }); });
  await refused(H.get('https://registry.npmjs.org/lodash', { timeoutMs: 3000 }), /more than 3 redirects/);
  assert.equal(n, 4, 'the original request plus three redirects');
  n = 0;
  fakeServer(({ respond }) => { n++; if (n <= 3) respond({ status: 302, headers: { location: 'https://registry.npmjs.org/next' } }); else respond({ status: 200, headers: { 'content-type': 'application/json' }, chunks: ['{"ok":1}'] }); });
  const res = await H.get('https://registry.npmjs.org/lodash', { timeoutMs: 3000 });
  assert.equal(res.status, 200); assert.equal(res.body.toString(), '{"ok":1}');
});

test('guard: a body over 5 MB is refused whether the size is declared or only discovered while reading; just under is read (GET and POST)', async () => {
  const MB = 1024 * 1024;
  const declared = { 'content-length': String(6 * MB), 'content-type': 'application/json' };
  fakeServer(({ respond }) => respond({ headers: declared, chunks: [] }));
  await refused(H.get('https://registry.npmjs.org/big'), /-byte limit/);
  await refused(H.post('https://api.osv.dev/v1/query', {}), /-byte limit/);
  const big = Buffer.alloc(MB, 97);
  fakeServer(({ respond }) => respond({ headers: { 'content-type': 'application/json' }, chunks: [big, big, big, big, big, big] }));
  await refused(H.get('https://registry.npmjs.org/big'), /-byte limit/);
  await refused(H.post('https://api.osv.dev/v1/query', {}), /-byte limit/);
  fakeServer(({ respond }) => respond({ headers: { 'content-type': 'application/json' }, chunks: [big, big, big, big] }));
  assert.equal((await H.get('https://registry.npmjs.org/ok')).body.length, 4 * MB);
  assert.equal((await H.post('https://api.osv.dev/v1/query', {})).body.length, 4 * MB, 'negative control: under the cap is served');
});

test('guard: a server that never finishes is cut at the time limit (GET and POST)', async () => {
  fakeServer(({ respond }) => respond({ headers: { 'content-type': 'application/json' }, hang: true }));
  const t0 = Date.now();
  await refused(H.get('https://registry.npmjs.org/slow', { timeoutMs: 80 }), /timed out/);
  await refused(H.post('https://api.osv.dev/v1/query', {}, { timeoutMs: 80 }), /timed out/);
  assert.ok(Date.now() - t0 < 3000);
  fakeServer(() => { /* never answers at all */ });
  await refused(H.post('https://api.osv.dev/v1/query', {}, { timeoutMs: 60 }), /timed out/);
  assert.equal(H.MAX_TIMEOUT_MS, 10000, 'the cap passed down is 10 s');
});

test('guard: GET returns a 404 / 429 / 5xx as a status (the tool decides what it means); POST sends the JSON body with the right headers', async () => {
  for (const status of [404, 429, 500, 503]) {
    fakeServer(({ respond }) => respond({ status, headers: { 'content-type': 'application/json' }, chunks: ['{"error":"x"}'] }));
    const r = await H.get('https://registry.npmjs.org/x');
    assert.equal(r.status, status);
  }
  let captured;
  fakeServer(({ respond, opts, payload }) => { captured = { opts, payload }; respond({ headers: { 'content-type': 'application/json; charset=utf-8' }, chunks: ['{"vulns":[]}'] }); });
  const res = await H.post('https://api.osv.dev/v1/query', { version: '1.0.0', package: { name: 'x', ecosystem: 'npm' } });
  assert.equal(res.status, 200); assert.equal(res.contentType, 'application/json');
  assert.equal(captured.opts.method, 'POST'); assert.equal(captured.opts.lookup, SF.guardedLookup, 'the connection uses the guarded lookup');
  assert.deepEqual(JSON.parse(captured.payload.toString()), { version: '1.0.0', package: { name: 'x', ecosystem: 'npm' } });
  assert.equal(captured.opts.headers['content-length'], captured.payload.length); assert.equal(captured.opts.headers['content-type'], 'application/json');
  assert.match(captured.opts.headers['user-agent'], /^agentfeed-pkgcheck\//);
});

test('guard: the GET path passes the lookup guard and 5 MB / 10 s caps to the connection', async () => {
  const seen = fakeServer(({ respond }) => respond({ headers: { 'content-type': 'application/json' }, chunks: ['{}'] }));
  await H.get('https://registry.npmjs.org/x', { timeoutMs: 30000 });
  assert.equal(seen[0].opts.lookup, SF.guardedLookup); assert.equal(seen[0].opts.method, 'GET');
  assert.ok(seen[0].opts.timeout <= 10000, `socket timeout ${seen[0].opts.timeout}`);
  assert.match(seen[0].opts.headers['user-agent'], /^agentfeed-pkgcheck\//); assert.equal(seen[0].opts.headers['accept-encoding'], 'identity');
});

test('guard -> tool: every refusal from the guard reaches the caller as a 503 "Not charged." (never a 400 that blames the caller), for the registry and for OSV', async () => {
  const w = W.makeWorld();
  const refusals = [
    Object.assign(new Error('refused: registry.npmjs.org resolves to a private or reserved address'), { kind: 'bad_request' }),
    Object.assign(new Error('only https URLs are fetched'), { kind: 'bad_request' }),
    Object.assign(new Error('document is 9999999 bytes, over the 5242880-byte limit'), { kind: 'bad_request' }),
    Object.assign(new Error('more than 3 redirects'), { status: 503 }),
    Object.assign(new Error('timed out'), { upstream: true }),
  ];
  for (const err of refusals) {
    const down = P.makeCheck({ ...w.deps, get: async () => { throw err; }, lists: W.lists() });
    for (const args of [{ name: 'example-widget-kit', ecosystem: 'npm' }, { name: 'example-pylib', ecosystem: 'pypi', version: '1.1.0' }]) {
      const e = await refused(down.check(args));
      assert.equal(e.status, 503, err.message); assert.notEqual(e.kind, 'bad_request'); assert.match(e.message, /Not charged\.$/);
    }
    const osvDown = P.makeCheck({ ...w.deps, post: async () => { throw err; }, lists: W.lists() });
    const e = await refused(osvDown.check({ name: 'example-widget-kit', ecosystem: 'npm' }));
    assert.equal(e.status, 503, `OSV: ${err.message}`); assert.notEqual(e.kind, 'bad_request');
  }
});
