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
'use strict';

const ALL_EVM_RAILS = [
  { network: 'eip155:8453', name: 'Base', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  { network: 'eip155:137', name: 'Polygon', usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  { network: 'eip155:42161', name: 'Arbitrum', usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
];

function evmRails(env = process.env) {
  if (!env.PAY_TO_EVM) return [];
  const only = String(env.X402_EVM_NETWORKS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!only.length) return ALL_EVM_RAILS;
  const unknown = only.filter((n) => !ALL_EVM_RAILS.some((r) => r.network === n));
  if (unknown.length) throw new Error(`X402_EVM_NETWORKS names unknown rails: ${unknown.join(', ')}`);
  return ALL_EVM_RAILS.filter((r) => only.includes(r.network));
}

/** "Solana, Base, Polygon or Arbitrum" */
function railNames(solanaLabel = 'Solana', env = process.env) {
  const names = [solanaLabel, ...evmRails(env).map((r) => r.name)];
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0];
}

module.exports = { ALL_EVM_RAILS, evmRails, railNames };
