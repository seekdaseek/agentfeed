// tools/r23/cascade-backtest/events.js: cascade events from the liquidation tape, in one streaming pass.
//
// REUSED from get_cascade_history (tools/liqdb.js): the tape and its side convention ('Buy' = a LONG was liquidated, 'Sell' = a SHORT), the rule that an event needs at least
// 3 prints, the min_usd floor and default. ADDED: a rolling window (window_min) in place of the gap clustering, a cooldown that makes one cascade one event, and the entry time.
//
// DEFINITION. Prints of the chosen side(s) are grouped by identical timestamp. After each group, the window holds every print with ts in (t - window, t]. The window is HOT when it
// holds at least 3 prints and at least min_usd. An event STARTS at the first hot group after cooldown_min without a hot group (or at the first hot group of the scan); every later hot group
// before a cooldown_min gap belongs to the same event and only moves its end. So a cascade that keeps firing is one event, and the next event needs cooldown_min of quiet.
'use strict';
const C = require('./config');

class TooManyEvents extends Error {}

/**
 * @param {object} db better-sqlite3 handle on the tape (read-only)
 * @param {object} q { symbol, sideMode: 'long'|'short'|'both', fromTs, toTs, minUsd, windowMs, cooldownMs }  (events start at ts >= fromTs; the window is warmed with the windowMs before it)
 * @returns {{ events: Array, rows: number }}  events: { triggerTs, endTs, windowUsd, prints, longsUsd, shortsUsd }
 */
function scanEvents(db, { symbol, sideMode, fromTs, toTs, minUsd, windowMs, cooldownMs, maxEvents = C.MAX_EVENTS, maxRows = C.MAX_ROWS }) {
  const sideSql = sideMode === 'long' ? "AND side = 'Buy'" : sideMode === 'short' ? "AND side = 'Sell'" : '';
  const stmt = db.prepare(`SELECT ts, side, usd FROM liquidations WHERE symbol = ? AND ts >= ? AND ts <= ? ${sideSql} ORDER BY ts`).raw(true);
  const threshold = minUsd * (1 - C.HOT_TOLERANCE);

  // the window, one entry per timestamp group, in typed ring buffers (plain arrays of boxed doubles made V8 grow its heap by tens of MB over a scan); doubled when full
  let cap = 1024, wTs = new Float64Array(cap), wUsd = new Float64Array(cap), wLong = new Float64Array(cap), wCnt = new Int32Array(cap);
  let head = 0, size = 0;
  let sumUsd = 0, sumLong = 0, cnt = 0, sinceRefresh = 0;
  const events = [];
  let cur = null, lastHot = null, rows = 0;

  const grow = () => {
    const n = cap * 2, a = new Float64Array(n), b = new Float64Array(n), c = new Float64Array(n), d = new Int32Array(n);
    for (let i = 0; i < size; i++) { const k = (head + i) % cap; a[i] = wTs[k]; b[i] = wUsd[k]; c[i] = wLong[k]; d[i] = wCnt[k]; }
    wTs = a; wUsd = b; wLong = c; wCnt = d; head = 0; cap = n;
  };
  const exact = () => {
    let u = 0, l = 0, k = 0;
    for (let i = 0; i < size; i++) { const j = (head + i) % cap; u += wUsd[j]; l += wLong[j]; k += wCnt[j]; }
    sumUsd = u; sumLong = l; cnt = k; sinceRefresh = 0;
  };
  const step = (t, usd, longUsd, n) => {
    if (size === cap) grow();
    const k = (head + size) % cap;
    wTs[k] = t; wUsd[k] = usd; wLong[k] = longUsd; wCnt[k] = n; size++;
    sumUsd += usd; sumLong += longUsd; cnt += n;
    const lim = t - windowMs;                                  // (t - window, t]
    while (size && wTs[head] <= lim) { sumUsd -= wUsd[head]; sumLong -= wLong[head]; cnt -= wCnt[head]; head = (head + 1) % cap; size--; }
    if (!size) { sumUsd = 0; sumLong = 0; cnt = 0; sinceRefresh = 0; } else if (++sinceRefresh >= C.REFRESH_EVERY) exact();
    if (t < fromTs) return;                                    // warm-up only: no event starts before the period
    if (cnt >= C.MIN_PRINTS && sumUsd >= threshold) {
      if (lastHot === null || t - lastHot >= cooldownMs) {
        if (events.length >= maxEvents) throw new TooManyEvents(`more than ${maxEvents} events`);
        exact();
        cur = { triggerTs: t, endTs: t, windowUsd: sumUsd, prints: cnt, longsUsd: sumLong, shortsUsd: Math.max(0, sumUsd - sumLong) };
        events.push(cur);
      } else cur.endTs = t;
      lastHot = t;
    }
  };

  let gTs = null, gUsd = 0, gLong = 0, gN = 0;
  for (const r of stmt.iterate(symbol, fromTs - windowMs, toTs)) {
    if (++rows > maxRows) throw Object.assign(new Error('too many prints'), { tooManyRows: true });
    const ts = r[0], usd = r[2];
    if (gTs !== null && ts !== gTs) { step(gTs, gUsd, gLong, gN); gUsd = 0; gLong = 0; gN = 0; }
    gTs = ts; gUsd += usd; gN++;
    if (r[1] === 'Buy') gLong += usd;
  }
  if (gTs !== null) step(gTs, gUsd, gLong, gN);
  return { events, rows };
}

module.exports = { scanEvents, TooManyEvents };
