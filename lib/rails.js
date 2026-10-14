// lib/rails.js — the EVM payment rails, one list for every surface.
//
// payments.js (REST 402s), mcp.js (MCP payment requests), server.js (/ and
// /.well-known/x402.json), tools/discovery.js (openapi, llms.txt, SKILL.md) and
// tools/landing.js all read this, so a rail cannot be offered in one place and
// missing from another.
//
// Every rail is USDC by EIP-3009 (scheme `exact`) through the same CDP
// facilitator, paid to the same PAY_TO_EVM address. The SDK resolves "$0.01" to
// each chain's default stablecoin from @x402/evm's DEFAULT_STABLECOINS; the
// addresses here are for the published manifest only, and were checked
// 2026-10-08 against that map, upstream defaultAssets.ts, and each contract's
// own name()/version() ("USD Coin", "2"), which is the EIP-712 domain a payer
// signs. CDP /supported listed exact on all three that day.
//
// X402_EVM_NETWORKS (comma-separated CAIP-2 ids) narrows the list without a code
// change, e.g. X402_EVM_NETWORKS=eip155:8453 serves Base only. Unset = all.
//
// ARC (R4, 2026-10-12) is the exception to "same facilitator, same payTo": it settles
// through Circle's Facilitator Service (lib/circle-arc.js), pays a dedicated EOA whose key
// lives at ARC_PAYTO_KEY (never the treasury), and names its asset explicitly because
// @x402/evm 2.18 has no default stablecoin for eip155:5042. It is listed only while that
// key file exists; X402_ARC=off removes it.
'use strict';
const { ARC, arcPayTo } = require('./circle-arc');

const ALL_EVM_RAILS = [
  { network: 'eip155:8453', name: 'Base', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  { network: 'eip155:137', name: 'Polygon', usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  { network: 'eip155:42161', name: 'Arbitrum', usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
];

// ALGORAND (R5 A4): exact on Algorand mainnet through the GoPlausible facilitator, the same
// facilitator and payTo the standalone Algorand service (algo.ochinimus.app) has settled with
// since September; @x402/avm resolves "$0.01" to USDC ASA 31566704. X402_ALGO=off removes it.
const ALGORAND_MAINNET = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
function algoRail(env = process.env) {
  if (env.X402_ALGO === 'off') return null;
  return { network: ALGORAND_MAINNET, name: 'Algorand', asset: 'USDC (ASA 31566704)',
    payTo: env.ALGO_PAY_TO || 'QWOWU2E6BB76HEQRRMXWZ2MU4HAQIYZWEPP2W7Y377ZRDIW7ZKD4MMMEPM',
    facilitator: env.ALGO_FACILITATOR_URL || 'https://facilitator.goplausible.xyz' };
}

function arcRail(env = process.env) {
  const payTo = arcPayTo(env);
  return payTo ? { network: ARC.network, name: 'Arc', usdc: ARC.usdc, payTo, facilitator: 'circle', asset: { address: ARC.usdc, decimals: 6, extra: ARC.extra } } : null;
}

function evmRails(env = process.env) {
  if (!env.PAY_TO_EVM) return [];
  const arc = arcRail(env);
  const all = arc ? [...ALL_EVM_RAILS, arc] : ALL_EVM_RAILS;
  const only = String(env.X402_EVM_NETWORKS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!only.length) return all;
  const known = [...ALL_EVM_RAILS.map((r) => r.network), ARC.network];
  const unknown = only.filter((n) => !known.includes(n));
  if (unknown.length) throw new Error(`X402_EVM_NETWORKS names unknown rails: ${unknown.join(', ')}`);
  return all.filter((r) => only.includes(r.network));
}

/** The price an accept for this rail carries: "$0.01", or an explicit asset amount for Arc. */
function railPrice(rail, usd) {
  if (!rail.asset) return `$${usd}`;
  return { amount: String(Math.round(Number(usd) * 10 ** rail.asset.decimals)), asset: rail.asset.address, extra: rail.asset.extra };
}

/** payTo for this rail: its own (Arc) or the EVM treasury. */
const railPayTo = (rail, env = process.env) => rail.payTo || env.PAY_TO_EVM;

/** "Solana, Base, Polygon or Arbitrum" */
function railNames(solanaLabel = 'Solana', env = process.env) {
  const names = [solanaLabel, ...evmRails(env).map((r) => r.name)];
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0];
}

/**
 * The exact rails of every paid HTTP route, in the order the 402 lists them: Solana, the EVM rails, Algorand. One entry per
 * rail, {name, network}, for every text surface that names or counts them (llms.txt, SKILL.md, openapi, the agent card), so a
 * rail added here or to evmRails() cannot be missing from one of them. The 402 itself is built by payments.routeAccepts from
 * the same evmRails() and algoRail().
 */
function httpRails(env = process.env) {
  const { SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2 } = require('@x402/svm');
  const sol = String(env.X402_NETWORK || 'mainnet').toLowerCase() === 'devnet' ? SOLANA_DEVNET_CAIP2 : SOLANA_MAINNET_CAIP2;
  const algo = algoRail(env);
  // R10 Phase A: the new networks that are in every 402 (lib/ext-rails.js inDefault) come after Algorand, as in the 402.
  const ext = require('./ext-rails').extRails(env).filter((r) => r.inDefault);
  return [{ name: 'Solana', network: sol, symbol: 'USDC' }, ...evmRails(env).map((r) => ({ name: r.name, network: r.network, symbol: 'USDC' })), ...(algo ? [{ name: algo.name, network: algo.network, symbol: 'USDC' }] : []),
    ...ext.map((r) => ({ name: r.name, network: r.network, symbol: r.token.symbol }))];
}

/**
 * R10 Phase A: the networks a route's 402 carries only when asked (GET /api/<route>|<network>), with their token and, for
 * PayAI's, the minimum route price. A payment on one is accepted on the plain URL too.
 */
function onRequestRails(env = process.env) {
  return [...require('./ext-rails').extRails(env).filter((r) => !r.inDefault), ...require('./nonevm-rails').nonEvmRails(env)]
    .map((r) => ({ name: r.name, network: r.network, symbol: r.token.symbol, minUsd: r.minUsd || 0 }));
}

/** "Celo (USDC), …, BNB Chain (AUSD) … Sei and X Layer on routes from $0.005": one sentence, empty when there are none. */
function onRequestSentence(env = process.env) {
  const rows = onRequestRails(env);
  if (!rows.length) return '';
  const all = rows.filter((r) => !r.minUsd).map((r) => `${r.name} (${r.network}, ${r.symbol})`);
  const min = rows.filter((r) => r.minUsd);
  const tail = min.length ? `; on routes priced $${min[0].minUsd} or more also ${min.map((r) => `${r.name} (${r.network}, ${r.symbol})`).join(', ')}` : '';
  return `On request, a route's 402 also offers one of: ${all.join(', ')}${tail}. Ask with GET /api/<route>|<network> (the | may be sent as %7C); a payment on any of them is accepted on the plain URL as well.`;
}

/** The HTTP routes' rails: the x402 list plus Algorand (MCP payment requests do not offer Algorand). */
function httpRailNames(solanaLabel = 'Solana', env = process.env) {
  const names = httpRails(env).map((r, i) => (i === 0 ? solanaLabel : r.name));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0];
}

module.exports = { ALL_EVM_RAILS, evmRails, railNames, httpRails, httpRailNames, onRequestRails, onRequestSentence, railPrice, railPayTo, arcRail, algoRail, ALGORAND_MAINNET };
