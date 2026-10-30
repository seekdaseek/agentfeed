// lib/rpc-throttle.js — keeps what we send to a rate-limited RPC provider under its per-second compute-unit budget (R20j, 30 Oct 2026).
//
// Why: Alchemy's Free plan is measured in compute units per second over a rolling 10 seconds (the documentation read 30 Oct 2026: 300 CU/s, 3,000 CU in any 10 s, shown as
// "15 requests/s" at 20 CU; the owner's page shows 25 requests/s, which is 500 CU/s at 20 CU: two published figures, so we hold to the lower). A request over the budget is an
// HTTP 429, and the failover helper answers any 429 by resting that endpoint for ten minutes, for every method. The first live check on 30 Oct showed it: three `getProgramAccounts`
// calls answered 429 and Alchemy was put to rest, which would have starved the two routes that DO work there. Nothing in the server bounds the rate of upstream calls in total (the
// request limiter is per address, 240 a minute each, and the ranking cache only covers one method), so the bound is made here, on the way out.
//
// How: every request to a limited host is priced in compute units (Alchemy's published weights; a method not listed costs 20) and admitted only if the last second and the last ten
// seconds stay under the budget (the one-second cap implies the ten-second one); otherwise it WAITS (polling every 20 ms) up to MAX_WAIT_MS. If it still cannot be admitted it is answered locally with a JSON-RPC error carried in an
// HTTP 200, which the helper treats as an answer: the call fails (a 503, not charged) without resting the provider and without being sent anywhere, and the budget is never exceeded.
// The helper is not touched: this wraps the `fetch` it is given.
//
//   RPC_CUPS   unset: hosts ending in alchemy.com get 240 CU/s (80% of 300). `host=cu,host=cu` sets them (host or host:port); `off` removes every limit.
'use strict';

/** Alchemy Solana compute units per method (alchemy.com/docs/reference/compute-unit-costs, read 30 Oct 2026). Anything else: DEFAULT_CU. */
const CU = {
  getAccountInfo: 10, getBalance: 10, getMultipleAccounts: 20, getProgramAccounts: 20, getRecentPrioritizationFees: 10, getEpochInfo: 20, getSlot: 20, getTokenSupply: 20,
  getTokenLargestAccounts: 20, getTokenAccountsByOwner: 10, getSignaturesForAddress: 40, getTransaction: 40, getLatestBlockhash: 20, getSignatureStatuses: 20, getBlockHeight: 20,
};
const DEFAULT_CU = 20;
const WINDOW_MS = 10_000;
const MAX_WAIT_MS = 8_000;          // below the 10 s a call is given
const POLL_MS = 20;
const ALCHEMY_DEFAULT_CUPS = 240;

/** { 'host or host:port': cu per second } from RPC_CUPS and the Alchemy default. */
function parseLimits(env = process.env, urls = []) {
  const raw = env.RPC_CUPS;
  if (raw !== undefined && String(raw).trim().toLowerCase() === 'off') return {};
  const out = {};
  for (const u of urls) { let h = ''; try { h = new URL(u).host.toLowerCase(); } catch { /* skip */ } if (/(^|\.)alchemy\.com$/.test(h.replace(/:\d+$/, ''))) out[h] = ALCHEMY_DEFAULT_CUPS; }
  if (raw !== undefined) for (const part of String(raw).split(',')) {
    const [h, v] = part.split('=').map((s) => s.trim());
    const n = Number(v);
    if (h && Number.isFinite(n) && n > 0) out[h.toLowerCase()] = n;
  }
  return out;
}

const costOfBody = (body) => {
  let methods = ['unknown'];
  try { const p = JSON.parse(body); methods = (Array.isArray(p) ? p : [p]).map((x) => (x && typeof x.method === 'string' ? x.method : 'unknown')); } catch { /* not JSON */ }
  return methods.reduce((s, m) => s + (CU[m] ?? DEFAULT_CU), 0);
};

/** One host's budget: at most `cups` compute units in any rolling second, which is at most 10 x `cups` in any ten seconds (ten seconds are ten seconds: the second check implies the first). */
class CuThrottle {
  constructor({ cups, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.cups = cups; this.now = now; this.sleep = sleep; this.log = []; this.history = []; this.delayed = 0; this.refused = 0; this.admitted = 0; this.peak1s = 0; this.peak10s = 0;
  }
  _sums(t) {
    while (this.log.length && this.log[0][0] <= t - WINDOW_MS) this.log.shift();
    let s10 = 0, s1 = 0;
    for (const [at, c] of this.log) { s10 += c; if (at > t - 1000) s1 += c; }
    return { s10, s1 };
  }
  /** true when admitted (possibly after waiting), false when it could not be admitted within maxWaitMs */
  async admit(cost, maxWaitMs = MAX_WAIT_MS) {
    const cost1 = Math.min(cost, this.cups);                      // a single call dearer than a second's budget is admitted alone, never starved forever
    const deadline = this.now() + maxWaitMs;
    let waited = false;
    for (;;) {
      const t = this.now();
      const { s10, s1 } = this._sums(t);
      if (s1 + cost1 <= this.cups) {
        this.log.push([t, cost]); this.admitted++;
        this.history.push([t, cost]); if (this.history.length > 5000) this.history.shift();   // exact admission times, for diagnostics and tests
        if (waited) this.delayed++;
        this.peak1s = Math.max(this.peak1s, s1 + cost); this.peak10s = Math.max(this.peak10s, s10 + cost);
        return true;
      }
      if (t >= deadline) { this.refused++; return false; }
      waited = true;
      await this.sleep(POLL_MS);
    }
  }
}

/**
 * Wrap a fetch(url, init): requests to a limited host are priced and admitted by that host's CuThrottle; everything else passes straight through.
 * -> { fetch, throttles: Map host -> CuThrottle, limits }
 */
function wrapFetch(realFetch, limits, { now = Date.now, sleep, maxWaitMs = MAX_WAIT_MS } = {}) {
  const throttles = new Map();
  for (const [h, cups] of Object.entries(limits)) throttles.set(h, new CuThrottle({ cups, now, sleep }));
  const find = (url) => { let u; try { u = new URL(url); } catch { return null; } return throttles.get(u.host.toLowerCase()) || throttles.get(u.hostname.toLowerCase()) || null; };
  const wrapped = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url);
    const th = find(url);
    if (!th) return realFetch(input, init);
    const ok = await th.admit(costOfBody(init && init.body), maxWaitMs);
    if (!ok) {
      let id = null; try { id = JSON.parse(init.body).id ?? null; } catch { /* batch or not JSON */ }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32005, message: 'client throttle: the provider\'s per-second compute-unit budget is used up, retry in a few seconds' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input, init);
  };
  return { fetch: wrapped, throttles, limits };
}

module.exports = { CU, DEFAULT_CU, WINDOW_MS, MAX_WAIT_MS, ALCHEMY_DEFAULT_CUPS, parseLimits, costOfBody, CuThrottle, wrapFetch };
