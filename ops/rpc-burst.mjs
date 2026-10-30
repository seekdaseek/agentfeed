#!/usr/bin/env node
// ops/rpc-burst.mjs — a burst test of the Solana RPC layer with the box's REAL configuration (R20h, 30 Oct 2026). Nothing is paid and nothing is written: it fires N concurrent
// getTokenLargestAccounts calls for one mint through lib/solrpc.js (the same code the five holder routes use), then prints how the answers split and which HOST was asked what.
//
//   cd /opt/agentfeed && node --env-file=.env ops/rpc-burst.mjs [N=60] [mint]
//
// Read it like this: with a keyed provider in RPC_FALLBACKS you expect  answers 60 of 60, 2 attempts counted for getTokenLargestAccounts (the capped Helius once, the keyed provider once; "shared" = 59), none on api.mainnet-beta.solana.com;
// with none you expect  503 "Not charged" for all 60 and still no call on api.mainnet-beta.solana.com. Hosts only are printed, never a URL or a key.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SR = require('../lib/solrpc.js');

const N = Math.max(1, Math.min(500, Number(process.argv[2]) || 60));
const MINT = process.argv[3] || 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const hostsOf = (urls) => urls.map((u) => { try { return new URL(u).host; } catch { return 'unknown'; } });

const main = SR.endpoints();
console.log(`main list : ${hostsOf(main.urls).join('  >  ')}`);
const heavy = SR.heavyEndpoints();
console.log(`heavy list: ${heavy ? hostsOf(heavy.urls).join('  >  ') : '(none: no endpoint can serve getTokenLargestAccounts)'}`);
const keyedPresent = hostsOf(main.urls).some((h) => !/helius-rpc\.com$|api\.mainnet(-beta)?\.solana\.com$/.test(h));
console.log(`a keyed provider besides Helius is configured: ${keyedPresent ? 'yes' : 'NO'}`);

const t0 = Date.now();
const settled = await Promise.allSettled(Array.from({ length: N }, () => SR.rpc('getTokenLargestAccounts', [MINT])));
const ms = Date.now() - t0;
const ok = settled.filter((s) => s.status === 'fulfilled');
const bad = settled.filter((s) => s.status === 'rejected');
const kinds = new Map();
for (const b of bad) { const e = b.reason || {}; const k = `${e.status || '?'} ${String(e.message || '').replace(/https?:\/\/\S+/g, '<url>').slice(0, 90)}`; kinds.set(k, (kinds.get(k) || 0) + 1); }
console.log(`\n${N} concurrent calls in ${ms} ms: answers ${ok.length}, failures ${bad.length}`);
if (ok.length) console.log(`  first answer: ${ok[0].value.value.length} accounts, top account ${ok[0].value.value[0] && ok[0].value.value[0].uiAmountString}`);
for (const [k, n] of kinds) console.log(`  ${n} x ${k}`);
const u = main.takeUsage();
console.log('\nwhat upstream was asked (this process only):');
console.log(`  calls per method : ${JSON.stringify(u.calls)}`);
console.log(`  calls per host   : ${JSON.stringify(u.hosts)}`);
console.log(`  failed per host  : ${JSON.stringify(u.failed)}`);
const publicAsked = (u.hosts['api.mainnet-beta.solana.com'] || 0) + (u.hosts['api.mainnet.solana.com'] || 0);
console.log(`  public RPC asked : ${publicAsked} (expected 0 for a heavy-only burst)`);
console.log(`  cache            : ${JSON.stringify({ hits: SR.heavyCache.hits, shared: SR.heavyCache.shared, misses: SR.heavyCache.misses })}`);
process.exit(publicAsked === 0 ? 0 : 1);
