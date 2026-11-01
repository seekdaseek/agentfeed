// test/r24-company-check-memory.test.js: the collection hook for large streamed reads (tools/r24/company-check/memory.js, R24 item 5, v3): a document of at least COLLECT_EVERY bytes asks for a garbage collection
// every COLLECT_EVERY bytes of itself, a smaller one never does, the environment can switch it off, and the function it would call is real. Controls: the counts are exact for sizes on both sides of the
// threshold; ops/r24-company-check-mutation-memory.js breaks the hook on purpose and requires this file to fail (R24_MEMORY_MODULE).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const M = require(process.env.R24_MEMORY_MODULE || path.join(__dirname, '..', 'tools', 'r24', 'company-check', 'memory'));
const CC = require('../tools/r24/company-check');
const R = require('../tools/r24/company-check/resolve');
const W = require('./fixtures/r24/company-check/world');

const MB = 1024 * 1024;

test('perDocument: no collection below the threshold, one per COLLECT_EVERY bytes above it, exact counts on both sides; null turns it off', () => {
  assert.equal(M.COLLECT_EVERY, 4 * MB);
  const counts = (total) => { let n = 0; const t = M.perDocument(() => { n++; }); for (let s = 0; s < total; s += 65536) t.add(Math.min(65536, total - s)); return n; };
  assert.equal(counts(1 * MB), 0); assert.equal(counts(4 * MB - 65536), 0, 'just under: none'); assert.equal(counts(4 * MB), 1, 'exactly at the threshold: one');
  assert.equal(counts(8 * MB - 1), 1); assert.equal(counts(8 * MB), 2); assert.equal(counts(12.8 * MB), 3, 'a 12.8 MB report: 3'); assert.equal(counts(40 * MB), 10, 'the 40 MB limit: 10');
  let n = 0; const off = M.perDocument(null); for (let s = 0; s < 20 * MB; s += 65536) off.add(65536); assert.equal(n, 0); assert.equal(off.runs, 0);
  const one = M.perDocument(() => { n++; }); one.add(40 * MB); assert.equal(n, 1, 'one huge chunk is one collection, not ten');
});

test('the collector: the environment switch turns it off; otherwise it is a real function that runs a collection (global.gc, or one obtained from V8 without --expose-gc)', () => {
  assert.equal(M.collector({ R24_COMPANYCHECK_NO_GC: '1' }), null);
  const g = M.collector({});
  assert.equal(typeof g, 'function'); assert.doesNotThrow(() => g());
  assert.equal(typeof M.collector({ R24_COMPANYCHECK_NO_GC: '0' }), 'function');
});

test('readFiling asks for the collections of its own document only: a 6 MiB report asks once, a small one never, a refusal in the middle stops the count', async () => {
  R._reset();
  const world = W.makeWorld({ chunk: 65536 });
  let runs = 0;
  const deps = { fetch: world.fetch, stream: world.stream, now: () => W.NOW, cache: CC.makeCache(), maxDocBytes: 40e6, collect: () => { runs++; } };
  const big = await CC.readFiling({ accession: world.companies.HUGE.filings[0].accession, primary_document: 'huge-20251231.htm', form: '10-K' }, '0001000008', deps);
  assert.ok(big.chars > 5000); assert.equal(runs, 1, 'a 6 MiB document: one collection');
  runs = 0;
  await CC.readFiling({ accession: world.companies.ALDR.filings[0].accession, primary_document: 'aldr-20251231.htm', form: '10-K' }, '0001000001', { ...deps, cache: CC.makeCache() });
  assert.equal(runs, 0, 'a small document: none');
  runs = 0;
  await assert.rejects(CC.readFiling({ accession: world.companies.HUGE.filings[0].accession, primary_document: 'huge-20251231.htm', form: '10-K' }, '0001000008', { ...deps, cache: CC.makeCache(), maxDocBytes: 5 * MB }), (e) => e.message.includes('read limit'));
  assert.equal(runs, 1, 'the 5 MiB refusal came after the first 4 MB had streamed: one collection');
  runs = 0;
  const off = await CC.readFiling({ accession: world.companies.HUGE.filings[0].accession, primary_document: 'huge-20251231.htm', form: '10-K' }, '0001000008', { ...deps, cache: CC.makeCache(), collect: null });
  assert.ok(off.chars > 5000); assert.equal(runs, 0, 'collect: null turns the hook off');
});
