// test/r23-claim-check-real-server.test.js: claim-check on the REAL server.js (test/helpers/real-server.js: stub facilitator, every outbound connection refused, scratch databases).
// claim-check is not in expansion.js yet (the lead wires it), so the child server is started with test/fixtures/r23/claimcheck/wire-preload.js, which registers the module's own
// entry the way expansion.js will: EXP, PRICES_ADD, TAGS_ADD, MCP_DEFS_ADD, the title and the question, and the region gate's two sets. The handler is the real claimCheck() with
// scripted pages and a stand-in model (the claim picks the scenario). What this proves that the unit tests cannot:
//   - unpaid GET and HEAD, and 24 spellings of the path, answer 402 (or are not served) and start no model call, no page read, no settlement;
//   - a paid call is served and settled ONCE at the route price; the prepaid-key rail draws half;
//   - a 400, a 404 and a 503 settle nothing on x402 v2, x402 v1 or the key rail; a fabricated quote is a 200 INSUFFICIENT that does settle (it is an answer);
//   - the MCP tool is listed and goes through the x402 gate; the public documents list the route;
//   - the region gate refuses a caller outside Google's regions with a 451 before the paywall, once the two additions are made.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const H = require('./helpers/real-server');
const { hfUsd } = require('../lib/hf');
const { newKey, hashKey } = require('../lib/keys');

const ROUTE = '/api/claim-check'; const TOOL = 'get_claim_check'; const USD = 0.15; const ATOMIC = String(Math.round(USD * 1e6));
const GOOD = 'The Harbour Tunnel is 12.4 kilometres long.'; const WRONG = 'The Harbour Tunnel is 14.2 kilometres long.';
const OK_URL = 'https://www.example.org/ok';
const q = (claim, urls = OK_URL) => `${ROUTE}?claim=${encodeURIComponent(claim)}${urls ? `&urls=${encodeURIComponent(urls)}` : ''}`;
let s; let dir; let log;
let ipN = 0;
const ip = () => { ipN++; return { 'cf-connecting-ip': `198.19.${(ipN >> 8) & 255}.${ipN & 255}` }; };
const get = (p, h = {}, srv = s) => H.raw(srv.port, 'GET', p, { ...ip(), ...h });
const send = (m, p, h = {}) => H.raw(s.port, m, p, { ...ip(), ...h });
const logLines = () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const paidV2 = async (p, h = {}) => { const ch = await get(p, h); assert.equal(ch.status, 402, `challenge for ${p}`); return get(p, { ...h, 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) }); };
const settles = () => s.fac.log.filter((x) => x.op === 'settle');

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r23cc-real-'));
  log = path.join(dir, 'cc.log');
  s = await H.boot({ NODE_OPTIONS: `--require ${path.join(__dirname, 'fixtures', 'r23', 'claimcheck', 'wire-preload.js')}`, AF_CC_LOG: log });
});
after(() => { if (s) s.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const mcp = (method, params, h = {}) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const req = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/mcp', headers: { host: 'x402.ochinimus.app', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body), ...ip(), ...h } }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; });
    res.on('end', () => { const m = /^data: (.*)$/m.exec(b); let j = null; try { j = JSON.parse(m ? m[1] : b); } catch { /* not JSON */ } resolve({ status: res.statusCode, json: j, raw: b }); });
  });
  req.on('error', reject); req.write(body); req.end();
});

test('control: the route is priced from the entry, the challenge asks exactly the list price on every exact rail, and the query-less URL stays a 402 (the catalogues list it)', async () => {
  const c = await get(q(GOOD));
  assert.equal(c.status, 402);
  const accepts = H.unb64(c.headers['payment-required']).accepts;
  assert.equal(accepts.find((a) => a.network === H.BASE).amount, ATOMIC);
  assert.ok(accepts.some((a) => a.scheme === 'exact' && a.amount === ATOMIC && a.network === 'eip155:8453'));
  assert.equal((await get(ROUTE)).status, 402, 'no query at all');
  assert.equal((await send('HEAD', q(GOOD))).status, 402);
  assert.deepEqual(logLines(), [], 'a challenge starts no model call and no page read');
});

test('unpaid GET and HEAD on the route and on 24 spellings of it: never served, no handler run, no model call, no page read, no outbound connection, no calls row, nothing settled', async () => {
  const variants = (p) => { const parts = p.split('/'); const last = parts.pop(); const dir2 = parts.join('/');
    return [p, p + '/', p + '//', p.toUpperCase(), p.replace('/api/', '/API/'), p.replace('/api/', '/Api/'), '/' + p, p.replace('/api/', '/api//'), dir2 + '/' + encodeURIComponent(last).replace(/-/g, '%2D'),
      dir2 + '/%' + last.charCodeAt(0).toString(16) + last.slice(1), p.replace('/api/', '/api%2F'), p.replace('/api/', '/x/../api/'), p.replace('/api/', '/api/./'), '/api/sample/../' + p.slice(5), p + ';x=1', p + '%20', p + '\\', p + '?', p + '#x', p + '%3F', p + '/.', p.replace('/api/', '/%61pi/'), p + '|eip155:8453/', p + '%7Ceip155:1']; };
  const spec = JSON.parse((await get('/openapi.json')).body);
  assert.ok(spec.paths[ROUTE] && spec.paths[ROUTE].get['x-payment-info'], 'a priced route in the document the R19 canonical-path sweep reads');
  const vs = variants(ROUTE); assert.equal(vs.length, 24);
  const withQuery = (v) => (/[?#]/.test(v) ? v : `${v}?claim=${encodeURIComponent(GOOD)}&urls=${encodeURIComponent(OK_URL)}`);
  const bad = []; let n = 0;
  for (const v of vs) for (const m of ['GET', 'HEAD']) for (const form of [v, withQuery(v)]) {
    n++;
    const res = await send(m, form);
    if (res.status >= 200 && res.status < 400) bad.push(`${m} ${form} -> ${res.status}`);
    if ([0, 1, 3, 4].includes(vs.indexOf(v)) && res.status !== 402) bad.push(`${m} ${form} -> ${res.status} (the plain, trailing-slash, upper-case and /API/ spellings are the 402 challenge)`);
  }
  assert.equal(n, 24 * 2 * 2);
  assert.deepEqual(bad, []);
  assert.deepEqual(s.handlerRuns().filter((x) => x === TOOL), [], 'no handler ran without payment');
  assert.deepEqual(logLines(), [], 'no model call and no page read');
  assert.deepEqual(s.netAttempts(), [], 'no outbound connection');
  assert.deepEqual((await H.rowsSince(s, 0)).filter((x) => x.tool === TOOL), [], 'no calls row');
  assert.deepEqual(settles(), []);
});

test('the MCP tool is listed with its schema and goes through the x402 gate: unpaid it asks for payment and runs nothing', async () => {
  const list = await mcp('tools/list', {});
  const t = (list.json.result.tools || []).find((x) => x.name === TOOL);
  assert.ok(t, `${TOOL} is in tools/list`);
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ['claim', 'urls']); assert.deepEqual(t.inputSchema.required, ['claim']);
  const before1 = s.handlerRuns().length;
  const out = await mcp('tools/call', { name: TOOL, arguments: { claim: GOOD, urls: OK_URL } });
  assert.match(JSON.stringify(out.json), /payment|x402|402/i);
  assert.ok(!/"verdict"/.test(JSON.stringify(out.json)), 'no answer without payment');
  assert.equal(s.handlerRuns().length, before1); assert.deepEqual(logLines(), []);
  assert.deepEqual(settles(), []);
});

test('paid over MCP (the real @x402/mcp wrapper): the tool answers and settles once at the list price; a model outage and a bad input come back as isError results and settle nothing', async () => {
  const call = (args, payment) => mcp('tools/call', { name: TOOL, arguments: args, ...(payment ? { _meta: { 'x402/payment': payment } } : {}) });
  const pay = async (args) => {
    const un = await call(args);
    const accepted = JSON.parse(un.json.result.content[0].text).accepts.find((a) => a.network === H.BASE);
    return { x402Version: 2, accepted, payload: { signature: '0x' + '11'.repeat(65), authorization: { from: H.PAYER, to: accepted.payTo, value: accepted.amount, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: '0x' + '07'.repeat(32) } } };
  };
  s.fac.log.length = 0;
  const okArgs = { claim: GOOD, urls: OK_URL };
  const ok = await call(okArgs, await pay(okArgs));
  assert.ok(!ok.json.result.isError, JSON.stringify(ok.json).slice(0, 300));
  const body = JSON.parse(ok.json.result.content[0].text);
  assert.equal(body.tool, TOOL); assert.equal(body.data.verdict, 'SUPPORTED');
  assert.equal(settles().length, 1); assert.equal(settles()[0].amount, ATOMIC);
  for (const args of [{ claim: `${GOOD} zzmodeldown`, urls: OK_URL }, { claim: 'Is the tunnel 12.4 kilometres long?', urls: OK_URL }, { claim: GOOD, urls: 'http://www.example.org/ok' }]) {
    s.fac.log.length = 0;
    const res = await call(args, await pay(args));
    assert.equal(res.json.result.isError, true, JSON.stringify(args));
    assert.deepEqual(settles(), [], `${JSON.stringify(args)}: nothing settled`);
  }
});

test('paid x402 v2: served once, settled once at the list price; the envelope is {tool, data, paid} and the data is the claim-check answer with a verified quote', async () => {
  s.fac.log.length = 0; fs.writeFileSync(log, ''); const handlers = s.handlerRuns().length;
  const res = await paidV2(q(GOOD, `${OK_URL}?fresh=1`));                // a URL no earlier test read, so this call reads its page (the fetched text of the others is cached)
  assert.equal(res.status, 200, res.body.slice(0, 300));
  const j = JSON.parse(res.body);
  assert.equal(j.tool, TOOL); assert.equal(j.paid, true);
  for (const k of ['claim', 'verdict', 'confidence_note', 'quotes', 'sources_read', 'sources_failed', 'model', 'method']) assert.ok(k in j.data, k);
  assert.equal(j.data.verdict, 'SUPPORTED');
  assert.match(j.data.quotes[0].text, /12\.4 kilometres long/); assert.equal(j.data.quotes[0].url, `${OK_URL}?fresh=1`); assert.equal(j.data.quotes[0].source_kind, 'web');
  assert.equal(s.handlerRuns().length, handlers + 1);
  assert.equal(settles().length, 1); assert.equal(settles()[0].amount, ATOMIC);
  assert.deepEqual(logLines().map((l) => l.split(' ')[0]), ['page', 'model'], 'one page read and one model call');
  const rows = (await H.rowsSince(s, 0)).filter((x) => x.tool === TOOL && x.req_path === ROUTE && x.status === 'paid' && x.amount_usdc != null);
  assert.equal(rows.length, 1, JSON.stringify(rows)); assert.equal(rows[0].status, 'paid'); assert.equal(Number(rows[0].amount_usdc), USD);
});

test('a false claim through the real server: CONTRADICTED with the page\'s own figure; a planted instruction in the page does not turn it into SUPPORTED', async () => {
  const a = JSON.parse((await paidV2(q(WRONG))).body).data;
  assert.equal(a.verdict, 'CONTRADICTED'); assert.match(a.quotes[0].text, /12\.4 kilometres/);
  const b = JSON.parse((await paidV2(q(WRONG, 'https://www.example.org/inject'))).body).data;
  assert.notEqual(b.verdict, 'SUPPORTED'); assert.equal(b.verdict, 'CONTRADICTED');
  assert.ok(b.quotes.every((x) => !/previous instructions/i.test(x.text)));
  assert.match(b.method, /1 line that read as an instruction to an AI model was removed/);
});

test('a fabricated quote is a 200 INSUFFICIENT with no quotes, and it IS settled (it is an answer); a dropped quote never reaches the customer', async () => {
  s.fac.log.length = 0;
  const res = await paidV2(q(`${GOOD} zzfabricate`));
  assert.equal(res.status, 200, res.body.slice(0, 200));
  const d = JSON.parse(res.body).data;
  assert.equal(d.verdict, 'INSUFFICIENT'); assert.deepEqual(d.quotes, []); assert.match(d.confidence_note, /no proposed quote could be found word for word/);
  assert.ok(!JSON.stringify(d).includes('famous engineer'));
  assert.equal(settles().length, 1);
});

const REFUSALS = [
  ['bad: a question', q('Is the tunnel 12.4 kilometres long?'), 400, null],
  ['bad: an http URL', q(GOOD, 'http://www.example.org/ok'), 400, null],
  ['bad: a private address', q(GOOD, 'https://169.254.169.254/latest/meta-data/'), 400, null],
  ['bad: a claim over 300 characters', q(`The tunnel is long ${'x'.repeat(300)}`), 400, null],
  ['bad: four URLs', q(GOOD, 'https://a.example.org/1,https://a.example.org/2,https://a.example.org/3,https://a.example.org/4'), 400, null],
  ['bad: the URL answers 404', q(GOOD, 'https://www.example.org/missing'), 400, 'page'],
  ['503: the URL is down', q(GOOD, 'https://www.example.org/down'), 503, 'page'],
  ['503: the model API is down', q(`${GOOD} zzmodeldown`), 503, 'model'],
  ['404: no URL and nothing to find', q('the tunnel is 12.4 kilometres long today', null), 404, 'none'],
];
test('a 400, a 404 and a 503 settle NOTHING: not on x402 v2, not on x402 v1, and the prepaid-key rail refunds every reserve; none of the refused inputs started a model call', async () => {
  const key = newKey(); const hash = hashKey(key);
  const d = s.db();
  try { d.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, spent_micro, calls, created, rate_per_min, label) VALUES (?, ?, 'active', 1000000, 1000000, 0, 0, ?, 120, 'claim-check test')`).run(hash, key.slice(4, 12), Date.now()); } finally { d.close(); }
  const readKey = () => { const x = s.db(); try { return x.prepare('SELECT balance_micro, spent_micro, calls FROM api_keys WHERE key_hash = ?').get(hash); } finally { x.close(); } };
  for (const [what, p, status, upstream] of REFUSALS) {
    // where the query rule `textCap('claim', 300)` of lib/query-rules.js is in place (the lead's wiring) an over-long claim never reaches the paywall: a 400 and no challenge to sign
    const first = await get(p);
    if (first.status === 400) {
      assert.match(JSON.parse(first.body).error, /300-character limit/, what); assert.equal(first.headers['payment-required'], undefined, `${what}: no challenge`);
      assert.deepEqual(settles(), []); assert.deepEqual(logLines(), [], `${what}: nothing started`);
      continue;
    }
    for (const rail of ['v2', 'v1', 'key']) {
      s.fac.log.length = 0; fs.writeFileSync(log, '');
      let res;
      if (rail === 'v2') res = await paidV2(p);
      else if (rail === 'v1') { const ch = await get(p); assert.equal(ch.status, 402); res = await get(p, { 'x-payment': H.b64(H.payV1({}, ATOMIC)) }); }
      else res = await get(p, { 'x-agentfeed-key': key });
      assert.equal(res.status, status, `${what} on ${rail}: ${res.body.slice(0, 200)}`);
      if (status === 503) { assert.ok(Number(res.headers['retry-after']) > 0, `${what}: Retry-After`); assert.match(JSON.parse(res.body).error, /Not charged\./); }
      if (status === 404) assert.match(JSON.parse(res.body).error, /not covered, not charged\./);
      assert.deepEqual(settles(), [], `${what} on ${rail}: never settled`);
      const calls = logLines().map((l) => l.split(' ')[0]);
      if (upstream === null) assert.deepEqual(calls, [], `${what}: a bad input starts no page read and no model call`);
      if (upstream === 'page') assert.deepEqual(calls, ['page'], `${what}: the page was tried, the model was not called`);
      if (upstream === 'none') assert.ok(!calls.includes('model'), `${what}: no model call`);
      if (upstream === 'model') assert.ok(calls.includes('model'));
    }
  }
  await wait(900);
  assert.deepEqual(readKey(), { balance_micro: 1000000, spent_micro: 0, calls: 0 }, 'the key rail refunded every reserve and counted no call');
});

test('a key caller pays half the list price for an answer, and the draw is exactly that', async () => {
  const key = newKey(); const hash = hashKey(key);
  const d = s.db();
  try { d.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, spent_micro, calls, created, rate_per_min, label) VALUES (?, ?, 'active', 1000000, 1000000, 0, 0, ?, 120, 'claim-check test')`).run(hash, key.slice(4, 12), Date.now()); } finally { d.close(); }
  const res = await get(q(GOOD), { 'x-agentfeed-key': key });
  assert.equal(res.status, 200, res.body.slice(0, 200)); assert.equal(JSON.parse(res.body).data.verdict, 'SUPPORTED');
  await wait(900);
  const x = s.db(); let row; try { row = x.prepare('SELECT balance_micro, calls FROM api_keys WHERE key_hash = ?').get(hash); } finally { x.close(); }
  assert.equal(1000000 - row.balance_micro, Math.round(hfUsd(USD) * 1e6)); assert.equal(row.calls, 1);
});

test('the in-flight limit on the real server (default 2 at once, 2 s of waiting): of three paid calls that all read a slow page two are served and settled, the third is a 503 "claim-check is busy" with Retry-After 5, not settled, and it read no page', async () => {
  s.fac.log.length = 0; fs.writeFileSync(log, '');
  const res = await Promise.all([1, 2, 3].map((n) => paidV2(q(GOOD, `https://www.example.org/slow?n=${n}`))));
  const codes = res.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 200, 503], res.map((r) => `${r.status} ${r.body.slice(0, 80)}`).join(' | '));
  const refused = res.find((r) => r.status === 503);
  assert.equal(refused.headers['retry-after'], '5'); assert.match(JSON.parse(refused.body).error, /^claim-check is busy\. Not charged\.$/);
  assert.equal(settles().length, 2, 'the refused call settled nothing');
  assert.equal(logLines().filter((l) => l.startsWith('page ')).length, 2, 'the refused call read no page');
  assert.equal((await paidV2(q(GOOD, `${OK_URL}?after=busy`))).status, 200, 'the slots were released');
});

test('the public documents list the route at its price, and the MCP tool list has the tool', async () => {
  const J = async (p) => { const r = await get(p); assert.equal(r.status, 200, p); return r; };
  const spec = JSON.parse((await J('/openapi.json')).body);
  assert.ok(spec.paths[ROUTE].get['x-payment-info']);
  const x402 = JSON.parse((await J('/.well-known/x402.json')).body);
  assert.equal(x402.resources.find((r) => r.name === TOOL).price_usd, USD);
  assert.equal(JSON.parse((await J('/pricing')).body).paid.find((r) => r.tool === TOOL).price_usd, USD);
  assert.ok((await J('/llms.txt')).body.includes(ROUTE));
  const N = Object.keys(require('../payments').PRICES).length;
  assert.ok(x402.resources.length >= N, 'x402.json lists every priced route (this server also has the preload route)');
});

test('REGION GATE (once the route and the tool are added to its two sets): a caller outside Google\'s regions gets 451 before the paywall and no handler runs; an allowed region and a request with no country header reach the 402; the same on the MCP tool', async () => {
  const before1 = s.handlerRuns().length; fs.writeFileSync(log, '');
  for (const country of ['CN', 'RU', 'T1', 'XX']) {
    const r = await get(q(GOOD), { 'cf-ipcountry': country });
    assert.equal(r.status, 451, country); assert.equal(JSON.parse(r.body).country, country);
    assert.equal(r.headers['payment-required'], undefined, 'no challenge for a region the model cannot serve');
    const r2 = await get(q(GOOD).replace('/api/', '/API/'), { 'cf-ipcountry': country });
    assert.equal(r2.status, 451, `${country} on the upper-case spelling`);
    const m = await mcp('tools/call', { name: TOOL, arguments: { claim: GOOD } }, { 'cf-ipcountry': country });
    assert.equal(m.status, 451, `${country} over MCP`);
  }
  assert.equal((await get(q(GOOD), { 'cf-ipcountry': 'US' })).status, 402, 'an allowed region gets the normal challenge');
  assert.equal((await get(q(GOOD))).status, 402, 'no header: the gate cannot judge, the challenge');
  const out = await mcp('tools/call', { name: 'get_time', arguments: {} }, { 'cf-ipcountry': 'CN' });
  assert.notEqual(out.status, 451, 'a route that is not a language-model route is not gated');
  assert.equal(s.handlerRuns().length, before1); assert.deepEqual(logLines(), []);
});
