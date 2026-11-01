// R24 item 4: GET /api/tx-precheck, chain=base: input caps, the requests sent to the RPC, every warning, every benign pass-through, the failing simulation, the 503 paths.
// The RPC is a fake Base node (test/fixtures/r24/txprecheck/evm-world.js): nothing here touches the network. The live gate is a separate run (ops/r24-txprecheck-gate.mjs).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('viem');
const W = require('./fixtures/r24/txprecheck/evm-world');
const D = require('../tools/r24/txprecheck/evm-decode');
const L = require('../tools/r24/txprecheck/limits');
const { precheckBase } = require('../tools/r24/txprecheck/evm');
const { makeBaseRpc } = require('../tools/r24/txprecheck/base-rpc');
const { run } = require('../tools/r24/txprecheck');

const ME = '0x1111111111111111111111111111111111111111'; const FRIEND = '0x2222222222222222222222222222222222222222'; const FRESH = '0x3333333333333333333333333333333333333333';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; const WETH = '0x4200000000000000000000000000000000000006'; const ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43';
const JUNK = '0x4444444444444444444444444444444444444444'; const POOL = '0x5555555555555555555555555555555555555555'; const UNKNOWN = '0x6666666666666666666666666666666666666666'; const SPENDER = '0x7777777777777777777777777777777777777777';
const FEE = '0x8888888888888888888888888888888888888888';
const MAX = (1n << 256n) - 1n; const ONE_USDC = 1_000_000n; const E18 = 10n ** 18n;
const erc20 = V.parseAbi(['function approve(address,uint256)', 'function transfer(address,uint256)', 'function setApprovalForAll(address,bool)', 'function transferOwnership(address)']);
const callData = (fn, args) => V.encodeFunctionData({ abi: erc20, functionName: fn, args });
const noRisk = async () => { throw new Error('the token-risk read should not be called'); };

const baseWorld = (over = {}) => ({
  head: { number: 5000, timestamp: 1_800_000_000 },
  eth: { [ME]: 10n * E18, [FRIEND]: 2n * E18, [WETH]: 1000n * E18 },
  tok: { [USDC]: { [ME]: 500n * ONE_USDC, [FRIEND]: 5n * ONE_USDC }, [JUNK]: { [ME]: 0n, [POOL]: 10n ** 24n }, [WETH]: { [ME]: 0n } },
  meta: { [USDC]: { symbol: 'USDC', name: 'USD Coin', decimals: 6 }, [JUNK]: { symbol: 'JUNK', name: 'Junk', decimals: 18 }, [WETH]: { symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 } },
  code: [USDC, WETH, ROUTER, JUNK, POOL, UNKNOWN, SPENDER], nonce: { [FRIEND]: 7, [ME]: 3 },
  scenario: () => ({ status: '0x1', returnData: '0x', logs: [] }),
  ...over,
});
async function go(q, world, { risk = noRisk, deps = {} } = {}) {
  const w = W.makeEvmWorld(world);
  const out = await precheckBase({ chain: 'base', from: ME, ...q }, { base: { request: w.request }, now: Date.now, baseRisk: risk, ...deps });
  return { out, w };
}
const ids = (o) => o.warnings.map((x) => x.id);
const addr = (a) => V.getAddress(a);

test('input: every cap and every shape is checked in the handler before any RPC call (calldata 20,000 hex characters)', async () => {
  assert.equal(L.MAX_EVM_DATA_HEX, 20000);
  const ok = D.parseInput({ to: USDC, data: `0x${'ab'.repeat(10000)}` });
  assert.equal(ok.data.length, 2 + 20000);
  assert.throws(() => D.parseInput({ to: USDC, data: `0x${'ab'.repeat(10000)}00` }), /20002 hex characters|cap is 20000/);
  assert.throws(() => D.parseInput({ to: USDC, data: '0xabc' }), /even number of digits/);
  assert.throws(() => D.parseInput({ to: USDC, data: '0xzz' }), /even number of digits/);
  assert.throws(() => D.parseInput({}), /missing required parameter: to/);
  assert.throws(() => D.parseInput({ to: '0x12' }), /40 hex characters/);
  assert.throws(() => D.parseInput({ to: USDC, from: 'nope' }), /from must be a 0x address/);
  assert.throws(() => D.parseInput({ to: USDC, value: '1.5' }), /wei as a decimal number or 0x hex/);
  assert.throws(() => D.parseInput({ to: USDC, value: '-1' }), /wei as a decimal/);
  assert.throws(() => D.parseInput({ to: USDC, value: (2n ** 256n).toString() }), /above the largest uint256/);
  assert.equal(D.parseInput({ to: USDC, value: (2n ** 256n - 1n).toString() }).value, 2n ** 256n - 1n);
  assert.equal(D.parseInput({ to: USDC, value: '0xde0b6b3a7640000' }).value, E18);
  assert.equal(D.parseInput({ to: USDC, data: 'ABCD' }).data, '0xabcd', 'hex without the prefix is accepted and lower-cased');
  assert.equal(D.parseInput({ to: USDC }).data, '0x'); assert.equal(D.parseInput({ to: USDC }).value, 0n); assert.equal(D.parseInput({ to: USDC }).from, null);
  const calls = [];
  const deps = { base: { request: async (m) => { calls.push(m); return {}; } }, now: Date.now };
  await assert.rejects(precheckBase({ chain: 'base', to: USDC, data: `0x${'ab'.repeat(10001)}` }, deps), (e) => e.kind === 'bad_request');
  await assert.rejects(precheckBase({ chain: 'base', to: 'x' }, deps), (e) => e.kind === 'bad_request');
  assert.deepEqual(calls, [], 'a refused request never reaches the RPC');
});

test('benign: an exact-amount approval to a well-known router, a wrap, a small ETH transfer to an account that has been used, and a small token transfer carry NO warning', async () => {
  const cases = [
    ['exact approval to a known router', { to: USDC, data: callData('approve', [ROUTER, ONE_USDC]) }, { logs: [W.logApproval(USDC, ME, ROUTER, ONE_USDC)] }],
    ['wrap', { to: WETH, data: '0xd0e30db0', value: String(E18 / 100n) }, { logs: [W.logEth(ME, WETH, E18 / 100n), W.logRaw(WETH, ['0xe1fffcc4923d04b559f4d29a2b0b7ce60f56bd96c8b7f77ba5b5bb4e56b63a8e', W.pad(ME)], W.word(E18 / 100n))], apply: (s) => { s.eth.set(ME, s.eth.get(ME) - E18 / 100n); s.eth.set(WETH, s.eth.get(WETH) + E18 / 100n); s.tok.get(WETH).set(ME, E18 / 100n); } }],
    ['small ETH transfer to a used account', { to: FRIEND, value: String(E18 / 100n) }, { logs: [W.logEth(ME, FRIEND, E18 / 100n)], apply: (s) => { s.eth.set(ME, s.eth.get(ME) - E18 / 100n); s.eth.set(FRIEND, s.eth.get(FRIEND) + E18 / 100n); } }],
    ['small token transfer', { to: USDC, data: callData('transfer', [FRIEND, ONE_USDC]) }, { logs: [W.logTransfer(USDC, ME, FRIEND, ONE_USDC)], apply: (s) => { s.tok.get(USDC).set(ME, s.tok.get(USDC).get(ME) - ONE_USDC); s.tok.get(USDC).set(FRIEND, s.tok.get(USDC).get(FRIEND) + ONE_USDC); } }],
  ];
  for (const [what, q, sc] of cases) {
    const { out } = await go(q, baseWorld({ scenario: () => ({ status: '0x1', returnData: '0x', ...sc }) }));
    assert.deepEqual(ids(out), [], `${what}: ${JSON.stringify(out.warnings)}`);
    assert.equal(out.simulation.ok, true, what); assert.equal(out.summary.warning_count, 0);
  }
});

test('benign: the balance changes are per account and per token with before, after, delta and decimals, read in one block; the approval is listed with its spender and the table name', async () => {
  const { out } = await go({ to: USDC, data: callData('transfer', [FRIEND, 3n * ONE_USDC]) }, baseWorld({ scenario: () => ({ status: '0x1', logs: [W.logTransfer(USDC, ME, FRIEND, 3n * ONE_USDC)], apply: (s) => { s.tok.get(USDC).set(ME, 497n * ONE_USDC); s.tok.get(USDC).set(FRIEND, 8n * ONE_USDC); } }) }));
  const me = out.balance_changes.find((c) => c.account === addr(ME) && c.asset === addr(USDC));
  assert.deepEqual([me.symbol, me.decimals, me.before, me.after, me.delta, me.delta_ui, me.is_sender], ['USDC', 6, '500000000', '497000000', '-3000000', '-3', true]);
  const fr = out.balance_changes.find((c) => c.account === addr(FRIEND));
  assert.deepEqual([fr.before, fr.after, fr.delta], ['5000000', '8000000', '3000000']);
  assert.equal(out.balance_changes[0].is_sender, true, 'the sender\'s changes come first');
  const ap = await go({ to: USDC, data: callData('approve', [ROUTER, ONE_USDC]) }, baseWorld({ scenario: () => ({ logs: [W.logApproval(USDC, ME, ROUTER, ONE_USDC)] }) }));
  assert.deepEqual(ap.out.approvals.map((a) => [a.kind, a.token, a.spender, a.spender_known, a.spender_name, a.amount, a.amount_ui, a.unlimited, a.by_sender]), [['erc20_allowance', addr(USDC), addr(ROUTER), true, 'Uniswap Universal Router', '1000000', '1', false, true]]);
  assert.deepEqual(ap.out.request.call, { selector: '0x095ea7b3', name: 'approve', args: [addr(ROUTER), '1000000'] });
});

test('unlimited_approval: an allowance of at least the uint96 maximum is unlimited (uint256 max, a Permit2 uint160 max); one below it is not; a zero allowance (a revoke) is no finding', async () => {
  const at = (amount) => baseWorld({ scenario: () => ({ logs: [W.logApproval(USDC, ME, ROUTER, amount)] }) });
  const max = await go({ to: USDC, data: callData('approve', [ROUTER, MAX]) }, at(MAX));
  assert.deepEqual(ids(max.out), ['unlimited_approval']);
  const w = max.out.warnings[0];
  assert.equal(w.severity, 'high'); assert.equal(w.spender, addr(ROUTER)); assert.equal(w.token, addr(USDC)); assert.equal(w.owner, addr(ME)); assert.equal(w.unlimited, true);
  assert.match(w.message, /grants spender 0x[0-9a-fA-F]{40} \(Uniswap Universal Router\) an unlimited allowance of token USDC/);
  assert.equal(max.out.approvals[0].amount_ui, null);
  const U96 = (1n << 96n) - 1n;
  assert.deepEqual(ids((await go({ to: USDC, data: callData('approve', [ROUTER, U96]) }, at(U96))).out), ['unlimited_approval']);
  assert.deepEqual(ids((await go({ to: USDC, data: callData('approve', [ROUTER, U96 - 1n]) }, at(U96 - 1n))).out), []);
  assert.deepEqual(ids((await go({ to: USDC, data: callData('approve', [ROUTER, 0n]) }, at(0n))).out), []);
  // Permit2: the Approval event with a uint160 amount
  const p2 = baseWorld({ scenario: () => ({ logs: [W.logRaw('0x000000000022d473030f116ddee9f6b43ac78ba3', ['0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b', W.pad(ME), W.pad(USDC), W.pad(ROUTER)], `${W.word((1n << 160n) - 1n)}${W.word(1_900_000_000).slice(2)}`)] }) });
  const perm = await go({ to: '0x000000000022d473030f116ddee9f6b43ac78ba3', data: '0x87517c45' }, baseWorld({ ...p2, code: [USDC, WETH, ROUTER, '0x000000000022d473030f116ddee9f6b43ac78ba3'] }));
  assert.deepEqual(ids(perm.out), ['unlimited_approval']); assert.equal(perm.out.approvals[0].kind, 'permit2_allowance'); assert.equal(perm.out.approvals[0].expires_at_unix, 1_900_000_000);
});

test('approval_to_unknown_spender: an allowance to a spender outside the table is flagged even when it is an exact amount; an approval made by someone other than the sender is listed but not flagged', async () => {
  const exact = await go({ to: USDC, data: callData('approve', [SPENDER, ONE_USDC]) }, baseWorld({ scenario: () => ({ logs: [W.logApproval(USDC, ME, SPENDER, ONE_USDC)] }) }));
  assert.deepEqual(ids(exact.out), ['approval_to_unknown_spender']); assert.equal(exact.out.warnings[0].severity, 'medium'); assert.match(exact.out.warnings[0].message, /not in this service's table of well-known Base contracts/);
  const both = await go({ to: USDC, data: callData('approve', [SPENDER, MAX]) }, baseWorld({ scenario: () => ({ logs: [W.logApproval(USDC, ME, SPENDER, MAX)] }) }));
  assert.deepEqual(ids(both.out).sort(), ['approval_to_unknown_spender', 'unlimited_approval']);
  const other = await go({ to: ROUTER, data: '0x1234' }, baseWorld({ scenario: () => ({ logs: [W.logApproval(USDC, ROUTER, SPENDER, MAX)] }) }));
  assert.deepEqual(ids(other.out), []); assert.equal(other.out.approvals[0].by_sender, false);
});

test('delegate_granted: setApprovalForAll(operator, true) by the sender is flagged; setApprovalForAll(operator, false) is not', async () => {
  const ev = (approved) => W.logRaw(UNKNOWN, ['0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31', W.pad(ME), W.pad(SPENDER)], W.word(approved ? 1 : 0));
  const on = await go({ to: UNKNOWN, data: callData('setApprovalForAll', [SPENDER, true]) }, baseWorld({ scenario: () => ({ logs: [ev(true)] }) }));
  assert.ok(ids(on.out).includes('delegate_granted')); const w = on.out.warnings.find((x) => x.id === 'delegate_granted');
  assert.equal(w.severity, 'high'); assert.equal(w.delegate, addr(SPENDER)); assert.equal(w.collection, addr(UNKNOWN)); assert.equal(on.out.delegations[0].kind, 'operator_for_all');
  const off = await go({ to: UNKNOWN, data: callData('setApprovalForAll', [SPENDER, false]) }, baseWorld({ scenario: () => ({ logs: [ev(false)] }) }));
  assert.ok(!ids(off.out).includes('delegate_granted'));
});

test('transfer_to_fresh_account: ETH to an address with no code, no ETH and no transactions is flagged; to a used account it is not; the whole balance to a fresh address is high severity and also a large outflow', async () => {
  const send = (to, amount) => ({ to, value: amount.toString() });
  const scen = (to, amount) => baseWorld({ scenario: () => ({ logs: [W.logEth(ME, to, amount)], apply: (s) => { s.eth.set(ME, s.eth.get(ME) - amount); s.eth.set(to, (s.eth.get(to) || 0n) + amount); } }) });
  const small = await go(send(FRESH, E18 / 100n), scen(FRESH, E18 / 100n));
  assert.deepEqual(ids(small.out), ['transfer_to_fresh_account']); assert.equal(small.out.warnings[0].severity, 'low'); assert.equal(small.out.warnings[0].account, addr(FRESH)); assert.equal(small.out.warnings[0].asset, 'ETH');
  const drain = await go(send(FRESH, 10n * E18), scen(FRESH, 10n * E18));
  assert.deepEqual(ids(drain.out).sort(), ['large_balance_outflow', 'transfer_to_fresh_account']);
  assert.equal(drain.out.warnings.find((w) => w.id === 'transfer_to_fresh_account').severity, 'high');
  assert.equal(drain.out.warnings.find((w) => w.id === 'large_balance_outflow').share_pct, 100);
  const used = await go(send(FRIEND, 10n * E18), scen(FRIEND, 10n * E18));
  assert.deepEqual(ids(used.out), ['large_balance_outflow'], 'a used account is not fresh');
  // a recipient that has a balance, or a nonce, or code is not fresh; each of the three alone is enough
  for (const w of [baseWorld({ eth: { [ME]: 10n * E18, [FRESH]: 1n }, scenario: () => ({ logs: [W.logEth(ME, FRESH, 5n)] }) }), baseWorld({ nonce: { [FRESH]: 1 }, scenario: () => ({ logs: [W.logEth(ME, FRESH, 5n)] }) }), baseWorld({ code: [FRESH], scenario: () => ({ logs: [W.logEth(ME, FRESH, 5n)] }) })]) {
    assert.ok(!ids((await go(send(FRESH, 5n), w)).out).includes('transfer_to_fresh_account'));
  }
  // the same for an ERC-20 transfer
  const tok = await go({ to: USDC, data: callData('transfer', [FRESH, 400n * ONE_USDC]) }, baseWorld({ scenario: () => ({ logs: [W.logTransfer(USDC, ME, FRESH, 400n * ONE_USDC)], apply: (s) => { s.tok.get(USDC).set(ME, 100n * ONE_USDC); } }) }));
  assert.deepEqual(ids(tok.out).sort(), ['transfer_to_fresh_account']);
  assert.equal(tok.out.warnings[0].severity, 'low', '80 percent of the balance is below the 90 percent line');
  const tokAll = await go({ to: USDC, data: callData('transfer', [FRESH, 500n * ONE_USDC]) }, baseWorld({ scenario: () => ({ logs: [W.logTransfer(USDC, ME, FRESH, 500n * ONE_USDC)] }) }));
  assert.deepEqual(ids(tokAll.out).sort(), ['large_balance_outflow', 'transfer_to_fresh_account']);
});

test('large_balance_outflow: 90 percent of the sender\'s ETH or token balance leaves; 89 does not; below 0.05 ETH it is dust', async () => {
  const eth = (amount, w = {}) => go({ to: FRIEND, value: amount.toString() }, baseWorld({ ...w, scenario: () => ({ logs: [W.logEth(ME, FRIEND, amount)] }) }));
  assert.deepEqual(ids((await eth(9n * E18)).out), ['large_balance_outflow']);
  assert.deepEqual(ids((await eth(89n * E18 / 10n)).out), []);
  assert.deepEqual(ids((await eth(E18 / 100n, { eth: { [ME]: E18 / 100n, [FRIEND]: E18 } })).out), [], 'a 0.01 ETH wallet emptied is dust');
  const tok = (amount) => go({ to: USDC, data: callData('transfer', [FRIEND, amount]) }, baseWorld({ scenario: () => ({ logs: [W.logTransfer(USDC, ME, FRIEND, amount)] }) }));
  assert.deepEqual(ids((await tok(450n * ONE_USDC)).out), ['large_balance_outflow']);
  assert.deepEqual(ids((await tok(449n * ONE_USDC)).out), []);
});

test('unknown_program: a call to a contract outside the table is flagged; a call to a known contract or to an account with no code is not', async () => {
  const unk = await go({ to: UNKNOWN, data: '0x' }, baseWorld());
  assert.deepEqual(ids(unk.out), ['unknown_program']); assert.equal(unk.out.warnings[0].program, addr(UNKNOWN)); assert.equal(unk.out.warnings[0].severity, 'medium');
  assert.deepEqual(unk.out.contracts.map((c) => [c.address, c.known]), [[addr(UNKNOWN), false]]);
  assert.deepEqual(ids((await go({ to: ROUTER, data: '0x' }, baseWorld())).out), []);
  const eoa = await go({ to: FRIEND, data: '0x' }, baseWorld());
  assert.deepEqual(ids(eoa.out), []); assert.deepEqual(eoa.out.contracts, []);
});

test('high_risk_token: a token with a not_sellable, extreme_tax or high_tax read is flagged; sellable, no_liquidity and unavailable reads are not; a well-known token is never read', async () => {
  const swap = (q = {}) => ({ to: ROUTER, data: '0x1234', value: String(E18 / 100n), ...q });
  const world = baseWorld({ scenario: () => ({ logs: [W.logEth(ME, ROUTER, E18 / 100n), W.logTransfer(JUNK, POOL, ME, 5n * E18)], apply: (s) => { s.tok.get(JUNK).set(ME, 5n * E18); } }) });
  const reads = [];
  const hp = (verdict, sell = null) => async (token) => { reads.push(token); return { verdict, sellable: verdict === 'sellable', buy_tax_pct: 2, sell_tax_pct: sell, pool: { address: POOL, venue: 'uniswap-v2', quote: 'WETH', quote_liquidity_usd: 5 }, contract: { owner_renounced: false, mintable: true, blacklist: false, pausable: false, tax_changeable: true, upgradeable: false }, disagreements: ['x'], as_of: { simulation: { block: 5000 } } }; };
  for (const verdict of ['not_sellable', 'extreme_tax', 'high_tax']) {
    const { out } = await go(swap(), world, { risk: hp(verdict, 60) });
    assert.deepEqual(ids(out), ['high_risk_token'], verdict);
    assert.equal(out.warnings[0].token, addr(JUNK)); assert.equal(out.warnings[0].verdict, verdict); assert.equal(out.warnings[0].severity, 'high');
    assert.match(out.warnings[0].message, /its token-risk read is high-risk: /);
    const t = out.tokens.find((x) => x.address === addr(JUNK)); assert.equal(t.token_risk.high_risk, true); assert.equal(t.token_risk.read.verdict, verdict); assert.equal(t.symbol, 'JUNK'); assert.equal(t.decimals, 18);
  }
  for (const verdict of ['sellable', 'no_liquidity', 'no_pool_found', 'buy_failed']) assert.deepEqual(ids((await go(swap(), world, { risk: hp(verdict) })).out), [], verdict);
  const down = await go(swap(), world, { risk: async () => { throw new Error('x'); } });
  assert.deepEqual(ids(down.out), []); assert.deepEqual(down.out.tokens.find((x) => x.address === addr(JUNK)).token_risk, { available: false, reason: 'the token-risk read failed' });
  reads.length = 0;
  await go({ to: USDC, data: callData('transfer', [FRIEND, ONE_USDC]) }, baseWorld({ scenario: () => ({ logs: [W.logTransfer(USDC, ME, FRIEND, ONE_USDC)] }) }), { risk: hp('not_sellable') });
  assert.deepEqual(reads, [], 'USDC is in the official table and is not read');
  reads.length = 0;
  await go(swap(), world, { risk: hp('sellable') });
  assert.deepEqual(reads, [JUNK], 'one read per unknown token, with the lower-case address');
});

test('authority_change: OwnershipTransferred and AdminChanged where the sender is the previous owner or admin are flagged; the same events from someone else are not', async () => {
  const own = (prev, next) => W.logRaw(UNKNOWN, ['0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0', W.pad(prev), W.pad(next)]);
  const adm = (prev, next) => W.logRaw(UNKNOWN, ['0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f'], `${W.pad(prev)}${W.pad(next).slice(2)}`);
  const w1 = await go({ to: UNKNOWN, data: callData('transferOwnership', [SPENDER]) }, baseWorld({ scenario: () => ({ logs: [own(ME, SPENDER)] }) }));
  assert.ok(ids(w1.out).includes('authority_change')); assert.match(w1.out.warnings.find((x) => x.id === 'authority_change').message, /changes the owner of contract .* from .* to /);
  const w2 = await go({ to: UNKNOWN, data: '0x' }, baseWorld({ scenario: () => ({ logs: [own(ME, '0x0000000000000000000000000000000000000000')] }) }));
  assert.match(w2.out.warnings.find((x) => x.id === 'authority_change').message, /nobody \(ownership is renounced\)/);
  const w3 = await go({ to: UNKNOWN, data: '0x' }, baseWorld({ scenario: () => ({ logs: [adm(ME, SPENDER)] }) }));
  assert.match(w3.out.warnings.find((x) => x.id === 'authority_change').message, /proxy admin/);
  const other = await go({ to: UNKNOWN, data: '0x' }, baseWorld({ scenario: () => ({ logs: [own(FRIEND, SPENDER), adm(FRIEND, SPENDER)] }) }));
  assert.ok(!ids(other.out).includes('authority_change'));
});

test('a transaction that REVERTS is an answer: 200, simulation.ok false with the revert reason, no balance changes; the warnings from the request still apply', async () => {
  const reason = V.encodeAbiParameters([{ type: 'string' }], ['transfer amount exceeds balance']);
  const revert = baseWorld({ scenario: () => ({ status: '0x0', returnData: `0x08c379a0${reason.slice(2)}`, logs: [], gasUsed: '0x5208', error: { code: 3, message: 'execution reverted' } }) });
  const { out, w } = await go({ to: FRESH, value: String(E18) }, revert);
  assert.equal(out.simulation.ok, false); assert.equal(out.simulation.error, 'reverted: transfer amount exceeds balance');
  assert.deepEqual(out.balance_changes, []); assert.match(out.balance_changes_note, /did not succeed/);
  assert.deepEqual(ids(out), ['transfer_to_fresh_account'], 'the value was addressed to a fresh account whether or not the call went through');
  assert.equal(w.calls.filter((c) => c.method === 'eth_simulateV1').length, 1, 'no second simulation for a call that failed');
  const panic = baseWorld({ scenario: () => ({ status: '0x0', returnData: `0x4e487b71${W.word(0x11).slice(2)}`, logs: [] }) });
  assert.equal((await go({ to: UNKNOWN, data: '0x' }, panic)).out.simulation.error, 'panic code 0x11');
  const custom = baseWorld({ scenario: () => ({ status: '0x0', returnData: '0xdeadbeef', logs: [] }) });
  assert.equal((await go({ to: UNKNOWN, data: '0x' }, custom)).out.simulation.error, 'reverted with custom error 0xdeadbeef');
  const bare = baseWorld({ scenario: () => ({ status: '0x0', returnData: '0x', logs: [], error: { code: -32015, message: 'out of gas' } }) });
  assert.equal((await go({ to: UNKNOWN, data: '0x' }, bare)).out.simulation.error, 'out of gas');
  // an execution error that the node reports for the whole request (insufficient funds for the value) is also a finding
  const lack = baseWorld({ scenario: () => ({ rpcError: { code: -38014, message: 'insufficient funds for transfer' } }) });
  const l = await go({ to: FRIEND, value: String(100n * E18) }, lack);
  assert.equal(l.out.simulation.ok, false); assert.equal(l.out.simulation.error, 'insufficient funds for transfer');
});

test('the requests to the RPC: one pinned block, eth_simulateV1 with traceTransfers and validation false, balances before by eth_call and after inside the second simulation; a missing `from` gets a placeholder sender with a balance override and is said so', async () => {
  const world = baseWorld({ scenario: () => ({ logs: [W.logTransfer(USDC, ME, FRIEND, ONE_USDC)] }) });
  const { out, w } = await go({ to: USDC, data: callData('transfer', [FRIEND, ONE_USDC]) }, world);
  const sims = w.calls.filter((c) => c.method === 'eth_simulateV1');
  assert.equal(sims.length, 2);
  const block = `0x${(5000).toString(16)}`;
  for (const s of sims) { assert.equal(s.params[1], block); assert.equal(s.params[0].traceTransfers, true); assert.equal(s.params[0].validation, false); assert.equal(s.params[0].blockStateCalls[0].calls[0].from, ME); assert.equal(s.params[0].blockStateCalls[0].stateOverrides, undefined); }
  assert.equal(sims[1].params[0].blockStateCalls[0].calls.length, 2, 'the transaction, then the balances after');
  assert.equal(w.calls.find((c) => c.method === 'eth_call').params[1], block);
  assert.ok(w.calls.every((c) => c.opts.timeoutMs <= L.SIM_TIMEOUT_MS));
  assert.equal(out.request.from_assumed, false);
  const none = await go({ to: WETH, data: '0xd0e30db0', value: String(E18), from: undefined }, baseWorld(), { deps: {} });
  void none;
  const w2 = W.makeEvmWorld(baseWorld());
  const out2 = await precheckBase({ chain: 'base', to: WETH, data: '0xd0e30db0', value: String(E18) }, { base: { request: w2.request }, now: Date.now, baseRisk: noRisk });
  assert.equal(out2.request.from_assumed, true);
  const s1 = w2.calls.find((c) => c.method === 'eth_simulateV1');
  const ov = s1.params[0].blockStateCalls[0].stateOverrides;
  assert.equal(Object.keys(ov).length, 1); assert.equal(Object.keys(ov)[0], D.PLACEHOLDER_SENDER.toLowerCase()); assert.equal(BigInt(Object.values(ov)[0].balance), E18 + 10n ** 18n);
  assert.equal(D.PLACEHOLDER_SENDER.length, 42);
});

test('fail closed: a Base RPC that cannot simulate is a 503 "Not charged", whichever call fails; a simulation that does not finish within the cap is a 503 with a Retry-After', async () => {
  const down = () => Object.assign(new Error('Base RPC unavailable (eth_simulateV1: timeout). Not charged.'), { status: 503, retryAfter: 30 });
  for (const method of ['eth_getBlockByNumber', 'eth_simulateV1', 'eth_call', 'eth_getCode', 'eth_getTransactionCount']) {
    const world = baseWorld({ fail: (m) => (m === method ? down() : null), scenario: () => ({ logs: [W.logEth(ME, FRESH, 1n)] }) });
    await assert.rejects(go({ to: FRESH, value: '1' }, world), (e) => e.status === 503 && /Not charged\.$/.test(e.message), method);
  }
  const hang = baseWorld({ hang: (m) => m === 'eth_simulateV1' });
  const t0 = Date.now();
  await assert.rejects(go({ to: USDC, data: '0x' }, hang, { deps: { simTimeoutMs: 200 } }), (e) => e.status === 503 && e.retryAfter > 0 && /did not finish within 8 s/.test(e.message));
  assert.ok(Date.now() - t0 < 2000);
});

test('the RPC client: it tries the endpoints in order, moves on from a rate limit, an unsupported method and a dead host, returns an execution error as an answer, and ends in a 503 when nobody answers', async () => {
  const urls = ['https://one.example', 'https://two.example', 'https://three.example'];
  const seen = [];
  const reply = (map) => async (url, init) => { seen.push(url); const r = map[url]; if (r instanceof Error) throw r; return { status: r.status || 200, json: async () => r.body }; };
  const ok = makeBaseRpc({ urls, fetchImpl: reply({ 'https://one.example': { status: 429, body: { error: { code: -32011, message: 'request limit reached' } } }, 'https://two.example': { body: { error: { code: -32601, message: 'the method does not exist' } } }, 'https://three.example': { body: { jsonrpc: '2.0', id: 1, result: '0x1' } } }) });
  assert.deepEqual(await ok.request('eth_chainId', []), { result: '0x1', host: 'three.example' }); assert.deepEqual(seen, urls);
  seen.length = 0;
  const exec = makeBaseRpc({ urls, fetchImpl: reply({ 'https://one.example': { body: { error: { code: -38014, message: 'insufficient funds' } } } }) });
  const e = await exec.request('eth_simulateV1', []); assert.equal(e.error.code, -38014); assert.deepEqual(seen, ['https://one.example'], 'an execution error is an answer, not a reason to ask the next node');
  const allDown = makeBaseRpc({ urls, fetchImpl: reply({ 'https://one.example': new Error('ECONNRESET'), 'https://two.example': { status: 502, body: null }, 'https://three.example': Object.assign(new Error('x'), { name: 'TimeoutError' }) }) });
  await assert.rejects(allDown.request('eth_simulateV1', []), (x) => x.status === 503 && /Base RPC unavailable \(eth_simulateV1: timeout\)\. Not charged\.$/.test(x.message) && x.retryAfter > 0);
  await assert.rejects(makeBaseRpc({ urls: [] }).request('eth_chainId', []), (x) => x.status === 503, 'no endpoint configured is a 503, not a crash');
  assert.deepEqual(require('../tools/r24/txprecheck/base-rpc').defaultUrls({}), ['https://mainnet.base.org', 'https://base.drpc.org']);
  assert.deepEqual(require('../tools/r24/txprecheck/base-rpc').defaultUrls({ TXPRECHECK_BASE_RPCS: 'https://a.example, https://b.example' }), ['https://a.example', 'https://b.example']);
});

test('the route entry reaches the Base half through run(); an answer is JSON-able', async () => {
  const w = W.makeEvmWorld(baseWorld());
  const out = await run({ chain: 'BASE', to: WETH, data: '0xd0e30db0', value: '1000', from: ME }, { base: { base: { request: w.request }, now: Date.now, baseRisk: noRisk } });
  assert.equal(out.chain, 'base'); assert.doesNotThrow(() => JSON.stringify(out));
});
