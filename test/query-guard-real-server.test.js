// R20f (29 Oct 2026): the property that makes a pre-paywall guard safe: WHATEVER THE GUARD REFUSES, THE HANDLER REFUSES TOO, with the same sentence.
//
// Two copies of the REAL server.js run side by side (test/helpers/real-server.js: stub facilitator, every outbound connection refused, scratch DBs):
//   A  the guard on (the default): an unpaid request. A refused value answers 400 {charged:false, param}; any other value answers the 402 challenge.
//   B  AF_QUERY_GUARD=off: the same request with a prepaid key, so it reaches the handler, which answers for itself.
// For every rule of lib/query-rules.js the test sends a battery of boundary values to both (the edge, one step outside, the Number() quirks, words in
// other cases, the rule's own ok/bad samples) and requires: A refused  =>  B is a 400 carrying the very same error text. A value the guard lets
// through is the handler's business (a handler may refuse more: existence, upstream state), so that direction is not asserted, except that a
// guard which refuses nothing at all would pass this test trivially: every rule must refuse at least one value of its battery.
//
// Some handlers check a parameter only AFTER an upstream call (sec-filings limit and form, insider-trades days: the ticker lookup comes first) or need
// state the harness does not have (liq-feed's tape, tradfi-radar's snapshot). The first two are proven in-process below with a stubbed EDGAR; the others
// are listed in UNREACHABLE and the test fails if the list changes, so a new unreachable rule cannot hide.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const H = require('./helpers/real-server');
const { PRICES } = require('../payments');
const META = require('../bazaar-examples.json').routes;
const { QUERY_RULES } = require('../lib/query-rules');

// handler outcome cannot be observed through the harness for these (route + rule name)
const UNREACHABLE = new Set([
  'GET /api/sec-filings limit', 'GET /api/sec-filings form', 'GET /api/insider-trades days',   // validated after the EDGAR ticker lookup: in-process test below
  'GET /api/liq-feed since', 'GET /api/liq-feed next',                                           // needs the liquidation tape
  'GET /api/tradfi-radar class',                                                                 // needs the tradfi snapshot
  'GET /api/funding-radar min_oi_usd',                                                           // checked after the snapshot read; the harness has no snapshot
]);

let A; let B; let key;
let ipN = 0;
const ip = () => { ipN++; return { 'cf-connecting-ip': `198.21.${(ipN >> 8) & 255}.${ipN & 255}`, 'cf-ipcountry': 'DE' }; };

before(async () => {
  A = await H.boot();
  B = await H.boot({ AF_QUERY_GUARD: 'off' });
  const { newKey, hashKey } = require('../lib/keys');
  key = newKey();
  const d = B.db();
  try {
    d.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, spent_micro, calls, created, rate_per_min, label) VALUES (?, ?, 'active', 900000000000, 900000000000, 0, 0, ?, 1000000, 'query-guard test')`)
      .run(hashKey(key), key.slice(4, 12), Math.floor(Date.now() / 1000));
  } finally { d.close(); }
});
after(() => { if (A) A.close(); if (B) B.close(); });

const ctxNow = () => ({ now: Date.now() });
/** the values worth sending for one rule: strings (the rule's own parameter) or whole-query objects */
function battery(rule) {
  const hi = typeof rule.max === 'function' ? rule.max(ctxNow()) : rule.max;
  if (rule.kind === 'int') return [rule.min - 1, rule.min, hi, hi + 1, String(rule.min + 1), '1.5', 'abc', '1e1', '0x14', ' 30 ', '-0', '1e9', 'Infinity', String(hi) + '.0', ''].map(String);
  if (rule.kind === 'num') return [rule.min - 1, rule.min, hi, 'abc', '0.5', '1.5', 'Infinity', '-1e9', '1e30', ''].map(String);
  if (rule.kind === 'enum') return [...rule.values, ...rule.values.map((v) => v.toUpperCase()), ...rule.values.map((v) => ` ${v}`), 'nonsense', ''];
  return [...rule.samples.ok, ...rule.samples.bad];
}
const asQuery = (rule, sample) => (sample !== null && typeof sample === 'object' ? sample : { [rule.name]: sample });
function request(route, rule, sample) {
  const m = META[route];
  const base = { ...(m.input || {}) };
  let p = route.replace('GET ', '');
  for (const [k, v] of Object.entries(m.pathParams || {})) p = p.replace(':' + k, encodeURIComponent(v));
  // as=hex only makes sense with hex data (the cross-parameter rule is tested on its own); every other value keeps the published example
  const hexData = route === 'GET /api/hash' && rule.name === 'as' && String(sample).toLowerCase() === 'hex' ? { data: 'deadbeef' } : {};
  const qs = new URLSearchParams({ ...base, ...hexData, ...asQuery(rule, sample) }).toString();
  return p + (qs ? '?' + qs : '');
}
const json = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };

test('control: the two servers are the real thing, one with the query rules on and one with them off', async () => {
  const ra = await H.raw(A.port, 'GET', '/api/sec-8k?hours=0', ip());
  assert.equal(ra.status, 400);
  assert.equal(json(ra).charged, false);
  assert.equal(json(ra).param, 'hours');
  assert.ok(!ra.headers['payment-required'], 'A refuses before any challenge');
  const rb = await H.raw(B.port, 'GET', '/api/sec-8k?hours=0', ip());
  assert.equal(rb.status, 402, 'B has the rules off: the same request is asked to pay');
  const rb2 = await H.raw(B.port, 'GET', '/api/sec-8k?hours=0', { ...ip(), 'x-agentfeed-key': key });
  assert.equal(rb2.status, 400, 'and with a key the handler answers for itself');
  assert.equal(json(rb2).error, 'hours must be an integer from 1 to 72', 'with the sentence the guard uses');
  // the path rules stay on when the query rules are off
  assert.equal((await H.raw(B.port, 'GET', '/api/wallet-activity/notawallet', ip())).status, 400);
});

test('whatever the guard refuses, the handler refuses too, with the same sentence (every rule, every battery value)', async (t) => {
  const seen = { refused: 0, passed: 0, compared: 0 };
  const unreachable = new Set();
  const refusedBy = new Map();
  const comparedBy = new Map();
  for (const [route, list] of Object.entries(QUERY_RULES)) {
    assert.ok(PRICES[route]);
    for (const rule of list) {
      const id = `${route} ${rule.name}`;
      for (const sample of battery(rule)) {
        const url = request(route, rule, sample);
        const a = await H.raw(A.port, 'GET', url, ip());
        const ja = json(a);
        const guardRefused = a.status === 400 && ja.charged === false && ja.param === rule.name;
        if (!guardRefused) {
          seen.passed++;
          assert.ok(a.status === 402 || a.status === 400 || a.status === 200, `${id} ${JSON.stringify(sample)}: A answered ${a.status}`);
          continue;
        }
        seen.refused++;
        refusedBy.set(id, (refusedBy.get(id) || 0) + 1);
        assert.ok(!a.headers['payment-required'] && !a.headers['www-authenticate'], `${id} ${JSON.stringify(sample)}: a refusal carries no challenge`);
        const b = await H.raw(B.port, 'GET', url, { ...ip(), 'x-agentfeed-key': key });
        const jb = json(b);
        if (b.status === 400 && jb.error === ja.error) { seen.compared++; comparedBy.set(id, (comparedBy.get(id) || 0) + 1); continue; }
        if (UNREACHABLE.has(id) && b.status !== 400) { unreachable.add(id); continue; }
        if (UNREACHABLE.has(id) && b.status === 400 && jb.error !== ja.error) { unreachable.add(id); continue; }
        assert.fail(`${id} ${JSON.stringify(sample)}: the guard refused (${JSON.stringify(ja.error)}) but the handler answered ${b.status} ${JSON.stringify(jb.error || b.body.slice(0, 100))}`);
      }
    }
  }
  t.diagnostic(`refused ${seen.refused}, passed ${seen.passed}, compared with the handler ${seen.compared}, rules compared ${[...comparedBy.keys()].length} of ${Object.values(QUERY_RULES).reduce((a, l) => a + l.length, 0)}, unreachable ${[...unreachable].join('; ')}`);
  assert.ok(seen.refused >= 140 && seen.passed >= 100, `control: the battery is not trivial (${JSON.stringify(seen)})`);
  assert.ok(seen.compared >= 110, `control: ${seen.compared} refusals were compared with the handler's own answer`);
  // every rule refuses something, or this test would pass for a guard that does nothing
  for (const [route, list] of Object.entries(QUERY_RULES)) for (const rule of list) assert.ok(refusedBy.get(`${route} ${rule.name}`) > 0, `${route} ${rule.name}: the guard refuses at least one battery value`);
  // the unreachable list is exact: a rule hides there only if the harness really cannot see its handler answer, and every other rule was compared at least once
  assert.deepEqual([...UNREACHABLE].filter((id) => comparedBy.get(id)), [], 'listed unreachable, but the harness did compare them: remove them from UNREACHABLE');
  assert.deepEqual([...refusedBy.keys()].filter((id) => !UNREACHABLE.has(id) && !comparedBy.get(id)), [], 'a rule that refuses values must have been compared with its handler at least once');
  assert.ok(unreachable.size <= UNREACHABLE.size);
});

test('a value the handler serves is never refused: every ok sample, every in-range edge, and the published examples reach the 402', async () => {
  let n = 0;
  for (const [route, list] of Object.entries(QUERY_RULES)) {
    for (const rule of list) {
      const oks = [];
      if (rule.kind === 'int' || rule.kind === 'num') { const hi = typeof rule.max === 'function' ? rule.max(ctxNow()) : rule.max; oks.push(String(rule.min), String(hi)); if (rule.kind === 'int') oks.push(`${rule.min}.0`, `0x${rule.min.toString(16)}`); }
      if (rule.kind === 'enum') oks.push(...rule.values, ...rule.values.map((v) => v.toUpperCase()));
      if (rule.kind === 'custom') oks.push(...rule.samples.ok);
      for (const sample of oks) {
        const a = await H.raw(A.port, 'GET', request(route, rule, sample), ip());
        n++;
        assert.equal(a.status, 402, `${route} ${rule.name}=${JSON.stringify(sample)} must reach the paywall (${a.status} ${a.body.slice(0, 120)})`);
        assert.ok(a.headers['payment-required'], 'with its challenge');
      }
    }
  }
  assert.ok(n >= 100, `control: ${n} servable values`);
  for (const [route, m] of Object.entries(META)) {
    if (!QUERY_RULES[route]) continue;
    let p = route.replace('GET ', '');
    for (const [k, v] of Object.entries(m.pathParams || {})) p = p.replace(':' + k, encodeURIComponent(v));
    const qs = new URLSearchParams(m.input || {}).toString();
    assert.equal((await H.raw(A.port, 'GET', p + (qs ? '?' + qs : ''), ip())).status, 402, `${route}: the published example`);
    assert.equal((await H.raw(A.port, 'GET', p, ip())).status, 402, `${route}: the query-less URL every catalogue lists`);
  }
});

test('the refusal costs nothing on any rail: no challenge, no facilitator call, no key reserve, no handler run, no calls row', async () => {
  A.fac.log.length = 0;
  const handlers = A.handlerRuns().length;
  const net = A.netAttempts().length;
  const before = (await H.rowsSince(A, 0)).length;
  for (let i = 0; i < 5; i++) {
    const r = await H.raw(A.port, 'GET', '/api/sol-token-flow/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263?swaps=5', {
      ...ip(), 'x-payment': H.b64(H.payV1()), 'payment-signature': 'x', authorization: 'Payment x' });
    assert.equal(r.status, 400);
  }
  assert.deepEqual(A.fac.log, [], 'the facilitator was asked nothing, even with payment headers on the request');
  assert.equal(A.handlerRuns().length, handlers, 'no handler ran');
  assert.equal(A.netAttempts().length, net, 'and nothing went out');
  const rows = (await H.rowsSince(A, 0)).slice(before);
  assert.deepEqual(rows.filter((r) => /sol-token-flow/.test(r.req_path || '')), [], 'a refusal writes no per-request row');
  const d = A.db();
  try { assert.ok(d.prepare("SELECT SUM(n) n FROM param_rejected WHERE kind = 'query' AND route = 'get_sol_token_flow'").get().n >= 5, 'the refusals are counted'); } finally { d.close(); }
});

test('prepaid key: a refused query value never reserves; a servable one that fails in the handler is refunded (control)', async () => {
  // server A has the rules on; give it a key too
  const { newKey, hashKey } = require('../lib/keys');
  const k = newKey(); const hash = hashKey(k);
  const d = A.db();
  try {
    d.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, spent_micro, calls, created, rate_per_min, label) VALUES (?, ?, 'active', 1000000, 1000000, 0, 0, ?, 120, 'query-guard test')`).run(hash, k.slice(4, 12), Math.floor(Date.now() / 1000));
  } finally { d.close(); }
  const read = () => { const c = A.db(); try { return c.prepare('SELECT balance_micro, spent_micro, calls FROM api_keys WHERE key_hash = ?').get(hash); } finally { c.close(); } };
  const settle = async () => { let a = read(); for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 150)); const b = read(); if (JSON.stringify(a) === JSON.stringify(b)) return b; a = b; } return a; };
  const b0 = await settle();
  for (const u of ['/api/sec-8k?hours=0', '/api/hash?alg=md5&data=x', '/api/fx-rates?base=EURO']) assert.equal((await H.raw(A.port, 'GET', u, { ...ip(), 'x-agentfeed-key': k })).status, 400, u);
  assert.deepEqual(await settle(), b0, 'nothing reserved, nothing billed, no call counted');
  const ok = await H.raw(A.port, 'GET', '/api/hash?alg=SHA256&data=hello', { ...ip(), 'x-agentfeed-key': k });
  assert.equal(ok.status, 200, `control: a servable value is served (${ok.body.slice(0, 100)})`);
  const b1 = await settle();
  assert.ok(b1.balance_micro < b0.balance_micro && b1.calls === 1, 'and billed');
});

test('in-process, EDGAR stubbed: sec-filings limit and form, insider-trades days (checked after the ticker lookup) agree with the guard', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => ({ ok: true, status: 200, json: async () => (/company_tickers/.test(url)
    ? { 0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } }
    : { name: 'Apple Inc.', sic: '3571', sicDescription: 'Electronic Computers', filings: { recent: { accessionNumber: [], form: [], filingDate: [], reportDate: [], primaryDocument: [], primaryDocDescription: [] } } }), text: async () => '' });
  try {
    const sec = require('../tools/sec');
    const { checkQuery } = require('../lib/query-rules');
    let compared = 0; let refused = 0;
    for (const [route, rule, fn] of [['GET /api/sec-filings', 'limit', sec.getSecFilings], ['GET /api/sec-filings', 'form', sec.getSecFilings], ['GET /api/insider-trades', 'days', sec.getInsiderTrades]]) {
      const r = QUERY_RULES[route].find((x) => x.name === rule);
      for (const sample of battery(r)) {
        const q = { ticker: 'AAPL', ...asQuery(r, sample) };
        const verdict = checkQuery(route, q, ctxNow());
        let handler = null;
        try { await fn(q); } catch (e) { handler = e; }
        const handlerRefused = !!(handler && handler.kind === 'bad_request');
        if (verdict) {
          refused++;
          assert.ok(handlerRefused, `${route} ${rule}=${JSON.stringify(sample)}: the guard refuses, the handler answered ${handler ? handler.message : 'a result'}`);
          if (verdict.rule.name === rule) { assert.equal(handler.message, verdict.message, 'same sentence'); compared++; }
        }
      }
    }
    assert.ok(refused >= 15 && compared >= 15, `control: ${refused} refusals, ${compared} sentences compared`);
    // and a servable value is served by the handler too
    assert.ok(await sec.getSecFilings({ ticker: 'AAPL', limit: '50', form: '10-K' }));
    assert.ok(await sec.getInsiderTrades({ ticker: 'AAPL', days: '180' }));
  } finally { global.fetch = realFetch; }
});
