// tools/r23/x402/lint.js: grade the x402 challenge an endpoint serves to an UNPAID request (R23 T3, 31 Oct 2026). No payment, no wallet, no key.
//
// The caller's URL is fetched ONLY through lib/safe-fetch.js (address and port guard, 3 redirects, 5 MB, 10 s). The rubric (what is graded, severity, weight) is data in rubric.js.
// One lint is: the unpaid request itself, then (only when it answered 402) three probes in parallel, a HEAD and the upper-case and trailing-slash spellings of the path,
// which must not be served without payment. deps (all optional, for tests): fetch(url, opts) with the safeFetch contract, now(), hrnow(), checkUrl(url, opts), httpsOnly.
'use strict';
const R = require('./rubric');
const P = require('./parse');
const { bad, unavailable } = require('../common');

const UA = 'AgentFeed-x402-lint/1.0 (+https://x402.ochinimus.app)';
const sf = () => require('../../../lib/safe-fetch');   // looked up per call, so the guard that runs is always the module's current one
const defaultFetch = (url, opts) => sf().safeFetch(url, opts);
/** a 503 from the guard (could not fetch, redirect limit, read timeout) becomes the route's own "Not charged" refusal; every other error passes through unchanged */
const refuse = (e) => (e && e.status === 503 && !/Not charged\.?$/.test(String(e.message)) ? unavailable(e.message, 60) : e);
const hr = () => Number(process.hrtime.bigint() / 1000000n);

function collector() {
  const byId = new Map();
  return {
    add(id, pass, detail) {
      const c = R.BY_ID.get(id);
      if (!c) throw new Error(`x402 lint: ${id} is not in the rubric`);
      if (byId.has(id)) throw new Error(`x402 lint: ${id} reported twice`);
      byId.set(id, { id, severity: c.severity, pass: Boolean(pass), detail });
    },
    untested(id, why) {
      if (!R.BY_ID.has(id)) throw new Error(`x402 lint: ${id} is not in the rubric`);
      byId.set(id, { id, severity: 'info', pass: false, detail: `not tested: ${why}` });
    },
    has: (id) => byId.has(id),
    /** the checks in rubric order */
    list: () => R.CHECKS.filter((c) => byId.has(c.id)).map((c) => byId.get(c.id)),
  };
}

/** the score (0 to 100) and the verdict from the checks and the shape of the answer */
function grade(checks, noX402) {
  let lost = 0; let errors = 0; let warns = 0;
  for (const c of checks) {
    if (c.pass || c.severity === 'info') continue;
    lost += R.BY_ID.get(c.id).weight;
    if (c.severity === 'error') errors++; else warns++;
  }
  const score = Math.max(0, 100 - lost);
  const verdict = noX402 ? 'no-402' : errors ? 'invalid' : warns ? 'warnings' : 'valid';
  return { score, verdict };
}

// ---- network and offer reading
/** a network string -> { shape: 'caip2'|'v1name'|'invalid', family: 'evm'|'solana'|'other'|null, known, testnet, caip2 } */
function netInfo(net) {
  if (typeof net !== 'string' || net === '') return { shape: 'invalid' };
  if (R.V1_CHAIN_IDS[net] !== undefined) return { shape: 'v1name', family: 'evm', known: true, testnet: R.V1_TESTNETS.has(net), caip2: `eip155:${R.V1_CHAIN_IDS[net]}` };
  if (R.V1_SOLANA.includes(net)) {
    const ref = net === 'solana' ? R.SOLANA_REFS.mainnet : net === 'solana-devnet' ? R.SOLANA_REFS.devnet : R.SOLANA_REFS.testnet;
    return { shape: 'v1name', family: 'solana', known: true, testnet: net !== 'solana', caip2: `solana:${ref}` };
  }
  if (P.CAIP2_RE.test(net)) {
    const [ns, ref] = net.split(':');
    if (ns === 'eip155') { const id = /^[1-9]\d{0,15}$/.test(ref) ? Number(ref) : null; return { shape: 'caip2', family: 'evm', known: id !== null, testnet: id !== null && R.EVM_TESTNET_IDS.has(id), caip2: net }; }
    if (ns === 'solana') return { shape: 'caip2', family: 'solana', known: Object.values(R.SOLANA_REFS).includes(ref), testnet: ref === R.SOLANA_REFS.devnet || ref === R.SOLANA_REFS.testnet, caip2: net };
    return { shape: 'caip2', family: 'other', known: R.OTHER_NAMESPACES.has(ns), testnet: null, caip2: net };
  }
  if (/^[a-z][a-z0-9-]{1,40}$/.test(net)) return { shape: 'v1name', family: null, known: false, testnet: null, caip2: null };
  return { shape: 'invalid' };
}

const addrOk = (family, v) => (family === 'evm' ? P.isEvmAddr(v) : family === 'solana' ? P.isSolAddr(v) : typeof v === 'string' && v.trim() !== '');
const fmtName = (family) => (family === 'evm' ? '0x and 40 hex characters' : family === 'solana' ? 'base58 that decodes to 32 bytes' : 'a non-empty string (this network is not checked further)');
const lc = (family, v) => (family === 'evm' && typeof v === 'string' ? v.toLowerCase() : v);

/** the version a challenge is graded as: its own x402Version when that is 1 or 2, else the one its location implies */
const gradedVersion = (primary) => (primary.version === 1 || primary.version === 2 ? primary.version : primary.source === 'header' ? 2 : 1);

/** which offers are on the list, as a short sentence part */
const label = (i, e) => `accepts[${i}]${e && typeof e === 'object' && e.network !== undefined ? ` (${P.show(e.network, 40)})` : ''}`;

/** grade accepts[] of one challenge into the collector; returns { networks, offers } where offers are the normalised entries other code (x402-test) pays from */
function gradeOffers(C, obj, ver) {
  const accepts = obj.accepts;
  const fails = {};
  const fail = (id, i, e, msg) => { (fails[id] ||= []).push(`${label(i, e)}: ${msg}`); };
  const offers = []; const networks = []; const seenKeys = new Map(); const testnetFlags = [];
  accepts.forEach((e, i) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) { fail('entry_scheme', i, null, 'is not an object'); return; }
    // scheme
    if (typeof e.scheme !== 'string' || e.scheme.trim() === '') fail('entry_scheme', i, e, 'has no scheme');
    else if (!R.SCHEMES.includes(e.scheme)) fail('scheme_known', i, e, `scheme ${P.show(e.scheme, 30)} is not one of ${R.SCHEMES.join(', ')}`);
    // network
    const ni = netInfo(e.network);
    if (ni.shape === 'invalid') fail('entry_network', i, e, e.network === undefined ? 'has no network' : `network ${P.show(e.network, 40)} is neither CAIP-2 nor a network name`);
    else if (ver === 2 && ni.shape === 'v1name') fail('entry_network', i, e, `a v2 network is written as CAIP-2 (for example eip155:8453), not ${P.show(e.network, 30)}`);
    else {
      if (ver === 1 && ni.shape === 'caip2') fail('network_known', i, e, `a v1 challenge names networks like base or solana, not ${P.show(e.network, 40)}`);
      else if (!ni.known) fail('network_known', i, e, `network ${P.show(e.network, 40)} is not one this lint knows`);
      if (typeof e.network === 'string' && !networks.includes(e.network)) networks.push(e.network);
      testnetFlags.push(ni.testnet);
    }
    const family = ni.shape === 'invalid' ? null : ni.family;
    // amount
    const field = ver === 1 ? 'maxAmountRequired' : 'amount';
    const other = ver === 1 ? 'amount' : 'maxAmountRequired';
    const av = e[field];
    let amountOk = false;
    if (av === undefined) fail('entry_amount', i, e, e[other] !== undefined ? `has ${other}, but a v${ver} offer states its price in ${field}` : `has no ${field}`);
    else if (typeof av === 'number') fail('entry_amount', i, e, `${field} is a number (${P.show(av, 20)}); it must be a string of digits`);
    else if (!P.isAtomic(av)) fail('entry_amount', i, e, `${field} ${P.show(av, 30)} is not a positive integer written as a string of digits`);
    else amountOk = true;
    // amount range, for USDC on a network this lint knows
    const usdc = ni.caip2 ? R.isUsdc(ni.caip2, e.asset) : false;
    let usd = null;
    if (amountOk && usdc) {
      usd = Number(BigInt(av)) / 1e6;
      if (usd < R.RANGE_USD.min || usd > R.RANGE_USD.max) fail('amount_range', i, e, `${usd} USD is outside ${R.RANGE_USD.min} to ${R.RANGE_USD.max} USD; USDC has 6 decimals, so ${P.show(av, 30)} units is ${usd} USD`);
    }
    // asset and payTo
    const fam = family === 'evm' || family === 'solana' ? family : 'other';
    if (typeof e.asset !== 'string' || e.asset.trim() === '') fail('entry_asset', i, e, 'has no asset');
    else if (!addrOk(fam, e.asset)) fail('entry_asset', i, e, `asset ${P.show(e.asset, 50)} should be ${fmtName(fam)}`);
    if (typeof e.payTo !== 'string' || e.payTo.trim() === '') fail('entry_payto', i, e, 'has no payTo');
    else if (!addrOk(fam, e.payTo)) fail('entry_payto', i, e, `payTo ${P.show(e.payTo, 50)} should be ${fmtName(fam)}`);
    // validity window
    const mt = e.maxTimeoutSeconds;
    const mtOk = Number.isInteger(mt) && mt > 0;
    if (!mtOk) fail('entry_timeout', i, e, mt === undefined ? 'has no maxTimeoutSeconds' : `maxTimeoutSeconds ${P.show(mt, 20)} is ${typeof mt === 'string' ? 'a string; it must be a number' : 'not a positive integer'}`);
    else if (mt < R.LIMITS.timeoutMin || mt > R.LIMITS.timeoutMax) fail('timeout_range', i, e, `maxTimeoutSeconds ${mt} is outside ${R.LIMITS.timeoutMin} to ${R.LIMITS.timeoutMax}`);
    // what an exact offer needs to be signed
    if (e.scheme === 'exact') {
      const ex = e.extra && typeof e.extra === 'object' && !Array.isArray(e.extra) ? e.extra : null;
      if (family === 'evm' && !(ex && ex.assetTransferMethod === 'permit2')) {
        if (!(ex && typeof ex.name === 'string' && ex.name && typeof ex.version === 'string' && ex.version)) fail('exact_extra', i, e, 'an exact EVM offer needs extra.name and extra.version (the token\'s EIP-712 domain) as strings');
      } else if (family === 'solana') {
        if (!(ex && P.isSolAddr(ex.feePayer))) fail('exact_extra', i, e, 'an exact Solana offer needs extra.feePayer as a base58 address');
      }
    }
    // duplicates
    const key = JSON.stringify([e.scheme, lc(family, e.network), lc(family, e.asset), lc(family, e.payTo), av, e.extra === undefined ? null : P.sortKeys(e.extra)]);
    if (seenKeys.has(key)) fail('entry_duplicate', i, e, `repeats accepts[${seenKeys.get(key)}]`); else seenKeys.set(key, i);
    offers.push({ index: i, entry: e, scheme: e.scheme, network: e.network, family, caip2: ni.caip2 || null, amount: av, asset: e.asset, payTo: e.payTo, usdc, usd });
  });
  const verdictFor = (id, okText) => {
    const f = fails[id];
    C.add(id, !f, f ? `${f.length > 4 ? `${f.slice(0, 4).join('; ')}; and ${f.length - 4} more` : f.join('; ')}` : okText);
  };
  const n = accepts.length;
  verdictFor('entry_scheme', `all ${n} offers name a scheme`);
  verdictFor('scheme_known', 'every scheme is a recognised one');
  verdictFor('entry_network', `all ${n} networks are written as v${ver} requires`);
  verdictFor('network_known', 'every network is a known one');
  verdictFor('entry_amount', `all ${n} amounts are positive integer strings in ${ver === 1 ? 'maxAmountRequired' : 'amount'}`);
  verdictFor('amount_range', offers.some((o) => o.usd !== null) ? 'every USDC price is inside the range' : 'no offer is in USDC on a network this lint knows, so no price range was checked');
  verdictFor('entry_asset', 'every asset is written in the format of its network');
  verdictFor('entry_payto', 'every payTo is written in the format of its network');
  verdictFor('entry_timeout', 'every offer has a positive integer maxTimeoutSeconds');
  verdictFor('timeout_range', 'every validity window is inside the range');
  verdictFor('exact_extra', offers.some((o) => o.scheme === 'exact') ? 'every exact offer carries what it needs to be signed' : 'no exact offer to check');
  verdictFor('entry_duplicate', 'no offer is listed twice');
  const known = testnetFlags.filter((t) => t !== null && t !== undefined);
  const allTest = known.length > 0 && known.every(Boolean);
  C.add('mainnet_offered', !allTest, allTest ? 'every network this lint knows is a testnet, so a client with real funds cannot pay it' : known.length ? 'at least one offer is on a mainnet' : 'no network this lint knows the status of');
  return { networks, offers };
}

/** the resource, description and mime type of a challenge: v2 keeps them in resource{}, v1 in each offer */
function resourceOf(obj, ver) {
  if (ver === 2) { const r = obj.resource && typeof obj.resource === 'object' && !Array.isArray(obj.resource) ? obj.resource : null; return { present: Boolean(r), url: r && r.url, description: r && r.description, mimeType: r && r.mimeType }; }
  const es = obj.accepts.filter((e) => e && typeof e === 'object');
  const first = (k) => { const e = es.find((x) => typeof x[k] === 'string' && x[k].trim() !== ''); return e ? e[k] : undefined; };
  return { present: es.length > 0, url: first('resource'), description: first('description'), mimeType: first('mimeType') };
}

const isLocalHost = (h) => /^(localhost|.*\.local|.*\.internal)$/i.test(h) || (require('net').isIP(h.replace(/^\[|\]$/g, '')) && sf().isPrivate(h.replace(/^\[|\]$/g, '')));

function gradeResource(C, obj, ver, requested) {
  const r = resourceOf(obj, ver);
  // resource url
  let ok = false; let detail;
  if (typeof r.url !== 'string' || r.url.trim() === '') detail = ver === 2 ? 'resource.url is missing' : 'no offer carries a resource URL';
  else {
    let u = null;
    try { u = new URL(r.url); } catch { /* reported below */ }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) detail = `resource URL ${P.show(r.url, 80)} is not an absolute http or https URL`;
    else if (isLocalHost(u.hostname)) detail = `resource URL ${P.show(r.url, 80)} names a local or private host, which no client outside the server can reach`;
    else {
      const trim = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
      const same = requested.some((q) => q.protocol === u.protocol && q.host.toLowerCase() === u.host.toLowerCase() && trim(q.pathname) === trim(u.pathname));
      ok = same;
      detail = same ? 'the resource URL is the URL that was requested' : `the resource URL is ${P.plainUrl(r.url)} but the request was ${P.plainUrl(requested[0].href)}; a client signs for the resource it is told, so the two should match`;
    }
  }
  C.add('resource_url', ok, detail);
  const hasDesc = typeof r.description === 'string' && r.description.trim() !== '';
  C.add('description_present', hasDesc, hasDesc ? `${P.show(r.description, 60)} (${r.description.length} characters)` : ver === 2 ? 'resource.description is missing' : 'no offer carries a description');
  const mt = typeof r.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+/.test(r.mimeType.trim());
  C.add('mime_type_present', mt, mt ? P.show(r.mimeType, 60) : ver === 2 ? 'resource.mimeType is missing or is not type/subtype' : 'no offer carries a mimeType in type/subtype form');
  // extensions and discovery metadata
  if (ver === 2 && 'extensions' in obj) {
    const okExt = obj.extensions && typeof obj.extensions === 'object' && !Array.isArray(obj.extensions);
    C.add('extensions_shape', okExt, okExt ? `${Object.keys(obj.extensions).length} extension(s)` : 'extensions is not an object');
  }
  const found = []; const other = [];
  if (ver === 2 && obj.extensions && typeof obj.extensions === 'object' && !Array.isArray(obj.extensions)) for (const k of Object.keys(obj.extensions)) (R.EXTENSIONS.includes(k) ? found : other).push(k);
  if (ver === 1 && obj.accepts.some((e) => e && typeof e === 'object' && e.outputSchema && typeof e.outputSchema === 'object')) found.push('outputSchema');
  const note = other.length ? `; not recognised here: ${other.slice(0, 5).map((k) => P.show(k, 30)).join(', ')}` : '';
  C.add('discovery_metadata', found.length > 0, found.length ? `recognised: ${found.join(', ')}${note}` : `none recognised, so a catalogue cannot index this endpoint from its challenge${note}`);
}

// ---- the paywall probes
/** the same URL with the path in capitals, and with a trailing slash added or taken away (null when the spelling would be the same URL) */
function variants(u) {
  const upper = u.pathname.toUpperCase();
  const slash = u.pathname === '/' ? u.pathname : u.pathname.endsWith('/') ? u.pathname.replace(/\/+$/, '') : `${u.pathname}/`;
  const mk = (p) => (p === u.pathname ? null : `${u.origin}${p}${u.search}`);
  return { upper: mk(upper), slash: mk(slash) };
}

async function probeOne(d, url, method) {
  const opts = { maxBytes: R.LIMITS.probeMaxBytes, timeoutMs: d.probeTimeoutMs, userAgent: UA, accept: 'application/json, */*;q=0.1', method, httpsOnly: d.httpsOnly, acceptStatus: () => true, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' } } : {}) };
  try {
    const r = await d.fetch(url, opts);
    return { status: r.status, finalUrl: r.url, headers: lowerKeys(r.headers), bodyLen: r.body ? r.body.length : 0, requested: url };
  } catch (e) { return { error: e }; }
}

function lowerKeys(h) { const o = {}; for (const [k, v] of Object.entries(h || {})) o[k.toLowerCase()] = v; return o; }

function gradeProbe(C, id, what, p, isHead) {
  if (p === null) return;                                    // the spelling is the same URL: nothing to probe
  if (p.error) { C.untested(id, `${what} could not be sent (${P.show(p.error.message, 100)})`); return; }
  const s = p.status;
  if (s >= 200 && s < 300) {
    const sameUrl = (() => { try { const a = new URL(p.requested); const b = new URL(p.finalUrl); return a.host === b.host && a.pathname === b.pathname; } catch { return true; } })();
    if (!sameUrl) { C.add(id, true, `${what} was redirected to ${P.plainUrl(p.finalUrl)}, which answered HTTP ${s}; that is not counted as served content, check the target by hand`); return; }
    const cl = p.headers['content-length'];
    const empty = isHead ? cl === '0' : p.bodyLen === 0;
    if (empty) { C.add(id, true, `${what} answered HTTP ${s} with no content`); return; }
    C.add(id, false, `${what} answered HTTP ${s} with content and no payment: this spelling reaches the paid handler without a 402`);
    return;
  }
  C.add(id, true, `${what} answered HTTP ${s}`);
}

// ---- the first answer, explained
function explain(res, finalHref, requestedHref) {
  const s = res.status; const ct = res.contentType || 'no content type'; const n = res.body ? res.body.length : 0;
  const moved = finalHref !== requestedHref;
  let head;
  if (s >= 200 && s < 300) {
    const html = /html/i.test(ct);
    const txt = html && res.body ? res.body.subarray(0, 20000).toString('utf8') : '';
    const login = html && (/<input[^>]+type=["']?password/i.test(txt) || /sign[ -]?in|log[ -]?in/i.test(txt));
    head = `HTTP ${s} (${P.show(ct, 60)}, ${n} bytes): the endpoint answered an unpaid request with its content${login ? ', and the page looks like a login page' : ''}, so it is not asking for payment here. If a paywall was meant, it is not active for this method and path`;
  } else if (s === 401 || s === 403) head = `HTTP ${s}: a login or permission wall, not a payment request. x402 answers 402 and needs no account`;
  else if (s === 404 || s === 405) head = `HTTP ${s}: no handler for this method and path. Check the URL, and the method (a POST-only endpoint answers GET with 405)`;
  else if (s === 429) head = 'HTTP 429: the endpoint rate-limited the request before it asked for payment';
  else if (s >= 500) head = `HTTP ${s}: the endpoint failed before it could ask for payment`;
  else if (s >= 300 && s < 400) head = `HTTP ${s}: a redirect with no Location the lint could follow`;
  else if (s === 402) head = 'HTTP 402 with no x402 requirement';
  else head = `HTTP ${s}: not a payment request`;
  return moved ? `${head}. The request was redirected to ${P.plainUrl(finalHref)}` : head;
}

/** the 402 answered, but no x402 requirement could be read: what was in it */
function whyNoChallenge(loc) {
  const parts = [];
  if (loc.header.present && !loc.header.ok) parts.push(`the PAYMENT-REQUIRED header is ${loc.header.why}`);
  if (loc.body.present && !loc.body.ok) parts.push(`the body is ${loc.body.why}`);
  if (!loc.header.present && !loc.body.present) parts.push('there is no PAYMENT-REQUIRED header and no JSON body with accepts[]');
  if (loc.mpp) parts.push('a WWW-Authenticate: Payment challenge (MPP) is present, which this lint reports and does not grade');
  return parts.join('; ');
}

/**
 * Grade the first answer of an unpaid request (synchronous: no network). -> { done: {output, internals} } when nothing more needs fetching, or
 * { pending: { href, upper, slash, finish(probes) -> {output, internals} } } when the endpoint answered 402 with a readable challenge and the three paywall probes
 * (a HEAD, the upper-case path, the trailing-slash path; upper and slash are null when the spelling is the same URL) must be run first.
 * Used by lintDetailed below and, with canned answers, by the examples (tools/r23/x402/example.js).
 */
function assessMain({ url, href, method, res0, latencyMs, now }) {
  const res = { ...res0, headers: lowerKeys(res0.headers), body: res0.body || Buffer.alloc(0), contentType: res0.contentType || '' };
  const finalHref = res.url || href;
  const redirected = finalHref !== href;
  const checkedAt = new Date(now).toISOString();
  const C = collector();

  // the first answer
  const is402 = res.status === 402;
  C.add('http_402', is402, is402 ? 'HTTP 402 Payment Required' : explain(res, finalHref, href));
  C.add('no_redirect', !redirected, redirected ? `the unpaid request was redirected to ${P.plainUrl(finalHref)}; a payment is signed for the URL the client was given, so give the final URL` : 'answered at the URL given');
  const loc = P.locate(res);
  const finish = (extra) => {
    const cks = C.list();
    const g = grade(cks, extra.noX402);
    return {
      url: String(url), checked_at: checkedAt, verdict: g.verdict, score: g.score, version: extra.version ?? null, networks: extra.networks || [], checks: cks,
      raw: { status: res.status, headers: P.allowHeaders(res.headers), challenge: extra.challenge ?? null, latency_ms: latencyMs, ...(redirected ? { final_url: P.plainUrl(finalHref) } : {}) },
    };
  };
  const base = { loc, res, redirected, latencyMs, finalHref, href };
  if (loc.mpp) C.add('mpp_detected', true, 'a WWW-Authenticate: Payment challenge (MPP) is present; it is reported here and not graded');
  if (loc.header.present) C.add('header_decodes', loc.header.ok, loc.header.ok ? `PAYMENT-REQUIRED decodes to a JSON object (${loc.header.bytes} characters)` : `the PAYMENT-REQUIRED header is ${loc.header.why}`);

  if (!is402) return { done: { output: finish({ noX402: true }), internals: { ...base, primary: null, secondary: null, offers: [], ver: null } } };
  const found = Boolean(loc.primary);
  C.add('challenge_found', found, found ? `read from the ${loc.primary.source}` : `no x402 requirement could be read: ${whyNoChallenge(loc)}`);
  if (!found) return { done: { output: finish({ noX402: loc.mpp && !loc.header.present && !loc.body.present }), internals: { ...base, primary: null, secondary: null, offers: [], ver: null } } };
  const primary = loc.primary; const secondary = loc.secondary;
  const ver = gradedVersion(primary);
  C.add('version_known', primary.version === 1 || primary.version === 2, primary.version === 1 || primary.version === 2 ? `x402Version ${primary.version}` : `x402Version is ${primary.version === null ? 'missing or not a number' : P.show(primary.version, 20)}; graded as v${ver} from where it was found`);
  const wrongPlace = (primary.source === 'header' && ver === 1) || (primary.source === 'body' && ver === 2 && !loc.header.present);
  C.add('version_location', !wrongPlace, wrongPlace ? (primary.source === 'header' ? 'a v1 challenge is read from the JSON body, not from the PAYMENT-REQUIRED header' : 'a v2 challenge is read from the PAYMENT-REQUIRED header; clients do not look for it in the body') : `a v${ver} challenge in the ${primary.source}, where clients read it`);
  if (loc.header.present && loc.header.bytes > R.LIMITS.headerBytes) C.add('challenge_size', false, `the PAYMENT-REQUIRED header is ${loc.header.bytes} characters, over ${R.LIMITS.headerBytes}; a proxy with a small response header buffer drops or rejects it`);
  else if (loc.header.present) C.add('challenge_size', true, `${loc.header.bytes} characters`);
  const cc = String(res.headers['cache-control'] || '').toLowerCase();
  const noStore = /no-store|no-cache|private/.test(cc);
  const ages = [...cc.matchAll(/(?:^|[,\s])(?:s-maxage|max-age)=(\d+)/g)].map((m) => Number(m[1]));
  const cacheable = !noStore && (ages.some((a) => a > 0) || (/\bpublic\b/.test(cc) && ages.length === 0));
  C.add('challenge_not_cached', !cacheable, cacheable ? `Cache-Control "${P.show(cc, 80)}" lets a cache keep the 402, and with it a price or an expiry that may have changed` : cc ? `Cache-Control "${P.show(cc, 80)}"` : 'no Cache-Control header, and a 402 is not cached by default');

  const acc = Array.isArray(primary.value.accepts) ? primary.value.accepts : null;
  const okAccepts = Boolean(acc && acc.length > 0);
  C.add('accepts_present', okAccepts, okAccepts ? `${acc.length} offer(s)` : acc ? 'accepts is empty: there is nothing to pay' : 'accepts is missing or is not an array');
  let networks = []; let offers = [];
  if (okAccepts) {
    ({ networks, offers } = gradeOffers(C, primary.value, ver));
    gradeResource(C, primary.value, ver, [new URL(href), new URL(finalHref)]);
    if (secondary && secondary.version === primary.version && Array.isArray(secondary.value.accepts)) {
      const same = JSON.stringify(P.sortKeys(primary.value.accepts)) === JSON.stringify(P.sortKeys(secondary.value.accepts));
      C.add('versions_agree', same, same ? 'the header and the body carry the same offers' : 'the header and the body are the same version but carry different offers');
    } else if (secondary && secondary.version !== primary.version) {
      C.add('versions_agree', true, `a v${secondary.version} challenge in the ${secondary.source} (${Array.isArray(secondary.value.accepts) ? secondary.value.accepts.length : 0} offers) beside the v${primary.version} challenge in the ${primary.source}: two versions, not compared`);
    }
  }
  const v = variants(new URL(href));
  const internals = { ...base, primary, secondary, offers, ver };
  return {
    pending: {
      href, upper: v.upper, slash: v.slash,
      finish(probes) {
        gradeProbe(C, 'head_unpaid', 'a HEAD request', probes.head, true);
        gradeProbe(C, 'case_variant_unpaid', 'the upper-case path', probes.upper, false);
        gradeProbe(C, 'slash_variant_unpaid', 'the path with its trailing slash toggled', probes.slash, false);
        return { output: finish({ noX402: false, version: primary.version === 1 || primary.version === 2 ? primary.version : null, networks, challenge: P.capChallenge(primary.value) }), internals };
      },
    },
  };
}

/**
 * -> { output, internals }. `output` is the route's answer; `internals` ({ loc, primary, secondary, offers, ver, res, redirected, latencyMs, finalHref, href }) is what x402-test pays from.
 * Throws bad (400) for a URL the guard refuses and the 503 of the guard for an endpoint that cannot be reached: neither is a result.
 */
async function lintDetailed({ url, method = 'GET' }, deps = {}) {
  const d = { fetch: deps.fetch || defaultFetch, now: deps.now || Date.now, hrnow: deps.hrnow || hr, httpsOnly: Boolean(deps.httpsOnly), checkUrl: deps.checkUrl || ((u, o) => sf().checkUrl(u, o)),
    mainTimeoutMs: deps.mainTimeoutMs || R.LIMITS.mainTimeoutMs, probeTimeoutMs: deps.probeTimeoutMs || R.LIMITS.probeTimeoutMs };
  if (method !== 'GET' && method !== 'POST') throw bad('method must be GET or POST');
  const href = d.checkUrl(url, { httpsOnly: d.httpsOnly }).href;
  const mainOpts = { maxBytes: R.LIMITS.maxBytes, timeoutMs: d.mainTimeoutMs, userAgent: UA, accept: 'application/json, */*;q=0.1', method, httpsOnly: d.httpsOnly, acceptStatus: () => true, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' } } : {}) };
  const t0 = d.hrnow();
  let res0;
  try { res0 = await d.fetch(href, mainOpts); } catch (e) { throw refuse(e); }
  const latencyMs = Math.max(0, d.hrnow() - t0);
  const a = assessMain({ url, href, method, res0, latencyMs, now: d.now() });
  if (a.done) return a.done;
  const p = a.pending;
  // the paywall: only an endpoint that really asks for payment is probed
  const [head, upper, slash] = await Promise.all([
    probeOne(d, p.href, 'HEAD'),
    p.upper ? probeOne(d, p.upper, method) : null,
    p.slash ? probeOne(d, p.slash, method) : null,
  ]);
  return p.finish({ head, upper, slash });
}

const lintEndpoint = async (args, deps) => (await lintDetailed(args, deps)).output;

module.exports = { refuse, lintEndpoint, lintDetailed, assessMain, grade, collector, netInfo, gradeOffers, variants, explain, UA };
