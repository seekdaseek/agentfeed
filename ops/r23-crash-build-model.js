#!/usr/bin/env node
// ops/r23-crash-build-model.js: assemble a crash-risk model file from the scikit-learn export (R23 T1).
//   node ops/r23-crash-build-model.js --kind production --trees <production-trees.json> --summary <production-summary.json> --validation <validation-summary.json>
//        --features <features.json> --tables <tables.json> --out tools/r23/crash-model/model.json [--meta tools/r23/crash-model/meta.json] [--date 20261031]
//   node ops/r23-crash-build-model.js --kind validation --trees <validation-trees.json> --summary <validation-summary.json> --validation <validation-summary.json> --features <features.json> --out <file>
// The three inputs come from /Volumes/D/r23/t1 (ops/r23-crash-train/ holds the scripts that write them). The model_version is
// `hgb-t3-<date>-<first 8 hex of sha256(JSON.stringify(trees))>`, so the file proves it was not edited. meta.json is the same file without the trees (small enough for the routes module).
'use strict';
const fs = require('fs');
const { versionOf } = require('../tools/r23/crash-model/evaluator');

function args(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  return a;
}
const a = args(process.argv.slice(2));
for (const k of ['kind', 'trees', 'summary', 'validation', 'features', 'tables', 'out']) if (!a[k]) { console.error(`missing --${k}`); process.exit(2); }
const J = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const tables = J(a.tables);
const tr = J(a.trees), sm = J(a.summary), val = J(a.validation), ft = J(a.features);
const date = a.date || '20261031';
if (JSON.stringify(tr.feature_names) !== JSON.stringify(ft.feature_cols)) throw new Error('the exported trees and features.json disagree on the feature order');

const categories = {
  dex_cats: ft.dex_cats,
  quote_cats: { So11111111111111111111111111111111111111112: 'SOL', EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC' },
  top_quote_other: ft.top_quote_other,
  reasons: ['liquidity>=5000', 'volume>=1000', 'late:liquidity>=5000', 'late:volume>=1000'],
};
// raw columns that were never NULL on any cohort pool of the training window: the service skips a pool where one of them is missing
const nulls = a.kind === 'production' ? sm.null_counts_training_window : null;
const required = nulls ? Object.keys(nulls).filter((k) => nulls[k] === 0) : null;

const production = a.kind === 'production';
const model = {
  model_version: versionOf(tr.trees, `hgb-t3-${date}`),
  kind: a.kind,
  model_type: `HistGradientBoostingClassifier (scikit-learn ${tr.sklearn}), ${tr.n_trees} trees, log-odds summed and passed through a sigmoid`,
  target: 'the pool price at its 24 hour check is at least 80 percent below its frozen t0 price',
  trained_through_day: production ? sm.trained_through_day : val.train_last_day,
  n_train: sm.n_train,
  positives_train: production ? sm.positives : Math.round(val.train_base * val.n_train),
  base_rate_train: production ? sm.base_rate : val.train_base,
  hyperparameters: { learning_rate: val.params.lr, max_leaf_nodes: val.params.leaves, min_samples_leaf: val.params.msl, max_iter: val.params.iters, l2_regularization: 1.0, early_stopping: false, random_state: 20261031 },
  feature_names: tr.feature_names,
  categories,
  // the 24 values numpy gave sin and cos of 2*pi*hour/24 in the training script (04_tables.py); see features.js for why they are a table
  tables,
  required_columns: required,
  baseline: tr.baseline,
  // frozen decile boundaries: the VALIDATION model's out-of-sample scores on pools that entered 1 to 29 October (the production model has no out-of-sample scores yet)
  decile_cuts: val.decile_cuts,
  decile_cuts_source: production
    ? 'out-of-sample scores of the validation model (same recipe, trained on an earlier window) on the pools of the test window; the production model is scored on later pools, so these boundaries are a starting point until the service has enough live scores of its own'
    : 'out-of-sample scores of this model on the pools of the test window',
  ...(production ? { decile_cuts_insample_last14d: sm.decile_cuts_insample_last14d, decile_cuts_insample_note: 'scores of the production model on its own last 14 training days: in-sample, kept only to show how far they sit from the frozen boundaries; never used for a decile' } : {}),
  validation: {
    note: production
      ? 'measured on the VALIDATION model (trained on pools that entered through the validation training window, tested on later pools). The production model is the same recipe on more data; it has no out-of-time test of its own.'
      : 'measured on this model',
    trained_through_day: val.train_last_day,
    n_train: val.n_train,
    test_window: 'pools that entered after an embargo week, through the last fully labelled day of that run',
    n_test: val.n_test,
    base_rate_test: val.test_base,
    roc_auc: val.auc,
    n_by_window: val.weekly_n,
    decile_table: val.decile_table,
  },
  trees: tr.trees,
};
if (required) model.required_columns = required;
fs.writeFileSync(a.out, JSON.stringify(model));
if (a.meta) { const { trees, baseline, ...meta } = model; fs.writeFileSync(a.meta, JSON.stringify({ ...meta, n_trees: trees.length }, null, 1)); }
console.log(JSON.stringify({ out: a.out, model_version: model.model_version, bytes: fs.statSync(a.out).size, trees: tr.trees.length, required_columns: required }));
