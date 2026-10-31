// test/fixtures/r23/crash/ledger-fixture.js: builds a synthetic launchledger.db to the live schema (ll-schema.sql) for the crash-risk tests.
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'll-schema.sql'), 'utf8');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'parity-fixture.json'), 'utf8'));

/**
 * @param {string} file
 * @param {object} o
 * @param {object[]} [o.pools]     rows of pools (any subset of the columns); cohort defaults to 1, cohort_ts and discovered_ts to t0_ts
 * @param {object[]} [o.labels]    { pool_id, horizon_days, label, evidence (object) }
 * @param {object[]} [o.checks]    { pool_id, ts, price_usd, ... }
 * @param {object}   [o.meta]
 * @param {boolean}  [o.extras]    add columns and tables the scorer has never heard of (a later migration)
 * The database is closed before returning, so its WAL is checkpointed into the main file and the file's bytes are a stable thing to hash.
 */
function makeLedger(file, { pools = [], labels = [], checks = [], meta = {}, extras = false } = {}) {
  if (fs.existsSync(file)) fs.rmSync(file);
  for (const s of ['-wal', '-shm']) if (fs.existsSync(file + s)) fs.rmSync(file + s);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  if (extras) {
    db.exec(`ALTER TABLE pools ADD COLUMN t0_unknown_future_column TEXT; ALTER TABLE pools ADD COLUMN t0_holder_top10_pct REAL DEFAULT 0.5;
      CREATE TABLE some_future_table (a INTEGER, b TEXT); INSERT INTO some_future_table VALUES (1, 'x');`);
  }
  const cols = db.prepare('PRAGMA table_info(pools)').all().map((c) => c.name);
  const ins = db.prepare(`INSERT INTO pools (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`);
  const insL = db.prepare('INSERT INTO labels (pool_id, horizon_days, label, evidence, labeled_ts) VALUES (?,?,?,?,?)');
  const insC = db.prepare('INSERT INTO checks (pool_id, ts, age_hours, liquidity_usd, volume24h_usd, price_usd, fdv_usd, txns24h, ok) VALUES (?,?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (const p of pools) {
      const row = Object.fromEntries(cols.map((c) => [c, null]));
      Object.assign(row, { cohort: 1, retired: 0, discovered_ts: p.t0_ts, cohort_ts: p.t0_ts, t0_enrich_tries: 0, t0_holder_tries: 0 }, p);
      if (row.pool_address === null) row.pool_address = `pool-${row.id}`;
      ins.run(row);
    }
    for (const l of labels) insL.run(l.pool_id, l.horizon_days, l.label || 'unknown', JSON.stringify(l.evidence ?? {}), l.labeled_ts || 0);
    for (const c of checks) insC.run(c.pool_id, c.ts, null, null, null, c.price_usd ?? null, null, null, c.ok === undefined ? 1 : c.ok);
    for (const [k, v] of Object.entries(meta)) db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run(k, String(v));
  })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  return file;
}

module.exports = { makeLedger, FIXTURE, SCHEMA };
