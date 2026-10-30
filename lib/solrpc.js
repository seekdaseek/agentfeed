// lib/solrpc.js — Solana reads with standard JSON-RPC methods only (R5 C4).
//
// The token and wallet routes used Helius-only APIs (DAS getAsset, the enhanced transactions
// API, getPriorityFeeEstimate). Helius's terms allow integrating its services but not providing
// them to third parties (docs/SOURCES.md), so these routes now ask only for chain state, with
// methods every Solana RPC serves: getAccountInfo, getTokenSupply, getTokenLargestAccounts,
// getSignaturesForAddress, getTransaction, getRecentPrioritizationFees. The primary RPC is still Helius
// (SOLANA_RPC_URL overrides it), as a transport for chain state, not for Helius's own data.
//
// R20 (24 Oct 2026): the free Helius plan ran out of credits (23 Oct to 9 Nov), and every Solana read in AgentFeed went dark with it. ALL Solana RPC
// calls in this repo now go through the endpoint list built here (lib/rpc-failover.cjs): the primary first; on HTTP 429, 402, 403, 5xx, a dropped
// connection or a timeout the same call goes to RPC_FALLBACKS (default: the free public mainnet RPC) and the primary is left alone for 10 minutes.
// Calls are counted per method and per host and logged as one `rpc_usage` line every 10 minutes (startUsageLog). When no endpoint answers, the call
// throws a 503 (kind: transport), so a paid route answers an error status and x402 does not settle.
//
// Program ids below were read on-chain on 12 Oct 2026 (executable, owned by a BPF loader).
'use strict';

const FO = require('./rpc-failover.cjs');
const RH = require('./rpc-heavy');
const RT = require('./rpc-throttle');   // R20j: a per-host compute-unit budget (Alchemy 240 CU/s by default) so no burst can 429 the keyed provider and rest it   // R20h: getTokenLargestAccounts never goes to the public RPC (it refuses it with a per-method 429), and is cached 90 s per mint
/** The primary endpoint: SOLANA_RPC_URL, else HELIUS_RPC, else the Helius URL of HELIUS_API_KEY; '' when none is configured (the first fallback then leads). */
const RPC_URL = () => process.env.SOLANA_RPC_URL || process.env.HELIUS_RPC || (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : '');
let defaultEndpoints = null;
let throttle = null;
/** The process-wide compute-unit throttle (lib/rpc-throttle.js): one per process, shared by every endpoint list, so the budget of a host is spent once. */
function getThrottle() {
  if (!throttle) {
    const fallbacks = FO.parseFallbacks(process.env.RPC_FALLBACKS);
    throttle = RT.wrapFetch((...a) => globalThis.fetch(...a), RT.parseLimits(process.env, [RPC_URL(), ...fallbacks].filter(Boolean)), { maxWaitMs: Number(process.env.RPC_THROTTLE_MAX_WAIT_MS) || undefined });
  }
  return throttle;
}
/** The process-wide endpoint list (built on first use from the environment): every Solana call of this process is counted and fails over here. */
function endpoints() {
  if (!defaultEndpoints) defaultEndpoints = FO.create({ name: process.env.SOLRPC_NAME || 'agentfeed', primary: RPC_URL(), fallbacks: FO.parseFallbacks(process.env.RPC_FALLBACKS), log: (l) => console.log(l), fetch: getThrottle().fetch });
  return defaultEndpoints;
}
const heavyLists = new Map();   // method -> list or null
const heavyCache = new RH.SingleFlightCache();
/**
 * The endpoint list for a HEAVY method (lib/rpc-heavy.js METHOD_RULES): the process-wide list minus the hosts that refuse that method, or null when nothing is left. Built on
 * first use per method. It SHARES the process-wide list's rest state and usage counters (RH.shareState): a primary that is out of credits rests once for all lists, and one
 * `rpc_usage` line counts every call. A caller-visible 503 is produced when it is null.
 */
function heavyEndpoints(method = 'getTokenLargestAccounts') {
  if (!heavyLists.has(method)) {
    const main = endpoints();
    const urls = RH.heavyUrls(main.urls, process.env, method);
    heavyLists.set(method, urls.length ? RH.shareState(FO.create({ name: main.name, primary: urls[0], fallbacks: urls.slice(1), log: (l) => console.log(l), fetch: getThrottle().fetch }), main) : null);
  }
  return heavyLists.get(method);
}
/** Another list (the jito cron leads with the public RPC and keeps Helius as the fallback). */
function makeEndpoints(opts) { return FO.create({ log: (l) => console.log(l), ...opts }); }
/** For tests: forget the process-wide lists and the heavy-method cache so the next call rebuilds them from the environment. */
function _reset() { defaultEndpoints = null; throttle = null; heavyLists.clear(); heavyCache.clear(); heavyCache.hits = heavyCache.shared = heavyCache.misses = 0; }
/** One `rpc_usage` line every 10 minutes for this process (a long-lived server). Short-lived crons call endpoints().logUsage() before they exit. */
function startUsageLog(everyMs) { return endpoints().startUsageLog(undefined, everyMs); }
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PROGRAMS = {
  TOKEN: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN_2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  METAPLEX: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
};
// labels for the programs a transaction invokes; only ids verified on-chain are listed
const PROGRAM_NAMES = {
  '11111111111111111111111111111111': 'system',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'spl-token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'spl-token-2022',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'associated-token-account',
  ComputeBudget111111111111111111111111111111: 'compute-budget',
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: 'metaplex-token-metadata',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'orca-whirlpool',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'raydium-clmm',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'raydium-cpmm',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'raydium-amm-v4',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'meteora-dlmm',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pump-fun',
};

const badRequest = (msg) => Object.assign(new Error(msg), { kind: 'bad_request', badRequest: true });
const unavailable = (msg) => Object.assign(new Error(msg), { status: 503 });

async function rpc(method, params, { timeoutMs = 10_000, endpoints: eps } = {}) {
  if (!eps && RH.HEAVY_METHODS.has(method)) {
    // R20h: never a host that refuses the method (it would only be put to rest by the refusal); an honest 503 when no endpoint can serve it. The ranking is also kept 90 s and
    // shared by concurrent callers: one upstream call per (method, params).
    const rule = RH.METHOD_RULES[method];
    const run = () => {
      const h = heavyEndpoints(method);
      if (!h) throw Object.assign(unavailable(`${rule.what} is unavailable right now: no Solana RPC provider is configured that serves ${method}. Not charged.`), { transport: true, retryAfter: 300 });
      return rpcOn(h, method, params, timeoutMs);
    };
    return rule.cache ? heavyCache.run(`${method}:${JSON.stringify(params)}`, run) : run();
  }
  return rpcOn(eps || endpoints(), method, params, timeoutMs);
}

async function rpcOn(list, method, params, timeoutMs) {
  let j;
  try {
    j = await list.post(JSON.stringify({ jsonrpc: '2.0', id: 'agentfeed', method, params }), { timeoutMs, method });
  } catch (e) {
    // no endpoint answered (all rate limited, out of credits, down or timed out), or a Helius-only method with Helius out: a 503, never a guess
    // the caller-facing text names no provider: `publicMessage` is the status only ("solana rpc http 429"); the hosts stay in the log lines
    if (e && e.transport) throw Object.assign(unavailable(`${e.publicMessage || 'solana rpc unavailable'}. Not charged.`), { transport: true });
    throw unavailable(`solana rpc unreachable (${(e && e.message) || 'error'})`);
  }
  if (j && j.error) {
    const e = new Error(`solana rpc: ${j.error.message}`);
    e.rpcError = j.error;
    // a mint too large to rank is the caller asking what the node cannot answer (see solana2.js)
    if (j.error.code === -32600 && /too many accounts/i.test(j.error.message || '')) e.badRequest = true;
    else if (/invalid param|WrongSize|Invalid/i.test(j.error.message || '')) { e.kind = 'bad_request'; e.badRequest = true; }
    else e.status = 503;
    throw e;
  }
  return j ? j.result : undefined;
}

function checkAddress(v, what) {
  if (v == null || v === '') throw badRequest(`missing required parameter: ${what}`);
  if (!BASE58_RE.test(v)) throw badRequest(`invalid ${what} address`);
}

// Borsh string: u32 length then bytes; Metaplex pads name/symbol/uri with NULs
function readString(buf, o) { const n = buf.readUInt32LE(o); return [buf.subarray(o + 4, o + 4 + n).toString('utf8').replace(/\0+$/, '').trim(), o + 4 + n]; }

const metaplexPda = async (mint) => {
  const K = require('@solana/kit');
  const enc = K.getAddressEncoder();
  return (await K.getProgramDerivedAddress({ programAddress: PROGRAMS.METAPLEX, seeds: ['metadata', enc.encode(PROGRAMS.METAPLEX), enc.encode(mint)] }))[0];
};

/** Metaplex token metadata for a mint, or null when there is none */
async function metaplex(mint) {
  const pda = await metaplexPda(mint);
  const a = await rpc('getAccountInfo', [pda, { encoding: 'base64' }]);
  if (!a || !a.value || a.value.owner !== PROGRAMS.METAPLEX) return null;
  return decodeMetaplex(Buffer.from(a.value.data[0], 'base64'));
}

/** the fields of a Metaplex metadata account (raw bytes) */
function decodeMetaplex(b) {
  // key u8, update_authority 32, mint 32, then name, symbol, uri, seller_fee_basis_points u16,
  // creators Option<Vec<{address 32, verified u8, share u8}>>, primary_sale_happened u8, is_mutable u8
  let o = 1 + 32 + 32;
  const updateAuthority = require('../tools/dexspot')._b58(b.subarray(1, 33));
  let name, symbol, uri;
  [name, o] = readString(b, o); [symbol, o] = readString(b, o); [uri, o] = readString(b, o);
  o += 2;
  if (b[o] === 1) { const n = b.readUInt32LE(o + 1); o += 1 + 4 + n * 34; } else o += 1;
  const mutable = b[o + 1] === 1;
  return { name: name || null, symbol: symbol || null, uri: uri || null, mutable, update_authority: updateAuthority, source: 'metaplex token metadata account' };
}

/** the mint account itself (jsonParsed), plus metadata from Token-2022's extension or Metaplex */
async function mintInfo(mint) {
  checkAddress(mint, 'mint');
  const a = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  const v = a && a.value;
  if (!v) throw badRequest(`no account at ${mint}`);
  if (![PROGRAMS.TOKEN, PROGRAMS.TOKEN_2022].includes(v.owner) || !v.data || !v.data.parsed || v.data.parsed.type !== 'mint') throw badRequest(`${mint} is not an SPL token mint`);
  const info = v.data.parsed.info;
  const ext = (info.extensions || []).find((x) => x.extension === 'tokenMetadata');
  let meta = ext && ext.state ? { name: ext.state.name || null, symbol: ext.state.symbol || null, uri: ext.state.uri || null, mutable: !!ext.state.updateAuthority, update_authority: ext.state.updateAuthority || null, source: 'token-2022 metadata extension' } : null;
  if (!meta) { try { meta = await metaplex(mint); } catch { meta = null; } }
  return {
    program: v.owner === PROGRAMS.TOKEN_2022 ? 'spl-token-2022' : 'spl-token',
    decimals: info.decimals, supply_raw: info.supply, supply: Number(info.supply) / 10 ** info.decimals,
    mint_authority: info.mintAuthority || null, freeze_authority: info.freezeAuthority || null,
    extensions: (info.extensions || []).map((x) => x.extension),
    metadata: meta,
  };
}

/**
 * Metadata for many mints in two batched reads per 100 (the mint accounts, for Token-2022's metadata extension, and
 * their Metaplex metadata accounts): Map mint -> { name, symbol, uri } or null. Standard getMultipleAccounts only.
 */
async function metadataMap(mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 100) {
    const part = mints.slice(i, i + 100);
    const pdas = await Promise.all(part.map(metaplexPda));
    const [mintAccs, metaAccs] = await Promise.all([
      rpc('getMultipleAccounts', [part, { encoding: 'jsonParsed' }]),
      rpc('getMultipleAccounts', [pdas, { encoding: 'base64' }]),
    ]);
    part.forEach((m, j) => {
      const mv = mintAccs.value[j], av = metaAccs.value[j];
      const info = mv && mv.data && mv.data.parsed && mv.data.parsed.info;
      const ext = info && (info.extensions || []).find((x) => x.extension === 'tokenMetadata');
      let meta = ext && ext.state ? { name: ext.state.name || null, symbol: ext.state.symbol || null, uri: ext.state.uri || null } : null;
      if (!meta && av && av.owner === PROGRAMS.METAPLEX) {
        try { const d = decodeMetaplex(Buffer.from(av.data[0], 'base64')); meta = { name: d.name, symbol: d.symbol, uri: d.uri }; } catch { meta = null; }
      }
      out.set(m, meta);
    });
  }
  return out;
}

/** one transaction from getTransaction (jsonParsed, versions up to 1), seen from `wallet` */
function summarizeTx(t, wallet) {
  const m = t.transaction.message; const meta = t.meta || {};
  const keys = m.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const i = keys.indexOf(wallet);
  const solChange = i >= 0 && meta.preBalances && meta.postBalances ? (meta.postBalances[i] - meta.preBalances[i]) / 1e9 : null;
  const tok = new Map();
  for (const [sign, list] of [[-1, meta.preTokenBalances || []], [1, meta.postTokenBalances || []]]) {
    for (const b of list) {
      if (b.owner !== wallet) continue;
      const amt = Number(b.uiTokenAmount && (b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount) || 0);
      tok.set(b.mint, (tok.get(b.mint) || 0) + sign * amt);
    }
  }
  const programs = [...new Set(m.instructions.map((x) => x.programId || keys[x.programIdIndex]).filter(Boolean))];
  return {
    signature: t.transaction.signatures[0], ts: t.blockTime ?? null, slot: t.slot,
    fee_sol: meta.fee != null ? meta.fee / 1e9 : null, failed: !!meta.err, fee_payer: keys[0] === wallet,
    sol_change: solChange != null ? Number(solChange.toFixed(9)) : null,
    token_changes: [...tok].filter(([, d]) => Math.abs(d) > 0).map(([mint, d]) => ({ mint, change: Number(d.toPrecision(12)) })),
    programs: programs.map((p) => PROGRAM_NAMES[p] || p),
  };
}

module.exports = { rpc, endpoints, heavyEndpoints, heavyCache, getThrottle, makeEndpoints, startUsageLog, _reset, RPC_URL, mintInfo, metaplex, metadataMap, decodeMetaplex, summarizeTx, checkAddress, PROGRAMS, PROGRAM_NAMES, BASE58_RE, badRequest, unavailable };
