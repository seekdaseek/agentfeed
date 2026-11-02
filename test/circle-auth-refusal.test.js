// test/circle-auth-refusal.test.js — a dead Circle key is seen on the FIRST payment (R8, 13 Oct 2026).
//
// Offline, no money. Part 1 drives the real x402 middleware, the real CircleArcFacilitator (against a local stub standing in for Circle) and the real
// refusal recorder with a real exact-EVM client, and pins what the audit table says when Circle refuses on authorisation grounds: the wording
// ops/af-digest.js matches on. Part 2 is the alert on a real SQLite table: first row alerts (own wallets included), quiet hour, held count, retry after
// a failed send. Part 3 is the digest line, and the --alert entry point end to end as a child process.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const express = require('express');
const Database = require('better-sqlite3');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { ExactEvmScheme: ServerExact } = require('@x402/evm/exact/server');
const { ExactEvmScheme: ClientExact } = require('@x402/evm/exact/client');
const { wrapFetchWithPaymentFromConfig } = require('@x402/fetch');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const { makeRefusalRecorder } = require('../lib/refusals');
const { CircleArcFacilitator, ARC } = require('../lib/circle-arc');
const digest = require('../ops/af-digest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-car-'));
// the --alert CLI also reads the pensio-tg pass file (ops/af-digest.js pensioPassAlert); a well-formed key and no api_keys table in these fixture databases keep it silent, whatever machine this runs on
const PENSIO_KEY_FILE = path.join(tmp, 'pensio-key'); fs.writeFileSync(PENSIO_KEY_FILE, 'afk_' + 'a'.repeat(40) + '\n');
const keyFile = path.join(tmp, 'arc-payto.key');
fs.writeFileSync(keyFile, generatePrivateKey());
const PAYER = '0x000000000000000000000000000000000000dEaD';

// ---- part 1: through the real middleware
const mode = { verify: 'ok', settle: 'ok' };
const circle = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    const j = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith('/supported')) return j(200, { kinds: [{ x402Version: 2, scheme: 'exact', network: ARC.network }], extensions: [], signers: {} });
    if (req.url.endsWith('/verify')) {
      if (mode.verify === '403') return j(403, { code: 403, message: 'forbidden' });
      if (mode.verify === '401') return j(401, { code: 401, message: 'Invalid credentials.' });
      if (mode.verify === '400') return j(400, { code: 400, message: 'invalid request body' });
      if (mode.verify === 'invalid') return j(200, { isValid: false, invalidReason: 'insufficient_funds', payer: PAYER });
      return j(200, { isValid: true, payer: PAYER });
    }
    if (req.url.endsWith('/settle')) {
      if (mode.settle === '403') return j(403, { code: 403, message: 'trial allowance spent', errors: [{ reason: 'registration_required' }] });
      if (mode.settle === 'failed') return j(200, { success: false, errorReason: 'settlement_failed', payer: PAYER, transaction: '', network: ARC.network });
      return j(200, { success: true, transaction: '0x' + 'ab'.repeat(32), network: ARC.network, payer: PAYER });
    }
    return j(404, { code: 404, message: 'not found' });
  });
});
const rows = [];
let base;
let srv;

test.before(async () => {
  await new Promise((r) => circle.listen(0, '127.0.0.1', r));
  const fac = new CircleArcFacilitator({ env: { CIRCLE_FACILITATOR_URL: `http://127.0.0.1:${circle.address().port}/v1/facilitator/x402`, CIRCLE_API_KEY: 'TEST_API_KEY:probe:probe', ARC_PAYTO_KEY: keyFile }, pollMs: 1, polls: 1 });
  const rs = new x402ResourceServer([fac]).register(ARC.network, new ServerExact());
  const app = express();
  app.use(makeRefusalRecorder({ logCall: (r) => rows.push(r), PRICES: { 'GET /ok': { tool: 'get_ok' } }, mppPayer: null }));
  app.use(paymentMiddleware({ 'GET /ok': { accepts: [{ scheme: 'exact', network: ARC.network, payTo: fac.payTo, price: { amount: '1000', asset: ARC.usdc, extra: ARC.extra } }], description: 'ok' } }, rs));
  app.get('/ok', (req, res) => res.json({ ok: true }));
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(async () => { srv.close(); circle.close(); });

async function payOnce(m) {
  Object.assign(mode, { verify: 'ok', settle: 'ok' }, m);
  rows.length = 0;
  const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: ARC.network, client: new ClientExact(privateKeyToAccount(generatePrivateKey())) }] });
  const res = await pay(`${base}/ok`);
  await res.text();
  await new Promise((r) => setTimeout(r, 30));
  return { status: res.status, rows: rows.slice() };
}

test('through the real middleware: Circle refusing on authorisation grounds is a payment_refused row the alert can match', async () => {
  for (const [name, m, expect] of [
    ['verify 403 forbidden', { verify: '403' }, /^verification refused: Circle \/verify 403: forbidden/],
    ['verify 401 invalid credentials', { verify: '401' }, /^verification refused: Circle \/verify 401: Invalid credentials/],
    ['settle 403 registration_required', { settle: '403' }, /^settlement refused: Circle \/settle 403 registration_required: trial allowance spent/],
  ]) {
    const r = await payOnce(m);
    assert.equal(r.status, 402, `${name}: the buyer is refused`);
    assert.equal(r.rows.length, 1, `${name}: one audit row`);
    assert.equal(r.rows[0].status, 'payment_refused');
    assert.match(r.rows[0].error_msg, expect, name);
    assert.ok(digest.CIRCLE_AUTH_RE.test(r.rows[0].error_msg), `${name}: the alert's pattern matches the real wording`);
    assert.match(digest.shapeOf(r.rows[0].error_msg), /^Circle (verify|settle) (401|403)/, `${name}: the digest names it`);
  }
});

test('through the real middleware: a buyer-side failure, a Circle 400, a failed settlement or a good payment never match the alert', async () => {
  for (const [name, m, wantStatus] of [
    ['payer lacks funds (isValid false)', { verify: 'invalid' }, 402],
    ['Circle 400 on a malformed request', { verify: '400' }, 402],
    ['settlement failed on chain', { settle: 'failed' }, 402],
  ]) {
    const r = await payOnce(m);
    assert.equal(r.status, wantStatus, name);
    assert.equal(r.rows.length, 1, `${name}: still a refused row`);
    assert.ok(!digest.CIRCLE_AUTH_RE.test(r.rows[0].error_msg), `${name}: must not alert (${r.rows[0].error_msg})`);
  }
  const ok = await payOnce({});
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.rows, []);
});

// ---- part 2: the alert on a real table
const SCHEMA = `CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool TEXT NOT NULL, payer_wallet TEXT, tx_sig TEXT, amount_usdc REAL, status TEXT NOT NULL, latency_ms INTEGER, ip TEXT, error_msg TEXT, req_host TEXT, req_path TEXT, user_agent TEXT, method TEXT)`;
const SETTLE_403 = 'settlement refused: Circle /settle 403 registration_required: trial allowance spent';
const VERIFY_403 = 'verification refused: Circle /verify 403: forbidden';
const NOW = Date.UTC(2026, 9, 14, 4, 30, 0);
const MIN = 60e3;
function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT INTO calls (ts, tool, payer_wallet, ip, status, error_msg, user_agent) VALUES (@ts, @tool, @payer_wallet, @ip, @status, @error_msg, @ua)');
  return { db, add: (o) => ins.run({ tool: 'get_eth_price', payer_wallet: null, ip: '203.0.113.9', status: 'payment_refused', error_msg: null, ua: 'test', ...o }).lastInsertRowid };
}
const sender = (ok = true) => { const sent = []; const fn = async (t) => { sent.push(t); return ok; }; fn.sent = sent; return fn; };
const quietLog = () => {};

test('alert: nothing to say when there is nothing; old history before the first run is not news', async () => {
  const { db, add } = freshDb();
  const state = {};
  const send = sender();
  assert.equal(await digest.circleAuthAlert(db, state, NOW, { send, log: quietLog }), 0);
  assert.equal(send.sent.length, 0);
  add({ ts: NOW - 3 * 3600e3, error_msg: SETTLE_403 });         // three hours before the first run: baseline
  const state2 = {};
  assert.equal(await digest.circleAuthAlert(db, state2, NOW, { send, log: quietLog }), 0);
  assert.equal(send.sent.length, 0, 'a refusal from before the first run is history');
  assert.ok(state2.circleAuth.lastId >= 1);
});

test('alert: the FIRST refused payment alerts, our own proof payer included, with the reason and both commands', async () => {
  const { db, add } = freshDb();
  const state = { circleAuth: { lastId: 0, alertedAt: 0, held: 0 } };
  const send = sender();
  add({ ts: NOW - 2 * MIN, payer_wallet: '0x05b38ff795a2d750788157f1119e5d403d8ef47a', status: 'payment_refused', error_msg: SETTLE_403, tool: 'get_eth_price' });
  assert.equal(await digest.circleAuthAlert(db, state, NOW, { send, log: quietLog }), 1);
  assert.equal(send.sent.length, 1);
  const t = send.sent[0];
  assert.match(t, /^AgentFeed: Circle refused 1 Arc payment on authorisation grounds/);
  assert.match(t, /1x Circle \/settle 403 registration_required: trial allowance spent/);
  assert.match(t, /routes: get_eth_price/);
  assert.match(t, /payers: 0x05b38f… \(own\)/);
  assert.match(t, /node ops\/circle-key-check\.js'/);
  assert.match(t, /node ops\/circle-key-check\.js --stdin'/);
  assert.ok(!t.includes('0x05b38ff795a2d750788157f1119e5d403d8ef47a'), 'a short form of the payer, not the whole address');
  assert.equal(state.circleAuth.alertedAt, NOW);
  assert.equal(state.circleAuth.lastId, 1);
  // the same row is not news twice
  assert.equal(await digest.circleAuthAlert(db, state, NOW + 5 * MIN, { send, log: quietLog }), 0);
  assert.equal(send.sent.length, 1);
});

test('alert: first run with a refusal inside the last hour alerts; verify-stage 403 and 401 count too', async () => {
  for (const msg of [VERIFY_403, 'verification refused: Circle /verify 401: Invalid credentials.']) {
    const { db, add } = freshDb();
    add({ ts: NOW - 3 * 3600e3, error_msg: SETTLE_403 });
    add({ ts: NOW - 30 * MIN, error_msg: msg });
    const send = sender();
    const state = {};
    assert.equal(await digest.circleAuthAlert(db, state, NOW, { send, log: quietLog }), 1, msg);
    assert.equal(send.sent.length, 1);
  }
});

test('alert: the quiet hour holds further rows back, the next alert carries them; a failed send is retried, not lost', async () => {
  const { db, add } = freshDb();
  const state = { circleAuth: { lastId: 0, alertedAt: 0, held: 0 } };
  const failing = sender(false);
  add({ ts: NOW - MIN, error_msg: SETTLE_403 });
  assert.equal(await digest.circleAuthAlert(db, state, NOW, { send: failing, log: quietLog }), 0, 'Telegram refused');
  assert.equal(failing.sent.length, 1);
  assert.equal(state.circleAuth.lastId, 0, 'state untouched: the row is still owed an alert');
  assert.equal(state.circleAuth.alertedAt, 0);
  const send = sender();
  assert.equal(await digest.circleAuthAlert(db, state, NOW + 5 * MIN, { send, log: quietLog }), 1, 'the next run sends it');
  assert.equal(send.sent.length, 1);
  // within the hour: two more rows, no message, counted
  add({ ts: NOW + 6 * MIN, error_msg: VERIFY_403 });
  add({ ts: NOW + 7 * MIN, error_msg: VERIFY_403 });
  assert.equal(await digest.circleAuthAlert(db, state, NOW + 10 * MIN, { send, log: quietLog }), 0);
  assert.equal(send.sent.length, 1, 'quiet');
  assert.equal(state.circleAuth.held, 2);
  // after the hour: a new row alerts with the held ones folded in
  add({ ts: NOW + 70 * MIN, error_msg: SETTLE_403 });
  assert.equal(await digest.circleAuthAlert(db, state, NOW + 71 * MIN, { send, log: quietLog }), 3);
  assert.equal(send.sent.length, 2);
  assert.match(send.sent[1], /^AgentFeed: Circle refused 3 Arc payments/);
  assert.match(send.sent[1], /2 more were held back during the last quiet hour/);
  assert.equal(state.circleAuth.held, 0);
});

test('alert: only Circle authorisation refusals; other refusals, other statuses and other facilitators are not this alert', async () => {
  const { db, add } = freshDb();
  const state = { circleAuth: { lastId: 0, alertedAt: 0, held: 0 } };
  const send = sender();
  add({ ts: NOW - MIN, error_msg: 'verification refused: insufficient_funds' });
  add({ ts: NOW - MIN, error_msg: 'verification refused: Circle /verify 400: invalid request body' });
  add({ ts: NOW - MIN, error_msg: 'settlement refused: settlement_failed' });
  add({ ts: NOW - MIN, error_msg: 'verification refused: invalid_exact_evm_payload_signature' });
  add({ ts: NOW - MIN, status: 'paid', error_msg: SETTLE_403 });
  add({ ts: NOW - MIN, status: 'error', error_msg: SETTLE_403 });
  add({ ts: NOW - MIN, error_msg: null });
  assert.equal(await digest.circleAuthAlert(db, state, NOW, { send, log: quietLog }), 0);
  assert.equal(send.sent.length, 0);
  assert.equal(state.circleAuth.lastId, 0, 'nothing matched, nothing consumed');
});

test('alert: a row logged late by a slow request (older ts, higher id) is still seen; a replaced table does not wedge the state', async () => {
  const { db, add } = freshDb();
  const state = { circleAuth: { lastId: 0, alertedAt: 0, held: 0 } };
  const send = sender();
  add({ ts: NOW - MIN, error_msg: SETTLE_403 });
  await digest.circleAuthAlert(db, state, NOW, { send, log: quietLog });
  add({ ts: NOW - 20 * MIN, error_msg: VERIFY_403 });                // logged after, started before
  assert.equal(await digest.circleAuthAlert(db, state, NOW + 2 * 3600e3, { send, log: quietLog }), 1, 'found by id, not by timestamp');
  const { db: fresh } = freshDb();                                    // the table was replaced: its ids start over, below lastId
  assert.ok(state.circleAuth.lastId >= 2);
  assert.equal(await digest.circleAuthAlert(fresh, state, NOW + 3 * 3600e3, { send, log: quietLog }), 0);
  assert.equal(state.circleAuth.lastId, 0);
});

// ---- part 3: the digest line, and --alert end to end
test('digest: a line for the Circle refusals of the day, absent on a clean day; the groups name them', () => {
  const { db, add } = freshDb();
  const from = Date.UTC(2026, 9, 13, 21, 0, 0), to = from + 86400e3;
  add({ ts: from + 5 * MIN, error_msg: SETTLE_403, payer_wallet: '0x1111111111111111111111111111111111111111' });
  add({ ts: from + 9 * MIN, error_msg: VERIFY_403, payer_wallet: '0x2222222222222222222222222222222222222222' });
  add({ ts: to + 5 * MIN, error_msg: VERIFY_403 });                  // the next day: not in this digest
  const w = { date: '2026-10-14', from, to, hour: 9, today: '2026-10-14' };
  const text = digest.digestText(db, w, false);
  assert.match(text, /Circle \(Arc rail\) authorisation refusals: 2, first 2026-10-13 21:05:00Z, last 2026-10-13 21:09:00Z UTC/);
  assert.match(text, /Circle settle 403 registration_required/);
  assert.match(text, /Circle verify 403/);
  const quiet = freshDb();
  quiet.add({ ts: from + MIN, error_msg: 'verification refused: insufficient_funds' });
  assert.ok(!/Circle \(Arc rail\)/.test(digest.digestText(quiet.db, w, false)));
});

test('--alert end to end (child process, --dry): a Circle refusal in the table is reported, a clean table is silent', () => {
  const dbFile = path.join(tmp, 'e2e.db');
  const d = new Database(dbFile);
  d.exec(SCHEMA);
  d.prepare("INSERT INTO calls (ts, tool, payer_wallet, ip, status, error_msg, user_agent) VALUES (?, 'get_sol_price', '0x05b38ff795a2d750788157f1119e5d403d8ef47a', '167.233.69.154', 'payment_refused', ?, 'pay-arc')").run(Date.now() - 2 * MIN, SETTLE_403);
  d.close();
  const env = { PATH: process.env.PATH, AF_PENSIO_KEY_FILE: PENSIO_KEY_FILE, AGENTFEED_DB: dbFile, AF_DIGEST_STATE: path.join(tmp, 'state.json'), AF_OWN_IPS: path.join(tmp, 'no-such-file') };
  const run = () => spawnSync(process.execPath, [path.join(__dirname, '..', 'ops', 'af-digest.js'), '--alert', '--dry'], { env, encoding: 'utf8' });
  const hit = run();
  assert.equal(hit.status, 0, hit.stdout + hit.stderr);
  assert.match(hit.stdout, /would send/);
  assert.match(hit.stdout, /Circle refused 1 Arc payment on authorisation grounds/);
  assert.match(hit.stdout, /\(own\)/, 'the box and the proof payer are ours and still alert');
  const clean = new Database(path.join(tmp, 'clean.db')); clean.exec(SCHEMA); clean.close();
  const quiet = spawnSync(process.execPath, [path.join(__dirname, '..', 'ops', 'af-digest.js'), '--alert', '--dry'], { env: { ...env, AGENTFEED_DB: path.join(tmp, 'clean.db') }, encoding: 'utf8' });
  assert.equal(quiet.status, 0);
  assert.ok(!/would send/.test(quiet.stdout), quiet.stdout);
});
