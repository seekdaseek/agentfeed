// test/fixtures/r24/rwa/chain.js: a synthetic Ethereum for the get_rwa_yields tests (R24, item 3). Not a recording of anything: blocks are 12 seconds apart (optionally with missed slots), every
// product of the register has a price that grows at a made-up yearly rate, and a fetch stub answers JSON-RPC for any number of endpoint URLs, each with its own behaviour.
// Nothing here touches a network.
'use strict';
const { PRODUCTS } = require('../../../../tools/r24/rwa/products');

const HEAD = 26000000;
const HEAD_TS = 1793600000 - (1793600000 % 12);      // a multiple of 12, like every post-merge slot
const SLOT = 12;
const DEFAULT_RATE = { usdy: 0.0372, ousg: 0.0405, ustb: 0.0391, usyc: 0.0412, tbill: 0.0398, mtbill: 0.0409, syrupusdc: 0.0634 };
const BASE = { usdy: 1.1, ousg: 112, ustb: 11.2, usyc: 1.14, tbill: 1.16, mtbill: 1.17, syrupusdc: 1.19 };      // the price at HEAD_TS

const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const signedWord = (n) => (n < 0n ? (n + (1n << 256n)) : n).toString(16).padStart(64, '0');
const lower = (a) => a.toLowerCase();

/**
 * @param {object} [o]
 * @param {number} [o.headTs]         the time of the head block (default HEAD_TS; a multiple of 12)
 * @param {number} [o.now]            the clock the tests use (ms); default headTs + 5 s
 * @param {number[]} [o.gaps]         block numbers g after which one slot was missed (block g+1 is 24 s after g)
 * @param {Record<string,(ts:number)=>bigint>} [o.price]   override: raw price of a product at a time
 * @param {Record<string,number>} [o.updatedAge]   round feeds: seconds between the block time and the feed's updatedAt (default 3 h)
 * @param {Record<string,string>} [o.rawResult]    force the raw eth_call result of a product (any block)
 * @param {Record<string,number>} [o.decimals]     what decimals() answers for a feed
 * @param {string[]} [o.revert]                    products whose contract reverts
 * @param {string[]} [o.failOld]                   products whose contract reverts for any block older than the head
 */
function makeChain(o = {}) {
  const headTs = o.headTs ?? HEAD_TS;
  const gaps = (o.gaps || []).slice().sort((a, b) => a - b);
  const tsOf = (n) => headTs - (HEAD - n) * SLOT - SLOT * gaps.filter((g) => g >= n && g < HEAD).length;
  const priceOf = (p, ts) => {
    if (o.price && o.price[p.id]) return o.price[p.id](ts);
    const yearsAgo = (headTs - ts) / (365 * 86400);
    const level = BASE[p.id] * (1 - DEFAULT_RATE[p.id] * yearsAgo);
    return BigInt(Math.round(level * 1e8)) * 10n ** BigInt(p.read.decimals) / 100000000n;
  };
  const byAddr = new Map(PRODUCTS.map((p) => [lower(p.contract), p]));
  const ethCall = (n, call) => {
    const p = byAddr.get(lower(call.to || ''));
    if (!p || (o.revert || []).includes(p.id) || ((o.failOld || []).includes(p.id) && n < HEAD - 100)) return { revert: true };
    const sel = String(call.data || '').slice(0, 10);
    if (sel === '0x313ce567' && p.read.kind === 'round') return { result: '0x' + word((o.decimals && o.decimals[p.id]) ?? p.read.decimals) };
    if (o.rawResult && o.rawResult[p.id] != null) return { result: o.rawResult[p.id] };
    const ts = tsOf(n);
    const raw = priceOf(p, ts);
    if (p.read.kind === 'round') {
      if (sel !== '0xfeaf968c') return { revert: true };
      const age = (o.updatedAge && o.updatedAge[p.id]) ?? 3 * 3600;
      const upd = BigInt(ts - age);
      return { result: '0x' + word(n) + signedWord(raw) + word(upd) + word(upd) + word(n) };
    }
    if (String(call.data).toLowerCase() !== p.read.data.toLowerCase()) return { revert: true };
    return { result: '0x' + word(raw) };
  };
  const block = (n) => ({ number: '0x' + n.toString(16), timestamp: '0x' + tsOf(n).toString(16), hash: '0x' + word(n) });

  const calls = [];
  /** behaviours per endpoint URL: { mode } with mode ok | down | timeout | badjson | wrongchain | archive | big | rate | oldhead | notfound */
  function fetchFor(endpoints) {
    return async (url, init) => {
      const cfg = endpoints[url];
      if (!cfg) throw new Error('unexpected url');
      const body = JSON.parse(init.body);
      calls.push({ url, method: body.method, params: body.params });
      // 'big': a VALID answer padded to 600 KB (no content-length, so the streaming cap must stop it); 'bigcl': a valid answer whose content-length header says 600 KB.
      // Both are answers that would be accepted if nothing capped them, so the test sees whether the cap is what moved the client on.
      const reply = (j, status = 200) => {
        const o = { jsonrpc: '2.0', id: body.id, ...j };
        if (cfg.mode === 'big') o.padding = 'x'.repeat(600 * 1024);
        return new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...(cfg.mode === 'bigcl' ? { 'content-length': String(600 * 1024) } : {}) } });
      };
      const mode = cfg.mode || 'ok';
      if (mode === 'down') return new Response('bad gateway', { status: 502 });
      if (mode === 'rate') return new Response('slow down', { status: 429 });
      if (mode === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      if (mode === 'hang') {
        const sig = init.signal;
        const aborted = await new Promise((resolve) => { const t = setTimeout(() => resolve(false), 1500); if (sig) sig.addEventListener('abort', () => { clearTimeout(t); resolve(true); }, { once: true }); });
        if (aborted) throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      }
      if (mode === 'badjson') return new Response('<html>not json</html>', { status: 200 });
      if (body.method === 'eth_chainId') return reply({ result: mode === 'wrongchain' ? '0xaa36a7' : '0x1' });
      if (body.method === 'eth_getBlockByNumber') {
        const tag = body.params[0];
        const n = tag === 'latest' ? HEAD : Number(BigInt(tag));
        if (mode === 'archive' && n < HEAD - 100) return reply({ error: { code: -32602, message: 'Archive requests require a personal token. Get one at: https://example.invalid' } });
        if (n > HEAD || n < 1) return reply({ result: null });
        const b = block(n);
        if (mode === 'oldhead' && tag === 'latest') b.timestamp = '0x' + (tsOf(n) - 3600).toString(16);
        return reply({ result: b });
      }
      if (body.method === 'eth_call') {
        const n = Number(BigInt(body.params[1]));
        if (mode === 'archive' && n < HEAD - 100) return reply({ error: { code: -32602, message: 'Archive requests require a personal token. Get one at: https://example.invalid' } });
        if (cfg.noState && n < HEAD - cfg.noState) return reply({ error: { code: -32000, message: 'historical state 0xabc is not available' } });
        const r = ethCall(n, body.params[0]);
        if (r.revert) return reply({ error: { code: 3, message: 'execution reverted' } });
        return reply({ result: r.result });
      }
      return reply({ error: { code: -32601, message: 'method not found' } });
    };
  }
  return { HEAD, HEAD_TS: headTs, tsOf, priceOf, calls, fetchFor, now: (o.now ?? (headTs + 5) * 1000), clock: () => (o.now ?? (headTs + 5) * 1000) };
}

module.exports = { makeChain, HEAD, HEAD_TS, SLOT, DEFAULT_RATE, BASE };
