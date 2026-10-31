// tools/r23/claim-check/text.js: the deterministic half of claim-check (R23 T4, 31 Oct 2026). No network, no model, no clock.
//   htmlToText      a filing or page as lines of text (a table row is one line), hidden characters removed
//   figuresOf       the numbers in a text, comparable across formats ("383.3" and "383,285" are the same figure to four significant digits)
//   selectExcerpts  which passages of a long source go in front of the model (the ones that share the most words and figures with the claim)
//   verifyQuotes    keeps only the quotes found word for word (whitespace aside) in a fetched source; this is the rule the whole route stands on
//   redactInjections / quoteLooksInjected  the injection rules (tools/llm/injection-rules.js) applied to what the model is shown and to what it quotes
//   notCheckable, tickerOf, formHint, yearsOf, wikiTitlesOf  what can be read off a claim without a second model call
'use strict';
const R = require('../../llm/injection-rules');

// ---------------------------------------------------------------- text
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', bull: '•', deg: '°', copy: '©', reg: '®', trade: '™', times: '×', euro: '€', pound: '£', cent: '¢', sect: '§', para: '¶', middot: '·', laquo: '«', raquo: '»', shy: '' };
function decodeEntities(s) {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,8}));/g, (m, d, h, n) => {
    if (n) return Object.prototype.hasOwnProperty.call(NAMED, n) ? NAMED[n] : m;
    const cp = d ? Number(d) : parseInt(h, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
  });
}
// zero-width, bidi and tag characters: invisible, so nothing a reader could check a quote against; they are removed from every source
const HIDDEN = /[​-‏‪-‮⁠-⁤﻿\u{e0000}-\u{e007f}]/gu;
const BLOCK = new Set(['p', 'div', 'tr', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'section', 'article', 'header', 'footer', 'blockquote', 'pre', 'dd', 'dt', 'dl', 'br', 'hr', 'td', 'th', 'tbody', 'thead', 'tfoot', 'caption', 'center']);
const TAG = /<(\/?)([A-Za-z][\w:-]*)\b[^>]*>/g;

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template']);
const NAME_BYTE = (b) => (b >= 48 && b <= 58) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 45 || b === 95;   // 0-9 : A-Z a-z - _
const WORD_BYTE = (b) => (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95;
const LETTER_BYTE = (b) => (b >= 65 && b <= 90) || (b >= 97 && b <= 122);
const SPACE_BYTE = (b) => b === 32 || (b >= 9 && b <= 13);
// A tag name is read as a number, not as a string: its lower-case letters and digits packed in base 37 (at most 10 of them, which holds every name below; a longer name, or one
// with a ":", "-" or "_", is -1 and so an inline tag). A filing has a million tags, and a string and an object for each was most of the memory of reading it.
const codeOf = (name) => { let c = 0; for (let i = 0; i < name.length; i++) c = c * 37 + (name.charCodeAt(i) <= 57 ? name.charCodeAt(i) - 21 : name.charCodeAt(i) - 96); return c; };
const BLOCK_CODES = new Set([...BLOCK].map(codeOf));
const SKIP_CODES = new Set([...SKIP_TAGS].map(codeOf));
const SKIP_NAME = Object.fromEntries([...SKIP_TAGS].map((n) => [codeOf(n), n]));
const TR = codeOf('tr'); const TD = codeOf('td'); const TH = codeOf('th');
let tagClosing = false; let tagCode = -1;                       // set by tagAt, so that finding a tag allocates nothing
/** where the tag that starts at buf[lt] ("<") ends, as the pattern TAG reads it (just after its ">"), or -1 when "<" opens no tag; sets tagClosing and tagCode */
function tagAt(buf, lt, limit) {
  let i = lt + 1; tagClosing = buf[i] === 47; if (tagClosing) i++;
  if (i >= limit || !LETTER_BYTE(buf[i])) return -1;
  let j = i + 1; while (j < limit && NAME_BYTE(buf[j])) j++;
  while (!WORD_BYTE(buf[j - 1])) j--;                           // the name ends on a word character (the \b of the pattern)
  const gt = buf.indexOf(62, j);
  if (gt < 0 || gt >= limit) return -1;
  let c = 0;
  if (j - i <= 10) { for (let k = i; k < j; k++) { const x = buf[k] | 32; if (x >= 97 && x <= 122) c = c * 37 + (x - 96); else if (buf[k] >= 48 && buf[k] <= 57) c = c * 37 + (buf[k] - 21); else { c = -1; break; } } } else c = -1;
  tagCode = c;
  return gt + 1;
}
/** just after the ">" of the first "</name" + spaces + ">" at or after `from` (case-insensitive), or -1 */
function closeAt(buf, name, from, limit) {
  for (let i = buf.indexOf('</', from); i >= 0 && i < limit; i = buf.indexOf('</', i + 2)) {
    let k = i + 2; let ok = true;
    for (let c = 0; c < name.length; c++, k++) if ((buf[k] | 32) !== name.charCodeAt(c)) { ok = false; break; }
    if (!ok) continue;
    while (SPACE_BYTE(buf[k])) k++;
    if (buf[k] === 62) return k + 1;
  }
  return -1;
}
/** the visible text of buf[from, to) as lines, in ONE pass over the bytes: the text between tags is decoded and kept, the tags are only read; nothing as large as the document is ever built */
function bytesToLines(buf, from, to, out) {
  // pieces are joined into one string every 1,000 entries, so the array of pieces stays small however many tags the document has (a filing has a million)
  let parts = [];
  const put = (x) => { if (x) { parts.push(x); if (parts.length >= 1000) { out.push(parts.join('')); parts = []; } } };
  const text = (a, b) => { if (b > a) put(decodeEntities(buf.toString('utf8', a, b).replace(/[\r\n\t\f]+/g, ' '))); };
  let i = from; let rowEnd = -1;                                // rowEnd: just after the </tr> of the table row being read, or -1
  while (i < to) {
    const lt = buf.indexOf(60, i);
    if (lt < 0 || lt >= to) { text(i, to); break; }
    text(i, lt);
    if (buf[lt + 1] === 33 && buf[lt + 2] === 45 && buf[lt + 3] === 45) { const e = buf.indexOf('-->', lt + 4); if (e >= 0 && e < to) { put(' '); i = e + 3; continue; } }
    const end = tagAt(buf, lt, to);
    if (end < 0) { put('<'); i = lt + 1; continue; }            // a "<" that opens no tag stays text
    const closing = tagClosing; const code = tagCode;
    if (!closing && SKIP_CODES.has(code)) { const e = closeAt(buf, SKIP_NAME[code], end, to); if (e >= 0) { put(' '); i = e; continue; } }
    if (!closing && code === TR && rowEnd < 0) rowEnd = closeAt(buf, 'tr', end, to);
    const block = BLOCK_CODES.has(code);
    put(rowEnd >= 0 ? (block ? ' ' : '') : (code === TD || code === TH ? ' ' : (block ? '\n' : '')));
    i = end;
    if (rowEnd >= 0 && i >= rowEnd) { put('\n'); rowEnd = -1; }
  }
  if (parts.length) out.push(parts.join(''));
}
/** the same conversion written the plain way, as a chain of whole-document rewrites of a string: the reference htmlToText is tested against (it copies the document about ten times) */
function htmlToTextRegex(html) {
  let s = String(html).replace(/[\r\n\t\f]+/g, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<ix:header[\s\S]*?<\/ix:header>/gi, ' ').replace(/<(script|style|head|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<tr\b[\s\S]*?<\/tr\s*>/gi, (row) => row.replace(TAG, (m, c, n) => (BLOCK.has(n.toLowerCase()) ? ' ' : '')) + '\n');
  s = s.replace(TAG, (m, c, n) => { const k = n.toLowerCase(); return k === 'td' || k === 'th' ? ' ' : (BLOCK.has(k) ? '\n' : ''); });
  return cleanText(decodeEntities(s));
}

/** the earliest "<name" at or after `from` in a Buffer whose name is not followed by another name character ("<head" yes, "<header" no); -1 when none */
function openTag(buf, names, from) {
  let best = -1;
  for (const nm of names) {
    for (let i = buf.indexOf(nm, from); i >= 0; i = buf.indexOf(nm, i + 1)) {
      if (!NAME_BYTE(buf[i + nm.length])) { if (best < 0 || i < best) best = i; break; }
    }
  }
  return best;
}
/**
 * Visible text of an HTML document (a Buffer, or a string), one line per paragraph or table row, the cells of a row separated by a space. Not a security boundary: it only
 * decides what text is read. The document is read ONCE, as bytes, by a single scanner (bytesToLines): it is never turned into a whole-document string, no DOM is built, and the
 * only allocations are the pieces of text between tags and the lines made of them, so the memory of reading a 4 MB filing is about the size of its text. The hidden XBRL header
 * and <head> are skipped by position. What leaves is the text; the caller holds no reference to the bytes after this returns. Tag names are read as filings write them
 * (lower or upper case for the skipped header and <head>) and compared without case everywhere else.
 */
function htmlToText(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  const out = []; let from = 0;
  for (let pos = 0; ;) {
    const open = openTag(buf, ['<ix:header', '<IX:HEADER', '<head', '<HEAD'], pos);
    if (open < 0) break;
    const name = buf.toString('latin1', open + 1, open + 3).toLowerCase() === 'ix' ? 'ix:header' : 'head';
    const end = closeAt(buf, name, open, buf.length);
    if (end < 0) { pos = open + 1; continue; }                  // never closed: nothing is skipped
    if (open > from) { bytesToLines(buf, from, open, out); out.push('\n'); }
    from = end; pos = end;
  }
  if (from < buf.length) bytesToLines(buf, from, buf.length, out);
  return cleanText(out.join(''));
}
/** hidden characters out, every kind of space a plain space, lines trimmed, empty lines dropped */
function cleanText(s) {
  return String(s).replace(HIDDEN, '').replace(/[   -   　]/g, ' ').split('\n').map((l) => l.replace(/[ \t\f\v\r]+/g, ' ').trim()).filter(Boolean).join('\n');
}
const normWs = (s) => String(s).replace(/\s+/g, ' ').trim();
/** the readable text of the markdown tools/webmd.js makes: links and images become their text, heading marks, bold marks and backslash escapes go */
function mdToPlain(md) {
  return cleanText(String(md).replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^#{1,6}[ \t]+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\\([\\`*_{}\[\]()#+\-.!|>~$])/g, '$1'));
}

// ---------------------------------------------------------------- terms and figures
const STOP = new Set(('a an the and or but if of to in on at by for with from as is are was were be been being it its this that these those there their they he she we you i his her our your not no do does did has have had will would can could should may might must than then so such into over under about after before during between per via also more most other some any each both own same very which who whom whose what when where while'.split(' ')));
const stem = (w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const joinThousands = (s) => s.replace(/(?<=\d),(?=\d{3}(?!\d))/g, '');
const tokens = (s) => joinThousands(String(s).toLowerCase()).match(/[\p{L}\p{N}]+(?:\.\d+)?/gu) || [];
const contentTerms = (s) => tokens(s).filter((w) => !STOP.has(w) && (w.length > 1 || /\d/.test(w))).map(stem);

const NUM_RE = /(?<![\p{L}\p{N}.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\p{N}]|-[KQ]\b)/gu;   // "10-K" and "10-Q" are form names, not figures
/** every number in a text: { raw, value, sig (significant digits as a string), k (how many), digits (written length), year } */
function figuresOf(text) {
  const out = [];
  for (const m of String(text).matchAll(NUM_RE)) {
    const raw = m[1]; const plain = raw.replace(/,/g, ''); const [int, frac = ''] = plain.split('.');
    const sig = frac ? `${int}${frac}`.replace(/^0+/, '') : int.replace(/^0+/, '').replace(/0+$/, '');
    if (!sig) continue;
    out.push({ raw, value: Number(plain), sig, k: sig.length, digits: int.replace(/^0+/, '').length + frac.length, year: !frac && !raw.includes(',') && /^(?:19|20)\d\d$/.test(raw) });
  }
  return out;
}
/** the first k significant digits of a value, rounded: 383285 to 4 digits is "3833", the same as 383.3 */
function mantissa(value, k) {
  if (!Number.isFinite(value) || value === 0) return '';
  return Math.abs(value).toExponential(Math.max(0, Math.min(k, 20) - 1)).split('e')[0].replace('.', '');
}
const figureMatches = (fig, other) => other.some((o) => mantissa(o.value, fig.k) === fig.sig);
// "September 30", "30 September", "Mar. 3rd": the day of a date is not a figure the supporting line must repeat (a table row has no date in it; its heading has). A changed
// date is therefore not caught by the figure guard: it is the model's to notice. The negative lookahead keeps "May 5 million" a figure.
const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DATE_DAY = new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?!\\s*(?:%|percent|thousand|million|billion|trillion|bn\\b|k\\b))|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, 'gi');
/** the figures of a claim that a SUPPORTED answer has to find in its quotes: numbers of two or more digits that are not a bare year or the day of a date */
const guardFigures = (claim) => figuresOf(String(claim).replace(DATE_DAY, ' ')).filter((f) => !f.year && f.digits >= 2);

// ---------------------------------------------------------------- retrieval: which passages of a long source the model reads
const BLOCK_CHARS = 600;
const EXCERPT_BREAK = '=== excerpt break ===';
/** blocks of at most BLOCK_CHARS made of whole lines (a longer line is cut at a space) -> [{ s, e }] offsets into text */
function blocksOf(text, max = BLOCK_CHARS) {
  const out = []; let cs = -1; let ce = -1;
  const flush = () => { if (cs >= 0) out.push({ s: cs, e: ce }); cs = -1; };
  let pos = 0; const n = text.length;
  while (pos < n) {
    let nl = text.indexOf('\n', pos); if (nl < 0) nl = n;
    let ls = pos;
    while (nl - ls > max) { let cut = text.lastIndexOf(' ', ls + max); if (cut <= ls) cut = ls + max; flush(); out.push({ s: ls, e: cut }); ls = cut < nl && text[cut] === ' ' ? cut + 1 : cut; }
    if (nl > ls) {
      if (cs >= 0 && nl - cs > max) flush();
      if (cs < 0) cs = ls;
      ce = nl;
    }
    pos = nl + 1;
  }
  flush();
  return out;
}

/**
 * Score every block against the claim (rare shared words and shared figures count most; a pair of neighbouring claim words appearing together adds more) and
 * return the best blocks, each with its neighbours for context, in document order, up to `budget` characters. -> { text, chars_read, ranges, truncated, whole }
 * A text that already fits is returned whole. A claim that matches nothing gets the start of the document.
 */
function selectExcerpts(text, claim, budget) {
  if (text.length <= budget) return { text, chars_read: text.length, ranges: [[0, text.length]], truncated: false, whole: true };
  const SEP = `\n${EXCERPT_BREAK}\n`;
  const blocks = blocksOf(text);
  const N = blocks.length;
  const want = [...new Set(contentTerms(claim))];
  const figs = guardFigures(claim);
  const cwords = tokens(claim).filter((w) => !STOP.has(w)).map(stem);
  const bigrams = []; for (let i = 0; i + 1 < cwords.length; i++) bigrams.push([cwords[i], cwords[i + 1]]);
  // two passes, nothing kept per block: first how many blocks each term is in, then each block's score from its own text (a copy of the document is never built)
  const df = new Map();
  for (const b of blocks) for (const w of new Set(contentTerms(text.slice(b.s, b.e)))) df.set(w, (df.get(w) || 0) + 1);
  const idf = (w) => Math.log(1 + (N - (df.get(w) || 0) + 0.5) / ((df.get(w) || 0) + 0.5));
  const score = Array.from(blocks, (b) => {
    const t = text.slice(b.s, b.e); const tf = new Map();
    for (const w of contentTerms(t)) tf.set(w, (tf.get(w) || 0) + 1);
    let s = 0;
    for (const w of want) { const n = tf.get(w); if (n) s += idf(w) * (1 + 0.4 * Math.min(n - 1, 3)) * (/\d/.test(w) ? 1.5 : 1); }
    if (bigrams.length) { let low = null; for (const [a, c] of bigrams) if (tf.has(a) && tf.has(c)) { low = low || t.toLowerCase(); if (low.includes(`${a} ${c}`)) s += 0.7 * (idf(a) + idf(c)); } }
    if (figs.length) { const have = figuresOf(t); for (const f of figs) if (figureMatches(f, have)) s += 4; }
    return s;
  });
  const order = score.map((s, i) => [s, i]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(([, i]) => i);
  if (!order.length) order.push(0);
  const sel = new Set(); let used = 0;
  const len = (i) => blocks[i].e - blocks[i].s + 1;
  const cost = (i) => len(i) + (sel.has(i - 1) || sel.has(i + 1) ? 0 : SEP.length);   // a block that joins an excerpt needs no break line
  const take = (i) => { if (i < 0 || i >= N || sel.has(i)) return false; if (used + cost(i) > budget) return false; used += cost(i); sel.add(i); return true; };
  for (const i of order) {
    if (!take(i) && !sel.has(i)) continue;
    take(i - 1); take(i + 1);
    if (budget - used < 120) break;
  }
  const idx = [...sel].sort((a, b) => a - b);
  const ranges = []; const parts = [];
  for (const i of idx) {
    const last = ranges[ranges.length - 1];
    if (last && i === last.lastBlock + 1) { last.e = blocks[i].e; last.lastBlock = i; } else ranges.push({ s: blocks[i].s, e: blocks[i].e, lastBlock: i });
  }
  for (const r of ranges) parts.push(text.slice(r.s, r.e));
  const out = parts.join(SEP);
  return { text: out, chars_read: ranges.reduce((a, r) => a + (r.e - r.s), 0), ranges: ranges.map((r) => [r.s, r.e]), truncated: true, whole: false };
}

// ---------------------------------------------------------------- what is kept of a source after the model's excerpts are chosen
/** [start, end) in `raw` of the part that becomes normWs(raw)[ns, ns + len) */
function rawSpan(raw, ns, len) {
  let ni = 0; let prevSpace = true; let rs = -1;
  for (let i = 0; i < raw.length; i++) {
    const sp = /\s/.test(raw[i]);
    if (sp) { if (prevSpace) continue; prevSpace = true; } else prevSpace = false;
    if (ni === ns && rs < 0) rs = i;
    ni++;
    if (ni === ns + len) return [rs < 0 ? i : rs, i + 1];
  }
  return [Math.max(rs, 0), raw.length];
}
/**
 * The part of a source the model is shown, and the only part of it kept after this: the excerpts at `ranges` ([start, end) in `text`), each with the injection rules applied
 * and whitespace collapsed. -> { shown (what the prompt carries), norm (the segments joined by a line feed, which no quote contains, so a quote never matches across two),
 * redacted (lines removed), locate(at, len) -> [start, end) of a quote found at `at` in norm, in the extracted text }. A quote is checked against `norm` only.
 */
function shownSource(text, ranges) {
  const segs = ranges.map(([a, b]) => { const r = module.exports.redactInjections(text.slice(a, b)); return { start: a, text: r.text, norm: normWs(r.text), redacted: r.redacted, at: 0 }; });
  let off = 0; for (const g of segs) { g.at = off; off += g.norm.length + 1; }
  return {
    shown: segs.map((g) => g.text).join(`\n${EXCERPT_BREAK}\n`),
    norm: segs.map((g) => g.norm).join('\n'),
    redacted: segs.reduce((n, g) => n + g.redacted, 0),
    locate(at, len) { let g = segs[0]; for (const x of segs) if (x.at <= at) g = x; const [a, b] = rawSpan(g.text, at - g.at, len); return [g.start + a, g.start + b]; },
  };
}

// ---------------------------------------------------------------- injection rules over what the model sees and what it quotes
const REDACTED_LINE = '[line removed: it reads as an instruction to an AI model]';
/** every line the injection rules call suspicious or malicious is replaced by a marker; -> { text, redacted } */
function redactInjections(text) {
  let redacted = 0;
  const lines = text.split('\n').map((l) => { if (l.length >= 12 && R.scan(l).verdict !== 'none') { redacted++; return REDACTED_LINE; } return l; });
  return { text: redacted ? lines.join('\n') : text, redacted };
}
const quoteLooksInjected = (q) => R.scan(q).verdict !== 'none';

// ---------------------------------------------------------------- quotes
const MAX_QUOTES = 3;
const QUOTE_MIN_CHARS = 12; const QUOTE_MIN_WORDS = 3; const QUOTE_MAX_CHARS = 500;
/** is `quote` a verbatim part of `normalisedSource` (both whitespace-normalised)? the single place the route decides a quote is real */
const quoteInText = (quote, normalisedSource) => normalisedSource.includes(quote);

/**
 * sources: [{ index (1-based), url, kind, norm (the whitespace-normalised text that was shown), locate?, chars_total? }]; proposed: [{ source, text }]; claim: the claim text.
 * A quote ships only if it is within the length bounds, shares at least two words or figures with the claim (one when the claim has only one), does not read as an injection, and is found word for word
 * (whitespace aside) in a source: the one the model named, else the first source that has it. -> { kept: [{ text, source, locator }], dropped: [{ text, why }] }
 */
function verifyQuotes(proposed, sources, claim, { max = MAX_QUOTES } = {}) {
  const kept = []; const dropped = []; const seen = new Set();
  const claimTerms = new Set(contentTerms(claim));
  for (const p of proposed) {
    const q = normWs(p && p.text);
    const why = (w) => dropped.push({ text: q.slice(0, 120), why: w });
    if (q.length < QUOTE_MIN_CHARS || q.split(' ').length < QUOTE_MIN_WORDS) { why('too short'); continue; }
    if (q.length > QUOTE_MAX_CHARS) { why('too long'); continue; }
    if (seen.has(q)) { why('duplicate'); continue; }
    if (module.exports.quoteLooksInjected(q)) { why('reads as an instruction to an AI model'); continue; }
    if (contentTerms(q).filter((w) => claimTerms.has(w)).length < Math.min(2, claimTerms.size)) { why('shares too little with the claim'); continue; }
    const named = sources.find((s) => s.index === Number(p.source));
    const home = [named, ...sources].filter(Boolean).find((s) => module.exports.quoteInText(q, s.norm));
    if (!home) { why('not found in any fetched source'); continue; }
    seen.add(q);
    const at = home.norm.indexOf(q);
    const [from, to, total] = home.locate ? [...home.locate(at, q.length), home.chars_total] : [at, at + q.length, home.norm.length];
    kept.push({ text: q, source: home, locator: `characters ${from} to ${to} of ${total} in the extracted text (whitespace collapsed)` });
    if (kept.length >= max) break;
  }
  return { kept, dropped };
}

/** SUPPORTED needs every figure of the claim in its verified quotes. -> null when they all appear, else the first raw figure that does not */
function missingFigure(claim, quotes) {
  const have = figuresOf(quotes.map((q) => q.text).join(' \n '));
  for (const f of guardFigures(claim)) if (!figureMatches(f, have)) return f.raw;
  return null;
}

// ---------------------------------------------------------------- what can be read off the claim
/**
 * A question, a request for advice, a prediction or an explicit opinion is not a statement a source can confirm or refute. Only unmistakable forms are caught here
 * (the route answers 400, not charged); anything else goes to the model, which answers INSUFFICIENT. -> null or the reason
 */
const NOT_CHECKABLE = [
  [/\?\s*$/, 'a question'],
  [/\bshould\s+(?:i|we|you|one)\b/i, 'a request for advice'],
  [/\b(?:good|bad|great|best|right|wrong|smart|wise)\s+(?:time|idea|move|moment)\s+to\s+(?:buy|sell|hold|short|long|invest|trade|enter|exit)\b/i, 'a request for advice'],
  [/\b(?:will|going to|gonna)\s+(?:moon|pump|dump|crash|skyrocket|soar|plunge|rally|collapse|explode|double|triple)\b/i, 'a prediction'],
  [/\bprice target\b|\bto the moon\b/i, 'a prediction'],
  [/^\s*(?:i|we)\s+(?:think|believe|feel|reckon)\b|\bin my (?:humble )?opinion\b|\b(?:overrated|underrated|overvalued|undervalued)\b/i, 'an opinion'],
];
function notCheckable(claim) {
  for (const [re, what] of NOT_CHECKABLE) if (re.test(claim)) return what;
  return null;
}

/** an explicit US ticker: $AAPL, NASDAQ: AAPL, NYSE: XOM, "ticker AAPL" (a bare capitalised word is never read as one) */
function tickerOf(claim) {
  const m = /\$([A-Z]{1,5}(?:[.-][A-Z])?)\b|\b(?:NYSE(?: American| Arca)?|NASDAQ(?: GS| GM| CM)?|Nasdaq|AMEX)\s*:\s*([A-Z]{1,5}(?:[.-][A-Z])?)\b|\bticker(?: symbol)?\s*:?\s*([A-Z]{1,5}(?:[.-][A-Z])?)\b/.exec(String(claim));
  return m ? (m[1] || m[2] || m[3]) : null;
}
/** the periodic report the claim points at: 10-Q when it speaks of a quarter, else the annual 10-K */
const formHint = (claim) => (/\b10-?Q\b|\bquarter(?:ly)?\b|\bthree months\b|\b(?:first|second|third) quarter\b|\bQ[1-4]\b/i.test(claim) ? '10-Q' : '10-K');
const yearsOf = (claim) => [...new Set((String(claim).match(/\b(?:19[89]\d|20\d\d)\b/g) || []).map(Number))];

const LEAD_WORDS = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'it', 'he', 'she', 'they', 'we', 'this', 'that', 'these', 'those', 'there', 'his', 'her', 'their', 'its', 'our', 'is', 'was', 'are', 'were', 'by', 'for', 'as', 'after', 'before', 'during', 'since', 'from', 'with', 'of', 'and', 'but', 'or', 'if', 'when', 'while', 'which', 'who', 'what', 'where', 'why', 'how', 'some', 'many', 'most', 'all', 'no', 'not', 'one', 'two', 'three', 'q1', 'q2', 'q3', 'q4', 'fiscal', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
// stock exchanges and the filings regulator come up in the claims that carry a ticker; they are not what the claim is about
const NOT_AN_ARTICLE = /^(?:NYSE(?: American| Arca)?|NASDAQ(?: GS| GM| CM)?|Nasdaq|AMEX|OTC|SEC|EDGAR|Form|Inc|Corp|Ltd|LLC|Co)$/;
const CAP_WORD = String.raw`\p{Lu}[\p{L}\p{N}'’.\-]*`;
const CAP_RUN = new RegExp(`${CAP_WORD}(?:\\s+(?:(?:of|the|de|del|da|di|van|von|and|for|in|on|la|le|du|des|al|bin|ibn)\\s+)?${CAP_WORD})*`, 'gu');
/** up to `max` Wikipedia article titles to try: runs of capitalised words in the claim, longer names first ("Bank of America" before "Paris"); no model */
function wikiTitlesOf(claim, max = 2) {
  const found = [];
  for (const m of String(claim).matchAll(CAP_RUN)) {
    let words = m[0].replace(/[.,;:]+$/, '').split(/\s+/);
    while (words.length && LEAD_WORDS.has(words[0].toLowerCase())) words = words.slice(1);
    while (words.length && LEAD_WORDS.has(words[words.length - 1].toLowerCase())) words = words.slice(0, -1);
    const title = words.join(' ').replace(/['’]s$/, '');
    if (title.length >= 2 && !/^\d+$/.test(title) && !NOT_AN_ARTICLE.test(title) && !found.some((f) => f.toLowerCase() === title.toLowerCase())) found.push(title);
  }
  const multi = found.filter((t) => t.includes(' ')); const single = found.filter((t) => !t.includes(' '));
  return [...multi, ...single].slice(0, max);
}

module.exports = {
  htmlToText, htmlToTextRegex, cleanText, mdToPlain, decodeEntities, normWs, tokens, contentTerms, figuresOf, mantissa, figureMatches, guardFigures,
  blocksOf, selectExcerpts, shownSource, rawSpan, redactInjections, quoteLooksInjected, quoteInText, verifyQuotes, missingFigure,
  notCheckable, tickerOf, formHint, yearsOf, wikiTitlesOf, REDACTED_LINE, EXCERPT_BREAK, MAX_QUOTES, QUOTE_MIN_CHARS, QUOTE_MAX_CHARS,
};
