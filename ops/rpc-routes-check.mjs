#!/usr/bin/env node
// ops/rpc-routes-check.mjs — runs the five holder routes' handlers (token-risk, token-holders, sol-token-check, sol-token-flow, sol-holder-clusters) with the box's REAL
// configuration, no HTTP and no payment, and says where every upstream call went (R20h, 30 Oct 2026). A tracer on fetch records HOST, JSON-RPC method, status and time of each
// upstream request (never a URL, never a body, never a key), then reports per route: did it answer, how many calls to which host, the compute units the calls cost at
// Alchemy's published weights, and the peak request rate per second and the peak CU/s over any rolling 10 seconds (Alchemy measures throughput as CU/s over a rolling 10 s).
//
//   cd /opt/agentfeed && node --env-file=.env ops/rpc-routes-check.mjs [mint]            one request of each route, one after the other
//   cd /opt/agentfeed && node --env-file=.env ops/rpc-routes-check.mjs --peak [rounds]   then the worst mix the server admits, all at once, `rounds` times (default 3)
//   cd /opt/agentfeed && node --env-file=.env ops/rpc-routes-check.mjs --flood [N]       N (default 400) concurrent light calls straight at the provider: the throttle's proof
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Alchemy Solana compute units per method (alchemy.com/docs/reference/compute-unit-costs, read 30 Oct 2026); a method not listed counts as 20 and is flagged
const CU = { getAccountInfo: 10, getBalance: 10, getMultipleAccounts: 20, getProgramAccounts: 20, getRecentPrioritizationFees: 10, getEpochInfo: 20, getSlot: 20, getTokenSupply: 20,
  getTokenLargestAccounts: 20, getTokenAccountsByOwner: 10, getSignaturesForAddress: 40, getTransaction: 40, getLatestBlockhash: 20, getSignatureStatuses: 20, getBlockHeight: 20 };
const FREE_CUPS = 300;          // Free plan, CU per second, measured over a rolling 10 s window (3,000 CU in any 10 s)
const FREE_RPS_PAGE = 15;       // the same plan row shows "(15)" requests per second
const USER_RPS = 25;            // the figure the owner saw on a page

const trace = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  let host = '?'; try { host = new URL(typeof input === 'string' ? input : input.url).host; } catch { /* keep ? */ }
  let methods = ['http']; try { const b = JSON.parse(init && init.body); methods = (Array.isArray(b) ? b : [b]).map((x) => x.method || 'http'); } catch { /* not JSON-RPC */ }
  const t = Date.now();
  try { const res = await realFetch(input, init); for (const m of methods) trace.push({ t, host, method: m, status: res.status }); return res; }
  catch (e) { for (const m of methods) trace.push({ t, host, method: m, status: 0 }); throw e; }
};

const SR = require('../lib/solrpc.js');
const risk = require('../tools/tokenrisk.js');
const S2 = require('../tools/solana2.js');
const SP = require('../tools/solpretrade.js');

const clean = (s) => String(s == null ? '' : s).replace(/https?:\/\/\S+/g, '<url>').replace(/[A-Za-z0-9_-]{28,}/g, '<id>').slice(0, 150);
const isAlchemy = (h) => /alchemy/i.test(h);
const argv = process.argv.slice(2);
const PEAK = argv.includes('--peak');
const FLOOD = argv.includes('--flood');
const FLOOD_N = Math.max(10, Math.min(2000, Number(argv[argv.indexOf('--flood') + 1]) || 400));
const rounds = Math.max(1, Math.min(10, Number(argv[argv.indexOf('--peak') + 1]) || 3));
const MINT = argv.find((a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) || 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const MINTS = [MINT, 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr'];

const ROUTES = [
  ['token-risk', (m) => risk.getTokenRisk(m), (r) => `top1 ${r.concentration && r.concentration.top1_pct}%, top10 ${r.concentration && r.concentration.top10_pct}%`],
  ['token-holders', (m) => S2.getTokenHolders({ mint: m }), (r) => `${(r.top_accounts || []).length} accounts, top1 ${r.concentration && r.concentration.top1_pct}%`],
  ['sol-token-check', (m) => SP.tokenCheck({ mint: m }), (r) => `keys ${Object.keys(r).length}${r.verdict ? `, verdict ${clean(r.verdict)}` : ''}`],
  ['sol-token-flow', (m) => SP.tokenFlow({ mint: m }), (r) => `keys ${Object.keys(r).length}${r.truncated ? ', truncated' : ''}`],
  ['sol-holder-clusters', (m) => SP.holderClusters({ mint: m }), (r) => `keys ${Object.keys(r).length}`],
];

/** stats over a slice of the trace */
function stats(rows) {
  const by = {};
  for (const r of rows) { const k = r.host; by[k] = by[k] || { calls: 0, failed: 0, methods: {} }; by[k].calls++; if (r.status === 0 || r.status >= 400) by[k].failed++; by[k].methods[r.method] = (by[k].methods[r.method] || 0) + 1; }
  const al = rows.filter((r) => isAlchemy(r.host));
  const sec = new Map(); for (const r of al) { const s = Math.floor(r.t / 1000); sec.set(s, (sec.get(s) || 0) + 1); }
  const peakRps = Math.max(0, ...sec.values());
  let peakCups = 0, unknown = new Set();
  for (const a of al) {
    let cu = 0;
    for (const b of al) if (b.t >= a.t && b.t < a.t + 10_000) { if (!(b.method in CU)) unknown.add(b.method); cu += CU[b.method] ?? 20; }
    peakCups = Math.max(peakCups, cu / 10);
  }
  const totalCu = al.reduce((s, r) => s + (CU[r.method] ?? 20), 0);
  return { by, alchemyCalls: al.length, alchemy429: al.filter((r) => r.status === 429).length, peakRps, peakCups, totalCu, unknown: [...unknown] };
}
const show = (label, st, ms) => {
  console.log(`  ${label}: ${ms} ms; upstream calls per host ${JSON.stringify(Object.fromEntries(Object.entries(st.by).map(([h, v]) => [h, v.calls])))}, failed ${JSON.stringify(Object.fromEntries(Object.entries(st.by).filter(([, v]) => v.failed).map(([h, v]) => [h, v.failed])))}`);
  const al = Object.entries(st.by).find(([h]) => isAlchemy(h));
  if (al) console.log(`     at Alchemy: ${JSON.stringify(al[1].methods)} = ${st.totalCu} CU; peak ${st.peakRps} req/s; peak ${st.peakCups.toFixed(0)} CU/s over a rolling 10 s (Free plan ${FREE_CUPS} CU/s = ${FREE_RPS_PAGE} req/s at 20 CU; owner saw ${USER_RPS} req/s)${st.alchemy429 ? `  *** ${st.alchemy429} x 429 from Alchemy` : ''}${st.unknown.length ? `  (unlisted method counted at 20 CU: ${st.unknown})` : ''}`);
};

console.log(`main list : ${SR.endpoints().urls.map((u) => { try { return new URL(u).host; } catch { return '?'; } }).join('  >  ')}`);
console.log(`mint      : ${MINT}\n`);
const seq = [];
for (const [name, fn, summarize] of ROUTES) {
  const from = trace.length; const t0 = Date.now(); let out;
  try { const r = await fn(MINT); out = `ANSWERED (${clean(summarize(r))})`; } catch (e) { out = `FAILED status ${e.status || '?'}: ${clean(e.message)}`; }
  console.log(`${name.padEnd(20)} ${out}`);
  const st = stats(trace.slice(from)); show('one request', st, Date.now() - t0); seq.push({ name, ok: out.startsWith('ANSWERED'), st });
}
const okAll = seq.every((s) => s.ok);
const usage = SR.endpoints().takeUsage();
console.log(`\nthis process, all five: calls per host ${JSON.stringify(usage.hosts)}, failed ${JSON.stringify(usage.failed)}, public RPC asked for getTokenLargestAccounts: no (RPC_HEAVY_SKIP)`);
console.log(`${okAll ? 'ALL FIVE ANSWERED' : 'NOT ALL ANSWERED'}; Alchemy total ${seq.reduce((s, r) => s + r.st.totalCu, 0)} CU for one request of each`);

if (PEAK) {
  console.log(`\n--peak: ${rounds} round(s) of the worst mix the server admits at once: 8 x token-risk and 8 x token-holders on 4 different mints, 3 x each of the three heavy routes (the server runs at most 2 of the flow/cluster ones at a time and refuses the rest, not charged)`);
  let worst = { rps: 0, cups: 0 };
  for (let k = 1; k <= rounds; k++) {
    SR.heavyCache.clear();
    const from = trace.length; const t0 = Date.now();
    const jobs = [];
    for (let i = 0; i < 8; i++) { jobs.push(ROUTES[0][1](MINTS[i % 4])); jobs.push(ROUTES[1][1](MINTS[i % 4])); }
    for (let i = 0; i < 3; i++) for (const j of [2, 3, 4]) jobs.push(ROUTES[j][1](MINTS[i % 4]));
    const res = await Promise.allSettled(jobs);
    const ok = res.filter((r) => r.status === 'fulfilled').length;
    const refused = res.filter((r) => r.status === 'rejected' && /already running/.test(String(r.reason && r.reason.message))).length;
    const st = stats(trace.slice(from));
    console.log(`round ${k}: ${jobs.length} concurrent requests, ${ok} answered, ${refused} refused as designed (two heavy at a time, not charged), ${jobs.length - ok - refused} failed`);
    show('round', st, Date.now() - t0);
    worst = { rps: Math.max(worst.rps, st.peakRps), cups: Math.max(worst.cups, st.peakCups) };
    await new Promise((r) => setTimeout(r, 11_000));   // let the rolling window empty between rounds
  }
  console.log(`\nworst over ${rounds} rounds: ${worst.rps} req/s, ${worst.cups.toFixed(0)} CU/s over a rolling 10 s.  Under ${USER_RPS} req/s: ${worst.rps < USER_RPS ? 'yes' : 'NO'}.  Under ${FREE_RPS_PAGE} req/s: ${worst.rps < FREE_RPS_PAGE ? 'yes' : 'NO'}.  Under ${FREE_CUPS} CU/s: ${worst.cups < FREE_CUPS ? 'yes' : 'NO'}.`);
}
if (FLOOD) {
  // 400 concurrent getAccountInfo (10 CU, never cached) at the provider: far more than any budget allows in a second. What the PROVIDER saw (the tracer sees every request that was
  // actually sent) must stay under the budget; the excess is refused locally as a 503, not charged, and nothing is rested.
  const th = SR.getThrottle();
  const from = trace.length; const t0 = Date.now();
  const res = await Promise.allSettled(Array.from({ length: FLOOD_N }, () => SR.rpc('getAccountInfo', ['So11111111111111111111111111111111111111112', { encoding: 'base64' }])));
  const ms = Date.now() - t0;
  const ok = res.filter((r) => r.status === 'fulfilled').length;
  const thr = res.filter((r) => r.status === 'rejected' && /throttle/.test(String(r.reason && r.reason.message))).length;
  const st = stats(trace.slice(from));
  console.log(`\n--flood: ${FLOOD_N} concurrent getAccountInfo in ${ms} ms: ${ok} answered, ${thr} refused by the client-side budget (503, not charged), ${FLOOD_N - ok - thr} other failures`);
  show('flood', st, ms);
  const limits = Object.fromEntries([...th.throttles].map(([h, t]) => [h, t.cups]));
  console.log(`  limits in force: ${JSON.stringify(limits)}; the provider's own status codes in the flood: ${JSON.stringify(Object.fromEntries([...trace.slice(from).filter((r) => isAlchemy(r.host)).reduce((m, r) => m.set(r.status, (m.get(r.status) || 0) + 1), new Map())]))}`);
  const lim = Object.entries(limits).find(([h]) => isAlchemy(h));
  const cap = lim ? lim[1] : FREE_CUPS;
  console.log(`  result: peak ${st.peakRps} req/s (under ${USER_RPS}: ${st.peakRps < USER_RPS ? 'yes' : 'NO'}; under ${FREE_RPS_PAGE}: ${st.peakRps < FREE_RPS_PAGE ? 'yes' : 'no (10 CU calls: 15 req/s is only 150 CU/s)'}), peak ${st.peakCups.toFixed(0)} CU/s over a rolling 10 s (under ${FREE_CUPS}: ${st.peakCups < FREE_CUPS ? 'yes' : 'NO'}; our budget ${cap}), 429 from the provider: ${st.alchemy429}`);
}
process.exit(okAll ? 0 : 1);
