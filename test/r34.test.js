// R34 (14 Nov 2026): not_found traffic turned into 402 offers, with no new data route.
// Unit tests for lib/path-normalize.js and lib/legacy-routes.js, and regression tests against the REAL server.js (test/helpers/real-server.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const Database = require('better-sqlite3');
const { normalize, makePathNormalizer } = require('../lib/path-normalize');
const H = require('./helpers/real-server');

// ---- unit: the normalizer
test('normalize: every debris case in the 7-day not_found sample', () => {
  const cases = {
    '/api/sol-price|eip155:8453': '/api/sol-price',
    '/api/sol-price%7Ceip155:8453': '/api/sol-price',
    '/api/sol-price%7ceip155:8453': '/api/sol-price',
    '/api/cascade%7Calgorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k': '/api/cascade',
    '/api/funding-pulse%7Calgorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=': '/api/funding-pulse',
    '/api/sol-price|solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': '/api/sol-price',
    '/api/extract-eip155:8453-0x22db3a9686ee5261e7bf3ed4f91277232e8076e6-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': '/api/extract',
    '/api/summarize-algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=-QWOWU2E6BB76HEQRRMXWZ2MU4HAQIYZWE': '/api/summarize',
    '/api/cascade-forecast:12': '/api/cascade-forecast',
    '/api/sol-price:': '/api/sol-price',
    '/api/sol-price&quot': '/api/sol-price',
    '/api/sol-price&quot;': '/api/sol-price',
    '/api/sol-price%22': '/api/sol-price',
    '/api/sol-price%22%22': '/api/sol-price',
  };
  for (const [from, to] of Object.entries(cases)) assert.equal(normalize(from), to, from);
});

test('normalize: a path with nothing to strip is null, and a hyphenated word is not a network tail', () => {
  for (const p of ['/api/sol-price', '/api/cascade-forecast', '/api/token-risk/abc', '/api/status', '/api/sol-price/', '/api/sol-price%7Ceip155:8453/', '/api/x;x=1', '/api/x%20']) assert.equal(normalize(p), null, p);
  assert.equal(normalize('/api/cascade-forecast:12'), '/api/cascade-forecast', 'the :digits rule wins over a network-looking word: "-forecast" is not a CAIP namespace');
});

const fake = (known) => { const r = { n: 0 }; return { r, mw: makePathNormalizer({ isKnown: (p) => known.includes(p) }) }; };
const run = (mw, method, url) => { const req = { method, url, originalUrl: url }; let called = 0; mw(req, {}, () => { called++; }); return { req, called }; };

test('middleware: a matching path is never touched, a candidate that matches is rewritten (url and originalUrl, query kept), a candidate that does not match is left alone', () => {
  const { mw } = fake(['/api/sol-price', '/api/token-risk/abc:12']);
  let r = run(mw, 'GET', '/api/sol-price'); assert.equal(r.req.url, '/api/sol-price'); assert.equal(r.req.pathNormalizedFrom, undefined);
  r = run(mw, 'GET', '/api/token-risk/abc:12'); assert.equal(r.req.url, '/api/token-risk/abc:12', 'a value with :digits in a path that matches as written is not stripped');
  r = run(mw, 'GET', '/api/sol-price:12?x=1&y=2'); assert.equal(r.req.url, '/api/sol-price?x=1&y=2'); assert.equal(r.req.originalUrl, '/api/sol-price?x=1&y=2'); assert.equal(r.req.pathNormalizedFrom, '/api/sol-price:12'); assert.equal(r.called, 1);
  r = run(mw, 'HEAD', '/api/sol-price%22'); assert.equal(r.req.url, '/api/sol-price');
  r = run(mw, 'GET', '/api/nothing:12'); assert.equal(r.req.url, '/api/nothing:12', 'the candidate matches no route: stays a 404');
  r = run(mw, 'POST', '/api/sol-price:12'); assert.equal(r.req.url, '/api/sol-price:12', 'only GET and HEAD');
  r = run(mw, 'GET', '/other/sol-price:12'); assert.equal(r.req.url, '/other/sol-price:12', 'only under /api/');
  assert.equal(r.called, 1);
});

test('middleware: it counts each rewrite for 7 days in path_normalized and never fails a request over the log', () => {
  const db = new Database(':memory:');
  const mw = makePathNormalizer({ isKnown: (p) => p === '/api/sol-price', db });
  run(mw, 'GET', '/api/sol-price:12'); run(mw, 'GET', '/api/sol-price:12'); run(mw, 'GET', '/api/sol-price&quot');
  const rows = db.prepare('SELECT original, normalized, n FROM path_normalized ORDER BY original').all();
  assert.deepEqual(rows, [{ original: '/api/sol-price&quot', normalized: '/api/sol-price', n: 1 }, { original: '/api/sol-price:12', normalized: '/api/sol-price', n: 2 }]);
  db.prepare("INSERT INTO path_normalized VALUES (date('now','-9 days'), '/old', '/api/x', 1)").run();
  makePathNormalizer({ isKnown: () => false, db });
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM path_normalized WHERE original = '/old'").get().c, 0, 'rows older than 7 days are pruned at start');
  const broken = makePathNormalizer({ isKnown: (p) => p === '/api/sol-price', db: { exec() { throw new Error('x'); } } });
  assert.equal(run(broken, 'GET', '/api/sol-price:12').req.url, '/api/sol-price', 'a database that cannot be written does not stop the rewrite');
});

// ---- the real server
let s; let ipN = 0;
const ip = () => { ipN++; return { 'cf-connecting-ip': `198.18.${(ipN >> 8) & 255}.${ipN & 255}` }; };
const get = (p, h = {}) => H.raw(s.port, 'GET', p, { ...ip(), ...h });
const head = (p, h = {}) => H.raw(s.port, 'HEAD', p, { ...ip(), ...h });
before(async () => { s = await H.boot(); });
after(() => { if (s) s.close(); });

const resourceOf = (r) => H.unb64(r.headers['payment-required']).resource.url;

test('real server: every debris spelling of a priced route answers its 402 unpaid, the challenge names the CLEAN resource, and no handler runs', async () => {
  const spellings = ['/api/sol-price:12', '/api/sol-price:', '/api/sol-price&quot', '/api/sol-price%22', '/api/sol-price%7Calgorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k', '/api/sol-price|algorand:abc=',
    '/api/sol-price-eip155:8453-0x22db3a9686ee5261e7bf3ed4f91277232e8076e6-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '/api/sol-price%7Ceip155:8453'];
  const control = await get('/api/sol-price');
  assert.equal(control.status, 402, 'control: the clean path answers 402');
  for (const p of spellings) {
    for (const f of [get, head]) {
      const r = await f(p);
      assert.equal(r.status, 402, `${f === get ? 'GET' : 'HEAD'} ${p}`);
      assert.ok(r.headers['payment-required'], `${p} carries the challenge`);
      assert.equal(resourceOf(r), resourceOf(control), `${p}: the challenge quotes the clean resource URL`);
    }
  }
  assert.deepEqual(s.handlerRuns(), [], 'no paid handler ran for any of them');
});

test('real server: it must not bypass payment (a bad payment on a normalized path is still refused) and a good payment settles against the clean route', async () => {
  const bad = await get('/api/time:12', { 'payment-signature': H.b64({ x402Version: 2, payload: {} }) });
  assert.equal(bad.status, 402);
  assert.deepEqual(s.handlerRuns(), [], 'a refused payment ran no handler');
  const ch = await get('/api/time:12');
  assert.equal(ch.status, 402);
  const pay = H.payBase(ch.headers['payment-required']);
  const ok = await get('/api/time:12', { 'payment-signature': H.b64(pay) });
  assert.equal(ok.status, 200, `paid: ${ok.body.slice(0, 200)}`);
  const settles = s.fac.log.filter((l) => l.op === 'settle');
  assert.equal(settles.length, 1);
  const rows = await H.rowsSince(s, 0);
  const paid = rows.filter((r) => r.status === 'paid');
  assert.equal(paid.length, 1); assert.equal(paid[0].req_path, '/api/time', 'the audit row names the clean path');
  const d = s.db();
  try { const n = d.prepare("SELECT original, normalized FROM path_normalized WHERE original = '/api/time:12'").get(); assert.deepEqual(n, { original: '/api/time:12', normalized: '/api/time' }); } finally { d.close(); }
});

test('real server: paths that match are never touched, and debris on an unknown route stays a 404', async () => {
  const exact = await get('/api/sol-price');
  assert.equal(exact.status, 402);
  const unknown = await get('/api/not-a-route-r34:12');
  assert.equal(unknown.status, 404);
  const unknown2 = await get('/api/not-a-route-r34%7Ceip155:8453');
  assert.equal(unknown2.status, 404);
  const d = s.db();
  try { assert.equal(d.prepare("SELECT COUNT(*) AS c FROM path_normalized WHERE original LIKE '%not-a-route%'").get().c, 0); } finally { d.close(); }
  // a parameter value that happens to carry :digits matches its route as written, so it is not stripped
  const param = await get('/api/token-metadata/So11111111111111111111111111111111111111112');
  assert.equal(param.status, 402);
});

test('real server: /telegraph/api/<name> is a 308 where /api/<name> exists, a 404 where it does not', async () => {
  const names = ['trade-context', 'sol-price', 'base-balance', 'base-gas', 'eth-price', 'btc-price', 'tvl', 'liquidation-leaders', 'squeeze-score'];
  for (const n of names) {
    const r = await get(`/telegraph/api/${n}`);
    assert.equal(r.status, 308, n); assert.match(r.headers.location, new RegExp(`/api/${n}$`));
  }
  assert.equal((await get('/telegraph/api/token-risk')).status, 404, 'token-risk has only /api/token-risk/{mint}: no twin of the bare name');
  assert.equal((await get('/telegraph/api/not-a-name')).status, 404);
});

test('real server: /api/funding and /api/funding-rates are 308s to /api/funding-rate and keep the query', async () => {
  for (const p of ['/api/funding', '/api/funding-rates', '/api/funding/', '/API/Funding']) {
    const r = await get(p + '?symbol=SOL');
    assert.equal(r.status, 308, p); assert.equal(r.headers.location, '/api/funding-rate?symbol=SOL', p);
  }
  assert.equal((await get('/api/funding-rate')).status, 402, 'control: the target is a priced route');
  assert.equal((await get('/api/funding-extremes')).status, 402, 'control: its neighbours are untouched');
});

test('real server: /api/wallet-holdings and /api/wallet-activity with no wallet are a 400 with an example, the query form and the path form are untouched', async () => {
  for (const n of ['wallet-holdings', 'wallet-activity']) {
    for (const p of [`/api/${n}`, `/api/${n}/`]) {
      const r = await get(p);
      assert.equal(r.status, 400, p);
      const j = JSON.parse(r.body);
      assert.equal(j.example_path, `/api/${n}/<wallet-address>`); assert.match(j.error, /wallet address is required/);
      assert.ok(!r.headers['payment-required'], 'no challenge: nothing to pay');
    }
  }
  const W = '11111111111111111111111111111111';
  assert.equal((await get(`/api/wallet-holdings/${W}`)).status, 402, 'path form: still the paywall');
  assert.equal((await get(`/api/wallet-holdings?wallet=${W}`)).status, 402, 'query form: rewritten by the existing canonicalisation, still the paywall');
});

test('real server: /api/<route>/openapi.json and /api/<route>/.well-known/x402 are 308s to the real documents; other sub-paths are not', async () => {
  for (const r0 of ['tvl', 'price', 'sol-price', 'token-risk']) {
    let r = await get(`/api/${r0}/openapi.json`); assert.equal(r.status, 308, r0); assert.equal(r.headers.location, '/openapi.json');
    r = await get(`/api/${r0}/.well-known/x402`); assert.equal(r.status, 308, r0); assert.equal(r.headers.location, '/.well-known/x402');
  }
  assert.equal((await get('/openapi.json')).status, 200, 'control: the target answers');
  assert.equal((await get('/.well-known/x402')).status, 200);
  assert.equal((await get('/api/tvl/other.json')).status, 404);
  assert.equal((await get('/api/sol-price/extra')).status, 404);
});

test('real server: /llms-full.txt, /apis.json and /.well-known/x402-payto.json are plain data with no e-mail address', async () => {
  const ll = await get('/llms.txt'); const full = await get('/llms-full.txt'); const apis = await get('/apis.json'); const pt = await get('/.well-known/x402-payto.json');
  for (const r of [ll, full, apis, pt]) assert.equal(r.status, 200);
  assert.ok(full.body.startsWith(ll.body.replace(/\s+$/, '')), 'llms-full.txt starts with llms.txt, so they cannot disagree');
  const spec = JSON.parse((await get('/openapi.json')).body);
  const priced = Object.entries(spec.paths).filter(([p, o]) => o.get && o.get['x-payment-info']).length;
  const heads = (full.body.match(/^### GET /gm) || []).length;
  assert.ok(heads >= priced, `the catalog lists every priced route (${heads} headings, ${priced} priced in openapi)`);
  assert.match(full.body, /- price: \$0\.001 per call/);
  const a = JSON.parse(apis.body);
  assert.equal(a.specificationVersion, '0.14'); assert.equal(a.apis[0].baseURL, 'https://x402.ochinimus.app'); assert.ok(a.apis[0].properties.some((p) => p.type === 'Swagger' && p.url.endsWith('/openapi.json')));
  const p = JSON.parse(pt.body);
  const challenge = H.unb64((await get('/api/sol-price')).headers['payment-required']);
  assert.ok(challenge.accepts.length >= 2);
  for (const acc of challenge.accepts) assert.ok(p.payTo.some((x) => x.network === acc.network && x.payTo.toLowerCase() === String(acc.payTo).toLowerCase()), `payto.json lists ${acc.network}`);
  for (const r of [full, apis, pt]) { assert.ok(!/@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(r.body.replace(/@seekdaseek|@x402|@modelcontextprotocol/g, '')), 'no e-mail address'); }
});
