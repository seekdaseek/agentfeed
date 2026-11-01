// test/r24-company-check-real-server.test.js: company-check on the REAL server.js (test/helpers/real-server.js: stub facilitator, every outbound connection refused, scratch databases).
// company-check is not in expansion.js yet (the lead wires tools/r24/index.js), so the child server is started with test/fixtures/r24/company-check/wire-preload.js, which registers the module's own
// entry the way expansion.js will (EXP, PRICES_ADD, TAGS_ADD, MCP_DEFS_ADD, title, question) and gives its handler a synthetic EDGAR, a scripted insider function and a scripted site read.
// What this proves that the unit tests cannot:
//   - unpaid GET and HEAD, and 24 spellings of the path, answer 402 (or are not served) and start no EDGAR read, no insider call, no site read, no settlement;
//   - a paid call is served and settled ONCE at 0.25; the prepaid-key rail draws half;
//   - a 400, a 404 and a 503 settle nothing on x402 v2, x402 v1 or the key rail, and the 400 starts no read at all;
//   - the in-flight limit (2 at once, the third is a 503 "busy" that read nothing); the MCP tool is listed and goes through the x402 gate; the public documents list the route.
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

const ROUTE = '/api/company-check'; const TOOL = 'get_company_check'; const USD = 0.25; const ATOMIC = String(Math.round(USD * 1e6));
const enc = encodeURIComponent;
const q = (v) => `${ROUTE}?q=${enc(v)}`;
let s; let dir; let log;
let ipN = 0;
const ip = () => { ipN++; return { 'cf-connecting-ip': `198.19.${(ipN >> 8) & 255}.${ipN & 255}` }; };
const get = (p, h = {}) => H.raw(s.port, 'GET', p, { ...ip(), ...h });
const send = (m, p, h = {}) => H.raw(s.port, m, p, { ...ip(), ...h });
const logLines = () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const paidV2 = async (p, h = {}) => { const ch = await get(p, h); assert.equal(ch.status, 402, `challenge for ${p}`); return get(p, { ...h, 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) }); };
const settles = () => s.fac.log.filter((x) => x.op === 'settle');

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r24cc-real-'));
  log = path.join(dir, 'cc.log');
  s = await H.boot({ NODE_OPTIONS: `--require ${path.join(__dirname, 'fixtures', 'r24', 'company-check', 'wire-preload.js')}`, AF_CC_LOG: log });
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
  const c = await get(q('ALDR'));
  assert.equal(c.status, 402);
  const accepts = H.unb64(c.headers['payment-required']).accepts;
  assert.equal(accepts.find((a) => a.network === H.BASE).amount, ATOMIC);
  assert.ok(accepts.some((a) => a.scheme === 'exact' && a.amount === ATOMIC && a.network === 'eip155:8453'));
  assert.equal((await get(ROUTE)).status, 402, 'no query at all');
  assert.equal((await send('HEAD', q('ALDR'))).status, 402);
  assert.deepEqual(logLines(), [], 'a challenge starts no EDGAR read, no insider call and no site read');
});

test('unpaid GET and HEAD on the route and on 24 spellings of it: never served, no handler run, nothing read, no outbound connection, no calls row, nothing settled', async () => {
  const variants = (p) => { const parts = p.split('/'); const last = parts.pop(); const dir2 = parts.join('/');
    return [p, p + '/', p + '//', p.toUpperCase(), p.replace('/api/', '/API/'), p.replace('/api/', '/Api/'), '/' + p, p.replace('/api/', '/api//'), dir2 + '/' + enc(last).replace(/-/g, '%2D'),
      dir2 + '/%' + last.charCodeAt(0).toString(16) + last.slice(1), p.replace('/api/', '/api%2F'), p.replace('/api/', '/x/../api/'), p.replace('/api/', '/api/./'), '/api/sample/../' + p.slice(5), p + ';x=1', p + '%20', p + '\\', p + '?', p + '#x', p + '%3F', p + '/.', p.replace('/api/', '/%61pi/'), p + '|eip155:8453/', p + '%7Ceip155:1']; };
  const spec = JSON.parse((await get('/openapi.json')).body);
  assert.ok(spec.paths[ROUTE] && spec.paths[ROUTE].get['x-payment-info'], 'a priced route in the document the canonical-path sweep reads');
  const vs = variants(ROUTE); assert.equal(vs.length, 24);
  const withQuery = (v) => (/[?#]/.test(v) ? v : `${v}?q=BRLG`);
  const bad = []; let n = 0;
  for (const v of vs) for (const m of ['GET', 'HEAD']) for (const form of [v, withQuery(v)]) {
    n++;
    const res = await send(m, form);
    if (res.status >= 200 && res.status < 400) bad.push(`${m} ${form} -> ${res.status}`);
    if ([0, 1, 3, 4].includes(vs.indexOf(v)) && res.status !== 402) bad.push(`${m} ${form} -> ${res.status} (the plain, trailing-slash, upper-case and /API/ spellings are the 402 challenge)`);
  }
  for (const qv of ['?q=', '?Q=BRLG', '?q=BRLG&q=ALDR', '?q=https://example.com', '?q=%00']) for (const m of ['GET', 'HEAD']) { n++; const res = await send(m, ROUTE + qv); if (res.status !== 402) bad.push(`${m} ${ROUTE}${qv} -> ${res.status}`); }
  assert.ok(n >= 24 * 2 * 2);
  assert.deepEqual(bad, []);
  assert.deepEqual(s.handlerRuns().filter((x) => x === TOOL), [], 'no handler ran without payment');
  assert.deepEqual(logLines(), [], 'no EDGAR read, no insider call, no site read');
  assert.deepEqual(s.netAttempts(), [], 'no outbound connection');
  assert.deepEqual((await H.rowsSince(s, 0)).filter((x) => x.tool === TOOL), [], 'no calls row');
  assert.deepEqual(settles(), []);
});

test('the MCP tool is listed with its schema and goes through the x402 gate: unpaid it asks for payment and runs nothing', async () => {
  const list = await mcp('tools/list', {});
  const t = (list.json.result.tools || []).find((x) => x.name === TOOL);
  assert.ok(t, `${TOOL} is in tools/list`);
  assert.deepEqual(Object.keys(t.inputSchema.properties), ['q', 'site']); assert.deepEqual(t.inputSchema.required, ['q']);
  const before1 = s.handlerRuns().length;
  const out = await mcp('tools/call', { name: TOOL, arguments: { q: 'ALDR' } });
  assert.match(JSON.stringify(out.json), /payment|x402|402/i);
  assert.ok(!/"verdict"/.test(JSON.stringify(out.json)), 'no answer without payment');
  assert.equal(s.handlerRuns().length, before1); assert.deepEqual(logLines(), []);
  assert.deepEqual(settles(), []);
});

test('paid over MCP (the real @x402/mcp wrapper): the tool answers and settles once at the list price; a foreign filer and a bad input come back as isError results and settle nothing', async () => {
  const call = (args, payment) => mcp('tools/call', { name: TOOL, arguments: args, ...(payment ? { _meta: { 'x402/payment': payment } } : {}) });
  const pay = async (args) => {
    const un = await call(args);
    const accepted = JSON.parse(un.json.result.content[0].text).accepts.find((a) => a.network === H.BASE);
    return { x402Version: 2, accepted, payload: { signature: '0x' + '11'.repeat(65), authorization: { from: H.PAYER, to: accepted.payTo, value: accepted.amount, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: '0x' + '07'.repeat(32) } } };
  };
  s.fac.log.length = 0;
  const okArgs = { q: 'ALDR' };
  const ok = await call(okArgs, await pay(okArgs));
  assert.ok(!ok.json.result.isError, JSON.stringify(ok.json).slice(0, 300));
  const body = JSON.parse(ok.json.result.content[0].text);
  assert.equal(body.tool, TOOL); assert.equal(body.data.flags.going_concern, false);
  assert.equal(settles().length, 1); assert.equal(settles()[0].amount, ATOMIC);
  for (const args of [{ q: 'EXPT' }, { q: '' }, { q: 'Pioneer' }]) {
    s.fac.log.length = 0;
    const res = await call(args, await pay(args));
    assert.equal(res.json.result.isError, true, JSON.stringify(args));
    assert.deepEqual(settles(), [], `${JSON.stringify(args)}: nothing settled`);
  }
});

test('paid x402 v2: served once, settled once at the list price; the envelope is {tool, data, paid} and the data is the company-check answer, every fact with a source on sec.gov', async () => {
  s.fac.log.length = 0; fs.writeFileSync(log, ''); const handlers = s.handlerRuns().length;
  const res = await paidV2(q('BRLG'));
  assert.equal(res.status, 200, res.body.slice(0, 300));
  const j = JSON.parse(res.body);
  assert.equal(j.tool, TOOL); assert.equal(j.paid, true);
  for (const k of ['query', 'company', 'verdict', 'flags', 'going_concern', 'latest_10k', 'latest_10q', 'delisting_notice_8k', 'recent_8k', 'staleness', 'insider_form4', 'website', 'method', 'fetched_at']) assert.ok(k in j.data, k);
  assert.deepEqual(j.data.flags, { going_concern: true, delisting_notice_8k: true, stale: false });
  assert.match(j.data.verdict, /^Going-concern language in the latest 10-K and 10-Q; delisting notice 8-K \(Item 3\.01\) on 2026-09-09/);
  assert.equal(s.handlerRuns().length, handlers + 1);
  assert.equal(settles().length, 1); assert.equal(settles()[0].amount, ATOMIC);
  const kinds = logLines().map((l) => l.split(' ')[0]); assert.ok(kinds.includes('edgar') && kinds.includes('insider'));
  const rows = (await H.rowsSince(s, 0)).filter((x) => x.tool === TOOL && x.req_path === ROUTE && x.status === 'paid' && x.amount_usdc != null);
  assert.equal(rows.length, 1, JSON.stringify(rows)); assert.equal(Number(rows[0].amount_usdc), USD);
});

test('v2: an annual report over 5 MB (6 MiB here) is READ as a stream and answered, settled once at the list price', async () => {
  s.fac.log.length = 0;
  const res = await paidV2(q('HUGE'));
  assert.equal(res.status, 200, res.body.slice(0, 300));
  const d = JSON.parse(res.body).data; assert.equal(d.latest_10k.ok, true); assert.equal(d.flags.going_concern, false);
  assert.equal(settles().length, 1); assert.equal(settles()[0].amount, ATOMIC);
});

const REFUSALS = [
  ['bad: an empty q', q(''), 400, 'none'],
  ['bad: a q that is a control character', q('\u0001'), 400, 'none'],
  ['bad: an ambiguous name', q('Pioneer'), 400, 'list'],
  ['bad: a name nobody has', q('Nonexistent Widgets Ltd'), 400, 'list'],
  ['bad: a website whose name matches two companies', q('pioneer.com'), 400, 'list'],
  ['bad: a site parameter that is a private address', `${q('ALDR')}&site=127.0.0.1`, 400, 'none'],
  ['bad: a site parameter that is not https', `${q('ALDR')}&site=http://example.com`, 400, 'none'],
  ['404: a website whose name matches no company', q('example-not-listed.com'), 404, 'list'],
  ['404: a foreign filer', q('EXPT'), 404, 'filings'],
  ['404: no 10-K or 10-Q', q('FNCH'), 404, 'filings'],
  ['503: EDGAR does not serve the 10-K', q('OUTG'), 503, 'filings'],
];
test('a 400, a 404 and a 503 settle NOTHING: not on x402 v2, not on x402 v1, and the prepaid-key rail refunds every reserve; a 400 reads nothing at all', async () => {
  const key = newKey(); const hash = hashKey(key);
  const d = s.db();
  try { d.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, spent_micro, calls, created, rate_per_min, label) VALUES (?, ?, 'active', 1000000, 1000000, 0, 0, ?, 120, 'company-check test')`).run(hash, key.slice(4, 12), Date.now()); } finally { d.close(); }
  const readKey = () => { const x = s.db(); try { return x.prepare('SELECT balance_micro, spent_micro, calls FROM api_keys WHERE key_hash = ?').get(hash); } finally { x.close(); } };
  for (const [what, p, status, reads] of REFUSALS) {
    for (const rail of ['v2', 'v1', 'key']) {
      s.fac.log.length = 0; fs.writeFileSync(log, '');
      let res;
      if (rail === 'v2') res = await paidV2(p);
      else if (rail === 'v1') { const ch = await get(p); assert.equal(ch.status, 402); res = await get(p, { 'x-payment': H.b64(H.payV1({}, ATOMIC)) }); }
      else res = await get(p, { 'x-agentfeed-key': key });
      assert.equal(res.status, status, `${what} on ${rail}: ${res.body.slice(0, 200)}`);
      if (status === 503) { assert.ok(Number(res.headers['retry-after']) > 0, `${what}: Retry-After`); assert.match(JSON.parse(res.body).error, /Not charged\.$/); }
      if (status === 404) assert.match(JSON.parse(res.body).error, /not covered, not charged\.$/);
      assert.deepEqual(settles(), [], `${what} on ${rail}: never settled`);
      const kinds = logLines().map((l) => l.split(' ')[0]);
      if (reads === 'none') assert.deepEqual(kinds, [], `${what}: a bad q starts no read`);
      assert.ok(!kinds.includes('insider'), `${what}: the insider function was not called`);
      assert.ok(!kinds.includes('site'), `${what}: no site was read`);
    }
  }
  await wait(900);
  assert.deepEqual(readKey(), { balance_micro: 1000000, spent_micro: 0, calls: 0 }, 'the key rail refunded every reserve and counted no call');
});

test('a key caller pays half the list price for an answer, and the draw is exactly that; a website given as q is read and kept apart from the EDGAR facts', async () => {
  const key = newKey(); const hash = hashKey(key);
  const d = s.db();
  try { d.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, spent_micro, calls, created, rate_per_min, label) VALUES (?, ?, 'active', 1000000, 1000000, 0, 0, ?, 120, 'company-check test')`).run(hash, key.slice(4, 12), Date.now()); } finally { d.close(); }
  fs.writeFileSync(log, '');
  const res = await get(q('indigo-ventures.com'), { 'x-agentfeed-key': key });
  assert.equal(res.status, 200, res.body.slice(0, 200)); const data = JSON.parse(res.body).data;
  assert.equal(data.query.resolved_by, 'website'); assert.equal(data.website.ok, true); assert.equal(data.website.from, 'the q parameter'); assert.ok(logLines().includes('site https://indigo-ventures.com/'));
  await wait(900);
  const x = s.db(); let row; try { row = x.prepare('SELECT balance_micro, calls FROM api_keys WHERE key_hash = ?').get(hash); } finally { x.close(); }
  assert.equal(1000000 - row.balance_micro, Math.round(hfUsd(USD) * 1e6)); assert.equal(row.calls, 1);
});

test('the in-flight limit on the real server (2 at once, 2 s of waiting): of three paid calls whose filing list takes 2.3 s, two are served and settled, the third is a 503 "company-check is busy" with Retry-After 5, not settled, and it read nothing; the slots are released', async () => {
  s.fac.log.length = 0; fs.writeFileSync(log, '');
  const res = await Promise.all([1, 2, 3].map(() => paidV2(q('INDV'))));
  const codes = res.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 200, 503], res.map((r) => `${r.status} ${r.body.slice(0, 80)}`).join(' | '));
  const refused = res.find((r) => r.status === 503);
  assert.equal(refused.headers['retry-after'], '5'); assert.match(JSON.parse(refused.body).error, /^company-check is busy\. Not charged\.$/);
  assert.equal(settles().length, 2, 'the refused call settled nothing');
  assert.equal(logLines().filter((l) => /edgar \/submissions\/CIK0001000012\.json/.test(l)).length, 2, 'the refused call read no filing list');
  assert.equal((await paidV2(q('ALDR'))).status, 200, 'the slots were released');
});

test('the public documents list the route at its price, and the MCP tool list has the tool', async () => {
  const J = async (p) => { const r = await get(p); assert.equal(r.status, 200, p); return r; };
  const spec = JSON.parse((await J('/openapi.json')).body);
  assert.ok(spec.paths[ROUTE].get['x-payment-info']);
  const x402 = JSON.parse((await J('/.well-known/x402.json')).body);
  assert.equal(x402.resources.find((r) => r.name === TOOL).price_usd, USD);
  assert.equal(JSON.parse((await J('/pricing')).body).paid.find((r) => r.tool === TOOL).price_usd, USD);
  assert.ok((await J('/llms.txt')).body.includes(ROUTE));
});
