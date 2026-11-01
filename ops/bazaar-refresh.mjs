#!/usr/bin/env node
// ops/bazaar-refresh.mjs — bring Coinbase's CDP Bazaar index back in line with the live catalogue (14 Oct 2026).
//
// Why: the Bazaar re-indexes a route only when a client that fetched a fresh 402 settles a payment on it
// (ops/bazaarwatch-score.mjs measured this on 26 Sep; /validate simulates and never refreshes). So every data route
// whose index record holds an old description, or has no record at all, needs one small paid call.
//
//   node ops/bazaar-refresh.mjs            dry run (default): reads the index, validates each record, prints the plan
//   node ops/bazaar-refresh.mjs --pay      pays each planned route once through test-client.mjs, then re-reads the index
//   node ops/bazaar-refresh.mjs --check    re-reads the index only and prints "N of M match" (nothing paid)
//   --run <id>      (or RUN=<id>) this invocation belongs to run <id>: every payment is written to the tx log (PAID_LOG, default ./.bazaar-refresh-paid.jsonl) under that id, and a
//                   route that already has a tx under the id is skipped for good (whatever its age, even if STATE is gone, and AGAIN=1 does not override it). Resume a stopped
//                   run with the SAME id and it can never pay a route twice. Without --run the 6-hour state-file skip below is the only protection.
//   --defer-503     a route that answers 503 (its source is down: never billed) is deferred instead of stopping the run; the run goes on with the other routes, lists the deferred
//                   ones and exits 5. Run the same command again later and only they are paid. Any other failure still stops the run.
//   --only <route,...>  (R24, 1 Nov 2026) pay exactly these routes and no other: names are manifest paths or the same without "/api/" (pkg-check,/api/tx-precheck,paper/:doi). A name that matches no
//                   manifest route stops the script before anything is paid (exit 2); a named route the index already shows fresh is reported and left alone. Use it when one payer's balance covers
//                   only part of the list, so a pass can never reach a route that payer cannot afford; combine with the same --run id and the passes share one tx log.
//   One run pays at a time (lock file next to STATE). Every payment prints its Solscan link.
//
// Environment: PAYER (keypair file, default ./payer-wallet.json; run it from /opt/agentfeed), MAX_TOTAL (default 0.80 USD),
// ORIGIN, STATE (default ./.bazaar-refresh-state.json: a route paid within the last 6 hours is skipped, so a second run
// before CDP's index has caught up cannot pay twice; delete the file or set AGAIN=1 to override).
//
// STALE   = an index record for the route whose description differs from the live challenge description (CDP /validate on
//           the record's own URL, status 402).
// ABSENT  = a live data route with no index record at all.
// Key purchase routes (/api/keys/*) are never paid by this script. Withdrawn routes (410) cannot be refreshed and are left to age out.
// Guard: before anything is signed, each planned route's fresh Solana accept must pay TREASURY exactly the manifest price.
// One mismatch, or a total over MAX_TOTAL, and nothing is paid. Gack9 is in OWN_WALLETS: these payments are QA, not revenue.
'use strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadPaidLog, appendPaid, decide, acquireLock, classifyOutcome, solscan } from './refresh-resume.mjs';

const ORIGIN = process.env.ORIGIN || 'https://x402.ochinimus.app';
const TREASURY = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7';
const TREASURY_EVM = '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6';
const CDP = process.env.CDP_BASE || 'https://api.cdp.coinbase.com/platform/v2/x402';   // CDP_BASE: a test points it at a stub
const PAYER = process.env.PAYER || './payer-wallet.json';
const MAX_TOTAL = Number(process.env.MAX_TOTAL || 0.80);
const STATE = process.env.STATE || './.bazaar-refresh-state.json';
const SIX_H = 6 * 3600_000;
const ARGV = process.argv.slice(2);
const ARGS = new Set(ARGV);
const RUN = (ARGV.includes('--run') ? ARGV[ARGV.indexOf('--run') + 1] : process.env.RUN) || null;
const DEFER_503 = ARGS.has('--defer-503');
const PAID_LOG = process.env.PAID_LOG || './.bazaar-refresh-paid.jsonl';
const LOCK = process.env.LOCK || `${STATE}.lock`;
const RETRY_WAIT_MS = Number(process.env.RETRY_WAIT_MS ?? 5000);
const PAY = ARGS.has('--pay'), CHECK = ARGS.has('--check');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = async (u, init) => { const r = await fetch(u, { ...init, signal: AbortSignal.timeout(30000) }); if (!r.ok && !(init && init.allow)) throw new Error(`${u} -> ${r.status}`); return r.json(); };

const examples = JSON.parse(fs.readFileSync(new URL('../bazaar-examples.json', import.meta.url), 'utf8')).routes;
const wk = await J(`${ORIGIN}/.well-known/x402.json`);
// data routes only: a key purchase is not a data route and is never paid here
// R20e (29 Oct 2026): for a path-parameter route the manifest's `resource` is a CONCRETE example URL and `resource_template` is its {name} form. This script
// keys everything on the :name pattern (the bazaar-examples.json key, the index-record matcher, the payment URL), so the pattern is rebuilt from the template.
const patternPath = (r) => decodeURIComponent(new URL(r.resource_template || r.resource).pathname).replace(/\{([A-Za-z0-9_]+)\}/g, ':$1');
const manifest = wk.resources
  .map((r) => ({ path: patternPath(r), price: Number(r.price_usd) }))
  .filter((r) => !r.path.startsWith('/api/keys/'));
// --only <route,...>: the routes this invocation may pay. A name is a manifest path or the same without "/api/" ("pkg-check" = "/api/pkg-check"; a path-parameter route by its :name pattern).
// Returns { only: Set of manifest paths | null (no --only), unknown: [names that match no route] }. A bare --only, a flag in its value slot or an empty list is an error, never "everything".
function parseOnly(argv, manifestPaths) {
  const i = argv.findIndex((a) => a === '--only' || a.startsWith('--only='));
  if (i < 0) return { only: null, unknown: [] };
  const raw = argv[i].startsWith('--only=') ? argv[i].slice(7) : (argv[i + 1] || '');
  const names = raw.split(',').map((x) => x.trim()).filter(Boolean);
  if (!names.length || raw.startsWith('--')) return { only: new Set(), unknown: ['(empty --only list)'] };
  const known = new Set(manifestPaths);
  const only = new Set(), unknown = [];
  for (const n of names) {
    const path = known.has(n) ? n : (known.has('/api/' + n) ? '/api/' + n : null);
    if (path) only.add(path); else unknown.push(n);
  }
  return { only, unknown };
}
const rx = (p) => new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z_]+/g, '[^/]+') + '$');
for (const m of manifest) m.re = rx(m.path);
const routeOf = (pathname) => manifest.find((m) => m.re.test(pathname)) || null;

// ---- the index: both treasuries, paged until the total CDP states is read
async function readIndex() {
  const recs = new Map(); // resource URL -> record
  let declared = 0;
  for (const payTo of [TREASURY, TREASURY_EVM]) {
    for (let off = 0, page = 0; page < 20; page++) {
      const j = await J(`${CDP}/discovery/merchant?payTo=${payTo}&limit=100&offset=${off}`);
      const rows = j.resources || [];
      declared = Math.max(declared, j.pagination?.total ?? 0);
      for (const r of rows) if (String(r.resource).startsWith(ORIGIN + '/')) recs.set(r.resource, r);
      off += 100;
      if (rows.length < 100 || off >= (j.pagination?.total ?? 0)) break;
    }
  }
  return { recs, declared };
}

async function validate(resource) {
  const v = await J(`${CDP}/validate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resource, method: 'GET' }), allow: true });
  await sleep(300);
  return v;
}

function payUrl(m) {
  const e = examples['GET ' + m.path];
  if (!e) throw new Error(`no bazaar-examples.json entry for GET ${m.path}`);
  let path = m.path;
  for (const [k, v] of Object.entries(e.pathParams || {})) path = path.replace(':' + k, encodeURIComponent(v));
  if (/:[A-Za-z_]/.test(path)) throw new Error(`path parameter without an example value: ${path}`);
  const req = new Set((e.inputSchema && e.inputSchema.required) || []);
  const q = new URLSearchParams();
  // R24: tx-precheck needs a whole request (chain plus the from, to and data of a Base call; or a Solana tx) that no single field of its schema can require, and pkg-check is indexed with the exact version
  // its example shows: for these two every key of the example input is part of the paid call
  const wholeExample = m.path === '/api/tx-precheck' || m.path === '/api/pkg-check';
  for (const [k, v] of Object.entries(e.input || {})) if (req.has(k) || wholeExample) q.set(k, String(v));
  if (m.path === '/api/squeeze-score') q.set('symbol', 'BTC'); // a default-symbol call would also work; BTC is the one the brief names
  const qs = q.toString();
  return ORIGIN + path + (qs ? '?' + qs : '');
}

// ---- 1. what the index holds, and which records are stale
const { recs, declared } = await readIndex();
console.log(`index: ${recs.size} records on ${ORIGIN} (CDP states ${declared} for the payTo(s)); manifest data routes: ${manifest.length}`);
const byRoute = new Map(); // manifest path -> [{resource, indexed, live, status}]
const orphans = [];
const templateKeyed = [];
let n = 0;
for (const r of recs.values()) {
  const pathname = new URL(r.resource).pathname;
  if (pathname.startsWith('/api/keys/')) continue; // key purchases: never paid or judged here
  // R20i (30 Oct 2026): CDP indexes a dynamic route under the routeTemplate of its 402 (/api/wallet-activity/:wallet), so the record's URL IS the template and a paid call on a
  // concrete example URL refreshes THAT record (measured: wallet-holdings and token-metadata were paid on concrete URLs at 05:44Z and their template records, not new ones, took
  // lastUpdated 05:44:32 and 05:44:34; the total stayed 84). R20e had called these records "retired" and planned every such route as ABSENT, which pays for routes whose record is
  // already right and can never remove the record. A template-keyed record is judged like any other: its description against the live challenge of the route's example URL
  // (CDP /validate cannot be used on the template URL, our server answers it 400). Fresh = no payment.
  const isTemplate = /\/:[A-Za-z_]|%7B|\{/.test(pathname);
  const m = routeOf(pathname);
  if (!m) { orphans.push(pathname); continue; }
  if (isTemplate) {
    templateKeyed.push(pathname);
    let live = null;
    try {
      const res = await fetch(payUrl(m), { signal: AbortSignal.timeout(30000) });
      live = JSON.parse(Buffer.from(res.headers.get('payment-required') || '', 'base64').toString()).resource?.description ?? null;
    } catch { live = null; }
    n++;
    (byRoute.get(m.path) || byRoute.set(m.path, []).get(m.path)).push({ resource: r.resource, indexed: String(r.description || ''), live, status: live === null ? null : 402 });
    continue;
  }
  const v = await validate(r.resource);
  n++;
  const live = v?.paymentRequirements?.resource?.description ?? null;
  const row = { resource: r.resource, indexed: String(r.description || ''), live, status: v?.statusCode ?? null };
  (byRoute.get(m.path) || byRoute.set(m.path, []).get(m.path)).push(row);
}
console.log(`validated ${n} records (CDP /validate simulates, never settles); ${orphans.length} index records are for routes no longer in the manifest (left to age out)`);
if (templateKeyed.length) console.log(`  ${templateKeyed.length} index records are keyed by the route template (CDP's way of indexing a dynamic route), judged against the live challenge of the route's example URL: ${templateKeyed.map((t) => t.replace('/api/', '')).join(', ')}`);

let plan = []; // {m, why}
let match = 0, known = 0, unknown = 0;
for (const m of manifest) {
  const rows = byRoute.get(m.path);
  if (!rows) { plan.push({ m, why: 'ABSENT' }); continue; }
  known++;
  const bad = rows.filter((x) => x.status !== 402 || x.live === null);
  if (bad.length === rows.length) { unknown++; console.log(`  unknown (validate did not answer 402): ${m.path} status ${bad[0].status}`); continue; }
  if (rows.some((x) => x.status === 402 && x.live !== null && x.indexed !== x.live)) plan.push({ m, why: 'STALE' });
  else match++;
}
console.log(`index vs live: ${match} of ${known} indexed routes match, ${plan.filter((p) => p.why === 'STALE').length} stale, ${unknown} unknown; ${plan.filter((p) => p.why === 'ABSENT').length} data routes absent from the index`);
if (CHECK) { console.log(`N of M match: ${match} of ${known}; absent ${plan.filter((p) => p.why === 'ABSENT').length}`); process.exit(0); }

// ---- 2. skip what was already paid: under this run id (the tx log, for good), or by this script in the last six hours (the state file)
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* none yet */ }
const now = Date.now();
const { only, unknown: onlyUnknown } = parseOnly(ARGV, manifest.map((m) => m.path));
if (onlyUnknown.length) { console.error(`--only names no manifest route: ${onlyUnknown.join(', ')}: nothing was paid`); process.exit(2); }
if (only) {
  for (const p of only) if (!plan.some((x) => x.m.path === p)) console.log(`  --only ${p}: not in the plan (its index record already matches the live challenge)`);
  plan = plan.filter((p) => only.has(p.m.path));
  console.log(`--only: ${plan.length} of ${only.size} named route(s) are in the plan`);
}
const { todo: toPay, skipped } = decide({ plan, state, paidLog: loadPaidLog(PAID_LOG), run: RUN, now, sixH: SIX_H, again: !!process.env.AGAIN });
for (const k of skipped) {
  if (k.why === 'run') console.log(`  skip ${k.path}: already paid in run ${RUN} (${k.minutes} min ago) ${solscan(k.tx)}`);
  else console.log(`  skip ${k.path}: paid ${k.minutes} min ago (tx ${String(k.tx).slice(0, 12)}…), index not caught up yet`);
}
const todo = toPay.map((p) => ({ ...p, url: payUrl(p.m) }));
if (RUN) console.log(`run ${RUN}: ${skipped.filter((k) => k.why === 'run').length} route(s) already paid in this run, ${todo.length} to go`);

// ---- 3. guard: every planned route's fresh Solana accept pays the treasury exactly the manifest price
let bad = 0, total = 0;
for (const p of todo) {
  const res = await fetch(p.url, { signal: AbortSignal.timeout(30000) });
  const pr = res.headers.get('payment-required');
  let sol = null;
  try { sol = JSON.parse(Buffer.from(pr || '', 'base64').toString()).accepts.find((a) => a.network.startsWith('solana:')); } catch { /* handled below */ }
  const want = String(Math.round(p.m.price * 1e6));
  if (!(res.status === 402 && sol && sol.payTo === TREASURY && sol.amount === want)) {
    bad++; console.error(`GUARD FAIL ${p.m.path}: status ${res.status}, payTo ${sol && sol.payTo}, amount ${sol && sol.amount}, manifest ${want}`);
  }
  total += p.m.price;
}
if (bad) { console.error(`guard failed on ${bad} route(s): nothing was paid`); process.exit(3); }
console.log(`guard OK: ${todo.length} routes pay ${TREASURY} exactly the manifest price`);
for (const p of todo) console.log(`  ${PAY ? 'will pay' : 'would pay'}  ${p.why.padEnd(6)} $${p.m.price.toFixed(3).padStart(6)}  ${p.url}`);
console.log(`planned total $${total.toFixed(3)} for ${todo.length} routes (cap $${MAX_TOTAL.toFixed(2)})`);
if (total > MAX_TOTAL) { console.error(`total passes the cap: nothing was paid`); process.exit(4); }
if (!PAY) { console.log('dry run: nothing paid. Run with --pay to pay each route once.'); process.exit(0); }
if (!todo.length) { console.log('nothing to pay'); process.exit(0); }

// ---- 4. pay, one by one; stop at the first status that is not 200 or a 200 without a settlement transaction (a 503 is deferred instead with --defer-503)
let releaseLock;
try { releaseLock = acquireLock(LOCK); } catch (e) { console.error(`${e.message}: nothing was paid`); process.exit(6); }
process.on('exit', () => { try { releaseLock(); } catch { /* ignore */ } });
let paid = 0, spent = 0;
const deferred = [];
for (const p of todo) {
  let out = '', status = null, tx = null;
  for (let attempt = 1; attempt <= 2; attempt++) { // a 503 is a failed or stale source: never billed, so one retry is free
    const r = spawnSync(process.execPath, ['test-client.mjs', p.url, PAYER], { encoding: 'utf8', timeout: 120000 });
    out = (r.stdout || '') + (r.stderr || '');
    status = (out.match(/^status: (\d+)/m) || [])[1] || null;
    tx = (out.match(/"transaction": "([^"]+)"/) || [])[1] || null;
    if (status !== '503') break;
    await sleep(RETRY_WAIT_MS);
  }
  console.log(`${p.m.path.padEnd(34)} status ${status || 'none'}  tx ${tx || 'none'}${tx ? `  ${solscan(tx)}` : ''}`);
  const outcome = classifyOutcome({ status, tx, defer503: DEFER_503 });
  if (outcome === 'deferred') { deferred.push({ path: p.m.path, usd: p.m.price, why: (out.match(/"error": ?"([^"]+)"/) || out.match(/error[^\n]{0,120}/) || ['503'])[0].slice(0, 140) }); console.log(`  deferred ${p.m.path}: 503 (not billed)`); continue; }
  if (outcome === 'stop') { console.error(`STOPPED at ${p.m.path}. Client output:\n${out.split('\n').slice(0, 25).join('\n')}\npaid ${paid} calls, $${spent.toFixed(3)}`); process.exit(1); }
  paid++; spent += p.m.price;
  appendPaid(PAID_LOG, { ts: Date.now(), run: RUN, path: p.m.path, tx, usd: p.m.price });   // the tx log first: this line is what a resume trusts
  state[p.m.path] = { ts: Date.now(), tx, usd: p.m.price };
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
}
console.log(`done: ${paid} calls settled, total $${spent.toFixed(3)}`);
if (deferred.length) {
  console.log(`DEFERRED ${deferred.length} route(s) that answered 503 (their source is down; nothing was billed), $${deferred.reduce((a, d) => a + d.usd, 0).toFixed(3)} still to pay:`);
  for (const d of deferred) console.log(`  ${d.path}  ${d.why}`);
  console.log(`run the same command again when the source is back${RUN ? ` (same --run ${RUN}: everything already paid is skipped by the tx log)` : ''}`);
  process.exitCode = 5;
}
console.log('CDP re-indexes on its own schedule; re-read the index in about 10 minutes with: node ops/bazaar-refresh.mjs --check');
