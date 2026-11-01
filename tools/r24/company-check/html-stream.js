// tools/r24/company-check/html-stream.js: a filing as visible text, read as a STREAM (R24 item 5, v2). The scanners take the bytes of a document in chunks of any size and hand out one line of
// visible text at a time; nothing the size of the document is ever built or kept. What is held between chunks is only what cannot be decided yet: the bytes of a tag, a comment or a closing tag
// that the chunk ended inside of, the text since the last tag (cut at a space when it passes 1 MB), and the line being built. That carry is the overlap that makes a phrase, a tag or an entity
// split across two chunks come out exactly as it would from one: the output is the same as tools/r23/claim-check/text.js htmlToText gives for the whole document (test/r24-company-check-stream.test.js
// compares them for every chunk size from 1 byte up, and ops/r24-company-check-equiv.js for every document in the cache).
//
// The rules are those of htmlToText: tags are dropped, a block tag is a line break, a table row is one line (its cells separated by a space), comments, script, style, noscript, template, <head> and the
// inline-XBRL header <ix:header> are skipped (the hidden facts of a filing are never "visible text"), entities are decoded, hidden characters are removed, empty lines are dropped.
// Differences, stated: a skipped element that is never closed swallows the rest of the document (htmlToText would keep it as text), a <tr> that is never closed keeps the row mode until the next
// </tr>, and a tag name of more than 256 bytes is text. Neither happens in a filing EDGAR accepts, and the cache comparison finds no difference.
'use strict';
const T = require('../../r23/claim-check/text');

const BLOCK = new Set(['p', 'div', 'tr', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'section', 'article', 'header', 'footer', 'blockquote', 'pre', 'dd', 'dt', 'dl', 'br', 'hr', 'td', 'th', 'tbody', 'thead', 'tfoot', 'caption', 'center']);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template']);
const HOLD_TAIL = 64;               // bytes kept while looking for the end of a skipped element: its closing tag may start in this chunk and end in the next
const MAX_TAG = 65536;              // a "<" with no ">" within this many bytes is text
const MAX_TEXT_HOLD = 1 << 20;      // text with no tag after it is held up to this many bytes, then cut at a space
const MAX_LINE_CHARS = 4 << 20;     // a single line this long is cut (a document of one enormous paragraph)
const BATCH = 256;

const isLetter = (b) => (b >= 65 && b <= 90) || (b >= 97 && b <= 122);
const isNameByte = (b) => (b >= 48 && b <= 58) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 45 || b === 95;
const isWordByte = (b) => (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95;
const isSpace = (b) => b === 32 || (b >= 9 && b <= 13);
const SIMPLE_NAME = /^[a-z0-9]{1,10}$/;
const EMPTY = Buffer.alloc(0);

/** just after the ">" of the first "</name" + spaces + ">" at or after `from` (case-insensitive), or -1 */
function closeTag(buf, name, from) {
  for (let i = buf.indexOf('</', from); i >= 0; i = buf.indexOf('</', i + 2)) {
    let k = i + 2; let ok = true;
    for (let c = 0; c < name.length; c++, k++) if (k >= buf.length || (buf[k] | 32) !== name.charCodeAt(c)) { ok = false; break; }
    if (!ok) continue;
    while (k < buf.length && isSpace(buf[k])) k++;
    if (buf[k] === 62) return k + 1;
  }
  return -1;
}
function closeComment(buf, from) { const e = buf.indexOf('-->', from); return e < 0 ? -1 : e + 3; }

/** @param {(line: string) => void} onLine  receives each non-empty line of visible text, cleaned the way htmlToText cleans it */
function makeHtmlScanner(onLine) {
  let carry = EMPTY;
  let skip = null;                   // { close: 'script', emit: ' ' } or { comment: true, emit: ' ' }
  let inRow = false;
  let cur = []; let curChars = 0; let batch = [];
  const flushBatch = () => {
    if (!batch.length) return;
    const cleaned = T.cleanText(batch.join('\n')); batch = [];
    if (cleaned) for (const l of cleaned.split('\n')) onLine(l);
  };
  const newline = () => { batch.push(cur.join('')); cur = []; curChars = 0; if (batch.length >= BATCH) flushBatch(); };
  const put = (x) => { if (!x) return; if (x === '\n') { newline(); return; } cur.push(x); curChars += x.length; if (curChars > MAX_LINE_CHARS) newline(); };
  const text = (buf, a, b) => { if (b > a) put(T.decodeEntities(buf.toString('utf8', a, b).replace(/[\r\n\t\f]+/g, ' '))); };

  function run(final) {
    const buf = carry; const n = buf.length; let i = 0;
    while (i < n) {
      if (skip) {
        const e = skip.comment ? closeComment(buf, i) : closeTag(buf, skip.close, i);
        if (e < 0) { i = Math.max(i, n - HOLD_TAIL); break; }              // keep only the tail: the closer may be split
        i = e; put(skip.emit); skip = null; continue;
      }
      const lt = buf.indexOf(60, i);
      if (lt < 0) {                                                        // text only, up to the end of what we have
        if (final) { text(buf, i, n); i = n; } else if (n - i > MAX_TEXT_HOLD) { const sp = buf.lastIndexOf(32, n - 1); if (sp > i) { text(buf, i, sp + 1); i = sp + 1; } }
        break;
      }
      if (lt > i) { text(buf, i, lt); i = lt; }
      if (n - lt < 4 && !final) break;                                     // too little to tell what this "<" opens
      if (buf[lt + 1] === 33 && buf[lt + 2] === 45 && buf[lt + 3] === 45) {   // <!--
        const e = closeComment(buf, lt + 4);
        if (e >= 0) { put(' '); i = e; continue; }
        if (!final) { skip = { comment: true, emit: ' ' }; i = lt + 4; continue; }
        put('<'); i = lt + 1; continue;
      }
      let k = lt + 1; const closing = buf[k] === 47; if (closing) k++;
      if (k >= n) { if (!final) break; put('<'); i = lt + 1; continue; }
      if (!isLetter(buf[k])) { put('<'); i = lt + 1; continue; }
      let j = k + 1; while (j < n && isNameByte(buf[j])) j++;
      if (j - k > 256) { put('<'); i = lt + 1; continue; }
      while (!isWordByte(buf[j - 1])) j--;                                 // the name ends on a word character
      const gt = buf.indexOf(62, j);
      if (gt < 0) { if (!final && n - lt < MAX_TAG) break; put('<'); i = lt + 1; continue; }
      const name = buf.toString('latin1', k, j).toLowerCase();
      const end = gt + 1;
      if (!closing && (name === 'head' || name === 'ix:header')) { skip = { close: name, emit: '\n' }; i = end; continue; }
      if (!closing && SKIP_TAGS.has(name)) { skip = { close: name, emit: ' ' }; i = end; continue; }
      const block = SIMPLE_NAME.test(name) && BLOCK.has(name);
      if (!closing && name === 'tr' && !inRow) inRow = true;
      if (inRow) put(block ? ' ' : '');
      else put(name === 'td' || name === 'th' ? ' ' : block ? '\n' : '');
      if (closing && name === 'tr' && inRow) { put('\n'); inRow = false; }
      i = end;
    }
    carry = i >= n ? EMPTY : Buffer.from(buf.subarray(i));                 // a copy: the chunk it came from can be freed
  }

  return {
    push(chunk) { carry = carry.length ? Buffer.concat([carry, chunk]) : chunk; run(false); },
    end() { run(true); if (cur.length) newline(); flushBatch(); },
    /** bytes held between chunks (tests: it must stay small) */
    held: () => carry.length + curChars,
  };
}

/** a hard-wrapped plain-text filing: one line per paragraph (blank lines separate paragraphs), the same as plainToLines + cleanText in index.js did for the whole text */
function makePlainScanner(onLine) {
  let carry = EMPTY; let para = []; let paraChars = 0;
  const emit = () => {
    if (!para.length) return;
    const s = para.join(' ').replace(/[ \t]+/g, ' ').trim(); para = []; paraChars = 0;
    if (s) { const c = T.cleanText(s); if (c) onLine(c); }
  };
  const lineOf = (buf, a, b) => {
    const l = buf.toString('utf8', a, b).replace(/\r/g, '');
    if (/^[ \t]*$/.test(l)) emit(); else { const t = l.trim(); para.push(t); paraChars += t.length + 1; if (paraChars > MAX_LINE_CHARS) emit(); }
  };
  function run(final) {
    const buf = carry; const n = buf.length; let i = 0;
    for (let nl = buf.indexOf(10, i); nl >= 0; nl = buf.indexOf(10, i)) { lineOf(buf, i, nl); i = nl + 1; }
    if (n - i > MAX_TEXT_HOLD) { const sp = buf.lastIndexOf(32, n - 1); if (sp > i) { lineOf(buf, i, sp + 1); i = sp + 1; } }
    if (final && i < n) { lineOf(buf, i, n); i = n; }
    carry = i >= n ? EMPTY : Buffer.from(buf.subarray(i));
  }
  return {
    push(chunk) { carry = carry.length ? Buffer.concat([carry, chunk]) : chunk; run(false); },
    end() { run(true); emit(); },
    held: () => carry.length + paraChars,
  };
}

module.exports = { makeHtmlScanner, makePlainScanner, HOLD_TAIL, MAX_TAG, MAX_TEXT_HOLD };
