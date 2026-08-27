// tools/defi.js — expansion: DeFi/macro suite (3 tools). DefiLlama + Jupiter, free public APIs.
'use strict';
const { cached, fetchJson } = require('../lib/cache');

const LLAMA = () => process.env.LLAMA_API || 'https://api.llama.fi';
const STABLES = () => process.env.STABLES_API || 'https://stablecoins.llama.fi';
const JUP = () => process.env.JUP_API || 'https://lite-api.jup.ag';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---- get_tvl ($0.005) — chain or protocol TVL
function normSlug(s) { return String(s || '').trim().toLowerCase().replace(/^parent#/, ''); }
function best(list) { return list.slice().sort((a, b) => (b.tvl || 0) - (a.tvl || 0))[0]; }

// Deterministic single-protocol match. Every arm picks the HIGHEST-TVL candidate
// rather than whatever DefiLlama happens to list first.
function resolveSingle(protos, target) {
  const bySlug = protos.filter((x) => (x.slug || '').toLowerCase() === target);
  if (bySlug.length) return best(bySlug);
  const byName = protos.filter((x) => (x.name || '').toLowerCase() === target);
  if (byName.length) return best(byName);
  const bySym = protos.filter((x) => (x.symbol || '').toLowerCase() === target && x.symbol !== '-');
  if (bySym.length) return best(bySym);
  return null;
}

// Brand -> every deployment under one parentProtocol, summed.
function resolveFamily(protos, target) {
  const parents = new Map();
  for (const p of protos) {
    if (!p.parentProtocol) continue;
    const key = normSlug(p.parentProtocol);
    if (!parents.has(key)) parents.set(key, []);
    parents.get(key).push(p);
  }
  const flat = (s) => s.replace(/-/g, '');
  let keys = [...parents.keys()].filter((k) => k === target);
  if (!keys.length) {
    keys = [...parents.keys()].filter((k) => k.startsWith(target + '-') || flat(k) === flat(target));
  }
  if (keys.length !== 1) return null;
  const key = keys[0];
  const kids = parents.get(key).filter((p) => (p.tvl || 0) > 0).sort((a, b) => (b.tvl || 0) - (a.tvl || 0));
  if (!kids.length) return null;
  // A family of one is just that protocol — do not dress it up as an aggregate.
  if (kids.length === 1) return { __single: kids[0] };
  const total = kids.reduce((s, p) => s + (p.tvl || 0), 0);
  // TVL-weighted change, computed only from components that report one.
  const wchg = (field) => {
    let num = 0, den = 0;
    for (const p of kids) if (p[field] != null) { num += p[field] * (p.tvl || 0); den += (p.tvl || 0); }
    return den ? Number((num / den).toFixed(2)) : null;
  };
  // Display name: longest common word-prefix of the children, else the parent slug.
  const words = kids.map((p) => String(p.name || '').split(' '));
  let common = [];
  for (let i = 0; i < words[0].length; i++) {
    const w = words[0][i];
    if (words.every((ws) => ws[i] === w)) common.push(w); else break;
  }
  const display = common.length ? common.join(' ') : key;
  return {
    scope: 'protocol_family',
    protocol: display,
    slug: key,
    category: kids[0].category,
    chains: [...new Set(kids.flatMap((p) => p.chains || []))],
    tvl_usd: Math.round(total),
    change_1d_pct: wchg('change_1d'),
    change_7d_pct: wchg('change_7d'),
    deployments: kids.length,
    components: kids.map((p) => ({
      name: p.name, slug: p.slug, tvl_usd: Math.round(p.tvl || 0),
      change_1d_pct: p.change_1d != null ? Number(p.change_1d.toFixed(2)) : null,
    })),
    note: `aggregate of ${kids.length} deployment(s); change is TVL-weighted. Query a component slug for one deployment.`,
    source: 'defillama',
  };
}

// Near-miss suggestions so a failed call teaches the caller the right name.
function suggestProtocols(protos, target) {
  const seen = new Set(), out = [];
  for (const p of protos.slice().sort((a, b) => (b.tvl || 0) - (a.tvl || 0))) {
    const n = String(p.name || '').toLowerCase();
    if (!n.includes(target) || (p.tvl || 0) <= 0) continue;
    const k = normSlug(p.parentProtocol) || p.slug;
    if (seen.has(k)) continue;
    seen.add(k); out.push(normSlug(p.parentProtocol) || p.slug);
    if (out.length === 5) break;
  }
  return out;
}


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
  const fam = resolveFamily(protos, target);
  if (fam && !fam.__single) return fam;
  const hit = (fam && fam.__single) || resolveSingle(protos, target);
  if (!hit) {
    const s = suggestProtocols(protos, target);
    throw new Error(`protocol not found on defillama: ${target}` + (s.length ? ` — did you mean: ${s.join(', ')}` : ' (use the defillama slug)'));
  }
  return {
    scope: 'protocol',
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
      `${JUP()}/swap/v1/quote?inputMint=${input_mint}&outputMint=${output_mint}&amount=${amount}&slippageBps=50`);
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
