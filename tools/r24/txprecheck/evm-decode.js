// tools/r24/txprecheck/evm-decode.js: the Base (EVM) half of GET /api/tx-precheck that only reads bytes: the request, the calldata, the logs a simulation returns (R24 item 4).
// Nothing here talks to the network and nothing here signs or sends anything.
'use strict';
const V = require('viem');
const { bad } = require('../../r23/common');
const L = require('./limits');

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ETH_PSEUDO = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';       // the emitter of the transfer logs that eth_simulateV1 adds when traceTransfers is on (ERC-7528)
const ZERO = '0x0000000000000000000000000000000000000000';
const PLACEHOLDER_SENDER = `0x${'00'.repeat(16)}a11ce000`;            // used when the caller gives no `from`; it has no history and no tokens

const TOPIC = Object.freeze({
  transfer: V.toEventSelector('Transfer(address,address,uint256)'),
  approval: V.toEventSelector('Approval(address,address,uint256)'),
  approvalForAll: V.toEventSelector('ApprovalForAll(address,address,bool)'),
  permit2Approval: V.toEventSelector('Approval(address,address,address,uint160,uint48)'),
  ownershipTransferred: V.toEventSelector('OwnershipTransferred(address,address)'),
  adminChanged: V.toEventSelector('AdminChanged(address,address)'),
});

// the calls whose arguments are shown in `request.call`; anything else shows its 4-byte selector only
const CALL_ABI = V.parseAbi([
  'function approve(address spender, uint256 amount)', 'function transfer(address to, uint256 amount)', 'function transferFrom(address from, address to, uint256 amount)',
  'function increaseAllowance(address spender, uint256 addedValue)', 'function setApprovalForAll(address operator, bool approved)', 'function deposit()', 'function withdraw(uint256 amount)',
  'function transferOwnership(address newOwner)', 'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
]);
const TOKEN_CALLS = new Set(['approve', 'transfer', 'transferFrom', 'increaseAllowance']);

const norm = (a) => String(a).toLowerCase();
const cs = (a) => V.getAddress(a);
const topicAddr = (t) => `0x${String(t).slice(26)}`.toLowerCase();

/** the request, checked: every cap is enforced here, before any RPC call. Throws the caller's 400. */
function parseInput(q) {
  const toRaw = q.to == null ? '' : String(q.to).trim();
  if (!toRaw) throw bad('missing required parameter: to, a 0x contract or account address on Base (a transaction that creates a contract is not covered)');
  if (!ADDR_RE.test(toRaw)) throw bad('to must be a 0x address (40 hex characters)');
  let data = q.data == null ? '' : String(q.data).trim();
  if (data === '') data = '0x';
  else if (!/^0x/i.test(data) && /^[0-9a-fA-F]+$/.test(data)) data = `0x${data}`;
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) throw bad('data must be hex with an even number of digits (0x...)');
  if (data.length - 2 > L.MAX_EVM_DATA_HEX) throw bad(`data is ${data.length - 2} hex characters; the cap is ${L.MAX_EVM_DATA_HEX}`);
  let value = 0n;
  const vRaw = q.value == null ? '' : String(q.value).trim();
  if (vRaw !== '') {
    if (/^[0-9]+$/.test(vRaw)) value = BigInt(vRaw);
    else if (/^0x[0-9a-fA-F]+$/.test(vRaw)) value = BigInt(vRaw);
    else throw bad('value must be wei as a decimal number or 0x hex');
    if (value >= 1n << BigInt(L.MAX_EVM_VALUE_BITS)) throw bad('value is above the largest uint256');
  }
  const fromRaw = q.from == null ? '' : String(q.from).trim();
  if (fromRaw && !ADDR_RE.test(fromRaw)) throw bad('from must be a 0x address (40 hex characters)');
  return { to: cs(toRaw), data: data.toLowerCase(), value, from: fromRaw ? cs(fromRaw) : null };
}

/** { selector, name, args } for the calldata; name and args are null for a selector outside CALL_ABI */
function decodeCall(data) {
  if (data.length < 10) return { selector: null, name: null, args: null, is_token_call: false };
  const selector = data.slice(0, 10);
  try {
    const d = V.decodeFunctionData({ abi: CALL_ABI, data });
    const args = (d.args || []).map((x) => (typeof x === 'bigint' ? x.toString() : Array.isArray(x) ? x.map(String) : String(x)));
    return { selector, name: d.functionName, args, is_token_call: TOKEN_CALLS.has(d.functionName) };
  } catch { return { selector, name: null, args: null, is_token_call: false }; }
}

/** Error(string) and Panic(uint256) revert data as a sentence; the 4-byte selector of anything else */
function revertReason(hex) {
  if (!hex || hex === '0x') return 'reverted without a reason';
  try {
    if (hex.startsWith('0x08c379a0')) return `reverted: ${V.decodeAbiParameters([{ type: 'string' }], `0x${hex.slice(10)}`)[0]}`.slice(0, 200);
    if (hex.startsWith('0x4e487b71')) return `panic code 0x${V.decodeAbiParameters([{ type: 'uint256' }], `0x${hex.slice(10)}`)[0].toString(16)}`;
  } catch { /* fall through */ }
  return `reverted with custom error ${hex.slice(0, 10)}`;
}

const wordAmount = (data) => (typeof data === 'string' && /^0x[0-9a-fA-F]{64}$/.test(data) ? BigInt(data) : null);

/** the events of one simulation that the assessment reads */
function decodeLogs(logs) {
  const out = { erc20Transfers: [], ethTransfers: [], nftTransfers: [], erc20Approvals: [], permit2Approvals: [], approvalsForAll: [], ownership: [], admin: [], emitters: [] };
  const em = new Set();
  for (const l of logs || []) {
    const t = (l.topics || []).map((x) => String(x).toLowerCase()); const e = norm(l.address || ''); const t0 = t[0];
    if (!t0 || !ADDR_RE.test(l.address || '')) continue;
    if (t0 === TOPIC.transfer && t.length === 3) {
      const amount = wordAmount(l.data); if (amount == null) continue;
      const rec = { token: e, from: topicAddr(t[1]), to: topicAddr(t[2]), amount };
      if (e === ETH_PSEUDO) out.ethTransfers.push(rec); else { out.erc20Transfers.push(rec); em.add(e); }
    } else if (t0 === TOPIC.transfer && t.length === 4) { out.nftTransfers.push({ collection: e, from: topicAddr(t[1]), to: topicAddr(t[2]), token_id: BigInt(t[3]).toString() }); em.add(e); }
    else if (t0 === TOPIC.approval && t.length === 3) { const amount = wordAmount(l.data); if (amount != null) { out.erc20Approvals.push({ token: e, owner: topicAddr(t[1]), spender: topicAddr(t[2]), amount }); em.add(e); } }
    else if (t0 === TOPIC.approvalForAll && t.length === 3) { const v = wordAmount(l.data); if (v != null) { out.approvalsForAll.push({ collection: e, owner: topicAddr(t[1]), operator: topicAddr(t[2]), approved: v !== 0n }); em.add(e); } }
    else if (t0 === TOPIC.permit2Approval && t.length === 4 && typeof l.data === 'string' && /^0x[0-9a-fA-F]{128}$/.test(l.data)) {
      out.permit2Approvals.push({ permit2: e, owner: topicAddr(t[1]), token: topicAddr(t[2]), spender: topicAddr(t[3]), amount: BigInt(`0x${l.data.slice(2, 66)}`), expiration: Number(BigInt(`0x${l.data.slice(66, 130)}`)) }); em.add(e);
    } else if (t0 === TOPIC.ownershipTransferred && t.length === 3) { out.ownership.push({ contract: e, previous: topicAddr(t[1]), next: topicAddr(t[2]) }); em.add(e); }
    else if (t0 === TOPIC.adminChanged && l.data && /^0x[0-9a-fA-F]{128}$/.test(l.data)) { out.admin.push({ contract: e, previous: `0x${l.data.slice(26, 66)}`.toLowerCase(), next: `0x${l.data.slice(90, 130)}`.toLowerCase() }); em.add(e); }
    else em.add(e);
  }
  out.emitters = [...em].filter((a) => a !== ETH_PSEUDO);
  return out;
}

module.exports = { ADDR_RE, ETH_PSEUDO, ZERO, PLACEHOLDER_SENDER, TOPIC, parseInput, decodeCall, revertReason, decodeLogs, norm, cs };
