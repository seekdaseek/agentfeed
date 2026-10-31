// R23 T6, /api/site-signals on the REAL server.js (test/helpers/real-server.js: stub facilitator, every outbound connection refused and logged). The route is the repo's own:
// expansion.js mounts tools/r23/index.js, and the module runs with its REAL dependencies. test/fixtures/r23/sitesignals/preload.cjs mounts and registers NOTHING; it only stubs the
// transports under the module (dns.lookup, tls.connect, https.request for the page and the two registry URLs, dns.promises.Resolver) for the fixture hosts, so any other host still
// reaches the harness's preload, which refuses it. Proved here, and not by the unit tests:
//   - the route is wired by the repo (tools/r23/index.js, expansion.js) and served at its price on every rail;
//   - unpaid GET and HEAD, on the route's spellings and query variants, answer 402 and run no handler, open no connection, write no row;
//   - a paid x402 call is served and settled once at 20000 atomic; a partial answer (TLS down, page up) is served and settled;
//   - a 503 (does not resolve, unreachable) and a 400 (private address, bad URL) are never settled: not on x402 v2, not on x402 v1, not on the prepaid-key rail;
//   - a host that is not a fixture is refused by the harness (a real host, and names that merely look like a fixture), and nothing is ever written to the TLS socket;
//   - R23_SITESIGNALS_RDAP: the tests above run on a server booted with it "on"; a second server without it (the shipped state) serves no `domain` section, makes no registry
//     request at all, and publishes no registration words in its challenge, OpenAPI entry or pricing entry (the ON server's do, as the control).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const path = require('path');
const http = require('http');
const H = require('./helpers/real-server');
const { hfUsd } = require('../lib/hf');
const { newKey, hashKey } = require('../lib/keys');
// the entry as the repo wires it (tools/r23/index.js, listed by expansion.js), not the module's own export
const ENTRY = require('../tools/r23').entries.find((e) => e.name === 'get_site_signals');
const ROUTE = '/api/site-signals';
const ATOMIC = String(Math.round(ENTRY.usd * 1e6));
const PRELOAD = path.join(__dirname, 'fixtures', 'r23', 'sitesignals', 'preload.cjs');
const q = (host, extra = '') => `${ROUTE}?url=${encodeURIComponent(`https://${host}/`)}${extra}`;

let s;
let sOff;
const os = require('os');
const fs = require('fs');
const LOG_ON = path.join(os.tmpdir(), `ss-stub-on-${process.pid}.log`);
const LOG_OFF = path.join(os.tmpdir(), `ss-stub-off-${process.pid}.log`);
let ipN = 0;
const ip = () => { ipN++; return { 'cf-connecting-ip': `198.19.${(ipN >> 8) & 255}.${ipN & 255}` }; };
const send = (m, p, h = {}) => H.raw(s.port, m, p, { ...ip(), ...h });
const paidV2 = async (p) => { const ch = await send('GET', p); assert.equal(ch.status, 402, `challenge for ${p}`); return send('GET', p, { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) }); };
const settles = () => s.fac.log.filter((x) => x.op === 'settle');

before(async () => {
  fs.writeFileSync(LOG_ON, ''); fs.writeFileSync(LOG_OFF, '');
  s = await H.boot({ NODE_OPTIONS: `--require ${PRELOAD}`, R23_SITESIGNALS_RDAP: 'on', SS_STUB_LOG: LOG_ON });        // the state every test below was written against
  sOff = await H.boot({ NODE_OPTIONS: `--require ${PRELOAD}`, SS_STUB_LOG: LOG_OFF });                                  // the shipped state: the variable is not set
});
after(() => { if (s) s.close(); if (sOff) sOff.close(); for (const f of [LOG_ON, LOG_OFF]) fs.rmSync(f, { force: true }); });

const mcpCall = (name, args) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const req = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/mcp', headers: { host: 'x402.ochinimus.app', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body), ...ip() } }, (res) => {
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

const logLines = (f, prefix) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l && (!prefix || l.startsWith(prefix)));
const IANA = 'https://data.iana.org/rdap/dns.json';
const REGISTRY = 'https://rdap.registry.example/com/v1/domain/example.com';

test('control: the repo wires the route (tools/r23/index.js, expansion.js, titles, questions, the Bazaar entry); the preload mounts nothing', async () => {
  assert.ok(ENTRY, 'tools/r23/index.js lists get_site_signals');
  assert.equal(ENTRY.route, 'GET /api/site-signals');
  const { EXP } = require('../expansion');
  assert.ok(EXP.some((t) => t.name === 'get_site_signals' && t.route === ENTRY.route), 'expansion.js pushes it');
  assert.equal(require('../tools/titles').TOOL_TITLES.get_site_signals, ENTRY.title);
  assert.equal(require('../tools/questions').QUESTIONS.get_site_signals, ENTRY.question);
  assert.ok(require('../bazaar-examples.json').routes[ENTRY.route], 'a constructed Bazaar entry exists');
  const pre = fs.readFileSync(PRELOAD, 'utf8');
  assert.doesNotMatch(pre, /\.(EXP|PRICES_ADD|TAGS_ADD|MCP_DEFS_ADD)\b|\bSS\.entries|\.entries\b(?!\()|TOOL_TITLES|\bQUESTIONS\b|app\.get|\bregister\(|'site-signals'\)\)/, 'the preload names nothing it could mount or register with');
  // known positive for that pattern: the old mounting preload would have matched it
  assert.match("exp.EXP.push(entry); exp.PRICES_ADD[e.route] = 1; SS.entries; require(path.join(ROOT, 'tools', 'r23', 'site-signals'))", /\.(EXP|PRICES_ADD|TAGS_ADD|MCP_DEFS_ADD)\b|\bSS\.entries|'site-signals'\)\)/);
  assert.deepEqual(logLines(LOG_ON), [], 'nothing was stubbed-for yet: no request has been made');
});

test('control: the route is on the real server at the entry\'s price, on every rail the service offers, and the server is the real one', async () => {
  assert.equal(ATOMIC, '20000');
  const c = await send('GET', q('ok.example.com'));
  assert.equal(c.status, 402);
  const accepts = H.unb64(c.headers['payment-required']).accepts;
  assert.ok(accepts.length >= 2);
  assert.ok(accepts.every((a) => a.amount === ATOMIC), 'every accept is the route price');
  assert.equal(accepts.find((a) => a.network === H.BASE).amount, ATOMIC);
  const spec = JSON.parse((await send('GET', '/openapi.json')).body);
  assert.ok(spec.paths[ROUTE] && spec.paths[ROUTE].get['x-payment-info'], 'priced in the OpenAPI document');
});

test('unpaid GET and HEAD, on the route\'s spellings and its query variants: never served (a 402 or a refusal), no handler run, no outbound connection, no calls row, nothing settled', async () => {
  const U = encodeURIComponent('https://ok.example.com/');
  const paths = [ROUTE, `${ROUTE}/`, ROUTE.toUpperCase(), ROUTE.replace('/api/', '/API/'), ROUTE.replace('/api/', '/Api/'), `/${ROUTE}`, ROUTE.replace('/api/', '/api//'), ROUTE.replace('/api/', '/api/./'),
    ROUTE.replace('/api/', '/x/../api/'), `${ROUTE};x=1`, `${ROUTE}%20`, ROUTE.replace('site-signals', 'site%2Dsignals'), ROUTE.replace('/api/', '/api%2F'), ROUTE.replace('/api/', '/%61pi/'), `${ROUTE}|eip155:8453`];
  const queries = ['', `?url=${U}`, '?url=', `?URL=${U}`, `?url=${U}&url=${U}`, `?%75rl=${U}`, `?url=${U}#f`, `?url=http://127.0.0.1/`, `?url=${encodeURIComponent('https://gone.example.com/')}`];
  const served = [];
  let n = 0;
  for (const p of paths) for (const qs of queries) for (const m of ['GET', 'HEAD']) {
    n++;
    const res = await send(m, p + qs);
    if (res.status >= 200 && res.status < 400) served.push(`${m} ${p}${qs} -> ${res.status}`);
  }
  for (const m of ['GET', 'HEAD']) for (const p of [ROUTE, `${ROUTE}/`, ROUTE.toUpperCase(), ROUTE.replace('/api/', '/API/')]) for (const qs of queries) {
    const res = await send(m, p + qs);
    assert.equal(res.status, 402, `${m} ${p}${qs}`);
  }
  assert.equal(n, paths.length * queries.length * 2);
  assert.deepEqual(served, []);
  assert.deepEqual(s.handlerRuns(), [], 'no handler ran without payment');
  assert.deepEqual(s.netAttempts(), [], 'no outbound connection (not even a name lookup) without payment');
  assert.deepEqual(settles(), []);
  const rows = (await H.rowsSince(s, 0)).filter((x) => x.tool === ENTRY.name);
  assert.deepEqual(rows, [], 'no calls row for the tool: nothing was served');
});

test('the MCP tool is listed and goes through the x402 gate: unpaid it answers payment required and runs no handler', async () => {
  const list = await mcpList();
  const t = (list.result.tools || []).find((x) => x.name === ENTRY.name);
  assert.ok(t, 'get_site_signals is in tools/list');
  assert.ok(t.inputSchema && t.inputSchema.properties && t.inputSchema.properties.url, 'the url parameter is in its schema');
  const before = s.handlerRuns().length;
  const out = await mcpCall(ENTRY.name, { url: 'https://ok.example.com/' });
  assert.ok(out.json && out.json.result, out.raw.slice(0, 200));
  assert.match(JSON.stringify(out.json), /payment|x402|402/i);
  assert.ok(!/"tls"|"headers"/.test(JSON.stringify(out.json)), 'no site data without payment');
  assert.equal(s.handlerRuns().length, before);
  assert.deepEqual(settles(), []);
});

test('paid x402 v2: a healthy site is served once, settled once at the route price, the envelope is {tool, data, paid}, and the calls row is a paid row', async () => {
  s.fac.log.length = 0;
  const before = s.handlerRuns().length;
  const res = await paidV2(q('ok.example.com'));
  assert.equal(res.status, 200, res.body.slice(0, 300));
  const j = JSON.parse(res.body);
  assert.equal(j.tool, ENTRY.name);
  assert.equal(j.paid, true);
  for (const k of ['url', 'host', 'page', 'tls', 'domain', 'dns', 'headers', 'stack', 'links', 'fetched_at', 'method']) assert.ok(k in j.data, k);
  assert.equal(j.data.host, 'ok.example.com');
  assert.equal(j.data.tls.ok, true);
  assert.equal(j.data.headers.rubric, 'headers-v1');
  assert.equal(s.handlerRuns().length, before + 1);
  assert.equal(settles().length, 1);
  assert.equal(settles()[0].amount, ATOMIC);
  const rows = (await H.rowsSince(s, 0)).filter((x) => x.tool === ENTRY.name);
  assert.deepEqual(rows.map((r) => r.status), ['paid']);
  assert.equal(rows[0].amount_usdc, ENTRY.usd);
});

test('a partial answer (the TLS handshake failed, the page was read) is served and settled; its tls section says why', async () => {
  s.fac.log.length = 0;
  const res = await paidV2(q('nocert.example.com'));
  assert.equal(res.status, 200, res.body.slice(0, 300));
  const d = JSON.parse(res.body).data;
  assert.equal(d.tls.ok, false);
  assert.match(d.tls.reason, /ECONNRESET/);
  assert.equal(d.page.ok, true);
  assert.equal(settles().length, 1);
});

// every case in which the caller must not pay: [host, expected status, what the body names]
const NOT_CHARGED = [
  ['gone.example.com', 503, /does not resolve.*Not charged\.$/],
  ['down.example.com', 503, /could not reach down\.example\.com.*Not charged\.$/],
  ['private.example.com', 400, /private or reserved/],
];
const urlFor = (host) => q(host);

test('never settled, on any rail: a name that does not resolve, an unreachable site, a private address, a bad URL (x402 v2 and v1)', async () => {
  const cases = [...NOT_CHARGED.map(([h, st, re]) => [urlFor(h), st, re]),
    [`${ROUTE}?url=${encodeURIComponent('http://ok.example.com/')}`, 400, /https/], [`${ROUTE}?url=${encodeURIComponent('https://127.0.0.1/')}`, 400, /./], [`${ROUTE}?url=${encodeURIComponent('https://u:p@ok.example.com/')}`, 400, /credentials/],
    [`${ROUTE}?url=${encodeURIComponent('https://ok.example.com:8443/')}`, 400, /port/]];
  for (const [p, status, re] of cases) {
    const ch = await send('GET', p);
    assert.equal(ch.status, 402, `${p}: the quote is served first`);
    s.fac.log.length = 0;
    const v2 = await send('GET', p, { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) });
    assert.equal(v2.status, status, `${p} v2: ${v2.body.slice(0, 200)}`);
    assert.match(JSON.parse(v2.body).error, re, p);
    if (status === 503) { assert.ok(Number(v2.headers['retry-after']) > 0, 'Retry-After'); assert.match(JSON.parse(v2.body).error, /Not charged\.$/); }
    assert.deepEqual(settles(), [], `${p} v2: never settled`);
    s.fac.log.length = 0;
    const v1 = await send('GET', p, { 'x-payment': H.b64(H.payV1({}, ATOMIC)) });
    assert.equal(v1.status, status, `${p} v1: ${v1.body.slice(0, 200)}`);
    assert.deepEqual(settles(), [], `${p} v1: never settled`);
  }
  const rows = await H.rowsSince(s, 0);
  const mine = rows.filter((x) => x.tool === ENTRY.name);
  assert.ok(mine.filter((r) => r.status === 'paid').length === 2, 'only the two successful calls above (healthy, partial) are paid rows; no refused call is');
});

test('a missing url is a 400 that settles nothing (the query-less URL itself stays the 402 that catalogues read)', async () => {
  const p = ROUTE;
  assert.equal((await send('GET', p)).status, 402);
  const ch = await send('GET', p);
  s.fac.log.length = 0;
  const res = await send('GET', p, { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) });
  assert.equal(res.status, 400, res.body.slice(0, 200));
  assert.match(JSON.parse(res.body).error, /missing required parameter: url/);
  assert.deepEqual(settles(), []);
});

test('key rail: a key caller pays half the price (minimum $0.0005) for a served call, and nothing for a 503 or a 400 (the reserve is refunded in full)', async () => {
  const key = newKey(); const hash = hashKey(key);
  const d = s.db();
  try { d.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, spent_micro, calls, created, rate_per_min, label) VALUES (?, ?, 'active', 1000000, 1000000, 0, 0, ?, 120, 'site-signals test')`).run(hash, key.slice(4, 12), Date.now()); } finally { d.close(); }
  const read = () => { const x = s.db(); try { return x.prepare('SELECT balance_micro, spent_micro, calls FROM api_keys WHERE key_hash = ?').get(hash); } finally { x.close(); } };
  const settledState = async () => { let a = read(); for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 150)); const b = read(); if (JSON.stringify(a) === JSON.stringify(b)) return b; a = b; } return a; };
  const prev = await settledState();
  const ok = await send('GET', q('ok.example.com'), { 'x-agentfeed-key': key });
  assert.equal(ok.status, 200, ok.body.slice(0, 200));
  const after1 = await settledState();
  assert.equal(prev.balance_micro - after1.balance_micro, Math.max(Math.round(hfUsd(ENTRY.usd) * 1e6), 500), 'half the list price');
  assert.equal(after1.calls, prev.calls + 1);
  for (const [p, status] of [[q('gone.example.com'), 503], [q('down.example.com'), 503], [q('private.example.com'), 400], [`${ROUTE}?url=${encodeURIComponent('http://ok.example.com/')}`, 400]]) {
    const res = await send('GET', p, { 'x-agentfeed-key': key });
    assert.equal(res.status, status, p);
    await new Promise((r) => setTimeout(r, 600));
  }
  assert.deepEqual(read(), after1, 'the key rail refunded every reserve and counted no further call');
});

test('the real path with nothing injected, under a refused network: a host the preload does not fake answers 503 Not charged after trying only to resolve its name; nothing is settled and no connection is opened', async () => {
  const lookups = s.netAttempts().length;
  const ch = await send('GET', q('real.example.com'));
  s.fac.log.length = 0;
  const res = await send('GET', q('real.example.com'), { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) });
  assert.equal(res.status, 503, res.body.slice(0, 300));
  assert.match(JSON.parse(res.body).error, /real\.example\.com could not be resolved.*Not charged\.$/);
  assert.deepEqual(settles(), []);
  const attempts = s.netAttempts().slice(lookups);
  assert.deepEqual([...new Set(attempts)], ['real.example.com'], 'the only thing tried was the name lookup');
});

// ======================================================================================================== the switch, over the real server
const BANNED_OFF = /\b(rdap|whois|registrar|registrant|registration|registered|expiry|domain[ _-]age|days_to_expiry)\b/i;
const sendTo = (srv, m, p, h = {}) => H.raw(srv.port, m, p, { ...ip(), ...h });
const paidOn = async (srv, p) => { const ch = await sendTo(srv, 'GET', p); assert.equal(ch.status, 402); return sendTo(srv, 'GET', p, { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) }); };

test('switch off (the shipped state): a paid call is served and settled at the same price with NO domain section and NO registry request of any kind; switched on, the same call has the section and the server made exactly the two registry requests (control)', async () => {
  const off = await paidOn(sOff, q('ok.example.com'));
  assert.equal(off.status, 200, off.body.slice(0, 300));
  const d = JSON.parse(off.body).data;
  assert.equal('domain' in d, false);
  for (const k of ['url', 'host', 'page', 'tls', 'dns', 'headers', 'stack', 'links', 'fetched_at', 'method']) assert.ok(k in d, k);
  assert.equal(d.tls.ok && d.dns.ok && d.headers.ok, true);
  assert.deepEqual(sOff.fac.log.filter((x) => x.op === 'settle').map((x) => x.amount), [ATOMIC]);
  assert.deepEqual(logLines(LOG_OFF, 'RDAP '), [], 'no request to IANA or a registry');
  assert.ok(logLines(LOG_OFF, 'PAGE ').length >= 1 && logLines(LOG_OFF, 'TLS ').length >= 1 && logLines(LOG_OFF, 'DNS ').length >= 1, 'control: the page, TLS and DNS transports did run on this server');
  assert.deepEqual(sOff.netAttempts(), [], 'and no outbound connection of any kind was tried');
  const on = await paidOn(s, q('ok.example.com'));
  assert.equal(on.status, 200);
  assert.equal(JSON.parse(on.body).data.domain.ok, true);
  assert.deepEqual([...new Set(logLines(LOG_ON, 'RDAP '))].sort(), [`RDAP ${IANA}`, `RDAP ${REGISTRY}`].sort(), 'with the switch on the same call reached the registry transport (the bootstrap and the domain record; later calls come from the cache)');
});

test('switch off: the 402 challenge, the OpenAPI entry, /pricing, llms.txt and SKILL.md lines of the route carry no registration words; on the switched-on server they do (control)', async () => {
  const slices = async (srv) => {
    const ch = await sendTo(srv, 'GET', q('ok.example.com'));
    const challenge = JSON.stringify(H.unb64(ch.headers['payment-required']));
    const spec = JSON.parse((await sendTo(srv, 'GET', '/openapi.json')).body);
    const pricing = JSON.parse((await sendTo(srv, 'GET', '/pricing')).body);
    const row = (pricing.paid || []).find((x) => x.tool === ENTRY.name);
    assert.ok(row, 'the route is in /pricing');
    const docLines = async (doc) => (await sendTo(srv, 'GET', doc)).body.split('\n').filter((l) => l.includes(ROUTE)).join('\n');
    return { challenge, openapi: JSON.stringify(spec.paths[ROUTE]), pricing: JSON.stringify(row), llms: await docLines('/llms.txt'), skill: await docLines('/SKILL.md') };
  };
  const off = await slices(sOff);
  const on = await slices(s);
  for (const [k, v] of Object.entries(off)) assert.doesNotMatch(v, BANNED_OFF, `off ${k}`);
  for (const k of ['challenge', 'openapi', 'llms', 'skill']) assert.ok(off[k].length > 0, `off ${k} has the route`);
  for (const k of ['challenge', 'openapi']) assert.match(on[k], BANNED_OFF, `on ${k} (control: the pattern sees the words that the switch adds; llms.txt, SKILL.md and /pricing list the route by name and price only)`);
  assert.ok(on.pricing.includes(ENTRY.name), '/pricing carries the name and price only');
});

// ======================================================================================================== the stubs reach fixture hosts only
test('a host that is not a fixture is refused by the harness, on a server with the stubs installed: a real host and names that merely look like a fixture answer 503 Not charged after trying only to resolve the name, nothing is settled', async () => {
  const hosts = ['www.python.org', 'okx.example.com', 'ok2.example.com', 'www.ok.example.com', 'example.com', 'ok.example.org'];
  const before = s.netAttempts().length;
  const stubBefore = logLines(LOG_ON).length;
  for (const h of hosts) {
    const ch = await send('GET', q(h));
    s.fac.log.length = 0;
    const res = await send('GET', q(h), { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) });
    assert.equal(res.status, 503, `${h}: ${res.body.slice(0, 200)}`);
    assert.match(JSON.parse(res.body).error, new RegExp(`${h.replace(/\./g, '\\.')} could not be resolved.*Not charged\\.$`));
    assert.deepEqual(settles(), [], h);
  }
  assert.deepEqual([...new Set(s.netAttempts().slice(before))].sort(), [...hosts].sort(), 'the harness saw (and refused) each of them, and nothing else');
  assert.deepEqual(logLines(LOG_ON).slice(stubBefore), [], 'and no stub answered for any of them: no lookup, handshake, page or registry line');
});

test('nothing is ever written to the TLS socket on the real server (the stub logs any write), and every transport the module needs ran for the fixture hosts only', async () => {
  for (const f of [LOG_ON, LOG_OFF]) {
    assert.deepEqual(logLines(f, 'TLSWRITE'), [], 'no write');
    assert.ok(logLines(f, 'TLS ').length >= 1, 'control: the TLS stub was used, so "no write" is an observation');
    const touched = new Set(logLines(f).filter((l) => /^(LOOKUP|TLS|PAGE) /.test(l)).map((l) => (l.split(' ')[1].startsWith('http') ? new URL(l.split(' ')[1]).hostname : l.split(' ')[1])));
    for (const h of touched) assert.ok(['ok.example.com', 'nocert.example.com', 'down.example.com', 'private.example.com', 'gone.example.com'].includes(h), `${h} is a fixture host`);
  }
  assert.equal(new Set(logLines(LOG_ON, 'DNS ').map((l) => l.split(' ')[2])).has('example.com'), true, 'the record queries ran against the registered domain');
});

test('the preload\'s stubs dispatch on the exact fixture host for every transport: dns.lookup, tls.connect, https.request and the Resolver delegate (or refuse) a real host and a look-alike, and answer only ok.example.com', () => {
  const { spawnSync } = require('child_process');
  const netLog = path.join(os.tmpdir(), `ss-dispatch-net-${process.pid}.log`);
  const code = `
    const dns = require('dns'), tls = require('tls'), https = require('https'), { EventEmitter } = require('events');
    const seen = [];
    dns.lookup = function (h) { seen.push('lookup ' + h); };
    tls.connect = function (o) { seen.push('tls ' + o.host); return new EventEmitter(); };
    https.request = function (u) { seen.push('https ' + (u.hostname || u)); return new EventEmitter(); };
    setImmediate(() => setImmediate(async () => {
      const hosts = ['www.python.org', 'ok.example.com', 'okx.example.com', 'OK.EXAMPLE.COM.evil.org'];
      for (const h of hosts) { dns.lookup(h, { all: true }, () => {}); tls.connect({ host: h, port: 443 }, () => {}); https.request(new URL('https://' + h + '/'), {}, () => {}); }
      const r = new dns.promises.Resolver(); const out = {};
      for (const h of hosts) { try { out[h] = (await r.resolve4(h)).length + ' answers'; } catch (e) { out[h] = e.code; } }
      console.log(JSON.stringify({ seen, out }));
      process.exit(0);
    }));`;
  const r = spawnSync(process.execPath, ['--require', PRELOAD, '-e', code], { encoding: 'utf8', env: { PATH: process.env.PATH, AF_ROOT: path.resolve(__dirname, '..'), AF_NET_LOG: netLog, SS_STUB_LOG: '' }, timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim().split('\n').pop());
  const seen = parsed.seen.map((x) => x.toLowerCase());
  const out = parsed.out;
  for (const h of ['www.python.org', 'okx.example.com', 'ok.example.com.evil.org']) for (const kind of ['lookup', 'tls', 'https']) assert.ok(seen.includes(`${kind} ${h}`), `${kind} ${h} went on to the real (harness) function`);
  for (const kind of ['lookup', 'tls', 'https']) assert.ok(!seen.includes(`${kind} ok.example.com`), `${kind} ok.example.com was answered by the stub, not passed on`);
  assert.deepEqual(out, { 'www.python.org': 'ECONNREFUSED', 'ok.example.com': '2 answers', 'okx.example.com': 'ECONNREFUSED', 'OK.EXAMPLE.COM.evil.org': 'ECONNREFUSED' });
  const refused = fs.readFileSync(netLog, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual([...new Set(refused)].sort(), ['ok.example.com.evil.org', 'okx.example.com', 'www.python.org'], 'the Resolver stub logged each refused name, lower-cased, like the harness does');
  fs.rmSync(netLog, { force: true });
});
