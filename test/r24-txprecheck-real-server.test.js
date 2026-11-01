// get_tx_precheck on the REAL server.js (test/helpers/real-server.js: stub facilitator, every outbound connection refused and logged, scratch databases).
// The route is the real one: expansion.js mounts tools/r24/index.js, titles and questions are the repo's. This test mounts NOTHING and registers nothing; it only stubs the TRANSPORTS of the server under
// test: the Solana RPC (SOLANA_RPC_URL, no fallbacks) and the Base RPC (TXPRECHECK_BASE_RPCS, BASE_SIM_RPC) point at loopback servers that answer from the fake worlds of test/fixtures/r24/txprecheck/
// (rpc-servers.js). A second server under test points at a pair that always answers HTTP 500. Every real host stays refused by the harness. What is proved here and not by the unit tests:
//   - unpaid GET and HEAD, on 24 spellings of the path and on query variants, answer 402 (or are refused) and never the tool's answer: no handler run, no RPC call, no row, no settlement
//   - the MCP tool goes through the x402 gate
//   - a paid x402 call is served and settled once at 50000 atomic units (USD 0.05) on both chains; a key caller pays half
//   - a transaction that FAILS in the simulation is an answer and is charged; 503 (node down) and 400 (bad input, over a cap) settle nothing on x402 v2, on x402 v1 and on the prepaid-key rail
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const http = require('http');
const H = require('./helpers/real-server');
const S = require('./fixtures/r24/txprecheck/scenarios');
const R = require('./fixtures/r24/txprecheck/rpc-servers');
const { hfUsd } = require('../lib/hf');
const { newKey, hashKey } = require('../lib/keys');

const enc = encodeURIComponent;
const sol = (name) => `/api/tx-precheck?chain=solana&tx=${enc(S.tx[name]())}`;
const base = (to, extra = '') => `/api/tx-precheck?chain=base&to=${to}&from=${S.ADDR.me}${extra}`;
const QUERY = sol('ok');
let s, bad, up;                     // s: the server under test with working RPC worlds; bad: a second one whose RPC always answers HTTP 500; up: the loopback servers
let ipN = 0;
const ip = () => { ipN++; return { 'cf-connecting-ip': `198.19.${(ipN >> 8) & 255}.${ipN & 255}` }; };
const get = (srv, p, h = {}) => H.raw(srv.port, 'GET', p, { ...ip(), ...h });
const send = (srv, m, p, h = {}) => H.raw(srv.port, m, p, { ...ip(), ...h });
const rpcLines = () => [...up.log];
const clearRpc = () => { up.log.length = 0; };
const pay = async (srv, p) => { const ch = await get(srv, p); assert.equal(ch.status, 402, `challenge for ${p.slice(0, 80)}`); return get(srv, p, { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) }); };
const settles = (srv) => srv.fac.log.filter((x) => x.op === 'settle');

before(async () => {
  up = await R.startAll();
  s = await H.boot(R.envFor(up.sol, up.base));
  bad = await H.boot(R.envFor(up.down.sol, up.down.base));
});
after(() => { for (const x of [s, bad]) if (x) x.close(); if (up) up.close(); });

const mcp = (srv, payload) => new Promise((resolve, reject) => {
  const body = JSON.stringify(payload);
  const req = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: '/mcp', headers: { host: 'x402.ochinimus.app', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body), ...ip() } }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; });
    res.on('end', () => { const m = /^data: (.*)$/m.exec(b); let j = null; try { j = JSON.parse(m ? m[1] : b); } catch { /* not JSON */ } resolve({ status: res.statusCode, json: j, raw: b }); });
  });
  req.on('error', reject); req.write(body); req.end();
});

test('control: the route is on the real server (mounted by expansion.js), priced at USD 0.05, and an unpaid call is the 402 challenge for 50000 atomic units', async () => {
  assert.equal(s.env.NODE_OPTIONS, undefined, 'no preload of ours is mounted into the server under test: only its transports are pointed at loopback stubs');
  assert.ok(require('../tools/r24').entries.some((e) => e.name === 'get_tx_precheck'), 'the repo\'s own tools/r24/index.js lists the route');
  const c = await get(s, QUERY);
  assert.equal(c.status, 402, c.body.slice(0, 200));
  assert.equal(H.unb64(c.headers['payment-required']).accepts.find((a) => a.network === H.BASE).amount, '50000');
  const spec = JSON.parse((await get(s, '/openapi.json')).body);
  assert.ok(spec.paths['/api/tx-precheck'] && spec.paths['/api/tx-precheck'].get['x-payment-info'], 'priced path in openapi.json');
  assert.ok(JSON.parse((await get(s, '/.well-known/x402.json')).body).resources.some((r) => r.name === 'get_tx_precheck' && r.price_usd === 0.05));
  assert.ok(JSON.parse((await get(s, '/pricing')).body).paid.some((r) => r.tool === 'get_tx_precheck'));
  assert.deepEqual(rpcLines(), [], 'asking for a price made no RPC call');
});

test('unpaid GET and HEAD on the route, on 24 spellings of its path and on query variants: never served, no handler run, no RPC call, no row, no settlement', async () => {
  const p = '/api/tx-precheck';
  const variants = [p, p + '/', p + '//', p.toUpperCase(), p.replace('/api/', '/API/'), p.replace('/api/', '/Api/'), '/' + p, p.replace('/api/', '/api//'), '/api/tx%2Dprecheck', '/api/%74x-precheck', p.replace('/api/', '/api%2F'),
    p.replace('/api/', '/x/../api/'), p.replace('/api/', '/api/./'), '/api/sample/../tx-precheck', p + ';x=1', p + '%20', p + '\\', p + '?', p + '#x', p + '%3F', p + '/.', p.replace('/api/', '/%61pi/'), p + '|eip155:8453/', p + '%7Ceip155:1'];
  assert.equal(variants.length, 24);
  const queries = [QUERY.slice(p.length), '?CHAIN=solana&TX=' + enc(S.tx.ok()), '?chain=solana&chain=base&tx=x', '?chain[]=solana', '?chain=solana&tx=..%2F..%2Fetc%2Fpasswd', '?chain=base&to=0x4200000000000000000000000000000000000006&data=0xd0e30db0&value=1',
    '?chain=base&to=%00', '?chain=base&to=0x4200000000000000000000000000000000000006&from=0x1111111111111111111111111111111111111111', '?chain=ethereum', '?tx=' + enc(S.tx.ok()), '?', '?chain=', '?chain=solana&tx=' + 'A'.repeat(1645)];
  const all = [...variants, ...queries.map((x) => p + x), ...queries.map((x) => p + '/' + x)];
  const bad = [];
  let n = 0;
  for (const v of all) for (const m of ['GET', 'HEAD']) {
    n++;
    const res = await send(s, m, v);
    if (res.status >= 200 && res.status < 400) bad.push(`${m} ${v.slice(0, 90)} -> ${res.status}`);
    if ([0, 1, 3, 4].includes(variants.indexOf(v)) && res.status !== 402) bad.push(`${m} ${v} -> ${res.status} (the plain, trailing-slash, upper-case and /API/ spellings are the 402 challenge)`);
    if (v.startsWith(p + '?') && !v.includes('%00') && res.status !== 402) bad.push(`${m} ${v.slice(0, 90)} -> ${res.status} (a query variant on the canonical path is the 402 challenge)`);
  }
  assert.equal(n, (24 + 2 * queries.length) * 2);
  assert.deepEqual(bad, []);
  assert.deepEqual(s.handlerRuns().filter((x) => x === 'get_tx_precheck'), [], 'no handler ran without payment');
  assert.deepEqual(rpcLines(), [], 'no RPC call without payment');
  assert.deepEqual(s.netAttempts(), [], 'no outbound connection without payment');
  const rows = (await H.rowsSince(s, 0)).filter((x) => x.tool === 'get_tx_precheck');
  assert.deepEqual(rows, [], 'no calls row for the tool: nothing was served');
  assert.deepEqual(settles(s), [], 'and nothing settled');
});

test('the MCP tool is listed with its schema and goes through the x402 gate: unpaid it answers with a payment-required result, runs no handler and asks the facilitator nothing', async () => {
  const list = await mcp(s, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const t = (list.json.result.tools || []).find((x) => x.name === 'get_tx_precheck');
  assert.ok(t, 'get_tx_precheck is in tools/list');
  assert.ok(t.description.startsWith('Use when an agent needs'));
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ['chain', 'data', 'from', 'to', 'tx', 'value']);
  assert.deepEqual(t.inputSchema.required, ['chain']);
  const before = s.handlerRuns().length;
  s.fac.log.length = 0;
  const out = await mcp(s, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_tx_precheck', arguments: { chain: 'solana', tx: S.tx.ok() } } });
  const text = JSON.stringify(out.json);
  assert.ok(out.json && out.json.result, out.raw.slice(0, 200));
  assert.match(text, /payment|x402|402/i);
  assert.ok(!/"balance_changes"|"warnings"|"simulation"/.test(text), 'no answer without payment');
  assert.equal(s.handlerRuns().length, before); assert.deepEqual(settles(s), []); assert.deepEqual(rpcLines(), []);
});

test('paid x402 v2 on Solana: served once, settled once at 50000 atomic units, and the answer is the full data object from the fake node', async () => {
  s.fac.log.length = 0; clearRpc();
  const before = s.handlerRuns().length;
  const res = await pay(s, QUERY);
  assert.equal(res.status, 200, res.body.slice(0, 300));
  const j = JSON.parse(res.body);
  assert.equal(j.tool, 'get_tx_precheck'); assert.equal(j.paid, true);
  assert.equal(j.data.chain, 'solana'); assert.equal(j.data.simulation.ok, true); assert.equal(j.data.request.fee_payer, S.P.ok); assert.deepEqual(j.data.warnings, []);
  for (const k of ['request', 'simulation', 'balance_changes', 'programs', 'approvals', 'delegations', 'new_accounts', 'tokens', 'warnings', 'summary', 'as_of']) assert.ok(k in j.data, k);
  assert.equal(s.handlerRuns().length, before + 1);
  const st = settles(s);
  assert.equal(st.length, 1, 'settled once'); assert.equal(st[0].amount, '50000', 'at the price in PRICES');
  assert.deepEqual(rpcLines().sort(), ['SOL getMultipleAccounts', 'SOL simulateTransaction']);
  assert.deepEqual(s.netAttempts(), [], 'the fake node made no real connection');
  const rows = (await H.rowsSince(s, 0)).filter((x) => x.tool === 'get_tx_precheck');
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'paid');
});

test('paid on Solana: an unlimited delegate is reported with its warnings; the same on Base: an unlimited allowance to a spender outside the table', async () => {
  s.fac.log.length = 0;
  const a = await pay(s, sol('approve'));
  assert.equal(a.status, 200, a.body.slice(0, 300));
  assert.deepEqual(JSON.parse(a.body).data.warnings.map((w) => w.id).sort(), ['delegate_granted', 'unlimited_approval']);
  const b = await pay(s, base(S.ADDR.usdc, '&data=0x095ea7b3'));
  assert.equal(b.status, 200, b.body.slice(0, 300));
  const jb = JSON.parse(b.body);
  assert.equal(jb.data.chain, 'base'); assert.deepEqual(jb.data.warnings.map((w) => w.id).sort(), ['approval_to_unknown_spender', 'unlimited_approval']);
  assert.equal(settles(s).length, 2); assert.ok(settles(s).every((x) => x.amount === '50000'));
  const w = await pay(s, base(S.ADDR.weth, '&data=0xd0e30db0&value=1000'));
  assert.equal(w.status, 200); assert.deepEqual(JSON.parse(w.body).data.warnings, []);
});

test('a transaction that FAILS in the simulation is an answer and is charged: 200, simulation.ok false, settled once', async () => {
  s.fac.log.length = 0;
  const res = await pay(s, sol('fail'));
  assert.equal(res.status, 200, res.body.slice(0, 300));
  const j = JSON.parse(res.body);
  assert.equal(j.data.simulation.ok, false); assert.equal(j.data.simulation.error, 'instruction 0 failed: custom program error 1');
  assert.equal(settles(s).length, 1);
});

test('503 (node down), 400 (bad input, over a cap) are never settled or billed: x402 v2, x402 v1 and the prepaid-key rail (the key rail refunds every reserve); a 400 makes no RPC call', async () => {
  const cases = [
    ['Solana node down (503)', sol('ok'), 503, /Not charged\.$/, true],
    ['Base node down (503)', base(S.ADDR.weth, '&data=0xd0e30db0&value=1000'), 503, /Not charged\.$/, true],
    ['no chain (400)', '/api/tx-precheck?tx=abc', 400, /missing required parameter: chain/, false],
    ['unknown chain (400)', '/api/tx-precheck?chain=ethereum', 400, /not covered/, false],
    ['no tx (400)', '/api/tx-precheck?chain=solana', 400, /missing required parameter: tx/, false],
    ['tx over the cap (400)', `/api/tx-precheck?chain=solana&tx=${'A'.repeat(1645)}`, 400, /cap is 1644/, false],
    ['tx not a transaction (400)', `/api/tx-precheck?chain=solana&tx=${enc(Buffer.alloc(200, 9).toString('base64'))}`, 400, /not a legacy or version 0/, false],
    ['no to (400)', '/api/tx-precheck?chain=base', 400, /missing required parameter: to/, false],
    ['calldata not hex (400)', base(S.ADDR.weth, '&data=0xzz'), 400, /even number of digits/, false],
    ['value not a number (400)', base(S.ADDR.weth, '&value=1.5'), 400, /wei as a decimal/, false],
  ];
  // a 503 case runs on the server whose RPC always answers HTTP 500 (`bad`; the endpoint rests there, which is why it is a second server); a 400 case runs on the working one
  const paidRows = async () => { let n = 0; for (const x of [s, bad]) n += (await H.rowsSince(x, 0)).filter((r) => r.tool === 'get_tx_precheck' && r.status === 'paid').length; return n; };
  const paidBefore = await paidRows();
  const keys = new Map();
  for (const x of [s, bad]) {
    const key = newKey(); const hash = hashKey(key); const d = x.db();
    try { d.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, spent_micro, calls, created, rate_per_min, label) VALUES (?, ?, 'active', 1000000, 1000000, 0, 0, ?, 120, 'txprecheck test')`).run(hash, key.slice(4, 12), Date.now()); } finally { d.close(); }
    keys.set(x, { key, hash });
  }
  const readKey = (x) => { const d = x.db(); try { return d.prepare('SELECT balance_micro, spent_micro, calls FROM api_keys WHERE key_hash = ?').get(keys.get(x).hash); } finally { d.close(); } };
  for (const [what, p, status, msg, retry] of cases) {
    const x = status === 503 ? bad : s;
    clearRpc();
    const ch = await get(x, p);
    assert.equal(ch.status, 402, `${what}: the quote is still served`);
    x.fac.log.length = 0;
    const v2 = await get(x, p, { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) });
    assert.equal(v2.status, status, `${what} v2: ${v2.body.slice(0, 200)}`);
    assert.match(JSON.parse(v2.body).error, msg);
    if (retry) assert.ok(Number(v2.headers['retry-after']) > 0, `${what}: Retry-After`);
    assert.deepEqual(settles(x), [], `${what} v2: never settled`);
    x.fac.log.length = 0;
    const v1 = await get(x, p, { 'x-payment': H.b64(H.payV1({}, '50000')) });
    assert.equal(v1.status, status, `${what} v1: ${v1.body.slice(0, 200)}`);
    assert.deepEqual(settles(x), [], `${what} v1: never settled`);
    const before = readKey(x);
    const kr = await get(x, p, { 'x-agentfeed-key': keys.get(x).key });
    assert.equal(kr.status, status, `${what} key rail`);
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(readKey(x), before, `${what}: the key rail refunded the reserve and counted no call`);
    if (status === 400) assert.deepEqual(rpcLines(), [], `${what}: a bad request makes no RPC call`);
    if (status === 503) assert.ok(rpcLines().length > 0, `${what}: the node was really asked (and answered HTTP 500)`);
  }
  assert.equal(await paidRows(), paidBefore, 'no 503 or 400 wrote a paid row');
});

test('a key caller pays half the price on success (USD 0.025) and the answer is the same data', async () => {
  const key = newKey(); const hash = hashKey(key);
  const d = s.db();
  try { d.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, spent_micro, calls, created, rate_per_min, label) VALUES (?, ?, 'active', 1000000, 1000000, 0, 0, ?, 120, 'txprecheck test')`).run(hash, key.slice(4, 12), Date.now()); } finally { d.close(); }
  const read = () => { const x = s.db(); try { return x.prepare('SELECT balance_micro, spent_micro, calls FROM api_keys WHERE key_hash = ?').get(hash); } finally { x.close(); } };
  const res = await get(s, QUERY, { 'x-agentfeed-key': key });
  assert.equal(res.status, 200, res.body.slice(0, 200));
  assert.equal(JSON.parse(res.body).data.simulation.ok, true);
  await new Promise((r) => setTimeout(r, 1200));
  const row = read();
  assert.equal(1000000 - row.balance_micro, Math.max(Math.round(hfUsd(0.05) * 1e6), 500)); assert.equal(row.calls, 1);
});

test('negative control: with the paywall off (X402_MODE=off) the same unpaid GET IS served, so the 402 sweep above detects a route that is not behind the paywall', async () => {
  const free = await H.boot({ ...R.envFor(up.sol, up.base), X402_MODE: 'off' });
  try {
    clearRpc();
    const res = await H.raw(free.port, 'GET', QUERY, ip());
    assert.equal(res.status, 200, res.body.slice(0, 200));
    assert.equal(JSON.parse(res.body).data.simulation.ok, true);
    assert.equal(JSON.parse(res.body).paid, false);
    assert.ok(rpcLines().length > 0, 'and the fake node was called');
  } finally { free.close(); }
});
