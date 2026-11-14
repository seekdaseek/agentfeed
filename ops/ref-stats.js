#!/usr/bin/env node
// ops/ref-stats.js [days=30]: unique outside callers per ref slug per day, from ref_hits (lib/ref-log.js). Own wallets are not in this table (callers are IPs); the box's own addresses and /opt/afwatch/own-ips.txt are excluded.
// Prints: day | ref | callers that got a free answer | callers that hit a paid route's 402. Read-only.
'use strict';
const fs = require('fs'); const path = require('path');
const Database = require('better-sqlite3');
const days = Math.max(1, Number(process.argv[2]) || 30);
const OWN = new Set(['167.233.69.154', '2a01:4f8:c015:eb5e::1', '127.0.0.1', '::1', '::ffff:127.0.0.1']);
try { for (const l of fs.readFileSync(process.env.AF_OWN_IPS || '/opt/afwatch/own-ips.txt', 'utf8').split('\n')) { const ip = l.replace(/#.*/, '').trim(); if (ip) OWN.add(ip); } } catch { /* box addresses only */ }
const pre = [...OWN].filter((ip) => ip.endsWith(':'));
const own = (ip) => OWN.has(ip) || pre.some((p) => ip.startsWith(p));
const db = new Database(process.env.AGENTFEED_DB || path.join(__dirname, '..', 'agentfeed.db'), { readonly: true, fileMustExist: true });
let rows = [];
try { rows = db.prepare(`SELECT day, ref, caller, kind, n FROM ref_hits WHERE day >= date('now', ?) ORDER BY day, ref`).all(`-${days} days`); } catch { console.log('no ref_hits table yet'); process.exit(0); }
const agg = {};
for (const r of rows) { if (own(r.caller)) continue; const k = `${r.day} | ${r.ref}`; const o = (agg[k] = agg[k] || { free: new Set(), u402: new Set() }); (r.kind === 'free' ? o.free : o.u402).add(r.caller); }
console.log('day | ref | free-answer callers | 402 callers');
for (const k of Object.keys(agg).sort()) console.log(k, '|', agg[k].free.size, '|', agg[k].u402.size);
const tot = {}; for (const [k, o] of Object.entries(agg)) { const ref = k.split(' | ')[1]; const t = (tot[ref] = tot[ref] || { free: new Set(), u402: new Set() }); o.free.forEach((x) => t.free.add(x)); o.u402.forEach((x) => t.u402.add(x)); }
console.log(`--- ${days} days, unique callers per ref`); for (const [ref, t] of Object.entries(tot).sort()) console.log(ref, '| free', t.free.size, '| 402', t.u402.size);

// R34: unknown-path (not_found) rows per day, without our own unpaid sweep (ops/r23-unpaid-sweep.mjs sends user agent 'r23-unpaid-sweep': 612 of the 6,553 not_found rows since 12 Oct were it).
// The rows stay in calls; they are only left out of this count. Prints: day | not_found rows | of them the sweep (left out).
try {
  const nf = db.prepare(`SELECT date(ts/1000, 'unixepoch') AS day, SUM(user_agent IS NOT 'r23-unpaid-sweep') AS counted, SUM(user_agent IS 'r23-unpaid-sweep') AS sweep FROM calls WHERE status = 'not_found' AND ts >= strftime('%s', 'now', ?) * 1000 GROUP BY 1 ORDER BY 1`).all(`-${days} days`);
  console.log('--- not_found rows per day, without the r23-unpaid-sweep user agent');
  console.log('day | not_found (counted) | sweep (left out)');
  for (const r of nf) console.log(r.day, '|', r.counted, '|', r.sweep);
} catch { console.log('no calls table to count not_found from'); }
