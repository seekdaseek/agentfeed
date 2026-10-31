// tools/r23/pkg-check-typo.js: how close is a package name to a very commonly installed one? (R23 T5)
//
// The list is a data file (tools/r23/data/pkgcheck-top-<ecosystem>.json, provenance and licence in its _meta), read on first use and kept (one list per ecosystem, a few
// thousand strings: bounded by the file). A name that IS on the list is the popular package itself and is never reported; every other name is compared with every list entry:
//   edit_distance       Damerau-Levenshtein distance 1 or 2 (insert, delete, substitute, swap two neighbouring characters; the unrestricted variant). A distance needs
//                       at least 4 characters on both sides, a distance of 2 at least 8, because on short names a distance of 2 matches half the list.
//   separator_variant   the same name once - _ . are dropped (lodash-es / lodashes / lodash_es), the names differing
//   token_swap          the same words in another order (dateutil-python for python-dateutil), two to five words
//   scope_removed       a scope-less name equal to the name part of a popular scoped package (an unscoped copy of @scope/name), at least 5 characters
// All of these are signals about a NAME. Nothing here says who owns a package or what it contains.
'use strict';
const fs = require('fs');
const path = require('path');
const { pep503 } = require('./pkg-check-names');

// One reusable matrix and one reusable last-row table, so comparing a name with thousands of list entries allocates nothing per pair (a fresh array of arrays per pair made
// every call churn tens of megabytes of short-lived garbage). Package names are ASCII (validated before they get here); a code above 127 is folded onto 127, which can only
// make two different strings look closer, never farther.
const MAX_DIM = 218;                                  // 214-character names + 2 + slack
let matrix = new Int32Array(MAX_DIM * MAX_DIM);
const lastRowOf = new Int32Array(128);
const code = (c) => (c > 127 ? 127 : c);

/** Damerau-Levenshtein distance (unrestricted: a substring may be edited after it was transposed), Lowrance-Wagner. */
function damerauLevenshtein(a, b) {
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  if (la + 2 > MAX_DIM || lb + 2 > MAX_DIM) return Math.max(la, lb);   // longer than any valid name: never reached from the tool, a safe over-estimate
  const w = lb + 2;
  const d = matrix;
  const inf = la + lb;
  d[0] = inf;
  for (let i = 0; i <= la; i++) { d[(i + 1) * w] = inf; d[(i + 1) * w + 1] = i; }
  for (let j = 0; j <= lb; j++) { d[j + 1] = inf; d[w + j + 1] = j; }
  lastRowOf.fill(0);
  for (let i = 1; i <= la; i++) {
    let lastMatchCol = 0;
    const ai = code(a.charCodeAt(i - 1));
    for (let j = 1; j <= lb; j++) {
      const bj = code(b.charCodeAt(j - 1));
      const i1 = lastRowOf[bj];
      const j1 = lastMatchCol;
      let cost = 1;
      if (ai === bj) { cost = 0; lastMatchCol = j; }
      const sub = d[i * w + j] + cost, ins = d[(i + 1) * w + j] + 1, del = d[i * w + j + 1] + 1, tr = d[i1 * w + j1] + (i - i1 - 1) + 1 + (j - j1 - 1);
      d[(i + 1) * w + j + 1] = sub < ins ? (sub < del ? (sub < tr ? sub : tr) : (del < tr ? del : tr)) : (ins < del ? (ins < tr ? ins : tr) : (del < tr ? del : tr));
    }
    lastRowOf[ai] = i;
  }
  return d[(la + 1) * w + lb + 1];
}

// A string within distance 2 of another shares all but 2 of its characters (a substitution changes one, an insertion or deletion one, a swap none): a cheap count of common
// characters rules most of a 4,000-name list out before the full distance is computed.
const histA = new Int32Array(128);
function sharesEnough(a, b, maxDist) {
  histA.fill(0);
  for (let i = 0; i < a.length; i++) histA[code(a.charCodeAt(i))]++;
  let common = 0;
  for (let i = 0; i < b.length; i++) { const c = code(b.charCodeAt(i)); if (histA[c] > 0) { histA[c]--; common++; } }
  return Math.max(a.length, b.length) - common <= maxDist;
}

const tokens = (n) => n.replace(/^@/, '').split(/[-_./]+/).filter(Boolean);
const stripSeps = (n) => n.replace(/[-_.]/g, '');
const bareOf = (n) => (n[0] === '@' && n.includes('/') ? n.slice(n.indexOf('/') + 1) : null);
const push = (m, k, v) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };

/** index a list of names (already lower-case / PEP 503 normalised) for the lookups above */
function makeList(rawNames, { ranked = true, ecosystem = 'npm', meta = null } = {}) {
  // names are compared lower-case (npm still has a few legacy capitalised names) or PEP 503 normalised; the first occurrence keeps its position as the rank
  const names = rawNames.map((n) => (ecosystem === 'pypi' ? pep503(n) : String(n).toLowerCase()));
  const rank = new Map();
  const byStripped = new Map(), byBare = new Map(), byTokens = new Map();
  names.forEach((n, i) => {
    if (rank.has(n)) return;
    rank.set(n, i + 1);
    push(byStripped, stripSeps(n), n);
    const bare = bareOf(n);
    if (bare) push(byBare, bare, n);
    const t = tokens(n);
    if (t.length >= 2 && t.length <= 5) push(byTokens, [...t].sort().join('\u0000'), n);
  });
  return { names, rank, byStripped, byBare, byTokens, ranked, ecosystem, meta, size: rank.size };
}

const lists = new Map();
const DATA_DIR = path.join(__dirname, 'data');
/** the bundled list of an ecosystem, loaded lazily; null when the data file cannot be read (the check then reports checked:false and nothing else fails) */
function loadList(ecosystem, dir = DATA_DIR) {
  const key = `${dir}|${ecosystem}`;
  if (lists.has(key)) return lists.get(key);
  let list = null;
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, `pkgcheck-top-${ecosystem}.json`), 'utf8'));
    if (Array.isArray(doc.names) && doc.names.length) list = makeList(doc.names.map(String), { ranked: !!(doc._meta && doc._meta.ranked), ecosystem, meta: doc._meta || null });
  } catch { /* leave null */ }
  lists.set(key, list);
  return list;
}

const PATTERN_ORDER = { separator_variant: 0, token_swap: 1, scope_removed: 2, edit_distance: 3 };

/**
 * -> { checked, is_top_package, rank, nearest: [{ name, distance, rank, pattern }] } for a (validated) name. `list` is a makeList() result or null.
 * nearest is at most 5 entries, closest first.
 */
function typosquat(name, ecosystem, list) {
  if (!list) return { checked: false, reason: 'the bundled package list could not be read', is_top_package: null, rank: null, nearest: [] };
  const norm = ecosystem === 'pypi' ? pep503(name) : name.toLowerCase();
  if (list.rank.has(norm)) return { checked: true, is_top_package: true, rank: list.ranked ? list.rank.get(norm) : null, nearest: [] };
  const found = new Map();
  const add = (t, pattern) => {
    const distance = damerauLevenshtein(norm, t);
    const prior = found.get(t);
    if (!prior || PATTERN_ORDER[pattern] < PATTERN_ORDER[prior.pattern]) found.set(t, { name: t, distance, rank: list.ranked ? list.rank.get(t) : null, pattern });
  };
  for (const t of list.byStripped.get(stripSeps(norm)) || []) if (t !== norm) add(t, 'separator_variant');
  const tk = tokens(norm);
  if (tk.length >= 2 && tk.length <= 5) for (const t of list.byTokens.get([...tk].sort().join('\u0000')) || []) if (t !== norm && !found.has(t)) add(t, 'token_swap');
  if (norm[0] !== '@' && norm.length >= 5) for (const t of list.byBare.get(norm) || []) if (!found.has(t)) add(t, 'scope_removed');
  for (const t of list.names) {
    if (t === norm || found.has(t) || Math.abs(t.length - norm.length) > 2 || !sharesEnough(norm, t, 2)) continue;
    const d = damerauLevenshtein(norm, t);
    if (d < 1 || d > 2) continue;
    const shortest = Math.min(t.length, norm.length);
    if ((d === 1 && shortest < 4) || (d === 2 && shortest < 8)) continue;
    add(t, 'edit_distance');
  }
  const nearest = [...found.values()]
    .sort((x, y) => x.distance - y.distance || PATTERN_ORDER[x.pattern] - PATTERN_ORDER[y.pattern] || (x.rank ?? 1e9) - (y.rank ?? 1e9) || (x.name < y.name ? -1 : 1))
    .slice(0, 5);
  return { checked: true, is_top_package: false, rank: null, nearest };
}

module.exports = { typosquat, makeList, loadList, damerauLevenshtein, sharesEnough };
