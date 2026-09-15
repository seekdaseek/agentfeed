// db.js — SQLite via better-sqlite3 (sync, fast, zero config)
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'agentfeed.db'));
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
