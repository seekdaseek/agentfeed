// DEPLOYED AT: /opt/bazaarwatch/score.mjs — this copy is here so the script is versioned with
// the service it watches; it is not run from the repo.
#!/usr/bin/env node
// score.mjs — the scoreboard. "#1 in crypto market data" has to be measured,
// not asserted, so this records the numbers every day and keeps the history.
//
// READ-ONLY against everything except its own SQLite file. It pulls Coinbase's
// public Bazaar discovery API (no key), stores per-route payer and call counts
// for AgentFeed and the three benchmarks, records AgentFeed's rank for the
// queries that matter, and probes the origin so uptime is evidence rather than
// a claim. Weekly it sends Sergiu a Telegram summary.
//
// usage: node score.mjs            daily row + uptime probe
//        node score.mjs --summary  also send the Telegram summary now
'use strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DB = '/opt/bazaarwatch/score.db';
const CDP = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery';
const ORIGIN = 'https://x402.ochinimus.app';
const GACK9 = 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOPUP_BELOW = 0.30;

const MERCHANTS = [
  { name: 'agentfeed', rail: 'solana', payTo: '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7' },
  { name: 'agentfeed', rail: 'base', payTo: '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6' },
  { name: 'otto', rail: 'base', payTo: '0x0E84dDEdAaE6A779c462C22a59F301EC31B6b808' },
  { name: 'kronos', rail: 'base', payTo: '0x36038e1d712c5e39f35952164ec58ec2b96caee7' },
  { name: 'oblique', rail: 'base', payTo: '0x970007590aCC5C938cd51345B17AF51B1B40D3Ab' },
];
const QUERIES = ['crypto liquidations', 'funding rate perps', 'open interest', 'perp market data', 'tokenized stock peg', 'solana priority fees'];

const db = new DatabaseSync(DB);
db.exec(`
  CREATE TABLE IF NOT EXISTS routes (
    ts INTEGER NOT NULL, day TEXT NOT NULL, merchant TEXT NOT NULL, rail TEXT NOT NULL,
    resource TEXT NOT NULL, payers_30d INTEGER, calls_30d INTEGER, last_called_at TEXT,
    PRIMARY KEY (day, merchant, rail, resource));
  CREATE TABLE IF NOT EXISTS ranks (
    ts INTEGER NOT NULL, day TEXT NOT NULL, query TEXT NOT NULL,
    rank INTEGER, results INTEGER, resource TEXT, PRIMARY KEY (day, query));
  CREATE TABLE IF NOT EXISTS uptime (
    ts INTEGER NOT NULL, ok INTEGER NOT NULL, status INTEGER, ms INTEGER, path TEXT);
  CREATE TABLE IF NOT EXISTS wallet (
    ts INTEGER NOT NULL, day TEXT NOT NULL PRIMARY KEY, usdc REAL);
`);

const now = Date.now();
const day = new Date(now).toISOString().slice(0, 10);
const j = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(25000) }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); };

// ---- uptime evidence: probe the origin, append, never overwrite
async function probe() {
  const t0 = Date.now();
  let ok = 0, status = 0;
  try { const r = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(15000) }); status = r.status; ok = r.ok ? 1 : 0; }
  catch { ok = 0; }
  db.prepare('INSERT INTO uptime (ts, ok, status, ms, path) VALUES (?,?,?,?,?)').run(now, ok, status, Date.now() - t0, '/health');
  return { ok, status };
}
function uptime30d() {
  const r = db.prepare('SELECT COUNT(*) n, SUM(ok) up FROM uptime WHERE ts >= ?').get(now - 30 * 86400000);
  if (!r || !r.n) return { probes: 0, pct: null };
  return { probes: Number(r.n), pct: Math.round((Number(r.up) / Number(r.n)) * 10000) / 100 };
}

/**
 * The 30-day figure from /opt/watchdog.sh, which has been probing
 * https://x402.ochinimus.app/health and the paid /api/tvl every 15 minutes
 * since before this scoreboard existed. It logs only on alert, but linewatch
 * has been alerting continuously, so EVERY run writes a line -- which makes the
 * line count the probe count. This is the curation-grade number until the
 * scoreboard's own log is 30 days deep; reported separately, never merged, so
 * neither source is presented as the other.
 */
function watchdogUptime() {
  try {
    const lines = fs.readFileSync('/opt/watchdog.log', 'utf8').split('\n').filter(Boolean);
    const runs = lines.length;
    if (!runs) return null;
    const health = lines.filter((l) => l.includes('agentfeed: /health')).length;
    const paid = lines.filter((l) => l.includes('agentfeed: PAID /api/tvl')).length;
    return { runs, health: Math.round((1 - health / runs) * 100000) / 1000, paid: Math.round((1 - paid / runs) * 100000) / 1000 };
  } catch { return null; }
}

async function merchantRows() {
  const ins = db.prepare(`INSERT OR REPLACE INTO routes (ts,day,merchant,rail,resource,payers_30d,calls_30d,last_called_at) VALUES (?,?,?,?,?,?,?,?)`);
  const totals = new Map();
  for (const m of MERCHANTS) {
    let rows = [];
    try { rows = (await j(`${CDP}/merchant?payTo=${m.payTo}&limit=100&offset=0`)).resources || []; }
    catch (e) { console.log(`  ${m.name}/${m.rail}: lookup failed (${e.message})`); continue; }
    let payers = 0, calls = 0;
    for (const r of rows) {
      const q = r.quality || {};
      ins.run(now, day, m.name, m.rail, r.resource, q.l30DaysUniquePayers ?? null, q.l30DaysTotalCalls ?? null, q.lastCalledAt ?? null);
      payers += Number(q.l30DaysUniquePayers || 0);
      calls += Number(q.l30DaysTotalCalls || 0);
    }
    const k = `${m.name}/${m.rail}`;
    totals.set(k, { routes: rows.length, payers, calls });
    console.log(`  ${k.padEnd(18)} routes=${String(rows.length).padStart(3)} payer-slots30=${String(payers).padStart(4)} calls30=${String(calls).padStart(5)}`);
  }
  return totals;
}

async function rankRows() {
  const ins = db.prepare('INSERT OR REPLACE INTO ranks (ts,day,query,rank,results,resource) VALUES (?,?,?,?,?,?)');
  const out = [];
  for (const q of QUERIES) {
    let rows = [];
    try { rows = (await j(`${CDP}/search?query=${encodeURIComponent(q)}&limit=20`)).resources || []; }
    catch (e) { console.log(`  "${q}": search failed (${e.message})`); continue; }
    const i = rows.findIndex((r) => String(r.resource || '').includes('x402.ochinimus.app'));
    const rank = i >= 0 ? i + 1 : null;
    ins.run(now, day, q, rank, rows.length, i >= 0 ? rows[i].resource : null);
    out.push({ q, rank, results: rows.length });
    console.log(`  "${q}"`.padEnd(28) + (rank ? `#${rank}` : 'absent') + ` of ${rows.length}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}

async function gack9() {
  const key = (fs.readFileSync('/opt/agentfeed/.env', 'utf8').match(/^HELIUS_API_KEY=(.*)$/m) || [])[1];
  if (!key) return null;
  const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key.trim()}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [GACK9, { mint: USDC }, { encoding: 'jsonParsed' }] }),
  });
  const v = (await r.json()).result?.value || [];
  const bal = v.reduce((n, a) => n + Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
  db.prepare('INSERT OR REPLACE INTO wallet (ts, day, usdc) VALUES (?,?,?)').run(now, day, bal);
  return bal;
}

// Telegram credentials come from liqbot's .env, the same source afwatch uses.
// Read at call time and never logged, printed or stored.
function tg(text) {
  let env = '';
  try { env = fs.readFileSync('/opt/liqbot/.env', 'utf8'); } catch { return 'no /opt/liqbot/.env'; }
  const token = (env.match(/^TG_BOT_TOKEN=(.*)$/m) || [])[1];
  const chat = (env.match(/^TG_ALERT_CHAT=(.*)$/m) || [])[1];
  if (!token || !chat) return 'TG_BOT_TOKEN / TG_ALERT_CHAT not set';
  return fetch(`https://api.telegram.org/bot${token.trim()}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat.trim(), text, parse_mode: 'HTML', disable_web_page_preview: true }),
  }).then((r) => (r.ok ? 'sent' : `telegram ${r.status}`)).catch((e) => `telegram error ${e.message}`);
}

(async () => {
  console.log(`bazaarwatch ${day}`);
  const p = await probe();
  console.log(`  origin /health: ${p.status} (${p.ok ? 'up' : 'DOWN'})`);
  const totals = await merchantRows();
  const ranks = await rankRows();
  const bal = await gack9();
  const up = uptime30d();
  const wd = watchdogUptime();
  console.log(`  uptime, scoreboard probes: ${up.pct === null ? 'none yet' : up.pct + '% over ' + up.probes}`);
  if (wd) console.log(`  uptime, watchdog 15-min probes: /health ${wd.health}% | paid /api/tvl ${wd.paid}% over ${wd.runs} runs`);
  console.log(`  Gack9 USDC: ${bal === null ? 'unreadable' : bal.toFixed(3)}`);

  const weekly = process.argv.includes('--summary') || new Date(now).getUTCDay() === 1;
  if (!weekly) { console.log('  (summary sends on Mondays; --summary forces it)'); return; }
  // AgentFeed's two payTo addresses are two rails on the SAME routes, so the
  // merchant lookup returns the same resource set for both. Summing them would
  // double every figure; count distinct resources for today instead.
  const afRow = db.prepare(`SELECT COUNT(DISTINCT resource) routes, SUM(payers_30d) payers, SUM(calls_30d) calls
                            FROM (SELECT DISTINCT resource, payers_30d, calls_30d FROM routes WHERE day = ? AND merchant = 'agentfeed')`).get(day);
  const sum = (f) => Number((afRow && afRow[f]) || 0);
  const line = (k) => { const t = totals.get(k); return t ? `${k.split('/')[0]}: ${t.routes} routes, ${t.payers} payer-slots, ${t.calls} calls` : `${k}: n/a`; };
  const body = [
    `<b>AgentFeed Bazaar scoreboard</b> ${day}`,
    ``,
    `AgentFeed: ${sum('routes')} listed routes, ${sum('payers')} payer-slots/30d, ${sum('calls')} calls/30d`,
    `<i>payer-slots = each route's unique payers, summed across routes (same basis for everyone below)</i>`,
    line('otto/base'), line('kronos/base'), line('oblique/base'),
    ``,
    `<b>Search rank</b>`,
    ...ranks.map((r) => `${r.q}: ${r.rank ? '#' + r.rank : 'absent'} of ${r.results}`),
    ``,
    `<b>Uptime</b>`,
    ...(wd ? [`watchdog 15-min probes, 30d: /health ${wd.health}%, paid /api/tvl ${wd.paid}% (${wd.runs} runs)`] : []),
    `scoreboard probes: ${up.pct === null ? 'n/a' : up.pct + '% (' + up.probes + ')'}`,
    `Gack9: ${bal === null ? 'unreadable' : '$' + bal.toFixed(3)} USDC`,
    ...(bal !== null && bal < TOPUP_BELOW ? [``, `top up Gack9: send 1 USDC (Solana) to ${GACK9}`] : []),
  ].join('\n');
  console.log('  telegram:', await tg(body));
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
