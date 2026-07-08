// tools/prices.js — Pyth Hermes latest price. Same feeds as skrly-alerts backend.
const FEEDS = {
  SOL: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  BTC: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
};

const HERMES = 'https://hermes.pyth.network/v2/updates/price/latest';

// 5s micro-cache: agents in loops shouldn't hammer Hermes for identical data
const cache = new Map(); // symbol -> { at, data }
const CACHE_MS = 5000;

async function getPrice(symbol) {
  const feed = FEEDS[symbol];
  if (!feed) throw new Error(`unsupported symbol: ${symbol}`);

  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const url = `${HERMES}?ids[]=${feed}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`hermes ${res.status}`);
  const json = await res.json();

  const p = json?.parsed?.[0]?.price;
  if (!p) throw new Error('hermes: no parsed price');

  const price = Number(p.price) * Math.pow(10, p.expo);
  const conf = Number(p.conf) * Math.pow(10, p.expo);

  const data = {
    symbol,
    price: Number(price.toFixed(symbol === 'BTC' ? 2 : 4)),
    confidence: Number(conf.toFixed(4)),
    publish_time: p.publish_time,
    source: 'pyth-hermes',
  };
  cache.set(symbol, { at: Date.now(), data });
  return data;
}

module.exports = { getPrice };
