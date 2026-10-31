-- The launchledger.db schema as of 2026-10-31, built the way the live file evolved: the tables of lib/db.mjs, then the additive migrations (t0_ts and promo_ts,
-- then the on-chain enrichment columns and the holders_t0 table of the 2026-10-31 migration). The column list of pools is the one in the snapshot ll-snap-20261031.db
-- (PRAGMA table_info) plus the enrichment columns. Used only to build synthetic databases for tests.
CREATE TABLE pools (
  id              INTEGER PRIMARY KEY,
  pool_address    TEXT UNIQUE NOT NULL,
  base_mint       TEXT,
  quote_mint      TEXT,
  name            TEXT,
  symbol          TEXT,
  dex             TEXT,
  discovered_ts   INTEGER NOT NULL,
  pool_created_ts INTEGER,
  t0_liquidity_usd REAL,
  t0_volume24h_usd REAL,
  t0_price_usd     REAL,
  t0_fdv_usd       REAL,
  t0_txns24h       INTEGER,
  t0_mint_authority   TEXT,
  t0_freeze_authority TEXT,
  t0_supply           REAL,
  cohort          INTEGER NOT NULL DEFAULT 0,
  cohort_ts       INTEGER,
  cohort_reason   TEXT,
  retired         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_pools_cohort ON pools(cohort, retired);
CREATE INDEX idx_pools_disc ON pools(discovered_ts);
CREATE TABLE checks (
  id            INTEGER PRIMARY KEY,
  pool_id       INTEGER NOT NULL REFERENCES pools(id),
  ts            INTEGER NOT NULL,
  age_hours     REAL,
  liquidity_usd REAL,
  volume24h_usd REAL,
  price_usd     REAL,
  fdv_usd       REAL,
  txns24h       INTEGER,
  ok            INTEGER NOT NULL DEFAULT 1,
  UNIQUE(pool_id, ts)
);
CREATE INDEX idx_checks_pool ON checks(pool_id, ts);
CREATE TABLE labels (
  id            INTEGER PRIMARY KEY,
  pool_id       INTEGER NOT NULL REFERENCES pools(id),
  horizon_days  INTEGER NOT NULL,
  label         TEXT NOT NULL,
  evidence      TEXT,
  labeled_ts    INTEGER NOT NULL,
  UNIQUE(pool_id, horizon_days)
);
CREATE INDEX idx_labels_h ON labels(horizon_days, label);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
ALTER TABLE pools ADD COLUMN t0_ts INTEGER;
ALTER TABLE pools ADD COLUMN promo_ts INTEGER;
ALTER TABLE pools ADD COLUMN t0_token_program TEXT;
ALTER TABLE pools ADD COLUMN t0_decimals INTEGER;
ALTER TABLE pools ADD COLUMN t0_extensions TEXT;
ALTER TABLE pools ADD COLUMN t0_enrich_ts INTEGER;
ALTER TABLE pools ADD COLUMN t0_enrich_tries INTEGER DEFAULT 0;
ALTER TABLE pools ADD COLUMN t0_holder_tries INTEGER DEFAULT 0;
CREATE TABLE holders_t0 (
  pool_id    INTEGER PRIMARY KEY REFERENCES pools(id),
  ts         INTEGER NOT NULL,
  top20_json TEXT NOT NULL,
  source     TEXT
);
CREATE INDEX idx_pools_t0 ON pools(cohort, retired, t0_ts);
CREATE INDEX idx_pools_promo ON pools(cohort, retired, promo_ts);
