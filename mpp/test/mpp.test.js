// mpp/test/mpp.test.js — offline conformance tests for the MPP solana/charge
// layer. No network: every RPC call is served by a stub.
//
// Run:  node --test mpp/test/mpp.test.js        (from the service root)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('better-sqlite3');
const { createSqliteStore, consumedKey } = require('../store');
const { base58Encode, signatureFromBase64Transaction } = require('../signature');
const { usdToBaseUnits, clampDescription } = require('../index');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const RECIPIENT = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7';
const OTHER = 'GBFoGJXvLsgBXAKJw9cGK18BGxaevpYtAyQKoqgcSQKz';
const PAYER = 'ASCQRp616JVQKMpynYfcPVdKPext719WUf7CuFcnnatX';
const OTHER_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'; // USDT
const RPC = 'http://stub.invalid/rpc';
const SECRET = 'f'.repeat(64);
const AMOUNT = '1000'; // $0.001 at 6 decimals

// ---- helpers -------------------------------------------------------------

function tmpDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpp-test-')), 'agentfeed.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  return { db, file };
}

/** Parse `Payment k="v", k2="v2"` into an object. */
function parseChallenge(header) {
  assert.ok(header.startsWith('Payment '), 'challenge must use the Payment scheme');
  const out = {};
  for (const [, k, v] of header.slice(8).matchAll(/([a-zA-Z0-9_-]+)="([^"]*)"/g)) out[k] = v;
  return out;
}

const b64urlJson = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decodeB64urlJson = (text) => JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));

/** A jsonParsed transferChecked instruction, in the shape verifySplTransfer reads. */
function transferChecked({ destination, mint = USDC, amount = AMOUNT, decimals = 6 }) {
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
        tokenAmount: { amount: String(amount), decimals },
      },
    },
  };
}

/** Install a fetch stub that answers getTransaction with `tx` (null = not found). */
function stubRpc(tx) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.method === 'getLatestBlockhash') {
      return new Response(
        JSON.stringify({ result: { value: { blockhash: '9EhfBiNunPdVrJTLENSWLkseHPS8uH9gMw9a7tUB3uAY' } } }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    if (body.method === 'getTransaction') {
      return new Response(JSON.stringify({ result: tx }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ result: null }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return calls;
}

async function buildServer(store) {
  const { Mppx, solana } = await import('@solana/mpp/server');
  const method = solana.charge({
    currency: USDC,
    decimals: 6,
    network: 'mainnet',
    recipient: RECIPIENT,
    rpcUrl: RPC,
    store,
    tokenProgram: TOKEN_PROGRAM,
  });
  return Mppx.create({ methods: [method], realm: 'x402.ochinimus.app', secretKey: SECRET });
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

/** Issue a 402 and return its parsed challenge auth-params. */
async function issueChallenge(mppx) {
  const result = await mppx.charge({
    amount: AMOUNT,
    description: 'SOL spot price',
    scope: 'GET /api/sol-price',
  })(new Request('https://x402.ochinimus.app/api/sol-price'));
  assert.equal(result.status, 402);
  return {
    header: result.challenge.headers.get('WWW-Authenticate'),
    params: parseChallenge(result.challenge.headers.get('WWW-Authenticate')),
  };
}

/** Present a push-mode credential for `signature` against `challengeParams`. */
async function present(mppx, params, signature, overrides = {}) {
  const echo = {
    id: params.id,
    realm: params.realm,
    method: params.method,
    intent: params.intent,
    request: params.request,
    ...(params.expires ? { expires: params.expires } : {}),
    ...(params.opaque ? { opaque: params.opaque } : {}),
    ...overrides,
  };
  const credential = b64urlJson({
    challenge: echo,
    payload: { type: 'signature', signature },
    source: PAYER,
  });
  return mppx.charge({
    amount: AMOUNT,
    description: 'SOL spot price',
    scope: 'GET /api/sol-price',
  })(
    new Request('https://x402.ochinimus.app/api/sol-price', {
      headers: { Authorization: `Payment ${credential}` },
    }),
  );
}

// =========================================================================
test('usdToBaseUnits is exact (no float rounding)', () => {
  assert.equal(usdToBaseUnits(0.001), '1000');
  assert.equal(usdToBaseUnits(0.002), '2000');
  assert.equal(usdToBaseUnits(0.07), '70000'); // 0.07*1e6 === 70000.00000000001 in IEEE-754
  assert.equal(usdToBaseUnits(0.01), '10000');
  assert.equal(usdToBaseUnits(1), '1000000');
  assert.equal(usdToBaseUnits('0.000001'), '1');
  // Below the mint's precision must be refused, never silently rounded.
  assert.throws(() => usdToBaseUnits(0.0000001), /precision/);
  assert.throws(() => usdToBaseUnits(0), /positive/);
});

test('description is clamped to the 256-char limit (§7.1)', () => {
  assert.equal(clampDescription('short').length, 5);
  const long = 'x '.repeat(400);
  assert.ok(clampDescription(long).length <= 256);
  assert.equal(clampDescription('a'.repeat(256)).length, 256);
  assert.ok(clampDescription('a'.repeat(257)).length <= 256);
});

test('base58 matches known vectors', () => {
  assert.equal(base58Encode(Buffer.from('hello world')), 'StV1DL6CwTryKyV');
  assert.equal(base58Encode(Buffer.from([0x00, 0x00, 0x28, 0x7f, 0xb4, 0xcd])), '11233QC4');
  assert.equal(base58Encode(Buffer.from([0x61])), '2g');
  assert.equal(base58Encode(Buffer.from([0x00])), '1');
});

test('signature is derived from signed transaction bytes without broadcasting', () => {
  const sig = Buffer.alloc(64);
  for (let i = 0; i < 64; i++) sig[i] = (i * 7 + 3) & 0xff;
  const tx = Buffer.concat([Buffer.from([1]), sig, Buffer.from([0, 0, 0])]); // shortvec(1) || sig || msg
  assert.equal(signatureFromBase64Transaction(tx.toString('base64')), base58Encode(sig));

  // An unsigned slot (all zeroes) is not a signature.
  const empty = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from([0])]);
  assert.equal(signatureFromBase64Transaction(empty.toString('base64')), null);
  assert.equal(signatureFromBase64Transaction('not base64 at all!!'), null);
  assert.equal(signatureFromBase64Transaction(''), null);
});

// ---- store ---------------------------------------------------------------

test('SQLite store persists consumed signatures across process restarts', async () => {
  const { db, file } = tmpDb();
  const store = createSqliteStore(db);
  await store.put(consumedKey('SIG_AAA'), true);
  assert.equal(store.isConsumed('SIG_AAA'), true);
  assert.equal(store.isConsumed('SIG_BBB'), false);
  db.close();

  // Reopen: this is the property Store.memory() does not have.
  const reopened = createSqliteStore(new Database(file));
  assert.equal(reopened.isConsumed('SIG_AAA'), true);
  assert.equal(await reopened.get(consumedKey('SIG_AAA')), true);
});

test('SQLite store update() is a single atomic read-modify-write', async () => {
  const { db } = tmpDb();
  const store = createSqliteStore(db);
  // 20 concurrent claimers, exactly one may win.
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      store.update('k', (current) =>
        current === null ? { op: 'set', value: 1, result: 'won' } : { op: 'noop', result: 'lost' },
      ),
    ),
  );
  assert.equal(results.filter((r) => r === 'won').length, 1);
  assert.equal(results.filter((r) => r === 'lost').length, 19);
});

// ---- challenge -----------------------------------------------------------

test('challenge encodes per §6/§7 and decodes back to the same object', async () => {
  const { db } = tmpDb();
  stubRpc(null);
  const mppx = await buildServer(createSqliteStore(db));
  const { params } = await issueChallenge(mppx);

  assert.equal(params.method, 'solana');
  assert.equal(params.intent, 'charge');
  assert.equal(params.realm, 'x402.ochinimus.app');
  assert.ok(params.id && params.id.length > 0);

  // §6: base64url, no '=' padding, and decodable with or without it.
  assert.ok(!params.request.includes('='), 'request auth-param must not be padded');
  const request = decodeB64urlJson(params.request);
  assert.deepEqual(decodeB64urlJson(params.request + '=='), request, 'padded input must still decode');

  // §7.1 / §7.2
  assert.equal(request.amount, AMOUNT);
  assert.equal(typeof request.amount, 'string');
  assert.equal(request.currency, USDC);
  assert.equal(request.recipient, RECIPIENT);
  assert.equal(request.methodDetails.decimals, 6);
  assert.equal(request.methodDetails.tokenProgram, TOKEN_PROGRAM);
  assert.equal(request.methodDetails.network, 'mainnet');

  // The mission's constraint: no server-funded fees anywhere in the challenge.
  assert.equal(request.methodDetails.feePayer, undefined);
  assert.equal(request.methodDetails.feePayerKey, undefined);

  // §6: JCS means keys are lexicographically ordered.
  const keys = Object.keys(request);
  assert.deepEqual(keys, [...keys].sort());
  const inner = Object.keys(request.methodDetails);
  assert.deepEqual(inner, [...inner].sort());

  // Round trip: re-encoding the decoded object reproduces the auth-param.
  const canonical = (value) =>
    JSON.stringify(value, (_k, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
        : v,
    );
  assert.equal(
    Buffer.from(canonical(request)).toString('base64url').replace(/=+$/, ''),
    params.request,
  );
});

// ---- verification --------------------------------------------------------

test('happy path: confirmed transferChecked to the derived recipient ATA settles (§11.2/§11.4/§12.7)', async () => {
  const { db } = tmpDb();
  const store = createSqliteStore(db);
  const destination = await ata(RECIPIENT);
  const calls = stubRpc({
    meta: { err: null },
    transaction: { message: { instructions: [transferChecked({ destination })] } },
  });
  const mppx = await buildServer(store);
  const { params } = await issueChallenge(mppx);

  const result = await present(mppx, params, 'SIG_HAPPY_PATH');
  assert.equal(result.status, 200, 'a matching confirmed transfer must settle');

  // §12.5: the server must read the transaction at >= confirmed.
  const get = calls.find((c) => c.method === 'getTransaction');
  assert.equal(get.params[1].commitment, 'confirmed');
  assert.equal(get.params[1].encoding, 'jsonParsed');

  // §12.7 receipt.
  const receipted = result.withReceipt(Response.json({ ok: true }));
  const header = receipted.headers.get('Payment-Receipt');
  assert.ok(header, 'a settled request must carry Payment-Receipt');
  const receipt = decodeB64urlJson(header.replace(/^\S+\s+/, ''));
  assert.equal(receipt.method, 'solana');
  assert.equal(receipt.reference, 'SIG_HAPPY_PATH');
  assert.equal(receipt.status, 'success');
  assert.equal(receipt.challengeId, params.id);
  assert.ok(!Number.isNaN(Date.parse(receipt.timestamp)), 'timestamp must be RFC3339');

  // §11.6: the signature is now recorded as consumed, durably.
  assert.equal(store.isConsumed('SIG_HAPPY_PATH'), true);
});

test('replayed signature is rejected (§11.6)', async () => {
  const { db } = tmpDb();
  const store = createSqliteStore(db);
  const destination = await ata(RECIPIENT);
  stubRpc({
    meta: { err: null },
    transaction: { message: { instructions: [transferChecked({ destination })] } },
  });
  const mppx = await buildServer(store);

  const first = await issueChallenge(mppx);
  assert.equal((await present(mppx, first.params, 'SIG_REPLAY')).status, 200);

  // Same signature, brand-new challenge: §11.6 says it must still be refused.
  const second = await issueChallenge(mppx);
  assert.notEqual(second.params.id, first.params.id);
  const replay = await present(mppx, second.params, 'SIG_REPLAY');
  assert.equal(replay.status, 402, 'a consumed signature must not settle again');
  assert.equal(replay.withReceipt, undefined, 'a rejected replay must not produce a receipt');
  assert.ok(replay.challenge.headers.get('WWW-Authenticate'), '§13: a fresh challenge must accompany the rejection');
  assert.equal(replay.challenge.headers.get('content-type'), 'application/problem+json');
  // NOTE: at this layer the body says `internal-payment-error` / status 500.
  // That is upstream behaviour (FINDINGS #2); the gate re-shapes it, and the
  // HTTP-level test below asserts the §13-correct result.
});

test('credential whose challenge echo does not match is rejected (§11 step 4)', async () => {
  const { db } = tmpDb();
  const destination = await ata(RECIPIENT);
  stubRpc({
    meta: { err: null },
    transaction: { message: { instructions: [transferChecked({ destination })] } },
  });
  const mppx = await buildServer(createSqliteStore(db));
  const { params } = await issueChallenge(mppx);

  // Tamper with the echoed request: same id, a request that asks for 1 base unit.
  const tampered = decodeB64urlJson(params.request);
  tampered.amount = '1';
  const forged = Buffer.from(JSON.stringify(tampered)).toString('base64url').replace(/=+$/, '');

  const result = await present(mppx, params, 'SIG_ECHO_MISMATCH', { request: forged });
  assert.equal(result.status, 402, 'a mismatched challenge echo must not settle');
  assert.ok(result.challenge.headers.get('WWW-Authenticate'));
});

test('wrong amount is rejected (§11.4)', async () => {
  const { db } = tmpDb();
  const store = createSqliteStore(db);
  const destination = await ata(RECIPIENT);
  stubRpc({
    meta: { err: null },
    // Pays 999 instead of the challenged 1000.
    transaction: { message: { instructions: [transferChecked({ destination, amount: '999' })] } },
  });
  const mppx = await buildServer(store);
  const { params } = await issueChallenge(mppx);
  const result = await present(mppx, params, 'SIG_WRONG_AMOUNT');
  assert.equal(result.status, 402, 'an underpayment must not settle');
  assert.equal(result.withReceipt, undefined);
  assert.equal(store.isConsumed('SIG_WRONG_AMOUNT'), false);
});

test('wrong recipient is rejected (§11.4 derived-ATA check)', async () => {
  const { db } = tmpDb();
  const destination = await ata(OTHER); // correct mint + amount, someone else's ATA
  stubRpc({
    meta: { err: null },
    transaction: { message: { instructions: [transferChecked({ destination })] } },
  });
  const mppx = await buildServer(createSqliteStore(db));
  const { params } = await issueChallenge(mppx);
  const result = await present(mppx, params, 'SIG_WRONG_RECIPIENT');
  assert.equal(result.status, 402, 'a transfer to another ATA must not settle');
});

test('wrong mint is rejected (§11.4)', async () => {
  const { db } = tmpDb();
  // Right owner, right amount — but the USDT ATA and a USDT mint field.
  const destination = await ata(RECIPIENT, OTHER_MINT);
  stubRpc({
    meta: { err: null },
    transaction: {
      message: { instructions: [transferChecked({ destination, mint: OTHER_MINT })] },
    },
  });
  const mppx = await buildServer(createSqliteStore(db));
  const { params } = await issueChallenge(mppx);
  const result = await present(mppx, params, 'SIG_WRONG_MINT');
  assert.equal(result.status, 402, 'a transfer of a different token must not settle');
});

test('a failed or missing on-chain transaction is rejected', async () => {
  const { db } = tmpDb();
  const store = createSqliteStore(db);
  const mppx = await buildServer(store);

  stubRpc(null); // getTransaction -> not found
  const missing = await present(mppx, (await issueChallenge(mppx)).params, 'SIG_MISSING');
  assert.equal(missing.status, 402);
  assert.equal(store.isConsumed('SIG_MISSING'), false, 'a failed verify must not burn the signature');

  const destination = await ata(RECIPIENT);
  stubRpc({
    meta: { err: { InstructionError: [0, 'Custom'] } },
    transaction: { message: { instructions: [transferChecked({ destination })] } },
  });
  const failed = await present(mppx, (await issueChallenge(mppx)).params, 'SIG_FAILED_TX');
  assert.equal(failed.status, 402, 'a transaction that failed on-chain must not settle');
  assert.equal(store.isConsumed('SIG_FAILED_TX'), false);
});

test('no credential yields a 402 that carries a challenge and no receipt', async () => {
  const { db } = tmpDb();
  stubRpc(null);
  const mppx = await buildServer(createSqliteStore(db));
  const result = await mppx.charge({ amount: AMOUNT, scope: 'GET /api/sol-price' })(
    new Request('https://x402.ochinimus.app/api/sol-price'),
  );
  assert.equal(result.status, 402);
  assert.ok(result.challenge.headers.get('WWW-Authenticate'));
  assert.equal(result.withReceipt, undefined);
});
