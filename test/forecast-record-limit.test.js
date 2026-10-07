// test/forecast-record-limit.test.js — the free /api/forecast-record route and
// the get_forecast_record MCP tool clamp `rows` to an integer in 1..500
// (2026-10-07).
//
// Before: Math.min(Number(rows) || 50, 500) had no lower bound. rows=-1 reached
// caliper's exportRows as LIMIT -1, which SQLite reads as "no limit", and one
// request loaded every row of record.db into the process (OOM kill, 2026-10-04
// 17:32 UTC, anon-rss 1.93 GB). The record worker also gets a heap ceiling, so
// a runaway read ends the worker and not the box.
const test = require('node:test');
const assert = require('node:assert');
const { Worker } = require('node:worker_threads');
const { recordRowLimit } = require('../tools/cascade-forecast');

const cases = {
  negative: [-1, '-1', -5, '-5', -500, '-1000000', -0.5],
  zero: [0, '0', '-0', -0],
  nonNumeric: ['abc', '', ' ', undefined, null, NaN, {}, [], 'rows', true, false],
  fractional: [0.5, '0.9', 1.5, '2.7', 499.9, '500.4', 0.0001],
  huge: [501, 1e9, '1e9', 1e21, '1e21', Infinity, '-Infinity', Number.MAX_SAFE_INTEGER, '99999999999999999999'],
  arrays: [['-5'], ['1', '2'], ['999']],
  normal: [1, 50, '50', 500, '500', 25],
};
for (const [kind, vals] of Object.entries(cases)) {
  test(`${kind} lands in 1..500 as an integer`, () => {
    for (const v of vals) {
      const n = recordRowLimit(v);
      assert.ok(Number.isInteger(n) && n >= 1 && n <= 500, `${kind} ${JSON.stringify(v)} -> ${n}`);
    }
  });
}

test('normal values pass through unchanged', () => {
  assert.strictEqual(recordRowLimit(1), 1);
  assert.strictEqual(recordRowLimit('50'), 50);
  assert.strictEqual(recordRowLimit(500), 500);
  assert.strictEqual(recordRowLimit(undefined), 50);
});

test('negative control: the old expression lets -1 through', () => {
  const oldLimit = (raw) => Math.min(Number(raw) || 50, 500);
  assert.strictEqual(oldLimit(-1), -1);
  assert.strictEqual(oldLimit('-5'), -5);
});

test('resourceLimits ends a runaway worker, not this process', async () => {
  const w = new Worker('const a=[]; for(;;) a.push(new Array(1e5).fill(Math.random()));',
    { eval: true, resourceLimits: { maxOldGenerationSizeMb: 32 } });
  const err = await new Promise((res) => { w.on('error', res); w.on('exit', () => res(null)); });
  assert.ok(err, 'worker must error');
  assert.strictEqual(err.code, 'ERR_WORKER_OUT_OF_MEMORY');
});
