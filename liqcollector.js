// AGENTFEED liquidation collector v3 — Bybit (complete) + OKX + Binance -> SQLite
//
// v3 CHANGES:
//   - FULL UNIVERSE. Binance (!forceOrder@arr) and OKX (instType:SWAP) were ALREADY
//     firehosing every symbol; v2 threw the non-core ones away at a filter. Now kept.
//   - Bybit uses per-symbol topics, so we fetch the universe from the API and subscribe
//     in chunks. Async bootstrap so the symbol list exists BEFORE the socket opens.
//   - SUBSCRIPTION ACK VALIDATION. v2 ignored acks. With 5 topics that never mattered;
//     with 250, a partial rejection = silent permanent data loss. Now logged loudly.
//   - USDT-LINEAR ONLY on all three venues. Inverse/coin-margined contracts report size
//     in USD, not coins -> mixing them silently corrupts every aggregate.
//
// side convention (unchanged, verified against all 3 exchange docs):
//   'Buy' = LONG liquidated, 'Sell' = SHORT liquidated.
//   Bybit S is already position side. Binance S is ORDER side -> flipped. OKX posSide -> mapped.
'use strict';
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const BYBIT_MAX = parseInt(process.env.BYBIT_MAX_SYMBOLS || '1000', 10);
const SUB_CHUNK = 10;      // topics per subscribe frame
const SUB_GAP_MS = 120;    // gap between subscribe frames

// endpoints (env-overridable so the whole thing can be tested against mocks)
const EP = {
  bybitApi:  process.env.BYBIT_API  || 'https://api.bybit.com/v5/market/tickers?category=linear',
  okxApi:    process.env.OKX_API    || 'https://www.okx.com/api/v5/public/instruments?instType=SWAP',
  bybitWs:   process.env.BYBIT_WS   || 'wss://stream.bybit.com/v5/public/linear',
  okxWs:     process.env.OKX_WS     || 'wss://ws.okx.com:8443/ws/v5/public',
  binanceWs: process.env.BINANCE_WS || 'wss://fstream.binance.com/market/ws/!forceOrder@arr',
};
const DB_PATH = process.env.LIQ_DB || '/opt/agentfeed/liquidations.db';

const db = new Database(DB_PATH);
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
try { db.exec(`ALTER TABLE liquidations ADD COLUMN exchange TEXT NOT NULL DEFAULT 'bybit'`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_liq_ex_ts ON liquidations(exchange, ts)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_liq_ts ON liquidations(ts)`); } catch {}

const insert = db.prepare(
  'INSERT INTO liquidations (ts, symbol, side, size, price, usd, exchange) VALUES (?, ?, ?, ?, ?, ?, ?)'
);

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- universes
let BYBIT_SYMBOLS = ['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'DOGEUSDT']; // fallback
const OKX_CTVAL = {};   // instId -> contract size in COINS (linear USDT swaps only)

async function loadBybitUniverse() {
  try {
    const r = await fetch(EP.bybitApi);
    const j = await r.json();
    const list = (j?.result?.list || [])
      .filter(t => /USDT$/.test(t.symbol))                       // linear USDT perps only
      .sort((a, b) => parseFloat(b.turnover24h || 0) - parseFloat(a.turnover24h || 0))
      .slice(0, BYBIT_MAX)
      .map(t => t.symbol);
    if (list.length) BYBIT_SYMBOLS = list;
    log(`bybit universe: ${BYBIT_SYMBOLS.length} symbols (top ${BYBIT_MAX} by 24h turnover)`);
  } catch (e) {
    log('bybit universe fetch FAILED, using', BYBIT_SYMBOLS.length, 'fallback symbols:', e.message);
  }
}

async function loadOkxCtVals() {
  try {
    const r = await fetch(EP.okxApi);
    const j = await r.json();
    let n = 0;
    for (const it of j?.data || []) {
      // ONLY linear USDT swaps. Inverse (BTC-USD-SWAP) has ctValCcy=USD, so
      // contracts * ctVal would yield USD instead of coins -> silent units bug.
      if (!/-USDT-SWAP$/.test(it.instId)) continue;
      const v = parseFloat(it.ctVal);
      if (isFinite(v) && v > 0) { OKX_CTVAL[it.instId] = v; n++; }
    }
    log(`okx ctVal: ${n} linear USDT swaps loaded`);
  } catch (e) {
    log('okx ctVal fetch FAILED:', e.message, '- okx rows will be skipped until next boot');
  }
}

const okxSymbol = instId => instId.replace('-USDT-SWAP', '') + 'USDT';   // SOL-USDT-SWAP -> SOLUSDT

// ---------------------------------------------------------------- connection factory
function makeConn({ name, url, onOpen, onMessage, ping, pingMs, staleMs = 60000 }) {
  let ws, pingTimer, backoff = 1000, lastMsg = Date.now();

  setInterval(() => { // staleness watchdog
    if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMsg > staleMs) {
      const age = Math.round((Date.now() - lastMsg) / 1000);
      log(name, `stale (${age}s > ${staleMs / 1000}s), terminating`);
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
        if (ping) ws.send(ping);   // app-level ping (bybit {op:ping}, okx 'ping')
        else ws.ping();            // WS PROTOCOL ping frame (binance answers with a pong)
      }, pingMs);
      log(name, 'connected');
    });
    ws.on('ping', () => { lastMsg = Date.now(); });
    ws.on('pong', () => { lastMsg = Date.now(); });
    ws.on('message', (raw) => {
      lastMsg = Date.now();
      try { onMessage(raw.toString()); } catch (e) { console.error(name, 'handler error:', e.message); }
    });
    ws.on('close', () => {
      clearInterval(pingTimer);
      log(name, `disconnected, retry in ${backoff}ms`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60000);
    });
    ws.on('error', (e) => { console.error(name, 'ws error:', e.message); ws.close(); });
  }
  connect();
}

// ---------------------------------------------------------------- boot
(async () => {
  await Promise.all([loadBybitUniverse(), loadOkxCtVals()]);

  // ---- BYBIT: the only COMPLETE liquidation tape. Per-symbol topics -> chunked subscribe.
  let bybitAcked = 0, bybitFailed = 0;
  makeConn({
    name: 'bybit',
    url: EP.bybitWs,
    ping: JSON.stringify({ op: 'ping' }),
    pingMs: 15000,
    onOpen: (ws) => {
      bybitAcked = 0; bybitFailed = 0;
      const topics = BYBIT_SYMBOLS.map(s => `allLiquidation.${s}`);
      for (let i = 0; i < topics.length; i += SUB_CHUNK) {
        const chunk = topics.slice(i, i + SUB_CHUNK);
        setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ op: 'subscribe', req_id: `s${i}`, args: chunk }));
        }, (i / SUB_CHUNK) * SUB_GAP_MS);
      }
      const total = Math.ceil(topics.length / SUB_CHUNK);
      setTimeout(() => {
        log(`bybit subscribe: ${bybitAcked}/${total} frames acked` +
            (bybitFailed ? `  ${bybitFailed} FAILED <-- SYMBOLS NOT RECORDING` : ''));
      }, total * SUB_GAP_MS + 4000);
    },
    onMessage: (raw) => {
      const msg = JSON.parse(raw);
      if (msg.op === 'subscribe') {                       // <-- ACK VALIDATION (v2 ignored this)
        if (msg.success === false) { bybitFailed++; console.error('bybit SUBSCRIBE FAILED', msg.req_id, msg.ret_msg); }
        else bybitAcked++;
        return;
      }
      if (msg.op === 'ping' || msg.op === 'pong') return;  // pong ack
      if (!msg.topic || !msg.topic.startsWith('allLiquidation.') || !Array.isArray(msg.data)) return;
      for (const r of msg.data) {
        const size = parseFloat(r.v), price = parseFloat(r.p);
        if (!isFinite(size) || !isFinite(price) || size <= 0) continue;
        insert.run(r.T, r.s, r.S, size, price, size * price, 'bybit');  // S = position side already
      }
    },
  });

  // ---- OKX: instType-level sub = ALL swaps already. v2 filtered to 5 and binned the rest.
  makeConn({
    name: 'okx',
    url: EP.okxWs,
    ping: 'ping',
    pingMs: 20000,
    onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP' }] })),
    onMessage: (raw) => {
      if (raw === 'pong') return;
      const msg = JSON.parse(raw);
      if (msg.event === 'error') { console.error('okx SUBSCRIBE FAILED', msg.code, msg.msg); return; }
      if (msg.event === 'subscribe') { log('okx subscribed:', msg.arg?.channel, msg.arg?.instType); return; }
      if (msg.arg?.channel !== 'liquidation-orders' || !Array.isArray(msg.data)) return;
      for (const item of msg.data) {
        const ct = OKX_CTVAL[item.instId];
        if (!ct) continue;                                  // not a linear USDT swap (or ctVal missing)
        const symbol = okxSymbol(item.instId);
        for (const d of item.details || []) {
          const contracts = parseFloat(d.sz), price = parseFloat(d.bkPx);
          if (!isFinite(contracts) || !isFinite(price) || contracts <= 0) continue;
          const size = contracts * ct;                      // contracts -> coins
          const side = d.posSide === 'short' ? 'Sell' : 'Buy';
          insert.run(parseInt(d.ts), symbol, side, size, price, size * price, 'okx');
        }
      }
    },
  });

  // ---- BINANCE: !forceOrder@arr is the ALL-MARKET stream. v2 filtered to 5 and binned the rest.
  // Throttled 1/sec/symbol by Binance (documented, unfixable). /market path (legacy URLs dead 2026-04-23).
  makeConn({
    name: 'binance',
    url: EP.binanceWs,
    ping: null,          // null + pingMs>0 => WS protocol ping frame; binance pongs back
    pingMs: 30000,       // binance server pings only every 180s (docs) vs 60s watchdog ->
                         // without our own ping, healthy sockets died in every quiet stretch
    onMessage: (raw) => {
      const msg = JSON.parse(raw);
      if (msg.e !== 'forceOrder' || !msg.o) return;
      const o = msg.o;
      if (!/USDT$/.test(o.s)) return;                       // excludes USDC perps + dated futures (BTCUSDT_240927)
      const size = parseFloat(o.z), price = parseFloat(o.ap);   // z=filled qty, ap=avg fill price
      if (!isFinite(size) || !isFinite(price) || size <= 0) return;
      const side = o.S === 'SELL' ? 'Buy' : 'Sell';         // ORDER side -> POSITION side
      insert.run(o.T, o.s, side, size, price, size * price, 'binance');
    },
  });

  log(`liqcollector v3 up — bybit ${BYBIT_SYMBOLS.length} symbols | okx ${Object.keys(OKX_CTVAL).length} swaps | binance all USDT perps`);
})();
