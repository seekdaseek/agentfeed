// get_pkg_check on the REAL server.js (test/helpers/real-server.js: stub facilitator, every outbound connection refused and logged, scratch databases).
// The route is the repo's own (expansion.js -> tools/r24/index.js -> tools/r23/pkg-check.js); this test registers nothing. test/fixtures/r23/pkgcheck/server-preload.cjs only puts the fake
// upstream of world.js behind a stubbed https.request for the five hosts the tool calls (registry.npmjs.org, api.npmjs.org, pypi.org, pypistats.org, api.osv.dev); every other host is still
// refused by the harness. What is proved here and not by the unit tests:
//   - the route is mounted by the repo (a server with no preload answers the 402 challenge), and the real hosts stay refused without the stub
//   - unpaid GET and HEAD, on 24 spellings of the path and on query variants, answer 402 (or are refused) and never the tool's answer: no handler run, no upstream call, no row, no settlement
//   - the MCP tool goes through the x402 gate
//   - a paid x402 call is served and settled once at 20000 atomic units (USD 0.02); a key caller pays half
//   - 404 (unknown package), 503 (registry down, OSV down) and 400 (bad name) settle nothing on x402 v2, on x402 v1 and on the prepaid-key rail, and the key rail refunds in full
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const H = require('./helpers/real-server');
const { PRICES } = require('../payments');
const { hfUsd } = require('../lib/hf');
const { newKey, hashKey } = require('../lib/keys');

const QUERY = '/api/pkg-check?name=example-widget-kit&ecosystem=npm';
const PRELOAD = path.join(__dirname, 'fixtures', 'r23', 'pkgcheck', 'server-preload.cjs');
const HARNESS = path.join(__dirname, 'helpers', 'af-test-preload.js');
let s, logDir, pkgLog;
let ipN = 0;
const ip = () => { ipN++; return { 'cf-connecting-ip': `198.19.${(ipN >> 8) & 255}.${ipN & 255}` }; };
const get = (srv, p, h = {}) => H.raw(srv.port, 'GET', p, { ...ip(), ...h });
const send = (srv, m, p, h = {}) => H.raw(srv.port, m, p, { ...ip(), ...h });
const upstream = () => { try { return fs.readFileSync(pkgLog, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const q = (name, extra = '') => `/api/pkg-check?name=${encodeURIComponent(name)}&ecosystem=npm${extra}`;
const pay = async (srv, p) => { const ch = await get(srv, p); assert.equal(ch.status, 402, `challenge for ${p}`); return get(srv, p, { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) }); };
const settles = (srv) => srv.fac.log.filter((x) => x.op === 'settle');

before(async () => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgcheck-rs-'));
  pkgLog = path.join(logDir, 'upstream.log');
  s = await H.boot({ NODE_OPTIONS: `--require ${PRELOAD}`, AF_PKG_LOG: pkgLog });
});
after(() => { if (s) s.close(); fs.rmSync(logDir, { recursive: true, force: true }); });

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

test('control: the route is the repo\'s own (the preload mounts and registers nothing), priced at USD 0.02, and an unpaid call is the 402 challenge for 20000 atomic units', async () => {
  // the preload source touches none of the places a route is registered in (shown first to find them in a sample that does)
  const registering = /\b(EXP\.push|PRICES_ADD|TAGS_ADD|MCP_DEFS_ADD|TOOL_TITLES|QUESTIONS)\b|require\([^)]*expansion/;
  const code = (text) => text.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');                // comments may name what the file does not do
  assert.ok(registering.test(code("// a comment\nexpansion.EXP.push(e); expansion.PRICES_ADD[e.route] = {}")), 'the scan finds a registering sample');
  assert.ok(!registering.test(code("// expansion.EXP.push(e) in a comment\nconst x = 1;")), 'and ignores a comment');
  assert.ok(!registering.test(code(fs.readFileSync(PRELOAD, 'utf8'))), 'the preload registers nothing');
  // a server with NO preload still has the route: it answers the paywall challenge (the entry comes from expansion.js)
  const bare = await H.boot({});
  try {
    const c0 = await H.raw(bare.port, 'GET', QUERY, ip());
    assert.equal(c0.status, 402, c0.body.slice(0, 200));
    assert.equal(H.unb64(c0.headers['payment-required']).accepts.find((a) => a.network === H.BASE).amount, '20000');
  } finally { bare.close(); }
  const c = await get(s, QUERY);
  assert.equal(c.status, 402, c.body.slice(0, 200));
  assert.ok(c.headers['payment-required']);
  assert.equal(H.unb64(c.headers['payment-required']).accepts.find((a) => a.network === H.BASE).amount, '20000');
  const spec = JSON.parse((await get(s, '/openapi.json')).body);
  assert.ok(spec.paths['/api/pkg-check'] && spec.paths['/api/pkg-check'].get['x-payment-info'], 'priced path in openapi.json');
  assert.ok(JSON.parse((await get(s, '/.well-known/x402.json')).body).resources.some((r) => r.name === 'get_pkg_check' && r.price_usd === 0.02));
  assert.ok(JSON.parse((await get(s, '/pricing')).body).paid.some((r) => r.tool === 'get_pkg_check'));
  assert.equal(PRICES['GET /api/pkg-check'].usd, 0.02); assert.equal(PRICES['GET /api/pkg-check'].tool, 'get_pkg_check');
});

test('real hosts stay refused: without the stub a paid call is a 503 "Not charged" that settles nothing and the registry host is in the harness\'s refused-connection log; the stub answers only its five hosts', async () => {
  const bare = await H.boot({});
  try {
    const ch = await H.raw(bare.port, 'GET', QUERY, ip());
    assert.equal(ch.status, 402);
    bare.fac.log.length = 0;
    const res = await H.raw(bare.port, 'GET', QUERY, { ...ip(), 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) });
    assert.equal(res.status, 503, res.body.slice(0, 300));
    assert.match(JSON.parse(res.body).error, /Not charged\.$/);
    assert.deepEqual(bare.fac.log.filter((x) => x.op === 'settle'), [], 'a refused upstream settles nothing');
    assert.ok(bare.netAttempts().some((h) => /registry\.npmjs\.org|api\.osv\.dev|pypi\.org/.test(h)), `the refused hosts are logged: ${bare.netAttempts().join(',')}`);
  } finally { bare.close(); }
  // with the preload chain in a bare process: a stubbed host answers from the fake world and makes no connection; any other host is refused and logged
  const netLog = path.join(logDir, 'probe-net.log'); const pLog = path.join(logDir, 'probe-pkg.log');
  const code = `const https = require('https');
    const get = (u) => new Promise((resolve) => { const r = https.request(new URL(u), { method: 'GET' }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 40) })); }); r.on('error', (e) => resolve({ error: e.message })); r.end(); });
    (async () => { console.log(JSON.stringify({ stubbed: await get('https://registry.npmjs.org/example-widget-kit'), other: await get('https://example.com/'), lookalike: await get('https://registry.npmjs.org.evil.test/x'), npmOther: await get('https://www.npmjs.com/package/x') })); })();`;
  const r = spawnSync(process.execPath, ['--require', HARNESS, '--require', PRELOAD, '-e', code], { env: { PATH: process.env.PATH, AF_ROOT: path.join(__dirname, '..'), AF_NET_LOG: netLog, AF_PKG_LOG: pLog }, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.stubbed.status, 200); assert.match(out.stubbed.body, /example-widget-kit/);
  for (const k of ['other', 'lookalike', 'npmOther']) assert.match(out[k].error || '', /refused/, `${k} must be refused: ${JSON.stringify(out[k])}`);
  const refused = fs.readFileSync(netLog, 'utf8').split('\n').filter(Boolean);
  assert.ok(refused.includes('example.com') && refused.includes('registry.npmjs.org.evil.test') && refused.includes('www.npmjs.com'), refused.join(','));
  assert.ok(!refused.includes('registry.npmjs.org'), 'the stubbed host made no connection attempt');
  assert.deepEqual(fs.readFileSync(pLog, 'utf8').split('\n').filter(Boolean), ['GET https://registry.npmjs.org/example-widget-kit']);
});

test('unpaid GET and HEAD on the route, on 24 spellings of its path and on query variants: never served, no handler run, no upstream call, no row, no settlement', async () => {
  const p = '/api/pkg-check';
  const variants = [p, p + '/', p + '//', p.toUpperCase(), p.replace('/api/', '/API/'), p.replace('/api/', '/Api/'), '/' + p, p.replace('/api/', '/api//'), '/api/pkg%2Dcheck', '/api/%70kg-check', p.replace('/api/', '/api%2F'),
    p.replace('/api/', '/x/../api/'), p.replace('/api/', '/api/./'), '/api/sample/../pkg-check', p + ';x=1', p + '%20', p + '\\', p + '?', p + '#x', p + '%3F', p + '/.', p.replace('/api/', '/%61pi/'), p + '|eip155:8453/', p + '%7Ceip155:1'];
  assert.equal(variants.length, 24);
  const queries = ['?name=example-widget-kit&ecosystem=npm', '?NAME=example-widget-kit&ECOSYSTEM=npm', '?name=a&name=b&ecosystem=npm', '?name[]=x&ecosystem=npm', '?name=..%2F..%2Fetc%2Fpasswd&ecosystem=npm', '?name=example-widget-kit&ecosystem=pypi&version=1.0.0', '?name=%00&ecosystem=npm', '?ecosystem=npm&name=example-widget-kit&name=example-widget-kit'];
  const all = [...variants, ...queries.map((x) => p + x), ...queries.map((x) => p + '/' + x)];
  const bad = [];
  let n = 0;
  for (const v of all) for (const m of ['GET', 'HEAD']) {
    n++;
    const res = await send(s, m, v);
    if (res.status >= 200 && res.status < 400) bad.push(`${m} ${v} -> ${res.status}`);
    if ([0, 1, 3, 4].includes(variants.indexOf(v)) && res.status !== 402) bad.push(`${m} ${v} -> ${res.status} (the plain, trailing-slash, upper-case and /API/ spellings are the 402 challenge)`);
    if (v.startsWith(p + '?') && !v.includes('%00') && res.status !== 402) bad.push(`${m} ${v} -> ${res.status} (a query variant on the canonical path is the 402 challenge)`);
  }
  assert.equal(n, (24 + 2 * queries.length) * 2);
  assert.deepEqual(bad, []);
  assert.deepEqual(s.handlerRuns().filter((x) => x === 'get_pkg_check'), [], 'no handler ran without payment');
  assert.deepEqual(upstream(), [], 'no registry, OSV or downloads call without payment');
  assert.deepEqual(s.netAttempts(), [], 'no outbound connection without payment');
  const rows = (await H.rowsSince(s, 0)).filter((x) => x.tool === 'get_pkg_check');
  assert.deepEqual(rows, [], 'no calls row for the tool: nothing was served');
  assert.deepEqual(settles(s), [], 'and nothing settled');
});

test('the MCP tool is listed and goes through the x402 gate: unpaid it answers with a payment-required result, runs no handler and asks the facilitator nothing', async () => {
  const list = await mcpList();
  const t = (list.result.tools || []).find((x) => x.name === 'get_pkg_check');
  assert.ok(t, 'get_pkg_check is in tools/list');
  assert.ok(t.description.startsWith('Use when an agent needs')); assert.ok(t.inputSchema && t.inputSchema.properties && t.inputSchema.properties.ecosystem);
  const before = s.handlerRuns().length;
  s.fac.log.length = 0;
  const out = await mcpCall(s, 'get_pkg_check', { name: 'example-widget-kit', ecosystem: 'npm' });
  const text = JSON.stringify(out.json);
  assert.ok(out.json && out.json.result, out.raw.slice(0, 200));
  assert.match(text, /payment|x402|402/i);
  assert.ok(!/GHSA-aaaa|"advisories"|"flagged"|"highest_severity"/.test(text), 'no package content without payment');
  assert.equal(s.handlerRuns().length, before); assert.deepEqual(s.fac.log.filter((x) => x.op === 'settle'), []); assert.deepEqual(upstream(), []);
});

test('paid x402 v2: the tool is served once, settled once at 20000 atomic units, and the answer is the full data object (real fetch code over the fake upstream)', async () => {
  s.fac.log.length = 0;
  const before = s.handlerRuns().length;
  const res = await pay(s, QUERY);
  assert.equal(res.status, 200, res.body.slice(0, 300));
  const j = JSON.parse(res.body);
  assert.equal(j.tool, 'get_pkg_check'); assert.equal(j.paid, true);
  assert.equal(j.data.name, 'example-widget-kit'); assert.equal(j.data.version, '2.0.0'); assert.equal(j.data.advisories[0].id, 'GHSA-aaaa-bbbb-cccc');
  assert.equal(j.data.flagged, true); assert.equal(j.data.highest_severity, 'high');      // R24 rule: the paid answer carries the verdict fields
  for (const k of ['flagged', 'highest_severity', 'advisory_summary', 'advisories', 'malicious', 'release', 'maintainers', 'install_scripts', 'downloads', 'typosquat', 'repository', 'flags', 'sources', 'method']) assert.ok(k in j.data, k);
  assert.equal(s.handlerRuns().length, before + 1);
  const st = settles(s);
  assert.equal(st.length, 1, 'settled once'); assert.equal(st[0].amount, '20000', 'at the price in PRICES');
  assert.deepEqual(upstream().sort(), ['GET https://api.npmjs.org/downloads/point/last-week/example-widget-kit', 'GET https://registry.npmjs.org/example-widget-kit', 'POST https://api.osv.dev/v1/query example-widget-kit@2.0.0']);
  assert.deepEqual(s.netAttempts(), [], 'the fake upstream made no real connection');
  const rows = (await H.rowsSince(s, 0)).filter((x) => x.tool === 'get_pkg_check');
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'paid');
});

test('a paid PyPI call is served and settled once; its install scripts are not inspected and its owners are a count', async () => {
  fs.writeFileSync(pkgLog, '');
  s.fac.log.length = 0;
  const res = await pay(s, '/api/pkg-check?name=Example_PyLib&ecosystem=pypi');
  assert.equal(res.status, 200, res.body.slice(0, 300));
  const j = JSON.parse(res.body);
  assert.equal(j.data.name, 'example-pylib'); assert.equal(j.data.install_scripts, null); assert.equal(j.data.maintainers.count, 2); assert.equal(j.data.release.distributions.sdist, true);
  assert.equal(settles(s).length, 1); assert.equal(settles(s)[0].amount, '20000');
  assert.ok(upstream().includes('GET https://pypi.org/pypi/example-pylib/json') && upstream().includes('POST https://api.osv.dev/v1/query example-pylib@1.2.0'));
});

test('404, 503 and 400 are never settled or billed: x402 v2, x402 v1 and the prepaid-key rail (the key rail refunds every reserve)', async () => {
  const cases = [
    ['unknown package (404)', q('example-nosuch'), 404, /not covered, not charged\.$/, false],
    ['unknown version (404)', q('example-widget-kit', '&version=9.9.9'), 404, /not covered, not charged\.$/, false],
    ['registry down (503)', q('example-down'), 503, /Not charged\.$/, true],
    ['OSV down (503)', q('example-osvdown'), 503, /Not charged\.$/, true],
    ['bad name (400)', q('../../etc/passwd'), 400, /not a valid npm package name/, false],
    ['bad ecosystem (400)', '/api/pkg-check?name=lodash&ecosystem=cargo', 400, /ecosystem must be npm or pypi/, false],
  ];
  const paidRows = async () => (await H.rowsSince(s, 0)).filter((x) => x.tool === 'get_pkg_check' && x.status === 'paid').length;
  const paidBefore = await paidRows();
  const key = newKey(); const hash = hashKey(key);
  const d = s.db();
  try { d.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, spent_micro, calls, created, rate_per_min, label) VALUES (?, ?, 'active', 1000000, 1000000, 0, 0, ?, 120, 'pkgcheck test')`).run(hash, key.slice(4, 12), Date.now()); } finally { d.close(); }
  const readKey = () => { const x = s.db(); try { return x.prepare('SELECT balance_micro, spent_micro, calls FROM api_keys WHERE key_hash = ?').get(hash); } finally { x.close(); } };
  for (const [what, p, status, msg, retry] of cases) {
    fs.writeFileSync(pkgLog, '');
    // unpaid: the challenge does not depend on the answer
    const ch = await get(s, p);
    assert.equal(ch.status, 402, `${what}: the quote is still served`);
    // x402 v2
    s.fac.log.length = 0;
    const v2 = await get(s, p, { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) });
    assert.equal(v2.status, status, `${what} v2: ${v2.body.slice(0, 200)}`);
    assert.match(JSON.parse(v2.body).error, msg);
    if (retry) assert.ok(Number(v2.headers['retry-after']) > 0, `${what}: Retry-After`);
    assert.deepEqual(s.fac.log.filter((x) => x.op === 'settle'), [], `${what} v2: never settled`);
    // x402 v1
    s.fac.log.length = 0;
    const v1 = await get(s, p, { 'x-payment': H.b64(H.payV1({}, '20000')) });
    assert.equal(v1.status, status, `${what} v1: ${v1.body.slice(0, 200)}`);
    assert.deepEqual(s.fac.log.filter((x) => x.op === 'settle'), [], `${what} v1: never settled`);
    // key rail
    const before = readKey();
    const kr = await get(s, p, { 'x-agentfeed-key': key });
    assert.equal(kr.status, status, `${what} key rail`);
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(readKey(), before, `${what}: the key rail refunded the reserve and counted no call`);
    if (status === 400) assert.deepEqual(upstream(), [], `${what}: a bad request makes no upstream call`);
    if (what === 'unknown package (404)') assert.ok(!upstream().some((l) => l.startsWith('POST')), 'OSV is not asked about a package the registry does not know');
  }
  assert.equal(await paidRows(), paidBefore, 'no 404, 503 or 400 wrote a paid row');
});

test('a key caller pays half the price on success (USD 0.01) and the answer is the same data', async () => {
  const key = newKey(); const hash = hashKey(key);
  const d = s.db();
  try { d.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, spent_micro, calls, created, rate_per_min, label) VALUES (?, ?, 'active', 1000000, 1000000, 0, 0, ?, 120, 'pkgcheck test')`).run(hash, key.slice(4, 12), Date.now()); } finally { d.close(); }
  const read = () => { const x = s.db(); try { return x.prepare('SELECT balance_micro, spent_micro, calls FROM api_keys WHERE key_hash = ?').get(hash); } finally { x.close(); } };
  const res = await get(s, QUERY, { 'x-agentfeed-key': key });
  assert.equal(res.status, 200, res.body.slice(0, 200));
  assert.equal(JSON.parse(res.body).data.advisories[0].id, 'GHSA-aaaa-bbbb-cccc');
  await new Promise((r) => setTimeout(r, 1200));
  const row = read();
  assert.equal(1000000 - row.balance_micro, Math.max(Math.round(hfUsd(0.02) * 1e6), 500)); assert.equal(row.calls, 1);
});

test('negative control: with the paywall off (X402_MODE=off) the same unpaid GET IS served, so the 402 sweep above detects a route that is not behind the paywall', async () => {
  const free = await H.boot({ NODE_OPTIONS: `--require ${PRELOAD}`, AF_PKG_LOG: pkgLog, X402_MODE: 'off' });
  try {
    const res = await H.raw(free.port, 'GET', QUERY, ip());
    assert.equal(res.status, 200, res.body.slice(0, 200));
    assert.equal(JSON.parse(res.body).data.advisories[0].id, 'GHSA-aaaa-bbbb-cccc');
    assert.equal(JSON.parse(res.body).paid, false);
    assert.ok(upstream().length > 0, 'and the fake upstream was called');
  } finally { free.close(); }
});
