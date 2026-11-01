// tools/r24/txprecheck/risk.js: the EXISTING token-risk reads, called as functions (never through the paid HTTP routes), for the tokens a transaction involves (R24 item 4).
//   Solana: tools/tokenrisk.js getTokenRisk(mint)  (mint and freeze authority, holder concentration)
//   Base:   tools/honeypot.js  getHoneypotCheck({ token, chain: 'base' })  (our own buy / transfer / sell simulation of the token against its deepest pool)
// A read that fails or is late is reported as unavailable for that token and never fails the whole answer. Tokens in the official tables (known.js) are not read.
// At most RISK_MAX_TOKENS reads per call, RISK_CONCURRENCY at a time, all inside one RISK_TIMEOUT_MS deadline; the rest are listed as not read.
'use strict';
const L = require('./limits');
const U = require('./util');

function defaultDeps() {
  return {
    solRisk: (mint) => require('../../tokenrisk').getTokenRisk(mint),
    baseRisk: (token) => require('../../honeypot').getHoneypotCheck({ token, chain: 'base' }),
  };
}

const reasonOf = (e) => (e && e.code === 'RISK_TIMEOUT' ? `the token-risk read did not finish within ${L.RISK_TIMEOUT_MS / 1000} s` : 'the token-risk read failed');

/**
 * Map id -> { available: true, read } | { available: false, reason } for the first RISK_MAX_TOKENS ids; ids beyond the cap are absent from the map.
 * All the reads share ONE deadline of RISK_TIMEOUT_MS from the moment this is called: a read still pending at the deadline is reported unavailable.
 */
async function readAll(ids, read, now = Date.now) {
  const todo = ids.slice(0, L.RISK_MAX_TOKENS);
  const end = now() + L.RISK_TIMEOUT_MS;
  const settled = await U.mapLimit(todo, L.RISK_CONCURRENCY, (id) => {
    const left = end - now();
    if (left <= 0) throw Object.assign(new Error('timeout'), { code: 'RISK_TIMEOUT' });
    return U.withTimeout(Promise.resolve().then(() => read(id)), left, () => Object.assign(new Error('timeout'), { code: 'RISK_TIMEOUT' }));
  });
  const out = new Map();
  todo.forEach((id, i) => out.set(id, settled[i].ok ? { available: true, read: settled[i].value } : { available: false, reason: reasonOf(settled[i].error) }));
  return out;
}

module.exports = { defaultDeps, readAll };
