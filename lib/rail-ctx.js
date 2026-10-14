// lib/rail-ctx.js — which accepts this /api request's 402 carries (R10 Phase A).
//
// @x402/core reads a route's `accepts` on every request (x402HTTPResourceServer keeps the config object by reference and
// normalizePaymentOptions reads routeConfig.accepts each time), so payments.js gives each route an `accepts` getter that asks
// this module. The answer:
//   outside an /api request (boot validation, the manifest, the discovery listing)   every accept, so all are checked and listed
//   an /api request that names no on-request network                                   the default list (today's thirteen + the
//                                                                                       ext rows marked inDefault)
//   /api/<route>|<network>, or a payment whose `accepted.network` is an on-request one  today's thirteen + that network only: the
//                                                                                       header stays as small as the default one
// The network a payer chose is read from PAYMENT-SIGNATURE (v2) or X-PAYMENT; this runs after the alias middlewares, so an
// Authorization: Payment or a v2 payload in X-PAYMENT has already been moved to the header core reads. A payload that does not
// decode names no network: the request gets the default list and core refuses the payment as it always has.
'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();
// the EVM networks and the Phase B families (lib/nonevm-rails.js)
const NET_ID = 'eip155:\\d+|xrpl:\\d+|stellar:pubnet|sui:mainnet|near:mainnet|hedera:mainnet|fogo:mainnet';
const SUFFIX_NET = new RegExp(`(?:\\||%7[cC])(${NET_ID})$`);
const NET_RE = new RegExp(`^(?:${NET_ID})$`);

function paidNetwork(req) {
  const raw = req.headers['payment-signature'] || req.headers['x-payment'];
  if (typeof raw !== 'string' || raw.length > 20000) return null;
  try {
    const p = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    const n = (p && p.accepted && p.accepted.network) || (p && p.network);
    return typeof n === 'string' && NET_RE.test(n) ? n : null;
  } catch { return null; }
}

/** Express middleware: mount right before the x402 gate. */
function railContext(req, _res, next) {
  if (!req.path.startsWith('/api/')) return next();
  const m = req.x402OriginalPath ? SUFFIX_NET.exec(req.x402OriginalPath) : null;
  als.run({ asked: m ? m[1] : null, paid: paidNetwork(req) }, next);
}

/**
 * The accepts for one route under the current request.
 * base: today's accepts (exact + high-frequency); ext: this route's ext accepts in table order; isDefault(network) -> bool.
 */
function acceptsFor(base, ext, isDefault) {
  const s = als.getStore();
  if (!s) return [...base, ...ext];
  const def = ext.filter((a) => isDefault(a.network));
  for (const net of [s.paid, s.asked]) {
    if (!net || isDefault(net)) continue;
    const one = ext.find((a) => a.network === net);
    if (one) return [...base, one];
  }
  return [...base, ...def];
}

module.exports = { railContext, acceptsFor, paidNetwork, als, SUFFIX_NET };
