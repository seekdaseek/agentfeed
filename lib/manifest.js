// lib/manifest.js — the accepts of /.well-known/x402.json, built by the payment layer itself (R10 F1).
//
// The manifest used to list Solana plus evmRails() by hand, so Algorand (and the half-price batch-settlement and Gateway
// accepts) were in every 402 and missing from the manifest. Here each route's accepts come from the SAME route config the
// x402 middleware answers with (payments.js routeAccepts, layer.routes) through the same core call the middleware makes for a
// 402, resourceServer.buildPaymentRequirementsFromOptions. So scheme, network, amount, asset and payTo are the 402's, and any
// rail added to the 402 later is in the manifest with no second edit. Scheme enrichment at 402 time can only ADD keys to
// `extra` (@x402/core asserts it), never change those five.
//
// Built once, after the facilitators' /supported has been read (buildPaymentRequirements throws before that); a failure is
// not cached, so the next request retries.
'use strict';

// Tokens whose decimals or symbol are not USDC's 6 / "USDC", keyed `${network}|${asset}` (lower-case): the R10 Phase A rows
// (lib/ext-rails.js) add theirs, so AUSD, USDG and USDC.e are named as what they are.
const { EXT_RAILS } = require('./ext-rails');
const { NONEVM_RAILS } = require('./nonevm-rails');
const TOKENS = {};
for (const r of EXT_RAILS) TOKENS[`${r.network}|${r.token.address.toLowerCase()}`] = { symbol: r.token.symbol, decimals: r.token.decimals };
// Phase B: an XRPL IOU amount is already a decimal string (decimals 0 here); every other family is in base units
for (const r of NONEVM_RAILS) TOKENS[`${r.network}|${String(r.token.address || r.token.currency).toLowerCase()}`] = { symbol: r.token.symbol, decimals: r.family === 'xrpl' ? 0 : r.token.decimals };
const EXT_BY_NET = new Map([...EXT_RAILS, ...NONEVM_RAILS.map((r) => ({ ...r, inDefault: false }))].map((r) => [r.network, r]));

function tokenOf(network, asset) {
  return TOKENS[`${network}|${String(asset).toLowerCase()}`] || { symbol: 'USDC', decimals: 6 };
}

/**
 * The accept as the 402 carries it, plus the token symbol and the USD price for a reader that does not do units. An accept on a
 * network outside the default 402 (lib/ext-rails.js, R10 Phase A) says how to get it: `on_request` is the suffix that makes the
 * route's 402 carry it (GET /api/<route>|<network>); a payment on it is accepted on the plain URL as well.
 */
function manifestAccept(r) {
  const t = tokenOf(r.network, r.asset);
  const usd = Math.round((Number(r.amount) / 10 ** t.decimals) * 1e6) / 1e6; // dollars to the micro-dollar, whatever the token's units
  const ext = EXT_BY_NET.get(r.network);
  return { scheme: r.scheme, network: r.network, amount: r.amount, asset: r.asset, payTo: r.payTo, maxTimeoutSeconds: r.maxTimeoutSeconds, ...(r.extra && Object.keys(r.extra).length ? { extra: r.extra } : {}), asset_symbol: t.symbol, price_usd: usd, ...(ext && !ext.inDefault ? { on_request: `|${r.network}` } : {}) };
}

/** deps: getLayer() -> payments.js layer {routes, resourceServer} or null (payments off). Returns async () => Map(pattern -> accepts[]). */
function makeManifestAccepts({ getLayer }) {
  let built = null;
  return async function manifestAccepts() {
    if (built) return built;
    const layer = getLayer();
    if (!layer) return new Map();
    const out = new Map();
    for (const [pattern, rc] of Object.entries(layer.routes)) {
      const reqs = await layer.resourceServer.buildPaymentRequirementsFromOptions(rc.accepts, {});
      out.set(pattern, reqs.map(manifestAccept));
    }
    built = out;
    return built;
  };
}

module.exports = { makeManifestAccepts, manifestAccept, tokenOf, TOKENS };
