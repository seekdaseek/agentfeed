'use strict';
// R3: honeypot simulation helpers, Base launch log parsing and V4 position math, the
// launch-odds / rwa-yields / base-launches contracts (stale = 503, untracked = 422,
// bad input = 400 before any upstream call), and the 422 emitter in lib/tool.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const V = require('viem');
const express = require('express');

const tmp = (name) => path.join(os.tmpdir(), `r3-${process.pid}-${name}`);

// ---- Base launch collector: log parsing against viem's own event decoder ----
test('pool-creation logs parse to the same fields viem decodes from the raw log', () => {
  const C = require('../bin/base-launches-collect.js');
  const fx = require('./fixtures/base-pool-logs.json');
  const EVENTS = V.parseAbi([
    'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
    'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
    'event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)',
  ]);
  const AERO = V.parseAbi(['event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256 poolCount)']);
  assert.ok(Object.keys(fx).length >= 3, 'fixtures present');
  for (const [kind, { log }] of Object.entries(fx)) {
    const p = C.parseCreate(log);
    assert.equal(p.kind, kind);
    const ev = V.decodeEventLog({ abi: kind === 'aerodrome-v2' ? AERO : EVENTS, data: log.data, topics: log.topics });
    const a = ev.args;
    if (kind === 'uniswap-v4') {
      assert.equal(p.pool_id, a.id.toLowerCase());
      assert.equal(p.token0, a.currency0.toLowerCase()); assert.equal(p.token1, a.currency1.toLowerCase());
      assert.equal(p.fee, a.fee); assert.equal(p.tick_spacing, a.tickSpacing); assert.equal(p.hooks, a.hooks.toLowerCase());
    } else if (kind === 'uniswap-v3') {
      assert.equal(p.pool_id, a.pool.toLowerCase()); assert.equal(p.fee, a.fee); assert.equal(p.tick_spacing, a.tickSpacing);
    } else if (kind === 'uniswap-v2') {
      assert.equal(p.pool_id, a.pair.toLowerCase());
    } else {
      assert.equal(p.pool_id, a.pool.toLowerCase()); assert.equal(Boolean(p.stable), a.stable);
    }
    assert.equal(p.token0, String(a.token0 || a.currency0).toLowerCase());
  }
});

test('V4 quote side from positions: below, inside and above the current price', () => {
  const { v4QuoteAmount } = require('../bin/base-launches-collect.js');
  const sAt = (t) => Math.pow(1.0001, t / 2);
  const X96 = (s) => BigInt(Math.round(s * 2 ** 96));
  const L = 1e18;
  // quote is token1: a range wholly below the price holds only token1 = L * (sb - sa)
  const below = v4QuoteAmount([{ tl: -200, tu: -100, liq: L }], X96(sAt(0)), true);
  assert.ok(Math.abs(below - L * (sAt(-100) - sAt(-200))) / below < 1e-9);
  // a range wholly above the price holds only token0: no quote
  assert.equal(v4QuoteAmount([{ tl: 100, tu: 200, liq: L }], X96(sAt(0)), true), 0);
  // straddling: L * (s - sa)
  const inside = v4QuoteAmount([{ tl: -100, tu: 100, liq: L }], X96(sAt(0)), true);
  assert.ok(Math.abs(inside - L * (1 - sAt(-100))) / inside < 1e-6);
  // quote is token0: mirror image, and removed liquidity (sum 0) contributes nothing
  const t0 = v4QuoteAmount([{ tl: 100, tu: 200, liq: L }, { tl: -50, tu: 50, liq: 0 }], X96(sAt(0)), false);
  assert.ok(Math.abs(t0 - L * (1 / sAt(100) - 1 / sAt(200))) / t0 < 1e-9);
});

// ---- honeypot helpers ----
test('bytecode selector scan skips PUSH data and finds real PUSH4 selectors', () => {
  const H = require('../tools/honeypot');
  // PUSH32 whose data contains 63 40c10f19 (a fake PUSH4 mint), then a real PUSH4 8456cb59 (pause)
  const code = '0x7f' + '63' + '40c10f19' + '00'.repeat(27) + '63' + '8456cb59' + '14';
  const s = H._push4s(code);
  assert.ok(s.has('8456cb59'));
  assert.ok(!s.has('40c10f19'), 'bytes inside PUSH32 data are not opcodes');
});

test('revert data decodes: Error(string), Panic, OpenZeppelin balance error, unknown selector', () => {
  const H = require('../tools/honeypot');
  const err = V.encodeAbiParameters([{ type: 'string' }], ['TRANSFER_FAILED']);
  assert.equal(H._decodeRevert('0x08c379a0' + err.slice(2)).reason, 'TRANSFER_FAILED');
  assert.equal(H._decodeRevert('0x4e487b71' + V.encodeAbiParameters([{ type: 'uint256' }], [0x11n]).slice(2)).reason, 'panic 0x11');
  const ozb = V.encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], ['0x000000000000000000000000000000000000a402', 5n, 2n ** 256n - 1n]);
  assert.match(H._decodeRevert('0xe450d38c' + ozb.slice(2)).reason, /ERC20InsufficientBalance: 0x0+A402 has 5, needs 1157920/i);
  assert.equal(H._decodeRevert('0xdeadbeef').reason, 'custom error 0xdeadbeef');
  assert.equal(H._decodeRevert('0x').reason, 'reverted without a reason');
});

test('verdicts: sellable, high tax, extreme tax, not sellable, buy failed, no pool', () => {
  const H = require('../tools/honeypot');
  const leg = (ok, sent, arrived, received) => ({ ok, sent, arrived, received, err: '0x', gasUsed: 1n });
  const v = (buy, sell) => H._verdictOf({ r: { buy, sell, transferOk: true } }).verdict;
  assert.equal(v(leg(true, 100n, 1000n, 1000n), leg(true, 990n, 990n, 95n)), 'sellable');
  assert.equal(v(leg(true, 100n, 1000n, 880n), leg(true, 870n, 870n, 80n)), 'high_tax');   // 12% buy tax
  assert.equal(v(leg(true, 100n, 1000n, 1000n), leg(true, 990n, 400n, 30n)), 'extreme_tax'); // 60% sell tax
  assert.equal(v(leg(true, 100n, 1000n, 1000n), leg(true, 990n, 50n, 1n)), 'not_sellable');  // 95% sell tax
  assert.equal(v(leg(true, 100n, 1000n, 1000n), leg(false, 990n, 0n, 0n)), 'not_sellable');
  assert.equal(v(leg(false, 100n, 0n, 0n), leg(false, 0n, 0n, 0n)), 'buy_failed');
  assert.equal(H._verdictOf(null).verdict, 'no_pool_found');
});

test('honeypot-check refuses bad input before any network call', async () => {
  const H = require('../tools/honeypot');
  const realFetch = global.fetch; let calls = 0;
  global.fetch = async () => { calls++; throw new Error('no network in this test'); };
  try {
    for (const a of [{}, { token: '0x12' }, { token: '4ed4E862860beD51a9570b96d89aF5E1B0Efefed' }, { token: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', chain: 'solana' }]) {
      await assert.rejects(H.getHoneypotCheck(a), (e) => e.kind === 'bad_request');
    }
    assert.equal(calls, 0);
    // a node failure on every RPC is a 503, never a 400
    await assert.rejects(H.getHoneypotCheck({ token: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed' }), (e) => e.status === 503);
  } finally { global.fetch = realFetch; }
});

// ---- base-launches route ----
test('base-launches: fresh snapshot filters and limits; stale is 503; bad numbers are 400', () => {
  const file = tmp('bl.json');
  process.env.BASE_LAUNCHES_SNAPSHOT = file;
  delete require.cache[require.resolve('../tools/baselaunches')];
  const BL = require('../tools/baselaunches');
  const launches = [{ pool: 'a', quote_liquidity_usd: 5000 }, { pool: 'b', quote_liquidity_usd: 10 }, { pool: 'c', quote_liquidity_usd: null }];
  const now = Date.parse('2026-10-12T05:00:00Z');
  fs.writeFileSync(file, JSON.stringify({ as_of: '2026-10-12T04:58:00Z', head_block: 1, window_hours: 24, counts: {}, launches }));
  try {
    const r = BL.getBaseLaunches({}, { now });
    assert.deepStrictEqual(r.launches.map((l) => l.pool), ['a'], 'default floor $1,000');
    assert.equal(BL.getBaseLaunches({ min_liq_usd: '0', limit: '2' }, { now }).launches.length, 2);
    assert.throws(() => BL.getBaseLaunches({ limit: 0 }, { now }), (e) => e.kind === 'bad_request');
    assert.throws(() => BL.getBaseLaunches({ min_liq_usd: 'x' }, { now }), (e) => e.kind === 'bad_request');
    assert.throws(() => BL.getBaseLaunches({}, { now: now + 4 * 60000 }), (e) => e.status === 503);
  } finally { fs.unlinkSync(file); delete process.env.BASE_LAUNCHES_SNAPSHOT; }
});

// ---- R4: withdrawn routes ----
test('the four routes withdrawn on 12 Oct and still gone answer a neutral 410 on any method, with a pointer to /pricing (rwa-yields came back in R24; the R7 withdrawals are in r7.test.js)', async (t) => {
  const compat = require('../lib/compat');
  const app = express();
  const FIVE = ['/api/tvl', '/api/stablecoin-flows', '/api/launch-odds', '/api/dex-quote'];
  for (const p of compat.WITHDRAWN) app.all(p, compat.makeWithdrawn({ ORIGIN: 'https://x' }));
  const srv = app.listen(0); t.after(() => srv.close()); const u = `http://127.0.0.1:${srv.address().port}`;
  assert.deepStrictEqual(compat.WITHDRAWN.slice(0, 4), FIVE);
  assert.ok(!compat.WITHDRAWN.includes('/api/rwa-yields'), 'rwa-yields is served again (R24)');
  for (const p of FIVE) {
    for (const method of ['GET', 'POST']) {
      const r = await fetch(u + p, { method });
      assert.equal(r.status, 410, `${method} ${p}`);
      assert.deepStrictEqual(await r.json(), { error: 'gone', status: 'withdrawn', route: p, withdrawn: '2026-10-12', pricing: 'https://x/pricing' });
    }
  }
});

test('withdrawn routes and sources are gone from the price table and the eth-price venues', () => {
  const { PRICES } = require('../payments');
  for (const k of ['GET /api/tvl', 'GET /api/stablecoin-flows', 'GET /api/launch-odds', 'GET /api/dex-quote']) assert.ok(!(k in PRICES), k);
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'tools', 'prices.js'), 'utf8');
  for (const host of ['api.coingecko.com', 'coins.llama.fi', 'api.coinpaprika.com', 'hermes.pyth.network/v2/updates']) assert.ok(!src.includes(host), host);
});
