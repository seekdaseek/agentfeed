#!/usr/bin/env node
// ops/r24-company-check-mutation-stream.js: negative controls of the stream scanner (R24 item 5, v2). It copies tools/r24/company-check/html-stream.js with ONE rule broken on purpose, runs
// test/r24-company-check-stream.test.js against the copy (the test file reads the module path from R24_STREAM_MODULE), and requires the run to FAIL. An unmutated copy is run first: it must PASS.
// usage: node ops/r24-company-check-mutation-stream.js      (no network)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'tools/r24/company-check/html-stream.js');
const TEST = path.join(ROOT, 'test/r24-company-check-stream.test.js');
const src = fs.readFileSync(SRC, 'utf8').replace("require('../../r23/claim-check/text')", `require(${JSON.stringify(path.join(ROOT, 'tools/r23/claim-check/text'))})`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r24-stream-mut-'));
const EMPTY_CARRY = 'carry = i >= n ? EMPTY : Buffer.from(buf.subarray(i));';

const MUTATIONS = [
  ['no tail kept while looking for a closing tag (HOLD_TAIL = 0)', (s) => s.replace('const HOLD_TAIL = 64;', 'const HOLD_TAIL = 0;')],
  ['html scanner drops the bytes it could not decide yet (no carry)', (s) => s.replace(EMPTY_CARRY, 'carry = EMPTY;')],
  ['plain scanner drops its unfinished line (no carry)', (s) => { const i = s.indexOf(EMPTY_CARRY); return s.slice(0, i + 1) + s.slice(i + 1).replace(EMPTY_CARRY, 'carry = EMPTY;'); }],
  ['"<" with fewer than 4 bytes after it is judged at once', (s) => s.replace('if (n - lt < 4 && !final) break;', '')],
  ['a tag whose ">" has not arrived is text', (s) => s.replace('if (gt < 0) { if (!final && n - lt < MAX_TAG) break; put(\'<\'); i = lt + 1; continue; }', 'if (gt < 0) { put(\'<\'); i = lt + 1; continue; }')],
  ['text is decoded at the end of each chunk (no wait for the next "<")', (s) => s.replace('if (final) { text(buf, i, n); i = n; } else if', 'if (true) { text(buf, i, n); i = n; } else if')],
  ['table rows are not rows', (s) => s.replace("if (!closing && name === 'tr' && !inRow) inRow = true;", '')],
  ['<head> and <ix:header> are not skipped', (s) => s.replace("if (!closing && (name === 'head' || name === 'ix:header')) {", 'if (false) {')],
  ['script, style, noscript and template are not skipped', (s) => s.replace('if (!closing && SKIP_TAGS.has(name)) {', 'if (false) {')],
  ['comments are not skipped', (s) => s.replace("if (buf[lt + 1] === 33 && buf[lt + 2] === 45 && buf[lt + 3] === 45) {   // <!--", 'if (false) {')],
  ['a blank line does not end a plain-text paragraph', (s) => s.replace('if (/^[ \\t]*$/.test(l)) emit(); else {', 'if (false) emit(); else {')],
];

function run(file) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', TEST], { env: { ...process.env, R24_STREAM_MODULE: file }, encoding: 'utf8', timeout: 600000 });
  const failed = [...(r.stdout + r.stderr).matchAll(/^✖ (.*?) \(\d/gm)].map((m) => m[1]).filter((n, i, a) => a.indexOf(n) === i && !/^failing tests/.test(n));
  return { code: r.status, failed };
}
const results = [];
const ctl = path.join(dir, 'control.js'); fs.writeFileSync(ctl, src);
const c = run(ctl); results.push({ mutation: '(none: control copy)', expect: 'pass', code: c.code, failed: c.failed, ok: c.code === 0 });
MUTATIONS.forEach(([name, fn], k) => {
  const mutated = fn(src);
  if (mutated === src) { results.push({ mutation: name, expect: 'fail', code: null, failed: [], ok: false, note: 'pattern not found in the module' }); return; }
  const f = path.join(dir, `m${k}.js`); fs.writeFileSync(f, mutated);
  const r = run(f); results.push({ mutation: name, expect: 'fail', code: r.code, failed: r.failed, ok: r.code !== 0 });
});
fs.rmSync(dir, { recursive: true, force: true });
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.mutation.padEnd(70)} expected ${r.expect}, exit ${r.code}${r.failed.length ? `, failing: ${r.failed.map((x) => x.slice(0, 50)).join(' | ')}` : ''}${r.note ? ` (${r.note})` : ''}`);
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length} of ${results.length} as expected`);
process.exit(bad.length ? 1 : 0);
