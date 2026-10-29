// ops/funnel.js (pensio): the 402-to-paid funnel report, read-only, tested on FIXTURES only (a synthetic database written here; it never touches agentfeed.db).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const F = require('../ops/funnel');
const { passOf } = require('../lib/keys');

const NOW = Date.UTC(2026, 9, 29, 15, 0, 0);
const D0 = '2026-10-29', D1 = '2026-10-28';
const ms = (day, hm = '10:00') => Date.parse(`${day}T${hm}:00Z`);
const EVM_PAYER = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const SOL_PAYER = 'Ho1xSwRYyxwWSD7qgGqe3zZ9tUDYbnZ6nRWdYtcRsQTb';
const OWN = 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu';              // an own / test payer af-digest already lists
const EVM_TX = '0x' + '5e'.repeat(32), SOL_TX = '3'.repeat(88);
const IP = '203.0.113.77';

function fixture(file, { tables = true } = {}) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool TEXT NOT NULL, payer_wallet TEXT, tx_sig TEXT, amount_usdc REAL, status TEXT NOT NULL, latency_ms INTEGER, ip TEXT, error_msg TEXT, req_host TEXT, req_path TEXT, user_agent TEXT, method TEXT);`);
  const ins = db.prepare('INSERT INTO calls (ts, tool, payer_wallet, tx_sig, amount_usdc, status, ip, error_msg, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const row = (day, tool, status, o = {}) => ins.run(ms(day, o.hm), tool, o.payer ?? null, o.tx ?? null, o.usd ?? null, status, IP, o.err ?? null, o.ua ?? 'curl/8.4.0');
  if (tables) {
    db.exec(`CREATE TABLE unpaid_402 (day TEXT NOT NULL, route TEXT NOT NULL, ip TEXT NOT NULL, user_agent TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, route, ip, user_agent)) WITHOUT ROWID;
      CREATE TABLE api_keys (key_hash TEXT PRIMARY KEY, prefix TEXT, status TEXT, balance_micro INTEGER, pass_days INTEGER, expires_at INTEGER, allow TEXT);`);
    const u = db.prepare('INSERT INTO unpaid_402 VALUES (?, ?, ?, ?, ?)');
    u.run(D0, 'get_morning_brief', IP, 'curl/8.4.0', 10); u.run(D0, 'get_morning_brief', '203.0.113.78', 'python-httpx/0.27.0', 6); u.run(D0, 'get_move_alert', IP, 'Mozilla/5.0 (X11) Chrome/120', 4);
    u.run(D1, 'get_morning_brief', IP, 'curl/8.4.0', 7); u.run('2026-10-20', 'get_anomaly_flag', IP, 'curl/8.4.0', 100);
    const k = db.prepare('INSERT INTO api_keys VALUES (?, ?, ?, ?, ?, ?, ?)');
    k.run('h1', 'AAAAAAAA', 'active', 0, 30, null, '/api/morning-brief,/api/move-alert,/api/anomaly-flag'); k.run('h2', 'BBBBBBBB', 'active', 500000, null, null, null);
  }
  row(D0, 'get_morning_brief', 'paid', { payer: EVM_PAYER.toLowerCase(), tx: EVM_TX, usd: 0.03 }); row(D0, 'get_morning_brief', 'paid', { payer: EVM_PAYER, tx: EVM_TX, usd: 0.03 }); row(D0, 'get_morning_brief', 'paid', { payer: EVM_PAYER, tx: EVM_TX, usd: 0.03 });
  row(D0, 'get_morning_brief', 'paid', { payer: SOL_PAYER, tx: SOL_TX, usd: 0.03, ua: 'python-httpx/0.27.0' });
  row(D0, 'get_move_alert', 'paid', { payer: SOL_PAYER, tx: SOL_TX, usd: 0.02, ua: 'Mozilla/5.0 (X11) Chrome/120' });
  row(D0, 'get_morning_brief', 'paid', { payer: OWN, tx: SOL_TX, usd: 0.03 });                                                  // an own wallet: left out by default
  row(D0, 'get_morning_brief', 'payment_refused', { payer: EVM_PAYER, err: 'verification refused: invalid_exact_evm_payload_signature' }); row(D0, 'get_morning_brief', 'payment_refused', { err: 'verification refused: invalid_exact_evm_payload_signature' });
  row(D0, 'get_morning_brief', 'payment_refused', { err: 'settlement refused: insufficient_funds', ua: 'python-httpx/0.27.0' });
  for (let i = 0; i < 4; i++) row(D0, 'get_morning_brief', 'key', { payer: 'key:AAAAAAAA', usd: 0, ua: 'hermes-agent/1.0' });       // a brief pass: nothing drawn
  for (let i = 0; i < 2; i++) row(D1, 'get_signal_board', 'key', { payer: 'key:BBBBBBBB', usd: 0.005, ua: 'hermes-agent/1.0' });  // a prepaid pack: half price drawn
  row(D0, 'get_fear_greed', 'free'); row(D1, 'get_morning_brief', 'paid', { payer: EVM_PAYER, tx: EVM_TX, usd: 0.03 });
  row('2026-10-20', 'get_anomaly_flag', 'paid', { payer: EVM_PAYER, tx: EVM_TX, usd: 0.02 });                                    // outside a 7-day window
  db.close();
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'funnel-'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const isOwn = (r) => r.payer_wallet === OWN;
const { shapeOf } = require('../ops/af-digest');
const report = (file, o = {}) => { const db = F.openDb(file); try { return F.buildReport(db, { now: NOW, isOwn, shapeOf, passKindOf: (r) => passOf(r).id, ...o }); } finally { db.close(); } };

test('uaFamily: the client family, not its version; empty and "-" are none', () => {
  const cases = { 'curl/8.4.0': 'curl', 'python-httpx/0.27.0': 'python', 'python-requests/2.31': 'python', 'Go-http-client/2.0': 'go', 'node-fetch/1.0': 'node', 'undici': 'node', 'Mozilla/5.0 (X11; Linux) Chrome/120': 'browser',
    'Googlebot/2.1': 'search bot', 'x402scan/1.0': 'agentcash / x402scan', 'AgentCash/2': 'agentcash / x402scan', 'hermes-agent/1.0': 'hermes-agent', '': 'none', '-': 'none', null: 'none', 'PostmanRuntime/7.36': 'api tool' };
  for (const [ua, fam] of Object.entries(cases)) assert.equal(F.uaFamily(ua === 'null' ? null : ua), fam, ua);
  assert.equal(F.uaFamily('Weird Client 9.1'), 'weird');
});
test('railOf: the rail from the transaction and payer shapes; the table stores no network', () => {
  assert.equal(F.railOf({ tx_sig: EVM_TX }), 'evm');
  assert.equal(F.railOf({ payer_wallet: EVM_PAYER }), 'evm');
  assert.equal(F.railOf({ tx_sig: SOL_TX }), 'solana');
  assert.equal(F.railOf({ payer_wallet: SOL_PAYER }), 'solana');
  assert.equal(F.railOf({}), 'unknown');
});
test('report: 402s, paid by rail, refused by reason, key and pass calls, conversion; per route, UA family and day; own wallets and rows outside the window left out', () => {
  const d = tmp(); const f = path.join(d, 'af.db'); fixture(f);
  const r = report(f);
  const cell = (day, route, fam) => r.rows.find((x) => x.day === day && x.route === route && x.ua_family === fam);
  const m = cell(D0, 'get_morning_brief', 'curl');
  assert.deepEqual([m.unpaid_402, m.paid, m.paid_by_rail, m.conversion], [10, 3, { solana: 0, evm: 3, unknown: 0 }, 0.3]);
  assert.equal(m.paid_usd, 0.09);
  const mp = cell(D0, 'get_morning_brief', 'python');
  assert.deepEqual([mp.unpaid_402, mp.paid, mp.paid_by_rail.solana, mp.conversion], [6, 1, 1, 0.1667]);
  assert.deepEqual(mp.refused_by_reason, { 'v2: insufficient_funds': 1 });
  assert.deepEqual(m.refused_by_reason, { 'v2 evm: invalid_exact_evm_payload_signature': 2 });
  const mv = cell(D0, 'get_move_alert', 'browser');
  assert.deepEqual([mv.unpaid_402, mv.paid, mv.conversion], [4, 1, 0.25]);
  const k = cell(D0, 'get_morning_brief', 'hermes-agent');
  assert.deepEqual([k.key_calls, k.key_calls_by_kind, k.unpaid_402, k.conversion], [4, { brief: 4 }, 0, null]);
  assert.deepEqual(cell(D1, 'get_signal_board', 'hermes-agent').key_calls_by_kind, { pack: 2 });
  assert.equal(cell(D1, 'get_morning_brief', 'curl').paid, 1);
  assert.ok(!r.rows.some((x) => x.route === 'get_anomaly_flag'), 'a day before the window is not counted (402s or paid)');
  assert.ok(!r.rows.some((x) => x.route === 'get_fear_greed'), 'free rows are not part of the funnel');
  assert.deepEqual(r.totals, { unpaid_402: 27, paid: 6, paid_usd: 0.17, refused: 3, key_calls: 6, conversion: 0.2222 });
  assert.equal(r.routes[0].route, 'get_morning_brief');
  assert.ok(r.notes.some((n) => /1 paid or refused rows from own \/ test wallets/.test(n)));
  assert.ok(r.notes.some((n) => /every EVM chain reads as evm/.test(n)));
  const all = report(f, { all: true });
  assert.equal(all.totals.paid, 7, '--all keeps the own wallet');
  const one = report(f, { days: 1 });
  assert.deepEqual([one.window.from_day, one.window.to_day, one.totals.unpaid_402], [D0, D0, 20], '--days 1 is today only');
  fs.rmSync(d, { recursive: true, force: true });
});
test('payers are shown as normPayer prefixes only; no full address, no IP, in the text, the JSON or the line', () => {
  const d = tmp(); const f = path.join(d, 'af.db'); fixture(f);
  const r = report(f);
  const text = F.render(r) + JSON.stringify(r) + F.line(r);
  assert.ok(text.includes('0xabcdef…'), 'the EVM payer appears lower-cased, 8 characters then an ellipsis');
  assert.ok(text.includes('Ho1xSwRY…'));
  for (const secret of [EVM_PAYER, EVM_PAYER.toLowerCase(), SOL_PAYER, EVM_TX, SOL_TX, IP, '203.0.113.78']) assert.ok(!text.includes(secret), `${secret.slice(0, 12)} must not be printed`);
  assert.ok(!text.includes(OWN.slice(0, 8)), 'an excluded own wallet is not printed at all');
  fs.rmSync(d, { recursive: true, force: true });
});
test('read-only: the handle refuses a write, and a report leaves the database file byte for byte as it was', () => {
  const d = tmp(); const f = path.join(d, 'af.db'); fixture(f);
  const db = F.openDb(f);
  assert.throws(() => db.exec('CREATE TABLE intruder (a)'), /readonly|read-only|attempt to write/i);
  assert.throws(() => db.prepare('INSERT INTO calls (ts, tool, status) VALUES (1, \'x\', \'paid\')').run(), /readonly|read-only|attempt to write/i);
  db.close();
  const before = sha(f);
  report(f);
  assert.equal(sha(f), before);
  assert.throws(() => F.openDb(path.join(d, 'missing.db')), /does not exist|unable to open/i, 'a missing file is an error, never a fresh empty database');
  fs.rmSync(d, { recursive: true, force: true });
});
test('missing tables: a database without unpaid_402 or api_keys still reports, and says what is missing', () => {
  const d = tmp(); const f = path.join(d, 'af.db'); fixture(f, { tables: false });
  const r = report(f);
  assert.ok(r.notes.some((n) => /unpaid_402 table does not exist/.test(n)));
  assert.equal(r.totals.unpaid_402, 0);
  assert.equal(r.totals.paid, 6);
  assert.equal(r.rows.find((x) => x.day === D0 && x.route === 'get_morning_brief' && x.ua_family === 'hermes-agent').key_calls_by_kind['pass (kind unknown)'], 4, 'without api_keys a key row that drew nothing is a pass of unknown kind');
  fs.rmSync(d, { recursive: true, force: true });
});
test('CLI: --json, the text report and --line on a fixture database; a bad --days and a missing database exit 1; own wallets are left out by default and kept by --all', () => {
  const d = tmp(); const f = path.join(d, 'af.db'); fixture(f);
  const run = (...a) => spawnSync(process.execPath, [path.join(__dirname, '..', 'ops', 'funnel.js'), ...a], { encoding: 'utf8', env: { PATH: process.env.PATH, OVERHANG_DB_PATH: process.env.OVERHANG_DB_PATH || path.join(d, 'x.db') } });
  const j = run('--db', f, '--days', '365', '--json');
  assert.equal(j.status, 0, j.stderr);
  const rep = JSON.parse(j.stdout);
  assert.ok(rep.rows.length > 5 && rep.window.days === 365);
  assert.ok(!j.stdout.includes('Gack9Utq'), 'the own wallet is excluded by default (af-digest.js own-wallet list)');
  assert.ok(run('--db', f, '--days', '365', '--json', '--all').stdout.includes('Gack9Utq'));
  const t = run('--db', f);
  assert.match(t.stdout, /^AgentFeed funnel, .* UTC \(7 days, \d+ audit rows read\)/);
  assert.match(t.stdout, /PER ROUTE/);
  assert.match(run('--db', f, '--days', '365', '--line').stdout, /^Funnel \d{4}-\d\d-\d\d\.\.\d{4}-\d\d-\d\d: 127 price reads \(402\), \d+ paid \(\$[\d.]+\), conversion [\d.]+%, \d+ refused, \d+ key\/pass calls; most read: get_anomaly_flag \(100, paid 1\)/);
  assert.equal(run('--db', f, '--days', '0').status, 1);
  assert.equal(run('--db', f, '--days', 'x').status, 1);
  assert.equal(run('--db', path.join(d, 'nope.db')).status, 1);
  fs.rmSync(d, { recursive: true, force: true });
});
