// R20h (30 Oct 2026): getTokenLargestAccounts is routed past the public RPC (which refuses it with a per-method 429, always), cached 90 s per mint and shared by
// concurrent callers (lib/rpc-heavy.js, wired in lib/solrpc.js). Unit level: the host filter, the cache, and the routing against loopback stubs that behave like
// the providers measured on 30 Oct (test/helpers/rpc-stub.js). test/rpc-burst-real-server.test.js proves the same on the real server under a burst.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const RH = require('../lib/rpc-heavy');
const SR = require('../lib/solrpc');
const { startRpcStub } = require('./helpers/rpc-stub');

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

test('which hosts a heavy method may go to: the Solana Labs public hosts are skipped, a keyed provider and Helius are not', () => {
  const urls = ['https://mainnet.helius-rpc.com/?api-key=x', 'https://solana-mainnet.g.alchemy.com/v2/KEY', 'https://api.mainnet-beta.solana.com', 'https://api.mainnet.solana.com/'];
  assert.deepEqual(RH.heavyUrls(urls, {}), urls.slice(0, 2), 'default: both public hosts out, order kept');
  assert.deepEqual(RH.heavyUrls(urls, { RPC_HEAVY_SKIP: '' }), urls, 'an empty RPC_HEAVY_SKIP skips nothing');
  assert.deepEqual(RH.heavyUrls(urls, { RPC_HEAVY_SKIP: 'solana-mainnet.g.alchemy.com' }), [urls[0], urls[2], urls[3]], 'an explicit list replaces the default');
  assert.deepEqual(RH.heavyUrls(['http://127.0.0.1:9/a', 'http://127.0.0.1:10/a'], { RPC_HEAVY_SKIP: '127.0.0.1:10' }), ['http://127.0.0.1:9/a'], 'host:port matches');
  assert.deepEqual(RH.heavyUrls(['not a url', urls[0]], {}), [urls[0]], 'a URL that does not parse is never an endpoint');
  assert.ok(RH.HEAVY_METHODS.has('getTokenLargestAccounts') && !RH.HEAVY_METHODS.has('getAccountInfo'), 'only the measured method is heavy: the public RPC serves the rest');
});

test('the cache: one call for twenty concurrent identical callers, a copy each, a failure shared but never kept, expiry, a size cap', async () => {
  let t = 1000;
  const c = new RH.SingleFlightCache({ ttlMs: 90_000, max: 3, now: () => t });
  let calls = 0;
  const slow = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { value: [{ a: 1 }] }; };
  const got = await Promise.all(Array.from({ length: 20 }, () => c.run('k', slow)));
  assert.equal(calls, 1, 'twenty concurrent callers, one upstream call');
  assert.equal(c.shared, 19);
  got[0].value[0].a = 99;
  assert.equal((await c.run('k', slow)).value[0].a, 1, 'a caller that mutates its answer cannot change the cached one');
  assert.equal(calls, 1, 'and the next call is a hit');
  t += 90_001;
  await c.run('k', slow);
  assert.equal(calls, 2, 'after the TTL it asks again');
  // failures
  let fails = 0;
  const bad = async () => { fails++; await new Promise((r) => setTimeout(r, 10)); throw new Error('upstream 429'); };
  const settled = await Promise.allSettled([c.run('f', bad), c.run('f', bad), c.run('f', bad)]);
  assert.equal(fails, 1, 'concurrent callers share one failing call');
  assert.ok(settled.every((s) => s.status === 'rejected' && /upstream 429/.test(s.reason.message)));
  await assert.rejects(c.run('f', bad));
  assert.equal(fails, 2, 'a failure is not cached: the next caller asks again');
  // size cap
  for (const k of ['a', 'b', 'c', 'd']) await c.run(k, async () => k);
  assert.ok(c.values.size <= 3, `at most 3 keys kept (${c.values.size})`);
});

async function withEnv(env, fn) {
  const keep = {};
  for (const k of Object.keys(env)) { keep[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  SR._reset();
  try { return await fn(); } finally { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } SR._reset(); }
}
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

test('routing: with a keyed provider a burst of 30 for one mint is ONE call to it, and the public RPC is never asked', async () => {
  const primary = await startRpcStub({ mode: 'capped' });
  const keyed = await startRpcStub({ mode: 'ok' });
  const pub = await startRpcStub({ mode: 'public', refuse: ['getTokenLargestAccounts'] });
  try {
    await quiet(() => withEnv({ SOLANA_RPC_URL: primary.url, HELIUS_API_KEY: undefined, RPC_FALLBACKS: `${keyed.url},${pub.url}`, RPC_HEAVY_SKIP: pub.host }, async () => {
      const results = await Promise.all(Array.from({ length: 30 }, () => SR.rpc('getTokenLargestAccounts', [MINT])));
      assert.ok(results.every((r) => r.value.length === 3), 'all 30 got the ranking');
      assert.equal(keyed.count('getTokenLargestAccounts'), 1, 'one call reached the keyed provider');
      assert.equal(pub.count('getTokenLargestAccounts'), 0, 'the public RPC was never asked for it');
      assert.ok(primary.count('getTokenLargestAccounts') <= 1, `the capped primary was tried at most once (${primary.count('getTokenLargestAccounts')})`);
      await SR.rpc('getTokenLargestAccounts', [MINT]);
      assert.equal(keyed.count('getTokenLargestAccounts'), 1, 'the next call within 90 s is a cache hit');
      // every other method still uses the full list: the capped primary falls through to the keyed provider
      assert.ok((await SR.rpc('getAccountInfo', [MINT, { encoding: 'jsonParsed' }])).value, 'getAccountInfo is answered');
      assert.equal(keyed.count('getAccountInfo'), 1);
    }));
  } finally { primary.close(); keyed.close(); pub.close(); }
});

test('routing: with NO keyed provider (today) a heavy call is a 503 "Not charged" from the primary alone, the public RPC is not asked and not put to rest', async () => {
  const primary = await startRpcStub({ mode: 'capped' });
  const pub = await startRpcStub({ mode: 'public', refuse: ['getTokenLargestAccounts'] });
  try {
    await quiet(() => withEnv({ SOLANA_RPC_URL: primary.url, HELIUS_API_KEY: undefined, RPC_FALLBACKS: pub.url, RPC_HEAVY_SKIP: pub.host }, async () => {
      const errs = await Promise.allSettled(Array.from({ length: 10 }, () => SR.rpc('getTokenLargestAccounts', [MINT])));
      assert.ok(errs.every((e) => e.status === 'rejected' && e.reason.status === 503 && e.reason.transport && /Not charged/.test(e.reason.message)), 'every one is a 503, not charged');
      assert.equal(pub.count('getTokenLargestAccounts'), 0, 'the public RPC was not asked for what it always refuses');
      assert.ok(SR.endpoints().isUp(pub.url), 'and it was not put to rest: it still serves everything else');
      assert.ok((await SR.rpc('getAccountInfo', [MINT, { encoding: 'jsonParsed' }])).value, 'getAccountInfo is answered by the public RPC');
      assert.equal(pub.count('getAccountInfo'), 1);
    }));
  } finally { primary.close(); pub.close(); }
});

test('routing: the heavy list shares the main list\'s rest state and counters: a primary found capped by one call is not asked again by the other, and one usage report counts both', async () => {
  const primary = await startRpcStub({ mode: 'capped' });
  const keyed = await startRpcStub({ mode: 'ok' });
  try {
    await quiet(() => withEnv({ SOLANA_RPC_URL: primary.url, HELIUS_API_KEY: undefined, RPC_FALLBACKS: keyed.url, RPC_HEAVY_SKIP: '' }, async () => {
      await SR.rpc('getAccountInfo', [MINT, { encoding: 'jsonParsed' }]);                 // main list: the primary answers 429 and rests
      assert.equal(primary.total(), 1);
      await SR.rpc('getTokenLargestAccounts', [MINT]);                                    // heavy list: must not ask the resting primary
      assert.equal(primary.total(), 1, 'the primary was asked once in total, not once per list');
      assert.equal(keyed.count('getTokenLargestAccounts'), 1);
      const usage = SR.endpoints().takeUsage();
      assert.equal(usage.calls.getTokenLargestAccounts, 1, 'the one usage report counts the heavy call');
      assert.equal(usage.failovers, 1, 'and one failover event, not two');
      assert.equal(SR.endpoints().calls.size, 0, 'takeUsage reset the counters');
      await SR.rpc('getTokenLargestAccounts', [MINT]);                  // a cache hit: no new counted call
      assert.equal(SR.heavyCache.hits, 1);
    }));
  } finally { primary.close(); keyed.close(); }
});

test('routing: when no endpoint can serve a heavy method the answer is an immediate 503 that says so, with Retry-After 300', async () => {
  const pub = await startRpcStub({ mode: 'public', refuse: ['getTokenLargestAccounts'] });
  try {
    await quiet(() => withEnv({ SOLANA_RPC_URL: undefined, HELIUS_RPC: undefined, HELIUS_API_KEY: undefined, RPC_FALLBACKS: pub.url, RPC_HEAVY_SKIP: pub.host }, async () => {
      await assert.rejects(SR.rpc('getTokenLargestAccounts', [MINT]), (e) => e.status === 503 && e.transport === true && e.retryAfter === 300 && /Not charged/.test(e.message) && /no Solana RPC provider is configured/.test(e.message));
      assert.equal(pub.total(), 0, 'nothing was sent anywhere');
    }));
  } finally { pub.close(); }
});

test('an endpoint passed in by a test or a cron is used as given: no routing, no cache', async () => {
  const stub = await startRpcStub({ mode: 'ok' });
  try {
    const eps = SR.makeEndpoints({ name: 't', primary: stub.url, fallbacks: [], log: () => {} });
    await SR.rpc('getTokenLargestAccounts', [MINT], { endpoints: eps });
    await SR.rpc('getTokenLargestAccounts', [MINT], { endpoints: eps });
    assert.equal(stub.count('getTokenLargestAccounts'), 2);
  } finally { stub.close(); }
});
