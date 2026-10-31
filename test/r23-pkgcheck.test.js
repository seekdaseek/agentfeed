// test/r23-pkgcheck.test.js: GET /api/pkg-check (get_pkg_check, R23 T5) over a fake upstream world: no network, no server.
// Every check the tool relies on has a negative control in this file (a test that would pass if the check were missing is not a test of the check):
//   name validation      the same hostile strings built into a URL the NAIVE way escape the host (so the tests discriminate); a pattern that rejected everything fails the positive list
//   typosquat            the popular package itself is not flagged; the same query against a list without it IS flagged
//   OSV / CVSS           scorer pinned to published base scores; fixed versions come from the queried package only
//   failure semantics    404 / 503 / 400 each tested with the upstream calls counted (a 400 makes none; nothing failing is cached)
// The real safe-fetch refusals are in r23-pkgcheck-guard.test.js; the paywall and settlement in r23-pkgcheck-real-server.test.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const W = require('./fixtures/r23/pkgcheck/world');
const N = require('../tools/r23/pkg-check-names');
const T = require('../tools/r23/pkg-check-typo');
const O = require('../tools/r23/pkg-check-osv');
const P = require('../tools/r23/pkg-check');
const { buildExample } = require('../ops/r23-pkgcheck-example');

const TEXTS = [];                                   // every customer-visible string produced by these tests, scanned at the end
const note = (...xs) => { for (const x of xs) TEXTS.push(typeof x === 'string' ? x : JSON.stringify(x)); };
const make = (w = W.makeWorld(), extra = {}) => P.makeCheck({ ...w.deps, lists: W.lists(), ...extra });
const run = async (args, w = W.makeWorld(), extra = {}) => { const r = await make(w, extra).check(args); note(r); return r; };
const refusal = async (promise) => { try { await promise; } catch (e) { note(e.message); return e; } assert.fail('expected a refusal'); };
const npm = (name, version) => ({ name, ecosystem: 'npm', ...(version ? { version } : {}) });
const pypi = (name, version) => ({ name, ecosystem: 'pypi', ...(version ? { version } : {}) });
const ids = (r) => r.flags.map((f) => f.id);
const flagOf = (r, id) => r.flags.find((f) => f.id === id);
const bodyOf = (o) => ({ status: 200, body: o });
// a 400: lib/tool.js answers kind 'bad_request' with no status as a 400; a not-covered refusal carries the kind too (for the audit row) but also a status 404
const is400 = (e) => e.kind === 'bad_request' && e.status == null;

// ---------------------------------------------------------------- names
const BAD_NPM = ['', '..', '../etc/passwd', 'a/b', '@a/b/c', '@a', '@/b', '@a/', 'a b', 'a%2e%2e', 'a\u0000b', 'a\nb', '\\a', 'a?x=1', 'a#x', '.hidden', '_x', 'a..b', 'x'.repeat(215), 'http://x', 'a:b', 'é', '@a@b/c', 'a/../b', 'a\tb', '-lead'];
const GOOD_NPM = ['lodash', '@scope/pkg', 'Foo.bar', 'a-b_c~d', 'a', '@a-b/c.d', 'JSONStream', 'x'.repeat(214)];

test('names: every hostile npm name is a 400 before any request; the valid list passes (positive control)', async () => {
  for (const name of GOOD_NPM) assert.equal(N.parseRequest({ name, ecosystem: 'npm' }).name, name, `valid name rejected: ${name}`);
  for (const name of BAD_NPM) {
    const w = W.makeWorld();
    const e = await refusal(make(w).check({ name, ecosystem: 'npm' }));
    assert.ok(is400(e), `name ${JSON.stringify(name)}`);
    assert.equal(w.calls.length, 0, `no upstream call for ${JSON.stringify(name)}`);
  }
  for (const v of [['a', 'b'], { a: 1 }, 5, true]) { const e = await refusal(make().check({ name: v, ecosystem: 'npm' })); assert.ok(is400(e)); }
});

test('names: PyPI names, ecosystem and version are checked the same way', async () => {
  for (const name of ['Foo_Bar.baz', 'a', 'x9', 'A-B']) assert.ok(N.parseRequest({ name, ecosystem: 'pypi' }).name);
  assert.equal(N.parseRequest({ name: 'Foo_Bar.baz', ecosystem: 'PyPI' }).name, 'foo-bar-baz', 'PEP 503 normalised');
  for (const name of ['', '-x', 'x-', '../x', 'a/b', 'a b', '@a/b', 'a\u0000', 'x'.repeat(215), '.x', 'a%2fb']) {
    const e = await refusal(make().check({ name, ecosystem: 'pypi' })); assert.ok(is400(e), name);
  }
  for (const eco of [undefined, '', 'cargo', 'Maven', ['npm'], { a: 1 }]) { const e = await refusal(make().check({ name: 'lodash', ecosystem: eco })); assert.ok(is400(e)); }
  for (const v of ['1.2', 'v1.2.3', '1.2.3/../x', '1.2.3 ', '1.2.3\n', '1.2.3;x', '1.2.3-', 'x'.repeat(101), ['1.2.3'], '1.2.3+']) {
    const e = await refusal(make().check({ name: 'lodash', ecosystem: 'npm', version: v })); assert.ok(is400(e), JSON.stringify(v));
  }
  for (const v of ['1.2.3', '0.0.1-security', '1.0.0-beta.1+build.5']) assert.equal(N.parseRequest({ name: 'lodash', ecosystem: 'npm', version: v }).version, v);
  for (const v of ['1.0', '2!1.0.post1', '1.0+local.1', '1.0rc1']) assert.equal(N.parseRequest({ name: 'x', ecosystem: 'pypi', version: v }).version, v);
  assert.equal(N.parseRequest({ name: 'lodash', ecosystem: 'npm', version: 'latest' }).version, null);
  assert.equal(N.parseRequest({ name: 'lodash', ecosystem: 'npm', version: '' }).version, null);
});

test('names: URLs are built from a fixed host with every piece encoded; a hostile string cannot move the host or the path (and the naive builder does)', () => {
  const hostile = ['a/../b', 'a?x=1', 'a#frag', 'a b', '..', '%2e%2e', 'a\\b'];
  const naive = (n) => `https://registry.npmjs.org/${n}`;
  for (const h of hostile) {
    const u = new URL(N.urls.npmDoc(h));
    assert.equal(u.hostname, 'registry.npmjs.org'); assert.equal(u.search, ''); assert.equal(u.hash, '');
    assert.ok(!/\/\.\.?(\/|$)/.test(u.pathname), `${h} -> ${u.pathname}`);
    assert.equal(u.pathname.split('/').length, 2, 'one path segment');
    N.assertAllowedUrl(N.urls.pypiDoc(h)); N.assertAllowedUrl(N.urls.pypiStats(h)); N.assertAllowedUrl(N.urls.npmDownloads(h)); N.assertAllowedUrl(N.urls.npmVersion(h, '1.0.0')); N.assertAllowedUrl(N.urls.pypiVersion(h, '1.0'));
  }
  // negative control: the naive builder is what the encoding prevents
  assert.notEqual(new URL(naive('a?x=1')).search, '', 'naive builder lets a query through');
  assert.ok(/\/\.\.\//.test(naive('a/../b')) || new URL(naive('a/../b')).pathname === '/b', 'naive builder lets a path trick through');
  assert.equal(N.urls.npmDoc('@example-scope/widget-kit'), 'https://registry.npmjs.org/@example-scope%2Fwidget-kit');
  assert.equal(N.urls.npmDownloads('@example-scope/widget-kit'), 'https://api.npmjs.org/downloads/point/last-week/@example-scope%2Fwidget-kit');
  assert.equal(N.urls.pypiDoc('foo-bar'), 'https://pypi.org/pypi/foo-bar/json');
  assert.equal(N.urls.pypiVersion('foo-bar', '1.0+local'), 'https://pypi.org/pypi/foo-bar/1.0%2Blocal/json');
  assert.equal(N.urls.osv(), 'https://api.osv.dev/v1/query');
  for (const bad of ['http://registry.npmjs.org/x', 'https://evil.example/x', 'https://registry.npmjs.org:8443/x', 'https://u:p@registry.npmjs.org/x', 'https://registry.npmjs.org/x?y=1', 'https://registry.npmjs.org/x#y', 'https://registry.npmjs.org.evil.example/x', 'not a url'])
    assert.throws(() => N.assertAllowedUrl(bad), bad);
});

test('names: through the tool, a scoped npm name reaches the registry in the encoded form; the URL set is only the five fixed hosts', async () => {
  const w = W.makeWorld({ extraGet: { 'https://registry.npmjs.org/@example-scope%2Fwidget-kit': 'npm-widget.json' } });
  await run(npm('@example-scope/widget-kit'), w);
  assert.equal(w.calls[0].url, 'https://registry.npmjs.org/@example-scope%2Fwidget-kit');
  const w2 = W.makeWorld();
  await run(pypi('Example_PyLib'), w2);
  assert.equal(w2.calls[0].url, 'https://pypi.org/pypi/example-pylib/json');
  for (const c of [...w.calls, ...w2.calls]) N.assertAllowedUrl(c.url);
});

// ---------------------------------------------------------------- typosquat
test('typosquat: Damerau-Levenshtein is the unrestricted variant, pinned to known values', () => {
  for (const [a, b, d] of [['lodash', 'loadsh', 1], ['ca', 'abc', 2], ['kitten', 'sitting', 3], ['', 'abc', 3], ['ab', 'ba', 1], ['abc', 'abc', 0], ['react', 'preact', 1], ['colorama', 'colourama', 1]]) assert.equal(T.damerauLevenshtein(a, b), d, `${a} ${b}`);
});

test('typosquat: the popular package itself is not flagged; remove it from the list and the same query IS flagged (negative control)', () => {
  const withIt = T.makeList(['react', 'preact', 'lodash'], { ranked: true });
  const without = T.makeList(['preact', 'lodash'], { ranked: true });
  const self = T.typosquat('react', 'npm', withIt);
  assert.deepEqual(self, { checked: true, is_top_package: true, rank: 1, nearest: [] });
  assert.equal(T.typosquat('preact', 'npm', withIt).nearest.length, 0, 'a popular neighbour is itself popular');
  const flagged = T.typosquat('react', 'npm', without);
  assert.equal(flagged.is_top_package, false);
  assert.deepEqual(flagged.nearest.map((n) => [n.name, n.distance, n.pattern]), [['preact', 1, 'edit_distance']], 'the check that stops this flag is list membership');
  assert.equal(T.typosquat('REACT', 'npm', withIt).is_top_package, true, 'case does not matter for npm');
});

test('typosquat: edit distance 1 and 2, with the length floors; patterns; PyPI normalisation; unranked lists', () => {
  const { npm: nl, pypi: pl } = W.lists();
  const near = (name, eco = 'npm', l = eco === 'npm' ? nl : pl) => T.typosquat(name, eco, l).nearest.map((n) => `${n.name}:${n.distance}:${n.pattern}`);
  assert.deepEqual(near('lodahs'), ['lodash:1:edit_distance']);                  // swapped letters
  assert.deepEqual(near('lodsh'), ['lodash:1:edit_distance']);                   // dropped letter
  assert.deepEqual(near('reactt'), ['react:1:edit_distance']);                   // doubled letter
  assert.deepEqual(near('abcdefgh-xx'), ['abcdefgh-ui:2:edit_distance'], 'distance 2 needs 8+ characters');
  assert.deepEqual(near('lodaxx'), [], 'distance 2 on a 6-character name is not reported');
  assert.deepEqual(near('rea'), [], 'distance 1 needs 4+ characters on both sides');
  assert.deepEqual(near('lodashes'), ['lodash-es:1:separator_variant']);
  assert.deepEqual(near('lodash_es'), ['lodash-es:1:separator_variant']);
  assert.deepEqual(near('lodash.es'), ['lodash-es:1:separator_variant']);
  assert.deepEqual(near('style-python'), ['python-style:10:token_swap']);
  assert.deepEqual(near('core-utils'), ['@example-scope/core-utils:15:scope_removed']);
  assert.deepEqual(near('core'), [], 'a scope-less name under 5 characters is left alone');
  assert.deepEqual(near('colourama', 'pypi'), ['colorama:1:edit_distance']);
  assert.deepEqual(near('jeIlyfish', 'pypi'), ['jellyfish:1:edit_distance'], 'normalised first (jeilyfish)');
  assert.deepEqual(near('pythondateutil', 'pypi'), ['python-dateutil:1:separator_variant']);
  assert.deepEqual(near('dateutil-python', 'pypi'), ['python-dateutil:0:token_swap'.replace(':0:', ':' + T.damerauLevenshtein('dateutil-python', 'python-dateutil') + ':')]);
  assert.equal(T.typosquat('python_dateutil', 'pypi', pl).is_top_package, true, 'PEP 503: the same project');
  assert.equal(T.typosquat('requests', 'pypi', pl).rank, null, 'an unranked list reports no rank');
  assert.equal(T.typosquat('lodash', 'npm', nl).rank, 4);
  assert.deepEqual(T.typosquat('zzzzzzzz', 'npm', nl).nearest, []);
  assert.deepEqual(T.typosquat('lodash', 'npm', null), { checked: false, reason: 'the bundled package list could not be read', is_top_package: null, rank: null, nearest: [] });
});

test('typosquat: the bundled data files load, stay inside the size limits, and carry their provenance', () => {
  for (const eco of ['npm', 'pypi']) {
    const file = path.join(__dirname, '..', 'tools', 'r23', 'data', `pkgcheck-top-${eco}.json`);
    assert.ok(fs.statSync(file).size < 150 * 1024, `${eco} list under 150 KB`);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(doc.names.length > 100 && doc.names.length < 5000, `${eco}: ${doc.names.length} names`);
    assert.equal(doc._meta.count, doc.names.length);
    assert.equal(new Set(doc.names).size, doc.names.length, 'no duplicates');
    for (const k of ['source', 'retrieved', 'licence', 'selection', 'ranked', 'caveat']) assert.ok(k in doc._meta, `${eco} _meta.${k}`);
    const l = T.loadList(eco);
    assert.ok(l && l.size === doc.names.length);
  }
  const npmMeta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'r23', 'data', 'pkgcheck-top-npm.json'), 'utf8'))._meta;
  assert.equal(npmMeta.licence, 'MIT'); assert.match(npmMeta.commit, /^[0-9a-f]{40}$/); assert.match(npmMeta.licence_text, /^\(The MIT License\)[\s\S]*Permission is hereby granted/);
  assert.equal(T.loadList('nosuch'), null, 'a missing data file is a null list, not a crash');
  assert.equal(T.loadList('npm', '/nonexistent-dir-r23'), null);
  assert.equal(T.loadList('npm').rank.get('semver'), 1);
});

// ---------------------------------------------------------------- OSV
test('osv: the CVSS v3 scorer matches published base scores', () => {
  for (const [v, score, label] of [['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8, 'critical'], ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L', 5.3, 'medium'], ['CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H', 8.8, 'high'],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', 10, 'critical'], ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H', 7.5, 'high'], ['CVSS:3.0/AV:L/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H', 7.8, 'high'], ['CVSS:3.1/AV:P/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N', 1.6, 'low']]) {
    assert.deepEqual(O.cvss3(v), { score, label }, v);
  }
  for (const v of ['CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N', 'CVSS:3.1/AV:N/AC:L', 'garbage', '', null, 5, 'CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 'CVSS:3.1/' + 'A:N/'.repeat(100)]) assert.equal(O.cvss3(v), null, String(v));
});

test('osv: severity is the database label when it has one, else the computed score, else unknown; fixed versions come from the queried package only', () => {
  const rec = (extra) => ({ id: 'GHSA-xxxx-yyyy-zzzz', summary: 's', affected: [], ...extra });
  assert.deepEqual(O.severityOf(rec({ database_specific: { severity: 'MODERATE' }, severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] })), { label: 'medium', score: 9.8, source: 'database_specific' });
  assert.deepEqual(O.severityOf(rec({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] })), { label: 'critical', score: 9.8, source: 'cvss_v3' });
  assert.deepEqual(O.severityOf(rec({ severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N' }] })), { label: 'unknown', score: null, source: null });
  assert.deepEqual(O.severityOf(rec({})), { label: 'unknown', score: null, source: null });
  const aff = [
    { package: { name: 'left-pad', ecosystem: 'npm' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '1.3.1' }] }] },
    { package: { name: 'other', ecosystem: 'npm' }, ranges: [{ events: [{ fixed: '9.9.9' }] }] },
    { package: { name: 'left-pad', ecosystem: 'PyPI' }, ranges: [{ events: [{ fixed: '8.8.8' }] }] },
  ];
  assert.deepEqual(O.normalizeVuln(rec({ affected: aff }), 'npm', 'left-pad').fixed_versions, ['1.3.1']);
  assert.deepEqual(O.normalizeVuln(rec({ affected: [{ package: { name: 'Foo_Bar', ecosystem: 'PyPI' }, ranges: [{ events: [{ fixed: '2.0' }] }] }] }), 'pypi', 'foo-bar').fixed_versions, ['2.0'], 'PyPI names compare normalised');
});

test('osv: MAL- ids mark malicious (also via an alias); odd records are skipped; every string is capped; the list is capped and sorted', () => {
  assert.equal(O.normalizeVuln({ id: 'MAL-2099-1' }, 'npm', 'x').malicious, true);
  assert.equal(O.normalizeVuln({ id: 'GHSA-aaaa', aliases: ['MAL-2099-2'] }, 'npm', 'x').malicious, true);
  assert.equal(O.normalizeVuln({ id: 'GHSA-aaaa', aliases: ['CVE-2099-1'] }, 'npm', 'x').malicious, false);
  for (const bad of [null, {}, { id: 5 }, { id: 'has space' }, { id: '../x' }, { id: 'x'.repeat(100) }]) assert.equal(O.normalizeVuln(bad, 'npm', 'x'), null);
  const big = O.normalizeVuln({ id: 'GHSA-big', summary: 'y'.repeat(5000), aliases: Array.from({ length: 50 }, (_, i) => `CVE-2099-${i}`), published: 'not a date', modified: '2026-01-01T00:00:00Z' }, 'npm', 'x');
  assert.equal(big.summary.length, 200); assert.equal(big.aliases.length, 8); assert.equal(big.published, null); assert.equal(big.modified, '2026-01-01T00:00:00Z');
  assert.equal(O.normalizeVuln({ id: 'GHSA-d', details: 'first paragraph\n\nsecond' }, 'npm', 'x').summary, 'first paragraph');
  const many = Array.from({ length: 80 }, (_, i) => O.normalizeVuln({ id: `GHSA-${String(i).padStart(4, '0')}`, database_specific: { severity: i % 2 ? 'LOW' : 'HIGH' } }, 'npm', 'x'));
  many.push(O.normalizeVuln({ id: 'MAL-2099-9' }, 'npm', 'x'));
  const r = O.rankAdvisories(many);
  assert.equal(r.advisories.length, O.MAX_ADVISORIES); assert.equal(r.total, 81);
  assert.equal(r.advisories[0].id, 'MAL-2099-9', 'malicious first'); assert.equal(r.advisories[1].severity.label, 'high');
});

test('osv: paging follows next_page_token up to 3 pages; a non-200, non-JSON or malformed answer throws', async () => {
  const page = (n, token) => ({ status: 200, body: Buffer.from(JSON.stringify({ vulns: [{ id: `GHSA-p${n}` }], ...(token ? { next_page_token: token } : {}) })) });
  const seen = [];
  const post = async (url, body) => { seen.push(body.page_token || null); const n = seen.length; return page(n, n < 5 ? `t${n}` : null); };
  const r = await O.queryOsv(post, { ecosystem: 'npm', name: 'x', version: '1.0.0' });
  assert.deepEqual(seen, [null, 't1', 't2']); assert.equal(r.pages, 3); assert.equal(r.truncated, true); assert.equal(r.total, 3);
  const one = await O.queryOsv(async () => ({ status: 200, body: Buffer.from('{}') }), { ecosystem: 'pypi', name: 'x', version: '1' });
  assert.deepEqual([one.total, one.truncated, one.pages], [0, false, 1]);
  for (const res of [{ status: 500, body: Buffer.from('{}') }, { status: 200, body: Buffer.from('<html>') }, { status: 200, body: Buffer.from('[]') }, { status: 200, body: Buffer.from('{"vulns":"x"}') }, { status: 429, body: Buffer.from('{}') }])
    await assert.rejects(O.queryOsv(async () => res, { ecosystem: 'npm', name: 'x', version: '1' }));
});

// ---------------------------------------------------------------- the check over a fake world
test('npm: the latest version of a package, end to end (shape, OSV request, flags, sources, no maintainer handles)', async () => {
  const w = W.makeWorld();
  const r = await run(npm('example-widget-kit'), w);
  assert.deepEqual(w.calls.map((c) => `${c.method} ${c.url}`).sort(), ['GET https://api.npmjs.org/downloads/point/last-week/example-widget-kit', 'GET https://registry.npmjs.org/example-widget-kit', 'POST https://api.osv.dev/v1/query']);
  assert.deepEqual(w.calls.find((c) => c.method === 'POST').body, { version: '2.0.0', package: { name: 'example-widget-kit', ecosystem: 'npm' } });
  assert.deepEqual(Object.keys(r).slice(0, 4), ['name', 'ecosystem', 'version', 'found']);
  assert.equal(r.found, true); assert.equal(r.version, '2.0.0'); assert.equal(r.malicious, false); assert.equal(r.advisory_count, 1);
  assert.equal(r.advisories[0].id, 'GHSA-aaaa-bbbb-cccc'); assert.deepEqual(r.advisories[0].fixed_versions, ['2.0.1']); assert.equal(r.advisories[0].severity.label, 'high');
  assert.deepEqual(r.release, { version: '2.0.0', published_at: '2026-10-29T12:00:00.000Z', age_days: 2, first_published_at: '2026-04-01T00:00:00.000Z', package_age_days: 213, version_count: 3, latest_version: '2.0.0', is_latest: true, deprecated: false });
  assert.deepEqual(r.maintainers, { available: true, count: 2, added_since_previous_version: 1, removed_since_previous_version: 0, published_by_new_account: true, source: 'registry document' });
  assert.deepEqual(r.install_scripts, [{ script: 'postinstall', command: 'node setup.js' }]);
  assert.deepEqual(r.downloads, { period: 'last-week', count: 123456, from: '2026-10-24', to: '2026-10-30' });
  assert.deepEqual(r.repository, { url: 'https://github.com/example-org/widget-kit', present: true, host: 'github.com', recognized_host: true });
  assert.deepEqual(ids(r), ['known_vulnerability', 'typosquat_candidate', 'install_script', 'new_release', 'maintainer_change', 'new_publisher']);
  assert.equal(flagOf(r, 'known_vulnerability').severity, 'error'); assert.equal(flagOf(r, 'typosquat_candidate').severity, 'warn');
  assert.deepEqual(r.sources.map((s) => [s.name, s.ok]), [['npm registry', true], ['OSV.dev', true], ['npm downloads', true]]);
  for (const s of r.sources) { assert.match(s.fetched_at, /^2026-10-31T12:00:00/); N.assertAllowedUrl(s.url); }
  assert.ok(!('data_gaps' in r)); assert.ok(!('downloads_note' in r));
  const text = JSON.stringify(r);
  for (const handle of ['maint-one', 'maint-two', 'example.invalid']) assert.ok(!text.includes(handle), `${handle} must not be echoed`);
  assert.ok(W.read('npm-widget.json').toString().includes('maint-one'), 'control: the fixture does carry the handle');
});

test('npm: an older version is judged on its own (OSV asked for that version; no install script, no maintainer change)', async () => {
  const w = W.makeWorld();
  const r = await run(npm('example-widget-kit', '1.1.0'), w);
  assert.equal(w.calls.find((c) => c.method === 'POST').body.version, '1.1.0');
  assert.equal(r.version, '1.1.0'); assert.equal(r.release.is_latest, false); assert.equal(r.advisory_count, 0); assert.deepEqual(r.install_scripts, []);
  assert.deepEqual(r.maintainers, { available: true, count: 2, added_since_previous_version: 0, removed_since_previous_version: 0, published_by_new_account: false, source: 'registry document' });
  assert.ok(!ids(r).includes('known_vulnerability') && !ids(r).includes('install_script') && !ids(r).includes('new_release'));
  assert.equal(r.release.age_days, 138);
  const first = await run(npm('example-widget-kit', '1.0.0'));
  assert.deepEqual([first.maintainers.added_since_previous_version, first.maintainers.published_by_new_account], [null, null], 'the first version has no previous one');
});

test('npm: a MAL- advisory marks the exact version malicious and is an error flag; install hooks are listed', async () => {
  const r = await run(npm('example-bad-widget'));
  assert.equal(r.malicious, true); assert.equal(r.advisories[0].id, 'MAL-2099-0001'); assert.equal(r.advisories[0].malicious, true);
  assert.deepEqual(flagOf(r, 'malicious_package'), { id: 'malicious_package', severity: 'error', detail: 'OSV lists MAL-2099-0001 (a malicious-package advisory) for example-bad-widget@1.0.0' });
  assert.deepEqual(r.install_scripts.map((s) => s.script), ['preinstall', 'install']);
  assert.equal(r.flags[0].id, 'malicious_package', 'errors sort first');
  assert.ok(!ids(r).includes('known_vulnerability'), 'a MAL record is not also counted as a vulnerability');
  assert.ok(!('repository' in r) || r.repository.present === false);
  assert.ok(ids(r).includes('repository_missing') && ids(r).includes('new_package'));
  // negative control: the same package with OSV returning nothing is not malicious (the marker comes from OSV only)
  const quiet = await run(npm('example-bad-widget'), W.makeWorld({ osvOverride: () => bodyOf({}) }));
  assert.equal(quiet.malicious, false); assert.ok(!ids(quiet).includes('malicious_package'));
});

test('npm: severity decides the vulnerability flag level (high and critical are errors; medium, low and unknown are warnings)', async () => {
  for (const [label, sev] of [['HIGH', 'error'], ['CRITICAL', 'error'], ['MODERATE', 'warn'], ['LOW', 'warn'], [null, 'warn']]) {
    const w = W.makeWorld({ osvOverride: () => bodyOf({ vulns: [{ id: 'GHSA-sevt-test-0000', database_specific: label ? { severity: label } : {} }] }) });
    const r = await run(npm('example-widget-kit'), w);
    assert.equal(flagOf(r, 'known_vulnerability').severity, sev, String(label));
  }
});

test('npm: the registry security holding package is flagged; the same package without the markers is not (negative control)', async () => {
  const r = await run(npm('example-holder'));
  assert.equal(flagOf(r, 'registry_security_holding_package').severity, 'warn');
  const doc = W.json('npm-holding.json');
  const v = doc.versions['0.0.1-security'];
  v.description = 'a real description'; v.repository = { url: 'git+https://github.com/example-org/other.git' }; doc.repository = v.repository;
  const r2 = await run(npm('example-holder'), W.makeWorld({ getOverrides: { 'https://registry.npmjs.org/example-holder': bodyOf(doc) } }));
  assert.ok(!ids(r2).includes('registry_security_holding_package'));
});

test('npm: each remaining flag fires on its own condition and not otherwise', async () => {
  const doc = W.json('npm-widget.json');
  const via = async (mutate, version) => { const d = W.clone(doc); mutate(d); return run(npm('example-widget-kit', version), W.makeWorld({ getOverrides: { 'https://registry.npmjs.org/example-widget-kit': bodyOf(d) } })); };
  const base = await via(() => {}, '1.1.0');
  assert.deepEqual(ids(base).filter((i) => i !== 'typosquat_candidate'), [], 'quiet version: no flags');
  assert.ok(ids(await via((d) => { d.versions['1.1.0'].deprecated = 'use 2.x'; }, '1.1.0')).includes('deprecated_release'));
  assert.ok(!ids(base).includes('deprecated_release'));
  assert.ok(ids(await via((d) => { delete d.repository; delete d.versions['1.1.0'].repository; }, '1.1.0')).includes('repository_missing'));
  assert.ok(ids(await via((d) => { d.versions['1.1.0'].repository = 'https://example.invalid/r.git'; }, '1.1.0')).every((i) => i !== 'repository_missing'), 'an unrecognised host still counts as a repository link');
  const odd = await via((d) => { d.versions['1.1.0'].repository = 'https://example.invalid/r.git'; }, '1.1.0');
  assert.deepEqual([odd.repository.present, odd.repository.recognized_host, odd.repository.host], [true, false, 'example.invalid']);
  const fresh = await via((d) => { d.time.created = '2026-10-20T00:00:00.000Z'; }, '1.1.0');
  assert.ok(ids(fresh).includes('new_package'), 'first publish 11 days ago');
  const removed = await via((d) => { d.versions['2.0.0'].maintainers = [{ name: 'maint-two' }]; }, '2.0.0');
  assert.deepEqual([removed.maintainers.added_since_previous_version, removed.maintainers.removed_since_previous_version], [1, 1]);
  const gyp = await via((d) => { d.versions['1.1.0'].gypfile = true; }, '1.1.0');
  assert.deepEqual(gyp.install_scripts, [{ script: 'install', command: 'node-gyp rebuild (implicit: the package ships a binding.gyp)', implicit: true }]);
  const explicit = await via((d) => { d.versions['1.1.0'].gypfile = true; d.versions['1.1.0'].scripts.install = 'node build.js'; }, '1.1.0');
  assert.deepEqual(explicit.install_scripts, [{ script: 'install', command: 'node build.js' }]);
  const same = await via((d) => { d.versions['2.0.0']._npmUser = { name: 'maint-one' }; }, '2.0.0');
  assert.equal(same.maintainers.published_by_new_account, false); assert.ok(!ids(same).includes('new_publisher'));
});

test('npm: values taken from the registry are capped (script text, repository link, advisory text) and credentials in a repository URL are dropped', async () => {
  const doc = W.json('npm-widget.json');
  doc.versions['2.0.0'].scripts.postinstall = 'x'.repeat(5000);
  doc.versions['2.0.0'].repository = { url: 'git+https://user:secret-token@github.com/example-org/widget-kit.git#main' };
  const w = W.makeWorld({ getOverrides: { 'https://registry.npmjs.org/example-widget-kit': bodyOf(doc) },
    osvOverride: () => bodyOf({ vulns: Array.from({ length: 120 }, (_, i) => ({ id: `GHSA-cap-${String(i).padStart(4, '0')}`, summary: 'z'.repeat(1000), database_specific: { severity: 'LOW' } })) }) });
  const r = await run(npm('example-widget-kit'), w);
  assert.equal(r.install_scripts[0].command.length, 200);
  assert.equal(r.repository.url, 'https://github.com/example-org/widget-kit'); assert.ok(!JSON.stringify(r).includes('secret-token'));
  assert.equal(r.advisories.length, 50); assert.equal(r.advisory_count, 120); assert.equal(r.advisories_truncated, true);
  assert.ok(r.advisories.every((a) => a.summary.length === 200));
});

test('PyPI: a project, end to end (install scripts not inspected, owner count without handles, distributions, pypistats)', async () => {
  const w = W.makeWorld();
  const r = await run(pypi('example-pylib'), w);
  assert.deepEqual(w.calls.map((c) => `${c.method} ${c.url}`).sort(), ['GET https://pypi.org/pypi/example-pylib/json', 'GET https://pypistats.org/api/packages/example-pylib/recent', 'POST https://api.osv.dev/v1/query']);
  assert.deepEqual(w.calls.find((c) => c.method === 'POST').body, { version: '1.2.0', package: { name: 'example-pylib', ecosystem: 'PyPI' } });
  assert.equal(r.install_scripts, null); assert.match(r.install_scripts_note, /not inspected/);
  assert.deepEqual(r.release, { version: '1.2.0', published_at: '2026-10-01T08:00:00.000Z', age_days: 30, first_published_at: '2026-03-01T08:00:00.000Z', package_age_days: 244, version_count: 4, latest_version: '1.2.0', is_latest: true, deprecated: false, yanked: false, distributions: { sdist: true, wheels: 2 } });
  assert.deepEqual(r.maintainers, { available: true, count: 2, organization_owned: false, added_since_previous_version: null, removed_since_previous_version: null, published_by_new_account: null, source: 'PyPI ownership roles (no history is exposed)' });
  assert.deepEqual(r.downloads, { period: 'last-week', count: 7000 });
  assert.deepEqual(r.repository, { url: 'https://github.com/example-org/pylib', present: true, host: 'github.com', recognized_host: true });
  assert.deepEqual(ids(r), []);
  assert.ok(!JSON.stringify(r).includes('owner-one'));
  const old = await run(pypi('example-pylib', '1.1.0'));
  assert.deepEqual(old.release.distributions, { sdist: false, wheels: 1 }); assert.equal(old.release.is_latest, false);
});

test('PyPI: a yanked release is flagged; a missing owners block and a missing repository link are reported as such', async () => {
  const y = await run(pypi('example-pylib', '0.9.0'));
  assert.equal(flagOf(y, 'yanked_release').severity, 'warn'); assert.equal(y.release.yanked, true);
  const doc = W.json('pypi-pylib.json'); delete doc.ownership; doc.info.project_urls = { Homepage: 'https://example.invalid' };
  const r = await run(pypi('example-pylib'), W.makeWorld({ getOverrides: { 'https://pypi.org/pypi/example-pylib/json': bodyOf(doc) } }));
  assert.deepEqual(r.maintainers, { available: false, reason: 'the PyPI JSON API did not expose project owners for this project' });
  assert.deepEqual(r.repository, { url: null, present: false, host: null, recognized_host: false }); assert.ok(ids(r).includes('repository_missing'));
  assert.ok(!ids(r).includes('maintainer_change'));
});

test('failure semantics: an unknown package or version is a 404 "not covered" with no OSV call and nothing cached', async () => {
  for (const [args, text] of [[npm('example-nosuch'), /npm has no package named example-nosuch/], [npm('example-widget-kit', '9.9.9'), /npm has no version 9.9.9 of example-widget-kit/], [pypi('example-nosuch'), /PyPI has no project named example-nosuch/], [pypi('example-pylib', '9.9'), /PyPI has no release 9.9 of example-pylib/]]) {
    const w = W.makeWorld();
    const c = make(w);
    const e = await refusal(c.check(args));
    assert.equal(e.status, 404, JSON.stringify(args)); assert.match(e.message, text); assert.match(e.message, /not covered, not charged\.$/);
    assert.ok(!w.calls.some((x) => x.method === 'POST'), 'OSV is not asked about a package no registry knows');
    assert.equal(c.cache.size, 0);
  }
});

test('failure semantics: a registry that cannot answer is a 503 "Not charged." with Retry-After (5xx, network error, rate limit, junk)', async () => {
  const url = 'https://registry.npmjs.org/example-widget-kit';
  const cases = { 'HTTP 500 on both documents': { [url]: { status: 500, body: {} }, [`${url}/latest`]: { status: 500, body: {} } },
    'network error': { [url]: new Error('connect ECONNREFUSED'), [`${url}/latest`]: new Error('connect ECONNREFUSED') },
    'HTTP 429 with Retry-After 120': { [url]: { status: 429, body: {}, headers: { 'retry-after': '120' } }, [`${url}/latest`]: { status: 429, body: {}, headers: { 'retry-after': '120' } } },
    'HTML instead of JSON': { [url]: { status: 200, body: '<html>maintenance</html>' }, [`${url}/latest`]: { status: 200, body: '<html>maintenance</html>' } },
    'a document that is not a package': { [url]: { status: 200, body: '[]' }, [`${url}/latest`]: { status: 200, body: '{"x":1}' } } };
  for (const [what, getOverrides] of Object.entries(cases)) {
    const w = W.makeWorld({ getOverrides });
    const c = make(w);
    const e = await refusal(c.check(npm('example-widget-kit')));
    assert.equal(e.status, 503, what); assert.match(e.message, /Not charged\.$/, what); assert.ok(e.retryAfter >= 5 && e.retryAfter <= 300, what);
    assert.ok(!w.calls.some((x) => x.method === 'POST'), `${what}: no OSV call`);
    assert.equal(c.cache.size, 0, `${what}: a refusal is not cached`);
  }
  const e429 = await refusal(make(W.makeWorld({ getOverrides: cases['HTTP 429 with Retry-After 120'] })).check(npm('example-widget-kit')));
  assert.equal(e429.retryAfter, 120);
  const pyDown = await refusal(make(W.makeWorld({ getOverrides: { 'https://pypi.org/pypi/example-pylib/json': { status: 503, body: {} } } })).check(pypi('example-pylib')));
  assert.equal(pyDown.status, 503);
});

test('failure semantics: OSV is the core, so OSV down is a 503 (not a 200 without advisories) and the registry answer is not served or cached', async () => {
  for (const [what, osvOverride] of [['500', () => ({ status: 500, body: {} })], ['429', () => ({ status: 429, body: {} })], ['network', () => new Error('socket hang up')], ['not JSON', () => ({ status: 200, body: '<html>' })], ['malformed', () => bodyOf([])]]) {
    const w = W.makeWorld({ osvOverride });
    const c = make(w);
    const e = await refusal(c.check(npm('example-widget-kit')));
    assert.equal(e.status, 503, what); assert.match(e.message, /OSV\.dev could not answer/); assert.match(e.message, /Not charged\.$/); assert.equal(c.cache.size, 0);
    const py = await refusal(make(W.makeWorld({ osvOverride })).check(pypi('example-pylib')));
    assert.equal(py.status, 503, `pypi ${what}`);
  }
});

test('failure semantics: a download count that cannot be read never fails the call (null with a reason, source marked not ok)', async () => {
  for (const [what, spec] of [['429', { status: 429, body: {} }], ['network', new Error('timed out')], ['junk', { status: 200, body: '<html>' }], ['negative', bodyOf({ downloads: -5 })], ['string', bodyOf({ downloads: '9' })]]) {
    const r = await run(npm('example-widget-kit'), W.makeWorld({ getOverrides: { 'https://api.npmjs.org/downloads/point/last-week/example-widget-kit': spec } }));
    assert.equal(r.downloads, null, what); assert.match(r.downloads_note, /download|API/); assert.equal(r.sources.find((s) => s.name === 'npm downloads').ok, false);
    assert.equal(r.advisory_count, 1, 'the rest of the answer is intact');
    const p = await run(pypi('example-pylib'), W.makeWorld({ getOverrides: { 'https://pypistats.org/api/packages/example-pylib/recent': spec } }));
    assert.equal(p.downloads, null, `pypistats ${what}`); assert.match(p.downloads_note, /download|pypistats/);
  }
});

test('over the read cap: the npm document falls back to the version document with the gap named; both failing is a 503', async () => {
  const over = new Error('document is 7107539 bytes, over the 5242880-byte limit'); over.kind = 'bad_request';
  const url = 'https://registry.npmjs.org/example-widget-kit';
  const w = W.makeWorld({ getOverrides: { [url]: over } });
  const r = await run(npm('example-widget-kit'), w);
  assert.deepEqual(w.calls.filter((c) => c.method === 'GET').map((c) => c.url), [url, `${url}/latest`, 'https://api.npmjs.org/downloads/point/last-week/example-widget-kit']);
  assert.equal(r.version, '2.0.0'); assert.equal(r.release.published_at, null); assert.equal(r.release.age_days, null); assert.equal(r.release.version_count, null); assert.equal(r.release.is_latest, true);
  assert.deepEqual(r.data_gaps, [{ part: 'release times, version count and maintainer history', reason: 'the full registry document is over the 5 MB read cap' }]);
  assert.deepEqual(r.maintainers, { available: true, count: 2, added_since_previous_version: null, removed_since_previous_version: null, published_by_new_account: null, source: 'version document' });
  assert.deepEqual(r.install_scripts, [{ script: 'postinstall', command: 'node setup.js' }]);
  assert.equal(r.advisory_count, 1); assert.equal(r.sources[0].ok, false); assert.equal(r.sources[1].ok, true);
  assert.ok(!ids(r).includes('new_release'), 'no release age, so no age flag');
  const wv = W.makeWorld({ getOverrides: { [url]: over } });
  const rv = await run(npm('example-widget-kit', '2.0.0'), wv);
  assert.ok(wv.calls.some((c) => c.url === `${url}/2.0.0`)); assert.equal(rv.release.is_latest, null);
  const both = await refusal(make(W.makeWorld({ getOverrides: { [url]: over, [`${url}/latest`]: over } })).check(npm('example-widget-kit')));
  assert.equal(both.status, 503);
  const gone = await refusal(make(W.makeWorld({ getOverrides: { [url]: over, [`${url}/9.9.9`]: { status: 404, body: {} } } })).check(npm('example-widget-kit', '9.9.9')));
  assert.equal(gone.status, 404);
});

test('over the read cap: a PyPI project document needs version= (404 with the hint without it); with a version the release document is used', async () => {
  const over = new Error('document is over the 5242880-byte limit'); over.kind = 'bad_request';
  const url = 'https://pypi.org/pypi/example-pylib/json';
  const e = await refusal(make(W.makeWorld({ getOverrides: { [url]: over } })).check(pypi('example-pylib')));
  assert.equal(e.status, 404); assert.match(e.message, /over the 5 MB read cap; pass version=<release>/);
  const r = await run(pypi('example-pylib', '1.1.0'), W.makeWorld({ getOverrides: { [url]: over } }));
  assert.equal(r.version, '1.1.0'); assert.equal(r.release.first_published_at, null); assert.equal(r.release.published_at, '2026-08-01T08:00:00.000Z');
  assert.deepEqual(r.data_gaps, [{ part: 'first-publish date and version count', reason: 'the full project document is over the 5 MB read cap' }]);
  const down = await refusal(make(W.makeWorld({ getOverrides: { [url]: { status: 500, body: {} } } })).check(pypi('example-pylib')));
  assert.equal(down.status, 503);
});

test('the oversize wording this tool recognises is the wording lib/safe-fetch.js really throws', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'safe-fetch.js'), 'utf8');
  assert.ok(/over the \$\{maxBytes\}-byte limit/.test(src), 'both oversize messages in safe-fetch end in "-byte limit"');
  assert.equal((src.match(/-byte limit/g) || []).length, 2);
});

test('cache: a repeat is served with no upstream call, a stale entry is refetched, the size is bounded, a refusal is never kept', async () => {
  let t = W.NOW;
  const w = W.makeWorld();
  const c = P.makeCheck({ ...w.deps, now: () => t, lists: W.lists(), cacheMax: 2, cacheTtlMs: 1000 });
  const a = await c.check(npm('example-widget-kit'));
  const n = w.calls.length;
  assert.equal(await c.check(npm('example-widget-kit')), a); assert.equal(w.calls.length, n, 'second call: zero upstream calls');
  assert.equal(await c.check({ name: 'example-widget-kit', ecosystem: 'NPM', version: 'latest' }), a, 'the key is the normalised request');
  t += 1500;
  await c.check(npm('example-widget-kit')); assert.ok(w.calls.length > n, 'expired: fetched again');
  await c.check(npm('example-widget-kit', '1.0.0')); await c.check(npm('example-widget-kit', '1.1.0')); await c.check(npm('example-widget-kit', '2.0.0'));
  assert.equal(c.cache.size, 2, 'bounded by cacheMax');
  const bad = await refusal(c.check(npm('example-nosuch'))); assert.equal(bad.status, 404); assert.equal(c.cache.size, 2);
  // the cache itself
  const m = P.makeCache({ max: 3, ttlMs: 10, now: () => t });
  for (let i = 0; i < 10; i++) m.set(`k${i}`, i);
  assert.equal(m.size, 3); assert.equal(m.get('k9'), 9); assert.equal(m.get('k0'), undefined);
  m.get('k7'); m.set('new', 1); assert.equal(m.get('k7'), 7, 'a read keeps an entry young'); assert.equal(m.get('k8'), undefined);
  t += 11; assert.equal(m.get('k7'), undefined, 'expired');
});

test('concurrency: no more than maxInflight checks run at once; the next gets a 503 "busy" and the slot is released afterwards', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const w = W.makeWorld();
  const slow = { ...w.deps, get: async (url, o) => { await gate; return w.deps.get(url, o); } };
  const c = P.makeCheck({ ...slow, lists: W.lists(), maxInflight: 2 });
  const p1 = c.check(npm('example-widget-kit', '1.0.0')); const p2 = c.check(npm('example-widget-kit', '1.1.0'));
  assert.equal(c.inflightCount(), 2);
  // (raced with a timer: with no cap the third call would wait on the gate for ever; a test that hangs is not a test that fails)
  const third = c.check(npm('example-widget-kit', '2.0.0'));
  const verdict = await Promise.race([third.then(() => 'was served', (err) => err), new Promise((r) => setTimeout(() => r('did not answer'), 400))]);
  assert.ok(verdict instanceof Error, `the third check ${verdict}`);
  const e = verdict;
  assert.equal(e.status, 503); assert.match(e.message, /maximum number of checks.*Not charged\.$/); assert.equal(e.retryAfter, 5);
  const bad = await refusal(c.check({ name: '..', ecosystem: 'npm' })); assert.ok(is400(bad), 'validation still runs first');
  release();
  await Promise.all([p1, p2]);
  assert.equal(c.inflightCount(), 0);
  assert.equal((await c.check(npm('example-widget-kit', '2.0.0'))).version, '2.0.0');
  const fail = P.makeCheck({ ...w.deps, get: async () => { throw new Error('boom'); }, lists: W.lists(), maxInflight: 1 });
  await refusal(fail.check(npm('example-widget-kit'))); await refusal(fail.check(npm('example-widget-kit')));
  assert.equal(fail.inflightCount(), 0, 'a failing call frees its slot');
});

test('time budget: when the upstream calls have used the whole allowance the call is a 503, not an unbounded wait', async () => {
  let t = W.NOW;
  const w = W.makeWorld();
  const slowClock = { ...w.deps, now: () => t, get: async (u, o) => { t += 21800; return w.deps.get(u, o); } };
  const e = await refusal(P.makeCheck({ ...slowClock, lists: W.lists() }).check(npm('example-widget-kit')));
  assert.equal(e.status, 503); assert.match(e.message, /Not charged\.$/);
});

test('a bundled list that cannot be read does not fail the call: the typosquat part says checked:false', async () => {
  const r = await run(npm('example-widget-kit'), W.makeWorld(), { lists: { npm: null, pypi: null } });
  assert.equal(r.typosquat.checked, false); assert.ok(!ids(r).includes('typosquat_candidate')); assert.match(r.method, /no bundled list/);
});

// ---------------------------------------------------------------- the route entry and its public text
const BANNED = /\b(safe|unsafe|trusted|scam|malware-free|no risk|guaranteed|rugs?|rugged|rugpull)\b|\bsince\s+(?:\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b(buy|sell|hold|trade|invest)\b/i;
const EMAIL = /[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;

test('public text: the banned-word scanner finds its known positives (so a clean scan means something)', () => {
  for (const s of ['this is safe', 'Not UNSAFE', 'trusted publisher', 'a scam', 'malware-free', 'there is no risk', 'guaranteed', 'a rug pull', 'since 2019', 'since March', 'you should buy', 'sell now', 'hold it', 'trade this']) assert.ok(BANNED.test(s), s);
  for (const s of ['added_since_previous_version', 'the package was first published 5 days ago', 'security holding package', 'drug', 'tradeoff']) assert.ok(!BANNED.test(s), s);
  assert.ok(EMAIL.test('a@b.invalid') && !EMAIL.test('@scope/name'));
});

test('public text: the entry has the documented shape, a 180-255 character description in the house style, and no banned wording anywhere', () => {
  const e = P.entries[0];
  assert.deepEqual(Object.keys(e).sort(), ['desc', 'example', 'name', 'question', 'route', 'run', 'schema', 'tags', 'title', 'usd']);
  assert.equal(e.name, 'get_pkg_check'); assert.equal(e.route, 'GET /api/pkg-check'); assert.equal(e.usd, 0.02);
  assert.ok(e.desc.length >= 180 && e.desc.length <= 255, `desc is ${e.desc.length} characters`);
  assert.ok(e.desc.startsWith('Use when an agent needs')); assert.match(e.desc, /404/); assert.match(e.desc, /503/); assert.match(e.desc, /not charged/);
  assert.ok(e.tags.every((t) => t === t.toLowerCase() && /^[a-z0-9-]+$/.test(t)));
  assert.deepEqual(Object.keys(e.schema), ['name', 'ecosystem', 'version']);
  assert.ok(!e.route.includes(':'), 'query parameters only: no path parameter');
  assert.equal(typeof e.run, 'function');
  const text = [e.desc, e.title, e.question, ...e.tags, ...Object.values(e.schema).map((s) => s.description), JSON.stringify(e.example)];
  for (const s of text) { assert.ok(!BANNED.test(s), `banned wording in: ${s.slice(0, 80)}`); assert.ok(!EMAIL.test(s)); }
  assert.ok(!/\d/.test(e.desc.replace(/\b(404|503)\b/g, '')), 'no typed count in the description (only the two status codes)');
});

test('public text: the published example is built by the real code from the fixtures, equals the data file, and has the full output shape', async () => {
  const fresh = await buildExample();
  assert.deepEqual(P.entries[0].example, fresh, 'tools/r23/data/pkgcheck-example.json is stale: run node ops/r23-pkgcheck-example.js');
  for (const k of ['name', 'ecosystem', 'version', 'found', 'advisories', 'malicious', 'release', 'maintainers', 'install_scripts', 'downloads', 'typosquat', 'repository', 'flags', 'sources', 'method']) assert.ok(k in fresh, k);
  assert.ok(fresh.name.startsWith('example-'), 'a constructed example names no real package');
});

test('public text: every customer-visible string any test produced (answers, flag details, refusals) is free of banned wording, person handles and emails', () => {
  assert.ok(TEXTS.length > 30, `only ${TEXTS.length} strings collected`);
  for (const s of TEXTS) {
    assert.ok(!BANNED.test(s.replace(/maint-(one|two|x)/g, '')), `banned wording: ${s.slice(0, 120)}`);
    assert.ok(!EMAIL.test(s), `email-like text: ${s.slice(0, 120)}`);
    assert.ok(!/maint-(one|two|x)\b|owner-(one|two)\b/.test(s), `a fixture handle leaked: ${s.slice(0, 120)}`);
  }
});

// ---------------------------------------------------------------- the field-by-field reader (tools/r23/pkg-check-pick.js)
const K = require('../tools/r23/pkg-check-pick');
function prng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const STRINGS = ['plain', 'with "quotes"', 'back\\slash', '{"time":{"created":"x"}}', '] } [ {', 'unicode é ü 漢字 😀', 'line\nbreak\ttab', '', '\\u0041', 'a,b:c'];
function randomValue(rnd, depth) {
  const r = rnd();
  if (depth > 3 || r < 0.25) return [0, 1.5, -2, 1e21, true, false, null, STRINGS[Math.floor(rnd() * STRINGS.length)]][Math.floor(rnd() * 8)];
  if (r < 0.55) return Array.from({ length: Math.floor(rnd() * 4) }, () => randomValue(rnd, depth + 1));
  const o = {}; for (let i = 0, n = Math.floor(rnd() * 5); i < n; i++) o[STRINGS[Math.floor(rnd() * STRINGS.length)] + i] = randomValue(rnd, depth + 1); return o;
}
const spaced = (v, rnd) => JSON.stringify(v, null, rnd() < 0.5 ? 0 : rnd() < 0.5 ? 2 : '\t');

test('reader: taking everything gives exactly what JSON.parse gives, over 300 random documents with awkward strings and layouts', () => {
  const rnd = prng(20261031);
  for (let k = 0; k < 300; k++) {
    const doc = { k, v: randomValue(rnd, 0), w: randomValue(rnd, 0) };
    const text = spaced(doc, rnd);
    assert.deepEqual(JSON.parse(JSON.stringify(K.pickJson(Buffer.from(text), () => 'take'))), JSON.parse(text), text.slice(0, 120));
    assert.deepEqual(JSON.parse(JSON.stringify(K.pickJson(Buffer.from(text), (p) => (p.length === 0 ? 'descend' : 'take')))), JSON.parse(text), 'descend one level, take the rest');
  }
});

test('reader: skipped values are skipped exactly (strings holding braces, brackets, quotes and fake keys do not confuse it), selected ones are returned', () => {
  const doc = { skipme: { a: '} ] "x": {', b: [1, 2, { c: '"time":{"created":"1999"}' }] }, time: { created: '2026-01-01T00:00:00.000Z' }, readme: 'He said "hi" \\ {{{[[[', versions: { '1.0.0': { scripts: { install: 'x' }, readme: '}"', _npmUser: { name: 'u' } } } };
  const picked = K.pickJson(Buffer.from(JSON.stringify(doc, null, 1)), K.npmDocSelect);
  assert.deepEqual(JSON.parse(JSON.stringify(picked)), { time: doc.time, versions: { '1.0.0': { scripts: { install: 'x' }, _npmUser: { name: 'u' } } } });
  assert.ok(!('readme' in picked) && !('skipme' in picked));
});

test('reader: the npm and PyPI selectors keep exactly the fields the tool reads (checked against a full parse of the fixtures)', () => {
  const npmDoc = W.json('npm-widget.json');
  const got = K.pickJson(W.read('npm-widget.json'), K.npmDocSelect);
  const want = { 'dist-tags': npmDoc['dist-tags'], time: npmDoc.time, maintainers: npmDoc.maintainers, repository: npmDoc.repository, versions: {} };
  for (const [v, m] of Object.entries(npmDoc.versions)) { want.versions[v] = {}; for (const k of ['version', 'scripts', 'maintainers', '_npmUser', 'deprecated', 'description', 'gypfile', 'repository']) if (k in m) want.versions[v][k] = m[k]; }
  assert.deepEqual(JSON.parse(JSON.stringify(got)), want);
  const py = W.json('pypi-pylib.json');
  const g2 = JSON.parse(JSON.stringify(K.pickJson(W.read('pypi-pylib.json'), K.pypiSelector('1.1.0'))));
  assert.deepEqual(Object.keys(g2).sort(), ['info', 'ownership', 'releases', 'urls']);
  assert.deepEqual(g2.info, { version: '1.2.0', project_urls: py.info.project_urls, home_page: null, yanked: false });
  assert.deepEqual(g2.releases['1.2.0'], py.releases['1.2.0'].map((f) => ({ upload_time_iso_8601: f.upload_time_iso_8601 })), 'other releases keep only the upload time');
  assert.deepEqual(g2.releases['1.1.0'], py.releases['1.1.0'].map((f) => ({ packagetype: f.packagetype, upload_time_iso_8601: f.upload_time_iso_8601, yanked: f.yanked })), 'the release asked for keeps type and yanked');
  assert.deepEqual(g2.urls, py.urls.map((f) => ({ packagetype: f.packagetype, upload_time_iso_8601: f.upload_time_iso_8601, yanked: f.yanked })));
});

test('reader: a document that is not a JSON object, is cut short, or has trailing data throws; a hostile key cannot change a prototype', () => {
  for (const bad of ['', '<html>', '[]', '"x"', '{', '{"a":', '{"a":"unterminated}', '{"a":1,}', '{"a" 1}', '{"a":1}x', '{"a":[1,2}', '{"a":{"b":1}', 'null']) {
    assert.throws(() => K.pickJson(Buffer.from(bad), () => 'descend'), undefined, JSON.stringify(bad));
  }
  const evil = K.pickJson(Buffer.from('{"versions":{"__proto__":{"version":"1.0.0"},"1.0.0":{"version":"1.0.0"}}}'), K.npmDocSelect);
  assert.equal(Object.getPrototypeOf(evil.versions), Object.prototype); assert.equal(Object.prototype.hasOwnProperty.call(evil.versions, '__proto__'), true); assert.equal({}.version, undefined);
  assert.deepEqual(Object.keys(evil.versions).sort(), ['1.0.0', '__proto__']);
});

test('reader: through the tool, a document with a 6000-version history, a huge readme and hostile strings is read correctly and fast', async () => {
  const versions = {}, time = { created: '2020-01-01T00:00:00.000Z', modified: '2026-10-30T00:00:00.000Z' };
  for (let i = 0; i < 6000; i++) { const v = `1.${Math.floor(i / 100)}.${i % 100}`; versions[v] = { name: 'example-widget-kit', version: v, readme: '"} {'.repeat(50), dist: { tarball: 'https://example.invalid/x.tgz', shasum: 'a'.repeat(40) }, maintainers: [{ name: i % 2 ? 'maint-one' : 'maint-two' }], _npmUser: { name: 'maint-one' } }; time[v] = new Date(Date.UTC(2020, 0, 1) + i * 86400000 / 2).toISOString(); }
  versions['1.59.99'].scripts = { postinstall: 'node "x".js' };
  const doc = { _id: 'x', name: 'example-widget-kit', 'dist-tags': { latest: '1.59.99' }, readme: 'R'.repeat(1024 * 1024), versions, time, maintainers: [{ name: 'maint-one' }, { name: 'maint-two' }], repository: 'example-org/widget-kit' };
  const text = Buffer.from(JSON.stringify(doc));
  assert.ok(text.length > 3 * 1024 * 1024 && text.length < 5 * 1024 * 1024, `${text.length} bytes`);
  const t0 = Date.now();
  const r = await run(npm('example-widget-kit'), W.makeWorld({ getOverrides: { 'https://registry.npmjs.org/example-widget-kit': { status: 200, body: text } } }));
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  assert.equal(r.version, '1.59.99'); assert.equal(r.release.version_count, 6000); assert.equal(r.release.first_published_at, '2020-01-01T00:00:00.000Z');
  assert.deepEqual(r.install_scripts, [{ script: 'postinstall', command: 'node "x".js' }]);
  assert.deepEqual(r.repository, { url: 'https://github.com/example-org/widget-kit', present: true, host: 'github.com', recognized_host: true });
  assert.equal(r.maintainers.count, 2);
});

const EXPLORE = '/Volumes/D/r23/cache/pkgcheck/explore';
test('reader: on the real registry documents saved from the live run, the selected fields equal a full JSON.parse of the same documents', { skip: !fs.existsSync(EXPLORE) && 'the cache folder of the live run is not on this machine' }, () => {
  const reduce = (full, select, p = []) => {
    const a = select(p);
    if (a === 'skip') return undefined;
    if (a === 'take' || full === null || typeof full !== 'object') return full;
    if (Array.isArray(full)) return full.map((x, i) => reduce(x, select, [...p, i])).filter((x) => x !== undefined);
    const o = {}; for (const [k, v] of Object.entries(full)) { const r = reduce(v, select, [...p, k]); if (r !== undefined) o[k] = r; } return o;
  };
  const cases = [['https___registry_npmjs_org_express.json', K.npmDocSelect], ['https___registry_npmjs_org_lodash.json', K.npmDocSelect], ['https___registry_npmjs_org_event_stream.json', K.npmDocSelect], ['https___pypi_org_pypi_numpy_json.json', K.pypiSelector('1.0.0')], ['https___pypi_org_pypi_requests_json.json', K.pypiSelector(null)], ['https___pypi_org_pypi_boto3_json.json', K.pypiSelector('1.26.0')]];
  for (const [f, sel] of cases) {
    const buf = fs.readFileSync(path.join(EXPLORE, f));
    assert.deepEqual(JSON.parse(JSON.stringify(K.pickJson(buf, sel))), reduce(JSON.parse(buf.toString('utf8')), sel), f);
  }
});

test('typosquat: the shared-matrix distance equals a plain reference over random names, and the prefilter never drops a pair within distance 2', () => {
  function ref(a, b) { const da = {}; const la = a.length, lb = b.length, maxd = la + lb; const d = Array.from({ length: la + 2 }, () => new Array(lb + 2).fill(0)); d[0][0] = maxd; for (let i = 0; i <= la; i++) { d[i + 1][0] = maxd; d[i + 1][1] = i; } for (let j = 0; j <= lb; j++) { d[0][j + 1] = maxd; d[1][j + 1] = j; } for (let i = 1; i <= la; i++) { let db = 0; for (let j = 1; j <= lb; j++) { const i1 = da[b[j - 1]] || 0, j1 = db; let c = 1; if (a[i - 1] === b[j - 1]) { c = 0; db = j; } d[i + 1][j + 1] = Math.min(d[i][j] + c, d[i + 1][j] + 1, d[i][j + 1] + 1, d[i1][j1] + (i - i1 - 1) + 1 + (j - j1 - 1)); } da[a[i - 1]] = i; } return d[la + 1][lb + 1]; }
  const rnd = prng(7); const al = 'ab-_.cdex';
  const word = (n) => Array.from({ length: Math.floor(rnd() * n) + 1 }, () => al[Math.floor(rnd() * al.length)]).join('');
  let near = 0;
  for (let k = 0; k < 4000; k++) {
    const a = word(9), b = word(9);
    assert.equal(T.damerauLevenshtein(a, b), ref(a, b), `${a} ${b}`);
    if (ref(a, b) <= 2) { near++; assert.ok(T.sharesEnough(a, b, 2), `prefilter dropped ${a} ${b}`); }
  }
  assert.ok(near > 100, `only ${near} near pairs: the prefilter check needs positives`);
  assert.equal(T.sharesEnough('abcdefgh', 'zzzzzzzz', 2), false, 'negative control: unrelated strings are filtered');
});

test('PyPI versions: spellings PEP 440 treats as one version find the same release (2.2.0 and 2.2); different versions do not', async () => {
  for (const [a, b, same] of [['2.2.0', '2.2', true], ['1.0.0rc1', '1.0rc1', true], ['1.0-rc1', '1.0.rc1', true], ['v1.2', '1.2.0', true], ['1!2.0', '1!2', true], ['1.10', '1.1', false], ['2.2.1', '2.2', false], ['1.0', '1.0.post1', false]])
    assert.equal(N.pypiVersionKey(a) === N.pypiVersionKey(b), same, `${a} ${b}`);
  const w = W.makeWorld();
  const r = await run(pypi('example-pylib', '1.1'), w);            // the project publishes 1.1.0
  assert.equal(r.version, '1.1.0'); assert.deepEqual(r.release.distributions, { sdist: false, wheels: 1 }, 'the release asked for keeps its file types');
  assert.equal(w.calls.find((c) => c.method === 'POST').body.version, '1.1.0', 'OSV is asked about the release as PyPI spells it');
  const r2 = await run(pypi('example-pylib', '1.2.0.0')); assert.equal(r2.version, '1.2.0');
  const e = await refusal(make().check(pypi('example-pylib', '1.3'))); assert.equal(e.status, 404);
});
