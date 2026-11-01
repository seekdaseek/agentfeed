// tools/r24/txprecheck/index.js: GET /api/tx-precheck (tool get_tx_precheck), $0.05: what a Solana or Base transaction would do, simulated on our own RPC before it is signed (R24 item 4, 1 Nov 2026).
//   chain=solana  tx = a base64 transaction (legacy or version 0, signed or unsigned, at most 1232 bytes)
//   chain=base    to, data (0x hex, at most 20,000 hex characters), value (wei, decimal or 0x hex), optional from
// Output: balance changes per account and token (before, after, delta), programs or contracts touched with a `known` flag from a table of official ids, approvals and delegations granted,
// new token accounts, every token involved with the existing token-risk read, warnings with stable ids, and the simulation itself (ok or the error, units or gas, logs).
// HARD RULES: the module never signs and never sends anything (test/r24-txprecheck-nosend.test.js scans the source for it). It cannot simulate -> 503, not charged. A transaction that FAILS in the
// simulation is a finding: 200 with simulation.ok false. Size and time caps are in limits.js and are enforced before any RPC call. No URL is taken from the caller, so lib/safe-fetch.js has nothing to guard here.
// The module exports `entries` (one entry shaped like the EXP entries of expansion.js) and makeEntries(deps) for tests.
'use strict';
const { z } = require('zod');
const { bad } = require('../../r23/common');
const L = require('./limits');
const { precheckSolana } = require('./solana');
const { precheckBase } = require('./evm');

const DESC = 'Use when an agent needs to see what a Solana or Base transaction does before signing it. Returns simulated balance changes, programs or contracts, approvals, new accounts, token-risk reads and warnings. 503 if it cannot simulate: not charged.';

/** the handler; `deps` is { sol, base } for tests, undefined on the real server (each chain then builds its own default dependencies) */
async function run(args, deps = {}) {
  const a = args || {};
  for (const k of ['chain', 'tx', 'to', 'data', 'value', 'from']) if (Array.isArray(a[k])) throw bad(`${k} was given more than once`);
  const chain = String(a.chain == null ? '' : a.chain).trim().toLowerCase();
  if (!chain) throw bad('missing required parameter: chain, solana or base');
  if (chain === 'solana') return precheckSolana(a, deps.sol);
  if (chain === 'base') return precheckBase(a, deps.base);
  throw bad(`chain ${chain.slice(0, 20)} is not covered; use solana or base`);
}

function makeEntries(deps) {
  return [{
    name: 'get_tx_precheck', route: 'GET /api/tx-precheck', usd: 0.05,
    tags: ['security', 'simulation', 'transactions', 'wallet', 'solana', 'base', 'approvals', 'token-risk'],
    desc: DESC,
    schema: {
      chain: z.enum(['solana', 'base']).describe('the chain of the transaction: solana or base'),
      tx: z.string().max(L.MAX_SOL_TX_B64).optional().describe(`chain=solana: the transaction as base64, legacy or version 0, signed or unsigned, at most ${L.MAX_SOL_TX_BYTES} bytes`),
      to: z.string().max(42).optional().describe('chain=base: the 0x address the transaction calls'),
      data: z.string().max(L.MAX_EVM_DATA_HEX + 2).optional().describe(`chain=base: calldata as 0x hex, at most ${L.MAX_EVM_DATA_HEX} hex characters (default 0x)`),
      value: z.string().max(80).optional().describe('chain=base: wei to send, decimal or 0x hex (default 0)'),
      from: z.string().max(42).optional().describe('chain=base: the sender, a 0x address (default: a placeholder sender that holds nothing)'),
    },
    title: 'Transaction precheck',
    question: 'What would this Solana or Base transaction do to the wallet that signs it, before it is signed?',
    example: require('./example').build(),
    run: (args) => run(args, deps),
  }];
}

module.exports = { entries: makeEntries(), makeEntries, run, DESC };
