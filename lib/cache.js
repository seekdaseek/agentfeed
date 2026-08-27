// lib/cache.js — shared TTL memo + fetchJson. Every expansion tool caches, so
// 26 new tools don't multiply upstream calls. Promise-cached: concurrent
// identical calls collapse into one upstream request.
'use strict';
const store = new Map(); // key -> { at, ttl, p }

async function cached(key, ttlMs, fn) {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.p;
  const p = Promise.resolve().then(fn);
  store.set(key, { at: Date.now(), ttl: ttlMs, p });
  try {
    return await p;
  } catch (e) {
    store.delete(key); // never cache failures
    throw e;
  }
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(opts.timeoutMs || 8000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (now - v.at > v.ttl * 2) store.delete(k);
}, 60_000).unref();

module.exports = { cached, fetchJson };
