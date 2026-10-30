// R20j (30 Oct 2026): the compute-unit budget toward a rate-limited provider (lib/rpc-throttle.js), getProgramAccounts kept off the hosts that refuse it
// (lib/rpc-heavy.js METHOD_RULES), and a pre-trade request that starts no new call once every endpoint has failed (tools/solpretrade.js ctx.rpc).
// What each guards against, measured on the box 30 Oct: one getProgramAccounts call on an idle Alchemy Free app is answered 429 "exceeded its compute units per second
// capacity" (and the 429 rested Alchemy for ten minutes for every method); one failing sol-token-flow request made about 390 calls across three hosts; and nothing bounded the
// total rate of calls to the keyed provider.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const RT = require('../lib/rpc-throttle');
const RH = require('../lib/rpc-heavy');
const SR = require('../lib/solrpc');
const SP = require('../tools/solpretrade');
const { startRpcStub } = require('./helpers/rpc-stub');

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const body = (method, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params: [] });

test('limits: Alchemy hosts get 240 CU/s by default, RPC_CUPS sets or removes limits, nothing else is limited', () => {
  const urls = ['https://mainnet.helius-rpc.com/?api-key=x', 'https://solana-mainnet.g.alchemy.com/v2/KEY', 'https://api.mainnet-beta.solana.com'];
  assert.deepEqual(RT.parseLimits({}, urls), { 'solana-mainnet.g.alchemy.com': 240 });
  assert.deepEqual(RT.parseLimits({ RPC_CUPS: 'solana-mainnet.g.alchemy.com=400, 127.0.0.1:9=50' }, urls), { 'solana-mainnet.g.alchemy.com': 400, '127.0.0.1:9': 50 });
  assert.deepEqual(RT.parseLimits({ RPC_CUPS: 'off' }, urls), {});
  assert.deepEqual(RT.parseLimits({ RPC_CUPS: 'bad=x,=5' }, ['https://api.mainnet-beta.solana.com']), {}, 'junk entries are ignored');
  assert.equal(RT.costOfBody(body('getAccountInfo')), 10);
  assert.equal(RT.costOfBody(body('getTokenLargestAccounts')), 20);
  assert.equal(RT.costOfBody(body('getTransaction')), 40);
  assert.equal(RT.costOfBody(body('somethingNew')), 20, 'a method not in the table costs 20');
  assert.equal(RT.costOfBody(JSON.stringify([{ method: 'getAccountInfo' }, { method: 'getTransaction' }])), 50, 'a batch costs the sum');
  assert.equal(RT.costOfBody('not json'), 20);
});

test('the budget: never more than cups in any second or 10 x cups in any ten seconds; excess waits; a call that cannot be admitted in time is refused; a huge single call is not starved', async () => {
  let t = 1_000_000;
  const sleep = async (ms) => { t += ms; };
  const th = new RT.CuThrottle({ cups: 100, now: () => t, sleep });
  const stamps = [];
  for (let i = 0; i < 40; i++) { assert.equal(await th.admit(20, 60_000), true); stamps.push(t); }      // 800 CU asked at once, 100 CU/s: at most 5 calls a second
  const perSec = new Map(); for (const s of stamps) perSec.set(Math.floor((s - stamps[0]) / 1000), (perSec.get(Math.floor((s - stamps[0]) / 1000)) || 0) + 1);
  assert.ok(Math.max(...perSec.values()) <= 5, `at most 5 x 20 CU in a second: ${[...perSec.values()]}`);
  assert.ok(th.peak1s <= 100 && th.peak10s <= 1000, `peaks ${th.peak1s} CU in a second, ${th.peak10s} in ten`);
  assert.ok(th.delayed > 0, 'and the excess was delayed, not dropped');
  // refusal: 60 callers at once, room for 5 in the 300 ms they are willing to wait (real clock)
  const th2 = new RT.CuThrottle({ cups: 100 });
  const verdicts = await Promise.all(Array.from({ length: 60 }, () => th2.admit(20, 300)));
  const admitted = verdicts.filter(Boolean).length, refused = verdicts.length - admitted;
  assert.ok(admitted >= 1 && admitted <= 5 && refused >= 55, `${admitted} admitted, ${refused} refused`);
  assert.ok(th2.peak1s <= 100 && th2.refused === refused, 'refusing never lets the second go over'); 
  // a single call dearer than a second's budget goes through alone
  const th3 = new RT.CuThrottle({ cups: 10, now: () => t, sleep });
  assert.equal(await th3.admit(40, 5000), true);
});

test('wrapFetch: a limited host is priced, an unlimited one passes straight through, and a refusal is a JSON-RPC error in a 200 that echoes the id (an answer: it rests nothing)', async () => {
  const sent = [];
  const real = async (url) => { sent.push(String(url)); return new Response('{"jsonrpc":"2.0","id":1,"result":1}', { status: 200 }); };
  let t = 5_000_000;
  const { fetch: f, throttles } = RT.wrapFetch(real, { 'limited.example': 20 }, { now: () => t, sleep: async (ms) => { t += ms; }, maxWaitMs: 50 });
  assert.equal((await f('https://free.example/x', { method: 'POST', body: body('getSlot') })).status, 200);
  assert.equal(throttles.size, 1);
  const r1 = await f('https://limited.example/x', { method: 'POST', body: body('getSlot', 7) });      // 20 CU = the whole second
  assert.equal((await r1.json()).result, 1);
  const r2 = await f('https://limited.example/x', { method: 'POST', body: body('getSlot', 8) });      // no room, 50 ms is not enough
  const j2 = await r2.json();
  assert.equal(r2.status, 200);
  assert.equal(j2.id, 8);
  assert.equal(j2.error.code, -32005);
  assert.match(j2.error.message, /client throttle/);
  assert.equal(sent.filter((u) => u.includes('limited.example')).length, 1, 'the refused call was never sent');
});

test('against a real loopback provider: 300 concurrent calls never put more than the budget on the wire, and the rest are 503 (not charged) without resting the provider', async () => {
  const stub = await startRpcStub({ mode: 'ok' });
  const pub = await startRpcStub({ mode: 'ok' });
  const keep = {}; const env = { SOLANA_RPC_URL: stub.url, HELIUS_API_KEY: undefined, RPC_FALLBACKS: pub.url, RPC_CUPS: `${stub.host}=200`, RPC_THROTTLE_MAX_WAIT_MS: '1500' };
  for (const k of Object.keys(env)) { keep[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  SR._reset();
  const log = console.log; console.log = () => {};
  try {
    const res = await Promise.allSettled(Array.from({ length: 300 }, () => SR.rpc('getAccountInfo', [MINT, { encoding: 'jsonParsed' }])));
    const ok = res.filter((r) => r.status === 'fulfilled').length;
    const bad = res.filter((r) => r.status === 'rejected');
    assert.equal(ok + bad.length, 300);
    assert.ok(ok > 0 && bad.length > 0, `${ok} answered, ${bad.length} refused by the budget`);
    assert.ok(bad.every((e) => e.reason.status === 503 && /throttle/.test(e.reason.message)), 'the refused ones are 503s that name the throttle');
    // the budget, from the throttle's own admission times (exact: the stub shares this event loop, so its arrival stamps skew by milliseconds): no rolling second above 200 CU
    // (= 20 calls of 10 CU), no rolling ten seconds above 2,000 CU
    const th = SR.getThrottle().throttles.get(stub.host);
    const rolling = (ms) => Math.max(...th.history.map(([t0]) => th.history.filter(([t]) => t >= t0 && t < t0 + ms).reduce((s, [, c]) => s + c, 0)));
    assert.ok(rolling(1000) <= 200, `peak CU in any rolling second admitted: ${rolling(1000)}`);
    assert.ok(rolling(10_000) <= 2000, `peak CU in any rolling ten seconds admitted: ${rolling(10_000)}`);
    // and on the wire over ten seconds, where the milliseconds of arrival skew of a stub in this process do not matter (10% tolerance)
    const wire10 = Math.max(...stub.hits.map((a) => stub.hits.filter((b) => b.t >= a.t && b.t < a.t + 10_000).length * 10));
    assert.ok(wire10 <= 2000 * 1.1, `peak CU in any rolling ten seconds at the provider: ${wire10}`);
    assert.equal(stub.total(), ok, 'every call that reached the provider was answered: nothing wasted');
    assert.ok(SR.endpoints().isUp(stub.url), 'refusing locally rested nothing');
    assert.equal(pub.total(), 0, 'and nothing was sent to the fallback either: a throttled call is an answer, not a failure');
  } finally { console.log = log; for (const k of Object.keys(env)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } SR._reset(); stub.close(); pub.close(); }
});

test('getProgramAccounts goes only to hosts that serve it: the public RPC and Alchemy Free are skipped, and a 429 from them can no longer rest the keyed provider', async () => {
  assert.ok(RH.HEAVY_METHODS.has('getProgramAccounts'));
  const urls = ['https://mainnet.helius-rpc.com/?api-key=x', 'https://solana-mainnet.g.alchemy.com/v2/KEY', 'https://api.mainnet-beta.solana.com'];
  assert.deepEqual(RH.heavyUrls(urls, {}, 'getProgramAccounts'), [urls[0]], 'by default only Helius is asked');
  assert.deepEqual(RH.heavyUrls(urls, {}, 'getTokenLargestAccounts'), urls.slice(0, 2), 'the ranking still goes to Alchemy');
  assert.deepEqual(RH.heavyUrls(urls, { RPC_PROGRAM_SKIP: '' }, 'getProgramAccounts'), urls, 'RPC_PROGRAM_SKIP= (empty) asks everyone, for the day Alchemy is on a plan that serves it');
  const primary = await startRpcStub({ mode: 'capped' });
  const alch = await startRpcStub({ mode: 'cups', refuse: ['getProgramAccounts'] });
  const pub = await startRpcStub({ mode: 'public', refuse: ['getProgramAccounts', 'getTokenLargestAccounts'] });
  const env = { SOLANA_RPC_URL: primary.url, HELIUS_API_KEY: undefined, RPC_FALLBACKS: `${alch.url},${pub.url}`, RPC_CUPS: 'off', RPC_PROGRAM_SKIP: `${alch.host},${pub.host}`, RPC_HEAVY_SKIP: pub.host };
  const keep = {}; for (const k of Object.keys(env)) { keep[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  SR._reset();
  const log = console.log; console.log = () => {};
  try {
    for (let i = 0; i < 5; i++) await assert.rejects(SR.rpc('getProgramAccounts', ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', {}]), (e) => e.status === 503);
    assert.equal(alch.count('getProgramAccounts'), 0, 'the keyed provider was never asked for what it refuses');
    assert.equal(pub.count('getProgramAccounts'), 0, 'nor was the public RPC');
    assert.ok(SR.endpoints().isUp(alch.url), 'so the keyed provider was not rested');
    const r = await SR.rpc('getTokenLargestAccounts', [MINT]);
    assert.equal(r.value.length, 3, 'and it still serves the ranking right after');
    assert.equal(alch.count('getTokenLargestAccounts'), 1);
  } finally { console.log = log; for (const k of Object.keys(env)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } SR._reset(); primary.close(); alch.close(); pub.close(); }
});

test('a pre-trade request that has seen every endpoint fail starts no new call (its answer is a 503 whatever else it reads)', async () => {
  let calls = 0;
  const outage = Object.assign(new Error('solana rpc http 429. Not charged.'), { status: 503, transport: true });
  const ctx = SP.makeCtx({ rpc: async () => { calls++; throw outage; }, budget: 100 });
  await assert.rejects(ctx.rpc('getAccountInfo', ['a']), (e) => e === outage);
  const first = calls;
  assert.ok(ctx.outage, 'the outage is remembered');
  for (const m of ['getMultipleAccounts', 'getProgramAccounts', 'getTransaction']) await assert.rejects(ctx.rpc(m, ['x']), (e) => e === outage);
  assert.equal(calls, first, `no new upstream call after the outage (${calls} calls in total, ${first} for the first one with its own retries)`);
});
