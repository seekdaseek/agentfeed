#!/usr/bin/env node
// ops/af-digest.js — AgentFeed sales + refused-payment digest, and the refusal burst alert.
// READ-ONLY on agentfeed.db. Sends to Telegram with the liqbot bot token and the
// TG_ALERT_CHAT chat id from /opt/liqbot/.env; neither value is ever printed.
//
//   node ops/af-digest.js --digest          hourly cron: sends yesterday's digest once, in the
//                                           09:00 hour Europe/Chisinau (DST-proof: the box is UTC)
//   node ops/af-digest.js --digest --force  send it now (add --test to mark it as a test)
//   node ops/af-digest.js --alert           every 5 min: one IP or payer refused >= 5 times in
//                                           the last hour -> one alert, then quiet for that key 1 h;
//                                           and a refused tempo payment (row with a tx hash, last
//                                           24 h) whose transaction landed anyway -> one alert per row
//                                           and ANY refused payment whose reason is a Circle authorisation refusal for the Arc rail
//                                           (403 / forbidden / registration_required): one row is an alert, own wallets included,
//                                           then quiet for an hour (a dead Circle key is seen on the first payment, not after a burst)
//                                           and, from day 30 of the move-alert calibration table (tools/briefs/config.js), one line a day about its age
//                                           and (R22) one line when the USDC account of a Solana payTo in the manifest does not exist, then quiet for an hour
//   --dry                                   print what would be sent; send nothing, write no state
//
// crons (root), under flock, no PM2 process:
//   0 * * * * cd /opt/agentfeed && /usr/bin/flock -n /var/lock/af-digest.lock /usr/bin/node ops/af-digest.js --digest >> /opt/afwatch/digest.log 2>&1
//   */5 * * * * cd /opt/agentfeed && /usr/bin/flock -n /var/lock/af-alert.lock /usr/bin/node ops/af-digest.js --alert >> /opt/afwatch/digest.log 2>&1
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { normPayer } = require('../lib/audit');

const DB_PATH = process.env.AGENTFEED_DB || path.join(__dirname, '..', 'agentfeed.db');
const ENV_PATH = '/opt/liqbot/.env';
const STATE = process.env.AF_DIGEST_STATE || '/opt/afwatch/digest-state.json';
const TZ = 'Europe/Chisinau';
const BURST = 5;               // refusals from one IP or payer ...
const BURST_WINDOW = 3600e3;   // ... within this window
const QUIET_AFTER_ALERT = 3600e3;
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');

// Our own traffic: tagged in the digest, never an alert. Same wallets as afwatch.js. EVM addresses are compared lower-case
// (the audit table stores them that way from R8, older rows are migrated): one payer, one spelling.
const OWN_WALLETS = new Set([
  'EqRNNpKVpu6jm8iRTNa17Rht2TRTzCtNNz37M9m2Di1',
  'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu',
  'TeStKWyNre9PW8XbLfvuBm9f6EnTBYqS5GXTzciCnHw',
  '0xFEfF369D5048b2Cf817d87467E48404b3ADfE4Ee',
  '0x05b38ff795a2d750788157f1119e5d403d8ef47a', // the Circle Gateway proof payer (Arc, 13 Oct 2026)
].map(normPayer));
// The box itself, plus /opt/afwatch/own-ips.txt (one per line, # comments): the Mac's
// addresses change, so they live in a file rather than here.
const OWN_IPS = new Set(['167.233.69.154', '2a01:4f8:c015:eb5e::1', '127.0.0.1', '::1', '::ffff:127.0.0.1']);
try { for (const l of fs.readFileSync(process.env.AF_OWN_IPS || '/opt/afwatch/own-ips.txt', 'utf8').split('\n')) { const ip = l.replace(/#.*/, '').trim(); if (ip) OWN_IPS.add(ip); } } catch { /* no file: box addresses only */ }
// an own-ips.txt entry ending in ':' is an IPv6 prefix (the Mac's /64 rotates its suffix)
const OWN_PREFIXES = [...OWN_IPS].filter((ip) => ip.endsWith(':'));
const isOwn = (r) => OWN_WALLETS.has(normPayer(r.payer_wallet)) || OWN_IPS.has(r.ip) || OWN_PREFIXES.some((p) => String(r.ip || '').startsWith(p));

// A batch-settlement client that has lost its channel context (a fresh process per call, a restart) rebuilds the base of its voucher
// from the chain's claimed total, which is behind the server's charged total while vouchers are outstanding. The server answers with a
// corrective 402 carrying its state and the client resyncs inside the same fetch(): the buyer is served. That is protocol, not a failed
// payment, so it is neither a "buyer we failed" in the digest nor a refusal for the burst alert (13 Oct 2026: audit rows 11994, 11997;
// test/batch-resync.test.js). Rows stay in the table; they are counted on their own line.
const RESYNC_SQL = "(error_msg LIKE '%cumulative_amount_mismatch%' OR error_msg LIKE '%cumulative_amount_below_claimed%')";

// Circle's Facilitator Service refusing the Arc rail on authorisation grounds (a key it rejects, an address or account it will not serve, a
// registration the key lacks) reaches the audit table as a refused payment whose reason is lib/circle-arc.js's own text: "verification refused:
// Circle /verify 403: forbidden", "settlement refused: Circle /settle 403 registration_required: ...". test/circle-auth-refusal.test.js drives the
// real x402 middleware to pin that wording, so a library upgrade that changed it fails a test instead of silencing this alert. 13 Oct 2026: the
// LIVE key answered 403 on every call for hours and nothing would have said so before a burst of five from one payer.
const CIRCLE_AUTH_RE = /registration_required|Circle \/(?:verify|settle|status) (?:401|403)\b|Circle[^\n]*\b(?:forbidden|unauthori[sz]ed)\b/i;
const CIRCLE_AUTH_COLS = 'id, ts, tool, payer_wallet, ip, error_msg';
const circleAuthRowsSince = (db, afterId) => db.prepare(`SELECT ${CIRCLE_AUTH_COLS} FROM calls WHERE status='payment_refused' AND id > ? ORDER BY id`).all(afterId).filter((r) => CIRCLE_AUTH_RE.test(String(r.error_msg || '')));
const circleAuthRowsBetween = (db, from, to) => db.prepare(`SELECT ${CIRCLE_AUTH_COLS} FROM calls WHERE status='payment_refused' AND ts >= ? AND ts < ? ORDER BY id`).all(from, to).filter((r) => CIRCLE_AUTH_RE.test(String(r.error_msg || '')));
const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');

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
  const full = String(msg || '');
  // R1 rows carry '; mpp <shape>' when an MPP-style credential was presented
  const at = full.indexOf('; mpp ');
  if (at >= 0) {
    const sh = full.slice(at + 6);
    const pick = (re) => (sh.match(re) || [])[0];
    const kind = [pick(/base64json=yes( x402Version=\d+)?/), /base64urljson=yes/.test(sh) && 'base64url JSON', /params=yes/.test(sh) && 'auth-params', /dots=2/.test(sh) && 'JWS-like'].filter(Boolean).join(', ') || 'undecodable';
    return `${shapeOf(full.slice(0, at))} | mpp ${pick(/^\S+/)} (${kind})`;
  }
  const m = full;
  if (/^x402 payment sent in /.test(m)) return `x402 in MPP header: ${shapeOf(m.replace(/^x402 payment sent in [^:]+: /, ''))}`;
  if (/^MPP (solana )?credential on (an x402-only route|a route without solana)/.test(m)) return 'MPP solana on a non-solana route';
  const h = m.match(/header (PAYMENT-SIGNATURE|X-PAYMENT) len=\d+ prefix=\S+ base64json=(yes|no)(?: x402Version=(\d+))?/);
  if (h) return `${h[1]} ${h[2] === 'no' ? 'undecodable' : `v${h[3] || '?'}`}`;
  // Since the shape logging (S3) an x402 header always gets '; header <shape>', so a plain
  // challenge with no shape means only an MPP-style credential was presented (3.14.8.71).
  if (/not a decodable x402 v2 PAYMENT-SIGNATURE/.test(m)) return /; header /.test(m) ? 'x402 header, plain challenge' : 'MPP credential on an x402-only route (plain challenge, pre-R1)';
  if (/Cannot (destructure|read propert)/.test(m)) return 'payload without accepted (v1 layout under PAYMENT-SIGNATURE; JS error text, pre-S4)';
  if (/^x402 v1 /.test(m)) return `v1: ${m.replace(/^x402 v1 /, '').split(/[:;]/)[0]}`;
  const mpp = m.match(/^(malformed-credential|invalid-challenge|[a-z-]+-credential|payment-[a-z-]+):/);
  if (mpp) return `MPP ${mpp[1]}`;
  const circ = m.match(/Circle \/(verify|settle|status) (\d{3})(?: ([a-z_]+))?/);
  if (circ) return `Circle ${circ[1]} ${circ[2]}${circ[3] ? ` ${circ[3]}` : ''}`;
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

// ---- prepaid keys (R9): what was sold, what was drawn, what is still owed to key holders. Revenue is unchanged: a purchase is a
// 'paid' row (counted above, tool buy_key_* / topup_key_*); the calls it funds are 'key' rows = consumption of credit already counted,
// never added to revenue. No alert. The table is created at boot by lib/keys.js; before that (or on an old copy) the section is absent.
function keysLines(db, w) {
  try { db.prepare('SELECT 1 FROM api_keys LIMIT 1').get(); } catch { return []; }
  const sold = db.prepare("SELECT tool, COUNT(*) n, COALESCE(SUM(amount_usdc), 0) u FROM calls WHERE status = 'paid' AND (tool LIKE 'buy\\_key\\_%' ESCAPE '\\' OR tool LIKE 'topup\\_key\\_%' ESCAPE '\\') AND ts >= ? AND ts < ? GROUP BY tool ORDER BY tool").all(w.from, w.to);
  const use = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount_usdc), 0) u, COUNT(DISTINCT payer_wallet) k FROM calls WHERE status = 'key' AND ts >= ? AND ts < ?").get(w.from, w.to);
  const comp = db.prepare("SELECT COUNT(*) n FROM calls WHERE status = 'key' AND ts >= ? AND ts < ? AND payer_wallet IN (SELECT 'key:' || prefix FROM api_keys WHERE buyer = 'grant')").get(w.from, w.to).n;
  const owed = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(balance_micro), 0) b FROM api_keys WHERE status = 'active'").get();
  const soldN = sold.reduce((n, r) => n + r.n, 0), soldU = sold.reduce((n, r) => n + r.u, 0);
  return [`Prepaid keys: sold ${soldN} (${usd(soldU)}${sold.length ? `: ${sold.map((r) => `${r.tool} x${r.n}`).join(', ')}` : ''}); drawn ${use.n} calls = ${usd(use.u)} from ${use.k} key${use.k === 1 ? '' : 's'}${comp ? ` (${comp} on comp keys, not sales)` : ''}; still owed to ${owed.n} active key${owed.n === 1 ? '' : 's'}: ${usd(owed.b / 1e6)}`];
}

function digestText(db, w, test) {
  const paid = db.prepare("SELECT tool, payer_wallet, ip, amount_usdc FROM calls WHERE status='paid' AND ts >= ? AND ts < ?").all(w.from, w.to);
  const refused = db.prepare(`SELECT tool, payer_wallet, ip, user_agent, error_msg FROM calls WHERE status='payment_refused' AND NOT COALESCE(${RESYNC_SQL}, 0) AND ts >= ? AND ts < ?`).all(w.from, w.to);
  const resyncs = db.prepare(`SELECT COUNT(*) n FROM calls WHERE status='payment_refused' AND ${RESYNC_SQL} AND ts >= ? AND ts < ?`).get(w.from, w.to).n;
  const ext = paid.filter((r) => !isOwn(r)), own = paid.filter(isOwn);
  const sum = (rows) => rows.reduce((s, r) => s + (r.amount_usdc || 0), 0);
  const L = [`AgentFeed digest${test ? ' (TEST)' : ''} for ${w.date} (${TZ})`, ''];
  L.push(`Paid: ${ext.length} calls, ${usd(sum(ext))} from ${new Set(ext.map((r) => normPayer(r.payer_wallet))).size} external payers` + (own.length ? `; own/test ${own.length} calls, ${usd(sum(own))}` : ''));
  const byTool = {};
  for (const r of ext) { const t = byTool[r.tool] || (byTool[r.tool] = { n: 0, u: 0 }); t.n++; t.u += r.amount_usdc || 0; }
  const tools = Object.entries(byTool).sort((a, b) => b[1].u - a[1].u || b[1].n - a[1].n);
  for (const [t, v] of tools.slice(0, 15)) L.push(`  ${t}: ${v.n} = ${usd(v.u)}`);
  if (tools.length > 15) L.push(`  ... ${tools.length - 15} more routes, ${usd(tools.slice(15).reduce((s, [, v]) => s + v.u, 0))}`);
  if (!ext.length) L.push('  (no external paid calls)');
  L.push('', `Refused payments: ${refused.length} (${refused.filter((r) => !isOwn(r)).length} external)` + (resyncs ? `; plus ${resyncs} batch-channel resync(s), served on the retry, not failures` : ''));
  for (const l of keysLines(db, w)) L.push(l);
  const circle = circleAuthRowsBetween(db, w.from, w.to);
  if (circle.length) L.push(`Circle (Arc rail) authorisation refusals: ${circle.length}, first ${stamp(circle[0].ts)}, last ${stamp(circle[circle.length - 1].ts)} UTC (the key, its allow-list or the account at Circle; own wallets included)`);
  // Three sections. "No funds" is the payer's side; a probe is a challenge we never
  // issued, or a presenter whose every refusal is MPP-only and who has never paid.
  const paidEver = new Set(db.prepare("SELECT DISTINCT payer_wallet k FROM calls WHERE status='paid' AND payer_wallet IS NOT NULL UNION SELECT DISTINCT ip FROM calls WHERE status='paid' AND ip IS NOT NULL").all().map((r) => normPayer(r.k)));
  const NO_FUNDS = /execution reverted|InvalidAccountData|insufficient[_ ]funds/i;
  const NOT_ISSUED = /invalid-challenge|challenge was not issued/i;
  const mppOnlyRow = (m) => /^(malformed-credential|invalid-challenge|verification-failed|[a-z-]+-credential|MPP credential )/.test(m) || (/not a decodable x402 v2/.test(m) && !/; header /.test(m));
  const extR = refused.filter((r) => !isOwn(r));
  const keyOf = (r) => normPayer(r.payer_wallet) || r.ip || '?';
  const mppOnlyKey = {};
  for (const r of extR) { const k = keyOf(r); mppOnlyKey[k] = (mppOnlyKey[k] !== false) && mppOnlyRow(String(r.error_msg || '')); }
  const sectionOf = (r) => {
    const m = String(r.error_msg || '');
    if (NOT_ISSUED.test(m)) return 'probe';
    if (NO_FUNDS.test(m)) return 'funds';
    if (mppOnlyKey[keyOf(r)] && !paidEver.has(normPayer(r.payer_wallet)) && !paidEver.has(r.ip)) return 'probe';
    return 'failed';
  };
  const routesOf = (rt) => Object.entries(rt).sort((a, b) => b[1] - a[1]).map(([t, n]) => (n > 1 ? `${t} x${n}` : t)).join(', ');
  const SECTIONS = [['failed', 'Buyers we failed'], ['funds', 'Payer had no funds, their side'], ['probe', 'Probes, rejected as designed']];
  for (const [id, title] of SECTIONS) {
    const g = {};
    for (const r of extR.filter((x) => sectionOf(x) === id)) {
      const k = [who(r), (r.user_agent || '-').slice(0, 40), shapeOf(r.error_msg)].join(' | ');
      const e = g[k] || (g[k] = { n: 0, routes: {} });
      e.n++; e.routes[r.tool] = (e.routes[r.tool] || 0) + 1;
    }
    const groups = Object.entries(g).sort((a, b) => b[1].n - a[1].n);
    L.push('', `${title}: ${groups.reduce((n, [, e]) => n + e.n, 0)}`);
    for (const [k, e] of groups.slice(0, 15)) L.push(`  ${e.n}x ${k}\n      routes: ${routesOf(e.routes).slice(0, 400)}`);
    if (groups.length > 15) L.push(`  ... ${groups.length - 15} more groups`);
    if (!groups.length) L.push('  (none)');
  }
  const ownN = refused.length - extR.length;
  if (ownN) L.push('', `Own/test refusals (not shown): ${ownN}`);
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

// ---- late tempo landings. mpp/tempo.js refuses a tempo payment whose transaction it cannot
// prove landed within 15 s and logs the hash in tx_sig. mppx signs with validBefore = now + 25 s,
// so the transaction's fate is final a minute later: landed (buyer paid, got no data: alert once,
// Sergiu refunds by hand from the treasury, whose key is never on the box) or never.
const TEMPO_RPCS = ['https://rpc.tempo.xyz', 'https://rpc.mainnet.tempo.xyz'];
const TEMPO_FINAL_AFTER = 120e3;
const TEMPO_TOKENS = { '0x20c0000000000000000000006a37da5c996874be': 'OUSD', '0x20c000000000000000000000b9537d11c60e8b50': 'USDC.e' };
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const FEE_MANAGER = '0xfeec000000000000000000000000000000000000';
async function tempoReceipt(hash) {
  for (const url of TEMPO_RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }), signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.error) continue;
      return j.result || null; // null: not mined
    } catch { /* next RPC */ }
  }
  return undefined; // nobody answered: look again next run
}
async function lateTempo(db, state, now) {
  state.lateTempo = state.lateTempo || {};
  const rows = db.prepare("SELECT id, ts, tool, payer_wallet, ip, tx_sig FROM calls WHERE status='payment_refused' AND tx_sig LIKE '0x%' AND error_msg LIKE '%tempo%' AND ts >= ?").all(now - 86400e3);
  for (const r of rows) {
    const key = String(r.tx_sig).toLowerCase();
    if (state.lateTempo[key]) continue;
    const rc = await tempoReceipt(key);
    if (rc === undefined) continue;
    if (rc === null) { if (now - r.ts > TEMPO_FINAL_AFTER) state.lateTempo[key] = { at: now, landed: false }; continue; }
    if (rc.status !== '0x1') { state.lateTempo[key] = { at: now, landed: 'reverted' }; continue; }
    const moved = (rc.logs || []).filter((l) => l.topics && l.topics[0] === TOPIC_TRANSFER && `0x${l.topics[2].slice(26)}`.toLowerCase() !== FEE_MANAGER)
      .map((l) => `${Number(BigInt(l.data)) / 1e6} ${TEMPO_TOKENS[String(l.address).toLowerCase()] || l.address} to 0x${l.topics[2].slice(26)}`);
    const text = [
      'AgentFeed: a REFUSED tempo payment landed on-chain (the buyer paid, got no data)',
      `route: ${r.tool} (calls row ${r.id}, ${new Date(r.ts).toISOString()})`,
      `payer: ${r.payer_wallet || '?'}${isOwn(r) ? ' (own)' : ''}`,
      `moved: ${moved.join('; ') || 'no transfer found'}`,
      `tx: ${key}`,
      'refund by hand from the treasury',
    ].join('\n');
    if (await send(text)) { state.lateTempo[key] = { at: now, landed: true }; console.log(`${new Date().toISOString()} late tempo landing alert sent for ${key.slice(0, 12)}`); }
  }
  for (const k of Object.keys(state.lateTempo)) if (now - state.lateTempo[k].at > 7 * 86400e3) delete state.lateTempo[k];
}

// ---- Circle refusing the Arc rail. The first matching row is an alert (the first payment after a key change is usually our own, so own wallets
// count here, unlike the burst alert); further rows within the quiet hour are counted and folded into the next alert. State: the last audit row id
// seen (ids only grow, a row logged late by a slow request still has a higher id than the ones before it), when we last alerted, rows held back.
// A failed Telegram send leaves the state alone, so the next run (5 min later) tries again.
async function circleAuthAlert(db, state, now, io = {}) {
  const sendFn = io.send || send, log = io.log || console.log;
  const baseline = () => db.prepare('SELECT COALESCE(MAX(id), 0) m FROM calls WHERE ts < ?').get(now - BURST_WINDOW).m;
  const cs = state.circleAuth || (state.circleAuth = { lastId: baseline(), alertedAt: 0, held: 0 });
  if (cs.lastId > db.prepare('SELECT COALESCE(MAX(id), 0) m FROM calls').get().m) cs.lastId = baseline(); // a restored or replaced table
  const rows = circleAuthRowsSince(db, cs.lastId);
  if (!rows.length) return 0;
  const last = rows[rows.length - 1];
  if (cs.alertedAt && now - cs.alertedAt < QUIET_AFTER_ALERT) { cs.held += rows.length; cs.lastId = last.id; return 0; }
  const reasons = {};
  for (const r of rows) { const k = String(r.error_msg).replace(/^(?:settlement|verification) refused: /i, '').replace(/\s+/g, ' ').slice(0, 160); reasons[k] = (reasons[k] || 0) + 1; }
  const routes = {}; for (const r of rows) routes[r.tool] = (routes[r.tool] || 0) + 1;
  const payers = [...new Set(rows.map((r) => `${r.payer_wallet ? `${r.payer_wallet.slice(0, 8)}…` : `ip ${r.ip || '?'}`}${isOwn(r) ? ' (own)' : ''}`))];
  const n = rows.length + cs.held;
  const text = [
    `AgentFeed: Circle refused ${n} Arc payment${n === 1 ? '' : 's'} on authorisation grounds, the Arc rail is failing`,
    ...Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, c]) => `  ${c}x ${m}`),
    `routes: ${Object.entries(routes).sort((a, b) => b[1] - a[1]).map(([t, c]) => (c > 1 ? `${t} x${c}` : t)).join(', ').slice(0, 300)}`,
    `payers: ${payers.slice(0, 5).join(', ')}${payers.length > 5 ? ` and ${payers.length - 5} more` : ''}`,
    `first ${stamp(rows[0].ts)}, last ${stamp(last.ts)} UTC${cs.held ? `; ${cs.held} more were held back during the last quiet hour` : ''}`,
    'Usually the key, its IP allow-list or the account at Circle rather than the buyer; Arc payments keep failing until it is fixed.',
    "check (prints the key TYPE and Circle's HTTP status, never the key): ssh root@167.233.69.154 'cd /opt/agentfeed && node ops/circle-key-check.js'",
    "test a replacement key without touching .env: ssh -t root@167.233.69.154 'cd /opt/agentfeed && node ops/circle-key-check.js --stdin'",
  ].join('\n');
  if (!(await sendFn(text))) return 0;
  cs.alertedAt = now; cs.held = 0; cs.lastId = last.id;
  log(`${new Date(now).toISOString()} circle auth alert sent (${n} refusal${n === 1 ? '' : 's'}, last row ${last.id})`);
  return n;
}

// ---- Apify comp keys running low. The four Apify actors spend comp keys (api_keys, label starting 'apify'); a key at 0 makes its actor fail, and
// Apify marks an actor "under maintenance" after 3 failed daily tests. One alert per key when its balance is under KEY_LOW_MICRO, then quiet for
// KEY_LOW_QUIET (an hour would be 24 messages a day for one unattended key). A key back above the line is forgotten, so its next drop alerts at once.
// A failed Telegram send leaves the state alone, so the next run (5 min later) tries again. AF_KEY_LOW_MICRO overrides the line for a dry test.
const KEY_LOW_MICRO = Number(process.env.AF_KEY_LOW_MICRO) || 5000000;   // $5
const KEY_LOW_QUIET = 6 * 3600e3;
async function keyLowAlert(db, state, now, io = {}) {
  const sendFn = io.send || send, log = io.log || console.log;
  let rows;
  try { rows = db.prepare("SELECT prefix, label, balance_micro FROM api_keys WHERE status = 'active' AND label LIKE 'apify%' AND balance_micro < ? ORDER BY balance_micro, prefix").all(KEY_LOW_MICRO); }
  catch { return 0; } // no api_keys table yet (lib/keys.js creates it at boot)
  const seen = state.keyLow || (state.keyLow = {});
  for (const p of Object.keys(seen)) if (!rows.some((r) => r.prefix === p)) delete seen[p];
  const due = rows.filter((r) => !seen[r.prefix] || now - seen[r.prefix] >= KEY_LOW_QUIET);
  if (!due.length) return 0;
  const text = [
    `AgentFeed: ${due.length} Apify comp key${due.length === 1 ? ' is' : 's are'} under ${usd(KEY_LOW_MICRO / 1e6)}, its actor fails at 0`,
    ...due.map((r) => `  ${r.label} (${r.prefix}): ${usd(r.balance_micro / 1e6)} left`),
    'Apify marks an actor under maintenance after 3 failed daily tests. Grant a new key and put it in that actor before it reaches 0.',
    "balances: ssh root@167.233.69.154 'cd /opt/agentfeed && node ops/key-admin.mjs list'",
  ].join('\n');
  if (!(await sendFn(text))) return 0;
  for (const r of due) seen[r.prefix] = now;
  log(`${new Date(now).toISOString()} apify key low alert sent (${due.map((r) => r.prefix).join(', ')})`);
  return due.length;
}

// The move-alert calibration table (pensio, 30 Oct 2026). /api/move-alert refuses a table older than 45 days (it then answers 503), and the weekly cron job
// bin/brief-calibrate.js is what keeps it young. From day 30 this sends ONE Telegram line a day (the first --alert run of each UTC day), so a refresh that stopped
// working is seen about two weeks before the route fails. Same path as every other alert here (send(): the token is read from the env file and never printed). A failed
// send leaves the day unmarked, so the next run tries again. The files are the ones tools/briefs/move.js reads; the newer fetched_at counts.
const CAL_FILES = () => (process.env.BRIEF_CALIBRATION ? process.env.BRIEF_CALIBRATION.split(',') : [path.join(__dirname, '..', 'brief-calibration.json'), path.join(__dirname, '..', 'tools', 'briefs', 'calibration.json')]);
async function calibrationAlert(state, now, io = {}) {
  const sendFn = io.send || send, log = io.log || console.log;
  const { MAX_AGE_S } = require('../tools/briefs/config');
  let fetched = null;
  for (const f of io.files || CAL_FILES()) {
    try { const t = Date.parse(JSON.parse(fs.readFileSync(f, 'utf8')).fetched_at); if (Number.isFinite(t) && (fetched == null || t > fetched)) fetched = t; } catch { /* absent or unreadable */ }
  }
  const warnDays = MAX_AGE_S.calibration_warn / 86400, refuseDays = MAX_AGE_S.calibration / 86400;
  const ageDays = fetched == null ? null : Math.floor((now - fetched) / 86400e3);
  if (ageDays != null && ageDays < warnDays) return 0;
  const day = new Date(now).toISOString().slice(0, 10);
  const seen = state.calibration || (state.calibration = {});
  if (seen.day === day) return 0;
  const text = ageDays == null
    ? 'AgentFeed: no readable move-alert calibration table, so /api/move-alert answers 503 (not billed) until one is written. Run bin/brief-calibrate.js; its log: /opt/agentfeed/brief-calibrate.log (cron: Mondays 04:10 UTC).'
    : `AgentFeed: the move-alert calibration table is ${ageDays} days old; the route refuses it after ${refuseDays} (${ageDays >= refuseDays ? 'now: /api/move-alert answers 503, not billed' : `${refuseDays - ageDays} days left`}). The weekly refresh is not replacing it: read /opt/agentfeed/brief-calibrate.log (cron: Mondays 04:10 UTC).`;
  if (!(await sendFn(text))) return 0;
  seen.day = day;
  log(`${new Date(now).toISOString()} calibration age alert sent (${ageDays == null ? 'no table' : `${ageDays} days`})`);
  return 1;
}

// ---- The USDC account of every Solana payTo (R22, 30 Oct 2026). A Solana x402 payment pays the payTo's associated USDC account. A wallet cleanup closed the treasury's at 08:10:41Z and it was
// recreated at 10:35:14Z; meanwhile every Solana payment would have been refused at verification ("simulation failed: transaction would fail"), and nothing here said so (the one refusal in
// those 2 h 25 min was our own QA wallet, at 10:30). So every --alert run (5 min) reads the live manifest, takes each distinct Solana (payTo, USDC mint), derives the associated token
// account and asks lib/solrpc whether it exists: ONE Telegram line when it does not, then quiet for an hour (QUIET_AFTER_ALERT); a present account clears the state, so the next closure
// alerts at once. An RPC error, an unreadable manifest or an answer of an unexpected shape is logged and is NOT a missing account: no alert and no state change. Only the classic token
// program's USDC is checked (a Token-2022 asset would derive another address and read as missing). The cron runs without the service's env file, so the RPC settings are read from it here,
// by name, and never printed.
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const RPC_ENV_NAMES = ['SOLANA_RPC_URL', 'HELIUS_RPC', 'HELIUS_API_KEY', 'RPC_FALLBACKS', 'RPC_CUPS', 'RPC_HEAVY_SKIP', 'RPC_PROGRAM_SKIP'];
const MANIFEST_URL = () => process.env.AF_MANIFEST_URL || 'http://127.0.0.1:3006/.well-known/x402.json';
const SERVICE_ENV = () => process.env.AF_SERVICE_ENV || path.join(__dirname, '..', '.env');

/** every distinct { payTo, asset } the manifest offers on a Solana network (CAIP-2 `solana:...`) */
function solanaPayTos(manifest) {
  const seen = new Map();
  for (const r of (manifest && manifest.resources) || []) for (const a of r.accepts || []) {
    if (!/^solana:/.test(String(a.network || '')) || typeof a.payTo !== 'string' || typeof a.asset !== 'string') continue;
    seen.set(`${a.payTo}|${a.asset}`, { payTo: a.payTo, asset: a.asset });
  }
  return [...seen.values()];
}
/** the associated token account of `owner` for `mint` under the classic token program */
async function usdcAccountOf(owner, mint = USDC_MINT) {
  const k = require('@solana/kit');
  const enc = k.getAddressEncoder();
  const [ata] = await k.getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [enc.encode(owner), enc.encode(TOKEN_PROGRAM), enc.encode(mint)] });
  return ata;
}
function loadRpcEnv() {
  let text = '';
  try { text = fs.readFileSync(SERVICE_ENV(), 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && RPC_ENV_NAMES.includes(m[1]) && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
async function readManifest() {
  const r = await fetch(MANIFEST_URL(), { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`manifest HTTP ${r.status}`);
  return r.json();
}
async function treasuryAlert(state, now, io = {}) {
  const sendFn = io.send || send, log = io.log || console.log;
  let targets;
  try { targets = (io.targets || solanaPayTos(await readManifest())).filter((t) => t.asset === USDC_MINT); } catch (e) { log(`${new Date(now).toISOString()} treasury usdc check: manifest unreadable (${String(e && e.message).slice(0, 80)}); nothing checked`); return 0; }
  if (!targets.length) { log(`${new Date(now).toISOString()} treasury usdc check: no Solana USDC payTo in the manifest; nothing checked`); return 0; }
  const rpcFn = io.rpc || (() => { loadRpcEnv(); return require('../lib/solrpc').rpc; })();
  const seen = state.treasury || (state.treasury = {});
  let alerts = 0, present = 0;
  for (const t of targets) {
    const ata = await (io.account || usdcAccountOf)(t.payTo, t.asset);
    let res;
    try { res = await rpcFn('getAccountInfo', [ata, { encoding: 'base64', commitment: 'confirmed' }]); }
    catch (e) { log(`${new Date(now).toISOString()} treasury usdc check: rpc error for ${ata.slice(0, 8)}… (${String(e && e.message).slice(0, 80)}); not reported as missing`); continue; }
    if (!res || typeof res !== 'object' || !('value' in res)) { log(`${new Date(now).toISOString()} treasury usdc check: unexpected rpc answer for ${ata.slice(0, 8)}…; not reported as missing`); continue; }
    if (res.value) {
      present++;
      if (seen[ata]) { delete seen[ata]; log(`${new Date(now).toISOString()} treasury usdc account ${ata.slice(0, 8)}… is back`); }
      continue;
    }
    if (seen[ata] && now - seen[ata].alertedAt < QUIET_AFTER_ALERT) continue;
    const text = `AgentFeed: the USDC account ${ata} of the Solana payTo ${t.payTo} does not exist, so every Solana payment is refused at verification (the payer is not charged). Recreate it (send USDC to the payTo, or spl-token create-account ${t.asset} --owner ${t.payTo}); the next reminder is in 1 hour.`;
    if (await sendFn(text)) { seen[ata] = { alertedAt: now, payTo: t.payTo }; alerts++; log(`${new Date(now).toISOString()} treasury usdc account missing: alert sent (${ata.slice(0, 8)}…)`); }
  }
  if (DRY) log(`${new Date(now).toISOString()} treasury usdc check (dry): ${targets.length} Solana payTo, ${present} account(s) present, ${alerts} alert(s) that would be sent`);
  return alerts;
}

async function alert(db) {
  const now = Date.now();
  const rows = db.prepare(`SELECT ts, tool, payer_wallet, ip, user_agent, error_msg FROM calls WHERE status='payment_refused' AND NOT COALESCE(${RESYNC_SQL}, 0) AND ts >= ?`).all(now - BURST_WINDOW);
  const state = loadState();
  const g = {};
  for (const r of rows) { if (isOwn(r)) continue; const k = normPayer(r.payer_wallet) || r.ip || '?'; (g[k] = g[k] || []).push(r); }
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
  try { await circleAuthAlert(db, state, now); } catch (e) { console.log(`${new Date().toISOString()} circle auth alert failed: ${String(e && e.message).slice(0, 160)}`); }
  await lateTempo(db, state, now);
  try { await keyLowAlert(db, state, now); } catch (e) { console.log(`${new Date().toISOString()} apify key low alert failed: ${String(e && e.message).slice(0, 160)}`); }
  try { await calibrationAlert(state, now); } catch (e) { console.log(`${new Date().toISOString()} calibration age alert failed: ${String(e && e.message).slice(0, 160)}`); }
  try { await treasuryAlert(state, now); } catch (e) { console.log(`${new Date().toISOString()} treasury usdc check failed: ${String(e && e.message).slice(0, 160)}`); }
  saveState(state);
}

if (require.main === module) (async () => {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  if (args.has('--digest')) await digest(db);
  else if (args.has('--alert')) await alert(db);
  else { console.error('usage: node ops/af-digest.js --digest [--force] [--test] | --alert [--dry]'); process.exit(1); }
})().catch((e) => { console.log(`${new Date().toISOString()} af-digest failed: ${String(e.message).slice(0, 200)}`); process.exit(1); });

module.exports = { treasuryAlert, solanaPayTos, usdcAccountOf, calibrationAlert, shapeOf, isOwn, yesterday, offsetMin, digestText, keysLines, circleAuthAlert, keyLowAlert, circleAuthRowsBetween, CIRCLE_AUTH_RE };
