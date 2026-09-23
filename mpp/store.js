// mpp/store.js — durable, atomic consumed-signature store for MPP charge replay
// protection (draft-solana-charge-00 §11.6).
//
// @solana/mpp defaults `store` to `Store.memory()` (dist/server/Charge.js:45),
// which is per-process and forgotten on every restart. §11.6 requires that a
// consumed signature is never accepted again, so the set has to outlive the
// process. This backs it with the service's existing SQLite file.
//
// better-sqlite3 is synchronous, so a `db.transaction(...)` is a real
// read-modify-write critical section: `update()` below cannot interleave with
// another `update()` in this process, and SQLite's own write lock serializes it
// against any other process holding the same file.
//
// Shape is mppx's `Store.AtomicStore` (mppx/dist/Store.d.ts): get/put/delete
// plus the optional `update`/`tryClaim` atomic slots. @solana/mpp 0.7.0 only
// calls get/put; 0.11.0's replay.ts prefers `update` when the store exposes it
// and warns that "multi-process deployments must provide update()". Providing
// it now means this store is correct under either version.

const VALUE_MAX = 4096;

// How long one settlement may hold a signature before another request may take
// it over. Must exceed the worst-case settle time — simulate + broadcast +
// confirmation polling (@solana/mpp waits up to 30s) + post-confirmation
// verification — or a slow-but-live settlement could be raced by a retry.
const CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * @param {import('better-sqlite3').Database} db  open handle (agentfeed.db)
 * @param {string} table
 */
function createSqliteStore(db, table = 'mpp_consumed') {
  // Two processes sharing one database file WILL collide here — on the DDL at
  // boot and on every claim. Without a busy timeout SQLite returns
  // SQLITE_BUSY immediately and the loser dies, which is exactly the
  // multi-replica case this store exists to serve.
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      key     TEXT PRIMARY KEY,
      value   TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${table}_created ON ${table}(created);
  `);

  const selectStmt = db.prepare(`SELECT value FROM ${table} WHERE key = ?`);
  const upsertStmt = db.prepare(
    `INSERT INTO ${table} (key, value, created) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const deleteStmt = db.prepare(`DELETE FROM ${table} WHERE key = ?`);

  // Settlement claims live in their own table, keyed by the transaction
  // signature itself. Upstream owns `${table}` and writes its consumed marker
  // there; this table is the concurrency control in front of it, so the two
  // never contend for the same row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mpp_claim (
      signature  TEXT PRIMARY KEY,
      claimed_at INTEGER NOT NULL,
      state      TEXT NOT NULL
    );
  `);

  // One statement, and its row count is the whole verdict.
  //
  //   inserted                     -> 1 row  -> we own the settlement
  //   conflict, lease still live   -> 0 rows -> someone else is settling it
  //   conflict, lease expired      -> 1 row  -> we take it over (crash recovery)
  //   conflict, already settled    -> 0 rows -> replay
  //
  // The ON CONFLICT ... WHERE clause is what makes take-over safe: a row in
  // state 'settled' can never match, so a settled signature is never reclaimed.
  const claimStmt = db.prepare(`
    INSERT INTO mpp_claim (signature, claimed_at, state)
    VALUES (@signature, @now, 'pending')
    ON CONFLICT(signature) DO UPDATE SET claimed_at = @now
      WHERE mpp_claim.state = 'pending' AND mpp_claim.claimed_at <= @deadline
  `);
  const readClaimStmt = db.prepare(`SELECT state FROM mpp_claim WHERE signature = ?`);
  const releaseClaimStmt = db.prepare(`DELETE FROM mpp_claim WHERE signature = ? AND state = 'pending'`);
  const settleClaimStmt = db.prepare(`UPDATE mpp_claim SET state = 'settled' WHERE signature = ?`);

  const claimSignatureTxn = db.transaction((signature, leaseMs) => {
    // A signature upstream has already recorded is settled, full stop —
    // including across restarts, where no claim row survives.
    if (selectStmt.get(consumedKey(signature)) !== undefined) return 'consumed';
    const now = Date.now();
    const changes = claimStmt.run({ deadline: now - leaseMs, now, signature }).changes;
    if (changes === 1) return 'claimed';
    return readClaimStmt.get(signature)?.state === 'settled' ? 'consumed' : 'in-progress';
  });

  const read = (key) => {
    const row = selectStmt.get(key);
    if (row === undefined) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      // A row we cannot parse is not "absent" — treating it as absent would
      // let a consumed signature through. Surface it instead.
      throw new Error(`mpp store: corrupt value for key ${key}`);
    }
  };

  const write = (key, value) => {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('mpp store: value is not JSON-serializable');
    if (encoded.length > VALUE_MAX) throw new Error('mpp store: value too large');
    upsertStmt.run(key, encoded, Date.now());
  };

  // Single critical section. `fn` must be synchronous and side-effect free —
  // mppx documents the same contract (Store.d.ts, `Update`).
  const updateTxn = db.transaction((key, fn) => {
    const change = fn(read(key));
    if (change.op === 'set') write(key, change.value);
    else if (change.op === 'delete') deleteStmt.run(key);
    return change.result;
  });

  const claimTxn = db.transaction((key, expires) => {
    const current = read(key);
    const live =
      current !== null &&
      (typeof current !== 'object' ||
        current === null ||
        current.type !== 'mppx:replay' ||
        current.expires > Date.now());
    if (live) return false;
    write(key, { expires, type: 'mppx:replay' });
    return true;
  });

  return {
    async get(key) {
      return read(key);
    },
    async put(key, value) {
      write(key, value);
    },
    async delete(key) {
      deleteStmt.run(key);
    },
    async update(key, fn) {
      return updateTxn(key, fn);
    },
    tryClaim(key, expires) {
      return claimTxn(key, expires);
    },

    // --- used by this module's own pre-broadcast replay gate (see index.js) ---

    /** True when this signature has already been recorded as consumed. */
    isConsumed(signature) {
      return selectStmt.get(consumedKey(signature)) !== undefined;
    },

    /**
     * Atomically take ownership of one signature's settlement.
     *
     * This is the replay gate, and it is a WRITE, not a read. A read-then-act
     * check is useless here: two concurrent presentations of the same
     * credential both read "not consumed", both proceed, and one payment buys
     * two grants. The verdict is the row count of a single statement against a
     * PRIMARY KEY, so SQLite decides the winner, not this process.
     *
     * @returns {'claimed'|'in-progress'|'consumed'}
     */
    claimSignature(signature, leaseMs = CLAIM_LEASE_MS) {
      return claimSignatureTxn(signature, leaseMs);
    },

    /** Release a claim so a legitimate payer can retry after a failed verify. */
    releaseSignature(signature) {
      releaseClaimStmt.run(signature);
    },

    /** Mark a claim settled. The durable record is upstream's consumed key. */
    settleSignature(signature) {
      settleClaimStmt.run(signature);
    },
  };
}

/** The key @solana/mpp writes for a consumed signature (Charge.js: `solana-charge:consumed:${signature}`). */
function consumedKey(signature) {
  return `solana-charge:consumed:${signature}`;
}

module.exports = { createSqliteStore, consumedKey };
