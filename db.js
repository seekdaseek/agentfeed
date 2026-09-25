// db.js — SQLite via better-sqlite3 (sync, fast, zero config)
const Database = require('better-sqlite3');
const path = require('path');

// AGENTFEED_DB exists so a scratch instance cannot write to the live audit
// table, the way tools/liqdb.js and tools/entry.js already take LIQ_DB.
// Unset in production, where the join below is the answer.
//
// The join alone is not enough, and the reason is worth keeping: a scratch tree
// that SYMLINKS this file gets __dirname = /opt/agentfeed, because node resolves
// a module's realpath before running it. On Sep 25 2026 that put 37 rows from
// scratch boots on ports 3999/4099/4199 into the production calls table --
// including loopback head_probe and rate_limited rows that read as real traffic
// -- while the boot script's `rm -f agentfeed.db` deleted a file nothing opened.
// An env var is the only override that survives being symlinked.
const db = new Database(process.env.AGENTFEED_DB || path.join(__dirname, 'agentfeed.db'));
db.pragma('journal_mode = WAL');

// calls: audit trail. payment columns stay NULL in Session 1 (free mode),
// filled in Session 2 when x402 lands.
db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    tool TEXT NOT NULL,
    payer_wallet TEXT,
    tx_sig TEXT,
    amount_usdc REAL,
    status TEXT NOT NULL,          -- paid | free | error | bad_request
    latency_ms INTEGER,
    ip TEXT,
    error_msg TEXT,
    req_host TEXT,
    req_path TEXT,
    user_agent TEXT,
    method TEXT
  );

  CREATE TABLE IF NOT EXISTS free_tier (
    wallet TEXT PRIMARY KEY,
    calls_used INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts);
  CREATE INDEX IF NOT EXISTS idx_calls_tool ON calls(tool);
`);

// The live DB predates some of the columns above: CREATE IF NOT EXISTS is a
// no-op there, so add whatever is missing. Additive only — existing rows get
// NULL and history is never rewritten.
const haveCols = new Set(db.prepare(`PRAGMA table_info(calls)`).all().map((c) => c.name));
for (const col of ['error_msg', 'req_host', 'req_path', 'user_agent', 'method']) {
  if (!haveCols.has(col)) db.exec(`ALTER TABLE calls ADD COLUMN ${col} TEXT`);
}

// batched async-ish logging: queue writes, flush every 2s — keeps the hot path clean
const queue = [];
const insertCall = db.prepare(`
  INSERT INTO calls (ts, tool, payer_wallet, tx_sig, amount_usdc, status, latency_ms, ip,
                     error_msg, req_path, user_agent, method)
  VALUES (@ts, @tool, @payer_wallet, @tx_sig, @amount_usdc, @status, @latency_ms, @ip,
          @error_msg, @req_path, @user_agent, @method)
`);
const flushMany = db.transaction((rows) => rows.forEach((r) => insertCall.run(r)));

// caps, not truth-shaping: a hostile User-Agent can be arbitrarily long
const trunc = (v, n) => (v == null ? null : String(v).slice(0, n));

function logCall(row) {
  queue.push({
    ts: Date.now(),
    tool: row.tool,
    payer_wallet: row.payer_wallet || null,
    tx_sig: row.tx_sig || null,
    amount_usdc: row.amount_usdc ?? null,
    status: row.status,
    latency_ms: row.latency_ms ?? null,
    ip: row.ip || null,
    error_msg: trunc(row.error_msg, 500),
    req_path: trunc(row.req_path, 500),
    user_agent: trunc(row.user_agent, 400),
    method: trunc(row.method, 10),
  });
}

setInterval(() => {
  if (queue.length === 0) return;
  const batch = queue.splice(0, queue.length);
  try {
    flushMany(batch);
  } catch (e) {
    console.error('[db] flush failed:', e.message);
  }
}, 2000).unref();

module.exports = { db, logCall };
