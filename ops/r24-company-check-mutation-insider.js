#!/usr/bin/env node
// ops/r24-company-check-mutation-insider.js: negative controls of the Form 4 reader (R24 item 5, v2). It copies tools/r24/company-check/insider.js with ONE rule broken on purpose, runs
// test/r24-company-check-insider.test.js against the copy (R24_INSIDER_MODULE), and requires the run to FAIL; the unmutated copy must PASS first.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'tools/r24/company-check/insider.js');
const TEST = path.join(ROOT, 'test/r24-company-check-insider.test.js');
const src = fs.readFileSync(SRC, 'utf8').replace("require('./edgar')", `require(${JSON.stringify(path.join(ROOT, 'tools/r24/company-check/edgar'))})`).replace("require('fast-xml-parser')", `require(${JSON.stringify(path.join(ROOT, 'node_modules/fast-xml-parser'))})`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r24-ins-mut-'));
const MUT = [
  ['the cap of 25 filings is 30', (s) => s.replace('const CAP = 25;', 'const CAP = 30;')],
  ['the window is not applied', (s) => s.replace('rows.filter((r) => r.filed >= since)', 'rows.filter(() => true)')],
  ['purchases are summed as sales', (s) => s.replace("open_market_buys_usd: sum('P'), open_market_sales_usd: sum('S')", "open_market_buys_usd: sum('S'), open_market_sales_usd: sum('P')")],
  ['a derivative transaction would count', (s) => s.replace("(d.nonDerivativeTable || {}).nonDerivativeTransaction || []", "(d.nonDerivativeTable || {}).nonDerivativeTransaction || (d.derivativeTable || {}).derivativeTransaction || []")],
  ['a document with no reporting owner counts', (s) => s.replace("if (!(d.reportingOwner || []).length) return [];", '')],
  ['a Form 4 that is not served is an outage instead of skipped', (s) => s.replace("if (r.status === 200) {", "if (r.status !== 200) throw new Error('not served'); if (r.status === 200) {")],
  ['the cache by accession is not used', (s) => s.replace("let list = d.form4Cache ? d.form4Cache.get(f.accession, d.now()) : undefined;", 'let list;')],
  ['the xsl prefix of the document name is kept', (s) => s.replace("String(f.primary_document).replace(/^xsl[^/]*\\//, '')", 'String(f.primary_document)')],
];
const run = (file) => {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', TEST], { env: { ...process.env, R24_INSIDER_MODULE: file }, encoding: 'utf8', timeout: 300000 });
  return { code: r.status, failed: [...(r.stdout + r.stderr).matchAll(/^✖ (.*?) \(\d/gm)].map((m) => m[1]).filter((n, i, a) => a.indexOf(n) === i && !/^failing tests/.test(n)) };
};
const results = [];
const ctl = path.join(dir, 'control.js'); fs.writeFileSync(ctl, src); const c = run(ctl); results.push({ m: '(none: control copy)', expect: 'pass', code: c.code, failed: c.failed, ok: c.code === 0 });
MUT.forEach(([name, fn], k) => { const mu = fn(src); if (mu === src) { results.push({ m: name, expect: 'fail', code: null, failed: [], ok: false, note: 'pattern not found' }); return; } const f = path.join(dir, `m${k}.js`); fs.writeFileSync(f, mu); const r = run(f); results.push({ m: name, expect: 'fail', code: r.code, failed: r.failed, ok: r.code !== 0 }); });
fs.rmSync(dir, { recursive: true, force: true });
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.m.padEnd(62)} expected ${r.expect}, exit ${r.code}${r.failed.length ? `, failing: ${r.failed.map((x) => x.slice(0, 40)).join(' | ')}` : ''}${r.note ? ` (${r.note})` : ''}`);
const bad = results.filter((r) => !r.ok); console.log(`\n${results.length - bad.length} of ${results.length} as expected`); process.exit(bad.length ? 1 : 0);
