#!/usr/bin/env node
// ops/r24-pkgcheck-select.js: builds the CASE LIST of GATES-r24 section 1 (item 1, pkg-check re-gated) by QUERY AND RULE, before the tool is run on it.
//   node ops/r24-pkgcheck-select.js [--out /path/selection.json]
// It never requires tools/r23/pkg-check*.js: the tool is not run, and nothing the tool answers is looked at. Every upstream response is cached under
// /Volumes/D/r24/cache/pkgcheck/select/http/ (key = sha256 of method, url and body), so a re-run makes 0 calls and gives the same list.
//
// Rule (written before the first query; SEED and the strata below are fixed here and not edited after the first run):
//   KNOWN-BAD, 20 cases = the STRATA table (14 npm, 6 PyPI; severity x advisory-year buckets, so at least 6 are LOW or MODERATE and the years are spread).
//     pool        npm: the FULL wooorm/npm-high-impact ranking, 15,916 names (a download ranking, only used as a list of real packages); PyPI: the top 15,000 of the
//                 hugovk/top-pypi-packages download ranking read 2026-11-01 (used to PICK TEST CASES ONLY: nothing from it is bundled or served)
//     order       by sha256(SEED + ':' + name), ascending; the first 4,000 of the pool are scanned per stratum
//     per package one OSV POST /v1/query for the package (all pages): the records, which OSV already excludes when withdrawn, give version -> advisories (affected[].versions);
//                 a version's highest severity is the highest database_specific.severity label (CRITICAL > HIGH > MODERATE > LOW) among the records that list it
//     per stratum the first package (hash order, not used before, not excluded) with a version whose highest label is the stratum's label and whose earliest-published advisory
//                 carrying that label was published in the stratum's year bucket; versions tried in sha256(SEED + name + version) order, 6 at most; a version is accepted only if
//                   (1) the registry version document answers HTTP 200 (npm: registry.npmjs.org/<name>/<version>; PyPI: pypi.org/pypi/<name>/<version>/json), and
//                   (2) a version-level OSV POST /v1/query {version, package} returns at least one record and the same highest label
//     fallback    if no package of the first 4,000 fills a stratum, its year bucket is relaxed to any year (recorded)
//   REVISION, before the tool was ever run: run 1 of this script (npm pool = the bundled first 4,000 names, 1,500 scanned per stratum) filled 15 of 20 strata and only 5 LOW or MODERATE
//     cases (the gate needs 6); strata 1, 2, 3, 6 and 7 (npm LOW and MODERATE) stayed empty. The pool was widened to the full ranking and the scan limit raised to 4,000; nothing else changed.
//     Run 1's output is kept as selection-run1-superseded.json. No tool answer was seen at any point.
//   REVISION 2, still before the tool was ever run: run 2 (full pool, 4,000 scanned) filled only 14 of 20. Cause, measured offline on the cached OSV answers: of the first 4,920 npm
//     packages scanned 349 had advisories, but 283 of those 349 list their affected versions only as SEMVER ranges (no enumerated \`versions\`), and this script read enumerated lists only.
//     For npm it now also evaluates the SEMVER ranges (events introduced / fixed / last_affected, node_modules/semver for the comparison; a tool of this script only, not of the product)
//     against the version list of the registry's abbreviated package document, so a version can be chosen from a ranges-only record. The authoritative check is unchanged: the registry
//     version document must answer 200 and a version-level OSV query must return a record with the same highest label.
//   KNOWN-GOOD, 20 cases = the first 14 npm and the first 6 PyPI packages of the download rankings (npm: the order of the list; PyPI: download_count, descending) that
//     are not excluded, whose LATEST version at registration time (npm: registry.npmjs.org/<name>/latest; PyPI: pypi.org/pypi/<name>/json info.version) gets ZERO records from
//     a version-level OSV query. Weekly download counts (api.npmjs.org, pypistats.org) are recorded for the case file.
//   EXCLUDED  every package named in ops/r23-pkgcheck-gate.js (gate and EXTRA), every test fixture of the R23/R24 pkg-check build (example-*, es5-ext, ...).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SEED = 'r24-pkgcheck-1';
const CACHE = '/Volumes/D/r24/cache/pkgcheck/select/http';
const SPACING_MS = 300;
const UA = 'agentfeed-r24-case-selection/1.0 (+https://x402.ochinimus.app)';
const SCAN_PER_STRATUM = 4000;
const VERSIONS_PER_PACKAGE = 6;
const RANK = { CRITICAL: 4, HIGH: 3, MODERATE: 2, LOW: 1, UNLABELED: 0 };

// [ecosystem, label, yearFrom, yearTo]   (published year of the advisory that carries the version's highest label)
const STRATA = [
  ['npm', 'LOW', 0, 2020], ['npm', 'LOW', 2021, 2023], ['npm', 'LOW', 2024, 2026],
  ['npm', 'MODERATE', 0, 2020], ['npm', 'MODERATE', 2021, 2022], ['npm', 'MODERATE', 2023, 2024], ['npm', 'MODERATE', 2025, 2026],
  ['npm', 'HIGH', 0, 2020], ['npm', 'HIGH', 2021, 2022], ['npm', 'HIGH', 2023, 2024], ['npm', 'HIGH', 2025, 2026],
  ['npm', 'CRITICAL', 0, 2021], ['npm', 'CRITICAL', 2022, 2023], ['npm', 'CRITICAL', 2024, 2026],
  ['pypi', 'LOW', 0, 2026],
  ['pypi', 'MODERATE', 0, 2022], ['pypi', 'MODERATE', 2023, 2026],
  ['pypi', 'HIGH', 0, 2022], ['pypi', 'HIGH', 2023, 2026],
  ['pypi', 'CRITICAL', 0, 2026],
];
const GOOD_NPM = 14, GOOD_PYPI = 6;

fs.mkdirSync(CACHE, { recursive: true });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const stats = { live: 0, cached: 0 };
let lastLive = 0;
async function http(method, url, body, accept = 'application/json') {
  const file = path.join(CACHE, `${sha(`${method}\n${url}\n${body ? JSON.stringify(body) : ''}`)}.json`);
  if (fs.existsSync(file)) { stats.cached++; const j = JSON.parse(fs.readFileSync(file, 'utf8')); return { status: j.status, text: j.text, at: j.at }; }
  const wait = lastLive + SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  let res, text;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, { method, headers: { 'user-agent': UA, accept, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
      text = await res.text();
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      break;
    } catch (e) { if (attempt >= 3) throw e; await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); }
  }
  lastLive = Date.now(); stats.live++;
  const rec = { method, url, at: new Date().toISOString(), status: res.status, text };
  fs.writeFileSync(file, JSON.stringify(rec));
  return { status: res.status, text, at: rec.at };
}
const jsonOf = (r) => { try { return JSON.parse(r.text); } catch { return null; } };

// ---- OSV ----
const pep503 = (n) => String(n).toLowerCase().replace(/[-_.]+/g, '-');
async function osvQuery(eco, name, version) {
  const out = [];
  let token = null;
  for (let page = 0; page < 30; page++) {
    const r = await http('POST', 'https://api.osv.dev/v1/query', { ...(version ? { version } : {}), package: { name, ecosystem: eco === 'npm' ? 'npm' : 'PyPI' }, ...(token ? { page_token: token } : {}) });
    if (r.status !== 200) throw new Error(`OSV ${r.status} for ${eco} ${name} ${version || ''}`);
    const j = jsonOf(r);
    out.push(...((j && j.vulns) || []));
    token = j && j.next_page_token;
    if (!token) break;
  }
  return out;
}
const labelOf = (v) => { const s = v.database_specific && typeof v.database_specific.severity === 'string' ? v.database_specific.severity.toUpperCase() : null; return s && RANK[s] != null ? s : 'UNLABELED'; };
const highestLabel = (vulns) => vulns.reduce((best, v) => (RANK[labelOf(v)] > RANK[best] ? labelOf(v) : best), 'UNLABELED');
const yearOf = (v) => { const y = Number(String(v.published || '').slice(0, 4)); return Number.isFinite(y) && y > 1990 ? y : null; };
const semver = require('semver');
const mine = (eco, name, a) => a.package && a.package.ecosystem === (eco === 'npm' ? 'npm' : 'PyPI') && (eco === 'npm' ? a.package.name === name : pep503(a.package.name) === pep503(name));
/** OSV range events -> [{from, to, inclusive}] ("0" is the lowest version; a missing "to" is open-ended) */
function intervals(events) {
  const evs = (events || []).map((e) => { const k = Object.keys(e)[0]; return { k, v: String(e[k]) }; }).filter((e) => e.k === 'introduced' || e.k === 'fixed' || e.k === 'last_affected');
  const cmp = (a, b) => (a === b ? 0 : a === '0' ? -1 : b === '0' ? 1 : semver.compare(a, b));
  evs.sort((x, y) => cmp(x.v, y.v) || (x.k === 'introduced' ? -1 : 1));
  const out = []; let start = null;
  for (const e of evs) {
    if (e.k === 'introduced') { if (start == null) start = e.v; } else if (start != null) { out.push({ from: start, to: e.v, inclusive: e.k === 'last_affected' }); start = null; }
  }
  if (start != null) out.push({ from: start, to: null, inclusive: false });
  return out;
}
const inInterval = (ver, iv) => {
  try {
    if (iv.from !== '0' && semver.compare(ver, iv.from) < 0) return false;
    if (iv.to == null) return true;
    const c = semver.compare(ver, iv.to);
    return iv.inclusive ? c <= 0 : c < 0;
  } catch { return false; }
};
/** version -> Map(id -> record) of the records that list it: enumerated versions, and for npm also the SEMVER ranges evaluated over the registry's version list */
async function versionsMap(eco, name, vulns) {
  const m = new Map();
  const add = (ver, v) => { if (!m.has(ver)) m.set(ver, new Map()); m.get(ver).set(v.id, v); };
  for (const v of vulns) for (const a of v.affected || []) if (mine(eco, name, a)) for (const ver of a.versions || []) add(ver, v);
  if (eco === 'npm') {
    const ranged = vulns.filter((v) => (v.affected || []).some((a) => mine(eco, name, a) && (a.ranges || []).some((r) => r.type === 'SEMVER')));
    if (ranged.length) {
      const r = await http('GET', `https://registry.npmjs.org/${npmPath(name)}`, null, 'application/vnd.npm.install-v1+json');
      const doc = r.status === 200 ? jsonOf(r) : null;
      const list = doc && doc.versions ? Object.keys(doc.versions) : [];
      for (const v of ranged) {
        const ivs = [];
        for (const a of v.affected || []) if (mine(eco, name, a)) for (const rg of a.ranges || []) if (rg.type === 'SEMVER') { try { ivs.push(...intervals(rg.events)); } catch { /* an event that is not a version */ } }
        for (const ver of list) if (ivs.some((iv) => inInterval(ver, iv))) add(ver, v);
      }
    }
  }
  return m;
}

// ---- registries ----
const npmPath = (name) => name.replace('/', '%2F');
async function registryHas(eco, name, version) {
  const url = eco === 'npm' ? `https://registry.npmjs.org/${npmPath(name)}/${encodeURIComponent(version)}` : `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
  const r = await http('GET', url);
  return { url, status: r.status, at: r.at };
}
async function latestOf(eco, name) {
  if (eco === 'npm') {
    const r = await http('GET', `https://registry.npmjs.org/${npmPath(name)}/latest`);
    const j = r.status === 200 ? jsonOf(r) : null;
    return j && typeof j.version === 'string' ? { version: j.version, url: `https://registry.npmjs.org/${npmPath(name)}/latest`, at: r.at } : null;
  }
  const r = await http('GET', `https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  const j = r.status === 200 ? jsonOf(r) : null;
  return j && j.info && typeof j.info.version === 'string' ? { version: j.info.version, url: `https://pypi.org/pypi/${encodeURIComponent(name)}/json`, at: r.at } : null;
}
async function weekly(eco, name) {
  if (eco === 'npm') {
    const url = `https://api.npmjs.org/downloads/point/last-week/${npmPath(name)}`;
    const r = await http('GET', url); const j = r.status === 200 ? jsonOf(r) : null;
    return j && Number.isFinite(j.downloads) ? { count: j.downloads, url, from: j.start, to: j.end, at: r.at } : { count: null, url, status: r.status, at: r.at };
  }
  const url = `https://pypistats.org/api/packages/${encodeURIComponent(name)}/recent`;
  const r = await http('GET', url); const j = r.status === 200 ? jsonOf(r) : null;
  return j && j.data && Number.isFinite(j.data.last_week) ? { count: j.data.last_week, url, at: r.at } : { count: null, url, status: r.status, at: r.at };
}

// ---- pools and exclusions ----
function excludedNames() {
  const set = new Set(['es5-ext', 'peacenotwar', 'electron-native-notify']);
  const gate = fs.readFileSync(path.join(__dirname, 'r23-pkgcheck-gate.js'), 'utf8');
  for (const m of gate.matchAll(/\[\s*'(npm|pypi)',\s*'([^']+)'/g)) set.add(pep503(m[2]));
  return set;
}
const EXCLUDED = excludedNames();
// the rule also excludes every name the R23 gate file or any pkg-check test or fixture mentions (same scan as ops/r24-pkgcheck-register.js, which re-checks the final list)
const FIX_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'r23', 'pkgcheck');
const SCAN_TEXT = fs.readFileSync(path.join(__dirname, 'r23-pkgcheck-gate.js'), 'utf8') + '\n' + fs.readdirSync(FIX_DIR).map((f) => fs.readFileSync(path.join(FIX_DIR, f), 'utf8')).join('\n') + fs.readFileSync(path.join(__dirname, '..', 'test', 'r23-pkgcheck.test.js'), 'utf8');
const mentions = (text, name) => new RegExp(`(^|[^A-Za-z0-9_.@/-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_.-])`, 'i').test(text);
const exclMemo = new Map();
const isExcluded = (name) => {
  if (!exclMemo.has(name)) exclMemo.set(name, EXCLUDED.has(pep503(name)) || /^example-/.test(name) || name === 'es5-ext' || mentions(SCAN_TEXT, name));
  return exclMemo.get(name);
};
function pools() {
  // the FULL wooorm/npm-high-impact ranking (15,916 names, most downloaded first) from the R23 source download; the bundled data file is its first 4,000 (shown equal below)
  const npm = [...fs.readFileSync('/Volumes/D/r23/cache/pkgcheck/src/wooorm.top-download.js', 'utf8').matchAll(/^\s*'([^']+)',?\s*$/gm)].map((m) => m[1]);
  const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'r23', 'data', 'pkgcheck-top-npm.json'), 'utf8')).names;
  if (npm.length < 15000 || bundled.some((n, i) => npm[i] !== n)) throw new Error('the full npm ranking does not start with the bundled list: wrong file');
  const py = JSON.parse(fs.readFileSync('/Volumes/D/r24/cache/pkgcheck/select/top-pypi.min.json', 'utf8'));
  return { npm, pypi: py.rows.map((r) => r.project), pypiMeta: { last_update: py.last_update, source: py.source, rows: py.rows.length } };
}

(async () => {
  const P = pools();
  const out = { seed: SEED, started_at: new Date().toISOString(), excluded_names: [...EXCLUDED].sort(), pool_sizes: { npm: P.npm.length, pypi: P.pypi.length }, pypi_ranking: P.pypiMeta, bad: [], good: [], scan_log: [] };
  const used = new Set();

  for (const [i, [eco, label, y0, y1]] of STRATA.entries()) {
    const ordered = [...P[eco]].filter((n) => !isExcluded(n)).sort((a, b) => (sha(`${SEED}:${a}`) < sha(`${SEED}:${b}`) ? -1 : 1)).slice(0, SCAN_PER_STRATUM);
    let found = null, scanned = 0, relaxed = false;
    for (const pass of [0, 1]) {
      if (found) break;
      if (pass === 1) relaxed = true;
      for (const name of ordered) {
        if (used.has(`${eco}:${pep503(name)}`)) continue;
        scanned++;
        let vulns;
        try { vulns = await osvQuery(eco, name); } catch (e) { out.scan_log.push(`${eco} ${name}: ${e.message}`); continue; }
        if (!vulns.length) continue;
        const map = await versionsMap(eco, name, vulns);
        const cands = [];
        for (const [ver, recs] of map) {
          const list = [...recs.values()];
          if (highestLabel(list) !== label) continue;
          const top = list.filter((v) => labelOf(v) === label).map(yearOf).filter((y) => y != null).sort((a, b) => a - b);
          const yr = top.length ? top[0] : null;
          if (!relaxed && (yr == null || yr < y0 || yr > y1)) continue;
          cands.push(ver);
        }
        cands.sort((a, b) => (sha(`${SEED}:${name}:${a}`) < sha(`${SEED}:${name}:${b}`) ? -1 : 1));
        for (const ver of cands.slice(0, VERSIONS_PER_PACKAGE)) {
          const reg = await registryHas(eco, name, ver);
          if (reg.status !== 200) continue;
          const vv = await osvQuery(eco, name, ver);
          if (!vv.length || highestLabel(vv) !== label) continue;
          const yrs = vv.filter((v) => labelOf(v) === label).map(yearOf).filter((y) => y != null).sort((a, b) => a - b);
          found = {
            stratum: i + 1, stratum_rule: { ecosystem: eco, highest_label: label, year_from: y0 || null, year_to: y1, relaxed_to_any_year: relaxed },
            ecosystem: eco, name, version: ver, osv_highest_label: highestLabel(vv), osv_year_of_top_label_advisory: yrs[0] || null,
            osv_records: vv.map((v) => ({ id: v.id, label: labelOf(v), published: v.published || null, aliases: (v.aliases || []).slice(0, 4) })).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 12),
            osv_record_count: vv.length, registry_check: { url: reg.url, http_status: reg.status, at: reg.at },
          };
          break;
        }
        if (found) break;
      }
    }
    if (!found) { out.bad.push({ stratum: i + 1, stratum_rule: { ecosystem: eco, highest_label: label, year_from: y0 || null, year_to: y1 }, unfilled: true, scanned }); console.log(`stratum ${i + 1} ${eco} ${label} ${y0}-${y1}: UNFILLED after ${scanned}`); continue; }
    found.packages_scanned_for_stratum = scanned;
    used.add(`${eco}:${pep503(found.name)}`);
    out.bad.push(found);
    console.log(`stratum ${i + 1} ${eco} ${label} ${y0}-${y1}${relaxed ? ' (year relaxed)' : ''}: ${found.name}@${found.version} [${found.osv_records.map((r) => r.id).join(' ')}] year ${found.osv_year_of_top_label_advisory} (scanned ${scanned})`);
  }

  for (const [eco, want] of [['npm', GOOD_NPM], ['pypi', GOOD_PYPI]]) {
    let got = 0, skipped = [];
    for (const name of P[eco]) {
      if (got >= want) break;
      if (isExcluded(name)) { skipped.push([name, 'excluded: in the R23 gate or a fixture']); continue; }
      const latest = await latestOf(eco, name);
      if (!latest) { skipped.push([name, 'latest version not readable on the registry']); continue; }
      const vv = await osvQuery(eco, name, latest.version);
      if (vv.length) { skipped.push([name, `latest ${latest.version} has ${vv.length} OSV record(s)`]); continue; }
      const dl = await weekly(eco, name);
      got++;
      const rank = P[eco].indexOf(name) + 1;
      out.good.push({ ecosystem: eco, name, version: latest.version, rank_in_ranking: rank, osv_records_at_registration: 0, latest_check: { url: latest.url, at: latest.at }, weekly_downloads: dl });
      console.log(`good ${eco} #${rank} ${name}@${latest.version} weekly=${dl.count}`);
    }
    out[`good_${eco}_skipped`] = skipped;
  }

  out.finished_at = new Date().toISOString();
  out.http = { live: stats.live, from_cache: stats.cached };
  const oi = process.argv.indexOf('--out');
  const file = oi > 0 ? process.argv[oi + 1] : '/Volumes/D/r24/cache/pkgcheck/select/selection.json';
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nwritten ${file}; HTTP ${stats.live} live, ${stats.cached} cached; bad ${out.bad.filter((b) => !b.unfilled).length}/${STRATA.length}, good ${out.good.length}/${GOOD_NPM + GOOD_PYPI}`);
})().catch((e) => { console.error(e); process.exit(1); });
