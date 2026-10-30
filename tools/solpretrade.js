// tools/solpretrade.js — the Solana pre-trade pack (R11 A6): /api/sol-token-check/:mint,
// /api/sol-token-flow/:mint and /api/sol-holder-clusters/:mint.
//
// Everything here is chain state read through lib/solrpc.js: standard JSON-RPC methods only
// (getAccountInfo, getMultipleAccounts, getProgramAccounts, getTokenLargestAccounts,
// getSignaturesForAddress, getTransaction). No vendor API, no DexScreener, no Jupiter, no DAS: a
// vendor's price or pool list is exactly what their terms forbid us to resell (docs/SOURCES.md).
// The RPC is a transport for chain state.
//
// POOL DISCOVERY is getProgramAccounts on each AMM program with a dataSize filter and a memcmp on
// the mint, once per side. Layouts were read from live accounts on 13 Oct 2026 and each decoder checks
// the mints it finds, so a changed layout fails instead of mispricing:
//   raydium-amm-v4 (752 B)  base 400, quote 432, vaults 336 / 368, swap fee 176 / 184, status 0 (6 = swap)
//   raydium-cpmm   (637 B)  mint0 168, mint1 200, vaults 72 / 104, status 329 (0 = all enabled)
//   raydium-clmm  (1544 B)  mint0 73, mint1 105, vaults 137 / 169, decimals 233 / 234, liquidity u128 237, sqrt x64 253
//   orca-whirlpool (653 B)  mintA 101, mintB 181, vaults 133 / 213, liquidity u128 49, sqrt x64 65
//   meteora-dlmm   (904 B)  x 88, y 120, reserves 152 / 184 (listed with its depth, not quoted)
//   pumpswap       (301 B)  base 43, quote 75, vaults 139 / 171 (older, shorter pool layouts are not searched:
//                           Helius refuses a scan on those sizes, so pools made before the current layout can be missed)
// Pump.fun bonding curve: PDA ["bonding-curve", mint] under 6EF8rr..., virtual token reserves u64 8,
// virtual sol 16, real token 24, real sol 32, supply 40, complete 48.
//
// PRICE IMPACT is what the trade pays against the pool's mid, the swap fee excluded, in the single
// deepest pool (not a routed quote). Constant-product pools use their vault balances; a
// concentrated-liquidity pool uses its in-range virtual reserves (x = L / sqrtP, y = L * sqrtP), which is
// exact while the trade stays inside the active tick range and understates impact if it would cross it.
// The answer names the method.
'use strict';
const crypto = require('crypto');
const sr = require('../lib/solrpc');
const { _b58: b58 } = require('./dexspot');

const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const unavailable = (msg, extra) => Object.assign(new Error(msg), { status: 503 }, extra || {});

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const QUOTES = { [WSOL]: { sym: 'SOL', dec: 9 }, [USDC]: { sym: 'USDC', dec: 6 }, [USDT]: { sym: 'USDT', dec: 6 } };
// quote assets themselves: thousands of pools each, and a pre-trade check on them is not the question being asked
const QUOTE_ASSETS = new Set([WSOL, USDC, USDT, 'USDSwpHBfoCPSzTmnyxNQR5UCvCDW3rCsj9XFAZa5Ap', '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', 'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX']);
const PROGRAM = { PUMP: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', SYSTEM: '11111111111111111111111111111111' };
const BURN = new Set(['1nc1nerator11111111111111111111111111111111', '1111111111111111111111111111111111111111111', PROGRAM.SYSTEM]);

// ---------- small helpers ----------
const u64 = (b, o) => b.readBigUInt64LE(o);
const u128 = (b, o) => { let v = 0n; for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; };
const keyAt = (b, o) => b58(b.subarray(o, o + 32));
const num = (x) => Number(x);
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ed25519 point test: a PDA is, by construction, NOT on the curve; a wallet's address is
const P = 2n ** 255n - 19n; const D = (-121665n * modInv(121666n)) % P;
function modPow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }
function modInv(a) { return modPow(((a % P) + P) % P, P - 2n, P); }
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(str) {
  let n = 0n; for (const ch of str) { const i = B58.indexOf(ch); if (i < 0) return null; n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let z = 0; while (z < str.length && str[z] === '1') z++;
  return Buffer.concat([Buffer.alloc(z), body]);
}
// ed25519 decompression: y is the 255 low bits; x^2 = (y^2 - 1) / (d y^2 + 1) must have a square root mod p
function isOnCurve(addr) {
  const b = b58decode(addr);
  if (!b || b.length !== 32) return false;
  const bytes = Buffer.from(b); bytes[31] &= 0x7f;
  let y = 0n; for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P; const v = (D * y2 + 1n) % P;
  const x2 = (u * modInv(v)) % P;
  if (x2 === 0n) return true;
  return modPow(x2, (P - 1n) / 2n, P) === 1n; // Euler's criterion: x2 is a quadratic residue
}

// ---------- the RPC context: a call budget, so one request cannot run away with the shared key ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The shared key 429s bursts (a batch of 10 getTransaction calls was refused, single calls two at a time were not), so a
// 429 backs off and retries, and transaction reads go out two at a time.
// Pacer state is process-wide, not per request: two flow requests at once share one history-read rate, so these routes
// cannot between them starve the key the other Solana routes use. (planning chat, 13 Oct)
const pacer = { gap: 170, nextAt: 0 };
async function pace() { const at = Math.max(Date.now(), pacer.nextAt); pacer.nextAt = at + pacer.gap; if (at > Date.now()) await sleep(at - Date.now()); }
// at most this many history-heavy requests (flow, clusters) run at once; the rest are told to retry shortly, unbilled
const HEAVY_MAX = 2; let heavyNow = 0;
async function heavy(fn) {
  if (heavyNow >= HEAVY_MAX) throw unavailable('two trade-flow or holder-cluster requests are already running; retry in a few seconds. Not charged.', { retryAfter: 5 });
  heavyNow++;
  try { return await fn(); } finally { heavyNow--; }
}
function makeCtx(opts = {}) {
  const ctx = { calls: 0, budget: opts.budget || 60, deadline: opts.deadline || Infinity, raw: opts.rpc || sr.rpc, mocked: !!opts.rpc };
  const guard = (n = 1) => {
    if (ctx.calls + n > ctx.budget) throw unavailable(`the RPC call budget for this request (${ctx.budget}) is used up. Not charged.`);
    if (Date.now() > ctx.deadline) throw unavailable('the time budget for this request is used up. Not charged.');
    ctx.calls += n;
  };
  // Reads of history go out through one shared pacer: the key is shared with other services and answers a burst with 429,
  // so the gap between calls widens on a 429 and narrows again on a success. A paced call that still gets 429s retries.
  const PACED = new Set(['getTransaction', 'getSignaturesForAddress']);
  const floor = opts.gapMs ?? 170;
  ctx.rpc = async (method, params, o) => {
    for (let attempt = 0; ; attempt++) {
      // R20j: a request that has seen every endpoint fail (ctx.outage) ends in a 503 whatever else it reads (outageGuard), so it starts no NEW call: one failing request had made
      // about 390 upstream calls across three hosts. A call already running keeps its own retries.
      if (attempt === 0 && ctx.outage) throw ctx.outage;
      guard();
      if (PACED.has(method) && !ctx.mocked) await pace();
      // a call may not outlive the request's deadline: its own timeout is whatever time is left
      const left = ctx.deadline - Date.now();
      const callOpts = Number.isFinite(left) ? { ...(o || {}), timeoutMs: Math.max(1000, Math.min(10000, left)) } : o;
      try { const r = await ctx.raw(method, params, callOpts); if (PACED.has(method)) pacer.gap = Math.max(floor, pacer.gap * 0.97); return r; } catch (e) {
        if (e && e.transport && !ctx.outage) ctx.outage = e;   // no endpoint answered (R20): see outageGuard, no route answers around it
        if (/http 429/.test(e.message || '') && attempt < 4) { pacer.gap = Math.min(1200, pacer.gap * 1.6); await sleep(300 * (attempt + 1)); continue; }
        throw e;
      }
    }
  };
  return ctx;
}

// ---------- pool decoders ----------
const AMMS = [
  { id: 'raydium-amm-v4', program: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', size: 752, sides: [400, 432], slice: 496, kind: 'cp',
    decode: (d) => ({ mintA: keyAt(d, 400), mintB: keyAt(d, 432), vaultA: keyAt(d, 336), vaultB: keyAt(d, 368), live: u64(d, 0) === 6n, feeBps: num(u64(d, 176)) * 10000 / Math.max(1, num(u64(d, 184))) }) },
  { id: 'raydium-cpmm', program: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', size: 637, sides: [168, 200], slice: 340, kind: 'cp',
    decode: (d) => ({ mintA: keyAt(d, 168), mintB: keyAt(d, 200), vaultA: keyAt(d, 72), vaultB: keyAt(d, 104), live: d[329] === 0 }) },
  { id: 'raydium-clmm', program: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', size: 1544, sides: [73, 105], slice: 273, kind: 'cl',
    decode: (d) => ({ mintA: keyAt(d, 73), mintB: keyAt(d, 105), vaultA: keyAt(d, 137), vaultB: keyAt(d, 169), decA: d[233], decB: d[234], liquidity: u128(d, 237), sqrt: u128(d, 253), live: true }) },
  { id: 'orca-whirlpool', program: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', size: 653, sides: [101, 181], slice: 245, kind: 'cl',
    decode: (d) => ({ mintA: keyAt(d, 101), mintB: keyAt(d, 181), vaultA: keyAt(d, 133), vaultB: keyAt(d, 213), liquidity: u128(d, 49), sqrt: u128(d, 65), live: true }) },
  { id: 'meteora-dlmm', program: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', size: 904, sides: [88, 120], slice: 216, kind: 'bins',
    decode: (d) => ({ mintA: keyAt(d, 88), mintB: keyAt(d, 120), vaultA: keyAt(d, 152), vaultB: keyAt(d, 184), live: true }) },
  { id: 'pumpswap', program: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', size: 301, sides: [43, 75], sizeless: [75], slice: 203, kind: 'cp',
    decode: (d) => ({ mintA: keyAt(d, 43), mintB: keyAt(d, 75), vaultA: keyAt(d, 139), vaultB: keyAt(d, 171), live: true }) },
];

const mintCache = new Map();
function memo(map, key, ttl, fn, now = Date.now()) {
  const e = map.get(key);
  if (e && now - e.at < ttl) return e.p;
  const p = fn();
  map.set(key, { at: now, p });
  p.catch(() => { if (map.get(key) && map.get(key).p === p) map.delete(key); });
  if (map.size > 300) map.delete(map.keys().next().value);
  return p;
}

// ---------- on-chain reads ----------
async function readMint(ctx, mint) {
  const a = await ctx.rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  const v = a && a.value;
  if (!v) throw bad(`no account at ${mint}`);
  if (![sr.PROGRAMS.TOKEN, sr.PROGRAMS.TOKEN_2022].includes(v.owner) || !v.data || !v.data.parsed || v.data.parsed.type !== 'mint') throw bad(`${mint} is not an SPL token mint`);
  const info = v.data.parsed.info;
  const ext = {}; for (const x of info.extensions || []) ext[x.extension] = x.state || {};
  return { program: v.owner === sr.PROGRAMS.TOKEN_2022 ? 'spl-token-2022' : 'spl-token', decimals: info.decimals, supply_raw: BigInt(info.supply), supply: Number(info.supply) / 10 ** info.decimals,
    mint_authority: info.mintAuthority || null, freeze_authority: info.freezeAuthority || null, ext };
}
async function readMetadata(ctx, mint, mintExt) {
  const tm = mintExt.tokenMetadata;
  if (tm) return { name: tm.name || null, symbol: tm.symbol || null, mutable: !!tm.updateAuthority && tm.updateAuthority !== PROGRAM.SYSTEM, source: 'token-2022 metadata extension' };
  try {
    const K = require('@solana/kit'); const enc = K.getAddressEncoder();
    const [pda] = await K.getProgramDerivedAddress({ programAddress: sr.PROGRAMS.METAPLEX, seeds: ['metadata', enc.encode(sr.PROGRAMS.METAPLEX), enc.encode(mint)] });
    const a = await ctx.rpc('getAccountInfo', [pda, { encoding: 'base64' }]);
    if (!a.value || a.value.owner !== sr.PROGRAMS.METAPLEX) return null;
    const m = sr.decodeMetaplex(Buffer.from(a.value.data[0], 'base64'));
    return { name: m.name, symbol: m.symbol, mutable: m.mutable, source: 'metaplex token metadata account' };
  } catch (e) { if (e.status === 503) throw e; return null; }
}
async function accountsBatch(ctx, keys, encoding = 'base64') {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    const r = await ctx.rpc('getMultipleAccounts', [keys.slice(i, i + 100), { encoding }]);
    out.push(...r.value);
  }
  return out;
}
const tokAmount = (acc) => { if (!acc) return null; const d = Buffer.from(acc.data[0], 'base64'); return d.length >= 72 ? u64(d, 64) : null; };

// ---------- pools ----------
async function discoverPools(ctx, mint) {
  const found = []; let other = 0; const gaps = [];
  const jobs = AMMS.flatMap((amm) => amm.sides.map((off) => ({ amm, off })));
  await mapLimit(jobs, 3, async ({ amm, off }) => {
    // Helius sometimes refuses a narrow scan as "too many accounts"; the PumpSwap quote side only answers without a size filter
    const filters = [...((amm.sizeless || []).includes(off) ? [] : [{ dataSize: amm.size }]), { memcmp: { offset: off, bytes: mint } }];
    let accs = null;
    for (let attempt = 0; attempt < 2 && !accs; attempt++) {
      try { accs = await ctx.rpc('getProgramAccounts', [amm.program, { encoding: 'base64', dataSlice: { offset: 0, length: amm.slice }, filters }]); } catch (e) {
        if (e.status === 503 && /budget/.test(e.message)) throw e;
        if (attempt === 1) gaps.push(`${amm.id} (offset ${off}): ${String(e.message).slice(0, 70)}`);
      }
    }
    for (const a of accs || []) {
      let d; try { d = amm.decode(Buffer.from(a.account.data[0], 'base64')); } catch { continue; }
      const side = d.mintA === mint ? 'A' : d.mintB === mint ? 'B' : null;
      if (!side) continue; // the decoder read other mints than the filter asked for: a changed layout fails closed
      const quote = side === 'A' ? d.mintB : d.mintA;
      if (!QUOTES[quote]) { other++; continue; }
      if (!d.live) continue;
      found.push({ venue: amm.id, kind: amm.kind, address: a.pubkey, side, quote, d });
    }
  });
  if (gaps.length === jobs.length) throw unavailable('the RPC refused every pool scan right now. Not charged.');
  const seen = new Set(); const pools = found.filter((p) => !seen.has(p.address) && seen.add(p.address));
  return { pools, other_quote_pools: other, gaps };
}

// USD value of a quote asset: stables are taken at 1.00, SOL from our on-chain SOL price
async function quoteUsd(quote, deps) {
  if (quote === WSOL) return (await (deps.solPrice || (() => require('./prices').getPrice('SOL')))()).price;
  return 1;
}

async function priceAndDepth(ctx, pools, mint, tokDec, deps) {
  if (!pools.length) return [];
  const vaultKeys = [...new Set(pools.flatMap((p) => [p.d.vaultA, p.d.vaultB]))];
  const accs = await accountsBatch(ctx, vaultKeys);
  const bal = new Map(vaultKeys.map((k, i) => [k, tokAmount(accs[i])]));
  const sol = await quoteUsd(WSOL, deps).catch(() => null);
  const out = [];
  for (const p of pools) {
    const aTok = p.side === 'A';
    const tokRaw = bal.get(aTok ? p.d.vaultA : p.d.vaultB); const quoRaw = bal.get(aTok ? p.d.vaultB : p.d.vaultA);
    if (tokRaw == null || quoRaw == null) continue;
    const q = QUOTES[p.quote]; const qUsd = p.quote === WSOL ? sol : 1;
    if (qUsd == null) continue;
    const tok = num(tokRaw) / 10 ** tokDec; const quo = num(quoRaw) / 10 ** q.dec;
    let priceQuote = null; let virt = null;
    if (p.kind === 'cp' && tok > 0 && quo > 0) { priceQuote = quo / tok; virt = { tok, quo }; }
    else if (p.kind === 'cl') {
      const s = num(p.d.sqrt) / 2 ** 64; const L = num(p.d.liquidity);
      if (s > 0) {
        const rawB_per_A = s * s; // token B raw units per token A raw unit
        const decA = aTok ? tokDec : q.dec; const decB = aTok ? q.dec : tokDec;
        const bPerA = rawB_per_A * 10 ** (decA - decB);
        priceQuote = aTok ? bPerA : 1 / bPerA;
        if (L > 0) { // virtual reserves in raw units: A = L / s, B = L * s
          const aRaw = L / s; const bRaw = L * s;
          virt = aTok ? { tok: aRaw / 10 ** tokDec, quo: bRaw / 10 ** q.dec } : { tok: bRaw / 10 ** tokDec, quo: aRaw / 10 ** q.dec };
        }
      }
    } else if (p.kind === 'bins' && tok > 0 && quo > 0) priceQuote = quo / tok; // reserve ratio: an indication, not a quote
    if (!(priceQuote > 0)) continue;
    out.push({ venue: p.venue, kind: p.kind, address: p.address, quote_asset: q.sym, quote_mint: p.quote, price_usd: priceQuote * qUsd,
      liquidity_usd: tok * priceQuote * qUsd + quo * qUsd, token_reserve: tok, quote_reserve: quo, virt, qUsd, fee_bps: p.d.feeBps != null ? Math.round(p.d.feeBps * 100) / 100 : null,
      vaults: [p.d.vaultA, p.d.vaultB], token_vault: aTok ? p.d.vaultA : p.d.vaultB, quotable: p.kind !== 'bins' && !!virt });
  }
  // a DLMM pool's reserves sit in bins at many prices, so its reserve ratio is not a price: value its token side at the
  // best quoted pool's price, and report no price of its own
  const ref = out.filter((x) => x.quotable).sort((a, b) => b.liquidity_usd - a.liquidity_usd)[0];
  for (const x of out) if (x.kind === 'bins') { x.liquidity_usd = ref ? x.token_reserve * ref.price_usd + x.quote_reserve * x.qUsd : x.quote_reserve * x.qUsd * 2; x.price_usd = null; }
  return out.sort((a, b) => b.liquidity_usd - a.liquidity_usd);
}
// average execution price against the pool mid for a buy of `usd`: x*y=k gives exactly q_in / R_quote
function buyImpact(pool, usd) {
  if (!pool || !pool.quotable || !pool.virt) return null;
  const qIn = usd / pool.qUsd;
  const imp = qIn / pool.virt.quo;
  const afterMid = (1 + qIn / pool.virt.quo) ** 2 - 1; // how far the pool's mid moves
  return { trade_usd: usd, price_impact_pct: Math.round(imp * 1e4) / 100, mid_price_move_pct: Math.round(afterMid * 1e4) / 100 };
}

// ---------- pump.fun bonding curve ----------
async function readCurve(ctx, mint, deps) {
  const K = require('@solana/kit'); const enc = K.getAddressEncoder();
  const [pda] = await K.getProgramDerivedAddress({ programAddress: PROGRAM.PUMP, seeds: ['bonding-curve', enc.encode(mint)] });
  const a = await ctx.rpc('getAccountInfo', [pda, { encoding: 'base64' }]);
  if (!a.value || a.value.owner !== PROGRAM.PUMP) return null;
  const d = Buffer.from(a.value.data[0], 'base64');
  if (d.length < 49) return null;
  const vT = u64(d, 8), vS = u64(d, 16), rT = u64(d, 24), rS = u64(d, 32), complete = d[48] === 1;
  if (complete) return { address: pda, complete: true };
  const k = num(vT) * num(vS);
  const vTend = num(vT) - num(rT); // virtual tokens left when the real ones run out
  const vSend = k / vTend;
  const sol = await quoteUsd(WSOL, deps).catch(() => null);
  const priceSol = (num(vS) / 1e9) / (num(vT) / 1e6);
  // pump.fun reserves 206.9M of the 1B supply for the pool it graduates into; the rest (793.1M) is sold along the curve
  const forSale = num(u64(d, 40)) - 206_900_000e6;
  return { address: pda, complete: false, price_sol: priceSol, price_usd: sol ? priceSol * sol : null, sol, vT: num(vT), vS: num(vS), rT: num(rT), rS: num(rS),
    progress_pct: forSale > 0 ? Math.round((1 - num(rT) / forSale) * 1e4) / 100 : null, sol_raised: num(rS) / 1e9, sol_to_graduate: Math.max(0, (vSend - num(vS)) / 1e9), vSend };
}


// ---------- holders ----------
// class: wallet (on-curve, system-owned or empty), burn, program-authority (an off-curve owner: a pool,
// vault or program PDA), program-owned (the owner account belongs to a program other than the system program)
async function readHolders(ctx, mint, supply, exclude = new Set()) {
  let largest;
  try { largest = (await ctx.rpc('getTokenLargestAccounts', [mint])).value || []; } catch (e) {
    if (e.badRequest) return { error: 'this mint has too many token accounts for the RPC to rank its holders' };
    throw e;
  }
  const top = largest.slice(0, 20);
  if (!top.length) return { holders: [], top10_wallet_pct: 0, wallet_holders_ranked: 0 };
  const tokAccs = await accountsBatch(ctx, top.map((t) => t.address), 'jsonParsed');
  const owners = tokAccs.map((a) => (a && a.data && a.data.parsed && a.data.parsed.info && a.data.parsed.info.owner) || null);
  const uniq = [...new Set(owners.filter(Boolean))];
  const ownerAccs = uniq.length ? await accountsBatch(ctx, uniq) : [];
  const ownerInfo = new Map(uniq.map((o, i) => [o, ownerAccs[i]]));
  const holders = top.map((t, i) => {
    const owner = owners[i]; const acc = owner ? ownerInfo.get(owner) : null;
    let cls = 'wallet';
    if (!owner) cls = 'unknown';
    else if (BURN.has(owner)) cls = 'burn';
    else if (exclude.has(t.address)) cls = 'pool-vault';
    else if (acc && acc.owner !== PROGRAM.SYSTEM) cls = 'program-owned';
    else if (!isOnCurve(owner)) cls = 'program-authority';
    const amount = Number(t.uiAmountString || t.uiAmount || 0);
    return { token_account: t.address, owner, class: cls, amount, pct_of_supply: supply > 0 ? Math.round(amount / supply * 1e6) / 1e4 : null };
  });
  const wallets = holders.filter((h) => h.class === 'wallet');
  const top10 = wallets.slice(0, 10).reduce((a, h) => a + (h.pct_of_supply || 0), 0);
  return { holders, wallet_holders_ranked: wallets.length, top1_wallet_pct: wallets[0] ? wallets[0].pct_of_supply : null, top10_wallet_pct: Math.round(top10 * 100) / 100 };
}

// ---------- the verdict: every rule stated, every rule listed whether it fired or not ----------
function evaluate(f) {
  const R = [];
  const add = (id, level, fired, detail, threshold) => R.push({ id, level, fired: fired === true, unknown: fired == null, threshold, detail });
  add('mint_authority_set', 'critical', f.mint_authority != null, f.mint_authority ? `mint authority ${f.mint_authority} can create more supply` : 'no mint authority: supply is fixed', 'any mint authority');
  add('freeze_authority_set', 'critical', f.freeze_authority != null, f.freeze_authority ? `freeze authority ${f.freeze_authority} can freeze any holder (regulated stablecoins keep one on purpose)` : 'no freeze authority', 'any freeze authority');
  add('permanent_delegate', 'critical', !!f.ext.permanentDelegate, f.ext.permanentDelegate ? `permanent delegate ${f.ext.permanentDelegate.delegate} can move or burn any holder's tokens` : 'none', 'Token-2022 permanentDelegate present');
  add('transfer_hook', 'critical', !!(f.ext.transferHook && f.ext.transferHook.programId), f.ext.transferHook && f.ext.transferHook.programId ? `every transfer calls program ${f.ext.transferHook.programId}, which can block it` : 'none', 'Token-2022 transferHook with a program');
  add('non_transferable', 'critical', !!f.ext.nonTransferable, f.ext.nonTransferable ? 'tokens cannot be transferred or sold' : 'transferable', 'Token-2022 nonTransferable present');
  add('default_account_state_frozen', 'critical', !!(f.ext.defaultAccountState && f.ext.defaultAccountState.accountState === 'frozen'), f.ext.defaultAccountState ? `new token accounts start ${f.ext.defaultAccountState.accountState}` : 'none', 'Token-2022 defaultAccountState = frozen');
  const fee = f.ext.transferFeeConfig; const bps = fee ? Math.max(num((fee.newerTransferFee || {}).transferFeeBasisPoints || 0), num((fee.olderTransferFee || {}).transferFeeBasisPoints || 0)) : 0;
  add('transfer_fee_over_5pct', 'critical', bps > 500, fee ? `transfer fee ${bps / 100}%` : 'no transfer fee', 'Token-2022 transfer fee above 500 bps');
  add('transfer_fee_present', 'warn', bps > 0 && bps <= 500, bps > 0 ? `transfer fee ${bps / 100}% on every transfer` : 'none', 'any Token-2022 transfer fee up to 500 bps');
  add('metadata_mutable', 'warn', f.metadata == null ? null : f.metadata.mutable === true, f.metadata ? (f.metadata.mutable ? 'name, symbol and image can still be changed' : 'metadata is immutable') : 'no metadata account found', 'metadata update authority still set');
  add('top1_wallet_over_20pct', 'warn', f.holders && f.holders.top1_wallet_pct != null ? f.holders.top1_wallet_pct > 20 : null, f.holders && f.holders.top1_wallet_pct != null ? `largest wallet holds ${f.holders.top1_wallet_pct}% of supply` : 'holders not ranked', 'largest non-pool wallet above 20% of supply');
  add('top10_wallets_over_50pct', 'warn', f.holders && f.holders.top10_wallet_pct != null ? f.holders.top10_wallet_pct > 50 : null, f.holders && f.holders.top10_wallet_pct != null ? `top 10 wallets hold ${f.holders.top10_wallet_pct}% of supply` : 'holders not ranked', 'top 10 non-pool wallets above 50% of supply');
  add('no_liquidity_found', 'warn', f.deepest == null && !f.curve_active, f.deepest ? `deepest pool ${f.deepest.venue} holds $${Math.round(f.deepest.liquidity_usd)}` : f.curve_active ? 'trades on the pump.fun curve' : 'no pool or curve found in the AMMs searched', 'no pool against SOL, USDC or USDT in the AMMs searched');
  add('liquidity_under_10k_usd', 'warn', f.deepest ? f.deepest.liquidity_usd < 10000 : null, f.deepest ? `$${Math.round(f.deepest.liquidity_usd)} in the deepest pool` : 'no pool', 'deepest pool under $10,000');
  add('impact_1000_over_5pct', 'warn', f.impact1000 ? f.impact1000.price_impact_pct > 5 : null, f.impact1000 ? `a $1,000 buy moves price ${f.impact1000.price_impact_pct}%` : 'not computable', 'a $1,000 buy pays more than 5% over mid');
  const critical = R.filter((r) => r.level === 'critical' && r.fired).length; const warn = R.filter((r) => r.level === 'warn' && r.fired).length;
  return { verdict: critical ? 'high_risk' : warn ? 'caution' : 'no_red_flags_found', critical_fired: critical, warnings_fired: warn, rules: R,
    verdict_rule: 'high_risk if any critical rule fired; caution if any warn rule fired; otherwise no_red_flags_found. Never "safe": these are the on-chain properties we can read, not a guarantee. Rules marked unknown could not be evaluated.' };
}

function checkMintParam(mint) {
  if (mint == null || mint === '') throw bad('missing required parameter: mint');
  if (!sr.BASE58_RE.test(String(mint))) throw bad('invalid mint address');
  return String(mint);
}

// ---------- /api/sol-token-check ----------
const checkCache = new Map();
async function tokenCheck(p = {}, deps = {}) {
  const mint = checkMintParam(p.mint);
  if (QUOTE_ASSETS.has(mint)) throw bad('this is a quote asset (SOL or a major stablecoin) with thousands of pools: a pre-trade check on it is not served. Use /api/prices for SOL.');
  return memo(checkCache, mint, deps.ttl ?? 60e3, () => tokenCheckRun(mint, deps), deps.now);
}
// R20: several reads below tolerate a failed call (a pool that cannot be read becomes a "gap", a holder lookup is skipped). That is right for a pruned
// transaction or a refused scan, and wrong when NO endpoint answered: a Solana outage would come back as a paid, partial answer. The first such failure
// is remembered on the ctx (ctx.outage, set in ctx.rpc) and the request ends in a 503, not charged, whatever the tolerant code did with it.
async function outageGuard(ctx, run) {
  const outageError = () => unavailable(`the Solana RPC did not answer (${String(ctx.outage.message).replace(/\.?\s*Not charged\.?$/, '').slice(0, 120)}). Not charged.`, { retryAfter: 30 });
  let out;
  try { out = await run(); } catch (e) { if (ctx.outage && e === ctx.outage) throw outageError(); throw e; }   // R20j: ctx.rpc re-throws the remembered outage to any later call; same answer as a swallowed one
  if (ctx.outage) throw outageError();
  return out;
}
async function tokenCheckRun(mint, deps) {
  const ctx = deps.ctx || makeCtx({ rpc: deps.rpc, budget: 70, deadline: Date.now() + 40e3 });
  return outageGuard(ctx, () => tokenCheckBody(ctx, mint, deps));
}
async function tokenCheckBody(ctx, mint, deps) {
  const m = await readMint(ctx, mint);
  const [metadata, curve, disc] = await Promise.all([readMetadata(ctx, mint, m.ext), readCurve(ctx, mint, deps).catch((e) => { if (e.status === 503) throw e; return null; }), discoverPools(ctx, mint)]);
  const ranked = await priceAndDepth(ctx, disc.pools, mint, m.decimals, deps);
  const deepest = ranked[0] || null; const quotableBest = ranked.find((x) => x.quotable) || null;
  const exclude = new Set(ranked.flatMap((x) => x.vaults));
  const holders = await readHolders(ctx, mint, m.supply, exclude);
  const curveActive = !!(curve && !curve.complete);
  let impact100 = quotableBest ? buyImpact(quotableBest, 100) : null; let impact1000 = quotableBest ? buyImpact(quotableBest, 1000) : null;
  let curveImpact = null;
  if (curveActive && curve.sol) {
    // pump.fun curve: constant product on the virtual reserves; the 1% pump.fun fee is not in it
    const imp = (usd) => { const sIn = usd / curve.sol; return { trade_usd: usd, price_impact_pct: Math.round(sIn * 1e9 / curve.vS * 1e4) / 100, mid_price_move_pct: Math.round(((1 + sIn * 1e9 / curve.vS) ** 2 - 1) * 1e4) / 100 }; };
    curveImpact = { basis: 'pump.fun bonding curve, virtual reserves, fee excluded', buy_100_usd: imp(100), buy_1000_usd: imp(1000) };
    if (!impact100) { impact100 = curveImpact.buy_100_usd; impact1000 = curveImpact.buy_1000_usd; }
  }
  const ver = evaluate({ mint_authority: m.mint_authority, freeze_authority: m.freeze_authority, ext: m.ext, metadata, holders: holders.error ? null : holders, deepest, impact1000, curve_active: curveActive });
  const topN = ranked.slice(0, 3).map((x) => ({ venue: x.venue, address: x.address, quote_asset: x.quote_asset, price_usd: x.price_usd == null ? null : sig(x.price_usd), liquidity_usd: Math.round(x.liquidity_usd), fee_bps: x.fee_bps, quoted: x.quotable }));
  const ext = Object.keys(m.ext).filter((k) => k !== 'tokenMetadata' && k !== 'metadataPointer');
  return {
    mint, token_program: m.program, decimals: m.decimals, supply: m.supply,
    authorities: { mint_authority: m.mint_authority, freeze_authority: m.freeze_authority },
    token2022_extensions: ext,
    metadata: metadata ? { name: metadata.name, symbol: metadata.symbol, mutable: metadata.mutable, source: metadata.source } : null,
    holders: holders.error ? { error: holders.error } : { top10_wallet_pct: holders.top10_wallet_pct, top1_wallet_pct: holders.top1_wallet_pct, ranked: holders.holders.map((h) => ({ owner: h.owner, class: h.class, pct_of_supply: h.pct_of_supply })), note: 'top 20 token accounts by balance; pool vaults, burn addresses and program-controlled accounts are labelled and left out of the wallet percentages' },
    liquidity: { deepest_pool: topN[0] || null, other_deep_pools: topN.slice(1), pools_seen: disc.pools.length, scan_gaps: disc.gaps, pools_against_other_quotes_ignored: disc.other_quote_pools,
      amms_searched: AMMS.map((a) => a.id), coverage_note: 'Raydium AMM v4, CPMM and CLMM, Orca Whirlpool, Meteora DLMM and the current PumpSwap pool layout, against SOL, USDC or USDT; stablecoins are taken at $1.00' },
    price_impact: { basis: quotableBest ? `${quotableBest.venue} pool ${quotableBest.address}, swap fee excluded, single pool, ${quotableBest.kind === 'cl' ? 'concentrated liquidity in-range virtual reserves (exact only while the trade stays in the active range)' : 'constant product on vault balances'}` : curveActive ? 'pump.fun bonding curve' : null,
      buy_100_usd: impact100, buy_1000_usd: impact1000 },
    pumpfun: curve ? (curve.complete ? { curve: curve.address, graduated: true } : { curve: curve.address, graduated: false, progress_pct: curve.progress_pct, sol_raised: round(curve.sol_raised, 3), sol_to_graduate: round(curve.sol_to_graduate, 3), price_usd: curve.price_usd ? sig(curve.price_usd) : null, impact: curveImpact, progress_basis: 'share of the 793.1M curve tokens already sold, as the pump.fun UI shows it; sol_to_graduate is derived from the curve itself' }) : null,
    verdict: ver.verdict, critical_fired: ver.critical_fired, warnings_fired: ver.warnings_fired, rules: ver.rules, verdict_rule: ver.verdict_rule,
    rpc_calls: ctx.calls, as_of: new Date().toISOString(), source: 'Solana chain state via standard JSON-RPC (token mint, Metaplex metadata, AMM pool and vault accounts, pump.fun curve, largest token accounts)',
  };
}
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const sig = (x) => Number(Number(x).toPrecision(6));


// ---------- shared: where does this mint trade, and who owns the vaults ----------
// The market (pools, vaults, depth) changes slowly and costs 15-25 calls to find, which is most of a flow request's 20 s on a
// busy token; the production path remembers it for 5 minutes. Calls with an injected rpc or ctx (tests) never use the cache.
const marketCache = new Map();
function findMarket(ctx, mint, m, deps) {
  if (deps.rpc || deps.ctx) return findMarketRun(ctx, mint, m, deps);
  return memo(marketCache, mint, 300e3, () => findMarketRun(ctx, mint, m, deps));
}
async function findMarketRun(ctx, mint, m, deps) {
  const [curve, disc] = await Promise.all([readCurve(ctx, mint, deps).catch((e) => { if (e.status === 503) throw e; return null; }), discoverPools(ctx, mint)]);
  const ranked = await priceAndDepth(ctx, disc.pools, mint, m.decimals, deps);
  const pool = ranked.find((x) => x.kind !== 'bins') || ranked[0] || null;
  if (curve && !curve.complete && !pool) return { type: 'curve', state: curve.address, history_key: curve.address, curve, owners: new Set([curve.address]), quote: WSOL, quoteDec: 9, qUsd: curve.sol, ranked };
  if (!pool) throw bad('no pool or live bonding curve was found for this mint in the AMMs searched, so there is no trade flow to read');
  const vaultAccs = await accountsBatch(ctx, pool.vaults, 'jsonParsed');
  const owners = new Set(vaultAccs.map((a) => a && a.data && a.data.parsed && a.data.parsed.info && a.data.parsed.info.owner).filter(Boolean));
  return { type: 'pool', state: pool.address, history_key: pool.token_vault, pool, owners, quote: pool.quote_mint, quoteDec: QUOTES[pool.quote_mint].dec, qUsd: pool.qUsd, ranked };
}

// Two reads at a time. With `partial`, an exhausted time or call budget stops the reading and returns what was read, flagged.
async function getTxs(ctx, sigs, { partial = false } = {}) {
  let truncated = false;
  const txs = await mapLimit(sigs, 2, async (sg) => {
    if (truncated) return null;
    try { return await ctx.rpc('getTransaction', [sg, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]); } catch (e) {
      if (e.status === 503 && /budget/.test(e.message)) { if (partial) { truncated = true; return null; } throw e; }
      return null; // a pruned or unreadable transaction is skipped and counted
    }
  });
  return partial ? { txs, truncated } : txs;
}
const getTx = async (ctx, sig) => (await getTxs(ctx, [sig]))[0];
function balanceDeltas(t, mint, dec) {
  const by = new Map();
  for (const [sign, list] of [[-1, t.meta.preTokenBalances || []], [1, t.meta.postTokenBalances || []]]) {
    for (const b of list) {
      if (b.mint !== mint || !b.owner) continue;
      const amt = Number(b.uiTokenAmount && (b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount) || 0);
      by.set(b.owner, (by.get(b.owner) || 0) + sign * amt);
    }
  }
  return by;
}
function quoteDelta(t, market) {
  // |change| of the quote asset in the pool's vaults, in quote units
  if (market.quote === WSOL && market.type === 'curve') {
    const keys = t.transaction.message.accountKeys; const i = keys.indexOf(market.state);
    return i >= 0 ? Math.abs(t.meta.postBalances[i] - t.meta.preBalances[i]) / 1e9 : 0;
  }
  let d = 0;
  for (const [sign, list] of [[-1, t.meta.preTokenBalances || []], [1, t.meta.postTokenBalances || []]]) {
    for (const b of list) if (b.mint === market.quote && market.owners.has(b.owner)) d += sign * Number(b.uiTokenAmount && (b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount) || 0);
  }
  return Math.abs(d);
}
const keysOf = (t) => t.transaction.message.accountKeys.concat((t.meta.loadedAddresses && [...(t.meta.loadedAddresses.writable || []), ...(t.meta.loadedAddresses.readonly || [])]) || []);

// ---------- /api/sol-token-flow ----------
const flowCache = new Map();
async function tokenFlow(p = {}, deps = {}) {
  const mint = checkMintParam(p.mint);
  if (QUOTE_ASSETS.has(mint)) throw bad('this is a quote asset (SOL or a major stablecoin): trade flow is not served for it');
  let swaps = p.swaps == null || p.swaps === '' ? 50 : Number(p.swaps);
  if (!Number.isInteger(swaps) || swaps < 20 || swaps > 100) throw bad('swaps must be an integer from 20 to 100');
  return memo(flowCache, `${mint}|${swaps}`, deps.ttl ?? 60e3, () => heavy(() => tokenFlowRun(mint, swaps, deps)), deps.now);
}
async function tokenFlowRun(mint, swaps, deps) {
  const ctx = deps.ctx || makeCtx({ rpc: deps.rpc, budget: 400, deadline: Date.now() + (deps.budgetMs ?? 20e3) });
  return outageGuard(ctx, () => tokenFlowBody(ctx, mint, swaps, deps));
}
async function tokenFlowBody(ctx, mint, swaps, deps) {
  const now = deps.nowMs ? deps.nowMs() : Date.now();
  const m = await readMint(ctx, mint);
  const market = await findMarket(ctx, mint, m, deps);
  // Many transactions that touch a busy vault move none of this mint (bots that check and back out), so read in chunks of 20
  // from a long signature list until enough swaps are found or the budget ends.
  const sigs = (await ctx.rpc('getSignaturesForAddress', [market.history_key, { limit: Math.min(1000, swaps * 6) }])).filter((x) => !x.err);
  let unreadable = 0; let read = 0; let truncated = false; const rows = [];
  for (let i = 0; i < sigs.length && rows.length < swaps && !truncated; i += 20) {
    const r = await getTxs(ctx, sigs.slice(i, i + 20).map((x) => x.signature), { partial: true });
    truncated = r.truncated; read += r.txs.length;
    for (const t of r.txs) {
      if (!t || !t.meta || t.meta.err) { unreadable++; continue; }
      const d = balanceDeltas(t, mint, m.decimals);
      let poolDelta = 0; for (const o of market.owners) poolDelta += d.get(o) || 0;
      if (Math.abs(poolDelta) < 1e-12) continue; // not a swap against this market
      const feePayer = keysOf(t)[0];
      let trader = null; let best = 0;
      for (const [o, v] of d) { if (market.owners.has(o) || v === 0 || Math.sign(v) === Math.sign(poolDelta)) continue; if (Math.abs(v) > best || (Math.abs(v) === best && o === feePayer)) { best = Math.abs(v); trader = o; } }
      if (!trader) continue;
      const qUnits = quoteDelta(t, market);
      rows.push({ trader, side: d.get(trader) > 0 ? 'buy' : 'sell', usd: qUnits * market.qUsd, ts: t.blockTime, slot: t.slot, sig: t.transaction.signatures[0] });
      if (rows.length >= swaps) break;
    }
  }
  if (rows.length < 5) {
    if (truncated) throw unavailable('the 20 second budget ran out before 5 swaps were read. Not charged.');
    // most reads failing is the RPC refusing us (rate limit), not a quiet market: say so, and do not bill
    if (read && unreadable >= read / 2) throw unavailable('the RPC is rate limiting transaction reads right now. Not charged.', { retryAfter: 30 });
    throw bad('fewer than 5 swaps could be read for this mint in the recent history of its market');
  }
  const by = new Map();
  for (const r of rows) { const e = by.get(r.trader) || { buy: 0, sell: 0, buys: 0, sells: 0 }; if (r.side === 'buy') { e.buy += r.usd; e.buys++; } else { e.sell += r.usd; e.sells++; } by.set(r.trader, e); }
  const totalUsd = rows.reduce((a, r) => a + r.usd, 0);
  const ranked = [...by.entries()].map(([w, e]) => ({ w, vol: e.buy + e.sell, ...e })).sort((a, b) => b.vol - a.vol);
  const top5 = ranked.slice(0, 5);
  const roundTrip = ranked.filter((e) => e.buys > 0 && e.sells > 0);
  const buyers = ranked.filter((e) => e.buys > 0);
  // wallet age of the largest buyers: the oldest signature of the wallet, one call each
  const sample = [...buyers].sort((a, b) => b.buy - a.buy).slice(0, 40);
  let young = 0; let aged = 0;
  await mapLimit(sample, 3, async (b) => {
    try {
      const page = await ctx.rpc('getSignaturesForAddress', [b.w, { limit: 1000 }]);
      if (!page.length) return;
      const oldest = page[page.length - 1].blockTime;
      if (oldest == null) return;
      aged++; if (oldest * 1000 >= now - 86400e3) young++;
    } catch (e) { if (e.status !== 503) throw e; }
  });
  const bundle = await launchBundle(ctx, mint, market, m, rows, now).catch((e) => (e.status === 503 ? { error: 'RPC budget ran out before the launch could be read' } : { error: String(e.message).slice(0, 80) }));
  const ts = rows.map((r) => r.ts).filter(Boolean);
  const pct = (a, b) => (b ? Math.round(a / b * 1e4) / 100 : null);
  return {
    mint, market: { type: market.type, venue: market.type === 'pool' ? market.pool.venue : 'pump.fun bonding curve', address: market.state, quote_asset: QUOTES[market.quote].sym },
    // truncated means the budget ended the read with fewer swaps than asked; a read that reached the count is complete
    truncated: truncated && rows.length < swaps, swaps_analyzed: rows.length,
    window: { swaps_analyzed: rows.length, swaps_requested: swaps, from: new Date(Math.min(...ts) * 1000).toISOString(), to: new Date(Math.max(...ts) * 1000).toISOString(), transactions_unreadable: unreadable, truncated_by_time_budget: truncated && rows.length < swaps, budget_seconds: (deps.budgetMs ?? 20e3) / 1000 },
    volume_usd: Math.round(totalUsd), buys: rows.filter((r) => r.side === 'buy').length, sells: rows.filter((r) => r.side === 'sell').length,
    unique_traders: by.size, unique_buyers: buyers.length,
    top5_traders_volume_share_pct: pct(top5.reduce((a, e) => a + e.vol, 0), totalUsd),
    top5_traders: top5.map((e) => ({ wallet: e.w, volume_usd: Math.round(e.vol), buys: e.buys, sells: e.sells })),
    round_trip_wallets: { count: roundTrip.length, pct_of_traders: pct(roundTrip.length, by.size), definition: 'wallets that both bought and sold this mint inside the window' },
    new_wallet_buyers: { sampled_buyers: aged, first_transaction_under_24h: young, pct: pct(young, aged), basis: 'the 40 largest buyers; a wallet is new when the oldest signature in its last 1,000 is under 24 hours old' },
    launch_slot_bundle: bundle,
    rpc_calls: ctx.calls, as_of: new Date(now).toISOString(),
    method: 'swaps are the transactions that moved this mint in and out of the market\'s vaults; the trader is the wallet on the other side; USD is the quote-asset movement in the vaults, fees excluded; SOL at our on-chain price, stablecoins at $1.00',
    source: 'Solana chain state via standard JSON-RPC (getSignaturesForAddress, getTransaction)',
  };
}

// buyers in the first two slots of a mint younger than 7 days
async function launchBundle(ctx, mint, market, m, rows, now) {
  let before; let all = []; let reachedStart = false;
  for (let page = 0; page < 10; page++) {
    const r = await ctx.rpc('getSignaturesForAddress', [mint, { limit: 1000, ...(before ? { before } : {}) }]);
    all = all.concat(r);
    if (r.length < 1000) { reachedStart = true; break; }
    const tail = r[r.length - 1].blockTime;
    if (tail != null && now - tail * 1000 > 7 * 86400e3) return { applicable: false, reason: 'the mint is more than 7 days old (the check is for mints under 7 days)' };
    before = r[r.length - 1].signature;
  }
  if (!reachedStart) return { applicable: false, reason: 'the mint has more than 10,000 signatures: its creation is not reachable within the call budget' };
  const first = all[all.length - 1];
  if (!first || first.blockTime == null) return { applicable: false, reason: 'the mint\'s first transaction has no block time' };
  const ageDays = (now - first.blockTime * 1000) / 86400e3;
  if (ageDays >= 7) return { applicable: false, reason: `the mint is ${Math.floor(ageDays)} days old (the check is for mints under 7 days)` };
  const s0 = first.slot;
  const early = all.filter((x) => !x.err && x.slot <= s0 + 1).slice(-60);
  const txs = await getTxs(ctx, early.map((x) => x.signature));
  const buyers = new Set(); let creator = null;
  for (const t of txs) {
    if (!t || !t.meta || t.meta.err) continue;
    if (!creator && t.slot === s0) creator = keysOf(t)[0];
    const d = balanceDeltas(t, mint, m.decimals);
    for (const [o, v] of d) if (v > 0 && !market.owners.has(o)) buyers.add(o);
  }
  if (creator) buyers.delete(creator);
  return { applicable: true, mint_age_hours: Math.round(ageDays * 24 * 10) / 10, creation_slot: s0, transactions_in_first_two_slots: early.length, distinct_buyers_in_first_two_slots: buyers.size, definition: 'distinct wallets, other than the creating wallet, that received this mint in the creation slot or the next one' };
}

// ---------- /api/sol-holder-clusters ----------
const clusterCache = new Map();
async function holderClusters(p = {}, deps = {}) {
  const mint = checkMintParam(p.mint);
  if (QUOTE_ASSETS.has(mint)) throw bad('this is a quote asset: holder clusters are not served for it');
  return memo(clusterCache, mint, deps.ttl ?? 60e3, () => heavy(() => holderClustersRun(mint, deps)), deps.now);
}
// one hop: the account that first sent SOL to the wallet
async function funderOf(ctx, wallet) {
  let page = await ctx.rpc('getSignaturesForAddress', [wallet, { limit: 1000 }]);
  for (let i = 0; i < 2 && page.length === 1000; i++) page = await ctx.rpc('getSignaturesForAddress', [wallet, { limit: 1000, before: page[page.length - 1].signature }]);
  if (!page.length) return { funder: null, reason: 'no transactions' };
  if (page.length === 1000) return { funder: null, reason: 'wallet has 3,000 or more transactions: too active to trace its first funding within the call budget' };
  const oldest = page.filter((x) => !x.err).slice(-3).reverse();
  for (const s of oldest) {
    const t = await getTx(ctx, s.signature);
    if (!t || !t.meta) continue;
    const keys = keysOf(t); const i = keys.indexOf(wallet);
    if (i < 0) continue;
    const gained = t.meta.postBalances[i] - t.meta.preBalances[i];
    if (gained <= 0) continue;
    let from = null; let most = 0;
    keys.forEach((k, j) => { if (j !== i) { const loss = t.meta.preBalances[j] - t.meta.postBalances[j]; if (loss > most) { most = loss; from = k; } } });
    if (from) return { funder: from, sol: gained / 1e9, ts: t.blockTime || null };
  }
  return { funder: null, reason: 'no inbound SOL transfer among its first three transactions' };
}
async function holderClustersRun(mint, deps) {
  const ctx = deps.ctx || makeCtx({ rpc: deps.rpc, budget: 220, deadline: Date.now() + 50e3 });
  return outageGuard(ctx, () => holderClustersBody(ctx, mint, deps));
}
async function holderClustersBody(ctx, mint, deps) {
  const m = await readMint(ctx, mint);
  const disc = await discoverPools(ctx, mint).catch((e) => { if (e.status === 503 && /budget/.test(e.message)) throw e; return { pools: [] }; });
  const ranked = await priceAndDepth(ctx, disc.pools, mint, m.decimals, deps).catch(() => []);
  const h = await readHolders(ctx, mint, m.supply, new Set(ranked.flatMap((x) => x.vaults)));
  if (h.error) throw bad(h.error);
  const wallets = h.holders.filter((x) => x.class === 'wallet' && x.owner);
  const traced = await mapLimit(wallets, 3, async (w) => ({ w, f: await funderOf(ctx, w.owner).catch((e) => (e.status === 503 ? { funder: null, reason: 'RPC budget ran out' } : { funder: null, reason: String(e.message).slice(0, 60) }) ) }));
  const groups = new Map();
  for (const { w, f } of traced) if (f.funder) { const g = groups.get(f.funder) || []; g.push(w); groups.set(f.funder, g); }
  const clusters = [...groups.entries()].filter(([, g]) => g.length >= 2).map(([funder, g]) => ({ funder, holders: g.length, supply_pct: Math.round(g.reduce((a, x) => a + (x.pct_of_supply || 0), 0) * 100) / 100, wallets: g.map((x) => ({ wallet: x.owner, pct_of_supply: x.pct_of_supply })) })).sort((a, b) => b.supply_pct - a.supply_pct);
  return {
    mint, holders_examined: wallets.length, holders: traced.map(({ w, f }) => ({ wallet: w.owner, pct_of_supply: w.pct_of_supply, funder: f.funder, ...(f.funder ? { funded_sol: Math.round(f.sol * 1e4) / 1e4 } : { funder_unknown_because: f.reason }) })),
    clusters, clustered_supply_pct: Math.round(clusters.reduce((a, c) => a + c.supply_pct, 0) * 100) / 100,
    excluded_from_top_20: h.holders.filter((x) => x.class !== 'wallet').map((x) => ({ owner: x.owner, class: x.class, pct_of_supply: x.pct_of_supply })),
    caveat: 'A cluster is wallets whose first SOL came from the same account. That account can be an exchange hot wallet, which funds thousands of unrelated people: read the funder before treating a cluster as one owner.',
    rpc_calls: ctx.calls, as_of: new Date().toISOString(), source: 'Solana chain state via standard JSON-RPC (getTokenLargestAccounts, getSignaturesForAddress, getTransaction)',
  };
}

module.exports = { heavy, launchBundle, makeCtx, mapLimit, isOnCurve, b58decode, b58, AMMS, discoverPools, readMint, readMetadata, readHolders, priceAndDepth, buyImpact, readCurve, evaluate, tokenCheck, tokenFlow, holderClusters, funderOf, findMarket, QUOTES, QUOTE_ASSETS, BURN, PROGRAM, u128, u64, keyAt, memo, bad, unavailable, accountsBatch, tokAmount, num, checkMintParam, _caches: { checkCache, flowCache, clusterCache } };
