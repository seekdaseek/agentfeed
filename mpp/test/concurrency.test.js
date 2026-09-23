// mpp/test/concurrency.test.js — the replay gate must be a WRITE, not a read.
//
// The bug this pins: a read-then-act check ("is this consumed? no -> proceed")
// leaves a window between the read and the mark. Two concurrent presentations
// of one credential both read "not consumed", both proceed, and one payment
// buys two grants — a paid call that looks like it worked, twice.
//
// The fix is a single INSERT against a PRIMARY KEY whose row count is the
// verdict, so SQLite arbitrates rather than this process.
//
// Run:  node --test mpp/test/concurrency.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const express = require('express');
const Database = require('better-sqlite3');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TREASURY = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7';
const PAYER = 'EqRNNpKVpu6jm8iRTNa17Rht2TRTzCtNNz37M9m2Di1';
const TREASURY_ATA = 'HqbmBbnEQVN1xhjXM3uqBbJQf1zTrLnTp5dG9teBaz5z';
const RPC = 'http://stub.invalid/rpc';

process.env.MPP_ENABLED = 'true';
process.env.PAY_TO = TREASURY;
process.env.MPP_SECRET_KEY = 'f'.repeat(64);
process.env.MPP_RPC_URL = RPC;
process.env.MPP_REALM = 'localhost';
process.env.MPP_NETWORK = 'mainnet';

const mpp = require('../index');
const { createSqliteStore } = require('../store');

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'mainnet-pull-credential.json'), 'utf8'),
);
const SIGNATURE = FIXTURE.transactionSignature;
const PRICES = { 'GET /api/sol-price': { usd: 0.001, tool: 'get_sol_price', desc: 'SOL spot price' } };

const realFetch = globalThis.fetch;

function tmpDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpp-conc-')), 'agentfeed.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  // Mirrors the shape server.js's tool() wrapper writes on a 200.
  db.exec(`CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, tool TEXT, status TEXT,
    payer_wallet TEXT, tx_sig TEXT, amount_usdc REAL)`);
  return db;
}

/**
 * Stub RPC with a deliberate delay on the settle path. The delay widens the
 * window the old read-then-act gate depended on: with a bare read, both
 * requests get past the check while the first is still awaiting the RPC.
 */
function stubRpc({ settleDelayMs = 60 } = {}) {
  let sends = 0;
  globalThis.fetch = async (url, init) => {
    const target = typeof url === 'string' ? url : String(url && url.url);
    if (!target.startsWith(RPC)) return realFetch(url, init);
    const body = JSON.parse(init.body);
    const reply = (obj) => new Response(JSON.stringify({ id: 1, jsonrpc: '2.0', ...obj }));
    const stall = () => new Promise((r) => setTimeout(r, settleDelayMs));

    switch (body.method) {
      case 'getLatestBlockhash':
        return reply({ result: { value: { blockhash: 'ASUYmXrNLsEzHAttWdVwEw6LjxzJxVRo2UyPjCDrLEoB' } } });
      case 'simulateTransaction':
        await stall();
        return reply({ result: { value: { err: null, logs: [] } } });
      case 'sendTransaction':
        sends++;
        await stall();
        return reply({ result: SIGNATURE });
      case 'getSignatureStatuses':
        return reply({ result: { value: [{ confirmationStatus: 'confirmed', err: null }] } });
      case 'getTransaction':
        return reply({
          result: {
            meta: { err: null },
            transaction: {
              message: {
                instructions: [
                  {
                    program: 'spl-token',
                    programId: TOKEN_PROGRAM,
                    parsed: {
                      type: 'transferChecked',
                      info: {
                        authority: PAYER,
                        destination: TREASURY_ATA,
                        mint: USDC,
                        source: 'GVcCJrq1NYwZJa2N86DNjz5H2UscmBA8EXGQYryM8euo',
                        tokenAmount: { amount: '1000', decimals: 6 },
                      },
                    },
                  },
                ],
              },
            },
          },
        });
      default:
        return reply({ result: null });
    }
  };
  return () => sends;
}

async function boot(db) {
  await mpp.init({ db, prices: PRICES, routes: Object.keys(PRICES) });
  const app = express();
  const insert = db.prepare(
    `INSERT INTO calls (ts, tool, status, payer_wallet, tx_sig, amount_usdc) VALUES (?,?,?,?,?,?)`,
  );
  app.get('/api/sol-price', mpp.gate('GET /api/sol-price'));
  app.use(mpp.wrapX402((req, res) => res.status(402).json({})));
  app.get('/api/sol-price', (req, res) => {
    // Same audit rule as server.js tool(): log only a 200, marked paid when a
    // settlement is attached.
    res.on('finish', () => {
      if (res.statusCode !== 200) return;
      const s = req.mppSettlement || null;
      insert.run(Date.now(), 'get_sol_price', s ? 'paid' : 'free', s?.payer ?? null, s?.transaction ?? null, s ? 0.001 : null);
    });
    res.json({ tool: 'get_sol_price', data: { price: 1 } });
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { port: server.address().port, server };
}

function parseChallenge(header) {
  const out = {};
  for (const [, k, v] of header.slice(8).matchAll(/([a-zA-Z0-9_-]+)="([^"]*)"/g)) out[k] = v;
  return out;
}

function pullCredential(params) {
  return Buffer.from(
    JSON.stringify({
      challenge: {
        id: params.id,
        realm: params.realm,
        method: params.method,
        intent: params.intent,
        request: params.request,
        ...(params.expires ? { expires: params.expires } : {}),
        ...(params.opaque ? { opaque: params.opaque } : {}),
      },
      payload: { type: 'transaction', transaction: FIXTURE.transaction },
    }),
  ).toString('base64url');
}

// =========================================================================

test('two identical credentials fired concurrently: exactly one settles', async () => {
  const db = tmpDb();
  const sends = stubRpc({ settleDelayMs: 80 });
  const ctx = await boot(db);
  try {
    const params = parseChallenge(
      (await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`)).headers.get('www-authenticate'),
    );
    const credential = pullCredential(params);
    const fire = () =>
      fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`, {
        headers: { Authorization: `Payment ${credential}` },
      });

    // Both in flight before either can finish.
    const [a, b] = await Promise.all([fire(), fire()]);
    const statuses = [a.status, b.status].sort();

    assert.deepEqual(statuses, [200, 402], 'exactly one must settle and one must be refused');

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    assert.ok(winner.headers.get('payment-receipt'), 'the winner carries a receipt');
    assert.equal(loser.headers.get('payment-receipt'), null, 'the loser carries no receipt');

    const problem = await loser.json();
    assert.equal(problem.type, 'https://paymentauth.org/problems/verification-failed');
    assert.equal(problem.status, 402);

    await new Promise((r) => setTimeout(r, 50)); // let the finish handler run

    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM mpp_consumed WHERE key = ?').get(`solana-charge:consumed:${SIGNATURE}`).c,
      1,
      'exactly one mpp_consumed row',
    );
    assert.equal(db.prepare('SELECT COUNT(*) c FROM calls').get().c, 1, 'exactly one calls row');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM calls WHERE status = ?').get('paid').c, 1, 'and it is marked paid');
    assert.equal(sends(), 1, 'the transaction was broadcast exactly once');
  } finally {
    ctx.server.close();
  }
});

test('ten identical credentials fired concurrently: still exactly one settles', async () => {
  const db = tmpDb();
  stubRpc({ settleDelayMs: 40 });
  const ctx = await boot(db);
  try {
    const params = parseChallenge(
      (await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`)).headers.get('www-authenticate'),
    );
    const credential = pullCredential(params);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`, {
          headers: { Authorization: `Payment ${credential}` },
        }).then((r) => r.status),
      ),
    );
    assert.equal(results.filter((s) => s === 200).length, 1, 'exactly one 200 out of ten');
    assert.equal(results.filter((s) => s === 402).length, 9, 'the other nine are refused');

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(db.prepare('SELECT COUNT(*) c FROM mpp_consumed').get().c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM calls').get().c, 1);
  } finally {
    ctx.server.close();
  }
});

// --- the primitive itself, in isolation ---------------------------------

test('claimSignature is decided by one statement and is not a read', () => {
  const db = tmpDb();
  const store = createSqliteStore(db);
  const SIG = 'ClaimUnitTestSignature';

  assert.equal(store.claimSignature(SIG), 'claimed', 'first caller wins');
  assert.equal(store.claimSignature(SIG), 'in-progress', 'second caller is refused while the lease is live');
  assert.equal(store.claimSignature(SIG), 'in-progress', 'and stays refused');

  store.releaseSignature(SIG);
  assert.equal(store.claimSignature(SIG), 'claimed', 'a released claim can be retaken');

  store.settleSignature(SIG);
  assert.equal(store.claimSignature(SIG), 'consumed', 'a settled claim is never retaken');
  // Not even once the lease has long expired: the ON CONFLICT ... WHERE clause
  // matches only rows still in state 'pending'.
  assert.equal(store.claimSignature(SIG, 0), 'consumed', 'and not after the lease expires either');
});

test('an abandoned claim is recovered by its lease, a live one is not', () => {
  const db = tmpDb();
  const store = createSqliteStore(db);
  const SIG = 'LeaseRecoverySignature';

  assert.equal(store.claimSignature(SIG), 'claimed');
  // Crash: the holder never released. With a live lease, nobody may take over.
  assert.equal(store.claimSignature(SIG, 5 * 60 * 1000), 'in-progress');
  // Once the lease is past, exactly one recovery wins.
  assert.equal(store.claimSignature(SIG, 0), 'claimed');
  assert.equal(store.claimSignature(SIG, 5 * 60 * 1000), 'in-progress');
});

test('a signature upstream already consumed is refused even with no claim row', () => {
  const db = tmpDb();
  const store = createSqliteStore(db);
  const SIG = 'UpstreamConsumedSignature';
  // Models a restart: upstream's durable marker survives, the claim table does not.
  db.prepare('INSERT INTO mpp_consumed (key, value, created) VALUES (?,?,?)').run(
    `solana-charge:consumed:${SIG}`,
    'true',
    Date.now(),
  );
  assert.equal(store.claimSignature(SIG), 'consumed');
});
