// tools/entry.js — the $0.001 entry tier: four compact routes composed from
// functions this service already runs. Nothing here adds an upstream source.
//
// WHY THESE FOUR. Measured on the Bazaar 2026-09-25: the six best-selling
// routes in this niche are all $0.001, and the single most-bought route in the
// whole niche is a universal real-time primitive (hugen.tokyo's FX bid/ask,
// 169 distinct payers). AgentFeed had no cheap universal entry point at all --
// its floor was a $0.001 single-asset price and everything else was premium.
//
// Each answer is cached per symbol so a popular route cannot multiply upstream
// calls: one cache entry serves every concurrent caller (lib/cache.js collapses
// identical in-flight requests into one).
//
// DECLINES, NEVER FAKES. A route that cannot serve a request returns HTTP 200
// with a `decline` field naming the reason and what it can serve instead, the
// same shape get_squeeze_score uses. It never returns zeros dressed as data.
'use strict';
const Database = require('better-sqlite3');
const { cached } = require('../lib/cache');
const { _normSym: normSym, getFundingCross, getOpenInterest, getLongShort, getFundingExtremes } = require('./derivs');
const { getPrice, KRAKEN_PAIR } = require('./prices');

const DB_PATH = process.env.LIQ_DB || '/opt/agentfeed/liquidations.db';
let db = null;
function tape() {
  // READ-ONLY. liqcollector owns this file and writes it continuously.
  if (!db) db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return db;
}

const TTL = 45_000; // inside the 30-60s the brief asks for
const badRequest = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const n2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);

/** Newest row in the tape, and how old it is. The freshness gate for anything
 *  that reports "right now" from our own recording. */
function tapeAge() {
  const row = tape().prepare('SELECT MAX(ts) AS newest FROM liquidations').get();
  const newest = row && row.newest ? Number(row.newest) : null;
  return { newest, age_sec: newest ? Math.round((Date.now() - newest) / 1000) : null };
}
const STALE_SEC = 30 * 60; // the brief's bound: older than 30 minutes is stale

/** 24h liquidation slice for ONE symbol, straight from our tape. */
function liq24h(sym) {
  const since = Date.now() - 86_400_000;
  const r = tape().prepare(`
    SELECT COUNT(*) AS prints,
           COALESCE(SUM(usd),0) AS total_usd,
           COALESCE(SUM(CASE WHEN side='Buy'  THEN usd END),0) AS longs_usd,
           COALESCE(SUM(CASE WHEN side='Sell' THEN usd END),0) AS shorts_usd,
           COALESCE(MAX(usd),0) AS biggest_print_usd,
           COUNT(DISTINCT exchange) AS venues
    FROM liquidations WHERE symbol = ? AND ts >= ?`).get(sym, since);
  return {
    prints: r.prints,
    total_usd: n2(r.total_usd),
    longs_usd: n2(r.longs_usd),
    shorts_usd: n2(r.shorts_usd),
    biggest_print_usd: n2(r.biggest_print_usd),
    venues: r.venues,
    dominant_side: r.longs_usd >= r.shorts_usd ? 'longs' : 'shorts',
  };
}

// ---- a. GET /api/perp?symbol= -------------------------------------------
async function getPerp(p = {}) {
  const sym = normSym(p.symbol || 'SOLUSDT');
  return cached(`entry:perp:${sym}`, TTL, async () => {
    // Every part is optional except the tape: a venue that refuses is reported
    // as null with its reason, never silently dropped or zero-filled.
    const [funding, oi, ls] = await Promise.all([
      getFundingCross({ symbol: sym }).catch((e) => ({ _error: e.message })),
      getOpenInterest({ symbol: sym }).catch((e) => ({ _error: e.message })),
      getLongShort({ symbol: sym }).catch((e) => ({ _error: e.message })),
    ]);
    const age = tapeAge();
    const liq = liq24h(sym);
    const missing = [];
    if (funding._error) missing.push(`funding (${funding._error})`);
    if (oi._error) missing.push(`open_interest (${oi._error})`);
    if (ls._error) missing.push(`long_short (${ls._error})`);
    if (funding._error && oi._error && ls._error && liq.prints === 0) {
      return { symbol: sym, decline: `no venue served ${sym} and our tape has no liquidation for it in 24h`, tried: ['bybit', 'okx', 'hyperliquid'], tape_age_sec: age.age_sec };
    }
    return {
      symbol: sym,
      funding: funding._error ? null : { venues: funding.venues, spread_8h: funding.spread_8h, crowding: funding.crowding },
      open_interest: oi._error ? null : { bybit: oi.bybit, okx: oi.okx, mark_price: oi.mark_price },
      long_short: ls._error ? null : { long_pct: ls.long_pct, short_pct: ls.short_pct, long_pct_1h_ago: ls.long_pct_1h_ago, long_pct_24h_ago: ls.long_pct_24h_ago, source: ls.source },
      liquidations_24h: liq,
      tape_age_sec: age.age_sec,
      partial: missing.length ? missing : null,
      source: 'bybit+okx+hyperliquid venues, liquidations from our own tape',
    };
  });
}

// ---- b. GET /api/liq-pulse ----------------------------------------------
async function getLiqPulse() {
  return cached('entry:liqpulse', TTL, async () => {
    const age = tapeAge();
    // Prove the tape is live BEFORE answering. A collector that died would
    // otherwise make a quiet hour and a dead feed look identical.
    if (age.newest == null || age.age_sec > STALE_SEC) {
      return { stale: true, tape_age_sec: age.age_sec, newest_row_ts: age.newest,
        decline: age.newest == null
          ? 'the liquidation tape is empty; totals withheld rather than reported as zero'
          : `the liquidation tape is ${age.age_sec}s old, past the ${STALE_SEC}s freshness bound; totals withheld rather than reported as zero` };
    }
    const since = Date.now() - 3_600_000;
    const t = tape().prepare(`
      SELECT COUNT(*) AS prints, COALESCE(SUM(usd),0) AS total_usd,
             COALESCE(SUM(CASE WHEN side='Buy'  THEN usd END),0) AS longs_usd,
             COALESCE(SUM(CASE WHEN side='Sell' THEN usd END),0) AS shorts_usd,
             COUNT(DISTINCT symbol) AS symbols, COUNT(DISTINCT exchange) AS venues
      FROM liquidations WHERE ts >= ?`).get(since);
    const top = tape().prepare(`
      SELECT symbol, COUNT(*) AS prints, ROUND(SUM(usd),2) AS usd,
             ROUND(COALESCE(SUM(CASE WHEN side='Buy'  THEN usd END),0),2) AS longs_usd,
             ROUND(COALESCE(SUM(CASE WHEN side='Sell' THEN usd END),0),2) AS shorts_usd
      FROM liquidations WHERE ts >= ? GROUP BY symbol ORDER BY SUM(usd) DESC LIMIT 5`).all(since);
    return {
      stale: false,
      window_min: 60,
      tape_age_sec: age.age_sec,
      prints: t.prints,
      total_usd: n2(t.total_usd),
      longs_usd: n2(t.longs_usd),
      shorts_usd: n2(t.shorts_usd),
      dominant_side: t.longs_usd >= t.shorts_usd ? 'longs' : 'shorts',
      symbols: t.symbols,
      venues: t.venues,
      top_symbols: top.map((r) => ({ ...r, dominant_side: r.longs_usd >= r.shorts_usd ? 'longs' : 'shorts' })),
      source: 'our own bybit+okx+binance liquidation tape',
    };
  });
}

// ---- c. GET /api/funding-pulse ------------------------------------------
async function getFundingPulse() {
  return cached('entry:fundingpulse', TTL, async () => {
    // Scope is the Bybit USDT perp universe, which is the only venue this
    // service screens in full. Named honestly rather than implying a
    // cross-venue scan it does not run.
    const x = await getFundingExtremes({ limit: 5 });
    const rows = [...(x.most_positive || []), ...(x.most_negative || [])]
      .map((r) => ({ symbol: r.symbol, venue: 'bybit', funding_rate_8h: r.funding_rate_8h, annualized_pct: r.annualized_pct, oi_usd: r.oi_usd, price_24h_pct: r.price_24h_pct }))
      .sort((a, b) => Math.abs(b.annualized_pct) - Math.abs(a.annualized_pct))
      .slice(0, 5);
    if (!rows.length) return { decline: 'the funding screener returned no rows for the Bybit USDT perp universe', universe_size: x.universe_size ?? null };
    return {
      extremes: rows,
      universe_size: x.universe_size,
      min_turnover_usd: x.min_turnover_usd,
      venue_scope: ['bybit'],
      note: 'Ranked by absolute annualised funding across every Bybit USDT perp above the liquidity floor. For one symbol across Bybit, OKX and Hyperliquid use /api/funding-cross.',
      source: x.source,
    };
  });
}

// ---- d. GET /api/price?symbol= ------------------------------------------
// The multi-source price module carries one Pyth feed id per symbol and one
// Kraken pair per symbol, so its real coverage is exactly those keys. Measured,
// not assumed: SUPPORTED is read from the module's own table at require time,
// so adding a feed there extends this route with no edit here.
const SUPPORTED = Object.keys(KRAKEN_PAIR);
async function getSpot(p = {}) {
  const raw = String(p.symbol || 'SOL').trim().toUpperCase();
  const sym = raw.replace(/USDT?$/, '') || raw;
  if (!SUPPORTED.includes(sym)) {
    return { decline: `no price source configured for "${raw}"`, requested: raw, supported: SUPPORTED,
      note: 'This route serves only the symbols the multi-source price module has a feed for. For any USDT perp mark price use /api/perp.' };
  }
  return cached(`entry:spot:${sym}`, TTL, async () => {
    const q = await getPrice(sym);
    return { symbol: q.symbol, price: q.price, confidence: q.confidence, publish_time: q.publish_time, source: q.source, supported: SUPPORTED };
  });
}

module.exports = { getPerp, getLiqPulse, getFundingPulse, getSpot, _SUPPORTED: SUPPORTED, _tapeAge: tapeAge };
