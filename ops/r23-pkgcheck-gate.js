#!/usr/bin/env node
// ops/r23-pkgcheck-gate.js: the T5 GATE, run live from the Mac against the real registries and OSV.dev (R23).
//   node ops/r23-pkgcheck-gate.js [--json out.json]
// Responses are cached under /Volumes/D/r23/cache/pkgcheck/gate/ (key = sha256 of method, url and body), so a re-run makes ZERO calls; a live call is spaced 400 ms after the last.
// The 20 cases below were fixed BEFORE the first run and are not edited after it. They were chosen from public advisories and incident write-ups; a candidate is in the list
// only if the registry still serves that package/version (a removed one answers 404 and cannot be a case: see the notes). Selection looked at registry existence, never at what
// the tool answers. EXTRA cases are run and reported but are not counted in the gate.
//
// "Correct":
//   known-bad   flagged = malicious === true, OR a typosquat_candidate flag, OR a known_vulnerability flag of severity error (a high or critical advisory on that exact version)
//   known-good  the call answered and raised NO flag of severity error
// Nothing here changes a rule: it calls the tool as the server does (same module, same default HTTP code) and reports.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('../tools/r23/pkg-check');
const H = require('../tools/r23/pkg-check-http');

const CACHE = '/Volumes/D/r23/cache/pkgcheck/gate';
fs.mkdirSync(CACHE, { recursive: true });

const BAD = [
  ['npm', 'crossenv', null, 'typosquat of cross-env; 2017 credential-stealing package, now an npm security holding package'],
  ['npm', 'loadsh', null, 'typosquat of lodash; the registry deprecates it as a typosquat'],
  ['npm', 'mongose', null, 'typosquat of mongoose; 2017 malware campaign, now a security holding package'],
  ['npm', 'babelcli', null, 'typosquat of babel-cli (dropped separator); 2017 malware campaign, now a security holding package'],
  ['npm', 'faker', '6.6.6', 'sabotaged release by its author, January 2022'],
  ['npm', 'es5-ext', '0.10.54', 'protestware postinstall message, 2022'],
  ['npm', 'lodash', '4.17.15', 'prototype pollution, CVE-2020-8203 (high)'],
  ['npm', 'minimist', '1.2.5', 'prototype pollution, CVE-2021-44906 (critical)'],
  ['pypi', 'pyyaml', '5.3', 'arbitrary code execution, CVE-2020-14343 (critical)'],
  ['pypi', 'pillow', '8.0.0', 'several high-severity advisories on the 8.0.x line'],
];
const GOOD = [
  ['npm', 'express', null], ['npm', 'react', null], ['npm', 'lodash', null], ['npm', 'axios', null], ['npm', 'typescript', null],
  ['pypi', 'requests', null], ['pypi', 'numpy', null], ['pypi', 'flask', null], ['pypi', 'django', null], ['pypi', 'pandas', null],
];
const EXTRA = [
  ['npm', 'peacenotwar', null, 'protestware package by the node-ipc author'],
  ['npm', 'electron-native-notify', null, 'malicious package in a 2018 supply-chain attack, now a holding package'],
  ['npm', 'axios', '0.21.0', 'SSRF / ReDoS advisories on 0.21.0'],
  ['npm', 'node-fetch', '2.6.0', 'header leak on redirect, CVE-2020-15168 / CVE-2022-0235'],
  ['pypi', 'django', '2.2.0', 'many advisories on 2.2.0'],
  // incident cases the registries have REMOVED (expected 404 "not covered"): shown to prove they cannot be gate cases
  ['npm', 'event-stream', '3.3.6', 'REMOVED incident case: flatmap-stream bitcoin-wallet theft, 2018'],
  ['npm', 'ua-parser-js', '0.7.29', 'REMOVED incident case: hijacked release, 2021'],
  ['npm', 'coa', '2.0.3', 'REMOVED incident case: hijacked release, 2021'],
  ['npm', 'node-ipc', '10.1.1', 'REMOVED incident case: protestware, 2022'],
  ['npm', 'colors', '1.4.1', 'REMOVED incident case: sabotaged release, 2022'],
  ['pypi', 'ctx', '0.1.2', 'REMOVED incident case: hijacked project, 2022'],
  ['pypi', 'colourama', null, 'REMOVED incident case: typosquat of colorama'],
  ['pypi', 'jeIlyfish', null, 'REMOVED incident case: typosquat of jellyfish'],
  ['pypi', 'python3-dateutil', null, 'REMOVED incident case: typosquat of python-dateutil'],
];

// ---- cached HTTP with the production code underneath ----
const stats = { live: 0, cached: 0 };
let lastLive = 0;
const keyOf = (m, url, body) => crypto.createHash('sha256').update(`${m}\n${url}\n${body ? JSON.stringify(body) : ''}`).digest('hex');
async function cached(method, url, body, opts, live) {
  const file = path.join(CACHE, `${keyOf(method, url, body)}.json`);
  if (fs.existsSync(file)) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    stats.cached++;
    return { url, status: j.status, contentType: j.contentType, headers: j.headers, body: Buffer.from(j.body, 'base64') };
  }
  const wait = lastLive + 400 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const res = await live();
  lastLive = Date.now();
  stats.live++;
  const keep = { 'retry-after': res.headers && res.headers['retry-after'] };
  fs.writeFileSync(file, JSON.stringify({ method, url, fetched_at: new Date().toISOString(), status: res.status, contentType: res.contentType, headers: keep, body: res.body.toString('base64') }));
  return res;
}
const deps = {
  now: Date.now,
  get: (url, opts) => cached('GET', url, null, opts, () => H.get(url, opts)),
  post: (url, body, opts) => cached('POST', url, body, opts, () => H.post(url, body, opts)),
  cacheMax: 1,
};

const sevOf = (r, id) => (r.flags.find((f) => f.id === id) || {}).severity;
function judgeBad(r) {
  const why = [];
  if (r.malicious) why.push('malicious');
  if (r.flags.some((f) => f.id === 'typosquat_candidate')) why.push('typosquat');
  if (sevOf(r, 'known_vulnerability') === 'error') why.push('high/critical advisory');
  return why;
}
const judgeGood = (r) => r.flags.filter((f) => f.severity === 'error').map((f) => f.id);

async function runCase([eco, name, version]) {
  const { check } = P.makeCheck(deps);
  try { return { ok: true, r: await check({ name, ecosystem: eco, ...(version ? { version } : {}) }) }; } catch (e) { return { ok: false, status: e.status || (e.kind === 'bad_request' ? 400 : 'error'), message: e.message }; }
}
const show = (o) => (o.ok
  ? `v${o.r.version} adv=[${o.r.advisories.map((a) => a.id).join(' ')}] malicious=${o.r.malicious} flags=[${o.r.flags.map((f) => `${f.id}:${f.severity}`).join(' ')}] typo=[${o.r.typosquat.nearest.map((n) => `${n.name}:${n.distance}:${n.pattern}`).join(' ')}]${o.r.data_gaps ? ` gaps=${o.r.data_gaps.length}` : ''}`
  : `NO ANSWER ${o.status}: ${o.message}`);

(async () => {
  const out = { ran_at: new Date().toISOString(), bad: [], good: [], extra: [] };
  console.log('KNOWN-BAD (expected: flagged)');
  let badOk = 0;
  for (const c of BAD) {
    const o = await runCase(c);
    const why = o.ok ? judgeBad(o.r) : [];
    const holding = o.ok && o.r.flags.some((f) => f.id === 'registry_security_holding_package');
    const ok = why.length > 0;
    if (ok) badOk++;
    out.bad.push({ case: `${c[0]} ${c[1]}${c[2] ? '@' + c[2] : ''}`, note: c[3], correct: ok, why, holding_flag: holding, result: o.ok ? { version: o.r.version, advisories: o.r.advisories.map((a) => ({ id: a.id, severity: a.severity.label, malicious: a.malicious })), malicious: o.r.malicious, flags: o.r.flags, typosquat: o.r.typosquat, data_gaps: o.r.data_gaps || null } : { error: o.message, status: o.status } });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c[0]} ${c[1]}${c[2] ? '@' + c[2] : ''}  [${why.join(', ') || 'not flagged'}${holding ? '; also holding-package flag' : ''}]  ${show(o)}`);
  }
  console.log('\nKNOWN-GOOD (expected: answered, no error-severity flag)');
  let goodOk = 0;
  for (const c of GOOD) {
    const o = await runCase(c);
    const errs = o.ok ? judgeGood(o.r) : ['no answer'];
    const ok = o.ok && errs.length === 0;
    if (ok) goodOk++;
    out.good.push({ case: `${c[0]} ${c[1]}`, correct: ok, error_flags: errs, result: o.ok ? { version: o.r.version, advisories: o.r.advisories.map((a) => ({ id: a.id, severity: a.severity.label, malicious: a.malicious })), malicious: o.r.malicious, flags: o.r.flags, typosquat: o.r.typosquat, data_gaps: o.r.data_gaps || null, downloads: o.r.downloads, release_age_days: o.r.release.age_days } : { error: o.message, status: o.status } });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c[0]} ${c[1]}  ${show(o)}`);
  }
  console.log('\nEXTRA (reported, not counted)');
  for (const c of EXTRA) {
    const o = await runCase(c);
    out.extra.push({ case: `${c[0]} ${c[1]}${c[2] ? '@' + c[2] : ''}`, note: c[3], result: o.ok ? { version: o.r.version, advisories: o.r.advisories.map((a) => a.id), malicious: o.r.malicious, flags: o.r.flags.map((f) => `${f.id}:${f.severity}`) } : { error: o.message, status: o.status } });
    console.log(`      ${c[0]} ${c[1]}${c[2] ? '@' + c[2] : ''}  (${c[3]})  ${show(o)}`);
  }
  out.summary = { known_bad_correct: badOk, known_bad_total: BAD.length, known_good_correct: goodOk, known_good_total: GOOD.length, gate_pass: badOk === BAD.length && goodOk === GOOD.length, http_calls_live: stats.live, http_calls_cached: stats.cached };
  console.log(`\nGATE: known-bad ${badOk}/${BAD.length}, known-good ${goodOk}/${GOOD.length} -> ${out.summary.gate_pass ? 'PASS' : 'FAIL'}   (HTTP: ${stats.live} live, ${stats.cached} from cache)`);
  const ji = process.argv.indexOf('--json');
  if (ji > 0) fs.writeFileSync(process.argv[ji + 1], JSON.stringify(out, null, 2));
})();
