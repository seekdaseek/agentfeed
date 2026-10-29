// tools/briefs/morning.js: GET /api/morning-brief (get_morning_brief). BTC, ETH, SOL and HYPE over the last 8 hours, ranked by how abnormal each
// item is, with the one level to watch per coin. Deterministic templates over data AgentFeed already holds (sources.js); no model, no new upstream
// except Fear and Greed (market-state's own memoised read). Takes no parameter.
//
// CORE: the open-interest sampler with a sample 8 hours back. Without it there is no price change, so the answer is a 503 (not billed). Every other
// part (funding radar, liquidation tape and heatmap, macro calendar, Fear and Greed) that is stale or missing is left out and named in stale_parts.
'use strict';
const E = require('./engine');
const S = require('./sources');
const { MAX_AGE_S } = require('./config');
const { levelOf } = E;

const WINDOW_S = 8 * 3600;
const HISTORY_S = 7 * 86400;
const MIN_WINDOWS = 24;              // fewer comparable 8-hour windows than this and a move cannot be called unusual
const Z_RULE = 2;                    // a price or open-interest move beyond 2 standard deviations of its own 8-hour moves
const LIQ_HOURLY_FLOOR_USD = 5000;   // the floor signal-board puts under a quiet coin's hourly liquidation baseline (tools/signals.js Z_FLOOR_USD)
const T = S.T;                       // marketstate's THRESHOLDS: funding_extreme_abs_z, liq_spike_multiple, liq_spike_window_h
const FG_LOW = 25, FG_HIGH = 75;

const METHOD = [
  'Window: the last 8 hours up to the newest sample of our 5-minute Hyperliquid sampler.',
  'Abnormality score: 1.0 means an item just meets its rule; items are ordered by it.',
  `Price and open-interest moves: the 8-hour change in standard deviations of that coin's own 8-hour changes over the sampler's last 7 days (needs ${MIN_WINDOWS} comparable windows, the count is in each item's numbers); rule ${Z_RULE} standard deviations, score = |z| / ${Z_RULE}. Open interest is in coin units, so a price move is not counted as new positions.`,
  `Funding: |z_30d| from the funding radar (the coin's current 8-hour-equivalent rate against its own settled 30 days); rule ${T.funding_extreme_abs_z}, the funding_extreme_abs_z of /api/market-state; score = |z| / ${T.funding_extreme_abs_z}.`,
  `Liquidations: the 8-hour total against 8 times the median hourly total of the previous ${T.liq_spike_window_h - 1} completed hours of our tape (hourly floor $${LIQ_HOURLY_FLOOR_USD}); rule ${T.liq_spike_multiple} times, the liq_spike_multiple of /api/market-state; score = multiple / ${T.liq_spike_multiple}.`,
  'Macro: FOMC, CPI, NFP and PCE releases dated today (UTC) in our calendar; score 1.0 within 8 hours before or after the release, 0.4 later today.',
  `Fear and Greed: score |value - 50| / 25, shown as an item only at ${FG_LOW} or below and ${FG_HIGH} or above.`,
  'A part older than its limit, or missing, is null and listed in stale_parts. The level to watch is the nearest band, above or below the mark, holding at least 10% of the last 24 hours of liquidations on that coin: where leverage was flushed, not a forecast.',
  'The text is templates filled from these numbers; there is no language model and nothing is invented. It describes what moved and never what to trade.',
].join(' ');

const hourlyBaseline = (buckets, nowMs) => {
  const curHour = Math.floor(nowMs / 3_600_000) * 3_600_000;
  const by = new Map(buckets.map((b) => [b.bucket, b.usd_total || 0]));
  const hourly = [];
  for (let t = curHour - (T.liq_spike_window_h - 1) * 3_600_000; t < curHour; t += 3_600_000) hourly.push(by.get(t) || 0);
  return Math.max(E.median(hourly) || 0, LIQ_HOURLY_FLOOR_USD);
};

async function getMorningBrief(_p = {}, { now = Date.now(), deps = S.real } = {}) {
  const col = E.collector(now);

  // ---- core
  let win;
  try { win = deps.oiWindow(now, [WINDOW_S]); } catch (e) { throw e.status === 503 ? e : E.unavailable(`morning-brief: ${e.message}`, 300); }
  if (!win.value.back[WINDOW_S]) throw E.unavailable('morning-brief: our open-interest record has no sample 8 hours back yet (or has a gap there).', 600);
  col.use(win.name, win.as_of_ms);
  const cur = win.value.cur, back = win.value.back[WINDOW_S];
  const coins = S.SYMBOLS.filter((c) => cur.has(c) && back.has(c) && cur.get(c).mark > 0 && back.get(c).mark > 0);
  for (const c of S.SYMBOLS) if (!coins.includes(c)) col.stale.push({ part: `${c} sampler row`, reason: 'missing in the newest sample or 8 hours back' });
  if (!coins.length) throw E.unavailable('morning-brief: none of BTC, ETH, SOL and HYPE is in our sampler.', 300);

  // ---- optional parts
  const tape = await col.take('liquidation tape', S.TAPE_STALE_S, () => deps.tapeAsOf());
  const macro = await col.take('macro calendar', null, () => deps.macroDay(now));
  const fg = await col.take('fear and greed', MAX_AGE_S.fear_greed, () => deps.fearGreed());
  const asOf = E.iso(win.as_of_ms);
  const items = [];
  const table = {};

  for (const c of coins) {
    const sym = S.tapeSymbol(c);
    const a = cur.get(c), b = back.get(c);
    const chg = (a.mark / b.mark - 1) * 100;
    const oiChg = b.oi > 0 ? (a.oi / b.oi - 1) * 100 : null;
    const series = deps.oiSeries(c, HISTORY_S, now);
    const pz = E.windowChanges(series, 'mark', WINDOW_S);
    const oz = E.windowChanges(series, 'oi', WINDOW_S);
    const zOf = (change, ws) => { const s = ws.length >= MIN_WINDOWS ? E.sd(ws) : null; return s ? { z: (change / 100) / s, n: ws.length } : { z: null, n: ws.length }; };
    const pj = zOf(chg, pz), oj = oiChg == null ? { z: null, n: oz.length } : zOf(oiChg, oz);
    const fundAnn = a.funding == null ? null : a.funding * 24 * 365 * 100;

    const radar = await col.take(`${c} funding z-score`, S.RADAR_STALE_S, () => deps.radarRow(`${c}USDT`, now));
    const fz = radar && radar.venues && radar.venues.hyperliquid && radar.venues.hyperliquid.z_30d != null ? radar.venues.hyperliquid.z_30d : null;

    let liq = null;
    if (tape != null) {
      const bk = await col.take(`${c} liquidations`, null, () => ({ value: { b8: deps.liqBuckets(sym, 8, 5), b168: deps.liqBuckets(sym, T.liq_spike_window_h, 60) }, as_of_ms: tape }));
      if (bk) {
        const sum = (k) => bk.b8.reduce((t, x) => t + (x[k] || 0), 0);
        const total = sum('usd_total'), longs = sum('longs_usd'), shorts = sum('shorts_usd');
        const base = hourlyBaseline(bk.b168, now);
        liq = { total, longs, shorts, biggest: bk.b8.reduce((m, x) => Math.max(m, x.biggest_print || 0), 0), multiple: total / (8 * base), prints: sum('prints') };
      }
    }
    const level = tape != null ? levelOf(deps.clusters(sym, a.mark), a.mark) : null;
    if (tape != null && !level) col.stale.push({ part: `${c} liquidation heatmap`, reason: 'no cluster holding 10% of the last 24 hours of liquidations around the mark' });

    table[c] = {
      mark: E.r(a.mark, 6), change_8h_pct: E.r(chg), price_windows_n: pj.n, price_z: E.r(pj.z),
      oi_change_8h_pct: E.r(oiChg), oi_windows_n: oj.n, oi_z: E.r(oj.z),
      funding_annualised_pct: E.r(fundAnn), funding_z_30d: E.r(fz),
      liquidations_8h_usd: liq ? Math.round(liq.total) : null, liquidated_longs_share_pct: liq && liq.total > 0 ? E.r((liq.longs / liq.total) * 100, 1) : null,
      biggest_liquidation_usd: liq ? Math.round(liq.biggest) : null, liquidations_vs_usual: liq ? E.r(liq.multiple) : null,
    };
    const src = (extra) => `${win.name}${extra ? '; ' + extra : ''}`;

    // 1. the move: always an item, so a quiet morning still says what each coin did
    const dir = chg >= 0 ? 'up' : 'down';
    const moveWhat = `${c} ${E.pct(chg)} over 8 hours to ${E.px(a.mark)}` + (pj.z != null ? `, ${E.num(Math.abs(pj.z))} standard deviations of its usual 8-hour move` : ', with too little history to call it usual or unusual');
    const big = pj.z != null && Math.abs(pj.z) >= Z_RULE;
    items.push({
      what: moveWhat,
      why_it_matters: big
        ? `This is a larger 8-hour move than ${c} usually makes: it is beyond ${Z_RULE} standard deviations of its last 7 days of 8-hour moves.`
        : pj.z != null ? `${c} is ${dir} but inside the range of its last 7 days of 8-hour moves.` : `${c}'s record is too short to compare this move with its usual 8-hour moves.`,
      level_to_watch: level,
      numbers: { change_8h_pct: E.r(chg), price_z: E.r(pj.z), windows_n: pj.n, mark: E.r(a.mark, 6), funding_annualised_pct: E.r(fundAnn), oi_change_8h_pct: E.r(oiChg) },
      source: src(), as_of: asOf, abnormality: pj.z != null ? Math.abs(pj.z) / Z_RULE : 0.25,
    });

    // 2. open interest
    if (oj.z != null && Math.abs(oj.z) >= Z_RULE) {
      items.push({
        what: `${c} open interest ${E.pct(oiChg)} in 8 hours, counted in coins`,
        why_it_matters: oiChg > 0 ? `Open interest in coins rose, so positions were added rather than only closed: the move came with new leverage.` : `Open interest in coins fell, so positions were closed: the move came with leverage coming out.`,
        level_to_watch: level, numbers: { oi_change_8h_pct: E.r(oiChg), oi_z: E.r(oj.z), windows_n: oj.n, price_change_8h_pct: E.r(chg) },
        source: src(), as_of: asOf, abnormality: Math.abs(oj.z) / Z_RULE,
      });
    }
    // 3. funding
    if (fz != null && Math.abs(fz) >= T.funding_extreme_abs_z) {
      items.push({
        what: `${c} funding is ${E.num(Math.abs(fz))} standard deviations ${fz > 0 ? 'above' : 'below'} its own 30-day norm${fundAnn == null ? '' : ` (${E.pct(fundAnn, 0)} a year)`}`,
        why_it_matters: fz > 0 ? `Longs are paying shorts an unusually high rate to hold their positions: the long side is crowded.` : `Shorts are paying longs an unusually high rate to hold their positions: the short side is crowded.`,
        level_to_watch: level, numbers: { funding_z_30d: E.r(fz), funding_annualised_pct: E.r(fundAnn), samples: radar.venues.hyperliquid.samples },
        source: `AgentFeed funding radar snapshot (30-day z-scores); ${win.name}`, as_of: asOf, abnormality: Math.abs(fz) / T.funding_extreme_abs_z,
      });
    }
    // 4. liquidations
    if (liq && liq.total > 0 && liq.multiple >= T.liq_spike_multiple) {
      const lshare = (liq.longs / liq.total) * 100;
      items.push({
        what: `${c} saw ${E.usd(liq.total)} liquidated in 8 hours, ${E.num(liq.multiple)} times its usual, ${E.num(lshare, 0)}% of it longs`,
        why_it_matters: lshare >= 60 ? `Mostly long positions were forced closed, the largest single print ${E.usd(liq.biggest)}: leverage on the long side was flushed.` : lshare <= 40 ? `Mostly short positions were forced closed, the largest single print ${E.usd(liq.biggest)}: leverage on the short side was flushed.` : `Both sides were forced closed, the largest single print ${E.usd(liq.biggest)}.`,
        level_to_watch: level, numbers: { total_usd: Math.round(liq.total), longs_usd: Math.round(liq.longs), shorts_usd: Math.round(liq.shorts), biggest_usd: Math.round(liq.biggest), multiple: E.r(liq.multiple), prints: liq.prints },
        source: 'AgentFeed liquidation tape (Bybit, OKX, Binance prints; sums and extremes only)', as_of: E.iso(tape), abnormality: liq.multiple / T.liq_spike_multiple,
      });
    }
  }

  // 5. macro events today
  if (macro) {
    for (const ev of macro.events) {
      const dt = (Date.parse(ev.utc) - now) / 3_600_000;
      const near = Math.abs(dt) <= 8;
      items.push({
        what: `${ev.type} ${dt >= 0 ? `scheduled at ${E.clock(Date.parse(ev.utc))}, in ${E.num(dt)} hours` : `released at ${E.clock(Date.parse(ev.utc))}, ${E.num(-dt)} hours ago`}: ${ev.title}`,
        why_it_matters: dt >= 0 ? 'Scheduled releases are when prices and funding most often move together; a move around this time has a known cause.' : 'A move since this release has a known cause; one that began before it did not.',
        numbers: { utc: ev.utc, hours_from_now: E.r(dt, 1) }, source: `AgentFeed macro calendar (${ev.source_url})`, as_of: asOf, abnormality: near ? 1 : 0.4,
      });
    }
  }
  // 6. Fear and Greed, only at the extremes; the value is always in `context`
  if (fg && (fg.value <= FG_LOW || fg.value >= FG_HIGH)) {
    items.push({
      what: `Fear and Greed reads ${fg.value} (${fg.classification})`,
      why_it_matters: fg.value <= FG_LOW ? 'The index sits in its fear zone: sentiment is one-sided, which is when moves tend to be sharper.' : 'The index sits in its greed zone: sentiment is one-sided, which is when moves tend to be sharper.',
      numbers: { value: fg.value, classification: fg.classification }, source: 'alternative.me Fear & Greed Index (https://alternative.me/crypto/fear-and-greed-index/)', as_of: asOf, abnormality: Math.abs(fg.value - 50) / 25,
    });
  }

  return E.envelope({
    brief: 'morning-brief', now,
    window: { hours: 8, from: E.iso(win.as_of_ms - WINDOW_S * 1000), to: asOf },
    items, col, method: METHOD, emptyHeadline: 'No data to summarise.',
    extra: { coins: table, context: { fear_greed: fg ? { value: fg.value, classification: fg.classification } : null, macro_today: macro ? macro.events.length : null } },
  });
}

module.exports = { getMorningBrief, METHOD, WINDOW_S, Z_RULE };
