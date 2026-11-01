// tools/r24/rwa/rpc.js: a small Ethereum JSON-RPC client for get_rwa_yields (R24, item 3).
//
// The endpoints are fixed by configuration (an operator's R24_RWA_RPC_ETH list first, then the public defaults below), never by the caller, so nothing a caller sends reaches a URL.
// Every request has a timeout and a response-size cap, every attempt counts against a per-evaluation budget, and a refusal or failure moves to the next endpoint:
//   - an endpoint that cannot serve old state (PublicNode answers "Archive requests require a personal token"; others say the state is not available) is skipped for that call
//   - a rate limit, a 5xx, a timeout, a body that is not JSON, a head older than HEAD_MAX_AGE_S, or a chain id other than 1 is a failure of that endpoint, and the next one is asked
//   - a JSON-RPC "execution reverted" is the contract's answer, so it is returned to the caller (no failover can change it)
// An endpoint that failed FAIL_LIMIT times in a row is left alone for COOLDOWN_MS. No URL, key or remote error text is ever put in an error message (a keyed provider's URL is a secret).
'use strict';

const { unavailable, envNum } = require('../../r23/common');

const DEFAULT_ENDPOINTS = ['https://eth.drpc.org', 'https://ethereum-rpc.publicnode.com'];
const TIMEOUT_MS = 6000;
const MAX_BYTES = 512 * 1024;
const BUDGET = 80;
const HEAD_MAX_AGE_S = 180;
const FAIL_LIMIT = 3;
const COOLDOWN_MS = 60 * 1000;
const CHAIN_OK_MS = 60 * 60 * 1000;

const ARCHIVE_RE = /archive|historical state|state .* (is )?not available|missing trie node|header not found|too old|pruned|no state available/i;

/** the endpoint list: env first (comma separated), then the defaults; only https (or loopback http, for tests); duplicates dropped */
function endpointsFrom(env = process.env, defaults = DEFAULT_ENDPOINTS) {
  const out = [];
  for (const raw of [...String(env.R24_RWA_RPC_ETH || '').split(','), ...(env.R24_RWA_RPC_DEFAULTS === 'off' ? [] : defaults)]) {
    const s = raw.trim();
    if (!s || out.includes(s)) continue;
    let u; try { u = new URL(s); } catch { continue; }
    const loop = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && loop)) out.push(s);
  }
  return out;
}

/**
 * @param {object} o
 * @param {string[]} o.endpoints
 * @param {typeof fetch} [o.fetchImpl]
 * @param {() => number} [o.now]
 * @param {number} [o.budget]    requests this client may send in total
 */
function makeRpc({ endpoints, fetchImpl = (...a) => fetch(...a), now = Date.now, budget = BUDGET, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, health = null }) {
  if (!endpoints || !endpoints.length) throw unavailable('no Ethereum RPC endpoint is configured', 3600);
  let used = 0; let id = 0;
  const state = health || new Map();                       // endpoint index -> { fails, until, chainOkAt }  (shared across clients when passed in; at most endpoints.length entries)
  const st = (i) => { let s = state.get(i); if (!s) { s = { fails: 0, until: 0, chainOkAt: 0 }; state.set(i, s); } return s; };

  async function post(i, method, params) {
    if (used >= budget) throw Object.assign(unavailable('the RPC request budget of this call was used up', 120), { detail: 'budget' });
    used++;
    const res = await fetchImpl(endpoints[i], { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* closed */ } return { http: res.status }; }
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > maxBytes) { try { await res.body?.cancel(); } catch { /* closed */ } return { http: 'size' }; }
    let text = '';
    if (res.body && res.body.getReader) {
      const rd = res.body.getReader(); const dec = new TextDecoder(); let n = 0;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        n += value.byteLength;
        if (n > maxBytes) { try { await rd.cancel(); } catch { /* closed */ } return { http: 'size' }; }
        text += dec.decode(value, { stream: true });
      }
      text += dec.decode();
    } else { text = await res.text(); if (text.length > maxBytes) return { http: 'size' }; }
    let j; try { j = JSON.parse(text); } catch { return { http: 'json' }; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { http: 'json' };
    return { j };
  }

  /** one call with failover. opts.archive: the call needs old state. opts.accept(result): false = that endpoint's answer is not usable, ask the next. Returns the result; throws a 503 "Not charged" when no endpoint could answer. */
  async function call(method, params, opts = {}) {
    let lastKind = 'none';
    const allResting = endpoints.every((_, i) => st(i).until > now());      // when every endpoint is resting, asking anyway beats a certain refusal
    for (let i = 0; i < endpoints.length; i++) {
      const s = st(i);
      if (s.until > now() && !allResting) continue;
      try {
        if (method !== 'eth_chainId' && now() - s.chainOkAt > CHAIN_OK_MS) {
          const c = await post(i, 'eth_chainId', []);
          if (!c.j || c.j.result !== '0x1') throw Object.assign(new Error('chain'), { endpoint: true });
          s.chainOkAt = now();
        }
        const r = await post(i, method, params);
        if (r.http) throw Object.assign(new Error('http'), { endpoint: true, kind: String(r.http) });
        const j = r.j;
        if (j.error) {
          const code = Number(j.error.code); const msg = String(j.error.message || '');
          if (code === 3 || /execution reverted/i.test(msg)) { s.fails = 0; throw Object.assign(unavailable('a contract read reverted', 300), { detail: 'revert', revert: true }); }
          if (ARCHIVE_RE.test(msg) || (code === -32602 && /archive/i.test(msg))) { lastKind = 'archive'; continue; }   // this endpoint cannot serve old state: not a failure of the endpoint
          throw Object.assign(new Error('rpc'), { endpoint: true, kind: `rpc${code}` });
        }
        if (!('result' in j)) throw Object.assign(new Error('rpc'), { endpoint: true, kind: 'noresult' });
        if (opts.accept && !opts.accept(j.result)) throw Object.assign(new Error('invalid'), { endpoint: true, kind: 'invalid' });      // an answer of the wrong shape (or a head that is old) is that endpoint's fault: ask the next one
        s.fails = 0;
        return j.result;
      } catch (e) {
        if (e && e.revert) throw e;
        if (e && e.detail === 'budget') throw e;
        if (e && e.status === 503) throw e;
        lastKind = (e && e.kind) || (e && e.name === 'TimeoutError' ? 'timeout' : (e && e.name) || 'error');
        s.fails++; if (s.fails >= FAIL_LIMIT) { s.until = now() + COOLDOWN_MS; s.fails = 0; }
      }
    }
    throw Object.assign(unavailable(opts.archive && lastKind === 'archive' ? 'no configured Ethereum RPC endpoint serves old state right now' : 'the Ethereum RPC endpoints could not answer right now', 120), { detail: lastKind });
  }

  return { call, used: () => used, state, endpoints: () => endpoints.length };
}

const hex = (n) => '0x' + BigInt(n).toString(16);

/** a block as {number, ts}; tag is 'latest' or a number. The head must be recent: an endpoint that is behind is skipped like one that is down. */
async function getBlock(rpc, tag, now = Date.now) {
  const parse = (b) => {
    if (!b || typeof b !== 'object' || typeof b.number !== 'string' || typeof b.timestamp !== 'string' || !/^0x[0-9a-f]+$/i.test(b.number) || !/^0x[0-9a-f]+$/i.test(b.timestamp)) return null;
    const out = { number: Number(BigInt(b.number)), ts: Number(BigInt(b.timestamp)) };
    return Number.isSafeInteger(out.number) && out.number > 0 && Number.isSafeInteger(out.ts) && out.ts > 0 ? out : null;
  };
  const accept = (b) => { const o = parse(b); return !!o && (tag !== 'latest' || Math.abs(now() / 1000 - o.ts) <= HEAD_MAX_AGE_S) && (tag === 'latest' || o.number === Number(tag)); };
  const b = await rpc.call('eth_getBlockByNumber', [tag === 'latest' ? 'latest' : hex(tag), false], { archive: tag !== 'latest', accept });
  return parse(b);
}

/**
 * The latest block whose timestamp is <= targetTs, found from a nearby block by stepping with the 12-second slot time (a handful of getBlock calls, never a scan).
 * `head` is the newest block; blocks never move, so the result is the same for every caller asking the same targetTs.
 */
async function blockAtOrBefore(rpc, head, targetTs, slot = 12) {
  if (targetTs >= head.ts) return head;
  let n = Math.max(1, head.number - Math.ceil((head.ts - targetTs) / slot));
  let b = await getBlock(rpc, n);
  for (let k = 0; k < 8 && Math.abs(b.ts - targetTs) > slot; k++) {
    const step = Math.round((targetTs - b.ts) / slot) || (targetTs > b.ts ? 1 : -1);
    n = Math.min(Math.max(1, b.number + step), head.number);
    if (n === b.number) break;
    b = await getBlock(rpc, n);
  }
  // settle on the last block at or before the target: step back while after it, forward while the next is still at or before it
  for (let k = 0; k < 6 && b.ts > targetTs && b.number > 1; k++) b = await getBlock(rpc, b.number - 1);
  for (let k = 0; k < 6 && b.number < head.number && targetTs - b.ts >= slot; k++) {      // after the merge slots are exact multiples of 12 s: the next block can only be at or before the target when 12 s or more are left
    const nx = await getBlock(rpc, b.number + 1);
    if (nx.ts > targetTs) break;
    b = nx;
  }
  if (b.ts > targetTs) throw unavailable('could not place a past block in time', 120);
  return b;
}

module.exports = { makeRpc, endpointsFrom, getBlock, blockAtOrBefore, hex, DEFAULT_ENDPOINTS, TIMEOUT_MS, MAX_BYTES, BUDGET, HEAD_MAX_AGE_S, FAIL_LIMIT, COOLDOWN_MS, envNum };
