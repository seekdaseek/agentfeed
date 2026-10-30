// The signals passes (pensio, 30 Oct 2026): 30 days ($25) and 24 hours ($1.00), good only on the brief routes and the perp signal routes (market-state, signal-board,
// coin-signal, oi-spike-scan, liq-heatmap: tools/briefs/config.js passRoutes()), nothing drawn per call, each route one call per 60 s per key. The bot pass / day pass mechanism of lib/keys.js with two more kinds. Run against the REAL @x402/express 2.28 middleware with a stub
// facilitator, the real key rail and lib/tool.js, as keys-daypass.test.js does. The old bot pass and day pass tests stay unchanged; this file also pins that
// the two old kinds are what they were.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const KL = require('../lib/keys');
const { makeKeys, hashKey, newKey, PASS, DAY_PASS, SIGNALS_PASS, SIGNALS_DAY_PASS, exampleBody, keysSentence, passOf, kindOf } = KL;
const { ExactEvmScheme: ExactEvmClient } = require('@x402/evm/exact/client');
const { wrapFetchWithPaymentFromConfig } = require('@x402/fetch');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const { makeTool } = require('../lib/tool');
const { hfUsd } = require('../lib/hf');
const BC = require('../tools/briefs/config');

const NET = 'eip155:8453';
const PAYTO = '0x' + '22'.repeat(20);
const PAYER = '0x' + 'ab'.repeat(20);
const DAY = 24 * 3_600_000;
const unb64 = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));
const SIGNALS_ROUTES = BC.passRoutes();                                   // the one list: brief routes sold + signal routes (pattern form)
const concrete = (r) => r.replace(':coin', 'BTC');
const PRICES = {
  'GET /api/morning-brief': { usd: 0.03, tool: 'get_morning_brief' },
  'GET /api/move-alert': { usd: 0.02, tool: 'get_move_alert' },
  'GET /api/anomaly-flag': { usd: 0.02, tool: 'get_anomaly_flag' },
  'GET /api/market-state': { usd: 0.02, tool: 'get_market_state' },
  'GET /api/signal-board': { usd: 0.01, tool: 'get_signal_board' },
  'GET /api/coin-signal/:coin': { usd: 0.004, tool: 'get_coin_signal' },
  'GET /api/oi-spike-scan': { usd: 0.02, tool: 'get_oi_spike_scan' },
  'GET /api/liq-heatmap': { usd: 0.02, tool: 'get_liq_heatmap' },
  'GET /api/open-interest': { usd: 0.01, tool: 'get_open_interest' },
  'GET /api/liq-feed': { usd: 0.001, tool: 'get_liq_feed' },
  'GET /api/thing': { usd: 0.01, tool: 'get_thing' },
  [`GET ${SIGNALS_PASS.path}`]: { usd: SIGNALS_PASS.usd, tool: SIGNALS_PASS.tool, noHf: true },
  [`GET ${SIGNALS_DAY_PASS.path}`]: { usd: SIGNALS_DAY_PASS.usd, tool: SIGNALS_DAY_PASS.tool, noHf: true },
  'GET /api/keys/buy-pass': { usd: 25, tool: 'buy_key_pass', noHf: true },
  'GET /api/keys/buy-day-pass': { usd: 1, tool: 'buy_key_day_pass', noHf: true },
  'GET /api/keys/topup-5': { usd: 5, tool: 'topup_key_5', noHf: true },
};

async function boot({ settle = 'ok' } = {}) {
  const db = new Database(':memory:');
  const clock = { t: 1_800_000_000_000 };
  const rows = [];
  const logCall = (r) => rows.push(r);
  const fac = { calls: { verify: 0, settle: 0 }, mode: settle,
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: NET }], extensions: [], signers: {} }; },
    async verify() { this.calls.verify++; return { isValid: true, payer: PAYER }; },
    async settle() { this.calls.settle++; return this.mode === 'ok' ? { success: true, transaction: '0x' + '5e'.repeat(32), network: NET, payer: PAYER } : { success: false, errorReason: 'insufficient_funds', transaction: '', network: NET, payer: PAYER }; } };
  const rs = new x402ResourceServer([fac]).register(NET, new ExactEvmScheme());
  const routes = {};
  for (const [pattern, p] of Object.entries(PRICES)) routes[pattern] = { accepts: [{ scheme: 'exact', price: `$${p.usd}`, network: NET, payTo: PAYTO }], description: p.tool, mimeType: 'application/json' };
  const gate = paymentMiddleware(routes, rs);
  const K = makeKeys({ db, PRICES, logCall, hfUsd, paymentsOn: true, now: () => clock.t });
  const gateHits = { n: 0 };
  const app = express();
  app.use((req, _res, next) => { req.callerIp = '127.0.0.1'; next(); });
  app.use(K.identify);
  app.use(K.purchaseGuard);
  app.use(K.charge);
  app.use((req, res, next) => { if (req.keyPaid) return next(); gateHits.n++; return gate(req, res, next); });
  const { tool } = makeTool({ paymentsOn: true, PRICES, decodeSettlement: (res) => { const raw = res.getHeader('payment-response'); return raw ? unb64(raw) : null; }, logCall });
  const ok = () => ({ ok: true });
  for (const [pattern, p] of Object.entries(PRICES)) {
    const path = pattern.replace('GET ', '');
    if (path === SIGNALS_PASS.path) app.get(path, tool(p.tool, p.usd, (req) => K.buy(req.query, req, p.usd, { pass: SIGNALS_PASS })));
    else if (path === SIGNALS_DAY_PASS.path) app.get(path, tool(p.tool, p.usd, (req) => K.buy(req.query, req, p.usd, { pass: SIGNALS_DAY_PASS })));
    else if (path === '/api/keys/buy-pass') app.get(path, tool(p.tool, p.usd, (req) => K.buy(req.query, req, p.usd, { pass: PASS })));
    else if (path === '/api/keys/buy-day-pass') app.get(path, tool(p.tool, p.usd, (req) => K.buy(req.query, req, p.usd, { pass: DAY_PASS })));
    else if (path === '/api/keys/topup-5') app.get(path, tool(p.tool, p.usd, (req) => K.topup(req.query, req, 5)));
    else app.get(path, tool(p.tool, p.usd, ok));
  }
  app.get('/api/keys/balance', K.balance);
  app.use((err, _req, res, _next) => res.status(500).json({ error: 'internal' })); // eslint-disable-line no-unused-vars
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, headers = {}) => fetch(base + p, { headers });
  await new Promise((r) => setTimeout(r, 30));
  return { db, rows, fac, K, clock, gateHits, get, base, close: () => { K.stop(); server.close(); } };
}
const flush = () => new Promise((r) => setTimeout(r, 20));
/** buy through the real x402 gate: the 402, then the same request with a PAYMENT-SIGNATURE */
async function buyPass(s, path, { keyHash } = {}) {
  const q = keyHash ? `?key_hash=${keyHash}` : '';
  const ch = await s.get(path + q);
  assert.equal(ch.status, 402, `${path} unpaid`);
  const pr = unb64(ch.headers.get('payment-required'));
  const accepted = pr.accepts[0];
  const payload = { x402Version: 2, resource: pr.resource, accepted, payload: { signature: '0x' + '11'.repeat(65), authorization: { from: PAYER, to: accepted.payTo, value: accepted.amount, validAfter: '0', validBefore: String(2 ** 40), nonce: '0x' + '33'.repeat(32) } } };
  const res = await s.get(path + q, { 'payment-signature': Buffer.from(JSON.stringify(payload)).toString('base64') });
  await flush();
  return res;
}

test('the signals passes: the terms come from tools/briefs/config.js, allow = the brief routes the instance sells plus the signal routes, one call a minute on every one of them', () => {
  assert.deepEqual([SIGNALS_PASS.usd, SIGNALS_PASS.days, SIGNALS_PASS.path, SIGNALS_PASS.tool], [BC.PASS_TERMS.usd, BC.PASS_TERMS.days, '/api/keys/buy-signals-pass', 'buy_key_signals_pass']);
  assert.deepEqual([SIGNALS_DAY_PASS.usd, SIGNALS_DAY_PASS.days, SIGNALS_DAY_PASS.path, SIGNALS_DAY_PASS.tool], [BC.DAY_PASS_TERMS.usd, 1, '/api/keys/buy-signals-day-pass', 'buy_key_signals_day_pass']);
  assert.equal(SIGNALS_DAY_PASS.usd, 1, '$1.00 is the most a stock @x402/fetch client pays with its default spend cap');
  assert.deepEqual(SIGNALS_PASS.allow, BC.passRoutes());
  assert.deepEqual(SIGNALS_DAY_PASS.allow, BC.passRoutes());
  assert.deepEqual(SIGNALS_PASS.allow, [...BC.soldRoutes(), '/api/market-state', '/api/signal-board', '/api/coin-signal/:coin', '/api/oi-spike-scan', '/api/liq-heatmap'], 'the list, written out once here as the control for the constant');
  assert.ok(!SIGNALS_PASS.allow.includes('/api/news-brief'), 'the news brief is off by default, so a pass is not sold for it');
  for (const r of BC.PASS_ROUTES_ALL) assert.equal(SIGNALS_PASS.pace[r], 60_000, `${r} is paced at one call a minute`);
  assert.equal(new Set(SIGNALS_PASS.allow).size, SIGNALS_PASS.allow.length, 'no route twice');
  assert.equal(KL.PASSES.length, 4);
});
test('the two old passes are what they were: same price, term, routes, pace, label; and a stored row of either still reads as its own kind', () => {
  assert.deepEqual({ ...PASS }, { id: 'pass', usd: 25, days: 30, allow: ['/api/liq-feed'], label: 'bot pass', path: '/api/keys/buy-pass', tool: 'buy_key_pass' });
  assert.deepEqual({ ...DAY_PASS }, { id: 'day', usd: 1, days: 1, allow: ['/api/liq-feed', '/api/liquidations'], pace: { '/api/liquidations': 10_000 }, label: 'day pass', path: '/api/keys/buy-day-pass', tool: 'buy_key_day_pass' });
  assert.equal(passOf({ pass_days: 30, allow: '/api/liq-feed' }), PASS);
  assert.equal(passOf({ pass_days: 1, allow: '/api/liq-feed,/api/liquidations' }), DAY_PASS);
  assert.equal(passOf({ pass_days: 7, allow: '/api/liq-feed' }), PASS, 'a comp pass of another length still reads as the bot pass');
  assert.equal(passOf({ pass_days: 3, allow: null }), PASS);
  assert.equal(exampleBody('buy_key_pass').pass.routes.join(), '/api/liq-feed');
  assert.match(exampleBody('buy_key_day_pass').use, /one call every 10 seconds per key \(6 a minute\)/);
});
test('a stored row is a signals pass whatever subset of the brief routes it was sold with (the news brief may be switched on or off after the sale)', () => {
  assert.equal(passOf({ pass_days: 30, allow: '/api/morning-brief,/api/move-alert,/api/anomaly-flag' }), SIGNALS_PASS);
  assert.equal(passOf({ pass_days: 30, allow: '/api/morning-brief,/api/move-alert,/api/anomaly-flag,/api/news-brief' }), SIGNALS_PASS);
  assert.equal(passOf({ pass_days: 1, allow: '/api/move-alert' }), SIGNALS_DAY_PASS);
  assert.equal(kindOf(1, ['/api/morning-brief', '/api/news-brief']), SIGNALS_DAY_PASS);
  assert.equal(passOf({ pass_days: 30, allow: '/api/liq-feed,/api/morning-brief' }), PASS, 'a mixed set is not a signals pass');
  assert.equal(passOf({ pass_days: 30, allow: '/api/market-state,/api/signal-board,/api/coin-signal/:coin' }), SIGNALS_PASS, 'a row that covers signal routes only is still a signals pass');
  assert.equal(passOf({ pass_days: 1, allow: '/api/oi-spike-scan,/api/liq-heatmap,/api/morning-brief' }), SIGNALS_DAY_PASS);
  assert.equal(passOf({ pass_days: 30, allow: '/api/signal-board,/api/liq-feed' }), PASS, 'and a signal route beside a bot-pass route is not');
});

test('purchase: a pending row is created, and the pass activates only when the settlement is present (expiry = settlement + 30 days)', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = newKey(); const hash = hashKey(key);
  const ch = await s.get(`${SIGNALS_PASS.path}?key_hash=${hash}`);
  assert.equal(ch.status, 402);
  assert.equal(s.K.store.get(hash), null, 'an unpaid request creates nothing');
  const res = await buyPass(s, SIGNALS_PASS.path, { keyHash: hash });
  assert.equal(res.status, 200);
  const body = (await res.json()).data;
  assert.equal(body.pass.price_usd, SIGNALS_PASS.usd);
  assert.deepEqual(body.pass.routes, SIGNALS_PASS.allow);
  assert.ok(body.terms.startsWith(`a 30-day signals pass for a flat $25, good only on ${SIGNALS_PASS.allow.map(KL.showRoute).join(', ')}, non-refundable, cannot be topped up`), body.terms);
  assert.ok(SIGNALS_PASS.allow.every((r) => body.terms.includes(KL.showRoute(r)) && body.use.includes(KL.showRoute(r)) && body.pass.routes.includes(r)), 'the terms and the use text name every covered route, and pass.routes lists the stored patterns');
  assert.ok(!/\/:[a-z]/.test(body.terms + body.use), 'no colon template in the prose');
  assert.match(body.use, /one clock for every value \(\/api\/coin-signal\/\{coin\}\), so to read several coins in one call use \/api\/signal-board\?coins=BTC,ETH,SOL/);
  assert.match(body.terms, /bearer secret/);
  assert.match(body.use, /one call every 60 seconds per key \(1 a minute\)/);
  const row = s.K.store.get(hash);
  assert.equal(row.status, 'active');
  assert.equal(row.pass_days, 30);
  assert.equal(row.expires_at, s.clock.t + 30 * DAY);
  assert.equal(row.allow, SIGNALS_PASS.allow.join(','));
  assert.equal(s.fac.calls.settle, 1);
  const paid = s.rows.filter((r) => r.status === 'paid');
  assert.deepEqual(paid.map((r) => [r.tool, r.amount_usdc]), [[SIGNALS_PASS.tool, SIGNALS_PASS.usd]], 'the sale is one paid row');
});
test('purchase: a settlement that fails leaves no pass, and a pass is never active before it settles', async (t) => {
  const s = await boot({ settle: 'fail' }); t.after(s.close);
  const key = newKey(); const hash = hashKey(key);
  const res = await buyPass(s, SIGNALS_DAY_PASS.path, { keyHash: hash });
  assert.notEqual(res.status, 200);
  assert.equal(s.K.store.get(hash), null, 'the pending row is dropped: the buyer never sees a usable key');
  assert.equal(s.rows.filter((r) => r.status === 'paid').length, 0);
  const call = await s.get('/api/morning-brief', { 'x-agentfeed-key': key });
  assert.equal(call.status, 401);
});

async function activePass(s, kind = SIGNALS_PASS) {
  const key = newKey();
  const res = await buyPass(s, kind.path, { keyHash: hashKey(key) });
  assert.equal(res.status, 200);
  return key;
}
test('a signals pass is good on every covered route (the briefs and the signal routes), draws nothing per call, and is refused (403) on every other priced route, naming the covered routes', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = await activePass(s);
  const hash = hashKey(key);
  const hits = s.gateHits.n;
  for (const r of SIGNALS_ROUTES) {
    const res = await s.get(concrete(r), { 'x-agentfeed-key': key });
    assert.equal(res.status, 200, r);
    s.clock.t += 61_000;      // outside the pace
  }
  await flush();
  assert.equal(s.gateHits.n, hits, 'a pass call never reaches the payment gate');
  const row = s.K.store.get(hash);
  assert.equal(row.balance_micro, 0);
  assert.equal(row.spent_micro, 0, 'nothing drawn per call');
  assert.equal(row.calls, SIGNALS_ROUTES.length);
  const keyRows = s.rows.filter((r) => r.status === 'key');
  assert.equal(keyRows.length, SIGNALS_ROUTES.length);
  assert.ok(keyRows.every((r) => r.amount_usdc === 0), 'a pass call is a key row of amount 0');
  for (const other of ['/api/liq-feed', '/api/thing', '/api/open-interest']) {
    const res = await s.get(other, { 'x-agentfeed-key': key });
    assert.equal(res.status, 403, other);
    const j = await res.json();
    assert.match(j.error, /^this key is a signals pass, good only on \/api\/morning-brief/);
    assert.ok(SIGNALS_PASS.allow.every((r) => j.error.includes(KL.showRoute(r))), 'the refusal names every covered route');
    assert.deepEqual(j.routes, SIGNALS_PASS.allow);
  }
  assert.equal(s.K.store.get(hash).calls, SIGNALS_ROUTES.length, 'a refused call is not counted');
});
test('a signals pass is refused with 401 when it has expired, naming the pass to buy again', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = await activePass(s);
  s.clock.t += 30 * DAY + 1;
  const res = await s.get('/api/move-alert', { 'x-agentfeed-key': key });
  assert.equal(res.status, 401);
  const j = await res.json();
  assert.match(j.error, /^this signals pass expired on 2027-/);
  assert.equal(j.buy, SIGNALS_PASS.path);
  const d = await activePass(s, SIGNALS_DAY_PASS);
  s.clock.t += DAY + 1;
  const r2 = await s.get('/api/move-alert', { 'x-agentfeed-key': d });
  assert.equal(r2.status, 401);
  const j2 = await r2.json();
  assert.match(j2.error, /^this signals day pass expired on /);
  assert.equal(j2.buy, SIGNALS_DAY_PASS.path);
});
test('the pace: a second call to the same brief route inside 60 s is a 429 with Retry-After and retry_after, never counted; another route has its own clock', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = await activePass(s, SIGNALS_DAY_PASS);
  const a = await s.get('/api/morning-brief', { 'x-agentfeed-key': key });
  assert.equal(a.status, 200);
  s.clock.t += 20_000;
  const b = await s.get('/api/morning-brief', { 'x-agentfeed-key': key });
  assert.equal(b.status, 429);
  assert.equal(b.headers.get('retry-after'), '40');
  const j = await b.json();
  assert.equal(j.retry_after, 40);
  assert.match(j.error, /^this signals day pass answers \/api\/morning-brief one call every 60 s per key \(1 a minute\)\. Retry in 40 s\./);
  const other = await s.get('/api/move-alert', { 'x-agentfeed-key': key });
  assert.equal(other.status, 200, 'the other route is not held back by the first');
  await flush();
  assert.equal(s.K.store.get(hashKey(key)).calls, 2, 'the 429 was not counted');
  assert.equal(s.rows.filter((r) => r.status === 'key').length, 2);
  s.clock.t += 40_000;
  assert.equal((await s.get('/api/morning-brief', { 'x-agentfeed-key': key })).status, 200, 'after the wait the route answers again');
});
test('a signals pass cannot be topped up, and /api/keys/balance shows its kind, routes and expiry', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = await activePass(s);
  const top = await s.get('/api/keys/topup-5', { 'x-agentfeed-key': key });
  assert.equal(top.status, 400);
  assert.match((await top.json()).error, /^a signals pass cannot be topped up/);
  const bal = await (await s.get('/api/keys/balance', { 'x-agentfeed-key': key })).json();
  assert.equal(bal.pass.kind, 'signals');
  assert.deepEqual(bal.pass.routes, SIGNALS_PASS.allow);
  assert.equal(bal.pass.days_left, 30);
});
test('the old bot pass and day pass behave as before beside the new ones: the bot pass is refused on a brief route, the day pass paces only /api/liquidations', async (t) => {
  const s = await boot(); t.after(s.close);
  const bot = await activePass(s, PASS);
  assert.equal((await s.get('/api/liq-feed', { 'x-agentfeed-key': bot })).status, 200);
  const r = await s.get('/api/morning-brief', { 'x-agentfeed-key': bot });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /^this key is a bot pass, good only on \/api\/liq-feed/);
  const day = await activePass(s, DAY_PASS);
  assert.equal(passOf(s.K.store.get(hashKey(day))), DAY_PASS);
});
test('the brief tools over MCP: a pass key is good on a brief tool and refused on another tool; the pace holds', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = await activePass(s, SIGNALS_DAY_PASS);
  const row = s.K.store.get(hashKey(key));
  const mk = () => ({ afKey: { presented: true, active: true, row: { ...row, prefix: key.slice(4, 12) }, hash: hashKey(key) }, headers: {}, callerIp: '127.0.0.1' });
  const run = async (name, req) => {
    const wrap = s.K.mcpWrap(req, { name, usd: 0.03 });
    return wrap(async () => ({ content: [{ type: 'text', text: '{}' }] }))({}, {});
  };
  const ok = await run('get_morning_brief', mk());
  assert.ok(!ok.isError);
  const paced = await run('get_morning_brief', mk());
  assert.equal(paced.isError, true);
  assert.match(paced.content[0].text, /one call every 60 s/);
  const wrong = await run('get_liq_feed', mk());
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0].text, /good only on/);
});
test('docs: the derived keys sentence names the signals passes with their prices from the price table, and the packs list does not count them as packs', () => {
  const sentence = keysSentence({ ...PRICES, 'GET /api/keys/buy-5': { usd: 5, tool: 'buy_key_5' }, 'GET /api/keys/buy-1': { usd: 1, tool: 'buy_key_1' } });
  assert.ok(sentence.includes(`A 30-day signals pass is one flat key for the briefs and the perp signal routes (${SIGNALS_PASS.allow.map(KL.showRoute).join(', ')}): $25 (/api/keys/buy-signals-pass), or $1 for 24 hours (/api/keys/buy-signals-day-pass)`), sentence);
  assert.match(sentence, /each route one call every 60 seconds per key/);
  assert.match(sentence, /prepaid key once \(\$1, \$5; page at \/keys\)/, 'the packs list holds the packs only, not the signals passes');
  assert.equal(keysSentence({}), '');
});

test('a stock @x402/fetch client with its default spend cap buys the brief DAY pass ($1.00, signed, not sent) and is refused the $25 signals pass (control)', async (t) => {
  const s = await boot(); t.after(s.close);
  const account = privateKeyToAccount(generatePrivateKey());
  const seen = [];
  const catcher = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const sig = req.headers.get('payment-signature');
    if (sig) { seen.push(unb64(sig)); return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { 'content-type': 'application/json' } }); }
    return fetch(req);
  };
  const pay = wrapFetchWithPaymentFromConfig(catcher, { schemes: [{ network: NET, client: new ExactEvmClient(account) }] });   // no spendControls: the defaults
  const r = await pay(`${s.base}${SIGNALS_DAY_PASS.path}`);
  assert.equal(r.status, 200);
  assert.deepEqual([seen[0].accepted.amount, seen[0].accepted.network], ['1000000', NET]);
  await assert.rejects(pay(`${s.base}${SIGNALS_PASS.path}`), /spendControls\.maxAmountPerPayment \(\$1/, 'the $25 pass needs the cap raised');
  assert.equal(seen.length, 1);
  assert.equal(s.fac.calls.settle, 0);
});
test('the /keys page offers both signals passes at the prices of the constants, and a purchase it makes is checked against them', () => {
  const page = require('../tools/keys-page');
  assert.match(page.HTML, new RegExp(`value="signals-pass">signals pass \\$${SIGNALS_PASS.usd}: ${SIGNALS_PASS.days} days, one flat key for the briefs and the perp signal routes \\(${SIGNALS_PASS.allow.map(KL.showRoute).map((r) => r.replace(/[\/{}]/g, '\\$&')).join(', ')}\\)`));
  assert.match(page.HTML, new RegExp(`value="signals-day-pass">signals day pass \\$${SIGNALS_DAY_PASS.usd}: 24 hours`));
  assert.match(page._SCRIPT, new RegExp(`'signals-pass':${SIGNALS_PASS.usd},'signals-day-pass':${SIGNALS_DAY_PASS.usd}`));
  assert.match(page._SCRIPT, /const SIGNALS_ROUTES=\["\/api\/morning-brief"/);
  assert.ok(page._SCRIPT.includes(`const SIGNALS_ROUTES=${JSON.stringify(SIGNALS_PASS.allow)}`), 'the page knows every covered route');
  assert.match(page.HTML, /The signals pass is the same flat terms for 30 days \(or 24 hours\)/);
  assert.match(page.CSP, /sha256-/, 'the CSP hash still covers the edited script');
  const crypto = require('crypto');
  assert.ok(page.CSP.includes(crypto.createHash('sha256').update(page._SCRIPT, 'utf8').digest('base64')), 'the script hash in the CSP is the hash of the script served');
});

test('signal routes: a bot polling signal-board every 60 s is admitted every time; one call 1 ms early is a 429 with retry_after 1 (not counted); the pace is per route', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = await activePass(s);
  const h = { 'x-agentfeed-key': key };
  assert.equal((await s.get('/api/signal-board', h)).status, 200);
  for (let i = 0; i < 4; i++) {
    s.clock.t += 60_000;                                               // exactly the pace
    assert.equal((await s.get('/api/signal-board?n=30', h)).status, 200, `poll ${i + 2} at +60 s`);
  }
  s.clock.t += 59_999;
  const early = await s.get('/api/signal-board', h);
  assert.equal(early.status, 429);
  assert.equal(early.headers.get('retry-after'), '1');
  const j = await early.json();
  assert.equal(j.retry_after, 1);
  assert.match(j.error, /^this signals pass answers \/api\/signal-board one call every 60 s per key \(1 a minute\)\. Retry in 1 s\./);
  assert.equal((await s.get('/api/market-state', h)).status, 200, 'another covered route has its own clock');
  await flush();
  assert.equal(s.K.store.get(hashKey(key)).calls, 6, 'five polls and the market-state call; the early one was not counted');
  s.clock.t += 1;
  assert.equal((await s.get('/api/signal-board', h)).status, 200, 'and one millisecond later it is admitted');
});
test('coin-signal with a real coin is admitted and draws nothing; the clock is the route\'s, so a second coin inside 60 s is a 429, and signal-board?coins= is the way to read several', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = await activePass(s, SIGNALS_DAY_PASS);
  const h = { 'x-agentfeed-key': key };
  const first = await s.get('/api/coin-signal/BTC', h);
  assert.equal(first.status, 200);
  s.clock.t += 20_000;
  const second = await s.get('/api/coin-signal/ETH', h);
  assert.equal(second.status, 429, 'one clock for every coin');
  assert.equal(second.headers.get('retry-after'), '40');
  assert.match((await second.json()).error, /answers \/api\/coin-signal\/\{coin\} one call every 60 s/);
  assert.equal((await s.get('/api/signal-board?coins=BTC,ETH,SOL', h)).status, 200);
  await flush();
  const row = s.K.store.get(hashKey(key));
  assert.equal(row.spent_micro, 0);
  assert.equal(row.balance_micro, 0);
  assert.equal(s.rows.filter((r) => r.status === 'key' && r.tool === 'get_coin_signal').length, 1);
});
test('every covered signal route is on the instance\'s own price table at the pattern the pass stores (a pass row\'s allow must be a priced pattern or it can never match)', () => {
  const { PRICES: REAL } = require('../payments');
  for (const r of SIGNALS_PASS.allow) assert.ok(REAL[`GET ${r}`], `${r} is a priced route`);
  assert.equal(REAL['GET /api/coin-signal/:coin'].tool, 'get_coin_signal');
});
test('the signal tools over MCP: a pass key is good on market-state and the paced clock is shared with REST', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = await activePass(s, SIGNALS_DAY_PASS);
  const row = s.K.store.get(hashKey(key));
  const mk = () => ({ afKey: { presented: true, active: true, row: { ...row, prefix: key.slice(4, 12) }, hash: hashKey(key) }, headers: {}, callerIp: '127.0.0.1' });
  const run = async (name) => s.K.mcpWrap(mk(), { name, usd: 0.02 })(async () => ({ content: [{ type: 'text', text: '{}' }] }))({}, {});
  assert.ok(!(await run('get_market_state')).isError);
  assert.ok(!(await run('get_coin_signal')).isError, 'coin-signal over MCP is admitted too');
  const paced = await run('get_market_state');
  assert.equal(paced.isError, true);
  assert.match(paced.content[0].text, /one call every 60 s/);
  assert.equal((await s.get('/api/market-state', { 'x-agentfeed-key': key })).status, 429, 'the same clock over REST');
});
