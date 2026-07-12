// AGENTFEED liquidation collector v2 — Bybit (complete) + OKX (sampled) -> SQLite
// side column convention (matches v1 data): 'Sell' = short liquidated, 'Buy' = long liquidated
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const db = new Database('/opt/agentfeed/liquidations.db');
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS liquidations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  size REAL NOT NULL,
  price REAL NOT NULL,
  usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_liq_sym_ts ON liquidations(symbol, ts);`);
try { db.exec(`ALTER TABLE liquidations ADD COLUMN exchange TEXT NOT NULL DEFAULT 'bybit'`); } catch {} // exists on re-run
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_liq_ex_ts ON liquidations(exchange, ts)`); } catch {}

const insert = db.prepare(
  'INSERT INTO liquidations (ts, symbol, side, size, price, usd, exchange) VALUES (?, ?, ?, ?, ?, ?, ?)'
);

// ---- OKX contract sizes (sz is in contracts, not coins). Fetched at boot; verified fallbacks.
const OKX_INSTS = { 'SOL-USDT-SWAP': 'SOLUSDT', 'BTC-USDT-SWAP': 'BTCUSDT', 'ETH-USDT-SWAP': 'ETHUSDT', 'XRP-USDT-SWAP': 'XRPUSDT', 'DOGE-USDT-SWAP': 'DOGEUSDT' };
const ctVal = { 'SOL-USDT-SWAP': 1, 'BTC-USDT-SWAP': 0.01, 'ETH-USDT-SWAP': 0.1, 'XRP-USDT-SWAP': 100, 'DOGE-USDT-SWAP': 1000 }; // verified Jul 9-10 2026
async function refreshCtVals() {
  for (const inst of Object.keys(OKX_INSTS)) {
    try {
      const r = await fetch(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${inst}`);
      const j = await r.json();
      const v = parseFloat(j?.data?.[0]?.ctVal);
      if (isFinite(v) && v > 0) ctVal[inst] = v;
    } catch (e) { console.warn('ctVal fetch failed for', inst, '- using fallback', ctVal[inst]); }
  }
  console.log(new Date().toISOString(), 'ctVal:', JSON.stringify(ctVal));
}

// ---- generic resilient connection factory
function makeConn({ name, url, onOpen, onMessage, ping, pingMs, staleMs = 60000 }) {
  let ws, pingTimer, backoff = 1000, lastMsg = Date.now();

  setInterval(() => { // staleness watchdog
    if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMsg > staleMs) {
      const age = Math.round((Date.now() - lastMsg) / 1000);
      console.log(new Date().toISOString(), name, `stale (${age}s > ${staleMs / 1000}s), terminating`);
      ws.terminate();
    }
  }, 15000);

  function connect() {
    ws = new WebSocket(url);
    ws.on('open', () => {
      backoff = 1000;
      lastMsg = Date.now();
      if (onOpen) onOpen(ws);
      if (pingMs > 0) pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ping) ws.send(ping);   // app-level ping (bybit: {op:ping}, okx: 'ping')
        else ws.ping();            // WS PROTOCOL ping frame (binance answers with a pong)
      }, pingMs);
      console.log(new Date().toISOString(), name, 'connected + subscribed');
    });
    ws.on('ping', () => { lastMsg = Date.now(); });
    ws.on('pong', () => { lastMsg = Date.now(); });
    ws.on('message', (raw) => {
      lastMsg = Date.now();
      try { onMessage(raw.toString()); } catch (e) { console.error(name, 'handler error:', e.message); }
    });
    ws.on('close', () => {
      clearInterval(pingTimer);
      console.log(new Date().toISOString(), name, `disconnected, retry in ${backoff}ms`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60000);
    });
    ws.on('error', (e) => { console.error(name, 'ws error:', e.message); ws.close(); });
  }
  connect();
}

// ---- BYBIT: complete feed. S = side of liquidated position ('Sell' = short liq'd) — verified live Jul 8.
makeConn({
  name: 'bybit',
  url: 'wss://stream.bybit.com/v5/public/linear',
  onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: ['allLiquidation.SOLUSDT', 'allLiquidation.BTCUSDT', 'allLiquidation.ETHUSDT', 'allLiquidation.XRPUSDT', 'allLiquidation.DOGEUSDT'] })),
  ping: JSON.stringify({ op: 'ping' }),
  pingMs: 15000,
  onMessage: (raw) => {
    const msg = JSON.parse(raw);
    if (!msg.topic || !msg.topic.startsWith('allLiquidation.') || !Array.isArray(msg.data)) return;
    for (const r of msg.data) {
      const size = parseFloat(r.v), price = parseFloat(r.p);
      if (!isFinite(size) || !isFinite(price)) continue;
      insert.run(r.T, r.s, r.S, size, price, size * price, 'bybit');
    }
  },
});

// ---- OKX: sampled feed (max ~1 print/sec/contract). posSide is explicit — no inference.
makeConn({
  name: 'okx',
  url: 'wss://ws.okx.com:8443/ws/v5/public',
  onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP' }] })),
  ping: 'ping', // OKX wants the literal string
  pingMs: 20000,
  onMessage: (raw) => {
    if (raw === 'pong') return;
    const msg = JSON.parse(raw);
    if (msg.arg?.channel !== 'liquidation-orders' || !Array.isArray(msg.data)) return;
    for (const item of msg.data) {
      const symbol = OKX_INSTS[item.instId];
      if (!symbol) continue; // only SOL/BTC
      for (const d of item.details || []) {
        const contracts = parseFloat(d.sz), price = parseFloat(d.bkPx);
        if (!isFinite(contracts) || !isFinite(price)) continue;
        const size = contracts * ctVal[item.instId];         // coins
        const side = d.posSide === 'short' ? 'Sell' : 'Buy'; // map to v1 convention
        insert.run(parseInt(d.ts), symbol, side, size, price, size * price, 'okx');
      }
    }
  },
});

// ---- BINANCE: stubbed until format verified live (stream: wss://fstream.binance.com/ws/!forceOrder@arr, throttled 1/sec/symbol)
// makeConn({ name: 'binance', url: 'wss://fstream.binance.com/ws/!forceOrder@arr', ... })

refreshCtVals();

// ---- BINANCE: sampled feed (largest liq per symbol per 1000ms). Routed /market path (legacy URLs dead since 2026-04-23).
// S is the LIQUIDATION ORDER side: SELL = long was force-closed -> flip to our convention ('Buy' = long liquidated).
const BINANCE_SYMBOLS = new Set(['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'DOGEUSDT']);
makeConn({
  name: 'binance',
  url: 'wss://fstream.binance.com/market/ws/!forceOrder@arr',
  ping: null,           // null + pingMs>0 => WS protocol ping frame; binance pongs back
  pingMs: 30000,        // was 0: binance server pings only every 180s (docs) vs 60s watchdog
                        // => healthy sockets were being killed in every quiet stretch
  onMessage: (raw) => {
    const msg = JSON.parse(raw);
    if (msg.e !== 'forceOrder' || !msg.o) return;
    const o = msg.o;
    if (!BINANCE_SYMBOLS.has(o.s)) return;
    const size = parseFloat(o.z), price = parseFloat(o.ap);
    if (!isFinite(size) || !isFinite(price) || size <= 0) return;
    const side = o.S === 'SELL' ? 'Buy' : 'Sell'; // flip: their order side -> our liquidated-position convention
    insert.run(o.T, o.s, side, size, price, size * price, 'binance');
  },
});
