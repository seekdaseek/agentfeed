// tools/r23/pkg-check-names.js: strict validation of the package name, ecosystem and version a caller sends to /api/pkg-check, and the only place the upstream URLs are built.
// The registry hosts are fixed; the NAME is caller input, so it is checked against a per-ecosystem pattern BEFORE any request and every URL piece is encodeURIComponent'ed.
// A name that tries a path trick (.., a second slash, @ in the middle, %, a backslash, a space, a control character) never matches the pattern and is a 400 with no upstream call.
'use strict';
const { bad } = require('./common');

// npm: [@scope/]name, letters (legacy names have capitals), digits and . _ ~ - ; the first character of each part is a letter or digit; at most 214 characters in all
const NPM_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/;
// PyPI (PEP 508): letters, digits and . _ - ; starts and ends with a letter or digit; at most 214 characters
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const NPM_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const PYPI_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+!-]*$/;
const MAX_NAME = 214;
const MAX_VERSION = 100;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const HOSTS = Object.freeze({ npm: 'registry.npmjs.org', npmDownloads: 'api.npmjs.org', pypi: 'pypi.org', pypiStats: 'pypistats.org', osv: 'api.osv.dev' });
const ALLOWED_HOSTS = new Set(Object.values(HOSTS));

/** PEP 503 normalisation: lower-case, runs of - _ . become one - */
const pep503 = (n) => String(n).toLowerCase().replace(/[-_.]+/g, '-');
/**
 * A comparison key for PyPI versions that makes the spellings PEP 440 treats as one version agree: 2.2.0 and 2.2, 1.0.0rc1 and 1.0rc1 and 1.0-rc1, a leading v. PyPI names its
 * releases the way the author spelled them ("2.2"), and a caller who types 2.2.0 means the same release. A simplified form of PEP 440 normalisation (no post/dev/local rewriting).
 */
function pypiVersionKey(v) {
  const s = String(v).toLowerCase().replace(/^v/, '').replace(/[-_]/g, '.');
  const m = /^(\d+!)?(\d+(?:\.\d+)*)(.*)$/.exec(s);
  if (!m) return s;
  const nums = m[2].split('.');
  while (nums.length > 1 && nums[nums.length - 1] === '0') nums.pop();
  return `${m[1] || ''}${nums.join('.')}${m[3].replace(/^\.+/, '')}`;
}

function single(v, what) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw bad(`${what} must be a single string`);
  if (CONTROL.test(v)) throw bad(`${what} must not contain control characters`);
  return v;
}

/** -> { ecosystem: 'npm'|'pypi', name, version: string|null }; throws the 400 `bad` refusal. Makes no request. */
function parseRequest(args) {
  const a = args || {};
  const eco = single(a.ecosystem, 'ecosystem');
  if (eco == null) throw bad('ecosystem is required: npm or pypi');
  const ecosystem = eco.toLowerCase();
  if (ecosystem !== 'npm' && ecosystem !== 'pypi') throw bad('ecosystem must be npm or pypi');
  const name = single(a.name, 'name');
  if (name == null) throw bad('name is required: an npm package name (or @scope/name) or a PyPI project name');
  if (name.length > MAX_NAME) throw bad(`name is longer than ${MAX_NAME} characters`);
  if (ecosystem === 'npm') {
    if (!NPM_NAME.test(name) || name.includes('..')) throw bad('name is not a valid npm package name (letters, digits and . _ ~ - , with an optional @scope/ prefix)');
  } else if (!PYPI_NAME.test(name)) {
    throw bad('name is not a valid PyPI project name (letters, digits and . _ - , starting and ending with a letter or digit)');
  }
  let version = single(a.version, 'version');
  if (version != null && version.toLowerCase() === 'latest') version = null;
  if (version != null) {
    if (version.length > MAX_VERSION) throw bad(`version is longer than ${MAX_VERSION} characters`);
    if (!(ecosystem === 'npm' ? NPM_VERSION : PYPI_VERSION).test(version)) throw bad(ecosystem === 'npm' ? 'version must be a semantic version such as 1.2.3 (or latest)' : 'version must be a PEP 440 version such as 1.2.3 (or latest)');
  }
  return { ecosystem, name: ecosystem === 'pypi' ? pep503(name) : name, version };
}

// ---- URL builders: fixed host + encoded pieces. A scoped npm name keeps its @ and encodes the slash (the form the npm client sends).
const npmPath = (name) => (name[0] === '@' ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name));
const urls = {
  npmDoc: (name) => `https://${HOSTS.npm}/${npmPath(name)}`,
  npmVersion: (name, version) => `https://${HOSTS.npm}/${npmPath(name)}/${encodeURIComponent(version)}`,
  npmDownloads: (name) => `https://${HOSTS.npmDownloads}/downloads/point/last-week/${npmPath(name)}`,
  pypiDoc: (name) => `https://${HOSTS.pypi}/pypi/${encodeURIComponent(name)}/json`,
  pypiVersion: (name, version) => `https://${HOSTS.pypi}/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`,
  pypiStats: (name) => `https://${HOSTS.pypiStats}/api/packages/${encodeURIComponent(name)}/recent`,
  osv: () => `https://${HOSTS.osv}/v1/query`,
};

/** defence in depth: every URL this tool fetches is https on one of the five fixed hosts, whatever the name was */
function assertAllowedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('pkg-check built an unparseable URL'); }
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname) || u.port || u.username || u.password || u.search || u.hash) throw new Error('pkg-check built a URL outside its fixed hosts');
  return raw;
}

module.exports = { parseRequest, pep503, pypiVersionKey, urls, assertAllowedUrl, HOSTS, NPM_NAME, PYPI_NAME, NPM_VERSION, PYPI_VERSION };
