// R23 T3: the two routes on the REAL server.js (test/helpers/real-server.js: stub facilitator for AgentFeed's own paywall, every outbound connection refused).
// The routes are mounted by the repo itself (expansion.js -> tools/r23/index.js), nothing is registered by the test. test/fixtures/r23/x402/server-preload.js only puts mock sellers behind a
// stubbed socket. Everything else is the unmodified server: the x402 paywall on every rail, the route wrapper, the 400/404/503 mapping, the discovery documents. Behind the routes: the REAL
// wallet files made by the generator, the REAL spend ledger (R23_SPEND_DB), the REAL balance reads (against a loopback JSON-RPC), the REAL x402 client libraries signing, and the mock sellers.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const H = require('./helpers/real-server');
const S = require('./fixtures/r23/x402/seller');

const PRELOAD = path.join(__dirname, 'fixtures', 'r23', 'x402', 'server-preload.js');
const GEN = path.join(__dirname, '..', 'ops', 'r23-x402-wallet-gen.mjs');
const LINT = { path: '/api/x402-lint', tool: 'get_x402_lint', usd: 0.05, atomic: '50000' };
const TEST = { path: '/api/x402-test', tool: 'get_x402_test', usd: 1, atomic: '1000000' };
const enc = encodeURIComponent;
const target = (host, p = S.PATH) => `https://${host}${p}`;
let ipN = 0;
const ip = () => { ipN++; return { 'cf-connecting-ip': `198.19.${(ipN >> 8) & 255}.${ipN & 255}` }; };
const send = (srv, m, p, h = {}) => H.raw(srv.port, m, p, { ...ip(), ...h });
const get = (srv, p, h = {}) => send(srv, 'GET', p, h);
const payV2 = async (srv, p, extra = {}) => { const ch = await get(srv, p); assert.equal(ch.status, 402, `unpaid ${p}: ${ch.body.slice(0, 120)}`); return get(srv, p, { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])), ...extra }); };
const settles = (srv) => srv.fac.log.filter((x) => x.op === 'settle');

let rpc; let rpcMode = { baseBalance: 10n ** 8n, solBalance: 10n ** 8n, fail: false }; const rpcCalls = [];
let A; let B; let walletDir; let spendFile; let sellerLog; let wallet; const dirs = [];
const sellerLines = () => { try { return fs.readFileSync(sellerLog, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const spendRows = () => { const d = new Database(spendFile, { readonly: true, fileMustExist: true }); try { return d.prepare('SELECT state, usd_reserved, usd_final FROM spend ORDER BY id').all(); } finally { d.close(); } };

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402rs-')); dirs.push(dir);
  walletDir = path.join(dir, 'wallet'); spendFile = path.join(dir, 'spend.db'); sellerLog = path.join(dir, 'seller.log');
  const g = spawnSync(process.execPath, [GEN], { env: { PATH: process.env.PATH, X402TEST_WALLET_DIR: walletDir }, encoding: 'utf8' });
  assert.equal(g.status, 0, g.stderr);
  wallet = { base: /base\s+(0x[0-9a-fA-F]{40})/.exec(g.stdout)[1], solana: /solana\s+([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(g.stdout)[1] };
  // one loopback JSON-RPC for the balance reads (Base eth_call, Solana getTokenAccountBalance through lib/solrpc.js) and for the Solana client (mint account, blockhash)
  const K = require('@solana/kit');
  const mint = Buffer.alloc(82); mint.writeBigUInt64LE(1000000n, 36); mint[44] = 6; mint[45] = 1;
  const blockhash = K.getBase58Decoder().decode(Uint8Array.from({ length: 32 }, (_, i) => i + 7));
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const j = JSON.parse(b); rpcCalls.push(j.method);
      res.setHeader('content-type', 'application/json');
      if (rpcMode.fail) { res.statusCode = 500; return res.end('down'); }
      let result = null;
      if (j.method === 'eth_call') result = `0x${rpcMode.baseBalance.toString(16)}`;
      else if (j.method === 'getTokenAccountBalance') result = { context: { slot: 1 }, value: { amount: String(rpcMode.solBalance), decimals: 6, uiAmount: 1 } };
      else if (j.method === 'getAccountInfo') result = { context: { slot: 1 }, value: { data: [mint.toString('base64'), 'base64'], executable: false, lamports: 1461600, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', rentEpoch: 0, space: 82 } };
      else if (j.method === 'getLatestBlockhash') result = { context: { slot: 1 }, value: { blockhash, lastValidBlockHeight: 1000 } };
      res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  rpc = { url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections(); srv.close(); } };
  const env = (extra) => ({ NODE_OPTIONS: `--require ${PRELOAD}`, AF_SELLER_LOG: sellerLog, X402TEST_BASE_RPC: rpc.url, SOLANA_RPC_URL: rpc.url, RPC_FALLBACKS: '', X402TEST_SOLANA_RPC_URL: rpc.url, R23_SPEND_DB: spendFile, ...extra });
  A = await H.boot(env({ X402TEST_WALLET_DIR: walletDir, X402TEST_PER_DAY_USD: '0.012' }));
  B = await H.boot(env({ X402TEST_WALLET_DIR: path.join(dir, 'no-wallet-here'), R23_SPEND_DB: path.join(dir, 'spend-b.db'), AF_SELLER_LOG: path.join(dir, 'seller-b.log') }));
});
test.after(() => { for (const x of [A, B]) if (x) x.close(); if (rpc) rpc.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('control: both routes are priced in the real server (0.05 and 1.00), the unpaid challenge asks exactly that, and the openapi document lists them as priced paths', async () => {
  for (const r of [LINT, TEST]) {
    const c = await get(A, `${r.path}?url=${enc(target('seller.test'))}`);
    assert.equal(c.status, 402, r.path); assert.equal(H.unb64(c.headers['payment-required']).accepts.find((a) => a.network === H.BASE && a.scheme === 'exact').amount, r.atomic, r.path);
  }
  const spec = JSON.parse((await get(A, '/openapi.json')).body);
  for (const r of [LINT, TEST]) assert.ok(spec.paths[r.path] && spec.paths[r.path].get['x-payment-info'], `${r.path} is a priced path in openapi.json`);
  const pricing = JSON.parse((await get(A, '/pricing')).body).paid;
  assert.equal(pricing.find((x) => x.tool === LINT.tool).price_usd, 0.05); assert.equal(pricing.find((x) => x.tool === TEST.tool).price_usd, 1);
  assert.deepEqual(sellerLines(), [], 'asking for a price touched no seller');
});

test('unpaid GET and HEAD on each route and on 24 spellings of it (and with query variants): never served, no handler run, no outbound connection, no seller contacted, nothing settled, nothing reserved', async () => {
  const variants = (p) => { const parts = p.split('/'); const last = parts.pop(); const dir = parts.join('/');
    return [p, p + '/', p + '//', p.toUpperCase(), p.replace('/api/', '/API/'), p.replace('/api/', '/Api/'), '/' + p, p.replace('/api/', '/api//'), dir + '/' + enc(last).replace(/-/g, '%2D'),
      dir + '/%' + last.charCodeAt(0).toString(16) + last.slice(1), p.replace('/api/', '/api%2F'), p.replace('/api/', '/x/../api/'), p.replace('/api/', '/api/./'), '/api/sample/../' + p.slice(5), p + ';x=1', p + '%20', p + '\\', p + '?', p + '#x', p + '%3F', p + '/.', p.replace('/api/', '/%61pi/'), p + '|eip155:8453/', p + '%7Ceip155:1']; };
  let n = 0; const bad = [];
  for (const r of [LINT, TEST]) {
    const vs = variants(r.path); assert.equal(vs.length, 24);
    for (const v of vs) for (const m of ['GET', 'HEAD']) {
      n++; const res = await send(A, m, v);
      if (res.status >= 200 && res.status < 400) bad.push(`${m} ${v} -> ${res.status}`);
      if ([0, 1, 3, 4].includes(vs.indexOf(v)) && res.status !== 402) bad.push(`${m} ${v} -> ${res.status} (the plain, trailing-slash, upper-case and /API/ spellings are the 402)`);
    }
    for (const q of [`?url=${enc(target('seller.test'))}`, `?url=${enc(target('seller.test'))}&method=POST`, '?url=', '?method=PUT', `?url=${enc(target('seller.test'))}&url=${enc(target('free.test'))}`, '?url=http://127.0.0.1/', `?URL=${enc(target('seller.test'))}`]) {
      for (const m of ['GET', 'HEAD']) { n++; const res = await send(A, m, r.path + q); if (res.status !== 402) bad.push(`${m} ${r.path}${q} -> ${res.status}`); }
    }
  }
  assert.ok(n >= 2 * 24 * 2 + 28); assert.deepEqual(bad, []);
  assert.deepEqual(A.handlerRuns().filter((x) => /x402/.test(x)), [], 'no handler ran without payment');
  assert.deepEqual(A.netAttempts(), [], 'no outbound connection without payment'); assert.deepEqual(sellerLines(), [], 'no seller was contacted');
  assert.deepEqual(settles(A), [], 'nothing settled');
  assert.equal(fs.existsSync(spendFile) ? spendRows().length : 0, 0, 'nothing reserved');
  const rows = (await H.rowsSince(A, 0)).filter((x) => /x402/.test(x.tool)); assert.deepEqual(rows, [], 'no calls row');
});

test('the MCP tools are listed and go through the x402 gate: unpaid they answer with a payment-required result and run no handler', async () => {
  const call = (name, args) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const req = http.request({ host: '127.0.0.1', port: A.port, method: 'POST', path: '/mcp', headers: { host: 'x402.ochinimus.app', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body), ...ip() } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b));
    }); req.on('error', reject); req.write(body); req.end();
  });
  const listBody = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const list = await new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port: A.port, method: 'POST', path: '/mcp', headers: { host: 'x402.ochinimus.app', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(listBody), ...ip() } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { const m = /^data: (.*)$/m.exec(b); resolve(JSON.parse(m ? m[1] : b)); }); }); req.on('error', reject); req.write(listBody); req.end(); });
  const names = list.result.tools.map((t) => t.name);
  for (const r of [LINT, TEST]) assert.ok(names.includes(r.tool), `${r.tool} is in tools/list`);
  const before = A.handlerRuns().length;
  for (const r of [LINT, TEST]) { const out = await call(r.tool, { url: target('seller.test') }); assert.match(out, /payment|x402|402/i, r.tool); assert.ok(!/"verdict"/.test(out), `${r.tool}: no answer without payment`); }
  assert.equal(A.handlerRuns().length, before); assert.deepEqual(sellerLines(), []);
});

test('lint, paid: 200, valid, settled once at 0.05; the seller saw the request, a HEAD and the two spellings and never a payment', async () => {
  A.fac.log.length = 0;
  const res = await payV2(A, `${LINT.path}?url=${enc(target('seller.test'))}`);
  assert.equal(res.status, 200, res.body.slice(0, 300));
  const j = JSON.parse(res.body);
  assert.equal(j.tool, LINT.tool); assert.equal(j.paid, true); assert.equal(j.data.verdict, 'valid'); assert.equal(j.data.score, 100); assert.equal(j.data.url, target('seller.test'));
  const st = settles(A); assert.equal(st.length, 1); assert.equal(st[0].amount, LINT.atomic);
  const lines = sellerLines().filter((l) => l.startsWith('REQ')); assert.equal(lines.length, 4); assert.ok(lines.every((l) => l.endsWith('paid=false')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('REQ HEAD')));
});
test('lint, paid: an endpoint that serves free is a verdict (200, charged once); a URL the guard refuses is a 400; an endpoint that never answers is a 503 -> none of the last two settles, on x402 v2 or v1', async () => {
  A.fac.log.length = 0;
  const free = await payV2(A, `${LINT.path}?url=${enc(target('free.test'))}`);
  assert.equal(free.status, 200); assert.equal(JSON.parse(free.body).data.verdict, 'no-402'); assert.equal(settles(A).length, 1);
  for (const [what, url, want] of [['loopback', 'http://127.0.0.1/x', 400], ['metadata', 'http://169.254.169.254/latest', 400], ['unreachable', target('down.test'), 503], ['no url', '', 400]]) {
    A.fac.log.length = 0;
    const p = `${LINT.path}?url=${enc(url)}`;
    const v2 = await payV2(A, p);
    assert.equal(v2.status, want, `${what} v2: ${v2.body.slice(0, 200)}`); assert.deepEqual(settles(A), [], `${what}: never settled on v2`);
    if (want === 503) { assert.ok(Number(v2.headers['retry-after']) > 0); assert.match(JSON.parse(v2.body).error, /Not charged\.$/); }
    const v1 = await get(A, p, { 'x-payment': H.b64(H.payV1({}, LINT.atomic)) });
    assert.equal(v1.status, want, `${what} v1`); assert.deepEqual(settles(A), [], `${what}: never settled on v1`);
  }
});

test('test, paid: ONE real payment from the generated wallet files to the linted payTo, 200 PASS, settled once at 1.00, the spend ledger holds one settled row, the seller saw exactly one payment', async () => {
  A.fac.log.length = 0; const before = sellerLines().length;
  const res = await payV2(A, `${TEST.path}?url=${enc(target('seller.test'))}`);
  assert.equal(res.status, 200, res.body.slice(0, 400));
  const d = JSON.parse(res.body).data;
  assert.equal(d.verdict, 'PASS', JSON.stringify(d.reasons)); assert.equal(d.settlement.payer_is_test_wallet, true);
  assert.equal(d.payment.payer, wallet.base, 'the payer is the address the generator printed'); assert.equal(d.payment.pay_to, S.PAY_TO_BASE); assert.equal(d.payment.amount_atomic, '5000');
  const st = settles(A); assert.equal(st.length, 1); assert.equal(st[0].amount, TEST.atomic, 'the caller paid 1.00');
  const mine = sellerLines().slice(before);
  assert.equal(mine.filter((l) => l.endsWith('paid=true')).length, 1, 'exactly one paid request reached the seller'); assert.equal(mine.filter((l) => l.startsWith('SETTLE')).length, 1);
  assert.ok(mine.some((l) => l === `SETTLE eip155:8453 ${wallet.base}`), mine.join('\n'));
  assert.deepEqual(spendRows().map((r) => [r.state, r.usd_final]), [['settled', 0.005]]);
  assert.ok(rpcCalls.includes('eth_call'), 'the Base balance was read before the payment');
  assert.equal(d.timing.time_to_402_ms >= 0 && d.timing.time_to_paid_response_ms >= 0, true);
});
test('test, paid: a seller that serves free is a verdict (200 FAIL, charged, nothing paid); a seller over the cap is a 404 and a seller that never answers a 503: neither settles, and the test wallet pays nothing', async () => {
  const paidBefore = sellerLines().filter((l) => l.endsWith('paid=true')).length; const rowsBefore = spendRows().length;
  A.fac.log.length = 0;
  const free = await payV2(A, `${TEST.path}?url=${enc(target('free.test'))}`);
  assert.equal(free.status, 200); assert.equal(JSON.parse(free.body).data.verdict, 'FAIL'); assert.equal(settles(A).length, 1);
  for (const [what, host, want, re] of [['over the cap', 'pricey.test', 404, /not covered, not charged\.$/], ['unreachable', 'down.test', 503, /Not charged\.$/]]) {
    A.fac.log.length = 0;
    const p = `${TEST.path}?url=${enc(target(host))}`;
    const v2 = await payV2(A, p);
    assert.equal(v2.status, want, `${what}: ${v2.body.slice(0, 200)}`); assert.match(JSON.parse(v2.body).error, re); assert.deepEqual(settles(A), [], `${what}: never settled on v2`);
    const v1 = await get(A, p, { 'x-payment': H.b64(H.payV1({}, TEST.atomic)) });
    assert.equal(v1.status, want, `${what} v1`); assert.deepEqual(settles(A), [], `${what}: never settled on v1`);
  }
  assert.equal(sellerLines().filter((l) => l.endsWith('paid=true')).length, paidBefore, 'the test wallet paid nobody');
  assert.equal(spendRows().length, rowsBefore, 'nothing was reserved');
});
test('test, paid: an unfunded wallet, a failing balance read and a reached daily cap are all 503 "Not charged": the caller is not settled and the test wallet pays nobody', async () => {
  const paidBefore = sellerLines().filter((l) => l.endsWith('paid=true')).length;
  const p = `${TEST.path}?url=${enc(target('seller.test'))}`;
  try {
    rpcMode = { baseBalance: 4999n, solBalance: 0n, fail: false };
    A.fac.log.length = 0;
    let r = await payV2(A, p); assert.equal(r.status, 503, r.body.slice(0, 200)); assert.match(JSON.parse(r.body).error, /holds less USDC than this endpoint asks for. Not charged\.$/); assert.deepEqual(settles(A), []);
    rpcMode = { baseBalance: 0n, solBalance: 0n, fail: true };
    r = await payV2(A, p); assert.equal(r.status, 503); assert.match(JSON.parse(r.body).error, /balance of the test wallet could not be read/); assert.deepEqual(settles(A), []);
    r = await get(A, p, { 'x-payment': H.b64(H.payV1({}, TEST.atomic)) }); assert.equal(r.status, 503); assert.deepEqual(settles(A), [], 'and on x402 v1');
  } finally { rpcMode = { baseBalance: 10n ** 8n, solBalance: 10n ** 8n, fail: false }; }
  // the day's cap (0.012): the first PASS above was 0.005; a second fits (0.010), a third (0.015) does not
  A.fac.log.length = 0;
  const second = await payV2(A, p); assert.equal(second.status, 200, second.body.slice(0, 200)); assert.equal(JSON.parse(second.body).data.verdict, 'PASS'); assert.equal(settles(A).length, 1);
  A.fac.log.length = 0;
  const third = await payV2(A, p);
  assert.equal(third.status, 503, third.body.slice(0, 200)); assert.match(JSON.parse(third.body).error, /daily spend cap of 0\.012 USD.*Not charged\.$/); assert.deepEqual(settles(A), [], 'the caller of the refused call was not settled');
  assert.equal(sellerLines().filter((l) => l.endsWith('paid=true')).length, paidBefore + 1, 'only the second PASS paid the seller');
  assert.deepEqual(spendRows().map((r) => r.state), ['settled', 'settled']);
});
test('test, paid, on a server with NO wallet files: 503 "Not charged" on every rail, the seller is never contacted, nothing is reserved', async () => {
  B.fac.log.length = 0;
  const p = `${TEST.path}?url=${enc(target('seller.test'))}`;
  const v2 = await payV2(B, p); assert.equal(v2.status, 503, v2.body.slice(0, 200)); assert.match(JSON.parse(v2.body).error, /the x402 test wallet is not set up. Not charged\.$/); assert.ok(Number(v2.headers['retry-after']) > 0);
  const v1 = await get(B, p, { 'x-payment': H.b64(H.payV1({}, TEST.atomic)) }); assert.equal(v1.status, 503);
  assert.deepEqual(settles(B), []);
  assert.deepEqual((() => { try { return fs.readFileSync(path.join(path.dirname(spendFile), 'seller-b.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } })(), [], 'no seller was contacted');
  // the lint does not need the wallet: it is served on the same server
  const lint = await payV2(B, `${LINT.path}?url=${enc(target('seller.test'))}`); assert.equal(lint.status, 200); assert.equal(JSON.parse(lint.body).data.verdict, 'valid');
});
test('the public documents list the two new routes with their prices, and the priced paths of openapi.json and the resources of x402.json agree', async () => {
  const x = JSON.parse((await get(A, '/.well-known/x402.json')).body);
  for (const r of [LINT, TEST]) assert.equal(x.resources.find((q) => q.name === r.tool).price_usd, r.usd, r.tool);
  const spec = JSON.parse((await get(A, '/openapi.json')).body);
  assert.equal(Object.values(spec.paths).filter((o) => o.get && o.get['x-payment-info']).length, x.resources.length, 'openapi.json and x402.json count the same routes');
});
