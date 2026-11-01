#!/usr/bin/env node
// ops/r24-company-check-equiv.js: the v2 stream pipeline against the v1 whole-document pipeline on EVERY document in the disk cache (R24 item 5, v2). For each cached filing document (htm, html, txt) it computes
//   v1: tools/r23/claim-check/text.js htmlToText (or the plain-text paragraph rule) on the whole buffer, then the v1 analyse() of the frozen snapshot of going-concern.js
//   v2: the chunked scanner of html-stream.js (a different chunk size per run) into the line-fed analyser of tools/r24/company-check/going-concern.js
// and requires the visible text to be identical and every field of the analysis to be identical. No network. Prints the number of documents, bytes, and every difference.
// usage: node ops/r24-company-check-equiv.js [--v1 /Volumes/D/r24/v1-snapshot/going-concern.js] [--cache DIR] [--limit N]
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('../tools/r23/claim-check/text');
const H = require('../tools/r24/company-check/html-stream');
const G2 = require('../tools/r24/company-check/going-concern');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const G1 = require(arg('--v1', '/Volumes/D/r24/v1-snapshot/going-concern.js'));
const CACHE = arg('--cache', '/Volumes/D/r24/cache/company-check');
const LIMIT = Number(arg('--limit', '100000'));
const plainToLines = (s) => s.replace(/\r/g, '').split(/\n[ \t]*\n/).map((p) => p.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
const SIZES = [65536, 7919, 1000, 262144, 3];

let docs = 0; let bytes = 0; let diffs = 0; let withMentions = 0; let affirmativeDocs = 0; let k = 0;
for (const f of fs.readdirSync(CACHE).filter((x) => x.length === 69 && x.endsWith('.json'))) {
  let m; try { m = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')); } catch { continue; }
  if (m.status !== 200 || m.too_large || !/\/Archives\/edgar\/data\/.*\.(htm|html|txt)$/i.test(m.url)) continue;
  const bodyFile = path.join(CACHE, f.replace('.json', '.body')); if (!fs.existsSync(bodyFile)) continue;
  const body = fs.readFileSync(bodyFile); const html = /\.html?$/i.test(m.url);
  const text1 = html ? T.htmlToText(body) : T.cleanText(plainToLines(body.toString('utf8')));
  const a1 = G1.analyse(text1);
  const cs = SIZES[k++ % SIZES.length];
  const an = G2.makeAnalyser(); const out = [];
  const sc = (html ? H.makeHtmlScanner : H.makePlainScanner)((l) => { out.push(l); an.line(l); });
  for (let p = 0; p < body.length; p += cs) sc.push(body.subarray(p, p + cs));
  sc.end();
  const a2 = an.finish(); const text2 = out.join('\n');
  docs++; bytes += body.length; if (a1.mentions) withMentions++; if (a1.found) affirmativeDocs++;
  if (text1 !== text2) { diffs++; let i = 0; while (i < text1.length && text1[i] === text2[i]) i++; console.log(`TEXT DIFF ${m.url} chunk ${cs} at ${i}: ${JSON.stringify(text1.slice(Math.max(0, i - 30), i + 50))} | ${JSON.stringify(text2.slice(Math.max(0, i - 30), i + 50))}`); } else if (JSON.stringify(a1) !== JSON.stringify(a2)) { diffs++; console.log(`ANALYSIS DIFF ${m.url} chunk ${cs}`, JSON.stringify(a1).slice(0, 300), JSON.stringify(a2).slice(0, 300)); }
  if (docs >= LIMIT) break;
}
console.log(`documents ${docs}, ${(bytes / 1e6).toFixed(0)} MB, with a mention ${withMentions}, with an affirmative sentence ${affirmativeDocs}, differences ${diffs}`);
process.exit(diffs ? 1 : 0);
