// R20e (29 Oct 2026): an impossible path parameter is refused before anyone is asked to pay (lib/param-guard.js), and no document publishes a
// literal template. Unit level, no server boot: the rule table, the guard against the handlers' own validators, the published examples, the
// MCP schemas and the documents. test/param-guard-real-server.test.js proves the same on the real middleware stack.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const { PRICES } = require('../payments');
const META = require('../bazaar-examples.json').routes;
const ORIGIN = require('../tools/discovery').ORIGIN;
const { makeRouteUrls } = require('../lib/route-urls');
const { makeParamGuard, PLACEHOLDER_RE, EXPECTED } = require('../lib/param-guard');
const PS = require('../lib/param-schemas');
const { BASE58_RE } = require('../lib/solrpc');

const routeUrls = makeRouteUrls({ ORIGIN, meta: META });
const guard = makeParamGuard({ PRICES, routeUrls, logger: { warn() {} } });
const PARAM_ROUTES = Object.keys(PRICES).filter((k) => /^GET /.test(k) && /\/:[A-Za-z0-9_]+/.test(k));
const nameOf = (pattern) => /:([A-Za-z0-9_]+)$/.exec(pattern)[1];

test('every priced path-parameter route has a validator, and there are twelve of them', () => {
  assert.equal(PARAM_ROUTES.length, 12, `control: the route table has 12 path-parameter routes (${PARAM_ROUTES.join(', ')})`);
  assert.deepEqual(guard.unguarded, [], 'a path-parameter route without a validator is unguarded: add one to lib/param-guard.js validators() and EXPECTED');
  assert.deepEqual(guard.rules.map((r) => r.pattern).sort(), [...PARAM_ROUTES].sort());
  for (const r of guard.rules) assert.ok(EXPECTED[r.name], `${r.name} has an "expected" sentence`);
  // a route that ends in a param is the only shape supported; a second param or a mid-path param would be reported, not guessed
  for (const pattern of PARAM_ROUTES) assert.match(pattern, /^GET \/api\/[a-z0-9-]+\/:[a-z]+$/, `${pattern} has the one-trailing-param shape the guard reads`);
});

test('every published example value passes the guard, the MCP schema and the pattern the documents publish', () => {
  for (const pattern of PARAM_ROUTES) {
    const name = nameOf(pattern);
    const value = routeUrls.example(pattern, name);
    assert.ok(value, `${pattern} has an example value in bazaar-examples.json (pathParams)`);
    assert.equal(guard.check(pattern, value), null, `${pattern}: the example ${value} passes the guard`);
    const schema = META[pattern].pathParamsSchema.properties[name];
    if (schema.pattern) assert.ok(new RegExp(schema.pattern).test(value), `${pattern}: the example matches the pattern the document publishes (${schema.pattern})`);
    if (schema.minLength) assert.ok(value.length >= schema.minLength, `${pattern}: example length >= minLength`);
    if (schema.maxLength) assert.ok(value.length <= schema.maxLength, `${pattern}: example length <= maxLength`);
    assert.equal(PS[name]('x').safeParse(value).success, true, `${pattern}: the MCP schema accepts the example`);
    const url = routeUrls.concrete(pattern);
    assert.ok(!/[:{}<>]/.test(url.replace('https://', '')), `${pattern}: the published URL has no template characters: ${url}`);
  }
});

test('the six name-keyed validators: valid values pass, impossible values and every placeholder spelling are refused with a named reason', () => {
  const valid = {
    wallet: ['Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu', '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7', 'So11111111111111111111111111111111111111112'],
    mint: ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'],
    coin: ['BTC', 'btc', 'kPEPE', 'SOL-PERP', 'ETHUSDT', 'HYPE'],
    address: ['0x742d35Cc6634C0532925a3b844Bc454e4438f44e', '6wjqWWra8ombzaw6VHrG5xpQ972jCYF6bbHiFCbWmr4U', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'],
    domain: ['wikipedia.org', 'Example.COM', 'sub.domain.co.uk', 'xn--bcher-kva.de'],
    doi: ['10.1038/nature14539', '10.1038%2Fnature14539', 'doi:10.1038/nature14539', 'https://doi.org/10.1038/nature14539'],
  };
  const invalid = {
    wallet: ['notawallet', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4T0', 'short', 'x'.repeat(45), 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu ', ''],
    mint: ['notamint', 'mint', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1O', 'E'.repeat(31)],
    coin: ['', 'BTC/ETH', 'a b', 'x'.repeat(21), 'USDT', '../etc', 'BTC;DROP'],
    address: ['short', 'not an address with spaces', 'x'.repeat(121), '0x742d35Cc6634C0532925a3b844Bc454e4438f44e/../'],
    domain: ['localhost', '127.0.0.1', 'nodots', 'foo.test', 'http://example.com', 'a'.repeat(254) + '.com', 'bad_domain.com'],
    doi: ['nature14539', '10.1038', 'not a doi', '11.1038/x', ''],
  };
  for (const pattern of PARAM_ROUTES) {
    const name = nameOf(pattern);
    for (const v of valid[name]) assert.equal(guard.check(pattern, v), null, `${pattern}: ${JSON.stringify(v)} should pass`);
    for (const v of invalid[name]) {
      const r = guard.check(pattern, v);
      assert.ok(r, `${pattern}: ${JSON.stringify(v)} should be refused`);
      assert.equal(r.body.charged, false);
      assert.equal(r.body.param, name);
      assert.equal(r.body.expected, EXPECTED[name]);
      assert.equal(r.body.example, routeUrls.concrete(pattern), 'the 400 names a working example URL');
      assert.ok(r.body.error && r.body.tool === PRICES[pattern].tool);
    }
    for (const ph of [`:${name}`, `{${name}}`, `<${name}>`, `[${name}]`, `\${${name}}`, '<your wallet>', ':id']) {
      assert.ok(PLACEHOLDER_RE.test(ph), `${ph} is read as a placeholder`);
      const r = guard.check(pattern, ph);
      assert.ok(r && r.kind === 'placeholder', `${pattern}: ${ph} is refused as a placeholder`);
      assert.match(r.body.note, /Replace .* with a real/);
    }
  }
  // controls: the placeholder regex does not swallow real values
  for (const v of ['Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu', 'BTC', 'wikipedia.org', '10.1038/nature14539']) assert.ok(!PLACEHOLDER_RE.test(v), `${v} is not a placeholder`);
});

test('the guard is never stricter than the handler: every value the handler accepts passes the guard (and the MCP schema)', () => {
  // wallet / mint: all four tool modules carry the same literal as lib/solrpc.js
  const lit = String(BASE58_RE);
  for (const f of ['tools/onchain.js', 'tools/tokenrisk.js', 'tools/solana2.js']) {
    assert.ok(fs.readFileSync(path.join(ROOT, f), 'utf8').includes(`const BASE58_RE = ${lit};`), `${f} still uses ${lit}`);
  }
  // coin: the resolver (universe lookup) can only return a coin for a value that coinShape accepts
  const { _resolver, coinShape } = require('../tools/signals');
  const resolve = _resolver(['BTC', 'ETH', 'SOL', 'HYPE', 'kPEPE', 'kSHIB']);
  const corpus = ['btc', 'BTC', 'Btc', ' BTC ', 'btcusdt', 'BTC-PERP', 'BTCPERP', 'kpepe', '1000PEPE', '1000pepeusdt', 'sol', 'SOL-PERP', 'nope', 'NOPEZZ', '', 'x'.repeat(30), 'BTC/ETH', 'USDT'];
  const coinPattern = 'GET /api/coin-signal/:coin';
  for (const raw of corpus) {
    if (resolve(raw)) {
      assert.ok(coinShape(raw), `${JSON.stringify(raw)} resolves to ${resolve(raw)} so its shape must pass`);
      if (raw === raw.trim()) assert.equal(guard.check(coinPattern, raw), null, `the guard lets ${JSON.stringify(raw)} through`);
      assert.equal(PS.coin('x').safeParse(raw.trim()).success, true, `the MCP coin schema accepts ${JSON.stringify(raw)}`);
    }
  }
  // sanctions: the shared constant
  const S = require('../tools/sanctions');
  assert.equal(String(S.ADDRESS_SHAPE), String(/^[A-Za-z0-9:]{14,120}$/));
  assert.ok(fs.readFileSync(path.join(ROOT, 'tools/sanctions.js'), 'utf8').includes('!ADDRESS_SHAPE.test(s)'), 'sanctionsCheck uses the exported shape');
  // domain / doi: the guard calls the handler's own parser, so accepted means accepted
  const { parseDomain } = require('../tools/domain');
  const { normDoi } = require('../tools/papers');
  for (const d of ['wikipedia.org', 'Example.COM', 'a.b', 'xn--bcher-kva.de', 'münchen.de']) {
    assert.doesNotThrow(() => parseDomain(d));
    assert.equal(guard.check('GET /api/domain/:domain', d), null, d);
    assert.equal(PS.domain('x').safeParse(d).success, true, `MCP domain schema accepts ${d}`);
  }
  for (const d of ['10.1038/nature14539', '10.1038%2Fnature14539', 'doi:10.1038/NATURE14539', 'https://doi.org/10.1038/nature14539', 'HTTP://DX.DOI.ORG/10.1038/nature14539']) {
    assert.doesNotThrow(() => normDoi(d));
    assert.equal(guard.check('GET /api/paper/:doi', d), null, d);
    assert.equal(PS.doi('x').safeParse(d).success, true, `MCP doi schema accepts ${d}`);
  }
  // the MCP schemas refuse what is certainly impossible, which is what stops a payment prompt over MCP
  for (const [n, bad] of [['wallet', 'notawallet'], ['wallet', ':wallet'], ['mint', '{mint}'], ['mint', 'short'], ['coin', 'BTC/ETH'], ['coin', ':coin'], ['address', 'short'], ['doi', 'nature14539'], ['doi', ':doi']]) {
    assert.equal(PS[n]('x').safeParse(bad).success, false, `MCP ${n} schema refuses ${bad}`);
  }
});

test('the JSON Schema each document publishes carries the constraints', () => {
  for (const pattern of PARAM_ROUTES) {
    const name = nameOf(pattern);
    const schema = META[pattern].pathParamsSchema.properties[name];
    assert.equal(schema.type, 'string');
    if (['wallet', 'mint'].includes(name)) {
      assert.equal(schema.pattern, '^[1-9A-HJ-NP-Za-km-z]{32,44}$', `${pattern} publishes the base58 pattern`);
      assert.equal(schema.minLength, 32); assert.equal(schema.maxLength, 44);
    } else {
      assert.ok(schema.pattern || schema.minLength || schema.maxLength, `${pattern} publishes at least one constraint`);
    }
    assert.deepEqual(META[pattern].pathParamsSchema.required, [name]);
  }
});

test('middleware: an impossible value is a 400 and nothing behind it runs; a possible one passes on; other routes and verbs are untouched', async () => {
  const hits = [];
  const app = express();
  app.use((req, _res, next) => { req.callerIp = '203.0.113.9'; next(); });
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  const g = makeParamGuard({ PRICES, routeUrls, db, logger: { warn() {} } });
  app.use(g.middleware);
  app.use((req, res) => { hits.push(`${req.method} ${req.path}`); res.status(402).json({ behind: 'the paywall' }); });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = srv.address().port;
  const get = (p, method = 'GET') => new Promise((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'user-agent': 'unit' } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    q.on('error', reject); q.end();
  });
  try {
    const W = 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu';
    // impossible: 400, JSON, never reaches the layer behind
    for (const p of ['/api/wallet-activity/:wallet', '/api/wallet-activity/notawallet', '/api/wallet-activity/%7Bwallet%7D', '/api/WALLET-ACTIVITY/notawallet/', '//api//wallet-activity//notawallet', '/api/wallet-activity/notawallet?limit=5', '/api/token-risk/:mint', '/api/coin-signal/BTC%2FETH', '/api/domain/localhost', '/api/paper/nature14539', '/api/sanctions-check/short']) {
      const r = await get(p);
      assert.equal(r.status, 400, `${p} -> ${r.status} ${r.body.slice(0, 80)}`);
      const j = JSON.parse(r.body);
      assert.equal(j.charged, false);
      assert.ok(j.example.startsWith(ORIGIN + '/api/'));
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.ok(!r.headers['payment-required'] && !r.headers['www-authenticate'], 'no challenge of any kind');
    }
    assert.deepEqual(hits, [], 'nothing behind the guard ran for an impossible value');
    // possible: passes on (and the layer behind answers whatever it answers)
    for (const p of [`/api/wallet-activity/${W}`, `/api/WALLET-ACTIVITY/${W}/`, `/api/token-metadata/${W}`, '/api/coin-signal/BTC', '/api/domain/wikipedia.org', '/api/paper/10.1038%2Fnature14539', '/api/sol-price', '/api/time', '/health', '/api/wallet-activity']) {
      const r = await get(p);
      assert.equal(r.status, 402, `${p} reaches the layer behind`);
    }
    assert.equal(hits.length, 10);
    // other verbs are not this guard's business (compat.makeGetOnly answers them in server.js)
    hits.length = 0;
    assert.equal((await get('/api/wallet-activity/notawallet', 'POST')).status, 402, 'the guard reads GET only; the 405 for POST is makeGetOnly, earlier in the real stack');
    assert.equal(hits.length, 1);
    // every refusal is counted without writing a calls row per request
    const rows = db.prepare('SELECT route, kind, n FROM param_rejected ORDER BY route, kind').all();
    assert.ok(rows.length >= 4, `rejections are aggregated (${JSON.stringify(rows)})`);
    assert.ok(rows.some((r) => r.kind === 'placeholder' && r.route === 'get_wallet_activity'));
    assert.equal(rows.find((r) => r.route === 'get_wallet_activity' && r.kind === 'invalid').n >= 3, true);
  } finally { srv.close(); db.close(); }
});

test('documents: no published URL or path is a template with a colon, and the examples they print are the ones the guard accepts', () => {
  const { buildOpenApi, buildWellKnown, buildLlmsTxt, buildSkillMd } = require('../tools/discovery');
  const ctx = { PRICES, TAGS: require('../payments').TAGS, META, FREE_TOOLS: [], mpp: { active: false, routes: [] }, tempo: { active: false } };
  const wk = buildWellKnown(ctx);
  assert.equal(wk.resources.length, Object.keys(PRICES).length);
  for (const u of wk.resources) assert.ok(!/[:{}]/.test(u.replace('https://', '')), `well-known resource is a working URL: ${u}`);
  for (const e of wk.resourceCatalog) {
    if (/\{[a-z]+\}/.test(e.url_template || '')) {
      assert.ok(e.path_params_example && Object.keys(e.path_params_example).length, `${e.name} keeps its example values`);
      assert.ok(e.path_params, `${e.name} publishes the schema of its path parameter`);
    }
  }
  const spec = buildOpenApi(ctx);
  for (const [p, o] of Object.entries(spec.paths)) {
    for (const prm of (o.get.parameters || []).filter((x) => x.in === 'path' && PARAM_ROUTES.some((r) => r.endsWith(`:${x.name}`)) && /^\/api\/(?!sample)/.test(p))) {
      assert.ok(prm.example, `${p}: the path parameter ${prm.name} has an example`);
      assert.ok(prm.schema.example === prm.example, `${p}: and the schema carries it`);
    }
  }
  const walletParam = spec.paths['/api/wallet-activity/{wallet}'].get.parameters.find((x) => x.name === 'wallet');
  assert.equal(walletParam.schema.pattern, '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
  assert.equal(walletParam.schema.minLength, 32);
  for (const [name, text] of [['llms.txt', buildLlmsTxt(ctx)], ['SKILL.md', buildSkillMd(ctx)]]) {
    const colon = text.match(/\/api\/[a-z0-9-]+\/:[A-Za-z]+/g);
    assert.equal(colon, null, `${name} prints no colon template: ${colon}`);
    assert.ok(text.includes('/api/wallet-activity/Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu'), `${name} prints the working wallet-activity example`);
    assert.ok(/wallet \(path: replace the example value\)/.test(text), `${name} names the part to replace`);
  }
});
