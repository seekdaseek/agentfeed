// ops/r23-claimcheck-gate.mjs: the claim-check gate (R23 T4): 20 hand-made claims from 4 fixed SEC filings, 10 true and 10 false. PASS = at least 17 of 20 correct
// (true -> SUPPORTED, false -> CONTRADICTED; INSUFFICIENT or an error is not correct) AND no verdict without a verified quote.
//
//   live gate (needs the key; the box):    node --env-file=.env ops/r23-claimcheck-gate.mjs [--claims test/fixtures/r23/claimcheck/claims.json] [--max-usd 0.5]
//   no key (the Mac): the same command runs the OFFLINE CHECK only (claims file integrity, passages found in the filings, how much of each filing the model would be shown) and
//                     says plainly that the live gate was not run (exit code 2).
//   options:  --cache <dir>    where the filing HTML is kept (default: $CLAIMCHECK_GATE_CACHE, else ./claimcheck-gate-cache under the repo this script is in; a missing file is
//                              downloaded once from sec.gov at one request a second with the declared User-Agent, about 9 MB for the four)
//             --only A1,N3     run these claim ids   --offline   force the offline check even with a key   --delay-ms 400   pause between claims
// It uses only paths relative to the repo it sits in (a scratch copy with node_modules symlinked works) and the process environment; the box's .env supplies GEMINI_API_KEY.
// The key is read from GEMINI_API_KEY in the environment (the name tools/llm/gemini.js reads) and is never printed. The script caps its own spend: --max-usd (default 0.5)
// is checked before every claim against the worst case of one call, and the per-call and per-day caps of the route itself apply on top (an in-memory ledger).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes(`--${name}`);

const claimsPath = path.resolve(ROOT, arg('claims', 'test/fixtures/r23/claimcheck/claims.json'));
const maxUsd = Number(arg('max-usd', '0.5'));
const delayMs = Number(arg('delay-ms', '400'));
const only = arg('only', '') ? new Set(arg('only', '').split(',')) : null;
const cacheDir = path.resolve(arg('cache', process.env.CLAIMCHECK_GATE_CACHE || path.join(ROOT, 'claimcheck-gate-cache')));
const haveKey = typeof process.env.GEMINI_API_KEY === 'string' && process.env.GEMINI_API_KEY.length > 0;
const offlineOnly = flag('offline') || !haveKey;

// the gate must not touch the production counters of tools/llm/gemini.js: its usage log and daily total go to a scratch folder
if (!process.env.GEMINI_DATA_DIR) process.env.GEMINI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claimcheck-gate-'));

const T = require(path.join(ROOT, 'tools/r23/claim-check/text.js'));
const SRC = require(path.join(ROOT, 'tools/r23/claim-check/sources.js'));
const CC = require(path.join(ROOT, 'tools/r23/claim-check'));
const G = require(path.join(ROOT, 'tools/llm/gemini.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n, d = 6) => Number(n).toFixed(d);

const doc = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));
const claims = doc.claims.filter((c) => !only || only.has(c.id));

// ---------------------------------------------------------------- filings: from the cache, downloaded once when missing
fs.mkdirSync(cacheDir, { recursive: true });
let lastDownload = 0;
async function filingHtml(id) {
  const f = doc.filings[id];
  const file = path.join(cacheDir, f.file);
  if (!fs.existsSync(file)) {
    const wait = lastDownload + 1100 - Date.now(); if (wait > 0) await sleep(wait);
    const res = await fetch(f.url, { headers: { 'user-agent': SRC.SEC_UA, accept: 'text/html' }, signal: AbortSignal.timeout(30000) });
    lastDownload = Date.now();
    if (!res.ok) throw new Error(`download of ${f.url} answered HTTP ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log(`downloaded ${f.file}`);
  }
  return fs.readFileSync(file);
}
const textOf = {};
async function filingText(id) { if (!textOf[id]) textOf[id] = T.htmlToText((await filingHtml(id)).toString('utf8')); return textOf[id]; }

// ---------------------------------------------------------------- offline check
async function offlineCheck() {
  console.log(`claims file: ${path.relative(ROOT, claimsPath)} (${doc.claims.length} claims)`);
  let problems = 0; const bad = (m) => { problems++; console.log(`  PROBLEM: ${m}`); };
  const t = doc.claims.filter((c) => c.expected === 'SUPPORTED').length; const f = doc.claims.filter((c) => c.expected === 'CONTRADICTED').length;
  console.log(`  ${t} true (SUPPORTED), ${f} false (CONTRADICTED), ${new Set(doc.claims.map((c) => c.filing)).size} filings`);
  if (doc.claims.length !== 20 || t !== 10 || f !== 10) bad('the gate is 20 claims, 10 true and 10 false');
  const ids = new Set(); let recall = 0; let found = 0; let accepted = 0;
  for (const c of doc.claims) {
    if (ids.has(c.id)) bad(`duplicate id ${c.id}`); ids.add(c.id);
    if (!doc.filings[c.filing]) { bad(`${c.id}: unknown filing ${c.filing}`); continue; }
    if (c.expected === 'CONTRADICTED' && !c.altered) bad(`${c.id}: a false claim names what was altered`);
    const norm = T.normWs(await filingText(c.filing));
    if (norm.includes(T.normWs(c.passage))) found++; else bad(`${c.id}: the passage is not in ${c.filing}`);
    const full = await filingText(c.filing);
    const sel = T.selectExcerpts(full, c.claim, 36000);
    const kept = T.shownSource(full, sel.ranges);                 // what the route keeps of a source: the excerpts, redacted, and nothing else
    const shown = kept.norm.includes(T.normWs(c.passage));
    if (shown) recall++; else bad(`${c.id}: the passage would not be shown to the model (${sel.chars_read} of ${norm.length} characters)`);
    // the ideal answer, a model that quotes exactly the passage (cut to the 500-character limit at a word), must get through the route's own checks
    let ideal = T.normWs(c.passage); if (ideal.length > 480) ideal = ideal.slice(0, 480).replace(/\s+\S*$/, '');
    const v = T.verifyQuotes([{ source: 1, text: ideal }], [{ index: 1, norm: kept.norm, locate: kept.locate, chars_total: full.length }], c.claim);
    const gap = v.kept.length && c.expected === 'SUPPORTED' ? T.missingFigure(c.claim, v.kept) : null;
    if (v.kept.length && !gap) accepted++; else bad(`${c.id}: the passage itself would not pass the quote checks (${v.dropped.map((d) => d.why).join(', ') || `figure ${gap} not in it`})`);
  }
  console.log(`  passages found verbatim in their filing: ${found} of ${doc.claims.length}; passage inside the excerpts the model would see: ${recall} of ${doc.claims.length}; passage accepted by the quote checks and the figure guard: ${accepted} of ${doc.claims.length}`);
  console.log(problems ? `OFFLINE CHECK: ${problems} problem(s)` : 'OFFLINE CHECK: ok');
  return problems;
}

// ---------------------------------------------------------------- live gate
async function liveGate() {
  const { makeSpend } = require(path.join(ROOT, 'tools/r23/spend.js'));
  const caps = { perCall: CC.DEFAULT_CAPS.perCall, perDay: Math.max(maxUsd, CC.DEFAULT_CAPS.perCall) };
  const spend = makeSpend({ file: ':memory:', caps: { [CC.SCOPE]: caps } });
  const tally = { tokensIn: 0, tokensOut: 0, usd: 0, calls: 0 };
  const fetchImpl = async (url, opts) => {
    const res = await fetch(url, opts); tally.calls++;
    try { const c = G.costOf(G.MODEL.default, (await res.clone().json()).usageMetadata || {}); tally.usd += c.usd; tally.tokensIn += c.tokens_in; tally.tokensOut += c.tokens_out + c.tokens_thoughts; } catch { /* not a usage body */ }
    return res;
  };
  const fetchSecDoc = async (href) => {
    const id = Object.keys(doc.filings).find((k) => doc.filings[k].url === href);
    if (!id) throw new Error(`the gate only reads its own filings (${href})`);
    return { url: href, status: 200, contentType: 'text/html', body: await filingHtml(id) };
  };
  const deps = { fetchImpl, fetchSecDoc, spend, caps, key: process.env.GEMINI_API_KEY, cache: SRC.makeCache({ max: 4 }) };
  const worst = caps.perCall;
  const rows = []; let stopped = false;
  console.log(`\nLIVE GATE: ${claims.length} claim(s), model ${G.MODEL.default}, spend cap ${maxUsd} USD (this run), per-call cap ${caps.perCall} USD${/stub-gemini/.test(process.env.NODE_OPTIONS || '') ? ' -- A STAND-IN FOR THE API IS INSTALLED (NODE_OPTIONS): NOT THE GATE' : ''}`);
  for (const c of claims) {
    if (tally.usd + worst > maxUsd) { stopped = true; rows.push({ c, got: 'SKIPPED', note: 'the script spend cap was reached', ok: false }); continue; }
    const before = { ...tally }; const t0 = Date.now();
    let got; let result = null; let note = '';
    try { result = await CC.claimCheck({ claim: c.claim, urls: doc.filings[c.filing].url }, deps); got = result.verdict; note = result.confidence_note; } catch (e) { got = `ERROR ${e.status || (e.kind === 'bad_request' ? 400 : '')}`.trim(); note = String(e.message).slice(0, 160); }
    // an independent re-check of the shipped quotes against the filing text (not the route's own code path)
    const norm = T.normWs(await filingText(c.filing));
    const unverified = result ? result.quotes.filter((q) => !norm.includes(T.normWs(q.text))).length + (result.verdict !== 'INSUFFICIENT' && result.quotes.length === 0 ? 1 : 0) : 0;
    const ok = got === c.expected && unverified === 0;
    rows.push({ c, got, ok, unverified, quotes: result ? result.quotes.length : 0, ms: Date.now() - t0, tin: tally.tokensIn - before.tokensIn, tout: tally.tokensOut - before.tokensOut, usd: tally.usd - before.usd, note, firstQuote: result && result.quotes[0] ? result.quotes[0].text : null });
    const r = rows[rows.length - 1];
    console.log(`${c.id.padEnd(3)} expected ${c.expected.padEnd(12)} got ${String(got).padEnd(12)} ${ok ? 'ok ' : 'NO '} quotes ${r.quotes} unverified ${r.unverified} tokens ${r.tin}/${r.tout} usd ${fmt(r.usd)} ${r.ms}ms`);
    if (!ok) console.log(`      note: ${note}`);
    await sleep(delayMs);
  }
  const done = rows.filter((r) => r.got !== 'SKIPPED');
  const correct = rows.filter((r) => r.ok).length;
  const unverified = rows.reduce((a, r) => a + (r.unverified || 0), 0);
  const insuff = rows.filter((r) => r.got === 'INSUFFICIENT').length; const errs = rows.filter((r) => String(r.got).startsWith('ERROR')).length; const wrong = done.length - correct - insuff - errs;
  console.log(`\nSUMMARY: ${correct} of ${claims.length} correct; ${wrong} wrong verdict, ${insuff} INSUFFICIENT, ${errs} error, ${rows.length - done.length} skipped; verdicts without a verified quote: ${unverified}`);
  const trueRows = rows.filter((r) => r.c.expected === 'SUPPORTED'); const falseRows = rows.filter((r) => r.c.expected === 'CONTRADICTED');
  console.log(`  true claims answered SUPPORTED: ${trueRows.filter((r) => r.ok).length} of ${trueRows.length}; false claims answered CONTRADICTED: ${falseRows.filter((r) => r.ok).length} of ${falseRows.length}`);
  const calls = done.length || 1;
  console.log(`  cost: ${tally.tokensIn} tokens in, ${tally.tokensOut} out over ${tally.calls} model call(s), ${fmt(tally.usd)} USD; per claim about ${Math.round(tally.tokensIn / calls)} in / ${Math.round(tally.tokensOut / calls)} out, ${fmt(tally.usd / calls)} USD`);
  const pass = !stopped && claims.length === 20 && correct >= 17 && unverified === 0;
  const standIn = /stub-gemini/.test(process.env.NODE_OPTIONS || '');            // the test of this script runs it against a stand-in for the API: that is not the gate
  console.log((pass ? 'GATE PASS (at least 17 of 20 correct and zero verdicts without a verified quote)' : `GATE FAIL (needs all 20 claims run, at least 17 correct, zero unverified${stopped ? '; the run stopped at the script spend cap' : ''})`) + (standIn ? ' -- STAND-IN MODEL, NOT THE GATE' : ''));
  spend.close();
  return pass ? 0 : 1;
}

const problems = await offlineCheck();
if (offlineOnly) {
  console.log(haveKey ? '\nLive gate not run (--offline).' : '\nLIVE GATE NOT RUN: GEMINI_API_KEY is not set in this environment. Run it where the key is: node --env-file=.env ops/r23-claimcheck-gate.mjs');
  process.exit(problems ? 1 : 2);
}
if (problems) { console.log('\nFix the claims file before the live gate.'); process.exit(1); }
process.exit(await liveGate());
