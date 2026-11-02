#!/usr/bin/env node
// ops/pensio-pass-alert-mutate.js: negative controls by mutation (2 Nov 2026). For each rule pensioPassAlert in ops/af-digest.js relies on, a scratch COPY of af-digest.js is built with
// that one rule removed or broken, and test/pensio-pass-alert.test.js is run against it: the run must FAIL. The real files are never touched (the copy lives in the scratch folder;
// lib, tools and node_modules are symlinks). A mutation whose search text is not found exactly once is itself a failure of this script (it would prove nothing). The unmutated copy must PASS first.
//   node ops/pensio-pass-alert-mutate.js [--only <substring of a mutation name>]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const ROOT = process.env.PENSIO_PASS_MUT_DIR || '/Volumes/D/r24/scratch/pensio-pass/mut';
const SRC = 'ops/af-digest.js';
const TEST = 'test/pensio-pass-alert.test.js';

// [name, find, replace]
const MUTATIONS = [
  ['quiet period is 1 hour, not 12', 'const PENSIO_QUIET = 12 * 3600e3;', 'const PENSIO_QUIET = 1 * 3600e3;'],
  ['quiet period is 24 hours, not 12', 'const PENSIO_QUIET = 12 * 3600e3;', 'const PENSIO_QUIET = 24 * 3600e3;'],
  ['no quiet period at all', 'if (seen.alertedAt && now - seen.alertedAt < PENSIO_QUIET) return 0;', ''],
  ['quiet period ends one run late (<=)', 'now - seen.alertedAt < PENSIO_QUIET) return 0;', 'now - seen.alertedAt <= PENSIO_QUIET) return 0;'],
  ['the line is 2 days, not 3', ': 3);\nconst PENSIO_QUIET', ': 2);\nconst PENSIO_QUIET'],
  ['the line is 4 days, not 3', ': 3);\nconst PENSIO_QUIET', ': 4);\nconst PENSIO_QUIET'],
  ['exactly 3 days left alerts (<=)', 'left < warnMs) problem', 'left <= warnMs) problem'],
  ['an expired pass at exactly 0 left is not expired (<)', 'left != null && left <= 0) problem', 'left != null && left < 0) problem'],
  ['expiry is not checked at all', "else if (left != null && left <= 0) problem = `(${row.prefix}) expired ${stamp(row.expires_at)} UTC`;", ''],
  ['the days left are rounded, not floored (2.96 shows 3.0)', 'Math.floor(left / 864e4) / 10', 'Math.round(left / 864e4) / 10'],
  ['a revoked or pending pass is not a problem', "else if (row.status !== 'active') problem = `(${row.prefix}) is ${row.status}`;", ''],
  ['an unknown key is not a problem', "if (!row) problem = 'is unknown to the server: the key in its file matches no api_keys row';\n    else if (row.status", 'if (!row) { delete state.pensioPass; return 0; }\n    else if (row.status'],
  ['a file that is not an afk_ key goes on to the lookup', 'if (!problem && !PENSIO_KEY_RE.test(key)) problem', 'if (false) problem'],
  ['a key of any length is accepted (the regex floor is gone)', '/^afk_[A-Za-z0-9]{20,80}$/', '/^afk_[A-Za-z0-9]{1,80}$/'],
  ['a missing file is not a problem', "problem = e && e.code === 'ENOENT' ? `is missing: ${file} does not exist` : `cannot be read: ${file} (${(e && e.code) || 'error'})`; }", "problem = null; key = 'afk_x'; }"],
  ['an unreadable file is reported as missing', "`cannot be read: ${file} (${(e && e.code) || 'error'})`", '`is missing: ${file} does not exist`'],
  ['the hash is not the sha256 of the key', ".update(key, 'utf8')", ".update(key + 'x', 'utf8')"],
  ['the whole file is the key (a second line breaks it)', ".split('\\n')[0].trim()", '.trim()'],
  ['the line ending is not trimmed (CRLF breaks it)', ".split('\\n')[0].trim()", ".split('\\n')[0]"],
  ['the alert shows the key, not its prefix', '`(${row.prefix}) is ${row.status}`', '`(${key}) is ${row.status}`'],
  ['a healthy pass does not clear the state', 'if (!problem) { delete state.pensioPass; return 0; }', 'if (!problem) { return 0; }'],
  ['a failed send still marks the state', 'if (!(await sendFn(text))) return 0;\n  seen.alertedAt = now;', 'seen.alertedAt = now;\n  if (!(await sendFn(text))) return 0;'],
  ['an unreadable api_keys table is reported as a missing pass', 'nothing checked`); return 0; }\n    const left', "nothing checked`); problem = 'is missing'; }\n    const left"],
  ['the alert is not called from --alert', 'try { await pensioPassAlert(db, state, now); }', 'try { await Promise.resolve(); }'],
  ['the key file path is the wrong one', "process.env.AF_PENSIO_KEY_FILE || '/opt/pensio-tg/agentfeed.key'", "process.env.AF_PENSIO_KEY_FILE || '/opt/pensio-tg/key'"],
  ['--dry writes state (the state is saved even when dry)', 'const saveState = (s) => { if (!DRY) {', 'const saveState = (s) => { if (true) {'],
];

function copyTree(dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  for (const d of ['ops', 'test']) fs.mkdirSync(path.join(dest, d), { recursive: true });
  for (const f of [SRC, TEST]) fs.copyFileSync(path.join(REPO, f), path.join(dest, f));
  for (const d of ['lib', 'tools', 'node_modules']) fs.symlinkSync(path.join(REPO, d), path.join(dest, d));
  fs.writeFileSync(path.join(dest, 'package.json'), fs.readFileSync(path.join(REPO, 'package.json')));
}
function runTests(dest) {
  const r = spawnSync(process.execPath, ['--test', TEST], { cwd: dest, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test' }, timeout: 120000 });
  const pass = /^# pass (\d+)/m.exec(r.stdout) || /ℹ pass (\d+)/.exec(r.stdout); const fail = /^# fail (\d+)/m.exec(r.stdout) || /ℹ fail (\d+)/.exec(r.stdout);
  return { status: r.status, pass: pass ? Number(pass[1]) : null, fail: fail ? Number(fail[1]) : null, tail: (r.stdout || '').split('\n').filter((l) => /^\s*(✖|not ok)/.test(l) && !/failing tests/.test(l)).slice(0, 2).map((l) => l.trim().slice(0, 55)).join(' | ') };
}

function main() {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  copyTree(ROOT);
  const base = runTests(ROOT);
  console.log(`unmutated ${TEST}: exit ${base.status}, pass ${base.pass}, fail ${base.fail}`);
  if (base.status !== 0) { console.log('the unmutated copy must pass first'); process.exit(1); }
  const full = path.join(ROOT, SRC); const orig = fs.readFileSync(full, 'utf8');
  let killed = 0, ran = 0, bad = 0;
  for (const [name, find, replace] of MUTATIONS) {
    if (only && !name.includes(only)) continue;
    const n = orig.split(find).length - 1;
    if (n !== 1) { console.log(`INVALID  ${name}: search text found ${n} times in ${SRC}`); bad++; continue; }
    ran++;
    fs.writeFileSync(full, orig.replace(find, () => replace));
    const r = runTests(ROOT);
    fs.writeFileSync(full, orig);
    if (r.status !== 0) { killed++; console.log(`killed   ${name}  [${r.fail} failing: ${r.tail.slice(0, 110)}]`); } else { bad++; console.log(`SURVIVED ${name}  (the test file still passes with this rule broken)`); }
  }
  console.log(`\n${killed} of ${ran} mutations killed; ${bad} problems`);
  process.exit(bad ? 1 : 0);
}
main();
