// test/fixtures/r24/company-check/stream-mem.js: run in a child with --expose-gc by test/r24-company-check-stream.test.js. A synthetic annual report of 120 MB is generated lazily and fed in 64 KB chunks
// to the stream scanner and the analyser; the largest amount of memory in use above the start (heap + buffers, sampled at every chunk) is printed as JSON. The control does what v1 did, for a 40 MB
// document: join all the chunks and convert the whole thing; its peak must be far above the stream's.
'use strict';
const path = require('path');
const H = require(path.join(process.env.AF_ROOT, 'tools/r24/company-check/html-stream'));
const G = require(path.join(process.env.AF_ROOT, 'tools/r24/company-check/going-concern'));
const T = require(path.join(process.env.AF_ROOT, 'tools/r23/claim-check/text'));

const BLOCK = Buffer.from(`<div><p>Revenue is recognised when control transfers to the customer. Inventories are stated at the lower of cost and net realisable value &amp; the notes explain why.</p>
<table><tr><td>Net sales</td><td>1,204,331</td><td>(88,100)</td></tr><tr><td>Cost of sales</td><td>904,100</td><td>12.4%</td></tr></table>
<!-- a comment with a < and a > in it --><script>var x = "<b>not text</b>";</script><p>Management concluded that there is no substantial doubt about the Company’s ability to continue as a going concern.</p></div>\n`);
const used = () => { const m = process.memoryUsage(); return m.heapUsed + m.external; };

function* chunks(totalBytes, size = 65536) {
  let sent = 0; let buf = Buffer.alloc(0); const head = Buffer.from('<html><head><title>t</title></head><body><ix:header><ix:hidden>' + 'x'.repeat(2e6) + '</ix:hidden></ix:header>');
  buf = head;
  while (sent < totalBytes) {
    while (buf.length < size) buf = Buffer.concat([buf, BLOCK]);
    const c = buf.subarray(0, size); buf = Buffer.from(buf.subarray(size)); sent += c.length; yield Buffer.from(c);
  }
  yield Buffer.from('<p>Our auditors have expressed substantial doubt about our ability to continue as a going concern.</p></body></html>');
}

(async () => {
  global.gc(); const base = used(); let peak = 0; let held = 0; let lines = 0;
  const an = G.makeAnalyser();
  const sc = H.makeHtmlScanner((l) => { lines++; an.line(l); });
  for (const c of chunks(120e6)) { sc.push(c); peak = Math.max(peak, used() - base); held = Math.max(held, sc.held()); }
  sc.end(); const r = an.finish();
  global.gc(); const afterGc = used() - base;
  // control: the whole document in one buffer
  global.gc(); const base2 = used(); let peak2 = 0;
  const parts = []; for (const c of chunks(40e6)) { parts.push(c); peak2 = Math.max(peak2, used() - base2); }
  const whole = Buffer.concat(parts); parts.length = 0; peak2 = Math.max(peak2, used() - base2);
  const text = T.htmlToText(whole); peak2 = Math.max(peak2, used() - base2);
  console.log(JSON.stringify({ stream_mb: 120, stream_peak_mb: Math.round(peak / 1048576), stream_after_gc_mb: Math.round(afterGc / 1048576), stream_max_held_bytes: held, lines, found: r.found, mentions: r.mentions, control_mb: 40, control_peak_mb: Math.round(peak2 / 1048576), control_text_chars: text.length }));
})();
