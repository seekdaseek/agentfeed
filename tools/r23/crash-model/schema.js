// tools/r23/crash-model/schema.js: the tables of scores.db, the file the ledger-score service writes and the crash-risk routes read (R23 T1).
// One definition, used by the service, the routes' example builder and the tests. scores.db holds NOTHING copied from launchledger.db except what a route shows
// (mint, pool, dex, the frozen entry time, and the two entry numbers liquidity and fully diluted value) and the model's own outputs.
'use strict';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scores (
  pool_id          INTEGER PRIMARY KEY,           -- launchledger pools.id: the PRIMARY KEY is what makes scoring idempotent
  mint             TEXT,                          -- base_mint
  pool             TEXT,                          -- pool_address
  dex              TEXT,
  score            REAL,                          -- the model's probability of an 80 percent price fall within 24 hours of entry
  model_version    TEXT,
  scored_ts        INTEGER,                       -- unix seconds, when this row was written
  t0_ts            INTEGER,                       -- the pool's frozen entry time
  t0_liquidity_usd REAL,                          -- frozen entry numbers a route shows (so a route never opens launchledger.db)
  t0_fdv_usd       REAL
);
CREATE INDEX IF NOT EXISTS scores_mint ON scores (mint);
CREATE INDEX IF NOT EXISTS scores_pool ON scores (pool);
CREATE INDEX IF NOT EXISTS scores_scored_ts ON scores (scored_ts);
CREATE TABLE IF NOT EXISTS auc_weekly (
  week_start    TEXT,                             -- the Monday (UTC) of the ISO week of t0_ts, YYYY-MM-DD
  model_version TEXT,
  n             INTEGER,                          -- pools scored at entry whose 24 hour outcome arrived after they were scored
  positives     INTEGER,                          -- of those, price at the 24 hour check at least 80 percent below the entry price
  auc           REAL,                             -- NULL under the floor of resolved pools, or when there is no positive or no negative
  deciles       TEXT,                             -- JSON: { basis, rows: [{ decile, n, positives }] }
  computed_ts   INTEGER,
  PRIMARY KEY (week_start, model_version)
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS skipped (                -- cohort pools the service refused to score: a column the model needs was missing
  pool_id INTEGER PRIMARY KEY,
  reason  TEXT,
  ts      INTEGER
);
`;

const ensureSchema = (db) => db.exec(SCHEMA);

module.exports = { SCHEMA, ensureSchema };
