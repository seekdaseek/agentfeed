// ops/r24-txprecheck-gate.mjs: the SCORING RUN of the tx-precheck gate (GATES-r24.md section 4): the 12 crafted transactions of ops/r24-txprecheck-cases.mjs are simulated live through the route's own
// handler and scored with the rule "every risky case carries a warning with the expected id AND no benign case carries any warning".
//   node ops/r24-txprecheck-gate.mjs --out <dir> [--expect-code <sha256>]                      from the Mac (public RPC endpoints)
//   node --env-file=/opt/agentfeed/.env ops/r24-txprecheck-gate.mjs --out <dir>                from a scratch copy of the repo on the box (the keyed RPC); it never prints a key or a URL, only hosts
//   node ops/r24-txprecheck-gate.mjs --out <dir> --selftest                                    checks THIS SCRIPT (scoring, retries, output) against the fake worlds of the tests, not the live cases
// Policy fixed BEFORE the run (written in the registered case list): the run is made ONCE per case list; the cases are sent one at a time, 1.5 s apart; an answer of status 503 ("Not charged", the RPC
// could not answer) is sent again up to 2 more times, 5 s apart, and every attempt is recorded; a case with no answer at the end counts as a miss; nothing is tuned after the run.
// No key is read or printed: the only environment this script reads is what lib/solrpc.js and tools/r24/txprecheck/base-rpc.js already read. It signs nothing and sends nothing.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const OUT = arg('--out'); const EXPECT = arg('--expect-code'); const SELFTEST = process.argv.includes('--selftest');
if (!OUT) { console.error('usage: node ops/r24-txprecheck-gate.mjs --out <dir> [--expect-code <sha256>]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

// ---- count the JSON-RPC methods every case sends, per host (hosts only: a URL can carry a key and is never printed)
const realFetch = globalThis.fetch.bind(globalThis);
let counts = {};
globalThis.fetch = async (input, init) => {
  try {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const host = new URL(url).host;
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    for (const m of Array.isArray(body) ? body : [body]) if (m && m.method) { const k = `${host} ${m.method}`; counts[k] = (counts[k] || 0) + 1; }
  } catch { /* counting must never break a call */ }
  return realFetch(input, init);
};

const { CU, DEFAULT_CU } = require(path.join(ROOT, 'lib/rpc-throttle'));
const SR = require(path.join(ROOT, 'lib/solrpc'));
const T = require(path.join(ROOT, 'tools/r24/txprecheck'));
const { makeBaseRpc } = require(path.join(ROOT, 'tools/r24/txprecheck/base-rpc'));
const { buildCases } = await import('./r24-txprecheck-cases.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SOLANA_METHODS = new Set(['getMultipleAccounts', 'simulateTransaction', 'getAccountInfo', 'getTokenLargestAccounts', 'getBalance', 'getLatestBlockhash', 'getTokenAccountsByOwner']);
const cuOf = (c) => Object.entries(c).filter(([k]) => SOLANA_METHODS.has(k.split(' ')[1])).reduce((s, [k, n]) => s + n * (CU[k.split(' ')[1]] ?? DEFAULT_CU), 0);

// ---- the code under test
const files = fs.readdirSync(path.join(ROOT, 'tools/r24/txprecheck')).filter((f) => f.endsWith('.js')).sort();
const fileHashes = Object.fromEntries(files.map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'tools/r24/txprecheck', f))).digest('hex')]));
const codeState = crypto.createHash('sha256').update(files.map((f) => `${f}\n${fileHashes[f]}\n`).join('')).digest('hex');
const scriptHash = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'ops', f))).digest('hex');
const startedAt = new Date().toISOString();

const base = makeBaseRpc();
let built; let run = T.entries[0].run;
if (SELFTEST) {
  // 12 cases over the fake worlds of the unit tests: the script's own mechanics (scoring, the 503 retry, the files), with a deliberate miss and a deliberate 503
  const S = require(path.join(ROOT, 'test/fixtures/r24/txprecheck/scenarios'));
  const B = require(path.join(ROOT, 'test/fixtures/r24/txprecheck/build'));
  const W = require(path.join(ROOT, 'test/fixtures/r24/txprecheck/evm-world'));
  const sol = B.stubSol(S.solWorld()); const bw = W.makeEvmWorld(S.baseWorld());
  run = T.makeEntries({ sol: { rpc: sol.rpc, now: Date.now, solRisk: async () => { throw new Error('x'); } }, base: { base: { request: bw.request }, now: Date.now, baseRisk: async () => { throw new Error('x'); } } })[0].run;
  const mkc = (n, kind, expected, query) => ({ n, id: `selftest-${n}`, chain: query.chain, kind, risky_type: kind === 'risky' ? 'selftest' : undefined, expected, what: 'selftest', query });
  const q = (name) => ({ chain: 'solana', tx: S.tx[name]() });
  const bq = (to, data, value = '0') => ({ chain: 'base', from: S.ADDR.me, to, data, value });
  built = { facts: { selftest: true }, cases: [mkc(1, 'benign', null, q('ok')), mkc(2, 'benign', null, q('ok')), mkc(3, 'benign', null, q('fail')), mkc(4, 'benign', null, bq(S.ADDR.weth, '0xd0e30db0', '1000')), mkc(5, 'benign', null, bq(S.ADDR.weth, '0xd0e30db0', '1000')), mkc(6, 'benign', null, q('ok')),
    mkc(7, 'risky', 'unlimited_approval', q('approve')), mkc(8, 'risky', 'delegate_granted', q('approve')), mkc(9, 'risky', 'close_account_to_other', q('ok')) /* a deliberate miss */, mkc(10, 'risky', 'unlimited_approval', bq(S.ADDR.usdc, '0x095ea7b3')), mkc(11, 'risky', 'unknown_program', q('down')) /* a deliberate 503 */, mkc(12, 'risky', 'approval_to_unknown_spender', bq(S.ADDR.usdc, '0x095ea7b3'))] };
} else {
  built = await buildCases({ sol: (m, p) => SR.rpc(m, p), base: (m, p) => base.request(m, p), honeypot: (t) => require(path.join(ROOT, 'tools/honeypot')).getHoneypotCheck({ token: t, chain: 'base' }), now: Date.now });
}
counts = {};
const results = [];
for (const c of built.cases) {
  const attempts = []; let answer = null; let error = null;
  const t0 = Date.now(); counts = {};
  for (let k = 0; k < 3; k++) {
    try { answer = await run({ ...c.query }); attempts.push({ ok: true }); error = null; break; } catch (e) {
      error = { status: e.status || (e.kind === 'bad_request' ? 400 : 500), message: String(e.message).slice(0, 300) };
      attempts.push({ ok: false, ...error });
      if (error.status !== 503) break;
      if (k < 2) await sleep(5000);
    }
  }
  const ms = Date.now() - t0;
  const ids = answer ? answer.warnings.map((w) => w.id) : null;
  const ok = !!answer && (c.kind === 'risky' ? ids.includes(c.expected) : ids.length === 0);
  const rpc = { ...counts };
  results.push({ n: c.n, id: c.id, chain: c.chain, kind: c.kind, risky_type: c.risky_type || null, expected: c.expected, what: c.what, answered: !!answer, correct: ok, warning_ids: ids, simulation_ok: answer ? answer.simulation.ok : null, simulation_error: answer ? answer.simulation.error : null, ms, attempts, rpc_calls: rpc, alchemy_cu_if_all_solana_calls_went_to_alchemy: cuOf(rpc), query: c.query, answer, error });
  console.log(`${String(c.n).padStart(2)} ${c.id.padEnd(34)} ${c.kind.padEnd(6)} expect ${(c.expected || '(none)').padEnd(26)} got [${ids ? ids.join(',') : 'NO ANSWER ' + (error && error.status)}] sim_ok=${answer ? answer.simulation.ok : '-'} ${ms}ms ${ok ? 'OK' : 'MISS'}`);
  await sleep(1500);
}

const answered = results.filter((r) => r.answered).length;
const riskyOk = results.filter((r) => r.kind === 'risky' && r.correct).length; const benignOk = results.filter((r) => r.kind === 'benign' && r.correct).length;
const pass = answered === 12 && riskyOk === 6 && benignOk === 6;
const summary = {
  gate: 'GATES-r24.md section 4 (tx-precheck)', started_at: startedAt, finished_at: new Date().toISOString(), result: pass ? 'PASS' : 'FAIL', answered, risky_with_expected_warning: `${riskyOk}/6`, benign_without_any_warning: `${benignOk}/6`,
  code_state_sha256: codeState, code_state_matches_registered: EXPECT ? EXPECT === codeState : null, file_sha256: fileHashes, scripts_sha256: { 'r24-txprecheck-cases.mjs': scriptHash('r24-txprecheck-cases.mjs'), 'r24-txprecheck-gate.mjs': scriptHash('r24-txprecheck-gate.mjs') },
  facts: built.facts, node: process.version, rpc_hosts_in_use: { solana_primary_configured: !!SR.RPC_URL(), base: base.urls.map((u) => new URL(u).host) },
};
const stamp = startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const file = path.join(OUT, `GATES-r24-4-run-${stamp}.json`);
fs.writeFileSync(file, JSON.stringify({ summary, results }, null, 1));
console.log(`\n${summary.result}: answered ${answered}/12, risky ${summary.risky_with_expected_warning}, benign ${summary.benign_without_any_warning}`);
console.log(`code state ${codeState}${EXPECT ? (EXPECT === codeState ? ' (matches the registered list)' : ' (DOES NOT match the registered list)') : ''}`);
console.log(`raw output: ${file}`);
process.exit(0);
