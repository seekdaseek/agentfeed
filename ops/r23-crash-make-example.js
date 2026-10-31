#!/usr/bin/env node
// ops/r23-crash-make-example.js: writes tools/r23/crash-model/example-scores.json, the synthetic score database the route examples are built from (R23 T1).
// The scores are the real model's output (evaluator.js) on real feature rows of the parity fixture; the mint and pool addresses are MADE UP (base58 of a sha256), so a published example
// never names a real token. Deterministic: running it twice writes the same bytes.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadModel, score } = require('../tools/r23/crash-model/evaluator');
const { makeFeatureBuilder } = require('../tools/r23/crash-model/features');
const { decileOf } = require('../tools/r23/crash-model/metrics');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buf) {
  let n = BigInt('0x' + buf.toString('hex')), s = '';
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}
const fake = (tag) => base58(crypto.createHash('sha256').update(`r23-crash-example:${tag}`).digest());

const model = loadModel(path.join(__dirname, '..', 'tools', 'r23', 'crash-model', 'model.json'));
const build = makeFeatureBuilder(model.feature_names, model.categories, model.tables);
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'r23', 'crash', 'parity-fixture.json'), 'utf8'));
const scored = fx.rows.filter((r) => r.t0_liquidity_usd !== null && r.t0_fdv_usd !== null).map((r) => ({ r, s: score(model, build(r)) })).sort((a, b) => a.s - b.s);
// eight pools spread over the score range (the 6th, 20th, ... percentile of the fixture), newest first
const pick = [0.97, 0.88, 0.7, 0.55, 0.4, 0.25, 0.12, 0.03].map((q) => scored[Math.floor(q * (scored.length - 1))]);
const minutes = [3, 11, 24, 41, 70, 120, 300, 900];
const pools = pick.map((p, i) => ({
  mint: fake(`mint-${i}`), pool: fake(`pool-${i}`), dex: p.r.dex, score: p.s, minutes_ago: minutes[i],
  t0_liquidity_usd: Math.round(p.r.t0_liquidity_usd * 100) / 100, t0_fdv_usd: Math.round(p.r.t0_fdv_usd * 100) / 100,
}));
const example_mint_index = pools.findIndex((p) => decileOf(p.score, model.decile_cuts) >= 9);
const out = { note: 'constructed: made-up mint and pool addresses; scores are the production model on real feature rows of the parity fixture; the clock is fixed', now: 1793600000, model_version: model.model_version, example_mint_index: Math.max(0, example_mint_index), pools };
fs.writeFileSync(path.join(__dirname, '..', 'tools', 'r23', 'crash-model', 'example-scores.json'), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify({ wrote: pools.length, example_mint_index: out.example_mint_index, deciles: pools.map((p) => decileOf(p.score, model.decile_cuts)) }));
