#!/usr/bin/env node
// ops/af-digest.js — AgentFeed sales + refused-payment digest, and the refusal burst alert.
// READ-ONLY on agentfeed.db. Sends to Telegram with the liqbot bot token and the
// TG_ALERT_CHAT chat id from /opt/liqbot/.env; neither value is ever printed.
//
//   node ops/af-digest.js --digest          hourly cron: sends yesterday's digest once, in the
//                                           09:00 hour Europe/Chisinau (DST-proof: the box is UTC)
//   node ops/af-digest.js --digest --force  send it now (add --test to mark it as a test)
//   node ops/af-digest.js --alert           every 5 min: one IP or payer refused >= 5 times in
//                                           the last hour -> one alert, then quiet for that key 1 h
//   --dry                                   print what would be sent; send nothing, write no state
//
// crons (root), under flock, no PM2 process:
//   0 * * * * cd /opt/agentfeed && /usr/bin/flock -n /var/lock/af-digest.lock /usr/bin/node ops/af-digest.js --digest >> /opt/afwatch/digest.log 2>&1
//   */5 * * * * cd /opt/agentfeed && /usr/bin/flock -n /var/lock/af-alert.lock /usr/bin/node ops/af-digest.js --alert >> /opt/afwatch/digest.log 2>&1
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.AGENTFEED_DB || path.join(__dirname, '..', 'agentfeed.db');
const ENV_PATH = '/opt/liqbot/.env';
const STATE = process.env.AF_DIGEST_STATE || '/opt/afwatch/digest-state.json';
const TZ = 'Europe/Chisinau';
const BURST = 5;               // refusals from one IP or payer ...
const BURST_WINDOW = 3600e3;   // ... within this window
const QUIET_AFTER_ALERT = 3600e3;
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');

// Our own traffic: tagged in the digest, never an alert. Same wallets as afwatch.js.
const OWN_WALLETS = new Set([
  'EqRNNpKVpu6jm8iRTNa17Rht2TRTzCtNNz37M9m2Di1',
  'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu',
  'TeStKWyNre9PW8XbLfvuBm9f6EnTBYqS5GXTzciCnHw',
  '0xFEfF369D5048b2Cf817d87467E48404b3ADfE4Ee',
]);
// The box itself, plus /opt/afwatch/own-ips.txt (one per line, # comments): the Mac's
// addresses change, so they live in a file rather than here.
const OWN_IPS = new Set(['167.233.69.154', '2a01:4f8:c015:eb5e::1', '127.0.0.1', '::1', '::ffff:127.0.0.1']);
try { for (const l of fs.readFileSync(process.env.AF_OWN_IPS || '/opt/afwatch/own-ips.txt', 'utf8').split('\n')) { const ip = l.replace(/#.*/, '').trim(); if (ip) OWN_IPS.add(ip); } } catch { /* no file: box addresses only */ }
const isOwn = (r) => OWN_WALLETS.has(r.payer_wallet) || OWN_IPS.has(r.ip);

// ---- time: the box runs UTC; the digest's "yesterday" is a Chisinau calendar day
function offsetMin(ms) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date(ms))
    .find((p) => p.type === 'timeZoneName').value; // "GMT+03:00"
  const m = s.match(/GMT([+-])(\d{2}):(\d{2})/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}
const localParts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
  .formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
function localMidnightUtc(y, m, d) {   // ms of 00:00 local on y-m-d
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) guess = Date.UTC(y, m - 1, d) - offsetMin(guess) * 60e3;
  return guess;
}
function yesterday(now) {
  const t = localParts(now);
  const todayStart = localMidnightUtc(+t.year, +t.month, +t.day);
  const y = localParts(todayStart - 12 * 3600e3);
  return { date: `${y.year}-${y.month}-${y.day}`, from: localMidnightUtc(+y.year, +y.month, +y.day), to: todayStart, hour: +t.hour, today: `${t.year}-${t.month}-${t.day}` };
}

// ---- the decoded shape of a refusal, from the reason the recorder wrote
function shapeOf(msg) {
  const m = String(msg || '');
  const h = m.match(/header (PAYMENT-SIGNATURE|X-PAYMENT) len=\d+ prefix=\S+ base64json=(yes|no)(?: x402Version=(\d+))?/);
  if (h) return `${h[1]} ${h[2] === 'no' ? 'undecodable' : `v${h[3] || '?'}`}`;
  if (/not a decodable x402 v2 PAYMENT-SIGNATURE/.test(m)) return 'X-PAYMENT or undecodable header (no shape recorded)';
  if (/Cannot (destructure|read propert)/.test(m)) return 'payload without accepted (v1 layout under PAYMENT-SIGNATURE; JS error text, pre-S4)';
  if (/^x402 v1 /.test(m)) return `v1: ${m.replace(/^x402 v1 /, '').split(/[:;]/)[0]}`;
  const mpp = m.match(/^(malformed-credential|invalid-challenge|[a-z-]+-credential|payment-[a-z-]+):/);
  if (mpp) return `MPP ${mpp[1]}`;
  const code = m.match(/(invalid_[a-z0-9_]+|settle_[a-z0-9_]+|insufficient_[a-z_]+|No matching payment requirements)/);
  if (code) return `${/svm/.test(code[1]) ? 'v2 solana' : /evm/.test(code[1]) ? 'v2 evm' : 'v2'}: ${code[1]}`;
  return m.split(':')[0].slice(0, 60) || 'no reason';
}

function readEnv() {
  const out = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
async function send(text) {
  if (DRY) { console.log('--- would send ---\n' + text); return true; }
  const env = readEnv();
  if (!env.TG_BOT_TOKEN || !env.TG_ALERT_CHAT) { console.log(`${new Date().toISOString()} TG_BOT_TOKEN or TG_ALERT_CHAT missing in ${ENV_PATH}`); return false; }
  const parts = [];
  for (let s = text; s.length; ) { const cut = s.length <= 3900 ? s.length : s.lastIndexOf('\n', 3900) > 0 ? s.lastIndexOf('\n', 3900) : 3900; parts.push(s.slice(0, cut)); s = s.slice(cut).replace(/^\n/, ''); }
  for (const p of parts) {
    let ok = false, status = 0, desc = '';
    try {
      const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TG_ALERT_CHAT, text: p, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(20000),
      });
      status = r.status; const j = await r.json().catch(() => ({})); ok = j.ok === true; desc = j.description || '';
    } catch { desc = 'network error'; }
    // status and Telegram's own description only: never the URL, which holds the token
    if (!ok) { console.log(`${new Date().toISOString()} telegram send failed: HTTP ${status} ${String(desc).slice(0, 120)}`); return false; }
  }
  return true;
}
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { digestSent: {}, alerted: {} }; } };
const saveState = (s) => { if (!DRY) { fs.writeFileSync(STATE + '.tmp', JSON.stringify(s, null, 1)); fs.renameSync(STATE + '.tmp', STATE); } };
const usd = (n) => `$${(Math.round(n * 1000) / 1000).toFixed(3)}`;
const who = (r) => r.payer_wallet ? `payer ${r.payer_wallet.slice(0, 8)}…` : `ip ${r.ip || '?'}`;

function digestText(db, w, test) {
  const paid = db.prepare("SELECT tool, payer_wallet, ip, amount_usdc FROM calls WHERE status='paid' AND ts >= ? AND ts < ?").all(w.from, w.to);
  const refused = db.prepare("SELECT tool, payer_wallet, ip, user_agent, error_msg FROM calls WHERE status='payment_refused' AND ts >= ? AND ts < ?").all(w.from, w.to);
  const ext = paid.filter((r) => !isOwn(r)), own = paid.filter(isOwn);
  const sum = (rows) => rows.reduce((s, r) => s + (r.amount_usdc || 0), 0);
  const L = [`AgentFeed digest${test ? ' (TEST)' : ''} for ${w.date} (${TZ})`, ''];
  L.push(`Paid: ${ext.length} calls, ${usd(sum(ext))} from ${new Set(ext.map((r) => r.payer_wallet)).size} external payers` + (own.length ? `; own/test ${own.length} calls, ${usd(sum(own))}` : ''));
  const byTool = {};
  for (const r of ext) { const t = byTool[r.tool] || (byTool[r.tool] = { n: 0, u: 0 }); t.n++; t.u += r.amount_usdc || 0; }
  const tools = Object.entries(byTool).sort((a, b) => b[1].u - a[1].u || b[1].n - a[1].n);
  for (const [t, v] of tools.slice(0, 15)) L.push(`  ${t}: ${v.n} = ${usd(v.u)}`);
  if (tools.length > 15) L.push(`  ... ${tools.length - 15} more routes, ${usd(tools.slice(15).reduce((s, [, v]) => s + v.u, 0))}`);
  if (!ext.length) L.push('  (no external paid calls)');
  L.push('', `Refused payments: ${refused.length} (${refused.filter((r) => !isOwn(r)).length} external)`);
  // grouped by IP or payer, user agent and decoded shape; the group's routes listed inline
  const g = {};
  for (const r of refused) {
    const own = isOwn(r);
    const k = [own ? `${who(r)} [own]` : who(r), (r.user_agent || '-').slice(0, 40), shapeOf(r.error_msg)].join(' | ');
    const e = g[k] || (g[k] = { n: 0, own, routes: {} });
    e.n++; e.routes[r.tool] = (e.routes[r.tool] || 0) + 1;
  }
  const groups = Object.entries(g).sort((a, b) => (a[1].own - b[1].own) || b[1].n - a[1].n);
  const routesOf = (rt) => Object.entries(rt).sort((a, b) => b[1] - a[1]).map(([t, n]) => (n > 1 ? `${t} x${n}` : t)).join(', ');
  for (const [k, e] of groups.slice(0, 30)) L.push(`  ${e.n}x ${k}\n      routes: ${routesOf(e.routes).slice(0, 400)}`);
  if (groups.length > 30) L.push(`  ... ${groups.length - 30} more groups`);
  if (!refused.length) L.push('  (none)');
  return L.join('\n');
}

async function digest(db) {
  const now = Date.now();
  const w = yesterday(now);
  const state = loadState();
  const force = args.has('--force');
  if (!force && (w.hour !== 9 || state.digestSent[w.today])) return; // not the hour, or already sent today
  const text = digestText(db, w, args.has('--test'));
  if (await send(text)) {
    if (!force) state.digestSent[w.today] = new Date(now).toISOString();
    for (const k of Object.keys(state.digestSent).sort().slice(0, -60)) delete state.digestSent[k];
    saveState(state);
    console.log(`${new Date().toISOString()} digest for ${w.date} sent${force ? ' (forced)' : ''}${DRY ? ' (dry)' : ''}`);
  }
}

async function alert(db) {
  const now = Date.now();
  const rows = db.prepare("SELECT ts, tool, payer_wallet, ip, user_agent, error_msg FROM calls WHERE status='payment_refused' AND ts >= ?").all(now - BURST_WINDOW);
  const state = loadState();
  const g = {};
  for (const r of rows) { if (isOwn(r)) continue; const k = r.payer_wallet || r.ip || '?'; (g[k] = g[k] || []).push(r); }
  for (const [k, rs] of Object.entries(g)) {
    if (rs.length < BURST) continue;
    if (state.alerted[k] && now - state.alerted[k] < QUIET_AFTER_ALERT) continue;
    const shapes = {}; for (const r of rs) { const s = shapeOf(r.error_msg); shapes[s] = (shapes[s] || 0) + 1; }
    const text = [
      `AgentFeed: ${who(rs[0])} refused ${rs.length} times in the last hour`,
      `ua: ${(rs[0].user_agent || '-').slice(0, 80)}`,
      `routes: ${[...new Set(rs.map((r) => r.tool))].join(', ').slice(0, 300)}`,
      ...Object.entries(shapes).map(([s, n]) => `  ${n}x ${s}`),
      `last reason: ${String(rs[rs.length - 1].error_msg || '').slice(0, 300)}`,
    ].join('\n');
    if (await send(text)) { state.alerted[k] = now; console.log(`${new Date().toISOString()} alert sent for ${k.slice(0, 12)} (${rs.length})`); }
  }
  for (const k of Object.keys(state.alerted)) if (now - state.alerted[k] > 7 * 86400e3) delete state.alerted[k];
  saveState(state);
}

if (require.main === module) (async () => {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  if (args.has('--digest')) await digest(db);
  else if (args.has('--alert')) await alert(db);
  else { console.error('usage: node ops/af-digest.js --digest [--force] [--test] | --alert [--dry]'); process.exit(1); }
})().catch((e) => { console.log(`${new Date().toISOString()} af-digest failed: ${String(e.message).slice(0, 200)}`); process.exit(1); });

module.exports = { shapeOf, yesterday, offsetMin };
