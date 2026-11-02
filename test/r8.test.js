// test/r8.test.js — R8 (13 Oct 2026): the audit table keeps one spelling per payer and the amount that was charged.
//
// Offline. The wrapper is the real lib/tool.js on a throwaway express app, db.js runs on a scratch SQLite file, and the digest
// runs as a child process (--dry) over a scratch audit table.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-r8-'));
// the --alert CLI also reads the pensio-tg pass file (ops/af-digest.js pensioPassAlert); a well-formed key and no api_keys table in these fixture databases keep it silent, whatever machine this runs on
const PENSIO_KEY_FILE = path.join(tmp, 'pensio-key'); fs.writeFileSync(PENSIO_KEY_FILE, 'afk_' + 'a'.repeat(40) + '\n');
process.env.AGENTFEED_DB = path.join(tmp, 'calls.db');
const { normPayer, acceptedOf, settledUsd } = require('../lib/audit');
const { makeTool } = require('../lib/tool');

const header = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const CHECKSUMMED = '0xFEfF369D5048b2Cf817d87467E48404b3ADfE4Ee';
const SOLANA = 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu';

test('normPayer: an EVM address has one spelling, every other address is left exactly as it came', () => {
  assert.equal(normPayer(CHECKSUMMED), CHECKSUMMED.toLowerCase());
  assert.equal(normPayer(CHECKSUMMED.toLowerCase()), CHECKSUMMED.toLowerCase());
  assert.equal(normPayer(SOLANA), SOLANA, 'base58 is case-sensitive');
  assert.equal(normPayer('0xabc'), '0xabc', 'not an address: untouched');
  assert.equal(normPayer('0x' + 'G'.repeat(40)), '0x' + 'G'.repeat(40));
  assert.equal(normPayer(''), null);
  assert.equal(normPayer(null), null);
  assert.equal(normPayer(undefined), null);
});

test('settledUsd: the accepted requirement decides, an unreadable or inflated one falls back to the list price', () => {
  assert.equal(settledUsd({ amount: '1000' }, 0.001), 0.001, 'exact tier');
  assert.equal(settledUsd({ amount: '500' }, 0.001), 0.0005, 'batch-settlement / Gateway: half price, minimum $0.0005');
  assert.equal(settledUsd({ amount: '5000' }, 0.01), 0.005);
  assert.equal(settledUsd({ amount: '20000' }, 0.01), 0.01, 'an amount above the list price is not believed');
  assert.equal(settledUsd({ amount: '0' }, 0.01), 0.01);
  assert.equal(settledUsd({ amount: '-5' }, 0.01), 0.01);
  assert.equal(settledUsd({ amount: 500 }, 0.001), 0.001, 'must be the atomic string');
  assert.equal(settledUsd({ amount: '1e3' }, 0.01), 0.01);
  assert.equal(settledUsd(null, 0.02), 0.02, 'x402 v1 and MPP carry no accepted requirement');
  assert.equal(settledUsd(undefined, undefined), null);
});

test('acceptedOf: reads accepted out of a v2 payment header and nothing else', () => {
  assert.deepEqual(acceptedOf(header({ x402Version: 2, accepted: { scheme: 'exact', amount: '1000' }, payload: {} })), { scheme: 'exact', amount: '1000' });
  assert.equal(acceptedOf(header({ x402Version: 1, scheme: 'exact', payload: {} })), null, 'v1 has no accepted');
  assert.equal(acceptedOf('%%% not base64 json'), null);
  assert.equal(acceptedOf(header('a string')), null);
  assert.equal(acceptedOf(undefined), null);
});

test('the route wrapper logs what was charged: list price on exact, half on batch and Gateway, null on a free call (R19b: from the matched requirement, not the buyer\'s header)', async () => {
  const PRICES = { 'GET /api/priced': { usd: 0.01, tool: 'get_priced', desc: 'priced' } };
  const audit = [];
  const { tool } = makeTool({
    paymentsOn: true, PRICES,
    decodeSettlement: (res) => (res.req && res.req.headers['x-test-settled'] ? { payer: CHECKSUMMED, transaction: '0xtx' } : null),
    logCall: (row) => audit.push(row),
  });
  const app = express();
  app.use((req, res, next) => {
    res.req = req; req.callerIp = '203.0.113.7';
    if (req.headers['x-test-matched']) req.x402Matched = { scheme: 'exact', amount: req.headers['x-test-matched'] };   // what the beforeVerify hook keeps (lib/rail-ctx.js bindMatched)
    next();
  });
  app.get('/api/priced', tool('get_priced', 0.01, () => ({ ok: true })));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const get = (headers) => fetch(`http://127.0.0.1:${server.address().port}/api/priced`, { headers }).then((r) => r.status);
  try {
    const cases = [
      ['exact', { 'x-test-settled': '1', 'x-test-matched': '10000' }, 0.01],
      ['batch', { 'x-test-settled': '1', 'x-test-matched': '5000' }, 0.005],
      ['gateway minimum', { 'x-test-settled': '1', 'x-test-matched': '500' }, 0.0005],
      ['inflated requirement: not believed', { 'x-test-settled': '1', 'x-test-matched': '90000' }, 0.01],
      ['a header claiming half price, nothing matched server-side: the header is not read', { 'x-test-settled': '1', 'payment-signature': header({ accepted: { amount: '5000' } }) }, 0.01],
      ['garbage header', { 'x-test-settled': '1', 'payment-signature': 'zzz' }, 0.01],
      ['v1 x-payment', { 'x-test-settled': '1', 'x-payment': header({ x402Version: 1, scheme: 'exact' }) }, 0.01],
      ['mpp (no payment header)', { 'x-test-settled': '1' }, 0.01],
      ['unpaid', {}, null],
    ];
    for (const [, h] of cases) assert.equal(await get(h), 200);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(audit.length, cases.length);
    cases.forEach(([name, , want], i) => assert.equal(audit[i].amount_usdc, want, name));
    assert.equal(audit[0].status, 'paid');
    assert.equal(audit[cases.length - 1].status, 'free');
  } finally { server.close(); }
});

test('logCall stores an EVM payer lower-case and leaves a Solana payer alone', async () => {
  const { db, logCall } = require('../db');
  logCall({ tool: 'get_eth_price', status: 'paid', payer_wallet: CHECKSUMMED, amount_usdc: 0.001 });
  logCall({ tool: 'get_eth_price', status: 'paid', payer_wallet: CHECKSUMMED.toLowerCase(), amount_usdc: 0.0005 });
  logCall({ tool: 'get_eth_price', status: 'paid', payer_wallet: SOLANA, amount_usdc: 0.001 });
  logCall({ tool: 'get_fear_greed', status: 'free' });
  await new Promise((r) => setTimeout(r, 2400)); // db.js flushes its queue every 2 s
  const rows = db.prepare('SELECT payer_wallet FROM calls ORDER BY id').all().map((r) => r.payer_wallet);
  assert.deepEqual(rows, [CHECKSUMMED.toLowerCase(), CHECKSUMMED.toLowerCase(), SOLANA, null]);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT payer_wallet) n FROM calls WHERE payer_wallet LIKE ?').get('0x%').n, 1, 'one payer, however it was spelled');
});

test('the digest counts an EVM payer once and tags both spellings of an own wallet as own', () => {
  const Database = require('better-sqlite3');
  const dbFile = path.join(tmp, 'digest.db');
  const d = new Database(dbFile);
  d.exec(`CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool TEXT NOT NULL, payer_wallet TEXT, tx_sig TEXT, amount_usdc REAL, status TEXT NOT NULL, latency_ms INTEGER, ip TEXT, error_msg TEXT, req_host TEXT, req_path TEXT, user_agent TEXT, method TEXT);`);
  // midday of the Chisinau calendar day before today (the digest's window): walk back in hour steps to the last hour before local
  // midnight, then 11 h earlier. Computed in the digest's own time zone so the test does not depend on the hour it runs.
  const localDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Chisinau', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  let ts = Date.now(); const today = localDate(ts);
  while (localDate(ts) === today) ts -= 3600e3;
  ts -= 11 * 3600e3;
  const ins = d.prepare("INSERT INTO calls (ts, tool, payer_wallet, amount_usdc, status, ip) VALUES (?, 'get_eth_price', ?, ?, 'paid', '198.51.100.9')");
  const EXT = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
  const GATEWAY_PROOF = '0x05B38ff795A2D750788157F1119E5D403D8Ef47A';
  for (const w of [CHECKSUMMED, CHECKSUMMED, CHECKSUMMED.toLowerCase(), CHECKSUMMED.toLowerCase(), GATEWAY_PROOF, GATEWAY_PROOF.toLowerCase()]) ins.run(ts, w, 0.001);
  for (const w of [EXT, EXT, EXT.toLowerCase()]) ins.run(ts, w, 0.01);
  ins.run(ts, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 0.002);
  d.close();
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'ops', 'af-digest.js'), '--digest', '--force', '--test', '--dry'], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, AGENTFEED_DB: dbFile, AF_DIGEST_STATE: path.join(tmp, 'digest-state.json'), AF_OWN_IPS: path.join(tmp, 'no-such-own-ips.txt') },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Paid: 4 calls, \$0\.032 from 2 external payers; own\/test 6 calls, \$0\.006/);
});

// ---- the corrective 402 of a batch-settlement client that lost its channel context is protocol, not a failed buyer ----
function digestDb(name) {
  const Database = require('better-sqlite3');
  const dbFile = path.join(tmp, `${name}.db`);
  const d = new Database(dbFile);
  d.exec(`CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool TEXT NOT NULL, payer_wallet TEXT, tx_sig TEXT, amount_usdc REAL, status TEXT NOT NULL, latency_ms INTEGER, ip TEXT, error_msg TEXT, req_host TEXT, req_path TEXT, user_agent TEXT, method TEXT);`);
  return { d, dbFile };
}
const RESYNC_MSG = 'verification refused: invalid_batch_settlement_evm_cumulative_amount_mismatch';
function runDigest(dbFile, args) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'ops', 'af-digest.js'), ...args], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, AGENTFEED_DB: dbFile, AF_DIGEST_STATE: path.join(tmp, `state-${path.basename(dbFile)}.json`), AF_PENSIO_KEY_FILE: PENSIO_KEY_FILE, AF_OWN_IPS: path.join(tmp, 'no-such-own-ips.txt') },
  });
}

test('the digest counts a batch client\'s corrective 402s on their own line and does not list the buyer as failed', () => {
  const { d, dbFile } = digestDb('digest-resync');
  const localDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Chisinau', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  let ts = Date.now(); const today = localDate(ts);
  while (localDate(ts) === today) ts -= 3600e3;
  ts -= 11 * 3600e3;
  const ins = d.prepare("INSERT INTO calls (ts, tool, status, ip, error_msg) VALUES (?, 'get_eth_price', 'payment_refused', ?, ?)");
  ins.run(ts, '198.51.100.20', RESYNC_MSG); ins.run(ts, '198.51.100.20', RESYNC_MSG); ins.run(ts, '198.51.100.20', RESYNC_MSG);
  ins.run(ts, '198.51.100.21', 'verification refused: insufficient_funds');
  d.close();
  const r = runDigest(dbFile, ['--digest', '--force', '--test', '--dry']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Refused payments: 1 \(1 external\); plus 3 batch-channel resync\(s\), served on the retry, not failures/);
  assert.doesNotMatch(r.stdout, /198\.51\.100\.20/, 'the resyncing buyer is not named anywhere in the failed sections');
  assert.match(r.stdout, /198\.51\.100\.21|funds/i, 'the genuine refusal is still reported');
});

test('the burst alert ignores corrective 402s and still fires on real refusals', () => {
  const resync = digestDb('alert-resync');
  const now = Date.now();
  const ins = (db) => db.prepare("INSERT INTO calls (ts, tool, status, ip, error_msg, user_agent) VALUES (?, 'get_eth_price', 'payment_refused', '198.51.100.30', ?, 'x402-test')");
  for (let i = 0; i < 8; i++) ins(resync.d).run(now - i * 60e3, RESYNC_MSG);
  resync.d.close();
  const quiet = runDigest(resync.dbFile, ['--alert', '--dry']);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stdout, /would send/, 'eight corrective 402s from one IP in an hour: no alert');
  const real = digestDb('alert-real');
  for (let i = 0; i < 8; i++) ins(real.d).run(now - i * 60e3, 'verification refused: insufficient_funds');
  real.d.close();
  const loud = runDigest(real.dbFile, ['--alert', '--dry']);
  assert.equal(loud.status, 0, loud.stderr);
  assert.match(loud.stdout, /would send/, 'the same count of real refusals does alert (the control that the quiet case could have fired)');
});
