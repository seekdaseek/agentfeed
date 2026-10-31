// tools/r23/site-signals/html.js: a bounded, linear tag scanner for the page a caller named (R23 T6).
// The page is untrusted input of up to 5 MB, and this runs on the request thread, so there is no backtracking regex over the document: one pass with indexOf, a
// per-tag length cap, a total step budget proportional to the document size, comments / script / style bodies skipped, and a cap on the tags kept. It returns only the tags
// the other modules read (a, link, script, meta, html, body) with their attributes. Not an HTML parser and not meant to be one: it finds attributes of tags.
'use strict';

const WANTED = new Set(['a', 'link', 'script', 'meta', 'html', 'body']);
const MAX_TAG_LEN = 4096;       // a tag longer than this is not read
const MAX_KEPT = 30000;         // tags kept
const MAX_ATTRS = 40;
const MAX_VALUE = 2048;

const isLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameChar = (c) => isLetter(c) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;
const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

function decode(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(amp|quot|apos|lt|gt|#\d{1,6}|#x[0-9a-fA-F]{1,5});/g, (m, e) => {
    if (e === 'amp') return '&'; if (e === 'quot') return '"'; if (e === 'apos') return "'"; if (e === 'lt') return '<'; if (e === 'gt') return '>';
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
  });
}

/** `raw` is the text between the tag name and the closing > -> a null-prototype object of lower-cased attribute names (first one wins) */
function parseAttrs(raw) {
  const attrs = Object.create(null);
  const n = raw.length;
  let i = 0; let count = 0;
  while (i < n && count < MAX_ATTRS) {
    while (i < n && (isSpace(raw.charCodeAt(i)) || raw.charCodeAt(i) === 47)) i++;
    if (i >= n) break;
    const s = i;
    while (i < n) { const c = raw.charCodeAt(i); if (isSpace(c) || c === 61 || c === 47) break; i++; }
    const name = raw.slice(s, i).toLowerCase();
    while (i < n && isSpace(raw.charCodeAt(i))) i++;
    let value = '';
    if (raw.charCodeAt(i) === 61) {
      i++;
      while (i < n && isSpace(raw.charCodeAt(i))) i++;
      const q = raw.charCodeAt(i);
      if (q === 34 || q === 39) { const e = raw.indexOf(raw[i], i + 1); const end = e === -1 ? n : e; value = raw.slice(i + 1, end); i = end + 1; }
      else { const v = i; while (i < n && !isSpace(raw.charCodeAt(i))) i++; value = raw.slice(v, i); }
    }
    if (name && !(name in attrs)) attrs[name] = decode(value.length > MAX_VALUE ? value.slice(0, MAX_VALUE) : value);
    count++;
  }
  return attrs;
}

/** the index of the next close tag `</name` (any case) at or after `from`, or -1. Linear in the body skipped: it walks the `</` occurrences, never rescans the document. */
function closeTagIndex(s, name, from) {
  let p = s.indexOf('</', from);
  while (p !== -1) {
    if (s.substr(p + 2, name.length).toLowerCase() === name) return p;
    p = s.indexOf('</', p + 2);
  }
  return -1;
}

/** raw[start..start+want.length) equals `want` (lower case), ignoring ASCII case, without making a string */
function eqLower(raw, start, want) {
  for (let k = 0; k < want.length; k++) { let c = raw.charCodeAt(start + k); if (c >= 65 && c <= 90) c += 32; if (c !== want.charCodeAt(k)) return false; }
  return true;
}

/** the value of ONE attribute of a tag (`raw` = the text between the tag name and the closing >), or null; no object is built, so it is cheap on the page's thousands of anchors */
function attrValue(raw, want) {
  const n = raw.length;
  let i = 0; let count = 0;
  while (i < n && count < MAX_ATTRS) {
    while (i < n && (isSpace(raw.charCodeAt(i)) || raw.charCodeAt(i) === 47)) i++;
    if (i >= n) break;
    const s = i;
    while (i < n) { const c = raw.charCodeAt(i); if (isSpace(c) || c === 61 || c === 47) break; i++; }
    const hit = i - s === want.length && eqLower(raw, s, want);          // the attribute's name is compared in place: no string is made for the ones we do not want
    while (i < n && isSpace(raw.charCodeAt(i))) i++;
    let value = '';
    if (raw.charCodeAt(i) === 61) {
      i++;
      while (i < n && isSpace(raw.charCodeAt(i))) i++;
      const q = raw.charCodeAt(i);
      if (q === 34 || q === 39) { const e = raw.indexOf(raw[i], i + 1); const end = e === -1 ? n : e; if (hit) value = raw.slice(i + 1, end); i = end + 1; }
      else { const v = i; while (i < n && !isSpace(raw.charCodeAt(i))) i++; if (hit) value = raw.slice(v, i); }
    }
    if (hit) return decode(value.length > MAX_VALUE ? value.slice(0, MAX_VALUE) : value);
    count++;
  }
  return null;
}

/**
 * One pass over the document; calls visit(name, raw) for each wanted tag (raw = the attribute text, see attrValue / parseAttrs) and keeps NOTHING, so memory does not grow with
 * the page. -> { truncated } when the step budget or the tag cap stopped the scan early.
 */
function visitTags(html, visit) {
  const n = html.length;
  let budget = n * 4 + 100000;     // characters of tag text we are willing to examine: linear in the document, so no input makes this quadratic
  let truncated = false; let kept = 0;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e === -1 ? n : e + 3; continue; }
    const c = html.charCodeAt(lt + 1);
    if (!isLetter(c)) { i = lt + 1; continue; }              // doctype, processing instruction, close tag, a stray <
    let j = lt + 1;
    while (j < n && isNameChar(html.charCodeAt(j))) j++;
    // a tag name is only turned into a string when its length can be one we read (a, link, meta, html, body, style, script): most tags are div, p, li and span
    const nl = j - lt - 1;
    const name = nl === 1 || nl === 4 || nl === 5 || nl === 6 ? html.slice(lt + 1, j).toLowerCase() : '';
    const limit = Math.min(n, lt + MAX_TAG_LEN);
    let k = j; let q = 0;
    while (k < limit) {
      const ch = html.charCodeAt(k);
      if (q) { if (ch === q) q = 0; } else if (ch === 34 || ch === 39) q = ch; else if (ch === 62) break;
      k++;
    }
    budget -= k - lt;
    if (budget < 0) { truncated = true; break; }
    if (k >= limit || html.charCodeAt(k) !== 62) { i = lt + 1; continue; }      // no end within the cap: not read as a tag
    if (WANTED.has(name)) {
      if (kept >= MAX_KEPT) { truncated = true; break; }
      kept++;
      visit(name, html.slice(j, k));
    }
    i = k + 1;
    if (name === 'script' || name === 'style') {                // the body is code, not markup
      const e = closeTagIndex(html, name, i);
      i = e === -1 ? n : e;
    }
  }
  return { truncated };
}

/** -> { tags: [{ name, attrs }], truncated } : the same scan, kept as a list (tests and small inputs; the route uses visitTags and keeps nothing) */
function scanTags(html) {
  const tags = [];
  const { truncated } = visitTags(html, (name, raw) => { tags.push({ name, attrs: parseAttrs(raw) }); });
  return { tags, truncated };
}

module.exports = { scanTags, visitTags, attrValue, parseAttrs, closeTagIndex, MAX_KEPT };
