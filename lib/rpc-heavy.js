// lib/rpc-heavy.js — Solana methods the free public RPC refuses outright, routed past it, with a short cache and single-flight (R20h, 30 Oct 2026).
//
// What happened: the Helius free plan is out of credits until 9 Nov (HTTP 429 "max usage reached", measured 30 Oct on every key on the box), so every Solana read
// falls to the public mainnet RPC (lib/rpc-failover.cjs, R20). The public RPC serves getAccountInfo, getMultipleAccounts and the rest, but answers
// getTokenLargestAccounts with HTTP 429 "Too many requests for a specific RPC call" EVERY time, at any load (measured 30 Oct 05:48Z from the box: three
// calls in nine seconds, all 429, while getSlot and getAccountInfo answered 200 in between). token-risk, token-holders, sol-token-check, sol-token-flow and
// sol-holder-clusters all need that method, so they answered 503 "solana rpc http 429. Not charged." to anyone, a paying customer or the Bazaar refresh,
// and each failed attempt also put the public endpoint to rest for ten minutes for every other method.
//
// What this module does, without touching the shared failover helper (four byte-identical copies are pinned by hash in four repos):
//   1. HEAVY methods go to a SECOND endpoint list built from the first with the hosts that cannot serve them removed (RPC_HEAVY_SKIP, default the two
//      Solana Labs public hosts). Helius first, then whatever keyed provider RPC_FALLBACKS names. The public RPC is never asked, so it is never put to rest
//      by a refusal it was always going to give, and no request wastes a round trip on it.
//   2. With no endpoint left that can serve the method, the call fails at once with a 503 that says so ("Not charged", Retry-After 300), instead of a 429 from a
//      host that could never have answered.
//   3. A successful answer is kept for 90 seconds per (method, params) and concurrent identical calls share one upstream call: the five routes that rank holders
//      ask about the same mint within seconds of each other, and a burst of N requests for one mint costs one call, not N.
//
// The keyed provider itself is configuration, not code: RPC_FALLBACKS=https://<provider>/<key>,https://api.mainnet-beta.solana.com in the service's .env.
'use strict';

/** Methods the public RPC refuses with a per-method 429 whatever the load. Measured; add a method only after measuring it. */
const HEAVY_METHODS = new Set(['getTokenLargestAccounts']);
const DEFAULT_SKIP = ['api.mainnet-beta.solana.com', 'api.mainnet.solana.com'];
const DEFAULT_TTL_MS = 90_000;
const DEFAULT_MAX = 200;

/** RPC_HEAVY_SKIP: a comma list of hosts (host or host:port); unset = the Solana Labs public hosts; empty = skip none. */
function skipList(env = process.env) {
  const raw = env.RPC_HEAVY_SKIP;
  if (raw === undefined || raw === null) return DEFAULT_SKIP.slice();
  return String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** The endpoint URLs that may be asked a heavy method: the list minus the skipped hosts, order kept. */
function heavyUrls(urls, env = process.env) {
  const skip = new Set(skipList(env));
  return urls.filter((u) => {
    let host = '', hostname = '';
    try { const p = new URL(u); host = p.host.toLowerCase(); hostname = p.hostname.toLowerCase(); } catch { return false; }
    return !skip.has(host) && !skip.has(hostname);
  });
}

/**
 * A TTL cache with single-flight. run(key, fn): a fresh cached value is returned (a copy); an identical call already in flight is awaited (all callers share its
 * result or its failure); otherwise fn runs, and only a success is kept. At most `max` keys (oldest dropped first).
 */
class SingleFlightCache {
  constructor({ ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX, now = Date.now } = {}) {
    this.ttlMs = ttlMs; this.max = max; this.now = now;
    this.values = new Map(); this.inflight = new Map();
    this.hits = 0; this.shared = 0; this.misses = 0;
  }
  async run(key, fn) {
    const hit = this.values.get(key);
    if (hit && hit.until > this.now()) { this.hits++; return clone(hit.value); }
    if (hit) this.values.delete(key);
    const pending = this.inflight.get(key);
    if (pending) { this.shared++; return clone(await pending); }
    this.misses++;
    const p = (async () => fn())();
    this.inflight.set(key, p);
    try {
      const value = await p;
      this.values.set(key, { value, until: this.now() + this.ttlMs });
      while (this.values.size > this.max) this.values.delete(this.values.keys().next().value);
      return clone(value);
    } finally { this.inflight.delete(key); }
  }
  clear() { this.values.clear(); }
}
const clone = (v) => (v === undefined || v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));

/**
 * Make `heavy` (a second RpcFailover over a subset of the same URLs) use the SAME rest state and usage counters as `main`: an endpoint that main found out of credits
 * rests for heavy too (nobody asks a capped primary twice in ten minutes), and one `rpc_usage` line covers both. The helper keeps these as plain properties and
 * takeUsage() replaces its Maps, so they are forwarded, not copied.
 */
function shareState(heavy, main) {
  for (const k of ['downUntil', 'wasDown', 'calls', 'hosts', 'failedByHost', 'failovers']) {
    Object.defineProperty(heavy, k, { get: () => main[k], set: (v) => { main[k] = v; }, configurable: true });
  }
  return heavy;
}

module.exports = { HEAVY_METHODS, DEFAULT_SKIP, DEFAULT_TTL_MS, skipList, heavyUrls, shareState, SingleFlightCache };
