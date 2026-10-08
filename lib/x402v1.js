// lib/x402v1.js — x402 v1 buyers, served by the same prices, payTo and facilitator.
//
// WHY. The installed v2 stack (@x402/express 2.17, @x402/core 2.17) reads only the
// PAYMENT-SIGNATURE header and publishes its challenge only in the PAYMENT-REQUIRED
// header, with a body of {}. A v1 client (x402-fetch / x402 1.2.0, the legacy line in
// coinbase/x402 typescript/packages/legacy) reads the challenge from the BODY and pays
// with X-PAYMENT, so it could never pay: 3.14.8.71 sent X-PAYMENT 126 times in a week.
//
// WHAT, per the v1 HTTP transport (specs/transports-v1/http.md):
//   1. every x402 402 also carries the v1 body {x402Version: 1, error, accepts}, built
//      from the very challenge in its PAYMENT-REQUIRED header, which stays as it is. A v2
//      client reads the header first (@x402/core getPaymentRequiredResponse), so it never
//      sees the body.
//   2. an X-PAYMENT whose payload is x402Version 1 is verified and settled through the
//      CDP facilitator's v1 kinds against v1 requirements built from the route's own
//      v2 requirements, and the response carries X-PAYMENT-RESPONSE (and PAYMENT-RESPONSE,
//      which the audit row reads). A v1 payload sent under PAYMENT-SIGNATURE is taken the
//      same way: that is what "Cannot destructure property 'extra' of 'accepted'" was.
//   3. like @x402/express, the handler's response is held until settlement, and a status
//      of 400 or more is sent unsettled: the buyer is never charged for an error.
//
// RAILS. v1 only where BOTH sides have it, measured 2026-10-08: CDP /supported lists
// x402Version 1 kinds for base and solana only (no polygon, no arbitrum), and the v1
// client's network enum has no arbitrum at all. The list is re-read from the facilitator
// at boot, so a rail CDP drops is dropped here too. Polygon and Arbitrum stay v2-only.
//
// Every refusal is an ordinary unpaid challenge with a plain reason in its .error
// (req.x402PlainReason, applied by lib/refusals.js sanitizeChallengeErrors), so the
// buyer always gets a 402 it can act on and the refusal recorder logs the reason.

const V1_NAME = {
  'eip155:8453': 'base',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'solana',
};
const V2_NAME = Object.fromEntries(Object.entries(V1_NAME).map(([k, v]) => [v, k]));

const b64json = (s) => {
  try { return JSON.parse(Buffer.from(String(s), 'base64').toString('utf8')); } catch { return null; }
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

/** v1 PaymentRequirements from one v2 requirement + the v2 resource object. */
function toV1(a, resource, v1Kinds) {
  const network = V1_NAME[a.network];
  if (!network || a.scheme !== 'exact') return null;
  const kind = v1Kinds.get(network);
  if (!kind) return null;
  const extra = { ...(a.extra || {}) };
  // Solana: the fee payer is the facilitator's v1 signer, read from /supported.
  if (kind.extra && kind.extra.feePayer) extra.feePayer = kind.extra.feePayer;
  return {
    scheme: 'exact',
    network,
    maxAmountRequired: String(a.amount),
    resource: resource && resource.url,
    description: (resource && resource.description) || '',
    mimeType: (resource && resource.mimeType) || 'application/json',
    payTo: a.payTo,
    maxTimeoutSeconds: a.maxTimeoutSeconds || 300,
    asset: a.asset,
    extra,
  };
}

/** The v1 402 body for a decoded v2 PaymentRequired. */
function v1Body(pr, v1Kinds) {
  return {
    x402Version: 1,
    error: pr.error || 'Payment required',
    accepts: (pr.accepts || []).map((a) => toV1(a, pr.resource, v1Kinds)).filter(Boolean),
  };
}

/**
 * deps (late-bound by bind(), because the payment layer is built after the middleware
 * that must run before the MPP gates is mounted):
 *   resourceServer  x402ResourceServer from payments.js (buildPaymentRequirements)
 *   routes          payments.js route configs, keyed 'GET /api/...'
 *   facilitator     HTTPFacilitatorClient (verify, settle, getSupported)
 */
function makeV1({ shapeOf } = {}) {
  let deps = null;
  const v1Kinds = new Map();     // v1 network -> supported kind
  let matchers = [];

  async function bind(d) {
    deps = d;
    matchers = Object.keys(d.routes).map((pattern) => {
      const path = pattern.replace(/^GET /, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z0-9_]+/g, '[^/]+');
      return [new RegExp(`^${path}$`), pattern];
    });
    const s = await d.facilitator.getSupported();
    v1Kinds.clear();
    for (const k of s.kinds || []) {
      if (k.x402Version === 1 && k.scheme === 'exact' && V2_NAME[k.network]) v1Kinds.set(k.network, k);
    }
    return [...v1Kinds.keys()];
  }

  const patternFor = (path) => (matchers.find(([re]) => re.test(path)) || [])[1] || null;

  // 1. the v1 body on every x402 402 that still has the SDK's empty {} body
  function challengeBody(req, res, next) {
    const json = res.json;
    res.json = function (body) {
      if (this.statusCode === 402 && v1Kinds.size && body && typeof body === 'object'
          && !Array.isArray(body) && Object.keys(body).length === 0) {
        const pr = b64json(this.getHeader('payment-required'));
        if (pr && pr.x402Version === 2) body = v1Body(pr, v1Kinds);
      }
      return json.call(this, body);
    };
    next();
  }

  // Refuse by falling through to the paywall's own unpaid challenge, with a reason.
  // The header shape is captured first: the refusal recorder logs it at 'finish',
  // after the payment headers are gone.
  function strip(req, reason) {
    if (shapeOf) { try { req.x402ShapeOverride = shapeOf(req); } catch { /* shape is best effort */ } }
    delete req.headers['x-payment'];
    delete req.headers['payment-signature'];
    req.x402PlainReason = reason;
  }

  // 2 + 3. a v1 payment, verified, the response held, settled below 400
  async function payments(req, res, next) {
    const raw = req.headers['payment-signature'] != null ? req.headers['payment-signature'] : req.headers['x-payment'];
    if (raw == null || !deps) return next();
    const p = b64json(raw);
    if (!p || p.x402Version !== 1) return next(); // v2 and undecodable: aliasXPayment + the paywall
    const pattern = req.method === 'GET' ? patternFor(req.path) : null;
    if (!pattern) return next();
    let reason = null;
    try {
      reason = await admit(req, res, p, pattern);
    } catch {
      reason = 'x402 v1 payment refused: the payment could not be processed; send it again or pay with x402 v2';
    }
    if (reason) strip(req, reason);
    return next(); // exactly once, outside the try
  }

  // null = admitted (verified, response held); a string = the refusal reason
  async function admit(req, res, p, pattern) {
    if (typeof p.scheme !== 'string' || typeof p.network !== 'string' || !p.payload || typeof p.payload !== 'object') {
      return 'x402 v1 payment refused: the X-PAYMENT payload must be base64 JSON with x402Version, scheme, network and payload';
    }
    if (!v1Kinds.has(p.network)) {
      return `x402 v1 payment refused: v1 is accepted on ${[...v1Kinds.keys()].join(' and ') || 'no network'} only; network "${String(p.network).slice(0, 40)}" needs an x402 v2 PAYMENT-SIGNATURE (see the PAYMENT-REQUIRED header)`;
    }
    const accept = deps.routes[pattern].accepts.find((a) => a.network === V2_NAME[p.network] && a.scheme === p.scheme);
    if (!accept) return `x402 v1 payment refused: no ${String(p.scheme).slice(0, 20)} requirement on ${p.network} for this route`;
    const [v2req] = await deps.resourceServer.buildPaymentRequirements(accept);
    const resource = {
      url: `https://${req.headers.host}${req.originalUrl}`,
      description: deps.routes[pattern].description,
      mimeType: deps.routes[pattern].mimeType || 'application/json',
    };
    const requirements = v2req && toV1(v2req, resource, v1Kinds);
    if (!requirements) return `x402 v1 payment refused: ${p.network} is not offered on this route`;
    let verdict;
    try { verdict = await deps.facilitator.verify(p, requirements); } catch (e) {
      verdict = e && e.invalidReason ? e : { isValid: false, invalidReason: 'facilitator verification failed' };
    }
    if (!verdict.isValid) {
      return `x402 v1 verification refused: ${[verdict.invalidReason, verdict.invalidMessage].filter(Boolean).join(': ').slice(0, 300)}`;
    }
    req.x402v1 = { payload: p, requirements };
    hold(res, p, requirements, v1Body({ resource, accepts: [v2req] }, v1Kinds));
    return null;
  }

  // Hold the handler's response, settle on < 400, then release it; >= 400 never settles.
  function hold(res, payload, requirements, failBody) {
    const end = res.end, write = res.write;
    const chunks = [];
    res.write = function (chunk, enc) { if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc)); return true; };
    res.end = function (chunk, enc, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = null; }
      if (typeof enc === 'function') { cb = enc; enc = undefined; }
      if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc));
      const body = Buffer.concat(chunks);
      const release = () => { res.write = write; res.end = end; return end.call(res, body, cb); };
      if (res.statusCode >= 400) return release();
      deps.facilitator.settle(payload, requirements).then((s) => {
        if (s && s.success) {
          const h = b64(s);
          res.setHeader('X-PAYMENT-RESPONSE', h);
          res.setHeader('PAYMENT-RESPONSE', h);
          return release();
        }
        return refusedAfterHandler(s);
      }).catch((e) => refusedAfterHandler(e && (e.errorReason || e.success === false) ? e : { success: false, errorReason: 'settlement failed' }));
      function refusedAfterHandler(s) {
        const fail = { success: false, errorReason: (s && s.errorReason) || 'settlement failed', transaction: '', network: requirements.network, payer: (s && s.payer) || '' };
        res.statusCode = 402;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('X-PAYMENT-RESPONSE', b64(fail));
        res.setHeader('PAYMENT-RESPONSE', b64(fail));
        res.removeHeader('Content-Length');
        res.write = write; res.end = end;
        return end.call(res, JSON.stringify({ ...failBody, error: `x402 v1 settlement refused: ${fail.errorReason}` }), cb);
      }
      return res;
    };
  }

  return { bind, challengeBody, payments, v1Kinds, _toV1: toV1, _v1Body: v1Body };
}

module.exports = { makeV1, V1_NAME };
