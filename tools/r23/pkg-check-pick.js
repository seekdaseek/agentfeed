// tools/r23/pkg-check-pick.js: read ONLY the fields of a big JSON document that /api/pkg-check uses, straight from the response bytes (R23 T5).
//
// Why: the full npm document of a popular package is megabytes (React 7 MB, TypeScript 16 MB: readmes, tarball links, hashes for thousands of versions), and a PyPI project
// document lists every file of every release. JSON.parse of a 4 MB document costs tens of megabytes of resident memory per call (measured: about 100 MB after 20 calls), far
// over this tool's budget. pickJson() walks the bytes, skips what no one asked for without building it, and JSON.parse's only the small values a selector takes. The result has
// the same shape as the full document restricted to those fields, so the code that reads it is the code that would read the full document.
//
// select(path) -> 'take' | 'descend' | 'skip'. `path` holds object keys and array indexes from the root. 'take' returns the value whole; 'descend' returns an object or array
// built from the selected children; 'skip' leaves the value out. The root must be an object. Anything that is not well-formed enough to walk throws (the caller treats it as "not JSON").
'use strict';

const QUOTE = 0x22, BACKSLASH = 0x5c, LBRACE = 0x7b, RBRACE = 0x7d, LBRACKET = 0x5b, RBRACKET = 0x5d, COMMA = 0x2c, COLON = 0x3a;
const isWs = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
const fail = (msg) => { throw new Error(`json walk: ${msg}`); };

function skipWs(buf, i) { while (i < buf.length && isWs(buf[i])) i++; return i; }

let ESCAPED = false;        // set by skipString: did the string just skipped contain a backslash?
let END = 0;               // set by walk: the index just after the value just read (a module variable, not a returned object: a 4 MB document has hundreds of thousands of values)

/** index just after the string that starts at buf[i] (a double quote); sets ESCAPED */
function skipString(buf, i) {
  let j = i + 1;
  const n = buf.length;
  ESCAPED = false;
  while (j < n) {
    const c = buf[j];
    if (c === QUOTE) return j + 1;
    if (c === BACKSLASH) { ESCAPED = true; j += 2; } else j++;
  }
  return fail('unterminated string');
}

/** index just after the value that starts at buf[i] */
function skipValue(buf, i) {
  const n = buf.length;
  if (i >= n) fail('unexpected end');
  const c = buf[i];
  if (c === QUOTE) return skipString(buf, i);
  if (c === LBRACE || c === LBRACKET) {
    let depth = 0;
    for (let j = i; j < n; j++) {
      const b = buf[j];
      if (b === QUOTE) { j = skipString(buf, j) - 1; continue; }
      if (b === LBRACE || b === LBRACKET) depth++;
      else if (b === RBRACE || b === RBRACKET) { depth--; if (depth === 0) return j + 1; }
    }
    return fail('unterminated object or array');
  }
  let j = i;
  while (j < n && buf[j] !== COMMA && buf[j] !== RBRACE && buf[j] !== RBRACKET && !isWs(buf[j])) j++;
  if (j === i) fail('empty value');
  return j;
}

/** the value at buf[i..end): a string without escapes is decoded directly, anything else goes through JSON.parse */
function decode(buf, i, end) {
  if (buf[i] === QUOTE) { skipString(buf, i); if (!ESCAPED) return buf.toString('utf8', i + 1, end - 1); }
  return JSON.parse(buf.toString('utf8', i, end));
}

/** the value at buf[i] per select(path); sets END; undefined means "left out" */
function walk(buf, i, path, select) {
  i = skipWs(buf, i);
  const action = select(path);
  if (action === 'skip') { END = skipValue(buf, i); return undefined; }
  if (action === 'take' || (buf[i] !== LBRACE && buf[i] !== LBRACKET)) {
    const end = skipValue(buf, i);
    const v = decode(buf, i, end);
    END = end;
    return v;
  }
  if (buf[i] === LBRACE) {
    const out = {};
    let j = skipWs(buf, i + 1);
    if (buf[j] === RBRACE) { END = j + 1; return out; }
    for (;;) {
      if (buf[j] !== QUOTE) fail('expected a key');
      const keyEnd = skipString(buf, j);
      const key = ESCAPED ? JSON.parse(buf.toString('utf8', j, keyEnd)) : buf.toString('utf8', j + 1, keyEnd - 1);
      j = skipWs(buf, keyEnd);
      if (buf[j] !== COLON) fail('expected a colon');
      path.push(key);
      const v = walk(buf, j + 1, path, select);
      path.pop();
      if (v !== undefined) { if (key === '__proto__') Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true }); else out[key] = v; }   // a registry may name a version __proto__
      j = skipWs(buf, END);
      if (buf[j] === COMMA) { j = skipWs(buf, j + 1); continue; }
      if (buf[j] === RBRACE) { END = j + 1; return out; }
      fail('expected a comma or the end of the object');
    }
  }
  const out = [];
  let j = skipWs(buf, i + 1);
  if (buf[j] === RBRACKET) { END = j + 1; return out; }
  for (let idx = 0; ; idx++) {
    path.push(idx);
    const v = walk(buf, j, path, select);
    path.pop();
    if (v !== undefined) out.push(v);
    j = skipWs(buf, END);
    if (buf[j] === COMMA) { j = skipWs(buf, j + 1); continue; }
    if (buf[j] === RBRACKET) { END = j + 1; return out; }
    fail('expected a comma or the end of the array');
  }
}

/** the selected fields of the JSON document in `buf`; throws when the bytes are not a JSON object */
function pickJson(buf, select) {
  const i = skipWs(buf, 0);
  if (buf[i] !== LBRACE) fail('the document is not a JSON object');
  const v = walk(buf, i, [], select);
  if (skipWs(buf, END) !== buf.length) fail('data after the end of the document');
  return v;
}

// ---- the selectors: exactly the fields tools/r23/pkg-check.js reads ----
const NPM_VERSION_KEYS = new Set(['version', 'scripts', 'maintainers', '_npmUser', 'deprecated', 'description', 'gypfile', 'repository']);
const NPM_TOP_TAKE = new Set(['dist-tags', 'time', 'maintainers', 'repository']);
/** full npm document (registry.npmjs.org/<name>) */
function npmDocSelect(p) {
  if (p.length === 0) return 'descend';
  if (p.length === 1) return NPM_TOP_TAKE.has(p[0]) ? 'take' : p[0] === 'versions' ? 'descend' : 'skip';
  if (p[0] !== 'versions') return 'skip';
  if (p.length === 2) return 'descend';
  return p.length === 3 && NPM_VERSION_KEYS.has(p[2]) ? 'take' : 'skip';
}
/** one npm version document (registry.npmjs.org/<name>/<version>) */
function npmVersionSelect(p) {
  if (p.length === 0) return 'descend';
  return p.length === 1 && (NPM_VERSION_KEYS.has(p[0]) || p[0] === 'name') ? 'take' : 'skip';
}
const PYPI_INFO_KEYS = new Set(['version', 'project_urls', 'home_page', 'yanked']);
const PYPI_FILE_KEYS = new Set(['packagetype', 'upload_time_iso_8601', 'yanked']);
/**
 * PyPI project document (pypi.org/pypi/<name>/json) or release document (pypi.org/pypi/<name>/<version>/json). Of every release only each file's upload time is kept (the first
 * publish date and the version count need nothing more); the file type and yanked flag are kept for the release asked for (`want`) and for `urls`, the files of the latest release.
 */
function pypiSelector(want, keyOf = (x) => x) {
  const wantKey = want == null ? null : keyOf(want);
  let lastRelease = null, lastIsWanted = false;                      // the same release key is asked about for every file in it
  return function pypiSelect(p) {
    if (p.length === 0) return 'descend';
    const top = p[0];
    if (p.length === 1) return top === 'info' || top === 'releases' || top === 'urls' ? 'descend' : top === 'ownership' ? 'take' : 'skip';
    if (top === 'info') return p.length === 2 && PYPI_INFO_KEYS.has(p[1]) ? 'take' : 'skip';
    if (top === 'urls') return p.length === 2 ? 'descend' : p.length === 3 && PYPI_FILE_KEYS.has(p[2]) ? 'take' : 'skip';
    if (top === 'releases') {
      if (p.length === 2 || p.length === 3) return 'descend';
      if (p.length !== 4) return 'skip';
      if (p[3] === 'upload_time_iso_8601') return 'take';
      if (wantKey == null) return 'skip';
      if (p[1] !== lastRelease) { lastRelease = p[1]; lastIsWanted = keyOf(p[1]) === wantKey; }
      return lastIsWanted && PYPI_FILE_KEYS.has(p[3]) ? 'take' : 'skip';
    }
    return 'skip';
  };
}

module.exports = { pickJson, npmDocSelect, npmVersionSelect, pypiSelector, skipValue, skipString };
