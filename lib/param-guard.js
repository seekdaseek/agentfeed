// lib/param-guard.js — an impossible path parameter is refused BEFORE anyone is asked to pay (R20e, 29 Oct 2026).
//
// Until now the paywall matched 'GET /api/wallet-activity/:wallet' on the route alone, so GET /api/wallet-activity/:wallet, .../notawallet and
// .../<a real address> all answered the same 402 at $0.02, and the handler checked the value only after the payer had signed. An agent that
// copied a URL template from a document paid-and-failed: the verification ran, the handler said 400, the settlement was cancelled (nobody was
// charged: no paid row has ever existed on a template path), but the agent had been shown a price for something that could never be sold, and
// the CDP Bazaar had indexed the literal template URLs (11 of 84 entries on 29 Oct).
//
// This middleware sits after the path canonicalisation and BEFORE every payment layer (prepaid key reserve, refusal recorder, x402 v1 and v2, tempo,
// MPP): a value the handler would reject is a 400 here, with no 402, no challenge, no key reserve and nothing to sign. It checks SHAPE only, with the
// same validator the handler uses (exported by the tool module, never a second copy), so it can never refuse a request the handler would have
// served. Whether the address has an account, the coin is listed or the DOI exists is still the handler's answer after payment, and a handler 4xx
// still settles nothing (every rail, test/param-guard.test.js).
//
// The rule table is DERIVED from PRICES: every priced route ending in /:param needs a validator for that param name, and test/param-guard.test.js
// fails when a new one is added without it. At runtime a route with no validator is let through (fail open): the guard narrows, it never takes a route down.
//
// R20f (29 Oct 2026): the same for QUERY values (lib/query-rules.js): an integer outside the range the handler enforces (?swaps=5), a word outside its
// list (?alg=md5), a code of the wrong shape (?base=EURO). The rules copy checks the handlers already answer with a 400; a missing parameter is NOT
// refused (the query-less URL is what every catalogue lists and it must stay a 402). AF_QUERY_GUARD=off (server.js) switches the query rules off
// without touching the path rules, which is how test/query-guard-real-server.test.js sees the handler's own answer to the same request.
'use strict';

const { canonPath, patternRegex } = require('./canon-path');
const { QUERY_RULES } = require('./query-rules');

const strip = (pattern) => String(pattern).replace(/^[A-Za-z]+\s+/, '');
// ":wallet", "{wallet}", "<wallet>", "[wallet]", "${wallet}": a placeholder copied out of a template, not a value
const PLACEHOLDER_RE = /^(?::[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_-]*\}|<[A-Za-z_][^<>]{0,38}>|\[[A-Za-z_][A-Za-z0-9_-]*\]|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)$/;

/** What each parameter name must look like, in words an agent can act on. */
const EXPECTED = {
  wallet: 'a Solana wallet address: 32 to 44 base58 characters (the alphabet has no 0, O, I or l)',
  mint: 'an SPL token mint address: 32 to 44 base58 characters (the alphabet has no 0, O, I or l)',
  coin: 'a Hyperliquid perp ticker: 1 to 20 letters or digits, e.g. BTC, ETH, SOL, HYPE, kPEPE',
  address: 'a crypto address: 14 to 120 letters and digits',
  domain: 'a hostname such as example.com (no URL, no IP address, no local names)',
  doi: 'a DOI such as 10.1038/nature14539 (the slash may be sent as written or as %2F)',
};

/** name -> check(value) -> null (shape ok) | the error message. The SAME validator the handler runs (exported by the tool module); lazy requires, the tool modules load their data on first use. */
function validators() {
  const { BASE58_RE } = require('./solrpc');
  return {
    wallet: (v) => (BASE58_RE.test(v) ? null : 'invalid wallet address'),
    mint: (v) => (BASE58_RE.test(v) ? null : 'invalid mint address'),
    coin: (v) => (require('../tools/signals').coinShape(v) ? null : `not a Hyperliquid perp ticker: "${String(v).slice(0, 40)}"`),
    address: (v) => (require('../tools/sanctions').ADDRESS_SHAPE.test(String(v).trim()) ? null : 'address must be 14-120 letters and digits (a Bitcoin, Ethereum, Tron, Solana, XRP, Litecoin or similar address)'),
    domain: (v) => { try { require('../tools/domain').parseDomain(v); return null; } catch (e) { return e.message; } },
    doi: (v) => { try { require('../tools/papers').normDoi(v); return null; } catch (e) { return e.message; } },
  };
}

/**
 * deps: { PRICES, routeUrls (lib/route-urls.js), db (optional: counts rejections), logger, queryRules (default lib/query-rules.js; {} = off), now }
 * -> { middleware, rules, queryRoutes, unguarded, check(pattern, value), checkQuery(pattern, query), match(path) }
 */
function makeParamGuard({ PRICES, routeUrls, db = null, logger = console, queryRules = QUERY_RULES, now = Date.now }) {
  const V = validators();
  const rules = [];
  const unguarded = [];
  for (const [pattern, p] of Object.entries(PRICES || {})) {
    if (!/^GET /.test(pattern) || !/\/:[A-Za-z0-9_]+/.test(pattern)) continue;
    const m = /^\/(?:[^/:]+\/)*:([A-Za-z0-9_]+)$/.exec(strip(pattern)); // exactly one param, and it is the last segment
    if (!m || !V[m[1]]) { unguarded.push(pattern); continue; }
    rules.push({ pattern, tool: p.tool, name: m[1], validate: V[m[1]], re: patternRegex(pattern), index: strip(pattern).split('/').filter(Boolean).length - 1 });
  }
  if (unguarded.length) logger.warn(`[param-guard] ${unguarded.length} path-parameter route(s) have NO validator and are NOT guarded: ${unguarded.join(', ')}`);

  // query rules: only for routes that are priced (a rule for a route that does not exist is reported, never silently kept)
  const queryRoutes = [];
  const queryUnknown = [];
  for (const [pattern, list] of Object.entries(queryRules || {})) {
    if (!PRICES || !PRICES[pattern]) { queryUnknown.push(pattern); continue; }
    queryRoutes.push({ pattern, tool: PRICES[pattern].tool, re: patternRegex(pattern), rules: list });
  }
  if (queryUnknown.length) logger.warn(`[param-guard] query rules for route(s) that are not priced and are NOT applied: ${queryUnknown.join(', ')}`);

  let bump = null;
  if (db) {
    db.exec(`CREATE TABLE IF NOT EXISTS param_rejected (
      day TEXT NOT NULL, route TEXT NOT NULL, kind TEXT NOT NULL, ip TEXT NOT NULL, user_agent TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, route, kind, ip, user_agent)) WITHOUT ROWID;`);
    const stmt = db.prepare(`INSERT INTO param_rejected (day, route, kind, ip, user_agent, n) VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT (day, route, kind, ip, user_agent) DO UPDATE SET n = n + 1`);
    bump = (tool, kind, req) => { try { stmt.run(new Date().toISOString().slice(0, 10), tool, kind, String(req.callerIp || req.ip || '?'), String(req.headers['user-agent'] || '-').slice(0, 200)); } catch { /* observation only */ } };
  }

  const match = (path) => { const c = canonPath(path); return rules.find((r) => r.re.test(c)) || null; };
  const rawValue = (path, rule) => {
    const segs = String(path).split(/[?#]/)[0].split('/').filter(Boolean);
    const seg = segs[rule.index];
    if (seg == null) return '';
    try { return decodeURIComponent(seg); } catch { return seg; }
  };
  /** -> null when the value may go on to the paywall, else { kind, body } with the 400 body */
  function check(rule, value) {
    const placeholder = PLACEHOLDER_RE.test(value);
    const message = placeholder ? `invalid ${rule.name}: "${value}" is a placeholder from a URL template, not a value` : rule.validate(value);
    if (!message) return null;
    const example = routeUrls.concrete(rule.pattern);
    return {
      kind: placeholder ? 'placeholder' : 'invalid',
      body: {
        tool: rule.tool,
        error: message,
        param: rule.name,
        expected: EXPECTED[rule.name],
        received: String(value).slice(0, 80),
        example,
        charged: false,
        note: `Nothing was asked of you and nothing was charged: this value can never be served. ${placeholder ? `Replace ${value} with a real ${rule.name}. ` : ''}Call ${example} to see a working request and its 402 challenge.`,
      },
    };
  }

  const matchQuery = (path) => { const c = canonPath(path); return queryRoutes.find((r) => r.re.test(c)) || null; };
  /** -> null when every query rule of the route passes, else { kind: 'query', body } */
  function checkQ(route, query0) {
    const query = query0 || {};
    for (const rule of route.rules) {
      let message;
      try { message = rule.check(query, { now: now() }); } catch { message = null; }   // a rule that throws is a rule that let the request through
      if (!message) continue;
      const example = routeUrls.concrete(route.pattern);
      const shown = query[rule.name] !== undefined ? query[rule.name] : (rule.name === 'class' ? query.asset_class : '');
      return {
        kind: 'query',
        body: {
          tool: route.tool,
          error: message,
          param: rule.name,
          expected: rule.expected,
          received: String(shown == null ? '' : shown).slice(0, 80),
          example,
          charged: false,
          note: `Nothing was asked of you and nothing was charged: this value can never be served. Send ${rule.name} as ${rule.expected}, or leave it out. Call ${example} to see a working request and its 402 challenge.`,
        },
      };
    }
    return null;
  }

  function middleware(req, res, next) {
    if (req.method !== 'GET') return next(); // HEAD arrives here as GET (server.js HEAD guard); other verbs were answered 405 before
    let verdict = null;
    let tool = null;
    const rule = match(req.path);
    if (rule) { verdict = check(rule, rawValue(req.path, rule)); tool = rule.tool; }
    if (!verdict && queryRoutes.length) {
      const qr = matchQuery(req.path);
      if (qr) { verdict = checkQ(qr, req.query); tool = qr.tool; }
    }
    if (!verdict) return next();
    if (bump) bump(tool, verdict.kind, req);
    res.set('Cache-Control', 'no-store');
    return res.status(400).json(verdict.body);
  }

  return {
    middleware, rules, queryRoutes, unguarded,
    check: (pattern, value) => { const r = rules.find((x) => x.pattern === pattern); return r ? check(r, value) : null; },
    checkQuery: (pattern, query) => { const r = queryRoutes.find((x) => x.pattern === pattern); return r ? checkQ(r, query) : null; },
    match, matchQuery, rawValue,
  };
}

module.exports = { makeParamGuard, PLACEHOLDER_RE, EXPECTED };
