// pensio briefs (tools/briefs/*): morning-brief, move-alert, anomaly-flag on a synthetic seeded market (test/helpers/brief-world.js).
// For each brief: fresh, stale, thin (one part missing), missing core (503, never billed), and the empty / "nothing abnormal" case, plus the
// templates: no NaN, no "undefined", no buy or sell wording, on every text any scenario produces.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
process.env.OVERHANG_DB_PATH = process.env.OVERHANG_DB_PATH || path.join(require('os').tmpdir(), 'none.db');
const E = require('../tools/briefs/engine');
const { getMorningBrief } = require('../tools/briefs/morning');
const MV = require('../tools/briefs/move');
const { getMoveAlert } = MV;
const { getAnomalyFlag } = require('../tools/briefs/anomaly');
const { makeWorld, makeCalibration } = require('./helpers/brief-world');

const NOW = Date.UTC(2026, 9, 29, 12, 2, 0);
const KEYS = ['brief', 'as_of', 'window', 'headline', 'items', 'sources', 'stale_parts', 'method'];
const ITEM_KEYS = ['what', 'why_it_matters', 'numbers', 'source', 'as_of', 'abnormality'];
const seen = [];           // every envelope any test produced, for the template sweep at the end
const keep = (b) => { seen.push(b); return b; };
const calOf = (over, coins) => () => makeCalibration(NOW, coins, over);

function shape(b, name) {
  for (const k of KEYS) assert.ok(k in b, `${name}: envelope has ${k}`);
  assert.equal(b.brief, name);
  assert.ok(Array.isArray(b.items) && Array.isArray(b.sources) && Array.isArray(b.stale_parts));
  for (const it of b.items) for (const k of ITEM_KEYS) assert.ok(k in it && it[k] != null, `${name} item has ${k}`);
  for (let i = 1; i < b.items.length; i++) assert.ok(b.items[i - 1].abnormality >= b.items[i].abnormality, 'items are ordered by abnormality');
  for (const s of b.sources) { assert.ok(s.name && s.as_of && Number.isInteger(s.age_s) && s.age_s >= 0, 'every source has name, as_of and age_s'); }
  assert.ok(typeof b.method === 'string' && b.method.length > 200, 'method names the thresholds and the sample');
  if (b.items.length) assert.equal(b.headline, b.items[0].what, 'the headline is the most abnormal item');
}
const rejects503 = async (fn, re) => {
  await assert.rejects(fn(), (e) => { assert.equal(e.status, 503); assert.ok(e.retryAfter > 0, 'Retry-After is set'); assert.match(e.message, /Not charged\./); if (re) assert.match(e.message, re); return true; });
};

// ---------------------------------------------------------------- engine
test('engine formatters: a non-finite number throws instead of printing NaN; clean() refuses a leaked non-value', () => {
  assert.equal(E.usd(1234567), '$1.23M');
  assert.equal(E.pct(-2.345), '-2.3%');
  assert.equal(E.pct(0.04), '0.0%');
  assert.throws(() => E.pct(NaN), /not a finite number/);
  assert.throws(() => E.usd(undefined), /not a finite number/);
  assert.throws(() => E.px(Infinity), /not a finite number/);
  for (const bad of ['x NaN y', 'value undefined', 'a null b', '[object Object]', '', '   ', 5]) assert.throws(() => E.clean(bad), /brief template/);
  assert.equal(E.clean('SOL -2.3% over 8 hours'), 'SOL -2.3% over 8 hours');
});
test('engine: TRADE_CALL catches buy / sell wording (control for the template sweep, tested on known positives)', () => {
  for (const s of ['buy the dip', 'Sell now', 'go long here', 'you should short', 'take profit at', 'a bullish setup', 'stop-loss at 5']) assert.match(s, E.TRADE_CALL, s);
  for (const s of ['longs paying shorts', 'liquidated longs', 'the long side is crowded', 'funding is high']) assert.doesNotMatch(s, E.TRADE_CALL, s);
});
test('windowChanges: hourly windows ending at least one window before the newest sample', () => {
  const rows = []; for (let i = 0; i < 864; i++) rows.push({ ts: 1_000_000 + i * 300, mark: 100 + i * 0.01 });
  const w = E.windowChanges(rows, 'mark', 8 * 3600);
  assert.equal(w.length, 56);
  assert.ok(w.every((x) => x > 0.008 && x < 0.011));
});

// ---------------------------------------------------------------- morning brief
test('morning-brief fresh: four coins, a move item each, ranked, with sources, no stale parts, level to watch from the heatmap', async () => {
  const w = makeWorld({ now: NOW, shock: { SOL: { markPct: -6.5, oiPct: 12, steps: 90 } }, funding: { SOL: -3.1, BTC: 0.3 }, liq: { SOL: { lastHourUsd: 400_000, longsShare: 0.8, windowH: 8 } },
    events: [{ type: 'FOMC', title: 'FOMC rate decision (statement)', utc: '2026-10-29T18:00:00.000Z' }] });
  const b = keep(await getMorningBrief({}, { now: NOW, deps: w.deps }));
  shape(b, 'morning-brief');
  assert.deepEqual(b.stale_parts, []);
  assert.deepEqual(Object.keys(b.coins).sort(), ['BTC', 'ETH', 'HYPE', 'SOL']);
  for (const c of ['BTC', 'ETH', 'SOL', 'HYPE']) assert.ok(b.items.some((i) => i.what.startsWith(`${c} `) && i.numbers.change_8h_pct !== undefined), `${c} has a move item`);
  assert.match(b.headline, /^SOL /, 'the coin that moved is the headline');
  assert.ok(b.items.some((i) => /^SOL -[67]\.\d% over 8 hours to /.test(i.what)), 'and its price move is an item');
  const sol = b.items.filter((i) => i.what.startsWith('SOL '));
  assert.ok(sol.some((i) => /funding is/.test(i.what)), 'funding z -3.1 crosses marketstate\'s 2');
  assert.ok(sol.some((i) => /liquidated in 8 hours/.test(i.what)), 'the liquidation spike is an item');
  assert.ok(b.items.some((i) => /^FOMC scheduled at 18:00 UTC, in 6\.0 hours/.test(i.what)), "today's macro event with its UTC time");
  assert.equal(sol[0].level_to_watch.kind, 'liquidation_cluster');
  assert.match(sol[0].level_to_watch.text, /Nearest liquidation cluster (above|below) the mark/);
  assert.equal(b.window.hours, 8);
  assert.ok(b.sources.length >= 5);
});
test('morning-brief quiet morning: still says what each coin did; nothing is flagged abnormal', async () => {
  const w = makeWorld({ now: NOW, seed: 11 });
  const b = keep(await getMorningBrief({}, { now: NOW, deps: w.deps }));
  shape(b, 'morning-brief');
  assert.ok(b.items.length >= 4);
  assert.ok(b.items.every((i) => i.abnormality < 1.5), 'no item is far past its rule on a seeded quiet market');
  assert.ok(!b.items.some((i) => /funding is|liquidated in 8 hours/.test(i.what)));
});
test('morning-brief stale: a stale tape leaves the liquidation parts null and names them; the rest is unchanged', async () => {
  const w = makeWorld({ now: NOW, tape: 'stale', liq: { BTC: { lastHourUsd: 5e6, windowH: 8 } } });
  const b = keep(await getMorningBrief({}, { now: NOW, deps: w.deps }));
  shape(b, 'morning-brief');
  assert.ok(b.stale_parts.some((p) => p.part === 'liquidation tape' && /old \(limit 1800s\)/.test(p.reason)), JSON.stringify(b.stale_parts));
  for (const c of Object.values(b.coins)) { assert.equal(c.liquidations_8h_usd, null); assert.equal(c.biggest_liquidation_usd, null); }
  assert.ok(!b.items.some((i) => /liquidated in 8 hours/.test(i.what)), 'a stale tape is never served as a fresh liquidation item');
  assert.ok(b.items.every((i) => !i.level_to_watch), 'no heatmap level without a fresh tape');
  assert.ok(!b.sources.some((s) => /liquidation tape/.test(s.name)));
});
test('morning-brief stale: an old calendar, Fear and Greed and a stale radar are left out and named', async () => {
  const w = makeWorld({ now: NOW, radar: 'stale', macro: 'missing', fg: null });
  const b = keep(await getMorningBrief({}, { now: NOW, deps: w.deps }));
  shape(b, 'morning-brief');
  const parts = b.stale_parts.map((p) => p.part);
  assert.ok(parts.includes('macro calendar') && parts.includes('fear and greed') && parts.includes('BTC funding z-score'), parts.join('; '));
  assert.equal(b.coins.BTC.funding_z_30d, null);
  assert.equal(b.context.fear_greed, null);
});
test('morning-brief thin: one coin missing from the radar is null for that coin only', async () => {
  const w = makeWorld({ now: NOW, radarMissing: ['HYPE'], funding: { SOL: 2.6 } });
  const b = keep(await getMorningBrief({}, { now: NOW, deps: w.deps }));
  assert.equal(b.coins.HYPE.funding_z_30d, null);
  assert.notEqual(b.coins.SOL.funding_z_30d, null);
  assert.deepEqual(b.stale_parts.map((p) => p.part), ['HYPE funding z-score']);
});
test('morning-brief thin: a coin missing from the sampler is dropped and named, the others are served', async () => {
  const w = makeWorld({ now: NOW });
  const real = w.deps.oiWindow;
  w.deps.oiWindow = (n, o) => { const r = real(n, o); r.value.cur.delete('HYPE'); return r; };
  const b = keep(await getMorningBrief({}, { now: NOW, deps: w.deps }));
  assert.deepEqual(Object.keys(b.coins).sort(), ['BTC', 'ETH', 'SOL']);
  assert.ok(b.stale_parts.some((p) => p.part === 'HYPE sampler row'));
});
test('morning-brief missing core: a stale or empty sampler, or no sample 8 hours back, is a 503 with Retry-After and "Not charged."', async () => {
  await rejects503(() => getMorningBrief({}, { now: NOW, deps: makeWorld({ now: NOW, sampler: 'stale' }).deps }), /sampler/);
  await rejects503(() => getMorningBrief({}, { now: NOW, deps: makeWorld({ now: NOW, sampler: 'empty' }).deps }), /no data/);
  await rejects503(() => getMorningBrief({}, { now: NOW, deps: makeWorld({ now: NOW, gapAt: [28800] }).deps }), /8 hours back/);
});

// ---------------------------------------------------------------- move-alert
const moveDeps = (o) => makeWorld({ now: NOW, ...o }).deps;
test('move-alert fresh: a sharp 1-hour move in SOL is an item, unexplained by the calendar, with the tails and n in the item and the method', async () => {
  const b = keep(await getMoveAlert({}, { now: NOW, deps: moveDeps({ shock: { SOL: { markPct: -3.4, steps: 12 } }, events: [] }), calibration: calOf() }));
  shape(b, 'move-alert');
  const it = b.items.find((i) => i.what.startsWith('SOL '));
  assert.ok(it, JSON.stringify(b.items.map((i) => i.what)));
  assert.equal(it.numbers.tier, 'sharp');
  assert.equal(it.numbers.label, 'unexplained');
  assert.equal(it.numbers.horizon, '1h');
  assert.equal(it.numbers.n, 4999);
  assert.match(it.what, /a sharp move, larger than 99\.8% of its last 4999 hourly moves/);
  assert.match(b.method, /p99\.8/);
  assert.match(b.method, /Sample size n per coin, in windows: 5m 4999; 1h 4999; 4h 4998\./);
  assert.equal(b.coins_checked, 6);
});
test('move-alert event-driven: the same move inside a CPI window is labelled with the release; an event 5 hours away is not', async () => {
  const inside = keep(await getMoveAlert({}, { now: NOW, deps: moveDeps({ shock: { SOL: { markPct: -3.4, steps: 12 } }, events: [{ type: 'CPI', title: 'CPI', utc: '2026-10-29T11:30:00.000Z' }] }), calibration: calOf() }));
  const it = inside.items.find((i) => i.what.startsWith('SOL '));
  assert.equal(it.numbers.label, 'event_driven');
  assert.deepEqual(it.numbers.event, { type: 'CPI', utc: '2026-10-29T11:30:00.000Z' });
  assert.match(it.why_it_matters, /CPI \(11:30 UTC\) falls inside this window/);
  const after = keep(await getMoveAlert({}, { now: NOW, deps: moveDeps({ shock: { SOL: { markPct: -3.4, steps: 12 } }, events: [{ type: 'CPI', title: 'CPI', utc: '2026-10-29T17:00:00.000Z' }] }), calibration: calOf() }));
  assert.equal(after.items.find((i) => i.what.startsWith('SOL ')).numbers.label, 'unexplained');
  assert.ok(MV.EVENT_BEFORE_S === 900 && MV.EVENT_AFTER_S === 7200, 'the window is 15 minutes before to 2 hours after, as stated in method');
  assert.match(inside.method, /15 minutes before it to 2 hours after it/);
});
test('move-alert tiers: notable is below the surfaced tier, extreme means larger than every window in the sample', async () => {
  const mild = { shock: { ETH: { markPct: 1.7, steps: 12 } } };    // above the 1.5% notable, below the 2.4% sharp
  const quiet = keep(await getMoveAlert({}, { now: NOW, deps: moveDeps(mild), calibration: calOf() }));
  assert.ok(!quiet.items.some((i) => i.what.startsWith('ETH ')), 'a notable move is not shown at the sharp tier');
  const loud = keep(await getMoveAlert({}, { now: NOW, deps: moveDeps(mild), calibration: calOf(), minTier: 'notable' }));
  assert.equal(loud.items.find((i) => i.what.startsWith('ETH ')).numbers.tier, 'notable');
  const ext = keep(await getMoveAlert({}, { now: NOW, deps: moveDeps({ shock: { ETH: { markPct: 7, steps: 12 } } }), calibration: calOf() }));
  const e = ext.items.find((i) => i.what.startsWith('ETH '));
  assert.equal(e.numbers.tier, 'extreme');
  assert.match(e.what, /larger than every one of its last 4999 hourly moves/);
  assert.equal(MV.tierOf(0.39, { notable_pct: 0.4, sharp_pct: 0.8, extreme_pct: 3 }), null);
  assert.equal(MV.tierOf(0.4, { notable_pct: 0.4, sharp_pct: 0.8, extreme_pct: 3 }), 'notable');
});
test('move-alert open interest: a spike scan row past the rule is an item; the scan failing is a stale part, not a failure', async () => {
  const spikes = [{ coin: 'C00', oi_change_1h_pct: 14.2, spike_z: 6.1 }, { coin: 'C01', oi_change_1h_pct: 3, spike_z: 1.2 }];
  const b = keep(await getMoveAlert({}, { now: NOW, deps: moveDeps({ spikes }), calibration: calOf() }));
  const it = b.items.find((i) => /open interest/.test(i.what));
  assert.ok(it && it.what.startsWith('C00 '));
  assert.equal(it.numbers.tier, 'extreme');
  assert.equal(b.items.filter((i) => /open interest/.test(i.what)).length, 1);
  const warm = keep(await getMoveAlert({}, { now: NOW, deps: moveDeps({ spikes: 'warming' }), calibration: calOf() }));
  assert.ok(warm.stale_parts.some((p) => p.part === 'open-interest spikes' && /covers 3\.0 of the 24 hours/.test(p.reason)));
});
test('move-alert thin: no macro calendar means the label is event_status_unknown, never "unexplained"', async () => {
  const b = keep(await getMoveAlert({}, { now: NOW, deps: moveDeps({ macro: 'missing', shock: { SOL: { markPct: -3.4, steps: 12 } } }), calibration: calOf() }));
  const it = b.items.find((i) => i.what.startsWith('SOL '));
  assert.equal(it.numbers.label, 'event_status_unknown');
  assert.match(it.why_it_matters, /macro calendar could not be read/);
  assert.ok(b.stale_parts.some((p) => p.part === 'macro calendar'));
});
test('move-alert thin: a gap at one baseline drops that horizon only', async () => {
  const b = keep(await getMoveAlert({}, { now: NOW, deps: moveDeps({ gapAt: [14400], shock: { SOL: { markPct: -3.4, steps: 12 } } }), calibration: calOf() }));
  assert.ok(b.stale_parts.some((p) => p.part === '4 hours baseline'));
  assert.ok(b.items.some((i) => i.what.startsWith('SOL ')), 'the 1-hour horizon still answers');
});
test('move-alert missing core: stale sampler, an old or unreadable calibration table, or no baseline at all is a 503', async () => {
  await rejects503(() => getMoveAlert({}, { now: NOW, deps: moveDeps({ sampler: 'stale' }), calibration: calOf() }), /sampler/);
  await rejects503(() => getMoveAlert({}, { now: NOW, deps: moveDeps({}), calibration: calOf({ fetched_at: new Date(NOW - 60 * 86400_000).toISOString() }) }), /60 days old \(limit 45\)/);
  await rejects503(() => getMoveAlert({}, { now: NOW, deps: moveDeps({}), calibration: () => { throw new Error('ENOENT'); } }), /calibration table cannot be read/);
  await rejects503(() => getMoveAlert({}, { now: NOW, deps: moveDeps({ gapAt: [300, 3600, 14400] }), calibration: calOf() }), /no baseline/);
});
test('move-alert empty: nothing past its tail is a valid 200 that says what was checked', async () => {
  const b = keep(await getMoveAlert({}, { now: NOW, deps: moveDeps({ seed: 5 }), calibration: calOf() }));
  shape(b, 'move-alert');
  assert.deepEqual(b.items, []);
  assert.match(b.headline, /^No move at the sharp tier or above in the last 4 hours across 6 coins/);
  assert.equal(b.coins_checked, 6);
});

// ---------------------------------------------------------------- anomaly-flag
test('anomaly-flag fresh: funding, liquidation and open-interest anomalies in one ranked list; a coin flagged twice says so', async () => {
  const w = makeWorld({ now: NOW, funding: { SOL: 3.4, C03: -2.4 }, liq: { SOL: { lastHourUsd: 900_000, longsShare: 0.9 }, C05: { lastHourUsd: 120_000, longsShare: 0.2 } },
    spikes: [{ coin: 'C07', oi_change_1h_pct: 9, spike_z: 4.4 }] });
  const b = keep(await getAnomalyFlag({}, { now: NOW, deps: w.deps }));
  shape(b, 'anomaly-flag');
  assert.deepEqual(b.stale_parts, []);
  const kinds = b.items.map((i) => i.numbers.kind);
  for (const k of ['funding', 'liquidations', 'open_interest']) assert.ok(kinds.includes(k), `${k} item`);
  const sol = b.items.filter((i) => i.what.startsWith('SOL '));
  assert.equal(sol.length, 2);
  assert.ok(sol.every((i) => i.numbers.also_flagged && i.numbers.also_flagged.length === 1), 'SOL is flagged by funding and by liquidations');
  assert.equal(b.items.find((i) => i.what.startsWith('C03 ')).numbers.kind, 'funding');
  assert.ok(b.items.find((i) => i.what.startsWith('C05 ')).numbers.longs_usd < b.items.find((i) => i.what.startsWith('C05 ')).numbers.shorts_usd);
  assert.equal(b.rules.funding_abs_z, 2);
  assert.equal(b.rules.liquidation_multiple, 3);
});
test('anomaly-flag empty: nothing abnormal is a 200 that lists what was checked, and it needs all three signals', async () => {
  const b = keep(await getAnomalyFlag({}, { now: NOW, deps: makeWorld({ now: NOW }).deps }));
  shape(b, 'anomaly-flag');
  assert.deepEqual(b.items, []);
  assert.match(b.headline, /^Nothing abnormal: 337 perps checked for funding, 24 for liquidations and 74 for open interest; none is past its rule\.$/);
  assert.deepEqual(b.checked, { funding_perps: 337, liquidation_coins: 24, open_interest_coins: 74, universe: 24 });
  assert.deepEqual(b.stale_parts, []);
});
test('anomaly-flag below the rules: a 2.9x liquidation hour, a 1.9 funding z and a $40k hour flag nothing', async () => {
  const w = makeWorld({ now: NOW, funding: { SOL: 1.9 }, liq: { BTC: { lastHourUsd: 40_000 }, ETH: { lastHourUsd: 20_000 } } });
  const b = keep(await getAnomalyFlag({}, { now: NOW, deps: w.deps }));
  assert.deepEqual(b.items, []);
});
test('anomaly-flag floor: a quiet coin\'s $42k hour is 8 times its usual but below the $50k floor, so it is not flagged; $60k is', async () => {
  const quiet = { baseline: 5_000, bg: 2_000 };
  const below = keep(await getAnomalyFlag({}, { now: NOW, deps: makeWorld({ now: NOW, ...quiet, liq: { SOL: { lastHourUsd: 40_000 } } }).deps }));
  assert.deepEqual(below.items, [], 'a multiple of 8 on a $42k hour is under the floor');
  const above = keep(await getAnomalyFlag({}, { now: NOW, deps: makeWorld({ now: NOW, ...quiet, liq: { SOL: { lastHourUsd: 60_000 } } }).deps }));
  assert.equal(above.items.length, 1);
  assert.equal(above.items[0].numbers.kind, 'liquidations');
});
test('anomaly-flag thin: a stale radar with the other two signals finding something is served, with the radar named; with nothing found it is a 503, never an all-clear', async () => {
  const w = makeWorld({ now: NOW, radar: 'stale', liq: { SOL: { lastHourUsd: 900_000 } } });
  const b = keep(await getAnomalyFlag({}, { now: NOW, deps: w.deps }));
  assert.ok(b.items.length === 1 && b.items[0].numbers.kind === 'liquidations');
  assert.ok(b.stale_parts.some((p) => p.part === 'funding radar'));
  assert.equal(b.checked.funding_perps, null);
  await rejects503(() => getAnomalyFlag({}, { now: NOW, deps: makeWorld({ now: NOW, radar: 'stale' }).deps }), /funding radar could not be read, so an all-clear cannot be given/);
  await rejects503(() => getAnomalyFlag({}, { now: NOW, deps: makeWorld({ now: NOW, tape: 'stale' }).deps }), /liquidation tape/);
  await rejects503(() => getAnomalyFlag({}, { now: NOW, deps: makeWorld({ now: NOW, spikes: 'warming' }).deps }), /open-interest spikes/);
});
test('anomaly-flag stale tape: a stale tape is never served as a fresh liquidation item', async () => {
  const w = makeWorld({ now: NOW, tape: 'stale', liq: { SOL: { lastHourUsd: 900_000 } }, funding: { C02: 2.8 } });
  const b = keep(await getAnomalyFlag({}, { now: NOW, deps: w.deps }));
  assert.ok(b.items.every((i) => i.numbers.kind !== 'liquidations'));
  assert.ok(b.stale_parts.some((p) => p.part === 'liquidation tape'));
  assert.equal(b.checked.liquidation_coins, null);
});
test('anomaly-flag missing core: a stale or empty sampler is a 503', async () => {
  await rejects503(() => getAnomalyFlag({}, { now: NOW, deps: makeWorld({ now: NOW, sampler: 'stale' }).deps }), /sampler/);
  await rejects503(() => getAnomalyFlag({}, { now: NOW, deps: makeWorld({ now: NOW, sampler: 'empty' }).deps }), /no data/);
});

// ---------------------------------------------------------------- templates
test('templates: no NaN, undefined, null or object leak and no buy / sell wording in anything any scenario above produced', () => {
  assert.ok(seen.length >= 14, `the sweep saw ${seen.length} envelopes`);
  let strings = 0;
  const walk = (v, where) => {
    if (typeof v === 'string') {
      strings++;
      if (where.startsWith('method') || where === 'sources') return;
      assert.doesNotMatch(v, /NaN|undefined|Infinity|\[object/, `${where}: ${v}`);
      assert.doesNotMatch(v, E.TRADE_CALL, `${where}: ${v}`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
    else if (typeof v === 'number') assert.ok(Number.isFinite(v), `${where} is a finite number`);
  };
  for (const b of seen) { walk(b.headline, 'headline'); walk(b.items, 'items'); walk(b.stale_parts, 'stale_parts'); walk(b.coins || {}, 'coins'); walk(b.checked || {}, 'checked'); }
  for (const b of seen) { assert.doesNotMatch(b.method, E.TRADE_CALL); assert.doesNotMatch(b.method, /NaN|undefined/); assert.doesNotMatch(JSON.stringify(b), /since \d{1,2} [A-Z][a-z]+ 20\d\d|since 20\d\d/); }
  assert.ok(strings > 200);
});
