#!/usr/bin/env node
// ops/key-admin.mjs — prepaid API keys, box only, no HTTP (R9 K1). Reads and writes agentfeed.db api_keys.
//
//   node ops/key-admin.mjs list
//   node ops/key-admin.mjs revoke <prefix>
//   node ops/key-admin.mjs set-rate <prefix> <n>            requests per minute, 1-6000
//   node ops/key-admin.mjs grant <usd> --label <x> [--out <file>]
//   node ops/key-admin.mjs grant-pass <days> --label <x> [--day] [--signals] [--out <file>]   a comp pass, no balance: good only on its routes;
//                                                                         default: the bot pass's /api/liq-feed; --day: the day pass's routes (/api/liq-feed and /api/liquidations);
//                                                                         --signals: the signals pass's routes (the briefs and the perp signal routes); --signals --day: the signals
//                                                                         day pass (24 hours, <days> must be 1). Sold 0 either way: a comp pass is never revenue.
//
// grant makes a comp or partner key (a gateway such as claw402, or a proof run), active at once, sold_micro 0, so it
// never reads as revenue. The key is printed ONCE to this terminal; with --out it is written to <file> (mode 600) and
// only its prefix is printed, so a scripted proof never puts it in a log. Nothing else on the box keeps it.
// <prefix> is the 8 characters after afk_, or the start of the key's sha256 for a key bought by hash and never used.
// AGENTFEED_DB overrides the database (a scratch copy); the default is agentfeed.db beside this repo.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { makeKeyStore, toUsd, showRoute, PASS, DAY_PASS, SIGNALS_PASS, SIGNALS_DAY_PASS } = require('../lib/keys');

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = process.env.AGENTFEED_DB || path.join(here, '..', 'agentfeed.db');
const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const die = (msg) => { console.error(msg); process.exit(1); };
const iso = (ms) => (ms ? new Date(ms).toISOString().replace('.000Z', 'Z') : '-');

if (!cmd || !['list', 'revoke', 'set-rate', 'grant', 'grant-pass'].includes(cmd)) die('usage: key-admin.mjs list | revoke <prefix> | set-rate <prefix> <n> | grant <usd> --label <x> [--out <file>] | grant-pass <days> --label <x> [--day] [--signals] [--out <file>]');
if (!fs.existsSync(DB)) die(`no database at ${DB}`);
const db = new Database(DB);
db.pragma('busy_timeout = 5000');
const store = makeKeyStore(db);

function one(prefix) {
  if (!prefix || String(prefix).length < 6) die('give at least 6 characters of the prefix');
  const rows = store.find(prefix);
  if (rows.length === 0) die(`no key matches ${prefix}`);
  if (rows.length > 1) die(`${rows.length} keys match ${prefix}; give more characters`);
  return rows[0];
}
const label = (r) => r.prefix || `#${r.key_hash.slice(0, 7)}`;

if (cmd === 'list') {
  const rows = store.list();
  const cols = ['prefix', 'status', 'balance', 'sold', 'spent', 'calls', 'rate', 'created', 'last_used', 'buyer', 'label', 'expires', 'allow'];
  console.log(cols.join('\t'));
  for (const r of rows) {
    console.log([label(r), r.status, toUsd(r.balance_micro), toUsd(r.sold_micro), toUsd(r.spent_micro), r.calls, r.rate_per_min, iso(r.created), iso(r.last_used),
      r.buyer ? String(r.buyer).slice(0, 12) : '-', r.label || '-', iso(r.expires_at), r.allow || '-'].join('\t'));
  }
  const active = rows.filter((r) => r.status === 'active');
  console.log(`# ${rows.length} keys, ${active.length} active, outstanding $${toUsd(active.reduce((a, r) => a + r.balance_micro, 0))}`);
} else if (cmd === 'revoke') {
  const r = one(args[0]);
  store.setStatus(r.key_hash, 'revoked');
  console.log(`revoked ${label(r)} (balance $${toUsd(r.balance_micro)} left on it)`);
} else if (cmd === 'set-rate') {
  const r = one(args[0]);
  const n = Number(args[1]);
  if (!Number.isInteger(n) || n < 1 || n > 6000) die('rate must be an integer from 1 to 6000 requests per minute');
  store.setRate(r.key_hash, n);
  console.log(`${label(r)} rate_per_min ${r.rate_per_min} -> ${n}`);
} else if (cmd === 'grant-pass') {
  const days = Number(args[0]);
  if (!Number.isInteger(days) || days < 1 || days > 365) die('grant-pass takes a number of days from 1 to 365');
  const lbl = flag('--label');
  if (!lbl) die('grant-pass needs --label <x> (who or what the pass is for)');
  const out = flag('--out');
  if (out && fs.existsSync(out)) die(`${out} exists; refusing to overwrite a key file`);
  const day = args.includes('--day');
  const kind = args.includes('--signals') ? (day ? SIGNALS_DAY_PASS : SIGNALS_PASS) : (day ? DAY_PASS : PASS);
  if (args.includes('--signals') && day && days !== kind.days) die(`a signals day pass is ${kind.days} day: grant-pass ${kind.days} --signals --day`);
  const key = store.grantPass({ days, allow: kind.allow, label: lbl });
  const prefix = key.slice(4, 12);
  if (out) {
    fs.writeFileSync(out, key + '\n', { mode: 0o600 });
    fs.chmodSync(out, 0o600);
    console.log(`granted a ${days}-day ${kind.label} (${kind.allow.map(showRoute).join(', ')}) to ${lbl}: prefix ${prefix}, key written to ${out} (mode 600, ${key.length} chars)`);
  } else {
    console.log(`granted a ${days}-day ${kind.label} (${kind.allow.map(showRoute).join(', ')}) to ${lbl}: prefix ${prefix}`);
    console.log(`key (shown once, not stored anywhere): ${key}`);
  }
} else if (cmd === 'grant') {
  const usd = Number(args[0]);
  if (!Number.isFinite(usd) || usd <= 0 || usd > 100) die('grant takes a USD amount above 0 and at most 100');
  const lbl = flag('--label');
  if (!lbl) die('grant needs --label <x> (who or what the key is for)');
  const out = flag('--out');
  if (out && fs.existsSync(out)) die(`${out} exists; refusing to overwrite a key file`);
  const key = store.grant(usd, lbl);
  const prefix = key.slice(4, 12);
  if (out) {
    fs.writeFileSync(out, key + '\n', { mode: 0o600 });
    fs.chmodSync(out, 0o600);
    console.log(`granted $${usd} to ${lbl}: prefix ${prefix}, key written to ${out} (mode 600, ${key.length} chars)`);
  } else {
    console.log(`granted $${usd} to ${lbl}: prefix ${prefix}`);
    console.log(`key (shown once, not stored anywhere): ${key}`);
  }
}
db.close();
