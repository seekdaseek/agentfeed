// tools/funding.js — perp funding from Hyperliquid public info API.
// Swapped from Binance (their ToS prohibits charging for their market data).
// Hyperliquid: decentralized perp DEX, public API, no account/ToS gate.
const API = 'https://api.hyperliquid.xyz/info';
const SYMBOLS = ['SOL', 'BTC'];

let cached = null; // { at, byName }
const CACHE_MS = 60_000;

async function refresh() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.byName;
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`hyperliquid ${res.status}`);
  const [meta, ctxs] = await res.json();
  const byName = {};
  meta.universe.forEach((u, i) => {
    if (SYMBOLS.includes(u.name) && ctxs[i]) byName[u.name] = ctxs[i];
  });
  cached = { at: Date.now(), byName };
  return byName;
}

async function getFunding(symbol) {
  if (!SYMBOLS.includes(symbol)) throw new Error(`unsupported symbol: ${symbol}`);
  const byName = await refresh();
  const c = byName[symbol];
  if (!c) throw new Error(`hyperliquid: no ctx for ${symbol}`);
  const hourly = Number(c.funding);
  return {
    symbol,
    funding_rate_hourly: hourly,
    funding_rate_8h_equiv: Number((hourly * 8).toFixed(8)),
    funding_rate_pct_hourly: Number((hourly * 100).toFixed(6)),
    mark_price: Number(Number(c.markPx).toFixed(symbol === 'BTC' ? 2 : 4)),
    open_interest: Number(c.openInterest),
    source: 'hyperliquid',
  };
}

module.exports = { getFunding };
