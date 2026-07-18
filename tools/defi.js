// tools/defi.js — expansion: DeFi/macro suite (3 tools). DefiLlama + Jupiter, free public APIs.
'use strict';
const { cached, fetchJson } = require('../lib/cache');

const LLAMA = () => process.env.LLAMA_API || 'https://api.llama.fi';
const STABLES = () => process.env.STABLES_API || 'https://stablecoins.llama.fi';
const JUP = () => process.env.JUP_API || 'https://quote-api.jup.ag';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---- get_tvl ($0.005) — chain or protocol TVL
async function getTvl(p = {}) {
  const target = String(p.target || '').trim().toLowerCase();
  if (!target || target === 'chains') {
    return cached('tvl:chains', 300_000, async () => {
      const chains = await fetchJson(`${LLAMA()}/v2/chains`);
      const top = chains.sort((a, b) => b.tvl - a.tvl).slice(0, 15)
        .map((c) => ({ chain: c.name, tvl_usd: Math.round(c.tvl) }));
      return { scope: 'top_chains', total_tvl_usd: Math.round(chains.reduce((s, c) => s + (c.tvl || 0), 0)), chains: top };
    });
  }
  const protos = await cached('tvl:protocols', 300_000, () => fetchJson(`${LLAMA()}/protocols`));
  const hit = protos.find((x) => x.slug === target) ||
    protos.find((x) => (x.name || '').toLowerCase() === target) ||
    protos.find((x) => (x.symbol || '').toLowerCase() === target);
  if (!hit) throw new Error(`protocol not found on defillama: ${target} (use the defillama slug)`);
  return {
    protocol: hit.name, slug: hit.slug, category: hit.category, chains: hit.chains,
    tvl_usd: Math.round(hit.tvl || 0),
    change_1d_pct: hit.change_1d != null ? Number(hit.change_1d.toFixed(2)) : null,
    change_7d_pct: hit.change_7d != null ? Number(hit.change_7d.toFixed(2)) : null,
    source: 'defillama',
  };
}

// ---- get_stablecoin_flows ($0.01) — the risk-on/risk-off macro dial
async function getStablecoinFlows() {
  return cached('stables', 600_000, async () => {
    const [list, chart] = await Promise.all([
      fetchJson(`${STABLES()}/stablecoins?includePrices=false`),
      fetchJson(`${STABLES()}/stablecoincharts/all`),
    ]);
    const cur = (x) => Object.values(x?.totalCirculatingUSD || {}).reduce((s, v) => s + v, 0);
    const nowPt = chart[chart.length - 1], wkPt = chart[chart.length - 8], moPt = chart[chart.length - 31];
    const total = cur(nowPt);
    const d = (thenPt) => (thenPt ? Math.round(total - cur(thenPt)) : null);
    const top = (list?.peggedAssets || [])
      .map((a) => ({ symbol: a.symbol, circulating_usd: Math.round(Object.values(a.circulating || {}).reduce((s, v) => s + v, 0)) }))
      .sort((a, b) => b.circulating_usd - a.circulating_usd).slice(0, 8);
    return {
      total_stablecoin_usd: Math.round(total),
      delta_7d_usd: d(wkPt), delta_30d_usd: d(moPt),
      read: d(wkPt) > 0 ? 'supply expanding — dry powder entering' : 'supply flat/contracting — risk appetite cooling',
      top_stables: top,
      source: 'defillama-stablecoins',
    };
  });
}

// ---- get_dex_quote ($0.005) — live Jupiter route for any SPL pair
async function getDexQuote(p = {}) {
  const { input_mint, output_mint } = p;
  if (!BASE58_RE.test(input_mint || '') || !BASE58_RE.test(output_mint || '')) throw new Error('invalid input_mint or output_mint');
  const amount = String(p.amount || '').replace(/[^0-9]/g, '');
  if (!amount || amount === '0') throw new Error('amount required (raw base units of input mint)');
  const key = `jup:${input_mint}:${output_mint}:${amount}`;
  return cached(key, 5_000, async () => {
    const q = await fetchJson(
      `${JUP()}/v6/quote?inputMint=${input_mint}&outputMint=${output_mint}&amount=${amount}&slippageBps=50`);
    if (q.error) throw new Error(`jupiter: ${q.error}`);
    return {
      input_mint, output_mint, in_amount: q.inAmount, out_amount: q.outAmount,
      other_amount_threshold: q.otherAmountThreshold,
      price_impact_pct: q.priceImpactPct != null ? Number(Number(q.priceImpactPct).toFixed(4)) : null,
      route: (q.routePlan || []).map((r) => r.swapInfo?.label).filter(Boolean),
      slippage_bps: 50,
      source: 'jupiter-v6',
    };
  });
}

module.exports = { getTvl, getStablecoinFlows, getDexQuote };
