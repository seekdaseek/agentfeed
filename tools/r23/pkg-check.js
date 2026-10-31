// tools/r23/pkg-check.js: GET /api/pkg-check?name=&ecosystem=npm|pypi&version= (R23 T5, get_pkg_check, $0.02).
//
// For one npm or PyPI package version: the OSV.dev advisories that affect it, a malicious-package marker, release age, maintainer counts and changes where the registry exposes them,
// install scripts, weekly downloads, how close the NAME is to a very commonly installed package, the repository link, and a list of factual flags. Public APIs, no key.
// The flags are signals from public records; they are not a verdict on a package and say nothing about who is behind it.
//
// Upstream calls (hosts fixed in pkg-check-names.js, the name validated and encoded before any request, GET through lib/safe-fetch.js, OSV POST through pkg-check-http.js):
//   npm   registry.npmjs.org/<name> (full document: release times, maintainers, scripts), or when that is over the 5 MB read cap / unavailable, registry.npmjs.org/<name>/<version|latest>
//   PyPI  pypi.org/pypi/<name>/json, or when that is over the cap and a version was given, pypi.org/pypi/<name>/<version>/json
//   OSV   api.osv.dev/v1/query            (CORE: if it cannot answer, the call is a 503 and nothing is charged)
//   downloads  api.npmjs.org/downloads/point/last-week/<name>, pypistats.org/api/packages/<name>/recent  (optional: failure gives downloads null with a reason)
// Refusals (common.js): a bad name, ecosystem or version is a 400 before any request; a package or version the registry does not know is a 404 "not covered, not charged";
// a registry or OSV that cannot answer, or the tool being busy, is a 503 "Not charged." with Retry-After.
// Memory: one bounded TTL cache of finished answers (CACHE_MAX), a cap on calls in flight (MAX_INFLIGHT), the two bundled lists read once; no other state.
'use strict';
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { unavailable, notCovered, envNum } = require('./common');
const N = require('./pkg-check-names');
const T = require('./pkg-check-typo');
const O = require('./pkg-check-osv');
const H = require('./pkg-check-http');
const K = require('./pkg-check-pick');

const DAY_MS = 86400000;
const TOTAL_MS = 22000;          // all upstream calls of one answer
const CACHE_MAX = 100;
const CACHE_TTL_MS = 10 * 60 * 1000;
const NEW_RELEASE_DAYS = 7;
const NEW_PACKAGE_DAYS = 30;
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];
const READ_CAP_MB = H.MAX_BYTES / (1024 * 1024);

// ---- small helpers ----
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const short = (s, n = 140) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, n);
const validIso = (s) => (typeof s === 'string' && s.length <= 40 && !Number.isNaN(Date.parse(s)) ? s : null);
const ageDays = (nowMs, iso) => (iso ? Math.max(0, Math.floor((nowMs - Date.parse(iso)) / DAY_MS)) : null);
const isOversize = (e) => Boolean(e && /-byte limit/.test(String(e.message)));
const retryAfterOf = (res, dflt) => { const n = Number(res && res.headers && res.headers['retry-after']); return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.round(n), 5), 300) : dflt; };
function parseJson(buf) { try { return JSON.parse(buf.toString('utf8')); } catch { return undefined; } }
// the big registry documents are read field by field (pkg-check-pick.js), never parsed whole: a 4 MB document would cost tens of MB of resident memory per call
function pick(buf, select) { try { return K.pickJson(buf, select); } catch { return undefined; } }
const plural = (n, one, many) => (n === 1 ? one : many);

/** a small TTL + size bounded map: the oldest entry goes first when full */
function makeCache({ max, ttlMs, now }) {
  const m = new Map();
  return {
    get(k) { const e = m.get(k); if (!e) return undefined; if (e.exp <= now()) { m.delete(k); return undefined; } m.delete(k); m.set(k, e); return e.v; },
    set(k, v) { m.delete(k); m.set(k, { v, exp: now() + ttlMs }); while (m.size > max) m.delete(m.keys().next().value); },
    get size() { return m.size; },
  };
}

// ---- repository link ----
function repoInfo(raw) {
  let url = null;
  if (typeof raw === 'string') url = raw; else if (isObj(raw) && typeof raw.url === 'string') url = raw.url;
  url = url ? url.trim().slice(0, 300) : null;
  if (!url) return { url: null, present: false, host: null, recognized_host: false };
  let n = url.replace(/^git\+/, '');
  let m;
  if ((m = /^(github|gitlab):(\S+)$/.exec(n))) n = `https://${m[1]}.com/${m[2]}`;
  else if (/^[\w.-]+\/[\w.-]+$/.test(n)) n = `https://github.com/${n}`;                 // the npm shorthand owner/repo means GitHub
  else if ((m = /^git@([^:\s]+):(.+)$/.exec(n))) n = `https://${m[1]}/${m[2]}`;
  else if ((m = /^(?:git|ssh):\/\/(?:git@)?([^/\s]+)\/(.+)$/.exec(n))) n = `https://${m[1]}/${m[2]}`;
  n = n.replace(/#.*$/, '').replace(/\.git$/, '');
  let host = null;
  try {
    const u = new URL(n);
    if (u.protocol === 'http:' || u.protocol === 'https:') { host = u.hostname.toLowerCase().replace(/^www\./, ''); u.username = ''; u.password = ''; n = u.href.replace(/\/$/, ''); }
  } catch { /* not a URL */ }
  return { url: short(host ? n : url, 300), present: true, host, recognized_host: host === 'github.com' || host === 'gitlab.com' };
}
/** PyPI has no single repository field: the first Source / Repository / Code / Git* project URL, a recognised host preferred, else a recognised Homepage */
function pypiRepo(info) {
  const urlsMap = isObj(info && info.project_urls) ? info.project_urls : {};
  const cands = Object.entries(urlsMap).filter(([k, v]) => /source|repo|code|git/i.test(k) && typeof v === 'string').map(([, v]) => repoInfo(v));
  const pick = cands.find((c) => c.recognized_host) || cands[0];
  if (pick) return pick;
  const home = repoInfo(info && info.home_page);
  const anyUrl = Object.values(urlsMap).filter((v) => typeof v === 'string').map(repoInfo).find((c) => c.recognized_host);
  if (anyUrl) return anyUrl;
  return home.recognized_host ? home : { url: null, present: false, host: null, recognized_host: false };
}

// ---- npm ----
function installScripts(m) {
  const out = [];
  const scripts = isObj(m && m.scripts) ? m.scripts : {};
  for (const hook of INSTALL_HOOKS) if (typeof scripts[hook] === 'string' && scripts[hook].trim()) out.push({ script: hook, command: short(scripts[hook], 200) });
  if (m && m.gypfile === true && !out.some((s) => s.script === 'install')) out.push({ script: 'install', command: 'node-gyp rebuild (implicit: the package ships a binding.gyp)', implicit: true });
  return out;
}
const maintainerNames = (arr) => new Set((Array.isArray(arr) ? arr : []).map((x) => (isObj(x) && typeof x.name === 'string' ? x.name : null)).filter(Boolean));
const publisherOf = (m) => (m && isObj(m._npmUser) && typeof m._npmUser.name === 'string' ? m._npmUser.name : null);

/** what the full npm document gives that the version document cannot: release times and the maintainer history around this version */
function npmFromDocument(doc, want, name) {
  const latest = isObj(doc['dist-tags']) && typeof doc['dist-tags'].latest === 'string' ? doc['dist-tags'].latest : null;
  const versions = isObj(doc.versions) ? doc.versions : {};
  const version = want || latest;
  if (!version) throw notCovered(`npm lists no latest version of ${name}`);
  if (!hasOwn(versions, version) || !isObj(versions[version])) throw notCovered(`npm has no version ${version} of ${name}`);
  const m = versions[version];
  const time = isObj(doc.time) ? doc.time : {};
  const publishedAt = validIso(time[version]);
  const keys = Object.keys(versions);
  const stamp = (v) => (validIso(time[v]) ? Date.parse(time[v]) : null);
  const firstPublishedAt = validIso(time.created) || (keys.map(stamp).filter((x) => x != null).sort((a, b) => a - b).map((x) => new Date(x).toISOString())[0] || null);
  let prev = null;
  const prior = [];
  if (publishedAt) {
    const mine = Date.parse(publishedAt);
    for (const v of keys) {
      const t = stamp(v);
      if (v === version || t == null || t >= mine) continue;
      prior.push(v);
      if (prev == null || t > stamp(prev)) prev = v;
    }
  }
  let maint = { available: true, count: maintainerNames(doc.maintainers).size || maintainerNames(m.maintainers).size, added_since_previous_version: null, removed_since_previous_version: null, published_by_new_account: null, source: 'registry document' };
  if (prev) {
    const cur = maintainerNames(m.maintainers), before = maintainerNames(versions[prev].maintainers);
    maint.added_since_previous_version = [...cur].filter((x) => !before.has(x)).length;
    maint.removed_since_previous_version = [...before].filter((x) => !cur.has(x)).length;
    const pub = publisherOf(m);
    if (pub) {
      const seen = new Set(before);
      for (const v of prior) { const p = publisherOf(versions[v]); if (p) seen.add(p); }
      maint.published_by_new_account = !seen.has(pub);
    }
  }
  return { version, latest, isLatest: latest ? version === latest : null, versionCount: keys.length, manifest: m, publishedAt, firstPublishedAt, maint, gaps: [] };
}

// ---- PyPI ----
function pypiFiles(arr) { return (Array.isArray(arr) ? arr : []).filter(isObj); }
const uploadOf = (f) => validIso(f.upload_time_iso_8601) || (typeof f.upload_time === 'string' && validIso(`${f.upload_time}Z`)) || null;
const minIso = (list) => list.map((x) => Date.parse(x)).sort((a, b) => a - b).map((x) => new Date(x).toISOString())[0] || null;

function pypiRelease(files) {
  const times = files.map(uploadOf).filter(Boolean);
  return {
    publishedAt: minIso(times),
    yanked: files.length > 0 && files.every((f) => f.yanked === true),
    distributions: { sdist: files.some((f) => f.packagetype === 'sdist'), wheels: files.filter((f) => f.packagetype === 'bdist_wheel').length },
  };
}
function pypiOwners(doc) {
  const roles = isObj(doc.ownership) && Array.isArray(doc.ownership.roles) ? doc.ownership.roles : null;
  // an organisation-owned project (django, numpy) lists few or no individual roles: count says how many individuals PyPI names, organization_owned says whether an organisation owns the project
  return roles ? { available: true, count: roles.length, organization_owned: Boolean(doc.ownership.organization), added_since_previous_version: null, removed_since_previous_version: null, published_by_new_account: null, source: 'PyPI ownership roles (no history is exposed)' }
    : { available: false, reason: 'the PyPI JSON API did not expose project owners for this project' };
}

// ---- answer assembly (pure: no I/O, so the published example is built by the same code) ----
const SEV_ORDER = { error: 0, warn: 1, info: 2 };

function buildFlags({ ecosystem, name, version, advisories, malicious, release, view, typo, scripts, repository }) {
  const flags = [];
  const flag = (id, severity, detail) => flags.push({ id, severity, detail });
  const mal = advisories.filter((a) => a.malicious);
  if (malicious) flag('malicious_package', 'error', `OSV lists ${mal.slice(0, 3).map((a) => a.id).join(', ')} (a malicious-package advisory) for ${name}@${version}`);
  const known = advisories.filter((a) => !a.malicious);
  if (known.length) {
    const top = known[0];
    const hi = top.severity.label;
    const fixed = top.fixed_versions.length ? `; ${top.id} lists a fix in ${top.fixed_versions.slice(0, 3).join(', ')}` : '';
    flag('known_vulnerability', hi === 'critical' || hi === 'high' ? 'error' : 'warn', `${known.length} OSV ${plural(known.length, 'advisory affects', 'advisories affect')} ${name}@${version}; highest severity ${hi}${fixed}`);
  }
  if (view.holding) flag('registry_security_holding_package', 'warn', 'the registry marks this version as a security holding package, a placeholder that replaced removed content');
  if (release.yanked) flag('yanked_release', 'warn', 'this release is yanked on PyPI');
  if (typo.nearest && typo.nearest.length) {
    const t = typo.nearest[0];
    const sev = t.pattern === 'edit_distance' && t.distance >= 2 ? 'info' : 'warn';
    const how = { edit_distance: `${t.distance} ${plural(t.distance, 'edit', 'edits')} from`, separator_variant: 'the same letters as', token_swap: 'the same words, reordered, as', scope_removed: 'the unscoped name part of' }[t.pattern];
    flag('typosquat_candidate', sev, `the name is ${how} ${t.name}, ${t.rank ? `rank ${t.rank} in` : 'one of'} the bundled list of commonly installed ${ecosystem === 'npm' ? 'npm' : 'PyPI'} packages (${typo.nearest.length} ${plural(typo.nearest.length, 'match', 'matches')})`);
  }
  if (scripts && scripts.length) flag('install_script', 'info', `npm runs ${scripts.map((s) => s.script).join(', ')} when this version is installed`);
  if (release.deprecated) flag('deprecated_release', 'info', 'the registry marks this version deprecated');
  if (release.age_days != null && release.age_days < NEW_RELEASE_DAYS) flag('new_release', 'info', `this version was published ${release.age_days} ${plural(release.age_days, 'day', 'days')} ago`);
  if (release.package_age_days != null && release.package_age_days < NEW_PACKAGE_DAYS) flag('new_package', 'info', `the package was first published ${release.package_age_days} ${plural(release.package_age_days, 'day', 'days')} ago`);
  const m = view.maint;
  if (m && m.available && ((m.added_since_previous_version || 0) > 0 || (m.removed_since_previous_version || 0) > 0)) flag('maintainer_change', 'info', `the maintainer list differs from the previous version (${m.added_since_previous_version} added, ${m.removed_since_previous_version} removed)`);
  if (m && m.published_by_new_account === true) flag('new_publisher', 'info', 'this version was published by an account that published no earlier version');
  if (!repository.present) flag('repository_missing', 'info', 'the registry lists no repository link');
  return flags.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
}

/**
 * view: { version, latest, isLatest, versionCount, manifest|null, publishedAt, firstPublishedAt, maint, gaps, holding, scripts, deprecated, yanked, distributions, repository, downloads, downloadsNote }
 * -> the `data` object. `sources` are the fetches that were made.
 */
function assemble({ ecosystem, name, view, osv, list, sources, nowMs }) {
  const advisories = osv.advisories;
  const malicious = advisories.some((a) => a.malicious);
  const typo = T.typosquat(name, ecosystem, list);
  const release = {
    version: view.version,
    published_at: view.publishedAt,
    age_days: ageDays(nowMs, view.publishedAt),
    first_published_at: view.firstPublishedAt,
    package_age_days: ageDays(nowMs, view.firstPublishedAt),
    version_count: view.versionCount,
    latest_version: view.latest,
    is_latest: view.isLatest,
    deprecated: view.deprecated,
    ...(ecosystem === 'pypi' ? { yanked: view.yanked, distributions: view.distributions } : {}),
  };
  const flags = buildFlags({ ecosystem, name, version: view.version, advisories, malicious, release: { ...release, yanked: view.yanked }, view, typo, scripts: view.scripts, repository: view.repository });
  const listNote = list ? `a bundled ${list.ranked ? 'list of the most-downloaded' : 'curated list of widely used'} ${ecosystem === 'npm' ? 'npm packages' : 'PyPI projects'}` : 'no bundled list (not checked)';
  return {
    name, ecosystem, version: view.version, found: true,
    advisories,
    advisory_count: osv.total,
    ...(osv.truncated ? { advisories_truncated: true } : {}),
    malicious,
    release,
    maintainers: view.maint,
    install_scripts: ecosystem === 'npm' ? view.scripts : null,
    ...(ecosystem === 'pypi' ? { install_scripts_note: 'PyPI install-time code lives in the source distribution (setup.py) and is not inspected; the release object says whether a source distribution exists and how many wheels' } : {}),
    downloads: view.downloads,
    ...(view.downloads ? {} : { downloads_note: view.downloadsNote }),
    typosquat: typo,
    repository: view.repository,
    flags,
    ...(view.gaps.length ? { data_gaps: view.gaps } : {}),
    sources,
    method: `Advisories: OSV.dev, queried for this exact version, a MAL- id marking a malicious-package advisory. Release, maintainer and script facts: the ${ecosystem === 'npm' ? 'npm registry' : 'PyPI'} document. Typosquat: Damerau-Levenshtein distance 1 or 2, separator and word-order variants, and unscoped copies, against ${listNote}. Flags are factual signals from public records, not a verdict.`,
  };
}

// ---- the fetcher/assembler (I/O) ----
function makeCheck(deps = {}) {
  const d = { ...H.defaultDeps(), ...deps };
  const lists = d.lists || {};
  const listFor = (eco) => (hasOwn(lists, eco) ? lists[eco] : T.loadList(eco));
  const cache = makeCache({ max: d.cacheMax || CACHE_MAX, ttlMs: d.cacheTtlMs || CACHE_TTL_MS, now: d.now });
  const maxInflight = d.maxInflight || envNum('R23_PKGCHECK_MAX_INFLIGHT', 3);
  let inflight = 0;

  function makeCtx() {
    const deadline = d.now() + TOTAL_MS;
    const sources = [];
    const timeLeft = () => { const t = Math.min(H.MAX_TIMEOUT_MS, deadline - d.now()); if (t < 500) throw unavailable('the upstream services did not answer within the time allowed', 30); return t; };
    const record = (source, url, ok, note) => sources.push({ name: source, url, fetched_at: new Date(d.now()).toISOString(), ok, ...(note ? { note: short(note, 120) } : {}) });
    return {
      sources, timeLeft,
      // `usable(res)` -> a problem sentence, or null: a 200 whose body cannot be used is recorded as not ok, like an error status
      async get(source, url, usable) {
        const timeoutMs = timeLeft();
        let res;
        try { res = await d.get(url, { timeoutMs }); } catch (e) { record(source, url, false, e.message); throw Object.assign(new Error(short(e.message)), { oversize: isOversize(e) }); }
        const problem = res.status !== 200 ? `HTTP ${res.status}` : (usable ? usable(res) : null);
        record(source, url, !problem, problem || undefined);
        return res;
      },
      async post(source, url, body) {
        const timeoutMs = timeLeft();
        let res;
        try { res = await d.post(url, body, { timeoutMs }); } catch (e) { record(source, url, false, e.message); throw new Error(short(e.message)); }
        record(source, url, res.status === 200, res.status === 200 ? undefined : `HTTP ${res.status}`);
        return res;
      },
    };
  }

  async function npmView(ctx, req) {
    const { name, version: want } = req;
    let doc = null;
    let failure = null;
    try {
      const r = await ctx.get('npm registry', N.urls.npmDoc(name));
      if (r.status === 404) throw notCovered(`npm has no package named ${name}`);
      if (r.status !== 200) failure = new Error(`npm registry answered HTTP ${r.status}`);
      else { doc = pick(r.body, K.npmDocSelect); if (!isObj(doc)) { doc = null; failure = new Error('npm registry answered with a document that is not JSON'); } }
    } catch (e) { if (e.status === 404) throw e; failure = e; }
    let v;
    let gaps = [];
    if (doc) v = npmFromDocument(doc, want, name);
    else {
      let r;
      try { r = await ctx.get('npm registry (version document)', N.urls.npmVersion(name, want || 'latest')); } catch (e) { throw unavailable(`the npm registry could not answer (${short(e.message, 90)})`, 60); }
      if (r.status === 404) throw notCovered(want ? `npm has no version ${want} of ${name}` : `npm has no package named ${name}`);
      if (r.status !== 200) throw unavailable(`the npm registry answered HTTP ${r.status}`, retryAfterOf(r, 60));
      const m = pick(r.body, K.npmVersionSelect);
      if (!isObj(m) || typeof m.version !== 'string') throw unavailable('the npm registry answered with a document that is not a package version', 60);
      const reason = failure && failure.oversize ? `the full registry document is over the ${READ_CAP_MB} MB read cap` : 'the full registry document could not be read';
      gaps = [{ part: 'release times, version count and maintainer history', reason }];
      v = { version: m.version, latest: want ? null : m.version, isLatest: want ? null : true, versionCount: null, manifest: m, publishedAt: null, firstPublishedAt: null, gaps,
        maint: { available: true, count: maintainerNames(m.maintainers).size, added_since_previous_version: null, removed_since_previous_version: null, published_by_new_account: null, source: 'version document' } };
    }
    const m = v.manifest;
    const desc = typeof m.description === 'string' ? m.description.trim().toLowerCase() : '';
    const repo = repoInfo(m.repository || (isObj(doc) ? doc.repository : null));
    return {
      ...v,
      scripts: installScripts(m),
      deprecated: typeof m.deprecated === 'string' && m.deprecated.length > 0,
      yanked: false,
      holding: /-security$/.test(v.version) && (desc === 'security holding package' || /npm\/security-holder/.test(repo.url || '')),
      repository: repo,
    };
  }

  async function pypiView(ctx, req) {
    const { name, version: want } = req;
    let doc = null;
    let failure = null;
    try {
      const r = await ctx.get('PyPI', N.urls.pypiDoc(name));
      if (r.status === 404) throw notCovered(`PyPI has no project named ${name}`);
      if (r.status !== 200) failure = new Error(`PyPI answered HTTP ${r.status}`);
      else { doc = pick(r.body, K.pypiSelector(want, N.pypiVersionKey)); if (!isObj(doc) || !isObj(doc.info)) { doc = null; failure = new Error('PyPI answered with a document that is not JSON'); } }
    } catch (e) { if (e.status === 404) throw e; failure = e; }
    let version, latest = null, files, versionCount = null, firstPublishedAt = null, info, gaps = [], maint;
    if (doc) {
      latest = typeof doc.info.version === 'string' ? doc.info.version : null;
      const releases = isObj(doc.releases) ? doc.releases : {};
      version = want || latest;
      if (want && !hasOwn(releases, want)) {                         // 2.2.0 asked, 2.2 published: the same PEP 440 version
        const k = N.pypiVersionKey(want);
        version = Object.keys(releases).find((r) => N.pypiVersionKey(r) === k) || want;
      }
      if (!version) throw notCovered(`PyPI lists no release of ${name}`);
      // `urls` holds the files of the latest release with every field; for another release the reader kept the full fields of the one asked for (want)
      const latestFiles = version === latest ? pypiFiles(doc.urls) : [];
      files = latestFiles.length ? latestFiles : (hasOwn(releases, version) ? pypiFiles(releases[version]) : []);
      if (!files.length) throw notCovered(`PyPI has no release ${version} of ${name}`);
      // one pass, no intermediate arrays: a project like numpy lists thousands of files
      let count = 0, first = Infinity;
      for (const key of Object.keys(releases)) {
        const arr = releases[key];
        if (!Array.isArray(arr) || !arr.length) continue;
        count++;
        for (const f of arr) { const t = isObj(f) && typeof f.upload_time_iso_8601 === 'string' ? Date.parse(f.upload_time_iso_8601) : NaN; if (t < first) first = t; }
      }
      versionCount = count || null;
      firstPublishedAt = Number.isFinite(first) ? new Date(first).toISOString() : null;
      info = doc.info;
      maint = pypiOwners(doc);
    } else {
      if (!want) {
        if (failure && failure.oversize) throw notCovered(`the PyPI document for ${name} is over the ${READ_CAP_MB} MB read cap; pass version=<release> to check one release`);
        throw unavailable(`PyPI could not answer (${short(failure && failure.message, 90)})`, 60);
      }
      let r;
      try { r = await ctx.get('PyPI (release document)', N.urls.pypiVersion(name, want)); } catch (e) { throw unavailable(`PyPI could not answer (${short(e.message, 90)})`, 60); }
      if (r.status === 404) throw notCovered(`PyPI has no release ${want} of ${name}`);
      if (r.status !== 200) throw unavailable(`PyPI answered HTTP ${r.status}`, retryAfterOf(r, 60));
      const vd = pick(r.body, K.pypiSelector(want, N.pypiVersionKey));
      if (!isObj(vd) || !isObj(vd.info)) throw unavailable('PyPI answered with a document that is not a release', 60);
      version = want; info = vd.info; files = pypiFiles(vd.urls);
      if (!files.length) throw notCovered(`PyPI has no release ${want} of ${name}`);
      gaps = [{ part: 'first-publish date and version count', reason: failure && failure.oversize ? `the full project document is over the ${READ_CAP_MB} MB read cap` : 'the full project document could not be read' }];
      maint = pypiOwners(vd);
    }
    const rel = pypiRelease(files);
    return {
      version, latest, isLatest: latest ? version === latest : null, versionCount, manifest: null, publishedAt: rel.publishedAt, firstPublishedAt, maint, gaps,
      scripts: null, deprecated: false, yanked: rel.yanked, distributions: rel.distributions, holding: false, repository: pypiRepo(info),
    };
  }

  async function downloadsOf(ctx, req) {
    const npm = req.ecosystem === 'npm';
    const api = npm ? 'the npm downloads API' : 'pypistats';
    try {
      const r = await ctx.get(npm ? 'npm downloads' : 'pypistats', npm ? N.urls.npmDownloads(req.name) : N.urls.pypiStats(req.name), (res) => {
        const j = parseJson(res.body);
        const count = npm ? (isObj(j) ? j.downloads : undefined) : (isObj(j) && isObj(j.data) ? j.data.last_week : undefined);
        if (!Number.isSafeInteger(count) || count < 0) return 'no usable count';
        res.parsed = { j, count };
        return null;
      });
      if (r.status !== 200) return { downloads: null, note: `${api} answered HTTP ${r.status}` };
      if (!r.parsed) return { downloads: null, note: `${api} answered with no usable count` };
      const { j, count } = r.parsed;
      return { downloads: { period: 'last-week', count, ...(npm && validIso(j.start) ? { from: j.start, to: validIso(j.end) } : {}) }, note: null };
    } catch (e) {
      return { downloads: null, note: e && e.status === 503 ? 'the call ran out of time before download counts could be read' : `download counts could not be read (${short(e && e.message, 80)})` };
    }
  }

  async function check(args) {
    const req = N.parseRequest(args);                                  // 400, before any request
    const key = `${req.ecosystem}|${req.name}|${req.version || 'latest'}`;
    const hit = cache.get(key);
    if (hit) return hit;
    if (inflight >= maxInflight) throw unavailable('this tool is handling its maximum number of checks right now', 5);
    inflight++;
    try {
      const ctx = makeCtx();
      const view = await (req.ecosystem === 'npm' ? npmView(ctx, req) : pypiView(ctx, req));
      const [osv, dl] = await Promise.all([
        O.queryOsv((url, body) => ctx.post('OSV.dev', url, body), { ecosystem: req.ecosystem, name: req.name, version: view.version })
          .catch((e) => { throw e && e.status === 503 ? e : unavailable(`OSV.dev could not answer (${short(e && e.message, 90)})`, 60); }),
        downloadsOf(ctx, req),
      ]);
      const out = assemble({ ecosystem: req.ecosystem, name: req.name, view: { ...view, downloads: dl.downloads, downloadsNote: dl.note }, osv, list: listFor(req.ecosystem), sources: ctx.sources, nowMs: d.now() });
      cache.set(key, out);
      return out;
    } finally { inflight--; }
  }

  return { check, cache, inflightCount: () => inflight };
}

// ---- the route entry the lead wires into expansion.js ----
const DESC = 'Use when an agent needs facts about an npm or PyPI package version. Returns OSV advisories, a malicious-package marker, release age, maintainers, install scripts, downloads, name-squat distance, flags. Unknown package 404, upstream down 503: not charged.';
const EXAMPLE_FILE = path.join(__dirname, 'data', 'pkgcheck-example.json');
let exampleCache = null;

function makeEntries(deps) {
  const { check } = makeCheck(deps);
  return [{
    name: 'get_pkg_check', route: 'GET /api/pkg-check', usd: 0.02,
    tags: ['security', 'supply-chain', 'npm', 'pypi', 'osv', 'dependencies', 'vulnerabilities', 'typosquat'],
    desc: DESC,
    schema: {
      name: z.string().describe('package name: an npm name (optionally @scope/name) or a PyPI project name'),
      ecosystem: z.string().describe('npm or pypi'),
      version: z.string().optional().describe('version to check, for example 4.17.21 (default: the latest published version)'),
    },
    title: 'Package check',
    question: 'What do the public registries and OSV.dev report about this version of an npm or PyPI package?',
    // the published (constructed) example: tools/r23/data/pkgcheck-example.json is written by ops/r23-pkgcheck-example.js from the test fixtures and pinned by a test
    get example() {
      if (!exampleCache) exampleCache = JSON.parse(fs.readFileSync(EXAMPLE_FILE, 'utf8'));
      return exampleCache;
    },
    run: async (args) => check(args),
  }];
}

const entries = makeEntries();

module.exports = { entries, makeEntries, makeCheck, assemble, buildFlags, repoInfo, pypiRepo, npmFromDocument, installScripts, makeCache, DESC, EXAMPLE_FILE, CACHE_MAX, CACHE_TTL_MS, TOTAL_MS };
