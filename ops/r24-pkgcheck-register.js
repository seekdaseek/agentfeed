#!/usr/bin/env node
// ops/r24-pkgcheck-register.js: turns the output of ops/r24-pkgcheck-select.js into the REGISTERED case list of GATES-r24 section 1 and hashes it.
//   node ops/r24-pkgcheck-register.js [/path/selection.json]
// Writes /Volumes/D/agentfeed-briefs/r24-20261101/GATES-r24-1-cases.md and GATES-r24-1-cases.sha256, and REFUSES to overwrite either (a registered list is never rewritten).
// The tool is not run here. Before writing, it checks the gate's own conditions on the list and refuses to register a list that breaks one:
//   20 known-bad and 20 known-good; >= 5 PyPI in each; >= 6 known-bad whose highest label is LOW or MODERATE; no name of ops/r23-pkgcheck-gate.js or of any pkg-check test fixture;
//   every known-bad has a registry 200 and OSV records; every known-good has zero OSV records.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const BRIEFS = '/Volumes/D/agentfeed-briefs/r24-20261101';
const MD = path.join(BRIEFS, 'GATES-r24-1-cases.md');
const SHA = path.join(BRIEFS, 'GATES-r24-1-cases.sha256');
const selFile = process.argv[2] || '/Volumes/D/r24/cache/pkgcheck/select/selection.json';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pep503 = (n) => String(n).toLowerCase().replace(/[-_.]+/g, '-');

if (fs.existsSync(MD) || fs.existsSync(SHA)) { console.error('REFUSED: a case list is already registered; it is never rewritten'); process.exit(2); }
const sel = JSON.parse(fs.readFileSync(selFile, 'utf8'));
const selBytes = fs.readFileSync(selFile);

// ---- the gate's conditions ----
const names = (x) => new Set(x.map((c) => `${c.ecosystem}:${pep503(c.name)}`));
const bad = sel.bad.filter((b) => !b.unfilled), good = sel.good;
const problems = [];
if (bad.length !== 20) problems.push(`known-bad: ${bad.length} filled strata, not 20 (${sel.bad.filter((b) => b.unfilled).map((b) => b.stratum).join(',')} unfilled)`);
if (good.length !== 20) problems.push(`known-good: ${good.length}, not 20`);
if (bad.filter((b) => b.ecosystem === 'pypi').length < 5) problems.push('fewer than 5 PyPI known-bad');
if (good.filter((g) => g.ecosystem === 'pypi').length < 5) problems.push('fewer than 5 PyPI known-good');
if (bad.filter((b) => b.osv_highest_label === 'LOW' || b.osv_highest_label === 'MODERATE').length < 6) problems.push('fewer than 6 known-bad with highest label LOW or MODERATE');
if (new Set([...names(bad)]).size !== bad.length || new Set([...names(good)]).size !== good.length) problems.push('a package appears twice in one list');
// the names of the R23 gate and of every pkg-check fixture (text scan; the scan is shown to find known positives below)
const gateText = fs.readFileSync(path.join(__dirname, 'r23-pkgcheck-gate.js'), 'utf8');
const fixText = fs.readdirSync(path.join(REPO, 'test', 'fixtures', 'r23', 'pkgcheck')).map((f) => fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'r23', 'pkgcheck', f), 'utf8')).join('\n') + fs.readFileSync(path.join(REPO, 'test', 'r23-pkgcheck.test.js'), 'utf8');
const mentions = (text, name) => new RegExp(`(^|[^A-Za-z0-9_.@/-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_.-])`, 'i').test(text);
for (const [known, where, text] of [['crossenv', 'gate', gateText], ['es5-ext', 'fixtures', fixText], ['example-widget-kit', 'fixtures', fixText]]) if (!mentions(text, known)) problems.push(`the overlap scan does not find the known positive ${known} in the ${where}: the scan cannot be trusted`);
if (mentions(gateText, 'totally-invented-name-xyz') || mentions(fixText, 'totally-invented-name-xyz')) problems.push('the overlap scan matches an invented name');
const overlaps = [];
for (const c of [...bad, ...good]) { if (mentions(gateText, c.name)) overlaps.push(`${c.name} (gate)`); if (mentions(fixText, c.name)) overlaps.push(`${c.name} (fixtures)`); }
if (overlaps.length) problems.push(`names also in the R23 gate or a fixture: ${overlaps.join(', ')}`);
for (const b of bad) { if (b.registry_check.http_status !== 200) problems.push(`${b.name}@${b.version}: registry ${b.registry_check.http_status}`); if (!b.osv_record_count) problems.push(`${b.name}@${b.version}: no OSV record`); }
for (const g of good) if (g.osv_records_at_registration !== 0) problems.push(`${g.name}@${g.version}: OSV records at registration`);
if (problems.length) { console.error('REFUSED to register:\n  ' + problems.join('\n  ')); process.exit(3); }

// ---- re-verification at registration time, live (the cache is bypassed): the gate's "when the list is registered" ----
const UA = 'agentfeed-r24-case-selection/1.0 (+https://x402.ochinimus.app)';
const npmPath = (n) => n.replace('/', '%2F');
async function live(method, url, body) {
  const r = await fetch(url, { method, headers: { 'user-agent': UA, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  return { status: r.status, text: await r.text() };
}
async function osvIds(eco, name, version) {
  const ids = []; let token = null;
  for (let i = 0; i < 20; i++) {
    const r = await live('POST', 'https://api.osv.dev/v1/query', { version, package: { name, ecosystem: eco === 'npm' ? 'npm' : 'PyPI' }, ...(token ? { page_token: token } : {}) });
    if (r.status !== 200) throw new Error(`OSV ${r.status}`);
    const j = JSON.parse(r.text); ids.push(...(j.vulns || []).map((v) => v.id)); token = j.next_page_token; if (!token) break;
    await new Promise((x) => setTimeout(x, 250));
  }
  return ids;
}
async function reverify() {
  const t0 = new Date().toISOString(); const out = { started_at: t0, bad: [], good: [], problems: [] };
  for (const b of bad) {
    const url = b.ecosystem === 'npm' ? `https://registry.npmjs.org/${npmPath(b.name)}/${encodeURIComponent(b.version)}` : `https://pypi.org/pypi/${encodeURIComponent(b.name)}/${encodeURIComponent(b.version)}/json`;
    const reg = await live('GET', url); await new Promise((x) => setTimeout(x, 250));
    const ids = await osvIds(b.ecosystem, b.name, b.version); await new Promise((x) => setTimeout(x, 250));
    out.bad.push({ name: b.name, version: b.version, registry_http: reg.status, osv_ids_now: ids });
    if (reg.status !== 200) out.problems.push(`${b.name}@${b.version}: registry ${reg.status} at registration`);
    if (!ids.length) out.problems.push(`${b.name}@${b.version}: no OSV record at registration`);
  }
  for (const g of good) {
    const latest = await live('GET', g.ecosystem === 'npm' ? `https://registry.npmjs.org/${npmPath(g.name)}/latest` : `https://pypi.org/pypi/${encodeURIComponent(g.name)}/json`); await new Promise((x) => setTimeout(x, 250));
    const j = latest.status === 200 ? JSON.parse(latest.text) : null;
    const now = j ? (g.ecosystem === 'npm' ? j.version : j.info.version) : null;
    const ids = await osvIds(g.ecosystem, g.name, g.version); await new Promise((x) => setTimeout(x, 250));
    out.good.push({ name: g.name, version: g.version, latest_now: now, osv_ids_now: ids });
    if (now !== g.version) out.problems.push(`${g.name}: latest is ${now} at registration, selected ${g.version}`);
    if (ids.length) out.problems.push(`${g.name}@${g.version}: ${ids.length} OSV record(s) at registration`);
  }
  out.finished_at = new Date().toISOString();
  return out;
}

(async () => {
const rv = await reverify();
if (rv.problems.length) { console.error('REFUSED to register (re-verification at registration):\n  ' + rv.problems.join('\n  ')); process.exit(4); }

// ---- code identity ----
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();
const files = [...fs.readdirSync(path.join(REPO, 'tools', 'r23')).filter((f) => /^pkg-check.*\.js$/.test(f)).map((f) => `tools/r23/${f}`), ...fs.readdirSync(path.join(REPO, 'tools', 'r23', 'data')).filter((f) => /^pkgcheck-/.test(f)).map((f) => `tools/r23/data/${f}`), 'ops/r24-pkgcheck-gate.js', 'ops/r24-pkgcheck-select.js', 'ops/r24-pkgcheck-register.js'];
const fileHashes = files.sort().map((f) => `${sha(fs.readFileSync(path.join(REPO, f)))}  ${f}`);
const head = git('rev-parse', 'HEAD'), branch = git('rev-parse', '--abbrev-ref', 'HEAD');
// the worktree is shared with other agents of the batch: only the paths of this item are listed
const dirty = git('status', '--short', '--', 'tools/r23', 'test/r23-pkgcheck.test.js', 'test/r23-pkgcheck-guard.test.js', 'test/r23-pkgcheck-real-server.test.js', 'test/fixtures/r23/pkgcheck', 'ops').split('\n').filter(Boolean).filter((l) => /pkg-?check/.test(l));
const now = new Date().toISOString();

// ---- cases ----
const badCases = bad.map((b, i) => ({ id: `B${String(i + 1).padStart(2, '0')}`, ecosystem: b.ecosystem, name: b.name, version: b.version, expected: 'flagged', expected_highest_label: b.osv_highest_label, osv_ids: b.osv_records.map((r) => r.id), osv_record_count: b.osv_record_count, osv_year_of_top_label_advisory: b.osv_year_of_top_label_advisory, stratum: b.stratum, year_bucket_relaxed: b.stratum_rule.relaxed_to_any_year }));
const goodCases = good.map((g, i) => ({ id: `G${String(i + 1).padStart(2, '0')}`, ecosystem: g.ecosystem, name: g.name, version: g.version, expected: 'not flagged, no error flag', rank_in_ranking: g.rank_in_ranking, weekly_downloads: g.weekly_downloads.count }));
const tab = (rows, head) => [head, head.replace(/[^|]/g, '-'), ...rows].join('\n');
const pyBad = bad.filter((b) => b.ecosystem === 'pypi').length, lm = bad.filter((b) => b.osv_highest_label === 'LOW' || b.osv_highest_label === 'MODERATE').length;
const labelHist = {}; for (const b of bad) labelHist[b.osv_highest_label] = (labelHist[b.osv_highest_label] || 0) + 1;
const yearHist = {}; for (const b of bad) yearHist[b.osv_year_of_top_label_advisory] = (yearHist[b.osv_year_of_top_label_advisory] || 0) + 1;

const md = `# GATES-r24-1-cases: the registered case list for item 1 (pkg-check re-gated)

Registered: **${now}** (UTC). Rule: GATES-r24.md section 1 (sha256 in GATES-r24.sha256, never edited). The tool was NOT run on any case of this list before this file was hashed.

## Code the list is registered against
- repository: /Volumes/D/r24/agentfeed, branch ${branch}, HEAD ${head} (origin/main 1d3aa62 plus uncommitted changes: this build may not commit, so the code identity is the sha256 of every file the gate runs, below)
- uncommitted paths of this item (git status --short, other agents' paths in the shared worktree left out): ${dirty.length} (${dirty.map((l) => l.trim()).join('; ')})
- files:
~~~
${fileHashes.join('\n')}
~~~

## How the list was chosen (selection by query and rule; the tool is not involved)
- Command: \`node ops/r24-pkgcheck-select.js\` (SEED \`${sel.seed}\`; the rule is in the header of that file, fixed before its first query). Started ${sel.started_at}, finished ${sel.finished_at}; ${sel.http.live} live HTTP calls and ${sel.http.from_cache} cache reads; every response is kept in /Volumes/D/r24/cache/pkgcheck/select/http/. Selection output: ${selFile}, sha256 ${sha(selBytes)}.
- Then: \`node ops/r24-pkgcheck-register.js\`, which refuses to register a list that breaks a condition of the gate (checked, all hold): 20 known-bad and 20 known-good; PyPI cases known-bad ${pyBad}, known-good ${good.filter((g) => g.ecosystem === 'pypi').length} (each >= 5); known-bad with highest label LOW or MODERATE: ${lm} (>= 6); no package name of ops/r23-pkgcheck-gate.js (gate and EXTRA) or of any pkg-check fixture or test appears in the list (the overlap scan was first shown to find crossenv, es5-ext and example-widget-kit and to ignore an invented name); every known-bad has a registry HTTP 200 on its exact version document and at least one OSV record from a version-level query; every known-good has zero OSV records from a version-level query.
- Queries used: OSV \`POST https://api.osv.dev/v1/query\` with {package} (all pages) to list the records and the versions each lists, and with {version, package} for the authoritative per-version list; OSV excludes withdrawn records from POST queries (OSV FAQ). Registry: npm \`GET https://registry.npmjs.org/<name>/<version>\` and \`/<name>/latest\`; PyPI \`GET https://pypi.org/pypi/<name>/<version>/json\` and \`/pypi/<name>/json\` (info.version). Weekly downloads: \`https://api.npmjs.org/downloads/point/last-week/<name>\`, \`https://pypistats.org/api/packages/<name>/recent\`.
- Pools and rankings: npm = the FULL wooorm/npm-high-impact ranking, ${sel.pool_sizes.npm} names, most downloaded first (R23 source download /Volumes/D/r23/cache/pkgcheck/src/wooorm.top-download.js; the bundled tools/r23/data/pkgcheck-top-npm.json is its first 4,000 and the script checked that); PyPI = hugovk/top-pypi-packages (last_update ${sel.pypi_ranking.last_update}, source ${sel.pypi_ranking.source}, 30-day downloads, ${sel.pypi_ranking.rows} rows), read ONLY to pick test cases (nothing from it is bundled or served).
- Known-bad: 20 strata fixed in advance (ecosystem x highest OSV label x year bucket of the earliest advisory carrying that label); per stratum the first package in sha256(SEED:name) order that has a qualifying version; versions tried in sha256(SEED:name:version) order. Highest label = the highest \`database_specific.severity\` label among the records listing the version.
- Known-good: the first 14 npm and first 6 PyPI packages of the rankings, in rank order, not excluded, whose latest version at registration has zero OSV records. Skipped candidates are listed at the end.
- Excluded names (R23 gate, EXTRA and fixtures): ${sel.excluded_names.join(', ')}.

## History of the selection script before this registration (the tool was never run in any of it)
1. Run 1: npm pool = the bundled first 4,000 names, 1,500 scanned per stratum. It filled 15 of 20 strata and only 5 LOW or MODERATE cases (the gate needs 6); npm LOW and MODERATE strata 1, 2, 3, 6, 7 stayed empty. Output kept: selection-run1-superseded.json (sha256 ${sha(fs.readFileSync('/Volumes/D/r24/cache/pkgcheck/select/selection-run1-superseded.json'))}).
2. Run 2: pool widened to the full npm ranking, scan limit 4,000 per stratum. It filled 14 of 20. A measurement on the cached OSV answers (offline) found the cause: of the first 4,920 npm packages scanned, 349 had advisories and 283 of those list their affected versions only as SEMVER ranges, which the script did not read. Output kept: selection-run2-superseded.json (sha256 ${sha(fs.readFileSync('/Volumes/D/r24/cache/pkgcheck/select/selection-run2-superseded.json'))}).
3. Run 3 (this list): for npm the script also evaluates the SEMVER ranges against the registry's version list. The evaluator was first shown to agree exactly with OSV's own version-level answers on 16 (package, version) pairs of lodash, minimist and axios (names outside this list; they are R23 gate names and excluded). All 20 strata filled; stratum 2 had its year bucket relaxed to any year by the written fallback.
4. A first registration file was written at the end of run 3 and replaced before any scoring: it described the npm pool inaccurately and omitted this history. The case list was identical; the replaced file is kept as GATES-r24-1-cases.v0-superseded.md with its sha256 (86374fcd12ed90db927c2fb597b78f4ba3ed86a5d6fe6ca4218136cd7c2dbb5b).
5. The semver module used for the range comparison is node_modules/semver 7.8.5 (a transitive dependency; used by this ops script only, never by the tool).

## Re-verified live at registration (cache bypassed), ${rv.started_at} to ${rv.finished_at}
Every known-bad: registry HTTP 200 on the exact version document and at least one OSV record from a version-level query. Every known-good: the registry's latest version still equals the selected version and the version-level OSV query returns zero records. ${rv.bad.length + rv.good.length} cases, 0 problems.

## Correct, and PASS (GATES-r24 section 1, verbatim in effect)
known-bad is correct when \`flagged\` is true; known-good is correct when \`flagged\` is false AND no flag of severity \`error\` is raised for any reason. PASS: 0 known-bad rated clean AND at least 38 of 40 correct. Live run from the Mac (ops/r24-pkgcheck-gate.js), once; responses cached under /Volumes/D/r24/cache/pkgcheck/gate/. A case the tool cannot answer is not correct.

## Known-bad (20)
Highest label histogram: ${JSON.stringify(labelHist)}; year of the top-label advisory: ${JSON.stringify(yearHist)}.

${tab(bad.map((b, i) => `| ${badCases[i].id} | ${b.ecosystem} | ${b.name} | ${b.version} | ${b.osv_highest_label} | ${b.osv_year_of_top_label_advisory}${b.stratum_rule.relaxed_to_any_year ? ' (bucket relaxed)' : ''} | ${b.osv_records.slice(0, 4).map((r) => r.id).join(' ')}${b.osv_record_count > 4 ? ` (+${b.osv_record_count - 4})` : ''} | ${b.registry_check.http_status} ${b.registry_check.at} |`), '| id | eco | package | version | highest label | year | OSV ids at registration | registry |')}

## Known-good (20)
${tab(good.map((g, i) => `| ${goodCases[i].id} | ${g.ecosystem} | ${g.name} | ${g.version} | ${g.rank_in_ranking} | ${g.weekly_downloads.count} | 0 |`), '| id | eco | package | latest version | rank | weekly downloads | OSV records |')}

## Skipped known-good candidates (in rank order, before the 20 were filled)
npm: ${sel.good_npm_skipped.map(([n, why]) => `${n} (${why})`).join('; ') || 'none'}
PyPI: ${sel.good_pypi_skipped.map(([n, why]) => `${n} (${why})`).join('; ') || 'none'}

## Machine-readable list (the gate reads this block; the whole file is hashed)
<!-- cases-json:begin -->
\`\`\`json
${JSON.stringify({ bad: badCases, good: goodCases }, null, 2)}
\`\`\`
<!-- cases-json:end -->
`;
fs.writeFileSync(MD, md);
const h = sha(fs.readFileSync(MD));
fs.writeFileSync(SHA, `${h}  GATES-r24-1-cases.md\n`);
console.log(`registered ${MD}\nsha256 ${h}\nknown-bad ${bad.length} (PyPI ${pyBad}, LOW/MODERATE ${lm}), known-good ${good.length}`);
})().catch((e) => { console.error(e); process.exit(1); });
