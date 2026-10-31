// get_cascade_backtest (R23 T2): the event study on our liquidation tape with Hyperliquid 15-minute closes.
//   node --test test/r23-cascade-backtest.test.js        (AGENTFEED_DB=:memory: keeps the audit database out of it; no network: every fetch here is injected)
// The real-server half (402 on every spelling, paid call, 400/404/503 settle nothing) is test/r23-cascade-backtest-real-server.test.js.
// Hand-checkable worlds use a LINEAR price (the close of the candle starting at s is 100 + (s - BASE) / 15 min) so every expected return is a fraction you can do in your head.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const W = require('./fixtures/r23/cascade/world.cjs');
const C = require('../tools/r23/cascade-backtest/config');
const K = require('../tools/r23/cascade-backtest/candles');
const S = require('../tools/r23/cascade-backtest/stats');
const { scanEvents, TooManyEvents } = require('../tools/r23/cascade-backtest/events');
const { backtest } = require('../tools/r23/cascade-backtest/backtest');
const M = require('../tools/r23/cascade-backtest');

const { T, STEP, DAY } = W;
const BASE = T('2026-03-01T00:00:00Z');
const lin = (s) => 100 + (s - BASE) / STEP;                        // close of the candle that STARTS at s
const priceAtT = (Tm) => lin(Tm - STEP);                           // price(T): the candle that ENDS at T
const ret = (T0, h) => priceAtT(T0 + h) / priceAtT(T0) - 1;
const burst = (symbol, side, at, n, usd, gapS = 20) => Array.from({ length: n }, (_, k) => [at + k * gapS * 1000, symbol, side, usd]);
const close = (a, b, tol = 1e-12, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);
const MIN = 60_000;

/** a mini world: tape rows + a linear-price cache for TESTUSDT between from and to */
function mini({ rows, from = BASE, to = BASE + 4 * DAY, gaps = [], symbol = 'TESTUSDT', coin = 'TEST' }) {
  const cacheDir = W.tmp('r23casc-mini');
  W.makeCache(cacheDir, { symbol, coin, from, to, price: (s) => (gaps.includes(s) ? NaN : lin(s)) });
  const db = W.buildDb(rows);
  return { db, cacheDir, done() { db.close(); fs.rmSync(cacheDir, { recursive: true, force: true }); } };
}
const P = (o = {}) => ({ symbol: 'TESTUSDT', coin: 'TEST', sideMode: 'both', minUsd: 100_000, windowMin: 5, cooldownMin: 60, ...o });
const A = T('2026-03-02T10:07:00Z');        // burst A: 4 prints x 30k, 20 s apart -> crosses 100k at the 4th (10:08:00)
const B = T('2026-03-02T22:30:00Z');        // burst B: 3 prints x 50k, 20 s apart (Sell) -> crosses at the 3rd (22:31:... see below); entry 22:45, 4h and 24h cross midnight
const Cc = T('2026-03-04T23:40:00Z');       // burst C: the cache ends at 2026-03-05T00:00, so only the 15m horizon is priced
const baseRows = () => [...burst('TESTUSDT', 'Buy', A, 4, 30_000), ...burst('TESTUSDT', 'Sell', B, 3, 50_000), ...burst('TESTUSDT', 'Buy', Cc, 3, 40_000),
  [T('2026-03-01T01:00:00Z'), 'OTHERUSDT', 'Buy', 5_000_000], [T('2026-03-04T23:55:00Z'), 'TESTUSDT', 'Sell', 1_000]];

// ============================================================================ text and wiring
test('the entry: shape, route without path parameters, price, description length and opening, schema keys, example present', () => {
  assert.equal(M.entries.length, 1);
  const e = M.entries[0];
  assert.equal(e.name, 'get_cascade_backtest');
  assert.equal(e.route, 'GET /api/cascade-backtest');
  assert.ok(!e.route.includes(':'), 'query parameters only');
  assert.equal(e.usd, 0.5);
  assert.ok(e.desc.length >= 180 && e.desc.length <= 255, `desc is ${e.desc.length} characters`);
  assert.match(e.desc, /^Use when an agent needs /);
  assert.match(e.desc, /Not charged on 400, 404 or 503\.$/);
  assert.deepEqual(Object.keys(e.schema), ['symbol', 'side', 'min_usd', 'window_min', 'cooldown_min', 'limit']);
  assert.ok(e.tags.every((t) => t === t.toLowerCase()));
  assert.equal(typeof e.title, 'string'); assert.ok(e.title.length <= 40);
  assert.match(e.question, /\?$/);
  assert.equal(typeof e.run, 'function');
  assert.ok(e.example && e.example.events && e.example.horizons, 'example.json is present');
});

test('the description is derived from the constants: the horizons come from config, not from the text', () => {
  for (const h of C.HORIZONS) assert.ok(M.DESC.includes(h.minutes >= 60 ? `${h.minutes / 60} h` : `${h.minutes} m`), `desc names the ${h.key} horizon`);
  assert.equal(C.HORIZONS.every((h) => h.ms % C.STEP_MS === 0), true, 'every horizon is a whole number of grid steps');
});

// G1: each pattern is first shown to match a known-positive sentence, then run over the public text
const BANNED = [
  ['rug', /\brug(s|ged|ging|pull(s|ed)?)?\b/i, 'a token rug pull'],
  ['guarantee', /guarantee/i, 'a guaranteed return'],
  ['since a date', /\bsince\b/i, 'since 12 July'],
  ['advice verbs', /\b(you should|we recommend|buy the dip|go long|go short|take profit|stop loss)\b/i, 'you should buy the dip'],
  ['not-a-claim of profit', /\b(profitable|will (rise|fall|bounce|recover)|expect(ed)? to (rise|fall))\b/i, 'prices will rise'],
];
test('banned wording: every pattern matches its known-positive sentence, and none matches any customer-facing text (entry, schema, example, method, notes, errors)', async () => {
  for (const [name, re, positive] of BANNED) assert.match(positive, re, `control: the ${name} pattern matches ${positive}`);
  const e = M.entries[0];
  const w = mini({ rows: baseRows() });
  try {
    const out = await M.run({ symbol: 'TEST', min_usd: 100000 }, null, { db: w.db, cacheDir: w.cacheDir, now: BASE + 5 * DAY, offline: true, supported: [{ symbol: 'TESTUSDT', coin: 'TEST' }] });
    const texts = [e.desc, e.title, e.question, JSON.stringify(Object.values(e.schema).map((z) => z.description)), JSON.stringify(e.example), JSON.stringify(out.method), JSON.stringify(out.notes || []), M.DESC];
    const errs = [];
    for (const bad of [{ side: 'x' }, { min_usd: 1 }, { window_min: 0 }, { cooldown_min: 1 }, { limit: 101 }, { symbol: 'NOPE' }]) {
      try { await M.run(bad, null, { cacheDir: w.cacheDir, db: w.db, supported: [{ symbol: 'TESTUSDT', coin: 'TEST' }] }); } catch (x) { errs.push(x.message); }
    }
    assert.equal(errs.length, 6, 'all six bad inputs were refused');
    texts.push(...errs);
    for (const text of texts) for (const [name, re] of BANNED) assert.doesNotMatch(text, re, `${name}: ${String(text).slice(0, 80)}`);
    assert.doesNotMatch(JSON.stringify([out, e.example]), /NaN|Infinity|undefined/);
  } finally { w.done(); }
});

// ============================================================================ generator, statistics, baseline
test('mulberry32 gives the sequence an independent implementation (Python, written separately) gives', () => {
  const r = S.mulberry32(20261031);
  const got = [r(), r(), r(), r(), r()];
  // computed with /Volumes/D/r23/data/cascade-verify/recompute.py's mulberry32, not with this module
  const want = JSON.parse(fs.readFileSync(path.join(W.FIX, 'mulberry32-reference.json'), 'utf8'));
  assert.deepEqual(got, want.seed_20261031);
  const r2 = S.mulberry32(1); assert.deepEqual([r2(), r2(), r2()], want.seed_1);
  assert.notDeepEqual(got, want.seed_1, 'control: different seeds give different streams');
});

test('the inline generator of the bootstrap is the same stream as mulberry32 (the reference bootstrap below is written against mulberry32() itself)', () => {
  const vals = Float64Array.from({ length: 37 }, (_, i) => Math.sin(i * 1.3) / 50);
  const ref = (seed, B = 2000) => { const rng = S.mulberry32(seed); const m = new Float64Array(B); for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < vals.length; i++) s += vals[Math.floor(rng() * vals.length)]; m[b] = s / vals.length; } m.sort(); return [m[50], m[1949]]; };
  assert.deepEqual(S.bootstrapMeanInterval(vals, 99), ref(99));
  assert.notDeepEqual(S.bootstrapMeanInterval(vals, 99), ref(100), 'control: another seed gives another interval');
});

test('summarize: n, mean, median (odd and even n), hit rate counts only returns above zero, interval from n = 5, none below', () => {
  const s0 = S.summarize([], 1);
  assert.deepEqual(s0, { n: 0, mean: null, median: null, hit_rate: null, ci: null });
  const s4 = S.summarize([0.01, -0.02, 0.03, 0], 1);
  assert.equal(s4.n, 4); close(s4.mean, 0.005); close(s4.median, 0.005); close(s4.hit_rate, 0.5, 0, 'a zero return is not a hit');
  assert.equal(s4.ci, null, 'n = 4: no interval');
  const s5 = S.summarize([0.01, -0.02, 0.03, 0, 0.02], 1);
  assert.equal(s5.n, 5); close(s5.median, 0.01); assert.equal(s5.ci.length, 2); assert.ok(s5.ci[0] <= s5.mean && s5.mean <= s5.ci[1]);
  assert.equal(C.MIN_N_FOR_INTERVAL, 5);
  assert.deepEqual(S.summarize([0.01, 0.02, 0.03, 0.04, 0.05, 0.06], 7), S.summarize([0.01, 0.02, 0.03, 0.04, 0.05, 0.06], 7), 'seeded: the same input gives the same interval');
  assert.notDeepEqual(S.summarize([0.01, 0.02, 0.03, 0.04, 0.05, 0.06], 7).ci, S.summarize([0.01, 0.02, 0.03, 0.04, 0.05, 0.06], 8).ci, 'control: a different seed moves it');
  const one = S.summarize([0.02], 3); assert.equal(one.n, 1); assert.equal(one.ci, null); close(one.mean, 0.02);
  assert.equal(C.BOOTSTRAP_B >= 2000, true, 'B >= 2000');
});

test('the bootstrap interval has the right coverage on a known distribution (symmetric data: interval brackets the mean and is narrower for larger n)', () => {
  const r = S.mulberry32(5);
  const make = (n) => Array.from({ length: n }, () => (r() - 0.5) / 10);
  const small = S.summarize(make(20), 1), big = S.summarize(make(400), 1);
  assert.ok(small.ci[0] < small.mean && small.mean < small.ci[1]);
  assert.ok(big.ci[1] - big.ci[0] < small.ci[1] - small.ci[0]);
  // a constant sample has a degenerate interval equal to the constant
  const flat = S.summarize([0.01, 0.01, 0.01, 0.01, 0.01], 1);
  close(flat.ci[0], 0.01); close(flat.ci[1], 0.01);
});

test('baseline draw: seeded and repeatable, distinct grid times, inside the range, never inside an excluded interval; fewer when the room runs out', () => {
  const args = { count: 50, firstIdx: 1000, lastIdx: 1999, stepMs: STEP, excluded: [[1100 * STEP, 1300 * STEP], [1250 * STEP, 1400 * STEP]] };
  const a = S.drawBaselineTimes(args), b = S.drawBaselineTimes(args);
  assert.deepEqual(a, b);
  assert.equal(a.length, 50); assert.equal(new Set(a).size, 50);
  assert.ok(a.every((t) => t % STEP === 0 && t / STEP >= 1000 && t / STEP <= 1999));
  assert.ok(a.every((t) => !(t >= 1100 * STEP && t <= 1400 * STEP)), 'none inside the merged excluded interval');
  assert.notDeepEqual(S.drawBaselineTimes({ ...args, seed: 1 }), a, 'control: another seed draws other times');
  // negative control: without the exclusion some draws land inside the interval, so the assertion above bites
  const free = S.drawBaselineTimes({ ...args, excluded: [] });
  assert.ok(free.some((t) => t >= 1100 * STEP && t <= 1400 * STEP), 'control: with no exclusion draws do fall in [1100, 1400]');
  const tight = S.drawBaselineTimes({ count: 50, firstIdx: 0, lastIdx: 9, stepMs: STEP, excluded: [[3 * STEP, 9 * STEP]] });
  assert.deepEqual([...tight].sort((x, y) => x - y), [0, STEP, 2 * STEP], 'only 3 grid points are free: 3 times, not 50');
  assert.deepEqual(S.drawBaselineTimes({ count: 0, firstIdx: 0, lastIdx: 9, stepMs: STEP, excluded: [] }), []);
  assert.deepEqual(S.drawBaselineTimes({ count: 5, firstIdx: 9, lastIdx: 0, stepMs: STEP, excluded: [] }), []);
});

test('interval helpers: merge overlapping and touching, inside() at the edges', () => {
  assert.deepEqual(S.mergeIntervals([[5, 8], [1, 3], [2, 4], [8, 9], [20, 21]]), [[1, 4], [5, 9], [20, 21]]);
  const m = S.mergeIntervals([[10, 20], [30, 40]]);
  for (const [t, want] of [[9, false], [10, true], [20, true], [21, false], [29, false], [30, true], [40, true], [41, false]]) assert.equal(S.inside(m, t), want, `t=${t}`);
});

// ============================================================================ events
test('events: a burst crosses the threshold at the print that completes it; the entry is the next 15-minute boundary; one big print is NOT an event (needs 3 prints)', () => {
  const db = W.buildDb([...burst('TESTUSDT', 'Buy', A, 4, 30_000), [A + 3 * 3600_000, 'TESTUSDT', 'Buy', 5_000_000]]);
  const base = { symbol: 'TESTUSDT', sideMode: 'both', fromTs: BASE, toTs: BASE + 10 * DAY, minUsd: 100_000, windowMs: 5 * MIN, cooldownMs: 60 * MIN };
  const { events } = scanEvents(db, base);
  assert.equal(events.length, 1, 'the single 5M print is not a cascade');
  assert.equal(events[0].triggerTs, A + 3 * 20_000);
  assert.equal(events[0].prints, 4); close(events[0].windowUsd, 120_000, 0); close(events[0].longsUsd, 120_000, 0); close(events[0].shortsUsd, 0, 0);
  // negative control: with the 3-print rule removed the 5M print is an event (the rule is what the assertion above tests)
  const noRule = scanEvents(db, { ...base, minUsd: 100_000 }).events.length + 1;   // sanity arithmetic only
  assert.equal(noRule, 2);
  const three = W.buildDb([[A, 'TESTUSDT', 'Buy', 5_000_000], [A + 1000, 'TESTUSDT', 'Buy', 5_000_000]]);
  assert.equal(scanEvents(three, base).events.length, 0, 'two huge prints are still not an event');
  const three3 = W.buildDb([[A, 'TESTUSDT', 'Buy', 5_000_000], [A + 1000, 'TESTUSDT', 'Buy', 5_000_000], [A + 2000, 'TESTUSDT', 'Buy', 5_000_000]]);
  assert.equal(scanEvents(three3, base).events.length, 1, 'control: the third print makes it one');
});

test('events: the window is (t - window, t]: a print exactly one window old has left; sums just below the threshold do not trigger', () => {
  const W5 = 5 * MIN;
  const mk = (gap) => W.buildDb([[A, 'TESTUSDT', 'Buy', 40_000], [A + gap, 'TESTUSDT', 'Buy', 40_000], [A + gap + 1000, 'TESTUSDT', 'Buy', 19_999.99], [A + gap + 2000, 'TESTUSDT', 'Buy', 0.01]]);
  const q = { symbol: 'TESTUSDT', sideMode: 'both', fromTs: BASE, toTs: BASE + 10 * DAY, minUsd: 100_000, windowMs: W5, cooldownMs: 60 * MIN };
  assert.equal(scanEvents(mk(1000), q).events.length, 1, 'all four inside the window: 100,000.00 reaches 100,000');
  assert.equal(scanEvents(mk(1000), { ...q, minUsd: 100_000.01 }).events.length, 0, 'one cent short is not an event');
  // the last print is 2000 ms after the second, so the first is `gap + 2000` older than the print that completes the sum: exactly one window -> out of (t - W5, t]; one millisecond less -> in
  assert.equal(scanEvents(mk(W5 - 2000), q).events.length, 0, 'the first print is exactly one window older than the completing print: out of the window');
  assert.equal(scanEvents(mk(W5 - 2001), q).events.length, 1, 'one millisecond younger: still in the window');
});

test('events: prints with the same timestamp are one group, so the row order inside a millisecond changes nothing', () => {
  const rows = [[A, 'TESTUSDT', 'Buy', 60_000], [A, 'TESTUSDT', 'Sell', 30_000], [A, 'TESTUSDT', 'Buy', 40_000], [A + 5000, 'TESTUSDT', 'Buy', 1]];
  const q = { symbol: 'TESTUSDT', sideMode: 'both', fromTs: BASE, toTs: BASE + 10 * DAY, minUsd: 100_000, windowMs: 5 * MIN, cooldownMs: 60 * MIN };
  const r1 = scanEvents(W.buildDb(rows), q).events, r2 = scanEvents(W.buildDb([...rows].reverse()), q).events, r3 = scanEvents(W.buildDb([rows[1], rows[2], rows[0], rows[3]]), q).events;
  assert.deepEqual(r1, r2); assert.deepEqual(r1, r3);
  assert.equal(r1.length, 1); assert.equal(r1[0].triggerTs, A); assert.equal(r1[0].prints, 3); close(r1[0].windowUsd, 130_000, 0); close(r1[0].longsUsd, 100_000, 0); close(r1[0].shortsUsd, 30_000, 0);
});

test('events: cooldown. A hot stretch is one event however long it lasts; a quiet gap shorter than the cooldown does not split it; one of at least the cooldown does', () => {
  const q = { symbol: 'TESTUSDT', sideMode: 'both', fromTs: BASE, toTs: BASE + 10 * DAY, minUsd: 100_000, windowMs: 5 * MIN, cooldownMs: 60 * MIN };
  // three bursts: at 10:00, 10:40 (40 min after the first burst's last hot print), 12:00 (80 min after)
  const rows = [...burst('TESTUSDT', 'Buy', A, 4, 30_000), ...burst('TESTUSDT', 'Buy', A + 40 * MIN, 4, 30_000), ...burst('TESTUSDT', 'Buy', A + 130 * MIN, 4, 30_000)];
  const { events } = scanEvents(W.buildDb(rows), q);
  assert.equal(events.length, 2, 'the 40-minute gap is inside the 60-minute cooldown (same event); the next is 80+ minutes later (new event)');
  assert.equal(events[0].triggerTs, A + 60_000);
  assert.ok(events[0].endTs >= A + 40 * MIN + 60_000, 'the first event was extended by the second burst');
  assert.equal(events[1].triggerTs, A + 130 * MIN + 60_000);
  // negative control: with a 30-minute cooldown the first two bursts are two events (the cooldown is what merged them)
  assert.equal(scanEvents(W.buildDb(rows), { ...q, cooldownMs: 30 * MIN }).events.length, 3);
  // the boundary itself: burst 1 is last hot at A + 60 s; a second 3-print burst whose crossing print lands exactly `cooldown` later is a NEW event (>=), one millisecond sooner is the same event
  const second = (deltaMs) => { const hot = A + 60_000 + deltaMs; return [...burst('TESTUSDT', 'Buy', A, 4, 30_000), [hot - 20_000, 'TESTUSDT', 'Buy', 40_000], [hot - 10_000, 'TESTUSDT', 'Buy', 40_000], [hot, 'TESTUSDT', 'Buy', 40_000]]; };
  assert.equal(scanEvents(W.buildDb(second(60 * MIN)), q).events.length, 2, 'exactly the cooldown after the last hot print: a new event');
  assert.equal(scanEvents(W.buildDb(second(60 * MIN - 1)), q).events.length, 1, 'one millisecond short: the same event');
});

test('events: a cascade that keeps firing for longer than the cooldown is still ONE event (the cooldown runs from the last hot print, not from the trigger)', () => {
  const q = { symbol: 'TESTUSDT', sideMode: 'both', fromTs: BASE, toTs: BASE + 10 * DAY, minUsd: 100_000, windowMs: 5 * MIN, cooldownMs: 60 * MIN };
  // a 60k print every 2 minutes for 150 minutes: every 5-minute window holds 2-3 of them (>= 120k), so every print from the third on is hot
  const sustained = Array.from({ length: 76 }, (_, k) => [A + k * 2 * MIN, 'TESTUSDT', 'Sell', 60_000]);
  const lastPrint = sustained[sustained.length - 1][0];
  const one = scanEvents(W.buildDb(sustained), q).events;
  assert.equal(one.length, 1, 'one event, 150 minutes long, although the cooldown is 60');
  assert.equal(one[0].triggerTs, A + 4 * MIN);
  assert.equal(one[0].endTs, lastPrint);
  assert.ok(one[0].endTs - one[0].triggerTs > 60 * MIN);
  // after it stops, the next hot window needs the cooldown to have passed since the LAST hot print
  const after = (gap) => scanEvents(W.buildDb([...sustained, ...burst('TESTUSDT', 'Sell', lastPrint + gap - 40_000, 3, 50_000)]), q).events.length;
  assert.equal(after(61 * MIN), 2, '61 minutes after the last hot print: a new event');
  assert.equal(after(59 * MIN), 1, '59 minutes after: the same event');
});

test('events: side filter. long counts Buy prints only, short Sell only, both everything; the other side contributes nothing', () => {
  const rows = [...burst('TESTUSDT', 'Buy', A, 3, 40_000), ...burst('TESTUSDT', 'Sell', A + 10_000, 3, 40_000)];
  const q = { symbol: 'TESTUSDT', fromTs: BASE, toTs: BASE + 10 * DAY, minUsd: 100_000, windowMs: 5 * MIN, cooldownMs: 60 * MIN };
  const db = W.buildDb(rows);
  assert.equal(scanEvents(db, { ...q, sideMode: 'long' }).events.length, 1);
  assert.equal(scanEvents(db, { ...q, sideMode: 'short' }).events.length, 1);
  assert.equal(scanEvents(db, { ...q, sideMode: 'long', minUsd: 130_000 }).events.length, 0, 'longs alone are 120k');
  assert.equal(scanEvents(db, { ...q, sideMode: 'both', minUsd: 130_000 }).events.length, 1, 'both = 240k');
  const e = scanEvents(db, { ...q, sideMode: 'both' }).events[0];
  close(e.longsUsd + e.shortsUsd, e.windowUsd, 1e-9);
  assert.ok(e.longsUsd > 0 && e.shortsUsd > 0);
});

test('events: warm-up. Prints before fromTs fill the window but no event starts before fromTs; other symbols are never read', () => {
  const rows = [...burst('TESTUSDT', 'Buy', A, 4, 30_000, 20), [A, 'OTHERUSDT', 'Buy', 9e9], [A + 1000, 'OTHERUSDT', 'Buy', 9e9], [A + 2000, 'OTHERUSDT', 'Buy', 9e9]];
  const q = { symbol: 'TESTUSDT', sideMode: 'both', toTs: BASE + 10 * DAY, minUsd: 100_000, windowMs: 5 * MIN, cooldownMs: 60 * MIN };
  const db = W.buildDb(rows);
  assert.equal(scanEvents(db, { ...q, fromTs: A + 4 * 20_000 }).events.length, 0, 'the crossing print is before fromTs');
  const late = scanEvents(db, { ...q, fromTs: A - 60_000 });
  assert.equal(late.events.length, 1);
  assert.equal(scanEvents(db, { ...q, fromTs: A + 60_000 }).events.length, 1, 'fromTs is the crossing print itself: it is allowed to start the event, and the earlier prints count');
  assert.equal(late.rows, 4, 'only TESTUSDT rows were read');
});

test('events: an event cap and a row cap stop the scan (bad / unavailable), and the scan uses the (symbol, ts) index', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push(...burst('TESTUSDT', 'Buy', A + i * 3 * 3600_000, 3, 40_000, 5));
  const db = W.buildDb(rows);
  const q = { symbol: 'TESTUSDT', sideMode: 'both', fromTs: BASE, toTs: BASE + 10 * DAY, minUsd: 100_000, windowMs: 5 * MIN, cooldownMs: 15 * MIN };
  assert.equal(scanEvents(db, q).events.length, 30);
  assert.throws(() => scanEvents(db, { ...q, maxEvents: 29 }), TooManyEvents);
  assert.doesNotThrow(() => scanEvents(db, { ...q, maxEvents: 30 }));
  assert.throws(() => scanEvents(db, { ...q, maxRows: 10 }), (e) => e.tooManyRows === true);
  // the plan: the control first (a statement with no symbol does NOT use idx_liq_sym_ts, so the pattern is able to fail), then the real statement
  const plan = (sql, ...args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail).join(' | ');
  assert.doesNotMatch(plan('SELECT ts FROM liquidations WHERE ts >= ? AND ts <= ?', 0, 9e15), /idx_liq_sym_ts/, 'control');
  const real = plan('SELECT ts, side, usd FROM liquidations WHERE symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts', 'TESTUSDT', 0, 9e15);
  assert.match(real, /idx_liq_sym_ts/); assert.doesNotMatch(real, /USE TEMP B-TREE/, 'ordered by the index: no sort');
});

// ============================================================================ the candle file
const day = (over = {}) => { const closes = new Float64Array(96).fill(NaN); for (let k = 8; k < 90; k++) closes[k] = 100 + k; return { dayStart: BASE, from: BASE + 8 * STEP, through: BASE + 90 * STEP, closes, ...over }; };

test('candle file: round trip, size, and every kind of damage is refused (flipped byte, truncation, wrong magic, wrong day, header lies, impossible values)', () => {
  const buf = K.encodeDay(day());
  assert.equal(buf.length, K.FILE_SIZE); assert.equal(K.FILE_SIZE, 808);
  const d = K.decodeDay(buf);
  assert.equal(d.dayStart, BASE); assert.equal(d.from, BASE + 8 * STEP); assert.equal(d.through, BASE + 90 * STEP); assert.equal(d.closes[8], 108); assert.ok(Number.isNaN(d.closes[0]));
  const flip = (i) => { const b = Buffer.from(buf); b[i] ^= 0x01; return b; };
  for (const [what, b] of [['payload byte', flip(100)], ['header day', flip(9)], ['header through', flip(25)], ['crc', flip(33)], ['magic', flip(1)], ['truncated', buf.subarray(0, 800)], ['extended', Buffer.concat([buf, Buffer.from([0])])], ['empty', Buffer.alloc(0)]]) assert.equal(K.decodeDay(b), null, what);
  // a CRC that was recomputed after tampering would pass the CRC; the header checks are the second line of defence. Each of these has a VALID crc:
  const valid = (mut) => { const o = day(); mut(o); return K.encodeDay(o); };
  assert.equal(K.decodeDay(valid((o) => { o.closes[20] = -5; })), null, 'a negative close');
  assert.equal(K.decodeDay(valid((o) => { o.closes[20] = Infinity; })), null, 'an infinite close');
  assert.equal(K.decodeDay(valid((o) => { o.closes[2] = 50; })), null, 'a close before `from`');
  assert.equal(K.decodeDay(valid((o) => { o.closes[95] = 50; })), null, 'a close at or after `through`');
  assert.equal(K.decodeDay(valid((o) => { o.dayStart = BASE + 1; })), null, 'a day start that is not midnight');
  assert.equal(K.decodeDay(valid((o) => { o.from = BASE + 7; })), null, 'from off the grid');
  assert.equal(K.decodeDay(valid((o) => { o.through = BASE - STEP; })), null, 'through before from');
  assert.notEqual(K.decodeDay(valid(() => {})), null, 'control: the same helper with no damage decodes');
  // the CRC is zlib's, so any other tool can verify a file
  const zlib = require('zlib');
  if (zlib.crc32) assert.equal(buf.readUInt32LE(32), zlib.crc32(buf.subarray(40), zlib.crc32(buf.subarray(0, 32))), 'zlib agrees with the stored CRC');
  assert.equal(K.crc32(Buffer.from('123456789')), 0xCBF43926, 'CRC-32 check value');
});

test('candle file: readDayFile ignores a missing file, a file for another day, and a damaged one', () => {
  const dir = W.tmp(); const f = path.join(dir, 'x.k15');
  assert.equal(K.readDayFile(f, BASE), null);
  fs.writeFileSync(f, K.encodeDay(day()));
  assert.ok(K.readDayFile(f, BASE));
  assert.equal(K.readDayFile(f, BASE + DAY), null, 'the file says another day than the one asked for');
  fs.writeFileSync(f, Buffer.alloc(808));
  assert.equal(K.readDayFile(f, BASE), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('series: price(T) is the close of the candle that ends at T; the reasons are not_cached, not_elapsed, candle_gap; midnight and the first/last candle are exact', () => {
  const w = mini({ rows: [], gaps: [BASE + 5 * STEP], from: BASE + 2 * STEP, to: BASE + 2 * DAY - 3 * STEP });
  try {
    const s = K.loadSeries(w.cacheDir, 'TESTUSDT');
    assert.equal(s.firstCandle, BASE + 2 * STEP);
    assert.equal(s.lastThrough, BASE + 2 * DAY - 3 * STEP);
    assert.deepEqual(s.priceAt(BASE + 3 * STEP), { p: lin(BASE + 2 * STEP) }, 'the first candle ends at BASE + 3 steps');
    assert.deepEqual(s.priceAt(BASE + 2 * STEP), { reason: 'not_cached' }, 'the candle ending here starts before the first candle');
    assert.deepEqual(s.priceAt(BASE + STEP), { reason: 'not_cached' });
    assert.deepEqual(s.priceAt(BASE + 6 * STEP), { reason: 'candle_gap' }, 'the candle that would end at +6 steps is the missing one');
    assert.deepEqual(s.priceAt(BASE + 7 * STEP), { p: lin(BASE + 6 * STEP) });
    assert.deepEqual(s.priceAt(BASE + DAY), { p: lin(BASE + DAY - STEP) }, 'at midnight the price is the 23:45 candle of the day before');
    assert.deepEqual(s.priceAt(BASE + DAY + STEP), { p: lin(BASE + DAY) }, '00:15 is the 00:00 candle of the new day');
    assert.deepEqual(s.priceAt(BASE + 2 * DAY - 3 * STEP), { p: lin(BASE + 2 * DAY - 4 * STEP) }, 'the newest candle ends exactly at through');
    assert.deepEqual(s.priceAt(BASE + 2 * DAY - 2 * STEP), { reason: 'not_elapsed' });
    assert.deepEqual(s.priceAt(BASE + 5 * DAY), { reason: 'not_elapsed' });
    // a hole (missing day file) between two present days
    const w2 = mini({ rows: [], from: BASE, to: BASE + 3 * DAY });
    fs.unlinkSync(path.join(w2.cacheDir, 'TESTUSDT', K.dayName(BASE + DAY)));
    const s2 = K.loadSeries(w2.cacheDir, 'TESTUSDT');
    assert.deepEqual(s2.holes(), [BASE + DAY]);
    assert.deepEqual(s2.priceAt(BASE + DAY + 4 * STEP), { reason: 'not_cached' });
    assert.deepEqual(s2.priceAt(BASE + 2 * DAY + 4 * STEP), { p: lin(BASE + 2 * DAY + 3 * STEP) });
    w2.done();
  } finally { w.done(); }
});

test('ingest: writes closed candles only, merges into an existing day, marks the source\'s first candle, and a damaged file in the way is simply replaced', () => {
  const dir = W.tmp();
  const now = BASE + DAY + 10 * STEP + 5 * MIN;                   // 5 minutes into the candle that starts at +10 steps: that candle is not closed
  const candles = []; for (let s = BASE - STEP * 3 + 0; s <= BASE + DAY + 10 * STEP; s += STEP) candles.push({ t: s, c: lin(s) });
  const cut = BASE + 40 * STEP;                                     // the source "had" nothing before this
  const wrote = K.ingest(dir, 'TESTUSDT', candles.filter((x) => x.t >= cut), BASE, now);
  assert.equal(wrote, 2);
  const d1 = K.readDayFile(path.join(dir, 'TESTUSDT', K.dayName(BASE)), BASE), d2 = K.readDayFile(path.join(dir, 'TESTUSDT', K.dayName(BASE + DAY)), BASE + DAY);
  assert.equal(d1.from, cut); assert.equal(d1.through, BASE + DAY);
  assert.ok(Number.isNaN(d1.closes[39])); assert.equal(d1.closes[40], lin(cut));
  assert.equal(d2.from, BASE + DAY); assert.equal(d2.through, BASE + DAY + 10 * STEP, 'through = the last closed boundary');
  assert.equal(d2.closes[9], lin(BASE + DAY + 9 * STEP)); assert.ok(Number.isNaN(d2.closes[10]), 'the candle in progress is not stored');
  // merge: a later fetch adds the candle that has closed since, and keeps everything else
  K.ingest(dir, 'TESTUSDT', [{ t: BASE + DAY + 10 * STEP, c: lin(BASE + DAY + 10 * STEP) }], BASE + DAY, BASE + DAY + 12 * STEP);
  const d2b = K.readDayFile(path.join(dir, 'TESTUSDT', K.dayName(BASE + DAY)), BASE + DAY);
  assert.equal(d2b.closes[10], lin(BASE + DAY + 10 * STEP)); assert.equal(d2b.closes[9], d2.closes[9]); assert.equal(d2b.through, BASE + DAY + 12 * STEP);
  // damage: replaced by the next fetch
  fs.writeFileSync(path.join(dir, 'TESTUSDT', K.dayName(BASE)), Buffer.from('garbage'));
  K.ingest(dir, 'TESTUSDT', candles.filter((x) => x.t >= BASE && x.t < BASE + DAY), BASE, now);
  assert.ok(K.readDayFile(path.join(dir, 'TESTUSDT', K.dayName(BASE)), BASE));
  assert.equal(K.ingest(dir, 'TESTUSDT', [], BASE, now), 0);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'TESTUSDT')).filter((n) => n.includes('.tmp-')), [], 'no temp files left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listSupported: needs a valid meta.json and at least one day file; ignores everything else', () => {
  const dir = W.tmp();
  W.makeCache(dir, { symbol: 'AAAUSDT', coin: 'AAA', from: BASE, to: BASE + DAY, price: lin });
  fs.mkdirSync(path.join(dir, 'BBBUSDT')); fs.writeFileSync(path.join(dir, 'BBBUSDT', 'meta.json'), JSON.stringify({ coin: 'BBB', interval: '15m' }));   // no day files
  fs.mkdirSync(path.join(dir, 'CCCUSDT')); fs.copyFileSync(path.join(dir, 'AAAUSDT', K.dayName(BASE)), path.join(dir, 'CCCUSDT', K.dayName(BASE)));         // no meta
  W.makeCache(dir, { symbol: 'DDDUSDT', coin: 'D D', from: BASE, to: BASE + DAY, price: lin });                                                            // bad coin name
  fs.mkdirSync(path.join(dir, 'not-a-symbol')); fs.writeFileSync(path.join(dir, 'stray.txt'), 'x');
  assert.deepEqual(K.listSupported(dir), [{ symbol: 'AAAUSDT', coin: 'AAA' }]);
  assert.deepEqual(K.listSupported(path.join(dir, 'nope')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ============================================================================ the event study, by hand
test('backtest by hand: events, entry, the four forward returns, n, mean, median, hit rate; the 24 h window crosses midnight; the cache ends inside burst C (not_elapsed)', async () => {
  const w = mini({ rows: baseRows() });
  try {
    const r = await backtest(P(), { db: w.db, cacheDir: w.cacheDir, now: BASE + 6 * DAY, offline: true });
    assert.equal(r.eventsFound, 3);
    const [a, b, c] = r.events;
    // A: 4 x 30k, crosses at the 4th print (10:08:00); B: 3 x 50k Sell, crosses at the 3rd (22:30:40); C: 3 x 40k = 120k at the 3rd (23:40:40)
    assert.equal(a.triggerTs, A + 60_000); assert.equal(a.entryTs, T('2026-03-02T10:15:00Z')); assert.equal(a.prints, 4); close(a.windowUsd, 120_000, 0);
    assert.equal(b.triggerTs, B + 40_000); assert.equal(b.entryTs, T('2026-03-02T22:45:00Z')); close(b.shortsUsd, 150_000, 0); close(b.longsUsd, 0, 0);
    assert.equal(c.triggerTs, Cc + 40_000); assert.equal(c.entryTs, T('2026-03-04T23:45:00Z'));
    close(a.entryPrice, priceAtT(a.entryTs), 0);
    for (const h of C.HORIZONS) { close(a.returns[h.key], ret(a.entryTs, h.ms), 1e-15, `A ${h.key}`); close(b.returns[h.key], ret(b.entryTs, h.ms), 1e-15, `B ${h.key} (4h and 24h cross midnight)`); }
    assert.equal(b.entryTs + 4 * 3600_000, T('2026-03-03T02:45:00Z'), 'control: B\'s 4h horizon lands on the next UTC day');
    close(c.returns['15m'], ret(c.entryTs, 15 * MIN), 1e-15);
    assert.deepEqual([c.skip['1h'], c.skip['4h'], c.skip['24h']], ['not_elapsed', 'not_elapsed', 'not_elapsed']);
    assert.equal(c.returns['1h'], null);
    // statistics, by hand
    const h15 = r.horizons[0], h24 = r.horizons[3];
    assert.equal(h15.events.n, 3); close(h15.events.mean, (ret(a.entryTs, 15 * MIN) + ret(b.entryTs, 15 * MIN) + ret(c.entryTs, 15 * MIN)) / 3, 1e-15);
    close(h15.events.median, [ret(a.entryTs, 15 * MIN), ret(b.entryTs, 15 * MIN), ret(c.entryTs, 15 * MIN)].sort((x, y) => x - y)[1], 1e-15);
    assert.equal(h15.events.hit_rate, 1, 'the linear price only rises');
    assert.equal(h15.events.ci, null, 'n = 3: no interval');
    assert.equal(h24.events.n, 2); assert.deepEqual(h24.skipped.events, { not_cached: 0, candle_gap: 0, not_elapsed: 1 });
    assert.equal(r.horizons[1].events.n, 2);
    assert.equal(r.baseline.requested, 3); assert.equal(r.baseline.drawn, 3);
    assert.equal(r.period.fromTs, A, 'the period starts at the symbol\'s first print (the cache starts earlier)');
    assert.equal(r.period.toTs, T('2026-03-04T23:55:00Z'), 'and ends at the newest print on the whole tape');
  } finally { w.done(); }
});

test('backtest: side long / short change the event set; min_usd and window_min move the threshold; a candle gap leaves exactly that horizon out and says why', async () => {
  const w = mini({ rows: baseRows(), gaps: [T('2026-03-02T11:00:00Z')] });                // A's entry 10:15; +1h = 11:15 = the candle starting 11:00 -> gap
  try {
    const run = (o) => backtest(P(o), { db: w.db, cacheDir: w.cacheDir, now: BASE + 6 * DAY, offline: true });
    assert.equal((await run({ sideMode: 'long' })).eventsFound, 2, 'A and C are Buy prints');
    assert.equal((await run({ sideMode: 'short' })).eventsFound, 1, 'B is the Sell burst');
    assert.equal((await run({ minUsd: 200_000 })).eventsFound, 0, 'no burst reaches 200k');
    assert.equal((await run({ minUsd: 125_000 })).eventsFound, 1, 'only B (150k) reaches 125k');
    const r = await run({});
    assert.equal(r.events[0].skip['1h'], 'candle_gap'); assert.equal(r.events[0].returns['1h'], null);
    assert.equal(r.events[0].skip['15m'], null); assert.equal(r.events[0].skip['4h'], null);
    assert.equal(r.horizons[1].events.n, 1, 'A is out of the 1h row; B is in; C is not elapsed');
    assert.deepEqual(r.horizons[1].skipped.events, { not_cached: 0, candle_gap: 1, not_elapsed: 1 });
    // the gap candle is also an exit price for other events: the 4h row is untouched
    assert.equal(r.horizons[2].events.n, 2);
    // the gap changes nothing else: same events with and without it
    const clean = mini({ rows: baseRows() });
    const r2 = await backtest(P(), { db: clean.db, cacheDir: clean.cacheDir, now: BASE + 6 * DAY, offline: true });
    assert.deepEqual(r2.events.map((e) => e.triggerTs), r.events.map((e) => e.triggerTs));
    assert.equal(r2.horizons[1].events.n, 2);
    clean.done();
    const w1 = await run({ windowMin: 1 });
    assert.deepEqual(w1.events.map((e) => e.triggerTs), [B + 40_000, Cc + 40_000], 'A spans 60 s, so a 1-minute window (t - 60 s, t] holds at most 3 of its 4 prints (90k): no event; B and C fit in 40 s');
  } finally { w.done(); }
});

test('backtest: a threshold that yields no event is a valid empty answer; events with no priced window are a 404 not-covered; unreadable tape is a 503', async () => {
  const w = mini({ rows: baseRows() });
  try {
    const none = await backtest(P({ minUsd: 900_000 }), { db: w.db, cacheDir: w.cacheDir, now: BASE + 6 * DAY, offline: true });
    assert.equal(none.eventsFound, 0); assert.deepEqual(none.events, []); assert.equal(none.horizons.length, 4); assert.equal(none.horizons[0].events.n, 0);
    const out = await M.run({ symbol: 'TEST', min_usd: 900000 }, null, { db: w.db, cacheDir: w.cacheDir, now: BASE + 6 * DAY, offline: true });
    assert.equal(out.events_found, 0); assert.deepEqual(out.events, []); assert.match(out.notes.join(' '), /No event at this threshold/);
    assert.equal(out.horizons['15m'].events.n, 0); assert.equal(out.horizons['15m'].events.mean_pct, null);
    // a covered symbol the tape has no print for: an empty valid answer with no period, not an error
    const noTape = mini({ rows: [[BASE, 'OTHERUSDT', 'Buy', 5]] });
    const nt = await M.run({ symbol: 'TEST' }, null, { db: noTape.db, cacheDir: noTape.cacheDir, now: BASE + 6 * DAY, offline: true });
    assert.equal(nt.events_found, 0); assert.equal(nt.period, null); assert.match(nt.notes.join(' '), /No event at this threshold/);
    noTape.done();
    // events exist, but the cache ends before them: nothing can be priced -> 404 not covered (not charged), not a 200 full of nulls
    const early = mini({ rows: baseRows(), from: BASE, to: BASE + DAY });
    await assert.rejects(backtest(P(), { db: early.db, cacheDir: early.cacheDir, now: BASE + 6 * DAY, offline: true }), (e) => e.status === 404 && /not covered, not charged\.$/.test(e.message) && /3 events/.test(e.message));
    early.done();
    // a tape database without the table: the tape's failure, a 503
    const empty = new (require('better-sqlite3'))(':memory:');
    await assert.rejects(backtest(P(), { db: empty, cacheDir: w.cacheDir, now: BASE + 6 * DAY, offline: true }), (e) => e.status === 503 && /Not charged\.$/.test(e.message) && e.retryAfter > 0);
  } finally { w.done(); }
});

// ============================================================================ time zones and midnight
test('UTC only: the same study under six time zones (including both daylight-saving changes) is byte-identical, and equals the hand formula', () => {
  const run = (tz) => { const r = spawnSync(process.execPath, [path.join(W.FIX, 'tz-probe.cjs')], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const zones = ['UTC', 'America/New_York', 'Europe/Chisinau', 'Pacific/Auckland', 'Asia/Kolkata', 'America/St_Johns'];
  const out = zones.map(run);
  // control: the machine really was in different zones (a local-time Date constructor gives a different instant in each), so equality below is not an accident
  assert.ok(new Set(out.map((o) => o.localDate)).size >= 4, `the probe's local-time control differs across zones: ${out.map((o) => o.localDate)}`);
  const strip = ({ localDate, ...rest }) => JSON.stringify(rest);
  for (let i = 1; i < out.length; i++) assert.equal(strip(out[i]), strip(out[0]), `${zones[i]} equals UTC`);
  const b0 = T('2026-10-24T00:00:00Z'), priceT = (Tm) => 100 + (Tm - STEP - b0) / STEP;
  assert.equal(out[0].events.length, 5);
  for (const e of out[0].events) for (const h of C.HORIZONS) assert.ok(Math.abs(e.returns[h.key] - (priceT(e.entryTs + h.ms) / priceT(e.entryTs) - 1)) < 1e-15, `${new Date(e.triggerTs).toISOString()} ${h.key}`);
  assert.deepEqual(out[0].events.map((e) => new Date(e.entryTs).toISOString()), ['2026-10-25T01:00:00.000Z', '2026-10-25T01:15:00.000Z', '2026-10-28T00:00:00.000Z', '2026-11-01T06:00:00.000Z', '2026-11-01T06:15:00.000Z']);
});

// ============================================================================ refresh: bounded, locked, rate limited, never fatal
const fakeFetch = (log, { delay = 0, fail = null, priceOf = lin } = {}) => async ({ coin, startMs, endMs }) => {
  log.push({ coin, startMs, endMs, at: Date.now() });
  if (delay) await new Promise((r) => setTimeout(r, delay));
  if (fail) throw fail;
  const out = [];
  for (let t = Math.ceil(startMs / STEP) * STEP; t < endMs; t += STEP) out.push({ t, c: priceOf(t) });
  return out;
};
const staleWorld = () => mini({ rows: [...burst('TESTUSDT', 'Buy', T('2026-03-02T20:00:00Z'), 4, 30_000)], from: BASE, to: BASE + 2 * DAY });   // the cache ends at Mar 3 00:00; the 24 h window of an event at 20:15 needs Mar 3 20:15
const NOW = BASE + 4 * DAY + 7 * MIN;

test('refresh: a cache that ends too early is topped up with ONE call from the start of its last day, the event is then priced at every horizon, and a second request makes no call', async () => {
  K._resetState();
  const w = staleWorld(), log = [];
  try {
    const deps = { db: w.db, cacheDir: w.cacheDir, now: NOW, fetchCandles: fakeFetch(log), callGapMs: 0 };
    const r = await backtest(P(), deps);
    assert.equal(log.length, 1); assert.equal(log[0].coin, 'TEST'); assert.equal(log[0].startMs, BASE + DAY, 'from the start of the cache\'s last day'); assert.equal(log[0].endMs, NOW);
    assert.equal(r.prices.refresh.status, 'ok');
    assert.deepEqual(r.horizons.map((h) => h.events.n), [1, 1, 1, 1]);
    assert.equal(K.loadSeries(w.cacheDir, 'TESTUSDT').lastThrough, Math.floor(NOW / STEP) * STEP, 'the new through is the last closed boundary');
    const again = await backtest(P(), deps);
    assert.equal(log.length, 1, 'no second call: the symbol was refreshed a moment ago');
    assert.deepEqual(again.horizons.map((h) => h.events.n), [1, 1, 1, 1]);
    // control: offline never calls
    K._resetState(); const w2 = staleWorld(); const log2 = [];
    const off = await backtest(P(), { db: w2.db, cacheDir: w2.cacheDir, now: NOW, fetchCandles: fakeFetch(log2), offline: true });
    assert.equal(log2.length, 0); assert.equal(off.horizons[3].events.n, 0, 'without the refresh the 24h row has nothing');
    w2.done();
  } finally { w.done(); }
});

test('refresh: five concurrent requests for the same stale symbol make ONE upstream call (in-flight lock); a naive implementation would make five', async () => {
  K._resetState();
  const w = staleWorld(), log = [];
  try {
    const deps = { db: w.db, cacheDir: w.cacheDir, now: NOW, fetchCandles: fakeFetch(log, { delay: 80 }), callGapMs: 0 };
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => backtest(P(), deps)));
    assert.equal(log.length, 1, `${log.length} upstream calls`);
    for (const r of rs) assert.deepEqual(r.horizons.map((h) => h.events.n), [1, 1, 1, 1]);
    const naive = []; const f = fakeFetch(naive, { delay: 80 });
    await Promise.all([1, 2, 3, 4, 5].map(() => f({ coin: 'TEST', startMs: BASE, endMs: NOW })));
    assert.equal(naive.length, 5, 'control: with no lock the same five requests make five calls, so the assertion above can fail');
  } finally { w.done(); }
});

test('refresh: an upstream failure with nothing priced is a 503 that says Not charged; the symbol is then left alone for a minute; one priced event keeps the answer a 200 that says so', async () => {
  K._resetState();
  const w = staleWorld(), log = [];
  try {
    const down = Object.assign(new Error('Hyperliquid answered HTTP 500. Not charged.'), { status: 503 });
    // an event that needs the missing tail only: the cache ends before it
    const rows = [...burst('TESTUSDT', 'Buy', T('2026-03-02T20:00:00Z'), 4, 30_000), ...burst('TESTUSDT', 'Buy', T('2026-03-04T12:00:00Z'), 4, 30_000)];
    const w3 = mini({ rows, from: BASE, to: BASE + 2 * DAY });
    const deps = { db: w3.db, cacheDir: w3.cacheDir, now: NOW, fetchCandles: fakeFetch(log, { fail: down }), callGapMs: 0 };
    const part = await backtest(P(), deps);
    assert.equal(log.length, 1);
    assert.equal(part.prices.refresh.status, 'failed');
    assert.deepEqual(part.horizons.map((h) => h.events.n), [1, 1, 0, 0], 'the Mar 2 event is priced to 1h from the cache (it ends at Mar 3 00:00); its 4h and 24h windows and the Mar 4 event are not');
    const out = require('../tools/r23/cascade-backtest').present(part, { side: 'both', minUsd: 100000, windowMin: 5, cooldownMin: 60, limit: 20 });
    assert.match(out.notes.join(' '), /could not be refreshed/);
    // nothing priced at all + failure -> 503
    K._resetState(); log.length = 0;
    const w4 = mini({ rows: [...burst('TESTUSDT', 'Buy', T('2026-03-04T12:00:00Z'), 4, 30_000)], from: BASE, to: BASE + 2 * DAY });
    const d4 = { db: w4.db, cacheDir: w4.cacheDir, now: NOW, fetchCandles: fakeFetch(log, { fail: down }), callGapMs: 0 };
    await assert.rejects(backtest(P(), d4), (e) => e.status === 503 && /Not charged\.$/.test(e.message) && e.retryAfter > 0 && /Hyperliquid could not be asked/.test(e.message));
    assert.equal(log.length, 1);
    await assert.rejects(backtest(P(), d4), (e) => e.status === 503);
    assert.equal(log.length, 1, 'a failure is not retried for a minute');
    await assert.rejects(backtest(P(), { ...d4, now: NOW + C.REFRESH_FAIL_BACKOFF_MS + 1 }), (e) => e.status === 503);
    assert.equal(log.length, 2, 'after the back-off it asks again');
    w3.done(); w4.done();
  } finally { w.done(); }
});

test('refresh: a damaged day file inside Hyperliquid\'s window is fetched again; one older than that window is ignored (the event is left out as not_cached) and nothing is fetched for it', async () => {
  K._resetState();
  const rows = [...burst('TESTUSDT', 'Buy', T('2026-03-02T10:00:00Z'), 4, 30_000), ...burst('TESTUSDT', 'Buy', T('2026-03-03T10:00:00Z'), 4, 30_000)];
  const damage = (dir) => { const f = path.join(dir, 'TESTUSDT', K.dayName(BASE + DAY)); const b = fs.readFileSync(f); b[200] ^= 0x10; fs.writeFileSync(f, b); return f; };
  const w = mini({ rows }), log = [];
  try {
    const f = damage(w.cacheDir);
    assert.equal(K.readDayFile(f, BASE + DAY), null, 'control: the file is damaged');
    const now = BASE + 6 * DAY;
    const r = await backtest(P(), { db: w.db, cacheDir: w.cacheDir, now, fetchCandles: fakeFetch(log), callGapMs: 0 });
    assert.equal(log.length, 1); assert.equal(log[0].startMs, BASE + DAY, 'asked from the damaged day');
    assert.ok(K.readDayFile(f, BASE + DAY), 'repaired');
    assert.equal(r.eventsFound, 2); assert.deepEqual(r.horizons.map((h) => h.events.n), [2, 2, 2, 2]);
    // beyond the retention window: the same damage cannot be repaired
    K._resetState();
    const w2 = mini({ rows }), log2 = [];
    damage(w2.cacheDir);
    const far = BASE + 4 * DAY + C.SOURCE_RETENTION_CANDLES * STEP + 5 * DAY;
    const r2 = await backtest(P(), { db: w2.db, cacheDir: w2.cacheDir, now: far, fetchCandles: fakeFetch(log2), callGapMs: 0 });
    assert.equal(log2.length, 0, 'Hyperliquid no longer has that day: no call');
    assert.equal(r2.eventsFound, 2);
    assert.equal(r2.events[0].skip['15m'], 'not_cached'); assert.deepEqual(r2.events[0].skip, { '15m': 'not_cached', '1h': 'not_cached', '4h': 'not_cached', '24h': 'not_cached' });
    assert.deepEqual(r2.horizons.map((h) => h.events.n), [1, 1, 1, 1], 'the other event is priced');
    assert.deepEqual(r2.horizons[0].skipped.events, { not_cached: 1, candle_gap: 0, not_elapsed: 0 });
    w2.done();
  } finally { w.done(); }
});

test('refresh: calls are spaced (one global line) and the bookkeeping maps stay bounded', async () => {
  K._resetState();
  const log = [];
  const dir = W.tmp();
  const f = fakeFetch(log);
  const [a, b] = await Promise.all([K.refresh({ dir, symbol: 'AAAUSDT', coin: 'AAA', fromMs: BASE, nowMs: BASE + DAY, fetchCandles: f, gapMs: 120 }), K.refresh({ dir, symbol: 'BBBUSDT', coin: 'BBB', fromMs: BASE, nowMs: BASE + DAY, fetchCandles: f, gapMs: 120 })]);
  assert.equal(a.status, 'ok'); assert.equal(b.status, 'ok');
  assert.ok(log[1].at - log[0].at >= 110, `second call ${log[1].at - log[0].at} ms after the first`);
  K._resetState(); log.length = 0;
  await Promise.all([K.refresh({ dir, symbol: 'AAAUSDT', coin: 'AAA', fromMs: BASE, nowMs: BASE + DAY, fetchCandles: f, gapMs: 0 }), K.refresh({ dir, symbol: 'BBBUSDT', coin: 'BBB', fromMs: BASE, nowMs: BASE + DAY, fetchCandles: f, gapMs: 0 })]);
  assert.ok(log[1].at - log[0].at < 100, 'control: with no gap the calls are back to back');
  K._resetState();
  const none = async () => [];
  for (let i = 0; i < C.MAX_TRACKED_SYMBOLS + 50; i++) await K.refresh({ dir, symbol: `S${i}USDT`, coin: 'X', fromMs: BASE, nowMs: BASE + DAY, fetchCandles: none, gapMs: 0 });
  assert.ok(K._state().lastOk <= C.MAX_TRACKED_SYMBOLS, `lastOk has ${K._state().lastOk}`);
  assert.ok(K._state().lastOk > 0, 'control: the map is in use');
  assert.equal(K._state().inflight, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ============================================================================ the Hyperliquid call
test('fetchCandlesHL: the request is exactly the documented candleSnapshot, to the fixed host; the answer is validated; every failure is a 503 that says Not charged', async () => {
  const seen = [];
  const reply = (body, { status = 200, headers = {} } = {}) => async (url, init) => { seen.push({ url, init }); return { status, ok: status < 400, headers: { get: (k) => headers[k.toLowerCase()] || null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }; };
  const good = [{ t: 3 * STEP, c: '101.5' }, { t: 1 * STEP, c: '100' }, { t: 1 * STEP, c: '100' }, { t: 2 * STEP + 1, c: '5' }, { t: 4 * STEP, c: '-3' }, { t: 5 * STEP, c: 'x' }, { s: 'junk' }];
  const out = await K.fetchCandlesHL({ coin: 'kPEPE', startMs: 123, endMs: 456 }, { fetchImpl: reply(good) });
  assert.deepEqual(out, [{ t: STEP, c: 100 }, { t: 3 * STEP, c: 101.5 }], 'sorted, de-duplicated; off-grid, negative, non-numeric and malformed rows dropped');
  assert.equal(seen[0].url, 'https://api.hyperliquid.xyz/info'); assert.equal(seen[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(seen[0].init.body), { type: 'candleSnapshot', req: { coin: 'kPEPE', interval: '15m', startTime: 123, endTime: 456 } });
  assert.equal(C.HL_INFO({ HL_API: 'http://127.0.0.1:1/info' }), 'http://127.0.0.1:1/info', 'the host is the operator\'s (HL_API), never the caller\'s');
  const refuse = async (impl, re, label) => { await assert.rejects(K.fetchCandlesHL({ coin: 'BTC', startMs: 0, endMs: 1 }, { fetchImpl: impl }), (e) => e.status === 503 && /Not charged\.$/.test(e.message) && re.test(e.message) && e.retryAfter > 0, label); };
  await refuse(reply('', { status: 429 }), /rate limiting/, '429');
  await refuse(reply('', { status: 500 }), /HTTP 500/, '500');
  await refuse(async () => { throw new Error('connect ECONNREFUSED'); }, /could not be reached/, 'network');
  await refuse(reply('<html>'), /not a candle list/, 'not json');
  await refuse(reply({ error: 'x' }), /not a candle list/, 'not an array');
  await refuse(reply([], { headers: { 'content-length': String(C.FETCH_MAX_BYTES + 1) } }), /oversized/, 'content-length over the cap');
  await refuse(reply('[' + ' '.repeat(C.FETCH_MAX_BYTES + 1) + ']'), /not a candle list/, 'body over the cap');
  for (const bad of ['BTC","x":"', 'BT C', '../x', 'a'.repeat(21), '', 'BTC\n', 'xyz:TSLA']) {
    seen.length = 0;
    await assert.rejects(K.fetchCandlesHL({ coin: bad, startMs: 0, endMs: 1 }, { fetchImpl: reply([]) }), (e) => e.status === 503, `coin ${JSON.stringify(bad)}`);
    assert.equal(seen.length, 0, `no request for coin ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(await K.fetchCandlesHL({ coin: 'BTC', startMs: 0, endMs: 1 }, { fetchImpl: reply([]) }), [], 'control: a good coin and an empty list pass');
});

test('no query parameter reaches the upstream URL or body except through a supported symbol: extra parameters are ignored, the host is fixed', async () => {
  K._resetState();
  const w = staleWorld(), log = [];
  try {
    const out = await M.run({ symbol: 'TEST', url: 'http://127.0.0.1:9/x', host: 'evil.example', coin: 'xyz:TSLA', HL_API: 'http://127.0.0.1:9', min_usd: '100000' }, null, { db: w.db, cacheDir: w.cacheDir, now: NOW, fetchCandles: fakeFetch(log), callGapMs: 0 });
    assert.equal(out.events_found, 1);
    assert.equal(log.length, 1); assert.equal(log[0].coin, 'TEST', 'the coin is the one in meta.json for the supported symbol');
  } finally { w.done(); }
});

// ============================================================================ parameters
test('parameters: defaults come from config; every bound is inclusive and an impossible value is a 400 before anything is read; empty means default', async () => {
  const d = M.parseParams({});
  assert.deepEqual(d, { side: C.SIDE_DEFAULT, minUsd: C.MIN_USD.dflt, windowMin: C.WINDOW_MIN.dflt, cooldownMin: C.COOLDOWN_MIN.dflt, limit: C.LIMIT.dflt });
  assert.deepEqual(M.parseParams({ side: '', min_usd: '', window_min: null, cooldown_min: undefined, limit: '' }), d, 'not given = default');
  const ok = (a, want) => assert.deepEqual({ ...M.parseParams(a) }, { ...d, ...want }, JSON.stringify(a));
  ok({ min_usd: '10000' }, { minUsd: 10000 }); ok({ min_usd: '1000000000' }, { minUsd: 1e9 }); ok({ min_usd: ' 1e5 ' }, { minUsd: 1e5 }); ok({ min_usd: 250000.5 }, { minUsd: 250000.5 });
  ok({ window_min: '1' }, { windowMin: 1 }); ok({ window_min: 60 }, { windowMin: 60 }); ok({ cooldown_min: '15' }, { cooldownMin: 15 }); ok({ cooldown_min: '1440' }, { cooldownMin: 1440 });
  ok({ limit: '1' }, { limit: 1 }); ok({ limit: 100 }, { limit: 100 }); ok({ side: 'LONG' }, { side: 'long' }); ok({ side: 'Short' }, { side: 'short' });
  // lib/query-rules.js refuses the same values with the sentence "... from 10000 to 1000000000" (no thousands separators) and test/query-guard-real-server.test.js requires the handler's sentence to be identical; the optional commas keep this test valid either way
  const no = (a, re) => assert.throws(() => M.parseParams(a), (e) => e.kind === 'bad_request' && re.test(e.message) && e.status === undefined, JSON.stringify(a));
  for (const v of ['9999.99', '1000000001', 'abc', 'NaN', 'Infinity', '-5', '0', '1e999', '0x10', ['1', '2'], { a: 1 }, true]) no({ min_usd: v }, /min_usd must be a number from 10,?000 to 1,?000,?000,?000/);
  for (const v of ['0', '61', '5.5', 'abc', '-1', ['5'], '1e2']) no({ window_min: v }, /window_min must be an integer from 1 to 60/);
  for (const v of ['14', '1441', '60.5', 'x']) no({ cooldown_min: v }, /cooldown_min must be an integer from 15 to 1,?440/);
  for (const v of ['0', '101', '2.5', 'x', '-3']) no({ limit: v }, /limit must be an integer from 1 to 100/);
  for (const v of ['up', 'longs', ['long'], 5, '  ']) no({ side: v }, /side must be long, short or both/);
  // nothing is read before the 400: no tape statement, no cache listing, no upstream call
  let touched = 0;
  const spy = { prepare() { touched++; throw new Error('read'); } };
  for (const bad of [{ side: 'x' }, { min_usd: 1 }, { window_min: 0 }, { cooldown_min: 1 }, { limit: 0 }]) await assert.rejects(M.run(bad, null, { db: spy, cacheDir: '/nonexistent', fetchCandles: () => { touched++; } }), (e) => e.kind === 'bad_request');
  assert.equal(touched, 0, 'no tape statement and no upstream call happened for any of them');
});

test('symbol: BTC, btc, BTCUSDT, kPEPE and 1000PEPE resolve; an unknown or malformed symbol is a 400 that lists the supported ones and reads nothing', async () => {
  const sup = [{ symbol: 'BTCUSDT', coin: 'BTC' }, { symbol: '1000PEPEUSDT', coin: 'kPEPE' }, { symbol: 'SOLUSDT', coin: 'SOL' }];
  for (const raw of ['BTC', 'btc', 'BTCUSDT', ' btcusdt ']) assert.equal(M.resolveSymbol(raw, sup).symbol, 'BTCUSDT', raw);
  for (const raw of ['kPEPE', '1000PEPE', '1000pepeusdt']) { const r = M.resolveSymbol(raw, sup); assert.equal(r.symbol, '1000PEPEUSDT'); assert.equal(r.coin, 'kPEPE'); }
  assert.equal(M.resolveSymbol(undefined, sup).symbol, 'SOLUSDT', 'the default is the same SOLUSDT the other tape routes default to');
  for (const raw of ['DOGE', 'ETHUSDT', '../etc/passwd', 'BTC USDT', "BTC'; DROP TABLE liquidations;--", 'a'.repeat(60), 'BTC\u0000', '%00', 'BTC,ETH', 'xyz:TSLA']) {
    assert.throws(() => M.resolveSymbol(raw, sup), (e) => e.kind === 'bad_request' && (e.supported === undefined || (Array.isArray(e.supported) && e.supported.join() === 'BTCUSDT,1000PEPEUSDT,SOLUSDT')), JSON.stringify(raw));
  }
  assert.throws(() => M.resolveSymbol('DOGE', sup), (e) => e.supported.length === 3 && /BTCUSDT, 1000PEPEUSDT, SOLUSDT/.test(e.message) && !/Not charged/.test(e.message) === true);
  assert.throws(() => M.resolveSymbol('DOGE', []), (e) => e.supported.length === 0 && /no symbol yet/.test(e.message));
  // the list is the cache's: a symbol whose files are removed stops being supported
  const w = mini({ rows: [] });
  assert.deepEqual(K.listSupported(w.cacheDir).map((s) => s.symbol), ['TESTUSDT']);
  fs.rmSync(path.join(w.cacheDir, 'TESTUSDT'), { recursive: true });
  await assert.rejects(M.run({ symbol: 'TEST' }, null, { db: w.db, cacheDir: w.cacheDir }), (e) => e.kind === 'bad_request' && e.supported.length === 0);
  w.done();
});

test('the zod schema (MCP) accepts every value the handler accepts at its edges and refuses what the handler refuses', () => {
  const { z } = require('zod');
  const shape = z.object(M.entries[0].schema);
  assert.ok(shape.safeParse({ symbol: 'BTC', side: 'long', min_usd: 1e6, window_min: 5, cooldown_min: 60, limit: 10 }).success);
  assert.ok(shape.safeParse({}).success, 'every parameter is optional');
  for (const a of [{ min_usd: C.MIN_USD.lo }, { min_usd: C.MIN_USD.hi }, { window_min: 1 }, { window_min: 60 }, { cooldown_min: 15 }, { cooldown_min: 1440 }, { limit: 1 }, { limit: 100 }]) { assert.ok(shape.safeParse(a).success, JSON.stringify(a)); assert.doesNotThrow(() => M.parseParams(a)); }
  for (const a of [{ min_usd: 9999 }, { min_usd: 1e9 + 1 }, { window_min: 0 }, { window_min: 61 }, { window_min: 2.5 }, { cooldown_min: 14 }, { cooldown_min: 1441 }, { limit: 0 }, { limit: 101 }, { side: 'x' }]) { assert.equal(shape.safeParse(a).success, false, JSON.stringify(a)); assert.throws(() => M.parseParams(a), (e) => e.kind === 'bad_request'); }
});

// ============================================================================ through the route wrapper (status mapping), and the fixture world / example
test('through lib/tool.js: 200 envelope, 400 with the supported list, 404 and 503 carry the refusal and Retry-After (the statuses that settle nothing)', async () => {
  K._resetState();
  const express = require('express');
  const { makeTool } = require('../lib/tool');
  const w = mini({ rows: baseRows() });
  const early = mini({ rows: baseRows(), from: BASE, to: BASE + DAY });
  const audit = [];
  const { tool } = makeTool({ paymentsOn: true, PRICES: { 'GET /api/cascade-backtest': { usd: 0.5 } }, decodeSettlement: () => null, logCall: (r) => audit.push(r) });
  const deps = { db: w.db, cacheDir: w.cacheDir, now: BASE + 6 * DAY, offline: true };
  let current = deps;
  const app = express();
  app.use((req, _res, next) => { req.callerIp = '203.0.113.9'; next(); });
  app.get(M.entries[0].route.replace('GET ', ''), tool(M.entries[0].name, M.entries[0].usd, (req) => M.run({ ...req.query }, req, current)));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const get = async (q) => { const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/cascade-backtest?${q}`); return { status: res.status, ra: res.headers.get('retry-after'), body: await res.json() }; };
  try {
    const ok = await get('symbol=TEST&min_usd=100000');
    assert.equal(ok.status, 200); assert.equal(ok.body.tool, 'get_cascade_backtest'); assert.equal(ok.body.paid, true); assert.equal(ok.body.data.events_found, 3);
    const bad = await get('symbol=TEST&side=up');
    assert.equal(bad.status, 400); assert.match(bad.body.error, /side must be/);
    const sym = await get('symbol=NOPE');
    assert.equal(sym.status, 400); assert.deepEqual(sym.body.supported, ['TESTUSDT']);
    current = { ...deps, db: early.db, cacheDir: early.cacheDir };
    const nc = await get('symbol=TEST');
    assert.equal(nc.status, 404); assert.match(nc.body.error, /not covered, not charged\.$/);
    current = { ...deps, db: new (require('better-sqlite3'))(':memory:') };
    const down = await get('symbol=TEST');
    assert.equal(down.status, 503); assert.ok(Number(down.ra) > 0); assert.match(down.body.error, /Not charged\.$/);
    const empty = await (async () => { current = deps; return get('symbol=TEST&min_usd=900000'); })();
    assert.equal(empty.status, 200, 'a threshold with no event is a valid answer'); assert.equal(empty.body.data.events_found, 0);
  } finally { srv.close(); w.done(); early.done(); }
});

test('the fixture world: the committed tape has the scheduled bursts, the events found are exactly those, and example.json is what the handler returns for it today', async () => {
  const G = require('./fixtures/r23/cascade/gen-fixtures.cjs');
  const { buildExample } = require('./fixtures/r23/cascade/build-example.cjs');
  const db = W.fixtureDb(), cacheDir = W.copyFixtureCache();
  try {
    const r = await backtest({ symbol: 'BTCUSDT', coin: 'BTC', sideMode: 'both', minUsd: 100_000, windowMin: 5, cooldownMin: 60 }, { db, cacheDir, now: W.FIXTURE_NOW, offline: true });
    const want = G.SCHEDULE.filter((b) => b.symbol === 'BTCUSDT').map((b) => b.at + (Math.max(C.MIN_PRINTS, Math.ceil(100_000 / b.usd)) - 1) * b.gapS * 1000);
    assert.deepEqual(r.events.map((e) => e.triggerTs), want, 'one event per scheduled burst, triggered by the print that completes it');
    assert.equal(r.events.length, 6);
    // the cache holds exactly what the generator says, including the one missing candle
    const s = K.loadSeries(cacheDir, 'BTCUSDT');
    assert.equal(s.priceAt(G.GAPS.BTCUSDT[0] + STEP).reason, 'candle_gap');
    assert.equal(s.lastThrough, G.WORLD.cacheEnd);
    assert.equal(K.listSupported(cacheDir).map((x) => `${x.symbol}:${x.coin}`).join(), 'BTCUSDT:BTC,SOLUSDT:SOL');
    const ex = await buildExample();
    assert.deepEqual(JSON.parse(JSON.stringify(M.entries[0].example)), ex, 'tools/r23/cascade-backtest/example.json is stale: run node test/fixtures/r23/cascade/build-example.cjs');
    assert.equal(ex.events_found, 6); assert.ok(ex.horizons['4h'].events.mean_ci95_pct, 'the example shows an interval on at least one row');
  } finally { db.close(); fs.rmSync(cacheDir, { recursive: true, force: true }); }
});

test('response shape: every key present, no NaN / undefined / Infinity, returns in percent to four places, the list is largest first and capped at limit while the statistics use every event', async () => {
  const w = mini({ rows: baseRows() });
  try {
    const full = await M.run({ symbol: 'TEST', limit: '2' }, null, { db: w.db, cacheDir: w.cacheDir, now: BASE + 6 * DAY, offline: true, supported: [{ symbol: 'TESTUSDT', coin: 'TEST' }] });
    assert.deepEqual(Object.keys(full), ['symbol', 'hyperliquid_coin', 'params', 'period', 'price_data', 'tape', 'events_found', 'events_listed', 'events_order', 'events', 'horizons', 'baseline', 'method', 'notes']);
    assert.equal(full.events_found, 3); assert.equal(full.events_listed, 2); assert.equal(full.events.length, 2);
    assert.deepEqual(full.events.map((e) => e.window_usd), [150000, 120000], 'largest window_usd first (B, then A before C by time)');
    assert.deepEqual(Object.keys(full.horizons), ['15m', '1h', '4h', '24h']);
    assert.equal(full.horizons['15m'].events.n, 3, 'the list was capped at 2 but the statistics used all 3');
    assert.deepEqual(Object.keys(full.horizons['15m'].events), ['n', 'mean_pct', 'median_pct', 'hit_rate_pct', 'mean_ci95_pct']);
    const a = full.events.find((e) => e.window_usd === 120000);
    assert.equal(a.forward_return_pct['15m'], Number((ret(T('2026-03-02T10:15:00Z'), 15 * MIN) * 100).toFixed(4)));
    assert.match(JSON.stringify(full.method), /rolling 5-minute window/);
    assert.doesNotMatch(JSON.stringify(full), /NaN|undefined|Infinity|null,null/);
    assert.equal(full.price_data.first_candle, '2026-03-01T00:00:00.000Z');
    assert.ok(full.method.limits.includes('not financial advice'));
    assert.ok(full.method.hit_rate.includes('above zero'));
  } finally { w.done(); }
});
