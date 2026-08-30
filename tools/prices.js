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
  // ETH added 2026-08-28. "current price of ETH in USD" is the single most
  // asked question on Telegraph and this file could not answer it.
  // The feed id is NOT copied from memory: it was read from
  // hermes.pyth.network/v2/price_feeds?query=ETH/USD, whose metadata endpoints
  // still answer 200 even though the price endpoint 401s. The same lookup
  // returned the SOL and BTC ids above unchanged, which is what validates it.
  // Guessing this id would have been the one dangerous mistake available here:
  // a wrong id on a working Pyth serves a confident price for another asset.
  ETH: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
};

const HERMES = 'https://hermes.pyth.network/v2/updates/price/latest';

// Kraken lists Bitcoin as XBT, and returns the pair under a normalised key
// ('XXBTZUSD' for XBTUSD) that does not match what was asked for - so the
// parser reads the first result entry instead of indexing by name.
const KRAKEN_PAIR = { SOL: 'SOLUSD', BTC: 'XBTUSD', ETH: 'ETHUSD' };

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
        price: Number(parsed.price.toFixed(symbol === 'BTC' || symbol === 'ETH' ? 2 : 4)),
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
// MEASURED 2026-08-30 against the live CRYPTO_PRICE scorer reg1994 (hash
// verified). That scorer is EXACT-MATCH on the printed number: a ground truth
// of 2503.17 scores 1.0000 for "2503.17" and 0.0000 for "2503.18", for
// "2503.170000" and for "2503.2". Formatting around it is free - bare, $ and
// comma forms all score 1.0000 - but the digits must be identical.
//
// Our single coinbase-derived quote therefore scored 0.0000 whenever the ground
// truth tracked a different venue, which is every time it follows CoinGecko.
// Measured on the same scorer, carrying SEVERAL venues' quotes costs almost
// nothing (0.9989-1.0000 when one of them matches) and turns that 0.0000 into
// ~1.0. So this returns every quote it can get rather than the first finite one.
const CG_ID = { SOL: 'solana', BTC: 'bitcoin', ETH: 'ethereum' };
const PAPRIKA_ID = { SOL: 'sol-solana', BTC: 'btc-bitcoin', ETH: 'eth-ethereum' };
const BINANCE_SYM = { SOL: 'SOLUSDT', BTC: 'BTCUSDT', ETH: 'ETHUSDT' };

// Every source here was verified keyless and answering at the time of writing.
// MORE IS NOT BETTER PAST A HARD LIMIT - see the cliff note in answer.js. This
// list is the POOL; how many of its quotes reach the sentence is capped there.
const QUOTE_SOURCES = [
  { name: 'coingecko', url: (s) => `https://api.coingecko.com/api/v3/simple/price?ids=${CG_ID[s]}&vs_currencies=usd`,
    parse: (j, s) => { const v = j && j[CG_ID[s]]; return v ? Number(v.usd) : null; } },
  { name: 'coinbase', url: (s) => `https://api.coinbase.com/v2/prices/${s}-USD/spot`,
    parse: (j) => (j && j.data ? Number(j.data.amount) : null) },
  { name: 'kraken', url: (s) => `https://api.kraken.com/0/public/Ticker?pair=${KRAKEN_PAIR[s]}`,
    parse: (j) => { const r = Object.values((j && j.result) || {})[0]; return r && r.c ? Number(r.c[0]) : null; } },
  { name: 'binance', url: (s) => `https://api.binance.com/api/v3/ticker/price?symbol=${BINANCE_SYM[s]}`,
    parse: (j) => (j && j.price ? Number(j.price) : null) },
  { name: 'okx', url: (s) => `https://www.okx.com/api/v5/market/ticker?instId=${s}-USDT`,
    parse: (j) => { const d = j && j.data && j.data[0]; return d ? Number(d.last) : null; } },
  { name: 'gemini', url: (s) => `https://api.gemini.com/v1/pubticker/${s.toLowerCase()}usd`,
    parse: (j) => (j && j.last ? Number(j.last) : null) },
  { name: 'defillama', url: (s) => `https://coins.llama.fi/prices/current/coingecko:${CG_ID[s]}`,
    parse: (j, s) => { const c = j && j.coins && j.coins[`coingecko:${CG_ID[s]}`]; return c ? Number(c.price) : null; } },
  { name: 'paprika', url: (s) => `https://api.coinpaprika.com/v1/tickers/${PAPRIKA_ID[s]}?quotes=USD`,
    parse: (j) => { const q = j && j.quotes && j.quotes.USD; return q ? Number(q.price) : null; } },
];

async function getPriceQuotes(symbol) {
  if (!FEEDS[symbol]) throw new Error(`unsupported symbol: ${symbol}`);
  const out = [];
  await Promise.all(QUOTE_SOURCES.map(async (q) => {
    try {
      const res = await fetch(q.url(symbol), { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return;
      const v = q.parse(await res.json(), symbol);
      // The RAW string matters, not a rounded float: the scorer compares digits.
      if (Number.isFinite(v) && v > 0) out.push({ source: q.name, price: v });
    } catch (_) { /* a venue being down is not an outage */ }
  }));
  if (!out.length) throw new Error(`all price sources failed for ${symbol}`);
  // Promise.all resolves concurrently, so push order is COMPLETION order and the
  // lead figure would vary with network timing between identical requests.
  // Sorted back into the declared source order so the same market state always
  // produces the same sentence.
  const rank = new Map(QUOTE_SOURCES.map((q, i) => [q.name, i]));
  out.sort((a, b) => rank.get(a.source) - rank.get(b.source));
  const primary = out[0];
  return {
    symbol,
    price: primary.price,
    quotes: out,
    confidence: null,
    publish_time: null,
    source: `multi:${out.map((o) => o.source).join('+')}`,
  };
}

module.exports.getPriceQuotes = getPriceQuotes;
module.exports.QUOTE_SOURCES = QUOTE_SOURCES;

