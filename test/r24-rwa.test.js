// R24 item 3: get_rwa_yields. The engine, the RPC client, the register and the route entry over a synthetic chain (test/fixtures/r24/rwa/chain.js). Nothing leaves the machine.
// Every fail-closed check has a CONTROL in the same test (the identical request without the fault is served), and ops/r24-rwa-mutate.js removes each check from a scratch copy and
// requires the matching test to fail.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const viem = require('viem');
const C = require('./fixtures/r24/rwa/chain');
const E = require('../tools/r24/rwa/evaluate');
const R = require('../tools/r24/rwa/rpc');
const RD = require('../tools/r24/rwa/reader');
const Y = require('../tools/r24/rwa/yield');
const P = require('../tools/r24/rwa/products');
const M = require('../tools/r24/rwa');

const A = 'https://rpc-a.example/v2/KEY-SECRET-123';
const B = 'https://rpc-b.example';
const iso = (s) => new Date(s * 1000).toISOString();
const caches = () => ({ history: E.makeStore(64, E.HISTORY_TTL_MS), blocks: E.makeStore(16, E.HISTORY_TTL_MS), answers: E.makeStore(16, E.ANSWER_TTL_MS), health: new Map() });

/** a client over the chain; endpoints = { url: { mode } } */
function setup(chainOpts = {}, endpoints = { [A]: { mode: 'ok' } }, rpcOpts = {}) {
  RD._decimalsMemo.clear();
  const chain = C.makeChain(chainOpts);
  const rpc = R.makeRpc({ endpoints: Object.keys(endpoints), fetchImpl: chain.fetchFor(endpoints), now: chain.clock, budget: 400, ...rpcOpts });
  const c = caches();
  return { chain, rpc, c, deps: { rpc, now: chain.clock, caches: c, snapshotDb: null } };
}
const all = () => P.served();
const run = (s, ids) => E.evaluate({ products: ids ? ids.map(P.byId) : all(), deps: s.deps });
const history = (s) => s.chain.calls.filter((c) => c.method === 'eth_call' && Number(BigInt(c.params[1])) < C.HEAD);

/** the request is refused with the 503 "Not charged" error, and the error carries no URL, key or remote text */
async function refused(s, ids, detail) {
  await assert.rejects(() => run(s, ids), (e) => {
    assert.equal(e.status, 503, `status (message: ${e.message})`);
    assert.match(e.message, /Not charged\.$/);
    assert.ok(Number(e.retryAfter) > 0);
    const dump = JSON.stringify({ ...e, message: e.message, stack: String(e.stack) });
    assert.ok(!/SECRET|rpc-a\.example|rpc-b\.example|https?:\/\//.test(dump), `no URL or key in the error: ${dump.slice(0, 200)}`);
    if (detail) assert.equal(e.detail, detail);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------- the register
test('register: ids are unique lower-case, addresses are EIP-55, every selector and calldata is what viem encodes, bands bracket the start price, docs are https', () => {
  assert.equal(new Set(P.PRODUCTS.map((p) => p.id)).size, P.PRODUCTS.length);
  for (const p of P.PRODUCTS) {
    assert.match(p.id, /^[a-z0-9]+$/);
    assert.equal(p.contract, viem.getAddress(p.contract), `${p.id}: checksum`);
    assert.ok(Number.isInteger(p.read.decimals) && p.read.decimals >= 6 && p.read.decimals <= 18);
    assert.ok(p.band[0] < p.startPrice && p.startPrice < p.band[1]);
    assert.ok(['simple', 'apy'].includes(p.convention) && P.CONVENTION[p.convention]);
    assert.ok(p.docs.length >= 1 && p.docs.every((u) => u.startsWith('https://')));
    assert.equal(p.chain, 'ethereum'); assert.equal(p.chainId, 1);
    if (p.read.kind === 'uint') assert.match(p.read.data, /^0x[0-9a-f]{8}([0-9a-f]{64})*$/);
  }
  // known-positive control for the encoder used below: the ERC-20 transfer selector
  assert.equal(viem.toFunctionSelector('transfer(address,uint256)'), '0xa9059cbb');
  assert.equal(viem.toFunctionSelector('getPrice()'), P.byId('usdy').read.data);
  assert.equal(viem.toFunctionSelector('latestRoundData()'), RD.SEL_LATEST_ROUND);
  assert.equal(viem.toFunctionSelector('decimals()'), RD.SEL_DECIMALS);
  const ousgToken = '0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92';
  assert.equal(P.byId('ousg').read.data, viem.encodeFunctionData({ abi: [{ type: 'function', name: 'getAssetPrice', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }], functionName: 'getAssetPrice', args: [ousgToken] }));
  assert.equal(P.byId('syrupusdc').read.data, viem.encodeFunctionData({ abi: [{ type: 'function', name: 'convertToAssets', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }], functionName: 'convertToAssets', args: [1000000n] }));
  // the control must be able to fail: a wrong address does not equal its checksum form
  assert.notEqual(P.byId('usdy').contract.toLowerCase(), viem.getAddress(P.byId('usdy').contract));
});

// ---------------------------------------------------------------------------------------------------------------------------------------- arithmetic
test('yield math: simple and APY conventions on known numbers; null for a price or a window that is not usable', () => {
  const p0 = 1000000000000000000n; const p1 = 1003333333333333333n;            // +0.33333...% over 30 days
  assert.ok(Math.abs(Y.annualized('simple', p1, p0, 30) - 4.0555556) < 1e-5);
  assert.ok(Math.abs(Y.annualized('apy', p1, p0, 30) - (Math.pow(1.0033333333333333, 365 / 30) - 1) * 100) < 1e-9);
  assert.ok(Y.annualized('apy', p1, p0, 30) > Y.annualized('simple', p1, p0, 30), 'compounding gives the larger figure');
  assert.equal(Y.annualized('simple', p0, p0, 30), 0);
  assert.ok(Y.annualized('simple', p0, p1, 30) < 0, 'a falling price is a negative yield, not hidden');
  for (const bad of [[p1, 0n, 30], [0n, p0, 30], [-1n, p0, 30], [p1, p0, 0], [p1, p0, -3], [p1, p0, NaN], [1.5, p0, 30]]) assert.equal(Y.annualized('simple', ...bad), null, String(bad));
  assert.equal(Y.annualized('nope', p1, p0, 30), null);
  assert.equal(Y.toNumber(1151646183300394284n, 18), 1.1516461833003943);
  assert.equal(Y.toNumber(11265269n, 6), 11.265269);
  assert.equal(Y.toNumber(0n, 6), null);
});

// ---------------------------------------------------------------------------------------------------------------------------------------- the answer
test('answer: every served product, priced at the head block, yields equal the closed form over the real days, history from the contract', async () => {
  const s = setup();
  const out = await run(s);
  assert.equal(out.count, all().length); assert.equal(out.block, C.HEAD); assert.equal(out.as_of, iso(C.HEAD_TS)); assert.equal(out.yield_unit, 'percent per year');
  for (const p of all()) {
    const a = out.products.find((x) => x.product === p.id); assert.ok(a, p.id);
    const unit = 10n ** BigInt(p.read.decimals);
    const pt = s.chain.priceOf(p, C.HEAD_TS);
    assert.equal(a.nav, Number((Number(pt) / Number(unit)).toFixed(8)), `${p.id} nav`);
    const anchor = Math.floor(C.HEAD_TS / 21600) * 21600;
    for (const [d, key, wkey] of [[7, 'yield_7d_annualized', 'window_7d_days'], [30, 'yield_30d_annualized', 'window_30d_days']]) {
      const ts0 = anchor - d * 86400; const days = (C.HEAD_TS - ts0) / 86400;
      const r = Number(pt) / Number(s.chain.priceOf(p, ts0));
      const want = (p.convention === 'simple' ? (r - 1) * 365 / days : Math.pow(r, 365 / days) - 1) * 100;
      assert.ok(Math.abs(a[key] - want) < 6e-5, `${p.id} ${key}: ${a[key]} vs ${want}`);
      assert.equal(a[wkey], Number(days.toFixed(2)));
      assert.ok(days >= d && days < d + 0.25 + 1e-9);
    }
    assert.equal(a.history_source, 'contract'); assert.deepEqual(a.history_source_by_window, { '7d': 'contract', '30d': 'contract' });
    assert.deepEqual(a.flags, []); assert.equal(a.contract, p.contract); assert.equal(a.chain, 'ethereum'); assert.equal(a.convention, P.CONVENTION[p.convention]);
    assert.equal(a.oracle_updated_at, p.read.kind === 'round' ? iso(C.HEAD_TS - 3 * 3600) : null);
  }
});

test('answer: the same builder makes the constructed example and the live answer (same keys), and the example covers every served product', () => {
  const ex = M.entries[0].example;
  assert.equal(ex.count, all().length); assert.deepEqual(ex.products.map((x) => x.product), all().map((p) => p.id));
  const s = setup();
  return run(s).then((live) => {
    assert.deepEqual(Object.keys(ex), Object.keys(live));
    for (const a of ex.products) assert.deepEqual(Object.keys(a), Object.keys(live.products.find((x) => x.product === a.product)));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------- the block search
test('blockAtOrBefore: the latest block at or before any time, on a chain with missed slots, in a bounded number of calls; the naive estimate is wrong on the same chain', async () => {
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const gaps = Array.from({ length: 400 }, () => C.HEAD - 1 - Math.floor(rnd() * 300000));
  const s = setup({ gaps });
  const head = await R.getBlock(s.rpc, 'latest', s.chain.clock);
  const brute = (ts) => { let lo = 1; let hi = C.HEAD; while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (s.chain.tsOf(mid) <= ts) lo = mid; else hi = mid - 1; } return lo; };
  let naiveWrong = 0; let maxCalls = 0;
  for (let i = 0; i < 120; i++) {
    const ts = C.HEAD_TS - Math.floor(rnd() * 40 * 86400) - (i % 3 === 0 ? 0 : 5);
    const before = s.chain.calls.length;
    const b = await R.blockAtOrBefore(s.rpc, head, ts);
    maxCalls = Math.max(maxCalls, s.chain.calls.length - before);
    assert.equal(b.number, brute(ts), `target ${ts}`); assert.ok(b.ts <= ts); assert.equal(b.ts, s.chain.tsOf(b.number));
    if (C.HEAD - Math.ceil((C.HEAD_TS - ts) / 12) !== brute(ts)) naiveWrong++;
  }
  assert.ok(naiveWrong > 20, `control: the plain 12-second estimate misses on this chain (${naiveWrong}/120), so the search is doing the work`);
  assert.ok(maxCalls <= 14, `bounded lookups: ${maxCalls}`);
  assert.equal((await R.blockAtOrBefore(s.rpc, head, C.HEAD_TS + 50)).number, C.HEAD, 'a time after the head is the head');
});

// ---------------------------------------------------------------------------------------------------------------------------------------- fail closed
test('fail closed: every endpoint down / timing out / sending a page that is not JSON / sending too much -> 503 Not charged (control: the same call served)', async () => {
  await run(setup());                                                                              // control
  for (const mode of ['down', 'rate', 'timeout', 'badjson', 'big', 'bigcl']) await refused(setup({}, { [A]: { mode } }), null);
});

test('fail closed: a contract that reverts, a zero price, a negative answer, a short or non-hex result, a price outside the band -> 503 (control: the others of the batch are served)', async () => {
  const ok = await run(setup(), ['usdy']); assert.equal(ok.count, 1);
  await refused(setup({ revert: ['usdy'] }), ['usdy'], 'revert');
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const neg = '0x' + word(1) + (BigInt(-5) + (1n << 256n)).toString(16) + word(1793600000) + word(1793600000) + word(1);
  await refused(setup({ rawResult: { usdy: '0x' + word(0) } }), ['usdy'], 'range');
  await refused(setup({ rawResult: { usyc: neg } }), ['usyc'], 'range');
  await refused(setup({ rawResult: { usdy: '0x' + word(1n << 255n) } }), ['usdy'], 'range');
  await refused(setup({ rawResult: { usdy: '0x' } }), ['usdy'], 'invalid');
  await refused(setup({ rawResult: { usdy: '0x' + word(5).slice(0, 60) } }), ['usdy'], 'invalid');
  await refused(setup({ rawResult: { usdy: 'not hex' } }), ['usdy'], 'invalid');
  await refused(setup({ price: { usdy: (ts) => BigInt(Math.round(3.2 * 1e8)) * 10n ** 10n } }), ['usdy'], 'band');                          // 3.2 USD: above 1.6 x the start price
  await refused(setup({ price: { ousg: (ts) => 10n ** 18n } }), ['ousg'], 'band');                                                          // 1 USD for a token that starts at 100
  // out of band only at the head (every older read is fine): the latest price is held to the band as well
  await refused(setup({ price: { usdy: (ts) => (ts > C.HEAD_TS - 3600 ? 3200000000000000000n : 1100000000000000000n) } }), ['usdy'], 'band');
  // a price in band now but out of band 30 days ago is refused too (a history read is believed no more than the latest)
  await refused(setup({ price: { usdy: (ts) => (ts > C.HEAD_TS - 20 * 86400 ? 1100000000000000000n : 9000000000000000000n) } }), ['usdy'], 'band');
});

test('fail closed: an oracle last updated too long ago, one updated in the future, a decimals value that differs from the register -> 503 (control: just inside the limit is served)', async () => {
  const lim = P.byId('ustb').staleSec;
  await run(setup({ updatedAge: { ustb: lim - 100 } }), ['ustb']);                                  // control
  await refused(setup({ updatedAge: { ustb: lim + 100 } }), ['ustb'], 'stale');
  await refused(setup({ updatedAge: { ustb: -3600 } }), ['ustb'], 'updatedAt');
  await run(setup({ decimals: { ustb: 6 } }), ['ustb']);                                            // control
  await refused(setup({ decimals: { ustb: 8 } }), ['ustb'], 'decimals');
  await refused(setup({ decimals: { usyc: 6 } }), ['usyc'], 'decimals');
});

test('fail closed: the RPC budget of a call is a hard limit (control: enough budget serves), and every attempt counts, retries and failovers included', async () => {
  const s = setup({}, { [A]: { mode: 'ok' } }, { budget: 400 });
  await run(s, ['usdy']); const need = s.rpc.used();
  assert.ok(need > 5 && need <= 40, `one product costs ${need} requests`);
  await refused(setup({}, { [A]: { mode: 'ok' } }, { budget: need - 1 }), ['usdy'], 'budget');
  await run(setup({}, { [A]: { mode: 'ok' } }, { budget: need }), ['usdy']);
  const f = setup({}, { [A]: { mode: 'down' }, [B]: { mode: 'ok' } }, { budget: 400 });
  await run(f, ['usdy']); assert.ok(f.rpc.used() > need, 'the failed attempts on the first endpoint were counted');
});

test('fail closed: a partial failure never gives a partial 200: with no filter the call is refused and says which product and how to get the others (control: product= for another one is served)', async () => {
  const s = setup({ revert: ['ustb'] });
  await assert.rejects(() => run(s), (e) => { assert.equal(e.status, 503); assert.match(e.message, /Superstate USTB/); assert.match(e.message, /product=/); assert.match(e.message, /Not charged\.$/); return true; });
  const one = await run(setup({ revert: ['ustb'] }), ['usdy']); assert.equal(one.count, 1); assert.equal(one.products[0].product, 'usdy');
});

// ---------------------------------------------------------------------------------------------------------------------------------------- the client
test('rpc: failover to the next endpoint on 5xx, 429, timeout, bad JSON, oversize, a head that is an hour old, and a chain id that is not 1 (control: one good endpoint serves alone)', async () => {
  const good = await run(setup({}, { [B]: { mode: 'ok' } }), ['usdy']);
  for (const mode of ['down', 'rate', 'timeout', 'badjson', 'big', 'bigcl', 'oldhead', 'wrongchain']) {
    const s = setup({}, { [A]: { mode }, [B]: { mode: 'ok' } });
    const out = await run(s, ['usdy']);
    assert.deepEqual(out, good, `${mode}: same answer from the second endpoint`);
    assert.ok(s.chain.calls.some((c) => c.url === A) && s.chain.calls.some((c) => c.url === B), mode);
  }
  await refused(setup({}, { [A]: { mode: 'oldhead' } }), ['usdy']);
  await refused(setup({}, { [A]: { mode: 'wrongchain' } }), ['usdy']);
});

test('rpc: a request that hangs is cut off by the timeout and the next endpoint is asked (control: the same endpoint answers when it is allowed to finish)', async () => {
  const slow = setup({}, { [A]: { mode: 'hang' }, [B]: { mode: 'ok' } }, { timeoutMs: 50 });
  const t0 = Date.now(); const out = await run(slow, ['usdy']);
  assert.ok(Date.now() - t0 < 1400, 'did not wait for the hanging endpoint to finish');
  assert.ok(slow.chain.calls.some((c) => c.url === B), 'the second endpoint was asked');
  assert.equal(out.block, C.HEAD);
  const patient = setup({}, { [A]: { mode: 'hang' }, [B]: { mode: 'ok' } }, { timeoutMs: 5000 });
  await run(patient, ['usdy']); assert.ok(!patient.chain.calls.some((c) => c.url === B), 'control: with time to finish, the first endpoint answers and the second is never asked');
});

test('rpc: an endpoint that refuses old state is skipped for history only, the latest block still comes from it; with no endpoint that serves old state the call is refused', async () => {
  const s = setup({}, { [A]: { mode: 'archive' }, [B]: { mode: 'ok' } });
  const out = await run(s, ['usdy']);
  assert.equal(out.block, C.HEAD);
  assert.ok(s.chain.calls.some((c) => c.url === A && c.method === 'eth_getBlockByNumber' && c.params[0] === 'latest'), 'the head came from the archive-less endpoint');
  assert.ok(s.chain.calls.filter((c) => c.url === B && c.method === 'eth_call').length >= 2, 'the old reads came from the second endpoint');
  await run(s, ['ousg', 'ustb', 'usyc', 'syrupusdc']);          // a lot of refusals from A in total ...
  const stA = s.rpc.state.get(0); assert.ok(!stA || (stA.fails === 0 && stA.until === 0), '... and none of them counts against it or puts it to rest');
  await refused(setup({}, { [A]: { mode: 'archive' } }), ['usdy']);
  const only = setup({}, { [A]: { mode: 'ok', noState: 100 } });
  await refused(only, ['usdy']);
});

test('rpc: an endpoint that fails three times in a row rests for a minute (shared across calls), then is asked again; a revert is the contract answering, so it does not move to the next endpoint', async () => {
  let t = C.HEAD_TS * 1000 + 5000; const clock = () => t;
  const chain = C.makeChain({ now: t });
  const eps = { [A]: { mode: 'down' }, [B]: { mode: 'ok' } };
  const health = new Map();
  const mk = () => R.makeRpc({ endpoints: Object.keys(eps), fetchImpl: chain.fetchFor(eps), now: clock, budget: 400, health });
  for (let i = 0; i < 3; i++) await mk().call('eth_getBlockByNumber', ['latest', false]);
  const before = chain.calls.filter((c) => c.url === A).length;
  await mk().call('eth_getBlockByNumber', ['latest', false]);
  assert.equal(chain.calls.filter((c) => c.url === A).length, before, 'resting: no request to the failing endpoint');
  t += R.COOLDOWN_MS + 1000; eps[A].mode = 'ok';
  await mk().call('eth_getBlockByNumber', ['latest', false]);
  assert.ok(chain.calls.filter((c) => c.url === A).length > before, 'asked again after the rest');
  // one endpoint only: after it has failed three times it is "resting", but with nothing else to ask it is asked anyway and a recovery is seen at once
  const solo = { [A]: { mode: 'down' } }; const sc = C.makeChain({ now: t }); const sh = new Map();
  const mkSolo = () => R.makeRpc({ endpoints: Object.keys(solo), fetchImpl: sc.fetchFor(solo), now: clock, budget: 400, health: sh });
  for (let i = 0; i < 4; i++) await assert.rejects(() => mkSolo().call('eth_getBlockByNumber', ['latest', false]), (e) => e.status === 503);
  solo[A].mode = 'ok'; assert.ok(await mkSolo().call('eth_getBlockByNumber', ['latest', false]), 'asked again at once');
  const rv = setup({ revert: ['usdy'] }, { [A]: { mode: 'ok' }, [B]: { mode: 'ok' } });
  await refused(rv, ['usdy'], 'revert');
  assert.ok(!rv.chain.calls.some((c) => c.url === B && c.method === 'eth_call'), 'a revert is not retried elsewhere');
});

test('rpc: endpoint list from the environment: operator URLs first, https only (loopback http allowed), junk dropped, defaults last or off; nothing a caller sends reaches a URL', () => {
  const l = R.endpointsFrom({ R24_RWA_RPC_ETH: ' https://k.test/key , http://evil.test/x, ftp://z, not a url, http://127.0.0.1:9/, https://k.test/key' });
  assert.deepEqual(l, ['https://k.test/key', 'http://127.0.0.1:9/', ...R.DEFAULT_ENDPOINTS]);
  assert.deepEqual(R.endpointsFrom({ R24_RWA_RPC_ETH: 'https://k.test/key', R24_RWA_RPC_DEFAULTS: 'off' }), ['https://k.test/key']);
  assert.deepEqual(R.endpointsFrom({}), R.DEFAULT_ENDPOINTS);
  assert.ok(R.DEFAULT_ENDPOINTS.length >= 2 && R.DEFAULT_ENDPOINTS.every((u) => u.startsWith('https://')));
  assert.throws(() => R.makeRpc({ endpoints: [] }), (e) => e.status === 503);
});

// ---------------------------------------------------------------------------------------------------------------------------------------- the daily-move flag
test('a price that moved more than 1 percent in a day is served with a flag (not hidden); the others carry none (control: the same chain without the jump has no flag)', async () => {
  const jump = (ts) => { const base = s0.chain.priceOf(P.byId('usdy'), ts); return ts > C.HEAD_TS - 2 * 3600 ? base * 102n / 100n : base; };
  const s0 = setup();
  const calm = await run(s0, ['usdy']); assert.deepEqual(calm.products[0].flags, []);
  const s = setup({ price: { usdy: jump } });
  const out = await run(s, ['usdy']);
  assert.deepEqual(out.products[0].flags, [E.FLAG_MOVE]);
  assert.ok(out.products[0].yield_7d_annualized > calm.products[0].yield_7d_annualized * 3, 'the yield shows the jump rather than hiding it');
  const j2 = setup({ price: { usdy: (ts) => (ts > C.HEAD_TS - 2 * 3600 ? s0.chain.priceOf(P.byId('usdy'), ts) * 1009n / 1000n : s0.chain.priceOf(P.byId('usdy'), ts)) } });
  assert.deepEqual((await run(j2, ['usdy'])).products[0].flags, [], '0.9 percent is under the line');
});

// ---------------------------------------------------------------------------------------------------------------------------------------- caching
test('caching: the old reads are shared for 6 hours, the latest is read each call; the stores are bounded', async () => {
  const s = setup();
  await run(s, ['usdy', 'ustb']); const first = history(s).length;
  assert.ok(first >= 6, 'cold: history read');
  s.chain.calls.length = 0;
  await E.evaluate({ products: ['usdy', 'ustb'].map(P.byId), deps: { ...s.deps, rpc: R.makeRpc({ endpoints: [A], fetchImpl: s.chain.fetchFor({ [A]: { mode: 'ok' } }), now: s.chain.clock, budget: 100 }) } });
  assert.equal(history(s).length, 0, 'warm: no old state read at all');
  assert.ok(s.chain.calls.some((c) => c.method === 'eth_call'), 'the latest price is read again');
  for (let i = 0; i < 300; i++) { E.SHARED.history.set('x' + i, i); E.SHARED.blocks.set('y' + i, i); E.SHARED.answers.set('z' + i, i); }
  assert.ok(E.SHARED.history.size() <= 64 && E.SHARED.blocks.size() <= 16 && E.SHARED.answers.size() <= 16, 'the stores the route really uses are bounded'); E.resetShared();
  // a later 6-hour anchor needs new history; the same anchor 5 hours on does not
  const st = E.makeStore(3, 1000, (() => { let n = 0; return () => n++; })());
  for (let i = 0; i < 10; i++) st.set('k' + i, i);
  assert.ok(st.size() <= 3, 'bounded'); assert.equal(st.get('k9'), 9); assert.equal(st.get('k0'), undefined);
  const aged = E.makeStore(3, 2, (() => { let n = 0; return () => (n += 3); })());
  aged.set('x', 1); assert.equal(aged.get('x'), undefined, 'expired entries are not served');
});

test('caching: concurrent identical calls share one history read, and a failed read is not cached (the next call tries again)', async () => {
  const s = setup();
  await Promise.all([run(s, ['usdy']), run(s, ['usdy']), run(s, ['usdy'])]);
  assert.equal(history(s).filter((c) => c.params[0].to === P.byId('usdy').contract).length, 3, 'one old read per window (1, 7, 30 days), not three each');
  const f = setup({ failOld: ['usdy'] });
  await refused(f, ['usdy'], 'revert');
  assert.equal(f.c.history.size(), 0, 'nothing cached from a refusal');
  assert.equal(f.c.blocks.size() > 0, true, 'control: the block lookups, which did succeed, are kept');
  const healed = setup(); await run(healed, ['usdy']); assert.ok(healed.c.history.size() >= 3, 'control: a good call does fill the cache');
});

// ---------------------------------------------------------------------------------------------------------------------------------------- input
test('caching: a burst of identical calls (no injected client) shares one evaluation for 30 seconds; a refusal is not kept; a different product list is its own entry', async () => {
  RD._decimalsMemo.clear();
  const chain = C.makeChain(); const eps = { 'https://rpc-a.example': { mode: 'ok' } }; const c = caches();
  const deps = { fetchImpl: chain.fetchFor(eps), now: chain.clock, caches: c, snapshotDb: null, env: { R24_RWA_RPC_ETH: 'https://rpc-a.example', R24_RWA_RPC_DEFAULTS: 'off' } };
  const heads = () => chain.calls.filter((x) => x.method === 'eth_getBlockByNumber' && x.params[0] === 'latest').length;
  const three = await Promise.all([M.getRwaYields({}, deps), M.getRwaYields({}, deps), M.getRwaYields({}, deps)]);
  assert.equal(heads(), 1, 'one head read for three callers'); assert.deepEqual(three[0], three[2]);
  await M.getRwaYields({}, deps); assert.equal(heads(), 1, 'still within 30 seconds: served from the kept evaluation');
  await M.getRwaYields({ product: 'usdy' }, deps); assert.equal(heads(), 2, 'another product list is its own evaluation');
  const down = C.makeChain(); const dc = caches(); const dEps = { 'https://rpc-a.example': { mode: 'down' } };
  const dDeps = { fetchImpl: down.fetchFor(dEps), now: down.clock, caches: dc, snapshotDb: null, env: deps.env };
  await assert.rejects(() => M.getRwaYields({}, dDeps), (e) => e.status === 503);
  assert.equal(dc.answers.size(), 0, 'a refusal is not kept'); dEps['https://rpc-a.example'].mode = 'ok'; dc.health.clear();
  assert.equal((await M.getRwaYields({}, dDeps)).count, all().length, 'the next call tries again');
});

test('input: product is one served id (any case); anything else is a 400 thrown before one RPC request is sent (control: a good id reads)', async () => {
  const s = setup();
  for (const v of ['nope', 'usdy,ousg', 'usdy ousg', ' usdy', 'usdy ', '1', {}, ['usdy', 'ousg'], ['usdy'], 7, '../etc/passwd', 'x'.repeat(5000)]) {
    await assert.rejects(() => M.getRwaYields({ product: v }, s.deps), (e) => { assert.equal(e.kind, 'bad_request'); assert.ok(e.message.length < 300); assert.ok(!e.status); return true; }, JSON.stringify(v).slice(0, 40));
  }
  assert.equal(s.chain.calls.length, 0, 'no request was made for a bad product');
  const ok = await M.getRwaYields({ product: 'USDY' }, s.deps); assert.equal(ok.count, 1); assert.ok(s.chain.calls.length > 0);
  assert.equal((await M.getRwaYields({ product: '' }, setup().deps)).count, all().length);
  assert.equal((await M.getRwaYields({}, setup().deps)).count, all().length);
  const e = await M.getRwaYields({ product: 'nope' }, s.deps).catch((x) => x);
  for (const id of E.servedIds()) assert.ok(e.message.includes(id), 'the message lists the ids (derived from the register)');
});

test('input: a product the gate dropped is not an id the route knows (served: false)', () => {
  const list = P.PRODUCTS.map((p) => (p.id === 'usdy' ? { ...p, served: false } : p));
  assert.ok(!E.servedIds(list).includes('usdy')); assert.throws(() => E.pick('usdy', list), (e) => e.kind === 'bad_request');
  assert.equal(E.pick(null, list).length, P.served().length - 1, 'one fewer than the register serves');
  assert.equal(E.pick('ousg', list)[0].id, 'ousg');
});

// ---------------------------------------------------------------------------------------------------------------------------------------- the route entry and the text a customer reads
const BANNED = /\b(buy|sell|hold|holds|holding|trade|trades|trading|invest|invests|investing|guarantee[ds]?|guaranteed|rug\w*|recommend\w*|should|advice)\b|since\s+\d|\bsince\b/i;
test('entry: price, route, name, tags, description (180-255 characters, house style), schema derived from the register, title and question', () => {
  assert.equal(M.entries.length, 1);
  const e = M.entries[0];
  assert.equal(e.name, 'get_rwa_yields'); assert.equal(e.route, 'GET /api/rwa-yields'); assert.equal(e.usd, 0.02);
  assert.ok(e.desc.length >= 180 && e.desc.length <= 255, `desc ${e.desc.length}`); assert.ok(e.desc.startsWith('Use when an agent needs'));
  assert.match(e.desc, /503/); assert.match(e.desc, /not charged/i);
  assert.ok(e.tags.every((t) => t === t.toLowerCase())); assert.ok(e.title.length < 40); assert.ok(e.question.endsWith('?'));
  assert.deepEqual(Object.keys(e.schema), ['product']);
  assert.equal(typeof e.run, 'function');
  for (const id of E.servedIds()) assert.ok(e.schema.product.description.includes(id));
});

test('text: no advice word, no start date, no person name pattern in anything a customer reads (route text, example answer, method); the check can see a known-bad line', () => {
  const e = M.entries[0];
  assert.match('You should buy this and hold it, guaranteed, since 2024', BANNED);
  assert.match('trade', BANNED); assert.match('a rug', BANNED); assert.doesNotMatch('tokenized treasury yields over 7 days', BANNED);
  const texts = [e.desc, e.title, e.question, e.schema.product.description, JSON.stringify(e.example), ...P.PRODUCTS.map((p) => `${p.name} ${p.assetClass} ${p.fn} ${p.contractName}`)];
  for (const t of texts) assert.doesNotMatch(t, BANNED, t.slice(0, 80));
  // counts in public text are derived from the register, never typed
  assert.ok(!/\b\d+ (products|tokens)\b/.test(e.desc + e.question));
});

test('no yield figure is read from anywhere: the module has no URL but its RPC defaults and the issuer docs it cites, and no banned data vendor appears (the scan finds a known positive)', () => {
  const dir = path.join(__dirname, '..', 'tools', 'r24', 'rwa');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f)).concat(path.join(__dirname, '..', 'bin', 'r24-rwa-snapshot.js'));
  const VENDOR = /defillama|llama\.fi|geckoterminal|dexscreener|coingecko|coinmarketcap|rwa\.xyz|rdap|kalshi|polymarket|opt\/rwayield/i;
  assert.match('https://api.llama.fi/protocol/x', VENDOR); assert.match('/opt/rwayield/db', VENDOR); assert.doesNotMatch('eth.drpc.org', VENDOR);
  const urlRe = /https?:\/\/[^\s'"`)<>,]+/g;
  const allowed = new Set([...R.DEFAULT_ENDPOINTS, ...P.PRODUCTS.flatMap((p) => p.docs)]);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''), VENDOR, `${path.basename(f)}: no banned data vendor in code`);
    for (const u of src.match(urlRe) || []) if (!allowed.has(u) && !/^https:\/\/(eth\.drpc\.org|ethereum-rpc\.publicnode\.com)/.test(u)) assert.ok(/^http:\/\/127\.0\.0\.1|^https?:\/\/k\.test|example/.test(u) || /\/\/ |\* /.test(src.split('\n').find((l) => l.includes(u)) || ''), `${path.basename(f)}: unexpected URL ${u}`);
  }
  assert.ok(files.length >= 8);
});

test('secrets: an endpoint URL that carries a key never reaches a message, a detail field, the answer or a collector line', async () => {
  const s = setup({}, { [A]: { mode: 'down' } });
  const e = await run(s).catch((x) => x);
  assert.equal(e.status, 503);
  assert.ok(!JSON.stringify({ m: e.message, d: e.detail, own: Object.entries(e) }).includes('SECRET'));
  const ok = setup({}, { [A]: { mode: 'ok' } });
  assert.ok(!JSON.stringify(await run(ok)).includes('SECRET'));
});
