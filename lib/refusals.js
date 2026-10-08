// lib/refusals.js — one audit row for every payment that was presented and refused.
//
// On Sep 28 2026 the first base-balance payment of Phase 6 came back 402,
// uncharged, and left no trace: no calls row, no reason, nothing in the log. A
// buyer who presents a payment and is still answered 402 was turned away, so
// that is recorded now: ONE calls row, status payment_refused, the reason the
// facilitator or the middleware gave, the route, and the payer when the payment
// names one. Never the signature, the transaction or the payload.
//
// Presented means a payment on the request:
//   x402  PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1): base64 JSON payload
//   MPP   Authorization or Payment-Authorization: Payment <credential>
// A plain unpaid request presents nothing and writes nothing: its 402 is the
// challenge, not a refusal.
//
// Where the reason is, read from @x402/express 2.17.0 and mpp/index.js:
//   x402 verify refusal   PAYMENT-REQUIRED header, base64 JSON, .error
//   x402 settle refusal   PAYMENT-RESPONSE header, base64 JSON, .errorReason
//   MPP refusal           application/problem+json body, .title and .detail
// A settlement that THREW answers a bare 402 {} and is recorded with that said.
'use strict';
const { decodeTransactionFromPayload, getTokenPayerFromTransaction } = require('@x402/svm');

const b64json = (v) => {
  if (v == null) return null;
  try { return JSON.parse(Buffer.from(String(v), 'base64').toString('utf8')); } catch { return null; }
};

// The payer an x402 payment names, or null. Decoding never throws into a request.
function x402Payer(header) {
  const p = b64json(header);
  const payload = p && p.payload;
  if (!payload || typeof payload !== 'object') return null;
  // exact EVM: the EIP-3009 authorization names its sender
  if (payload.authorization && typeof payload.authorization.from === 'string') return payload.authorization.from;
  // exact SVM: the transfer authority inside the transaction, the way the facilitator reads it
  if (typeof payload.transaction === 'string') {
    try { return getTokenPayerFromTransaction(decodeTransactionFromPayload({ transaction: payload.transaction })) || null; } catch { return null; }
  }
  return null;
}

// The SHAPE of a payment header the middleware could not read, never its
// content: which header, its length, whether it is base64 that decodes to JSON
// (and the x402Version it claims, a number), and the character classes of its
// first eight characters (A upper, a lower, 9 digit, the symbol itself for
// + / = - _ and ? for anything else). Enough to tell a v1 client, a truncated
// header and plain garbage apart in the audit table without storing a payment.
function headerShape(req) {
  const name = req.headers['payment-signature'] != null ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT';
  const v = String(req.headers['payment-signature'] ?? req.headers['x-payment'] ?? '');
  const p = b64json(v);
  const prefix = v.slice(0, 8).replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/[0-9]/g, '9').replace(/[^Aa9+/=_-]/g, '?');
  const version = p && Number.isInteger(p.x402Version) ? ` x402Version=${p.x402Version}` : '';
  return `${name} len=${v.length} prefix=${prefix} base64json=${p ? 'yes' : 'no'}${version}`;
}

// A reason is kept as text; any signature, hash or payload it quotes is not.
function scrub(s) {
  return String(s)
    .replace(/0x[0-9a-fA-F]{64,}/g, '<hash>')                  // EVM tx hash or signature (addresses are 40 hex)
    .replace(/[1-9A-HJ-NP-Za-km-z]{64,}/g, '<signature>')      // base58 at signature length (addresses are 32-44)
    .replace(/[A-Za-z0-9+/_-]{100,}={0,2}/g, '<payload>');       // base64 blobs
}

function refusalReason(res, body) {
  const type = String(res.getHeader('content-type') || '');
  if (/application\/problem\+json/i.test(type)) {
    try {
      const p = JSON.parse(body);
      const kind = String(p.type || '').split('/').pop();
      return [kind, p.title, p.detail].filter(Boolean).join(': ') || 'mpp refused the credential';
    } catch { /* fall through to the headers */ }
  }
  const settle = b64json(res.getHeader('payment-response') || res.getHeader('x-payment-response'));
  if (settle && settle.success === false) return `settlement refused: ${settle.errorReason || settle.errorMessage || 'no reason given'}`;
  const req = b64json(res.getHeader('payment-required') || res.getHeader('x-payment-required'));
  // @x402/core reads only a decodable v2 PAYMENT-SIGNATURE (extractPayment returns
  // null on anything else, X-PAYMENT included) and then answers the plain
  // challenge, whose error is exactly this string. Kept, and said what it means.
  if (req && req.error === 'Payment required') return 'verification refused: Payment required (the payment header was not a decodable x402 v2 PAYMENT-SIGNATURE, so the middleware answered its plain challenge)';
  if (req && typeof req.error === 'string' && /^x402 v1 /.test(req.error)) return req.error;
  if (req && req.error) return `verification refused: ${req.error}`;
  return 'refused with no reason in the response (a settlement that threw answers a bare 402; see the service log)';
}

// A decodable v2 payment with a field missing (no `accepted`, say) makes
// @x402/core throw inside its own matcher -- paymentRequirementsMatchAccepted()
// destructures `accepted` -- and the middleware puts that JavaScript message
// into the 402's .error. Measured 2026-10-08 on the live service: "Cannot
// destructure property 'extra' of 'accepted' as it is undefined." The status was
// already a clean 402; the reason was our stack. A buyer is owed a reason, so a
// JS-error message in the challenge is replaced, and only that: a facilitator's
// own refusal (invalid_exact_svm_payload_..., invalid_exact_evm_payload_...)
// matches none of these patterns and is passed through untouched.
const JS_ERROR = /\b(TypeError|ReferenceError|RangeError|SyntaxError)\b|Cannot (destructure|read propert|set propert)|is not (a function|iterable|defined)|of (undefined|null)\b|undefined is not/;
const MALFORMED = 'invalid_payment_payload: not a well-formed x402 v2 payment; PAYMENT-SIGNATURE needs x402Version 2, an accepted requirement copied from this challenge, and a payload';

// X-PAYMENT, the x402 v1 header name. Measured 2026-10-08: one client (3.14.8.71,
// UA node) presented a payment 126 times across 14 routes over a week and was
// refused every time, because @x402/core's server extractPayment() reads only
// PAYMENT-SIGNATURE (its comment says "handles v1 and v2"; the code does not) --
// and this service's own openapi.json, llms.txt and SKILL.md told buyers to send
// X-PAYMENT until 2026-10-08. The error log, never rotated since Jul 8, holds no
// PAYMENT-SIGNATURE decode warning from that client, so the header it sent was
// X-PAYMENT.
//
// The installed packages cannot serve a true v1 client: neither @x402/evm 2.18
// nor @x402/svm 2.17 ships a v1 SERVER scheme (only v1 client and facilitator),
// the HTTP layer never emits a v1 402 body, and core's v1 match reads
// payload.accepted, which a v1 payload does not have. So: X-PAYMENT carrying a
// valid x402 v2 payload is accepted as PAYMENT-SIGNATURE; a v1 payload is still
// refused, and the 402 now says why instead of a bare "Payment required".
// Reached only when X-PAYMENT is neither a v1 nor a v2 payload: since S4 (lib/x402v1.js)
// an x402Version 1 payload is paid on base and solana, and a v2 one through the alias.
const V1_UNSUPPORTED = 'X-PAYMENT not understood: send base64 JSON with x402Version 1 (exact on base or solana, requirements in this response body) or x402Version 2 (any rail in the PAYMENT-REQUIRED header)';

function aliasXPayment(req, res, next) {
  const xp = req.headers['x-payment'];
  if (xp == null || req.headers['payment-signature'] != null) return next();
  const p = b64json(xp);
  if (p && p.x402Version === 2) {
    req.headers['payment-signature'] = xp;
    // A client that sends X-PAYMENT may read the settlement from X-PAYMENT-RESPONSE.
    const setHeader = res.setHeader;
    res.setHeader = function (name, value) {
      if (String(name).toLowerCase() === 'payment-response') setHeader.call(this, 'X-PAYMENT-RESPONSE', value);
      return setHeader.call(this, name, value);
    };
  } else {
    req.xPaymentNotV2 = true;
  }
  next();
}

function sanitizeChallengeErrors(req, res, next) {
  if (req.headers['payment-signature'] == null && req.headers['x-payment'] == null) return next();
  const setHeader = res.setHeader;
  res.setHeader = function (name, value) {
    if (String(name).toLowerCase() === 'payment-required') {
      const c = b64json(value);
      if (c && req.x402PlainReason && c.error === 'Payment required') {
        // lib/x402v1.js refused a v1 payment and fell through to this plain challenge
        c.error = req.x402PlainReason;
        value = Buffer.from(JSON.stringify(c)).toString('base64');
      } else if (c && typeof c.error === 'string' && JS_ERROR.test(c.error)) {
        c.error = MALFORMED;
        value = Buffer.from(JSON.stringify(c)).toString('base64');
      } else if (c && req.xPaymentNotV2 && c.error === 'Payment required') {
        c.error = V1_UNSUPPORTED;
        value = Buffer.from(JSON.stringify(c)).toString('base64');
      }
    }
    return setHeader.call(this, name, value);
  };
  next();
}

/**
 * deps: { logCall, PRICES, mppPayer }  -- mppPayer(req) decodes an MPP credential's
 * payer (mpp/index.js credentialSource), or is absent when MPP is not loaded.
 */
function makeRefusalRecorder({ logCall, PRICES, mppPayer }) {
  // PRICES pattern -> tool, so the row names the tool the way every other row does
  const routes = Object.entries(PRICES).map(([pattern, p]) => {
    const path = pattern.replace(/^GET /, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z0-9_]+/g, '[^/]+');
    return [new RegExp(`^${path}$`), p.tool];
  });
  const toolFor = (path) => (routes.find(([re]) => re.test(path)) || [null, 'unpriced_route'])[1];
  const mppPresented = (req) => ['authorization', 'payment-authorization']
    .some((h) => typeof req.headers[h] === 'string' && /^payment\s+\S/i.test(req.headers[h].trim()));

  return function recordRefusals(req, res, next) {
    const x402 = req.headers['payment-signature'] || req.headers['x-payment'];
    const mpp = mppPresented(req);
    if (!x402 && !mpp) return next();
    const t0 = Date.now();
    // Only the MPP refusal carries its reason in the body; keep the first 4 KB.
    let body = '';
    const keep = (chunk) => {
      if (chunk == null || typeof chunk === 'function' || body.length >= 4096) return;
      body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    };
    const write = res.write, end = res.end;
    res.write = function (chunk, ...rest) { keep(chunk); return write.call(this, chunk, ...rest); };
    res.end = function (chunk, ...rest) { keep(chunk); return end.call(this, chunk, ...rest); };
    res.on('finish', () => {
      if (res.statusCode !== 402) return;
      let payer = null;
      try { payer = (mpp && mppPayer ? mppPayer(req) : null) || (x402 ? x402Payer(x402) : null); } catch { payer = null; }
      logCall({
        tool: toolFor(req.path),
        status: 'payment_refused',
        payer_wallet: payer,
        error_msg: (() => {
          const reason = scrub(refusalReason(res, body));
          // undecodable or v1: say what arrived, by shape only
          return x402 && /not a decodable x402 v2|invalid_payment_payload|x402 v1|X-PAYMENT not understood/.test(reason) ? `${reason}; header ${req.x402ShapeOverride || headerShape(req)}` : reason;
        })(),
        latency_ms: Date.now() - t0,
        ip: req.callerIp,
        req_path: req.path,
        user_agent: req.headers['user-agent'],
        method: req.method,
      });
    });
    next();
  };
}

module.exports = { makeRefusalRecorder, sanitizeChallengeErrors, aliasXPayment, V1_UNSUPPORTED, _x402Payer: x402Payer, _scrub: scrub, _headerShape: headerShape };
