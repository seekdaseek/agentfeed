// AGENTFEED liquidation collector — Bybit allLiquidation -> SQLite
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const db = new Database('/opt/agentfeed/liquidations.db');
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS liquidations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,          -- exchange timestamp ms
  symbol TEXT NOT NULL,         -- SOLUSDT / BTCUSDT
  side TEXT NOT NULL,           -- Sell = short liquidated, Buy = long liquidated
  size REAL NOT NULL,           -- contracts (base units)
  price REAL NOT NULL,
  usd REAL NOT NULL             -- size * price
);
CREATE INDEX IF NOT EXISTS idx_liq_sym_ts ON liquidations(symbol, ts);`);

const insert = db.prepare(
  'INSERT INTO liquidations (ts, symbol, side, size, price, usd) VALUES (?, ?, ?, ?, ?, ?)'
);

const URL = 'wss://stream.bybit.com/v5/public/linear';
const TOPICS = ['allLiquidation.SOLUSDT', 'allLiquidation.BTCUSDT'];
let ws, pingTimer, backoff = 1000, lastMsg = Date.now();

function connect() {
  ws = new WebSocket(URL);

  ws.on('open', () => {
    backoff = 1000;
    ws.send(JSON.stringify({ op: 'subscribe', args: TOPICS }));
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ping' }));
    }, 15000);
    console.log(new Date().toISOString(), 'connected + subscribed');
  });

  ws.on('message', (raw) => {
    lastMsg = Date.now();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.topic || !msg.topic.startsWith('allLiquidation.') || !Array.isArray(msg.data)) return;
    for (const r of msg.data) {
      const size = parseFloat(r.v), price = parseFloat(r.p);
      if (!isFinite(size) || !isFinite(price)) continue;
      insert.run(r.T, r.s, r.S, size, price, size * price);
    }
  });

  ws.on('close', () => {
    clearInterval(pingTimer);
    console.log(new Date().toISOString(), `disconnected, retry in ${backoff}ms`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60000);
  });

  ws.on('error', (e) => {
    console.error(new Date().toISOString(), 'ws error:', e.message);
    ws.close();
  });
}

connect();

// staleness watchdog: if no message (incl. pongs) for 60s, kill socket -> triggers reconnect
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMsg > 60000) {
    console.log(new Date().toISOString(), 'stale connection, terminating');
    ws.terminate();
  }
}, 30000);
