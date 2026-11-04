#!/usr/bin/env node
// DEPLOYED AT: /opt/agentfeed-canary/canary.mjs, byte-identical to ops/agentfeed-canary-canary.mjs in the repo (versioned with the service it watches; cron runs the
// deployed file, never the repo).
// canary.mjs — keep-alive for listings nobody has bought lately.
//
// CDP drops a route from Bazaar discovery after 30 days with no settlement
// (docs.cdp.coinbase.com/x402/bazaar). A route that falls out stops being
// findable, which is the opposite of what Phase 1 and 2 paid for. This pays
// ONLY the routes that are about to lapse, from the owner's own wallet, and only
// when no real buyer has kept them alive.
//
// THIS IS THE ONLY SELF-PAYMENT ALLOWED. It is not demand and must never be
// counted as revenue: Gack9 is in OWN_WALLETS in /opt/afwatch/afwatch.js, which
// every revenue reader honours. It never pays a route a real buyer paid inside
// the window, so it cannot inflate a payer count that a curation reviewer would
// trace on-chain.
//
// Which routes, in what order (4 Nov 2026):
//   - a route that has NEVER settled is skipped and listed on one "not indexed" line: CDP lists a route only after a settled payment
//     (docs.cdp.coinbase.com/x402/seller/get-discovered), so there is no listing to keep alive; a first payment is the Bazaar refresh's job.
//   - a lapsing route priced above $0.10 is skipped (and named in the log).
//   - what is left is paid in this order: routes a non-own wallet has ever paid first, newest outside payment first; then the routes only
//     our own wallets have paid, cheapest first. There is no up-front total-cost ABORT: the per-route $1 monthly cap check stops the run,
//     and the $0.05 balance floor holds before and during the run.
//   - "own" is lib/own-traffic.js, the list /opt/afwatch/afwatch.js builds its OWN_WALLETS from.
//   - an ABORT, an ERROR or a FAILED sends one Telegram message through the bot and chat af-digest.js alerts with (/opt/liqbot/.env;
//     neither value is ever printed). Dry runs never send.
//   - the FIRST monthly-cap stop of a calendar month (UTC) sends one line: how many lapsing routes are left unpaid, their total and the earliest
//     lapse (last settlement + 30 days, UTC). Later cap stops that month stay silent; the month is kept in cap-alert.json next to the ledger.
//
// usage: node canary.mjs --dry-run     (prints what it would pay, spends nothing, sends nothing)
//        node canary.mjs               (pays)
//        node canary.mjs --test-alert  (sends one Telegram line marked TEST and exits; touches nothing else)
'use strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const DRY = process.argv.includes('--dry-run');
const TEST_ALERT = process.argv.includes('--test-alert');
const AF = '/opt/agentfeed';
const LOG = '/opt/agentfeed-canary/canary.log';
const LEDGER = '/opt/agentfeed-canary/payments.jsonl';
const CAP_STATE = '/opt/agentfeed-canary/cap-alert.json';
const OWN_TRAFFIC = '/opt/agentfeed/lib/own-traffic.js';
const TG_ENV = '/opt/liqbot/.env';
const TG_API = 'https://api.telegram.org';
const PAYER = 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Overridable ONLY so the selection can be exercised in a dry run; the cron
// never sets it, so production always uses 25.
const LAPSE_DAYS = Number(process.env.CANARY_LAPSE_DAYS || 25);  // 5 days before CDP's 30-day cutoff
const CDP_DROP_DAYS = 30;       // CDP drops a route this many days after its last settlement
const MONTHLY_CAP_USD = 1.00;   // hard ceiling per calendar month
const MIN_BALANCE_USD = 0.05;   // never drain the wallet
const PRICE_CEILING_USD = 0.10; // a lapsing route priced above this is not worth keeping alive from this wallet
const GAP_MS = 2500;

const log = (m) => { const l = `${new Date().toISOString()} ${m}`; console.log(l); try { fs.appendFileSync(LOG, l + '\n'); } catch {} };

function spentThisMonth() {
  if (!fs.existsSync(LEDGER)) return 0;
  const month = new Date().toISOString().slice(0, 7);
  let sum = 0;
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (String(r.utc || '').startsWith(month) && r.settled) sum += Number(r.usd) || 0; } catch {}
  }
  return sum;
}

// A failed balance read must never look like $0: an unreadable endpoint is a failure and the next endpoint is tried; when every endpoint fails
// usdcBalance throws and the log says ERROR. Only an answer that carries a result is a balance (an empty account list is a real $0).
const HELIUS_RPC = 'https://mainnet.helius-rpc.com/';
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
// Gack9's USDC associated token account (derived from owner + token program + mint; getTokenAccountsByOwner on the public RPC returns this same address).
const PAYER_USDC_ATA = '6Lp9vL8uNzu7FZ1YFWDW3d39dPKActtHBXU6eYdWu6pW';
const RPC_TIMEOUT_MS = 15000;

// No API key in any log line: errors name the host and the cause, never the URL, and anything shaped like api-key=... is masked on the way out.
// The same mask covers a Telegram bot URL (.../bot<id>:<token>/...), so neither secret can reach the log or an alert.
const redact = (s) => String(s).replace(/(api-key=)[^&\s"')]+/gi, '$1<redacted>').replace(/(bot)\d{4,}:[A-Za-z0-9_-]{10,}/g, '$1<redacted>');
const hostOf = (url) => new URL(url).host;

// Telegram, through the bot and chat af-digest.js uses (TG_BOT_TOKEN and TG_ALERT_CHAT in /opt/liqbot/.env). Returns { ok } or { ok: false, why }; why is
// the HTTP status and Telegram's own description, never the URL, which holds the token.
async function sendTelegram(text) {
  const env = {};
  try {
    for (const line of fs.readFileSync(TG_ENV, 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  } catch (e) { return { ok: false, why: `${TG_ENV} unreadable (${e.code || 'error'})` }; }
  if (!env.TG_BOT_TOKEN || !env.TG_ALERT_CHAT) return { ok: false, why: `TG_BOT_TOKEN or TG_ALERT_CHAT missing in ${TG_ENV}` };
  let ok = false, status = 0, desc = '';
  try {
    const r = await fetch(`${TG_API}/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_ALERT_CHAT, text: String(text).slice(0, 3900), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(20000),
    });
    status = r.status; const j = await r.json().catch(() => ({})); ok = j.ok === true; desc = j.description || '';
  } catch { desc = 'network error'; }
  return ok ? { ok: true } : { ok: false, why: `HTTP ${status} ${redact(String(desc).slice(0, 120))}` };
}

// One message per ABORT, ERROR or FAILED line (each happens at most once in a run), never in a dry run; a failed send is logged and changes nothing else
// (the exit code and the payments stay as they were).
async function sendAlert(kind, detail) {
  if (DRY) { log(`  dry run: no alert sent (${kind})`); return false; }
  const r = await sendTelegram(`AgentFeed canary ${kind}: ${redact(detail).replace(/\s+/g, ' ').slice(0, 400)} (log ${LOG})`);
  log(r.ok ? `  alert sent (${kind})` : `  alert NOT sent (${kind}): ${r.why}`);
  return r.ok;
}

// The first cap stop of a calendar month (UTC) sends one line: routes left unpaid, their total, the earliest lapse (last settlement + 30 days). Later stops that month stay
// silent. The month is kept in CAP_STATE next to the ledger and written only after the line was really sent (a failed send is tried again at the next stop); a state file
// that is missing or unreadable counts as "not alerted yet", so the failure mode is one extra line, never silence.
async function capStopAlert(left, paidNow, monthSpend) {
  const month = new Date().toISOString().slice(0, 7);
  let last = null;
  try { last = JSON.parse(fs.readFileSync(CAP_STATE, 'utf8')).month; } catch {}
  if (last === month) { log('  cap alert already sent this month; staying silent'); return; }
  const first = left.reduce((a, d) => (d.lastAny < a.lastAny ? d : a));
  const lapse = new Date(first.lastAny + CDP_DROP_DAYS * 86400000).toISOString().slice(0, 16).replace('T', ' ');
  const total = left.reduce((n, d) => n + d.usd, 0);
  const sent = await sendAlert('CAP', `monthly cap reached: ${left.length} lapsing route(s) left unpaid, $${total.toFixed(3)} in total; earliest lapse ${lapse} UTC (${first.tool}); paid this run $${paidNow.toFixed(3)}, month-to-date $${monthSpend.toFixed(3)} of $${MONTHLY_CAP_USD.toFixed(2)}; later cap stops this month stay silent`);
  if (!sent) return;
  try { fs.writeFileSync(`${CAP_STATE}.tmp`, JSON.stringify({ month, at: new Date().toISOString() }) + '\n'); fs.renameSync(`${CAP_STATE}.tmp`, CAP_STATE); }
  catch (e) { log(`  cap alert state not saved (${e.code || 'error'}); the next cap stop will alert again`); try { fs.unlinkSync(`${CAP_STATE}.tmp`); } catch {} }
}

async function rpcCall(url, method, params) {
  const host = hostOf(url);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  } catch (e) { throw new Error(`${host} ${method}: ${e.name === 'TimeoutError' ? 'timeout' : (e.cause && (e.cause.code || e.cause.message)) || e.name}`); }
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch {}
  if (j && j.error) throw new Error(`${host} ${method}: HTTP ${res.status}, rpc error ${j.error.code}${j.error.message ? ' ' + String(j.error.message).slice(0, 80) : ''}`);
  if (!res.ok) throw new Error(`${host} ${method}: HTTP ${res.status}${j ? '' : ' ' + text.slice(0, 40).replace(/\s+/g, ' ')}`);
  if (!j || j.result === undefined || j.result === null) throw new Error(`${host} ${method}: HTTP ${res.status}, no result`);
  return j.result;
}

const sumByOwner = (r) => {
  if (!r || !Array.isArray(r.value)) throw new Error('getTokenAccountsByOwner: result has no value list');
  return r.value.reduce((n, a) => n + Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
};
const fromBalance = (r) => {
  const v = r && r.value;
  if (!v || v.uiAmountString === undefined || v.uiAmountString === null) throw new Error('getTokenAccountBalance: result has no uiAmountString');
  return Number(v.uiAmountString);
};

async function usdcBalance() {
  const key = ((fs.readFileSync(`${AF}/.env`, 'utf8').match(/^HELIUS_API_KEY=(.*)$/m) || [])[1] || '').trim();
  const owner = [PAYER, { mint: USDC }, { encoding: 'jsonParsed' }];
  const attempts = [];
  if (key) attempts.push([`${HELIUS_RPC}?api-key=${key}`, 'getTokenAccountsByOwner', owner, sumByOwner]);
  else log('  balance: HELIUS_API_KEY not readable; skipping Helius');
  attempts.push([PUBLIC_RPC, 'getTokenAccountsByOwner', owner, sumByOwner]);
  attempts.push([PUBLIC_RPC, 'getTokenAccountBalance', [PAYER_USDC_ATA], fromBalance]);
  const failures = [];
  for (const [url, method, params, parse] of attempts) {
    try {
      const bal = parse(await rpcCall(url, method, params));
      if (!Number.isFinite(bal) || bal < 0) throw new Error(`${hostOf(url)} ${method}: unusable amount`);
      if (failures.length) log(`  balance read from ${hostOf(url)} ${method} after: ${failures.join('; ')}`);
      return bal;
    } catch (e) { failures.push(redact(e.message)); }
  }
  throw new Error(`Gack9 USDC balance unreadable on every endpoint: ${failures.join('; ')}`);
}

// The own-wallet test is the repository's list (lib/own-traffic.js), the one /opt/afwatch/afwatch.js builds its OWN_WALLETS from. If it does not load, or does
// not hold Gack9 itself, "outside buyer" would be meaningless, so the run stops with an ERROR instead of guessing.
function ownWalletTest() {
  const own = createRequire(import.meta.url)(OWN_TRAFFIC);
  if (typeof own.isOwnWallet !== 'function' || !own.isOwnWallet(PAYER)) throw new Error(`own-wallet list ${OWN_TRAFFIC} did not load or does not hold ${PAYER}`);
  return own.isOwnWallet;
}

/** Last settlement per tool from ANY payer, and separately from anyone who is not one of our own wallets. */
function lastSettlements(isOwn) {
  const db = new DatabaseSync(`${AF}/agentfeed.db`, { readOnly: true });
  const rows = db.prepare(`SELECT tool, payer_wallet, MAX(ts) AS ts FROM calls WHERE status = 'paid' GROUP BY tool, payer_wallet`).all();
  db.close();
  const m = new Map();
  for (const r of rows) {
    const ts = Number(r.ts) || 0;
    const e = m.get(r.tool) || { last_any: 0, last_outside: 0 };
    if (ts > e.last_any) e.last_any = ts;
    if (r.payer_wallet && !isOwn(r.payer_wallet) && ts > e.last_outside) e.last_outside = ts;
    m.set(r.tool, e);
  }
  return m;
}

function routeUrl(pattern, meta) {
  let p = pattern.replace('GET ', '');
  for (const [k, v] of Object.entries((meta && meta.pathParams) || {})) p = p.replace(`:${k}`, encodeURIComponent(String(v)));
  const qs = new URLSearchParams(Object.entries((meta && meta.input) || {}).map(([k, v]) => [k, String(v)])).toString();
  return `https://x402.ochinimus.app${p}${qs ? `?${qs}` : ''}`;
}

(async () => {
  if (TEST_ALERT) {
    const r = await sendTelegram('AgentFeed canary TEST: alert path check from canary.mjs --test-alert. Nothing is wrong; ignore this message.');
    log(r.ok ? '  test alert sent' : `  test alert NOT sent: ${r.why}`);
    process.exit(r.ok ? 0 : 1);
  }
  const META = JSON.parse(fs.readFileSync(`${AF}/bazaar-examples.json`, 'utf8')).routes;
  const seen = lastSettlements(ownWalletTest());
  const now = Date.now();
  const cutoff = now - LAPSE_DAYS * 86400000;
  const ageOf = (ts) => (ts ? Math.floor((now - ts) / 86400000) : null);

  const notIndexed = [], skipped = [], due = [];
  for (const [pattern, m] of Object.entries(META)) {
    const s = seen.get(m.tool) || { last_any: 0, last_outside: 0 };
    // Never settled: CDP lists a route only after a settled payment, so there is no listing to keep alive.
    if (!s.last_any) { notIndexed.push(m.tool); continue; }
    // THE GATE: last_any is the newest settlement from ANY
    // payer, real buyers included. If it falls inside the window the route is
    // already alive and we skip it. That is what makes "never pay a route real
    // buyers paid in the window" structural rather than a second filter -- a
    // separate outside-payer check could never fire, because last_any is by
    // definition >= the last outside settlement.
    if (s.last_any >= cutoff) continue;
    // A lapsing route whose price is above the ceiling (or missing: a NaN price would slip past the cap check) is left alone and named in the log.
    if (!(m.price_usd > 0) || m.price_usd > PRICE_CEILING_USD) { skipped.push(`${m.tool} ${m.price_usd > 0 ? '$' + m.price_usd : 'no price'} (${ageOf(s.last_any)}d)`); continue; }
    due.push({ tool: m.tool, pattern, usd: m.price_usd, url: routeUrl(pattern, m), ageDays: ageOf(s.last_any), outsideDays: ageOf(s.last_outside), lastOutside: s.last_outside, lastAny: s.last_any });
  }
  // Pay order: routes a non-own wallet has ever paid first (newest outside payment first), then the routes only our own wallets have paid, cheapest first.
  due.sort((a, b) => (b.lastOutside > 0) - (a.lastOutside > 0) || b.lastOutside - a.lastOutside || a.usd - b.usd || (a.tool < b.tool ? -1 : 1));
  const payable = due;
  const cost = payable.reduce((n, d) => n + d.usd, 0);
  const spent = spentThisMonth();
  const bal = await usdcBalance();

  log(`${DRY ? 'DRY RUN' : 'RUN'}: ${Object.keys(META).length} routes, ${payable.length} with no settlement in ${LAPSE_DAYS}d, cost $${cost.toFixed(3)}`);
  if (notIndexed.length) log(`  not indexed (never settled; CDP lists a route only after a settled payment, nothing to keep alive): ${notIndexed.length} routes: ${notIndexed.join(', ')}`);
  if (skipped.length) log(`  skipped (lapsing but priced above $${PRICE_CEILING_USD.toFixed(2)} or unpriced): ${skipped.join(', ')}`);
  log(`  month-to-date canary spend $${spent.toFixed(3)} of $${MONTHLY_CAP_USD.toFixed(2)} cap | Gack9 balance $${bal.toFixed(3)} (floor $${MIN_BALANCE_USD.toFixed(2)})`);
  if (!payable.length) { log('  nothing is close to lapsing; no payment needed'); return; }
  for (const d of payable) log(`  would pay ${d.tool} $${d.usd} — last settlement ${d.ageDays === null ? 'never' : d.ageDays + 'd ago'}, last outside buyer ${d.outsideDays === null ? 'never' : d.outsideDays + 'd ago'}`);

  if (DRY) return;
  if (bal < MIN_BALANCE_USD) {
    const why = `balance $${bal.toFixed(3)} is below the $${MIN_BALANCE_USD} floor; ${payable.length} lapsing route(s) not paid`;
    log(`  ABORT: ${why}`); await sendAlert('ABORT', why); return;
  }

  let running = spent;
  for (let i = 0; i < payable.length; i++) {
    const d = payable[i];
    if (running + d.usd > MONTHLY_CAP_USD) {
      log(`  stop: monthly cap reached at ${d.tool}`);
      await capStopAlert(payable.slice(i), running - spent, running);
      break;
    }
    if (bal - (running - spent) - d.usd < MIN_BALANCE_USD - 1e-9) {
      const why = `paying ${d.tool} $${d.usd} would leave Gack9 below the $${MIN_BALANCE_USD} floor (balance $${bal.toFixed(3)}, paid this run $${(running - spent).toFixed(3)})`;
      log(`  ABORT: ${why}`); await sendAlert('ABORT', why); break;
    }
    let out = '';
    try { out = execFileSync('node', ['test-client.mjs', d.url, './payer-wallet.json'], { cwd: AF, encoding: 'utf8', timeout: 90000 }); }
    catch (e) { out = String((e.stdout || '') + (e.stderr || '') + e.message); }
    const ok = /^status: 200/m.test(out) && /"success": true/.test(out);
    const tx = (out.match(/"transaction": "([^"]+)"/) || [])[1] || null;
    if (ok) running += d.usd;
    fs.appendFileSync(LEDGER, JSON.stringify({ utc: new Date().toISOString(), tool: d.tool, usd: d.usd, url: d.url, settled: ok, tx }) + '\n');
    log(`  ${ok ? 'SETTLED' : 'FAILED '} ${d.tool} $${d.usd}${tx ? ' ' + tx.slice(0, 20) + '…' : ''}`);
    if (!ok) { await sendAlert('FAILED', `${d.tool} $${d.usd} did not settle; the run stopped on it`); log('  stopping on the first route that did not settle'); break; }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  log(`  done; canary spend this month now $${running.toFixed(3)}`);
})().catch(async (e) => { const m = redact(e.message); log(`ERROR ${m}`); await sendAlert('ERROR', m); process.exit(1); });
