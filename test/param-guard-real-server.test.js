// R20e (29 Oct 2026): the REAL server.js (whole middleware stack, test/helpers/real-server.js: stub facilitator, every outbound connection refused,
// scratch databases) answers an impossible path parameter with a 400 before any payment layer, keeps the 402 of a possible one exactly as it was
// (v2 header with its accepts AND the v1 body), and never settles a paid request whose handler then answers >= 400.
//
// What these tests are made to catch:
//   - the paywall asking for payment (402, PAYMENT-REQUIRED, WWW-Authenticate) for GET /api/wallet-activity/:wallet, .../notawallet;
//   - the facilitator being asked to verify or settle anything for an impossible value;
//   - a prepaid key being reserved against an impossible value;
//   - a request that was verified and then failed in the handler (any status >= 400) being settled, on x402 v2, x402 v1 and the prepaid-key rail.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./helpers/real-server');
const { PRICES } = require('../payments');
const META = require('../bazaar-examples.json').routes;
const ORIGIN = require('../tools/discovery').ORIGIN;
const routeUrls = require('../lib/route-urls').makeRouteUrls({ ORIGIN, meta: META });

const MINT = 'So11111111111111111111111111111111111111112';
let s;
let ipN = 0;
const ip = () => { ipN++; return { 'cf-connecting-ip': `198.18.${(ipN >> 8) & 255}.${ipN & 255}` }; };   // one rate-limit bucket per request
const get = (p, h = {}) => H.raw(s.port, 'GET', p, { ...ip(), ...h });
const send = (m, p, h = {}) => H.raw(s.port, m, p, { ...ip(), ...h });
const PARAM_ROUTES = Object.keys(PRICES).filter((k) => /^GET /.test(k) && /\/:[A-Za-z0-9_]+$/.test(k));
const nameOf = (pattern) => /:([A-Za-z0-9_]+)$/.exec(pattern)[1];
// per parameter name: a value that can never be served (coin: an encoded slash; everything else: plain nonsense)
const NONSENSE = { wallet: 'notawallet', mint: 'notamint', coin: 'BTC%2FETH', address: 'short', domain: 'nonsense', doi: 'nonsense' };
const basePath = (pattern) => pattern.replace(/^GET /, '').replace(/\/:[A-Za-z0-9_]+$/, '');
const exampleOf = (pattern) => routeUrls.concretePath(pattern);

before(async () => { s = await H.boot(); });
after(() => { if (s) s.close(); });

test('control: the server is the real one and the twelve published examples are answered with the 402 challenge (v2 header with accepts, v1 body kept)', async () => {
  assert.equal(PARAM_ROUTES.length, 12);
  for (const pattern of PARAM_ROUTES) {
    const r = await get(exampleOf(pattern));
    assert.equal(r.status, 402, `${exampleOf(pattern)} -> ${r.status}`);
    const v2 = H.unb64(r.headers['payment-required']);
    assert.equal(v2.x402Version, 2);
    assert.ok(v2.accepts.length >= 3, `${pattern}: the v2 header carries the accepts (${v2.accepts.length})`);
    assert.equal(v2.resource.url, ORIGIN + exampleOf(pattern), 'the challenge names the concrete URL that was asked');
    assert.equal(v2.extensions.bazaar.routeTemplate, pattern.replace('GET ', ''), 'and still names the route template for the Bazaar');
    const v1 = JSON.parse(r.body);
    assert.equal(v1.x402Version, 1, `${pattern}: the v1 body for old clients is kept`);
    assert.ok(Array.isArray(v1.accepts) && v1.accepts.length >= 1);
  }
});

test('the literal template, the OpenAPI template and nonsense are a 400 on all twelve routes: no challenge, no handler, no facilitator call, no outbound attempt', async () => {
  const handlers = s.handlerRuns().length;
  s.fac.log.length = 0;
  const net = s.netAttempts().length;
  let n = 0;
  for (const pattern of PARAM_ROUTES) {
    const name = nameOf(pattern);
    const base = basePath(pattern);
    for (const tail of [`:${name}`, `%3A${name}`, `{${name}}`, `%7B${name}%7D`, NONSENSE[name]]) {
      for (const method of ['GET', 'HEAD']) {
        const r = await send(method, `${base}/${tail}`);
        n++;
        assert.equal(r.status, 400, `${method} ${base}/${tail} -> ${r.status}`);
        assert.ok(!r.headers['payment-required'] && !r.headers['www-authenticate'] && !r.headers['x-payment-response'], `${method} ${base}/${tail}: no payment challenge of any kind`);
        if (method === 'GET') {
          const j = JSON.parse(r.body);
          assert.equal(j.charged, false);
          assert.equal(j.param, name);
          assert.equal(j.example, ORIGIN + exampleOf(pattern), 'the 400 hands over a working URL');
          assert.equal(j.tool, PRICES[pattern].tool);
        } else assert.equal(r.body, '', 'HEAD has no body');
      }
    }
  }
  assert.equal(n, 12 * 5 * 2);
  assert.equal(s.handlerRuns().length, handlers, 'no handler ran');
  assert.deepEqual(s.fac.log, [], 'the facilitator was never asked to verify or settle');
  assert.equal(s.netAttempts().length, net, 'and no upstream work started');
});

test('the three URLs from the report: :wallet, notawallet and a real address (the first two 400, the real one is the unchanged 402)', async () => {
  const a = await get('/api/wallet-activity/:wallet');
  const b = await get('/api/wallet-activity/notawallet');
  const c = await get('/api/wallet-activity/Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu');
  assert.deepEqual([a.status, b.status, c.status], [400, 400, 402]);
  assert.match(JSON.parse(a.body).error, /placeholder from a URL template/);
  assert.equal(JSON.parse(b.body).error, 'invalid wallet address');
  assert.match(JSON.parse(a.body).note, /Replace :wallet with a real wallet/);
});

test('every spelling the other layers canonicalise is guarded the same: case, trailing and double slash, encodings, ?param= form, |network suffix, a DOI with a literal slash', async () => {
  const W = 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu';
  const bad = ['/API/WALLET-ACTIVITY/notawallet', '/Api/Wallet-Activity/notawallet/', '/api//wallet-activity//notawallet', '/api/wallet-activity/notawallet?limit=5', '/api/wallet-activity?wallet=notawallet',
    '/api/wallet-activity?wallet=%3Awallet', '/api/wallet-activity?wallet=%7Bwallet%7D', '/api/wallet-activity/notawallet|eip155:8453', '/api/wallet-activity/notawallet%7Ceip155:8453',
    '/api/%77allet-activity/notawallet', '/api/wallet-activity/%6Eotawallet', '/api/paper/nature14539', '/api/paper?doi=nonsense', '/api/paper/:doi'];
  for (const p of bad) assert.equal((await get(p)).status, 400, p);
  const good = [`/api/wallet-activity/${W.slice(0, -1)}%75`, '/api/coin-signal/%42TC', '/api/domain/wikipedia%2Eorg', `/API/WALLET-ACTIVITY/${W}`, `/api/wallet-activity/${W}/`, `/api//wallet-activity//${W}`, `/api/wallet-activity?wallet=${W}`, `/api/wallet-activity/${W}|eip155:8453`,
    '/api/paper/10.1038/nature14539', '/api/paper/10.1038%2Fnature14539', '/api/paper?doi=10.1038%2Fnature14539', '/api/coin-signal?coin=BTC', '/api/domain?domain=wikipedia.org'];
  for (const p of good) assert.equal((await get(p)).status, 402, `${p} is a possible request: the unchanged 402`);
});

test('the rest of the surface is untouched: routes without a path parameter, free routes, unknown paths and the verbs', async () => {
  assert.equal((await get('/api/time')).status, 402);
  assert.equal((await get('/api/sol-price')).status, 402);
  assert.equal((await get('/health')).status, 200);
  assert.equal((await get('/api/sample/liq-pulse')).status, 200);
  assert.equal((await get('/api/zzz-not-a-route')).status, 404);
  assert.equal((await send('POST', '/api/wallet-activity/notawallet')).status, 405, 'the 405 for a non-GET verb still comes first');
  assert.equal((await send('HEAD', '/api/wallet-activity/Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu')).status, 402);
});

test('a payment attached to an impossible value is refused before it is read: the facilitator never sees it (x402 v2 and v1)', async () => {
  const ch = await get(`/api/token-metadata/${MINT}`);
  assert.equal(ch.status, 402);
  const v2 = H.b64(H.payBase(ch.headers['payment-required']));
  for (const [label, headers] of [['v2 PAYMENT-SIGNATURE', { 'payment-signature': v2 }], ['v1 X-PAYMENT', { 'x-payment': H.b64(H.payV1()) }], ['Authorization: Payment', { authorization: `Payment ${v2}` }]]) {
    s.fac.log.length = 0;
    const r = await get('/api/token-metadata/notamint', headers);
    assert.equal(r.status, 400, label);
    assert.deepEqual(s.fac.log, [], `${label}: not verified, not settled`);
  }
});

test('x402 v2: a payment that reaches a handler which then answers >= 400 is verified and NEVER settled; the same payment on a 200 route settles (control)', async () => {
  // control: the rail settles when the handler succeeds
  const chOk = await get('/api/time');
  s.fac.log.length = 0;
  const ok = await get('/api/time', { 'payment-signature': H.b64(H.payBase(chOk.headers['payment-required'])) });
  assert.equal(ok.status, 200);
  assert.deepEqual(s.fac.log.map((x) => x.op), ['verify', 'settle'], 'control: a 200 is verified then settled');
  // a possible value whose handler cannot answer (its upstream is refused here, as it is when the RPC is down): a 5xx after verification
  const ch = await get(`/api/token-metadata/${MINT}`);
  s.fac.log.length = 0;
  const r = await get(`/api/token-metadata/${MINT}`, { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) });
  assert.ok(r.status >= 400, `the handler answered ${r.status}`);
  assert.deepEqual(s.fac.log.map((x) => x.op), ['verify'], 'verified, and never settled');
  assert.equal(r.headers['payment-response'], undefined, 'no settlement receipt went out');
});

test('x402 v1: a payment whose handler answers >= 400 is not settled either; a 200 is (control)', async () => {
  s.fac.log.length = 0;
  const ok = await get('/api/time', { 'x-payment': H.b64(H.payV1()) });
  assert.equal(ok.status, 200);
  assert.deepEqual(s.fac.log.filter((x) => x.op === 'settle').map((x) => x.amount), ['5000'], 'control: a 200 settles');
  s.fac.log.length = 0;
  const r = await get(`/api/token-metadata/${MINT}`, { 'x-payment': H.b64(H.payV1()) });
  assert.ok(r.status >= 400, `the handler answered ${r.status}`);
  assert.deepEqual(s.fac.log.filter((x) => x.op === 'settle'), [], 'no settlement');
});

test('prepaid key: an impossible value never reserves; a handler >= 400 refunds the reserve; a 200 is billed (control)', async () => {
  const { newKey, hashKey } = require('../lib/keys');
  const key = newKey();
  const hash = hashKey(key);
  const read = () => { const d = s.db(); try { return d.prepare('SELECT balance_micro, spent_micro, calls FROM api_keys WHERE key_hash = ?').get(hash); } finally { d.close(); } };
  // the key rail books a call (and refunds a failed one) on the response's 'finish' event, a moment after the client has its answer: read the row once it has stopped moving
  const row = async () => { let a = read(); for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 150)); const b = read(); if (JSON.stringify(a) === JSON.stringify(b)) return b; a = b; } return a; };
  const d = s.db();
  try {
    d.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, spent_micro, calls, created, rate_per_min, label) VALUES (?, ?, 'active', 1000000, 1000000, 0, 0, ?, 120, 'param-guard test')`)
      .run(hash, key.slice(4, 12), Math.floor(Date.now() / 1000));
  } finally { d.close(); }
  const auth = { 'x-agentfeed-key': key };
  const b0 = await row();
  assert.equal(b0.balance_micro, 1000000);
  // control: a 200 is billed
  const ok = await get('/api/time', auth);
  assert.equal(ok.status, 200, `control: the key works (${ok.body.slice(0, 120)})`);
  const b1 = await row();
  assert.ok(b1.balance_micro < b0.balance_micro && b1.calls === 1, `control: the call was billed (${JSON.stringify(b0)} -> ${JSON.stringify(b1)})`);
  // an impossible value: 400, balance and counters untouched
  for (const p of ['/api/wallet-activity/:wallet', '/api/wallet-activity/notawallet', '/api/token-risk/{mint}']) {
    const r = await get(p, auth);
    assert.equal(r.status, 400, p);
  }
  assert.deepEqual(await row(), b1, 'no reserve, no charge, no counted call for an impossible value');
  // a possible value whose handler fails: reserved, then refunded in full
  const r = await get(`/api/token-metadata/${MINT}`, auth);
  assert.ok(r.status >= 400, `the handler answered ${r.status}`);
  assert.deepEqual(await row(), b1, 'a >= 400 from the handler is refunded in full');
});

test('the audit table: impossible values write no calls row (they are counted in param_rejected), and no paid row exists for them', async () => {
  const before = (await H.rowsSince(s, 0)).length;
  const reps = 6;
  for (let i = 0; i < reps; i++) await get('/api/wallet-activity/:wallet');
  await get('/api/token-risk/notamint');
  const rows = (await H.rowsSince(s, 0)).slice(before);
  assert.deepEqual(rows.filter((r) => /wallet-activity|token-risk/.test(r.req_path || '') ), [], 'no per-request row for a rejected value (a crawler loop must not grow the table)');
  const d = s.db();
  try {
    const t = d.prepare('SELECT route, kind, SUM(n) n FROM param_rejected GROUP BY route, kind ORDER BY route, kind').all();
    const wa = t.find((x) => x.route === 'get_wallet_activity' && x.kind === 'placeholder');
    assert.ok(wa && wa.n >= reps, `the placeholder hits are counted (${JSON.stringify(t.slice(0, 6))})`);
    assert.ok(t.some((x) => x.route === 'get_token_risk' && x.kind === 'invalid'));
    const paid = d.prepare(`SELECT COUNT(*) c FROM calls WHERE status = 'paid' AND (req_path LIKE '%/:%' OR req_path LIKE '%{%')`).get().c;
    assert.equal(paid, 0, 'no paid row on a template path');
  } finally { d.close(); }
});

test('MPP solana/charge settles on chain BEFORE the handler runs, so it may only gate routes whose handler cannot answer a caller error: no path parameter, no required query', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const m = /const MPP_ROUTES = \[([^\]]*)\]/.exec(src);
  assert.ok(m, 'MPP_ROUTES is declared in server.js');
  const routes = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(routes.length >= 1);
  for (const r of routes) {
    assert.ok(!routeUrls.isTemplated(r), `${r} has a path parameter: a 4xx from its handler would come after an on-chain settlement`);
    const sch = META[r] && META[r].inputSchema;
    assert.deepEqual((sch && sch.required) || [], [], `${r} has no required query parameter`);
  }
});

// ---- every URL a document prints must work when it is requested as printed ------------------------------------------------------------------
// The fix is not "the guard answers 400": it is that no document sends an agent to a URL that can only answer 400. Each document is read by an
// extractor that takes exactly the fields an agent or a crawler is meant to CALL (the template fields such as url_template are labelled as templates and
// are checked for what they must carry instead), and every URL found is requested as written.
const templateish = (u) => /[:{}<>]/.test(String(u).replace(/^https?:\/\//, ''));
const clean = (u) => u.replace(/[.,;:)\]}'"`|]+$/, '');
const CALL_ORIGIN = new RegExp('^' + ORIGIN.replace(/[.]/g, '\\.'));
const pathOf = (u) => u.replace(CALL_ORIGIN, '');

test('crawl: every URL a discovery document tells a caller to GET answers as written (a priced route 402, a free one is routed); none is a template', async () => {
  const J = async (p, h = {}) => { const r = await get(p, h); assert.equal(r.status, 200, `${p} -> ${r.status}`); return r; };
  const found = new Map();   // path -> where it was printed
  const add = (u, from) => { if (u) { const p = pathOf(clean(u)); if (!found.has(p)) found.set(p, from); } };

  const wk = JSON.parse((await J('/.well-known/x402')).body);
  for (const u of wk.resources) add(u, '/.well-known/x402 resources');
  for (const e of wk.resourceCatalog) add(e.url, '/.well-known/x402 resourceCatalog');
  const man = JSON.parse((await J('/.well-known/x402.json')).body);
  for (const e of man.resources) add(e.resource, '/.well-known/x402.json');
  for (const name of ['/llms.txt', '/SKILL.md']) {
    const t = (await J(name)).body;
    for (const m of t.matchAll(/GET\s+((?:https:\/\/x402\.ochinimus\.app)?\/api\/[^\s`|]*)/g)) add(m[1], name);
  }
  const card = JSON.parse((await J('/.well-known/agent-card.json')).body);
  for (const sk of card.skills) for (const m of sk.description.matchAll(/GET\s+(https:\/\/x402\.ochinimus\.app\/api\/\S+)/g)) add(m[1], '/.well-known/agent-card.json');
  for (const e of JSON.parse((await J('/pricing')).body).paid) add(e.route, '/pricing');
  for (const slug of ['token-risk', 'wallet-activity', 'paper', 'liq-pulse']) add(JSON.parse((await J(`/api/sample/${slug}`)).body).paid_url, `/api/sample/${slug}`);
  const landing = (await J('/')).body;
  for (const m of landing.matchAll(/"example_url":"([^"]+)"/g)) add(m[1], '/ (landing tools)');
  assert.ok(!/"route":"GET [^"]*\/:[A-Za-z]/.test(landing), 'the landing JSON prints no colon template');
  const spec = JSON.parse((await J('/openapi.json')).body);
  let templated = 0;
  for (const [p, o] of Object.entries(spec.paths)) {
    if (!p.includes('{') || !o.get) continue;
    templated++;
    let filled = p;
    for (const prm of (o.get.parameters || []).filter((x) => x.in === 'path')) {
      assert.ok(prm.example != null, `${p}: path parameter ${prm.name} carries an example`);
      assert.ok(prm.schema && (prm.schema.pattern || prm.schema.enum || prm.schema.minLength || prm.schema.maxLength), `${p}: and the shape it must have`);
      filled = filled.replace(`{${prm.name}}`, String(prm.example).replace(/%2F/gi, '/'));
    }
    add(filled, `openapi example for ${p}`);
  }
  assert.ok(templated >= 13, `control: the OpenAPI document describes the path-parameter routes (${templated})`);
  assert.ok(found.size >= 90, `control: the crawl found the catalogue (${found.size} distinct paths)`);

  const { pricedMatcher } = require('../lib/canon-path');
  const priced = pricedMatcher(Object.keys(PRICES));
  const bad = [];
  let pricedSeen = 0;
  for (const [u, from] of found) {
    if (!/^\/api\//.test(u)) continue;
    if (templateish(u)) { bad.push(`${u} (from ${from}) is a template`); continue; }
    const r = await get(u);
    if (priced.test(u)) { pricedSeen++; if (r.status !== 402) bad.push(`${u} (from ${from}) -> ${r.status}, a priced route must answer its 402`); }
    else if (r.status === 404 || r.status === 405) bad.push(`${u} (from ${from}) -> ${r.status}`);   // free routes: routed (offline their upstream may fail; the keys routes want a key)
  }
  assert.ok(pricedSeen >= 80, `control: ${pricedSeen} priced routes were requested`);
  assert.deepEqual(bad, [], 'a printed URL that cannot be served');

  // what the documents print beside the working URL
  assert.ok(card.skills.find((x) => /wallet-activity/.test(x.description)).description.includes('/api/wallet-activity/Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu'), 'agent card prints the working URL');
  assert.match(card.skills.find((x) => /wallet-activity/.test(x.description)).description, /replace \{wallet\} with your own value/);
  const wa = man.resources.find((x) => /wallet-activity/.test(x.resource));
  assert.equal(wa.resource, ORIGIN + '/api/wallet-activity/Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu');
  assert.equal(wa.resource_template, ORIGIN + '/api/wallet-activity/{wallet}');
  assert.deepEqual(wa.path_params_example, { wallet: 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu' });
  const wc = wk.resourceCatalog.find((x) => /wallet-activity/.test(x.url));
  assert.equal(wc.url_template, ORIGIN + '/api/wallet-activity/{wallet}');
  assert.equal(wc.path_params.wallet.pattern, '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
  const sample = JSON.parse((await get('/api/sample/wallet-activity')).body);
  assert.equal(sample.route, '/api/wallet-activity/{wallet}');
  assert.equal(JSON.parse((await get('/pricing')).body).paid.find((x) => /wallet-activity/.test(x.route)).route_template, ORIGIN + '/api/wallet-activity/{wallet}');
});

// ---- MCP: the same refusal, before any payment prompt -----------------------------------------------------------------------------------------
// The MCP SDK validates tool arguments against the tool's zod schema BEFORE the x402 payment wrapper runs (lib/param-schemas.js carries the patterns),
// so an impossible wallet over MCP is a JSON-RPC invalid-params error with no payment-required result and nothing sent to the facilitator.
function mcpCall(name, args) {
  const http = require('http');
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/mcp', headers: { host: 'x402.ochinimus.app', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body), ...ip() } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        const m = /^data: (.*)$/m.exec(b);
        let j = null; try { j = JSON.parse(m ? m[1] : b); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json: j, raw: b });
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

test('MCP: an impossible argument is refused as invalid params before any payment prompt; a possible one is asked to pay (control)', async () => {
  const W = 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu';
  s.fac.log.length = 0;
  // control: a possible wallet, no payment attached -> the wrapper answers with its payment-required result
  const ok = await mcpCall('get_wallet_activity', { wallet: W });
  const okText = JSON.stringify(ok.json);
  assert.ok(ok.json && ok.json.result, `control: a tools/call answers (${ok.raw.slice(0, 200)})`);
  assert.match(okText, /payment|x402|402/i, 'control: a possible argument reaches the payment wrapper');
  for (const [name, args] of [['get_wallet_activity', { wallet: 'notawallet' }], ['get_wallet_activity', { wallet: ':wallet' }], ['get_token_risk', { mint: '{mint}' }], ['get_token_metadata', { mint: 'short' }],
    ['get_sanctions_check', { address: 'short' }], ['get_paper', { doi: 'nonsense' }], ['get_coin_signal', { coin: 'BTC/ETH' }]]) {
    const r = await mcpCall(name, args);
    const t = JSON.stringify(r.json);
    assert.ok(r.json && (r.json.error || (r.json.result && r.json.result.isError)), `${name} ${JSON.stringify(args)}: refused (${r.raw.slice(0, 160)})`);
    assert.ok(/invalid|pattern|expected|too small|string/i.test(t), `${name}: the refusal names the schema problem (${t.slice(0, 200)})`);
    assert.ok(!/payment-required|x402Version|accepts/i.test(t), `${name} ${JSON.stringify(args)}: no payment prompt`);
  }
  assert.deepEqual(s.fac.log, [], 'the facilitator was never asked anything');
});
