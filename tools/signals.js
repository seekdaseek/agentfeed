// tools/signals.js — two routes shaped for a trading loop (R9 K3, 13 Oct 2026).
//
//   /api/signal-board        the Hyperliquid perp universe in one table, ranked by open interest in USD
//   /api/coin-signal/:coin   the same row for one coin, plus the cascade forecast, the nearest
//                            liquidation clusters around price and the top whale positions
//
// A bot polls these every 1-5 minutes, so neither touches an upstream: every number comes from data
// this box already holds, and the answer is built in well under a second.
//   hl-oi.db           our Hyperliquid sampler (bin/hl-oi-collect.js, lib/hl-oi.js): oi, mark, funding every 5 min, 7 days
//   liquidations.db    our liquidation tape (liqcollector.js; sums only here, never a single print)
//   hl-whales.json     the whale snapshot (bin/hl-whales-refresh.js, tools/hlwhales.js), every 5 min
//   caliper model      the cascade forecast (tools/cascade-forecast.js), coin-signal only
//   liq-heatmap        tools/liqdb.js getLiqHeatmap over 24 h, coin-signal only
//
// SHAPE. NOFX's External Data Sources walk `data_path` over objects only (kernel/engine.go
// extractJSONPath), so `coins` is an object keyed by coin and inserted in OI order, `ranked` is the
// order as a list, and `sources` names each source with its as_of.
//
// STALE IS 503. A source past its staleness limit answers 503 with Retry-After: x402 and the key rail
// both cancel on >= 400, so a stale answer is never billed. A change that needs history the sampler
// does not hold yet (oi 24 h before 14 Oct 03:51Z) is null, not an error.
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { cached } = require('../lib/cache');
const OI = require('../lib/hl-oi');

const LIQ_DB = () => process.env.LIQ_DB || '/opt/agentfeed/liquidations.db';
const WHALES = () => process.env.HL_WHALES_SNAPSHOT || path.join(__dirname, '..', 'hl-whales.json');

const TAPE_STALE_S = 30 * 60;    // the bound every tape route uses (tools/liquidations.js, tools/entry.js)
const WHALE_STALE_S = 15 * 60;   // three refresh periods; /api/hl-whales itself refreshes on demand past 5 min
const HOLE_S = 900;              // a sample more than this behind the moment asked for is a gap, not that moment
const BASE_HOURS = 168;          // the liquidation baseline: the coin's own last 7 days of complete hours
const BOARD_TTL_MS = 30_000;
const Z_FLOOR_USD = 5_000;       // the z denominator never falls below this: a coin with no liquidations most hours has MAD 0

// Flag rules. Published verbatim in the route description, in `rules` and in docs/nofx.md.
const RULES = {
  crowded_long: 'funding_ann_pct >= 30 and oi_chg_24h_pct >= 5',
  crowded_short: 'funding_ann_pct <= -10 and oi_chg_24h_pct >= 5',
  squeeze_risk: 'crowded_short and (chg_1h_pct >= 1 or liq_1h_short_usd >= 2 x liq_1h_long_usd with liq_1h_short_usd >= 50000)',
  liq_spike: 'liq_z >= 3 and liq_1h_long_usd + liq_1h_short_usd >= 50000',
  liq_z: '(last 60 min liquidation USD - median hourly USD of the last 168 complete hours) / max(1.4826 x MAD, 5000)',
  whale_tilt: '(whale long USD - whale short USD) / (long + short), -1 to 1, over the top 250 Hyperliquid accounts',
};

// injectable for tests: the clock, and the 30 s memo (off in tests so each case reads its own fixtures)
let clock = () => Date.now();
let memoOn = true;
const memo = (k, ttl, fn) => (memoOn ? cached(k, ttl, fn) : Promise.resolve().then(fn));

const unavailable = (msg, retryAfter = 60) => Object.assign(new Error(`${msg} Not charged.`), { status: 503, retryAfter });
const bad = (msg, supported) => Object.assign(new Error(msg), { kind: 'bad_request', ...(supported ? { supported } : {}) });
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r0 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v));
const sig = (v, d = 6) => (v == null || !Number.isFinite(v) ? null : Number(v.toPrecision(d)));
const pct = (now, then) => (now == null || !then ? null : r2(((now - then) / then) * 100));
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

// ---- sources ------------------------------------------------------------------------------------

let _tape = null;
function tape() {
  if (_tape) return _tape;
  try { _tape = new Database(LIQ_DB(), { readonly: true, fileMustExist: true }); } catch { _tape = null; }
  return _tape;
}

/** Hyperliquid coin <-> tape symbol: SOL <-> SOLUSDT, kPEPE <-> 1000PEPEUSDT (tools/hlperp.js coinFor, inverted) */
const tapeSymbol = (coin) => (/^k[A-Z0-9]+$/.test(coin) ? `1000${coin.slice(1)}USDT` : `${coin}USDT`);

/** the sampler's newest sample plus the samples ~1 h and ~24 h before it; 503 if it stopped writing */
function oiState(nowS = Math.floor(clock() / 1000)) {
  const db = OI.reader();
  const w = OI.warm(0, db, nowS);
  if (!db || w.last_ts == null) throw unavailable('signals: our Hyperliquid open-interest sampler has no data.', 300);
  if (w.stale) throw unavailable(`signals: our Hyperliquid open-interest sampler has not written for ${Math.round((nowS - w.last_ts) / 60)} minutes (limit ${OI.FRESH_S / 60}).`);
  const now = OI.snapshot(db);
  const back = (secs) => {
    const m = OI.snapshot(db, w.last_ts - secs);
    const ts = m.size ? m.values().next().value.ts : null;
    return ts != null && w.last_ts - secs - ts <= HOLE_S ? m : new Map();
  };
  return { at: w.last_ts, now, h1: back(3600), h24: back(86400) };
}

/** last 60 minutes per tape symbol: Map sym -> { long, short }; 503 when the tape stopped */
function liqNow(nowMs = clock()) {
  const db = tape();
  if (!db) throw unavailable('signals: the liquidation tape is not readable.', 300);
  const last = db.prepare('SELECT MAX(ts) AS t FROM liquidations').get().t;
  const age = last ? Math.round((nowMs - last) / 1000) : null;
  if (age == null || age > TAPE_STALE_S) throw unavailable(age == null ? 'signals: the liquidation tape is empty.' : `signals: the liquidation tape is ${age}s old, past its ${TAPE_STALE_S}s bound.`);
  const m = new Map();
  for (const r of db.prepare(`SELECT symbol, SUM(CASE WHEN side = 'Buy' THEN usd ELSE 0 END) AS l, SUM(CASE WHEN side = 'Sell' THEN usd ELSE 0 END) AS s
                              FROM liquidations WHERE ts >= ? GROUP BY symbol`).iterate(nowMs - 3600_000)) m.set(r.symbol, { long: r.l || 0, short: r.s || 0 });
  return { at: last, m };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const k = s.length; return k ? (k % 2 ? s[(k - 1) / 2] : (s[k / 2 - 1] + s[k / 2]) / 2) : null; };

/**
 * Map sym -> { median, mad } over the last 168 complete clock hours (an hour with no print counts as 0).
 * Kept incrementally: the full 7-day scan (~0.5M rows, ~1 s, synchronous) runs once per process; after
 * that each new complete hour is one small query and the oldest hour drops out, so a request never waits
 * on the scan again. Stats are recomputed once per hour.
 */
let _base = null; // { end, hours: Map sym -> Map hourIndex -> usd, stats }
function liqBaseline(nowMs = clock()) {
  const end = Math.floor(nowMs / 3600_000);           // first hour NOT in the baseline (the current one)
  const start = end - BASE_HOURS;
  const db = tape();
  if (!_base || end - _base.end > BASE_HOURS) _base = { end: start, hours: new Map(), stats: null };
  if (_base.end < end) {
    const q = db.prepare('SELECT symbol, ts / 3600000 AS h, SUM(usd) AS u FROM liquidations WHERE ts >= ? AND ts < ? GROUP BY symbol, h');
    for (const r of q.iterate(Math.max(_base.end, start) * 3600_000, end * 3600_000)) {
      let m = _base.hours.get(r.symbol); if (!m) _base.hours.set(r.symbol, (m = new Map()));
      m.set(r.h, r.u);
    }
    for (const [sym, m] of _base.hours) {
      for (const h of m.keys()) if (h < start) m.delete(h);
      if (!m.size) _base.hours.delete(sym);
    }
    _base.end = end;
    _base.stats = null;
  }
  if (!_base.stats) {
    const out = new Map();
    for (const [sym, m] of _base.hours) {
      const all = [...m.values()].concat(new Array(Math.max(0, BASE_HOURS - m.size)).fill(0));
      const med = median(all);
      out.set(sym, { median: med, mad: median(all.map((x) => Math.abs(x - med))) });
    }
    _base.stats = out;
  }
  return _base.stats;
}

let _wh = null; // { mtimeMs, snap }
/** the whale snapshot file, never an upstream call; 503 past WHALE_STALE_S */
function whales(nowMs = clock()) {
  let snap = null;
  try {
    const st = fs.statSync(WHALES());
    if (!_wh || _wh.mtimeMs !== st.mtimeMs) _wh = { mtimeMs: st.mtimeMs, snap: JSON.parse(fs.readFileSync(WHALES(), 'utf8')) };
    snap = _wh.snap;
  } catch { snap = null; }
  if (!snap || !Number.isFinite(snap.at)) throw unavailable('signals: the Hyperliquid whale snapshot is not readable.', 300);
  const age = Math.round((nowMs - snap.at) / 1000);
  if (age > WHALE_STALE_S) throw unavailable(`signals: the Hyperliquid whale snapshot is ${age}s old, past its ${WHALE_STALE_S}s bound.`);
  const by = new Map();
  for (const p of snap.positions || []) {
    let a = by.get(p.coin); if (!a) by.set(p.coin, (a = { long: 0, short: 0, ps: [] }));
    a[p.side === 'long' ? 'long' : 'short'] += Number(p.notional_usd) || 0;
    a.ps.push(p);
  }
  return { at: snap.at, by };
}

// ---- one row ------------------------------------------------------------------------------------

function row(coin, st, liq, base, wh) {
  const c = st.now.get(coin);
  const h1 = st.h1.get(coin); const h24 = st.h24.get(coin);
  const sym = tapeSymbol(coin);
  const b = base.get(sym);
  const inTape = !!b || liq.m.has(sym);
  const l = liq.m.get(sym) || { long: 0, short: 0 };
  const liqTotal = l.long + l.short;
  const z = inTape && b ? r2(Math.min(99, (liqTotal - b.median) / Math.max(1.4826 * b.mad, Z_FLOOR_USD))) : (inTape ? r2(Math.min(99, liqTotal / Z_FLOOR_USD)) : null);
  const w = wh.by.get(coin);
  const gross = w ? w.long + w.short : 0;
  const o = {
    mark: sig(c.mark),
    chg_1h_pct: pct(c.mark, h1 && h1.mark),
    chg_24h_pct: pct(c.mark, h24 && h24.mark),
    funding_1h: c.funding == null ? null : sig(c.funding, 4),
    funding_ann_pct: c.funding == null ? null : r2(c.funding * 24 * 365 * 100),
    oi_usd: c.mark == null ? null : r0(c.oi * c.mark),
    oi_chg_1h_pct: pct(c.oi, h1 && h1.oi),
    oi_chg_24h_pct: pct(c.oi, h24 && h24.oi),
    liq_1h_long_usd: inTape ? r0(l.long) : null,
    liq_1h_short_usd: inTape ? r0(l.short) : null,
    liq_z: z,
    whale_net_usd: gross > 0 ? r0(w.long - w.short) : null,
    whale_tilt: gross > 0 ? r2((w.long - w.short) / gross) : null,
  };
  const f = [];
  const crowdedLong = o.funding_ann_pct != null && o.funding_ann_pct >= 30 && o.oi_chg_24h_pct != null && o.oi_chg_24h_pct >= 5;
  const crowdedShort = o.funding_ann_pct != null && o.funding_ann_pct <= -10 && o.oi_chg_24h_pct != null && o.oi_chg_24h_pct >= 5;
  if (crowdedLong) f.push('crowded_long');
  if (crowdedShort) f.push('crowded_short');
  if (crowdedShort && ((o.chg_1h_pct != null && o.chg_1h_pct >= 1) || (inTape && l.short >= 50_000 && l.short >= 2 * l.long))) f.push('squeeze_risk');
  if (z != null && z >= 3 && liqTotal >= 50_000) f.push('liq_spike');
  o.flags = f;
  return o;
}

function sources(st, liq, wh) {
  return {
    hl_oi: { name: 'AgentFeed Hyperliquid OI sampler (Hyperliquid info API metaAndAssetCtxs every 5 min)', as_of: iso(st.at * 1000), stale_after_s: OI.FRESH_S, fields: 'mark, chg_*, funding_*, oi_*' },
    liq_tape: { name: 'AgentFeed liquidation tape (Bybit, OKX, Binance prints; sums only)', as_of: iso(liq.at), stale_after_s: TAPE_STALE_S, fields: 'liq_*' },
    hl_whales: { name: 'AgentFeed whale snapshot (top 250 Hyperliquid accounts, clearinghouseState every 5 min)', as_of: iso(wh.at), stale_after_s: WHALE_STALE_S, fields: 'whale_*' },
  };
}

/** case-insensitive coin lookup over the sampler's universe; accepts SOL, sol, SOLUSDT, SOL-PERP, 1000PEPE, kpepe */
/** The shape a coin must have before the universe is consulted: upper-cased, an optional USDT / -PERP / PERP suffix removed, 1-20 letters or digits. -> the stripped ticker or null. lib/param-guard.js applies it before anyone is asked to pay. */
function coinShape(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/(USDT|-PERP|PERP)$/, '');
  return /^[A-Z0-9]{1,20}$/.test(s) ? s : null;
}

function resolver(universe) {
  const up = new Map([...universe].map((c) => [c.toUpperCase(), c]));
  return (raw) => {
    const s = coinShape(raw);
    if (!s) return null;
    if (up.has(s)) return up.get(s);
    const m = /^10{3,}([A-Z0-9]+)$/.exec(s);
    if (m && up.has('K' + m[1])) return up.get('K' + m[1]);
    return null;
  };
}

const byOi = (st) => [...st.now.keys()].filter((c) => st.now.get(c).mark != null).sort((a, b) => st.now.get(b).oi * st.now.get(b).mark - st.now.get(a).oi * st.now.get(a).mark);

// ---- routes -------------------------------------------------------------------------------------

/** GET /api/signal-board?n=30&coins=BTC,ETH */
async function getSignalBoard(p = {}) {
  const nRaw = p.n == null || p.n === '' ? 30 : Number(p.n);
  if (!Number.isInteger(nRaw) || nRaw < 1 || nRaw > 60) throw bad('n must be an integer from 1 to 60');
  let want = null;
  if (p.coins != null && String(p.coins).trim() !== '') {
    want = [...new Set(String(p.coins).split(',').map((s) => s.trim()).filter(Boolean))];
    if (want.length > 20) throw bad('coins takes at most 20 coins');
  }
  const key = `signals:board:${nRaw}:${want ? want.join(',').toUpperCase() : ''}`;
  return memo(key, BOARD_TTL_MS, async () => {
    const st = oiState();
    const liq = liqNow();
    const wh = whales();
    const base = liqBaseline();
    const ranked = byOi(st);
    let list;
    if (want) {
      const res = resolver(ranked);
      const got = want.map((c) => [c, res(c)]);
      const unknown = got.filter(([, c]) => !c).map(([c]) => c);
      if (unknown.length) throw bad(`unknown Hyperliquid perp: ${unknown.join(', ').slice(0, 200)}`, ranked);
      const set = new Set(got.map(([, c]) => c));
      list = ranked.filter((c) => set.has(c));
    } else {
      list = ranked.slice(0, nRaw);
    }
    const coins = {};
    for (const c of list) coins[c] = row(c, st, liq, base, wh);
    return {
      as_of: iso(st.at * 1000),
      universe: ranked.length,
      ranked: list,
      coins,
      sources: sources(st, liq, wh),
      rules: { crowded_long: RULES.crowded_long, crowded_short: RULES.crowded_short, squeeze_risk: RULES.squeeze_risk, liq_spike: RULES.liq_spike },
    };
  });
}

/** nearest band above and below `mark` holding >= 10% of the heatmap's 24 h USD */
function clustersAround(hm, mark) {
  const levels = (hm && hm.levels) || [];
  const total = levels.reduce((a, l) => a + (l.usd_total || 0), 0);
  if (!total || mark == null) return { above: null, below: null };
  const big = levels.filter((l) => l.usd_total >= total * 0.1);
  const fmt = (l) => (l ? { price_low: sig(l.price_low), price_high: sig(l.price_high), usd: r0(l.usd_total), longs_usd: r0(l.longs_usd), shorts_usd: r0(l.shorts_usd), distance_pct: r2((((l.price_low + l.price_high) / 2) - mark) / mark * 100) } : null);
  const above = big.filter((l) => l.price_low > mark).sort((a, b) => a.price_low - b.price_low)[0];
  const below = big.filter((l) => l.price_high < mark).sort((a, b) => b.price_high - a.price_high)[0];
  return { above: fmt(above), below: fmt(below) };
}

/** GET /api/coin-signal/:coin */
async function getCoinSignal(p = {}, deps = {}) {
  const raw = p.coin == null ? '' : String(p.coin);
  if (!raw.trim()) throw bad('coin is required, e.g. /api/coin-signal/BTC');
  const st = oiState();
  const ranked = byOi(st);
  const coin = resolver(ranked)(raw);
  if (!coin) throw bad(`unknown Hyperliquid perp "${raw.slice(0, 40)}"`, ranked);
  return memo(`signals:coin:${coin}`, BOARD_TTL_MS, async () => {
    const liq = liqNow();
    const wh = whales();
    const base = liqBaseline();
    const r = row(coin, st, liq, base, wh);
    const sym = tapeSymbol(coin);
    const src = sources(st, liq, wh);

    // the cascade forecast: optional, a model that cannot load is a null with its reason, never a 503 for the whole answer
    let cascade = null;
    try {
      const CF = deps.cascade || require('./cascade-forecast');
      const a = ((await CF.getCascadeForecast({ query: { symbol: sym } })).answers || [])[0];
      if (a) cascade = { p: a.p == null ? null : Math.round(a.p * 1e4) / 1e4, evidence: a.evidence || null, threshold_usd: r0(a.thresholdUsd), window_end: a.windowEnd || null, ...(a.p == null && a.reason ? { reason: String(a.reason).slice(0, 160) } : {}) };
      src.cascade_forecast = { name: 'AgentFeed cascade forecast (caliper model over the liquidation tape)', as_of: (a && a.asOf) || null };
    } catch (e) {
      cascade = { p: null, reason: e && e.status === 503 ? 'the forecast model is not available right now' : 'the forecast could not be computed' };
      src.cascade_forecast = { name: 'AgentFeed cascade forecast (caliper model over the liquidation tape)', as_of: null };
    }

    let clusters = { above: null, below: null };
    try {
      const L = deps.liqdb || require('./liqdb');
      clusters = clustersAround(await L.getLiqHeatmap({ symbol: sym, hours: 24, buckets: 20 }, { tapeCheck: false }), r.mark);
    } catch { /* a coin the tape never recorded has no clusters */ }
    src.liq_heatmap = { name: 'AgentFeed liquidation heatmap, 24 h, 20 price bands (tools/liqdb.js over the tape)', as_of: src.liq_tape.as_of };

    const w = wh.by.get(coin);
    const top = w ? [...w.ps].sort((a, b) => b.notional_usd - a.notional_usd).slice(0, 3).map((x) => ({ side: x.side, size_usd: r0(x.notional_usd), entry_px: sig(x.entry_px), liquidation_px: sig(x.liquidation_px) })) : [];

    return {
      coin,
      oi_rank: ranked.indexOf(coin) + 1,
      as_of: iso(st.at * 1000),
      ...r,
      cascade_15m: cascade,
      liq_cluster_above: clusters.above,
      liq_cluster_below: clusters.below,
      whale_top: top,
      sources: src,
    };
  });
}

module.exports = { getSignalBoard, getCoinSignal, liqBaseline, RULES, coinShape, TAPE_STALE_S, WHALE_STALE_S, _tapeSymbol: tapeSymbol, _resolver: resolver, _clustersAround: clustersAround, _reset: () => { _tape = null; _wh = null; _base = null; },
  _setClock: (f) => { clock = f || (() => Date.now()); }, _memo: (on) => { memoOn = !!on; } };
