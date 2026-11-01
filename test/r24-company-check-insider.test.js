// test/r24-company-check-insider.test.js: the Form 4 section of company-check v2 (tools/r24/company-check/insider.js) (R24 item 5). It must give the numbers tools/sec.js getInsiderTrades gives: the proof
// runs BOTH on the same synthetic EDGAR (the global fetch that sec.js uses is replaced by the synthetic one) and compares the counts, the sums and the open-market transactions, over three companies, with a
// control that the comparison can fail. Then the parts: the parse (purchases, sales, awards, tax withholding, a derivative table that never counts, two owners, a missing price, no owner, damaged XML),
// the 90-day window, the cap of 25 filings, the cache by accession (bounded), a missing Form 4 (skipped as sec.js skips it), an outage (the section fails, not the answer), and that no insider name is kept.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const INS = require(process.env.R24_INSIDER_MODULE || '../tools/r24/company-check/insider');
const E = require('../tools/r24/company-check/edgar');
const CC = require('../tools/r24/company-check');
const W = require('./fixtures/r24/company-check/world');

const realNow = Date.now.bind(Date);
const mine = async (world, cik, days = 90, rows) => {
  const d = { now: () => W.NOW, fetch: world.fetch, form4Cache: CC.makeCache() };
  const sub = await E.fetchSubmissions(cik, d);
  return INS.getInsiderTrades({ cik, days, rows: rows || sub.form4 }, d);
};
/** run tools/sec.js on the synthetic EDGAR: its global fetch is replaced, and its clock runs from the world's date (its token bucket needs a clock that moves) */
async function theirs(t, world, ticker, days = 90) {
  const t0 = realNow();
  t.mock.method(Date, 'now', () => W.NOW + (realNow() - t0));
  t.mock.method(globalThis, 'fetch', async (url) => {
    const r = await world.fetch(String(url));
    return { ok: r.status === 200, status: r.status, json: async () => JSON.parse(r.body.toString('utf8')), text: async () => r.body.toString('utf8') };
  });
  // a fresh copy of tools/sec.js, loaded under the moving clock (its token bucket takes the time at load; a clock that starts earlier than the real one would stall it)
  const path = require.resolve('../tools/sec'); delete require.cache[path];
  try { return await require(path).getInsiderTrades({ ticker, days }); } finally { t.mock.restoreAll(); delete require.cache[path]; }
}
const view = (r) => ({ window_days: r.window_days, form4_filings: r.form4_filings, filings_capped: r.filings_capped, transactions: r.transactions, buys: r.open_market_buys_usd, sales: r.open_market_sales_usd,
  ps: r.trades.filter((x) => x.code === 'P' || x.code === 'S').map((x) => [x.code, x.filed, x.value_usd]) });

test('the same numbers as tools/sec.js getInsiderTrades, on the same synthetic EDGAR: counts, sums, open-market transactions, the window and the cap of 25 (three companies)', async (t) => {
  const world = W.makeWorld();
  for (const [ticker, cik] of [['ALDR', '0001000001'], ['FRM4', '0001000015'], ['BRLG', '0001000002']]) {
    const a = view(await theirs(t, world, ticker)); const b = view(await mine(world, cik));
    assert.deepEqual(b, a, ticker);
  }
  const aldr = view(await mine(world, '0001000001'));
  assert.deepEqual([aldr.form4_filings, aldr.transactions, aldr.buys, aldr.sales], [2, 5, 1050, 1335], 'the June filing is outside the 90 days; the derivative table and the award never count');
  assert.deepEqual(aldr.ps, [['P', '2026-10-08', 1050], ['S', '2026-10-08', 800], ['S', '2026-09-15', 535]]);
  const frm = view(await mine(world, '0001000015')); assert.equal(frm.form4_filings, 25); assert.equal(frm.filings_capped, true);
  // a longer window: both give the June filing too
  const a180 = view(await theirs(t, world, 'ALDR', 180)); const b180 = view(await mine(world, '0001000001', 180)); assert.deepEqual(b180, a180); assert.equal(b180.form4_filings, 3);
  // control: the comparison can tell two different answers apart (the same company, one filing left out of ours)
  const d = { now: () => W.NOW, fetch: world.fetch, form4Cache: CC.makeCache() }; const sub = await E.fetchSubmissions('0001000001', d);
  const short = view(await INS.getInsiderTrades({ cik: '0001000001', days: 90, rows: sub.form4.slice(1) }, d));
  assert.notDeepEqual(short, view(await theirs(t, world, 'ALDR')), 'control: with a filing missing the views differ');
});

test('parseForm4: purchases and sales are valued, awards and tax withholding are transactions but not open-market, a derivative table never counts, two owners count once, a missing price has no value, no owner means nothing, damaged XML means nothing', () => {
  const tx = INS.parseForm4(W.form4([{ code: 'P', shares: 100, price: 10.5, ad: 'A' }, { code: 'S', shares: 3, price: 2.333, ad: 'D' }, { code: 'A', shares: 7, price: null }, { code: 'F', shares: 1, price: 4 }]));
  assert.deepEqual(tx, [{ code: 'P', value_usd: 1050 }, { code: 'S', value_usd: 7 }, { code: 'A', value_usd: null }, { code: 'F', value_usd: 4 }]);
  assert.deepEqual(INS.parseForm4(W.form4([], { derivative: true })), [], 'a Form 4 with only a derivative table (an option grant) has no open-market transaction');
  assert.equal(INS.parseForm4(W.form4([{ code: 'S', shares: 5, price: 2 }], { owners: 2 })).length, 1, 'two reporting owners are one filing');
  assert.deepEqual(INS.parseForm4('<ownershipDocument><nonDerivativeTable><nonDerivativeTransaction><transactionCoding><transactionCode>P</transactionCode></transactionCoding></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>'), [], 'no reporting owner: nothing, as in sec.js');
  assert.deepEqual(INS.parseForm4('<html>not a form 4</html>'), []);
  assert.deepEqual(INS.parseForm4(''), []);
  assert.ok(!JSON.stringify(tx).includes('Insider'), 'no insider name is kept');
});

test('a Form 4 that EDGAR does not serve is skipped; an outage fails the section (not the answer); a row with no readable document name reads nothing; results are cached per accession in a bounded cache', async () => {
  const world = W.makeWorld({ status: (u) => (/wk-form4_2/.test(u) ? 404 : null) });
  const r = await mine(world, '0001000001'); assert.deepEqual([r.form4_filings, r.open_market_buys_usd, r.open_market_sales_usd], [2, 1050, 800], 'the second filing is skipped');
  const down = W.makeWorld({ status: (u) => (/wk-form4_1/.test(u) ? 503 : null) });
  await assert.rejects(mine(down, '0001000001'), (e) => e.status === 503 && /Not charged\.$/.test(e.message));
  const d = { now: () => W.NOW, fetch: world.fetch, form4Cache: CC.makeCache() };
  const none = await INS.getInsiderTrades({ cik: '0001000001', days: 90, rows: [{ form: '4', filed: '2026-10-08', accession: '0000000001-26-000099', primary_document: null }, { form: '4', filed: '2026-10-07', accession: '0000000001-26-000098', primary_document: 'xslF345X05/../../x.xml' }] }, d);
  assert.deepEqual([none.form4_filings, none.transactions], [2, 0]); assert.deepEqual(world.calls.filter((u) => /000099|000098/.test(u)), []);
  // the cache by accession: the second call reads no Form 4
  const sub = await E.fetchSubmissions('0001000001', d); const w2 = world.calls.length;
  await INS.getInsiderTrades({ cik: '0001000001', days: 90, rows: sub.form4 }, d); const w3 = world.calls.length; await INS.getInsiderTrades({ cik: '0001000001', days: 90, rows: sub.form4 }, d);
  assert.equal(world.calls.length, w3, 'the second call came from the cache'); assert.ok(w3 > w2);
  const c = CC.makeCache({ maxEntries: 300, maxBytes: 256 * 1024 }); for (let i = 0; i < 2000; i++) c.set(`a${i}`, [{ code: 'S', value_usd: 1 }], 0); assert.ok(c.size <= 300 && c.bytes <= 256 * 1024);
});

test('end to end through companyCheck with the real reader (no stub): the Form 4 section is the numbers above, net direction and counts, the window stated, the source on sec.gov; a failing reader is a section with a reason', async () => {
  const world = W.makeWorld();
  const deps = { fetch: world.fetch, stream: world.stream, now: () => W.NOW, gate: CC.makeGate(), lane: CC.makeLane(), cache: CC.makeCache(), form4Cache: CC.makeCache(), getSiteSignals: async () => { throw new Error('no site'); } };
  const a = await CC.companyCheck({ q: 'ALDR' }, deps);
  assert.deepEqual([a.insider_form4.ok, a.insider_form4.window_days, a.insider_form4.window_complete, a.insider_form4.form4_filings, a.insider_form4.transactions], [true, 90, true, 2, 5]);
  assert.deepEqual([a.insider_form4.open_market_purchases, a.insider_form4.open_market_sales, a.insider_form4.net_usd, a.insider_form4.net_direction], [{ count: 1, usd: 1050 }, { count: 2, usd: 1335 }, -285, 'net_sales']);
  assert.equal(a.insider_form4.source, 'https://data.sec.gov/submissions/CIK0001000001.json', 'the filing list the Form 4 rows come from: a static object');
  const f = await CC.companyCheck({ q: 'FRM4' }, deps); assert.equal(f.insider_form4.window_complete, false); assert.ok(f.insider_form4.covers_from >= '2026-09-01');
  const down = W.makeWorld({ status: (u) => (/wk-form4/.test(u) ? 503 : null) });
  const g = await CC.companyCheck({ q: 'ALDR' }, { ...deps, fetch: down.fetch, stream: down.stream, form4Cache: CC.makeCache(), cache: CC.makeCache() });
  assert.equal(g.insider_form4.ok, false); assert.ok(g.insider_form4.reason); assert.equal(g.flags.going_concern, false, 'the answer stands');
  assert.equal(INS.CAP, 25);
});
