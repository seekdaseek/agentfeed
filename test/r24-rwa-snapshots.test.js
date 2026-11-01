// R24 item 3: the snapshot store, the daily collector (bin/r24-rwa-snapshot.js) and the route's use of snapshots (history_source). Synthetic chain, scratch databases, no network.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const C = require('./fixtures/r24/rwa/chain');
const E = require('../tools/r24/rwa/evaluate');
const R = require('../tools/r24/rwa/rpc');
const RD = require('../tools/r24/rwa/reader');
const S = require('../tools/r24/rwa/snapshots');
const P = require('../tools/r24/rwa/products');
const collector = require('../bin/r24-rwa-snapshot');

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rwasnap-')); dirs.push(d); return d; };
test.after(() => { S.closeReaders(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const caches = () => ({ history: E.makeStore(64, E.HISTORY_TTL_MS), blocks: E.makeStore(16, E.HISTORY_TTL_MS), answers: E.makeStore(16, E.ANSWER_TTL_MS), health: new Map() });

function setup(chainOpts = {}, endpoints = { 'https://rpc-a.example': { mode: 'ok' } }) {
  RD._decimalsMemo.clear();
  const chain = C.makeChain(chainOpts);
  const rpc = R.makeRpc({ endpoints: Object.keys(endpoints), fetchImpl: chain.fetchFor(endpoints), now: chain.clock, budget: 400 });
  return { chain, rpc, c: caches() };
}
/** a snapshot file with one row per product per day for `days` days back from the head (taken at the same time of day as the head) */
function fill(chain, file, days, { skip = () => false, tweak = (r) => r } = {}) {
  const db = S.openWriter(file);
  for (let d = 0; d <= days; d++) {
    const ts = C.HEAD_TS - d * 86400;
    for (const p of P.served()) if (!skip(p, d)) S.record(db, tweak({ product: p.id, block: C.HEAD - d * 7200, blockTs: ts, priceRaw: chain.priceOf(p, ts), decimals: p.read.decimals, updatedAt: p.read.kind === 'round' ? ts - 3 * 3600 : null }, p, d));
  }
  db.close();
}
const oldCalls = (s) => s.chain.calls.filter((c) => c.method === 'eth_call' && Number(BigInt(c.params[1])) < C.HEAD);
const evalWith = (s, file, ids) => E.evaluate({ products: (ids || P.served().map((p) => p.id)).map(P.byId), deps: { rpc: s.rpc, now: s.chain.clock, caches: s.c, snapshotDb: S.openReader(file, s.chain.clock) } });

test('store: one row per product per UTC day (the first of the day stays), bounded by prune, and the row checks refuse a bad price', () => {
  const file = path.join(tmp(), 'snap.db'); const db = S.openWriter(file);
  const row = { product: 'usdy', block: 100, blockTs: 1793600000, priceRaw: 1151646183300394284n, decimals: 18, updatedAt: null };
  assert.equal(S.record(db, row), true); assert.equal(S.record(db, { ...row, block: 101, blockTs: row.blockTs + 600, priceRaw: 2n }), false, 'same UTC day: ignored');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rwa_snap').get().n, 1); assert.equal(db.prepare('SELECT price_raw FROM rwa_snap').get().price_raw, '1151646183300394284');
  assert.equal(S.record(db, { ...row, blockTs: row.blockTs + 86400 }), true, 'next day: added');
  for (const bad of [{ priceRaw: 0n }, { priceRaw: -5n }, { priceRaw: 5 }, { block: 1.5 }, { blockTs: 0 }]) assert.throws(() => S.record(db, { ...row, ...bad }), /snapshot/, JSON.stringify(bad, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  for (let d = 2; d < 450; d++) S.record(db, { ...row, blockTs: row.blockTs + d * 86400 });
  const latest = row.blockTs + 449 * 86400;
  const gone = S.prune(db, latest, S.KEEP_DAYS);
  assert.ok(gone > 40 && db.prepare('SELECT COUNT(*) AS n FROM rwa_snap').get().n <= S.KEEP_DAYS + 1, 'bounded at the keep period'); assert.equal(S.prune(db, latest, S.KEEP_DAYS), 0, 'a second prune removes nothing');
  assert.equal(S.dayOf(1793600000), new Date(1793600000 * 1000).toISOString().slice(0, 10));
  db.close();
});

test('store: the default path is beside the audit database, R24_RWA_DB wins, an in-memory audit database means no snapshots; a missing file is no snapshots (and is looked at again later)', () => {
  assert.equal(S.defaultPath({ R24_RWA_DB: '/x/y.db', AGENTFEED_DB: '/a/b.db' }), '/x/y.db');
  assert.equal(S.defaultPath({ AGENTFEED_DB: '/a/b/agentfeed.db' }), '/a/b/rwa-snapshots.db');
  assert.equal(S.defaultPath({ AGENTFEED_DB: ':memory:' }), null);
  assert.ok(S.defaultPath({}).endsWith('rwa-snapshots.db'));
  let t = 0; const file = path.join(tmp(), 'later.db');
  assert.equal(S.openReader(file, () => t), null);
  S.openWriter(file).close();
  assert.equal(S.openReader(file, () => t), null, 'not re-checked within the rest period');
  t += S.TOLERANCE_S * 1000; assert.ok(S.openReader(file, () => t), 'found once the file exists and the rest is over');
  assert.equal(S.openReader(null), null);
});

test('route: with >= 30 days of snapshots every window comes from them and not one old-state request is made; the answer says so', async () => {
  const s = setup(); const file = path.join(tmp(), 'snap.db'); fill(s.chain, file, 33);
  const out = await evalWith(s, file);
  assert.equal(oldCalls(s).length, 0, 'zero archive reads');
  assert.ok(!s.chain.calls.some((c) => c.method === 'eth_getBlockByNumber' && c.params[0] !== 'latest'), 'no past block was looked up either');
  for (const a of out.products) { assert.equal(a.history_source, 'snapshots'); assert.deepEqual(a.history_source_by_window, { '7d': 'snapshots', '30d': 'snapshots' }); }
  // the figures equal the ones the contract gives (the snapshots hold the same prices)
  const s2 = setup(); const viaChain = await E.evaluate({ products: P.served(), deps: { rpc: s2.rpc, now: s2.chain.clock, caches: caches(), snapshotDb: null } });
  for (const a of out.products) { const b = viaChain.products.find((x) => x.product === a.product); assert.ok(Math.abs(a.yield_30d_annualized - b.yield_30d_annualized) < 0.01, a.product); assert.ok(Math.abs(a.yield_7d_annualized - b.yield_7d_annualized) < 0.01, a.product); }
});

test('route: with 12 days of snapshots the 7-day window uses them and the 30-day window reads the contract; the answer says which, per window, and "contract" overall', async () => {
  const s = setup(); const file = path.join(tmp(), 'snap.db'); fill(s.chain, file, 12);
  const out = await evalWith(s, file, ['usdy']);
  const a = out.products[0];
  assert.deepEqual(a.history_source_by_window, { '7d': 'snapshots', '30d': 'contract' }); assert.equal(a.history_source, 'contract');
  assert.ok(oldCalls(s).length >= 1, 'the 30-day point is read from the contract');
  assert.ok(oldCalls(s).length <= 2, 'only the 30-day point (and its block lookup), not the 7-day one');
});

test('route: a snapshot that fails the checks (zero price, other decimals, outside the band, too far from the time) is ignored and the contract is read instead (control: the same file with good rows is used)', async () => {
  const good = setup(); const goodFile = path.join(tmp(), 'g.db'); fill(good.chain, goodFile, 33);
  assert.equal((await evalWith(good, goodFile, ['usdy'])).products[0].history_source, 'snapshots');
  for (const [name, tweak, skip] of [
    ['zero price', (r) => ({ ...r, priceRaw: 1n }), null],
    ['other decimals', (r) => ({ ...r, decimals: 6 }), null],
    ['outside the band', (r) => ({ ...r, priceRaw: r.priceRaw * 5n }), null],
    ['no row near the time (a gap of 3 days around day 30)', null, (p, d) => d >= 28 && d <= 32],
  ]) {
    const s = setup(); const file = path.join(tmp(), 'b.db'); fill(s.chain, file, 33, { ...(tweak ? { tweak } : {}), ...(skip ? { skip } : {}) });
    const a = (await evalWith(s, file, ['usdy'])).products[0];
    assert.notEqual(a.history_source_by_window['30d'], 'snapshots', name);
    assert.ok(oldCalls(s).length >= 1, `${name}: read from the contract`);
    assert.ok(a.yield_30d_annualized > 0 && a.yield_30d_annualized < 12, name);
  }
});

test('route: a stored price that is not a plain positive integer in text (1.5e18, abc, -5, empty, a hex string) is skipped, never thrown on; the contract is read instead', async () => {
  for (const junk of ['1.5e18', 'abc', '-5', '', '0x10', ' 5', '5 ', '00', '9'.repeat(90)]) {
    const s = setup(); const file = path.join(tmp(), 'j.db'); fill(s.chain, file, 33);
    const w = new Database(file); w.prepare('UPDATE rwa_snap SET price_raw = ? WHERE product = ?').run(junk, 'usdy'); w.close(); S.closeReaders();
    const a = (await evalWith(s, file, ['usdy'])).products[0];
    assert.notEqual(a.history_source_by_window['30d'], 'snapshots', JSON.stringify(junk));
    assert.ok(oldCalls(s).length >= 1, `${JSON.stringify(junk)}: read from the contract`);
  }
});

test('route: a snapshot file that is not a database, or has no table, is no snapshots (the contract is read); the route never writes to it', async () => {
  const d = tmp(); const junk = path.join(d, 'junk.db'); fs.writeFileSync(junk, 'this is not sqlite');
  const empty = path.join(d, 'empty.db'); new Database(empty).close();
  for (const f of [junk, empty]) {
    const s = setup(); S.closeReaders();
    const a = (await evalWith(s, f, ['usdy'])).products[0];
    assert.equal(a.history_source, 'contract');
  }
  const f = path.join(d, 'ro.db'); const s = setup(); fill(s.chain, f, 33); const before = fs.statSync(f).mtimeMs; S.closeReaders();
  await evalWith(s, f, ['usdy']); assert.equal(fs.statSync(f).mtimeMs, before);
  const ro = S.openReader(f); assert.throws(() => ro.prepare('DELETE FROM rwa_snap').run(), /readonly/i);
});

// ---------------------------------------------------------------------------------------------------------------------------------------- the collector
test('collector: one run writes one row per served product; a second run the same UTC day writes none; output has no URL, key or remote text; exit 0', async () => {
  const s = setup({}, { 'https://rpc-a.example/v2/KEY-SECRET-123': { mode: 'ok' } }); const file = path.join(tmp(), 'c.db'); const lines = [];
  const deps = { rpc: s.rpc, now: s.chain.clock };
  assert.equal(await collector.run({ env: { R24_RWA_DB: file }, deps, out: (l) => lines.push(l) }), 0);
  const db = new Database(file, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rwa_snap').get().n, P.served().length);
  const r = db.prepare("SELECT * FROM rwa_snap WHERE product = 'ustb'").get();
  assert.equal(r.block, C.HEAD); assert.equal(r.block_ts, C.HEAD_TS); assert.equal(r.decimals, 6); assert.equal(BigInt(r.price_raw), s.chain.priceOf(P.byId('ustb'), C.HEAD_TS)); assert.equal(r.updated_at, C.HEAD_TS - 3 * 3600);
  assert.equal(lines.filter((l) => / added /.test(l)).length, P.served().length);
  lines.length = 0;
  assert.equal(await collector.run({ env: { R24_RWA_DB: file }, deps: { rpc: setup().rpc, now: s.chain.clock }, out: (l) => lines.push(l) }), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rwa_snap').get().n, P.served().length, 'idempotent');
  assert.equal(lines.filter((l) => / exists /.test(l)).length, P.served().length);
  assert.ok(!/SECRET|https?:\/\/|rpc-a/.test(lines.join('\n')));
  db.close();
  // the next UTC day adds one more row per product
  const later = C.makeChain({ now: (C.HEAD_TS + 86400) * 1000 }); void later;
});

test('collector: a failing product is skipped, the others are written, exit code 2; nothing is written for a refused read (control: without the fault, all are written)', async () => {
  const s = setup({ revert: ['ustb'] }); const file = path.join(tmp(), 'c.db'); const lines = [];
  assert.equal(await collector.run({ env: { R24_RWA_DB: file }, deps: { rpc: s.rpc, now: s.chain.clock }, out: (l) => lines.push(l) }), 2);
  const db = new Database(file, { readonly: true });
  const got = db.prepare('SELECT product FROM rwa_snap').all().map((x) => x.product).sort();
  assert.deepEqual(got, P.served().map((p) => p.id).filter((id) => id !== 'ustb').sort());
  assert.ok(lines.some((l) => / ustb FAILED revert/.test(l)));
  db.close();
  for (const [name, opts, id] of [['out of band', { price: { ousg: () => 5n * 10n ** 18n } }, 'ousg'], ['stale oracle', { updatedAge: { usyc: 9 * 86400 } }, 'usyc'], ['zero', { rawResult: { usdy: '0x' + '0'.repeat(64) } }, 'usdy']]) {
    const t = setup(opts); const f = path.join(tmp(), 'x.db');
    assert.equal(await collector.run({ env: { R24_RWA_DB: f }, deps: { rpc: t.rpc, now: t.chain.clock }, out: () => {} }), 2, name);
    const d2 = new Database(f, { readonly: true }); assert.equal(d2.prepare('SELECT COUNT(*) AS n FROM rwa_snap WHERE product = ?').get(id).n, 0, name); assert.equal(d2.prepare('SELECT COUNT(*) AS n FROM rwa_snap').get().n, P.served().length - 1, name); d2.close();
  }
  const ok = setup(); const f = path.join(tmp(), 'ok.db');
  assert.equal(await collector.run({ env: { R24_RWA_DB: f }, deps: { rpc: ok.rpc, now: ok.chain.clock }, out: () => {} }), 0);
});

test('collector: an RPC that is down writes nothing and exits 2; no database path is exit 1; --dry writes no file', async () => {
  const s = setup({}, { 'https://rpc-a.example': { mode: 'down' } }); const file = path.join(tmp(), 'd.db'); const lines = [];
  assert.equal(await collector.run({ env: { R24_RWA_DB: file }, deps: { rpc: s.rpc, now: s.chain.clock }, out: (l) => lines.push(l) }), 2);
  assert.ok(!fs.existsSync(file)); assert.match(lines.join(' '), /FAILED head/);
  assert.equal(await collector.run({ env: { AGENTFEED_DB: ':memory:' }, deps: { rpc: setup().rpc }, out: () => {} }), 1);
  const dry = setup(); const f2 = path.join(tmp(), 'dry.db');
  assert.equal(await collector.run({ env: { R24_RWA_DB: f2 }, argv: ['--dry'], deps: { rpc: dry.rpc, now: dry.chain.clock }, out: () => {} }), 0);
  assert.ok(!fs.existsSync(f2));
});

test('collector: prunes rows older than the keep period on each run, so the file stays bounded', async () => {
  const s = setup(); const file = path.join(tmp(), 'p.db');
  const db = S.openWriter(file);
  for (let d = 1; d <= 450; d++) S.record(db, { product: 'usdy', block: 1, blockTs: C.HEAD_TS - d * 86400, priceRaw: 10n ** 18n, decimals: 18, updatedAt: null });
  db.close();
  assert.equal(await collector.run({ env: { R24_RWA_DB: file }, deps: { rpc: s.rpc, now: s.chain.clock }, out: () => {} }), 0);
  const d2 = new Database(file, { readonly: true });
  assert.ok(d2.prepare("SELECT COUNT(*) AS n FROM rwa_snap WHERE product = 'usdy'").get().n <= S.KEEP_DAYS + 1);
  assert.equal(d2.prepare("SELECT COUNT(*) AS n FROM rwa_snap WHERE block_ts < ?").get(C.HEAD_TS - S.KEEP_DAYS * 86400).n, 0);
  d2.close();
});
