#!/usr/bin/env node
// ops/r24-pkgcheck-gate.js: the GATES-r24 section 1 gate for pkg-check, run live from the Mac against the real registries and OSV.dev.
//   node ops/r24-pkgcheck-gate.js            the ONE scoring run: refuses if the registered case list does not match its sha256, refuses if a run file already exists
//   node ops/r24-pkgcheck-gate.js --replay   re-reads the same answers from the cache (0 live calls; a cache miss is an error); writes nothing
// It reads the REGISTERED case list (GATES-r24-1-cases.md, JSON block between the cases-json markers) and calls the tool exactly as the server does (same module, the production
// HTTP code underneath, the exact version of each case). Nothing here changes a rule, a case or a threshold.
// Responses are cached under /Volumes/D/r24/cache/pkgcheck/gate/ (key = sha256 of method, url and body); a live call is spaced 400 ms after the last.
//
// Definition of correct (GATES-r24 section 1):
//   known-bad   correct when the answer has flagged === true
//   known-good  correct when the answer has flagged === false AND no flag of severity "error" is raised for any reason
//   a case the tool cannot answer (404 / 503 / 400) is NOT correct; a known-bad case that answered with flagged false is "rated clean"
// PASS: 0 known-bad rated clean AND at least 38 of the 40 correct.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('../tools/r23/pkg-check');
const H = require('../tools/r23/pkg-check-http');

const BRIEFS = '/Volumes/D/agentfeed-briefs/r24-20261101';
const CASES_MD = path.join(BRIEFS, 'GATES-r24-1-cases.md');
const CASES_SHA = path.join(BRIEFS, 'GATES-r24-1-cases.sha256');
const RUN_JSON = path.join(BRIEFS, 'GATES-r24-1-run.json');
const RUN_TXT = path.join(BRIEFS, 'GATES-r24-1-run.txt');
const CACHE = '/Volumes/D/r24/cache/pkgcheck/gate';
const REPLAY = process.argv.includes('--replay');
fs.mkdirSync(CACHE, { recursive: true });

// ---- the registered case list, verified against its hash before anything runs ----
const md = fs.readFileSync(CASES_MD);
const hash = crypto.createHash('sha256').update(md).digest('hex');
const registered = fs.readFileSync(CASES_SHA, 'utf8').trim().split(/\s+/)[0];
if (hash !== registered) { console.error(`REFUSED: ${path.basename(CASES_MD)} sha256 ${hash} is not the registered ${registered}`); process.exit(2); }
const m = /<!-- cases-json:begin -->\s*```json\n([\s\S]*?)\n```\s*<!-- cases-json:end -->/.exec(md.toString('utf8'));
if (!m) { console.error('REFUSED: no cases-json block in the case list'); process.exit(2); }
const CASES = JSON.parse(m[1]);
if (CASES.bad.length !== 20 || CASES.good.length !== 20) { console.error(`REFUSED: the case list has ${CASES.bad.length} bad and ${CASES.good.length} good, not 20 and 20`); process.exit(2); }
if (!REPLAY && (fs.existsSync(RUN_JSON) || fs.existsSync(RUN_TXT))) { console.error(`REFUSED: ${RUN_JSON} exists. The scoring run happens once per case list; use --replay to re-read it from the cache.`); process.exit(2); }

// ---- cached HTTP with the production code underneath ----
const stats = { live: 0, cached: 0 };
let lastLive = 0;
const keyOf = (method, url, body) => crypto.createHash('sha256').update(`${method}\n${url}\n${body ? JSON.stringify(body) : ''}`).digest('hex');
async function cached(method, url, body, live) {
  const file = path.join(CACHE, `${keyOf(method, url, body)}.json`);
  if (fs.existsSync(file)) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    stats.cached++;
    return { url, status: j.status, contentType: j.contentType, headers: j.headers, body: Buffer.from(j.body, 'base64') };
  }
  if (REPLAY) throw new Error(`replay: no cached answer for ${method} ${url}`);
  const wait = lastLive + 400 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const res = await live();
  lastLive = Date.now();
  stats.live++;
  fs.writeFileSync(file, JSON.stringify({ method, url, fetched_at: new Date().toISOString(), status: res.status, contentType: res.contentType, headers: { 'retry-after': res.headers && res.headers['retry-after'] }, body: res.body.toString('base64') }));
  return res;
}
const deps = {
  now: Date.now,
  get: (url, opts) => cached('GET', url, null, () => H.get(url, opts)),
  post: (url, body, opts) => cached('POST', url, body, () => H.post(url, body, opts)),
  cacheMax: 1,
};

const label = (c) => `${c.ecosystem} ${c.name}@${c.version}`;
async function runCase(c) {
  const { check } = P.makeCheck(deps);
  const t0 = Date.now();
  try { return { ok: true, ms: Date.now() - t0, r: await check({ name: c.name, ecosystem: c.ecosystem, version: c.version }) }; }
  catch (e) { return { ok: false, ms: Date.now() - t0, status: e.status || (e.kind === 'bad_request' ? 400 : 'error'), message: e.message }; }
}
const errorFlags = (r) => r.flags.filter((f) => f.severity === 'error').map((f) => f.id);
const summary = (o) => (o.ok
  ? { version: o.r.version, flagged: o.r.flagged, highest_severity: o.r.highest_severity, advisory_count: o.r.advisory_count, malicious: o.r.malicious, advisory_ids: o.r.advisories.map((a) => a.id), flags: o.r.flags.map((f) => `${f.id}:${f.severity}`), data_gaps: o.r.data_gaps ? o.r.data_gaps.map((g) => g.part) : null, summary: o.r.advisory_summary }
  : { no_answer: true, status: o.status, message: o.message });

(async () => {
  const lines = [];
  const say = (s) => { lines.push(s); console.log(s); };
  const out = { registered_sha256: registered, ran_at: new Date().toISOString(), replay: REPLAY, bad: [], good: [] };
  say(`GATES-r24 section 1, pkg-check re-gated. Case list sha256 ${hash} (matches the registered hash). Run at ${out.ran_at}${REPLAY ? ' (REPLAY from the cache)' : ''}.`);

  say('\nKNOWN-BAD (expected: flagged true)');
  let badCorrect = 0, ratedClean = 0, badNoAnswer = 0;
  for (const c of CASES.bad) {
    const o = await runCase(c);
    const correct = o.ok && o.r.flagged === true;
    if (correct) badCorrect++; else if (o.ok) ratedClean++; else badNoAnswer++;
    const s = summary(o);
    out.bad.push({ id: c.id, case: label(c), expected: 'flagged', expected_highest_label: c.expected_highest_label, registered_osv_ids: c.osv_ids, correct, rated_clean: o.ok && !correct, got: s, ms: o.ms });
    say(`${correct ? 'PASS' : 'FAIL'}  ${c.id}  ${label(c)}  expected flagged  got ${o.ok ? `flagged=${s.flagged} highest_severity=${s.highest_severity} advisories=${s.advisory_count} [${s.advisory_ids.slice(0, 6).join(' ')}${s.advisory_ids.length > 6 ? ' ...' : ''}]` : `NO ANSWER ${s.status}: ${s.message}`}   (registered: ${c.expected_highest_label}, ${c.osv_ids.slice(0, 4).join(' ')})`);
  }
  say('\nKNOWN-GOOD (expected: flagged false and no error-severity flag)');
  let goodCorrect = 0, goodNoAnswer = 0;
  for (const c of CASES.good) {
    const o = await runCase(c);
    const errs = o.ok ? errorFlags(o.r) : [];
    const correct = o.ok && o.r.flagged === false && errs.length === 0;
    if (correct) goodCorrect++; else if (!o.ok) goodNoAnswer++;
    const s = summary(o);
    out.good.push({ id: c.id, case: label(c), expected: 'not flagged, no error flag', correct, error_flags: errs, got: s, ms: o.ms });
    say(`${correct ? 'PASS' : 'FAIL'}  ${c.id}  ${label(c)}  expected not flagged  got ${o.ok ? `flagged=${s.flagged} highest_severity=${s.highest_severity} advisories=${s.advisory_count} flags=[${s.flags.join(' ')}]${s.data_gaps ? ' gaps=' + s.data_gaps.length : ''}` : `NO ANSWER ${s.status}: ${s.message}`}`);
  }
  const correct = badCorrect + goodCorrect;
  const pass = ratedClean === 0 && correct >= 38;
  out.summary = { known_bad_correct: badCorrect, known_bad_rated_clean: ratedClean, known_bad_no_answer: badNoAnswer, known_good_correct: goodCorrect, known_good_wrong_or_unanswered: 20 - goodCorrect, known_good_no_answer: goodNoAnswer, correct_total: correct, of: 40, pass_rule: '0 known-bad rated clean AND >= 38 of 40 correct', gate_pass: pass, http_live: stats.live, http_cached: stats.cached };
  say(`\nGATE: known-bad correct ${badCorrect}/20 (rated clean ${ratedClean}, no answer ${badNoAnswer}); known-good correct ${goodCorrect}/20 (no answer ${goodNoAnswer}); total ${correct}/40 -> ${pass ? 'PASS' : 'FAIL'}   (HTTP: ${stats.live} live, ${stats.cached} from cache)`);
  if (!REPLAY) {
    fs.writeFileSync(RUN_JSON, JSON.stringify(out, null, 2));
    fs.writeFileSync(RUN_TXT, lines.join('\n') + '\n');
    console.log(`raw output kept: ${RUN_JSON} and ${RUN_TXT}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
