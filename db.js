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
    status TEXT NOT NULL,          -- ok | error | free
    latency_ms INTEGER,
    ip TEXT
  );

  CREATE TABLE IF NOT EXISTS free_tier (
    wallet TEXT PRIMARY KEY,
    calls_used INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts);
  CREATE INDEX IF NOT EXISTS idx_calls_tool ON calls(tool);
`);

// batched async-ish logging: queue writes, flush every 2s — keeps the hot path clean
const queue = [];
const insertCall = db.prepare(`
  INSERT INTO calls (ts, tool, payer_wallet, tx_sig, amount_usdc, status, latency_ms, ip)
  VALUES (@ts, @tool, @payer_wallet, @tx_sig, @amount_usdc, @status, @latency_ms, @ip)
`);
const flushMany = db.transaction((rows) => rows.forEach((r) => insertCall.run(r)));

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
