// tools/r23/cascade-backtest/config.js: every number of get_cascade_backtest in one place. Public text (route description, schema, method block) is built from these
// constants, never typed, so a changed bound changes the text with it.
'use strict';

const MIN = 60_000;
const DAY_MS = 86_400_000;

// ---- the price grid: Hyperliquid 15-minute candles. Hyperliquid's candleSnapshot keeps only the latest 5,000 candles of an interval (measured 31 Oct 2026: 1-minute reaches back
// about 3.6 days, 5-minute 17, 15-minute 52, 1-hour all of the tape), so 15 minutes is the finest interval whose history covers a useful span AND lands every horizon on the grid.
const INTERVAL = '15m';
const STEP_MS = 15 * MIN;
const PER_DAY = DAY_MS / STEP_MS;                 // 96 candles in a UTC day
const SOURCE_RETENTION_CANDLES = 5000;            // Hyperliquid's documented cap per interval

// ---- horizons (forward windows); every one is a whole number of grid steps
const HORIZONS = [
  { key: '15m', minutes: 15 },
  { key: '1h', minutes: 60 },
  { key: '4h', minutes: 240 },
  { key: '24h', minutes: 1440 },
].map((h) => ({ ...h, ms: h.minutes * MIN, steps: (h.minutes * MIN) / STEP_MS }));

// ---- query parameters: [lo, hi, default]. An impossible value is a 400 (bad), never clamped.
const SIDES = ['long', 'short', 'both'];
const SIDE_DEFAULT = 'both';
const MIN_USD = { lo: 10_000, hi: 1_000_000_000, dflt: 100_000 };   // the lower bound and the single-symbol default are get_cascade_history's
const WINDOW_MIN = { lo: 1, hi: 60, dflt: 5 };
const COOLDOWN_MIN = { lo: 15, hi: 1440, dflt: 60 };
const LIMIT = { lo: 1, hi: 100, dflt: 20 };

// ---- the event definition (reused from get_cascade_history: at least 3 prints; 'Buy' = longs liquidated, 'Sell' = shorts liquidated)
const MIN_PRINTS = 3;
const HOT_TOLERANCE = 1e-9;                       // a window sum within this share of min_usd counts as reaching it (running sums drift in the last digits)
const REFRESH_EVERY = 2048;                       // the running window sum is rebuilt exactly after this many groups
const MAX_EVENTS = 5000;                          // more events than this at one threshold: a 400 asking for a higher min_usd or longer cooldown_min
const MAX_ROWS = 4_000_000;                       // prints one request may read from the tape (the tape holds a few hundred thousand per symbol); past it, a 503
const MAX_LOOKBACK_DAYS = 400;                    // the scan never reaches further back than this

// ---- statistics
const BOOTSTRAP_B = 2000;
const CI_LEVEL = 0.95;
const MIN_N_FOR_INTERVAL = 5;
const SEED_BASELINE = 20261031;                   // fixed seeds: the same query on the same data returns the same numbers
const SEED_BOOTSTRAP = 31102026;
const BASELINE_ATTEMPTS_PER_TIME = 200;

// ---- the candle cache and its refresh at request time
const cacheDir = (env = process.env) => env.R23_CANDLE_CACHE || '/opt/agentfeed/r23-cache/candles';
const REFRESH_MIN_GAP_MS = 5 * MIN;               // a symbol's cache is refreshed from Hyperliquid at most this often
const REFRESH_FAIL_BACKOFF_MS = 60_000;           // after a failed refresh the same symbol is not asked again for this long
const GLOBAL_CALL_GAP_MS = 1500;                  // at least this long between any two Hyperliquid calls from this process
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const MAX_TRACKED_SYMBOLS = 5000;                 // bound on the in-memory refresh bookkeeping

const HL_INFO = (env = process.env) => env.HL_API || 'https://api.hyperliquid.xyz/info';
const SOURCE_NAME = 'Hyperliquid candleSnapshot, 15-minute candles (close of the candle that ends at the time)';
const TAPE_NAME = 'agentfeed_liq_tape';   // as get_cascade_history names it: sums and counts only, no print, no venue (docs/SOURCES.md C7)

module.exports = {
  MIN, DAY_MS, INTERVAL, STEP_MS, PER_DAY, SOURCE_RETENTION_CANDLES, HORIZONS, SIDES, SIDE_DEFAULT, MIN_USD, WINDOW_MIN, COOLDOWN_MIN, LIMIT,
  MIN_PRINTS, HOT_TOLERANCE, REFRESH_EVERY, MAX_EVENTS, MAX_ROWS, MAX_LOOKBACK_DAYS, BOOTSTRAP_B, CI_LEVEL, MIN_N_FOR_INTERVAL, SEED_BASELINE, SEED_BOOTSTRAP,
  BASELINE_ATTEMPTS_PER_TIME, cacheDir, REFRESH_MIN_GAP_MS, REFRESH_FAIL_BACKOFF_MS, GLOBAL_CALL_GAP_MS, FETCH_TIMEOUT_MS, FETCH_MAX_BYTES, MAX_TRACKED_SYMBOLS,
  HL_INFO, SOURCE_NAME, TAPE_NAME,
};
