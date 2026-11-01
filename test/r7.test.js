// test/r7.test.js — R7 (13 Oct 2026): Bybit and Deribit out, Hyperliquid the one perp venue, the OI sampler,
// 503 + Retry-After for a source that failed or is stale, the 410 bodies, wallet-holdings on standard RPC.
//
// Offline: Hyperliquid is a local stub (a switch makes it answer 500), the liquidation tape and the OI sampler are
// scratch SQLite files, the whale snapshot is a scratch JSON file, and Solana RPC is injected.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-r7-'));
const NOW_S = Math.floor(Date.now() / 1000);
let server, stub = { down: false, calls: [] };
let D, M, EN, L, POS, HLP, OI, HW, MS, FN;

// ---- the Hyperliquid stub ------------------------------------------------------------------
const UNIVERSE = [
  { name: 'BTC', oi: 1000, mark: 80000, oracle: 80080, funding: 0.0000125, vol: 3e9, prev: 78000 },
  { name: 'SOL', oi: 500000, mark: 100, oracle: 99.9, funding: -0.00002, vol: 8e8, prev: 105 },
  { name: 'ETH', oi: 20000, mark: 4000, oracle: 4001, funding: 0.00001, vol: 2e9, prev: 3900 },
  { name: 'ONDO', oi: 9000000, mark: 1, oracle: 1, funding: 0.0001, vol: 5e6, prev: 0.9 },
  { name: 'kPEPE', oi: 4000000000, mark: 0.001, oracle: 0.001, funding: 0.00003, vol: 4e7, prev: 0.0011 },
  { name: 'TINY', oi: 10, mark: 1, oracle: 1, funding: 0.0005, vol: 1000, prev: 1 },
];
const ctxs = () => [{ universe: [...UNIVERSE.map((u) => ({ name: u.name, maxLeverage: 20 })), { name: 'GONE', isDelisted: true }] },
  [...UNIVERSE.map((u) => ({ funding: String(u.funding), openInterest: String(u.oi), markPx: String(u.mark), oraclePx: String(u.oracle), midPx: String(u.mark), premium: '0', prevDayPx: String(u.prev), dayNtlVlm: String(u.vol) })), null]];

test.before(async () => {
  server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const b = JSON.parse(body || '{}');
    stub.calls.push(b.type);
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (stub.down) return send(500, { error: 'down' });
    if (b.type === 'metaAndAssetCtxs') return send(200, ctxs());
    if (b.type === 'l2Book') return send(200, { levels: [[{ px: '99.9', sz: '10', n: 3 }, { px: '99.5', sz: '200', n: 9 }, { px: '98', sz: '5', n: 1 }], [{ px: '100.1', sz: '4', n: 2 }, { px: '100.6', sz: '50', n: 4 }]] });
    if (b.type === 'candleSnapshot') {
      const n = b.req.coin === 'ONDO' ? 5 : 32;
      return send(200, Array.from({ length: n }, (_, i) => ({ t: i, T: i + 1, c: String(100 * (1 + 0.01 * Math.sin(i))), h: '103', l: '97' })));
    }
    if (b.type === 'fundingHistory') return send(200, Array.from({ length: 40 }, (_, i) => ({ coin: b.coin, time: 1_700_000_000_000 + i * 3_600_000, fundingRate: i % 4 === 0 ? '-0.00001' : '0.00002' })));
    return send(404, { error: 'stub: ' + b.type });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.HL_API = `http://127.0.0.1:${server.address().port}/info`;
  process.env.SOLANA_RPC_URL = 'http://127.0.0.1:9';
  process.env.RPC_FALLBACKS = ''; require('../lib/solrpc')._reset();   // R20: no default public fallback behind the closed port

  // the tape: SOLUSDT has recent prints (a live tape); ZQQ8USDT was recorded three days ago and is on no venue
  const db = new Database(path.join(tmp, 'liq.db'));
  db.exec(`CREATE TABLE liquidations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, symbol TEXT NOT NULL,
           side TEXT NOT NULL, size REAL NOT NULL, price REAL NOT NULL, usd REAL NOT NULL, exchange TEXT NOT NULL DEFAULT 'bybit')`);
  const ins = db.prepare('INSERT INTO liquidations (ts, symbol, side, size, price, usd, exchange) VALUES (?,?,?,?,?,?,?)');
  ins.run(Date.now() - 3 * 86_400_000, 'ZQQ8USDT', 'Buy', 1, 100, 100, 'bybit');
  ins.run(Date.now() - 60_000, 'SOLUSDT', 'Buy', 10, 100, 1000, 'bybit');
  ins.run(Date.now() - 120_000, 'SOLUSDT', 'Sell', 5, 100, 500, 'okx');
  db.close();
  process.env.LIQ_DB = path.join(tmp, 'liq.db');

  process.env.HL_OI_DB = path.join(tmp, 'hl-oi.db'); // does not exist yet: the sampler is cold
  process.env.HL_WHALES_SNAPSHOT = path.join(tmp, 'hl-whales.json');
  process.env.HL_WHALES_LIST = path.join(tmp, 'hl-whales-list.json');

  HLP = require('../tools/hlperp');
  OI = require('../lib/hl-oi');
  D = require('../tools/derivs');
  M = require('../tools/micro');
  EN = require('../tools/entry');
  L = require('../tools/liqdb');
  POS = require('../tools/positioning');
  HW = require('../tools/hlwhales');
  MS = require('../tools/marketstate');
  FN = require('../tools/funding');
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const status = (fn) => fn().then(() => null, (e) => e);

// ---- Hyperliquid unreachable: a 503, never a note inside a 200 (these run FIRST: failures are not cached) -------------
test('Hyperliquid down: every route that stands on it answers 503 with "Not charged", none returns a 200 with a note', async () => {
  stub.down = true;
  const calls = {
    'open-interest': () => D.getOpenInterest({ symbol: 'SOLUSDT' }),
    'basis': () => D.getBasis({ symbol: 'SOLUSDT' }),
    'volatility': () => D.getVolatility({ symbol: 'SOLUSDT' }),
    'funding-history': () => D.getFundingHistory({ symbol: 'SOLUSDT' }),
    'funding-extremes': () => D.getFundingExtremes({}),
    'top-movers': () => D.getTopMovers({}),
    'orderbook-imbalance': () => M.getOrderbookImbalance({ symbol: 'SOLUSDT' }),
    'orderbook-walls': () => M.getOrderbookWalls({ symbol: 'SOLUSDT' }),
    'funding-rate': () => FN.getFundingRate({ symbol: 'SOLUSDT' }),
    'perp': () => EN.getPerp({ symbol: 'SOLUSDT' }),
    'funding-pulse': () => EN.getFundingPulse(),
    'squeeze-score': () => L.getSqueezeScore({ symbol: 'SOLUSDT' }),
  };
  for (const [name, fn] of Object.entries(calls)) {
    const e = await status(fn);
    assert.ok(e, `${name} threw`);
    assert.equal(e.status, 503, `${name}: ${e.message}`);
    assert.match(e.message, /Not charged/, name);
    assert.notEqual(e.kind, 'bad_request', name);
  }
  stub.down = false;
});

// ---- the route wrapper ----------------------------------------------------------------------
test('wrapper: 503 carries Retry-After (60 by default, the error\'s own value up to an hour) and the warming object', async () => {
  const { makeTool } = require('../lib/tool');
  const audit = [];
  const { tool } = makeTool({ paymentsOn: true, PRICES: { 'GET /api/a': { usd: 0.02 } }, decodeSettlement: () => ({ payer: 'P', transaction: 'T' }), logCall: (r) => audit.push(r) });
  const app = express();
  app.get('/api/a', tool('get_a', 0.02, () => { throw Object.assign(new Error('cold. Not charged.'), { status: 503 }); }));
  app.get('/api/b', tool('get_b', 0.02, () => { throw Object.assign(new Error('warming. Not charged.'), { status: 503, retryAfter: 1500, warming: { warm: false, needs_hours: 24 } }); }));
  app.get('/api/c', tool('get_c', 0.02, () => { throw Object.assign(new Error('x'), { status: 503, retryAfter: 999999 }); }));
  const s = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  try {
    const get = (p) => fetch(`http://127.0.0.1:${s.address().port}${p}`);
    const a = await get('/api/a'); assert.equal(a.status, 503); assert.equal(a.headers.get('retry-after'), '60'); assert.deepEqual(await a.json(), { tool: 'get_a', error: 'cold. Not charged.', retry_after: 60 });
    const b = await get('/api/b'); assert.equal(b.status, 503); assert.equal(b.headers.get('retry-after'), '1500'); const bj = await b.json(); assert.equal(bj.retry_after, 1500); assert.deepEqual(bj.warming, { warm: false, needs_hours: 24 });
    const c = await get('/api/c'); assert.equal(c.headers.get('retry-after'), '3600', 'capped at an hour');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(audit.every((r) => r.status !== 'paid'), 'no 503 leaves a paid row');
  } finally { s.close(); }
});

// ---- strict Hyperliquid reads ---------------------------------------------------------------
test('resolve: USDT symbols map to Hyperliquid coins (1000x bundles to the k prefix); an unlisted symbol is a 400 with examples', async () => {
  assert.equal((await HLP.resolve('SOLUSDT')).coin, 'SOL');
  assert.equal((await HLP.resolve('1000PEPEUSDT')).coin, 'kPEPE');
  const e = await status(() => HLP.resolve('ZQQ9USDT'));
  assert.equal(e.kind, 'bad_request');
  assert.match(e.message, /Hyperliquid lists no perp for it/);
  assert.match(e.message, /SOLUSDT, BTCUSDT/);
  assert.equal(e.supported, undefined, 'an open set is not presented as a closed list');
  // the delisted coin in the universe is not a perp
  assert.ok(!(await HLP.contexts()).has('GONE'));
});

// ---- routes on Hyperliquid alone ------------------------------------------------------------
test('funding-rate with a symbol: venues.hyperliquid only, at its hourly interval', async () => {
  const r = await FN.getFundingRate({ symbol: 'SOLUSDT' });
  assert.deepEqual(Object.keys(r.venues), ['hyperliquid']);
  const h = r.venues.hyperliquid;
  assert.equal(h.funding_rate_raw, -0.00002);
  assert.equal(h.funding_interval_hours, 1);
  assert.equal(h.funding_rate_8h, -0.00016);
  assert.equal(h.annualized_pct, Number((-0.00002 * 24 * 365 * 100).toFixed(2)));
  assert.equal(h.mark_price, 100);
  assert.equal(h.next_funding_time % 3_600_000, 0);
  assert.ok(!/bybit|okx/i.test(JSON.stringify(r)), 'no other venue in the answer');
  await assert.rejects(FN.getFundingRate({ symbol: 'ZQQ9USDT' }), (e) => e.kind === 'bad_request');
});

test('funding-extremes and top-movers: Hyperliquid universe, sorted, volume floor applied', async () => {
  const e = await D.getFundingExtremes({ limit: 2, min_turnover_usd: 1_000_000 });
  assert.equal(e.source, HLP.SRC);
  assert.equal(e.universe_size, 5, 'TINY is below the $1M floor, the delisted coin is not a perp');
  assert.deepEqual(e.most_positive.map((r) => r.coin), ['ONDO', 'kPEPE']);
  assert.deepEqual(e.most_negative.map((r) => r.coin), ['SOL', 'ETH']);
  assert.equal(e.most_positive[0].funding_rate_8h, 0.0008);
  assert.equal(e.most_positive[0].funding_interval_hours, 1);
  assert.ok(!/bybit/i.test(JSON.stringify(e)));
  const m = await D.getTopMovers({ limit: 1, min_turnover_usd: 1_000_000 });
  assert.equal(m.gainers[0].coin, 'ONDO'); // 0.9 -> 1.0
  assert.equal(m.losers[0].coin, 'kPEPE'); // 0.0011 -> 0.001, -9.1% (SOL is -4.8%)
  const all = await D.getTopMovers({ limit: 25, min_turnover_usd: 1 });
  assert.equal(all.universe_size, 6, 'a floor of 1 admits TINY');
});

test('funding-history: hourly settlements, 8x the mean raw rate, no other venue', async () => {
  const h = await D.getFundingHistory({ symbol: 'SOLUSDT', limit: 40 });
  assert.equal(h.intervals, 40);
  assert.equal(h.funding_interval_hours, 1);
  const raw = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? -0.00001 : 0.00002));
  assert.equal(h.avg_rate_8h, Number(((8 * raw.reduce((s, x) => s + x, 0)) / 40).toFixed(8)));
  assert.equal(h.positive_share_pct, 75);
  assert.equal(h.history.length, 40);
  assert.ok(h.history.every((r) => r.funding_interval_hours === 1 && r.rate_8h === r.funding_rate_raw * 8));
});

test('basis: mark against the Hyperliquid oracle; volatility from daily candles, a young listing is a 400', async () => {
  const b = await D.getBasis({ symbol: 'BTCUSDT' });
  assert.equal(b.basis_pct, Number((((80000 - 80080) / 80080) * 100).toFixed(4)));
  assert.match(b.basis_against, /oracle/);
  assert.equal(b.funding_rate_8h, 0.0000125 * 8);
  assert.ok(!('spot_price' in b));
  const v = await D.getVolatility({ symbol: 'SOLUSDT' });
  assert.ok(v.realized_vol_7d_ann_pct > 0 && v.realized_vol_30d_ann_pct > 0);
  assert.equal(v.today_range_pct, Number(((6 / Number(100 * (1 + 0.01 * Math.sin(31)))) * 100).toFixed(2)));
  const e = await status(() => D.getVolatility({ symbol: 'ONDOUSDT' }));
  assert.equal(e.kind, 'bad_request');
  assert.match(e.message, /not enough daily candles/);
});

test('orderbook imbalance and walls read the Hyperliquid book', async () => {
  const i = await M.getOrderbookImbalance({ symbol: 'SOLUSDT', bps: 100 });
  assert.equal(i.bid_usd, Math.round(99.9 * 10 + 99.5 * 200));
  assert.equal(i.ask_usd, Math.round(100.1 * 4 + 100.6 * 50));
  assert.ok(!('hyperliquid' in i), 'the answer IS the Hyperliquid read');
  const w = await M.getOrderbookWalls({ symbol: 'SOLUSDT', top: 1 });
  assert.equal(w.bid_walls[0].price, 99.5);
  assert.equal(w.ask_walls[0].price, 100.6);
  assert.equal(w.depth_levels, 5);
});

test('a malformed symbol is the caller\'s 400, never a server error', async () => {
  for (const bad of ['../etc', 'SOL USDT', 'A', 'X'.repeat(30)]) {
    const e = await status(() => D.getOpenInterest({ symbol: bad }));
    assert.equal(e.kind, 'bad_request', bad);
    assert.match(e.message, /^invalid symbol: /);
    assert.ok(e.message.length < 80, 'the message does not echo an unbounded input');
  }
});

// ---- the withdrawn routes ---------------------------------------------------------------------
test('withdrawn routes answer 410 with closest_live; the five of 12 Oct keep their body; nothing else is withdrawn', async () => {
  const compat = require('../lib/compat');
  assert.deepEqual(compat.WITHDRAWN.slice().sort(), ['/api/dex-quote', '/api/funding-cross', '/api/launch-odds', '/api/long-short', '/api/options-gex', '/api/options-summary', '/api/spread-arb', '/api/stablecoin-flows', '/api/tvl', '/api/whale-trades']);
  const app = express();
  for (const p of compat.WITHDRAWN) app.all(p, compat.makeWithdrawn({ ORIGIN: 'https://x' }));
  const s = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  try {
    const get = async (p, method = 'GET') => { const r = await fetch(`http://127.0.0.1:${s.address().port}${p}`, { method }); return [r.status, await r.json()]; };
    const [c1, b1] = await get('/api/long-short');
    assert.equal(c1, 410);
    assert.deepEqual(b1, { error: 'gone', status: 'withdrawn', route: '/api/long-short', withdrawn: '2026-10-13', closest_live: ['/api/hl-whales', '/api/liquidations'], pricing: 'https://x/pricing' });
    assert.deepEqual((await get('/api/whale-trades', 'POST'))[1].closest_live, ['/api/hl-whales', '/api/liquidations']);
    assert.deepEqual((await get('/api/options-summary'))[1].closest_live, ['/api/volatility']);
    assert.deepEqual((await get('/api/options-gex'))[1].closest_live, ['/api/volatility']);
    assert.deepEqual((await get('/api/funding-cross'))[1].closest_live, ['/api/funding-radar']);
    assert.deepEqual((await get('/api/spread-arb'))[1].closest_live, ['/api/basis']);
    const [c2, b2] = await get('/api/tvl');
    assert.equal(c2, 410);
    assert.deepEqual(b2, { error: 'gone', status: 'withdrawn', route: '/api/tvl', withdrawn: '2026-10-12', pricing: 'https://x/pricing' });
  } finally { s.close(); }
  const { EXP } = require('../expansion');
  const names = EXP.map((t) => t.name);
  for (const n of ['get_long_short', 'get_whale_trades', 'get_options_summary', 'get_options_gex', 'get_funding_cross', 'get_spread_arb']) assert.ok(!names.includes(n), `${n} is out of the route table`);
  const routes = EXP.map((t) => t.route);
  for (const w of compat.WITHDRAWN) assert.ok(!routes.includes('GET ' + w), `${w} is not a live route`);
});

// ---- the OI sampler: cold ---------------------------------------------------------------------
test('sampler cold: open-interest answers without its changes (a note), oi-spike-scan and squeeze-score answer 503 with the warm-up time', async () => {
  // ONDO: the route answers are cached for a minute, so the symbols the warm tests read are not touched here
  const oi = await D.getOpenInterest({ symbol: 'ONDOUSDT' });
  assert.equal(oi.oi_base, 9000000);
  assert.equal(oi.oi_usd, 9000000);
  assert.equal(oi.mark_price, 1);
  assert.equal(oi.change_1h_pct, null);
  assert.equal(oi.change_24h_pct, null);
  assert.match(oi.history_note, /sampler/);
  for (const [name, fn] of [['oi-spike-scan', () => D.getOiSpikeScan({})], ['squeeze-score', () => L.getSqueezeScore({ symbol: 'SOLUSDT' })]]) {
    const e = await status(fn);
    assert.equal(e.status, 503, name);
    assert.match(e.message, /Not charged/, name);
    assert.equal(e.warming.warm, false);
    assert.equal(e.warming.needs_hours, 24);
    assert.ok(e.retryAfter >= 60 && e.retryAfter <= 3600);
  }
  // an unsupported symbol is still the caller's 400 while the sampler is cold, never hidden behind the 503
  const bad = await status(() => L.getSqueezeScore({ symbol: 'ZQQ9USDT' }));
  assert.equal(bad.kind, 'bad_request');
  assert.equal(bad.supported, undefined);
});

// ---- the OI sampler: warm ---------------------------------------------------------------------
function seedSampler({ hours = 25, lastAgeS = 30, gapAt = null } = {}) {
  const db = OI.openRw();
  const last = NOW_S - lastAgeS;
  const steps = Math.floor((hours * 3600) / 300);
  for (let k = 0; k <= steps; k++) {
    const ts = last - k * 300;
    if (gapAt && ts <= last - gapAt[0] && ts >= last - gapAt[1]) continue;
    const t = steps - k; // 0 = oldest
    const rows = UNIVERSE.map((u) => {
      let oi = u.oi;
      if (u.name === 'SOL') oi = 500000 * (0.8 + 0.2 * (t / steps)) * (k === 0 ? 1.06 : k <= 12 ? 1 + 0.06 * (1 - k / 13) : 1); // +25% over 24h, a jump in the last hour
      if (u.name === 'ETH') oi = 20000 * (1 + 0.002 * Math.sin(t));
      if (u.name === 'BTC') oi = 1000 * (1 + 0.001 * Math.cos(t));
      return [u.name, ts, oi, u.mark * (k <= 12 ? 1.01 : 1), u.funding, u.vol];
    });
    OI.record(db, rows, ts);
  }
  db.close();
  OI.closeReader();
}

test('sampler warm: open-interest carries 1h and 24h changes in coin units', async () => {
  seedSampler();
  const w = OI.warm(86_400);
  assert.equal(w.warm, true);
  assert.ok(w.samples > 280);
  const oi = await D.getOpenInterest({ symbol: 'ETHUSDT' });
  assert.equal(typeof oi.change_1h_pct, 'number');
  assert.equal(typeof oi.change_24h_pct, 'number');
  assert.equal('history_note' in oi, false);
  const sol = await D.getOpenInterest({ symbol: 'SOLUSDT' });
  // the sample 24h back (288 steps from the newest, 12 of 300 from the oldest) holds 0.8 + 0.2 x 12/300 of 500k
  const base24 = 500000 * (0.8 + 0.2 * (12 / 300));
  assert.equal(sol.change_24h_pct, Number((((500000 - base24) / base24) * 100).toFixed(2)), '24h change of SOL OI against the sampled value a day back');
});

test('oi-spike-scan: ranks the unusual 1h jump first, ignores dust, reports its window and baseline', async () => {
  const r = await D.getOiSpikeScan({ limit: 5 });
  assert.equal(r.window_hours, 24);
  assert.ok(r.samples > 280);
  assert.equal(r.spikes[0].coin, 'SOL');
  assert.ok(r.spikes[0].oi_change_1h_pct >= 5, JSON.stringify(r.spikes[0]));
  assert.ok(r.spikes[0].spike_z > 3, `z ${r.spikes[0].spike_z}`);
  assert.equal(typeof r.spikes[0].oi_change_4h_pct, 'number');
  assert.ok(r.spikes[0].oi_change_24h_pct > 20);
  assert.ok(!r.spikes.some((s) => s.coin === 'TINY'), 'dust (under $3M of OI) is ignored');
  assert.ok(!/bybit/i.test(JSON.stringify(r)));
  assert.match(r.method, /coin units/);
});

test('oi-spike-scan: a stopped sampler and a gap in the record are 503, not a stale 200', async () => {
  const db = OI.openRw();
  db.prepare('DELETE FROM hl_oi').run(); db.close(); OI.closeReader();
  seedSampler({ hours: 25, lastAgeS: 1200 }); // newest sample 20 minutes old
  require('../lib/cache'); // keep the module cache warm; the key below is new
  const e = await status(() => D.getOiSpikeScan({ limit: 6 }));
  assert.equal(e.status, 503);
  assert.match(e.message, /sampler has not written/);
  const db2 = OI.openRw(); db2.prepare('DELETE FROM hl_oi').run(); db2.close(); OI.closeReader();
  seedSampler({ hours: 25, lastAgeS: 30, gapAt: [3500, 4700] }); // an outage around the 1h baseline
  const g = await status(() => D.getOiSpikeScan({ limit: 7 }));
  assert.equal(g.status, 503);
  assert.match(g.message, /gap/);
  const db3 = OI.openRw(); db3.prepare('DELETE FROM hl_oi').run(); db3.close(); OI.closeReader();
  seedSampler({ hours: 25, lastAgeS: 30 });
});

test('sampler retention keeps 7 days and the store refuses nothing else', () => {
  const db = OI.openRw();
  const old = NOW_S - 8 * 86400;
  db.prepare('INSERT INTO hl_oi (coin, ts, oi, mark, funding, vol24) VALUES (?,?,?,?,?,?)').run('OLD', old, 1, 1, 0, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM hl_oi WHERE coin = 'OLD'").get().n, 1, 'an 8-day-old row is there until the next sample prunes it');
  const s = OI.record(db, [['SOL', NOW_S - 1, 1, 1, 0, 0]], NOW_S);
  assert.ok(s.pruned >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM hl_oi WHERE coin = 'OLD'").get().n, 0);
  db.close();
  const rows = OI.rowsFrom(ctxs(), NOW_S);
  assert.equal(rows.length, UNIVERSE.length, 'delisted and context-less entries are skipped');
  assert.deepEqual(rows.find((r) => r[0] === 'BTC'), ['BTC', NOW_S, 1000, 80000, 0.0000125, 3e9]);
});

// ---- whales: crowding for squeeze-score and positioning ----------------------------------------
function writeWhales(positions) {
  fs.writeFileSync(process.env.HL_WHALES_SNAPSHOT, JSON.stringify({ at: Date.now(), marks: { BTC: 80000, SOL: 100, ETH: 4000 }, positions, scanned: 250, withPositions: 40, failed: 0, listAt: Date.now(), listRows: 100000 }));
  const t = new Date(Date.now() + Math.random() * 1000); fs.utimesSync(process.env.HL_WHALES_SNAPSHOT, t, t);
}
const pos = (coin, side, notional, addr) => ({ address: addr, coin, side, size: 1, notional_usd: notional, entry_px: 1, mark_px: 1, liquidation_px: 1, liq_distance_pct: 20, unrealized_pnl_usd: 0, leverage: 5, margin_mode: 'cross', account_equity_usd: 1e6 });

test('whaleShare: the long share of the top accounts\' gross notional, null when nobody holds the coin', async () => {
  writeWhales([pos('SOL', 'short', 7_000_000, '0xa'), pos('SOL', 'short', 2_000_000, '0xb'), pos('SOL', 'long', 1_000_000, '0xc'), pos('BTC', 'long', 9_000_000, '0xa'), pos('BTC', 'short', 1_000_000, '0xd')]);
  const sol = await HW.whaleShare('SOL');
  assert.equal(sol.net_long_share_pct, 10);
  assert.equal(sol.long_accounts, 1);
  assert.equal(sol.short_accounts, 2);
  assert.equal(sol.whale_list_size, 250);
  assert.equal((await HW.whaleShare('BTC')).net_long_share_pct, 90);
  assert.equal((await HW.whaleShare('ONDO')).net_long_share_pct, null);
});

test('squeeze-score on Hyperliquid inputs: shorts crowded + OI building reads as squeeze fuel; the inputs name their source', async () => {
  const r = await L.getSqueezeScore({ symbol: 'SOLUSDT' });
  assert.equal(r.symbol, 'SOLUSDT');
  assert.equal(r.inputs.funding_interval_hours, 1);
  assert.equal(r.inputs.funding_rate_8h, -0.00016);
  assert.equal(r.inputs.whale_net_long_share_pct, 10);
  assert.equal(typeof r.inputs.oi_change_24h_pct, 'number');
  assert.equal('long_account_pct' in r.inputs, false, 'the retail account ratio is gone');
  assert.match(r.inputs.whale_list, /top 250 Hyperliquid accounts/);
  assert.deepEqual(r.inputs.liq_24h, { longs_usd: 1000, shorts_usd: 500 });
  assert.ok(r.short_squeeze_score > r.long_flush_score, `${r.short_squeeze_score} vs ${r.long_flush_score}`);
  assert.match(r.note, /whale crowding/);
  assert.ok(!/bybit/i.test(JSON.stringify(r)));
});

test('squeeze-score: a listed coin no top account holds declines with 200 (the decline is the product); a symbol on no venue and not in the tape is a 400', async () => {
  const d = await L.getSqueezeScore({ symbol: 'ONDOUSDT' });
  assert.equal(d.decline, 'insufficient_inputs');
  assert.deepEqual(d.missing_inputs, ['whale_net_long_share_pct']);
  assert.equal(d.recorded_in_tape, false);
  // tape-only symbol (not on Hyperliquid): all three venue inputs missing, still a 200 decline
  const t = await L.getSqueezeScore({ symbol: 'ZQQ8USDT' });
  assert.equal(t.decline, 'insufficient_inputs');
  assert.deepEqual(t.missing_inputs, ['funding_rate_8h', 'oi_change_24h_pct', 'whale_net_long_share_pct']);
  assert.equal(t.recorded_in_tape, true);
  await assert.rejects(L.getSqueezeScore({ symbol: 'ZQQ9USDT' }), (e) => e.kind === 'bad_request' && /nothing to score/.test(e.message) && e.supported === undefined);
});

test('squeeze-score: an unavailable whale snapshot is a 503, not a score on two inputs', async () => {
  fs.rmSync(process.env.HL_WHALES_SNAPSHOT);
  stub.down = true; // the on-demand refresh cannot reach Hyperliquid either
  const e = await status(() => L.getSqueezeScore({ symbol: 'BTCUSDT' }));
  stub.down = false;
  assert.ok(e && e.status === 503, e && e.message);
  assert.match(e.message, /Not charged/);
});

test('positioning: SOL and BTC open interest with changes, plus the whale net-long share; no retail ratio, no second venue', async () => {
  writeWhales([pos('SOL', 'short', 7_000_000, '0xa'), pos('SOL', 'long', 3_000_000, '0xc'), pos('BTC', 'long', 9_000_000, '0xa'), pos('BTC', 'short', 1_000_000, '0xd')]);
  const p = await POS.getPositioning();
  assert.deepEqual(Object.keys(p).filter((k) => k !== 'source' && k !== 'history_note').sort(), ['btc', 'sol']);
  assert.equal(p.sol.whale_positioning.net_long_share_pct, 30);
  assert.equal(p.btc.whale_positioning.net_long_share_pct, 90);
  assert.equal(p.sol.open_interest.base, 500000);
  assert.equal(p.sol.open_interest.usd, 50000000);
  assert.equal(typeof p.sol.open_interest.change_24h_pct, 'number');
  assert.match(p.sol.whale_positioning.covers, /top 250 Hyperliquid accounts/);
  const s = JSON.stringify(p);
  for (const gone of ['long_short_ratio', 'bybit', 'long_pct']) assert.ok(!s.includes(gone), gone);
});

// ---- perp, liq-pulse, funding-pulse ---------------------------------------------------------------
test('perp: Hyperliquid funding and open interest plus the tape; a tape-only symbol is answered from the tape; unknown is a 400', async () => {
  const r = await EN.getPerp({ symbol: 'SOLUSDT' });
  assert.deepEqual(Object.keys(r.funding.venues), ['hyperliquid']);
  assert.equal(r.funding.crowding, 'shorts_pay');
  assert.equal(r.open_interest.hyperliquid.oi_usd, 50000000);
  assert.equal('long_short' in r, false);
  assert.equal(r.liquidations_24h.prints, 2);
  assert.equal(r.partial, null);
  assert.ok(!/bybit/i.test(JSON.stringify(r.funding) + JSON.stringify(r.open_interest)));
  const t = await EN.getPerp({ symbol: 'ZQQ8USDT' });
  assert.equal(t.funding, null);
  assert.equal(t.open_interest, null);
  assert.equal(t.partial.length, 2);
  assert.equal(t.liquidations_24h.prints, 0);
  await assert.rejects(EN.getPerp({ symbol: 'ZQQ9USDT' }), (e) => e.kind === 'bad_request' && /Hyperliquid lists no perp/.test(e.message) && /never appeared in our liquidation tape/.test(e.message));
});

test('funding-pulse: the 5 most extreme annualised rates across Hyperliquid, one venue', async () => {
  const f = await EN.getFundingPulse();
  assert.deepEqual(f.venue_scope, ['hyperliquid']);
  assert.equal(f.extremes.length, 5);
  assert.equal(f.extremes[0].coin, 'ONDO');
  assert.ok(f.extremes.every((r) => r.venue === 'hyperliquid'));
  assert.ok(f.extremes.every((r, i) => i === 0 || Math.abs(f.extremes[i - 1].annualized_pct) >= Math.abs(r.annualized_pct)));
  assert.ok(!/bybit/i.test(JSON.stringify(f)));
});

test('liq-pulse: a live tape answers; an empty or stale tape is a 503, never a 200 saying so', async () => {
  const live = await EN.getLiqPulse();
  assert.equal(live.stale, false);
  assert.ok(live.prints >= 2);
  // a stale tape: a second module instance over a database whose newest row is two hours old
  const stale = path.join(tmp, 'stale.db');
  const db = new Database(stale);
  db.exec(`CREATE TABLE liquidations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, size REAL NOT NULL, price REAL NOT NULL, usd REAL NOT NULL, exchange TEXT NOT NULL DEFAULT 'bybit')`);
  db.prepare('INSERT INTO liquidations (ts, symbol, side, size, price, usd) VALUES (?,?,?,?,?,?)').run(Date.now() - 7_200_000, 'SOLUSDT', 'Buy', 1, 1, 1);
  db.close();
  const empty = path.join(tmp, 'empty.db');
  const e2 = new Database(empty);
  e2.exec(`CREATE TABLE liquidations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, size REAL NOT NULL, price REAL NOT NULL, usd REAL NOT NULL, exchange TEXT NOT NULL DEFAULT 'bybit')`);
  e2.close();
  for (const [file, re] of [[stale, /7[12]\d\ds old, past the 1800s freshness bound/], [empty, /tape is empty/]]) {
    const out = require('child_process').spawnSync(process.execPath, ['-e', `process.env.LIQ_DB=${JSON.stringify(file)};require('${path.join(__dirname, '..', 'tools', 'entry').replace(/\\/g, '/')}').getLiqPulse().then(()=>console.log('RESOLVED'),(e)=>console.log(JSON.stringify({status:e.status,message:e.message})))`], { encoding: 'utf8' });
    const o = JSON.parse(out.stdout.trim());
    assert.equal(o.status, 503, out.stdout + out.stderr);
    assert.match(o.message, re);
    assert.match(o.message, /Not charged/);
  }
});

// ---- market-state ---------------------------------------------------------------------------------
test('market-state: no implied vol, no long/short, no second venue; Hyperliquid parts present; the whole route is a 503 when nothing could be built', async () => {
  writeWhales([pos('BTC', 'long', 9_000_000, '0xa'), pos('BTC', 'short', 1_000_000, '0xd')]);
  const r = await MS.getMarketState({ symbol: 'BTC' });
  for (const gone of ['implied_vol', 'iv_minus_rv_30d_vol_pts', 'long_short']) assert.equal(gone in r, false, gone);
  assert.ok(!r.flags.includes('iv_rich') && !r.flags.includes('iv_cheap'));
  assert.ok(!('iv_rich' in r.flag_rules) && !('iv_cheap' in r.flag_rules));
  assert.equal(r.whale_positioning.net_long_share_pct, 90);
  assert.equal(r.open_interest.hyperliquid_usd, 80000000);
  assert.equal(r.perp.source, 'Hyperliquid perp mark vs oracle');
  assert.equal(typeof r.realized_vol.rv_30d_ann_pct, 'number');
  const { liquidations, ...rest } = r; // the liquidation tape's own source line names its exchanges (the one exception)
  assert.ok(liquidations && liquidations.source, 'the tape part is there');
  assert.ok(!/bybit|deribit|dvol/i.test(JSON.stringify(rest)), 'no Bybit or Deribit anywhere else in the answer');
});

// ---- wallet-holdings on standard RPC ----------------------------------------------------------------
test('wallet-holdings: balances from standard RPC reads, NFT-shaped holdings counted apart, no indexer, native SOL at our price', async () => {
  const { getWalletHoldings } = require('../tools/onchain');
  const W = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7';
  const accounts = [
    { mint: 'MINT1', amount: 5, raw: '5000000', decimals: 6, program: 'spl-token' },
    { mint: 'MINT2', amount: 12.5, raw: '12500000000', decimals: 9, program: 'spl-token-2022' },
    { mint: 'NFT1', amount: 1, raw: '1', decimals: 0, program: 'spl-token' },
    { mint: 'NFT2', amount: 1, raw: '1', decimals: 0, program: 'spl-token-2022' },
    { mint: 'DEC0', amount: 7, raw: '7', decimals: 0, program: 'spl-token' }, // 0 decimals but 7 units: fungible
  ];
  const seen = [];
  const out = await getWalletHoldings(W, {
    priceFn: async (s) => { assert.equal(s, 'SOL'); return { price: 100, source: 'on-chain DEX mid, test pools' }; },
    balanceFn: async () => ({ value: 2_500_000_000 }),
    accountsFn: async () => accounts,
    metadataFn: async (mints) => { seen.push(mints); return new Map([['MINT1', { symbol: 'AAA' }], ['MINT2', { symbol: 'BBB' }]]); },
  });
  assert.equal(out.native_sol, 2.5);
  assert.equal(out.native_sol_usd, 250);
  assert.match(out.native_sol_usd_source, /AgentFeed's own price: on-chain DEX mid, test pools/);
  assert.deepEqual(out.fungible_tokens, [
    { mint: 'MINT1', symbol: 'AAA', amount: 5, decimals: 6, program: 'spl-token' },
    { mint: 'MINT2', symbol: 'BBB', amount: 12.5, decimals: 9, program: 'spl-token-2022' },
    { mint: 'DEC0', symbol: null, amount: 7, decimals: 0, program: 'spl-token' },
  ]);
  assert.equal(out.fungible_count, 3);
  assert.equal(out.nft_count, 2);
  assert.equal(out.total_items, 5);
  assert.deepEqual(seen[0], ['MINT1', 'MINT2', 'DEC0'], 'metadata is read for the listed fungibles only');
  assert.match(out.source, /^Solana RPC/);
  assert.ok(!/helius|das/i.test(JSON.stringify(out)), 'no mention of the indexer');
  assert.match(out.note, /compressed NFTs have no token account/);
  const s = JSON.stringify(out);
  for (const leaked of ['price_usd', 'value_usd', 'price_per_token']) assert.ok(!s.includes(leaked), leaked);
  // the SOL price cannot be read: balances still come back, the value is null with the reason
  const down = await getWalletHoldings(W, { priceFn: async () => { throw new Error('boom'); }, balanceFn: async () => ({ value: 1e9 }), accountsFn: async () => [], metadataFn: async () => new Map() });
  assert.equal(down.native_sol, 1);
  assert.equal(down.native_sol_usd, null);
  assert.match(down.native_sol_usd_source, /unavailable/);
  assert.equal(down.nft_count, 0);
  // metadata that cannot be read costs the symbols, not the balances
  const nometa = await getWalletHoldings(W, { priceFn: async () => ({ price: 1, source: 's' }), balanceFn: async () => ({ value: 0 }), accountsFn: async () => accounts.slice(0, 1), metadataFn: async () => { throw new Error('rpc down'); } });
  assert.deepEqual(nometa.fungible_tokens, [{ mint: 'MINT1', symbol: null, amount: 5, decimals: 6, program: 'spl-token' }]);
  await assert.rejects(getWalletHoldings('not-a-wallet'), (e) => e.kind === 'bad_request');
  await assert.rejects(getWalletHoldings(''), (e) => e.kind === 'bad_request');
});

test('wallet-holdings: more than 100 fungible accounts are cut at 100 and counted', async () => {
  const { getWalletHoldings } = require('../tools/onchain');
  const many = Array.from({ length: 130 }, (_, i) => ({ mint: `M${i}`, amount: 2 + i, raw: String(2 + i), decimals: 0, program: 'spl-token' }));
  const out = await getWalletHoldings('4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7', { priceFn: async () => ({ price: 1, source: 's' }), balanceFn: async () => ({ value: 0 }), accountsFn: async () => many, metadataFn: async () => new Map() });
  assert.equal(out.fungible_tokens.length, 100);
  assert.equal(out.fungible_count, 130);
  assert.match(out.fungible_tokens_note, /first 100 of 130/);
});

// ---- the source guard: no Bybit or Deribit read outside the liquidation tape ---------------------------
test('guard: no module under tools/ or bin/ calls a Bybit, Deribit, OKX or Binance endpoint (the tape collector is the one exception and lives at the repo root)', () => {
  const root = path.join(__dirname, '..');
  const files = [...fs.readdirSync(path.join(root, 'tools')).map((f) => path.join('tools', f)), ...fs.readdirSync(path.join(root, 'bin')).map((f) => path.join('bin', f)), ...fs.readdirSync(path.join(root, 'lib')).map((f) => path.join('lib', f))]
    .filter((f) => /\.(js|mjs)$/.test(f));
  assert.ok(files.length > 30, 'the scan saw the source files');
  const re = /bybit\.com|deribit\.com|okx\.com|binance\.com|BYBIT_REST|OKX_REST|DERIBIT/i;
  const hits = files.filter((f) => re.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepEqual(hits, [], 'banned venues are not read');
  assert.ok(re.test("fetch('https://api.bybit.com/v5/market/tickers')") && re.test('process.env.BYBIT_REST') && re.test('www.deribit.com/api/v2'), 'negative control: the pattern finds real hits');
  for (const f of ['tools/options.js', 'bin/options-collect.js']) assert.ok(!fs.existsSync(path.join(root, f)), `${f} is gone`);
});
