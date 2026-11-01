#!/usr/bin/env node
// ops/r24-rwa-score.js: the scoring run of GATES-r24.md section 3 (R24, item 3), from the Mac, against public Ethereum RPC endpoints. Two steps, each run once on the scoring day:
//   node ops/r24-rwa-score.js run <out.json>
//       One live evaluation of every product in the register (fresh caches, no snapshots, the same engine the route runs), written with the raw integers behind every figure.
//       The issuer's published figure is NOT read here and cannot influence this step.
//   node ops/r24-rwa-score.js compare <run.json> <issuer-figures.json> <out.md>
//       |our 30-day realized yield - the issuer's published 30-day figure| <= 0.75 percentage points, per product; a product with no issuer figure does not pass.
//       issuer-figures.json: { "<product id>": { "figure_pct": 3.71, "label": "...", "url": "...", "read_utc": "...", "note": "..." } | { "unreadable": "reason" } }
// The tolerance and the pass line come from the GATES-r24.md text, not from this file's judgement: TOLERANCE_PP and PASS_LINE below are those numbers.
'use strict';
const fs = require('fs');
const E = require('../tools/r24/rwa/evaluate');
const R = require('../tools/r24/rwa/rpc');
const P = require('../tools/r24/rwa/products');

const TOLERANCE_PP = 0.75;
const PASS_LINE = 5;
// evidence tiers fixed in GATES-r24-3-cases.md before any issuer figure was read: 'strict' = the issuer's published text names the address AND the read function
const TIERS = { usdy: 'strict', ousg: 'strict', ustb: 'strict', usyc: 'lenient', tbill: 'strict', mtbill: 'strict', syrupusdc: 'strict' };

async function run(outFile) {
  const rows = [];
  for (const p of P.PRODUCTS) {
    const caches = { history: E.makeStore(64, E.HISTORY_TTL_MS), blocks: E.makeStore(16, E.HISTORY_TTL_MS), answers: E.makeStore(16, E.ANSWER_TTL_MS), health: new Map() };
    const rpc = R.makeRpc({ endpoints: R.endpointsFrom(process.env), budget: 120, health: caches.health });
    const row = { product: p.id, started_utc: new Date().toISOString() };
    try {
      const out = await E.evaluate({ products: [p], deps: { rpc, snapshotDb: null, caches, noAnswerCache: true } });
      row.answer = out.products[0]; row.block = out.block; row.as_of = out.as_of;
      row.raw = {};
      for (const [k, pr] of caches.history.entries()) { const v = await pr; row.raw[k] = { raw: v.raw.toString(), block: v.block, block_ts: v.blockTs, updated_at: v.updatedAt }; }
      row.rpc_requests = rpc.used();
    } catch (e) { row.error = { status: e.status || null, message: e.message, detail: e.detail || null }; }
    rows.push(row);
  }
  const doc = { generated_utc: new Date().toISOString(), tolerance_pp: TOLERANCE_PP, results: rows };
  fs.writeFileSync(outFile, JSON.stringify(doc, null, 2) + '\n');
  console.log(`${rows.filter((r) => r.answer).length} of ${rows.length} products read; written ${outFile}`);
}

function compare(runFile, issuerFile, outFile) {
  const runDoc = JSON.parse(fs.readFileSync(runFile, 'utf8')); const iss = JSON.parse(fs.readFileSync(issuerFile, 'utf8'));
  const lines = ['| product | our 30-day (percent) | issuer figure | label read | difference (pp) | pass |', '|---|---|---|---|---|---|'];
  let strict = 0; let lenient = 0; let passN = 0;
  const verdict = {};
  for (const r of runDoc.results) {
    const i = iss[r.product] || { unreadable: 'no entry' };
    const ours = r.answer ? r.answer.yield_30d_annualized : null;
    let ok = false; let diff = null;
    if (ours != null && i.figure_pct != null && Number.isFinite(i.figure_pct)) { const d = ours - i.figure_pct; ok = Math.abs(d) <= TOLERANCE_PP + 1e-9; diff = Number(d.toFixed(4)); }      // judged on the unrounded difference
    verdict[r.product] = ok;
    if (ok) { passN++; if (TIERS[r.product] === 'strict') strict++; else lenient++; }
    lines.push(`| ${r.product} | ${ours == null ? `no answer (${r.error ? r.error.message : '?'})` : ours.toFixed(4)} | ${i.figure_pct != null ? i.figure_pct : `unreadable: ${i.unreadable || '?'}`} | ${i.label || ''} | ${diff == null ? 'n/a' : diff} | ${ok ? 'PASS' : 'FAIL'} |`);
  }
  const summary = `\nTolerance ${TOLERANCE_PP} pp. Passing: ${passN} of ${runDoc.results.length}. With the issuer's text naming address and function (strict tier): ${strict}. Others (lenient tier): ${lenient}.\n`
    + `Item verdict (at least ${PASS_LINE} products pass): all tiers ${passN >= PASS_LINE ? 'PASS' : 'FAIL (CUT)'}; strict tier only ${strict >= PASS_LINE ? 'PASS' : 'FAIL (CUT)'}.\n`;
  fs.writeFileSync(outFile, lines.join('\n') + '\n' + summary);
  console.log(lines.join('\n') + summary);
  console.log(JSON.stringify(verdict));
}

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === 'run' && a) run(a).catch((e) => { console.error(String(e && e.message)); process.exit(1); });
else if (cmd === 'compare' && a && b && c) compare(a, b, c);
else { console.error('usage: r24-rwa-score.js run <out.json> | compare <run.json> <issuer.json> <out.md>'); process.exit(1); }
