// tools/r24/txprecheck/evm.js: the I/O half of GET /api/tx-precheck for chain=base (R24 item 4). It SIMULATES the transaction request on our own RPC and hands the facts to evm-assess.js.
// It never signs and never sends: it asks the node to run a call and read state, nothing more.
//
// Which RPC methods, and why (measured 1 Nov 2026 on mainnet.base.org, base.drpc.org and base-rpc.publicnode.com):
//   eth_simulateV1 (traceTransfers true)  the standard, keyless way to run a call WITH its logs and ETH transfers, with state overrides, at a pinned block. Served by all three. 40 CU on Alchemy.
//   eth_call (Multicall3 aggregate3)      balances and token metadata before the transaction, at the same pinned block.
//   eth_getCode, eth_getTransactionCount  whether the target has code and whether a recipient was ever used.
//   not used: debug_traceCall (mainnet.base.org refuses it, dRPC serves it: the answer would depend on which endpoint replied) and alchemy_simulateAssetChanges (needs a key, 2,500 CU a call).
// Flow, all at ONE block N: [N] -> simulate [tx] (logs tell which tokens and accounts are touched) -> in parallel: balances before (eth_call), simulate [tx, balances after], code and nonce of the recipients.
// A transaction that REVERTS in the simulation is an answer (simulation.ok false); an RPC that cannot simulate is a 503, not charged.
'use strict';
const V = require('viem');
const { unavailable } = require('../../r23/common');
const Kn = require('./known');
const L = require('./limits');
const D = require('./evm-decode');
const E = require('./evm-assess');
const R = require('./risk');
const U = require('./util');
const { makeBaseRpc } = require('./base-rpc');

const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ABI = V.parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
  'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function name() view returns (string)',
]);
const GAS = '0x1c9c380';                                              // 30,000,000: the same ceiling the honeypot simulator uses
const hex = (n) => `0x${n.toString(16)}`;
const METHOD = 'eth_simulateV1 with traceTransfers, pinned to one block, balances read with Multicall3 eth_call at that block';

function defaultDeps() {
  return { base: makeBaseRpc(), now: Date.now, ...R.defaultDeps() };
}

const enc = (fn, args = []) => V.encodeFunctionData({ abi: ABI, functionName: fn, args });
const mcCall = (calls) => enc('aggregate3', [calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))]);
const mcRead = (returnData, n) => {
  const out = V.decodeFunctionResult({ abi: ABI, functionName: 'aggregate3', data: returnData });
  if (out.length !== n) throw unavailable('the Base RPC answered a balance read with an unexpected shape', L.RETRY_AFTER_S);
  return out;
};
const decodeText = (r) => {
  if (!r || !r.success || r.returnData === '0x') return null;
  try { return String(V.decodeAbiParameters([{ type: 'string' }], r.returnData)[0]).slice(0, 40); } catch { /* maybe a bytes32 */ }
  try { return V.hexToString(r.returnData.slice(0, 66), { size: 32 }).replace(/\0+$/g, '').slice(0, 40) || null; } catch { return null; }
};
const decodeUint = (r) => { if (!r || !r.success || r.returnData === '0x') return null; try { return BigInt(r.returnData); } catch { return null; } };

/** one call's result out of an eth_simulateV1 answer */
function callOf(answer, index, count) {
  const blocks = answer.result;
  const calls = Array.isArray(blocks) && blocks[0] && blocks[0].calls;
  if (!Array.isArray(calls) || calls.length !== count) throw unavailable('the Base RPC answered the simulation with an unexpected shape', L.RETRY_AFTER_S);
  return calls[index];
}

async function precheckBase(q, deps = defaultDeps()) {
  const input = D.parseInput(q);                                       // 400 before any RPC: addresses, hex, size caps
  const started = deps.now();
  const simMs = deps.simTimeoutMs || L.SIM_TIMEOUT_MS;                  // tests shorten it; the route always uses the 8 s cap
  const left = () => Math.max(300, simMs - (deps.now() - started));
  const rpc = (method, params) => deps.base.request(method, params, { timeoutMs: left() });
  const senderAssumed = !input.from;
  const sender = D.norm(input.from || D.PLACEHOLDER_SENDER);
  const target = D.norm(input.to);
  const call = D.decodeCall(input.data);

  const gather = async () => {
    const head = (await rpc('eth_getBlockByNumber', ['latest', false])).result;
    if (!head || !head.number || !head.timestamp) throw unavailable('the Base RPC answered the head block with an unexpected shape', L.RETRY_AFTER_S);
    const block = { number: parseInt(head.number, 16), timestamp: parseInt(head.timestamp, 16) };
    const at = hex(block.number);
    const tx = { from: sender, to: target, data: input.data, ...(input.value > 0n ? { value: hex(input.value) } : {}), gas: GAS };
    const overrides = senderAssumed ? { stateOverrides: { [sender]: { balance: hex(input.value + 10n ** 18n) } } } : {};
    const simReq = (calls) => [{ blockStateCalls: [{ calls, ...overrides }], traceTransfers: true, validation: false }, at];

    const s1 = await rpc('eth_simulateV1', simReq([tx]));
    let sim; let ev; let logCount = 0;
    if (s1.error) { sim = { ok: false, error: String(s1.error.message || 'the transaction cannot execute').slice(0, 200), returnData: null, gasUsed: null }; ev = D.decodeLogs([]); }
    else {
      const c = callOf(s1, 0, 1); const ok = c.status === '0x1';
      sim = { ok, error: ok ? null : (c.error && c.error.message && c.returnData === '0x' ? String(c.error.message).slice(0, 200) : D.revertReason(c.returnData)), returnData: c.returnData || null, gasUsed: c.gasUsed ? parseInt(c.gasUsed, 16) : null };
      ev = D.decodeLogs(ok ? c.logs : []);
      logCount = ok && Array.isArray(c.logs) ? c.logs.length : 0;
    }
    const plan = E.probePlan(input, sender, call, ev);
    const preCalls = [
      ...plan.tokens.flatMap((t) => [{ target: t, data: enc('decimals') }, { target: t, data: enc('symbol') }, { target: t, data: enc('name') }]),
      ...plan.pairs.map((p) => ({ target: p.token, data: enc('balanceOf', [p.addr]) })),
      ...plan.ethAddrs.map((a) => ({ target: MC3, data: enc('getEthBalance', [a]) })),
    ];
    const postCalls = preCalls.slice(plan.tokens.length * 3);
    const codeAddrs = U.unique([target, ...plan.recipients]);
    const [preAns, postAns, codes, nonces] = await Promise.all([
      rpc('eth_call', [{ to: MC3, data: mcCall(preCalls) }, at]),
      sim.ok && postCalls.length ? rpc('eth_simulateV1', simReq([tx, { from: D.ZERO, to: MC3, data: mcCall(postCalls) }])) : Promise.resolve(null),
      Promise.all(codeAddrs.map((a) => rpc('eth_getCode', [a, at]))),
      Promise.all(plan.recipients.map((a) => rpc('eth_getTransactionCount', [a, at]))),
    ]);

    const pre = new Map(); const meta = new Map(); let post = null;
    const preRes = mcRead(preAns.result, preCalls.length);
    let i = 0;
    for (const t of plan.tokens) { const dec = decodeUint(preRes[i]); meta.set(t, { decimals: dec == null ? undefined : Number(dec), symbol: decodeText(preRes[i + 1]), name: decodeText(preRes[i + 2]) }); i += 3; }
    for (const p of plan.pairs) { const v = decodeUint(preRes[i++]); if (v != null) pre.set(E.tokKey(p.token, p.addr), v); }
    for (const a of plan.ethAddrs) { const v = decodeUint(preRes[i++]); if (v != null) pre.set(E.ethKey(a), v); }
    if (sim.ok && postAns) {
      if (postAns.error) throw unavailable('the Base RPC could not read balances after the transaction', L.RETRY_AFTER_S);
      const postRes = mcRead(callOf(postAns, 1, 2).returnData, postCalls.length);
      post = new Map(); let j = 0;
      for (const p of plan.pairs) { const v = decodeUint(postRes[j++]); if (v != null) post.set(E.tokKey(p.token, p.addr), v); }
      for (const a of plan.ethAddrs) { const v = decodeUint(postRes[j++]); if (v != null) post.set(E.ethKey(a), v); }
    } else if (sim.ok) post = new Map();
    const code = new Map(codeAddrs.map((a, k) => [a, typeof codes[k].result === 'string' && codes[k].result !== '0x']));
    const nonce = new Map(plan.recipients.map((a, k) => [a, typeof nonces[k].result === 'string' ? parseInt(nonces[k].result, 16) : undefined]).filter(([, v]) => v !== undefined));
    return { block, sim, ev, plan, pre, post, meta, code, nonce, logCount };
  };
  const g = await U.withTimeout(gather(), simMs, () => unavailable(`the simulation did not finish within ${L.SIM_TIMEOUT_MS / 1000} s`, L.RETRY_AFTER_S));

  const ids = g.plan.definite.filter((t) => { const k = Kn.baseContract(t); return !(k && k.kind === 'token'); });
  const risk = await R.readAll(ids, deps.baseRisk, deps.now);
  return E.assessBase({ input: { ...input, to: target }, sender, senderAssumed, call, block: g.block, sim: g.sim, ev: g.ev, pre: g.pre, post: g.post, meta: g.meta, code: g.code, nonce: g.nonce, risk, logCount: g.logCount, method: METHOD, at: new Date(deps.now()).toISOString() });
}

module.exports = { precheckBase, defaultDeps, METHOD };
