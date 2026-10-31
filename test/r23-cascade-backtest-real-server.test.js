// get_cascade_backtest on the REAL server.js (test/helpers/real-server.js: stub facilitator, every outbound connection but loopback refused, scratch databases). The route is added to the real
// expansion.js: since the lead integrated the R23 batch (expansion.js pushes tools/r23/index.js), the route is registered by the real wiring, nothing is injected. What is proved here and not by the unit tests:
//   - unpaid GET and HEAD on the route, on 24 spellings of it and with query variants, never reach the handler, open no connection, ask Hyperliquid nothing, write no row, settle nothing;
//   - a paid call is served once, settled once at the price in PRICES, and its numbers are the hand-computable ones; the cache refresh goes to the (loopback) Hyperliquid stand-in once, not per call;
//   - a value the query rules (lib/query-rules.js) refuse is a 400 BEFORE the paywall: no 402, no challenge, no handler, nothing settled;
//   - a 400 from a handler check the rules do not copy (an unsupported symbol), a 404 (events nothing can price) and a 503 (events whose prices cannot be fetched) settle nothing on x402 v2, x402 v1 or the prepaid-key rail;
//   - the MCP tool is listed and goes through the x402 gate; the OpenAPI document and /pricing carry the route at its price.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('fs');
const path = require('path');
const http = require('http');
const H = require('./helpers/real-server');
const W = require('./fixtures/r23/cascade/world.cjs');
const { PRICES } = require('../payments');
const { hfUsd } = require('../lib/hf');
const { newKey, hashKey } = require('../lib/keys');

const { STEP, DAY } = W;
const MIN = 60_000;
const ROUTE = '/api/cascade-backtest';
const KEY = `GET ${ROUTE}`;
const NOW0 = Math.floor(Date.now() / DAY) * DAY;
const B0 = NOW0 - 9 * DAY;
const lin = (s) => 100 + (s - B0) / STEP;
const burst = (symbol, side, at, n, usd) => Array.from({ length: n }, (_, k) => [at + k * 20_000, symbol, side, usd]);
const at = (days, hh, mm) => B0 + days * DAY + hh * 3600_000 + mm * MIN;

let s, hl, tmpDirs = [], dbFile, cacheDir;
let ipN = 0;
const ip = () => { ipN++; return { 'cf-connecting-ip': `198.18.${(ipN >> 8) & 255}.${ipN & 255}` }; };
const get = (p, h = {}) => H.raw(s.port, 'GET', p, { ...ip(), ...h });
const send = (m, p, h = {}) => H.raw(s.port, m, p, { ...ip(), ...h });
const paid = async (p, headerKind = 'v2') => {
  const ch = await get(p);
  assert.equal(ch.status, 402, `the challenge for ${p}`);
  return headerKind === 'v2' ? get(p, { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) }) : get(p, { 'x-payment': H.b64(H.payV1({}, '500000')) });
};
const settles = () => s.fac.log.filter((x) => x.op === 'settle');

/** a stand-in for Hyperliquid's info endpoint: TEST answers candles (the latest 5,000, like the real one), DOWN answers 500, EMPTY answers an empty list */
function startHl() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(body); } catch { /* none */ }
      calls.push({ url: req.url, method: req.method, body: j });
      const r = (j.req || {});
      if (r.coin === 'DOWN') { res.statusCode = 500; return res.end('{}'); }
      res.setHeader('content-type', 'application/json');
      if (j.type !== 'candleSnapshot' || r.interval !== '15m' || r.coin === 'EMPTY') return res.end('[]');
      const out = [];
      for (let t = Math.ceil(r.startTime / STEP) * STEP; t < r.endTime; t += STEP) out.push({ t, T: t + STEP - 1, s: r.coin, i: '15m', o: String(lin(t)), c: String(lin(t)), h: String(lin(t)), l: String(lin(t)), v: '1', n: 1 });
      res.end(JSON.stringify(out.slice(-5000)));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, calls, url: `http://127.0.0.1:${srv.address().port}/info` })));
}

before(async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'r23casc-real-')); tmpDirs.push(dir);
  cacheDir = path.join(dir, 'candles'); dbFile = path.join(dir, 'liq.db');
  W.makeCache(cacheDir, { symbol: 'TESTUSDT', coin: 'TEST', from: B0, to: B0 + 6 * DAY, price: lin });
  W.makeCache(cacheDir, { symbol: 'DOWNUSDT', coin: 'DOWN', from: B0, to: B0 + 2 * DAY, price: lin });
  W.makeCache(cacheDir, { symbol: 'EMPTYUSDT', coin: 'EMPTY', from: B0, to: B0 + 2 * DAY, price: lin });
  const rows = [
    ...burst('TESTUSDT', 'Buy', at(1, 10, 7), 4, 30_000),          // A: priced from the cache
    ...burst('TESTUSDT', 'Sell', at(2, 22, 30), 3, 50_000),        // B: its 4 h and 24 h windows cross midnight
    ...burst('TESTUSDT', 'Buy', at(6, 3, 0), 4, 30_000),           // C: after the cache ends -> one refresh from the stand-in
    [NOW0 - 3600_000, 'TESTUSDT', 'Sell', 1000],
    ...burst('DOWNUSDT', 'Buy', at(5, 10, 0), 4, 30_000),          // events beyond a cache that ends on day 2, and the price source is down
    ...burst('EMPTYUSDT', 'Buy', at(5, 10, 0), 4, 30_000),         // same, and the price source answers nothing
  ];
  const db = W.buildDb(rows, dbFile); db.close();
  hl = await startHl();
  s = await H.boot({ LIQ_DB: dbFile, R23_CANDLE_CACHE: cacheDir, HL_API: hl.url });
});
after(() => { if (s) s.close(); if (hl) hl.srv.close(); for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

test('control: the route is on the real server at its price, in the OpenAPI document and /pricing, and the challenge asks exactly that price', async () => {
  assert.equal(PRICES[KEY].usd, 0.5, 'the repo\'s own PRICES (built from expansion.js) has the route at $0.50');
  assert.equal(PRICES[KEY].tool, 'get_cascade_backtest');
  const spec = JSON.parse((await get('/openapi.json')).body);
  assert.ok(spec.paths[ROUTE] && spec.paths[ROUTE].get['x-payment-info'], 'priced in openapi.json');
  const pricing = JSON.parse((await get('/pricing')).body);
  assert.equal(pricing.paid.find((x) => x.tool === 'get_cascade_backtest').price_usd, 0.5);
  const ch = await get(ROUTE);
  assert.equal(ch.status, 402);
  assert.equal(H.unb64(ch.headers['payment-required']).accepts.find((a) => a.network === H.BASE).amount, '500000');
});

test('unpaid GET and HEAD, on 24 spellings and with query variants: never served, no handler run, no outbound connection, Hyperliquid not asked, no calls row, nothing settled', async () => {
  const variants = (p) => { const parts = p.split('/'); const last = parts.pop(); const dir = parts.join('/');
    return [p, p + '/', p + '//', p.toUpperCase(), p.replace('/api/', '/API/'), p.replace('/api/', '/Api/'), '/' + p, p.replace('/api/', '/api//'), dir + '/' + encodeURIComponent(last).replace(/-/g, '%2D'),
      dir + '/%' + last.charCodeAt(0).toString(16) + last.slice(1), p.replace('/api/', '/api%2F'), p.replace('/api/', '/x/../api/'), p.replace('/api/', '/api/./'), '/api/sample/../' + p.slice(5), p + ';x=1', p + '%20', p + '\\', p + '?', p + '#x', p + '%3F', p + '/.', p.replace('/api/', '/%61pi/'), p + '|eip155:8453/', p + '%7Ceip155:1']; };
  const vs = variants(ROUTE);
  assert.equal(vs.length, 24);
  const bad = [];
  let n = 0;
  for (const v of vs) for (const m of ['GET', 'HEAD']) {
    n++;
    const res = await send(m, v);
    if (res.status >= 200 && res.status < 400) bad.push(`${m} ${v} -> ${res.status}`);
    if ([0, 1, 3, 4].includes(vs.indexOf(v)) && res.status !== 402) bad.push(`${m} ${v} -> ${res.status} (the plain, trailing-slash, upper-case and /API/ spellings are the 402 challenge)`);
  }
  for (const q of ['?symbol=TEST', '?symbol=TEST&side=long&min_usd=250000&window_min=10', '?symbol=BTC&limit=5', '?symbol=TEST&symbol=DOWN', '?side=bad', '?min_usd=1', '?symbol=%00', '?SYMBOL=TEST', '?symbol=TEST&url=http://127.0.0.1:1/']) for (const m of ['GET', 'HEAD']) {
    n++;
    const res = await send(m, ROUTE + q);
    if (![400, 402].includes(res.status)) bad.push(`${m} ${ROUTE + q} -> ${res.status}`);   // 402 here; a 400 once lib/query-rules.js carries the route's rules: never an answer
  }
  assert.equal(n, 24 * 2 + 9 * 2);
  assert.deepEqual(bad, []);
  assert.deepEqual(s.handlerRuns().filter((x) => x === 'get_cascade_backtest'), [], 'no handler ran without payment');
  assert.deepEqual(s.netAttempts(), [], 'no outbound connection without payment');
  assert.deepEqual(hl.calls, [], 'Hyperliquid was not asked');
  assert.deepEqual(settles(), [], 'nothing settled');
  const rows = (await H.rowsSince(s, 0)).filter((x) => x.tool === 'get_cascade_backtest');
  assert.deepEqual(rows, [], 'no calls row: nothing was served');
});

function mcp(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/mcp', headers: { host: 'x402.ochinimus.app', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body), ...ip() } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { const m = /^data: (.*)$/m.exec(b); let j = null; try { j = JSON.parse(m ? m[1] : b); } catch { /* not JSON */ } resolve({ status: res.statusCode, json: j, raw: b }); });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

test('the MCP tool is listed with its schema and goes through the x402 gate: unpaid it asks for payment, runs no handler and asks the facilitator nothing', async () => {
  const list = await mcp('tools/list', {});
  const tool = (list.json.result.tools || []).find((t) => t.name === 'get_cascade_backtest');
  assert.ok(tool, 'listed');
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['cooldown_min', 'limit', 'min_usd', 'side', 'symbol', 'window_min']);
  const before = s.handlerRuns().length;
  s.fac.log.length = 0;
  const out = await mcp('tools/call', { name: 'get_cascade_backtest', arguments: { symbol: 'TEST' } });
  assert.match(JSON.stringify(out.json), /payment|x402|402/i);
  assert.ok(!/"events_found"/.test(JSON.stringify(out.json)), 'no event study without payment');
  assert.equal(s.handlerRuns().length, before);
  assert.deepEqual(settles(), []);
  const bad = await mcp('tools/call', { name: 'get_cascade_backtest', arguments: { window_min: 99 } });
  assert.ok(!/"events_found"/.test(bad.raw), 'an impossible value is refused by the schema or stopped at the gate; never answered');
  assert.equal(s.handlerRuns().length, before);
  assert.deepEqual(settles(), []);
});

test('paid x402 v2: served once, settled once at 500000 atomic (0.50 USDC); the numbers are the hand-computable ones; the price cache is refreshed ONCE from the stand-in, not per call', async () => {
  s.fac.log.length = 0;
  const runs = s.handlerRuns().length;
  const res = await paid(`${ROUTE}?symbol=TEST&min_usd=100000`);
  assert.equal(res.status, 200, res.body.slice(0, 400));
  const j = JSON.parse(res.body);
  assert.equal(j.tool, 'get_cascade_backtest'); assert.equal(j.paid, true);
  const d = j.data;
  assert.equal(d.symbol, 'TESTUSDT'); assert.equal(d.hyperliquid_coin, 'TEST');
  assert.equal(d.events_found, 3);
  assert.equal(s.handlerRuns().length, runs + 1);
  assert.equal(settles().length, 1); assert.equal(settles()[0].amount, '500000');
  // the hand formula: price(T) = lin(T - 15 min); A triggers at 10:08:00 and enters at 10:15
  const priceT = (T) => lin(T - STEP);
  const eA = d.events.find((e) => e.start_time === new Date(at(1, 10, 8)).toISOString());
  assert.ok(eA, JSON.stringify(d.events.map((e) => e.start_time)));
  assert.equal(eA.entry_time, new Date(at(1, 10, 15)).toISOString());
  for (const h of [{ k: '15m', ms: 15 * MIN }, { k: '1h', ms: 60 * MIN }, { k: '4h', ms: 240 * MIN }, { k: '24h', ms: 1440 * MIN }]) assert.equal(eA.forward_return_pct[h.k], Number(((priceT(at(1, 10, 15) + h.ms) / priceT(at(1, 10, 15)) - 1) * 100).toFixed(4)), h.k);
  const eC = d.events.find((e) => e.start_time === new Date(at(6, 3, 0) + 60_000).toISOString());
  assert.ok(eC && eC.forward_return_pct['24h'] !== null, 'C needed prices beyond the cache: the refresh supplied them');
  assert.equal(hl.calls.length, 1, 'one call to the stand-in'); assert.equal(hl.calls[0].body.req.coin, 'TEST'); assert.equal(hl.calls[0].body.req.interval, '15m');
  assert.equal(hl.calls[0].body.req.startTime, B0 + 5 * DAY, 'from the start of the cache\'s last day');
  assert.deepEqual(d.horizons['15m'].events.n, 3);
  // a second paid call, a different threshold: same cache, no new call
  s.fac.log.length = 0;
  const res2 = await paid(`${ROUTE}?symbol=test&side=long&limit=1`);
  assert.equal(res2.status, 200);
  const d2 = JSON.parse(res2.body).data;
  assert.equal(d2.events_found, 2); assert.equal(d2.events_listed, 1);
  assert.equal(hl.calls.length, 1, 'no second call');
  assert.equal(settles().length, 1);
  // a threshold with no event is a paid 200 with an empty list (a valid answer)
  const res3 = await paid(`${ROUTE}?symbol=TEST&min_usd=900000`);
  assert.equal(res3.status, 200); assert.equal(JSON.parse(res3.body).data.events_found, 0);
  const rows = (await H.rowsSince(s, 0)).filter((x) => x.tool === 'get_cascade_backtest' && x.status === 'paid');
  assert.equal(rows.length, 3, 'three paid rows');
});

test('a key caller pays half the price (minimum $0.0005) for a served answer', async () => {
  const key = newKey(); const hash = hashKey(key);
  const d = s.db();
  try { d.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, spent_micro, calls, created, rate_per_min, label) VALUES (?, ?, 'active', 5000000, 5000000, 0, 0, ?, 120, 'cascade test')`).run(hash, key.slice(4, 12), Date.now()); } finally { d.close(); }
  const read = () => { const x = s.db(); try { return x.prepare('SELECT balance_micro, spent_micro, calls FROM api_keys WHERE key_hash = ?').get(hash); } finally { x.close(); } };
  const settled = async () => { let a = read(); for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 150)); const b = read(); if (JSON.stringify(a) === JSON.stringify(b)) return b; a = b; } return a; };
  const before = await settled();
  const res = await get(`${ROUTE}?symbol=TEST`, { 'x-agentfeed-key': key });
  assert.equal(res.status, 200, res.body.slice(0, 200));
  const after = await settled();
  assert.equal(before.balance_micro - after.balance_micro, Math.max(Math.round(hfUsd(0.5) * 1e6), 500));
  assert.equal(after.calls, before.calls + 1);
});

test('values the query rules refuse are a 400 BEFORE the paywall: no 402, no challenge, no handler, no settlement, no Hyperliquid call; values they let through still reach the paywall', async () => {
  const handlers = s.handlerRuns().length, calls = hl.calls.length;
  s.fac.log.length = 0;
  const refused = [
    ['side=up', /side must be long, short or both/], ['side=LONGS', /side must be/], ['min_usd=9999', /min_usd must be a number from 10000 to 1000000000/], ['min_usd=abc', /min_usd/],
    ['min_usd=1e999', /min_usd/], ['window_min=0', /window_min must be an integer from 1 to 60/], ['window_min=99', /window_min/], ['window_min=2.5', /window_min/],
    ['cooldown_min=14', /cooldown_min must be an integer from 15 to 1440/], ['cooldown_min=1441', /cooldown_min/], ['limit=0', /limit must be an integer from 1 to 100/], ['limit=101', /limit/],
    ['symbol=TEST&side=up&limit=5', /side must be/],
  ];
  for (const [q, re] of refused) {
    for (const m of ['GET', 'HEAD']) {
      const r = await send(m, `${ROUTE}?${q}`);
      assert.equal(r.status, 400, `${m} ?${q}: ${r.body.slice(0, 160)}`);
      assert.equal(r.headers['payment-required'], undefined, `${m} ?${q}: no challenge is offered for a value nobody can pay for`);
      if (m === 'GET') assert.match(JSON.parse(r.body).error, re);
    }
  }
  assert.equal(s.handlerRuns().length, handlers, 'the handler never ran');
  assert.deepEqual(settles(), []);
  assert.equal(hl.calls.length, calls, 'Hyperliquid not asked');
  // the boundary values the rules accept are NOT refused: they reach the paywall (402)
  for (const q of ['min_usd=10000', 'min_usd=1000000000', 'window_min=1', 'window_min=60', 'cooldown_min=15', 'cooldown_min=1440', 'limit=1', 'limit=100', 'side=long', 'side=SHORT', 'side=both', 'min_usd=1e5', 'symbol=NOPE']) {
    const r = await get(`${ROUTE}?${q}`);
    assert.equal(r.status, 402, `?${q} reaches the paywall: ${r.body.slice(0, 120)}`);
  }
  assert.equal(s.handlerRuns().length, handlers);
});

test('a 400 from a handler check the rules do not copy (unsupported symbol), a 404 and a 503 settle nothing: x402 v2, x402 v1 and the prepaid-key rail (the key is refunded in full)', async () => {
  const key = newKey(); const hash = hashKey(key);
  const d = s.db();
  try { d.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, spent_micro, calls, created, rate_per_min, label) VALUES (?, ?, 'active', 5000000, 5000000, 0, 0, ?, 120, 'cascade refusal test')`).run(hash, key.slice(4, 12), Date.now()); } finally { d.close(); }
  const read = () => { const x = s.db(); try { return x.prepare('SELECT balance_micro, spent_micro, calls FROM api_keys WHERE key_hash = ?').get(hash); } finally { x.close(); } };
  const cases = [
    ['400 unsupported symbol', `${ROUTE}?symbol=NOPE`, 400, /unsupported symbol/],
    ['400 malformed symbol', `${ROUTE}?symbol=${encodeURIComponent('BTC USDT')}`, 400, /invalid symbol|unsupported symbol/],
    ['404 events nothing can price (the stand-in answers nothing)', `${ROUTE}?symbol=EMPTY`, 404, /not covered, not charged\.$/],
    ['503 prices cannot be fetched (the stand-in answers 500)', `${ROUTE}?symbol=DOWN`, 503, /Not charged\.$/],
  ];
  const startCalls = read().calls;
  for (const [label, url, status, re] of cases) {
    // the rules do not copy these checks, so the challenge is served; paid, the handler answers the refusal
    s.fac.log.length = 0;
    const v2 = await paid(url, 'v2');
    assert.equal(v2.status, status, `${label} v2: ${v2.body.slice(0, 200)}`);
    assert.match(JSON.parse(v2.body).error, re);
    if (status === 503) assert.ok(Number(v2.headers['retry-after']) > 0, 'Retry-After');
    assert.deepEqual(settles(), [], `${label} v2: never settled`);
    s.fac.log.length = 0;
    const v1 = await paid(url, 'v1');
    assert.equal(v1.status, status, `${label} v1`);
    assert.deepEqual(settles(), [], `${label} v1: never settled`);
    const k = await get(url, { 'x-agentfeed-key': key });
    assert.equal(k.status, status, `${label} key rail`);
    await new Promise((r) => setTimeout(r, 600));
  }
  assert.deepEqual(read(), { balance_micro: 5000000, spent_micro: 0, calls: startCalls }, 'the key rail refunded every reserve and counted no call');
  const supported = JSON.parse((await paid(`${ROUTE}?symbol=NOPE`)).body).supported;
  assert.deepEqual(supported, ['DOWNUSDT', 'EMPTYUSDT', 'TESTUSDT'], 'the 400 lists what works');
  const rows = (await H.rowsSince(s, 0)).filter((x) => x.tool === 'get_cascade_backtest');
  assert.ok(rows.filter((x) => x.status === 'paid').length === 3, 'only the three served answers were billed rows');
  assert.ok(rows.some((x) => x.status === 'bad_request') && rows.some((x) => x.status === 'error'), 'refusals are logged as refusals');
});
