// tools/forecast-record-worker.js — the track-record read, off the main thread.
//
// rec.tally() and rec.exportRows() are synchronous scans of caliper's 260 MB
// record.db through node:sqlite's DatabaseSync. On the main thread that is a
// stop-the-world pause: measured Sep 25 2026, one call took 4.68 s and a
// concurrent GET /api/tvl that normally answers in 1.6 ms waited 4.51 s behind
// it. /api/forecast-record is free and unauthenticated, so a single caller
// inside the 240/min GET allowance could hold the entire service — every
// prober and CDP's availability checks with it — in that wait. Nothing in this
// file runs in the server process.
//
// The handle is read-only and closed in a finally. caliper owns record.db; this
// must never be able to write to it or hold a lock its writer needs.
'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

// The caller must not be able to tell that the work moved. The pre-worker
// version had two different failure behaviours -- a missing library or a
// missing database RETURNED {error} and became a 200, while a failure inside
// the read THREW and became the route's 502 -- so `kind` carries that
// distinction back across the thread boundary instead of flattening it.
(async () => {
  const { caliperDir, recordDb, symbol, limit } = workerData;

  let rec;
  try {
    rec = await import(`file://${caliperDir}/lib/record.mjs`);
  } catch (err) {
    parentPort.postMessage({ kind: 'return', value: { error: `record unavailable: ${err.message}` } });
    return;
  }

  let log;
  try {
    log = new DatabaseSync(recordDb, { readOnly: true });
  } catch (err) {
    parentPort.postMessage({ kind: 'return', value: { error: `no record yet: ${err.message}` } });
    return;
  }

  try {
    const summary = rec.tally(log, symbol ? { symbol } : {});
    const rows = rec.exportRows(log, limit).map((r) => ({
      symbol: r.symbol,
      window: new Date(r.window_start).toISOString(),
      madeAt: new Date(r.made_at).toISOString(),
      thresholdUsd: r.threshold_usd,
      p: r.p,
      evidence: r.evidence,
      observedUsd: r.observed_usd,
      outcome: r.outcome,
      settled: r.settled_at !== null,
    }));
    parentPort.postMessage({ kind: 'ok', summary, rows });
  } catch (err) {
    parentPort.postMessage({ kind: 'throw', message: err.message });
  } finally {
    log.close();
  }
})();
