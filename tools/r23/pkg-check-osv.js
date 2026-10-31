// tools/r23/pkg-check-osv.js: the OSV.dev side of /api/pkg-check (R23 T5): one POST /v1/query for the exact version, the answer cut down to a bounded advisory list.
//   - advisories come back already filtered to the version asked for, so a MAL- id in the answer means a malicious-package advisory that covers THAT version
//   - severity: the database's own label when it gives one (GitHub advisories: CRITICAL / HIGH / MODERATE / LOW), else the base score computed from a CVSS v3 vector
//     (CVSS v4 vectors are not scored here: with no label they read "unknown")
//   - every string taken from the upstream record is length-capped; the list is capped at MAX_ADVISORIES, the total is still reported
'use strict';
const { urls, pep503 } = require('./pkg-check-names');

const MAX_ADVISORIES = 50;
const MAX_PAGES = 3;
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };

// ---- CVSS v3.0 / v3.1 base score (FIRST specification formula) ----
const W = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }, AC: { L: 0.77, H: 0.44 }, UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 }, PR_U: { N: 0.85, L: 0.62, H: 0.27 }, PR_C: { N: 0.85, L: 0.68, H: 0.5 },
};
const roundUp1 = (x) => { const i = Math.round(x * 100000); return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10; };
const labelOfScore = (s) => (s >= 9 ? 'critical' : s >= 7 ? 'high' : s >= 4 ? 'medium' : s > 0 ? 'low' : 'none');
/** -> { score, label } for a "CVSS:3.x/AV:../AC:../PR:../UI:../S:../C:../I:../A:.." vector, or null when it is not a complete v3 vector */
function cvss3(vector) {
  if (typeof vector !== 'string' || vector.length > 200 || !/^CVSS:3\.[01]\//.test(vector)) return null;
  const m = {};
  for (const part of vector.split('/').slice(1)) { const [k, v] = part.split(':'); if (k && v) m[k] = v; }
  const changed = m.S === 'C';
  const av = W.AV[m.AV], ac = W.AC[m.AC], ui = W.UI[m.UI], pr = (changed ? W.PR_C : W.PR_U)[m.PR];
  const c = W.CIA[m.C], i = W.CIA[m.I], a = W.CIA[m.A];
  if ([av, ac, ui, pr, c, i, a].some((x) => x === undefined) || (m.S !== 'U' && m.S !== 'C')) return null;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  const expl = 8.22 * av * ac * pr * ui;
  const score = impact <= 0 ? 0 : roundUp1(changed ? Math.min(1.08 * (impact + expl), 10) : Math.min(impact + expl, 10));
  return { score, label: labelOfScore(score) };
}

const cap = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const isoOrNull = (s) => (typeof s === 'string' && s.length <= 40 && !Number.isNaN(Date.parse(s)) ? s : null);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DB_LABEL = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'medium', MEDIUM: 'medium', LOW: 'low' };

function severityOf(v) {
  const fromDb = v.database_specific && typeof v.database_specific.severity === 'string' ? DB_LABEL[v.database_specific.severity.toUpperCase()] : undefined;
  let scored = null;
  if (Array.isArray(v.severity)) for (const s of v.severity) { if (s && s.type === 'CVSS_V3') { scored = cvss3(s.score); if (scored) break; } }
  if (fromDb) return { label: fromDb, score: scored ? scored.score : null, source: 'database_specific' };
  if (scored && scored.label !== 'none') return { label: scored.label, score: scored.score, source: 'cvss_v3' };
  return { label: 'unknown', score: null, source: null };
}

/** the version(s) the record says fix it, from the ranges of the entries that name THIS package only */
function fixedVersions(v, ecosystem, name) {
  const out = new Set();
  const same = (p) => p && p.ecosystem === (ecosystem === 'npm' ? 'npm' : 'PyPI') && (ecosystem === 'npm' ? p.name === name : pep503(String(p.name)) === name);
  for (const a of Array.isArray(v.affected) ? v.affected : []) {
    if (!a || !same(a.package)) continue;
    for (const r of Array.isArray(a.ranges) ? a.ranges : []) for (const e of Array.isArray(r && r.events) ? r.events : []) if (e && typeof e.fixed === 'string') out.add(cap(e.fixed, 64));
  }
  return [...out].slice(0, 10);
}

/** one OSV record -> the advisory object we return, or null for a record without a usable id */
function normalizeVuln(v, ecosystem, name) {
  if (!v || typeof v.id !== 'string' || !ID.test(v.id)) return null;
  const aliases = (Array.isArray(v.aliases) ? v.aliases : []).filter((x) => typeof x === 'string' && ID.test(x)).slice(0, 8);
  const summary = cap(v.summary || (typeof v.details === 'string' ? v.details.split(/\n\s*\n/)[0] : ''), 200);
  const malicious = v.id.startsWith('MAL-') || aliases.some((x) => x.startsWith('MAL-'));
  return { id: v.id, aliases, summary, severity: severityOf(v), published: isoOrNull(v.published), modified: isoOrNull(v.modified), fixed_versions: fixedVersions(v, ecosystem, name), malicious };
}

/** sort order: malicious first, then severity, then id; the list is cut to MAX_ADVISORIES */
function rankAdvisories(list) {
  const sorted = [...list].sort((a, b) => (b.malicious - a.malicious) || (SEVERITY_RANK[b.severity.label] - SEVERITY_RANK[a.severity.label]) || (a.id < b.id ? -1 : 1));
  return { advisories: sorted.slice(0, MAX_ADVISORIES), total: sorted.length };
}

/**
 * Ask OSV which advisories affect `name`@`version`. `post(url, bodyObject) -> { status, body: Buffer }` is supplied by the caller (it is the guarded POST).
 * Throws a plain Error (message says what failed) for anything but a clean 200 with JSON, so the caller turns it into the 503 "Not charged" refusal.
 * -> { advisories, total, pages, truncated }
 */
async function queryOsv(post, { ecosystem, name, version }) {
  const pkg = { name, ecosystem: ecosystem === 'npm' ? 'npm' : 'PyPI' };
  const all = [];
  let token;
  let pages = 0;
  for (; pages < MAX_PAGES;) {
    const res = await post(urls.osv(), { version, package: pkg, ...(token ? { page_token: token } : {}) });
    pages++;
    if (res.status !== 200) throw new Error(`OSV answered HTTP ${res.status}`);
    let j;
    try { j = JSON.parse(res.body.toString('utf8')); } catch { throw new Error('OSV answered with a document that is not JSON'); }
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('OSV answered with an unexpected document');
    if (j.vulns != null && !Array.isArray(j.vulns)) throw new Error('OSV answered with an unexpected vulns field');
    for (const v of j.vulns || []) { const n = normalizeVuln(v, ecosystem, name); if (n) all.push(n); }
    token = typeof j.next_page_token === 'string' && j.next_page_token.length <= 512 ? j.next_page_token : null;
    if (!token) break;
  }
  const ranked = rankAdvisories(all);
  return { ...ranked, pages, truncated: Boolean(token) || ranked.total > ranked.advisories.length };
}

module.exports = { queryOsv, normalizeVuln, cvss3, severityOf, rankAdvisories, MAX_ADVISORIES, MAX_PAGES, SEVERITY_RANK };
