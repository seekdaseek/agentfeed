// mpp/test/gate.test.js — HTTP-level tests for the Express gate itself:
// header coexistence, the §13 problem body, the pre-broadcast replay gate, and
// the "no soft path" property. No network; the RPC is stubbed.
//
// Run:  node --test mpp/test/gate.test.js       (from the service root)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const express = require('express');
const Database = require('better-sqlite3');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const RECIPIENT = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7';
const PAYER = 'ASCQRp616JVQKMpynYfcPVdKPext719WUf7CuFcnnatX';

const PRICES = {
  'GET /api/sol-price': { usd: 0.001, tool: 'get_sol_price', desc: 'SOL spot price' },
  'GET /api/btc-price': { usd: 0.001, tool: 'get_btc_price', desc: 'BTC spot price' },
};

process.env.MPP_ENABLED = 'true';
process.env.PAY_TO = RECIPIENT;
process.env.MPP_SECRET_KEY = 'f'.repeat(64);
process.env.MPP_RPC_URL = 'http://stub.invalid/rpc';
process.env.MPP_REALM = 'x402.ochinimus.app';

const mpp = require('../index');
const { createSqliteStore } = require('../store');

function tmpDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpp-gate-')), 'agentfeed.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  return db;
}

function transferChecked({ destination, amount = '1000', mint = USDC }) {
  return {
    program: 'spl-token',
    programId: TOKEN_PROGRAM,
    parsed: {
      type: 'transferChecked',
      info: {
        authority: PAYER,
        destination,
        mint,
        source: 'SourceAtaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        tokenAmount: { amount: String(amount), decimals: 6 },
      },
    },
  };
}

const realFetch = globalThis.fetch;

/**
 * Intercept only the JSON-RPC endpoint. The tests drive the server over real
 * HTTP, so everything else has to pass through to the genuine fetch.
 */
function stubRpc(tx) {
  globalThis.fetch = async (url, init) => {
    const target = typeof url === 'string' ? url : String(url && url.url);
    if (!target.startsWith(process.env.MPP_RPC_URL)) return realFetch(url, init);
    const body = JSON.parse(init.body);
    if (body.method === 'getLatestBlockhash') {
      return new Response(
        JSON.stringify({ result: { value: { blockhash: '9EhfBiNunPdVrJTLENSWLkseHPS8uH9gMw9a7tUB3uAY' } } }),
      );
    }
    if (body.method === 'getTransaction') return new Response(JSON.stringify({ result: tx }));
    return new Response(JSON.stringify({ result: null }));
  };
}

async function ata(owner, mint = USDC) {
  const { findAssociatedTokenPda } = await import('@solana-program/token');
  const { address } = await import('@solana/kit');
  const [pda] = await findAssociatedTokenPda({
    mint: address(mint),
    owner: address(owner),
    tokenProgram: address(TOKEN_PROGRAM),
  });
  return String(pda);
}

/**
 * Boot a miniature AgentFeed: the MPP gate, then a stand-in for the x402 layer
 * that 402s with only a PAYMENT-REQUIRED header, then the route handler.
 */
async function boot(db) {
  await mpp.init({ db, prices: PRICES, routes: Object.keys(PRICES) });
  const app = express();
  let x402Calls = 0;

  app.get('/api/sol-price', mpp.gate('GET /api/sol-price'));

  const fakeX402 = (req, res, next) => {
    x402Calls++;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify({ x402Version: 2 })).toString('base64'));
    res.status(402).json({});
  };
  app.use(mpp.wrapX402(fakeX402));

  app.get('/api/sol-price', (req, res) => res.json({ tool: 'get_sol_price', data: { price: 1 } }));

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { app, port: server.address().port, server, x402: () => x402Calls };
}

function parseChallenge(header) {
  const out = {};
  for (const [, k, v] of header.slice(8).matchAll(/([a-zA-Z0-9_-]+)="([^"]*)"/g)) out[k] = v;
  return out;
}

function credentialFor(params, signature) {
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
      payload: { type: 'signature', signature },
      source: PAYER,
    }),
  ).toString('base64url');
}

// =========================================================================

test('an unpaid request 402s with BOTH challenges on one response', async () => {
  stubRpc(null);
  const ctx = await boot(tmpDb());
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`);
    assert.equal(res.status, 402);
    const mppChallenge = res.headers.get('www-authenticate');
    const x402Challenge = res.headers.get('payment-required');
    assert.ok(mppChallenge, 'MPP challenge must be present');
    assert.ok(x402Challenge, 'the existing x402 challenge must still be present');
    assert.ok(mppChallenge.startsWith('Payment '));
    assert.equal(parseChallenge(mppChallenge).method, 'solana');
    assert.equal(parseChallenge(mppChallenge).intent, 'charge');
    // The x402 layer still ran: the existing flow is untouched.
    assert.equal(ctx.x402(), 1);
  } finally {
    ctx.server.close();
  }
});

test('a verified payment returns 200 with a receipt and never reaches the x402 layer', async () => {
  const db = tmpDb();
  const destination = await ata(RECIPIENT);
  stubRpc({
    meta: { err: null },
    transaction: { message: { instructions: [transferChecked({ destination })] } },
  });
  const ctx = await boot(db);
  try {
    const challenge = await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`);
    const params = parseChallenge(challenge.headers.get('www-authenticate'));
    const before = ctx.x402();

    const paid = await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`, {
      headers: { Authorization: `Payment ${credentialFor(params, 'GATE_SIG_OK')}` },
    });
    assert.equal(paid.status, 200);
    assert.ok(paid.headers.get('payment-receipt'), 'a settled request must carry Payment-Receipt');
    assert.equal(ctx.x402(), before, 'a request settled over MPP must not be charged again by x402');
    const body = await paid.json();
    assert.equal(body.tool, 'get_sol_price');
  } finally {
    ctx.server.close();
  }
});

test('a replayed signature is refused with a §13 problem body and a fresh challenge', async () => {
  const db = tmpDb();
  const destination = await ata(RECIPIENT);
  stubRpc({
    meta: { err: null },
    transaction: { message: { instructions: [transferChecked({ destination })] } },
  });
  const ctx = await boot(db);
  try {
    const first = parseChallenge(
      (await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`)).headers.get('www-authenticate'),
    );
    const ok = await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`, {
      headers: { Authorization: `Payment ${credentialFor(first, 'GATE_SIG_REPLAY')}` },
    });
    assert.equal(ok.status, 200);

    // A brand-new challenge, the same signature. §11.6: still refused.
    const second = parseChallenge(
      (await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`)).headers.get('www-authenticate'),
    );
    assert.notEqual(second.id, first.id);
    const replay = await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`, {
      headers: { Authorization: `Payment ${credentialFor(second, 'GATE_SIG_REPLAY')}` },
    });

    assert.equal(replay.status, 402);
    assert.equal(replay.headers.get('content-type'), 'application/problem+json');
    assert.ok(replay.headers.get('www-authenticate'), '§13: every rejection carries a fresh challenge');
    const problem = await replay.json();
    assert.equal(problem.type, 'https://paymentauth.org/problems/verification-failed');
    assert.equal(problem.status, 402, 'the problem body status must match the HTTP status');
    assert.match(problem.detail, /already consumed/i);
  } finally {
    ctx.server.close();
  }
});

test('a wrong-amount credential is refused as verification-failed, not an internal error', async () => {
  const db = tmpDb();
  const destination = await ata(RECIPIENT);
  stubRpc({
    meta: { err: null },
    transaction: { message: { instructions: [transferChecked({ destination, amount: '999' })] } },
  });
  const ctx = await boot(db);
  try {
    const params = parseChallenge(
      (await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`)).headers.get('www-authenticate'),
    );
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`, {
      headers: { Authorization: `Payment ${credentialFor(params, 'GATE_SIG_UNDERPAY')}` },
    });
    assert.equal(res.status, 402);
    const problem = await res.json();
    assert.equal(problem.type, 'https://paymentauth.org/problems/verification-failed');
    assert.equal(problem.status, 402);
    assert.ok(res.headers.get('www-authenticate'));
    assert.equal(res.headers.get('payment-receipt'), null, 'no receipt for a rejected payment');
  } finally {
    ctx.server.close();
  }
});

test('a malformed credential keeps upstream’s standard problem type', async () => {
  stubRpc(null);
  const ctx = await boot(tmpDb());
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`, {
      headers: { Authorization: 'Payment not-a-valid-credential' },
    });
    assert.equal(res.status, 402);
    const problem = await res.json();
    assert.equal(problem.type, 'https://paymentauth.org/problems/malformed-credential');
    assert.ok(res.headers.get('www-authenticate'));
  } finally {
    ctx.server.close();
  }
});

test('an RPC outage yields 402, never a free 200', async () => {
  const ctx = await boot(tmpDb());
  try {
    const params = parseChallenge(
      (await fetch(`http://127.0.0.1:${ctx.port}/api/sol-price`)).headers.get('www-authenticate'),
    );
    // Only the RPC goes down; the test still needs to reach the server.
    globalThis.fetch = async (url, init) => {
      const target = typeof url === 'string' ? url : String(url && url.url);
      if (target.startsWith(process.env.MPP_RPC_URL)) throw new Error('ECONNREFUSED');
      return realFetch(url, init);
    };
    const { default: http } = await import('node:http');
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          headers: { Authorization: `Payment ${credentialFor(params, 'GATE_SIG_RPCDOWN')}` },
          host: '127.0.0.1',
          path: '/api/sol-price',
          port: ctx.port,
        },
        (r) => {
          let data = '';
          r.on('data', (c) => (data += c));
          r.on('end', () => resolve({ body: data, headers: r.headers, status: r.statusCode }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.notEqual(res.status, 200, 'an RPC failure must never grant free access');
    assert.equal(res.status, 402);
  } finally {
    ctx.server.close();
  }
});
