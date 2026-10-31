// R23 T3: the address and port guard on this route's fetch path (31 Oct 2026).
// Mock sellers on 127.0.0.1 are refused by the real guard, so the money-path tests inject a stubbed socket. THIS file proves the guard itself for the two routes:
//   - every refusal at URL level (loopback, private, metadata, credentials, ports, http for the paid test) with a stubbed transport that records any request: there must be none;
//   - the DNS level (a name that resolves to a private address, alone or among public ones);
//   - with REAL sockets behind the REAL guard (test/fixtures/r23/x402/harness.js): a redirect to a private address, to the metadata address and to a name that resolves privately,
//     more than 3 redirects, an oversize body (declared and streamed), a connection that never answers, a stalled body, and a full lint and a full PAID test through TLS.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns');
const http = require('http');
const S = require('./fixtures/r23/x402/seller');
const H = require('./fixtures/r23/x402/harness');
const L = require('../tools/r23/x402/lint');
const T = require('../tools/r23/x402/test');
const R = require('../tools/r23/x402/rubric');
const { makeSpend } = require('../tools/r23/spend');

const kind = async (p) => { try { await p; return 'no error'; } catch (e) { return e.kind || (e.status ? `status ${e.status}` : e.message); } };
const msg = async (p) => { try { await p; return 'no error'; } catch (e) { return e.message; } };
let wallets;
test.before(async () => { wallets = await S.ephemeral(); });

const REFUSED = {
  'loopback v4': '127.0.0.1/x', 'loopback v6': '[::1]/x', 'mapped loopback': '[::ffff:127.0.0.1]/x', '10/8': '10.0.0.5/x', '172.16/12': '172.16.0.1/x', '192.168/16': '192.168.1.1/x',
  'cloud metadata': '169.254.169.254/latest/meta-data/', 'metadata v6': '[fd00:ec2::254]/x', 'CGNAT': '100.64.0.1/x', 'localhost': 'localhost/x', 'google metadata': 'metadata.google.internal/x', '.internal': 'db.internal/x', '.local': 'printer.local/x',
  'credentials': 'user:pw@example.com/x', 'port 8080': 'example.com:8080/x', 'port 22': 'example.com:22/x', 'port 8443': 'example.com:8443/x',
};

test('URL level: every refusal is a 400 on both routes, and not one request is made (a recording transport saw none); a public URL passes the same door (known positive)', async () => {
  const sel = S.makeSeller({}); const tr = S.stubTransport(sel.script);
  try {
    for (const [what, rest] of Object.entries(REFUSED)) {
      for (const scheme of ['http', 'https']) {
        const url = `${scheme}://${rest}`;
        assert.equal(await kind(L.lintEndpoint({ url })), 'bad_request', `lint ${what} ${scheme}`);
        if (scheme === 'https') assert.equal(await kind(T.runTest({ url }, { loadWallets: async () => wallets, balance: {}, spend: {} })), 'bad_request', `test ${what}`);
      }
    }
    for (const url of ['ftp://example.com/x', 'file:///etc/passwd', 'example.com/x', 'javascript:alert(1)', '']) assert.equal(await kind(L.lintEndpoint({ url })), 'bad_request', url);
    assert.equal(tr.calls.length, 0, 'no request was made for any refused URL');
    // known positive: the same door lets a public URL through to the transport
    const ok = await L.lintEndpoint({ url: `https://${S.HOST}${S.PATH}` }, {}); assert.equal(ok.verdict, 'valid'); assert.ok(tr.calls.length > 0);
  } finally { tr.restore(); }
});
test('the paid test is https only: an http URL is refused before the wallet is read, the lint runs or anything is reserved; the lint alone accepts http', async () => {
  const sel = S.makeSeller({}); const tr = S.stubTransport(sel.script); let loads = 0;
  try {
    assert.equal(await kind(T.runTest({ url: `http://${S.HOST}${S.PATH}` }, { loadWallets: async () => { loads++; return wallets; }, balance: {}, spend: {} })), 'bad_request');
    assert.equal(loads, 0); assert.equal(tr.calls.length, 0);
    const lint = await L.lintEndpoint({ url: `http://${S.HOST}${S.PATH}` });
    assert.equal(lint.checks.find((c) => c.id === 'http_402').pass, true, 'the lint reads an http endpoint');
    assert.deepEqual(lint.checks.filter((c) => !c.pass && c.severity !== 'info').map((c) => c.id), ['resource_url'], 'and notices that the resource URL says https while it was read over http');
    // and the lint of an https URL whose redirect goes to http is refused by the test (httpsOnly follows the redirect target too)
    const redir = S.makeSeller({ unpaid: () => ({ status: 302, headers: { location: `http://${S.HOST}/plain` }, body: '' }) }); tr.restore();
    const tr2 = S.stubTransport(redir.script);
    try { assert.equal(await kind(T.runTest({ url: `https://${S.HOST}${S.PATH}` }, { loadWallets: async () => wallets, balance: {}, spend: {} })), 'bad_request', 'a redirect from https to http is refused by the paid test'); } finally { tr2.restore(); }
  } finally { tr.restore(); }
});
test('DNS level: a name that resolves to a private address, alone or among public ones, is refused at connect time on both routes; a public answer is not (control)', async () => {
  const real = dns.lookup;
  const answer = (addrs) => { dns.lookup = (_h, _o, cb) => cb(null, addrs); };
  try {
    for (const addrs of [[{ address: '10.1.2.3', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }], [{ address: '::ffff:7f00:1', family: 6 }], [{ address: 'fd00:ec2::254', family: 6 }]]) {
      answer(addrs);
      assert.match(await msg(L.lintEndpoint({ url: 'http://rebind.example/x' })), /refused: rebind\.example resolves to a private or reserved address/);
      assert.equal(await kind(L.lintEndpoint({ url: 'https://rebind.example/x' })), 'bad_request');
      assert.equal(await kind(T.runTest({ url: 'https://rebind.example/x' }, { loadWallets: async () => wallets, balance: {}, spend: {} })), 'bad_request');
    }
    answer([{ address: '93.184.216.34', family: 4 }]);
    const e = await msg(L.lintEndpoint({ url: 'http://public.example/x' }, { mainTimeoutMs: 400 }));
    assert.doesNotMatch(e, /refused: .*private/, `a public answer is not refused by the guard: ${e}`);
  } finally { dns.lookup = real; }
});

// ---- real sockets behind the real guard
let ctx; let web; let tls; const hits = [];
test.before(async () => {
  ctx = H.install();
  const ok = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(body); };
  web = await H.httpServer((req, res) => {
    const host = req.headers.host; const p = req.url.split('?')[0];
    hits.push(`${req.method} ${host}${p}`);
    if (p === '/to-metadata') return ok(res, 302, '', { location: 'http://169.254.169.254/latest/meta-data/' });
    if (p === '/to-mapped') return ok(res, 302, '', { location: 'http://[::ffff:7f00:1]/x' });
    if (p === '/to-private-name') return ok(res, 302, '', { location: 'http://rebind.test/x' });
    if (p === '/to-private-ip') return ok(res, 301, '', { location: 'http://10.0.0.7/x' });
    if (p === '/to-creds') return ok(res, 302, '', { location: 'http://user:pw@seller.test/x' });
    if (p === '/to-port') return ok(res, 302, '', { location: 'http://seller.test:8080/x' });
    if (p === '/loop') return ok(res, 302, '', { location: `/loop?n=${Date.now()}` });
    if (p === '/big-declared') { res.writeHead(402, { 'content-type': 'application/json', 'content-length': String(R.LIMITS.maxBytes + 1) }); return res.end(Buffer.alloc(1024)); }
    if (p === '/big-streamed') { res.writeHead(402, { 'content-type': 'application/json' }); const chunk = Buffer.alloc(256 * 1024, 120); let n = 0; const iv = setInterval(() => { if (res.destroyed || n++ > 25) { clearInterval(iv); return res.end(); } res.write(chunk); }, 1); return undefined; }
    if (p === '/silent') return undefined;                                   // accepts the request and never answers
    if (p === '/stall') { res.writeHead(402, { 'content-type': 'application/json', 'content-length': '5000' }); res.write('{'); return undefined; }   // headers, then no body
    if (p === '/api/data') return ok(res, 402, '{}', { 'payment-required': S.b64({ x402Version: 2, error: 'Payment required', resource: { url: `http://seller.test${S.PATH}`, description: 'real socket fixture', mimeType: 'application/json' }, accepts: [S.offer('base', 2)] }), 'cache-control': 'no-store' });
    return ok(res, 404, '{"error":"not found"}');
  }, ctx);
});
test.after(async () => { ctx.restore(); await H.stop(web); if (tls) { tls.restoreCa(); await H.stop(tls); } });

test('real guard, real sockets: a lint of a good endpoint through the harness is valid, HEAD and spellings included (the harness works, so the refusals below are the guard and not a dead socket)', async () => {
  hits.length = 0;
  const out = await L.lintEndpoint({ url: 'http://seller.test/api/data' }, {});
  assert.equal(out.verdict, 'valid', JSON.stringify(out.checks.filter((c) => !c.pass)));
  assert.deepEqual([...hits].sort(), ['GET seller.test/API/DATA', 'GET seller.test/api/data', 'GET seller.test/api/data/', 'HEAD seller.test/api/data'].sort());
});
test('real guard, real sockets: a redirect to metadata, to a mapped loopback, to a name that resolves privately, to a private IP, to credentials or to another port is refused', async () => {
  for (const [p, re] of [['/to-metadata', /private, loopback and reserved addresses are refused/], ['/to-mapped', /private, loopback and reserved addresses are refused/], ['/to-private-name', /rebind\.test resolves to a private/],
    ['/to-private-ip', /private, loopback and reserved addresses are refused/], ['/to-creds', /credentials are refused/], ['/to-port', /only ports 80 and 443/]]) {
    hits.length = 0;
    const m = await msg(L.lintEndpoint({ url: `http://seller.test${p}` }, {}));
    assert.match(m, re, p); assert.deepEqual(hits, [`GET seller.test${p}`], `${p}: only the first hop was contacted`);
  }
});
test('real guard, real sockets: more than 3 redirects is a 503 (Not charged), after exactly the original request plus three', async () => {
  hits.length = 0;
  const e = await L.lintEndpoint({ url: 'http://seller.test/loop' }, {}).catch((x) => x);
  assert.equal(e.status, 503); assert.match(e.message, /more than 3 redirects.*Not charged\.$/); assert.equal(hits.length, 4);
});
test('real guard, real sockets: an oversize answer (declared, or streamed past the limit) is refused', async () => {
  assert.match(await msg(L.lintEndpoint({ url: 'http://seller.test/big-declared' }, {})), /over the 5242880-byte limit/);
  assert.match(await msg(L.lintEndpoint({ url: 'http://seller.test/big-streamed' }, {})), /over the 5242880-byte limit/);
});
test('real guard, real sockets: a connection that never answers, and a body that stalls after the headers, time out as a 503 (Not charged)', async () => {
  let e = await L.lintEndpoint({ url: 'http://seller.test/silent' }, { mainTimeoutMs: 300 }).catch((x) => x);
  assert.equal(e.status, 503); assert.match(e.message, /could not fetch seller\.test.*ETIMEDOUT.*Not charged\.$/);
  e = await L.lintEndpoint({ url: 'http://seller.test/stall' }, { mainTimeoutMs: 300 }).catch((x) => x);
  assert.equal(e.status, 503); assert.match(e.message, /timed out reading the document.*Not charged\.$/);
});
test('the numbers on the wire: 5 MB and 10 s on the request and the paid request, 512 KB and 6 s on the probes, redirects off and https only on the paid one (read from the options the fetch is given)', async () => {
  const seen = [];
  const sel = S.makeSeller({}); const tr = S.stubTransport(sel.script);
  const spy = (url, o) => { seen.push({ url, o }); return require('../lib/safe-fetch').safeFetch(url, o); };
  try {
    await L.lintEndpoint({ url: `https://${S.HOST}${S.PATH}` }, { fetch: spy });
    const main = seen[0].o; assert.deepEqual([main.maxBytes, main.timeoutMs, main.method, main.httpsOnly, typeof main.acceptStatus], [5 * 1024 * 1024, 10000, 'GET', false, 'function']);
    const probes = seen.slice(1); assert.equal(probes.length, 3); for (const p of probes) assert.deepEqual([p.o.maxBytes, p.o.timeoutMs], [512 * 1024, 6000]);
    seen.length = 0;
    const L2 = makeSpend({ file: ':memory:', caps: { x402test: { perCall: 0.05, perDay: 2 } } });
    const out = await T.runTest({ url: `https://${S.HOST}${S.PATH}` }, { fetch: spy, loadWallets: async () => wallets, balance: { base: async () => 10n ** 8n, solana: async () => 10n ** 8n }, spend: L2, caps: { perCall: 0.05, perDay: 2 } });
    L2.close();
    assert.equal(out.verdict, 'PASS');
    const paid = seen.find((s) => s.o.headers && s.o.headers['PAYMENT-SIGNATURE']).o;
    assert.deepEqual([paid.maxBytes, paid.timeoutMs, paid.httpsOnly, paid.maxRedirects, paid.method], [5 * 1024 * 1024, 10000, true, 0, 'GET']);
    const reread = seen.filter((s) => s.o.maxRedirects === 0 && !(s.o.headers && s.o.headers['PAYMENT-SIGNATURE'])); assert.equal(reread.length, 1, 'the second unpaid read also has redirects off');
    assert.ok(seen.every((s) => s.o.httpsOnly === true), 'every request of the paid test is https only');
    assert.equal(seen.filter((s) => s.o.headers && s.o.headers['PAYMENT-SIGNATURE']).length, 1);
  } finally { tr.restore(); }
});

test('real guard, real TLS, real sockets: a full PAID test through safe-fetch (https only, redirects off) settles once; a redirect on the paid request never reaches the other host', async (t) => {
  const sel = S.makeSeller({});
  const log = [];
  const handler = H.handlerFor(async (u, o) => { log.push({ host: u.host, path: u.pathname, paid: Boolean(o.headers['payment-signature']) }); return sel.script(u, o); }, 'https');
  tls = await H.tlsServer(handler, ctx);
  if (!tls) return t.skip('openssl is not available');
  const L1 = makeSpend({ file: ':memory:', caps: { x402test: { perCall: 0.05, perDay: 2 } } });
  const deps = { loadWallets: async () => wallets, balance: { base: async () => 10n ** 8n, solana: async () => 10n ** 8n }, spend: L1, caps: { perCall: 0.05, perDay: 2 } };
  try {
    const out = await T.runTest({ url: `https://seller.test${S.PATH}` }, deps);
    assert.equal(out.verdict, 'PASS', JSON.stringify(out.reasons)); assert.equal(sel.settles.length, 1); assert.equal(log.filter((l) => l.paid).length, 1);
    assert.equal(out.settlement.payer_is_test_wallet, true); assert.equal(L1.today('x402test'), 0.005);
    // redirect on the paid request: the other host (elsewhere.test, same TLS port) must never see a payment header
    const redir = S.makeSeller({ afterPay: () => ({ status: 307, headers: { location: 'https://elsewhere.test/steal' }, body: '' }) });
    const log2 = [];
    sel.script = null;
    const h2 = H.handlerFor(async (u, o) => { log2.push({ host: u.host, paid: Boolean(o.headers['payment-signature']) }); return redir.script(u, o); }, 'https');
    tls.removeAllListeners('request'); tls.on('request', h2);
    const out2 = await T.runTest({ url: `https://seller.test${S.PATH}` }, deps);
    assert.equal(out2.verdict, 'FAIL'); assert.match(out2.reasons[0], /redirect/);
    assert.equal(log2.filter((l) => l.host === 'elsewhere.test').length, 0, 'the redirect target was never contacted');
    assert.equal(log2.filter((l) => l.paid).length, 1, 'one payment header, sent to the linted URL only');
  } finally { L1.close(); }
});
