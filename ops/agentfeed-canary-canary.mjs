// DEPLOYED AT: /opt/agentfeed-canary/canary.mjs — this copy is here so the script is versioned with
// the service it watches; it is not run from the repo.
#!/usr/bin/env node
// canary.mjs — keep-alive for listings nobody has bought lately.
//
// CDP drops a route from Bazaar discovery after 30 days with no settlement
// (docs.cdp.coinbase.com/x402/bazaar). A route that falls out stops being
// findable, which is the opposite of what Phase 1 and 2 paid for. This pays
// ONLY the routes that are about to lapse, from Sergiu's own wallet, and only
// when no real buyer has kept them alive.
//
// THIS IS THE ONLY SELF-PAYMENT ALLOWED. It is not demand and must never be
// counted as revenue: Gack9 is in OWN_WALLETS in /opt/afwatch/afwatch.js, which
// every revenue reader honours. It never pays a route a real buyer paid inside
// the window, so it cannot inflate a payer count that a curation reviewer would
// trace on-chain.
//
// usage: node canary.mjs --dry-run     (prints what it would pay, spends nothing)
//        node canary.mjs               (pays)
'use strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DRY = process.argv.includes('--dry-run');
const AF = '/opt/agentfeed';
const LOG = '/opt/agentfeed-canary/canary.log';
const LEDGER = '/opt/agentfeed-canary/payments.jsonl';
const PAYER = 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Overridable ONLY so the selection can be exercised in a dry run; the cron
// never sets it, so production always uses 25.
const LAPSE_DAYS = Number(process.env.CANARY_LAPSE_DAYS || 25);  // 5 days before CDP's 30-day cutoff
const MONTHLY_CAP_USD = 1.00;   // hard ceiling per calendar month
const MIN_BALANCE_USD = 0.05;   // never drain the wallet
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

async function usdcBalance() {
  const key = (fs.readFileSync(`${AF}/.env`, 'utf8').match(/^HELIUS_API_KEY=(.*)$/m) || [])[1];
  if (!key) throw new Error('HELIUS_API_KEY not readable');
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key.trim()}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [PAYER, { mint: USDC }, { encoding: 'jsonParsed' }] }),
  });
  const j = await res.json();
  return (j.result?.value || []).reduce((n, a) => n + Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
}

/** Last settlement per tool from ANY payer, and separately from anyone but us. */
function lastSettlements() {
  const db = new DatabaseSync(`${AF}/agentfeed.db`, { readOnly: true });
  const rows = db.prepare(`
    SELECT tool,
           MAX(ts) AS last_any,
           MAX(CASE WHEN payer_wallet IS NOT NULL AND payer_wallet <> ? THEN ts END) AS last_outside
    FROM calls WHERE status = 'paid' GROUP BY tool`).all(PAYER);
  db.close();
  const m = new Map();
  for (const r of rows) m.set(r.tool, { last_any: Number(r.last_any) || 0, last_outside: Number(r.last_outside) || 0 });
  return m;
}

function routeUrl(pattern, meta) {
  let p = pattern.replace('GET ', '');
  for (const [k, v] of Object.entries((meta && meta.pathParams) || {})) p = p.replace(`:${k}`, encodeURIComponent(String(v)));
  const qs = new URLSearchParams(Object.entries((meta && meta.input) || {}).map(([k, v]) => [k, String(v)])).toString();
  return `https://x402.ochinimus.app${p}${qs ? `?${qs}` : ''}`;
}

(async () => {
  const META = JSON.parse(fs.readFileSync(`${AF}/bazaar-examples.json`, 'utf8')).routes;
  const seen = lastSettlements();
  const cutoff = Date.now() - LAPSE_DAYS * 86400000;

  const due = [];
  for (const [pattern, m] of Object.entries(META)) {
    const s = seen.get(m.tool) || { last_any: 0, last_outside: 0 };
    const ageDays = s.last_any ? Math.floor((Date.now() - s.last_any) / 86400000) : null;
    // THE GATE, and the whole of it: last_any is the newest settlement from ANY
    // payer, real buyers included. If it falls inside the window the route is
    // already alive and we skip it. That is what makes "never pay a route real
    // buyers paid in the window" structural rather than a second filter -- a
    // separate outside-payer check could never fire, because last_any is by
    // definition >= the last outside settlement.
    if (s.last_any >= cutoff) continue;
    const outsideDays = s.last_outside ? Math.floor((Date.now() - s.last_outside) / 86400000) : null;
    due.push({ tool: m.tool, pattern, usd: m.price_usd, url: routeUrl(pattern, m), ageDays, outsideDays });
  }
  const payable = due;
  const cost = payable.reduce((n, d) => n + d.usd, 0);
  const spent = spentThisMonth();
  const bal = await usdcBalance();

  log(`${DRY ? 'DRY RUN' : 'RUN'}: ${Object.keys(META).length} routes, ${payable.length} with no settlement in ${LAPSE_DAYS}d, cost $${cost.toFixed(3)}`);
  log(`  month-to-date canary spend $${spent.toFixed(3)} of $${MONTHLY_CAP_USD.toFixed(2)} cap | Gack9 balance $${bal.toFixed(3)} (floor $${MIN_BALANCE_USD.toFixed(2)})`);
  if (!payable.length) { log('  nothing is close to lapsing; no payment needed'); return; }
  for (const d of payable) log(`  would pay ${d.tool} $${d.usd} — last settlement ${d.ageDays === null ? 'never' : d.ageDays + 'd ago'}, last outside buyer ${d.outsideDays === null ? 'never' : d.outsideDays + 'd ago'}`);

  if (DRY) return;
  if (bal < MIN_BALANCE_USD) { log(`  ABORT: balance $${bal.toFixed(3)} is below the $${MIN_BALANCE_USD} floor`); return; }
  if (spent + cost > MONTHLY_CAP_USD) { log(`  ABORT: $${spent.toFixed(3)} + $${cost.toFixed(3)} would exceed the $${MONTHLY_CAP_USD} monthly cap`); return; }

  let running = spent;
  for (const d of payable) {
    if (running + d.usd > MONTHLY_CAP_USD) { log(`  stop: monthly cap reached at ${d.tool}`); break; }
    let out = '';
    try { out = execFileSync('node', ['test-client.mjs', d.url, './payer-wallet.json'], { cwd: AF, encoding: 'utf8', timeout: 90000 }); }
    catch (e) { out = String((e.stdout || '') + (e.stderr || '') + e.message); }
    const ok = /^status: 200/m.test(out) && /"success": true/.test(out);
    const tx = (out.match(/"transaction": "([^"]+)"/) || [])[1] || null;
    if (ok) running += d.usd;
    fs.appendFileSync(LEDGER, JSON.stringify({ utc: new Date().toISOString(), tool: d.tool, usd: d.usd, url: d.url, settled: ok, tx }) + '\n');
    log(`  ${ok ? 'SETTLED' : 'FAILED '} ${d.tool} $${d.usd}${tx ? ' ' + tx.slice(0, 20) + '…' : ''}`);
    if (!ok) { log('  stopping on the first route that did not settle'); break; }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  log(`  done; canary spend this month now $${running.toFixed(3)}`);
})().catch((e) => { log(`ERROR ${e.message}`); process.exit(1); });
