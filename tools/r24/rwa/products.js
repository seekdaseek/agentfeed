// tools/r24/rwa/products.js: the product register of get_rwa_yields (R24, item 3). One row per product whose issuer documentation names the on-chain price.
//
// A row says WHERE the price lives (chain, contract, function, decimals) and HOW the issuer's own documentation names it. The yield is never read from anywhere: it is
// computed from the price at two moments (yield.js). Nothing here is an issuer's published yield figure.
//
//   read.kind 'uint'   one eth_call returns the price as a single unsigned integer (Ondo USDY, Ondo OUSG, Maple syrupUSDC)
//   read.kind 'round'  a Chainlink-compatible feed: latestRoundData() -> (roundId, answer, startedAt, updatedAt, answeredInRound); the answer is the price,
//                      updatedAt is the issuer's own timestamp for it (Superstate USTB, Circle USYC, OpenEden TBILL, Midas mTBILL)
//   convention         'simple'  (P_t / P_t-N - 1) x 365 / N                 (the gate default: no issuer names another formula for a yield, so this is used)
//                      'apy'     (P_t / P_t-N) ^ (365 / N) - 1               (Ondo documents the USDY rate as a yearly APY that the price compounds at)
//   band               [low, high] in USD per token: a read outside it is a garbage read (a zero, a wrong decimals value), never sold. low = 0.98 x the price the
//                      product started at (accumulating products do not fall below it), high = 1.6 x that price.
//   staleSec           an oracle whose own updatedAt is older than this is not served (null: the oracle carries no timestamp)
//   served             set from the R24 gate result (GATES-r24.md section 3, GATES-r24-3-cases.md, GATES-r24-3-result.md): false = dropped from the route, kept here as the record.
//                      tbill and mtbill: false, because their issuer pages could not be read on the scoring day (an eligibility modal the agent did not accept), so no issuer figure was compared.
//   docs               the issuer pages (or the issuer's own published contract source) that name the address and the function: the evidence behind the row
'use strict';

const WEEK = 7 * 86400;

const PRODUCTS = [
  { id: 'usdy', name: 'Ondo USDY', issuer: 'Ondo Finance', assetClass: 'tokenized short-term US Treasuries and bank deposits, accumulating',
    chain: 'ethereum', chainId: 1, contract: '0x87b126e5518b6a1Bb8465779b4607C45C643DF90', contractName: 'USDYOracleWrapper', fn: 'getPrice()',
    read: { kind: 'uint', data: '0x98d5fdca', decimals: 18 }, convention: 'apy', startPrice: 1, band: [0.98, 1.6], staleSec: null, served: true,
    docs: ['https://docs.ondo.finance/addresses', 'https://docs.ondo.finance/general-access-products/usdy/usdy-price-oracle', 'https://github.com/ondoprotocol/rwa-contracts'] },
  { id: 'ousg', name: 'Ondo OUSG', issuer: 'Ondo Finance', assetClass: 'tokenized short-term US Treasuries and government agency securities',
    chain: 'ethereum', chainId: 1, contract: '0x9Cad45a8BF0Ed41Ff33074449B357C7a1fAb4094', contractName: 'OndoOracle', fn: 'getAssetPrice(address) for the OUSG token 0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92',
    read: { kind: 'uint', data: '0xb3596f070000000000000000000000001b19c19393e2d034d8ff31ff34c81252fcbbee92', decimals: 18 }, convention: 'simple', startPrice: 100, band: [98, 160], staleSec: null, served: true,
    docs: ['https://docs.ondo.finance/addresses', 'https://docs.ondo.finance/qualified-access-products/ousg/overview', 'https://github.com/ondoprotocol/rwa-contracts'] },
  { id: 'ustb', name: 'Superstate USTB', issuer: 'Superstate', assetClass: 'tokenized short-duration US government securities fund',
    chain: 'ethereum', chainId: 1, contract: '0xE4fA682f94610cCd170680cc3B045d77D9E528a8', contractName: 'Superstate USTB Continuous Price Oracle', fn: 'latestRoundData()',
    read: { kind: 'round', decimals: 6 }, convention: 'simple', startPrice: 10, band: [9.8, 16], staleSec: 6 * 86400, served: true,
    docs: ['https://docs.superstate.com/investors/smart-contracts', 'https://docs.superstate.com/investors/tokenized-funds/nav-income-and-yield'] },
  { id: 'usyc', name: 'Circle USYC', issuer: 'Circle', assetClass: 'tokenized money market fund backed by reverse repurchase agreements',
    chain: 'ethereum', chainId: 1, contract: '0x74f2199AEb743f68f05943e5715A33EaF2b61f53', contractName: 'USYC Oracle', fn: 'latestRoundData()',
    read: { kind: 'round', decimals: 18 }, convention: 'simple', startPrice: 1, band: [0.98, 1.6], staleSec: 6 * 86400, served: true,
    docs: ['https://developers.circle.com/tokenized/usyc/smart-contracts', 'https://developers.circle.com/tokenized/usyc/overview', 'https://developers.circle.com/tokenized/usyc/web2-apis'] },
  { id: 'tbill', name: 'OpenEden TBILL', issuer: 'OpenEden', assetClass: 'tokenized US Treasury bills',
    chain: 'ethereum', chainId: 1, contract: '0xCe9a6626Eb99eaeA829D7fA613d5D0A2eaE45F40', contractName: 'TBILL Price Oracle', fn: 'latestRoundData()',
    read: { kind: 'round', decimals: 8 }, convention: 'simple', startPrice: 1, band: [0.98, 1.6], staleSec: 6 * 86400, served: false,
    docs: ['https://docs.openeden.com/tbill/smart-contract-addresses', 'https://docs.openeden.com/tbill/token-price', 'https://github.com/OpenEdenHQ/openeden.vault.audit'] },
  { id: 'mtbill', name: 'Midas mTBILL', issuer: 'Midas', assetClass: 'tokenized US Treasury bills',
    chain: 'ethereum', chainId: 1, contract: '0x056339C044055819E8Db84E71f5f2E1F536b2E5b', contractName: 'mTBILL CustomAggregatorV3CompatibleFeed', fn: 'latestRoundData()',
    read: { kind: 'round', decimals: 8 }, convention: 'simple', startPrice: 1, band: [0.98, 1.6], staleSec: 6 * 86400, served: false,
    docs: ['https://github.com/midas-apps/contracts', 'https://raw.githubusercontent.com/midas-apps/contracts/main/config/constants/addresses.ts'] },
  { id: 'syrupusdc', name: 'Maple syrupUSDC', issuer: 'Maple', assetClass: 'onchain institutional credit: overcollateralised loans to crypto institutions',
    chain: 'ethereum', chainId: 1, contract: '0x80ac24aA929eaF5013f6436cdA2a7ba190f5Cc0b', contractName: 'syrupUSDC (ERC-4626 vault)', fn: 'convertToAssets(1000000), one share, 6 decimals',
    read: { kind: 'uint', data: '0x07a2d13a00000000000000000000000000000000000000000000000000000000000f4240', decimals: 6 }, convention: 'simple', startPrice: 1, band: [0.98, 1.6], staleSec: null, served: true,
    docs: ['https://docs.maple.finance/integrate/ethereum-mainnet/asset-integration.md'] },
];

const CONVENTION = {
  simple: 'simple annualization: (P_t / P_t-N - 1) x 365 / N',
  apy: 'issuer APY convention: (P_t / P_t-N) ^ (365 / N) - 1',
};

/** the products the route serves (a gate failure sets served: false in the register above) */
const served = () => PRODUCTS.filter((p) => p.served);
const byId = (id) => PRODUCTS.find((p) => p.id === id) || null;

module.exports = { PRODUCTS, CONVENTION, served, byId, WEEK };
