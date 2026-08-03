// tools/sharpmove.js — World Cup sharp-money detector (paid: get_sharp_move)
//
// Reads the LineWatch collector DB (/opt/linewatch) and applies the pre-match move detector.
// Thresholds are MEASURED, not guessed: p99.9 of 8,464,803 TxLINE ticks across 137 matches.
'use strict';
const Database = require('better-sqlite3');
const { detectSharpMoves } = require('/opt/linewatch/detect.js');

const DB_PATH = '/opt/linewatch/linewatch.db';
let db = null;
function getDb() {
  if (!db) db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return db;
}

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

function getSharpMove(req) {
  const q = (req && req.query) || {};
  const params = {
    windowSec:   clamp(q.window, 60, 1800, 300),
    minPp:       clamp(q.min_pp, 0.5, 20, 2.81),
    lookbackMin: clamp(q.lookback_min, 5, 1440, 60),
  };
  const moves = detectSharpMoves(getDb(), params);
  return {
    source: 'txline_stableprice_consensus',
    anchored_on: 'solana',
    method: 'pre-match move in the de-margined consensus win probability. No match is in play, so there is nothing to react to: a probability that jumps before kickoff is money arriving, not a reaction to a goal.',
    threshold_basis: 'default 2.81pp/5min = p99.9 of 8,464,803 real ticks across 137 matches (median move: 0.08pp)',
    active: moves.length > 0,
    count: moves.length,
    moves,
    params: { window_sec: params.windowSec, min_pp: params.minPp, lookback_min: params.lookbackMin },
    checked_at: Date.now(),
  };
}

module.exports = { getSharpMove };
