// tools/r24/txprecheck/base-rpc.js: the JSON-RPC client for Base used by GET /api/tx-precheck (R24 item 4). It only POSTs to the fixed endpoint list below (never to a URL taken from the caller),
// tries the endpoints in order, and treats a transport failure, a rate limit or an unsupported method as "try the next one". An answer that is a finding about the transaction itself (the
// simulate-spec execution errors) is returned as { error } instead. When no endpoint answers: a 503, not charged.
// Endpoints: BASE_SIM_RPC (or mainnet.base.org), then base.drpc.org: the same two the honeypot check uses, both keyless, terms in docs/SOURCES.md. TXPRECHECK_BASE_RPCS (comma list) replaces them.
'use strict';
const { unavailable } = require('../../r23/common');
const L = require('./limits');

const defaultUrls = (env = process.env) => {
  const own = String(env.TXPRECHECK_BASE_RPCS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return own.length ? own : [env.BASE_SIM_RPC || 'https://mainnet.base.org', 'https://base.drpc.org'];
};

/** the error codes eth_simulateV1 uses for "this transaction cannot execute" (execution-apis, eth_simulateV1): the transaction's problem, not the node's */
const isExecutionError = (e) => e && typeof e.code === 'number' && ((e.code >= -38026 && e.code <= -38010) || e.code === -32015);

function makeBaseRpc({ urls = defaultUrls(), fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  /** -> { result, host } | { error, host } (execution error only); throws the 503 when no endpoint answers */
  async function request(method, params, { timeoutMs = L.SIM_TIMEOUT_MS } = {}) {
    let last = 'no endpoint configured';
    for (const url of urls) {
      let host = ''; try { host = new URL(url).host; } catch { /* keep empty */ }
      try {
        const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(Math.max(250, timeoutMs)) });
        const j = await res.json().catch(() => null);
        if (j && j.error == null && 'result' in j) return { result: j.result, host };
        if (j && j.error && isExecutionError(j.error)) return { error: j.error, host };
        last = j && j.error ? `${method}: ${String(j.error.message || j.error.code).slice(0, 80)}` : `${method}: HTTP ${res.status}`;
      } catch (e) { last = `${method}: ${(e && e.name === 'TimeoutError') ? 'timeout' : String((e && e.message) || e).slice(0, 80)}`; }
    }
    throw unavailable(`Base RPC unavailable (${last})`, L.RETRY_AFTER_S);
  }
  return { request, urls };
}

module.exports = { makeBaseRpc, defaultUrls, isExecutionError };
