// lib/own-traffic.js (R22, 30 Oct 2026): ONE list of our own payer wallets for the digest, the funnel and afwatch. The owner's Base wallet 0xcc117788... bought the $1 balance key 3k9h2bvv
// on /keys at 11:14Z: own money, so it must never be counted as an outside payer, and neither may the calls its key made.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
process.env.OVERHANG_DB_PATH = process.env.OVERHANG_DB_PATH || path.join(os.tmpdir(), 'none.db');
const OT = require('../lib/own-traffic');
const { normPayer: auditNorm } = require('../lib/audit');
const DG = require('../ops/af-digest');
const F = require('../ops/funnel');

const BUYER = '0xcc1177889ff3fb19ed851c1dd9bf4b1871ee3736';        // the key row's buyer, from agentfeed.db api_keys prefix 3k9h2bvv
const OUTSIDE = '0x9a8b7c6d5e4f30211223344556677889900aabbc';
const NOW = Date.UTC(2026, 9, 30, 15, 0, 0);
const ms = (hm) => Date.parse(`2026-10-30T${hm}:00Z`);

test('the owner\'s buyer wallet is own, in any spelling; a lookalike and an outside wallet are not (negative controls)', () => {
  assert.equal(OT.isOwnWallet(BUYER), true);
  assert.equal(OT.isOwnWallet(BUYER.toUpperCase().replace('0X', '0x')), true, 'upper-case hex');
  assert.equal(OT.isOwnWallet('0xCc1177889Ff3fb19ED851c1dd9bf4b1871EE3736'), true, 'mixed case');
  assert.equal(OT.isOwnWallet(BUYER.slice(0, -1) + '7'), false, 'one character off is another wallet');
  assert.equal(OT.isOwnWallet('0xcc117788' + '0'.repeat(32)), false, 'same first 8 characters, other wallet');
  assert.equal(OT.isOwnWallet(OUTSIDE), false);
  assert.equal(OT.isOwnWallet(null), false);
  assert.equal(OT.isOwnWallet('key:3k9h2bvv'), false);
});

test('the five wallets that were already own still are', () => {
  for (const w of ['EqRNNpKVpu6jm8iRTNa17Rht2TRTzCtNNz37M9m2Di1', 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu', 'TeStKWyNre9PW8XbLfvuBm9f6EnTBYqS5GXTzciCnHw', '0xFEfF369D5048b2Cf817d87467E48404b3ADfE4Ee', '0x05b38ff795a2d750788157f1119e5d403d8ef47a']) assert.equal(OT.isOwnWallet(w), true, w);
  assert.equal(OT.OWN_WALLET_LIST.length, 6);
});

test('the local normPayer is lib/audit\'s, on every shape (so the two cannot drift)', () => {
  for (const v of [undefined, null, '', BUYER, BUYER.toUpperCase(), '0xABC', 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu', 'key:3k9h2bvv', 42]) assert.equal(OT.normPayer(v), auditNorm(v), String(v));
});

test('af-digest uses the shared list (the same Set), keeps no copy of it, and tags the buyer own whatever the IP', () => {
  assert.equal(DG.OWN_WALLETS, OT.OWN_WALLETS);
  const src = fs.readFileSync(path.join(__dirname, '..', 'ops', 'af-digest.js'), 'utf8');
  assert.ok(!/Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu|EqRNNpKVpu6jm8iRTNa17Rht2TRTzCtNNz37M9m2Di1/.test(src), 'no second copy of the wallet list in af-digest.js');
  assert.equal(DG.isOwn({ payer_wallet: BUYER, ip: '203.0.113.9' }), true, 'own by wallet, from a stranger\'s address');
  assert.equal(DG.isOwn({ payer_wallet: BUYER.toUpperCase().replace('0X', '0x'), ip: '203.0.113.9' }), true);
  assert.equal(DG.isOwn({ payer_wallet: OUTSIDE, ip: '203.0.113.9' }), false, 'an outside wallet from the same address is outside');
});

function fixture(file) {
  const db = new Database(file);
  db.exec(`CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool TEXT NOT NULL, payer_wallet TEXT, tx_sig TEXT, amount_usdc REAL, status TEXT NOT NULL, latency_ms INTEGER, ip TEXT, error_msg TEXT, req_host TEXT, req_path TEXT, user_agent TEXT, method TEXT);
    CREATE TABLE api_keys (key_hash TEXT PRIMARY KEY, prefix TEXT, status TEXT, balance_micro INTEGER, pass_days INTEGER, expires_at INTEGER, allow TEXT, buyer TEXT);`);
  const k = db.prepare('INSERT INTO api_keys VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  k.run('h1', 'OWNBUY01', 'active', 972500, null, null, null, BUYER);          // bought by the owner's wallet: own money
  k.run('h2', 'OUTBUY02', 'active', 500000, null, null, null, OUTSIDE);        // bought by an outside wallet
  k.run('h3', 'COMPGR03', 'active', 0, 30, null, '/api/morning-brief', 'grant');   // a comp grant (a partner's key): outside use, not own
  const i = db.prepare('INSERT INTO calls (ts, tool, payer_wallet, tx_sig, amount_usdc, status, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const row = (hm, tool, status, payer, usd) => i.run(ms(hm), tool, payer, null, usd, status, '203.0.113.50', 'curl/8.4.0');   // none of these comes from an address on the own-IP list
  row('11:14', 'buy_key_1', 'paid', BUYER, 1.0);                                // the owner's purchase: left out
  row('11:15', 'buy_key_1', 'paid', BUYER.toUpperCase().replace('0X', '0x'), 1.0);   // the same wallet, other spelling: left out
  row('11:16', 'buy_key_1', 'paid', OUTSIDE, 1.0);                              // an outside purchase: counted
  for (let n = 0; n < 4; n++) row('11:20', 'get_morning_brief', 'key', 'key:OWNBUY01', 0.015);   // the owner's key: left out
  for (let n = 0; n < 2; n++) row('11:21', 'get_morning_brief', 'key', 'key:OUTBUY02', 0.015);   // an outside key: counted
  row('11:22', 'get_morning_brief', 'key', 'key:COMPGR03', 0);                  // a comp grant: counted
  db.close();
}

test('funnel: the owner\'s purchase and the calls of the key it bought are left out; an outside purchase, an outside key and a comp grant are counted; --all keeps everything', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-funnel-'));
  const file = path.join(dir, 'af.db');
  fixture(file);
  const db = new Database(file, { readonly: true });
  try {
    const rep = F.buildReport(db, { days: 2, now: NOW, isOwn: DG.isOwn });
    assert.equal(rep.totals.paid, 1, 'one outside purchase');
    assert.equal(rep.totals.paid_usd, 1);
    const kinds = (r) => r.rows.reduce((a, x) => { for (const [k, n] of Object.entries(x.key_calls_by_kind)) a[k] = (a[k] || 0) + n; return a; }, {});
    assert.deepEqual(kinds(rep), { pack: 2, 'pass 30d': 1 }, 'the outside key\'s two calls and the comp grant\'s one; none of the owner\'s four');
    assert.equal(rep.totals.key_calls, 3);
    assert.match(rep.notes.join(' '), /2 paid or refused rows from own \/ test wallets and addresses were left out/);
    assert.match(rep.notes.join(' '), /4 calls of keys bought by own wallets were left out/);
    const all = F.buildReport(db, { days: 2, now: NOW, isOwn: DG.isOwn, all: true });
    assert.equal(all.totals.paid, 3);
    assert.deepEqual(kinds(all), { pack: 6, 'pass 30d': 1 }, '--all keeps the owner\'s four');
    // negative control: with a list that does not hold the wallet (the state before R22) the same rows ARE counted as outside
    const before = F.buildReport(db, { days: 2, now: NOW, isOwn: (r) => !!r.payer_wallet && /^(Gack9|EqRNN)/.test(r.payer_wallet) });
    assert.equal(before.totals.paid, 3, 'without the wallet in the list the two own purchases count as outside');
    assert.equal(before.totals.key_calls, 7, 'and so do the owner\'s four key calls (they were never left out before)');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('funnel CLI on the same fixture: the default report counts one outside purchase, --all three (the real af-digest list, the real CLI)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-funnel-cli-'));
  const file = path.join(dir, 'af.db');
  fixture(file);
  const run = (...a) => spawnSync(process.execPath, [path.join(__dirname, '..', 'ops', 'funnel.js'), '--db', file, '--days', '365', '--json', ...a], { encoding: 'utf8', env: { PATH: process.env.PATH, OVERHANG_DB_PATH: process.env.OVERHANG_DB_PATH } });
  try {
    const d = run(), a = run('--all');
    assert.equal(d.status, 0, d.stderr);
    assert.equal(JSON.parse(d.stdout).totals.paid, 1);
    assert.equal(JSON.parse(a.stdout).totals.paid, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
