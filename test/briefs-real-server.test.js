// pensio briefs on the REAL server.js (test/helpers/real-server.js: stub facilitator, every outbound connection refused, collector files from
// test/helpers/brief-files.js). What is proved here and not by the unit tests:
//   - unpaid GET and HEAD on each new route, and on 24 spellings of it, answer 402 and run no handler, open no connection, write no row;
//   - the MCP tool goes through the x402 gate;
//   - a paid x402 call is served and settled once at the price in PRICES; a key caller pays half (minimum $0.0005);
//   - a 503 (stale sampler) is never settled: not on x402 v2, not on x402 v1, not on the prepaid-key rail;
//   - every public document that counts routes agrees with PRICES.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const H = require('./helpers/real-server');
const { writeFiles } = require('./helpers/brief-files');
const { PRICES } = require('../payments');
const { hfUsd } = require('../lib/hf');
const { newKey, hashKey } = require('../lib/keys');
const BC = require('../tools/briefs/config');

const ROUTES = [['morning', 'get_morning_brief'], ['move', 'get_move_alert'], ['anomaly', 'get_anomaly_flag']].map(([k, tool]) => ({ path: BC.ROUTES[k], tool, key: `GET ${BC.ROUTES[k]}`, usd: PRICES[`GET ${BC.ROUTES[k]}`].usd, atomic: String(Math.round(PRICES[`GET ${BC.ROUTES[k]}`].usd * 1e6)) }));
let s, stale, tapeStale, dirs = [];
let ipN = 0;
const ip = () => { ipN++; return { 'cf-connecting-ip': `198.19.${(ipN >> 8) & 255}.${ipN & 255}` }; };
const get = (srv, p, h = {}) => H.raw(srv.port, 'GET', p, { ...ip(), ...h });
const send = (srv, m, p, h = {}) => H.raw(srv.port, m, p, { ...ip(), ...h });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-fx-')); dirs.push(d); return d; };

before(async () => {
  const good = writeFiles(tmp(), { shock: { SOL: { markPct: -3.4, steps: 12 } } });
  s = await H.boot(good);
  stale = await H.boot(writeFiles(tmp(), { sampler: 'stale' }));
  tapeStale = await H.boot(writeFiles(tmp(), { tape: 'stale' }));
});
after(() => { for (const x of [s, stale, tapeStale]) if (x) x.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const mcpCall = (srv, name, args) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const req = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: '/mcp', headers: { host: 'x402.ochinimus.app', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body), ...ip() } }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; });
    res.on('end', () => { const m = /^data: (.*)$/m.exec(b); let j = null; try { j = JSON.parse(m ? m[1] : b); } catch { /* not JSON */ } resolve({ status: res.statusCode, json: j, raw: b }); });
  });
  req.on('error', reject); req.write(body); req.end();
});
const mcpList = () => new Promise((resolve, reject) => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const req = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/mcp', headers: { host: 'x402.ochinimus.app', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body), ...ip() } }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; });
    res.on('end', () => { const m = /^data: (.*)$/m.exec(b); try { resolve(JSON.parse(m ? m[1] : b)); } catch (e) { reject(e); } });
  });
  req.on('error', reject); req.write(body); req.end();
});

test('control: the three routes are priced from the config and the server is the real one', async () => {
  assert.equal(ROUTES.length, 3);
  for (const r of ROUTES) {
    assert.ok(r.usd > 0, r.key);
    assert.equal(r.usd, BC.PRICES_PROPOSED[{ get_morning_brief: 'morning', get_move_alert: 'move', get_anomaly_flag: 'anomaly' }[r.tool]], `${r.tool} is priced from tools/briefs/config.js`);
    const c = await get(s, r.path);
    assert.equal(c.status, 402, `unpaid GET ${r.path}`);
    assert.ok(c.headers['payment-required']);
    assert.equal(H.unb64(c.headers['payment-required']).accepts.find((a) => a.network === H.BASE).amount, r.atomic, `${r.path}: the challenge asks the price in PRICES`);
  }
});

test('unpaid GET and HEAD on each route and on 24 spellings of it: never served (the canonical spellings are the 402), no handler run, no outbound connection, no calls row', async () => {
  const variants = (p) => { const parts = p.split('/'); const last = parts.pop(); const dir = parts.join('/');
    return [p, p + '/', p + '//', p.toUpperCase(), p.replace('/api/', '/API/'), p.replace('/api/', '/Api/'), '/' + p, p.replace('/api/', '/api//'), dir + '/' + encodeURIComponent(last).replace(/-/g, '%2D'),
      dir + '/%' + last.charCodeAt(0).toString(16) + last.slice(1), p.replace('/api/', '/api%2F'), p.replace('/api/', '/x/../api/'), p.replace('/api/', '/api/./'), '/api/sample/../' + p.slice(5), p + ';x=1', p + '%20', p + '\\', p + '?', p + '#x', p + '%3F', p + '/.', p.replace('/api/', '/%61pi/'), p + '|eip155:8453/', p + '%7Ceip155:1']; };
  const spec = JSON.parse((await get(s, '/openapi.json')).body);
  let n = 0;
  const bad = [];
  for (const r of ROUTES) {
    assert.ok(spec.paths[r.path] && spec.paths[r.path].get['x-payment-info'], `${r.path} is a priced route in the document the R19 canonical-path sweep reads`);
    const vs = variants(r.path);
    assert.equal(vs.length, 24);
    for (const v of vs) for (const m of ['GET', 'HEAD']) {
      n++;
      const res = await send(s, m, v);
      if (res.status >= 200 && res.status < 400) bad.push(`${m} ${v} -> ${res.status}`);             // R19: never served; an odd spelling may 404
      if ([0, 1, 3, 4].includes(vs.indexOf(v)) && res.status !== 402) bad.push(`${m} ${v} -> ${res.status} (the plain, trailing-slash, upper-case and /API/ spellings are the 402 challenge)`);
    }
  }
  assert.equal(n, 3 * 24 * 2, 'the sweep covered 3 routes x 24 spellings x GET and HEAD by count');
  assert.deepEqual(bad, []);
  assert.deepEqual(s.handlerRuns(), [], 'no handler ran without payment');
  assert.deepEqual(s.netAttempts(), [], 'no outbound connection without payment');
  const rows = (await H.rowsSince(s, 0)).filter((x) => ROUTES.some((r) => r.tool === x.tool));
  assert.deepEqual(rows, [], 'no calls row for a brief tool: nothing was served');
  assert.deepEqual(s.fac.log.filter((x) => x.op === 'settle'), [], 'and nothing settled');
});

test('the MCP tools are listed and go through the x402 gate: unpaid they answer with a payment-required result, run no handler and ask the facilitator nothing', async () => {
  const list = await mcpList();
  const names = (list.result.tools || []).map((t) => t.name);
  for (const r of ROUTES) assert.ok(names.includes(r.tool), `${r.tool} is in tools/list`);
  const before = s.handlerRuns().length;
  s.fac.log.length = 0;
  for (const r of ROUTES) {
    const out = await mcpCall(s, r.tool, {});
    const t = JSON.stringify(out.json);
    assert.ok(out.json && out.json.result, `${r.tool}: ${out.raw.slice(0, 200)}`);
    assert.match(t, /payment|x402|402/i, `${r.tool}: the wrapper asks for payment`);
    assert.ok(!/"headline"|"items"/.test(t), `${r.tool}: no brief content without payment`);
  }
  assert.equal(s.handlerRuns().length, before, 'the tool handler never ran');
  assert.deepEqual(s.fac.log.filter((x) => x.op === 'settle'), []);
});

test('paid x402 v2: each route is served once, settled once at its price, and the answer is the envelope (real accessors over the fixture files)', async () => {
  for (const r of ROUTES) {
    s.fac.log.length = 0;
    const before = s.handlerRuns().length;
    const ch = await get(s, r.path);
    const res = await get(s, r.path, { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) });
    assert.equal(res.status, 200, `${r.path}: ${res.body.slice(0, 300)}`);
    const j = JSON.parse(res.body);
    assert.equal(j.tool, r.tool);
    assert.equal(j.paid, true);
    for (const k of ['brief', 'as_of', 'window', 'headline', 'items', 'sources', 'stale_parts', 'method']) assert.ok(k in j.data, `${r.tool}.${k}`);
    assert.equal(s.handlerRuns().length, before + 1);
    const settles = s.fac.log.filter((x) => x.op === 'settle');
    assert.equal(settles.length, 1, `${r.path}: settled once`);
    assert.equal(settles[0].amount, r.atomic, `${r.path}: at the price in PRICES`);
  }
});

test('the three briefs on the fixture market: the morning brief ranks four coins, move-alert sees the SOL hour, anomaly-flag answers; no NaN, no trade call', async () => {
  const E = require('../tools/briefs/engine');
  const fetchPaid = async (r) => { const ch = await get(s, r.path); const res = await get(s, r.path, { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) }); assert.equal(res.status, 200, res.body.slice(0, 300)); return JSON.parse(res.body).data; };
  const [m, v, a] = await Promise.all(ROUTES.map((r) => fetchPaid(r)));
  assert.equal(m.brief, 'morning-brief');
  assert.deepEqual(Object.keys(m.coins).sort(), ['BTC', 'ETH', 'HYPE', 'SOL']);
  assert.ok(m.sources.some((x) => /sampler/.test(x.name)) && m.sources.some((x) => /liquidation tape/.test(x.name)) && m.sources.some((x) => /macro calendar/.test(x.name)));
  assert.ok(m.stale_parts.some((p) => p.part === 'fear and greed'), 'Fear and Greed needs the network, which this harness refuses: it is named as missing, not invented');
  assert.ok(m.items.some((i) => /^CPI scheduled at \d\d:30 UTC/.test(i.what)), 'the calendar fixture reaches the morning brief through the real macro reader');
  assert.equal(v.brief, 'move-alert');
  assert.equal(v.coins_checked, 7);
  assert.ok(v.items.some((i) => i.what.startsWith('SOL ') && /-3\.\d+%/.test(i.what)), `the SOL shock is a move item (${v.items.map((i) => i.what).join(' | ')})`);
  assert.equal(a.brief, 'anomaly-flag');
  assert.ok(Array.isArray(a.items));
  for (const b of [m, v, a]) {
    const text = JSON.stringify([b.headline, b.items.map((i) => [i.what, i.why_it_matters])]);
    assert.doesNotMatch(text, /NaN|undefined|Infinity/);
    assert.doesNotMatch(text, E.TRADE_CALL);
  }
});

test('a key caller pays half the price (minimum $0.0005) and nothing for a failed call', async () => {
  const key = newKey(); const hash = hashKey(key);
  const d = s.db();
  try { d.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, spent_micro, calls, created, rate_per_min, label) VALUES (?, ?, 'active', 1000000, 1000000, 0, 0, ?, 120, 'briefs test')`).run(hash, key.slice(4, 12), Date.now()); } finally { d.close(); }
  const read = () => { const x = s.db(); try { return x.prepare('SELECT balance_micro, spent_micro, calls FROM api_keys WHERE key_hash = ?').get(hash); } finally { x.close(); } };
  const settled = async () => { let a = read(); for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 150)); const b = read(); if (JSON.stringify(a) === JSON.stringify(b)) return b; a = b; } return a; };
  let prev = await settled();
  for (const r of ROUTES) {
    const res = await get(s, r.path, { 'x-agentfeed-key': key });
    assert.equal(res.status, 200, `${r.path}: ${res.body.slice(0, 200)}`);
    const now = await settled();
    const want = Math.max(Math.round(hfUsd(r.usd) * 1e6), 500);
    assert.equal(prev.balance_micro - now.balance_micro, want, `${r.path}: drawn ${hfUsd(r.usd)} = half of ${r.usd} (minimum 0.0005)`);
    assert.equal(now.calls, prev.calls + 1);
    prev = now;
  }
});

test('a 503 is never settled or billed: stale sampler on x402 v2, on x402 v1 and on the prepaid-key rail (real server, stub facilitator, outbound blocked)', async () => {
  for (const r of ROUTES) {
    // unpaid: the challenge does not depend on data
    const ch = await get(stale, r.path);
    assert.equal(ch.status, 402, `${r.path}: the quote is still served`);
    // x402 v2
    stale.fac.log.length = 0;
    const v2 = await get(stale, r.path, { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) });
    assert.equal(v2.status, 503, `${r.path} v2: ${v2.body.slice(0, 200)}`);
    assert.ok(Number(v2.headers['retry-after']) > 0, 'Retry-After');
    assert.match(JSON.parse(v2.body).error, /Not charged\./);
    assert.deepEqual(stale.fac.log.filter((x) => x.op === 'settle'), [], `${r.path} v2: never settled`);
    // x402 v1
    stale.fac.log.length = 0;
    const v1 = await get(stale, r.path, { 'x-payment': H.b64(H.payV1({}, r.atomic)) });
    assert.equal(v1.status, 503, `${r.path} v1: ${v1.body.slice(0, 200)}`);
    assert.deepEqual(stale.fac.log.filter((x) => x.op === 'settle'), [], `${r.path} v1: never settled`);
  }
  // key rail: the reserve is refunded in full
  const key = newKey(); const hash = hashKey(key);
  const d = stale.db();
  try { d.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, spent_micro, calls, created, rate_per_min, label) VALUES (?, ?, 'active', 1000000, 1000000, 0, 0, ?, 120, 'briefs test')`).run(hash, key.slice(4, 12), Date.now()); } finally { d.close(); }
  const read = () => { const x = stale.db(); try { return x.prepare('SELECT balance_micro, spent_micro, calls FROM api_keys WHERE key_hash = ?').get(hash); } finally { x.close(); } };
  for (const r of ROUTES) {
    const res = await get(stale, r.path, { 'x-agentfeed-key': key });
    assert.equal(res.status, 503, `${r.path} key rail`);
    await new Promise((x) => setTimeout(x, 600));
  }
  assert.deepEqual(read(), { balance_micro: 1000000, spent_micro: 0, calls: 0 }, 'the key rail refunded every reserve and counted no call');
});

test('every public document that counts routes agrees with PRICES', async () => {
  const N = Object.keys(PRICES).length;
  const J = async (p) => { const r = await get(s, p); assert.equal(r.status, 200, p); return r; };
  const spec = JSON.parse((await J('/openapi.json')).body);
  assert.equal(Object.values(spec.paths).filter((o) => o.get && o.get['x-payment-info']).length, N, 'openapi.json priced paths');
  assert.equal(JSON.parse((await J('/.well-known/x402.json')).body).resources.length, N, 'x402.json resources');
  assert.equal(JSON.parse((await J('/.well-known/agent-card.json')).body).skills.length, N, 'agent card skills');
  assert.equal(JSON.parse((await J('/pricing')).body).paid.length, N, '/pricing');
  const llms = (await J('/llms.txt')).body, skill = (await J('/SKILL.md')).body;
  for (const r of ROUTES) {
    for (const [name, doc] of [['llms.txt', llms], ['SKILL.md', skill]]) assert.ok(doc.includes(r.path), `${name} lists ${r.path}`);
    const lines = skill.split('\n').filter((l) => l.includes(r.path));
    assert.ok(lines.some((l) => l.includes(`$${r.usd}`) || l.includes(`${r.usd}`)), `SKILL.md prints the price ${r.usd} beside ${r.path}: ${lines[0]}`);
    assert.equal(JSON.parse((await J('/.well-known/x402.json')).body).resources.find((x) => x.name === r.tool).price_usd, r.usd, `x402.json price of ${r.tool}`);
    assert.equal(JSON.parse((await J('/pricing')).body).paid.find((x) => x.tool === r.tool).price_usd, r.usd, `/pricing price of ${r.tool}`);
  }
  const claimed = [...skill.matchAll(/(\d+) paid GET routes/g)].map((m) => Number(m[1]));
  for (const c of claimed) assert.equal(c, N, `SKILL.md says ${c} paid GET routes`);
  const mcp = await mcpList();
  assert.ok((mcp.result.tools || []).length >= ROUTES.length);
});

test('a stale liquidation tape (the real accessor reads the tape\'s newest print): the morning brief is served without it and says so; anomaly-flag, with nothing else found, is a 503', async () => {
  const paid = async (srv, r) => { const ch = await get(srv, r.path); return get(srv, r.path, { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) }); };
  const m = await paid(tapeStale, ROUTES[0]);
  assert.equal(m.status, 200, m.body.slice(0, 200));
  const d = JSON.parse(m.body).data;
  assert.ok(d.stale_parts.some((p) => p.part === 'liquidation tape' && /old \(limit 1800s\)/.test(p.reason)), JSON.stringify(d.stale_parts));
  assert.ok(Object.values(d.coins).every((c) => c.liquidations_8h_usd === null));
  tapeStale.fac.log.length = 0;
  const a = await paid(tapeStale, ROUTES[2]);
  assert.equal(a.status, 503, a.body.slice(0, 200));
  assert.match(JSON.parse(a.body).error, /liquidation tape/);
  assert.deepEqual(tapeStale.fac.log.filter((x) => x.op === 'settle'), [], 'the 503 was not settled');
});

test('the brief pass on the real server: the purchase is a paid 402, a stub-settled purchase activates the key, the key reads a brief with nothing drawn, and another route is a 403', async () => {
  const KL = require('../lib/keys');
  for (const kind of [KL.BRIEF_PASS, KL.BRIEF_DAY_PASS]) {
    const ch = await get(s, kind.path);
    assert.equal(ch.status, 402, `unpaid ${kind.path}`);
    const accepts = H.unb64(ch.headers['payment-required']).accepts;
    assert.ok(accepts.every((a) => a.amount === String(Math.round(kind.usd * 1e6))), `${kind.path}: every accept is exactly ${kind.usd} (no half-price accept for a pass)`);
    const key = newKey(); const hash = hashKey(key);
    const url = `${kind.path}?key_hash=${hash}&prefix=${key.slice(4, 12)}`;
    const c2 = await get(s, url);
    const bought = await get(s, url, { 'payment-signature': H.b64(H.payBase(c2.headers['payment-required'])) });
    assert.equal(bought.status, 200, bought.body.slice(0, 200));
    assert.equal(JSON.parse(bought.body).data.pass.days, kind.days);
    const handlers = s.handlerRuns().length;
    s.fac.log.length = 0;
    const res = await get(s, ROUTES[0].path, { 'x-agentfeed-key': key });
    assert.equal(res.status, 200, res.body.slice(0, 200));
    assert.equal(JSON.parse(res.body).data.brief, 'morning-brief');
    assert.equal(s.handlerRuns().length, handlers + 1);
    assert.deepEqual(s.fac.log, [], 'a pass call asks the facilitator nothing');
    const other = await get(s, '/api/time', { 'x-agentfeed-key': key });
    assert.equal(other.status, 403);
    const bal = JSON.parse((await get(s, '/api/keys/balance', { 'x-agentfeed-key': key })).body);
    assert.equal(bal.balance_usd, 0);
    assert.equal(bal.pass.kind, kind.id);
  }
});
