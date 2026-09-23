// mpp/test/concurrency-push.test.js — the push path (type="signature") must be
// as replay-safe as the pull path.
//
// Published @solana/mpp 0.7.0 does guard push mode with an in-process mutex:
// verifySignature reads the consumed key, re-reads it inside withKeyLock, then
// writes it after a successful verify. Its own comment scopes that guarantee:
//
//   "Scope: single Node process. Multi-process/replica deployments sharing one
//    Store must back the consumed marker with an atomic reserve."
//
// So the question these tests answer is not "does upstream try" but "does OUR
// gate put a single atomic write in front of push settlements too", which is
// what survives a second process or a restart mid-flight.
//
// Run:  node --test mpp/test/concurrency-push.test.js

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
const PAYER_ATA = 'GVcCJrq1NYwZJa2N86DNjz5H2UscmBA8EXGQYryM8euo';
const RPC = 'http://stub.invalid/rpc';

process.env.MPP_ENABLED = 'true';
process.env.PAY_TO = TREASURY;
process.env.MPP_SECRET_KEY = 'f'.repeat(64);
process.env.MPP_RPC_URL = RPC;
process.env.MPP_REALM = 'localhost';
process.env.MPP_NETWORK = 'mainnet';

const mpp = require('../index');

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'mainnet-pull-credential.json'), 'utf8'),
);
// The real mainnet signature this payer produced. In push mode the client has
// already broadcast, so the credential carries only this.
const SIGNATURE = FIXTURE.transactionSignature;
const PRICES = { 'GET /api/sol-price': { usd: 0.001, tool: 'get_sol_price', desc: 'SOL spot price' } };

const realFetch = globalThis.fetch;

function tmpDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpp-push-')), 'agentfeed.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, tool TEXT, status TEXT,
    payer_wallet TEXT, tx_sig TEXT, amount_usdc REAL)`);
  return db;
}

/** Stub RPC. In push mode the server never broadcasts — it only reads the chain. */
function stubRpc({ verifyDelayMs = 80, failPayerLookup = false } = {}) {
  // `payerLookupSignatures` is what makes the attribution test non-circular:
  // this stub answers ANY signature with the same account list, so asserting
  // only that a lookup happened would still pass if the gate looked up the
  // wrong string (measured: it does).
  const counts = { getTransaction: 0, payerLookup: 0, payerLookupSignatures: [], sendTransaction: 0 };
  globalThis.fetch = async (url, init) => {
    const target = typeof url === 'string' ? url : String(url && url.url);
    if (!target.startsWith(RPC)) return realFetch(url, init);
    const body = JSON.parse(init.body);
    const reply = (obj) => new Response(JSON.stringify({ id: 1, jsonrpc: '2.0', ...obj }));

    if (body.method === 'getLatestBlockhash') {
      return reply({ result: { value: { blockhash: 'ASUYmXrNLsEzHAttWdVwEw6LjxzJxVRo2UyPjCDrLEoB' } } });
    }
    if (body.method === 'sendTransaction') {
      counts.sendTransaction++;
      return reply({ result: SIGNATURE });
    }
    if (body.method === 'getTransaction') {
      // Two different reads use this method: upstream's on-chain verification
      // (JSON-RPC id 1, dist/server/Charge.js fetchTransaction) and the gate's
      // post-settlement payer lookup, which tags itself 'mpp-payer-lookup'.
      // Counting them apart keeps every existing "only the claim winner
      // verified on-chain" assertion meaning exactly what it meant before
      // attribution existed.
      if (body.id === 'mpp-payer-lookup') {
        counts.payerLookup++;
        counts.payerLookupSignatures.push(body.params && body.params[0]);
        if (failPayerLookup) return reply({ error: { code: -32603, message: 'RPC down' } });
      } else {
        counts.getTransaction++;
        // The delay is the window: it is what a read-then-act gate loses on.
        await new Promise((r) => setTimeout(r, verifyDelayMs));
      }
      return reply({
        result: {
          meta: { err: null },
          transaction: {
            message: {
              // jsonParsed puts the fee payer first. feePayer:false makes that
              // same account the transfer authority (§9.2) — the payer. Shape
              // verified against mainnet for live settlement 2TFZpJd4...:
              // accountKeys[0] = {pubkey, signer, source, writable}.
              accountKeys: [
                { pubkey: PAYER, signer: true, source: 'transaction', writable: true },
                { pubkey: PAYER_ATA, signer: false, source: 'transaction', writable: true },
              ],
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
                      source: PAYER_ATA,
                      tokenAmount: { amount: '1000', decimals: 6 },
                    },
                  },
                },
              ],
            },
          },
        },
      });
    }
    return reply({ result: null });
  };
  return counts;
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

/** A PUSH-mode credential: the client already broadcast, so only the signature. */
function pushCredential(params) {
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
      payload: { type: 'signature', signature: SIGNATURE },
    }),
  ).toString('base64url');
}

// =========================================================================

test('PUSH: a single credential settles and is recorded once', async () => {
  const db = tmpDb();
  const counts = stubRpc({ verifyDelayMs: 10 });
  const ctx = await boot(db);
  try {
    const params = parseChallenge(
      (await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`)).headers.get('www-authenticate'),
    );
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`, {
      headers: { Authorization: `Payment ${pushCredential(params)}` },
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('payment-receipt'));
    assert.equal(counts.sendTransaction, 0, 'push mode must never broadcast server-side');
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM mpp_consumed WHERE key = ?').get(`solana-charge:consumed:${SIGNATURE}`).c,
      1,
    );
  } finally {
    ctx.server.close();
  }
});

test('PUSH: two identical credentials fired concurrently: exactly one settles', async () => {
  const db = tmpDb();
  const counts = stubRpc({ verifyDelayMs: 100 });
  const ctx = await boot(db);
  try {
    const params = parseChallenge(
      (await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`)).headers.get('www-authenticate'),
    );
    const credential = pushCredential(params);
    const fire = () =>
      fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`, {
        headers: { Authorization: `Payment ${credential}` },
      });

    const [a, b] = await Promise.all([fire(), fire()]);
    assert.deepEqual([a.status, b.status].sort(), [200, 402], 'exactly one settles, one refused');

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    assert.ok(winner.headers.get('payment-receipt'));
    assert.equal(loser.headers.get('payment-receipt'), null);
    const problem = await loser.json();
    assert.equal(problem.type, 'https://paymentauth.org/problems/verification-failed');
    assert.equal(problem.status, 402);

    await new Promise((r) => setTimeout(r, 60));
    assert.equal(db.prepare('SELECT COUNT(*) c FROM mpp_consumed').get().c, 1, 'one mpp_consumed row');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM calls').get().c, 1, 'one calls row');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM calls WHERE status='paid'").get().c, 1);
    assert.equal(counts.sendTransaction, 0, 'still no server-side broadcast');
    assert.equal(counts.getTransaction, 1, 'only the claim winner verified on-chain');
  } finally {
    ctx.server.close();
  }
});

test('PUSH: ten identical credentials fired concurrently: still exactly one settles', async () => {
  const db = tmpDb();
  const counts = stubRpc({ verifyDelayMs: 60 });
  const ctx = await boot(db);
  try {
    const params = parseChallenge(
      (await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`)).headers.get('www-authenticate'),
    );
    const credential = pushCredential(params);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`, {
          headers: { Authorization: `Payment ${credential}` },
        }).then((r) => r.status),
      ),
    );
    assert.equal(results.filter((s) => s === 200).length, 1, 'exactly one 200 out of ten');
    assert.equal(results.filter((s) => s === 402).length, 9);

    await new Promise((r) => setTimeout(r, 60));
    assert.equal(db.prepare('SELECT COUNT(*) c FROM mpp_consumed').get().c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM calls').get().c, 1);
    assert.equal(counts.getTransaction, 1, 'nine were refused before any RPC work');
  } finally {
    ctx.server.close();
  }
});

test('PUSH: a settled signature is refused against a brand-new challenge', async () => {
  const db = tmpDb();
  stubRpc({ verifyDelayMs: 10 });
  const ctx = await boot(db);
  try {
    const first = parseChallenge(
      (await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`)).headers.get('www-authenticate'),
    );
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`, {
          headers: { Authorization: `Payment ${pushCredential(first)}` },
        })
      ).status,
      200,
    );

    const second = parseChallenge(
      (await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`)).headers.get('www-authenticate'),
    );
    assert.notEqual(second.id, first.id);
    const replay = await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`, {
      headers: { Authorization: `Payment ${pushCredential(second)}` },
    });
    assert.equal(replay.status, 402);
    const problem = await replay.json();
    assert.match(problem.detail, /already consumed/i);

    await new Promise((r) => setTimeout(r, 60));
    assert.equal(db.prepare('SELECT COUNT(*) c FROM mpp_consumed').get().c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM calls').get().c, 1);
  } finally {
    ctx.server.close();
  }
});

// ---- attribution ---------------------------------------------------------
//
// §8 makes the credential's `source` OPTIONAL, and the reference client omits
// it in push mode (@solana/mpp dist/client/Charge.js, the `if (broadcast)`
// branch serialises only { challenge, payload: { signature, type } }). Before
// the gate read the payer back off the settled transaction, such a call landed
// status='paid' with payer_wallet NULL, and /opt/afwatch/afwatch.js — which
// filters WHERE status='paid' AND payer_wallet IS NOT NULL — dropped it. A
// paying customer was invisible to every revenue surface.

test('PUSH: a credential with no `source` still records the on-chain payer', async () => {
  const db = tmpDb();
  const counts = stubRpc({ verifyDelayMs: 10 });
  const ctx = await boot(db);
  try {
    const params = parseChallenge(
      (await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`)).headers.get('www-authenticate'),
    );
    const credential = pushCredential(params);

    // The premise, asserted rather than assumed: this credential names no payer.
    const decoded = JSON.parse(Buffer.from(credential, 'base64url').toString('utf8'));
    assert.equal(decoded.source, undefined, 'push credential carries no source');
    assert.equal(decoded.payload.type, 'signature');
    assert.equal(decoded.payload.transaction, undefined, 'and no transaction bytes either');

    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`, {
      headers: { Authorization: `Payment ${credential}` },
    });
    assert.equal(res.status, 200);

    await new Promise((r) => setTimeout(r, 60));
    const row = db.prepare('SELECT status, payer_wallet, tx_sig FROM calls').get();
    assert.equal(row.status, 'paid');
    assert.equal(row.payer_wallet, PAYER, 'payer derived from the settled transaction');
    assert.equal(row.tx_sig, SIGNATURE);
    assert.equal(counts.payerLookup, 1, 'exactly one attribution read');
    assert.equal(counts.getTransaction, 1, 'and it did not duplicate the verification read');

    // THE anti-circularity assertion. The stub answers any signature with the
    // same payer, so without this a gate that looked up the challenge id, a
    // stale variable, or a literal would still make every other assertion
    // above pass. Measured: replacing the argument with a garbage string keeps
    // the rest of this file green.
    assert.deepEqual(
      counts.payerLookupSignatures,
      [SIGNATURE],
      'the attribution read must query the SETTLED signature, not some other string',
    );

    // The point of the whole exercise: afwatch can see this row.
    assert.equal(
      db
        .prepare("SELECT COUNT(*) c FROM calls WHERE status='paid' AND payer_wallet IS NOT NULL")
        .get().c,
      1,
      "afwatch's filter (status='paid' AND payer_wallet IS NOT NULL) counts this call",
    );
  } finally {
    ctx.server.close();
  }
});

test('PUSH: a failed payer lookup still serves the paid request', async () => {
  const db = tmpDb();
  const counts = stubRpc({ failPayerLookup: true, verifyDelayMs: 10 });
  const ctx = await boot(db);
  try {
    const params = parseChallenge(
      (await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`)).headers.get('www-authenticate'),
    );
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`, {
      headers: { Authorization: `Payment ${pushCredential(params)}` },
    });
    // Attribution is bookkeeping. The customer has already paid on-chain.
    assert.equal(res.status, 200, 'a broken attribution lookup must never deny a paid request');
    assert.ok(res.headers.get('payment-receipt'));

    await new Promise((r) => setTimeout(r, 60));
    const row = db.prepare('SELECT status, payer_wallet, tx_sig FROM calls').get();
    assert.equal(row.status, 'paid', 'still recorded as paid');
    assert.equal(row.payer_wallet, null, 'payer falls back to what the credential carried');
    assert.equal(row.tx_sig, SIGNATURE, 'the signature is still recorded');
    assert.equal(counts.payerLookup, 1);
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM mpp_consumed').get().c,
      1,
      'and the signature is still consumed exactly once',
    );
  } finally {
    ctx.server.close();
  }
});
