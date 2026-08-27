// Trade context: full market state in one call (composite of existing tools).
//
// v2 — HONOURS ?symbol=. The registered YAML advertises this route as full
// market state, and the Telegraph router passes the caller's symbol straight
// through. The previous signature was getTradeContext() with NO parameters and
// an unconditional SOL+BTC body, so a request for ETH was answered with facts
// about SOL — a wrong answer served with a 200, which is the worst failure mode
// a miner has.
//
// WHY ONLY SOL AND BTC. This is not a policy choice, it is what the upstreams
// actually carry, verified in the sources:
//   tools/prices.js     FEEDS  = { SOL, BTC }        Pyth feed ids, throws otherwise
//   tools/funding.js    SYMBOLS = ['SOL','BTC']      throws otherwise
//   tools/positioning.js SYMBOLS = { SOL, BTC }      pinned, takes no argument
// getLiquidationStats() covers five symbols, but a "full market state" missing
// both price and funding is not the product this route advertises. So the
// supported set is the INTERSECTION, and anything outside it is refused
// explicitly rather than silently answered with the wrong asset.
//
// AN UNSUPPORTED SYMBOL IS A 400, NOT A 502. Telegraph's validator fails an
// endpoint on 5xx and passes a 4xx, and it is the caller who named a symbol we
// do not carry. The badRequest tag is read by telegraph.js statusFor().
const { getPrice } = require('./prices');
const { getFunding } = require('./funding');
const { getFearGreed } = require('./feargreed');
const { getPositioning } = require('./positioning');
const { getLiquidationStats } = require('./liquidations');

const SUPPORTED = ['SOL', 'BTC'];

// 'SOLUSDT', 'sol', 'SOL-USDT', 'SOL/USDT' -> 'SOL'. The route is documented in
// perp symbols and asked for in bare tickers, so both have to land in one place.
function normalise(raw) {
  const u = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return u.replace(/USDT$/, '').replace(/PERP$/, '') || u;
}

function unsupported(raw) {
  const e = new Error(
    `unsupported symbol: ${raw}. /api/trade-context carries ${SUPPORTED.join(' and ')} ` +
    `only, because its price and funding upstreams list no other asset. ` +
    `Use /api/liquidation-stats or /api/squeeze-score for the wider universe.`
  );
  e.badRequest = true;
  return e;
}

async function getTradeContext(req) {
  const raw = req && req.query ? req.query.symbol : undefined;

  // No symbol: the original two-asset payload, byte-for-byte. The paid /api
  // route, the MCP tool and the validator's no-argument probe all land here,
  // so this path stays exactly as it was.
  if (raw === undefined || raw === null || raw === '') {
    const [sol, btc, fundingSol, fundingBtc, fearGreed, positioning, liquidations] =
      await Promise.all([
        getPrice('SOL'), getPrice('BTC'),
        getFunding('SOL'), getFunding('BTC'),
        getFearGreed(), getPositioning(), getLiquidationStats(),
      ]);
    return {
      ts: Date.now(),
      prices: { sol, btc },
      funding: { sol: fundingSol, btc: fundingBtc },
      fear_greed: fearGreed,
      positioning,
      liquidations,
    };
  }

  const symbol = normalise(raw);
  if (!SUPPORTED.includes(symbol)) throw unsupported(raw);
  const key = symbol.toLowerCase();

  const [price, funding, fearGreed, positioning, liqStats] = await Promise.all([
    getPrice(symbol), getFunding(symbol), getFearGreed(),
    getPositioning(), getLiquidationStats(),
  ]);

  return {
    ts: Date.now(),
    symbol,
    price,
    funding,
    fear_greed: fearGreed,
    // Both upstreams return every symbol they track in one object; the caller
    // asked about one asset, so the others are dropped rather than shipped as
    // noise the scorer has to read past. The venue metadata is kept.
    positioning: {
      source: positioning.source,
      period: positioning.period,
      ...(positioning[key] || {}),
    },
    liquidations: {
      source: liqStats.source,
      exchanges: liqStats.exchanges,
      collecting_since: liqStats.collecting_since,
      ...(liqStats[key] || {}),
    },
  };
}

module.exports = { getTradeContext, SUPPORTED, normalise };
