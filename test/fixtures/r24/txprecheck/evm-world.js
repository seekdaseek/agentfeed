// test/fixtures/r24/txprecheck/evm-world.js: a fake Base RPC for the tests of GET /api/tx-precheck (R24 item 4). It answers the five methods the route uses (eth_getBlockByNumber, eth_simulateV1, eth_call to
// Multicall3, eth_getCode, eth_getTransactionCount) from a small in-memory world: ETH and token balances, which addresses have code, nonces, token metadata, and a SCENARIO function that says what the
// transaction under test does (its logs, and the balance changes it makes). Nothing is sent anywhere; every request is recorded in `calls`.
'use strict';
const V = require('viem');

const MC3 = '0xca11bde05977b3631167028862be2a173976ca11';
const ABI = V.parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)', 'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)',
  'function symbol() view returns (string)', 'function name() view returns (string)',
]);
const TOPIC_TRANSFER = V.toEventSelector('Transfer(address,address,uint256)');
const TOPIC_APPROVAL = V.toEventSelector('Approval(address,address,uint256)');
const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const pad = (a) => `0x${'0'.repeat(24)}${String(a).slice(2).toLowerCase()}`;
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const l = (address, topics, data = '0x') => ({ address, topics, data, blockHash: '0x00', blockNumber: '0x1', blockTimestamp: '0x1', transactionHash: '0x00', transactionIndex: '0x0', logIndex: '0x0', removed: false });
const logTransfer = (token, from, to, amount) => l(token, [TOPIC_TRANSFER, pad(from), pad(to)], word(amount));
const logEth = (from, to, amount) => logTransfer(ETH, from, to, amount);
const logApproval = (token, owner, spender, amount) => l(token, [TOPIC_APPROVAL, pad(owner), pad(spender)], word(amount));
const logRaw = l;

/**
 * world = { head, eth: {addr: BigInt}, tok: {token: {addr: BigInt}}, meta: {token: {symbol,name,decimals}}, code: [addr], nonce: {addr: n}, scenario(call) -> { status, returnData, logs, gasUsed, error, apply(state) } | { rpcError }, fail(method) -> Error | undefined }
 * All addresses lower-case.
 */
function makeEvmWorld(world) {
  const calls = [];
  const base = () => ({ eth: new Map(Object.entries(world.eth || {})), tok: new Map(Object.entries(world.tok || {}).map(([t, m]) => [t, new Map(Object.entries(m))])) });
  const aggregate = (state, data) => {
    const dec = V.decodeFunctionData({ abi: ABI, data });
    const out = dec.args[0].map((c) => {
      let fn; try { fn = V.decodeFunctionData({ abi: ABI, data: c.callData }); } catch { return { success: false, returnData: '0x' }; }
      const t = c.target.toLowerCase();
      const meta = (world.meta || {})[t];
      const enc = (name, value) => ({ success: true, returnData: V.encodeFunctionResult({ abi: ABI, functionName: name, result: value }) });
      if (fn.functionName === 'getEthBalance') return enc('getEthBalance', state.eth.get(fn.args[0].toLowerCase()) ?? 0n);
      if (fn.functionName === 'balanceOf') { const m = state.tok.get(t); return m ? enc('balanceOf', m.get(fn.args[0].toLowerCase()) ?? 0n) : { success: false, returnData: '0x' }; }
      if (fn.functionName === 'decimals' && meta) return enc('decimals', meta.decimals);
      if (fn.functionName === 'symbol' && meta) return enc('symbol', meta.symbol);
      if (fn.functionName === 'name' && meta) return enc('name', meta.name);
      return { success: false, returnData: '0x' };
    });
    return V.encodeFunctionResult({ abi: ABI, functionName: 'aggregate3', result: out });
  };
  const request = async (method, params, opts) => {
    calls.push({ method, params, opts });
    if (world.fail) { const e = world.fail(method, params); if (e) throw e; }
    if (world.hang && world.hang(method)) return new Promise(() => {});
    if (method === 'eth_getBlockByNumber') return { result: { number: `0x${(world.head || { number: 1000 }).number.toString(16)}`, timestamp: `0x${(world.head || { timestamp: 1_800_000_000 }).timestamp.toString(16)}` }, host: 'stub' };
    if (method === 'eth_getCode') return { result: (world.code || []).includes(params[0].toLowerCase()) ? '0x6080604052' : '0x', host: 'stub' };
    if (method === 'eth_getTransactionCount') return { result: `0x${((world.nonce || {})[params[0].toLowerCase()] || 0).toString(16)}`, host: 'stub' };
    if (method === 'eth_call') return { result: aggregate(base(), params[0].data), host: 'stub' };
    if (method === 'eth_simulateV1') {
      const state = base(); const results = [];
      for (const c of params[0].blockStateCalls[0].calls) {
        if (c.to.toLowerCase() === MC3) { results.push({ status: '0x1', returnData: aggregate(state, c.data), logs: [], gasUsed: '0x1' }); continue; }
        const sc = world.scenario(c);
        if (sc.throw) throw sc.throw;
        if (sc.rpcError) return { error: sc.rpcError, host: 'stub' };
        if (sc.status === '0x1' && sc.apply) sc.apply(state);
        results.push({ status: sc.status || '0x1', returnData: sc.returnData || '0x', logs: sc.logs || [], gasUsed: sc.gasUsed || '0x5208', ...(sc.error ? { error: sc.error } : {}) });
      }
      return { result: [{ number: '0x1', calls: results }], host: 'stub' };
    }
    throw new Error(`unexpected method ${method}`);
  };
  return { request, calls };
}

module.exports = { makeEvmWorld, MC3, ETH, logTransfer, logEth, logApproval, logRaw, word, pad, TOPIC_TRANSFER, TOPIC_APPROVAL };
