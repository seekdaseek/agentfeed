// R32: the 402 PAYMENT-REQUIRED header must stay clear of aiohttp's 8,190 B header-value limit (Pitcrew, 24 Nov 2026: /api/oi-spike-scan answered 8,312 B, so Python agents
// got a client error instead of our 402). The REAL server.js is booted (test/helpers/real-server.js), every paid route in its own /.well-known/x402 catalog is asked unpaid, and
// the header is measured. A new route, a longer description or a bigger example can never push a header past the limit again without this failing.
//
// The harness runs 4 offers, production runs 12 (3,296-3,341 B on the live default list), so the measured size is PROJECTED to production by swapping the harness's offers for
// ACCEPTS_PROD_BYTES, the same figure payments.js fits against. The limit asserted here is 7,500 B, 690 B under aiohttp's.
'use strict';
require('./helpers/box-dbs-scratch');
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const H = require('./helpers/real-server');
const { capExample, MAX_EXAMPLE_BYTES } = require('../lib/example-cap');

const LIMIT = 7500;                 // what this test enforces
const AIOHTTP_LIMIT = 8190;         // what aiohttp enforces
const ACCEPTS_PROD_BYTES = 3350;    // payments.js ACCEPTS_FLOOR_BYTES: 12 production offers
const b64len = (n) => Math.ceil(n / 3) * 4;

let s;
const rows = [];
let n = 0;
const ip = () => ({ 'cf-connecting-ip': `198.19.${(++n >> 8) & 255}.${n & 255}` });

before(async () => {
  s = await H.boot();
  const wk = JSON.parse((await H.raw(s.port, 'GET', '/.well-known/x402', ip())).body);
  for (const r of wk.resourceCatalog) {
    const u = new URL(r.url);
    const res = await H.raw(s.port, r.method || 'GET', u.pathname + u.search, ip());
    const h = res.headers['payment-required'] || '';
    const dec = h ? H.unb64(h) : null;
    const acc = dec ? Buffer.byteLength(JSON.stringify(dec.accepts)) : 0;
    const decBytes = dec ? Buffer.byteLength(JSON.stringify(dec)) : 0;
    rows.push({ route: u.pathname, status: res.status, header: Buffer.byteLength(h), wwwAuth: Buffer.byteLength(res.headers['www-authenticate'] || ''), projected: b64len(decBytes - acc + ACCEPTS_PROD_BYTES), offers: dec ? dec.accepts.length : 0 });
  }
});
after(() => { if (s) s.close(); });

test('the catalog is the paid surface: 100+ routes, every one answers an unpaid 402 with the header', () => {
  assert.ok(rows.length >= 100, `catalog has ${rows.length} routes`);
  const bad = rows.filter((r) => r.status !== 402 || r.header === 0);
  assert.deepEqual(bad.map((r) => `${r.route} ${r.status}`), []);
});

test(`every route's payment-required header, projected to production's offers, is under ${LIMIT} B`, () => {
  const over = rows.filter((r) => r.projected >= LIMIT).sort((a, b) => b.projected - a.projected);
  assert.deepEqual(over.map((r) => `${r.route} ${r.projected} B`), []);
  assert.ok(Math.max(...rows.map((r) => r.projected)) < AIOHTTP_LIMIT);
});

test(`the header as measured on this server is under ${LIMIT} B on every route, and so is www-authenticate`, () => {
  assert.deepEqual(rows.filter((r) => r.header >= LIMIT).map((r) => `${r.route} ${r.header} B`), []);
  assert.deepEqual(rows.filter((r) => r.wwwAuth >= LIMIT).map((r) => `${r.route} www-authenticate ${r.wwwAuth} B`), []);
});

test('the Pitcrew route /api/oi-spike-scan is far under the limit', () => {
  const r = rows.find((x) => x.route === '/api/oi-spike-scan');
  assert.ok(r, 'route in the catalog');
  assert.ok(r.projected < LIMIT, `projected ${r.projected} B (was 8,312 B live)`);
});

test('no offer is touched: every route still lists payTo, amount, network and asset on each of its offers', () => {
  // the example is the only thing the fit may shrink; a missing field here would mean an offer was cut
  return (async () => {
    const wk = JSON.parse((await H.raw(s.port, 'GET', '/.well-known/x402', ip())).body);
    for (const r of wk.resourceCatalog.slice(0, 30)) {
      const u = new URL(r.url);
      const dec = H.unb64((await H.raw(s.port, 'GET', u.pathname + u.search, ip())).headers['payment-required']);
      assert.ok(dec.accepts.length >= 4, `${u.pathname} offers`);
      for (const a of dec.accepts) for (const k of ['scheme', 'network', 'amount', 'asset', 'payTo']) assert.ok(a[k] !== undefined && a[k] !== '', `${u.pathname} ${a.network} lacks ${k}`);
    }
  })();
});

// ---- the cap itself ----
const ser = (v) => Buffer.byteLength(JSON.stringify(v));
test('capExample: a value within the cap is returned as is (same reference)', () => {
  const v = { tool: 'x', data: { a: 1 }, paid: true };
  assert.equal(capExample(v), v);
});
test('capExample: a big envelope shrinks to <= 600 B, keeps its top-level keys, trims arrays to 2 and shortens strings', () => {
  const big = { tool: 'get_x', data: { rows: Array.from({ length: 40 }, (_, i) => ({ id: i, name: 'n'.repeat(80), v: i * 1.5 })), note: 'z'.repeat(900), count: 40 }, paid: false };
  const out = capExample(big);
  assert.ok(ser(out) <= MAX_EXAMPLE_BYTES, `${ser(out)} B`);
  assert.deepEqual(Object.keys(out), ['tool', 'data', 'paid']);
  assert.ok(out.data.rows.length <= 2);
  assert.equal(out.data.count, 40);
  assert.ok(ser(big) > 3000, 'input was not mutated');
});
test('capExample: never mutates the input, is deterministic, and meets any cap down to 30 B', () => {
  const big = { a: Array.from({ length: 50 }, () => ({ s: 'q'.repeat(200), n: [1, 2, 3, 4, 5] })), b: { c: { d: { e: { f: 'deep'.repeat(100) } } } } };
  const copy = JSON.stringify(big);
  for (const cap of [600, 300, 120, 60, 30]) { const o1 = capExample(big, cap), o2 = capExample(big, cap); assert.ok(ser(o1) <= cap, `cap ${cap}: ${ser(o1)}`); assert.deepEqual(o1, o2); }
  assert.equal(JSON.stringify(big), copy);
});
test('capExample: every real example in bazaar-examples.json fits 600 B', () => {
  const routes = require('../bazaar-examples.json').routes;
  let n2 = 0;
  for (const [route, m] of Object.entries(routes)) { if (!m.output || !m.output.example) continue; n2++; assert.ok(ser(capExample(m.output.example)) <= MAX_EXAMPLE_BYTES, route); }
  assert.ok(n2 > 90);
});
