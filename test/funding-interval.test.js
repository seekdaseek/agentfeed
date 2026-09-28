// test/funding-interval.test.js — every venue funding rate is read at the
// interval that venue quotes it for (Phase 7, 2026-09-28).
//
// Real Bybit, OKX and Hyperliquid answers, captured on 2026-09-28 and trimmed to
// the test symbols (test/fixtures/funding-venues.json), are served by a local
// stub. The REAL tools/derivs.js and tools/liqdb.js are pointed at it through
// the env overrides they already read (BYBIT_REST, OKX_REST, HL_API, LIQ_DB).
//
//   SOLUSDT   8h on Bybit and OKX -- its 8h figure must be the raw rate itself
//   ONDOUSDT  4h on Bybit and OKX -- its 8h figure must be exactly 2 x raw
//   AKEUSDT   history that moved between 4h and 1h inside the window
//   BPUSDT    a real PreLaunch perp kept in the tickers but left OUT of the
//             instruments sweep, so its interval cannot be read
//
// Negative controls: the 8h symbol is not doubled; the unreadable interval is
// named, never ranked on a guessed 8h; a symbol no venue lists is the caller's
// error only when every venue answered.
//
// Run:  node --test test/funding-interval.test.js        (from the service root)

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'funding-venues.json'), 'utf8'));
const fx = (k) => { if (!(k in FX)) throw new Error(`no fixture for ${k}`); return FX[k]; };

let server, D, L, tmp;

test.before(async () => {
  // exact request -> captured answer. Two test-only rules: Bybit answers any
  // symbol it does not list the way it answered ZQQ1USDT, and OKX answers 503
  // for ZQQ2, standing in for a venue that could not be asked. The history rule
  // below lets the old code be judged by these same fixtures.
  server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const [, venue, ...rest] = req.url.split('/');
    const url = '/' + rest.join('/');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (venue === 'okx' && url.includes('ZQQ2')) return send(503, { msg: 'unavailable' });
    const key = req.method === 'POST' ? `POST ${url} ${JSON.parse(body || '{}').type}` : `GET ${url}`;
    if (key in FX) return send(200, FX[key]);
    // Bybit's limit=N history is the first N rows of a longer answer (measured
    // 2026-09-28: SOLUSDT limit=31's first 30 equal limit=30), so a shorter
    // window is served from the captured longer one.
    const hist = /^\/v5\/market\/funding\/history\?category=linear&symbol=([A-Z0-9]+)&limit=(\d+)$/.exec(url);
    if (venue === 'bybit' && hist) {
      const cap = Object.keys(FX).find((k) => k.startsWith(`GET /v5/market/funding/history?category=linear&symbol=${hist[1]}&limit=`) && !k.includes('endTime'));
      if (cap && FX[cap].result.list.length >= Number(hist[2])) {
        return send(200, { ...FX[cap], result: { ...FX[cap].result, list: FX[cap].result.list.slice(0, Number(hist[2])) } });
      }
    }
    if (venue === 'bybit' && /tickers\?category=linear&symbol=ZQQ/.test(url)) return send(200, FX['GET /v5/market/tickers?category=linear&symbol=ZQQ1USDT']);
    return send(404, { error: `no fixture for ${key}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.BYBIT_REST = `${base}/bybit`;
  process.env.OKX_REST = `${base}/okx`;
  process.env.HL_API = `${base}/hl/info`;

  // squeeze-score reads the liquidation tape: an empty one is a quiet 24h
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-funding-test-'));
  const db = new Database(path.join(tmp, 'liq.db'));
  db.exec(`CREATE TABLE liquidations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, symbol TEXT NOT NULL,
           side TEXT NOT NULL, size REAL NOT NULL, price REAL NOT NULL, usd REAL NOT NULL, exchange TEXT NOT NULL DEFAULT 'bybit')`);
  db.close();
  process.env.LIQ_DB = path.join(tmp, 'liq.db'); // read by liqdb.js at require time

  D = require('../tools/derivs');
  L = require('../tools/liqdb');
});

test.after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ann = (raw, ih) => Number((raw * (24 / ih) * 365 * 100).toFixed(2));

// Value checks that need none of the new fields, so they judge the old code by
// the same yardstick: the 8h symbol must PASS on old and new code alike, and the
// 4h symbol must FAIL on the old code, which published the raw 4h rate as 8h.
const venueRaw = (sym) => ({
  bybit: Number(fx(`GET /v5/market/tickers?category=linear&symbol=${sym}`).result.list[0].fundingRate),
  okx: Number(fx(`GET /api/v5/public/funding-rate?instId=${sym.replace(/USDT$/, '')}-USDT-SWAP`).data[0].fundingRate),
});

test('values, 8h symbol: SOLUSDT 8h figures equal the venue raw rate (negative control, holds on old code too)', async () => {
  const raw = venueRaw('SOLUSDT');
  const x = await D.getFundingCross({ symbol: 'SOLUSDT' });
  assert.equal(x.venues.bybit.funding_rate_8h, raw.bybit);
  assert.equal(x.venues.okx.funding_rate_8h, raw.okx);
  assert.equal((await D.getBasis({ symbol: 'SOLUSDT' })).funding_rate_8h, raw.bybit);
  const hist = fx('GET /v5/market/funding/history?category=linear&symbol=SOLUSDT&limit=31').result.list;
  const h = await D.getFundingHistory({ symbol: 'SOLUSDT' });
  h.history.forEach((r, i) => assert.equal(r.rate_8h, Number(hist[i].fundingRate)));
});

test('values, 4h symbol: ONDOUSDT 8h figures are twice the venue raw rate', async () => {
  const raw = venueRaw('ONDOUSDT');
  const x = await D.getFundingCross({ symbol: 'ONDOUSDT' });
  assert.equal(x.venues.bybit.funding_rate_8h, 2 * raw.bybit);
  assert.equal(x.venues.okx.funding_rate_8h, 2 * raw.okx);
  assert.equal((await D.getBasis({ symbol: 'ONDOUSDT' })).funding_rate_8h, 2 * raw.bybit);
  const hist = fx('GET /v5/market/funding/history?category=linear&symbol=ONDOUSDT&limit=31').result.list;
  const h = await D.getFundingHistory({ symbol: 'ONDOUSDT' });
  h.history.forEach((r, i) => assert.equal(r.rate_8h, 2 * Number(hist[i].fundingRate)));
});

test('SOLUSDT (8h): every 8h figure is the raw rate itself, never doubled (negative control)', async () => {
  const x = await D.getFundingCross({ symbol: 'SOLUSDT' });
  const by = fx('GET /v5/market/tickers?category=linear&symbol=SOLUSDT').result.list[0];
  const ok = fx('GET /api/v5/public/funding-rate?instId=SOL-USDT-SWAP').data[0];
  assert.equal(x.venues.bybit.funding_interval_hours, 8);
  assert.equal(x.venues.bybit.funding_rate_raw, Number(by.fundingRate));
  assert.equal(x.venues.bybit.funding_rate_8h, Number(by.fundingRate));
  assert.equal(x.venues.okx.funding_interval_hours, 8);
  assert.equal(x.venues.okx.funding_rate_8h, Number(ok.fundingRate));
  // OKX's fundingTime is its next settlement; nextFundingTime is the one after
  assert.equal(x.venues.okx.next_funding_time, Number(ok.fundingTime));
  assert.equal(x.venues.hyperliquid.funding_interval_hours, 1);
  assert.equal(x.venues.hyperliquid.funding_rate_raw, x.venues.hyperliquid.funding_rate_1h);

  const b = await D.getBasis({ symbol: 'SOLUSDT' });
  assert.equal(b.funding_rate_8h, Number(by.fundingRate));
  assert.equal(b.funding_interval_hours, 8);

  const h = await D.getFundingHistory({ symbol: 'SOLUSDT' });
  assert.equal(h.history.length, 30);
  for (const r of h.history) {
    assert.equal(r.funding_interval_hours, 8);
    assert.equal(r.rate_8h, r.funding_rate_raw);
  }
  const mean = h.history.reduce((s, r) => s + r.funding_rate_raw, 0) / h.history.length;
  assert.equal(h.avg_rate_8h, Number(mean.toFixed(8)), 'one interval throughout: the plain mean, as before');
});

test('ONDOUSDT (4h): every 8h figure is exactly twice the raw rate', async () => {
  const x = await D.getFundingCross({ symbol: 'ONDOUSDT' });
  for (const v of ['bybit', 'okx']) {
    assert.equal(x.venues[v].funding_interval_hours, 4, v);
    assert.equal(x.venues[v].funding_rate_8h, 2 * x.venues[v].funding_rate_raw, v);
  }
  const rates = [x.venues.bybit.funding_rate_8h, x.venues.okx.funding_rate_8h, x.venues.hyperliquid.funding_rate_8h_equiv];
  assert.equal(x.spread_8h, Number((Math.max(...rates) - Math.min(...rates)).toFixed(8)), 'spread on like-for-like 8h rates');

  const b = await D.getBasis({ symbol: 'ONDOUSDT' });
  assert.equal(b.funding_interval_hours, 4);
  assert.equal(b.funding_rate_8h, 2 * b.funding_rate_raw);

  const h = await D.getFundingHistory({ symbol: 'ONDOUSDT' });
  assert.equal(h.history.length, 30);
  for (const r of h.history) {
    assert.equal(r.funding_interval_hours, 4);
    assert.equal(r.rate_8h, 2 * r.funding_rate_raw);
  }
  const avg = (8 * h.history.reduce((s, r) => s + r.funding_rate_raw, 0)) / (4 * h.history.length);
  assert.equal(h.avg_rate_8h, Number(avg.toFixed(8)));
  assert.equal(h.avg_annualized_pct, Number((avg * 3 * 365 * 100).toFixed(2)));
});

test('funding-extremes ranks on the 8h equivalent and annualises raw x 24/interval x 365 x 100', async () => {
  const e = await D.getFundingExtremes({ min_turnover_usd: 1, limit: 25 });
  const rows = [...e.most_positive, ...e.most_negative];
  for (const r of rows) {
    assert.equal(r.funding_rate_8h, (r.funding_rate_raw * 8) / r.funding_interval_hours, r.symbol);
    assert.equal(r.annualized_pct, ann(r.funding_rate_raw, r.funding_interval_hours), r.symbol);
  }
  const ondo = rows.find((r) => r.symbol === 'ONDOUSDT');
  assert.equal(ondo.funding_interval_hours, 4);
  assert.equal(ondo.annualized_pct, Number((ondo.funding_rate_raw * 6 * 365 * 100).toFixed(2)));
  const v = e.most_positive.map((r) => r.funding_rate_8h);
  assert.ok(v.every((x, i) => i === 0 || v[i - 1] >= x), 'most_positive sorted on the 8h equivalent');
});

test('an interval that cannot be read is named, never ranked on a guessed 8h (negative control)', async () => {
  const e = await D.getFundingExtremes({ min_turnover_usd: 1, limit: 25 });
  assert.deepEqual(e.unranked_interval_unknown, ['BPUSDT']);
  assert.ok(![...e.most_positive, ...e.most_negative].some((r) => r.symbol === 'BPUSDT'));

  const m = await D.getTopMovers({ min_turnover_usd: 1, limit: 25 });
  const bp = [...m.gainers, ...m.losers].find((r) => r.symbol === 'BPUSDT');
  assert.equal(typeof bp.funding_rate_raw, 'number');
  assert.equal(bp.funding_interval_hours, null);
  assert.equal(bp.funding_rate_8h, null);
  assert.match(m.funding_interval_note, /null rather than a guess/);
});

test('funding-history reads each settlement at the interval it closed (AKEUSDT: 4h and 1h)', async () => {
  const h = await D.getFundingHistory({ symbol: 'AKEUSDT', limit: 200 });
  const src = fx('GET /v5/market/funding/history?category=linear&symbol=AKEUSDT&limit=200').result.list;
  const before = Object.entries(FX).find(([k]) => k.includes('symbol=AKEUSDT&endTime='))[1].result.list[0];
  assert.equal(h.history.length, 200);
  let unknown = 0;
  for (let i = 0; i < src.length; i++) {
    const gap = (Number(src[i].fundingRateTimestamp) - Number((src[i + 1] || before).fundingRateTimestamp)) / 3_600_000;
    const r = h.history[i];
    if ([1, 2, 4, 8].includes(gap)) {
      assert.equal(r.funding_interval_hours, gap, `row ${i}`);
      assert.equal(r.rate_8h, (r.funding_rate_raw * 8) / gap, `row ${i}`);
    } else {
      unknown++;
      assert.equal(r.funding_interval_hours, null, `row ${i} gap ${gap}h`);
      assert.equal(r.rate_8h, null, `row ${i} gap ${gap}h`);
    }
  }
  assert.ok(h.history.some((r) => r.funding_interval_hours === 1) && h.history.some((r) => r.funding_interval_hours === 4));
  assert.notEqual(h.history[199].funding_interval_hours, null, 'the oldest row got its predecessor from a second call');
  if (unknown) assert.match(h.funding_interval_note, new RegExp(`^${unknown} of 200 settlements`));
});

test('no venue lists it: a named caller error only when every venue answered (negative control)', async () => {
  await assert.rejects(D.getFundingCross({ symbol: 'ZQQ1USDT' }),
    (e) => e.kind === 'bad_request' && /bybit, okx and hyperliquid each answered and none lists it/.test(e.message));
  await assert.rejects(D.getFundingCross({ symbol: 'ZQQ2USDT' }),
    (e) => e.kind === undefined && /no answer from okx/.test(e.message));
});

test('squeeze-score scores the 8h equivalent: ONDOUSDT at 2 x raw, SOLUSDT unchanged', async () => {
  const s = await L.getSqueezeScore({ symbol: 'ONDOUSDT' });
  assert.equal(s.inputs.funding_interval_hours, 4);
  assert.equal(s.inputs.funding_rate_8h, 2 * s.inputs.funding_rate_raw);
  const t = await L.getSqueezeScore({ symbol: 'SOLUSDT' });
  assert.equal(t.inputs.funding_interval_hours, 8);
  assert.equal(t.inputs.funding_rate_8h, t.inputs.funding_rate_raw);
});
