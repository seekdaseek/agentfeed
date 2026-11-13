// test/helpers/batch-claim-mocks.js — preloaded (node -r) into ops/batch-claim.js by test/batch-claim.test.js.
//
// Replaces everything the job talks to — the CDP facilitator, the chain, the channel store, Telegram — with a
// scripted fake driven by the BC_SCENARIO env var (JSON), so the job's own decisions are what is under test:
//   channels  [{ channelId, chargedCumulativeAmount, totalClaimed }]   the local channel store
//   claim     { mode: 'ok' | 'too_low' | 'error', tx }                 what mgr.claim() does (ok marks every claimed channel)
//             { rule: 'entry' | 'total', min, failIds }                a minimum per channel entry, or on the batch total (as CDP's may be);
//                                                                      failIds: a single-channel claim of these ids fails for another reason
//   settle    ['ok' | 'too_low' | 'nothing' | 'error', ...]                        one outcome per mgr.settle() call, the last repeats
//   chain     ['0', '2500', 'ERR', ...]                                claimed-but-unsettled per receivers() read, the last repeats
//   withdraw  { amount, initiatedAt } | 'ERR'                          what pendingWithdrawals() answers for every channel
// Telegram (fetch) is recorded to BC_FETCH_LOG instead of being sent. Nothing here touches the network or a real DB.
'use strict';
const fs = require('fs');
const Module = require('module');

const S = JSON.parse(process.env.BC_SCENARIO || '{}');
const channels = (S.channels || []).map((c) => ({ ...c }));
const settleSeq = [...(S.settle || [])];
const chainSeq = [...(S.chain || ['0'])];
const trace = (o) => { if (process.env.BC_TRACE) fs.appendFileSync(process.env.BC_TRACE, JSON.stringify(o) + '\n'); };

function settleError(kind) {
  const reason = kind === 'too_low' ? 'amount_too_low' : kind === 'nothing' ? 'invalid_batch_settlement_evm_nothing_to_settle' : null;
  const e = new Error(reason || 'Facilitator settle failed (500): boom');
  if (reason) { e.name = 'SettleError'; e.errorReason = reason; e.statusCode = 400; }
  return e;
}

const mgr = {
  receiver: '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6',
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  async claim(opts) {
    const c = S.claim || { mode: 'ok', tx: '0xclaim' };
    const owed = (x) => BigInt(x.chargedCumulativeAmount) - BigInt(x.totalClaimed);
    const all = channels.filter((x) => owed(x) > 0n);
    const todo = opts && opts.selectClaimChannels
      ? opts.selectClaimChannels(all.map((x) => ({ ...x }))).map((sel) => all.find((x) => x.channelId === sel.channelId)).filter(Boolean)
      : all;
    const total = todo.reduce((a, x) => a + owed(x), 0n);
    trace({ call: 'claim', mode: c.mode || c.rule, ids: todo.map((x) => x.channelId), total: String(total) });
    if (c.mode === 'too_low') throw settleError('too_low');
    if (c.mode === 'error') throw settleError('error');
    if (c.failIds && todo.length === 1 && c.failIds.includes(todo[0].channelId)) throw settleError('error'); // a channel the facilitator cannot process
    if (c.rule && todo.length) { // the minimum CDP does not publish, as each reading of it would behave
      const min = BigInt(c.min);
      if (c.rule === 'entry' ? todo.some((x) => owed(x) < min) : total < min) throw settleError('too_low');
    }
    for (const x of todo) x.totalClaimed = x.chargedCumulativeAmount;
    return todo.length ? [{ vouchers: todo.length, transaction: c.tx || '0xclaim' }] : [];
  },
  async settle() {
    const outcome = settleSeq.length > 1 ? settleSeq.shift() : (settleSeq[0] || 'ok');
    trace({ call: 'settle', outcome });
    if (outcome === 'ok') return { transaction: '0xsettle' };
    throw settleError(outcome);
  },
};

const scheme = { getStorage: () => ({ list: async () => channels.map((c) => ({ ...c })) }), createChannelManager: () => mgr };

const MOCKS = {
  'better-sqlite3': class FakeDatabase { constructor() {} },
  '@x402/core/server': { HTTPFacilitatorClient: class FakeFacilitator { constructor() {} } },
  '../lib/cdp-facilitator': { facilitator: {} },
  '@x402/evm': { BATCH_SETTLEMENT_ADDRESS: '0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003' },
  viem: {
    http: () => ({}),
    parseAbi: (x) => x,
    createPublicClient: () => ({
      async readContract({ functionName } = {}) {
        if (functionName === 'pendingWithdrawals') {
          trace({ call: 'withdrawal-read' });
          if (S.withdraw === 'ERR') throw new Error('rpc down');
          const w = S.withdraw || { amount: '0', initiatedAt: 0 };
          return [BigInt(w.amount), BigInt(w.initiatedAt)];
        }
        const v = chainSeq.length > 1 ? chainSeq.shift() : chainSeq[0];
        trace({ call: 'read', value: v });
        if (v === 'ERR') throw new Error('rpc down');
        return [BigInt(v), 0n];
      },
    }),
  },
  'viem/chains': { base: { id: 8453 }, polygon: { id: 137 }, arbitrum: { id: 42161 } },
  '../lib/hf': {
    hfConfig: () => ({ batch: { networks: ['eip155:8453'], receiver: mgr.receiver } }),
    batchSchemes: () => [{ network: 'eip155:8453', scheme }],
    NAMES: { 'eip155:8453': 'Base' },
  },
};

const load = Module._load;
Module._load = function patched(request, ...rest) {
  if (Object.prototype.hasOwnProperty.call(MOCKS, request)) return MOCKS[request];
  return load.call(this, request, ...rest);
};

global.fetch = async (url) => {
  if (process.env.BC_FETCH_LOG) fs.appendFileSync(process.env.BC_FETCH_LOG, JSON.stringify({ url: String(url).replace(/bot[^/]+/, 'bot<token>') }) + '\n');
  return { json: async () => ({ ok: true }) };
};
