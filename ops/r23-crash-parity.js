#!/usr/bin/env node
// ops/r23-crash-parity.js: proves the JavaScript crash-risk model equals the Python one (R23 T1, gates G1a, G1b, G1c).
//   node ops/r23-crash-parity.js --model <model.json> --db <launchledger snapshot copy> --csv <id,py[,week,yt] csv> [--auc] [--reference <0b-results-T3.json>] [--tol 1e-6] [--auc-tol 0.002]
// For every pool id in the csv it reads the RAW `pools` row from the database (explicit columns, read-only), builds the features with features.js, scores with
// evaluator.js, and compares with the score the Python model gave (`py`, written by the scikit-learn run). With --auc and the columns `week` and `yt` it also
// computes the ROC AUC from the JavaScript scores (pooled and per week) and compares it with the reference results of Phase 0b.
// Exit code 0 only if every comparison is inside its tolerance. Nothing is written; the database is opened read-only.
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { loadModel, score } = require('../tools/r23/crash-model/evaluator');
const { makeFeatureBuilder, INPUT_COLUMNS } = require('../tools/r23/crash-model/features');
const { rocAuc } = require('../tools/r23/crash-model/metrics');

function args(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); a[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  return a;
}
function readCsv(file) {
  const [head, ...lines] = fs.readFileSync(file, 'utf8').trim().split('\n');
  const cols = head.split(',');
  return lines.map((l) => { const c = l.split(','); return Object.fromEntries(cols.map((k, i) => [k, c[i]])); });
}

const a = args(process.argv.slice(2));
if (!a.model || !a.db || !a.csv) { console.error('usage: --model <model.json> --db <db> --csv <csv> [--auc] [--reference <json>] [--tol 1e-6] [--auc-tol 0.002]'); process.exit(2); }
const tol = Number(a.tol || 1e-6), aucTol = Number(a['auc-tol'] || 0.002);
const model = loadModel(a.model);
const build = makeFeatureBuilder(model.feature_names, model.categories, model.tables);
const db = new Database(a.db, { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');
const get = db.prepare(`SELECT ${INPUT_COLUMNS.join(', ')} FROM pools WHERE id = ?`);
const rows = readCsv(a.csv);

const js = new Float64Array(rows.length), py = new Float64Array(rows.length);
let maxDiff = 0, argmax = -1, over = 0, missing = 0;
rows.forEach((r, i) => {
  const row = get.get(Number(r.id));
  if (!row) { missing++; js[i] = NaN; py[i] = Number(r.py); return; }
  js[i] = score(model, build(row));
  py[i] = Number(r.py);
  const d = Math.abs(js[i] - py[i]);
  if (d > maxDiff) { maxDiff = d; argmax = Number(r.id); }
  if (d > tol) over++;
});
const out = { model_version: model.model_version, n: rows.length, pools_missing_in_db: missing, max_abs_diff: maxDiff, pool_with_max_diff: argmax, over_tolerance: over, tolerance: tol, parity_ok: missing === 0 && over === 0 };
if (a.auc) {
  const groups = { pooled: rows.map((_, i) => i) };
  rows.forEach((r, i) => { (groups[r.week] = groups[r.week] || []).push(i); });
  const aucJs = {}, aucPy = {}, n = {};
  for (const [g, ix] of Object.entries(groups)) {
    const y = ix.map((i) => Number(rows[i].yt));
    aucJs[g] = rocAuc(ix.map((i) => js[i]), y);
    aucPy[g] = rocAuc(ix.map((i) => py[i]), y);
    n[g] = ix.length;
  }
  out.auc = { n, js: aucJs, python_scores_same_formula: aucPy };
  if (a.reference) {
    const ref = JSON.parse(fs.readFileSync(a.reference, 'utf8')).week_auc_selected;
    out.auc.phase0b_reference = ref;
    out.auc.max_abs_diff_vs_phase0b = Math.max(...Object.keys(ref).map((g) => Math.abs(aucJs[g] - ref[g])));
    out.auc.tolerance = aucTol;
    out.auc_ok = out.auc.max_abs_diff_vs_phase0b <= aucTol;
  }
}
console.log(JSON.stringify(out, null, 1));
process.exit(out.parity_ok && (out.auc_ok === undefined || out.auc_ok) ? 0 : 1);
