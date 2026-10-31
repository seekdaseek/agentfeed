// tools/r23/cascade-backtest/index.js: get_cascade_backtest ($0.50), GET /api/cascade-backtest. R23, T2.
//
// An event study on OUR liquidation tape: past cascades of a symbol at a threshold, what price did after them (15 m, 1 h, 4 h, 24 h), n, mean, median, hit rate, a seeded
// bootstrap interval, and the same statistics for random times as a baseline. Prices are Hyperliquid's public 15-minute candles, cached on disk (candles.js).
// Past data described: no forecast, no advice. Failure semantics (contract rule 5): bad input 400, a symbol or window the cache cannot price 404, an unreadable tape or an upstream
// that cannot be asked 503; none of them settles.
'use strict';
const { z } = require('zod');
const C = require('./config');
const K = require('./candles');
const { backtest } = require('./backtest');
const { bad } = require('../common');

const fmtN = (n) => Number(n).toLocaleString('en-US');
const given = (v) => v != null && v !== '';
const iso = (ms) => new Date(ms).toISOString();
const round = (x, d) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));
const pct = (r) => (r == null ? null : round(r * 100, 4));
const horizonList = (conj = 'and') => { const k = C.HORIZONS.map((h) => (h.minutes >= 60 ? `${h.minutes / 60} h` : `${h.minutes} m`)); return `${k.slice(0, -1).join(', ')} ${conj} ${k[k.length - 1]}`; };

// ---- the query parameters: an impossible value is a 400 thrown before anything is read; "not given" (missing or empty) is the default, exactly as lib/query-rules.js reads it
function numParam(name, v, { lo, hi, dflt }, integer) {
  if (!given(v)) return dflt;
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < lo || n > hi || (integer && !Number.isInteger(n))) throw bad(`${name} must be ${integer ? 'an integer' : 'a number'} from ${lo} to ${hi}`);   // plain numbers: lib/query-rules.js prints them this way, and the guard must say what the handler says
  return n;
}
function parseParams(a = {}) {
  let side = C.SIDE_DEFAULT;
  if (given(a.side)) {
    side = typeof a.side === 'string' ? a.side.toLowerCase() : '';
    if (!C.SIDES.includes(side)) throw bad(`side must be ${C.SIDES.slice(0, -1).join(', ')} or ${C.SIDES[C.SIDES.length - 1]}`);
  }
  return {
    side,
    minUsd: numParam('min_usd', a.min_usd, C.MIN_USD, false),
    windowMin: numParam('window_min', a.window_min, C.WINDOW_MIN, true),
    cooldownMin: numParam('cooldown_min', a.cooldown_min, C.COOLDOWN_MIN, true),
    limit: numParam('limit', a.limit, C.LIMIT, true),
  };
}

// symbol: BTC, btc, BTCUSDT, kPEPE and 1000PEPE all work, through the same normaliser get_cascade_history uses; anything the cache does not cover is a 400 that lists what is covered
function resolveSymbol(raw, supported) {
  const sym = require('../../derivs')._normSym(raw);
  const hit = supported.find((s) => s.symbol === sym);
  if (!hit) {
    const list = supported.map((s) => s.symbol);
    throw Object.assign(bad(`unsupported symbol "${String(raw == null ? '' : raw).slice(0, 40)}": the cascade backtest covers ${list.length ? list.join(', ') : 'no symbol yet'}`), { supported: list });
  }
  return hit;
}

// ---- the response
const stat = (s) => ({ n: s.n, mean_pct: pct(s.mean), median_pct: pct(s.median), hit_rate_pct: s.hit_rate == null ? null : round(s.hit_rate * 100, 2), mean_ci95_pct: s.ci ? [pct(s.ci[0]), pct(s.ci[1])] : null });
const reasons = (r) => Object.fromEntries(Object.entries(r).filter(([, n]) => n > 0));

function methodBlock(P) {
  return {
    event: `Prints of the chosen side on our liquidation tape are summed over a rolling ${P.windowMin}-minute window. An event starts at the first print where that window holds at least ${C.MIN_PRINTS} prints and at least ${fmtN(P.minUsd)} USD. `
      + `Windows that stay at or above the threshold belong to the same event; the next event needs ${P.cooldownMin} minutes with no such window, so one cascade is one event.`,
    side: 'long counts liquidated long positions only, short counts liquidated short positions only, both counts either. With both, events of opposite direction are pooled and their signed returns partly cancel; query long and short separately to see each direction.',
    forward_return: `Entry is the first ${C.INTERVAL} candle close after the event starts (the close of the candle that contains the start). The forward return at each horizon is that symbol's close ${horizonList('and')} later divided by the entry close, minus one, in percent. It is the signed price change, not adjusted for direction.`,
    hit_rate: 'The share of events (or baseline times) with a forward return above zero.',
    baseline: `Random times with the same count as the events, drawn with the fixed seed ${C.SEED_BASELINE} from the ${C.INTERVAL} grid of the same symbol and period, never inside an event window (from ${P.windowMin} minutes before the event starts to ${P.cooldownMin} minutes after its last qualifying print), each priced the same way.`,
    interval: `Percentile bootstrap of the mean: ${fmtN(C.BOOTSTRAP_B)} resamples with replacement, fixed seeds, the ${Math.round(C.CI_LEVEL * 100)} percent interval taken from the sorted resample means. No interval is given when n is below ${C.MIN_N_FOR_INTERVAL}.`,
    left_out: 'An event is left out of a horizon when its price window cannot be read: not_cached (no cached candle there), candle_gap (the exchange printed no candle), or not_elapsed (the horizon ends after the newest cached candle). The counts are given per horizon.',
    limits: `Events closer together than a horizon share price moves, so the intervals understate the real uncertainty. Some of the exchange streams the tape records are throttled by the exchanges, so USD totals are lower bounds. Hyperliquid keeps ${fmtN(C.SOURCE_RETENTION_CANDLES)} candles of this interval, so the price history is cached from the day it was first read. This describes past data; it is not a forecast and not financial advice.`,
  };
}

function present(res, P) {
  const listed = [...res.events].sort((a, b) => b.windowUsd - a.windowUsd || a.triggerTs - b.triggerTs).slice(0, P.limit).map((e) => {
    const left = {};
    for (const h of C.HORIZONS) if (e.skip[h.key]) left[h.key] = e.skip[h.key];
    return {
      start_time: iso(e.triggerTs), last_qualifying_print_time: iso(e.endTs), window_usd: round(e.windowUsd, 2), prints: e.prints, longs_usd: round(e.longsUsd, 2), shorts_usd: round(e.shortsUsd, 2),
      entry_time: iso(e.entryTs), entry_close: e.entryPrice,
      forward_return_pct: Object.fromEntries(C.HORIZONS.map((h) => [h.key, pct(e.returns[h.key])])),
      ...(Object.keys(left).length ? { left_out: left } : {}),
    };
  });
  const notes = [];
  if (!res.eventsFound) notes.push('No event at this threshold in the period: a valid answer. Lower min_usd or window_min to see events.');
  if (res.horizons.some((h) => (h.events.n > 0 && h.events.n < C.MIN_N_FOR_INTERVAL) || (h.baseline.n > 0 && h.baseline.n < C.MIN_N_FOR_INTERVAL))) notes.push(`At least one row has fewer than ${C.MIN_N_FOR_INTERVAL} observations: no interval is given for it.`);
  if (res.eventsFound && res.baseline.drawn < res.baseline.requested) notes.push(`Only ${res.baseline.drawn} of ${res.baseline.requested} baseline times fit outside the event windows.`);
  if (res.prices.refresh && res.prices.refresh.status === 'failed') notes.push('The price history could not be refreshed from Hyperliquid just now; this answer uses the cache as it was.');
  return {
    symbol: res.symbol, hyperliquid_coin: res.coin,
    params: { side: P.side, min_usd: P.minUsd, window_min: P.windowMin, cooldown_min: P.cooldownMin, limit: P.limit },
    period: res.period ? { from: iso(res.period.fromTs), to: iso(res.period.toTs), days: round((res.period.toTs - res.period.fromTs) / C.DAY_MS, 1) } : null,
    price_data: { source: C.SOURCE_NAME, first_candle: iso(res.prices.firstCandleTs), newest_candle_end: iso(res.prices.throughTs) },
    tape: C.TAPE_NAME,
    events_found: res.eventsFound, events_listed: listed.length, events_order: 'largest window_usd first',
    events: listed,
    horizons: Object.fromEntries(res.horizons.map((h) => [h.key, { events: stat(h.events), baseline: stat(h.baseline), events_left_out: reasons(h.skipped.events), baseline_left_out: reasons(h.skipped.baseline) }])),
    baseline: { times_requested: res.baseline.requested, times_drawn: res.baseline.drawn },
    method: methodBlock(P),
    ...(notes.length ? { notes } : {}),
  };
}

/** the handler; `deps` is for tests and the bench (see backtest.js). The real server calls it with none. */
async function run(args, _req, deps = {}) {
  const P = parseParams(args);
  const dir = deps.cacheDir || C.cacheDir();
  const hit = resolveSymbol(args && args.symbol, deps.supported || K.listSupported(dir));
  const res = await backtest({ symbol: hit.symbol, coin: hit.coin, sideMode: P.side, minUsd: P.minUsd, windowMin: P.windowMin, cooldownMin: P.cooldownMin }, { ...deps, cacheDir: dir });
  return present(res, P);
}

// ---- the route entry (the lead wires `entries` into expansion.js's EXP)
const DESC = `Use when an agent needs what price did after past liquidation cascades. Returns a symbol's events with ${horizonList('and')} forward returns, n, mean, median, hit rate, a bootstrap interval and a random-time baseline. Not charged on 400, 404 or 503.`;
const entries = [{
  name: 'get_cascade_backtest', route: 'GET /api/cascade-backtest', usd: 0.5,
  tags: ['liquidations', 'cascade', 'backtest', 'history', 'statistics', 'trading', 'exclusive'],
  desc: DESC,
  schema: {
    symbol: z.string().optional().describe('BTC, ETH, SOL or any symbol the backtest covers (default SOLUSDT); a symbol it does not cover answers 400 with the list that works'),
    side: z.enum(C.SIDES).optional().describe(`which liquidations count: long, short or both (default ${C.SIDE_DEFAULT})`),
    min_usd: z.number().min(C.MIN_USD.lo).max(C.MIN_USD.hi).optional().describe(`USD liquidated inside the window, ${fmtN(C.MIN_USD.lo)} to ${fmtN(C.MIN_USD.hi)}, default ${fmtN(C.MIN_USD.dflt)}`),
    window_min: z.number().int().min(C.WINDOW_MIN.lo).max(C.WINDOW_MIN.hi).optional().describe(`rolling window in minutes, ${C.WINDOW_MIN.lo} to ${C.WINDOW_MIN.hi}, default ${C.WINDOW_MIN.dflt}`),
    cooldown_min: z.number().int().min(C.COOLDOWN_MIN.lo).max(C.COOLDOWN_MIN.hi).optional().describe(`minutes without a qualifying window before the next event can start, ${C.COOLDOWN_MIN.lo} to ${fmtN(C.COOLDOWN_MIN.hi)}, default ${C.COOLDOWN_MIN.dflt}`),
    limit: z.number().int().min(C.LIMIT.lo).max(C.LIMIT.hi).optional().describe(`events listed, largest first, ${C.LIMIT.lo} to ${C.LIMIT.hi}, default ${C.LIMIT.dflt}; the statistics always use every event`),
  },
  title: 'Cascade backtest',
  question: 'What did the price of a perp do after past liquidation cascades of this size, compared with random times?',
  run: (args, req) => run(args, req),
}];

// the published example is CONSTRUCTED from the test fixtures (test/r23-cascade-backtest.test.js rebuilds it and fails if this file is stale)
try { entries[0].example = require('./example.json'); } catch { /* the example file is generated by the test; absent only in a partial checkout */ }

module.exports = { entries, run, parseParams, resolveSymbol, present, DESC };
