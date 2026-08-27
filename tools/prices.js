// tools/prices.js — SOL/USD and BTC/USD spot, multi-source with ordered fallback.
//
// WHY THIS IS NO LONGER PYTH-ONLY. On 2026-08-27 hermes.pyth.network began
// answering 401 "unauthorized" to unauthenticated callers. It had been the
// single source here since July, so every route that touches getPrice went 502
// at once: the PAID /api/sol-price and /api/btc-price, market-snapshot,
// trade-context, the MCP price tools, and the telegraph mirror of all of them.
// A single free upstream with no fallback is a single point of failure for a
// paid product, and this file is the fix for that, not just for Pyth.
//
// THE ORDER IS DELIBERATE. Coinbase and Kraken are keyless, unmetered and were
// both verified answering 200 at the time of writing. Pyth stays LAST rather
// than being deleted, so that if public access is restored the oracle - which
// is the only one of the three that publishes a confidence interval - starts
// serving again on its own with no code change.
//
// FIRST FINITE NUMBER WINS. A source that answers non-200, throws, or parses to
// something that is not a finite number is skipped and the next is tried. If
// EVERY source fails, this throws and the caller returns 502. That is correct:
// it is a real outage. Nothing here invents a price, and nothing here serves a
// cached price past its TTL without the caller being told by the error.
//
// RETURN SHAPE IS FROZEN. Callers include the paid routes, market-snapshot,
// trade-context, mcp.js and the answer.js price shaper. The keys are exactly
//   { symbol, price, confidence, publish_time, source }
// and they do not change with the source. confidence and publish_time are
// NULL for venues that do not publish them - Coinbase and Kraken return a spot
// price and nothing else. Null is the honest value: fabricating a confidence
// interval would be inventing precision the venue never stated, and a made-up
// number is worse than an absent one. `source` names who actually served.

const FEEDS = {
  SOL: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  BTC: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
};

const HERMES = 'https://hermes.pyth.network/v2/updates/price/latest';

// Kraken lists Bitcoin as XBT, and returns the pair under a normalised key
// ('XXBTZUSD' for XBTUSD) that does not match what was asked for - so the
// parser reads the first result entry instead of indexing by name.
const KRAKEN_PAIR = { SOL: 'SOLUSD', BTC: 'XBTUSD' };

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Same {name, url, parse} contract as the SOURCES array in
// /opt/solwatch-trigger/watch.js. parse() returns the three price fields or
// null; anything falsy or non-finite moves on to the next source.
const SOURCES = [
  {
    name: 'coinbase',
    url: (sym) => `https://api.coinbase.com/v2/prices/${sym}-USD/spot`,
    parse: (j) => {
      const p = num(j && j.data && j.data.amount);
      return p === null ? null : { price: p, confidence: null, publish_time: null };
    },
  },
  {
    name: 'kraken',
    url: (sym) => `https://api.kraken.com/0/public/Ticker?pair=${KRAKEN_PAIR[sym]}`,
    parse: (j) => {
      if (j && Array.isArray(j.error) && j.error.length) return null;
      const row = Object.values((j && j.result) || {})[0];
      // c = [last trade price, lot volume]
      const p = num(row && row.c && row.c[0]);
      return p === null ? null : { price: p, confidence: null, publish_time: null };
    },
  },
  {
    name: 'pyth-hermes',
    url: (sym) => `${HERMES}?ids[]=${FEEDS[sym]}`,
    parse: (j) => {
      const p = j && j.parsed && j.parsed[0] && j.parsed[0].price;
      if (!p) return null;
      const scale = Math.pow(10, p.expo);
      const price = num(Number(p.price) * scale);
      if (price === null) return null;
      return {
        price,
        confidence: num(Number(p.conf) * scale),
        publish_time: num(p.publish_time),
      };
    },
  },
];

// 5s micro-cache: agents in loops shouldn't hammer the venues for identical data
const cache = new Map(); // symbol -> { at, data }
const CACHE_MS = 5000;

async function getPrice(symbol) {
  if (!FEEDS[symbol]) throw new Error(`unsupported symbol: ${symbol}`);

  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const tried = [];
  for (const src of SOURCES) {
    try {
      const res = await fetch(src.url(symbol), { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        tried.push(`${src.name} http ${res.status}`);
        console.log(`[prices] ${symbol}: ${src.name} http ${res.status}, trying next`);
        continue;
      }
      const parsed = src.parse(await res.json());
      if (!parsed || parsed.price === null) {
        tried.push(`${src.name} unparseable`);
        console.log(`[prices] ${symbol}: ${src.name} returned no usable price, trying next`);
        continue;
      }

      const data = {
        symbol,
        // BTC to 2dp, SOL to 4dp - unchanged from the Pyth-only version so the
        // numbers callers see keep the same precision they always had.
        price: Number(parsed.price.toFixed(symbol === 'BTC' ? 2 : 4)),
        confidence: parsed.confidence === null ? null : Number(parsed.confidence.toFixed(4)),
        publish_time: parsed.publish_time,
        source: src.name,
      };
      console.log(`[prices] ${symbol} served by ${src.name} at ${data.price}`);
      cache.set(symbol, { at: Date.now(), data });
      return data;
    } catch (e) {
      tried.push(`${src.name} ${e.message}`);
      console.log(`[prices] ${symbol}: ${src.name} failed (${e.message}), trying next`);
    }
  }

  // Every source is down. This is a genuine outage and the caller must 502.
  // No stale cache is served here: the entry, if any, is older than its TTL and
  // handing it back silently would be serving a stale price without saying so.
  throw new Error(`all price sources failed for ${symbol}: ${tried.join('; ')}`);
}

module.exports = { getPrice, SOURCES, KRAKEN_PAIR };
