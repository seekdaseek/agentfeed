// answer.js — answer shaping for the Telegraph mirror ONLY.
//
// WHY THIS EXISTS
// The canonical scorer receives exactly three strings: question, ground_truth,
// miner_answer. It is numeric-first and near-binary: reg 219 scores with
// score_stddev 0.458, so anything not close to exact lands at zero.
//
// AgentFeed's route wrapper in server.js returns
//     { tool: name, data: {...}, paid: true }
// so the scorer sees an envelope, a tool name, a boolean, and then a nested
// object carrying up to a dozen numbers. Ground truth for FINANCIAL_DATA is a
// short value. CoinGecko, the busiest crypto miner on the board, returns
// {"ethereum":{"usd":2390.3}} — one number, essentially the whole document.
//
// This module maps a payload to ONE short sentence carrying exactly ONE number.
// It does not touch the paid /api routes. Mirror only.
//
// RULES THE SENTENCES FOLLOW, each for a reason:
//   - exactly one number, so a numeric-first parser cannot pick the wrong one
//   - plain digits, no thousands separators, no currency symbol glued on
//   - the unit as a WORD (USD, percent), which also feeds token overlap
//   - the subject repeated from the question's vocabulary (symbol, protocol)
//   - no envelope keys, no tool names, no booleans

'use strict';

const round = (n, dp) => {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
};

// Plain decimal, never exponential, no separators. 1.24e9 -> "1240000000".
function plain(n, dp) {
  if (n === null || n === undefined || !isFinite(n)) return null;
  const v = dp === undefined ? n : round(n, dp);
  if (Math.abs(v) >= 1e21) return v.toFixed(0);
  let s = String(v);
  if (s.includes('e') || s.includes('E')) s = v.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : (v !== null && v !== undefined && v !== '' && isFinite(Number(v)) ? Number(v) : null));

// pick the first present key from a payload
function pick(d, keys) {
  for (const k of keys) {
    if (d && d[k] !== undefined && d[k] !== null) return d[k];
  }
  return null;
}

// pick the first present DOTTED path, e.g. 'bybit.oi_usd'. The real payloads
// nest per venue, which is why the first version of this file - written against
// guessed field names - returned null for open-interest and funding-cross.
function deep(d, paths) {
  for (const p of paths) {
    let cur = d;
    for (const seg of p.split('.')) {
      if (cur === null || cur === undefined) { cur = null; break; }
      cur = cur[seg];
    }
    if (cur !== undefined && cur !== null) return cur;
  }
  return null;
}

// The venue a dotted path names, for the sentence. Real key, not decoration.
const VENUE = { bybit: 'Bybit', okx: 'OKX', hyperliquid: 'Hyperliquid' };
function venueOf(d, paths) {
  for (const p of paths) {
    let cur = d;
    for (const seg of p.split('.')) {
      if (cur === null || cur === undefined) { cur = null; break; }
      cur = cur[seg];
    }
    if (cur !== undefined && cur !== null) {
      const seg = p.split('.').find((x) => VENUE[x]);
      return seg ? VENUE[seg] : null;
    }
  }
  return null;
}

const SHAPERS = {
  price(d) {
    const p = num(pick(d, ['price', 'usd', 'value']));
    if (p === null) return null;
    const sym = d.symbol || d.ticker || 'the asset';
    return `The current price of ${sym} is ${plain(p, 4)} USD.`;
  },

  funding(d) {
    const pct = num(pick(d, ['funding_rate_pct_hourly']));
    if (pct !== null) {
      return `The hourly funding rate for ${d.symbol || 'the perp'} is ${plain(pct, 6)} percent.`;
    }
    const r = num(pick(d, ['funding_rate_hourly', 'funding_rate', 'rate']));
    if (r === null) return null;
    return `The hourly funding rate for ${d.symbol || 'the perp'} is ${plain(r, 8)}.`;
  },

  // VERIFIED against tools/derivs.js getFundingCross: the rate lives under
  // venues.<venue>, and which venues are present depends on which listed the
  // symbol. Bybit's 8h rate is the standard cross-venue quote; Hyperliquid
  // publishes hourly, so its 8h EQUIVALENT is the comparable field.
  //
  // REPORTED AS PERCENT, like funding() above. The venue serves a decimal
  // (0.0001) and the hourly shaper serves percent (0.00125 percent) — the same
  // quantity in two conventions inside one file, which is a trap for anyone
  // comparing the two answers. One convention wins, and it is the one that
  // names its unit. plain() rounds the float noise from x100 away:
  // 0.0001 -> 0.01 exactly, never an exponent. The venue's own decimal is
  // still one ?verbose=1 away for anyone who needs it.
  fundingCross(d) {
    const paths = ['venues.bybit.funding_rate_8h', 'venues.okx.funding_rate_8h',
      'venues.hyperliquid.funding_rate_8h_equiv'];
    const r = num(deep(d, paths));
    if (r === null) return null;
    const venue = venueOf(d, paths);
    return `The eight hour funding rate for ${d.symbol || 'the perp'}${venue ? ' on ' + venue : ''} is ${plain(r * 100, 6)} percent.`;
  },

  // VERIFIED against tools/derivs.js getOpenInterest: bybit is always present
  // (the call throws if Bybit fails), okx may be null. oi_usd is the dollar
  // figure; oi_base is the same position in coins and would answer a different
  // question, so it is deliberately not a fallback.
  openInterest(d) {
    const paths = ['bybit.oi_usd', 'okx.oi_usd'];
    let oi = num(deep(d, paths));
    let venue = venueOf(d, paths);
    if (oi === null) {
      oi = num(pick(d, ['open_interest_usd', 'openInterestUsd']));
      venue = null;
    }
    if (oi === null) return null;
    return `Open interest for ${d.symbol || 'the perp'}${venue ? ' on ' + venue : ''} is ${plain(oi, 2)} USD.`;
  },

  fearGreed(d) {
    const v = num(pick(d, ['value', 'index', 'score']));
    if (v === null) return null;
    const cls = d.classification ? ` (${d.classification})` : '';
    return `The crypto Fear and Greed Index is ${plain(v, 0)}${cls}.`;
  },

  // VERIFIED against tools/defi.js getTvl, which returns TWO shapes:
  //   target given -> { scope:'protocol'|'protocol_family', protocol, tvl_usd }
  //   no target    -> { scope:'top_chains', total_tvl_usd, chains:[15] }
  // total_tvl_usd is summed over ALL chains, not over the fifteen listed, so
  // the sentence says "all chains". The validator probes with no arguments and
  // therefore always lands on the second shape.
  tvl(d) {
    const t = num(pick(d, ['tvl_usd', 'tvl', 'tvlUsd']));
    if (t !== null) {
      const who = d.protocol || d.name || d.slug || d.chain || 'the protocol';
      return `The total value locked in ${who} is ${plain(t, 2)} USD.`;
    }
    const all = num(pick(d, ['total_tvl_usd']));
    if (all === null) return null;
    return `The combined total value locked across all chains is ${plain(all, 2)} USD.`;
  },

  volatility(d) {
    // VERIFIED against tools/derivs.js getVolatility: realized_vol_7d_ann_pct,
    // annualized, already in percent. The 30d field answers a different
    // question and is never substituted for it.
    const v = num(pick(d, ['realized_vol_7d_ann_pct', 'realized_vol_7d', 'vol_7d', 'volatility_7d']));
    if (v === null) return null;
    return `The seven day annualized realized volatility for ${d.symbol || 'the perp'} is ${plain(v, 4)} percent.`;
  },

  basis(d) {
    const b = num(pick(d, ['basis_pct', 'basis_percent', 'basis_bps', 'basis']));
    if (b === null) return null;
    const isBps = d.basis_bps !== undefined && d.basis_bps !== null;
    return `The perp versus spot basis for ${d.symbol || 'the pair'} is ${plain(b, 4)} ${isBps ? 'basis points' : 'percent'}.`;
  },

  // VERIFIED against tools/liqdb.js getSqueezeScore, which returns BOTH
  // short_squeeze_score and long_flush_score. The endpoint and the tool are
  // named for the short squeeze, so that is the one reported, and the sentence
  // says which of the two it is rather than calling it "the score".
  squeeze(d) {
    const s = num(pick(d, ['short_squeeze_score', 'squeeze_score', 'score']));
    if (s === null) return null;
    return `The short squeeze score for ${d.symbol || 'the perp'} is ${plain(s, 2)} on a zero to one hundred scale.`;
  },

  // VERIFIED against tools/tokenrisk.js: there is NO risk score in the payload.
  // What exists is risk_flags (a string array) and risk_flag_count, set
  // unconditionally to flags.length. The count is the tool's own summary of how
  // many things are wrong with the mint, so it is reported as a count and NOT
  // dressed up as a score out of one hundred, which would be a number the tool
  // never computed.
  tokenRisk(d) {
    const s = num(pick(d, ['risk_score', 'score', 'rug_score']));
    if (s !== null) {
      return `The rug risk score for this token is ${plain(s, 2)} on a zero to one hundred scale.`;
    }
    const c = num(pick(d, ['risk_flag_count']));
    if (c === null) return null;
    const who = d.symbol || d.name || 'this token';
    return `The number of rug risk flags raised for ${who} is ${plain(c, 0)}.`;
  },

  // list payloads: name the leader, carry its one number
  leader(d, opts) {
    const arr = Array.isArray(d) ? d : (Array.isArray(d && d.leaders) ? d.leaders
      : Array.isArray(d && d.symbols) ? d.symbols
      : Array.isArray(d && d.items) ? d.items
      : Array.isArray(d && d.gainers) ? d.gainers : null);
    if (!arr || !arr.length) return null;
    const top = arr[0];
    const v = num(pick(top, opts.valueKeys));
    if (v === null) return null;
    const name = top.symbol || top.name || top.ticker || 'the top symbol';
    return `${opts.lead} ${name} at ${plain(v, 2)}${opts.unit ? ' ' + opts.unit : ''}.`;
  },
};

// endpoint path -> shaper
const ROUTES = {
  '/price': SHAPERS.price,
  '/sol-price': SHAPERS.price,
  '/btc-price': SHAPERS.price,
  '/funding-rate': SHAPERS.funding,
  '/funding-cross': SHAPERS.fundingCross,
  '/fear-greed': SHAPERS.fearGreed,
  '/open-interest': SHAPERS.openInterest,
  '/tvl': SHAPERS.tvl,
  '/volatility': SHAPERS.volatility,
  '/basis': SHAPERS.basis,
  '/squeeze-score': SHAPERS.squeeze,
  '/token-risk': SHAPERS.tokenRisk,
  '/liquidation-leaders': (d) => SHAPERS.leader(d, {
    valueKeys: ['liquidations_usd', 'liq_usd', 'total_usd', 'usd', 'value'],
    lead: 'The top symbol by liquidations is',
    unit: 'USD',
  }),
  '/top-movers': (d) => SHAPERS.leader(d, {
    valueKeys: ['change_24h_pct', 'change_pct', 'pct', 'change'],
    lead: 'The biggest gainer over the past day is',
    unit: 'percent',
  }),
};

// DELIBERATELY ABSENT: '/trade-context'.
//
// The route is a composite - price, funding, fear and greed, long/short ratio,
// open interest, and 1h/24h liquidation totals - and that is what it is sold
// as. No single one of those numbers is THE answer to "what is the trade
// context for SOL": picking the price would make this route a duplicate of
// /sol-price and would answer a question the caller did not ask, and picking
// any of the others is a coin toss dressed up as a decision.
//
// shape() returning null here is the correct answer, not a gap. Null means the
// structured payload is sent unchanged, which is the honest response for a
// question whose ground truth is not one number. Re-read the module header
// before adding an entry: a wrong number scores worse than a shapeless one.

/**
 * How many VALUES a sentence carries. A value is a number standing on its own;
 * digits inside a subject are part of its name, not a quantity.
 *
 * Measured: 1000PEPEUSDT and 1000BONKUSDT are real Bybit perps, and counting
 * their leading 1000 as a second number made the guard reject
 *   "The perp versus spot basis for 1000PEPEUSDT is -0.0215 percent."
 * and revert that route to raw JSON — on basis, volatility, open-interest,
 * funding-cross, squeeze-score, liquidation-leaders and top-movers, every
 * shaper that names its subject.
 *
 * The subject is REMOVED before counting rather than the guard being loosened
 * to "at least one". The reason the guard exists has not changed: a
 * numeric-first scorer must not be handed two numbers and left to choose. A
 * sentence carrying two genuine values still returns null.
 *
 * The rule that makes this safe: every value in these sentences comes from
 * plain(), which emits digits, an optional leading minus and an optional
 * decimal point and NOTHING else — no exponent, no separator, no unit glued
 * on. So a run of characters containing a letter can never be a value, and
 * dropping every such run cannot drop a quantity.
 */
const SUBJECT_TOKEN = /[\w.]*[A-Za-z][\w.]*/g;

function countValues(sentence) {
  const withoutSubjects = String(sentence).replace(SUBJECT_TOKEN, ' ');
  return (withoutSubjects.match(/-?\d+(?:\.\d+)?/g) || []).length;
}


/**
 * shape(endpoint, payload) -> string | null
 * Returns one scorable sentence, or null when no single number is defensible.
 * NULL IS A REAL ANSWER: it means fall back to the structured payload rather
 * than invent a number. A wrong number scores worse than a shapeless one.
 */
function shape(endpoint, payload) {
  if (!endpoint) return null;
  const path = String(endpoint).split('?')[0].replace(/\/+$/, '');
  // Match a route key as a whole path SEGMENT, so '/api/token-risk/So111...'
  // (a :mint style trailing param) still resolves to '/token-risk'. A plain
  // endsWith() silently misses every parameterised route.
  const key = Object.keys(ROUTES)
    .sort((a, b) => b.length - a.length)
    .find((r) => path === r || path.endsWith(r) || path.includes(r + '/'));
  if (!key) return null;
  // unwrap the server.js envelope { tool, data, paid } if it is present
  const d = payload && payload.data !== undefined && payload.tool !== undefined ? payload.data : payload;
  if (d === null || d === undefined) return null;
  try {
    const s = ROUTES[key](d);
    if (typeof s !== 'string' || !s.trim()) return null;
    const out = s.trim();
    // HARD GUARD: exactly one VALUE, or the sentence is not scorable and we
    // return null rather than hand the scorer two numbers to choose between.
    if (countValues(out) !== 1) return null;
    return out;
  } catch (_) {
    return null;
  }
}

module.exports = { shape, SHAPERS, plain, countValues };
