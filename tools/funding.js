// tools/funding.js — perp funding rates from Binance public futures API.
// NOTE (spec §8): confirm redistribution terms before mainnet listing,
// or swap source. Module is isolated so a swap is one-file.
const SYMBOLS = { SOL: 'SOLUSDT', BTC: 'BTCUSDT' };
const API = 'https://fapi.binance.com/fapi/v1/premiumIndex';

const cache = new Map(); // symbol -> { at, data }
const CACHE_MS = 60_000;

async function getFunding(symbol) {
  const pair = SYMBOLS[symbol];
  if (!pair) throw new Error(`unsupported symbol: ${symbol}`);

  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const res = await fetch(`${API}?symbol=${pair}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`binance ${res.status}`);
  const j = await res.json();

  const data = {
    symbol,
    funding_rate: Number(j.lastFundingRate),
    funding_rate_pct: Number((Number(j.lastFundingRate) * 100).toFixed(4)),
    next_funding_time: Number(j.nextFundingTime),
    mark_price: Number(Number(j.markPrice).toFixed(symbol === 'BTC' ? 2 : 4)),
    source: 'binance-futures',
  };
  cache.set(symbol, { at: Date.now(), data });
  return data;
}

module.exports = { getFunding };
