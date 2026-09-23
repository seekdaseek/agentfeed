// mpp/test/preflight.test.js — pins the preflightCommitment fix.
//
// The defect: @solana/mpp's broadcastTransaction sends `sendTransaction` with
// no `preflightCommitment`. Solana's default for that parameter is `finalized`
// (agave rpc/src/rpc.rs passes None; bank() does commitment.unwrap_or_default();
// CommitmentLevel derives #[default] Finalized). The challenge blockhash is
// minted at `confirmed`, so for the ~12s until it finalizes the preflight bank
// has never heard of it and the RPC answers "Blockhash not found". A client
// that pays FASTER than finality therefore always fails — which is what
// happened on mainnet on 2026-09-19.
//
// These tests are offline. The stub RPC models exactly that split, and the
// transaction under test is the REAL signed transaction the pay CLI produced
// during that failed attempt (test/fixtures/mainnet-pull-credential.json).
//
// This file is also the suite's only PULL-mode coverage: every other test
// presents `type:"signature"`, while the reference CLI sends
// `type:"transaction"` — the mode the mainnet failure occurred in.
//
// Run:  node --test mpp/test/preflight.test.js

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
const { check: checkPatched, REQUIRED, UNPATCHED } = require('../scripts/assert-patched');

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'mainnet-pull-credential.json'), 'utf8'),
);
const PRICES = { 'GET /api/sol-price': { usd: 0.001, tool: 'get_sol_price', desc: 'SOL spot price' } };

// A real RPC returns the transaction's own first signature from sendTransaction,
// so the stub must too: the gate's replay key is derived from the transaction
// bytes, and a stub that invented a different signature would silently disable
// replay detection in this test. Decoded independently with @solana/kit and
// recorded in the fixture.
const SIGNATURE = FIXTURE.transactionSignature;

const realFetch = globalThis.fetch;

/**
 * Stub RPC that models the confirmed/finalized bank split for sendTransaction,
 * and nothing else. Records every sendTransaction params array it is given.
 */
function stubRpc() {
  const sends = [];
  globalThis.fetch = async (url, init) => {
    const target = typeof url === 'string' ? url : String(url && url.url);
    if (!target.startsWith(RPC)) return realFetch(url, init);
    const body = JSON.parse(init.body);
    const reply = (obj) => new Response(JSON.stringify({ id: 1, jsonrpc: '2.0', ...obj }));

    switch (body.method) {
      case 'getLatestBlockhash':
        return reply({ result: { value: { blockhash: 'ASUYmXrNLsEzHAttWdVwEw6LjxzJxVRo2UyPjCDrLEoB' } } });

      // Simulation is explicitly at `confirmed` in the package, so it sees the
      // blockhash and passes. This is why the defect survived to the send step.
      case 'simulateTransaction':
        return reply({ result: { value: { err: null, logs: [] } } });

      case 'sendTransaction': {
        sends.push(body.params);
        return reply(sendOutcome(body.params[1]));
      }

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
  return sends;
}

/** The whole point: what the preflight bank does with a confirmed-only blockhash. */
function sendOutcome(options) {
  const preflight = options && options.preflightCommitment;
  if (options && options.skipPreflight === true) {
    // Never acceptable as a "fix": it would skip the check rather than aim it.
    return { error: { code: -32602, message: 'TEST: skipPreflight must stay false' } };
  }
  if (preflight === 'confirmed' || preflight === 'processed') {
    return { result: SIGNATURE };
  }
  // undefined -> Solana's default, `finalized`: the blockhash is not there yet.
  return { error: { code: -32002, message: 'Transaction simulation failed: Blockhash not found' } };
}

function tmpDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpp-pre-')), 'agentfeed.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  return db;
}

async function boot(db) {
  await mpp.init({ db, prices: PRICES, routes: Object.keys(PRICES) });
  const app = express();
  app.get('/api/sol-price', mpp.gate('GET /api/sol-price'));
  app.use(mpp.wrapX402((req, res) => res.status(402).json({})));
  app.get('/api/sol-price', (req, res) => res.json({ tool: 'get_sol_price', data: { price: 1 } }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { port: server.address().port, server };
}

function parseChallenge(header) {
  const out = {};
  for (const [, k, v] of header.slice(8).matchAll(/([a-zA-Z0-9_-]+)="([^"]*)"/g)) out[k] = v;
  return out;
}

/** A PULL-mode credential wrapping the real captured transaction. */
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

test('the installed @solana/mpp carries the preflightCommitment patch', () => {
  const result = checkPatched();
  assert.equal(result.ok, true, result.reason);
});

test('the patch assertion fails loudly on unpatched and on drifted sources', () => {
  // The committed patch file is the single source of truth for both strings.
  const patch = fs.readFileSync(path.join(__dirname, '..', 'patches', '@solana+mpp+0.7.0.patch'), 'utf8');
  assert.ok(patch.includes('-            ' + UNPATCHED), 'patch removes the unpatched params line');
  assert.ok(patch.includes('+            ' + REQUIRED), 'patch adds the patched params line');
  // skipPreflight must survive the fix — aiming preflight, not skipping it.
  assert.ok(REQUIRED.includes('skipPreflight: false'));
});

test('the stub oracle is calibrated: unpatched params are rejected, patched accepted', () => {
  const unpatched = sendOutcome({ encoding: 'base64', skipPreflight: false });
  assert.ok(unpatched.error, 'no preflightCommitment must be rejected');
  assert.match(unpatched.error.message, /Blockhash not found/);

  const patched = sendOutcome({ encoding: 'base64', preflightCommitment: 'confirmed', skipPreflight: false });
  assert.equal(patched.result, SIGNATURE, 'preflightCommitment:confirmed must be accepted');

  // And the forbidden shortcut is rejected by the oracle itself.
  const skipped = sendOutcome({ encoding: 'base64', skipPreflight: true });
  assert.ok(skipped.error, 'skipping preflight must not be treated as a fix');
});

test('PULL mode: the real captured mainnet transaction settles through the patched path', async () => {
  const db = tmpDb();
  const sends = stubRpc();
  const ctx = await boot(db);
  try {
    const challenge = await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`);
    assert.equal(challenge.status, 402);
    const params = parseChallenge(challenge.headers.get('www-authenticate'));

    const paid = await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`, {
      headers: { Authorization: `Payment ${pullCredential(params)}` },
    });

    assert.equal(paid.status, 200, 'a confirmed-only blockhash must settle once preflight is aimed at confirmed');
    assert.ok(paid.headers.get('payment-receipt'), '§12.7 receipt required on the 200');

    // The decisive assertion: what the module actually put on the wire.
    assert.equal(sends.length, 1, 'exactly one sendTransaction');
    const options = sends[0][1];
    assert.equal(options.preflightCommitment, 'confirmed', 'preflight must target the confirmed bank');
    assert.equal(options.skipPreflight, false, 'preflight must remain ENABLED — aimed, not skipped');
    assert.equal(options.encoding, 'base64');
  } finally {
    ctx.server.close();
  }
});

test('PULL mode: the settled signature is recorded consumed and a replay is refused', async () => {
  const db = tmpDb();
  stubRpc();
  const ctx = await boot(db);
  try {
    const first = parseChallenge(
      (await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`)).headers.get('www-authenticate'),
    );
    const ok = await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`, {
      headers: { Authorization: `Payment ${pullCredential(first)}` },
    });
    assert.equal(ok.status, 200);

    const row = db.prepare('SELECT COUNT(*) c FROM mpp_consumed WHERE key = ?').get(
      `solana-charge:consumed:${SIGNATURE}`,
    );
    assert.equal(row.c, 1, 'the signature must be recorded exactly once (§11.6)');

    // Same transaction, brand-new challenge.
    const second = parseChallenge(
      (await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`)).headers.get('www-authenticate'),
    );
    assert.notEqual(second.id, first.id);
    const replay = await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`, {
      headers: { Authorization: `Payment ${pullCredential(second)}` },
    });

    assert.equal(replay.status, 402, 'a consumed signature must not settle again');
    assert.equal(replay.headers.get('payment-receipt'), null);
    const problem = await replay.json();
    assert.equal(problem.type, 'https://paymentauth.org/problems/verification-failed');
    assert.match(problem.detail, /already consumed/i);

    const after = db.prepare('SELECT COUNT(*) c FROM mpp_consumed').get();
    assert.equal(after.c, 1, 'the replay must not add a second consumed row');
  } finally {
    ctx.server.close();
  }
});

test('the captured credential is reused for its transaction only — its own challenge has expired', () => {
  // Stated explicitly because the brief asked whether the captured credential
  // was still usable end-to-end. It is not: mppx challenges carry a 300s TTL.
  assert.ok(FIXTURE.capturedChallengeId, 'fixture records the original challenge id');
  assert.equal(FIXTURE.payloadType, 'transaction');
  assert.equal(FIXTURE.capturedRequest.amount, '1000');
  assert.equal(FIXTURE.capturedRequest.currency, USDC);
  assert.equal(FIXTURE.capturedRequest.recipient, TREASURY);
});
