// tools/overhang.js — exit-liquidity measurements from the overhang collector's tape.
//
// WHAT THIS SELLS. A lending protocol marks collateral at an oracle price. A liquidator
// only acts if the liquidation bonus it earns beats what it costs to actually get out of
// that collateral. overhang quotes real sell clips into USDC against live routing and
// compares the proceeds with the marked value, so the number returned here is what a
// seizer would actually realise, not what the protocol says the collateral is worth.
//
// READONLY, DELIBERATELY. The tape is written by a cron collector every 15 minutes.
// This paid read path must never be able to write to its own evidence, so the handle is
// opened exactly as tools/liquidations.js opens the liquidation tape.
'use strict';
const Database = require('better-sqlite3');
// Path is overridable ONLY so the *_unconfirmed fallback branch can be exercised
// against a throwaway copy: the live tape has never contained such a row. readonly and
// fileMustExist apply regardless of where it points, so an override cannot grant writes.
const DB_PATH = process.env.OVERHANG_DB_PATH || '/opt/overhang/overhang.db';
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// GATE. Rows before this timestamp came from a window where the collector read the mark
// off disk instead of refetching it, so the whole board sat frozen at one value for six
// days. They are not a measurement of anything. Every query in this file applies it.
const GATE_TS = 1786406400;                    // 2026-08-11T00:00:00Z

// A terminal verdict is withheld as *_unconfirmed until the symbol's own tape agrees with
// it. Those rows carry max_exitable_usd NULL BY DESIGN — they are not missing data, they
// are a measurement the collector declined to publish on one sample.
const UNCONFIRMED = ['no_route_unconfirmed', 'not_tradable_unconfirmed', 'unliquidatable_unconfirmed'];
const isUnconfirmed = (s) => UNCONFIRMED.includes(s);

const n2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const n6 = (x) => (x == null ? null : Math.round(x * 1e6) / 1e6);

const ROW_COLS = `
  r.id, r.sweep_id, r.ts, r.protocol, r.market, r.symbol, r.mint,
  r.oracle_price, r.oracle_source, r.oracle_age_sec, r.mark_generated_at,
  r.marked_usd, r.max_exitable_usd, r.exitable_fraction, r.max_exitable_cons_usd,
  r.unbacked_usd_lb, r.resolution_usd, r.status, r.session,
  r.liq_bonus_bps, r.liq_bonus_min_bps, r.liq_bonus_max_bps,
  r.floor_observation, r.corroboration,
  v.observation, v.refusal_reason`;

// LEFT JOIN: the adjudication view deliberately excludes rows carrying no observation
// (measurement_failed, no_ladder), and those rows must still be answerable.
const latestRow = db.prepare(`
  SELECT ${ROW_COLS} FROM reserves r
  LEFT JOIN reserves_adjudicated v ON v.id = r.id
  WHERE r.symbol = ? AND r.ts >= ${GATE_TS}
  ORDER BY r.ts DESC LIMIT 1`);

// The most recent row the collector was willing to stand behind.
const latestCorroborated = db.prepare(`
  SELECT ${ROW_COLS} FROM reserves r
  LEFT JOIN reserves_adjudicated v ON v.id = r.id
  WHERE r.symbol = ? AND r.ts >= ${GATE_TS}
    AND r.status NOT IN (${UNCONFIRMED.map(() => '?').join(',')})
    AND r.max_exitable_usd IS NOT NULL
  ORDER BY r.ts DESC LIMIT 1`);

const clipsFor = db.prepare(`
  SELECT size_usd, routed, realised_usd, haircut_bps, liq_margin_bps, reason
  FROM quotes WHERE reserve_id = ? ORDER BY size_usd ASC`);

const symbolsStmt = db.prepare(`SELECT DISTINCT symbol FROM reserves WHERE ts >= ${GATE_TS} ORDER BY symbol`);

function resolveSymbol(s) {
  if (!s) throw new Error('symbol is required (e.g. SPYx, cbBTC, FWDI). Call get_exit_method (free) for the covered list.');
  const want = String(s).trim().toLowerCase();
  const all = symbolsStmt.all().map((r) => r.symbol);
  const hit = all.find((x) => x.toLowerCase() === want);
  if (!hit) throw new Error(`unknown symbol '${s}'. Covered: ${all.join(', ')}`);
  return hit;
}

/**
 * WHY the exit is blocked, when it is. A liquidator must never read these two as the
 * same fact: one is a statement about the book, the other is a statement about the
 * router's token list.
 */
function exitMechanism(row) {
  const obs = row.observation || row.floor_observation;
  if (row.status === 'not_tradable_any_size' || row.status === 'not_tradable_unconfirmed' || obs === 'not_tradable') {
    return {
      mechanism: 'router_refusal',
      is_liquidity_finding: false,
      wire_reason: 'TOKEN_NOT_TRADABLE',
      detail: 'The primary router refuses to quote this token at all, at any size. Nothing was learned about depth because nothing was ever offered. This is a permissioning / listing fact, NOT illiquidity, and must not be read as an empty book.',
    };
  }
  if (row.status === 'no_route_any_size' || row.status === 'no_route_unconfirmed' || obs === 'no_route') {
    return {
      mechanism: 'no_route_found',
      is_liquidity_finding: true,
      wire_reason: 'NO_ROUTES_FOUND',
      detail: 'A route was sought at the smallest clip tested and none was found. The token IS quotable; the book had no path. This is a liquidity finding.',
    };
  }
  if (row.status === 'unliquidatable_at_smallest_tested' || row.status === 'unliquidatable_unconfirmed') {
    return {
      mechanism: 'negative_liquidator_margin',
      is_liquidity_finding: true,
      wire_reason: null,
      detail: 'The smallest clip tested DID route, but the haircut exceeded the liquidation bonus, so a rational liquidator declines. The debt sits and the protocol carries it.',
    };
  }
  return null;
}

/**
 * The nearest clip the bisection ACTUALLY probed. quotes stores the rungs it walked, so
 * an exact match for a caller's size is usually absent. Never interpolated: the returned
 * numbers are the measured ones, and the response says which clip they belong to.
 */
function nearestClip(reserveId, targetUsd) {
  const clips = clipsFor.all(reserveId);
  if (!clips.length) return null;
  let best = clips[0];
  for (const c of clips) if (Math.abs(c.size_usd - targetUsd) < Math.abs(best.size_usd - targetUsd)) best = c;
  const exact = Math.abs(best.size_usd - targetUsd) < 0.5;
  return {
    requested_size_usd: n2(targetUsd),
    measured_clip_usd: n2(best.size_usd),
    is_exact_match: exact,
    routed: !!best.routed,
    realised_usd: n2(best.realised_usd),
    haircut_bps: n2(best.haircut_bps),
    liq_margin_bps: n2(best.liq_margin_bps),
    reason: best.reason || null,
    clips_measured_usd: clips.map((c) => n2(c.size_usd)),
    note: exact
      ? `Exact measured clip at $${n2(best.size_usd)}.`
      : `No clip was probed at $${n2(targetUsd)}. These figures are the MEASURED clip at $${n2(best.size_usd)}, the nearest the bisection actually quoted. Not interpolated.`,
  };
}

function shapeMeasurement(row) {
  return {
    as_of: row.ts,
    as_of_utc: new Date(row.ts * 1000).toISOString(),
    session: row.session,
    marked_usd: n2(row.marked_usd),
    oracle_price: n6(row.oracle_price),
    oracle_source: row.oracle_source,
    oracle_age_sec: row.oracle_age_sec,
    mark_generated_at: row.mark_generated_at,
    mark_is_live: row.mark_generated_at != null && Math.abs(row.mark_generated_at - row.ts) <= 120,
    max_exitable_usd: n2(row.max_exitable_usd),
    exitable_fraction: n6(row.exitable_fraction),
    max_exitable_cons_usd: n2(row.max_exitable_cons_usd),
    unbacked_usd_lower_bound: n2(row.unbacked_usd_lb),
    resolution_usd: n2(row.resolution_usd),
    status: row.status,
    observation: row.observation || row.floor_observation || null,
    corroboration: row.corroboration || null,
    liq_bonus_bps_assumed: row.liq_bonus_bps,
    liq_bonus_min_bps: row.liq_bonus_min_bps,
    liq_bonus_max_bps: row.liq_bonus_max_bps,
  };
}

function getExitQuote(req) {
  const q = (req && req.query) || {};
  const symbol = resolveSymbol(q.symbol);
  const nowSec = Math.floor(Date.now() / 1000);

  const current = latestRow.get(symbol);
  if (!current) {
    return {
      symbol, source: 'overhang', gated_from_ts: GATE_TS,
      answer_available: false,
      reason: `no measurement for ${symbol} inside the valid window (ts >= ${GATE_TS}).`,
    };
  }

  // RESPONSE POLICY. max_exitable_usd is never returned as a bare null.
  //   *_unconfirmed rows carry NULL by design -> fall back to the last measurement the
  //   collector stood behind, and SAY it is a fallback plus how old it is. A caller can
  //   act on "14.1% exitable, measured 22 minutes ago, current sample unconfirmed".
  //   They cannot act on null.
  let basis = current;
  let confidence = 'measured';
  let currentSampleNote = null;

  if (isUnconfirmed(current.status) || current.max_exitable_usd == null) {
    const fb = latestCorroborated.get(symbol, ...UNCONFIRMED);
    if (fb) {
      basis = fb;
      confidence = 'last_corroborated';
      currentSampleNote = {
        as_of: current.ts,
        status: current.status,
        observation: current.observation || current.floor_observation || null,
        corroboration: current.corroboration || null,
        why_withheld: 'The current sweep saw a terminal-looking floor sample that the symbol\'s own recent tape contradicts. A single sample is never sufficient for a terminal verdict, so the verdict is withheld rather than published. The figures below are the last measurement that WAS corroborated.',
      };
    } else {
      return {
        symbol, source: 'overhang', gated_from_ts: GATE_TS,
        answer_available: false,
        confidence: 'none',
        current_sample: { as_of: current.ts, status: current.status },
        reason: `${symbol} has no corroborated measurement inside the valid window. The most recent sample is ${current.status}, whose verdict is withheld pending corroboration, and there is no earlier corroborated row to fall back to. This is stated explicitly rather than returned as null.`,
      };
    }
  }

  const m = shapeMeasurement(basis);
  const mech = exitMechanism(basis);

  // Default target: the boundary itself is the most informative clip. If nothing exits,
  // the floor clip is what was actually tested.
  const requested = q.size_usd != null && q.size_usd !== '' ? Number(q.size_usd) : null;
  if (requested != null && (!Number.isFinite(requested) || requested <= 0)) {
    throw new Error('size_usd must be a positive number of US dollars');
  }
  const target = requested != null ? requested : (m.max_exitable_usd > 0 ? m.max_exitable_usd : 1000);

  return {
    source: 'overhang',
    what_this_answers: 'If I seize this collateral and sell it, what do I actually get, and does the liquidation bonus cover the cost of selling?',
    symbol: basis.symbol,
    protocol: basis.protocol,
    market: basis.market,
    mint: basis.mint,
    gated_from_ts: GATE_TS,

    // 'measured' = this sweep. 'last_corroborated' = the current sample's verdict is
    // withheld and these figures are the most recent one the collector stood behind.
    confidence,
    measurement_age_sec: nowSec - basis.ts,
    current_sample_withheld: currentSampleNote,

    measurement: m,
    exit_blocked: mech,
    nearest_measured_clip: nearestClip(basis.id, target),

    liquidation_bonus_band: {
      min_bps: basis.liq_bonus_min_bps,
      max_bps: basis.liq_bonus_max_bps,
      assumed_bps: basis.liq_bonus_bps,
      note: 'Kamino publishes the liquidation penalty as a 2%-10% band that rises with LTV and is curator-tunable per market, and no public endpoint exposes the per-reserve figure. Both ends are therefore evaluated: max-pen assumes the 10% cap, min-pen the 2% floor.',
    },
    method: 'get_exit_method is FREE and returns the full measurement and corroboration rules, the status vocabulary, and the row counts behind this answer.',
  };
}

// ---------------------------------------------------------------------------
// FREE. Everything below is computed at request time from the tape. No hardcoded counts:
// overhang's whole pitch is independence, so the method is published rather than asserted.
function getExitMethod() {
  const w = db.prepare(`SELECT COUNT(*) rows_, COUNT(DISTINCT sweep_id) sweeps,
    COUNT(DISTINCT symbol) symbols, MIN(ts) first_ts, MAX(ts) last_ts
    FROM reserves WHERE ts >= ${GATE_TS}`).get();

  const byStatus = db.prepare(`SELECT status, COUNT(*) n FROM reserves
    WHERE ts >= ${GATE_TS} GROUP BY status ORDER BY n DESC`).all();

  const bySymbol = db.prepare(`SELECT r.symbol, r.protocol, r.market, COUNT(*) rows_,
      MAX(r.ts) last_ts,
      (SELECT status FROM reserves x WHERE x.symbol = r.symbol AND x.ts >= ${GATE_TS} ORDER BY x.ts DESC LIMIT 1) latest_status,
      (SELECT ROUND(marked_usd,2) FROM reserves x WHERE x.symbol = r.symbol AND x.ts >= ${GATE_TS} ORDER BY x.ts DESC LIMIT 1) latest_marked_usd
    FROM reserves r WHERE r.ts >= ${GATE_TS} GROUP BY r.symbol ORDER BY latest_marked_usd DESC`).all();

  const refusals = db.prepare(`SELECT observation, COUNT(*) n, COUNT(DISTINCT symbol) symbols
    FROM reserves_adjudicated WHERE ts >= ${GATE_TS} AND observation IN ('no_route','not_tradable')
    GROUP BY observation`).all();

  const ctl = db.prepare(`SELECT COUNT(*) probes, SUM(routed) routed, SUM(transient) transient,
      ROUND(MAX(size_usd),2) biggest_clip_usd, ROUND(AVG(haircut_bps),2) avg_haircut_bps
    FROM controls WHERE ts >= ${GATE_TS}`).get();
  const ctlLatest = db.prepare(`SELECT ts, symbol, ROUND(size_usd,2) size_usd, routed,
      ROUND(haircut_bps,2) haircut_bps FROM controls WHERE ts >= ${GATE_TS}
    ORDER BY ts DESC, size_usd DESC LIMIT 1`).get();

  // Cadence measured off the tape, not asserted.
  const gaps = db.prepare(`SELECT ts FROM sweeps WHERE ts >= ${GATE_TS} ORDER BY ts DESC LIMIT 50`).all().map((r) => r.ts);
  const deltas = [];
  for (let i = 1; i < gaps.length; i++) deltas.push(gaps[i - 1] - gaps[i]);
  deltas.sort((a, b) => a - b);
  const medianGap = deltas.length ? deltas[Math.floor(deltas.length / 2)] : null;

  return {
    source: 'overhang',
    price_usd: 0,
    what_is_measured: {
      question: 'Collateral is marked at an oracle price. What can it actually be sold for, at size, right now?',
      marked_value: 'The protocol\'s own mark: deposited tokens x the oracle price the lending market is using, refetched live every sweep. Never read off disk — a mark read from a seed file froze the whole board at one value for six days.',
      realisable_value: 'Live sell quotes into USDC at real clip sizes, SELL DIRECTION ONLY, because a liquidated borrower is a seller and a buy quote flatters the number.',
      headline_metric: 'liquidator_margin_bps = liquidation_bonus_bps - exit_haircut_bps(size). Negative means a rational liquidator declines at that clip, the debt sits, and the protocol carries it.',
      max_exitable_usd: 'The largest clip whose liquidator margin is still >= 0, found by bisection rather than a fixed ladder. resolution_usd is the width of the remaining bracket, so max_exitable_usd is never read as exact.',
      zero_bad_debt_caveat: 'Zero bad debt today does not disprove any of this. It means nobody has been forced to test it at size.',
    },
    corroboration_rule: {
      rule: 'A terminal verdict requires SIX consecutive agreeing floor observations from the symbol\'s own tape. A single sample is never sufficient.',
      why: 'A single unverified external response could previously write the most severe conclusion in the system. Five rows reached the tape that way: three where one bad response said no route on an asset that routed cleanly in 2,024 of its other 2,027 floor probes, and two where an HTTP 200 carried an implausible price.',
      discriminator: 'Persistence, not magnitude. A threshold on the number would suppress genuine illiquidity, so it cannot be the mechanism. Assets that fail on every single sweep are real findings and are published; an isolated failure is not.',
      contradicted_floor: 'When the symbol\'s own history contradicts a terminal-looking floor sample, the collector buys ONE fresh floor sample rather than writing a hole. If it clears, the normal bisection runs from it and a real number is returned. If it fails too, the verdict is withheld.',
      withheld_form: 'A withheld verdict is written as *_unconfirmed with max_exitable_usd NULL and is kept out of every published total. get_exit_quote never returns that null: it falls back to the last corroborated measurement and labels the answer last_corroborated with its age.',
      never_aborts: 'Every sweep writes a row even when it measured nothing, so a data gap and a quiet market never look the same.',
    },
    status_vocabulary: {
      clears_full_ladder: 'The whole marked reserve exits with the liquidator still in profit.',
      partial: 'Some of the reserve exits profitably; max_exitable_usd is the boundary, resolution_usd its uncertainty.',
      not_tradable_any_size: 'The primary router REFUSES to quote the token at all, at any size (TOKEN_NOT_TRADABLE). This is permissioning, NOT illiquidity. Nothing was learned about depth because nothing was ever offered.',
      no_route_any_size: 'A route was sought and none found (NO_ROUTES_FOUND). The token is quotable; the book had no path. This IS a liquidity finding.',
      why_those_two_differ: 'They were one status until 2026-09-02 and collapsing them writes "no liquidity" over "we never asked". A liquidator must not read them as the same fact: one may be resolved by a listing, the other cannot.',
      unliquidatable_at_smallest_tested: 'The smallest clip tested routed, but the haircut exceeded the liquidation bonus.',
      measurement_failed: 'We failed, not the market — a throttled or errored probe. Excluded from every total.',
      unconfirmed_suffix: 'Terminal verdict withheld pending corroboration; max_exitable_usd is NULL by design, not missing.',
    },
    retroactive_split_note: 'Rows written before the split stored both refusals as no_route_any_size. No historical row was rewritten. The documented view reserves_adjudicated derives the split from the wire-level reason recorded on each row\'s floor quote, and this tool reads that view rather than reimplementing the logic.',
    control_design: {
      what: 'A SIZE-MATCHED control. The same question is asked of wrapped SOL, the deepest USDC pair on Solana and deliberately NOT a member of the measured board, at the exact dollar clip where a measured reserve failed.',
      why: 'Two reserves clearing 100% were also the two smallest on the board. A risk curator reads that and says: your controls clear because they are small, not because they are deep. Size-matching converts an ASSET control into a METHOD control, which is the objection that actually needs answering.',
      probes: ctl.probes, routed: ctl.routed, transient: ctl.transient,
      biggest_clip_usd: ctl.biggest_clip_usd, avg_haircut_bps: ctl.avg_haircut_bps,
      latest: ctlLatest || null,
    },
    coverage: {
      gated_from_ts: GATE_TS,
      gate_reason: 'Rows before this are a known frozen-mark window where the mark was read off disk rather than refetched. They are excluded from every query this service runs.',
      window_first_ts: w.first_ts, window_last_ts: w.last_ts,
      window_first_utc: w.first_ts ? new Date(w.first_ts * 1000).toISOString() : null,
      window_last_utc: w.last_ts ? new Date(w.last_ts * 1000).toISOString() : null,
      sweeps: w.sweeps, reserve_rows: w.rows_, symbols: w.symbols,
      cadence_sec_median: medianGap,
      rows_by_status: byStatus,
      refusal_split: refusals,
      symbols_covered: bySymbol,
    },
    verify_yourself: 'Every figure above is computed from the tape at request time; nothing here is hardcoded. The collector is open source at https://github.com/seekdaseek/overhang — the corroboration rule is src/corroborate.mjs, the bisection is src/bisect.mjs, and the adjudication view is in src/db.mjs.',
  };
}

module.exports = { getExitQuote, getExitMethod, GATE_TS };
