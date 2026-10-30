// bin/brief-calibrate.js (pensio round 2): the weekly refresh of the move-alert tails. A bad fetch never replaces a good table, the write is atomic, and the table's age is
// stated from day 30 (route method, daily af-digest line). No network anywhere: the Hyperliquid API is a stub.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../bin/brief-calibrate');

const NOW = Date.UTC(2026, 9, 30, 4, 10, 0);
const INTERVAL_MS = { '5m': 300_000, '1h': 3_600_000, '4h': 14_400_000 };
const names = (n) => Array.from({ length: n }, (_, i) => `C${String(i).padStart(2, '0')}`);

/** a stub of the info API: `candles(coin, interval)` -> how many complete candles to return (0 = an HTTP 500), `coins` listed in metaAndAssetCtxs */
function stub({ coins = 30, candles = () => 5000, status429 = new Set() } = {}) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.type === 'metaAndAssetCtxs') {
      const ns = names(coins);
      return { ok: true, status: 200, json: async () => [{ universe: ns.map((name) => ({ name })) }, ns.map((_, i) => ({ openInterest: String(1000 - i), markPx: '10' }))] };
    }
    const { coin, interval } = body.req;
    if (status429.has(coin)) return { ok: false, status: 429, json: async () => ({}) };
    const n = candles(coin, interval);
    if (!n) return { ok: false, status: 500, json: async () => ({}) };
    const ms = INTERVAL_MS[interval];
    let px = 100 + (coin.charCodeAt(2) % 7);
    const out = [];
    for (let i = 0; i < n; i++) { px *= 1 + (((i * 7919 + coin.charCodeAt(2)) % 200) - 100) / 20000; const t = NOW - (n - i + 1) * ms; out.push({ t, T: t + ms - 1, c: String(px) }); }
    return { ok: true, status: 200, json: async () => out };
  };
  return { fetchImpl, calls };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'brief-cal-'));
const run = (o) => C.run({ gapMs: 0, sleepFn: async () => {}, log: () => {}, nowMs: NOW, shipped: '/nonexistent/calibration.json', ...o });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('a complete fetch is written: every coin has all three horizons with n over the minimum, the file is the new table, and no temp file is left behind', async () => {
  const d = tmp(); const out = path.join(d, 'brief-calibration.json');
  const s = stub();
  const doc = await run({ out, fetchImpl: s.fetchImpl });
  assert.equal(doc.rejected, undefined);
  const w = readJson(out);
  assert.equal(Object.keys(w.coins).length, 30);
  for (const c of Object.values(w.coins)) for (const [h, min] of Object.entries(C.MIN_N)) assert.ok(c[h] && c[h].n >= min, `${h} n=${c[h] && c[h].n}`);
  assert.equal(w.fetched_at, new Date(NOW).toISOString());
  assert.equal(w.accepted, true);
  assert.deepEqual(fs.readdirSync(d), ['brief-calibration.json'], 'no temp file');
  assert.equal(s.calls.length, 1 + 30 * 3, 'one meta call and one candle request per coin and horizon, one at a time');
  fs.rmSync(d, { recursive: true, force: true });
});
test('a short fetch (the API returned a fraction of the candles) is refused and the current table stays byte for byte', async () => {
  const d = tmp(); const out = path.join(d, 'brief-calibration.json');
  await run({ out, fetchImpl: stub().fetchImpl });
  const before = fs.readFileSync(out);
  const logs = [];
  const doc = await run({ out, log: (l) => logs.push(l), nowMs: NOW + 7 * 86400_000, fetchImpl: stub({ candles: (c, i) => (i === '5m' ? 1500 : 5000) }).fetchImpl });
  assert.ok(doc.rejected && /only 0 of 30 requested coins are complete/.test(doc.rejected[0]), JSON.stringify(doc.rejected));
  assert.deepEqual(fs.readFileSync(out), before);
  assert.ok(logs.some((l) => /NOT written/.test(l)));
  assert.deepEqual(fs.readdirSync(d), ['brief-calibration.json']);
  fs.rmSync(d, { recursive: true, force: true });
});
test('a fetch where a third of the coins failed is refused; one where 24 of 30 are complete (80%) is taken', async () => {
  const d = tmp(); const out = path.join(d, 'brief-calibration.json');
  const bad = await run({ out, fetchImpl: stub({ candles: (c) => (Number(c.slice(1)) < 10 ? 0 : 5000) }).fetchImpl });
  assert.ok(bad.rejected && bad.rejected.some((r) => /only 20 of 30/.test(r)) && bad.rejected.some((r) => /requests failed/.test(r)), JSON.stringify(bad.rejected));
  assert.ok(!fs.existsSync(out), 'nothing was written');
  const ok = await run({ out, fetchImpl: stub({ candles: (c) => (Number(c.slice(1)) < 6 ? 0 : 5000) }).fetchImpl });
  assert.equal(ok.rejected, undefined, JSON.stringify(ok.rejected));
  assert.equal(Object.keys(readJson(out).coins).length, 24);
  fs.rmSync(d, { recursive: true, force: true });
});
test('a table that covers far fewer coins than the current one is refused even when it is complete (a coverage regression)', async () => {
  const d = tmp(); const out = path.join(d, 'brief-calibration.json');
  await run({ out, fetchImpl: stub().fetchImpl });
  const before = fs.readFileSync(out);
  const doc = await run({ out, coinsN: 20, fetchImpl: stub().fetchImpl });
  assert.ok(doc.rejected && /covers only 20 of the 30 coins the current one covers/.test(doc.rejected[0]), JSON.stringify(doc.rejected));
  assert.deepEqual(fs.readFileSync(out), before);
  fs.rmSync(d, { recursive: true, force: true });
});
test('the first run is also checked against the table that ships with the code', async () => {
  const d = tmp(); const out = path.join(d, 'brief-calibration.json'); const shipped = path.join(d, 'shipped.json');
  fs.writeFileSync(shipped, JSON.stringify({ coins: Object.fromEntries(names(30).map((c) => [c, {}])) }));
  const doc = await run({ out, shipped, coinsN: 20, fetchImpl: stub().fetchImpl });
  assert.ok(doc.rejected && /of the 30 coins the current one covers/.test(doc.rejected[0]));
  assert.ok(!fs.existsSync(out));
  fs.rmSync(d, { recursive: true, force: true });
});
test('a 429 backs off and retries once; a write that dies half way leaves the current table intact and no temp file (the rename is the commit)', async () => {
  const d = tmp(); const out = path.join(d, 'brief-calibration.json');
  const sleeps = [];
  const s429 = stub();
  let first = true;
  const inner = s429.fetchImpl;
  const f = async (u, i) => { const b = JSON.parse(i.body); if (first && b.type === 'candleSnapshot') { first = false; return { ok: false, status: 429, json: async () => ({}) }; } return inner(u, i); };
  await run({ out, fetchImpl: f, sleepFn: async (ms) => { sleeps.push(ms); } });
  assert.ok(sleeps.includes(30000), 'a 429 waits 30 s before the one retry');
  const before = fs.readFileSync(out);
  // a crash mid-write: the temp file gets half the text and writeFileSync throws
  const crashing = { ...fs, writeFileSync: (file, text) => { fs.writeFileSync(file, String(text).slice(0, 40)); throw new Error('disk full'); } };
  await assert.rejects(run({ out, fetchImpl: stub().fetchImpl, nowMs: NOW + 86400_000, fsImpl: crashing }), /disk full/);
  assert.deepEqual(fs.readFileSync(out), before, 'the current table is whole');
  JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(fs.readdirSync(d), ['brief-calibration.json'], 'and the half-written temp file was removed');
  fs.rmSync(d, { recursive: true, force: true });
});
test('writeAtomic and accept, directly: the temp file sits beside the target; 5m or 1h under 4,000 windows is not complete; 4h needs 1,000', () => {
  const d = tmp(); const f = path.join(d, 't.json');
  const seen = [];
  C.writeAtomic(f, '{"a":1}', { ...fs, renameSync: (a, b) => { seen.push([path.dirname(a) === path.dirname(b), /\.tmp$/.test(a)]); fs.renameSync(a, b); } });
  assert.deepEqual(seen, [[true, true]]);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1}');
  const coin = (n5, n1, n4) => ({ '5m': { n: n5 }, '1h': { n: n1 }, '4h': { n: n4 } });
  const doc = (n5, n1, n4) => ({ coins: Object.fromEntries(names(10).map((c) => [c, coin(n5, n1, n4)])), errors: [] });
  assert.equal(C.accept(doc(4999, 4999, 1867), { wanted: 10, requests: 30 }).ok, true);
  assert.equal(C.accept(doc(3999, 4999, 2000), { wanted: 10, requests: 30 }).ok, false, '5m under 4,000');
  assert.equal(C.accept(doc(4999, 3999, 2000), { wanted: 10, requests: 30 }).ok, false, '1h under 4,000');
  assert.equal(C.accept(doc(4999, 4999, 999), { wanted: 10, requests: 30 }).ok, false, '4h under 1,000');
  assert.equal(C.accept({ coins: {}, errors: [] }, { wanted: 10, requests: 0 }).ok, false, 'an empty table');
  fs.rmSync(d, { recursive: true, force: true });
});
