// tools/liqdb.js — expansion: the MOAT (5 tools). Queries against our own
// collected liquidation tape (/opt/agentfeed/liquidations.db). Bybit is the
// only complete unthrottled liq tape in crypto and no exchange publishes
// history — this data exists nowhere else.
// side convention (liqcollector v3): 'Buy' = LONG liquidated, 'Sell' = SHORT liquidated.
'use strict';
const Database = require('better-sqlite3');
const { cached } = require('../lib/cache');
const { _normSym: normSym, getOpenInterest, getLongShort, getFundingCross } = require('./derivs');

const DB_PATH = process.env.LIQ_DB || '/opt/agentfeed/liquidations.db';
let db = null;
function getDb() {
  if (!db) db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return db;
}
const clampInt = (v, lo, hi, d) => Math.min(Math.max(parseInt(v) || d, lo), hi);

// ---- get_liq_history ($0.05) — time-bucketed liq aggregates, any symbol or whole tape
function getLiqHistory(p = {}) {
  const hours = clampInt(p.hours, 1, 168, 24);
  const bucketMin = clampInt(p.bucket_min, 5, 1440, 60);
  const scopeAll = String(p.scope || '').toLowerCase() === 'all';
  const sym = scopeAll ? null : normSym(p.symbol);
  const since = Date.now() - hours * 3600_000;
  const bucketMs = bucketMin * 60_000;
  const rows = getDb().prepare(`
    SELECT (ts / ${bucketMs}) * ${bucketMs} AS bucket,
           COUNT(*) AS prints,
           ROUND(SUM(usd)) AS usd_total,
           ROUND(SUM(CASE WHEN side = 'Buy' THEN usd ELSE 0 END)) AS longs_usd,
           ROUND(SUM(CASE WHEN side = 'Sell' THEN usd ELSE 0 END)) AS shorts_usd,
           ROUND(MAX(usd)) AS biggest_print
    FROM liquidations
    WHERE ts >= ? ${sym ? 'AND symbol = ?' : ''}
    GROUP BY bucket ORDER BY bucket ASC`).all(...(sym ? [since, sym] : [since]));
  const total = rows.reduce((s, r) => s + r.usd_total, 0);
  return {
    scope: sym || 'all_symbols', hours, bucket_min: bucketMin,
    total_usd: Math.round(total),
    longs_usd: Math.round(rows.reduce((s, r) => s + r.longs_usd, 0)),
    shorts_usd: Math.round(rows.reduce((s, r) => s + r.shorts_usd, 0)),
    buckets: rows,
    source: 'agentfeed_liq_tape (bybit complete + okx + binance)',
  };
}

// ---- get_liq_heatmap ($0.05) — where leverage actually got flushed, by price level
function getLiqHeatmap(p = {}) {
  const sym = normSym(p.symbol); // heatmap is per-symbol by design (price axis)
  const hours = clampInt(p.hours, 1, 168, 24);
  const nBuckets = clampInt(p.buckets, 5, 50, 20);
  const since = Date.now() - hours * 3600_000;
  const range = getDb().prepare(
    'SELECT MIN(price) lo, MAX(price) hi, COUNT(*) c FROM liquidations WHERE symbol = ? AND ts >= ?').get(sym, since);
  if (!range.c) return { symbol: sym, hours, levels: [], note: 'no liquidations recorded in window' };
  const { lo, hi } = range;
  const step = (hi - lo) / nBuckets || 1;
  const rows = getDb().prepare(`
    SELECT CAST((price - ?) / ? AS INTEGER) AS b,
           ROUND(SUM(usd)) usd_total, COUNT(*) prints,
           ROUND(SUM(CASE WHEN side = 'Buy' THEN usd ELSE 0 END)) longs_usd,
           ROUND(SUM(CASE WHEN side = 'Sell' THEN usd ELSE 0 END)) shorts_usd
    FROM liquidations WHERE symbol = ? AND ts >= ?
    GROUP BY b ORDER BY b ASC`).all(lo, step, sym, since);
  const levels = rows.map((r) => ({
    price_low: Number((lo + r.b * step).toFixed(6)),
    price_high: Number((lo + (r.b + 1) * step).toFixed(6)),
    usd_total: r.usd_total, prints: r.prints, longs_usd: r.longs_usd, shorts_usd: r.shorts_usd,
  }));
  const hottest = levels.reduce((a, b) => (b.usd_total > (a?.usd_total || 0) ? b : a), null);
  return {
    symbol: sym, hours, price_range: [lo, hi], levels, hottest_zone: hottest,
    note: 'historical flush zones from our tape — where leverage DIED, not an entry-price liq-level estimate',
  };
}

// ---- get_cascade_history ($0.03) — past cascade events reconstructed from the tape
function getCascadeHistory(p = {}) {
  const hours = clampInt(p.hours, 1, 72, 24);
  const gapS = clampInt(p.gap_s, 10, 300, 60);
  const scopeAll = String(p.scope || '').toLowerCase() === 'all';
  const sym = scopeAll ? null : normSym(p.symbol);
  const minUsd = Math.max(Number(p.min_usd) || (scopeAll ? 250_000 : 100_000), 10_000);
  const since = Date.now() - hours * 3600_000;
  const rows = getDb().prepare(`
    SELECT ts, symbol, side, usd FROM liquidations
    WHERE ts >= ? ${sym ? 'AND symbol = ?' : 'AND usd >= 500'}
    ORDER BY symbol, side, ts ASC LIMIT 500000`).all(...(sym ? [since, sym] : [since]));
  const events = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.usd_total >= minUsd && cur.prints >= 3) {
      events.push({ ...cur, usd_total: Math.round(cur.usd_total), duration_s: Math.round((cur.end_ts - cur.start_ts) / 1000) });
    }
    cur = null;
  };
  for (const r of rows) {
    if (cur && r.symbol === cur.symbol && r.side === cur.raw_side && r.ts - cur.end_ts <= gapS * 1000) {
      cur.end_ts = r.ts; cur.prints++; cur.usd_total += r.usd; cur.peak_print = Math.max(cur.peak_print, r.usd);
    } else {
      flush();
      cur = { symbol: r.symbol, raw_side: r.side, side: r.side === 'Buy' ? 'longs_liquidated' : 'shorts_liquidated', start_ts: r.ts, end_ts: r.ts, prints: 1, usd_total: r.usd, peak_print: r.usd };
    }
  }
  flush();
  events.forEach((e) => { delete e.raw_side; e.peak_print = Math.round(e.peak_print); });
  events.sort((a, b) => b.usd_total - a.usd_total);
  return {
    scope: sym || 'all_symbols', hours, min_usd: minUsd, gap_s: gapS,
    cascade_count: events.length, cascades: events.slice(0, 50),
    source: 'agentfeed_liq_tape',
  };
}

// ---- get_squeeze_score ($0.10) — flagship composite: funding + OI + liq skew + crowding
async function getSqueezeScore(p = {}) {
  const sym = normSym(p.symbol);
  return cached(`squeeze:${sym}`, 60_000, async () => {
    const since = Date.now() - 24 * 3600_000;
    const liq = getDb().prepare(`
      SELECT ROUND(SUM(CASE WHEN side='Buy' THEN usd ELSE 0 END)) longs_usd,
             ROUND(SUM(CASE WHEN side='Sell' THEN usd ELSE 0 END)) shorts_usd
      FROM liquidations WHERE symbol = ? AND ts >= ?`).get(sym, since);
    const [oi, ls, f] = await Promise.all([
      getOpenInterest({ symbol: sym }).catch(() => null),
      getLongShort({ symbol: sym }).catch(() => null),
      getFundingCross({ symbol: sym }).catch(() => null),
    ]);
    const funding = f?.venues?.bybit?.funding_rate_8h ?? null;
    const oiChg = oi?.bybit?.change_24h_pct ?? null;
    const longPct = ls?.long_pct ?? null;
    const longsUsd = liq?.longs_usd || 0, shortsUsd = liq?.shorts_usd || 0;
    const cap = (x, m) => Math.max(-1, Math.min(1, x / m));
    // SHORT-squeeze fuel: shorts crowded (negative funding, low long%), OI building, shorts not yet flushed
    let shortSq = 0, longSq = 0;
    if (funding != null) { shortSq += cap(-funding, 0.0005) * 35; longSq += cap(funding, 0.0005) * 35; }
    if (longPct != null) { shortSq += cap(50 - longPct, 15) * 25; longSq += cap(longPct - 50, 15) * 25; }
    if (oiChg != null) { shortSq += cap(oiChg, 10) * 20; longSq += cap(oiChg, 10) * 20; }
    const totalLiq = longsUsd + shortsUsd;
    if (totalLiq > 0) {
      const shortFlushed = shortsUsd / totalLiq; // already-flushed shorts = less fuel
      shortSq += (1 - shortFlushed * 2) * 20;
      longSq += (1 - (longsUsd / totalLiq) * 2) * 20;
    }
    const score = (x) => Math.max(0, Math.min(100, Math.round(x)));
    return {
      symbol: sym,
      short_squeeze_score: score(shortSq),
      long_flush_score: score(longSq),
      inputs: {
        funding_rate_8h: funding, oi_change_24h_pct: oiChg, long_account_pct: longPct,
        liq_24h: { longs_usd: longsUsd, shorts_usd: shortsUsd },
      },
      read: score(shortSq) >= 65 ? 'crowded shorts + building OI — short-squeeze conditions' :
            score(longSq) >= 65 ? 'crowded longs + building OI — long-flush risk' : 'no extreme setup',
      note: 'heuristic composite 0-100 (funding 35 / crowding 25 / OI 20 / liq-skew 20). Context, not financial advice.',
    };
  });
}

// ---- get_venue_liq_share ($0.02) — which exchange is flushing whom
function getVenueLiqShare(p = {}) {
  const hours = clampInt(p.hours, 1, 168, 24);
  const scopeAll = !p.symbol || String(p.scope || '').toLowerCase() === 'all';
  const sym = scopeAll ? null : normSym(p.symbol);
  const since = Date.now() - hours * 3600_000;
  const rows = getDb().prepare(`
    SELECT exchange, COUNT(*) prints, ROUND(SUM(usd)) usd_total,
           ROUND(SUM(CASE WHEN side='Buy' THEN usd ELSE 0 END)) longs_usd,
           ROUND(SUM(CASE WHEN side='Sell' THEN usd ELSE 0 END)) shorts_usd,
           ROUND(MAX(usd)) biggest_print
    FROM liquidations WHERE ts >= ? ${sym ? 'AND symbol = ?' : ''}
    GROUP BY exchange ORDER BY usd_total DESC`).all(...(sym ? [since, sym] : [since]));
  const total = rows.reduce((s, r) => s + r.usd_total, 0) || 1;
  return {
    scope: sym || 'all_symbols', hours,
    total_usd: Math.round(total),
    venues: rows.map((r) => ({ ...r, share_pct: Number(((r.usd_total / total) * 100).toFixed(1)) })),
    note: 'bybit tape is complete; okx/binance streams are throttled by the venues — shares reflect visible tape',
  };
}

module.exports = { getLiqHistory, getLiqHeatmap, getCascadeHistory, getSqueezeScore, getVenueLiqShare };
