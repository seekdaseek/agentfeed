// R15b (19 Oct 2026): the discovery paths crawlers asked for and got a 404 on, and the related field on the three free routes.
// Real HTTP, the real lib/discovery-aliases.js and the real rate limiter in front of it; the documents behind the aliases are stand-ins
// (server.js builds the real ones once). The paths that must STAY 404 are checked against the real server in ops/ output, not here: a
// stand-in app 404s everything it does not mount, which proves nothing.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const A = require('../lib/discovery-aliases');
const { makeRateLimiter, DOC_PATH } = require('../lib/ratelimit');
const { presentsPayment } = require('../lib/keys');
const { commands, strings, KNOWN_BAD } = require('./helpers/instructs');

const ORIGIN = 'https://x402.ochinimus.app';
const PRICES = {
  'GET /api/market-state': { usd: 0.02, tool: 'get_market_state' }, 'GET /api/price': { usd: 0.001, tool: 'get_spot' }, 'GET /api/perp': { usd: 0.005, tool: 'get_perp' }, 'GET /api/liq-pulse': { usd: 0.005, tool: 'get_liq_pulse' },
  'GET /api/funding-pulse': { usd: 0.005, tool: 'get_funding_pulse' }, 'GET /api/liq-feed': { usd: 0.001, tool: 'get_liq_feed' }, 'GET /api/liquidations': { usd: 0.005, tool: 'get_recent_liquidations' },
  'GET /api/signal-board': { usd: 0.01, tool: 'get_signal_board' }, 'GET /api/coin-signal/:coin': { usd: 0.004, tool: 'get_coin_signal' }, 'GET /api/cascade': { usd: 0.01, tool: 'get_cascade_alert' },
  'GET /api/positioning': { usd: 0.005, tool: 'get_positioning' }, 'GET /api/sol-price': { usd: 0.001, tool: 'get_sol_price' },
};
const DOCS = { openapi: { openapi: '3.1.0', info: { title: 'AgentFeed' }, paths: {} }, wellKnown: { version: 1, resources: ['https://x402.ochinimus.app/api/price'] } };

const STARTED = Date.UTC(2026, 9, 19, 5, 21, 21, 987);   // the process start the security.txt tests inject

async function boot({ limiter = true, startedAt = STARTED } = {}) {
  const app = express();
  const rows = [];
  if (limiter) { const rl = makeRateLimiter({ logCall: (r) => rows.push(r), isPricedPath: (p) => !!PRICES[`GET ${p}`], presentsPayment }); app.use(rl.middleware); }
  A.mountDiscoveryAliases(app, { docs: () => DOCS, PRICES, ORIGIN, version: '2.9.0', startedAt });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = (p, headers = {}) => fetch(base + p, { headers: { 'cf-connecting-ip': '203.0.113.9', ...headers } });
  return { rows, get, base, close: () => srv.close() };
}

const JSON_PATHS = ['/x402-resources', '/.well-known/x402-resources', '/.well-known/x402-services.json', '/x402', '/swagger.json', '/api', '/api/',
  '/.well-known/ai-plugin.json', '/.well-known/agents.json', '/.well-known/agent-registration.json'];

test('every new path answers 200, with the right content type, and the JSON ones parse', async (t) => {
  const s = await boot(); t.after(s.close);
  for (const p of JSON_PATHS) {
    const r = await s.get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /^application\/json/, p);
    assert.equal(typeof (await r.json()), 'object', `${p} parses`);
  }
  const sec = await s.get('/.well-known/security.txt');
  assert.equal(sec.status, 200);
  assert.equal(sec.headers.get('content-type'), 'text/plain; charset=utf-8');
  // HEAD works too (crawlers probe with it)
  for (const p of ['/api', '/swagger.json', '/.well-known/security.txt']) assert.equal((await fetch(s.base + p, { method: 'HEAD', headers: { 'cf-connecting-ip': '203.0.113.9' } })).status, 200, `HEAD ${p}`);
});

test('the four resource-list aliases are the /.well-known/x402 document, /swagger.json is openapi.json', async (t) => {
  const s = await boot(); t.after(s.close);
  for (const p of A.WELLKNOWN_ALIASES) assert.deepEqual(await (await s.get(p)).json(), DOCS.wellKnown, p);
  assert.deepEqual(await (await s.get('/swagger.json')).json(), DOCS.openapi);
});

test('/api and /api/: name, scope, the eight links (R25 added status), the ten trading-loop routes with the price table\'s prices', async (t) => {
  const s = await boot(); t.after(s.close);
  const a = await (await s.get('/api')).json();
  assert.deepEqual(await (await s.get('/api/')).json(), a, 'the trailing slash is the same document');
  assert.deepEqual(Object.keys(a), ['name', 'scope', 'links', 'trading_loop']);
  assert.equal(a.name, 'AgentFeed');
  assert.ok(a.scope.length > 40 && !a.scope.includes('\n'), 'one line of scope');
  assert.deepEqual(Object.keys(a.links), ['manifest', 'resources', 'openapi', 'llms_txt', 'skill_md', 'mcp', 'keys', 'status']);
  for (const u of Object.values(a.links)) assert.ok(u.startsWith(ORIGIN + '/'), u);
  assert.equal(a.trading_loop.length, 10);
  assert.equal(A.TRADING_LOOP.length, 10);
  for (const r of a.trading_loop) {
    assert.deepEqual(Object.keys(r), ['path', 'tool', 'price_usd']);
    const entry = PRICES[`GET ${r.path.replace(/\{(\w+)\}/g, ':$1')}`];
    assert.ok(entry, r.path);
    assert.deepEqual([r.tool, r.price_usd], [entry.tool, entry.usd], r.path);
  }
  assert.ok(a.trading_loop.some((r) => r.path === '/api/coin-signal/{coin}'), 'path parameters are written as in openapi');
  // R15c: the one-call bundle heads the list, /api/price is not in it
  assert.equal(a.trading_loop[0].path, '/api/market-state');
  assert.deepEqual([a.trading_loop[0].tool, a.trading_loop[0].price_usd], ['get_market_state', 0.02]);
  assert.ok(!a.trading_loop.some((r) => r.path === '/api/price'), '/api/price left the list');
  assert.deepEqual(a.trading_loop.map((r) => r.path), ['/api/market-state', '/api/perp', '/api/liq-pulse', '/api/funding-pulse', '/api/liq-feed', '/api/liquidations', '/api/signal-board', '/api/coin-signal/{coin}', '/api/cascade', '/api/positioning']);
});

test('/api drops a trading-loop route that left the price table rather than publish a stale one', () => {
  const { 'GET /api/cascade': _gone, ...rest } = PRICES;
  assert.equal(A.buildApiIndex({ PRICES: rest, ORIGIN }).trading_loop.length, 9);
});

test('ai-plugin.json: the legacy manifest, auth none, pointing at openapi.json, inside the legacy length limits', async (t) => {
  const s = await boot(); t.after(s.close);
  const j = await (await s.get('/.well-known/ai-plugin.json')).json();
  assert.equal(j.schema_version, 'v1');
  assert.deepEqual(j.auth, { type: 'none' });
  assert.deepEqual(j.api, { type: 'openapi', url: `${ORIGIN}/openapi.json` });
  assert.ok(j.name_for_human.length <= 20 && j.name_for_model.length <= 50 && j.description_for_human.length <= 100 && j.description_for_model.length <= 8000);
  assert.match(j.name_for_model, /^[a-z0-9_]+$/);
  for (const k of ['logo_url', 'legal_info_url']) assert.ok(j[k].startsWith(ORIGIN + '/'), k);
  assert.equal('contact_email' in j, false, 'no email is published');
});

test('agents.json: valid against the agents.json 0.1.0 schema, one source, openapi.json', async (t) => {
  const s = await boot(); t.after(s.close);
  const j = await (await s.get('/.well-known/agents.json')).json();
  assert.deepEqual(j.sources, [{ id: 'agentfeed', path: `${ORIGIN}/openapi.json` }]);
  assert.equal(j.agentsJson, '0.1.0');
  assert.match(j.info.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(j.flows, []);
  let Ajv; try { Ajv = require('ajv'); } catch { /* the structural asserts above stand */ }
  if (Ajv) {
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'agentsJson.schema.json'), 'utf8')); // wild-card-ai/agents-json, agents_json/agentsJson.schema.json
    const ajv = new Ajv({ strict: false, allErrors: true });
    const ok = ajv.validate(schema, j);
    assert.ok(ok, JSON.stringify(ajv.errors));
    assert.equal(ajv.validate(schema, { agentsJson: '0.1.0', info: j.info, sources: j.sources }), false, 'control: the schema does reject a file without flows');
  }
});

test('agent-registration.json: the ERC-8004 registration-v1 shape, no on-chain registration yet', async (t) => {
  const s = await boot(); t.after(s.close);
  const j = await (await s.get('/.well-known/agent-registration.json')).json();
  assert.deepEqual(Object.keys(j), ['type', 'name', 'description', 'image', 'services', 'x402Support', 'active', 'registrations', 'supportedTrust']);
  assert.equal(j.type, 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
  assert.equal(j.name, 'AgentFeed');
  assert.equal(j.image, `${ORIGIN}/icon.png`);
  assert.deepEqual(j.services.map((x) => x.name), ['web', 'MCP', 'A2A', 'x402']);
  for (const x of j.services) { assert.deepEqual(Object.keys(x).filter((k) => !['name', 'endpoint', 'version'].includes(k)), [], x.name); assert.ok(x.endpoint.startsWith(ORIGIN), x.name); }
  assert.equal(j.services.find((x) => x.name === 'A2A').endpoint, `${ORIGIN}/.well-known/agent-card.json`);
  assert.equal(j.services.find((x) => x.name === 'A2A').version, '0.3.0', 'the card\'s protocolVersion');
  assert.equal(j.services.find((x) => x.name === 'x402').endpoint, `${ORIGIN}/.well-known/x402.json`);
  assert.deepEqual([j.registrations, j.supportedTrust, j.x402Support, j.active], [[], [], true, true]);
});

test('security.txt: RFC 9116 Contact, Expires and Canonical, no email', async (t) => {
  const s = await boot(); t.after(s.close);
  const txt = await (await s.get('/.well-known/security.txt')).text();
  const f = Object.fromEntries(txt.trim().split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
  assert.deepEqual(Object.keys(f), ['Contact', 'Expires', 'Canonical']);
  assert.equal(f.Contact, 'https://github.com/seekdaseek/agentfeed/security');
  assert.equal(f.Canonical, `${ORIGIN}/.well-known/security.txt`);
  assert.match(f.Expires, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(f.Expires, '2027-10-18T05:21:21Z', 'the start time plus 364 days, whole seconds');
  assert.ok(!/@/.test(txt) && !/mailto:/i.test(txt), 'no email');
  assert.ok(txt.endsWith('\n'));
});

test('security.txt Expires is computed from the process start: 364 days, always under a year, never a fixed date (R15c)', async (t) => {
  const exp = async (startedAt) => {
    const s = await boot({ startedAt }); t.after(s.close);
    return (await (await s.get('/.well-known/security.txt')).text()).match(/^Expires: (.+)$/m)[1];
  };
  const a = Date.UTC(2026, 9, 19, 5, 21, 21), b = Date.UTC(2028, 1, 28, 23, 59, 59);   // b: 2028 is a leap year
  assert.equal(await exp(a), '2027-10-18T05:21:21Z');
  assert.equal(await exp(b), '2029-02-26T23:59:59Z');
  for (const at of [a, b]) {
    const days = (Date.parse(await exp(at)) - at) / 86_400_000;
    assert.equal(days, 364, 'exactly 364 days');
    assert.ok(days < 365, 'RFC 9116 asks for less than a year');
  }
  assert.equal(A.expiresFor(a + 999), A.expiresFor(a), 'milliseconds are dropped');
  assert.notEqual(await exp(a), await exp(b), 'it follows the start time');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'discovery-aliases.js'), 'utf8');
  assert.ok(!/2027-10-19/.test(src), 'the fixed 2027-10-19 is gone');
});

test('without an injected start the Expires is the real start plus 364 days', async (t) => {
  const before = Date.now();
  const app = express();
  A.mountDiscoveryAliases(app, { docs: () => DOCS, PRICES, ORIGIN, version: '2.9.0' });
  const srv = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  t.after(() => srv.close());
  const txt = await (await fetch(`http://127.0.0.1:${srv.address().port}/.well-known/security.txt`)).text();
  const at = Date.parse(txt.match(/^Expires: (.+)$/m)[1]);
  assert.ok(at >= before + 364 * 86_400_000 - 1000 && at <= Date.now() + 364 * 86_400_000, 'about now + 364 days');
});

test('every published string in the new documents is plain data: nothing addresses a reader or tells anyone what to do', async (t) => {
  for (const bad of KNOWN_BAD) assert.ok(commands(bad).length > 0, `the detector must see: ${bad}`); // positive control first
  const s = await boot(); t.after(s.close);
  const found = [];
  for (const p of ['/api', '/.well-known/ai-plugin.json', '/.well-known/agents.json', '/.well-known/agent-registration.json']) {
    for (const [at, str] of strings(await (await s.get(p)).json())) {
      if (/^https?:\/\//.test(str)) continue;
      for (const hit of commands(str)) found.push(`${p} ${at}: ${hit}`);
    }
  }
  assert.deepEqual(found, []);
});

test('rate limit: all of them are in the docs bucket (120 a minute), none in the 240 the data routes share, and a data route is untouched', async (t) => {
  for (const p of [...JSON_PATHS, '/.well-known/security.txt', '/openapi.json', '/llms.txt', '/SKILL.md', '/.well-known/x402', '/.well-known/x402.json']) assert.ok(DOC_PATH.test(p), p);
  for (const p of ['/api/sol-price', '/api/supported', '/supported', '/x402/supported', '/facilitator/supported', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/did.json', '/telegraph/api/token-risk']) assert.ok(!DOC_PATH.test(p), `${p} is not a document`);
  const s = await boot(); t.after(s.close);
  let ok = 0, limited = 0;
  for (let i = 0; i < 130; i++) { const r = await s.get(i % 2 ? '/swagger.json' : '/api'); if (r.status === 200) ok++; else if (r.status === 429) limited++; }
  assert.deepEqual([ok, limited], [120, 10]);
  assert.match(s.rows[0].error_msg, /120 req\/min exceeded on the discovery documents bucket/);
});

test('R15d: every alias document says no-cache and carries an ETag, so a cache must revalidate and a repeat is a 304', async (t) => {
  const s = await boot(); t.after(s.close);
  const paths = [...A.WELLKNOWN_ALIASES, '/swagger.json', '/api', '/api/', '/.well-known/ai-plugin.json', '/.well-known/agents.json', '/.well-known/agent-registration.json', '/.well-known/security.txt'];
  for (const p of paths) {
    const r = await s.get(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('cache-control'), 'no-cache', p);
    const etag = r.headers.get('etag');
    assert.ok(etag, `${p} has an ETag`);   // (fetch() adds Cache-Control: no-cache to a conditional request, which makes Express answer 200; max-age=0 is an ordinary revalidation)
    assert.equal((await s.get(p, { 'if-none-match': etag, 'cache-control': 'max-age=0' })).status, 304, `${p}: a revalidation with the ETag is a 304`);
  }
});
