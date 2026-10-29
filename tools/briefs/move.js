// tools/briefs/move.js: GET /api/move-alert (get_move_alert). Unusual moves across the Hyperliquid perp universe, by LineWatch's method
// (github.com/seekdaseek/linewatch detect.js): the threshold is MEASURED from each coin's own move distribution, in tiers, and a move that has a
// scheduled cause is labelled as such instead of as unexplained flow. LineWatch's exclusion is "in-running"; the perp version is a scheduled macro
// release (FOMC, CPI, NFP, PCE) inside the move's window.
//
// PRICE: per coin and per horizon (5 minutes, 1 hour, 4 hours) the tails come from tools/briefs/calibration.json, built by bin/brief-calibrate.js from
// Hyperliquid's public candles: notable = p99, sharp = the highest supported quantile up to p99.9, extreme = larger than every window in the sample
// (p99.99 needs 100,000 windows). n and the effective quantiles are printed in `method` and in every item.
// OPEN INTEREST (coin units): tonight's tiers come from the logic /api/oi-spike-scan already uses (the 1 h change against the coin's previous day, a
// z-score); the sampler's 7 days are too short to calibrate p99.9, and recalibrating on the box's own record is a later step. The z cut-offs below are
// PROPOSED, not measured.
//
// CORE: the sampler (the latest mark of every coin) and a calibration table younger than MAX_AGE_S.calibration; without them the answer is a 503.
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./engine');
const S = require('./sources');
const { MAX_AGE_S } = require('./config');

const HORIZONS = [{ id: '5m', s: 300, label: '5 minutes', each: '5-minute' }, { id: '1h', s: 3600, label: '1 hour', each: 'hourly' }, { id: '4h', s: 14400, label: '4 hours', each: '4-hour' }];
const TIERS = ['notable', 'sharp', 'extreme'];
// The tier the route surfaces. Set from the replay (REPORT): at 'notable' the route fires far too often to be a signal.
const MIN_TIER = 'sharp';
const OI_Z = { notable: 3, sharp: 4, extreme: 5 };    // PROPOSED, uncalibrated (see the header)
const OI_MIN_USD = 3_000_000;                         // the oi-spike-scan floor: dust markets are ignored
const OI_MIN_1H_PCT = 1;                              // oi-spike-scan: a 1 h change under 1% is noise whatever its z
const EVENT_BEFORE_S = 15 * 60;                       // a scheduled release explains moves from 15 minutes before it ...
const EVENT_AFTER_S = 2 * 3600;                       // ... to 2 hours after it
const MAX_ITEMS = 12;

let _cal = null;
function loadCalibration() {
  const file = process.env.BRIEF_CALIBRATION || path.join(__dirname, 'calibration.json');
  const st = fs.statSync(file);
  if (!_cal || _cal.mtimeMs !== st.mtimeMs || _cal.file !== file) _cal = { file, mtimeMs: st.mtimeMs, doc: JSON.parse(fs.readFileSync(file, 'utf8')) };
  return { value: _cal.doc, as_of_ms: Date.parse(_cal.doc.fetched_at), name: `Hyperliquid candle tails (${_cal.doc.source})` };
}

const rank = (t) => TIERS.indexOf(t);
function tierOf(absPct, cal) {
  if (absPct >= cal.extreme_pct) return 'extreme';
  if (absPct >= cal.sharp_pct) return 'sharp';
  if (absPct >= cal.notable_pct) return 'notable';
  return null;
}
function oiTierOf(absZ) { return absZ >= OI_Z.extreme ? 'extreme' : absZ >= OI_Z.sharp ? 'sharp' : absZ >= OI_Z.notable ? 'notable' : null; }

const qLabel = (cal, tier) => {
  if (tier === 'extreme') return cal.extreme_basis === 'sample_max' ? `every one of its last ${cal.n}` : `${(0.9999 * 100).toFixed(2)}% of its last ${cal.n}`;
  const q = tier === 'notable' ? cal.q_notable : cal.q_sharp;
  return `${(q * 100).toFixed(1)}% of its last ${cal.n}`;
};

/** the first scheduled release whose window [t - 15 min, t + 2 h] meets the move's window [fromS, toS] (epoch seconds), or null */
function eventFor(events, fromS, toS) {
  for (const ev of events) {
    const t = Date.parse(ev.utc) / 1000;
    if (t - EVENT_BEFORE_S <= toS && t + EVENT_AFTER_S >= fromS) return ev;
  }
  return null;
}

function method(calDoc, calCoins, minTier) {
  const ns = {}; const qs = new Set();
  for (const c of Object.values(calCoins)) for (const h of HORIZONS) if (c[h.id]) { (ns[h.id] ||= []).push(c[h.id].n); qs.add(`${h.id} sharp p${(c[h.id].q_sharp * 100).toFixed(1)}`); }
  const nr = (id) => (ns[id] ? (Math.min(...ns[id]) === Math.max(...ns[id]) ? `${ns[id][0]}` : `${Math.min(...ns[id])} to ${Math.max(...ns[id])}`) : 'none');
  return [
    `Price tails are measured per coin from Hyperliquid's public candles (${calDoc.docs && calDoc.docs[0]}), fetched ${calDoc.fetched_at}: the close-to-close change of every complete 5-minute, 1-hour and 4-hour candle, one window per candle (they do not overlap). Sample size n per coin, in windows: ${HORIZONS.map((h) => `${h.id} ${nr(h.id)}`).join('; ')}.`,
    `Tiers: notable = the coin's own p99, sharp = the highest quantile with at least ${calDoc.min_exceedances} windows beyond it, up to p99.9 (${[...qs].sort().join(', ')}), extreme = larger than every window in the sample (p99.99 needs 100,000 windows). The effective quantile and n are printed in every item. The route shows moves at the ${minTier} tier and above.`,
    `A move is the latest sampler mark against the sample 5 minutes, 1 hour and 4 hours earlier; each coin shows the horizon with the highest ratio to its notable threshold.`,
    `Event-driven: a move whose window meets a scheduled FOMC, CPI, NFP or PCE release from ${EVENT_BEFORE_S / 60} minutes before it to ${EVENT_AFTER_S / 3600} hours after it is labelled event_driven with the release named; otherwise it is unexplained by the calendar. This is LineWatch's in-running exclusion for perps.`,
    `Open interest (coin units): the 1-hour change against the coin's own previous day, as /api/oi-spike-scan measures it (z-score; coins above $${OI_MIN_USD / 1e6}M of open interest, 1-hour change of at least ${OI_MIN_1H_PCT}%); tiers at |z| ${OI_Z.notable}, ${OI_Z.sharp}, ${OI_Z.extreme} are proposed and not yet calibrated on our own record (a later step), so open-interest items are labelled by that rule only.`,
    `Abnormality score: price = |change| / the coin's notable threshold for that horizon; open interest = |z| / ${OI_Z.notable}. Coverage: only coins in the calibration table are checked.`,
    'The text is templates filled from these numbers; there is no language model. It describes what moved and never what to trade.',
  ].join(' ');
}

async function getMoveAlert(_p = {}, { now = Date.now(), deps = S.real, calibration = loadCalibration, minTier = MIN_TIER } = {}) {
  const col = E.collector(now);
  // ---- core
  let win;
  try { win = deps.oiWindow(now, HORIZONS.map((h) => h.s)); } catch (e) { throw e.status === 503 ? e : E.unavailable(`move-alert: ${e.message}`, 300); }
  let cal;
  try { cal = calibration(); } catch (e) { throw E.unavailable(`move-alert: the calibration table cannot be read (${e.message}).`, 600); }
  const calAge = Math.round((now - cal.as_of_ms) / 1000);
  if (calAge > MAX_AGE_S.calibration) throw E.unavailable(`move-alert: the calibration table is ${Math.round(calAge / 86400)} days old (limit ${MAX_AGE_S.calibration / 86400}).`, 3600);
  col.use(win.name, win.as_of_ms);
  col.sources.push({ name: cal.name, as_of: E.iso(cal.as_of_ms), age_s: calAge });
  const usable = HORIZONS.filter((h) => win.value.back[h.s]);
  for (const h of HORIZONS) if (!usable.includes(h)) col.stale.push({ part: `${h.label} baseline`, reason: 'the open-interest record has a gap at that distance back' });
  if (!usable.length) throw E.unavailable('move-alert: our sampler has no baseline for any horizon.', 300);

  const calCoins = cal.value.coins;
  const cur = win.value.cur;
  const asOf = E.iso(win.as_of_ms);
  const macro = await col.take('macro calendar', null, () => deps.macroDay(now));
  const events = macro ? macro.all : [];
  const lastS = win.value.last_ts;

  // ---- price tails
  const found = [];
  let checked = 0;
  for (const coin of Object.keys(calCoins)) {
    const a = cur.get(coin);
    if (!a || !(a.mark > 0)) continue;
    checked++;
    let best = null;
    for (const h of usable) {
      const cc = calCoins[coin][h.id];
      const b = win.value.back[h.s].get(coin);
      if (!cc || !b || !(b.mark > 0)) continue;
      const chg = (a.mark / b.mark - 1) * 100;
      const tier = tierOf(Math.abs(chg), cc);
      if (!tier) continue;
      const cand = { coin, h, chg, tier, cc, score: Math.abs(chg) / cc.notable_pct, from: b.mark, mark: a.mark, oi: b.oi > 0 ? (a.oi / b.oi - 1) * 100 : null };
      if (!best || cand.score > best.score) best = cand;
    }
    if (best && rank(best.tier) >= rank(minTier)) found.push(best);
  }

  // ---- open interest, by the spike scan's own logic (optional part)
  const spike = await col.take('open-interest spikes', null, () => deps.spikes(now));
  const oiFound = [];
  if (spike) {
    for (const row of spike.spikes || []) {
      if (row.spike_z == null) continue;
      const tier = oiTierOf(Math.abs(row.spike_z));
      if (tier && rank(tier) >= rank(minTier) && Math.abs(row.oi_usd) >= OI_MIN_USD) oiFound.push({ row, tier });
    }
  }

  // ---- items, strongest first, bounded
  const ranked = [
    ...found.map((f) => ({ kind: 'price', score: f.score, f })),
    ...oiFound.map((o) => ({ kind: 'oi', score: Math.abs(o.row.spike_z) / OI_Z.notable, o })),
  ].sort((x, y) => y.score - x.score).slice(0, MAX_ITEMS);

  const items = [];
  for (const k of ranked) {
    if (k.kind === 'price') {
      const { coin, h, chg, tier, cc, mark, from, oi } = k.f;
      const ev = macro ? eventFor(events, lastS - h.s, lastS) : null;
      const lvl = E.levelOf(deps.clusters(S.tapeSymbol(coin), mark), mark);
      items.push({
        what: `${coin} ${E.pct(chg, 2)} in ${h.label}: a ${tier} move, larger than ${qLabel(cc, tier)} ${h.each} moves`,
        why_it_matters: !macro
          ? 'The macro calendar could not be read, so this move cannot be checked against scheduled releases.'
          : ev
            ? `${ev.type} (${E.clock(Date.parse(ev.utc))}) falls inside this window, so the move has a scheduled cause rather than unexplained flow.`
            : `No scheduled release falls inside this window, so the calendar does not explain it${oi == null ? '' : `; open interest in coins changed ${E.pct(oi)} over the same ${h.label}`}.`,
        level_to_watch: lvl,
        numbers: { horizon: h.id, change_pct: E.r(chg, 3), from_mark: E.r(from, 6), mark: E.r(mark, 6), tier, label: !macro ? 'event_status_unknown' : ev ? 'event_driven' : 'unexplained', event: ev ? { type: ev.type, utc: ev.utc } : null,
          threshold_pct: { notable: cc.notable_pct, sharp: cc.sharp_pct, extreme: cc.extreme_pct }, effective_quantile: { notable: cc.q_notable, sharp: cc.q_sharp, extreme: cc.extreme_basis }, n: cc.n, oi_change_pct: E.r(oi) },
        source: `${win.name}; ${cal.name}`, as_of: asOf, abnormality: k.score,
      });
    } else {
      const { row, tier } = k.o;
      const ev = macro ? eventFor(events, lastS - 3600, lastS) : null;
      const m0 = (cur.get(row.coin) || {}).mark;
      const lvl = m0 > 0 ? E.levelOf(deps.clusters(S.tapeSymbol(row.coin), m0), m0) : null;
      items.push({
        what: `${row.coin} open interest ${E.pct(row.oi_change_1h_pct)} in 1 hour, counted in coins: a ${tier} change (z ${E.num(row.spike_z)} against its previous day)`,
        why_it_matters: !macro
          ? 'The macro calendar could not be read, so this change cannot be checked against scheduled releases.'
          : ev
            ? `${ev.type} (${E.clock(Date.parse(ev.utc))}) falls inside this window, so the change has a scheduled cause.`
            : row.oi_change_1h_pct > 0 ? `Positions were added faster than this coin usually adds them, and no scheduled release explains it.` : `Positions were closed faster than this coin usually closes them, and no scheduled release explains it.`,
        level_to_watch: lvl,
        numbers: { oi_change_1h_pct: row.oi_change_1h_pct, oi_change_4h_pct: row.oi_change_4h_pct, oi_change_24h_pct: row.oi_change_24h_pct, spike_z: row.spike_z, oi_usd: row.oi_usd, price_change_1h_pct: row.price_change_1h_pct, tier, label: !macro ? 'event_status_unknown' : ev ? 'event_driven' : 'unexplained', event: ev ? { type: ev.type, utc: ev.utc } : null },
        source: spike ? 'AgentFeed open-interest spike scan (sampler)' : win.name, as_of: asOf, abnormality: k.score,
      });
    }
  }

  return E.envelope({
    brief: 'move-alert', now,
    window: { horizons: HORIZONS.map((h) => h.id), to: asOf },
    items, col, method: method(cal.value, calCoins, minTier),
    emptyHeadline: `No move at the ${minTier} tier or above in the last 4 hours across ${checked} coins: each is inside its own measured range.`,
    extra: { coins_checked: checked, min_tier: minTier, calibration: { fetched_at: cal.value.fetched_at, source: cal.value.source } },
  });
}

module.exports = { getMoveAlert, tierOf, oiTierOf, eventFor, HORIZONS, TIERS, MIN_TIER, OI_Z, EVENT_BEFORE_S, EVENT_AFTER_S, loadCalibration, method };
