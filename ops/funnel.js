#!/usr/bin/env node
// ops/funnel.js: the 402-to-paid funnel, READ-ONLY on agentfeed.db. Who read a price and left, who paid, who was refused and why, who came with a key.
//
//   node ops/funnel.js [--db <path>] [--days N] [--json] [--line] [--all]
//     --db    default: agentfeed.db next to the repository root (the file the server writes), like ops/af-digest.js; AGENTFEED_DB also works
//     --days  UTC days to cover, today included (default 7)
//     --json  the report as JSON      --line  one line for the daily digest      --all  keep own / test wallets (default: they are left out)
//
// Per route (the tool name), per user-agent family, per UTC day:
//   unpaid_402   the 402s served to a request that presented no payment (lib/demand.js: counter rows, one per day, route, ip, user agent)
//   paid         settled calls (calls.status 'paid'), by rail: solana | evm | unknown. THE TABLE STORES NO NETWORK: rail is read from the payer / transaction
//                shape, so every EVM chain (Base, Polygon, Arbitrum, Arc, Tempo) is "evm". A paid call by an own / test wallet is left out unless --all.
//   refused      payment_refused rows (lib/refusals.js), grouped by the reason class ops/af-digest.js shapeOf() gives the reason text
//   key / pass   calls made with a prepaid key (status 'key'): a pass call draws nothing (amount 0) and is grouped by pass kind via api_keys; a pack call draws
//   conversion   paid / unpaid_402 for the same route, UA family and day: how many 402s turned into a payment. null when no 402 was served. It can pass 1
//                (one reader pays many times); it is a ratio of counts, not a share of people.
// Payer addresses are shown only as normPayer prefixes (first 8 characters) and IP addresses not at all.
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { normPayer } = require('../lib/audit');

const DAY_MS = 86_400_000;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** user-agent family: the client library or tool, not its version */
function uaFamily(ua) {
  const s = String(ua == null ? '' : ua).trim();
  if (!s || s === '-') return 'none';
  const l = s.toLowerCase();
  const table = [[/x402scan|agentcash/, 'agentcash / x402scan'], [/coinbase|cdp|bazaar/, 'coinbase / bazaar'], [/402index|idx402/, '402index'], [/googlebot|bingbot|duckduck|yandex|baidu|bot\b|crawler|spider/, 'search bot'],
    [/cloudflare|uptime|pingdom|statuscake|healthcheck|monitor/, 'monitor'], [/curl\//, 'curl'], [/python-requests|python-httpx|aiohttp|urllib/, 'python'], [/go-http-client/, 'go'], [/node-fetch|undici|axios|node\b/, 'node'],
    [/postman|insomnia|httpie/, 'api tool'], [/claude|cursor|mcp|openai|anthropic|langchain|eliza/, 'agent / mcp client'], [/mozilla|chrome|safari|firefox|edge\//, 'browser']];
  for (const [re, name] of table) if (re.test(l)) return name;
  const tok = l.split(/[\s/;(]/)[0].replace(/[^a-z0-9._-]/g, '').slice(0, 24);
  return tok || 'other';
}

/** the rail of a settled call, from the shapes the table does keep */
function railOf(row) {
  const tx = String(row.tx_sig || ''), pw = String(row.payer_wallet || '');
  if (/^0x[0-9a-fA-F]{64}$/.test(tx) || /^0x[0-9a-fA-F]{40}$/.test(pw)) return 'evm';
  if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(tx) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pw)) return 'solana';
  return 'unknown';
}
const prefixOf = (w) => { const n = normPayer(w); return n ? `${String(n).slice(0, 8)}…` : null; };

function openDb(file) { return new Database(file, { readonly: true, fileMustExist: true }); }
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

function buildReport(db, { days = 7, now = Date.now(), all = false, isOwn = () => false, shapeOf = (m) => String(m || '').split(':')[0].slice(0, 60), passKindOf = null } = {}) {
  const fromDay = utcDay(now - (days - 1) * DAY_MS);
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const notes = [];
  const cell = new Map();
  const get = (day, route, fam) => {
    const k = `${day}|${route}|${fam}`;
    let c = cell.get(k);
    if (!c) { c = { day, route, ua_family: fam, unpaid_402: 0, paid: { solana: 0, evm: 0, unknown: 0 }, paid_usd: 0, refused: {}, key_calls: { pass: {}, pack: 0 }, payers: new Map() }; cell.set(k, c); }
    return c;
  };
  if (hasTable(db, 'unpaid_402')) {
    for (const r of db.prepare('SELECT day, route, user_agent, SUM(n) AS n FROM unpaid_402 WHERE day >= ? GROUP BY day, route, user_agent').iterate(fromDay)) get(r.day, r.route, uaFamily(r.user_agent)).unpaid_402 += r.n;
  } else notes.push('the unpaid_402 table does not exist in this database: no 402 counts');
  const keyKinds = new Map();
  // R22: a key bought by one of our own wallets is our own money: its calls are left out like its purchase (--all keeps them). A comp grant (buyer 'grant') is not own: a partner's key is outside use.
  const ownKeys = new Set();
  const hasBuyer = hasTable(db, 'api_keys') && db.prepare('PRAGMA table_info(api_keys)').all().some((c) => c.name === 'buyer');
  if (hasBuyer) for (const r of db.prepare('SELECT prefix, buyer FROM api_keys').iterate()) if (r.buyer && isOwn({ payer_wallet: r.buyer, ip: null })) ownKeys.add(`key:${r.prefix}`);
  if (hasTable(db, 'api_keys')) for (const r of db.prepare('SELECT prefix, pass_days, allow FROM api_keys').iterate()) keyKinds.set(`key:${r.prefix}`, !r.pass_days ? 'pack' : passKindOf ? passKindOf(r) : `pass ${r.pass_days}d`);
  let own = 0, ownKeyCalls = 0, rows = 0;
  for (const r of db.prepare("SELECT ts, tool, payer_wallet, tx_sig, amount_usdc, status, ip, error_msg, user_agent FROM calls WHERE ts >= ? AND status IN ('paid', 'key', 'payment_refused') ORDER BY ts").iterate(fromMs)) {
    rows++;
    if (!all && r.status === 'key' && ownKeys.has(String(r.payer_wallet || ''))) { ownKeyCalls++; continue; }
    if (!all && r.status !== 'key' && isOwn(r)) { own++; continue; }
    const c = get(utcDay(r.ts), r.tool, uaFamily(r.user_agent));
    if (r.status === 'paid') {
      c.paid[railOf(r)]++; c.paid_usd += r.amount_usdc || 0;
      const p = prefixOf(r.payer_wallet); if (p) c.payers.set(p, (c.payers.get(p) || 0) + 1);
    } else if (r.status === 'payment_refused') {
      const k = shapeOf(r.error_msg); c.refused[k] = (c.refused[k] || 0) + 1;
    } else if (r.status === 'key') {
      const kind = keyKinds.get(String(r.payer_wallet || '')) || ((r.amount_usdc || 0) === 0 ? 'pass (kind unknown)' : 'pack');
      if (kind === 'pack') c.key_calls.pack++; else c.key_calls.pass[kind] = (c.key_calls.pass[kind] || 0) + 1;
    }
  }
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const out = [...cell.values()].map((c) => {
    const paid = sum(c.paid);
    return { day: c.day, route: c.route, ua_family: c.ua_family, unpaid_402: c.unpaid_402, paid, paid_by_rail: c.paid, paid_usd: Math.round(c.paid_usd * 1e6) / 1e6,
      conversion: c.unpaid_402 > 0 ? Math.round((paid / c.unpaid_402) * 1e4) / 1e4 : null,
      refused: sum(c.refused), refused_by_reason: c.refused, key_calls: sum(c.key_calls.pass) + c.key_calls.pack, key_calls_by_kind: { ...c.key_calls.pass, ...(c.key_calls.pack ? { pack: c.key_calls.pack } : {}) },
      payers: [...c.payers.entries()].sort((a, b) => b[1] - a[1]).map(([prefix, n]) => ({ payer: prefix, paid_calls: n })) };
  }).sort((a, b) => a.day.localeCompare(b.day) || a.route.localeCompare(b.route) || a.ua_family.localeCompare(b.ua_family));
  const byRoute = new Map();
  for (const r of out) {
    const t = byRoute.get(r.route) || { route: r.route, unpaid_402: 0, paid: 0, paid_usd: 0, refused: 0, key_calls: 0 };
    t.unpaid_402 += r.unpaid_402; t.paid += r.paid; t.paid_usd = Math.round((t.paid_usd + r.paid_usd) * 1e6) / 1e6; t.refused += r.refused; t.key_calls += r.key_calls; byRoute.set(r.route, t);
  }
  const routes = [...byRoute.values()].map((t) => ({ ...t, conversion: t.unpaid_402 > 0 ? Math.round((t.paid / t.unpaid_402) * 1e4) / 1e4 : null })).sort((a, b) => b.unpaid_402 - a.unpaid_402 || a.route.localeCompare(b.route));
  const totals = routes.reduce((a, t) => ({ unpaid_402: a.unpaid_402 + t.unpaid_402, paid: a.paid + t.paid, paid_usd: Math.round((a.paid_usd + t.paid_usd) * 1e6) / 1e6, refused: a.refused + t.refused, key_calls: a.key_calls + t.key_calls }), { unpaid_402: 0, paid: 0, paid_usd: 0, refused: 0, key_calls: 0 });
  totals.conversion = totals.unpaid_402 > 0 ? Math.round((totals.paid / totals.unpaid_402) * 1e4) / 1e4 : null;
  if (own) notes.push(`${own} paid or refused rows from own / test wallets and addresses were left out (--all keeps them)`);
  if (ownKeyCalls) notes.push(`${ownKeyCalls} calls of keys bought by own wallets were left out (--all keeps them)`);
  notes.push('rail is inferred from the payer and transaction shape: the table stores no network, and every EVM chain reads as evm');
  return { window: { days, from_day: fromDay, to_day: utcDay(now), calls_rows_read: rows }, totals, routes, rows: out, notes };
}

const pc = (x) => (x == null ? '-' : `${(x * 100).toFixed(1)}%`);
function render(rep) {
  const L = [`AgentFeed funnel, ${rep.window.from_day} to ${rep.window.to_day} UTC (${rep.window.days} days, ${rep.window.calls_rows_read} audit rows read)`, ''];
  L.push(`TOTAL  402s ${rep.totals.unpaid_402}  paid ${rep.totals.paid} ($${rep.totals.paid_usd})  conversion ${pc(rep.totals.conversion)}  refused ${rep.totals.refused}  key/pass calls ${rep.totals.key_calls}`, '');
  L.push('PER ROUTE', 'route                      402s   paid   conv  refused  key/pass');
  for (const t of rep.routes) L.push(`${t.route.padEnd(26)} ${String(t.unpaid_402).padStart(5)} ${String(t.paid).padStart(6)} ${pc(t.conversion).padStart(6)} ${String(t.refused).padStart(8)} ${String(t.key_calls).padStart(9)}`);
  L.push('', 'PER DAY, ROUTE AND CLIENT FAMILY', 'day        route                      client                  402s paid(sol/evm/?)  conv  refused  key/pass');
  for (const r of rep.rows) L.push(`${r.day} ${r.route.padEnd(26)} ${r.ua_family.padEnd(22)} ${String(r.unpaid_402).padStart(5)} ${`${r.paid}(${r.paid_by_rail.solana}/${r.paid_by_rail.evm}/${r.paid_by_rail.unknown})`.padStart(14)} ${pc(r.conversion).padStart(6)} ${String(r.refused).padStart(8)} ${String(r.key_calls).padStart(9)}`);
  const reasons = {}; for (const r of rep.rows) for (const [k, n] of Object.entries(r.refused_by_reason)) reasons[k] = (reasons[k] || 0) + n;
  if (Object.keys(reasons).length) { L.push('', 'REFUSED PAYMENTS BY REASON'); for (const [k, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) L.push(`${String(n).padStart(6)}  ${k}`); }
  const payers = new Map(); for (const r of rep.rows) for (const p of r.payers) payers.set(p.payer, (payers.get(p.payer) || 0) + p.paid_calls);
  if (payers.size) { L.push('', 'PAYERS (first 8 characters only)'); for (const [p, n] of [...payers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) L.push(`${String(n).padStart(6)}  ${p}`); }
  L.push('', ...rep.notes.map((n) => `note: ${n}`));
  return L.join('\n');
}
/** one line for the daily digest message */
function line(rep) {
  const top = rep.routes.find((t) => t.unpaid_402 > 0);
  return `Funnel ${rep.window.from_day === rep.window.to_day ? rep.window.to_day : `${rep.window.from_day}..${rep.window.to_day}`}: ${rep.totals.unpaid_402} price reads (402), ${rep.totals.paid} paid ($${rep.totals.paid_usd}), conversion ${pc(rep.totals.conversion)}, ${rep.totals.refused} refused, ${rep.totals.key_calls} key/pass calls${top ? `; most read: ${top.route} (${top.unpaid_402}, paid ${top.paid})` : ''}`;
}

function main(argv = process.argv.slice(2)) {
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const file = path.resolve(arg('--db', process.env.AGENTFEED_DB || path.join(__dirname, '..', 'agentfeed.db')));
  if (!fs.existsSync(file)) { console.error(`funnel: no database at ${file}`); process.exit(1); }
  const days = Number(arg('--days', 7));
  if (!Number.isInteger(days) || days < 1 || days > 365) { console.error('funnel: --days must be an integer from 1 to 365'); process.exit(1); }
  const dg = require('./af-digest');
  const db = openDb(file);
  try {
    const rep = buildReport(db, { days, all: argv.includes('--all'), isOwn: dg.isOwn, shapeOf: dg.shapeOf, passKindOf: (r) => { try { return require('../lib/keys').passOf(r).id; } catch { return 'pass'; } } });
    console.log(argv.includes('--json') ? JSON.stringify(rep, null, 1) : argv.includes('--line') ? line(rep) : render(rep));
  } finally { db.close(); }
}
if (require.main === module) main();
module.exports = { buildReport, render, line, uaFamily, railOf, prefixOf, openDb, main };
