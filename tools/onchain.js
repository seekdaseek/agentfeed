// tools/onchain.js — Helius DAS: wallet holdings + token metadata.
// Premium tools ($0.005-0.008 in Session 2). Key from .env only.
const HELIUS_URL = () =>
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// caller-input failures carry kind:'bad_request' so server.js logs them apart
// from real service failures; an unmarked throw stays status 'error'
const badRequest = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });

async function rpc(method, params) {
  const res = await fetch(HELIUS_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'agentfeed', method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`helius ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`helius rpc: ${j.error.message}`);
  return j.result;
}

// getAssetsByOwner — fungibles + NFTs summary for a wallet
async function getWalletHoldings(wallet) {
  if (wallet == null || wallet === '') {
    throw badRequest('missing required parameter: wallet — a Solana address (base58), e.g. wallet=4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7');
  }
  if (!BASE58_RE.test(wallet)) throw badRequest('invalid wallet address');

  const result = await rpc('getAssetsByOwner', {
    ownerAddress: wallet,
    page: 1,
    limit: 100,
    displayOptions: { showFungible: true, showNativeBalance: true },
  });

  const items = result?.items || [];
  const fungibles = [];
  let nft_count = 0;

  for (const a of items) {
    if (a.interface === 'FungibleToken' || a.interface === 'FungibleAsset') {
      const info = a.token_info || {};
      fungibles.push({
        mint: a.id,
        symbol: info.symbol || a.content?.metadata?.symbol || null,
        amount: info.balance != null && info.decimals != null
          ? info.balance / Math.pow(10, info.decimals)
          : null,
        price_usd: info.price_info?.price_per_token ?? null,
        value_usd: info.price_info?.total_price ?? null,
      });
    } else {
      nft_count++;
    }
  }

  return {
    wallet,
    native_sol: result?.nativeBalance?.lamports != null
      ? result.nativeBalance.lamports / 1e9
      : null,
    native_sol_usd: result?.nativeBalance?.total_price ?? null,
    fungible_tokens: fungibles,
    nft_count,
    total_items: result?.total ?? items.length,
    source: 'helius-das',
  };
}

// getAsset — metadata for one mint
async function getTokenMetadata(mint) {
  if (mint == null || mint === '') {
    throw badRequest('missing required parameter: mint — an SPL mint address (base58), e.g. mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (USDC)');
  }
  if (!BASE58_RE.test(mint)) throw badRequest('invalid mint address');

  const a = await rpc('getAsset', { id: mint });
  const meta = a?.content?.metadata || {};
  const info = a?.token_info || {};

  return {
    mint,
    name: meta.name || null,
    symbol: meta.symbol || info.symbol || null,
    interface: a?.interface || null,
    decimals: info.decimals ?? null,
    supply: info.supply ?? null,
    price_usd: info.price_info?.price_per_token ?? null,
    mutable: a?.mutable ?? null,
    source: 'helius-das',
  };
}

module.exports = { getWalletHoldings, getTokenMetadata };
