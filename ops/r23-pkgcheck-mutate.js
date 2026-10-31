#!/usr/bin/env node
// ops/r23-pkgcheck-mutate.js: negative controls by mutation (R23 T5). For each check the tool relies on, a scratch COPY of the tool is built with that one check removed or
// broken, and the matching test file is run against it: the run must FAIL. The real files are never touched (the copy lives under the cache folder; lib/ and node_modules are symlinks).
// A mutation whose search text is not found exactly once is itself a failure of this script (it would prove nothing). The unmutated copy must PASS first.
//   node ops/r23-pkgcheck-mutate.js
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const ROOT = '/Volumes/D/r23/cache/pkgcheck/mut';
const UNIT = 'test/r23-pkgcheck.test.js';
const GUARD = 'test/r23-pkgcheck-guard.test.js';

// [name, file, find, replace, test file to run]
const MUTATIONS = [
  ['name validation: the npm name pattern accepts anything', 'tools/r23/pkg-check-names.js', 'if (!NPM_NAME.test(name) || name.includes(\'..\')) throw', 'if (false) throw', UNIT],
  ['name validation: ecosystem is not checked', 'tools/r23/pkg-check-names.js', "if (ecosystem !== 'npm' && ecosystem !== 'pypi') throw", 'if (false) throw', UNIT],
  ['URL building: the name is not encoded', 'tools/r23/pkg-check-names.js', "npmDoc: (name) => `https://${HOSTS.npm}/${npmPath(name)}`", 'npmDoc: (name) => `https://${HOSTS.npm}/${name}`', UNIT],
  ['URL lock: any host is allowed', 'tools/r23/pkg-check-names.js', "!ALLOWED_HOSTS.has(u.hostname) ||", '', UNIT],
  ['typosquat: the popular package itself is no longer exempt', 'tools/r23/pkg-check-typo.js', 'if (list.rank.has(norm)) return', 'if (false) return', UNIT],
  ['typosquat: the length floors are removed', 'tools/r23/pkg-check-typo.js', 'if ((d === 1 && shortest < 4) || (d === 2 && shortest < 8)) continue;', '', UNIT],
  ['malicious: a MAL- id is not recognised', 'tools/r23/pkg-check-osv.js', "const malicious = v.id.startsWith('MAL-') || aliases.some((x) => x.startsWith('MAL-'));", 'const malicious = false;', UNIT],
  ['severity: the database label is ignored and no score is read', 'tools/r23/pkg-check-osv.js', 'if (fromDb) return', 'if (false) return', UNIT],
  ['fixed versions: any package in the record counts', 'tools/r23/pkg-check-osv.js', 'if (!a || !same(a.package)) continue;', 'if (!a) continue;', UNIT],
  ['OSV down: the failure is swallowed and the answer is served without advisories', 'tools/r23/pkg-check.js', ".catch((e) => { throw e && e.status === 503 ? e : unavailable(`OSV.dev could not answer (${short(e && e.message, 90)})`, 60); })", '.catch(() => ({ advisories: [], total: 0, truncated: false }))', UNIT],
  ['unknown package: served as a 200 instead of a 404', 'tools/r23/pkg-check.js', "if (r.status === 404) throw notCovered(`npm has no package named ${name}`);", "if (r.status === 404) return { version: '0.0.0' };", UNIT],
  ['caching: a refusal is cached (the cache write moves before the work)', 'tools/r23/pkg-check.js', 'cache.set(key, out);\n      return out;', 'return out;', UNIT],
  ['concurrency: no cap on checks in flight', 'tools/r23/pkg-check.js', 'if (inflight >= maxInflight) throw', 'if (false) throw', UNIT],
  ['upstream refusals blame the caller: the registry-fallback failure is passed on as thrown (a guard refusal would be a 400)', 'tools/r23/pkg-check.js', "catch (e) { throw unavailable(`the npm registry could not answer (${short(e.message, 90)})`, 60); }", 'catch (e) { throw e; }', GUARD],
  ['SSRF: the POST connection does not use the guarded lookup', 'tools/r23/pkg-check-http.js', "method: 'POST', lookup: guardedLookup, timeout: limit,", "method: 'POST', timeout: limit,", GUARD],
  ['SSRF: the POST helper follows a redirect (treats 307 like success)', 'tools/r23/pkg-check-http.js', 'if (res.statusCode >= 300 && res.statusCode < 400) {', 'if (false) {', GUARD],
  ['size cap: the POST body is read without a byte cap', 'tools/r23/pkg-check-http.js', 'if (size > MAX_BYTES) { res.destroy();', 'if (false) { res.destroy();', GUARD],
  ['time cap: the POST has no timer', 'tools/r23/pkg-check-http.js', 'const timer = setTimeout(() => { finish(reject, upstream(\'timed out\')); req.destroy(); }, limit);', 'const timer = setTimeout(() => {}, 0);', GUARD],
  ['https only: the outer lock lets http through', 'tools/r23/pkg-check-names.js', "u.protocol !== 'https:' ||", '', UNIT],
  ['field reader: strings are not skipped as strings (braces inside them count)', 'tools/r23/pkg-check-pick.js', "if (b === QUOTE) { j = skipString(buf, j) - 1; continue; }", '', UNIT],
  ['description: the length rule (the house style) is broken', 'tools/r23/pkg-check.js', "const DESC = 'Use when an agent needs facts about", "const DESC = 'Facts about", UNIT],
];

function copyTree(dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.join(dest, 'test', 'fixtures', 'r23'), { recursive: true });
  fs.mkdirSync(path.join(dest, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dest, 'ops'), { recursive: true });
  fs.cpSync(path.join(REPO, 'tools', 'r23'), path.join(dest, 'tools', 'r23'), { recursive: true });
  fs.cpSync(path.join(REPO, 'test', 'fixtures', 'r23', 'pkgcheck'), path.join(dest, 'test', 'fixtures', 'r23', 'pkgcheck'), { recursive: true });
  for (const f of ['r23-pkgcheck.test.js', 'r23-pkgcheck-guard.test.js']) fs.copyFileSync(path.join(REPO, 'test', f), path.join(dest, 'test', f));
  fs.copyFileSync(path.join(REPO, 'ops', 'r23-pkgcheck-example.js'), path.join(dest, 'ops', 'r23-pkgcheck-example.js'));
  fs.symlinkSync(path.join(REPO, 'lib'), path.join(dest, 'lib'));
  fs.symlinkSync(fs.realpathSync(path.join(REPO, 'node_modules')), path.join(dest, 'node_modules'));
}
function runTests(dest, file) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', file], { cwd: dest, encoding: 'utf8', env: { ...process.env, OVERHANG_DB_PATH: '/Volumes/D/pensio/scratch/overhang.db', AGENTFEED_DB: ':memory:' }, timeout: 170000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const failed = [...new Set([...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]))];
  return { code: r.status, failed, tests: (/ℹ tests (\d+)/.exec(out) || [])[1], pass: (/ℹ pass (\d+)/.exec(out) || [])[1] };
}

const dest = path.join(ROOT, 'work');
copyTree(dest);
const base = ['UNIT', UNIT, 'GUARD', GUARD].filter((_, i) => i % 2 === 1).map((f) => [f, runTests(dest, f)]);
for (const [f, r] of base) console.log(`unmutated copy  ${f}: ${r.pass}/${r.tests} pass${r.code === 0 ? '' : '  <-- MUST PASS'}`);
if (base.some(([, r]) => r.code !== 0)) { console.error('the unmutated copy does not pass: nothing below means anything'); process.exit(2); }

let caught = 0, problems = 0;
for (const [name, file, find, replace, testFile] of MUTATIONS) {
  copyTree(dest);
  const target = path.join(dest, file);
  const src = fs.readFileSync(target, 'utf8');
  const n = src.split(find).length - 1;
  if (n !== 1) { console.log(`ERROR  ${name}: the text to mutate occurs ${n} times (must be 1)`); problems++; continue; }
  fs.writeFileSync(target, src.replace(find, () => replace));
  const r = runTests(dest, testFile);
  if (r.code !== 0 && r.failed.length) { caught++; console.log(`CAUGHT ${name}\n         ${testFile.replace('test/', '')}: ${r.failed.length} failing, e.g. "${r.failed[0].slice(0, 110)}"`); } else { problems++; console.log(`MISSED ${name}: ${testFile} still ${r.pass}/${r.tests} (exit ${r.code})`); }
}
console.log(`\n${caught}/${MUTATIONS.length} mutations caught, ${problems} not`);
process.exit(problems ? 1 : 0);
