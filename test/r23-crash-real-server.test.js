// test/r23-crash-real-server.test.js: the crash-risk routes on the REAL server.js (test/helpers/real-server.js: stub facilitator, every outbound connection refused), with the switch on and off.
// The routes are registered by tools/r23/index.js when the tree has the lead's wiring, and by test/fixtures/r23/crash/preload-register.js when it does not; the preload also applies the
// two edits of notes-T1.md section 8 (a title and a question per tool, the free route not priced) where the tree lacks them, so this test means the same on either tree.
//   ON : unpaid GET and HEAD on each priced route and on its spellings answer 402 and never the answer; a paid call is served and settled once at the price; a 400, a 404 and a 503
//        settle nothing on x402 v2, x402 v1 and the prepaid-key rail; the free record needs no payment; MCP lists the tools and gates the priced ones; the documents list the routes.
//   OFF: the same server has no such route (404, not 402), and none of the documents or the MCP list mentions it. A control shows the document scan finds the names when the switch is on.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');
const H = require('./helpers/real-server');
const { newKey, hashKey } = require('../lib/keys');
const { ensureSchema } = require('../tools/r23/crash-model/schema');
const META = require('../tools/r23/crash-model/meta.json');
const C = require('../tools/r23/crash-model/constants');

const PRELOAD = path.join(__dirname, 'fixtures', 'r23', 'crash', 'preload-register.js');
const M1 = 'So11111111111111111111111111111111111111112', M2 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', UNKNOWN = '3mRFwgiEZgJCDnCmbZULuX6ecQbFxCMfunXa9VafpDcJ';
const P1 = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7', P2 = 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu';
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r23-crash-rs-')); dirs.push(d); return d; };
const nowSec = () => Math.floor(Date.now() / 1000);

/** a score database to the real schema, in real time (the server's clock is the real one) */
function scoresDb(dir, { tickAgo = 5 } = {}) {
  const f = path.join(dir, 'scores.db'); const d = new Database(f); ensureSchema(d);
  const now = nowSec(), { trees, baseline, feature_names, categories, tables, required_columns, ...pub } = META;
  const ins = d.prepare('INSERT INTO scores (pool_id, mint, pool, dex, score, model_version, scored_ts, t0_ts, t0_liquidity_usd, t0_fdv_usd) VALUES (?,?,?,?,?,?,?,?,?,?)');
  ins.run(1, M1, P1, 'pump-fun', 0.83, META.model_version, now - 120, now - 160, 12000, 30000); ins.run(2, M2, P2, 'orca', 0.02, META.model_version, now - 300, now - 340, 90000, 400000);
  const put = d.prepare('INSERT INTO meta (k, v) VALUES (?, ?)');
  put.run('current_model', META.model_version); put.run(`model:${META.model_version}`, JSON.stringify(pub)); put.run(`frozen:${META.model_version}`, JSON.stringify({ cuts: META.decile_cuts }));
  put.run('last_tick_ts', String(now - tickAgo)); put.run('ledger_last_cycle', String(now - 20));
  d.close();
  return f;
}
const bootWith = (flag, scores) => H.boot({ R23_CRASH_ROUTES: flag, LEDGER_SCORE_DB: scores, NODE_OPTIONS: `--require ${PRELOAD}` });

let on, stale, off;
before(async () => {
  on = await bootWith('on', scoresDb(tmp()));
  stale = await bootWith('on', scoresDb(tmp(), { tickAgo: 3600 }));
  off = await bootWith('off', scoresDb(tmp()));
});
after(() => { for (const x of [on, stale, off]) if (x) x.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

let ipN = 0;
const ip = () => { ipN++; return { 'cf-connecting-ip': `198.19.${(ipN >> 8) & 255}.${ipN & 255}` }; };
const send = (srv, m, p, h = {}) => H.raw(srv.port, m, p, { ...ip(), ...h });
const get = (srv, p, h = {}) => send(srv, 'GET', p, h);
const mcp = (srv, method, params) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const req = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: '/mcp', headers: { host: 'x402.ochinimus.app', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body), ...ip() } }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; });
    res.on('end', () => { const m = /^data: (.*)$/m.exec(b); let j = null; try { j = JSON.parse(m ? m[1] : b); } catch { /* not JSON */ } resolve({ status: res.statusCode, json: j, raw: b }); });
  });
  req.on('error', reject); req.write(body); req.end();
});
const Q = `?mint=${M1}`;
const PRICED = ['get_crash_risk', 'get_launch_radar'];
const ROUTES = [{ path: '/api/crash-risk', q: Q, tool: 'get_crash_risk', usd: 0.02, atomic: '20000' }, { path: '/api/launch-radar', q: '?limit=3', tool: 'get_launch_radar', usd: 0.10, atomic: '100000' }];
const pay = async (srv, r, q = r.q) => { const ch = await get(srv, r.path + q); assert.equal(ch.status, 402, `${r.path}${q}: ${ch.body.slice(0, 200)}`); return { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) }; };

test('control: the server is up with the routes registered; the challenge asks the route price on Base; the free record answers without payment', async () => {
  for (const r of ROUTES) {
    const c = await get(on, r.path + r.q);
    assert.equal(c.status, 402, r.path);
    assert.equal(H.unb64(c.headers['payment-required']).accepts.find((a) => a.network === H.BASE).amount, r.atomic, `${r.path}: the quote is the route price`);
  }
  const before = on.handlerRuns().length;
  const rec = await get(on, '/api/crash-risk-record');
  assert.equal(rec.status, 200, rec.body.slice(0, 300));
  const j = JSON.parse(rec.body);
  assert.equal(j.tool, 'get_crash_risk_record'); assert.equal(j.paid, false, 'a route that was never priced does not say it was paid for');
  assert.deepEqual(j.data.weeks, []); assert.equal(on.handlerRuns().length, before + 1);
  assert.deepEqual(on.fac.log.filter((x) => x.op === 'settle'), []);
});

test('ON: unpaid GET and HEAD on each priced route and on its spellings are never served; the plain, trailing-slash, upper-case and /API/ spellings are the 402; no handler, no outbound connection, no calls row, no settlement', async () => {
  const variants = (p, q) => [p + q, p + '/' + q, p + '//' + q, p.toUpperCase() + q, p.replace('/api/', '/API/') + q, p.replace('/api/', '/Api/') + q, '/' + p + q, p.replace('/api/', '/api//') + q, p + ';x=1' + q, p + '%20' + q, p + '?', p + '/.', p.replace('/api/', '/%61pi/') + q,
    p.replace('/api/', '/x/../api/') + q, p + q + '&mint=' + M2, p + q + '#x', p + '%3F' + q.slice(1), p.replace('-', '%2D') + q, p + '\\' + q, p.replace('/api/', '/api/./') + q];
  const bad = []; let n = 0;
  const before = on.handlerRuns().length;
  for (const r of ROUTES) {
    const vs = variants(r.path, r.q);
    for (const [i, v] of vs.entries()) for (const m of ['GET', 'HEAD']) {
      n++;
      const res = await send(on, m, v);
      if (res.status >= 200 && res.status < 400) bad.push(`${m} ${v} -> ${res.status}`);
      if ([0, 1, 3, 4].includes(i) && res.status !== 402) bad.push(`${m} ${v} -> ${res.status} (expected the 402 challenge)`);
    }
  }
  assert.equal(n, ROUTES.length * 20 * 2);
  assert.deepEqual(bad, []);
  assert.equal(on.handlerRuns().length, before, 'no handler ran without payment');
  assert.deepEqual(on.netAttempts(), []);
  assert.deepEqual(on.fac.log.filter((x) => x.op === 'settle'), []);
  assert.deepEqual((await H.rowsSince(on, 0)).filter((x) => PRICED.includes(x.tool)), [], 'no calls row for a priced route: nothing was served');
});

test('ON: a paid x402 v2 call is served once and settled once at the route price; the answer is the envelope with the route\'s data, and a mint it scored', async () => {
  for (const r of ROUTES) {
    on.fac.log.length = 0;
    const before = on.handlerRuns().length;
    const res = await get(on, r.path + r.q, await pay(on, r));
    assert.equal(res.status, 200, `${r.path}: ${res.body.slice(0, 300)}`);
    const j = JSON.parse(res.body);
    assert.equal(j.tool, r.tool); assert.equal(j.paid, true);
    assert.equal(on.handlerRuns().length, before + 1);
    const settles = on.fac.log.filter((x) => x.op === 'settle');
    assert.equal(settles.length, 1, `${r.path}: settled once`); assert.equal(settles[0].amount, r.atomic, `${r.path}: at the route price`);
    if (r.tool === 'get_crash_risk') { assert.equal(j.data.mint, M1); assert.equal(j.data.score, 0.83); assert.equal(j.data.meaning, C.MEANING); assert.equal(j.data.decile_basis, 'frozen'); assert.ok(j.data.decile >= 1 && j.data.decile <= 10); }
    else { assert.equal(j.data.count, 2); assert.deepEqual(j.data.launches.map((l) => l.mint), [M1, M2]); }
  }
  const rows = (await H.rowsSince(on, 0)).filter((x) => PRICED.includes(x.tool));
  assert.deepEqual(rows.map((x) => [x.tool, x.status, x.amount_usdc]).sort(), [['get_crash_risk', 'paid', 0.02], ['get_launch_radar', 'paid', 0.1]].sort());
});

test('ON: a 400 (both mint and pool, a limit of 0), a 404 (a mint never scored) and a 503 (a stale scorer) settle nothing on x402 v2, on x402 v1 and on the prepaid-key rail', async () => {
  const cases = [
    { srv: on, r: ROUTES[0], q: `?mint=${M1}&pool=${P1}`, status: 400, what: 'both mint and pool' },
    { srv: on, r: ROUTES[0], q: '?', status: 400, what: 'neither' },
    { srv: on, r: ROUTES[1], q: '?limit=0', status: 400, what: 'limit 0' },
    { srv: on, r: ROUTES[1], q: '?limit=101', status: 400, what: 'limit 101' },
    { srv: on, r: ROUTES[0], q: `?mint=${UNKNOWN}`, status: 404, what: 'a mint never scored' },
    { srv: stale, r: ROUTES[0], q: Q, status: 503, what: 'stale scorer, crash-risk' },
    { srv: stale, r: ROUTES[1], q: '?limit=3', status: 503, what: 'stale scorer, radar' },
  ];
  for (const c of cases) {
    // x402 v2
    c.srv.fac.log.length = 0;
    const v2 = await get(c.srv, c.r.path + c.q, await pay(c.srv, c.r, c.q));
    assert.equal(v2.status, c.status, `${c.what} v2: ${v2.body.slice(0, 200)}`);
    assert.deepEqual(c.srv.fac.log.filter((x) => x.op === 'settle'), [], `${c.what} v2: never settled`);
    if (c.status === 503) { assert.ok(Number(v2.headers['retry-after']) > 0, 'Retry-After'); assert.match(JSON.parse(v2.body).error, /Not charged\.$/); }
    if (c.status === 404) assert.match(JSON.parse(v2.body).error, /not covered, not charged\.$/);
    // x402 v1
    c.srv.fac.log.length = 0;
    const v1 = await get(c.srv, c.r.path + c.q, { 'x-payment': H.b64(H.payV1({}, c.r.atomic)) });
    assert.equal(v1.status, c.status, `${c.what} v1: ${v1.body.slice(0, 200)}`);
    assert.deepEqual(c.srv.fac.log.filter((x) => x.op === 'settle'), [], `${c.what} v1: never settled`);
  }
  // control: the same v1 payment on a call that CAN be answered is served and settled (so "nothing settled" above is the refusal, not a broken payment)
  on.fac.log.length = 0;
  const okv1 = await get(on, ROUTES[0].path + Q, { 'x-payment': H.b64(H.payV1({}, ROUTES[0].atomic)) });
  assert.equal(okv1.status, 200, okv1.body.slice(0, 200)); assert.equal(on.fac.log.filter((x) => x.op === 'settle').length, 1);
  // key rail: the reserve is refunded in full on every refusal
  for (const srv of [on, stale]) {
    const key = newKey(); const hash = hashKey(key);
    const d = srv.db();
    try { d.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, spent_micro, calls, created, rate_per_min, label) VALUES (?, ?, 'active', 1000000, 1000000, 0, 0, ?, 120, 'crash test')`).run(hash, key.slice(4, 12), Date.now()); } finally { d.close(); }
    const read = () => { const x = srv.db(); try { return x.prepare('SELECT balance_micro, spent_micro, calls FROM api_keys WHERE key_hash = ?').get(hash); } finally { x.close(); } };
    for (const c of cases.filter((x) => x.srv === srv)) {
      const res = await get(srv, c.r.path + c.q, { 'x-agentfeed-key': key });
      assert.equal(res.status, c.status, `${c.what} key rail`);
      await new Promise((x) => setTimeout(x, 500));
    }
    assert.deepEqual(read(), { balance_micro: 1000000, spent_micro: 0, calls: 0 }, 'the key rail refunded every reserve and counted no call');
    if (srv === on) {                                         // control: a call that is answered draws half the price
      const res = await get(srv, ROUTES[0].path + Q, { 'x-agentfeed-key': key });
      assert.equal(res.status, 200, res.body.slice(0, 200));
      let b; for (let i = 0; i < 30; i++) { await new Promise((x) => setTimeout(x, 150)); b = read(); if (b.calls === 1) break; }
      assert.equal(1000000 - b.balance_micro, 10000, 'half of $0.02'); assert.equal(b.calls, 1);
    }
  }
});

test('ON: MCP lists the three tools; the priced ones are gated by payment, the free one answers', async () => {
  const list = await mcp(on, 'tools/list', {});
  const names = (list.json.result.tools || []).map((t) => t.name);
  for (const r of [...ROUTES.map((x) => x.tool), 'get_crash_risk_record']) assert.ok(names.includes(r), `${r} is in tools/list`);
  const before = on.handlerRuns().length; on.fac.log.length = 0;
  for (const r of ROUTES) {
    const out = await mcp(on, 'tools/call', { name: r.tool, arguments: r.tool === 'get_crash_risk' ? { mint: M1 } : {} });
    assert.match(JSON.stringify(out.json), /payment|x402|402/i, `${r.tool}: the wrapper asks for payment`);
    assert.ok(!/"score"|"launches"/.test(JSON.stringify(out.json)), `${r.tool}: no answer without payment`);
  }
  assert.equal(on.handlerRuns().length, before, 'the tool handler never ran');
  assert.deepEqual(on.fac.log.filter((x) => x.op === 'settle'), []);
  const free = await mcp(on, 'tools/call', { name: 'get_crash_risk_record', arguments: {} });
  assert.match(JSON.stringify(free.json), /No week has a live record yet/);
});

const DOCS = ['/openapi.json', '/.well-known/x402.json', '/.well-known/agent-card.json', '/pricing', '/llms.txt', '/SKILL.md', '/'];
const NAMES = /crash-risk|launch-radar|get_crash_risk|get_launch_radar/;
async function scanDocs(srv) { const hit = {}; for (const p of DOCS) { const r = await get(srv, p); hit[p] = { status: r.status, mentions: NAMES.test(r.body) }; } const l = await mcp(srv, 'tools/list', {}); hit['mcp tools/list'] = { status: l.status, mentions: NAMES.test(l.raw) }; return hit; }

test('ON: the documents list the priced routes at their prices (and the scan below finds the names, the control for the OFF half)', async () => {
  const spec = JSON.parse((await get(on, '/openapi.json')).body);
  for (const r of ROUTES) assert.ok(spec.paths[r.path] && spec.paths[r.path].get['x-payment-info'], `${r.path} is a priced path in openapi.json`);
  const x = JSON.parse((await get(on, '/.well-known/x402.json')).body);
  for (const r of ROUTES) assert.equal(x.resources.find((y) => y.name === r.tool).price_usd, r.usd, `x402.json price of ${r.tool}`);
  const hit = await scanDocs(on);
  assert.ok(hit['/openapi.json'].mentions && hit['/.well-known/x402.json'].mentions && hit['mcp tools/list'].mentions, JSON.stringify(hit));
});

test('OFF (R23_CRASH_ROUTES=off): the routes do not exist: 404 on every spelling and verb, no handler, no 402 challenge, and no document or MCP list mentions them', async () => {
  for (const p of ['/api/crash-risk', '/api/launch-radar', '/api/crash-risk-record']) {
    for (const v of [p, p + '/', p + '?mint=' + M1, p.toUpperCase(), p.replace('/api/', '/API/')]) for (const m of ['GET', 'HEAD']) {
      const res = await send(off, m, v);
      assert.notEqual(res.status, 402, `${m} ${v}: no payment challenge for a route that does not exist`);
      assert.ok(res.status < 200 || res.status >= 400, `${m} ${v} -> ${res.status}: never served`);
    }
    assert.equal((await get(off, p + '?mint=' + M1)).status, 404, p);
  }
  assert.deepEqual(off.handlerRuns(), [], 'no handler ran');
  const hit = await scanDocs(off);
  for (const [doc, h] of Object.entries(hit)) { assert.equal(h.status, 200, doc); assert.equal(h.mentions, false, `${doc} mentions a crash-risk route with the switch off`); }
  const list = await mcp(off, 'tools/list', {});
  assert.deepEqual((list.json.result.tools || []).map((t) => t.name).filter((n) => NAMES.test(n)), []);
  assert.deepEqual(off.fac.log.filter((x) => x.op === 'settle'), []);
});
