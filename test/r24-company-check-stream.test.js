// test/r24-company-check-stream.test.js: the stream reader of company-check v2 (R24 item 5): a filing is read in chunks of any size and nothing the size of the document is held.
// What is proved: (1) the stream scanner gives the same visible text as tools/r23/claim-check/text.js htmlToText for the whole document, for every chunk size from 1 byte up, over a corpus of the
// markup that filings have (comments, script, style, the hidden inline-XBRL header, table rows, entities, multi-byte characters, a "<" in text, upper-case tags); (2) a phrase, a tag or a skipped
// element split across two chunks is found / skipped exactly as in one piece, at EVERY split point; (3) the held state stays tiny and a 120 MB document costs a fraction of what the whole-buffer
// path costs (measured in a child process with forced garbage collection). NEGATIVE CONTROLS: a reader that judges each chunk on its own (no carry) misses the phrase at split points, and the
// mutation run (ops/r24-company-check-mutation-stream.js) breaks the scanner on purpose, one rule at a time, and requires this file to fail (R24_STREAM_MODULE points at the copy).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require(process.env.R24_STREAM_MODULE || path.join(__dirname, '..', 'tools', 'r24', 'company-check', 'html-stream'));
const G = require('../tools/r24/company-check/going-concern');
const T = require('../tools/r23/claim-check/text');
const W = require('./fixtures/r24/company-check/world');

const ROOT = path.join(__dirname, '..');
const CHUNKS = [1, 2, 3, 5, 7, 16, 61, 64, 500, 100000];
function scan(buf, cs, make = H.makeHtmlScanner) {
  const out = []; const sc = make((l) => out.push(l));
  for (let p = 0; p < buf.length; p += cs) sc.push(buf.subarray(p, p + cs));
  sc.end();
  return out.join('\n');
}

const CORPUS = {
  plain: '<html><body><p>Hello world</p><div>Second block</div></body></html>',
  comment: '<p>before</p><!-- a comment with < and > and <b>tags</b> inside --><p>after</p><!----><p>x</p>',
  script_style: '<p>one</p><script type="text/javascript">var s = "</scrip" + "t>"; if (a < b && c > d) { x = "<p>no</p>"; }</script><style>p > a { color: red }</style><p>two</p><noscript><p>hidden</p></noscript><template><p>tpl</p></template><p>three</p>',
  ix_header: '<html><head><title>t</title><meta charset="utf-8"></head><body><ix:header><ix:hidden><ix:nonNumeric name="dei:X">There is substantial doubt about going concern (hidden)</ix:nonNumeric></ix:hidden><ix:references/></ix:header><div><p>Visible text</p></div></body></html>',
  header_tag_is_not_head: '<header>site header</header><p>body</p><head2>x</head2>',
  table_rows: '<table><tr><td>Net sales</td><td>1,204,331</td><td><b>(88,100)</b></td></tr><tr><td><p>cell</p><div>block</div></td><td>x</td></tr></table><p>after the table</p>',
  table_upper: '<TABLE><TR><TD>A</TD><TD>B</TD></TR></TABLE><P>Upper</P><BR>x<HR>y',
  closing_spaces: '<script>x</script ><p>a</p></tr ><p>b</p><style >y</style  >',
  entities: '<p>Fish &amp; chips &lt;3 &#8217;quoted&#8217; &#x2019; &nbsp;nbsp &copy; &unknown; &#0; &#xD800;</p>',
  multibyte: '<p>café €100 — “quoted” 😀 中文</p><p>Zoë</p>',
  stray_lt: '<p>if a < b and c<d then 3<4 and x <5 is true</p><p>a &lt; b</p><p>5 <</p><p>trailing <',
  attr_gt: '<a href="x" title="a > b">link text</a><p class="y">after</p>',
  inline: '<p>The <b>Company</b> has <i>incurred</i> losses; these <span style="x">conditions</span> raise substantial <u>doubt</u> about going concern.</p>',
  nested_tr: '<table><tr><td><table><tr><td>inner</td></tr></table></td><td>outer</td></tr></table><p>z</p>',
  paragraph_split: '<p>Management has concluded that there is no</p><p>substantial doubt about the Company’s ability to continue as a going concern.</p><p>There is substantial doubt about our ability to continue as a going concern, and this may adversely</p><p>affect our business.</p>',
};
const ALL = Object.values(CORPUS).concat([W.doc({ title: 'T', sentences: [W.SENT.affirmative, W.SENT.negated] }), W.doc({ title: 'Big', filler: 400, sentences: [W.SENT.auditor] })]);

test('the stream scanner gives the same text as htmlToText on the whole document, for every chunk size, over the corpus of markup', () => {
  let n = 0;
  for (const [name, html] of Object.entries(CORPUS).concat([['world doc', ALL[ALL.length - 2]], ['world doc, big', ALL[ALL.length - 1]]])) {
    const buf = Buffer.from(html, 'utf8'); const want = T.htmlToText(buf);
    for (const cs of CHUNKS) { assert.equal(scan(buf, cs), want, `${name}, chunk ${cs}`); n++; }
  }
  assert.ok(n >= 170);
  // control: the corpus is not trivial (the comparison would pass on empty text)
  assert.match(T.htmlToText(Buffer.from(CORPUS.table_rows)), /Net sales 1,204,331 \(88,100\)/); assert.ok(!/hidden/.test(T.htmlToText(Buffer.from(CORPUS.ix_header))) === true);
  assert.ok(T.htmlToText(Buffer.from(CORPUS.entities)).includes('Fish & chips <3'));
});

test('a phrase split by a chunk boundary is found at every split point of every chunk size; a reader that judges each chunk alone loses it (negative control)', () => {
  const html = Buffer.from(W.doc({ title: 'T', hiddenDecoy: false, filler: 3, sentences: [W.SENT.affirmative] }), 'utf8');
  const phrase = html.indexOf('substantial doubt'); assert.ok(phrase > 0);
  const find = (cs) => { const a = G.makeAnalyser(); const out = []; const sc = H.makeHtmlScanner((l) => { out.push(l); a.line(l); }); for (let p = 0; p < html.length; p += cs) sc.push(html.subarray(p, p + cs)); sc.end(); return a.finish(); };
  // every chunk size from 1 to 200 puts a boundary at a different place in "substantial doubt" and "going concern"
  for (let cs = 1; cs <= 200; cs++) { const r = find(cs); assert.equal(r.found, true, `chunk ${cs}`); assert.equal(r.quote, 'These conditions raise substantial doubt about the Company’s ability to continue as a going concern.', `chunk ${cs}`); }
  // and the same with the split at each single byte offset inside the phrase: two chunks, cut at k
  for (let k = phrase - 3; k < phrase + 40; k++) {
    const a = G.makeAnalyser(); const sc = H.makeHtmlScanner((l) => a.line(l)); sc.push(html.subarray(0, k)); sc.push(html.subarray(k)); sc.end();
    assert.equal(a.finish().found, true, `cut at ${k - phrase}`);
  }
  // NEGATIVE CONTROL: the naive way (convert each chunk on its own, no carry) misses it at some chunk size
  const naive = (cs) => { const a = G.makeAnalyser(); for (let p = 0; p < html.length; p += cs) for (const l of T.htmlToText(html.subarray(p, p + cs)).split('\n')) a.line(l); return a.finish().found; };
  let missed = 0; for (let cs = 1; cs <= 200; cs++) if (!naive(cs)) missed++;
  assert.ok(missed >= 20, `the naive per-chunk reader missed the phrase at ${missed} of 200 chunk sizes (so the sweep above can tell a lost phrase from a found one)`);
});

test('a skipped element split across chunks stays skipped: the hidden header, a script, a style and a comment, with the closing tag cut at every offset', () => {
  const doc = Buffer.from('<p>a</p><ix:header><ix:hidden>There is substantial doubt about going concern</ix:hidden></ix:header ><p>b</p><script>"substantial doubt going concern"</script><p>c</p><style>x</style><!-- substantial doubt going concern --><p>d</p>');
  const want = T.htmlToText(doc); assert.equal(want, 'a\nb\nc\nd');
  for (let k = 1; k < doc.length; k++) {
    const out = []; const sc = H.makeHtmlScanner((l) => out.push(l)); sc.push(doc.subarray(0, k)); sc.push(doc.subarray(k)); sc.end();
    assert.equal(out.join('\n'), want, `cut at ${k}`);
  }
  // a visible sentence in the same place IS read (control)
  const vis = Buffer.from('<p>a</p><p>There is substantial doubt about going concern</p>'); assert.match(scan(vis, 3), /substantial doubt about going concern/);
});

test('the plain-text scanner equals the whole-text conversion for every chunk size (paragraphs by blank lines, hard-wrapped lines joined)', () => {
  const raw = `${'The Company has suffered recurring losses and these conditions raise substantial\ndoubt about the Company\'s ability to continue as a going\nconcern.\n\n'}  \nSecond   paragraph\twith\ttabs.\r\nline two\r\n\r\n\n\nLast one without newline`;
  const whole = (s) => s.replace(/\r/g, '').split(/\n[ \t]*\n/).map((p) => p.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/[ \t]+/g, ' ').trim()).filter(Boolean).map((p) => T.cleanText(p)).filter(Boolean).join('\n');
  const want = whole(raw); assert.ok(want.split('\n').length === 3, want);
  for (const cs of CHUNKS) assert.equal(scan(Buffer.from(raw), cs, H.makePlainScanner), want, `chunk ${cs}`);
});

test('what is held between chunks stays tiny, and the text with no tag after it is cut at a space past 1 MB without changing the output', () => {
  const html = Buffer.from(W.doc({ title: 'T', filler: 200 }));
  const sc = H.makeHtmlScanner(() => {}); let max = 0;
  for (let p = 0; p < html.length; p += 97) { sc.push(html.subarray(p, p + 97)); max = Math.max(max, sc.held()); }
  sc.end(); assert.ok(max < 4096, `held ${max} bytes`);
  const words = Buffer.from(`<p>${'word '.repeat(300000)}</p>`); // 1.5 MB of text in one node
  assert.equal(scan(words, 65536), T.htmlToText(words)); assert.equal(scan(words, 65536).length > 1.4e6, true);
});

test('a document of 120 MB is scanned in a few MB while the whole-buffer way needs hundreds (child process, forced GC)', () => {
  const r = spawnSync(process.execPath, ['--expose-gc', path.join(__dirname, 'fixtures', 'r24', 'company-check', 'stream-mem.js')], { env: { PATH: process.env.PATH, AF_ROOT: ROOT }, encoding: 'utf8', timeout: 300000 });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(j.found, true); assert.ok(j.lines > 100000);
  assert.ok(j.stream_max_held_bytes < 4096, JSON.stringify(j));
  assert.ok(j.stream_peak_mb < 120 && j.stream_peak_mb < j.control_peak_mb / 2, `the stream peaked at ${j.stream_peak_mb} MB for ${j.stream_mb} MB of document (${JSON.stringify(j)})`);
  assert.ok(j.stream_after_gc_mb < 40, JSON.stringify(j));
  assert.ok(j.control_peak_mb > 150, `control: the whole-buffer way peaked at ${j.control_peak_mb} MB for ${j.control_mb} MB (${JSON.stringify(j)})`);
});
