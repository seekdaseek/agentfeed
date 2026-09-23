// mpp/index.js — MPP `solana`/`charge` (draft-solana-charge-00) for AgentFeed.
//
// Additive and flag-gated. With MPP_ENABLED unset or not "true", `isEnabled()`
// is false, `init()` is never called, `gate()` is never mounted and
// `wrapX402()` returns the x402 middleware unchanged — the service behaves
// exactly as it does today.
//
// Coexistence with the live x402 layer is safe because the two protocols live
// in disjoint header namespaces, and that is not a guess about what ought to
// work — it is what the reference payer does:
//
//   * MPP challenges are read ONLY from `WWW-Authenticate`
//     (solana-foundation/pay, rust/crates/core/src/client/mpp.rs:36-44).
//   * x402 challenges are read from `PAYMENT-REQUIRED` / `X-PAYMENT-REQUIRED`,
//     or from a self-identifying JSON body
//     (rust/crates/core/src/client/runner.rs:565-582).
//
// AgentFeed's x402 challenge is carried entirely in the `PAYMENT-REQUIRED`
// header (see the comment already in server.js), so adding `WWW-Authenticate`
// to the same 402 is invisible to every existing x402 client.
//
// This module NEVER configures a fee-payer signer: every challenge is issued
// with feePayer false (the field is simply absent, which §7.2 defines as
// false), so the payer covers its own network fee and this service needs no
// funded key. See §9.2.

const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');

const { createSqliteStore } = require('./store');
const { feePayerFromBase64Transaction, signatureFromBase64Transaction } = require('./signature');
const { check: checkPatched } = require('./scripts/assert-patched');

// Mainnet USDC. 6 decimals, classic Token Program (NOT Token-2022) — confirmed
// against pay-kit's own table, typescript/packages/mpp/src/constants.ts:62.
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// §7.1: description MUST NOT exceed 256 characters.
const DESCRIPTION_MAX = 256;

// Budget for the post-settlement payer lookup. It runs AFTER the money has
// moved and only decides what goes into the audit row, so it must never hold a
// paid response hostage. Measured against the live configured RPC
// (mainnet.helius-rpc.com) this read answers in ~110-165ms, so 2s is ~12x
// headroom and still caps the worst case a hung RPC can add to a paid 200.
const PAYER_LOOKUP_TIMEOUT_MS = 2000;

// The lookup tags its JSON-RPC request with this id so it is distinguishable
// from @solana/mpp's own verification read (dist/server/Charge.js
// fetchTransaction hardcodes id 1) in RPC logs and in the test stubs. Verified
// against the live endpoint: it accepts a string id and echoes it back.
const PAYER_LOOKUP_RPC_ID = 'mpp-payer-lookup';

const PROBLEM_BASE = 'https://paymentauth.org/problems/';

// §13: "Servers MUST use the standard problem types defined in
// [I-D.httpauth-payment]: malformed-credential, invalid-challenge, and
// verification-failed."
const STANDARD_PROBLEM_TYPES = new Set([
  PROBLEM_BASE + 'malformed-credential',
  PROBLEM_BASE + 'invalid-challenge',
  PROBLEM_BASE + 'verification-failed',
]);

function isStandardProblem(error) {
  return Boolean(error && typeof error.type === 'string' && STANDARD_PROBLEM_TYPES.has(error.type));
}

/** Per-request slot so a global `payment.failed` event can be read back safely. */
const requestContext = new AsyncLocalStorage();

let state = null;
// `init()` is async (ESM deps) but Express middleware is mounted synchronously,
// so the gate awaits this. server.js also awaits it before listen() and exits
// on failure, the same way the MCP rail already does.
let ready = null;

function isEnabled() {
  return String(process.env.MPP_ENABLED || '').toLowerCase() === 'true';
}

/**
 * Exact USD -> base units. Decimal-string arithmetic, never `usd * 10 ** d`:
 * 0.07 * 1e6 is 70000.00000000001 in IEEE-754 and §7.1 requires an integer.
 */
function usdToBaseUnits(usd, decimals = USDC_DECIMALS) {
  const text = typeof usd === 'number' ? usd.toFixed(decimals + 2) : String(usd).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`mpp: bad price ${JSON.stringify(usd)}`);
  const [whole, frac = ''] = text.split('.');
  if (frac.length > decimals) {
    // Anything below the mint's precision would silently round to a different
    // price than the one published. Refuse instead.
    const excess = frac.slice(decimals).replace(/0+$/, '');
    if (excess.length > 0) throw new Error(`mpp: price ${text} has more precision than ${decimals} decimals`);
  }
  const units = (whole + frac.padEnd(decimals, '0').slice(0, decimals)).replace(/^0+(?=\d)/, '');
  if (!/^\d+$/.test(units) || units === '0') throw new Error(`mpp: price ${text} is not a positive integer of base units`);
  return units;
}

function clampDescription(text) {
  const value = String(text || '');
  if (value.length <= DESCRIPTION_MAX) return value;
  const cut = value.slice(0, DESCRIPTION_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return (space > DESCRIPTION_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

/**
 * Build the module. Async because @solana/mpp and mppx are ESM and AgentFeed is
 * CommonJS. Throws on misconfiguration — a half-configured payment layer must
 * not boot.
 *
 * @param {object} options
 * @param {import('better-sqlite3').Database} options.db
 * @param {Record<string, {usd:number, tool:string, desc:string}>} options.prices  keyed 'GET /api/x'
 * @param {string[]} options.routes  the 'GET /api/x' patterns to gate
 */
function init(options) {
  ready = initOnce(options);
  return ready;
}

async function initOnce({ db, prices, routes }) {
  // Refuse to boot the payment layer against an unpatched @solana/mpp. The
  // nested node_modules can reach a server by copy, which runs no lifecycle
  // script, so patch-package's postinstall is not sufficient on its own. An
  // unpatched broadcast sends sendTransaction with no preflightCommitment,
  // whose default is `finalized`, while the challenge blockhash is minted at
  // `confirmed` — so every payment inside the ~12s finality window is rejected
  // with "Blockhash not found". Serving challenges that cannot be paid is
  // worse than not serving them.
  const patch = checkPatched();
  if (!patch.ok) throw new Error(`@solana/mpp patch check failed — ${patch.reason}`);

  const recipient = process.env.PAY_TO;
  if (!recipient) throw new Error('mpp: PAY_TO missing (treasury address)');

  const secretKey = process.env.MPP_SECRET_KEY;
  // mppx HMAC-binds the challenge id so verification is stateless; it requires
  // >= 32 bytes (mppx/dist/server/Mppx.d.ts:329).
  if (!secretKey || secretKey.length < 32) {
    throw new Error('mpp: MPP_SECRET_KEY missing or shorter than 32 characters');
  }

  const network = (process.env.MPP_NETWORK || 'mainnet').toLowerCase();
  const rpcUrl =
    process.env.MPP_RPC_URL ||
    (process.env.HELIUS_API_KEY
      ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
      : undefined);
  if (!rpcUrl) throw new Error('mpp: no RPC endpoint (set MPP_RPC_URL or HELIUS_API_KEY)');

  const realm = process.env.MPP_REALM || 'x402.ochinimus.app';

  const { Mppx, solana } = await import('@solana/mpp/server');

  const store = createSqliteStore(db);

  // currency is the mint, so decimals is REQUIRED and tokenProgram is sent as
  // the hint §7.2 recommends. No `signer` is passed anywhere in this file:
  // that is what makes every challenge feePayer:false.
  const method = solana.charge({
    recipient,
    currency: USDC_MINT,
    decimals: USDC_DECIMALS,
    tokenProgram: TOKEN_PROGRAM,
    network,
    rpcUrl,
    store,
  });

  const mppx = Mppx.create({ methods: [method], realm, secretKey });

  // Handlers run inline on the payment path, so the ALS store set by the gate
  // is still the active context here.
  mppx.onPaymentFailed((context) => {
    const slot = requestContext.getStore();
    if (slot) slot.error = context.error;
  });
  mppx.onPaymentSuccess((context) => {
    const slot = requestContext.getStore();
    if (slot) slot.receipt = context.receipt;
  });

  const gated = new Map();
  for (const pattern of routes) {
    const entry = prices[pattern];
    if (!entry) throw new Error(`mpp: route ${pattern} is not in PRICES`);
    gated.set(pattern, {
      amount: usdToBaseUnits(entry.usd),
      description: clampDescription(entry.desc),
      scope: pattern,
      tool: entry.tool,
      usd: entry.usd,
    });
  }

  // rpcUrl is kept so the payer lookup below reads the SAME endpoint upstream
  // verified against. NOTE: with MPP_RPC_URL unset this string embeds
  // HELIUS_API_KEY — never log `state`, and never log this value.
  state = { gated, mppx, network, realm, recipient, rpcUrl, store };

  // Deliberately does NOT print `recipient`.
  console.log(
    `[mpp] solana/charge active: network=${network} realm=${realm} routes=${routes.length} feePayer=false`,
  );
  return state;
}

// ---- HTTP plumbing -------------------------------------------------------

function toWebRequest(req) {
  const host = req.get('host') || state.realm;
  const url = `${req.protocol}://${host}${req.originalUrl}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }
  return new Request(url, { headers, method: req.method });
}

/**
 * Does this request actually present an MPP credential? Distinguishes "client
 * has not paid yet" (fall through to the x402 challenge) from "client paid and
 * we rejected it" (§13: answer 402 + problem+json ourselves).
 */
function hasPaymentCredential(req) {
  for (const name of ['authorization', 'payment-authorization']) {
    const raw = req.headers[name];
    if (typeof raw === 'string' && /^payment\s+\S/i.test(raw.trim())) return true;
  }
  return false;
}

function credentialToken(req) {
  for (const name of ['authorization', 'payment-authorization']) {
    const raw = req.headers[name];
    if (typeof raw !== 'string') continue;
    const match = /^payment\s+(\S+)/i.exec(raw.trim());
    if (match) return match[1];
  }
  return null;
}

/**
 * Who paid. `source` is OPTIONAL in §8 and the reference CLI omits it, so fall
 * back to the transaction's fee payer — which, with feePayer:false, §9.2 makes
 * the same account as the transfer authority. Null when neither is available
 * (a push-mode credential from a client that sent no `source`).
 */
function credentialSource(req) {
  const token = credentialToken(req);
  if (!token) return null;
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (typeof decoded.source === 'string' && decoded.source.length > 0) return decoded.source;
    const payload = decoded && decoded.payload;
    if (payload && payload.type === 'transaction' && typeof payload.transaction === 'string') {
      return feePayerFromBase64Transaction(payload.transaction);
    }
    return null;
  } catch {
    return null;
  }
}

/** The base64 pull-mode transaction inside a credential, or null. */
function pullTransactionFromCredential(req) {
  const token = credentialToken(req);
  if (!token) return null;
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    const payload = decoded && decoded.payload;
    if (!payload) return null;
    if (payload.type === 'transaction' && typeof payload.transaction === 'string') {
      return { kind: 'transaction', value: payload.transaction };
    }
    if (payload.type === 'signature' && typeof payload.signature === 'string') {
      return { kind: 'signature', value: payload.signature };
    }
    return null;
  } catch {
    // Unparseable credentials are mppx's to reject, with its own problem type.
    return null;
  }
}

/**
 * The fee payer of a SETTLED transaction, read back from the chain.
 *
 * Push-mode credentials (§8, payload.type "signature") carry no transaction
 * bytes, and the reference client sends no `source` — @solana/mpp
 * dist/client/Charge.js, the `if (broadcast)` branch, serialises only
 * { challenge, payload: { signature, type: 'signature' } } — so the chain is
 * the only place the payer exists. This is the same read @solana/mpp's own
 * verification makes (dist/server/Charge.js fetchTransaction: getTransaction
 * with commitment "confirmed", encoding "jsonParsed",
 * maxSupportedTransactionVersion 0), whose result puts the account list at
 * result.transaction.message.accountKeys with the fee payer first. Because
 * every challenge here is feePayer:false, §9.2 makes that same account the
 * transfer authority — it is the payer.
 *
 * NEVER throws and never blocks a settlement beyond PAYER_LOOKUP_TIMEOUT_MS:
 * attribution is bookkeeping, and a customer whose money has already moved
 * must be served even when the RPC is down or the transaction is not indexed
 * yet. The error message is logged WITHOUT the URL, which carries the API key.
 *
 * @param {string|null} signature
 * @returns {Promise<string|null>}
 */
async function feePayerFromSettledSignature(signature) {
  if (!signature || !state || !state.rpcUrl) return null;
  try {
    const response = await fetch(state.rpcUrl, {
      body: JSON.stringify({
        id: PAYER_LOOKUP_RPC_ID,
        jsonrpc: '2.0',
        method: 'getTransaction',
        params: [
          signature,
          { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
        ],
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(PAYER_LOOKUP_TIMEOUT_MS),
    });
    const data = await response.json();
    const message =
      data && data.result && data.result.transaction && data.result.transaction.message;
    const keys = message && message.accountKeys;
    if (!Array.isArray(keys) || keys.length === 0) return null;
    const first = keys[0];
    // jsonParsed yields {pubkey, signer, source, writable}; the unparsed
    // encodings yield a bare base58 string. Accept either rather than depend on
    // an encoding this function does not control.
    if (typeof first === 'string') return first || null;
    return first && typeof first.pubkey === 'string' ? first.pubkey : null;
  } catch (error) {
    console.error('[mpp] payer lookup failed (settlement stands):', error && error.message);
    return null;
  }
}

async function relayWebResponse(res, webResponse) {
  res.status(webResponse.status);
  for (const [name, value] of webResponse.headers.entries()) res.setHeader(name, value);
  const body = Buffer.from(await webResponse.arrayBuffer());
  if (body.length === 0) return res.end();
  return res.end(body);
}

/** RFC 9457 problem + a fresh challenge, for rejections this module makes itself (§13). */
async function sendProblem(res, { challengeHeader, type, title, detail }) {
  if (challengeHeader) res.setHeader('WWW-Authenticate', challengeHeader);
  res.status(402);
  res.setHeader('Content-Type', 'application/problem+json');
  return res.end(
    JSON.stringify({ type: PROBLEM_BASE + type, title, status: 402, detail }),
  );
}

/** Ask mppx for a fresh challenge header, used on the self-rejection path. */
async function freshChallengeHeader(req, entry) {
  try {
    const bare = new Request(toWebRequest(req).url, { method: req.method });
    const result = await state.mppx.charge({
      amount: entry.amount,
      description: entry.description,
      scope: entry.scope,
    })(bare);
    return result.status === 402 ? result.challenge.headers.get('WWW-Authenticate') : null;
  } catch {
    return null;
  }
}

/**
 * Attach the MPP challenge to whatever 402 the x402 layer goes on to emit, so
 * one 402 carries both protocols' challenges. A non-402 response is untouched.
 */
function attachChallengeOn402(res, challengeHeader) {
  if (!challengeHeader) return;
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = function writeHead(statusCode, ...rest) {
    const code = typeof statusCode === 'number' ? statusCode : res.statusCode;
    if (code === 402 && !res.headersSent) {
      try {
        res.setHeader('WWW-Authenticate', challengeHeader);
      } catch {
        /* headers already flushed; nothing to do */
      }
    }
    return originalWriteHead(statusCode, ...rest);
  };
}

/** Hand a claimed signature back after a failed verification. Never throws. */
function releaseClaim(signature) {
  if (!signature) return;
  try {
    state.store.releaseSignature(signature);
  } catch (error) {
    // A stuck claim expires on its own lease; losing this is not fatal.
    console.error('[mpp] releasing replay claim failed:', error.message);
  }
}

/** Freeze a claimed signature permanently once it has settled. */
function settleClaim(signature) {
  if (!signature) return;
  try {
    state.store.settleSignature(signature);
  } catch (error) {
    console.error('[mpp] settling replay claim failed:', error.message);
  }
}

/** Copy only the payment headers off the receipt response onto the 200. */
function applyReceiptHeaders(res, result) {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    try {
      const wrapped = result.withReceipt(Response.json(body));
      for (const [name, value] of wrapped.headers.entries()) {
        if (/^payment-/i.test(name)) res.setHeader(name, value);
      }
    } catch {
      /* withReceipt only throws when no response was supplied */
    }
    return originalJson(body);
  };
}

// ---- the gate ------------------------------------------------------------

/**
 * Express middleware for one gated route. Mount BEFORE the x402 layer.
 *
 * There is no soft path: the only branch that calls `next()` without a 402
 * having been arranged is the one where mppx returned 200, which means the
 * transfer was broadcast (or found), confirmed at `confirmed`, re-verified
 * against the challenge on-chain and recorded as consumed.
 */
function gate(pattern) {
  return async function mppGate(req, res, next) {
    if (ready) {
      try {
        await ready;
      } catch {
        // init() failed. server.js exits on that, but a request that arrives
        // first must not be treated as paid.
        return next();
      }
    }
    const entry = state && state.gated.get(pattern);
    if (!entry) return next();

    const presented = hasPaymentCredential(req);
    const slot = {};

    // --- pre-broadcast replay gate (§11.6) -------------------------------
    //
    // @solana/mpp 0.7.0 broadcasts before it consults the store, so a replayed
    // pull credential would be re-verified on-chain and could earn a second
    // 200 for one payment. Close that here, for both credential shapes.
    // The claim is a WRITE whose row count decides the outcome, taken before
    // any await, so two concurrent presentations of one credential cannot both
    // proceed. It is released again if verification fails, so a genuine payer
    // can retry; a crash mid-settlement is recovered by the lease.
    let claimed = null;
    if (presented) {
      const payload = pullTransactionFromCredential(req);
      const signature =
        payload === null
          ? null
          : payload.kind === 'signature'
            ? payload.value
            : signatureFromBase64Transaction(payload.value);
      if (signature) {
        let verdict;
        try {
          verdict = state.store.claimSignature(signature);
        } catch (error) {
          // A store that cannot arbitrate must not be treated as permission.
          console.error('[mpp] replay claim failed:', error.message);
          const challengeHeader = await freshChallengeHeader(req, entry);
          return sendProblem(res, {
            challengeHeader,
            detail: 'Payment verification could not be completed',
            title: 'Verification Failed',
            type: 'verification-failed',
          });
        }
        if (verdict === 'claimed') {
          claimed = signature;
        } else {
          const challengeHeader = await freshChallengeHeader(req, entry);
          return sendProblem(res, {
            challengeHeader,
            detail:
              verdict === 'consumed'
                ? 'Signature already consumed'
                : 'Settlement for this transaction is already in progress',
            title: 'Transfer Mismatch',
            type: 'verification-failed',
          });
        }
      }
    }

    let result;
    try {
      result = await requestContext.run(slot, () =>
        state.mppx.charge({
          amount: entry.amount,
          description: entry.description,
          scope: entry.scope,
        })(toWebRequest(req)),
      );
    } catch (error) {
      // A throw here is an infrastructure failure (RPC down, store error), not
      // a payment decision. It must never become a 200.
      console.error('[mpp] charge handler threw:', error && error.message);
      releaseClaim(claimed);
      const challengeHeader = await freshChallengeHeader(req, entry);
      return sendProblem(res, {
        challengeHeader,
        detail: 'Payment verification could not be completed',
        title: 'Verification Failed',
        type: 'verification-failed',
      });
    }

    if (result.status === 200) {
      const reference = slot.receipt && slot.receipt.reference;
      // Upstream has recorded its consumed marker by now; mark the claim
      // settled so it can never be taken over by a lease expiry. This runs
      // BEFORE the attribution await below so the concurrency state machine
      // reaches its final state at exactly the same point it does today — an
      // attribution read must not widen any window it does not own.
      settleClaim(claimed);
      // Shaped to match decodeSettlement()'s {payer, transaction} so the
      // existing audit log needs no new field names. The receipt @solana/mpp
      // builds carries no payer (Receipt.from in Charge.js sets method /
      // challengeId / reference / status / timestamp only).
      //
      // Pull mode is unchanged: the credential carries the signed transaction,
      // so credentialSource() already answers with no RPC call. Push mode is
      // the gap — §8 makes `source` optional and the reference client omits it,
      // so the row would land status='paid' with payer_wallet NULL and
      // /opt/afwatch/afwatch.js (WHERE status='paid' AND payer_wallet IS NOT
      // NULL, afwatch.js:139-140) would silently drop a genuine paying
      // customer. The settled transaction is the authoritative answer, so read
      // it back.
      //
      // Fail-soft by design: a null here costs one attribution row, while a
      // throw or a 402 would cost a customer who has already paid.
      let payer = credentialSource(req);
      if (!payer) payer = await feePayerFromSettledSignature(reference || null);
      req.mppSettlement = { payer: payer || null, transaction: reference || null };
      applyReceiptHeaders(res, result);
      return next();
    }

    // Verification failed, so the signature is NOT spent: hand it back so a
    // genuine payer can retry rather than burning their transaction.
    releaseClaim(claimed);

    const challengeHeader = result.challenge.headers.get('WWW-Authenticate');

    if (presented) {
      // A credential was supplied and did not verify. §13: answer 402, with a
      // problem body whose `type` is one of malformed-credential /
      // invalid-challenge / verification-failed, and a fresh challenge.
      //
      // mppx already emits exactly that for credential-shape errors, so those
      // are relayed verbatim. It does NOT for verification errors: an amount
      // mismatch, a wrong recipient, a wrong mint or a consumed signature all
      // surface as `internal-payment-error` with `"status": 500` in the body
      // and the underlying cause dropped (error.cause and error.details are
      // both undefined — measured). Relaying that would tell a payer who
      // underpaid that the server broke, and would put a 500 in the body of a
      // 402. Those are re-shaped here.
      if (isStandardProblem(slot.error)) return relayWebResponse(res, result.challenge);
      return sendProblem(res, {
        challengeHeader,
        detail:
          'Payment verification failed: the transfer does not match the challenge, or the transaction is not confirmed.',
        title: 'Verification Failed',
        type: 'verification-failed',
      });
    }

    // No credential: let the x402 layer answer as it always has, with the MPP
    // challenge riding along on the same 402.
    attachChallengeOn402(res, challengeHeader);
    return next();
  };
}

/**
 * Wrap the x402 middleware so a request already settled over MPP is not asked
 * to pay twice. Identity when MPP is off.
 */
function wrapX402(middleware) {
  if (!isEnabled()) return middleware;
  return function x402UnlessMppSettled(req, res, next) {
    if (req.mppSettlement) return next();
    return middleware(req, res, next);
  };
}

module.exports = { clampDescription, gate, init, isEnabled, usdToBaseUnits, wrapX402 };
