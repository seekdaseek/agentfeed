// tools/briefs/anomaly.js: GET /api/anomaly-flag (get_anomaly_flag). Funding, liquidation and open-interest anomalies across the Hyperliquid
// perp universe, in one ranked list, with the thresholds /api/market-state already uses (funding_extreme_abs_z, liq_spike_multiple) and the z-score
// /api/oi-spike-scan already computes. It answers "nothing abnormal" as a valid 200 that lists what was checked.
//
// THREE SIGNALS, ALL REQUIRED FOR AN ALL-CLEAR: funding (the radar snapshot), liquidations (the tape and its 7-day baseline) and open interest (the
// sampler's spike scan). A signal that is stale or missing is named in stale_parts; if the other two found something, that is the answer, and if they
// found nothing the route answers 503: "nothing abnormal" is never said on the strength of one or two signals out of three.
// CORE: the sampler (it defines the universe: the 60 coins with the most open interest). No sampler, no answer.
'use strict';
const E = require('./engine');
const S = require('./sources');
const { OI_Z } = require('./move');

const T = S.T;
const UNIVERSE_N = 60;                 // the same top 60 by open interest the signal board covers
const MIN_OI_USD = 3_000_000;          // the oi-spike-scan floor: dust markets are ignored
const MIN_LIQ_USD = 50_000;            // the floor signal-board puts under its liq_spike flag
const LIQ_HOURLY_FLOOR_USD = 5000;     // signal-board's floor under a quiet coin's hourly baseline
const MAX_ITEMS = 15;

const METHOD = [
  `Universe: the ${UNIVERSE_N} Hyperliquid perps with the most open interest in USD in our 5-minute sampler (funding: every perp in the funding radar above $${MIN_OI_USD / 1e6}M open interest).`,
  `Funding: |z_30d| of the coin's current 8-hour-equivalent rate against its own settled 30 days (the funding radar); flagged at ${T.funding_extreme_abs_z} or more, the funding_extreme_abs_z of /api/market-state.`,
  `Liquidations: the last 60 minutes of the coin's liquidations against the median hourly total of the previous ${T.liq_spike_window_h - 1} completed hours of our tape (hourly floor $${LIQ_HOURLY_FLOOR_USD}); flagged at ${T.liq_spike_multiple} times or more and at least $${MIN_LIQ_USD / 1000}k, the liq_spike_multiple of /api/market-state and the floor of /api/signal-board.`,
  `Open interest: the z-score /api/oi-spike-scan computes (the latest 1-hour change in coin units against that coin's 1-hour changes over the previous day; coins above $${MIN_OI_USD / 1e6}M, 1-hour change of at least 1%); flagged at |z| ${OI_Z.notable} or more (proposed, not yet calibrated on our own record).`,
  'Abnormality score: 1.0 means an item just meets its rule; funding = |z| / the funding threshold, liquidations = multiple / the liquidation threshold, open interest = |z| / the open-interest threshold. Items are ordered by it.',
  'All three signals are needed to say nothing is abnormal: if one is stale or missing and the other two find nothing, the route answers 503 (not billed) rather than an all-clear.',
  'The text is templates filled from these numbers; there is no language model. It describes what moved and never what to trade.',
].join(' ');

async function getAnomalyFlag(_p = {}, { now = Date.now(), deps = S.real } = {}) {
  const col = E.collector(now);
  let win;
  try { win = deps.oiWindow(now, []); } catch (e) { throw e.status === 503 ? e : E.unavailable(`anomaly-flag: ${e.message}`, 300); }
  col.use(win.name, win.as_of_ms);
  const asOf = E.iso(win.as_of_ms);
  const universe = [...win.value.cur.entries()].filter(([, r]) => r.mark > 0 && r.oi > 0).map(([coin, r]) => ({ coin, usd: r.oi * r.mark, mark: r.mark }))
    .sort((a, b) => b.usd - a.usd).slice(0, UNIVERSE_N);
  if (!universe.length) throw E.unavailable('anomaly-flag: our sampler holds no coin with open interest.', 300);

  const tape = await col.take('liquidation tape', S.TAPE_STALE_S, () => deps.tapeAsOf());
  const radar = await col.take('funding radar', S.RADAR_STALE_S, () => deps.radarAll(now));
  const spike = await col.take('open-interest spikes', null, () => deps.spikes(now));

  const flagged = [];   // { kind, score, item }
  let nLiq = 0;
  // ---- liquidations
  if (tape != null) {
    const base = deps.liqBaseline();
    for (const u of universe) {
      const sym = S.tapeSymbol(u.coin);
      const bs = deps.liqBuckets(sym, 2, 5).filter((b) => b.bucket >= now - 3_600_000);
      nLiq++;
      const total = bs.reduce((t, b) => t + (b.usd_total || 0), 0);
      if (total < MIN_LIQ_USD) continue;
      const med = Math.max((base.get(sym) && base.get(sym).median) || 0, LIQ_HOURLY_FLOOR_USD);
      const mult = total / med;
      if (mult < T.liq_spike_multiple) continue;
      const longs = bs.reduce((t, b) => t + (b.longs_usd || 0), 0), shorts = bs.reduce((t, b) => t + (b.shorts_usd || 0), 0);
      const big = bs.reduce((m, b) => Math.max(m, b.biggest_print || 0), 0);
      const lshare = (longs / total) * 100;
      flagged.push({
        kind: 'liquidations', coin: u.coin, score: mult / T.liq_spike_multiple, mark: u.mark,
        item: {
          what: `${u.coin} saw ${E.usd(total)} liquidated in the last hour, ${E.num(mult)} times its usual hour, ${E.num(lshare, 0)}% of it longs`,
          why_it_matters: lshare >= 60 ? `Mostly long positions were forced closed, the largest single print ${E.usd(big)}: leverage on the long side was flushed.` : lshare <= 40 ? `Mostly short positions were forced closed, the largest single print ${E.usd(big)}: leverage on the short side was flushed.` : `Both sides were forced closed, the largest single print ${E.usd(big)}.`,
          numbers: { last_hour_usd: Math.round(total), longs_usd: Math.round(longs), shorts_usd: Math.round(shorts), biggest_usd: Math.round(big), multiple: E.r(mult), hourly_median_usd: Math.round(med), rule_multiple: T.liq_spike_multiple },
          source: 'AgentFeed liquidation tape (Bybit, OKX, Binance prints; sums and extremes only)', as_of: E.iso(tape),
        },
      });
    }
  }
  // ---- funding
  const inUniverse = new Set(universe.map((u) => u.coin));
  if (radar) {
    for (const row of radar.rows) {
      if (row.max_abs_z == null || row.max_abs_z < T.funding_extreme_abs_z || !(row.oi_usd >= MIN_OI_USD)) continue;
      const v = row.venues && row.venues.hyperliquid;
      if (!v || v.z_30d == null) continue;
      const name = row.coin || String(row.symbol).replace(/USDT$/, '');
      const ann = v.funding_rate_8h == null ? null : v.funding_rate_8h * 3 * 365 * 100;
      flagged.push({
        kind: 'funding', coin: name, score: Math.abs(v.z_30d) / T.funding_extreme_abs_z, mark: null,
        item: {
          what: `${name} funding is ${E.num(Math.abs(v.z_30d))} standard deviations ${v.z_30d > 0 ? 'above' : 'below'} its own 30-day norm${ann == null ? '' : ` (${E.pct(ann, 0)} a year)`}`,
          why_it_matters: v.z_30d > 0 ? 'Longs are paying shorts an unusually high rate to hold their positions: the long side is crowded.' : 'Shorts are paying longs an unusually high rate to hold their positions: the short side is crowded.',
          numbers: { funding_z_30d: E.r(v.z_30d), funding_rate_8h: v.funding_rate_8h, funding_annualised_pct: E.r(ann), samples: v.samples, oi_usd: row.oi_usd, rule_z: T.funding_extreme_abs_z },
          source: 'AgentFeed funding radar snapshot (30-day z-scores)', as_of: E.iso(Date.parse(col.sources.find((x) => x.name.includes('funding radar')).as_of)),
        },
      });
    }
  }
  // ---- open interest
  if (spike) {
    for (const row of spike.spikes || []) {
      if (row.spike_z == null || Math.abs(row.spike_z) < OI_Z.notable) continue;
      flagged.push({
        kind: 'open_interest', coin: row.coin, score: Math.abs(row.spike_z) / OI_Z.notable, mark: (win.value.cur.get(row.coin) || {}).mark,
        item: {
          what: `${row.coin} open interest ${E.pct(row.oi_change_1h_pct)} in 1 hour, counted in coins, ${E.num(Math.abs(row.spike_z))} standard deviations from its usual hour`,
          why_it_matters: row.oi_change_1h_pct > 0 ? 'Positions were added faster than this coin usually adds them in an hour.' : 'Positions were closed faster than this coin usually closes them in an hour.',
          numbers: { oi_change_1h_pct: row.oi_change_1h_pct, oi_change_4h_pct: row.oi_change_4h_pct, oi_change_24h_pct: row.oi_change_24h_pct, spike_z: row.spike_z, oi_usd: row.oi_usd, price_change_1h_pct: row.price_change_1h_pct, rule_z: OI_Z.notable },
          source: 'AgentFeed open-interest spike scan (sampler)', as_of: asOf,
        },
      });
    }
  }

  // an all-clear needs all three signals
  const missing = [tape == null && 'liquidation tape', radar == null && 'funding radar', spike == null && 'open-interest spikes'].filter(Boolean);
  if (!flagged.length && missing.length) throw E.unavailable(`anomaly-flag: nothing was flagged, but ${missing.join(' and ')} could not be read, so an all-clear cannot be given.`, 120);

  flagged.sort((a, b) => b.score - a.score);
  const top = flagged.slice(0, MAX_ITEMS);
  const kindsOf = new Map();
  for (const f of flagged) kindsOf.set(f.coin, [...(kindsOf.get(f.coin) || []), f.kind]);
  const items = top.map((f) => {
    const m = f.mark || (win.value.cur.get(f.coin) || {}).mark;
    const lvl = tape != null && m > 0 && inUniverse.has(f.coin) ? E.levelOf(deps.clusters(S.tapeSymbol(f.coin), m), m) : null;
    const also = (kindsOf.get(f.coin) || []).filter((k) => k !== f.kind);
    return { ...f.item, level_to_watch: lvl, numbers: { ...f.item.numbers, kind: f.kind, ...(also.length ? { also_flagged: also } : {}) }, abnormality: f.score };
  });

  const checked = { funding_perps: radar ? (radar.universe && radar.universe.total) || radar.matched : null, liquidation_coins: tape != null ? nLiq : null, open_interest_coins: spike ? spike.coins_scanned : null, universe: universe.length };
  return E.envelope({
    brief: 'anomaly-flag', now,
    window: { liquidations: 'last 60 minutes', open_interest: 'last hour against the previous day', funding: '30-day z-score at the latest radar snapshot', to: asOf },
    items, col, method: METHOD,
    emptyHeadline: `Nothing abnormal: ${checked.funding_perps} perps checked for funding, ${checked.liquidation_coins} for liquidations and ${checked.open_interest_coins} for open interest; none is past its rule.`,
    extra: { checked, flagged_total: flagged.length, rules: { funding_abs_z: T.funding_extreme_abs_z, liquidation_multiple: T.liq_spike_multiple, liquidation_floor_usd: MIN_LIQ_USD, open_interest_abs_z: OI_Z.notable } },
  });
}

module.exports = { getAnomalyFlag, METHOD, UNIVERSE_N };
