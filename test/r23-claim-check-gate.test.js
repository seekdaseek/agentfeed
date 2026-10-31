// test/r23-claim-check-gate.test.js: the gate script ops/r23-claimcheck-gate.mjs, run as a child process. It needs the four cached filings in /Volumes/D/r23/cache/claimcheck (downloaded
// once from sec.gov while building the gate); without them these tests skip with that reason and the script itself would download them.
// What is proved: with no key the script runs the offline check, says plainly that the live gate was not run and exits 2; a claims file whose passage is not in its filing is a
// PROBLEM (negative control for the check); the live path, driven by a STAND-IN for the Gemini API (not the gate: the stand-in is not a language model), counts, prints a summary
// and the cost, never prints the key, applies its own spend cap, and exits 0 only on a pass.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CACHE = '/Volumes/D/r23/cache/claimcheck';
const HAVE = ['aapl-10k-fy2024.html', 'msft-10q-q1fy25.html', 'tsla-10q-q3-2024.html', 'nvda-10k-fy2025.html'].every((f) => fs.existsSync(path.join(CACHE, f)));
const skip = HAVE ? false : `needs the cached filings in ${CACHE}`;
const SCRIPT = path.join(ROOT, 'ops', 'r23-claimcheck-gate.mjs');
const CLAIMS = path.join(ROOT, 'test', 'fixtures', 'r23', 'claimcheck', 'claims.json');
const KEY = 'synthetic-gate-test-key-123456';
const run = (args, env = {}) => {
  const e = { PATH: process.env.PATH, HOME: os.tmpdir(), ...env };
  const r = spawnSync(process.execPath, [SCRIPT, '--cache', CACHE, ...args], { env: e, encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
};

test('the claims file: 20 hand-made claims, 10 true and 10 false, from 4 fixed filings; every false claim names the one fact it altered; the ids are unique', () => {
  const doc = JSON.parse(fs.readFileSync(CLAIMS, 'utf8'));
  assert.equal(doc.claims.length, 20);
  assert.equal(doc.claims.filter((c) => c.expected === 'SUPPORTED').length, 10); assert.equal(doc.claims.filter((c) => c.expected === 'CONTRADICTED').length, 10);
  assert.equal(new Set(doc.claims.map((c) => c.id)).size, 20); assert.equal(Object.keys(doc.filings).length, 4);
  for (const c of doc.claims) {
    assert.ok(doc.filings[c.filing], c.id); assert.ok(c.passage.length > 15 && c.claim.length >= 10 && c.claim.length <= 300, c.id);
    assert.equal(Boolean(c.altered), c.expected === 'CONTRADICTED', `${c.id}: only a false claim names an alteration`);
  }
  for (const f of Object.values(doc.filings)) assert.match(f.url, /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\/[\w.-]+\.htm$/);
});

test('no key: the offline check runs (passages found in the filings, passage inside the excerpts the model would see), the live gate is said NOT to have run, exit code 2', { skip }, () => {
  const r = run(['--claims', CLAIMS]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /20 claims/); assert.match(r.out, /10 true \(SUPPORTED\), 10 false \(CONTRADICTED\), 4 filings/);
  assert.match(r.out, /passages found verbatim in their filing: 20 of 20; passage inside the excerpts the model would see: 20 of 20; passage accepted by the quote checks and the figure guard: 20 of 20/);
  assert.match(r.out, /OFFLINE CHECK: ok/); assert.match(r.out, /LIVE GATE NOT RUN: GEMINI_API_KEY is not set/);
  assert.doesNotMatch(r.out, /GATE PASS|GATE FAIL/);
});
test('negative control: a claims file whose passage is not in its filing, or whose false claim names no alteration, is a PROBLEM and exit code 1', { skip }, () => {
  const doc = JSON.parse(fs.readFileSync(CLAIMS, 'utf8'));
  doc.claims[0].passage = doc.claims[0].passage.replace('391,035', '391,053');
  delete doc.claims[1].altered;
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccgate-')), 'claims.json'); fs.writeFileSync(f, JSON.stringify(doc));
  const r = run(['--claims', f]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /PROBLEM: A1: the passage is not in aapl-10k-fy2024/); assert.match(r.out, /PROBLEM: A2: a false claim names what was altered/);
  assert.match(r.out, /PROBLEM: A1: the passage would not be shown to the model/); assert.match(r.out, /PROBLEM: A1: the passage itself would not pass the quote checks/); assert.match(r.out, /OFFLINE CHECK: 4 problem/);
});

test('live path against the stand-in model: all 20 claims run through the real route code, the summary and the cost are printed, the key is never printed, exit code matches PASS or FAIL', { skip }, () => {
  const stub = path.join(ROOT, 'test', 'fixtures', 'r23', 'claimcheck', 'stub-gemini-preload.js');
  const r = run(['--claims', CLAIMS, '--delay-ms', '0'], { GEMINI_API_KEY: KEY, NODE_OPTIONS: `--require ${stub}` });
  assert.ok(!r.out.includes(KEY), 'the key is not printed');
  assert.match(r.out, /LIVE GATE: 20 claim\(s\)/);
  assert.equal((r.out.match(/^[ANMT]\d? ?\d? +expected/gm) || r.out.match(/^[A-Z]\d+ +expected/gm) || []).length, 20, 'a line per claim');
  const m = /SUMMARY: (\d+) of 20 correct; (\d+) wrong verdict, (\d+) INSUFFICIENT, (\d+) error, (\d+) skipped; verdicts without a verified quote: (\d+)/.exec(r.out);
  assert.ok(m, r.out.slice(-600));
  assert.equal(Number(m[1]) + Number(m[2]) + Number(m[3]) + Number(m[4]) + Number(m[5]), 20, 'every claim is counted once');
  assert.equal(m[6], '0', 'the stand-in cannot ship a verdict without a verified quote either');
  assert.match(r.out, /cost: \d+ tokens in, \d+ out over \d+ model call\(s\), \d\.\d{6} USD/);
  const pass = Number(m[1]) >= 17 && m[6] === '0';
  assert.match(r.out, pass ? /GATE PASS/ : /GATE FAIL/); assert.equal(r.code, pass ? 0 : 1);
});
test('the script caps its own spend: with --max-usd below the worst case of one call every claim is SKIPPED and the gate fails', { skip }, () => {
  const stub = path.join(ROOT, 'test', 'fixtures', 'r23', 'claimcheck', 'stub-gemini-preload.js');
  const r = run(['--claims', CLAIMS, '--delay-ms', '0', '--max-usd', '0.01'], { GEMINI_API_KEY: KEY, NODE_OPTIONS: `--require ${stub}` });
  assert.equal(r.code, 1); assert.match(r.out, /0 of 20 correct; 0 wrong verdict, 0 INSUFFICIENT, 0 error, 20 skipped/); assert.match(r.out, /GATE FAIL .*the run stopped at the script spend cap/);
  assert.ok(!r.out.includes(KEY));
});
