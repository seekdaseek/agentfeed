// tools/r23/cascade-backtest/backtest.js: the event study. Tape events (events.js) + Hyperliquid 15-minute closes (candles.js) -> forward returns, statistics, baseline.
//
// Returns FULL-PRECISION numbers (fractions, milliseconds); index.js rounds them for the response. `deps` makes every outside thing injectable:
//   { db, now: ms | () => ms, cacheDir, fetchCandles({coin,startMs,endMs}) -> [{t,c}], offline (never refresh), callGapMs }
'use strict';
const Database = require('better-sqlite3');
const C = require('./config');
const K = require('./candles');
const S = require('./stats');
const { scanEvents, TooManyEvents } = require('./events');
const { unavailable, notCovered, bad } = require('../common');

/** the tape, read-only. A forward scan touches each page a few times in a row and never again, so a 2 MB page cache costs no speed and keeps this handle's memory small. */
function openTape(file = process.env.LIQ_DB || '/opt/agentfeed/liquidations.db') {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma('cache_size = -2048');
  return db;
}
let sharedDb = null;
function getDb(deps) {
  if (deps.db) return deps.db;
  if (!sharedDb) {
    try { sharedDb = openTape(); } catch (e) { throw unavailable(`the liquidation tape could not be opened (${String(e.message).slice(0, 80)})`, 300); }
  }
  return sharedDb;
}

/** a failure inside the tape database (a missing table, a corrupt page, a locked file) is the tape's, not the caller's: a 503 that settles nothing */
const tapeUnreadable = (e) => (e && (e.status || e.kind) ? e : unavailable(`the liquidation tape could not be read (${String((e && e.message) || e).slice(0, 80)})`, 300));
const emptyReasons = () => ({ not_cached: 0, candle_gap: 0, not_elapsed: 0 });
const retentionStart = (nowGrid) => K.dayStartOf(nowGrid - C.SOURCE_RETENTION_CANDLES * C.STEP_MS);

/**
 * @param {object} p { symbol (tape symbol, e.g. BTCUSDT), coin (Hyperliquid coin), sideMode, minUsd, windowMin, cooldownMin }
 */
async function backtest(p, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now() : Number.isFinite(deps.now) ? deps.now : Date.now();
  const nowGrid = Math.floor(now / C.STEP_MS) * C.STEP_MS;
  const dir = deps.cacheDir || C.cacheDir();
  const db = getDb(deps);
  const windowMs = p.windowMin * C.MIN, cooldownMs = p.cooldownMin * C.MIN;
  const fetchCandles = deps.fetchCandles || ((a) => K.fetchCandlesHL(a));
  const refreshArgs = (fromMs) => ({ dir, symbol: p.symbol, coin: p.coin, fromMs, nowMs: now, fetchCandles, gapMs: deps.callGapMs });

  // ---- prices cached so far; a symbol with no readable day file is refreshed once before giving up
  let series = K.loadSeries(dir, p.symbol);
  let refreshInfo = null;
  if (!series && !deps.offline) {
    refreshInfo = await K.refresh(refreshArgs(nowGrid - C.SOURCE_RETENTION_CANDLES * C.STEP_MS));
    series = K.loadSeries(dir, p.symbol);
  }
  if (!series || series.firstCandle == null) throw unavailable(`no price history is cached for ${p.symbol}${refreshInfo && refreshInfo.status === 'failed' ? ' and Hyperliquid could not be asked' : ''}`, 300);

  // ---- the period: the tape's coverage of the symbol, cut to the span the price cache covers
  let tapeFirst, tapeLast;
  try {
    tapeFirst = db.prepare('SELECT MIN(ts) AS m FROM liquidations WHERE symbol = ?').get(p.symbol).m;
    tapeLast = db.prepare('SELECT MAX(ts) AS m FROM liquidations').get().m;
  } catch (e) { throw tapeUnreadable(e); }
  const base = { symbol: p.symbol, coin: p.coin, sideMode: p.sideMode, minUsd: p.minUsd, windowMin: p.windowMin, cooldownMin: p.cooldownMin };
  const horizonsEmpty = () => C.HORIZONS.map((h) => ({ key: h.key, minutes: h.minutes, events: S.summarize([], 0), baseline: S.summarize([], 0), skipped: { events: emptyReasons(), baseline: emptyReasons() } }));
  if (tapeFirst == null || tapeLast == null) return { ...base, period: null, prices: priceInfo(series, refreshInfo), eventsFound: 0, rows: 0, events: [], baseline: { requested: 0, drawn: 0, times: [] }, horizons: horizonsEmpty() };
  const fromTs = Math.max(tapeFirst, series.firstCandle, now - C.MAX_LOOKBACK_DAYS * C.DAY_MS);
  const toTs = tapeLast;
  if (fromTs > toTs) return { ...base, period: null, prices: priceInfo(series, refreshInfo), eventsFound: 0, rows: 0, events: [], baseline: { requested: 0, drawn: 0, times: [] }, horizons: horizonsEmpty() };

  // ---- events
  let scanned;
  try { scanned = scanEvents(db, { symbol: p.symbol, sideMode: p.sideMode, fromTs, toTs, minUsd: p.minUsd, windowMs, cooldownMs }); } catch (e) {
    if (e instanceof TooManyEvents) throw bad(`this threshold gives more than ${C.MAX_EVENTS} events in the period: raise min_usd or cooldown_min`);
    if (e && e.tooManyRows) throw unavailable('the symbol has more tape prints than one request may read', 3600);
    throw tapeUnreadable(e);
  }
  const events = scanned.events;
  const period = { fromTs, toTs };
  if (!events.length) return { ...base, period, prices: priceInfo(series, refreshInfo), eventsFound: 0, rows: scanned.rows, events: [], baseline: { requested: 0, drawn: 0, times: [] }, horizons: horizonsEmpty() };

  // ---- baseline times: seeded, same count as the events, outside every event window
  for (const e of events) e.entryTs = (Math.floor(e.triggerTs / C.STEP_MS) + 1) * C.STEP_MS;
  const baseTimes = S.drawBaselineTimes({
    count: events.length, firstIdx: Math.floor(fromTs / C.STEP_MS) + 1, lastIdx: Math.floor(toTs / C.STEP_MS), stepMs: C.STEP_MS,
    excluded: events.map((e) => [e.triggerTs - windowMs, e.endTs + cooldownMs]),
  });

  // ---- refresh the price cache when the newest prices these windows need are not in it, or a day they need is missing or damaged (Hyperliquid still has it)
  const maxH = C.HORIZONS[C.HORIZONS.length - 1].ms;
  const needUntil = Math.min(nowGrid, Math.max(events[events.length - 1].entryTs, baseTimes.length ? Math.max(...baseTimes) : 0) + maxH);
  const rs = retentionStart(nowGrid);
  const firstNeedDay = K.dayStartOf(fromTs), lastNeedDay = K.dayStartOf(needUntil);
  const fixable = [...series.corruptDays, ...series.holes()].filter((d) => d >= Math.max(rs, firstNeedDay) && d <= lastNeedDay);
  const stale = series.lastThrough < needUntil;
  if (!deps.offline && (stale || fixable.length)) {
    const from = Math.min(stale ? K.dayStartOf(series.lastThrough - 1) : Infinity, ...fixable);
    refreshInfo = await K.refresh(refreshArgs(from));
    const again = K.loadSeries(dir, p.symbol);
    if (again) series = again;
  }

  // ---- forward returns
  const reasonsE = C.HORIZONS.map(emptyReasons), reasonsB = C.HORIZONS.map(emptyReasons);
  const retE = C.HORIZONS.map(() => []), retB = C.HORIZONS.map(() => []);
  const forward = (T, retArr, reasonArr) => {
    const p0 = series.priceAt(T);
    const out = { entryPrice: p0.p === undefined ? null : p0.p, returns: {}, skip: {} };
    C.HORIZONS.forEach((h, i) => {
      if (p0.reason) { out.returns[h.key] = null; out.skip[h.key] = p0.reason; reasonArr[i][p0.reason]++; return; }
      const p1 = series.priceAt(T + h.ms);
      if (p1.reason) { out.returns[h.key] = null; out.skip[h.key] = p1.reason; reasonArr[i][p1.reason]++; return; }
      const r = p1.p / p0.p - 1;
      out.returns[h.key] = r; out.skip[h.key] = null; retArr[i].push(r);
    });
    return out;
  };
  for (const e of events) Object.assign(e, forward(e.entryTs, retE, reasonsE));
  for (const T of baseTimes) forward(T, retB, reasonsB);

  const priced = retE.reduce((s, a) => s + a.length, 0);
  if (!priced) {
    if (refreshInfo && refreshInfo.status === 'failed') throw unavailable(`${events.length} events were found but their prices could not be read: Hyperliquid could not be asked and the cache does not hold them`, 300);
    throw notCovered(`${events.length} events were found at this threshold, but none has a cached price window yet (the price history covers ${new Date(series.firstCandle).toISOString().slice(0, 10)} to ${new Date(series.lastThrough).toISOString().slice(0, 16)}Z)`);
  }

  const horizons = C.HORIZONS.map((h, i) => ({
    key: h.key, minutes: h.minutes,
    events: S.summarize(retE[i], C.SEED_BOOTSTRAP + 2 * i),
    baseline: S.summarize(retB[i], C.SEED_BOOTSTRAP + 2 * i + 1),
    skipped: { events: reasonsE[i], baseline: reasonsB[i] },
  }));
  return { ...base, period, prices: priceInfo(series, refreshInfo), eventsFound: events.length, rows: scanned.rows, events, baseline: { requested: events.length, drawn: baseTimes.length, times: baseTimes }, horizons };
}

function priceInfo(series, refreshInfo) {
  return { firstCandleTs: series.firstCandle, throughTs: series.lastThrough, refresh: refreshInfo };
}

module.exports = { backtest, openTape };
