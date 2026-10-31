// tools/r23/claim-check/index.js: GET /api/claim-check?claim=&urls= (R23 T4, 31 Oct 2026): is this short claim SUPPORTED, CONTRADICTED or INSUFFICIENT by sources, with every
// supporting line quoted word for word from a fetched source?
//
// HOW AN ANSWER IS MADE (all of it deterministic except one model call):
//   1. input checks (claim 10 to 300 characters and a statement of fact, at most 3 https URLs): a wrong input is a 400 before anything is fetched or spent;
//   2. sources: the caller's URLs, or, with none, one SEC filing for an explicit ticker such as $AAPL, else the Wikipedia articles the claim names (sources.js);
//   3. what the model sees: a long source is cut to the passages that share the most words and figures with the claim (text.js selectExcerpts), lines that read as an
//      instruction to an AI model are removed, everything goes in as delimited data, and the size is fitted to the token cap and the per-call USD cap BEFORE the call;
//   4. one model call (tools/llm/gemini.js, the summarize route's provider and key) proposes a verdict and up to 3 quotes;
//   5. THIS CODE decides: each quote must be found word for word (whitespace aside) in a fetched source or it is dropped; SUPPORTED or CONTRADICTED without a surviving quote
//      becomes INSUFFICIENT; SUPPORTED also needs every figure of the claim in the surviving quotes. The model's wording never reaches the answer; only verified quotes do.
// Failure semantics (R23 contract): bad input 400; no source readable, a spent cap, no key or a model error 503 with Retry-After; no source to be found 404 "not covered"; none
// of these is billed. Nothing is cached across callers except fetched source text (sources.js makeCache).
'use strict';
const { z } = require('zod');
const G = require('../../llm/gemini');
const SF = require('../../../lib/safe-fetch');
const T = require('./text');
const S = require('./sources');
const M = require('./model');
const { assemble } = require('./answer');
const { sharedGate } = require('./inflight');
const { unavailable, notCovered, bad, envNum } = require('../common');

const SCOPE = 'claimcheck';
const MAX_CLAIM = 300; const MIN_CLAIM = 10; const MIN_WORDS = 3;
const MAX_URLS = 3; const MAX_URL_CHARS = 2048;
const DEFAULT_CAPS = { perCall: 0.06, perDay: 3 };
const SHARED_CACHE = S.makeCache();
// What the model is shown is also capped by size, well under the token cap: measured on the 20 gate claims, the passage a claim comes from was in the excerpts at
// every budget from 3,000 characters up (19 of 20 at 3,000 and 8,000, 20 of 20 from 20,000), so 36,000 leaves a wide margin without paying for noise.
const EXCERPT_TARGET_CHARS = 36000;

// ---------------------------------------------------------------- input
function parseClaim(raw) {
  if (Array.isArray(raw)) throw bad('claim must be given once');
  const s = raw == null ? '' : String(raw);
  if (s.trim() && [...s].length > MAX_CLAIM) throw bad(`claim is over the ${MAX_CLAIM}-character limit`);        // code points of the claim as sent, the rule lib/query-rules.js textCap uses
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(s)) throw bad('claim must be plain text');
  const c = T.normWs(s);
  if (!c) throw bad(`missing required parameter: claim (one statement of fact, up to ${MAX_CLAIM} characters)`);
  if (c.length < MIN_CLAIM || c.split(' ').length < MIN_WORDS) throw bad(`claim must be a statement of fact of at least ${MIN_WORDS} words`);
  return c;
}
/** `urls`: comma separated, whitespace separated, or the parameter repeated. Every entry must be a plain public https URL (lib/safe-fetch.js checkUrl: no http, no credentials, no port but 443, no private or local address). */
function parseUrls(raw) {
  if (raw == null || raw === '') return [];
  const items = (Array.isArray(raw) ? raw : [raw]).flatMap((x) => String(x).split(/\s+/)).flatMap((x) => x.split(/,(?=[A-Za-z][A-Za-z0-9+.\-]*:\/\/)/)).map((x) => x.replace(/,+$/, '')).filter(Boolean);
  if (items.length > MAX_URLS) throw bad(`urls takes at most ${MAX_URLS} URLs`);
  const out = [];
  items.forEach((it, i) => {
    if (it.length > MAX_URL_CHARS) throw bad(`urls entry ${i + 1} is over ${MAX_URL_CHARS} characters`);
    let u; try { u = SF.checkUrl(it, { httpsOnly: true }); } catch (e) { throw bad(`${e.message} (urls entry ${i + 1})`); }
    if (!out.includes(u.href)) out.push(u.href);
  });
  return out;
}

// ---------------------------------------------------------------- dependencies (everything a test needs to replace)
let SPEND = null;
/** the shared spend ledger (a small SQLite file, tools/r23/spend.js), created on first use */
function sharedSpend(env) {
  if (!SPEND) {
    const caps = capsOf(env);
    SPEND = { caps, spend: require('../spend').makeSpend({ caps: { [SCOPE]: caps } }) };
  }
  return SPEND;
}
const capsOf = (env) => ({ perCall: envNum('CLAIMCHECK_PER_CALL_USD', DEFAULT_CAPS.perCall, env), perDay: envNum('CLAIMCHECK_PER_DAY_USD', DEFAULT_CAPS.perDay, env) });

function resolve(deps) {
  const env = deps.env || process.env;
  const WEBMD = deps.getWebMarkdown && deps.getPdfMarkdown ? null : require('../../webmd');
  return {
    env,
    now: deps.now || Date.now,
    key: deps.key !== undefined ? deps.key : env.GEMINI_API_KEY,
    fetchImpl: deps.fetchImpl, model: deps.model, timeoutMs: deps.timeoutMs,
    getPageText: deps.getPageText || require('../../llm/page').getPageText,
    getWebMarkdown: deps.getWebMarkdown || WEBMD.getWebMarkdown,
    getPdfMarkdown: deps.getPdfMarkdown || WEBMD.getPdfMarkdown,
    fetchSecDoc: deps.fetchSecDoc,
    sec: deps.sec || require('../../sec'),
    wiki: deps.wiki || require('../../wiki'),
    cache: deps.cache || SHARED_CACHE,
    gate: deps.gate || sharedGate(env),
    getSpend: () => (deps.spend ? { spend: deps.spend, caps: deps.caps || capsOf(env) } : sharedSpend(env)),
  };
}

/** wraps a fetch so that the real token counts of every attempt are added up (G.structured may call the model twice) */
function metered(base, model, fallbackUsd) {
  const m = { usd: 0, calls: 0, tokens_in: 0, tokens_out: 0 };
  const fetchImpl = async (url, opts) => {
    const res = await (base || fetch)(url, opts);
    m.calls++;
    if (res.ok) {
      let usd = fallbackUsd;       // a 200 whose usage cannot be read is charged at the reservation, never at zero
      try { const c = G.costOf(model, (await res.clone().json()).usageMetadata || {}); if (c.tokens_in > 0) { usd = c.usd; m.tokens_in += c.tokens_in; m.tokens_out += c.tokens_out + c.tokens_thoughts; } } catch { /* keep the fallback */ }
      m.usd += usd;
    }
    return res;
  };
  return { fetchImpl, m };
}

// ---------------------------------------------------------------- budget
/** split `total` characters between sources of the given lengths: short ones keep all they need, the rest is shared equally */
function allocate(lengths, total) {
  const order = lengths.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b]);
  const out = Array(lengths.length).fill(0); let left = total;
  order.forEach((i, k) => { out[i] = Math.min(lengths[i], Math.floor(left / (order.length - k))); left -= out[i]; });
  return out;
}

function noSources(given, failed) {
  const why = failed.map((f) => `${f.url || f.kind}: ${f.reason}`).join('; ').slice(0, 400);
  if (failed.some((f) => f.transient)) return unavailable(`no source could be read right now (${why})`, 120);
  if (given) return bad(`none of the given URLs could be read: ${why}`);
  return notCovered(`no source was found for this claim${why ? ` (${why})` : ''}; pass urls with up to ${MAX_URLS} https pages that state the facts`);
}

async function claimCheck(args = {}, deps = {}) {
  const d = resolve(deps);
  // 1. input: nothing is fetched, reserved or spent until all of it is valid
  const claim = parseClaim(args.claim);
  const urls = parseUrls(args.urls);
  const why = T.notCheckable(claim);
  if (why) throw bad(`claim must be a statement of fact that a source can confirm or refute; this one reads as ${why}`);
  if (!d.key) throw unavailable('the language-model backend is not configured', 3600);
  // a slot of the process-wide limit (inflight.js) before anything is fetched or spent; released whatever happens. A call that reads an SEC filing is the heavy kind.
  const heavy = urls.length ? urls.some((u) => S.classify(u).type === 'sec') : Boolean(T.tickerOf(claim));
  const release = await d.gate.acquire(heavy);
  try { return await answerClaim(claim, urls, d); } finally { release(); }
}

async function answerClaim(claim, urls, d) {
  let spend; let caps;
  try {
    ({ spend, caps } = d.getSpend());
    if (spend.today(SCOPE) >= caps.perDay - 1e-9) throw unavailable(`claim-check has reached its daily spend cap of ${caps.perDay} USD`, 3600);
  } catch (e) {
    if (e && e.status === 503) throw e;
    throw unavailable('the spend ledger is not available', 300);          // without a ledger no cap can be enforced, so nothing is spent
  }

  // 2. sources
  const got = urls.length ? await S.readUrls(urls, d) : await S.discover(claim, d);
  if (!got.read.length) throw noSources(urls.length > 0, got.failed);

  // 3. fit what the model sees to the token cap and the per-call USD cap, before the call
  const lim = M.limits(d.env);
  const model = d.model || G.MODEL.default;
  const budgetTokens = Math.min(lim.maxInputTokens, M.inputTokensFor(caps.perCall, lim.maxOutputTokens, model));
  const fit = Math.floor(budgetTokens * M.CHARS_PER_TOKEN) - M.overheadChars(claim, got.read.length);
  const room = Math.min(fit - Math.ceil(fit * 0.02) - 300, EXCERPT_TARGET_CHARS);         // a little slack: a removed line is replaced by a marker, which can be longer
  if (room < 1500) throw unavailable(`the per-call spend cap of ${caps.perCall} USD leaves no room to read a source`, 3600);
  const alloc = allocate(got.read.map((s) => s.text.length), room);
  let redactedTotal = 0;
  // only the excerpts the model is shown are kept from here on: the full text of a source is dropped as soon as they are cut from it (the cache may still hold it, bounded)
  const prepared = got.read.map((s, i) => {
    const sel = T.selectExcerpts(s.text, claim, alloc[i]);
    const kept = T.shownSource(s.text, sel.ranges);
    redactedTotal += kept.redacted;
    s.text = null;
    return { index: i + 1, url: s.url, final_url: s.final_url, kind: s.kind, format: s.format, title: s.title, chars_total: s.chars_total, chars_read: sel.chars_read, truncated: sel.truncated || s.truncated_source,
      redacted: kept.redacted, shown: kept.shown, norm: kept.norm, locate: kept.locate };
  });
  const parts = M.buildParts(claim, prepared);
  const promptChars = M.INSTRUCTION.length + G.DATA_RULE.length + parts.reduce((a, p) => a + p.text.length, 0);
  const inTokens = M.estTokens(promptChars);
  const usd = M.worstCaseUsd(inTokens, lim.maxOutputTokens, model);
  const id = spend.reserve(SCOPE, usd);                                  // throws the 503 "Not charged" when the per-call or the daily cap would be passed

  // 4. the model call; what was really spent is recorded whatever happens
  const meter = metered(d.fetchImpl, model, usd / M.ATTEMPTS);
  let r;
  try {
    r = await G.structured({ route: 'claim-check', task: 'default', instruction: M.INSTRUCTION, schema: M.SCHEMA, maxOutputTokens: lim.maxOutputTokens, parts }, M.validate,
      { fetchImpl: meter.fetchImpl, key: d.key, now: d.now(), ...(d.model ? { model: d.model } : {}), ...(d.timeoutMs ? { timeoutMs: d.timeoutMs } : {}) });
  } catch (e) {
    if (meter.m.calls) spend.settle(id, meter.m.usd); else spend.release(id);
    if (e && e.kind === 'bad_request') throw notCovered('the language-model provider declined to process this claim or its sources');
    throw e;
  }
  spend.settle(id, meter.m.usd);

  // 5. the answer is decided here, from verified quotes only
  return assemble({ claim, parsed: r.value, prepared, failed: got.failed, model: r.model, redacted: redactedTotal });
}

// ---------------------------------------------------------------- the route entry
const EXAMPLE = require('./example');
const entries = [
  { name: 'get_claim_check', route: 'GET /api/claim-check', usd: 0.15,
    tags: ['fact-check', 'verification', 'claims', 'citations', 'sec', 'edgar', 'wikipedia', 'research', 'rag'],
    desc: 'Use when an agent needs a short claim checked against sources. Returns SUPPORTED, CONTRADICTED or INSUFFICIENT, with every supporting line quoted word for word from a filing, Wikipedia article or URL. No readable source answers 404 or 503, not charged.',
    schema: {
      claim: z.string().describe(`the claim to check: one statement of fact, ${MIN_CLAIM} to ${MAX_CLAIM} characters`),
      urls: z.string().optional().describe(`up to ${MAX_URLS} https URLs of pages that should settle it, comma separated or repeat the parameter; omit them and the service reads one SEC filing when the claim carries an explicit ticker such as $AAPL, else the Wikipedia articles the claim names`),
    },
    title: 'Claim check',
    question: 'Do these sources support, contradict or not settle this claim, and which exact lines say so?',
    example: EXAMPLE.data,
    run: (args) => claimCheck(args || {}) },
];

module.exports = { entries, claimCheck, assemble, parseClaim, parseUrls, allocate, metered, noSources, resolve, capsOf, SCOPE, EXCERPT_TARGET_CHARS, MAX_CLAIM, MIN_CLAIM, MAX_URLS, DEFAULT_CAPS, SHARED_CACHE, _resetSpend: () => { if (SPEND) { try { SPEND.spend.close(); } catch { /* closed */ } } SPEND = null; } };
