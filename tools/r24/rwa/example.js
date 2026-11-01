// tools/r24/rwa/example.js: the CONSTRUCTED example answer of /api/rwa-yields (R24, item 3), built by the same assembler the route uses (evaluate.assembleProduct) over synthetic readings.
// Every price here is generated from a made-up yearly rate, not read from any chain and not taken from any issuer; the contracts and docs are the register's. Kept inline so the module
// loads wherever it is installed.
'use strict';

const { assembleProduct, answerOf } = require('./evaluate');
const { served } = require('./products');

const HEAD = { number: 26000000, ts: Date.parse('2026-10-31T12:00:00.000Z') / 1000 };
const ANCHOR = Math.floor(HEAD.ts / 21600) * 21600;

/** a synthetic price history for a product: it grows at `rate` a year, so the example has the shape of a real answer. level(d) is the price d days before the head. */
function readings(p, rate, idx) {
  const unit = 10n ** BigInt(p.read.decimals);
  const level = (daysAgo) => BigInt(Math.round(p.startPrice * (1.09 + 0.017 * idx) * (1 - rate * daysAgo / 365) * 1e8)) * unit / 100000000n;
  const at = (ts) => ({ raw: level((HEAD.ts - ts) / 86400), blockTs: ts, block: HEAD.number - Math.round((HEAD.ts - ts) / 12), updatedAt: p.read.kind === 'round' ? ts : null, source: 'contract' });
  return {
    latest: { raw: level(0), updatedAt: p.read.kind === 'round' ? HEAD.ts - 3 * 3600 : null, block: HEAD.number, blockTs: HEAD.ts },
    hist: { 1: at(ANCHOR - 86400), 7: at(ANCHOR - 7 * 86400), 30: at(ANCHOR - 30 * 86400) },
  };
}

function buildExample() {
  const rates = [0.0375, 0.0402, 0.0389, 0.0415, 0.0396, 0.0408, 0.0631];
  const products = served().map((p, i) => assembleProduct({ p, head: HEAD, ...readings(p, rates[i % rates.length], i) }));
  return answerOf(HEAD, products);
}

module.exports = { buildExample, HEAD };
