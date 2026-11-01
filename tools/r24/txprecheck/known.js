// tools/r24/txprecheck/known.js: the tables behind every `known` flag of GET /api/tx-precheck (R24 item 4, 1 Nov 2026).
// Each id below was (1) found in the OFFICIAL source named beside it (read 1 Nov 2026) and (2) read on chain the same day: a Solana program is an executable account, an EVM contract has code
// (and the V2 router's factory() and WETH() return the V2 factory and WETH listed here). A program or contract that is NOT in a table is "not known to this service": that is a statement about
// the table, not a verdict on the program. The tables are small on purpose; docs/SOURCES.md carries the same rows with the page and the date.
'use strict';

const SRC = {
  sdkIds: 'https://github.com/anza-xyz/solana-sdk/blob/master/sdk-ids/src/lib.rs',
  token: 'https://github.com/solana-program/token',
  token2022: 'https://github.com/solana-program/token-2022',
  ata: 'https://github.com/solana-program/associated-token-account',
  memo: 'https://github.com/solana-program/memo/blob/main/interface/src/lib.rs',
  jupiter: 'https://github.com/jup-ag/jupiter-cpi/blob/main/src/lib.rs',
  raydium: 'https://github.com/raydium-io/raydium-sdk-V2/blob/master/src/common/programId.ts',
  orca: 'https://github.com/orca-so/whirlpools',
  meteoraDlmm: 'https://github.com/MeteoraAg/dlmm-sdk/blob/main/ts-client/src/dlmm/constants/index.ts',
  meteoraDamm: 'https://github.com/MeteoraAg/damm-v2',
  pump: 'https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json',
  pumpamm: 'https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json',
  metaplex: 'https://github.com/metaplex-foundation/mpl-token-metadata',
  nativeMint: 'https://github.com/solana-program/token/blob/main/interface/src/native_mint.rs',
  circle: 'https://developers.circle.com/stablecoins/usdc-contract-addresses',
  tether: 'https://tether.to/en/supported-protocols/',
  uniBase: 'https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments',
  uniV2: 'https://docs.uniswap.org/contracts/v2/reference/smart-contracts/v2-deployments',
  uniUr: 'https://github.com/Uniswap/universal-router/blob/main/deploy-addresses/base.json',
  aero: 'https://github.com/aerodrome-finance/contracts/blob/main/README.md',
  mc3: 'https://github.com/mds1/multicall',
};

/** Solana programs: id -> { name, source } */
const SOLANA_PROGRAMS = {
  '11111111111111111111111111111111': { name: 'system', source: SRC.sdkIds },
  ComputeBudget111111111111111111111111111111: { name: 'compute-budget', source: SRC.sdkIds },
  AddressLookupTab1e1111111111111111111111111: { name: 'address-lookup-table', source: SRC.sdkIds },
  BPFLoaderUpgradeab1e11111111111111111111111: { name: 'bpf-loader-upgradeable', source: SRC.sdkIds },
  Stake11111111111111111111111111111111111111: { name: 'stake', source: SRC.sdkIds },
  Vote111111111111111111111111111111111111111: { name: 'vote', source: SRC.sdkIds },
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: { name: 'spl-token', source: SRC.token },
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: { name: 'spl-token-2022', source: SRC.token2022 },
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: { name: 'associated-token-account', source: SRC.ata },
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: { name: 'memo', source: SRC.memo },
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: { name: 'memo-v1', source: SRC.memo },
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: { name: 'jupiter-v6', source: SRC.jupiter },
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': { name: 'raydium-amm-v4', source: SRC.raydium },
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: { name: 'raydium-cpmm', source: SRC.raydium },
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: { name: 'raydium-clmm', source: SRC.raydium },
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: { name: 'orca-whirlpool', source: SRC.orca },
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: { name: 'meteora-dlmm', source: SRC.meteoraDlmm },
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: { name: 'meteora-damm-v2', source: SRC.meteoraDamm },
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': { name: 'pump-fun', source: SRC.pump },
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: { name: 'pumpswap', source: SRC.pumpamm },
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: { name: 'metaplex-token-metadata', source: SRC.metaplex },
};

/** Solana mints whose token-risk read is skipped (issuer-controlled or native by design): id -> { symbol, name, decimals, source } */
const SOLANA_MINTS = {
  So11111111111111111111111111111111111111112: { symbol: 'SOL', name: 'Wrapped SOL', decimals: 9, source: SRC.nativeMint },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', name: 'USD Coin', decimals: 6, source: SRC.circle },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', name: 'Tether USD', decimals: 6, source: SRC.tether },
};

/** Base contracts, keyed by LOWER-case address: { name, kind, source }. kind 'token' means the token-risk read is skipped. */
const BASE_CONTRACTS = {
  '0x4200000000000000000000000000000000000006': { name: 'WETH9', kind: 'token', symbol: 'WETH', decimals: 18, source: SRC.uniBase },
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { name: 'USDC (Circle, native on Base)', kind: 'token', symbol: 'USDC', decimals: 6, source: SRC.circle },
  '0x33128a8fc17869897dce68ed026d694621f6fdfd': { name: 'Uniswap V3 factory', kind: 'factory', source: SRC.uniBase },
  '0x2626664c2603336e57b271c5c0b26f421741e481': { name: 'Uniswap SwapRouter02', kind: 'router', source: SRC.uniBase },
  '0x6ff5693b99212da76ad316178a184ab56d299b43': { name: 'Uniswap Universal Router', kind: 'router', source: SRC.uniUr },
  '0x000000000022d473030f116ddee9f6b43ac78ba3': { name: 'Uniswap Permit2', kind: 'router', source: SRC.uniBase },
  '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24': { name: 'Uniswap V2 Router02', kind: 'router', source: SRC.uniV2 },
  '0x8909dc15e40173ff4699343b6eb8132c65e18ec6': { name: 'Uniswap V2 factory', kind: 'factory', source: SRC.uniV2 },
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': { name: 'Aerodrome Router', kind: 'router', source: SRC.aero },
  '0x420dd381b31aef6683db6b902084cb0ffece40da': { name: 'Aerodrome PoolFactory', kind: 'factory', source: SRC.aero },
  '0xca11bde05977b3631167028862be2a173976ca11': { name: 'Multicall3', kind: 'utility', source: SRC.mc3 },
};

const own = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : null);
const solProgram = (id) => own(SOLANA_PROGRAMS, id);
const solMint = (id) => own(SOLANA_MINTS, id);
const baseContract = (addr) => own(BASE_CONTRACTS, String(addr || '').toLowerCase());

module.exports = { SRC, SOLANA_PROGRAMS, SOLANA_MINTS, BASE_CONTRACTS, solProgram, solMint, baseContract };
