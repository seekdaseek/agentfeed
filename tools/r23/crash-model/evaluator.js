// tools/r23/crash-model/evaluator.js: the crash-risk model in plain JavaScript (no dependency, float64).
// The model is a scikit-learn HistGradientBoostingClassifier (binary, no categorical features) exported tree by tree. A tree is flat arrays indexed by node:
//   f: feature index (-1 on a leaf)   t: threshold (go left when x <= t)   l, r: child node   v: leaf value   m: 1 when a missing value goes left
// The score is sigmoid(baseline + sum of the leaf values, added in tree order) exactly as sklearn's _raw_predict + expit do, so the result equals predict_proba
// up to the last digits of libm (checked: ops/r23-crash-parity.js).
// Thresholds: scikit-learn bins a feature by percentiles with the 'midpoint' rule, so when many pools share one value (log1p of 13 trades, a pool age in whole seconds) the threshold IS that
// value, and "x <= threshold" is true for it only if the feature is computed to the last bit the way numpy computed it. V8's log1p and numpy's differ in the last bit for some inputs,
// which flipped the split for 1.5% of pools (found by the parity check). So a threshold is widened by SLACK (8 ulp, relative) to the right: a feature that equals the threshold up to
// libm noise still goes left, and no real value sits within 8 ulp above a threshold without being equal to it (measured: ops/r23-crash-parity.js on every cohort pool). The two features that
// come from a frozen table (hour_sin, hour_cos: neighbouring values 1 ulp apart, threshold between them) are compared exactly.
// model.json also carries its own version, which is derived from the trees: a model file that was edited or truncated does not load.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SLACK = 8 * Number.EPSILON;
const versionOf = (trees, prefix) => `${prefix}-${crypto.createHash('sha256').update(JSON.stringify(trees)).digest('hex').slice(0, 8)}`;

/** model_version = `<kind>-<date>-<first 8 hex of sha256(JSON.stringify(trees))>` */
function checkVersion(model) {
  const m = /^(.*)-([0-9a-f]{8})$/.exec(String(model.model_version));
  if (!m) throw new Error(`crash-model: model_version ${model.model_version} does not end in 8 hex digits`);
  const got = crypto.createHash('sha256').update(JSON.stringify(model.trees)).digest('hex').slice(0, 8);
  if (got !== m[2]) throw new Error(`crash-model: the trees hash to ${got}, the file says ${m[2]}; the model file was changed`);
  return model.model_version;
}

/** -> a model with typed arrays; throws when the file is not a well-formed model. `opts.slack` exists for the test that shows the widening is needed (0 = compare exactly) */
function compile(model, opts = {}) {
  const slack = opts.slack === undefined ? SLACK : opts.slack;
  checkVersion(model);
  if (!Array.isArray(model.trees) || !model.trees.length) throw new Error('crash-model: no trees');
  if (!Array.isArray(model.feature_names) || !model.feature_names.length) throw new Error('crash-model: no feature_names');
  if (!Number.isFinite(model.baseline)) throw new Error('crash-model: no baseline');
  const nf = model.feature_names.length;
  const tabled = new Set(Object.keys(model.tables || {}).map((k) => model.feature_names.indexOf(k)).filter((i) => i >= 0));
  const trees = model.trees.map((t, i) => {
    const n = t.f.length;
    if (![t.t, t.l, t.r, t.v, t.m].every((a) => a.length === n)) throw new Error(`crash-model: tree ${i} has arrays of different lengths`);
    for (let k = 0; k < n; k++) {
      if (t.f[k] >= nf) throw new Error(`crash-model: tree ${i} node ${k} reads feature ${t.f[k]} of ${nf}`);
      if (t.f[k] >= 0 && (t.l[k] <= k || t.r[k] <= k || t.l[k] >= n || t.r[k] >= n)) throw new Error(`crash-model: tree ${i} node ${k} has a child outside the tree`);
    }
    return { f: Int32Array.from(t.f), t: Float64Array.from(t.t, (th, k) => (t.f[k] < 0 || tabled.has(t.f[k]) ? th : th + Math.abs(th) * slack)), l: Int32Array.from(t.l), r: Int32Array.from(t.r), v: Float64Array.from(t.v), m: Uint8Array.from(t.m) };
  });
  return { ...model, trees: undefined, compiled: trees, trees_count: trees.length };
}

/** the raw (log-odds) sum for one feature vector */
function raw(c, x) {
  let s = c.baseline;
  const T = c.compiled;
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    let n = 0;
    for (;;) {
      const f = t.f[n];
      if (f < 0) { s += t.v[n]; break; }
      const v = x[f];
      n = v !== v ? (t.m[n] ? t.l[n] : t.r[n]) : (v <= t.t[n] ? t.l[n] : t.r[n]);
    }
  }
  return s;
}

/** the probability the model gives the positive class (scipy.special.expit of the raw sum) */
const score = (c, x) => 1 / (1 + Math.exp(-raw(c, x)));

/** read and compile a model file */
function loadModel(file, opts) {
  return compile(JSON.parse(fs.readFileSync(file, 'utf8')), opts);
}

const DEFAULT_MODEL = path.join(__dirname, 'model.json');

module.exports = { compile, loadModel, raw, score, checkVersion, versionOf, DEFAULT_MODEL };
