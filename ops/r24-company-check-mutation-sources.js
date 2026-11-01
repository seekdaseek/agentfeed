#!/usr/bin/env node
// ops/r24-company-check-mutation-sources.js: negative controls of the static-source rule (GATES-r24-5-v3.md rule 1). It copies tools/r24/company-check/edgar.js and index.js into a temporary folder
// (their relative requires rewritten to absolute paths, index.js pointed at the copy of edgar.js), breaks ONE thing on purpose, runs test/r24-company-check-sources.test.js against the copies
// (R24_CC_INDEX, R24_CC_EDGAR), and requires the run to FAIL. The unmutated pair is run first and must PASS.
// usage: node ops/r24-company-check-mutation-sources.js      (no network)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'tools/r24/company-check');
const TEST = path.join(ROOT, 'test/r24-company-check-sources.test.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r24-src-mut-'));
const abs = (src, own) => src.replace(/require\('(\.{1,2}\/[^']+)'\)/g, (m, rel) => {
  if (own && rel === './edgar') return `require(${JSON.stringify(path.join(tmp, 'edgar.js'))})`;
  return `require(${JSON.stringify(path.resolve(path.dirname(own === 'index' ? path.join(DIR, 'index.js') : path.join(DIR, 'edgar.js')), rel))})`;
});
const EDGAR = fs.readFileSync(path.join(DIR, 'edgar.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(DIR, 'index.js'), 'utf8');
const BROWSE = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K&dateb=&owner=include&count=40";

const MUT = [
  ['the submissions JSON source is a browse-edgar listing', 'edgar', (s) => s.replace('const submissionsUrl = (cik) => `https://data.sec.gov/submissions/CIK${cik}.json`;', `const submissionsUrl = (cik) => \`${BROWSE}\`;`)],
  ['a filing index source carries a query string', 'edgar', (s) => s.replace('/${acc}-index.htm`;', '/${acc}-index.htm?x=1`;')],
  ['a filing document source goes through cgi-bin', 'edgar', (s) => s.replace('const docUrl = (cik, acc, doc) => `https://www.sec.gov/Archives/edgar/data/', 'const docUrl = (cik, acc, doc) => `https://www.sec.gov/cgi-bin/viewer?x=/Archives/edgar/data/')],
  ['the static-source check accepts everything', 'edgar', (s) => s.replace('function isStaticSource(href) {', 'function isStaticSource(href) {\n  if (href !== undefined) return true;')],
  ['the static-source check ignores the query string', 'edgar', (s) => s.replace("u.search || u.hash || ", '')],
  ['the static-source check accepts any path on the two hosts', 'edgar', (s) => s.replace('return STATIC_PATHS.some(([h, p]) => h.test(u.hostname) && p.test(u.pathname));', 'return STATIC_PATHS.some(([h]) => h.test(u.hostname));')],
  ['a section without a filing cites a listing page', 'index', (s) => s.replace("reason: 'no 10-Q on EDGAR for this company', source: E.submissionsUrl(sub.cik) }", `reason: 'no 10-Q on EDGAR for this company', source: \`${BROWSE.replace('${cik}', '${sub.cik}')}\` }`)],
  ['the insider section cites a listing page', 'index', (s) => s.replace('    source: E.submissionsUrl(cik),', `    source: \`${BROWSE.replace('${cik}', '${cik}')}\`,`)],
  ['the company section cites a listing page', 'index', (s) => s.replace(/(company: \{[^\n]*?)source: E\.submissionsUrl\(sub\.cik\)/, `$1source: \`${BROWSE.replace('${cik}', '${sub.cik}')}\``)],
];
function run(edgarSrc, indexSrc) {
  fs.writeFileSync(path.join(tmp, 'edgar.js'), abs(edgarSrc, 'edgar'));
  fs.writeFileSync(path.join(tmp, 'index.js'), abs(indexSrc, 'index'));
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', TEST], { env: { ...process.env, R24_CC_INDEX: path.join(tmp, 'index.js'), R24_CC_EDGAR: path.join(tmp, 'edgar.js') }, encoding: 'utf8', timeout: 300000 });
  return { code: r.status, failed: [...(r.stdout + r.stderr).matchAll(/^✖ (.*?) \(\d/gm)].map((m) => m[1]).filter((n, i, a) => a.indexOf(n) === i && !/^failing tests/.test(n)) };
}
const results = [];
const c = run(EDGAR, INDEX); results.push({ m: '(none: control copies)', expect: 'pass', code: c.code, failed: c.failed, ok: c.code === 0 });
for (const [name, which, fn] of MUT) {
  const e = which === 'edgar' ? fn(EDGAR) : EDGAR; const i = which === 'index' ? fn(INDEX) : INDEX;
  if ((which === 'edgar' && e === EDGAR) || (which === 'index' && i === INDEX)) { results.push({ m: name, expect: 'fail', code: null, failed: [], ok: false, note: 'pattern not found' }); continue; }
  const r = run(e, i); results.push({ m: name, expect: 'fail', code: r.code, failed: r.failed, ok: r.code !== 0 });
}
fs.rmSync(tmp, { recursive: true, force: true });
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.m.padEnd(58)} expected ${r.expect}, exit ${r.code}${r.failed.length ? `, failing: ${r.failed.map((x) => x.slice(0, 44)).join(' | ')}` : ''}${r.note ? ` (${r.note})` : ''}`);
const bad = results.filter((r) => !r.ok); console.log(`\n${results.length - bad.length} of ${results.length} as expected`); process.exit(bad.length ? 1 : 0);
