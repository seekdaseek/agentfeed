// tools/r24/rwa/snapshots.js: our own daily record of each product's on-chain price (R24, item 3). A small SQLite file, rwa-snapshots.db beside the audit database
// (R24_RWA_DB overrides). bin/r24-rwa-snapshot.js appends one row per product per UTC day (INSERT OR IGNORE on (product, day): a second run the same day changes nothing) and prunes
// rows older than KEEP_DAYS, so the file is bounded at products x KEEP_DAYS rows. The route only READS it (read-only handle, one per process, re-checked when the file is missing).
// A row is trusted only after the same checks a live read gets: a positive integer price, the decimals the register says, a sane block time.
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const KEEP_DAYS = 400;
const REOPEN_MS = 5 * 60 * 1000;
const TOLERANCE_S = 14 * 3600;
const dayOf = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

/** R24_RWA_DB, else beside the audit database (db.js: AGENTFEED_DB, default agentfeed.db in the repo root); none for an in-memory audit database */
function defaultPath(env = process.env) {
  if (env.R24_RWA_DB) return env.R24_RWA_DB;
  const audit = env.AGENTFEED_DB || path.join(__dirname, '..', '..', '..', 'agentfeed.db');
  return audit !== ':memory:' ? path.join(path.dirname(path.resolve(audit)), 'rwa-snapshots.db') : null;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS rwa_snap (
  product TEXT NOT NULL, day TEXT NOT NULL, block INTEGER NOT NULL, block_ts INTEGER NOT NULL,
  price_raw TEXT NOT NULL, decimals INTEGER NOT NULL, updated_at INTEGER,
  PRIMARY KEY (product, day));
CREATE INDEX IF NOT EXISTS rwa_snap_ts ON rwa_snap (product, block_ts);`;

/** the writer (the collector): creates the file and table */
function openWriter(file) {
  const db = new Database(file);
  db.exec(SCHEMA);
  return db;
}

/** append a row. Returns true if it was added, false if that product already has a row for that UTC day (the first one of the day stays). */
function record(db, row) {
  if (!row || typeof row.priceRaw !== 'bigint' || row.priceRaw <= 0n) throw new Error('snapshot: price must be a positive integer');
  if (!Number.isSafeInteger(row.block) || !Number.isSafeInteger(row.blockTs) || row.blockTs <= 0) throw new Error('snapshot: block and block time must be integers');
  const r = db.prepare('INSERT OR IGNORE INTO rwa_snap (product, day, block, block_ts, price_raw, decimals, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(row.product, dayOf(row.blockTs), row.block, row.blockTs, row.priceRaw.toString(), row.decimals, row.updatedAt == null ? null : row.updatedAt);
  return r.changes === 1;
}

/** delete rows older than keepDays before `nowSec`; returns how many */
function prune(db, nowSec, keepDays = KEEP_DAYS) {
  return db.prepare('DELETE FROM rwa_snap WHERE block_ts < ?').run(nowSec - keepDays * 86400).changes;
}

// ---- the reader (the route) -------------------------------------------------------------------------------------------------------------------------------------------
const HANDLES = new Map();        // file -> { db|null, at }   (one entry: the configured file)

function openReader(file, now = Date.now) {
  if (!file) return null;
  const h = HANDLES.get(file);
  if (h && (h.db || now() - h.at < REOPEN_MS)) return h.db;
  let db = null;
  try {
    if (fs.existsSync(file)) db = new Database(file, { readonly: true, fileMustExist: true });
  } catch { db = null; }
  HANDLES.set(file, { db, at: now() });
  return db;
}
function closeReaders() { for (const h of HANDLES.values()) { try { if (h.db) h.db.close(); } catch { /* closed */ } } HANDLES.clear(); }

/**
 * the stored row nearest to targetTs (block time), within toleranceS, or null. A row that fails the checks is skipped as if it were absent.
 * @returns {{raw: bigint, block: number, blockTs: number, updatedAt: number|null}|null}
 */
function nearest(db, p, targetTs, toleranceS = TOLERANCE_S) {
  if (!db) return null;
  let rows;
  try {
    rows = db.prepare('SELECT block, block_ts, price_raw, decimals, updated_at FROM rwa_snap WHERE product = ? AND block_ts BETWEEN ? AND ? ORDER BY ABS(block_ts - ?) LIMIT 3')
      .all(p.id, targetTs - toleranceS, targetTs + toleranceS, targetTs);
  } catch { return null; }
  for (const r of rows) {
    if (r.decimals !== p.read.decimals || !/^[1-9][0-9]{0,77}$/.test(String(r.price_raw))) continue;
    if (!Number.isSafeInteger(r.block) || !Number.isSafeInteger(r.block_ts)) continue;
    return { raw: BigInt(r.price_raw), block: r.block, blockTs: r.block_ts, updatedAt: r.updated_at == null ? null : r.updated_at };
  }
  return null;
}

/** how many days of rows a product has: the span from its oldest row to `nowSec`, in days (0 when none) */
function spanDays(db, p, nowSec) {
  if (!db) return 0;
  try { const r = db.prepare('SELECT MIN(block_ts) AS m FROM rwa_snap WHERE product = ?').get(p.id); return r && r.m ? (nowSec - r.m) / 86400 : 0; } catch { return 0; }
}

module.exports = { openWriter, record, prune, openReader, closeReaders, nearest, spanDays, defaultPath, dayOf, KEEP_DAYS, TOLERANCE_S, SCHEMA, _handles: HANDLES };
