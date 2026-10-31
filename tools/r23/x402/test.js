// tools/r23/x402/test.js: x402-test, one REAL paid call to a seller's endpoint from OUR dedicated wallet (R23 T3, 31 Oct 2026).
//
// Who pays what: the caller pays the route's flat price to AgentFeed. The seller's own price is paid by the test wallet, never above X402TEST_PER_CALL_USD (default 0.05), never above
// X402TEST_PER_DAY_USD (default 2) in a UTC day (tools/r23/spend.js: reserve BEFORE signing, settle with the real amount, release when nothing was sent).
//
// Order of things, and which refusal each step can raise (503 and 404 are "Not charged"; a finding about the SELLER is a 200 and is charged):
//   1. input: method, https URL, the address guard                          bad          400
//   2. the wallet files exist and are usable                                unavailable  503   (before any request to the seller)
//   3. the lint (unpaid; https only; includes the HEAD and spelling probes)  guard refusal 400; endpoint unreachable 503
//        no 402 / no readable challenge / a redirect                          FAIL         200   (nothing is paid)
//        a 402 that is only MPP, or no Base or Solana exact USDC offer,       notCovered   404
//        or every payable offer above the per-call cap
//        the Base or Solana offers are malformed                              FAIL         200
//   4. a funded chain (balance read; an error is never "unfunded = pass")   unavailable  503
//   5. a second unpaid read: the offer (network, asset, payTo, amount) must be what was linted   FAIL 200 when it is not (nothing is paid)
//   6. reserve the spend (503 when a cap is hit), sign ONE payment from the linted offer only, check the signed payload pays exactly that offer
//   7. ONE paid request to the linted URL, redirects off, through safe-fetch's guard; never a second payment or a retry
//   8. the verdict: PASS, FAIL (the seller did something wrong) or INCONCLUSIVE (no way to tell), and the spend is settled, or released when nothing was sent
// deps (all optional, for tests): fetch, checkUrl, now, hrnow, loadWallets, balance {base, solana}, spend, caps, createPayment, solanaRpcUrl, env.
'use strict';
const R = require('./rubric');
const P = require('./parse');
const L = require('./lint');
const W = require('./wallet');
const PAY = require('./pay');
const { bad, unavailable, notCovered } = require('../common');
const spendLib = () => require('../spend');   // lazy: tools/r23/spend.js opens better-sqlite3, which a lint (or the example) never needs

const SCOPE = 'x402test';
const DEFAULT_CAPS = { perCall: 0.05, perDay: 2 };
const PAID_TIMEOUT_MS = 10000;
const sf = () => require('../../../lib/safe-fetch');

let spendHandle = null;     // one open ledger handle per process (tools/r23/spend.js keeps no cache of its own)
function realSpend(env) {
  if (!spendHandle) {
    try { const { makeSpend, capsFromEnv } = spendLib(); spendHandle = makeSpend({ caps: { [SCOPE]: capsFromEnv('X402TEST', DEFAULT_CAPS, env) } }); } catch { throw unavailable('the spend ledger of the test wallet could not be opened', 300); }
  }
  return spendHandle;
}

function depsOf(deps = {}) {
  const env = deps.env || process.env;
  return {
    env,
    fetch: deps.fetch || ((u, o) => sf().safeFetch(u, o)),
    checkUrl: deps.checkUrl || ((u, o) => sf().checkUrl(u, o)),
    now: deps.now || Date.now,
    hrnow: deps.hrnow || (() => Number(process.hrtime.bigint() / 1000000n)),
    loadWallets: async () => {                                  // X402TEST_CHAINS (default base,solana) can switch a chain off, e.g. to keep the Solana libraries out of memory
      const w = await (deps.loadWallets || (() => W.loadWallets({ env })))();
      const on = new Set(String(env.X402TEST_CHAINS || 'base,solana').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
      return { ...w, base: on.has('base') ? w.base : null, solana: on.has('solana') ? w.solana : null };
    },
    balance: deps.balance || { base: (a) => W.baseUsdcBalance(a, { env }), solana: (a) => W.solanaUsdcBalance(a) },
    spend: deps.spend ? () => deps.spend : () => realSpend(env),
    caps: deps.caps || spendLib().capsFromEnv('X402TEST', DEFAULT_CAPS, env),
    createPayment: deps.createPayment || PAY.createPayment,
    timeouts: { main: deps.mainTimeoutMs || R.LIMITS.mainTimeoutMs, probe: deps.probeTimeoutMs || R.LIMITS.probeTimeoutMs, paid: deps.paidTimeoutMs || PAID_TIMEOUT_MS },
    solanaRpcUrl: deps.solanaRpcUrl !== undefined ? deps.solanaRpcUrl : (env.X402TEST_SOLANA_RPC_URL || undefined),
  };
}

const unwrap = (a) => (a && typeof a === 'object' ? a : {});
function parseArgs(args) {
  const a = unwrap(args);
  const stray = Object.keys(a).find((k) => k !== 'url' && k !== 'method');
  if (stray !== undefined) throw bad(`unknown parameter ${String(stray).slice(0, 40)}: the url value must be URL-encoded as a whole (a ? inside it is %3F and a & is %26)`);
  if (Array.isArray(a.url) || Array.isArray(a.method)) throw bad('url and method must each be given once');
  const m = String(a.method == null || a.method === '' ? 'GET' : a.method).toUpperCase();
  if (m !== 'GET' && m !== 'POST') throw bad('method must be GET or POST');
  if (typeof a.url !== 'string' || a.url.trim() === '') throw bad('url is required: the x402 endpoint to check, URL-encoded');
  if (a.url.length > 2048) throw bad('url is longer than 2048 characters');
  return { url: a.url.trim(), method: m };
}

// ---- which offer to pay
const CHAINS = ['base', 'solana'];
const SAFE_FLOW = (ex) => !((ex.assetTransferMethod && ex.assetTransferMethod !== 'eip3009') || (ex.paymentFlow && ex.paymentFlow !== 'authorization'));
const tag = (o) => `accepts[${o.index}] (${P.show(o.network, 40)})`;

/** the offers of a graded challenge sorted into: payable (candidates), malformed, not supported by this test, over the cap. Pure. */
function classifyOffers(offers, ver, capUsd) {
  const out = { candidates: [], malformed: [], unsupported: [], overCap: [], onChain: 0 };
  for (const o of offers) {
    const chain = CHAINS.find((c) => o.network === R.PAYABLE[c][ver === 2 ? 'v2' : 'v1']);
    if (!chain) continue;
    out.onChain++;
    if (o.scheme !== 'exact') { out.unsupported.push(`${tag(o)}: the ${P.show(o.scheme, 20)} scheme is not paid by this test`); continue; }
    const want = R.PAYABLE[chain].asset;
    const assetOk = typeof o.asset === 'string' && (chain === 'base' ? o.asset.toLowerCase() === want.toLowerCase() : o.asset === want);
    if (!assetOk) { out.unsupported.push(`${tag(o)}: the asset ${P.show(o.asset, 44)} is not USDC`); continue; }
    const ex = o.entry.extra && typeof o.entry.extra === 'object' && !Array.isArray(o.entry.extra) ? o.entry.extra : {};
    if (!SAFE_FLOW(ex)) { out.unsupported.push(`${tag(o)}: the payment flow it asks for (${P.show(ex.assetTransferMethod || ex.paymentFlow, 20)}) is not the plain signed transfer this test makes`); continue; }
    const probs = [];
    if (!P.isAtomic(o.amount)) probs.push('the amount is not a positive integer string');
    if (!(chain === 'base' ? P.isEvmAddr(o.payTo) : P.isSolAddr(o.payTo))) probs.push('the payTo is not an address of its network');
    if (!Number.isInteger(o.entry.maxTimeoutSeconds) || o.entry.maxTimeoutSeconds <= 0) probs.push('maxTimeoutSeconds is not a positive integer');
    if (chain === 'base' && !(typeof ex.name === 'string' && ex.name && typeof ex.version === 'string' && ex.version)) probs.push('extra.name and extra.version are missing');
    if (chain === 'solana' && !P.isSolAddr(ex.feePayer)) probs.push('extra.feePayer is missing or is not an address');
    if (probs.length) { out.malformed.push(`${tag(o)}: ${probs.join('; ')}`); continue; }
    if (o.entry.maxTimeoutSeconds > R.LIMITS.timeoutMax) { out.unsupported.push(`${tag(o)}: maxTimeoutSeconds ${o.entry.maxTimeoutSeconds} would keep a signed payment usable for more than an hour`); continue; }
    const usd = Number(BigInt(o.amount)) / 1e6;
    if (usd > capUsd + 1e-9) { out.overCap.push({ tag: tag(o), usd }); continue; }
    out.candidates.push({ offer: o, chain, usd });
  }
  return out;
}

/** cheapest first; on a tie version 2 before 1 is irrelevant (one challenge), Base before Solana */
const order = (a, b) => a.usd - b.usd || CHAINS.indexOf(a.chain) - CHAINS.indexOf(b.chain) || a.offer.index - b.offer.index;

// ---- the second, unpaid read
const keyOf = (scheme, network, asset, payTo, amount) => JSON.stringify([scheme, network, String(asset).toLowerCase(), String(payTo).toLowerCase(), String(amount)]);
const rawKey = (e, ver) => keyOf(e.scheme, e.network, e.asset, e.payTo, ver === 1 ? e.maxAmountRequired : e.amount);
async function reread(d, href, method, pick, lintInternals) {
  let r;
  try {
    r = await d.fetch(href, { maxBytes: R.LIMITS.maxBytes, timeoutMs: d.timeouts.main, userAgent: L.UA, accept: 'application/json, */*;q=0.1', method, httpsOnly: true, maxRedirects: 0, acceptStatus: () => true, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' } } : {}) });
  } catch (e) {
    if (/^more than 0 redirects$/.test(String(e && e.message))) return { fail: ['a second unpaid request to the same URL was redirected; a payment is never sent across a redirect'] };
    throw L.refuse(e);
  }
  const res = { ...r, headers: Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v])), body: r.body || Buffer.alloc(0), contentType: r.contentType || '' };
  if (res.status !== 402) return { fail: [`a second unpaid request to the same URL answered HTTP ${res.status}, not the 402 it answered first`] };
  const loc = P.locate(res);
  const ch = [loc.primary, loc.secondary].find((c) => c && c.source === lintInternals.primary.source);
  const accepts = ch && Array.isArray(ch.value.accepts) ? ch.value.accepts : null;
  if (!accepts) return { fail: ['a second unpaid request to the same URL carried no readable challenge'] };
  const want = keyOf(pick.offer.scheme, pick.offer.network, pick.offer.asset, pick.offer.payTo, pick.offer.amount);
  if (accepts.some((e) => e && typeof e === 'object' && rawKey(e, lintInternals.ver) === want)) return { ok: true };
  const near = accepts.find((e) => e && typeof e === 'object' && e.network === pick.offer.network && e.scheme === pick.offer.scheme && String(e.asset).toLowerCase() === String(pick.offer.asset).toLowerCase());
  if (!near) return { fail: [`the ${P.show(pick.offer.network, 40)} offer of the first answer is not in a second answer to the same request`] };
  const diff = [];
  const amt = lintInternals.ver === 1 ? near.maxAmountRequired : near.amount;
  if (String(near.payTo).toLowerCase() !== String(pick.offer.payTo).toLowerCase()) diff.push(`payTo was ${P.show(pick.offer.payTo, 50)} and is now ${P.show(near.payTo, 50)}`);
  if (String(amt) !== String(pick.offer.amount)) diff.push(`the amount was ${P.show(pick.offer.amount, 30)} and is now ${P.show(amt, 30)}`);
  return { fail: [`the offer changed between two unpaid requests to the same URL: ${diff.join('; ') || 'another field differs'}. Nothing was paid: a payment goes only to the payTo that was linted`] };
}

// ---- the verdict on a paid response
function shapeOf(res) {
  const body = res.body || Buffer.alloc(0);
  const out = { status: res.status, content_type: res.contentType || null, size_bytes: body.length, valid_json: false };
  if (body.length) {
    try {
      const v = JSON.parse(body.toString('utf8').replace(/^﻿/, ''));
      out.valid_json = true;
      if (Array.isArray(v)) { out.json_type = 'array'; out.json_items = v.length; } else if (v && typeof v === 'object') { out.json_type = 'object'; out.json_keys = Object.keys(v).slice(0, 20).map((k) => P.show(k, 40)); } else out.json_type = typeof v;
    } catch { /* not JSON */ }
  }
  return out;
}

/** -> { verdict, reasons, notes, response, settlement, spend: 'settle' | 'release' } */
function judge({ res, err, offer, payer, ver }) {
  const J = (verdict, reasons, spend, extra = {}) => ({ verdict, reasons, notes: [], response: null, settlement: null, spend, ...extra });
  if (err) {
    const m = String((err && err.message) || '');
    if (/^more than 0 redirects$/.test(m)) return J('FAIL', ['the endpoint answered the paid request with a redirect; the payment header was sent only to the URL that was linted and was not forwarded'], 'settle');
    if (err.kind === 'bad_request' && (/^refused:/.test(m) || /does not resolve$/.test(m))) return J('INCONCLUSIVE', [`the paid request was refused before it was sent (${P.show(m, 100)}): the endpoint's address changed since the lint. Nothing was paid`], 'release');
    if (err.kind === 'bad_request') return J('FAIL', [`the paid response could not be read: ${P.show(m, 100)}`], 'settle');
    return J('INCONCLUSIVE', [`no usable answer to the paid request (${P.show(m, 100)}). The payment may or may not have settled, so it is counted as spent`], 'settle');
  }
  const status = res.status;
  const response = shapeOf(res);
  if (status >= 200 && status < 300) {
    const rc = PAY.checkReceipt(PAY.readReceipt(res.headers), { offer, payer });
    const notes = [];
    if (/json/i.test(res.contentType || '') && !response.valid_json) notes.push('the content type says JSON but the body is not valid JSON');
    if (!response.size_bytes) notes.push('the paid response has an empty body');
    if (rc.ok) return { verdict: 'PASS', reasons: [`the endpoint answered HTTP ${status} to the signed payment and reported a settlement of ${offer.network} USDC from the test wallet`], notes, response, settlement: rc.settlement, spend: 'settle' };
    return { verdict: 'FAIL', reasons: [`the endpoint answered HTTP ${status} but its settlement receipt is not a good one: ${rc.problems.join('; ')}`], notes, response, settlement: rc.settlement, spend: 'settle' };
  }
  if (status === 402) {
    const loc = P.locate({ ...res, headers: res.headers || {} });
    const why = loc.primary && typeof loc.primary.value.error === 'string' ? ` (${P.show(loc.primary.value.error, 80)})` : '';
    const reasons = [`the endpoint answered HTTP 402 again to the signed payment${why}: the payment was not accepted`];
    const acc = loc.primary && Array.isArray(loc.primary.value.accepts) ? loc.primary.value.accepts : [];
    const same = acc.find((e) => e && typeof e === 'object' && e.network === offer.network && e.scheme === offer.scheme);
    if (same && String(same.payTo).toLowerCase() !== String(offer.payTo).toLowerCase()) reasons.push(`its payTo for ${P.show(offer.network, 40)} is now ${P.show(same.payTo, 50)}, not the ${P.show(offer.payTo, 50)} that was linted`);
    return J('FAIL', reasons, 'release', { response });
  }
  if (status >= 500) return J('FAIL', [`the endpoint answered HTTP ${status} after the payment was sent; it may have settled, so it is counted as spent`], 'settle', { response });
  return J('FAIL', [`the endpoint answered HTTP ${status} to the signed payment instead of serving it; it may have settled, so it is counted as spent`], 'settle', { response });
}

const lintSummary = (lint) => ({ verdict: lint.verdict, score: lint.score, version: lint.version, networks: lint.networks, failed: lint.checks.filter((c) => !c.pass && (c.severity !== 'info' || /^not tested/.test(c.detail))).map((c) => ({ id: c.id, severity: c.severity, detail: c.detail })) });
/** the answer's shape, in one place (the route and the example both build it here) */
function buildResult({ url, method, lint, timing, verdict, reasons, notes = [], payment = null, response = null, settlement = null }) {
  return { url, checked_at: lint.checked_at, method, verdict, reasons, notes, lint: lintSummary(lint), payment, timing, response, settlement };
}
const paymentOf = (pick, payer, sent) => ({ sent, network: pick.offer.network, scheme: 'exact', asset: pick.offer.asset, amount_atomic: pick.offer.amount, amount_usd: pick.usd, pay_to: pick.offer.payTo, payer });
const usdText = (n) => String(Number(n.toFixed(6)));

/** the answer of x402-test */
async function runTest(args, deps) {
  const d = depsOf(deps);
  const { url, method } = parseArgs(args);
  const href = d.checkUrl(url, { httpsOnly: true }).href;                 // 1. input and the address guard (throws bad)

  const wallets = await d.loadWallets();                                    // 2. the wallet
  if (!wallets.base && !wallets.solana) {
    if (wallets.problems && wallets.problems.length) console.error(`[x402-test] wallet files refused: ${JSON.stringify(wallets.problems)}`);
    throw unavailable(wallets.problems && wallets.problems.length ? 'the x402 test wallet is not usable right now' : 'the x402 test wallet is not set up', 3600);
  }

  const { output: lint, internals } = await L.lintDetailed({ url, method }, { fetch: d.fetch, now: d.now, hrnow: d.hrnow, httpsOnly: true, checkUrl: d.checkUrl, mainTimeoutMs: d.timeouts.main, probeTimeoutMs: d.timeouts.probe });   // 3. the lint
  const timing = { time_to_402_ms: lint.raw.latency_ms, time_to_paid_response_ms: null };
  const out = (verdict, reasons, extra = {}) => buildResult({ url, method, lint, timing, verdict, reasons, ...extra });
  const checkText = (id) => (lint.checks.find((c) => c.id === id) || {}).detail;

  if (lint.verdict === 'no-402') {
    if (internals.res.status === 402 && internals.loc.mpp) throw notCovered('the endpoint asks for payment with WWW-Authenticate: Payment (MPP), which this test does not pay');
    return out('FAIL', [`the unpaid request did not get an x402 challenge: ${checkText('http_402')}`]);
  }
  if (!internals.primary) return out('FAIL', [`the endpoint answered 402 but no x402 requirement can be read: ${checkText('challenge_found')}`]);
  if (internals.redirected) return out('FAIL', [`the unpaid request was redirected to ${P.plainUrl(internals.finalHref)}; a payment is never sent across a redirect, so test the final URL`]);
  const ver = internals.primary.version;
  if (ver !== 1 && ver !== 2) return out('FAIL', [`the challenge has no usable x402Version (${checkText('version_known')})`]);

  const c = classifyOffers(internals.offers, ver, d.caps.perCall);
  if (!c.candidates.length) {
    if (c.overCap.length) { const min = c.overCap.reduce((a, b) => (b.usd < a.usd ? b : a)); throw notCovered(`the cheapest payable offer on Base or Solana USDC is ${usdText(min.usd)} USD, over the ${usdText(d.caps.perCall)} USD this test will spend`); }
    if (c.malformed.length) return out('FAIL', ['the Base or Solana USDC offer cannot be paid because it is malformed', ...c.malformed.slice(0, 4)]);
    if (!c.onChain) throw notCovered('the endpoint offers no payment on Base or Solana USDC');
    throw notCovered(`the endpoint offers no exact USDC payment this test makes on Base or Solana (${c.unsupported.slice(0, 2).join('; ')})`);
  }
  const ordered = c.candidates.sort(order);                                // 4. a funded chain
  const usable = ordered.filter((x) => wallets[x.chain]);
  if (!usable.length) throw unavailable('the test wallet holds no key for the chain this endpoint accepts', 3600);
  let pick = null;
  for (const x of usable) {
    let bal;
    try { bal = await d.balance[x.chain](wallets[x.chain].address); } catch (e) {        // a failed read is a 503, never "no money = pass" or "no money = fail"
      if (e && e.status === 503) throw e;
      throw unavailable('the balance of the test wallet could not be read', 120);
    }
    if (typeof bal === 'bigint' && bal >= BigInt(x.offer.amount)) { pick = x; break; }
  }
  if (!pick) throw unavailable('the test wallet holds less USDC than this endpoint asks for', 3600);

  const again = await reread(d, href, method, pick, internals);              // 5. the second, unpaid read
  if (again.fail) return out('FAIL', again.fail);

  const payer = wallets[pick.chain].address;                                // 6. reserve, sign, check
  const spend = d.spend();
  const rid = spend.reserve(SCOPE, pick.usd);                               // throws 503 when a cap is hit; nothing is signed or sent
  let finished = false; let sentMaybe = false;
  try {
    let made;
    try {
      made = await d.createPayment({ challenge: internals.primary.value, offer: pick.offer, ver, wallets, chain: pick.chain, solanaRpcUrl: d.solanaRpcUrl, maxUsd: d.caps.perCall });
      await PAY.assertPays({ payload: made.payload, offer: pick.offer, ver, payer, now: d.now });
    } catch (e) { spend.release(rid); finished = true; throw unavailable(`the payment could not be prepared (${PAY.scrub(e && e.message)})`, 300); }
    const t0 = d.hrnow();                                                   // 7. ONE paid request
    let res = null; let err = null;
    sentMaybe = true;
    try {
      res = await d.fetch(href, { maxBytes: R.LIMITS.maxBytes, timeoutMs: d.timeouts.paid, userAgent: L.UA, accept: 'application/json, */*;q=0.1', method, httpsOnly: true, maxRedirects: 0, acceptStatus: () => true,
        headers: { ...made.headers, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) } });
      res = { ...res, headers: Object.fromEntries(Object.entries(res.headers || {}).map(([k, v]) => [k.toLowerCase(), v])), body: res.body || Buffer.alloc(0), contentType: res.contentType || '' };
    } catch (e) { err = e; }
    timing.time_to_paid_response_ms = Math.max(0, d.hrnow() - t0);
    const v = judge({ res, err, offer: pick.offer, payer, ver });          // 8. the verdict, and the spend
    if (v.spend === 'release') spend.release(rid); else spend.settle(rid, pick.usd);
    finished = true;
    return out(v.verdict, v.reasons, { notes: v.notes, payment: paymentOf(pick, payer, !(err && v.spend === 'release')), response: v.response, settlement: v.settlement });
  } finally {
    // an exit nobody planned (a bug, a thrown error after the request was sent): count it as spent when the request may have gone out, give it back when it cannot have
    if (!finished) { if (sentMaybe) spend.settle(rid, pick.usd); else spend.release(rid); }
  }
}

module.exports = { runTest, buildResult, paymentOf, classifyOffers, judge, reread, parseArgs, depsOf, order, shapeOf, lintSummary, SCOPE, DEFAULT_CAPS, PAID_TIMEOUT_MS };
