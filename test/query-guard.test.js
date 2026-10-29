// R20f (29 Oct 2026): an impossible QUERY value is refused before anyone is asked to pay (lib/query-rules.js, mounted by lib/param-guard.js).
// Unit level, no server boot: the rule table against PRICES, the way each rule reads a value (the handlers' own Number()/String() semantics, quirks
// included), the examples every document publishes, the middleware, the MCP schemas and the OpenAPI bounds.
// test/query-guard-real-server.test.js proves the one property that matters on the real stack: whatever the guard refuses, the handler refuses too.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const { PRICES } = require('../payments');
const META = require('../bazaar-examples.json').routes;
const ORIGIN = require('../tools/discovery').ORIGIN;
const { makeRouteUrls } = require('../lib/route-urls');
const { makeParamGuard } = require('../lib/param-guard');
const { QUERY_RULES, checkQuery } = require('../lib/query-rules');
const PS = require('../lib/param-schemas');

const routeUrls = makeRouteUrls({ ORIGIN, meta: META });
const NOW = Date.parse('2026-10-29T12:00:00Z');
const ctx = { now: NOW };
const verdict = (route, query) => checkQuery(route, query, ctx);
const ruleOf = (route, name) => QUERY_RULES[route].find((r) => r.name === name);

test('the rule table: every route is priced, every rule is described, no two rules share a name on a route', () => {
  const routes = Object.keys(QUERY_RULES);
  assert.ok(routes.length >= 18, `control: the table covers ${routes.length} routes`);
  let n = 0;
  for (const route of routes) {
    assert.ok(PRICES[route], `${route} is a priced route (a rule for a route that does not exist is never applied)`);
    assert.ok(/^GET /.test(route));
    const names = QUERY_RULES[route].map((r) => r.name);
    assert.equal(new Set(names).size, names.length, `${route}: rule names are unique (${names})`);
    for (const r of QUERY_RULES[route]) {
      n++;
      assert.equal(typeof r.check, 'function', `${route} ${r.name}`);
      assert.ok(typeof r.expected === 'string' && r.expected.length > 8, `${route} ${r.name} says what it expects`);
      assert.ok(['int', 'num', 'enum', 'custom'].includes(r.kind));
      if (r.kind === 'custom') assert.ok(r.samples && r.samples.ok.length && r.samples.bad.length, `${route} ${r.name}: custom rules carry their own ok and bad samples`);
    }
  }
  assert.ok(n >= 30, `control: ${n} rules`);
  const g = makeParamGuard({ PRICES, routeUrls, logger: { warn() { throw new Error('a rule for an unpriced route'); } } });
  assert.equal(g.queryRoutes.length, routes.length, 'the guard applies every rule route');
});

test('a missing parameter is never refused: the query-less URL of every route is what the catalogues list and it stays a 402', () => {
  for (const route of Object.keys(QUERY_RULES)) assert.equal(verdict(route, {}), null, `${route} with no query`);
  for (const route of Object.keys(QUERY_RULES)) {
    for (const r of QUERY_RULES[route]) {
      for (const empty of [undefined, null, '']) assert.equal(r.check({ [r.name]: empty }, ctx), null, `${route} ${r.name}=${JSON.stringify(empty)} is "not given"`);
    }
  }
});

test('every example the documents publish passes: the Bazaar input of each route, and the default each description names', () => {
  let looked = 0;
  for (const [route, m] of Object.entries(META)) {
    if (!QUERY_RULES[route]) continue;
    looked++;
    assert.equal(verdict(route, m.input || {}), null, `${route}: the published example ${JSON.stringify(m.input)} passes the guard`);
  }
  assert.ok(looked >= 10);
  // the defaults the descriptions and handlers name
  for (const [route, q] of [['GET /api/sol-token-flow/:mint', { swaps: '50' }], ['GET /api/sec-filings', { ticker: 'AAPL', limit: '10' }], ['GET /api/papers', { q: 'transformers', limit: '10', year_from: '2022' }],
    ['GET /api/base-launches', { min_liq_usd: '1000', limit: '20' }], ['GET /api/hash', { alg: 'sha256', data: 'hello', as: 'utf8' }], ['GET /api/qr', { data: 'x', format: 'png' }]]) {
    assert.equal(verdict(route, q), null, `${route} ${JSON.stringify(q)}`);
  }
});

test('integers are read the way the handlers read them: Number() on the raw value, so 1e2, 0x14 and 50.0 are integers and 20.5, abc and 1,5 are not', () => {
  const swaps = (v) => verdict('GET /api/sol-token-flow/:mint', { swaps: v });
  for (const v of ['20', '50', '100', '1e2', '0x14', '50.0', ' 50 ', '+60', 50, 20, 100, ['50']]) assert.equal(swaps(v), null, `swaps=${JSON.stringify(v)} is served by the handler`);
  for (const v of ['19', '101', '0', '-1', '20.5', 'abc', '1,5', '5e1x', 'Infinity', 'NaN', '1e9', ' ', 19, 101, 20.5, ['1', '2'], { a: '1' }]) {
    const r = swaps(v);
    assert.ok(r, `swaps=${JSON.stringify(v)} is refused`);
    assert.equal(r.rule.name, 'swaps');
    assert.match(r.message, /^swaps must be an integer from 20 to 100$/, 'the handler\'s own sentence');
  }
  // each integer range, both edges, one step outside
  for (const [route, name, lo, hi] of [['GET /api/sec-filings', 'limit', 1, 50], ['GET /api/insider-trades', 'days', 1, 180], ['GET /api/sec-8k', 'hours', 1, 72], ['GET /api/signal-board', 'n', 1, 60],
    ['GET /api/papers', 'limit', 1, 25], ['GET /api/hl-whales', 'top', 1, 50], ['GET /api/sol-token-flow/:mint', 'swaps', 20, 100]]) {
    for (const v of [lo, hi, String(lo), String(hi)]) assert.equal(verdict(route, { [name]: v }), null, `${route} ${name}=${v}`);
    for (const v of [lo - 1, hi + 1, String(lo - 1), String(hi + 1), String(lo + 0.5)]) assert.ok(verdict(route, { [name]: v }), `${route} ${name}=${v} is refused`);
  }
});

test('year_from follows the clock the way the handler does: 1000 up to next year', () => {
  const yf = (v, now = NOW) => checkQuery('GET /api/papers', { year_from: v }, { now });
  assert.equal(yf('1000'), null);
  assert.equal(yf('2026'), null);
  assert.equal(yf('2027'), null, 'next year is allowed');
  assert.ok(yf('2028'), 'the year after is not');
  assert.ok(yf('999'));
  assert.equal(yf('2028', Date.parse('2027-01-02T00:00:00Z')), null, 'and the limit moves with the clock');
});

test('fractions are fine where the handler says "a number": base-launches', () => {
  const bl = (q) => verdict('GET /api/base-launches', q);
  for (const q of [{ limit: '1.5' }, { limit: '100' }, { limit: '1' }, { min_liq_usd: '0' }, { min_liq_usd: '1e12' }, { min_liq_usd: '2500.75' }]) assert.equal(bl(q), null, JSON.stringify(q));
  for (const q of [{ limit: '0.99' }, { limit: '100.1' }, { limit: 'abc' }, { limit: 'Infinity' }, { min_liq_usd: '-1' }, { min_liq_usd: '1e13' }, { min_liq_usd: 'x' }]) assert.ok(bl(q), JSON.stringify(q));
});

test('words are compared lower-cased, exactly as the handlers do', () => {
  for (const [route, name, ok, bad] of [
    ['GET /api/qr', 'format', ['svg', 'PNG', 'Svg'], ['jpeg', ' svg', 'svg ', 'png,svg']],
    ['GET /api/hash', 'alg', ['sha256', 'SHA256', 'Keccak256', 'blake2b'], ['md5', 'sha-256', ' sha256', 'sha512']],
    ['GET /api/hash', 'as', ['utf8', 'HEX', 'Utf8'], ['base64', 'utf-8', 'hex ']],
    ['GET /api/summarize', 'length', ['short', 'MEDIUM'], ['long', 'medium ', 'tiny']],
  ]) {
    for (const v of ok) assert.equal(verdict(route, { [name]: v }), null, `${route} ${name}=${v}`);
    for (const v of bad) assert.ok(verdict(route, { [name]: v }), `${route} ${name}=${v} is refused`);
  }
});

test('the custom rules: every ok sample passes, every bad sample is refused', () => {
  let n = 0;
  for (const [route, list] of Object.entries(QUERY_RULES)) {
    for (const r of list.filter((x) => x.kind === 'custom')) {
      const q = (s) => (s !== null && typeof s === 'object' ? s : { [r.name]: s });
      const u = r.samples.unitOnly || { ok: [], bad: [] };
      for (const s of [...r.samples.ok, ...u.ok]) { n++; assert.equal(r.check(q(s), ctx), null, `${route} ${r.name} accepts ${JSON.stringify(s).slice(0, 80)}`); }
      for (const s of [...r.samples.bad, ...u.bad]) { n++; assert.ok(r.check(q(s), ctx), `${route} ${r.name} refuses ${JSON.stringify(s).slice(0, 80)}`); }
    }
  }
  assert.ok(n >= 100, `control: ${n} samples`);
});

test('rules that depend on another parameter read it the way the handler does', () => {
  // liq-feed: since is read only when next is not given
  assert.equal(verdict('GET /api/liq-feed', { next: '1792064900000.5', since: 'abc' }), null);
  assert.ok(verdict('GET /api/liq-feed', { since: 'abc' }));
  assert.ok(verdict('GET /api/liq-feed', { next: 'abc' }));
  assert.equal(verdict('GET /api/liq-feed', { next: '  ', since: '1792064900000' }), null, 'a blank next is "not given"');
  // hash: the hex rule applies only to as=hex, and only when data is there (a missing data is the handler\'s own "missing" answer)
  assert.equal(verdict('GET /api/hash', { alg: 'sha256', as: 'hex' }), null);
  assert.equal(verdict('GET /api/hash', { alg: 'sha256', as: 'hex', data: 'DEADbeef' }), null);
  assert.ok(verdict('GET /api/hash', { alg: 'sha256', as: 'hex', data: 'xyz1' }));
  assert.equal(verdict('GET /api/hash', { alg: 'sha256', data: 'xyz1' }), null, 'utf8 reads any text');
  // tradfi-radar: class, or its alias asset_class
  assert.ok(verdict('GET /api/tradfi-radar', { asset_class: 'bonds' }));
  assert.equal(verdict('GET /api/tradfi-radar', { asset_class: 'fx,rates' }), null);
  assert.equal(verdict('GET /api/tradfi-radar', { class: 'stock', asset_class: 'bonds' }), null, 'the handler reads class first');
});

test('a rule that throws lets the request through, and the order is the table order (the first broken rule answers)', () => {
  const boom = { name: 'boom', kind: 'custom', expected: 'anything at all', check() { throw new Error('rule bug'); }, samples: { ok: [''], bad: ['x'] } };
  const g = makeParamGuard({ PRICES, routeUrls, logger: { warn() {} }, queryRules: { 'GET /api/qr': [boom] } });
  assert.equal(g.checkQuery('GET /api/qr', { format: 'x' }), null, 'fail open');
  const first = verdict('GET /api/papers', { limit: '99', year_from: '5' });
  assert.equal(first.rule.name, 'limit');
});

test('middleware: an impossible query value is a 400 with the handler\'s sentence and nothing behind it runs; a possible one passes on', async () => {
  const hits = [];
  const app = express();
  app.use((req, _res, next) => { req.callerIp = '203.0.113.9'; next(); });
  const db = new (require('better-sqlite3'))(':memory:');
  const g = makeParamGuard({ PRICES, routeUrls, db, logger: { warn() {} }, now: () => NOW });
  app.use(g.middleware);
  app.use((req, res) => { hits.push(`${req.method} ${req.originalUrl}`); res.status(402).json({ behind: 'the paywall' }); });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = srv.address().port;
  const get = (p, method = 'GET') => new Promise((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'user-agent': 'unit' } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    q.on('error', reject); q.end();
  });
  try {
    const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    for (const [p, param] of [[`/api/sol-token-flow/${MINT}?swaps=5`, 'swaps'], ['/api/SOL-TOKEN-FLOW/' + MINT + '/?swaps=101', 'swaps'], ['/api/sec-8k?hours=0', 'hours'],
      ['/api/hash?alg=md5&data=x', 'alg'], ['/api/qr?data=x&format=jpeg', 'format'], ['/api/fx-rates?base=EURO', 'base'], ['/api/papers?q=x&limit=26', 'limit'],
      ['/api/hl-whales?top=0', 'top'], ['/api/signal-board?n=61', 'n'], ['/api/honeypot-check?token=0x123', 'token'], ['/api/wiki?title=x&lang=english', 'lang'],
      ['//api//sec-8k?hours=73', 'hours'], ['/api/base-launches?limit=0', 'limit']]) {
      const r = await get(p);
      assert.equal(r.status, 400, `${p} -> ${r.status} ${r.body.slice(0, 80)}`);
      const j = JSON.parse(r.body);
      assert.equal(j.param, param, p);
      assert.equal(j.charged, false);
      assert.ok(j.error && j.expected && j.received !== undefined && j.example.startsWith(ORIGIN + '/api/'), `the 400 says what is wrong, what is expected and a working URL: ${r.body.slice(0, 200)}`);
      assert.match(j.note, /nothing was charged/i);
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.ok(!r.headers['payment-required'] && !r.headers['www-authenticate'], 'no challenge of any kind');
    }
    assert.deepEqual(hits, [], 'nothing behind the guard ran for an impossible value');
    const body = JSON.parse((await get(`/api/sol-token-flow/${MINT}?swaps=5`)).body);
    assert.equal(body.error, 'swaps must be an integer from 20 to 100');
    assert.equal(body.received, '5');
    assert.equal(body.tool, 'get_sol_token_flow');
    // possible values (and the query-less URL, and routes without rules) reach the layer behind
    for (const p of [`/api/sol-token-flow/${MINT}?swaps=50`, `/api/sol-token-flow/${MINT}`, '/api/sec-8k', '/api/sec-8k?hours=72', '/api/hash?alg=SHA256&data=x', '/api/qr', '/api/qr?data=x&format=SVG',
      '/api/fx-rates?base=usd', '/api/liquidations?limit=999999', '/api/time?tz=Nowhere/Land', '/api/sec-8k?hours=', '/api/papers?q=x&year_from=2027']) {
      const r = await get(p);
      assert.equal(r.status, 402, `${p} reaches the layer behind`);
    }
    assert.equal(hits.length, 12);
    // the path rule answers first when both are wrong
    const both = JSON.parse((await get('/api/sol-token-flow/notamint?swaps=5')).body);
    assert.equal(both.param, 'mint');
    // other verbs are not this guard's business
    hits.length = 0;
    assert.equal((await get(`/api/sol-token-flow/${MINT}?swaps=5`, 'POST')).status, 402);
    assert.equal(hits.length, 1);
    // HEAD arrives as GET at this point of the real stack
    assert.equal((await get('/api/sec-8k?hours=0', 'HEAD')).status, 402, 'node http: a HEAD request is not a GET (server.js rewrites it earlier); documented, as in the path-parameter test');
    // refusals are counted, not logged per request
    const rows = db.prepare('SELECT route, kind, SUM(n) n FROM param_rejected GROUP BY route, kind ORDER BY route').all();
    assert.ok(rows.some((r) => r.kind === 'query' && r.route === 'get_sol_token_flow' && r.n >= 3), JSON.stringify(rows));
    assert.ok(rows.every((r) => r.kind !== 'query' || r.route), 'every counted row names its tool');
  } finally { srv.close(); db.close(); }
});

test('the switch: with the query rules off nothing is refused for its query, and the path rules still are', async () => {
  const app = express();
  const g = makeParamGuard({ PRICES, routeUrls, logger: { warn() {} }, queryRules: {} });
  app.use(g.middleware);
  app.use((req, res) => res.status(402).json({ behind: true }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const get = (p) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port: srv.address().port, path: p }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject); });
  try {
    assert.equal(g.queryRoutes.length, 0);
    assert.equal(await get('/api/sec-8k?hours=0'), 402);
    assert.equal(await get('/api/wallet-activity/notawallet'), 400);
  } finally { srv.close(); }
});

test('MCP: the integer and number bounds are in the input schema, so an impossible argument is refused before any payment prompt', () => {
  const swaps = PS.q('GET /api/sol-token-flow/:mint', 'swaps', 'x');
  assert.equal(swaps.safeParse(50).success, true);
  assert.equal(swaps.safeParse(undefined).success, true, 'optional');
  for (const bad of [5, 19, 101, 20.5, '50', NaN]) assert.equal(swaps.safeParse(bad).success, false, `swaps ${bad}`);
  const limit = PS.q('GET /api/base-launches', 'limit', 'x');
  assert.equal(limit.safeParse(1.5).success, true, 'a "number" rule keeps fractions');
  assert.equal(limit.safeParse(0.5).success, false);
  assert.equal(limit.safeParse(101).success, false);
  const yf = PS.q('GET /api/papers', 'year_from', 'x');
  assert.equal(yf.safeParse(2027).success, true);
  assert.equal(yf.safeParse(999).success, false);
  assert.equal(yf.safeParse(12345).success, false, 'four digits at most');
  assert.throws(() => PS.q('GET /api/qr', 'format', 'x'), /no int\/num query rule/);
  // every value the REST guard lets through is accepted by the MCP schema (the schema is never stricter than the guard)
  for (const route of Object.keys(QUERY_RULES)) {
    for (const r of QUERY_RULES[route].filter((x) => x.kind === 'int' || x.kind === 'num')) {
      const schema = PS.q(route, r.name, 'x');
      const hi = typeof r.max === 'function' ? r.max(ctx) : r.max;
      for (const v of [r.min, hi]) assert.equal(schema.safeParse(v).success, true, `${route} ${r.name}=${v}`);
    }
  }
});

test('documents: the Bazaar declaration and the OpenAPI document publish the bounds', () => {
  for (const [route, name, lo, hi] of [['GET /api/sol-token-flow/:mint', 'swaps', 20, 100], ['GET /api/sec-8k', 'hours', 1, 72], ['GET /api/hl-whales', 'top', 1, 50], ['GET /api/papers', 'limit', 1, 25]]) {
    const sc = META[route].inputSchema.properties[name];
    assert.equal(sc.minimum, lo, `${route} ${name} minimum`);
    assert.equal(sc.maximum, hi, `${route} ${name} maximum`);
  }
  assert.equal(META['GET /api/papers'].inputSchema.properties.year_from.minimum, 1000);
  const { buildOpenApi } = require('../tools/discovery');
  const spec = buildOpenApi({ PRICES, TAGS: require('../payments').TAGS, META, FREE_TOOLS: [], mpp: { active: false, routes: [] }, tempo: { active: false } });
  const p = spec.paths['/api/sec-8k'].get.parameters.find((x) => x.name === 'hours');
  assert.equal(p.schema.minimum, 1, JSON.stringify(p));
  assert.equal(p.schema.maximum, 72);
});
