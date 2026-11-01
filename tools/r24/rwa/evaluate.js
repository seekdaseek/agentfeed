// tools/r24/rwa/evaluate.js: get_rwa_yields, the engine (R24, item 3).
//
// For each product: the price at the latest block (the issuer's on-chain oracle or vault, products.js), and the price at three past times, 1, 7 and 30 days before an anchor
// (the anchor is the latest block time rounded down to 6 hours, so the old reads are shared by every call in those 6 hours and cached for 6 hours):
//   history_source 'snapshots'  our own daily record (snapshots.js) has a row within 14 hours of that time
//   history_source 'contract'   otherwise: eth_call at the block nearest that time (needs an endpoint that serves old state)
// Yield = the product's convention (yield.js) over the real days between the two block times. Fail closed (the 503 "Not charged" refusal, tools/r23/common.js) when:
// an RPC read fails or cannot be trusted (reader.js), a price is outside the band the register allows, an oracle's own update time is too old, or the call's RPC budget is gone.
// A price that moved more than 1 percent in a day is not hidden: it is served with the flag price_moved_over_1_percent_in_one_day.
// Memory: three bounded Maps (history 64 entries, blocks 16, answers 16), nothing else retained between calls.
'use strict';

const { unavailable, bad, envNum } = require('../../r23/common');
const R = require('./rpc');
const RD = require('./reader');
const Y = require('./yield');
const SNAP = require('./snapshots');
const { PRODUCTS, CONVENTION } = require('./products');

const ANCHOR_S = 6 * 3600;
const WINDOWS = [7, 30];
const HISTORY_TTL_MS = 6 * 3600 * 1000;
const ANSWER_TTL_MS = 30 * 1000;
const CONCURRENCY = 4;
const DAY_MOVE_LIMIT = 0.01;
const FLAG_MOVE = 'price_moved_over_1_percent_in_one_day';

// ---- small bounded TTL map (insertion order eviction) ---------------------------------------------------------------------------------------------------------------------
function makeStore(max, ttlMs, now = Date.now) {
  const m = new Map();
  return {
    get(k) { const e = m.get(k); if (!e) return undefined; if (now() - e.at > ttlMs) { m.delete(k); return undefined; } return e.v; },
    set(k, v) { m.delete(k); m.set(k, { at: now(), v }); while (m.size > max) m.delete(m.keys().next().value); },
    delete(k) { m.delete(k); },
    size: () => m.size,
    entries: () => [...m].map(([k, e]) => [k, e.v]),
    clear: () => m.clear(),
  };
}
const SHARED = { history: makeStore(64, HISTORY_TTL_MS), blocks: makeStore(16, HISTORY_TTL_MS), answers: makeStore(16, ANSWER_TTL_MS), health: new Map() };
function resetShared() { SHARED.history.clear(); SHARED.blocks.clear(); SHARED.answers.clear(); SHARED.health.clear(); SNAP.closeReaders(); RD._decimalsMemo.clear(); }

async function pool(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  const worker = async () => { for (;;) { const i = next++; if (i >= items.length) return; try { out[i] = { ok: true, v: await fn(items[i], i) }; } catch (e) { out[i] = { ok: false, e }; } } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  const firstBad = out.find((o) => !o.ok);
  if (firstBad) throw firstBad.e;
  return out.map((o) => o.v);
}

const iso = (sec) => new Date(sec * 1000).toISOString();
const inBand = (p, raw) => { const n = Y.toNumber(raw, p.read.decimals); return n != null && n >= p.band[0] && n <= p.band[1]; };
const outOfBand = (p) => Object.assign(unavailable(`the on-chain price of ${p.name} is outside the range it can plausibly take, so it is withheld`, 600), { detail: 'band', product: p.id });

/** the product ids a request may name: the served products */
const servedIds = (list = PRODUCTS) => list.filter((p) => p.served).map((p) => p.id);

/** the products for a request: no `product` = all served; one id = that one. A value that is not a served id is the caller's error (400, before anything is read). */
function pick(arg, list = PRODUCTS) {
  const ids = servedIds(list);
  if (arg == null || arg === '') return list.filter((p) => p.served);
  // the sentence lib/query-rules.js words() gives for the same value, so the guard (before the paywall) and this handler (the MCP path) refuse in the same words
  const must = () => `product must be ${ids.length === 2 ? ids.join(' or ') : ids.slice(0, -1).join(', ') + ' or ' + ids[ids.length - 1]}`;
  if (typeof arg !== 'string') throw bad(must());
  const id = arg.toLowerCase();                  // exactly the way lib/query-rules.js words() reads it (String(v).toLowerCase()), so a rule there refuses nothing this serves
  const hit = list.find((p) => p.served && p.id === id);
  if (!hit) throw bad(must());
  return [hit];
}

/**
 * @param {object} o
 * @param {object[]} o.products  products to answer
 * @param {object} [o.deps]      { rpc, now, caches, snapshotDb, env, fetchImpl }  (tests inject; the real server passes nothing)
 */
async function evaluate({ products, deps = {} }) {
  const C = deps.caches || SHARED;
  if (deps.rpc || deps.noAnswerCache) return evaluateNow({ products, deps });
  // a burst of identical calls shares one evaluation (the promise is kept for 30 seconds; a refusal is not kept)
  const key = products.map((p) => p.id).sort().join(',');
  let pr = C.answers.get(key);
  if (!pr) { pr = evaluateNow({ products, deps }); C.answers.set(key, pr); pr.catch(() => C.answers.delete(key)); }
  return pr;
}

async function evaluateNow({ products, deps }) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const C = deps.caches || SHARED;

  const rpc = deps.rpc || R.makeRpc({ endpoints: R.endpointsFrom(env), fetchImpl: deps.fetchImpl, now, budget: envNum('R24_RWA_RPC_BUDGET', R.BUDGET, env), health: C.health });
  const snapDb = deps.snapshotDb !== undefined ? deps.snapshotDb : SNAP.openReader(SNAP.defaultPath(env), now);

  const head = await R.getBlock(rpc, 'latest', now);
  const anchorTs = Math.floor(head.ts / ANCHOR_S) * ANCHOR_S;
  const targets = { 1: anchorTs - 86400, 7: anchorTs - 7 * 86400, 30: anchorTs - 30 * 86400 };

  const blockFor = (days) => {
    const k = `blk|${targets[days]}`;
    let pr = C.blocks.get(k);
    if (!pr) { pr = R.blockAtOrBefore(rpc, head, targets[days]); C.blocks.set(k, pr); pr.catch(() => C.blocks.delete(k)); }
    return pr;
  };
  const contractPoint = (p, days) => {
    const k = `${p.id}|${targets[days]}|${days}`;
    let pr = C.history.get(k);
    if (!pr) {
      pr = (async () => { const b = await blockFor(days); const v = await RD.readAt(rpc, p, b.number, b.ts, { archive: true }); if (!inBand(p, v.raw)) throw outOfBand(p); return v; })();
      C.history.set(k, pr); pr.catch(() => C.history.delete(k));
    }
    return pr;
  };
  const point = async (p, days) => {
    const s = SNAP.nearest(snapDb, p, targets[days]);
    if (s && inBand(p, s.raw)) return { ...s, source: 'snapshots' };
    return { ...(await contractPoint(p, days)), source: 'contract' };
  };

  const answers = await pool(products, CONCURRENCY, async (p) => {
   try {
    await RD.checkDecimals(rpc, p, head.number, now);
    const latest = await RD.readAt(rpc, p, head.number, head.ts);
    if (!inBand(p, latest.raw)) throw outOfBand(p);
    if (p.staleSec != null && latest.updatedAt != null && head.ts - latest.updatedAt > p.staleSec) {
      throw Object.assign(unavailable(`the on-chain price of ${p.name} was last updated too long ago to be served`, 3600), { detail: 'stale', product: p.id });
    }
    const [d1, d7, d30] = await Promise.all([point(p, 1), point(p, 7), point(p, 30)]);
    return assembleProduct({ p, head, latest, hist: { 1: d1, 7: d7, 30: d30 } });
   } catch (e) { if (e && e.status === 503 && !e.product) e.product = p.id; throw e; }          // every refusal names its product
  }).catch((e) => {
    if (e && e.status === 503 && products.length > 1 && e.product) {
      const nm = (PRODUCTS.find((x) => x.id === e.product) || { name: e.product }).name; const m = e.message.replace(/\s*Not charged\.?$/, '');
      throw Object.assign(unavailable(`${m.includes(nm) ? m : `${nm}: ${m}`} Ask for one product at a time with product= (${servedIds().join(', ')}) to still get the others`, e.retryAfter || 300), { detail: e.detail, product: e.product });
    }
    throw e;
  });

  return answerOf(head, answers);
}

/** one product's answer from its readings: pure, so the constructed example and the tests use the same builder as the route */
function assembleProduct({ p, head, latest, hist }) {
  const nav = Y.toNumber(latest.raw, p.read.decimals);
  const y = {}; const win = {}; const src = {};
  for (const d of WINDOWS) {
    const h = hist[d];
    win[d] = Y.round(Y.days(head.ts, h.blockTs), 2);
    y[d] = Y.round(Y.annualized(p.convention, latest.raw, h.raw, Y.days(head.ts, h.blockTs)), 4);
    src[d] = h.source;
    if (y[d] == null) throw Object.assign(unavailable(`the yield of ${p.name} could not be computed from its readings`, 300), { detail: 'math', product: p.id });
  }
  const day = hist[1];
  const flags = [];
  const move = Y.ratio(latest.raw, day.raw);
  if (move != null && Math.abs(move - 1) > DAY_MOVE_LIMIT) flags.push(FLAG_MOVE);
  const sources = new Set(Object.values(src));
  return {
    product: p.id, name: p.name, issuer: p.issuer, asset_class: p.assetClass,
    chain: p.chain, contract: p.contract, contract_name: p.contractName, read_function: p.fn, decimals: p.read.decimals,
    nav: Y.round(nav, 8), nav_unit: 'USD per token', as_of: iso(head.ts), block: head.number,
    oracle_updated_at: latest.updatedAt != null ? iso(latest.updatedAt) : null,
    yield_7d_annualized: y[7], yield_30d_annualized: y[30], window_7d_days: win[7], window_30d_days: win[30],
    convention: CONVENTION[p.convention],
    history_source: sources.size === 1 ? [...sources][0] : 'contract',
    history_source_by_window: { '7d': src[7], '30d': src[30] },
    flags,
    issuer_docs: p.docs,
    method: `The price is read from ${p.contractName} (${p.contract}) on ${p.chain} with ${p.fn} at the latest block, and the same read is repeated at the block nearest 7 and 30 days earlier `
      + `(our own daily snapshots where they reach back that far, else eth_call at the old block). Yield is ${CONVENTION[p.convention]}, in percent per year, over the real days between the two blocks. `
      + 'It is realized yield, computed here from on-chain prices: not a forecast, and not a figure the issuer publishes.',
  };
}

function answerOf(head, products) {
  return { as_of: iso(head.ts), block: head.number, yield_unit: 'percent per year', count: products.length, products };
}

module.exports = { evaluate, assembleProduct, answerOf, pick, servedIds, makeStore, resetShared, SHARED, ANCHOR_S, WINDOWS, FLAG_MOVE, DAY_MOVE_LIMIT, HISTORY_TTL_MS, ANSWER_TTL_MS };
