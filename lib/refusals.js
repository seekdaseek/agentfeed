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
  if (req && req.error) return `verification refused: ${req.error}`;
  return 'refused with no reason in the response (a settlement that threw answers a bare 402; see the service log)';
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
        error_msg: scrub(refusalReason(res, body)),
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

module.exports = { makeRefusalRecorder, _x402Payer: x402Payer, _scrub: scrub };
