#!/usr/bin/env node
// ops/r24-company-check-mutation.js: the negative controls of the going-concern phrase test (R24 item 5). For every rule of tools/r24/company-check/going-concern.js it copies the module with that rule
// turned into a pattern that never matches (or, for NEAR and MAX_LINE, into a value that disables the window or the line merge), runs test/r24-company-check-going-concern.test.js against the copy
// (the test file reads the module path from R24_GC_MODULE), and requires the run to FAIL. An unmutated copy is run first as the control: it must PASS, or the harness itself is broken.
// usage: node ops/r24-company-check-mutation.js      (no network; about 15 runs of a test file that takes 0.2 s)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'tools/r24/company-check/going-concern.js');
const TEST = path.join(ROOT, 'test/r24-company-check-going-concern.test.js');
const src = fs.readFileSync(SRC, 'utf8');
const SKIP = new Set(['DOUBT', 'GOING', 'ENDS_SENTENCE', 'AFTER_END', 'NOT_BEFORE_RESOLVE']);          // not decision rules: the phrases themselves, sentence punctuation, and the helper of RESOLVE
const rules = [...src.matchAll(/^const ([A-Z_]+) = (\/.*?\/[a-z]*);/gm)].map((m) => m[1]).filter((n) => !SKIP.has(n));
const numeric = [['NEAR', '100000000'], ['MAX_LINE', '0']];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r24-gc-mut-'));

function run(file) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', TEST], { env: { ...process.env, R24_GC_MODULE: file }, encoding: 'utf8' });
  const failed = [...(r.stdout + r.stderr).matchAll(/^✖ (.*?) \(\d/gm)].map((m) => m[1]).filter((n, i, a) => a.indexOf(n) === i && !/^failing tests/.test(n));
  return { code: r.status, failed };
}
const results = [];
// control: an identical copy passes
const ctl = path.join(dir, 'control.js'); fs.writeFileSync(ctl, src);
const c = run(ctl); results.push({ mutation: '(none: control copy)', expect: 'pass', code: c.code, failed: c.failed, ok: c.code === 0 });
for (const name of rules) {
  const re = new RegExp(`^const ${name} = \\/.*?\\/[a-z]*;`, 'm');
  const mutated = src.replace(re, `const ${name} = /(?!)/;`);
  if (mutated === src) { results.push({ mutation: name, expect: 'fail', code: null, failed: [], ok: false, note: 'pattern not found in the module' }); continue; }
  const f = path.join(dir, `${name}.js`); fs.writeFileSync(f, mutated);
  const r = run(f); results.push({ mutation: `${name} never matches`, expect: 'fail', code: r.code, failed: r.failed, ok: r.code !== 0 });
}
for (const [name, value] of numeric) {
  const re = new RegExp(`^const ${name} = [0-9]+;`, 'm');
  const mutated = src.replace(re, `const ${name} = ${value};`);
  if (mutated === src) { results.push({ mutation: name, expect: 'fail', code: null, failed: [], ok: false, note: 'constant not found' }); continue; }
  const f = path.join(dir, `${name}.js`); fs.writeFileSync(f, mutated);
  const r = run(f); results.push({ mutation: `${name} = ${value}`, expect: 'fail', code: r.code, failed: r.failed, ok: r.code !== 0 });
}
fs.rmSync(dir, { recursive: true, force: true });
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.mutation.padEnd(28)} expected ${r.expect}, exit ${r.code}${r.failed.length ? `, failing: ${r.failed.map((x) => x.slice(0, 60)).join(' | ')}` : ''}${r.note ? ` (${r.note})` : ''}`);
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length} of ${results.length} as expected`);
process.exit(bad.length ? 1 : 0);
