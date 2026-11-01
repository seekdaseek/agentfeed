// tools/r24/txprecheck/solana.js: the I/O half of GET /api/tx-precheck for chain=solana (R24 item 4). It decodes the transaction, reads the state it touches, SIMULATES it on our own RPC
// (simulateTransaction: sigVerify false, replaceRecentBlockhash true, accounts returned for every writable account, innerInstructions true) and hands the facts to sol-assess.js.
// It never signs and never sends: there is no method in this file that could. A transaction that FAILS in the simulation is still an answer (simulation.ok false); an RPC that cannot simulate is a 503, not charged.
// Calls per request on Alchemy (compute units, alchemy.com/docs/reference/compute-unit-costs read 1 Nov 2026): getMultipleAccounts 20 (state before) + simulateTransaction 20, plus 20 for a v0 transaction's
// lookup tables and 10 to 30 per unknown token (tools/tokenrisk.js: getAccountInfo 10 for the mint, 10 for its metadata, getTokenLargestAccounts 20).
'use strict';
const { bad, unavailable } = require('../../r23/common');
const Kn = require('./known');
const L = require('./limits');
const O = require('./sol-ops');
const A = require('./sol-assess');
const R = require('./risk');
const U = require('./util');

const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';

function defaultDeps() {
  const SR = require('../../../lib/solrpc');
  return { rpc: (method, params, opts) => SR.rpc(method, params, opts), now: Date.now, ...R.defaultDeps() };
}

/** getMultipleAccounts over many addresses (100 per request); Map address -> raw account | null, and the lowest slot seen */
async function fetchAccounts(rpc, addresses, timeoutMs) {
  const map = new Map(); let slot = null;
  const parts = await Promise.all(U.chunk(addresses, 100).map((part) => rpc('getMultipleAccounts', [part, { encoding: 'jsonParsed', commitment: 'confirmed' }], { timeoutMs }).then((r) => ({ part, r }))));
  for (const { part, r } of parts) {
    if (!r || !Array.isArray(r.value) || r.value.length !== part.length) throw unavailable('the Solana RPC answered a state read with an unexpected shape', L.RETRY_AFTER_S);
    part.forEach((a, i) => map.set(a, r.value[i] || null));
    const s = r.context && r.context.slot; if (s != null) slot = slot == null ? s : Math.min(slot, s);
  }
  return { map, slot };
}

/** the full answer for one Solana transaction (a base64 string in q.tx) */
async function precheckSolana(q, deps = defaultDeps()) {
  const input = O.parseInput(q.tx);                                   // 400 before any RPC: base64, size cap
  const d = O.decodeTx(input.bytes);                                  // 400 before any RPC: not a legacy or v0 transaction
  const started = deps.now();
  const simMs = deps.simTimeoutMs || L.SIM_TIMEOUT_MS;                  // tests shorten it; the route always uses the 8 s cap
  const left = () => Math.max(300, simMs - (deps.now() - started));

  const gather = async () => {
    const tables = new Map();
    if (d.lookups.length) {
      const addrs = U.unique(d.lookups.map((l) => l.table));
      const r = await deps.rpc('getMultipleAccounts', [addrs, { encoding: 'base64', commitment: 'confirmed' }], { timeoutMs: left() });
      addrs.forEach((t, i) => {
        const v = r && r.value && r.value[i];
        if (!v) throw bad(`address lookup table ${t} does not exist`);
        if (v.owner !== ALT_PROGRAM) throw bad(`${t} is not an address lookup table`);
        tables.set(t, O.tableAddresses(v.data[0]));
      });
    }
    const { keys } = O.buildKeys(d, tables);
    const instructions = O.resolveInstructions(d, keys);
    const topOps = O.topOps(instructions);
    const writable = U.unique(keys.filter((k) => k.writable).map((k) => k.address));
    const want = U.unique([...writable, ...keys.filter((k) => k.signer).map((k) => k.address), ...topOps.filter((o) => o.op === 'ata_create').map((o) => o.wallet).filter(Boolean)]);
    const sim = deps.rpc('simulateTransaction', [input.b64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', innerInstructions: true, accounts: { encoding: 'jsonParsed', addresses: writable } }], { timeoutMs: left() });
    const [before, simRes] = await Promise.all([fetchAccounts(deps.rpc, want, left()), sim]);
    const value = simRes && simRes.value;
    if (!value || typeof value !== 'object') throw unavailable('the Solana RPC answered the simulation with an unexpected shape', L.RETRY_AFTER_S);
    const ok = value.err == null;
    const post = ok && Array.isArray(value.accounts) && value.accounts.length === writable.length ? new Map(writable.map((a, i) => [a, value.accounts[i] || null])) : null;
    const f = {
      d, keys, instructions, topOps, innerOps: O.innerOps(value.innerInstructions), inner: value.innerInstructions || [], pre: before.map, post,
      sim: { ok, err: value.err ?? null, logs: value.logs || [], unitsConsumed: value.unitsConsumed ?? null, fee: value.fee ?? null, slot: simRes.context ? simRes.context.slot : null }, preSlot: before.slot,
    };
    const extra = A.needsPre(f);
    if (extra.length) { const more = await fetchAccounts(deps.rpc, extra, left()); for (const [a, v] of more.map) f.pre.set(a, v); }
    return f;
  };
  const f = await U.withTimeout(gather(), simMs, () => unavailable(`the simulation did not finish within ${L.SIM_TIMEOUT_MS / 1000} s`, L.RETRY_AFTER_S));

  const mints = A.involvedMints(f).filter((m) => !Kn.solMint(m));
  f.risk = await R.readAll(mints, deps.solRisk, deps.now);
  f.at = new Date(deps.now()).toISOString();
  return A.assessSolana(f);
}

module.exports = { precheckSolana, fetchAccounts, defaultDeps };
