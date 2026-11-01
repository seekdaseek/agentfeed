// R24 item 3: GET /api/rwa-yields on the REAL server.js (test/helpers/real-server.js: stub facilitator for AgentFeed's own paywall, every outbound connection refused).
// The route is mounted by the repo's own pipeline (tools/r24/index.js -> expansion.js -> PRICES_ADD -> x402 paywall -> lib/tool.js); nothing in this test mounts it. The Ethereum RPC is a loopback stub
// over the synthetic chain; nothing leaves 127.0.0.1. A bad `product` is refused by the query guard (lib/query-rules.js) with a 400 BEFORE the paywall, so it is a 400 unpaid and paid alike, settles nothing.
// Asserts: the unpaid request (GET and HEAD, 24 spellings, query variants) is a 402 that starts no RPC read; a paid call is 200 and settles once; a 400, a 503 and a refused read settle nothing
// on x402 v2 or v1; the discovery documents list the route as priced.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const H = require('./helpers/real-server');
const C = require('./fixtures/r24/rwa/chain');
const P = require('../tools/r24/rwa/products');

const ROUTE = '/api/rwa-yields';
const ATOMIC = '20000';
const enc = encodeURIComponent;
let ipN = 0;
const ip = () => { ipN++; return { 'cf-connecting-ip': `198.18.${(ipN >> 8) & 255}.${ipN & 255}` }; };
const send = (srv, m, p, h = {}) => H.raw(srv.port, m, p, { ...ip(), ...h });
const get = (srv, p, h = {}) => send(srv, 'GET', p, h);
const payV2 = async (srv, p) => { const ch = await get(srv, p); assert.equal(ch.status, 402, `unpaid ${p}: ${ch.body.slice(0, 120)}`); return get(srv, p, { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) }); };
const settles = (srv) => srv.fac.log.filter((x) => x.op === 'settle');

let stub; let srv; let dir; let chain; let mode = { fail: false, price: null };
const rpcSeen = [];

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rwars-'));
  const headTs = Math.floor(Date.now() / 1000 / 12) * 12 - 12;
  const build = () => C.makeChain({ headTs, ...(mode.price ? { price: mode.price } : {}) });
  chain = build();
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', async () => {
      const j = JSON.parse(b); rpcSeen.push(j.method);
      if (mode.fail) { res.statusCode = 500; return res.end('down'); }
      const r = await build().fetchFor({ stub: { mode: 'ok' } })('stub', { body: b });
      res.statusCode = r.status; res.setHeader('content-type', 'application/json'); res.end(await r.text());
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  stub = { url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); } };
  try { srv = await H.boot({ R24_RWA_RPC_ETH: stub.url, R24_RWA_RPC_DEFAULTS: 'off', R24_RWA_DB: path.join(dir, 'rwa-snapshots.db') }); } catch (e) { stub.close(); throw e; }
});
test.after(() => { if (srv) srv.close(); if (stub) stub.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('control: the route is mounted and priced in the real server (0.02): the unpaid challenge asks exactly that, openapi.json and /pricing list it', async () => {
  const c = await get(srv, ROUTE);
  assert.equal(c.status, 402);
  assert.equal(H.unb64(c.headers['payment-required']).accepts.find((a) => a.network === H.BASE && a.scheme === 'exact').amount, ATOMIC);
  const spec = JSON.parse((await get(srv, '/openapi.json')).body);
  assert.ok(spec.paths[ROUTE] && spec.paths[ROUTE].get['x-payment-info'], 'priced path in openapi.json');
  const pricing = JSON.parse((await get(srv, '/pricing')).body).paid;
  const row = pricing.find((x) => x.tool === 'get_rwa_yields'); assert.ok(row); assert.equal(row.price_usd, 0.02);
  assert.equal(rpcSeen.length, 0, 'asking for a price read nothing from the chain');
});

test('unpaid GET and HEAD on the route and on 24 spellings of it (and with query variants): never served, no handler run, no RPC request, nothing settled', async () => {
  const variants = (p) => { const parts = p.split('/'); const last = parts.pop(); const dir2 = parts.join('/');
    return [p, p + '/', p + '//', p.toUpperCase(), p.replace('/api/', '/API/'), p.replace('/api/', '/Api/'), '/' + p, p.replace('/api/', '/api//'), dir2 + '/' + enc(last).replace(/-/g, '%2D'),
      dir2 + '/%' + last.charCodeAt(0).toString(16) + last.slice(1), p.replace('/api/', '/api%2F'), p.replace('/api/', '/x/../api/'), p.replace('/api/', '/api/./'), '/api/sample/../' + p.slice(5), p + ';x=1', p + '%20', p + '\\', p + '?', p + '#x', p + '%3F', p + '/.', p.replace('/api/', '/%61pi/'), p + '|eip155:8453/', p + '%7Ceip155:1']; };
  const vs = variants(ROUTE); assert.equal(vs.length, 24);
  const bad = []; let n = 0;
  for (const v of vs) for (const m of ['GET', 'HEAD']) {
    n++; const res = await send(srv, m, v);
    if (res.status >= 200 && res.status < 400) bad.push(`${m} ${v} -> ${res.status}`);
    if ([0, 1, 3, 4].includes(vs.indexOf(v)) && res.status !== 402) bad.push(`${m} ${v} -> ${res.status} (plain, trailing slash, upper-case and /API/ spellings are the 402)`);
  }
  // the query guard answers a value the handler would refuse with a 400 before the paywall (nothing is charged, nothing is read); every other spelling is the 402
  const guarded = new Set(['?product=nope', '?product=usdy&product=ousg']);
  for (const q of ['?product=usdy', '?product=nope', '?product=usdy&product=ousg', '?PRODUCT=usdy', '?product=', '?window=30', '?product[]=usdy']) {
    for (const m of ['GET', 'HEAD']) { n++; const res = await send(srv, m, ROUTE + q); const want = guarded.has(q) ? 400 : 402; if (res.status !== want) bad.push(`${m} ${ROUTE}${q} -> ${res.status} (wanted ${want})`); }
  }
  assert.ok(n >= 62); assert.deepEqual(bad, []);
  assert.deepEqual(srv.handlerRuns().filter((x) => /rwa/.test(x)), [], 'no handler ran without payment');
  assert.deepEqual(rpcSeen, [], 'no RPC request without payment'); assert.deepEqual(srv.netAttempts(), [], 'no outbound connection');
  assert.deepEqual(settles(srv), [], 'nothing settled');
});

test('the MCP tool is listed and goes through the x402 gate: unpaid it answers with a payment-required result, runs no handler and reads no chain', async () => {
  const post = (body) => new Promise((resolve, reject) => {
    const s = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: '/mcp', headers: { host: 'x402.ochinimus.app', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(s), ...ip() } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { const m = /^data: (.*)$/m.exec(b); resolve(m ? m[1] : b); });
    }); req.on('error', reject); req.write(s); req.end();
  });
  const list = JSON.parse(await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
  const tool = list.result.tools.find((t) => t.name === 'get_rwa_yields'); assert.ok(tool, 'in tools/list');
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['product']); assert.ok(!(tool.inputSchema.required || []).length, 'no required parameter');
  const before = srv.handlerRuns().length;
  const out = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_rwa_yields', arguments: {} } });
  assert.match(out, /payment|x402|402/i); assert.ok(!/"yield_30d_annualized"/.test(out), 'no answer without payment');
  assert.equal(srv.handlerRuns().length, before); assert.deepEqual(rpcSeen, []);
});

test('paid GET: 200, shape right, one settlement at 0.02, paid:true; every served product is there, read from the chain stub', async () => {
  srv.fac.log.length = 0;
  const res = await payV2(srv, ROUTE);
  assert.equal(res.status, 200, res.body.slice(0, 300));
  const j = JSON.parse(res.body);
  assert.equal(j.tool, 'get_rwa_yields'); assert.equal(j.paid, true);
  assert.equal(j.data.count, P.served().length); assert.deepEqual(j.data.products.map((x) => x.product), P.served().map((p) => p.id));
  for (const a of j.data.products) { assert.ok(Number.isFinite(a.nav) && a.nav > 0); assert.ok(Number.isFinite(a.yield_7d_annualized) && Number.isFinite(a.yield_30d_annualized)); assert.equal(a.history_source, 'contract'); assert.deepEqual(a.flags, []); }
  const st = settles(srv); assert.equal(st.length, 1); assert.equal(st[0].amount, ATOMIC);
  assert.ok(rpcSeen.includes('eth_getBlockByNumber') && rpcSeen.includes('eth_call'));
});

test('paid GET with product=: one product, only that contract is read; the name is case-insensitive', async () => {
  srv.fac.log.length = 0;
  const res = await payV2(srv, `${ROUTE}?product=USTB`);
  assert.equal(res.status, 200, res.body.slice(0, 300));
  const j = JSON.parse(res.body); assert.equal(j.data.count, 1); assert.equal(j.data.products[0].product, 'ustb');
  assert.equal(settles(srv).length, 1);
});

test('a bad product is a 400 and a refused read is a 503 "Not charged" with Retry-After: neither settles, on x402 v2 or v1 (control: the next good call settles once)', async () => {
  const seenBefore = rpcSeen.length;
  const challenge = (await get(srv, ROUTE)).headers['payment-required'];
  for (const [what, p, want] of [['unknown id', `${ROUTE}?product=nope`, 400], ['two ids', `${ROUTE}?product=usdy&product=ousg`, 400], ['list', `${ROUTE}?product=usdy,ousg`, 400]]) {
    srv.fac.log.length = 0;
    const unpaid = await get(srv, p); assert.equal(unpaid.status, want, `${what} unpaid: the guard refuses before the paywall`); assert.equal(JSON.parse(unpaid.body).param, 'product');
    const v2 = await get(srv, p, { 'payment-signature': H.b64(H.payBase(challenge)) }); assert.equal(v2.status, want, `${what} v2: ${v2.body.slice(0, 200)}`); assert.deepEqual(settles(srv), [], `${what}: never settled on v2`);
    const v1 = await get(srv, p, { 'x-payment': H.b64(H.payV1({}, ATOMIC)) }); assert.equal(v1.status, want, `${what} v1`); assert.deepEqual(settles(srv), [], `${what}: never settled on v1`);
  }
  assert.equal(rpcSeen.length, seenBefore, 'a 400 reads nothing from the chain');
  // the chain is down: 503, Not charged. (The route keeps an answer 30 seconds so a burst of callers does not multiply chain reads; let the earlier answers expire first.)
  await new Promise((r) => setTimeout(r, 31000));
  mode.fail = true;
  try {
    for (const p of [`${ROUTE}?product=ustb`, ROUTE]) {
      srv.fac.log.length = 0;
      const v2 = await payV2(srv, p); assert.equal(v2.status, 503, v2.body.slice(0, 200)); assert.ok(Number(v2.headers['retry-after']) > 0); assert.match(JSON.parse(v2.body).error, /Not charged\.$/); assert.deepEqual(settles(srv), [], 'never settled on v2');
      const v1 = await get(srv, p, { 'x-payment': H.b64(H.payV1({}, ATOMIC)) }); assert.equal(v1.status, 503); assert.deepEqual(settles(srv), [], 'never settled on v1');
      assert.ok(!/127\.0\.0\.1|http:\/\//.test(v2.body), 'no endpoint URL in the refusal');
    }
  } finally { mode.fail = false; }
  // an implausible price is refused the same way
  mode.price = { usdy: () => 9n * 10n ** 18n };
  try {
    srv.fac.log.length = 0;
    const v2 = await payV2(srv, `${ROUTE}?product=usdy`); assert.equal(v2.status, 503, v2.body.slice(0, 200)); assert.deepEqual(settles(srv), []);
  } finally { mode.price = null; }
  srv.fac.log.length = 0;
  const ok = await payV2(srv, `${ROUTE}?product=usdy`); assert.equal(ok.status, 200, ok.body.slice(0, 200)); assert.equal(settles(srv).length, 1);
});

test('the audit table: a paid 200 is a paid row for get_rwa_yields; a refused read is an error row; none of the refusals is paid', async () => {
  const rows = (await H.rowsSince(srv, 0)).filter((x) => x.tool === 'get_rwa_yields');
  assert.ok(rows.some((x) => x.status === 'paid' && Math.abs(x.amount_usdc - 0.02) < 1e-9), JSON.stringify(rows));
  assert.ok(rows.some((x) => x.status === 'error'), 'a refused read is an error row');
  // a bad `product` over REST never reaches the handler (the query guard refuses it before the paywall), so it leaves no row; the handler's own 400 is covered in r24-rwa.test.js
  assert.ok(rows.filter((x) => x.status === 'paid').every((x) => x.amount_usdc === 0.02));
});
