// test/r23-crash-model.test.js: the JavaScript crash-risk model equals scikit-learn (gate G1c on the committed fixture; the 2,000-pool and whole-population runs are
// ops/r23-crash-parity.js, recorded in the notes), and each thing that makes it equal has a negative control.
//   fixture: test/fixtures/r23/crash/parity-fixture.json = raw `pools` rows of the LaunchLedger snapshot, the features 03_dataset.py built for them, and predict_proba of the
//   production model. The last rows are the pools on which a naive port disagrees.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../tools/r23/crash-model/evaluator');
const F = require('../tools/r23/crash-model/features');
const M = require('../tools/r23/crash-model/metrics');
const FX = require('./fixtures/r23/crash/parity-fixture.json');

const MODEL_FILE = E.DEFAULT_MODEL;
const model = E.loadModel(MODEL_FILE);
const build = F.makeFeatureBuilder(model.feature_names, model.categories, model.tables);
const rel = (a, b) => (Number.isNaN(a) && b === null) || (b !== null && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b)));

test('control: the fixture is what the tests below assume', () => {
  assert.equal(FX.rows.length, FX.py.length); assert.equal(FX.rows.length, FX.py_features.length);
  assert.ok(FX.rows.length >= 300);
  assert.equal(FX.py_features[0].length, model.feature_names.length);
  assert.ok(FX.rows.some((r) => r.t0_liquidity_usd === null) && FX.rows.some((r) => r.t0_fdv_usd === null), 'NULL liquidity and NULL fdv rows');
  assert.ok(FX.rows.some((r) => /[^\x00-\x7f]/.test(r.name || '')), 'non-ASCII names');
  assert.ok(FX.rows.some((r) => model.categories.dex_cats.every((d) => d !== r.dex)), 'a venue outside the frozen list');
});

test('every feature of every fixture row equals the one 03_dataset.py built (exactly for counts and flags, to 1e-12 for logs and ratios)', () => {
  const exact = new Set(model.feature_names.filter((n) => /^(liq_na|fdv_na|wd\d|wday|hour|name_|pair_name_len|dex_|q_|reason_)/.test(n)));
  let cells = 0;
  FX.rows.forEach((row, i) => {
    const x = build(row);
    model.feature_names.forEach((n, k) => {
      const p = FX.py_features[i][k]; cells++;
      if (exact.has(n)) assert.ok(Object.is(x[k], p === null ? NaN : p), `${n} of pool ${row.id}: ${x[k]} vs ${p}`);
      else assert.ok(rel(x[k], p), `${n} of pool ${row.id}: ${x[k]} vs ${p}`);
    });
  });
  assert.equal(cells, FX.rows.length * model.feature_names.length);
});

test('JS scores equal scikit-learn predict_proba on every fixture row to 1e-9 (arithmetic parity of the production model)', () => {
  let max = 0;
  FX.rows.forEach((row, i) => { max = Math.max(max, Math.abs(E.score(model, build(row)) - FX.py[i])); });
  assert.ok(max < 1e-9, `max difference ${max}`);
  // and from scikit-learn's own features the evaluator alone is exact to rounding
  let max2 = 0;
  FX.py_features.forEach((f, i) => { max2 = Math.max(max2, Math.abs(E.score(model, Float64Array.from(f.map((v) => (v === null ? NaN : v)))) - FX.py[i])); });
  assert.ok(max2 < 1e-12, `evaluator alone ${max2}`);
});

test('negative control: without the hour_sin / hour_cos tables (Math.sin and Math.cos instead) the score disagrees with scikit-learn on some rows', () => {
  const tabs = { hour_sin: Array.from({ length: 24 }, (_, h) => Math.sin((2 * Math.PI * h) / 24)), hour_cos: Array.from({ length: 24 }, (_, h) => Math.cos((2 * Math.PI * h) / 24)) };
  assert.ok(tabs.hour_sin.some((v, h) => v !== model.tables.hour_sin[h]) || tabs.hour_cos.some((v, h) => v !== model.tables.hour_cos[h]), 'Math.sin / Math.cos round some hours differently from numpy');
  const b2 = F.makeFeatureBuilder(model.feature_names, model.categories, tabs);
  const bad = FX.rows.filter((row, i) => Math.abs(E.score(model, b2(row)) - FX.py[i]) > 1e-6).length;
  assert.ok(bad >= 1, `${bad} rows disagree without the tables`);
});

test('negative control: with an exact threshold comparison (no slack) the score disagrees with scikit-learn on some rows; with the slack it does not', () => {
  const exactModel = E.loadModel(MODEL_FILE, { slack: 0 });
  const bad = FX.rows.filter((row, i) => Math.abs(E.score(exactModel, build(row)) - FX.py[i]) > 1e-6).length;
  assert.ok(bad >= 1, `${bad} rows disagree without the slack`);
  const good = FX.rows.filter((row, i) => Math.abs(E.score(model, build(row)) - FX.py[i]) > 1e-6).length;
  assert.equal(good, 0);
});

test('a model file that was edited does not load: the version is the hash of the trees', () => {
  const raw = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8'));
  assert.equal(E.checkVersion(raw), raw.model_version);
  const t = JSON.parse(JSON.stringify(raw)); t.trees[3].t[0] += 1e-9;
  assert.throws(() => E.compile(t), /model file was changed/);
  const trunc = { ...raw, trees: raw.trees.slice(0, 399) };
  assert.throws(() => E.compile(trunc), /model file was changed/);
  assert.match(raw.model_version, /^hgb-t3-\d{8}-[0-9a-f]{8}$/);
  // a well-formed hash over broken structure is still refused
  const broken = JSON.parse(JSON.stringify(raw)); broken.trees[0].l[0] = 0;
  broken.model_version = E.versionOf(broken.trees, 'hgb-t3-20261031');
  assert.throws(() => E.compile(broken), /child outside the tree/);
});

test('model.json: what the notes and the service rely on', () => {
  assert.equal(model.kind, 'production');
  assert.equal(model.trained_through_day, '2026-10-29');
  assert.ok(model.n_train > 250000 && model.positives_train > 0 && model.base_rate_train > 0.1 && model.base_rate_train < 0.15);
  assert.equal(model.feature_names.length, 57);
  assert.equal(model.compiled.length, 400);
  assert.equal(model.decile_cuts.length, 9);
  assert.ok(model.decile_cuts.every((c, i, a) => i === 0 || c > a[i - 1]), 'decile boundaries ascend');
  for (const c of ['t0_price_usd', 't0_volume24h_usd', 't0_txns24h', 't0_ts', 'pool_created_ts', 'name', 'dex', 'quote_mint', 'cohort_reason', 'base_mint', 'pool_address']) assert.ok(model.required_columns.includes(c), c);
  assert.ok(!model.required_columns.includes('t0_liquidity_usd') && !model.required_columns.includes('t0_fdv_usd'), 'liquidity and fdv were NULL for some training pools and the model has flags for it');
  const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(MODEL_FILE), 'meta.json'), 'utf8'));
  assert.equal(meta.model_version, model.model_version); assert.equal(meta.trees, undefined); assert.ok(fs.statSync(path.join(path.dirname(MODEL_FILE), 'meta.json')).size < 20000);
  for (const k of ['feature_names', 'categories', 'tables', 'required_columns', 'decile_cuts', 'n_train', 'trained_through_day', 'validation']) assert.deepEqual(meta[k], JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8'))[k], `meta.json and model.json agree on ${k}`);
});

test('features: NULLs become NaN, odd names are counted like Python, a row with nothing does not throw', () => {
  const x = build({});
  assert.equal(x.length, 57);
  const idx = (n) => model.feature_names.indexOf(n);
  assert.ok(Number.isNaN(x[idx('log_liq')]) && Number.isNaN(x[idx('log10_price')]) && Number.isNaN(x[idx('age_h_clip')]));
  assert.equal(x[idx('liq_na')], 1); assert.equal(x[idx('dex_other')], 1); assert.equal(x[idx('q_other')], 1); assert.equal(x[idx('reason_other')], 1);
  const n = F.nameFeatures('ＡＢ٣ ß x / SOL');
  assert.deepEqual([n.name_digits, n.name_space, n.name_nonascii, n.name_len], [1, 2, 5, 7], 'a Unicode digit, a Unicode space and non-ASCII letters, counted by code point');
  assert.equal(F.nameFeatures('\u0000a\u007f!').name_punct, 3, 'ASCII controls and punctuation count as punctuation, as Python does');
  assert.equal(F.nameFeatures('\u001ca').name_space, 1, 'U+001C is whitespace for Python');
  assert.equal(F.nameFeatures('﻿a').name_space, 0, 'U+FEFF is not whitespace for Python (it is for JavaScript)');
  assert.equal(F.nameFeatures('PEPE / SOL').name_allcaps, 1); assert.equal(F.nameFeatures('1234').name_allcaps, 0); assert.equal(F.nameFeatures('Pepe').name_allcaps, 0);
  assert.equal(F.nameFeatures('😀x').name_len, 2, 'an astral character is one code point');
  // the weekday: Monday = 0, as pandas
  const monday = Date.parse('2026-11-02T13:00:00Z') / 1000, sunday = Date.parse('2026-11-01T23:59:59Z') / 1000;
  assert.equal(build({ t0_ts: monday })[idx('wd0')], 1); assert.equal(build({ t0_ts: monday })[idx('hour')], 13);
  assert.equal(build({ t0_ts: sunday })[idx('wd6')], 1); assert.equal(build({ t0_ts: sunday })[idx('hour')], 23);
  assert.throws(() => F.makeFeatureBuilder(model.feature_names, model.categories, null), /hour_sin/);
});

test('metrics: rank-sum AUC with ties, deciles and boundaries', () => {
  assert.equal(M.rocAuc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]), 0.75);
  assert.equal(M.rocAuc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5, 'all tied: half');
  assert.equal(M.rocAuc([1, 2, 3], [1, 1, 1]), null); assert.equal(M.rocAuc([1, 2, 3], [0, 0, 0]), null);
  const cuts = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.deepEqual([0.5, 1, 1.5, 8.99, 9, 100].map((s) => M.decileOf(s, cuts)), [1, 2, 2, 9, 10, 10]);
  const c = M.decileCuts(Array.from({ length: 101 }, (_, i) => i));
  assert.deepEqual(c, [10, 20, 30, 40, 50, 60, 70, 80, 90]);
  assert.equal(M.decileCuts([1, 2, 3]), null);
  const num = JSON.parse(fs.readFileSync(path.join(path.dirname(MODEL_FILE), 'meta.json'), 'utf8')).decile_cuts;
  assert.equal(M.decileOf(num[0] / 2, num), 1); assert.equal(M.decileOf(num[8], num), 10);
});

test('the module loads in a fresh process with no database and adds little memory (the routes module loads metrics.js and schema.js only, never the model)', () => {
  const { execFileSync } = require('child_process');
  const out = JSON.parse(execFileSync(process.execPath, ['-e', `
    const b = process.memoryUsage().rss;
    const C = require(${JSON.stringify(path.join(__dirname, '..', 'tools', 'r23', 'crash-risk.js'))});
    const loaded = Object.keys(require.cache).filter((f) => /crash-model[\\\\/]model\\.json|evaluator\\.js|features\\.js/.test(f));
    console.log(JSON.stringify({ delta: process.memoryUsage().rss - b, loaded, entries: C.entries.length }));`], { encoding: 'utf8', env: { ...process.env, R23_CRASH_ROUTES: '' } }));
  assert.deepEqual(out.loaded, [], 'the model, the evaluator and the feature builder are not loaded by the routes');
  assert.equal(out.entries, 3);
});
