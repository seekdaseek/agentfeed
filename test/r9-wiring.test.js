// test/r9-wiring.test.js — R9 Phase 2: the prepaid keys and the two signal routes, wired into the service (14 Oct 2026).
//
// lib/keys.js, tools/signals.js and the key middleware are tested on their own (keys*.test.js, signals.test.js). This file
// pins the WIRING: the price table, the accepts of every route, the MCP list, the Bazaar entries, the text surfaces, lib/tool.js
// and the order of the middleware in server.js. It needs the box's data files (expansion.js opens the liquidation, peg and
// overhang databases on require, like r7.test.js), so it skips with a reason on a machine without them.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');

const HAVE_BOX = fs.existsSync('/opt/agentfeed/liquidations.db') && fs.existsSync('/opt/overhang/overhang.db');
const skip = HAVE_BOX ? false : 'needs the box databases (/opt/agentfeed/liquidations.db, /opt/overhang/overhang.db)';

const KEY_ROUTES = ['GET /api/keys/buy-trial', 'GET /api/keys/buy-1', 'GET /api/keys/buy-5', 'GET /api/keys/buy-20', 'GET /api/keys/buy-pass', 'GET /api/keys/buy-day-pass', 'GET /api/keys/buy-brief-pass', 'GET /api/keys/buy-brief-day-pass', 'GET /api/keys/topup-5', 'GET /api/keys/topup-20'];   // pensio: plus the two brief passes
const SIGNAL_ROUTES = ['GET /api/signal-board', 'GET /api/coin-signal/:coin'];

test('price table: the nine routes at the briefed prices, only the ten key routes (eight, plus the two brief passes) are noHf', { skip }, () => {
  const { PRICES } = require('../payments');
  const want = { 'GET /api/signal-board': [0.01, 'get_signal_board'], 'GET /api/coin-signal/:coin': [0.004, 'get_coin_signal'],
    'GET /api/keys/buy-trial': [0.25, 'buy_key_trial'], 'GET /api/keys/buy-1': [1, 'buy_key_1'], 'GET /api/keys/buy-5': [5, 'buy_key_5'], 'GET /api/keys/buy-20': [20, 'buy_key_20'], 'GET /api/keys/buy-pass': [25, 'buy_key_pass'], 'GET /api/keys/buy-day-pass': [1, 'buy_key_day_pass'],
    'GET /api/keys/topup-5': [5, 'topup_key_5'], 'GET /api/keys/topup-20': [20, 'topup_key_20'] };
  for (const [route, [usd, tool]] of Object.entries(want)) {
    assert.ok(PRICES[route], route);
    assert.equal(PRICES[route].usd, usd, route);
    assert.equal(PRICES[route].tool, tool, route);
  }
  assert.deepEqual(Object.entries(PRICES).filter(([, p]) => p.noHf).map(([r]) => r).sort(), [...KEY_ROUTES].sort(), 'noHf is exactly the ten key routes');
  for (const r of SIGNAL_ROUTES) assert.ok(!PRICES[r].noHf, `${r} keeps the high-frequency tier`);
  assert.ok(!PRICES['GET /api/keys/balance'], 'the balance check is free and not in the price table');
});

test('accepts: the key routes carry the exact accepts only; every other route keeps its high-frequency accepts', { skip }, () => {
  const { PRICES, routeAccepts } = require('../payments');
  const { hfAccepts } = require('../lib/hf');
  const HF = { batch: { networks: ['eip155:8453', 'eip155:137'], receiver: '0x' + '22'.repeat(20) }, gateway: { networks: ['eip155:8453', 'eip155:5042'], payTo: '0x' + 'a8'.repeat(20) } };
  const EVM = [{ network: 'eip155:8453', name: 'Base' }, { network: 'eip155:5042', name: 'Arc' }];
  const ctx = { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', payTo: 'TREASURYsol', EVM, ALGO: { network: 'algorand:mainnet', payTo: 'ALGOPAYTO' }, HF,
    railPrice: (r, usd) => `$${usd}`, railPayTo: () => '0x' + '22'.repeat(20), hfAccepts };
  const hfOf = (accepts) => accepts.filter((a) => a.scheme === 'batch-settlement' || (a.extra && a.extra.name === 'GatewayWalletBatched'));
  for (const r of KEY_ROUTES) {
    const acc = routeAccepts(PRICES[r], ctx);
    assert.equal(hfOf(acc).length, 0, `${r}: no batch-settlement and no Gateway accept`);
    assert.deepEqual(acc.map((a) => a.network), ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'eip155:8453', 'eip155:5042', 'algorand:mainnet'], `${r}: every exact rail, in the usual order`);
    assert.ok(acc.every((a) => a.scheme === 'exact'), `${r}: exact only`);
  }
  for (const r of [...SIGNAL_ROUTES, 'GET /api/price', 'GET /api/eth-price']) {
    const acc = routeAccepts(PRICES[r], ctx);
    assert.equal(hfOf(acc).length, 4, `${r}: 2 batch + 2 Gateway`);
    assert.equal(acc.length, 4 + hfOf(acc).length, `${r}: 4 exact + the high-frequency tier`);
  }
  // the pre-R9 shape of an ordinary route is unchanged: same list as before the refactor
  const before = [
    { scheme: 'exact', price: '$0.001', network: ctx.network, payTo: ctx.payTo, extra: { name: 'USDC' } },
    ...EVM.map((r) => ({ scheme: 'exact', price: ctx.railPrice(r, 0.001), network: r.network, payTo: ctx.railPayTo(r) })),
    { scheme: 'exact', price: '$0.001', network: 'algorand:mainnet', payTo: 'ALGOPAYTO' },
    ...hfAccepts(HF, 0.001),
  ];
  assert.deepEqual(routeAccepts({ usd: 0.001, tool: 'x' }, ctx), before);
});

test('challenge: every priced route keeps its "Use when" sentence inside the 400-character cap of the 402 description', { skip }, () => {
  // challengeLead puts the route's FIRST SENTENCE ahead of the "Use when you need to answer" question, and challengeDesc cuts at 400. A first
  // sentence of ~370 characters (get_coin_signal's, live 14 Oct 2026) pushed the question past the cut, so the 402 lost it. The route's
  // opening and its question must fit together; the rest of the description may be trimmed.
  const { PRICES, challengeLead, challengeDesc, CHALLENGE_DESC_MAX } = require('../payments');
  const bad = [];
  for (const [route, p] of Object.entries(PRICES)) {
    const d = challengeDesc(challengeLead(p));
    if (d.length > CHALLENGE_DESC_MAX) bad.push(`${route}: ${d.length} chars`);
    else if (!/Use when you need to answer: /.test(d)) bad.push(`${route}: the "Use when" question was cut (opening ${String(p.desc).split(/(?<=[.?!])\s+(?=[A-Z0-9$(])/)[0].length} chars)`);
  }
  assert.deepEqual(bad, [], 'routes whose challenge description lost its when-to-use question');
});

test('MCP: the two signal tools are listed, the eight key routes are not tools', { skip }, () => {
  const { TOOL_DEFS } = require('../mcp');
  const names = TOOL_DEFS.map((d) => d.name);
  assert.ok(names.includes('get_signal_board') && names.includes('get_coin_signal'));
  assert.ok(!names.some((n) => /^(buy|topup)_key_/.test(n)), 'a key is bought over HTTP, never as an MCP tool');
  assert.equal(TOOL_DEFS.find((d) => d.name === 'get_signal_board').usd, 0.01);
  assert.equal(TOOL_DEFS.find((d) => d.name === 'get_coin_signal').usd, 0.004);
});

test('Bazaar: every priced route has an output example, the key routes are constructed (static) and show a placeholder key', { skip }, () => {
  const { PRICES } = require('../payments');
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bazaar-examples.json'), 'utf8')).routes;
  const missing = Object.keys(PRICES).filter((r) => !meta[r] || !meta[r].output || !meta[r].output.example);
  assert.deepEqual(missing, [], 'a route without an example would show as a CDP advisory');
  for (const r of KEY_ROUTES) {
    assert.equal(meta[r].static, true, `${r} is a constructed example`);
    const ex = JSON.stringify(meta[r].output.example);
    assert.ok(!/afk_[1-9A-HJ-NP-Za-km-z]{43}\b/.test(ex.replace(/afk_x+/g, '')), `${r}: no real-looking key in the example`);
  }
  for (const r of SIGNAL_ROUTES) assert.ok(!meta[r].static, `${r} is a live capture`);
  assert.equal(meta['GET /api/coin-signal/:coin'].pathParams.coin, 'BTC');
});

test('text surfaces: one derived keys sentence in openapi, llms.txt and SKILL.md; no surface still says there are no API keys at all', { skip }, () => {
  const { PRICES, TAGS, BAZAAR_META } = require('../payments');
  const D = require('../tools/discovery');
  const { keysSentence } = require('../lib/keys');
  const sentence = keysSentence(PRICES);
  assert.match(sentence, /\$0\.25, \$1, \$5, \$20/);
  assert.match(sentence, /X-AgentFeed-Key/);
  assert.match(sentence, /\/keys/);
  const ctx = { PRICES, TAGS, META: BAZAAR_META, FREE_TOOLS: ['get_fear_greed'], mpp: { active: false, routes: [] }, tempo: { active: false }, network: 'mainnet' };
  const openapi = JSON.stringify(D.buildOpenApi(ctx));
  const llms = D.buildLlmsTxt(ctx);
  const skill = D.buildSkillMd(ctx);
  for (const [name, text] of [['openapi', openapi], ['llms.txt', llms], ['SKILL.md', skill]]) {
    assert.ok(text.includes('X-AgentFeed-Key'), `${name} carries the keys sentence`);
    assert.ok(!/There are no API keys and no accounts/i.test(text), `${name} no longer says there are no API keys`);
  }
  const landing = require('../tools/landing').renderLanding(PRICES, 'mainnet', null);
  assert.ok(landing.includes('X-AgentFeed-Key'), 'the landing page carries the keys sentence');
  for (const [name, text] of [['openapi', openapi], ['llms.txt', llms], ['SKILL.md', skill], ['landing page (meta description included)', landing]]) {
    assert.ok(!/No API keys?\./.test(text), `${name} still carries the flat claim "No API key."`);
  }
  const api = D.buildOpenApi(ctx);
  assert.ok(api.paths['/api/signal-board'] && api.paths['/api/coin-signal/{coin}'] && api.paths['/api/keys/buy-trial'], 'the new routes are in openapi');
  const params = (api.paths['/api/keys/buy-trial'].get.parameters || []).map((p) => p.name);
  assert.ok(params.includes('key_hash'), 'buy-trial documents key_hash');
  assert.equal(keysSentence({}), '', 'no key routes in the table, no sentence');
});

test('terms and pricing: prepaid credit is covered (non-refundable, no expiry, bearer secret)', { skip }, () => {
  const { termsHandler, makePricing } = require('../lib/compat');
  let text = '';
  termsHandler({}, { type() { return this; }, send(t) { text = t; } });
  assert.match(text, /prepaid key/i);
  assert.match(text, /non-refundable/i);
  assert.match(text, /no expiry/i);
  assert.match(text, /bearer secret/i);
  assert.match(text, /120 per minute per prepaid key/);
  let body = null;
  makePricing({ PRICES: { 'GET /api/x': { usd: 0.01, tool: 'x' } }, FREE_TOOLS: [], ORIGIN: 'https://x', railNames: 'r', mpp: { active: false }, tempo: { active: false } })({ headers: {} }, { json(b) { body = b; } });
  assert.match(body.billing, /prepaid keys optional/);
});

test('lib/tool.js: a request paid with a key writes no second row (keys.charge writes the one row, status key)', async () => {
  const { makeTool } = require('../lib/tool');
  const rows = [];
  const { tool } = makeTool({ paymentsOn: true, PRICES: { 'GET /api/x': { usd: 0.01, tool: 'get_x' } }, decodeSettlement: () => null, logCall: (r) => rows.push(r) });
  const app = express();
  app.use((req, _res, next) => { if (req.headers['x-test-keypaid']) req.keyPaid = { prefix: 'abcd1234', micro: 5000, usd: 0.005 }; next(); });
  app.get('/api/x', tool('get_x', 0.01, () => ({ ok: true })));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r1 = await fetch(`${base}/api/x`, { headers: { 'x-test-keypaid': '1' } });
    const j1 = await r1.json();
    assert.equal(r1.status, 200);
    assert.equal(j1.paid, true, 'the response still says paid:true');
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(rows, [], 'no free or paid row from lib/tool.js for a key-paid request');
    await fetch(`${base}/api/x`); // an unkeyed request is logged as before
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'free');
  } finally { server.close(); }
});

test('server.js: the middleware order the key rail depends on', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const at = (s) => { const i = src.indexOf(s); assert.ok(i >= 0, `server.js lost: ${s}`); return i; };
  const identify = at('app.use(keys.identify);');
  const limiter = at('app.use(rateLimiter.middleware);'); // lib/ratelimit.js (R13); the buckets themselves moved with it
  const headGuard = at("if (req.method !== 'HEAD' || !isApiPath(req.path)) return next();");   // R19a: under /api/ on the canonical path, any spelling
  const getOnly = at('app.use(compat.makeGetOnly({ PRICES }));');
  const canon = at('const QUERY_ALIASABLE');
  const guard = at('app.use(keys.purchaseGuard);');
  const charge = at('app.use(keys.charge);');
  const recorder = at('app.use(skipForKey(makeRefusalRecorder(');
  const tempoGate = at('!req.keyPaid && tempo && tempo.isReady()');
  const x402gate = at('req.x402v1 || req.tempoPending || req.keyPaid ? next() : gate(req, res, next)');
  const routes = at("require('./expansion').register(app, tool);");
  assert.ok(identify < limiter, 'identify runs before the IP limiter');
  assert.ok(limiter < headGuard && headGuard < getOnly && getOnly < canon, 'limiter, HEAD guard, GET-only, canonicalisation keep their order');
  assert.ok(canon < guard && guard < charge, 'purchase guard and charge come after the query canonicalisation');
  assert.ok(charge < recorder && recorder < tempoGate && tempoGate < x402gate && x402gate < routes, 'charge precedes every payment layer');
  for (const mw of ['makeDemand', 'aliasAuthorizationPayment', 'sanitizeChallengeErrors', 'aliasXPayment', 'x402v1.challengeBody', 'x402v1.payments', 'makeMppOnX402Only']) {
    assert.ok(new RegExp(`skipForKey\\(\\s*${mw.replace('.', '\\.')}`).test(src), `${mw} skips a key-paid request`);
  }
  assert.ok(/skipForKey\(mpp\.gate\('GET \/api\/sol-price'\)\)/.test(src) && /skipForKey\(mpp\.gate\('GET \/api\/btc-price'\)\)/.test(src), 'the MPP solana gates skip a key-paid request');
  assert.ok(/req\.afKey && req\.afKey\.active/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'ratelimit.js'), 'utf8')), 'a valid key skips the IP bucket (lib/ratelimit.js)');
  assert.ok(src.indexOf("app.get('/api/keys/balance', keys.balance);") < src.indexOf('const paymentLayer') || src.indexOf("app.get('/api/keys/balance', keys.balance);") < at('let paymentLayer = null;'), 'the free balance route is mounted above the payment layer');
  assert.ok(src.indexOf("app.get('/keys',") > 0, 'the buy page is mounted');
  assert.ok(src.includes('await initMcp(app, keys);'), 'MCP receives the key store');
  const mcpSrc = fs.readFileSync(path.join(__dirname, '..', 'mcp.js'), 'utf8');
  assert.ok(/async function initMcp\(app, keys\)/.test(mcpSrc), 'initMcp takes the key store');
  assert.ok(/function buildServer\(req\)/.test(mcpSrc) && mcpSrc.includes('const server = buildServer(req);'), 'each MCP request builds its server from its own request');
  assert.ok(mcpSrc.includes('keys.mcpWrap(req, def)) || wrappers[def.name]'), 'a key-bearing request pays through mcpWrap, any other through the x402 wrapper');
  assert.equal((src.match(/const paymentsOn =/g) || []).length, 1, 'paymentsOn is declared once, before it is first used');
});
