// tools/funding.js — perp funding from Hyperliquid public info API.
// Swapped from Binance (their ToS prohibits charging for their market data).
// Hyperliquid: decentralized perp DEX, public API, no account/ToS gate.
const { getFundingCross, _normSym: normSym, _to8h: to8h, _annualizedPct: annualizedPct } = require('./derivs');
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

// ---- GET /api/funding-rate[?symbol=] -----------------------------------------
// Without a symbol: the SOL and BTC Hyperliquid answer this route has always
// given, byte for byte. With one: that USDT perp's funding on each venue that
// lists it, read through the cross-venue function /api/funding-cross uses (and
// its 30 s cache), so every rate is at its own interval. The cross-venue spread
// and the crowding read are what /api/funding-cross adds; they stay there.
async function getFundingRate(p = {}) {
  if (p.symbol == null || p.symbol === '') return { sol: await getFunding('SOL'), btc: await getFunding('BTC') };
  let sym;
  try { sym = normSym(p.symbol); } catch (e) { e.kind = 'bad_request'; throw e; }
  const x = await getFundingCross({ symbol: sym }); // throws a named 400 when no venue lists it
  // Hyperliquid settles every hour on the hour (measured 2026-09-28: six
  // consecutive settlements at :00 on SOL and ONDO), so its next one is the next
  // top of the hour, taken when answering rather than out of the 30 s cache.
  const nextHour = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 3_600_000;
  const venues = {};
  for (const [name, v] of Object.entries(x.venues)) {
    const raw = v.funding_rate_raw, ih = v.funding_interval_hours;
    venues[name] = {
      funding_rate_raw: raw,
      funding_interval_hours: ih,
      funding_rate_8h: to8h(raw, ih),
      annualized_pct: annualizedPct(raw, ih),
      next_funding_time: name === 'hyperliquid' ? nextHour : v.next_funding_time,
      mark_price: v.mark_price,
      ...(v.funding_interval_note ? { funding_interval_note: v.funding_interval_note } : {}),
    };
  }
  return {
    symbol: x.symbol,
    venues,
    note: 'Each rate is quoted for its own interval: funding_rate_8h = raw x 8 / funding_interval_hours, annualized_pct = raw x 24 / funding_interval_hours x 365 x 100. /api/funding-cross adds the cross-venue spread and a crowding read.',
    source: 'bybit+okx+hyperliquid public funding',
  };
}

module.exports = { getFunding, getFundingRate };
