// tools/briefs/sources.js: how the briefs read what AgentFeed already holds. Every accessor wraps an EXISTING function or file reader (hl-oi.js,
// liqdb.js, signals.js, fundingradar.js, macro.js, feargreed.js, derivs.js) and returns { value, as_of_ms } or throws; none opens a new upstream
// except the Fear and Greed read, which is the one memoised upstream market-state already makes. A brief takes a `deps` object shaped like this one,
// so a test replaces any accessor with a fixture.
'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const OI = require('../../lib/hl-oi');
const L = require('../liqdb');
const D = require('../derivs');
const SIG = require('../signals');
const FR = require('../fundingradar');
const MACRO = require('../macro');
const MS = require('../marketstate');
const { getFearGreed } = require('../feargreed');
const { unavailable, iso } = require('./engine');

const HOLE_S = 900;   // derivs.js / signals.js: a stored sample more than this behind the moment asked for is a gap in the record, not that moment
const LIQ_DB = () => process.env.LIQ_DB || '/opt/agentfeed/liquidations.db';

/** the coin <-> tape symbol rule (tools/signals.js) and the radar's symbol (marketstate: `${base}USDT`) */
const tapeSymbol = SIG._tapeSymbol;

/**
 * The sampler: the newest sample of every coin and the samples `offsetsS` seconds before it. The core of every brief: stale or empty is a 503.
 * -> { last_ts, cur: Map coin -> row, back: { [offsetS]: Map | null } } (null where the record has a gap at that baseline)
 */
function oiWindow(nowMs, offsetsS) {
  const db = OI.reader();
  const nowS = Math.floor(nowMs / 1000);
  const w = OI.warm(0, db, nowS);
  if (!db || w.last_ts == null) throw unavailable('our Hyperliquid open-interest sampler has no data.', 300);
  if (w.stale) throw unavailable(`our Hyperliquid open-interest sampler has not written for ${Math.round((nowS - w.last_ts) / 60)} minutes (limit ${OI.FRESH_S / 60}).`);
  const cur = OI.snapshot(db);
  const back = {};
  for (const off of offsetsS) {
    const m = OI.snapshot(db, w.last_ts - off);
    const ts = m.size ? m.values().next().value.ts : null;
    back[off] = ts != null && w.last_ts - off - ts <= HOLE_S ? m : null;
  }
  return { value: { last_ts: w.last_ts, cur, back, first_ts: w.first_ts }, as_of_ms: w.last_ts * 1000, name: 'AgentFeed Hyperliquid sampler (mark, open interest in coin units, funding, every 5 minutes)' };
}

/** one coin's samples over the last `secs`, oldest first */
function oiSeries(coin, secs, nowMs) {
  const db = OI.reader();
  if (!db) return [];
  return OI.series(db, coin, secs, Math.floor(nowMs / 1000));
}

let _tape = null;
/** the newest print of the whole liquidation tape (the freshness the tape routes use: any symbol printing means the collector is alive) */
function tapeAsOf() {
  try { if (!_tape) _tape = new Database(LIQ_DB(), { readonly: true, fileMustExist: true }); } catch { _tape = null; }
  if (!_tape) throw new Error('the liquidation tape is not readable');
  const t = _tape.prepare('SELECT MAX(ts) AS t FROM liquidations').get().t;
  if (!t) throw new Error('the liquidation tape is empty');
  return { value: t, as_of_ms: t, name: 'AgentFeed liquidation tape (Bybit, OKX, Binance prints; sums and extremes only)' };
}

/** liquidation buckets of one symbol: [{ bucket (ms), prints, usd_total, longs_usd, shorts_usd, biggest_print }] (longs_usd = longs liquidated) */
function liqBuckets(symbol, hours, bucketMin) {
  return (L.getLiqHistory({ symbol, hours, bucket_min: bucketMin }, { tapeCheck: false }).buckets) || [];
}

/** the nearest liquidation cluster above and below `mark` from the 24 h heatmap (signals.js _clustersAround), or { above: null, below: null } */
function clusters(symbol, mark) {
  try { return SIG._clustersAround(L.getLiqHeatmap({ symbol, hours: 24, buckets: 20 }, { tapeCheck: false }), mark); } catch { return { above: null, below: null }; }
}

/** today's scheduled macro events (UTC day of nowMs) from the calendar snapshot; stale after the calendar's own STALE_AFTER_DAYS */
function macroDay(nowMs) {
  const s = MACRO.readSnapshot();
  if (!s) throw new Error('the macro calendar has not been built');
  const ageDays = (nowMs - s.verified_at_ms) / 86_400_000;
  if (ageDays > MACRO.STALE_AFTER_DAYS) throw new Error(`macro calendar last verified ${s.verified_at} (${ageDays.toFixed(1)} days ago; limit ${MACRO.STALE_AFTER_DAYS})`);
  const day = iso(nowMs).slice(0, 10);
  const events = s.events.filter((e) => e.utc && e.utc.slice(0, 10) === day).map((e) => ({ type: e.type, title: e.title, utc: e.utc, source_url: e.source_url }));
  return { value: { events, all: s.events.filter((e) => e.utc).map((e) => ({ type: e.type, title: e.title, utc: e.utc })) }, as_of_ms: s.verified_at_ms, name: 'AgentFeed macro calendar (Federal Reserve, BLS and BEA pages)' };
}

async function fearGreed() {
  const f = await getFearGreed();
  return { value: { value: f.value, classification: f.classification }, as_of_ms: f.timestamp * 1000, name: 'alternative.me Fear & Greed Index (https://alternative.me/crypto/fear-and-greed-index/)' };
}

function radarRow(symbol, nowMs) {
  const r = FR.getRadarRow(symbol, { now: nowMs });
  if (!r) throw new Error('funding radar snapshot not built yet');
  if (r.stale) throw new Error(`funding radar snapshot is ${r.age_s}s old (limit ${FR.STALE_AFTER_S}s)`);
  if (!r.row) throw new Error(`${symbol} is not in the funding radar`);
  return { value: r.row, as_of_ms: Date.parse(r.as_of), name: 'AgentFeed funding radar snapshot (30-day z-scores)' };
}

/** the radar's most extreme rows, everything with |z| >= the marketstate threshold included (top 100 by extremity) */
function radarAll(nowMs) {
  const r = FR.getFundingRadar({ top: 100, min_oi_usd: 0 }, { now: nowMs });
  return { value: { rows: r.symbols, universe: r.universe, matched: r.matched }, as_of_ms: Date.parse(r.as_of), name: 'AgentFeed funding radar snapshot (30-day z-scores)' };
}

/** the sampler's OI spike scan over every coin above its liquidity floor (derivs.js spikeScan: 503 until the record covers 24 h) */
function spikes(nowMs) {
  const db = OI.reader();
  const r = D._spikeScan(db, 500, Math.floor(nowMs / 1000));
  return { value: r, as_of_ms: Date.parse(r.as_of), name: 'AgentFeed open-interest spike scan (sampler, 1 h change against the coin\'s previous day)' };
}

/** the signal board, top 60 coins by open interest: liquidations in the last hour and their baseline z (503 when a source is stale) */
async function board() {
  const b = await SIG.getSignalBoard({ n: 60 });
  return { value: b, as_of_ms: Date.parse(b.as_of), name: 'AgentFeed signal board (sampler + liquidation tape)' };
}

module.exports = {
  real: { oiWindow, oiSeries, tapeAsOf, liqBuckets, clusters, macroDay, fearGreed, radarRow, radarAll, spikes, board, liqBaseline: () => SIG.liqBaseline() },
  tapeSymbol, TAPE_STALE_S: SIG.TAPE_STALE_S, OI_FRESH_S: OI.FRESH_S, RADAR_STALE_S: FR.STALE_AFTER_S, T: MS.THRESHOLDS, SYMBOLS: MS.SYMBOLS,
  clusterOf: (c) => c,
};
