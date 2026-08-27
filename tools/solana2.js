// tools/solana2.js — expansion: Solana suite (5 tools).
// Helius RPC + enhanced API (key already in .env) + Jito public tip API.
// Everything cached — Helius credits are metered.
'use strict';
const { cached, fetchJson } = require('../lib/cache');

const HELIUS_RPC = () => process.env.HELIUS_RPC || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const HELIUS_ENH = () => process.env.HELIUS_ENH || 'https://api.helius.xyz';
const JITO = () => process.env.JITO_API || 'https://bundles.jito.wtf';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function rpc(method, params) {
  const j = await fetchJson(HELIUS_RPC(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'agentfeed', method, params }),
    timeoutMs: 10_000,
  });
  if (j.error) {
    const e = new Error(`helius rpc: ${j.error.message}`);
    // A mint whose holder set is too large to enumerate is the CALLER naming
    // something the upstream cannot answer for, not a fault here. Same class as
    // bybit retCode 10001 in derivs/micro/positioning, and tagged at the shared
    // helper for the same reason those are. Without this the three most obvious
    // mints anyone would try - SOL, USDC, BONK - return 502 from
    // /telegraph/api/token-holders, and telegraph's validator FAILS an endpoint
    // on 5xx while passing a 4xx, so a registered route reads as dead.
    //
    // Matched on BOTH the JSON-RPC code and the wording, deliberately narrow:
    // -32600 is the generic "Invalid Request" and Helius reuses it, so matching
    // the code alone would blame the caller for unrelated upstream failures.
    if (j.error.code === -32600 && /too many accounts/i.test(j.error.message || '')) {
      e.badRequest = true;
    }
    throw e;
  }
  return j.result;
}

// ---- get_token_holders ($0.02) — top holders + concentration metrics
async function getTokenHolders(p = {}) {
  const mint = p.mint;
  // A malformed or absent mint is the caller's input, so it is a 400 like the
  // too-many-accounts case above. server.js tool() already answers 400 for any
  // throw, so this changes nothing on the paid rail; it exists for telegraph's
  // statusFor(), which otherwise reads an untagged throw as 502 and fails a
  // healthy registered endpoint when a validator probes it with no argument.
  if (!BASE58_RE.test(mint || '')) { const e = new Error('invalid mint address'); e.badRequest = true; throw e; }
  return cached(`holders:${mint}`, 60_000, async () => {
    const [asset, largest] = await Promise.all([
      rpc('getAsset', { id: mint }),
      rpc('getTokenLargestAccounts', [mint]),
    ]);
    const ti = asset?.token_info || {};
    const decimals = ti.decimals ?? 0;
    const supply = ti.supply != null ? ti.supply / Math.pow(10, decimals) : null;
    const accounts = (largest?.value || []).map((a) => ({
      address: a.address,
      amount: parseFloat(a.uiAmountString ?? a.uiAmount ?? 0),
    }));
    const pctOf = (k) => (supply ? Number(((accounts.slice(0, k).reduce((s, a) => s + a.amount, 0) / supply) * 100).toFixed(2)) : null);
    return {
      mint, symbol: asset?.content?.metadata?.symbol || null, supply,
      top_accounts: accounts.map((a) => ({ ...a, pct: supply ? Number(((a.amount / supply) * 100).toFixed(2)) : null })),
      concentration: { top1_pct: pctOf(1), top5_pct: pctOf(5), top10_pct: pctOf(10) },
      note: 'token accounts, not unique owners — pools and exchanges included. Fails for mega-holder tokens (USDC-scale).',
    };
  });
}

// ---- get_wallet_activity ($0.02) — parsed recent transactions, human-readable
async function getWalletActivity(p = {}) {
  const wallet = p.wallet;
  if (!BASE58_RE.test(wallet || '')) { const e = new Error('invalid wallet address'); e.badRequest = true; throw e; }
  const limit = Math.min(Math.max(parseInt(p.limit) || 10, 1), 25);
  return cached(`activity:${wallet}:${limit}`, 30_000, async () => {
    const txs = await fetchJson(
      `${HELIUS_ENH()}/v0/addresses/${wallet}/transactions?api-key=${process.env.HELIUS_API_KEY}&limit=${limit}`,
      { timeoutMs: 12_000 });
    return {
      wallet, tx_count: txs.length,
      transactions: txs.map((t) => ({
        signature: t.signature,
        ts: t.timestamp,
        type: t.type || null,
        source: t.source || null,
        description: t.description || null,
        fee_sol: t.fee != null ? t.fee / 1e9 : null,
        failed: !!t.transactionError,
      })),
      source: 'helius-enhanced',
    };
  });
}

// ---- get_priority_fees ($0.005) — what to tip the network right now
async function getPriorityFees() {
  return cached('priofees', 10_000, async () => {
    const r = await rpc('getPriorityFeeEstimate', [{ options: { includeAllPriorityFeeLevels: true } }]);
    const l = r?.priorityFeeLevels || {};
    return {
      unit: 'micro-lamports per compute unit',
      levels: { min: l.min, low: l.low, medium: l.medium, high: l.high, very_high: l.veryHigh, unsafe_max: l.unsafeMax },
      recommended: l.high ?? null,
      source: 'helius getPriorityFeeEstimate',
    };
  });
}

// ---- get_jito_tips ($0.005) — Jito bundle tip floor percentiles
async function getJitoTips() {
  return cached('jitotips', 15_000, async () => {
    const arr = await fetchJson(`${JITO()}/api/v1/bundles/tip_floor`);
    const t = Array.isArray(arr) ? arr[0] : arr;
    if (!t) throw new Error('jito: empty tip_floor response');
    return {
      unit: 'SOL',
      percentiles: {
        p25: t.landed_tips_25th_percentile,
        p50: t.landed_tips_50th_percentile,
        p75: t.landed_tips_75th_percentile,
        p95: t.landed_tips_95th_percentile,
        p99: t.landed_tips_99th_percentile,
      },
      ema_p50: t.ema_landed_tips_50th_percentile ?? null,
      read: 'tip >= p75 to land bundles reliably in contested blocks',
      source: 'jito tip_floor',
    };
  });
}

// ---- get_sol_network ($0.005) — chain health: TPS + slot + epoch progress
async function getSolNetwork() {
  return cached('solnet', 15_000, async () => {
    const [perf, epoch] = await Promise.all([
      rpc('getRecentPerformanceSamples', [4]),
      rpc('getEpochInfo', []),
    ]);
    const tps = perf?.length
      ? perf.map((s) => s.numTransactions / s.samplePeriodSecs)
      : [];
    const avg = tps.length ? Math.round(tps.reduce((a, b) => a + b, 0) / tps.length) : null;
    return {
      tps_avg_recent: avg,
      slot: epoch?.absoluteSlot ?? null,
      epoch: epoch?.epoch ?? null,
      epoch_progress_pct: epoch?.slotsInEpoch ? Number(((epoch.slotIndex / epoch.slotsInEpoch) * 100).toFixed(1)) : null,
      source: 'helius rpc',
    };
  });
}

module.exports = { getTokenHolders, getWalletActivity, getPriorityFees, getJitoTips, getSolNetwork };
