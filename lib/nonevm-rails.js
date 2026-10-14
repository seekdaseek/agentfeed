// lib/nonevm-rails.js — R10 Phase B: XRPL, Stellar, Sui, NEAR, Hedera and Fogo, through Ultravioleta.
//
// BUILT, NOT LIVE. A row is in this process only when its payTo is set in .env (XRPL_PAY_TO, STELLAR_PAY_TO, ...), and that
// line is written only after ops/r10-verify-account.mjs has read the account on-chain: it exists, it can receive the token
// (trustline, association, storage deposit), and it is not the facilitator's own account. Custody is his: the box never holds
// a key for any of these accounts.
//
// Every row is on request only (the 402 header has no room: lib/ext-rails.js): GET /api/<route>|<network>.
//
// TOKENS come from Ultravioleta's /supported (2026-10-14) and agree with the official @x402 packages' default assets
// (@x402/stellar, @x402/near, @x402/hedera 2.28.0): Stellar USDC is the SAC contract with 7 decimals; NEAR USDC is the NEP-141
// account 17208628…; Hedera USDC is HTS token 0.0.456858; Sui USDC is the native coin type; Fogo USDC is an SPL mint. XRPL USDC
// is Circle's issued currency (code USDC = hex 5553444300…, issuer rGm7…) and is quoted the way @x402/xrpl quotes an IOU: the
// currency code as asset, the issuer in extra, the amount as a decimal string.
//
// SCHEMES. The official server schemes for XRPL and Hedera load their chain SDKs at require time (+34 MB and +61 MB RSS,
// measured), and none of them does more than shape the requirement: verification is the facilitator's. So each family's server
// scheme below reproduces the official package's parsePrice/enhancePaymentRequirements output with no dependency, and Fogo
// (SVM) uses @x402/svm's ExactSvmScheme, already loaded for Solana.
'use strict';

const NONEVM_RAILS = [
  { network: 'xrpl:0', name: 'XRPL', env: 'XRPL_PAY_TO', family: 'xrpl', token: { symbol: 'USDC', currency: '5553444300000000000000000000000000000000', issuer: 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE', decimals: 6 } },
  { network: 'stellar:pubnet', name: 'Stellar', env: 'STELLAR_PAY_TO', family: 'stellar', token: { symbol: 'USDC', address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', decimals: 7 } },
  { network: 'sui:mainnet', name: 'Sui', env: 'SUI_PAY_TO', family: 'sui', token: { symbol: 'USDC', address: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC', decimals: 6 } },
  { network: 'near:mainnet', name: 'NEAR', env: 'NEAR_PAY_TO', family: 'near', token: { symbol: 'USDC', address: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6 } },
  { network: 'hedera:mainnet', name: 'Hedera', env: 'HEDERA_PAY_TO', family: 'hedera', token: { symbol: 'USDC', address: '0.0.456858', decimals: 6 } },
  { network: 'fogo:mainnet', name: 'Fogo', env: 'FOGO_PAY_TO', family: 'svm', token: { symbol: 'USDC', address: 'uSd2czE61Evaf76RNbq4KPpXnkiL3irdzgLFUMe3NoG', decimals: 6 } },
];

// payTo shape per family: a malformed .env line refuses to boot the row rather than quoting an address nobody can pay
const PAYTO_SHAPE = {
  xrpl: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
  stellar: /^G[A-Z2-7]{55}$/,
  sui: /^0x[0-9a-f]{64}$/,
  near: /^(?:[a-z0-9]+(?:[-_][a-z0-9]+)*\.)*[a-z0-9]+(?:[-_][a-z0-9]+)*$|^[0-9a-f]{64}$/,
  hedera: /^0\.0\.\d+$/,
  svm: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};

/** The rows with a payTo set (X402_NONEVM=off removes all). Throws on a payTo of the wrong shape. */
function nonEvmRails(env = process.env) {
  if (env.X402_NONEVM === 'off') return [];
  const out = [];
  for (const r of NONEVM_RAILS) {
    const payTo = String(env[r.env] || '').trim();
    if (!payTo) continue;
    if (!PAYTO_SHAPE[r.family].test(payTo)) throw new Error(`${r.env} is not a ${r.name} account: ${payTo}`);
    out.push({ ...r, payTo, facilitator: 'ultravioleta' });
  }
  return out;
}

/** The explicit price for a row: base units for every family but XRPL, whose IOU amount is a decimal string (@x402/xrpl). */
function nonEvmPrice(rail, usd) {
  const t = rail.token;
  if (rail.family === 'xrpl') return { amount: String(Number(usd)), asset: t.currency, extra: { issuer: t.issuer } };
  return { amount: String(Math.round(Number(usd) * 10 ** t.decimals)), asset: t.address, extra: {} };
}

const nonEvmAccept = (rail, usd) => ({ scheme: 'exact', price: nonEvmPrice(rail, usd), network: rail.network, payTo: rail.payTo });

/** Minimal server scheme: explicit prices only; enhance as the official package does for that family. */
class LightScheme {
  constructor(family) {
    this.family = family;
    this.scheme = 'exact';
    this.defaultAssetTransferMethod = family === 'xrpl' ? 'sequence' : 'default';
    this.paymentFlows = family === 'xrpl'
      ? { sequence: { supported: ['authorization', 'upfront'], default: 'authorization' }, ticketSequence: { supported: ['authorization', 'upfront'], default: 'authorization' } }
      : { default: { supported: ['authorization', 'upfront'], default: 'authorization' } };
  }
  getAssetDecimals() { return undefined; }
  async parsePrice(price, network) {
    if (!price || typeof price !== 'object' || !('amount' in price) || !price.asset) throw new Error(`${network}: only explicit {amount, asset} prices`);
    return { amount: price.amount, asset: price.asset, extra: price.extra || {} };
  }
  async enhancePaymentRequirements(req, kind) {
    const extra = { ...(req.extra || {}) };
    if (this.family === 'xrpl') extra.areFeesSponsored = false; // @x402/xrpl: the payer's signed Payment carries its own XRP fee
    if (this.family === 'stellar' && typeof (kind.extra && kind.extra.areFeesSponsored) === 'boolean') extra.areFeesSponsored = kind.extra.areFeesSponsored; // @x402/stellar
    if ((this.family === 'hedera' || this.family === 'sui') && typeof (kind.extra && kind.extra.feePayer) === 'string') extra.feePayer = kind.extra.feePayer; // @x402/hedera; Sui the same way (sponsored)
    // near: @x402/near leaves the requirement as it is
    return { ...req, extra };
  }
}

/** The server scheme for one row. */
function schemeFor(rail) {
  if (rail.family === 'svm') { const { ExactSvmScheme } = require('@x402/svm/exact/server'); return new ExactSvmScheme(); }
  return new LightScheme(rail.family);
}

module.exports = { NONEVM_RAILS, nonEvmRails, nonEvmPrice, nonEvmAccept, schemeFor, LightScheme, PAYTO_SHAPE };
