// tools/cascade-forecast.js — caliper miner, served through AgentFeed's rail.
//
// AgentFeed is CommonJS and caliper is ESM, so the library is pulled in with a
// dynamic import the first time it is needed and cached after that.
//
// Two things are deliberately NOT done here. Fitting: it reads the whole tape
// and takes seconds, so the model is precomputed by cron into model.json and
// this only loads it. And a second database module: this opens its own
// read-only handle rather than coupling to AgentFeed's, so a change in either
// cannot silently break the other.

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const CALIPER_DIR = process.env.CALIPER_DIR || '/opt/caliper';
const MODEL_PATH = process.env.CALIPER_MODEL || `${CALIPER_DIR}/model.json`;
const LIQ_DB = process.env.CALIPER_LIQ_DB || '/opt/agentfeed/liquidations.db';
const RECORD_DB = process.env.CALIPER_RECORD_DB || `${CALIPER_DIR}/record.db`;
const FREE_SYMBOL = 'SOLUSDT';
const MAX_BATCH = 20;

let lib = null;
let model = null;
let modelMtime = 0;
let modelMeta = null;
let db = null;

async function loadLib() {
  if (lib) return lib;
  const [answerMod, modelMod] = await Promise.all([
    import(`file://${CALIPER_DIR}/lib/answer.mjs`),
    import(`file://${CALIPER_DIR}/lib/model.mjs`),
  ]);
  lib = { ...answerMod, fromJSON: modelMod.fromJSON };
  return lib;
}

// Reload when the file changes on disk, so a cron refit takes effect without a
// restart. Cheap: one stat per call.
function loadModel(fromJSON) {
  const stat = fs.statSync(MODEL_PATH);
  if (model && stat.mtimeMs === modelMtime) return model;
  const raw = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
  model = fromJSON(raw);
  modelMtime = stat.mtimeMs;
  modelMeta = {
    fittedAt: raw.fittedAt,
    scheme: raw.scheme,
    trainedOn: raw.trainedOn,
    symbolsIncluded: raw.symbolsIncluded,
    thresholds: raw.thresholds || {},
  };
  return model;
}

function getDb() {
  if (!db) db = new DatabaseSync(LIQ_DB, { readOnly: true });
  return db;
}

function normalise(sym) {
  if (!sym) return null;
  const s = String(sym).trim().toUpperCase();
  return s.endsWith('USDT') ? s : `${s}USDT`;
}

/**
 * A failure to load the model is OUR failure and is reported as unmeasured for
 * every requested symbol, never as an exception and never as a probability.
 */
function unmeasuredAll(symbols, reason) {
  return {
    model: null,
    answers: symbols.map((symbol) => ({ symbol, evidence: 'unmeasured', p: null, reason })),
  };
}

async function getCascadeForecast({ query = {} } = {}) {
  const requested = query.symbols
    ? String(query.symbols).split(',').map(normalise).filter(Boolean).slice(0, MAX_BATCH)
    : [normalise(query.symbol) || FREE_SYMBOL];

  let answerFn;
  let m;
  try {
    const l = await loadLib();
    answerFn = l.answerMany;
    m = loadModel(l.fromJSON);
  } catch (err) {
    return unmeasuredAll(requested, `model unavailable: ${err.message}`);
  }

  const now = Date.now();
  const out = requested.map((symbol) => {
    const threshold = modelMeta.thresholds[symbol];
    // No stored threshold means this symbol was not in the training universe.
    // Recomputing one here would answer a different question than the model
    // was trained on, so it is left to the library to refuse.
    const opts = threshold ? { threshold } : {};
    return answerFn(m, getDb(), [symbol], now, opts)[0];
  });

  return {
    model: {
      fittedAt: modelMeta.fittedAt,
      scheme: modelMeta.scheme,
      trainedOnPairs: modelMeta.trainedOn,
      symbolsCovered: modelMeta.symbolsIncluded,
    },
    answers: out,
  };
}

/** Free taster: one symbol, full quality, no delay. */
async function getCascadeForecastFree() {
  return getCascadeForecast({ query: { symbol: FREE_SYMBOL } });
}

// ---- the track record, cached and off the main thread -----------------------
//
// Three properties, in the order they matter:
//
//   never on the main thread   the read is a 4.7 s synchronous scan of a 260 MB
//                              database. See tools/forecast-record-worker.js for
//                              the measurement and why a free route makes it a
//                              denial-of-service rather than a slow endpoint.
//   at most one worker at a time
//                              a worker peaks around 130 MB and the cache key is
//                              caller-controlled (symbol x rows), so "one worker
//                              per key" would be a memory exhaustion bug wearing
//                              a cache's clothes: 40 made-up symbols, 40 workers.
//                              A global gate of one bounds the cost no matter
//                              what a caller asks for.
//   one computation per key    twenty simultaneous callers share one worker and
//                              one answer, so a cold cache cannot be stampeded.
//
// The first caller waits for the worker. Nothing else waits behind it, which is
// the entire point: the event loop stays free for the whole 4.7 s.
//
// An {error} result is deliberately NOT cached. Pinning "caliper unavailable"
// for ten minutes would turn a one-second blip into a ten-minute outage.
const RECORD_TTL_MS = Number(process.env.CALIPER_RECORD_TTL_MS || 10 * 60 * 1000);
const RECORD_WORKER = path.join(__dirname, 'forecast-record-worker.js');
const RECORD_TIMEOUT_MS = 120_000;
const RECORD_CACHE_MAX = 64;
const RECORD_QUEUE_MAX = 32;
const RECORD_HOW_TO_CHECK =
  'every row was written before its window opened and settled from the exchange public feed afterwards; sum liquidation USD for the symbol between window start and end and compare to thresholdUsd';

const recordCache = new Map(); // key -> { computedAt, value: { summary, rows } }
const recordInflight = new Map(); // key -> Promise, one per key
const recordQueue = []; // callers waiting for the single worker slot
let recordBusy = false;

function recordGate() {
  if (!recordBusy) {
    recordBusy = true;
    return Promise.resolve();
  }
  if (recordQueue.length >= RECORD_QUEUE_MAX) {
    // Bounded on purpose: an unbounded queue of pending promises is the same
    // memory problem one step removed.
    const e = new Error('forecast record is busy, retry in a few seconds');
    e.kind = 'bad_request';
    return Promise.reject(e);
  }
  return new Promise((resolve) => recordQueue.push(resolve));
}

function recordRelease() {
  const next = recordQueue.shift();
  if (next) next();
  else recordBusy = false;
}

function runRecordWorker(symbol, limit) {
  return new Promise((resolve, reject) => {
    let done = false;
    const w = new Worker(RECORD_WORKER, {
      workerData: { caliperDir: CALIPER_DIR, recordDb: RECORD_DB, symbol, limit },
    });
    // 'exit' fires after a successful message too, so every path goes through
    // finish() and the first one wins.
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      w.terminate();
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, new Error('forecast record read timed out')),
      RECORD_TIMEOUT_MS,
    );
    w.on('message', (m) => {
      if (m.kind === 'ok') finish(resolve, { summary: m.summary, rows: m.rows });
      else if (m.kind === 'return') finish(resolve, m.value);
      else finish(reject, new Error(m.message));
    });
    w.on('error', (err) => finish(reject, err));
    w.on('exit', (code) => finish(reject, new Error(`record worker exited with ${code}`)));
  });
}

function recordPayload(entry) {
  // Field order is the pre-worker order with computedAt appended, so a client
  // diffing the serialized payload sees exactly one added key.
  return {
    howToCheck: RECORD_HOW_TO_CHECK,
    summary: entry.value.summary,
    rows: entry.value.rows,
    computedAt: new Date(entry.computedAt).toISOString(),
  };
}

/**
 * The live track record.
 *
 * Free on purpose. A backtest is a claim the author also chose how to compute;
 * this is forecasts written before their window and settled from the public
 * feed afterwards. The raw rows travel with the score so nobody has to take
 * the score on trust.
 */
async function getForecastRecord({ query = {} } = {}) {
  const symbol = query.symbol ? String(query.symbol).toUpperCase() : '';
  const limit = Math.min(Number(query.rows) || 50, 500);
  const key = `${symbol}|${limit}`;

  const hit = recordCache.get(key);
  if (hit && Date.now() - hit.computedAt < RECORD_TTL_MS) return recordPayload(hit);

  let flight = recordInflight.get(key);
  if (!flight) {
    flight = (async () => {
      await recordGate();
      try {
        // A caller that queued behind the gate may find its answer already
        // computed by whoever was in front of it.
        const fresh = recordCache.get(key);
        if (fresh && Date.now() - fresh.computedAt < RECORD_TTL_MS) return fresh;
        const t0 = Date.now();
        const res = await runRecordWorker(symbol, limit);
        if (res.error) return res;
        const entry = { computedAt: Date.now(), value: res };
        recordCache.set(key, entry);
        // Insertion-ordered, so the first key is the oldest.
        while (recordCache.size > RECORD_CACHE_MAX) {
          recordCache.delete(recordCache.keys().next().value);
        }
        console.log(
          `[record] computed ${symbol || '(all symbols)'} rows=${limit} in ${Date.now() - t0}ms`,
        );
        return entry;
      } finally {
        recordRelease();
      }
    })().finally(() => recordInflight.delete(key));
    recordInflight.set(key, flight);
  }

  const entry = await flight;
  return entry.error ? entry : recordPayload(entry);
}

/** The published question contract, so an app never has to read this file. */
async function getForecastQuestion() {
  try {
    const l = await loadLib();
    const spec = l.questionSpec();
    let coverage = null;
    try {
      loadModel(l.fromJSON);
      coverage = {
        fittedAt: modelMeta.fittedAt,
        symbolsCovered: modelMeta.symbolsIncluded,
        symbols: Object.keys(modelMeta.thresholds).sort(),
      };
    } catch (err) {
      coverage = { error: `model unavailable: ${err.message}` };
    }
    return { question: spec, coverage, freeSymbol: FREE_SYMBOL, maxBatch: MAX_BATCH };
  } catch (err) {
    return { error: `caliper unavailable: ${err.message}` };
  }
}

module.exports = { getCascadeForecast, getCascadeForecastFree, getForecastQuestion, getForecastRecord };
