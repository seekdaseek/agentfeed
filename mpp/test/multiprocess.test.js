// mpp/test/multiprocess.test.js — replay protection ACROSS PROCESSES.
//
// Why this file exists, and why a same-process test was not enough:
//
// @solana/mpp 0.7.0's push path serialises with `withKeyLock`, a promise map
// local to one Node process, and scopes its own guarantee explicitly:
//
//   "Scope: single Node process. Multi-process/replica deployments sharing one
//    Store must back the consumed marker with an atomic reserve."
//
// So in ONE process, push mode passes with or without our claim — upstream's
// mutex carries it, and the test has no teeth. Two processes on one database
// is the arrangement where the mutex does nothing. Measured there, removing
// the claim produces a clean double settlement in BOTH modes:
//
//   non-atomic, push : statuses [200,200]  calls 2  receipts 2
//   non-atomic, pull : statuses [200,200]  calls 2  receipts 2  sendTransaction 2
//
// The race itself runs in test/helpers/race-two-processes.js, standalone, so
// the spawned servers are always reaped and the result is a single JSON line.
//
// Run:  node --test mpp/test/multiprocess.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RACE = path.join(__dirname, 'helpers', 'race-two-processes.js');

function race(mode, delayMs = 150) {
  const out = execFileSync(process.execPath, [RACE, mode, String(delayMs)], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('PUSH across two processes on one database: exactly one settles', () => {
  const r = race('push');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.statuses, [200, 402], `exactly one 200, got ${r.statuses}`);
  assert.equal(r.receipts, 1, 'exactly one receipt issued');
  assert.equal(r.consumed, 1, 'exactly one mpp_consumed row');
  assert.equal(r.calls, 1, 'exactly one calls row');
  assert.equal(r.getTransaction, 1, 'only the claim winner did on-chain verification work');
  assert.equal(r.payerLookup, 1, 'the settling process read the payer back off the chain, once');
  assert.equal(r.sendTransaction, 0, 'push mode never broadcasts server-side');
});

test('PULL across two processes on one database: exactly one settles', () => {
  const r = race('pull');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.statuses, [200, 402], `exactly one 200, got ${r.statuses}`);
  assert.equal(r.receipts, 1, 'exactly one receipt issued');
  assert.equal(r.consumed, 1, 'exactly one mpp_consumed row');
  assert.equal(r.calls, 1, 'exactly one calls row');
  assert.equal(r.sendTransaction, 1, 'the transaction was broadcast exactly once');
  assert.equal(r.payerLookup, 0, 'PULL adds ZERO network round trips: the credential names the payer');
});
