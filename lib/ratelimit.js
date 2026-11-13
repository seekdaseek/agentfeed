// lib/ratelimit.js — the per-address request limiter (server.js mounts it once, right after keys.identify).
//
// Fixed one-minute window, keyed on CF-Connecting-IP. Cloudflare sets it from the connection it terminated, a caller cannot
// forge it through the edge, and it is the only address header that survives the tunnel (measured on this box: x-forwarded-for
// is APPENDED to what the caller sent, so its leftmost element is attacker-controlled; x-real-ip is absent). The fallback is the
// raw socket peer, never req.ip, which `trust proxy` derives from X-Forwarded-For.
//
// FOUR BUCKETS, because a registry prober is not a customer and a 783 KB document is not a 405.
//
//   metered  240/min  GET and POST /mcp (and HEAD on a free /api route, which runs that route's handler): everything that costs
//                     us work, free data routes and requests that carry a payment included. Raised from 60 because one
//                     `pay catalog check` probe is one request per manifest route and two probes in a minute tripped the old limit.
//   other   2400/min  HEAD/OPTIONS/PUT/PATCH/DELETE: answered before any handler (x402scan's verb sweep of 2026-09-25 had tripped
//                     the shared bucket and left 22 of 52 paid routes unregistered).
//   docs     120/min  GET /openapi.json, /llms.txt, /SKILL.md, /.well-known/x402* and (R15b) their aliases and the other /.well-known files: prebuilt documents (the biggest, x402.json, is
//                     783 KB; openapi.json 580 KB). Their own bucket so a sweep of the paid routes cannot starve them (15 Oct 2026:
//                     x402scan's `agentcash register` was answered 429 on /openapi.json at 18:22:58 and 18:24:46 UTC, and the same on
//                     Oct 14 for two more AWS addresses, because its 90-route sweep had already used the shared 240) and, the other
//                     way round, so a document flood cannot spend more bandwidth than before: 120 x 783 KB is under the 240 x 783 KB
//                     the shared bucket allowed. A registration fetches a handful of documents; 120 is 20 or more registrations a minute.
//   unpaid  1200/min  GET on a priced path with no payment header, no key and no MPP credential. Nothing runs but the x402 layer's
//                     plain challenge (a 2 KB body and an 11 KB PAYMENT-REQUIRED header), so it costs what a HEAD costs and sits
//                     between the 'metered' and 'other' limits. 1,200 is 3.3 sweeps of all 90 priced routes at the 4 unpaid GETs per
//                     route per day the heaviest registry prober was recorded making (unpaid_402, 360 for 90 routes), which covers a
//                     failed run and its retry plus a `pay catalog check` in the same minute. Requests that carry a payment, and the
//                     free data routes, stay on 'metered'.
//
// Retry-After on every 429, and one logged row per bucket per address per window (a flood must not become a write storm); the
// row reuses status bad_request, which this table's readers (afwatch, the solwatch MCP x402_revenue tool) already know.
'use strict';

const WINDOW_MS = 60_000;
const LIMITS = { metered: 240, other: 2400, docs: 120, unpaid: 1200 };
const LABELS = { metered: 'GET + POST /mcp', other: 'other-method', docs: 'discovery documents', unpaid: 'unpaid challenge' };
// documents and their aliases (R15b: lib/discovery-aliases.js): /swagger.json, /x402, /x402-resources, /api and /api/ (the small index),
// the /.well-known files crawlers ask for and (R25) /api/status and /status, the free health document (lib/status.js: one cached read of the sources every 30 s)
const DOC_PATH = /^\/(?:openapi\.json|llms\.txt|SKILL\.md|swagger\.json|auth\.md|x402|x402-resources|api\/?|api\/status|status)$|^\/\.well-known\/(?:x402(?:\.json|-resources|-services\.json|\/.*)?|ai-plugin\.json|agents\.json|agent-registration\.json|security\.txt|ai-catalog\.json|ard\.json|api-catalog|agent-skills\/index\.json)$/;

/**
 * deps: { logCall, isPricedPath(path), presentsPayment(req), now?, limits? }
 * Returns { middleware, sweep, classify, buckets, limits }.
 */
const { isApiPath } = require('./canon-path');

function makeRateLimiter({ logCall, isPricedPath, presentsPayment, now = Date.now, limits = {} }) {
  const L = { ...LIMITS, ...limits };
  const buckets = new Map();

  /** Which bucket a request counts against: 'docs' | 'unpaid' | 'metered' | 'other'. */
  function classify(req) {
    if (req.method === 'GET') {
      if (DOC_PATH.test(req.path)) return 'docs';
      if (isPricedPath(req.path) && !(req.afKey && req.afKey.presented) && !presentsPayment(req)) return 'unpaid';
    }
    // GET is the entire paid surface; POST /mcp is the MCP rail. A HEAD on a free /api route runs that route's handler like a GET
    // (R10 F7), so it is metered with GET. Everything else is answered before any handler and is counted separately, HEAD on a
    // paid route included (it only ever gets the challenge).
    const metered = req.method === 'GET' || (req.method === 'POST' && req.path === '/mcp')
      || (req.method === 'HEAD' && isApiPath(req.path) && !isPricedPath(req.path));
    return metered ? 'metered' : 'other';
  }

  function middleware(req, res, next) {
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || req.ip;
    // Assigned before any early return: the HEAD guard and every logCall read req.callerIp, including on the throttled path.
    req.callerIp = ip;
    // A request with an ACTIVE prepaid key is metered by that key's own bucket (keys.identify, rate_per_min), not by the address, so
    // a partner gateway behind one IP can be given more with ops/key-admin.mjs set-rate. Unkeyed requests, and every method
    // keys.identify does not meter, keep these buckets.
    if (req.afKey && req.afKey.active && (req.method === 'GET' || (req.method === 'POST' && req.path === '/mcp'))) return next();
    const t = now();
    let b = buckets.get(ip);
    if (!b || t - b.windowStart > WINDOW_MS) {
      b = { windowStart: t, n: { metered: 0, other: 0, docs: 0, unpaid: 0 }, logged: {} };
      buckets.set(ip, b);
    }
    req.rateBucket = b;
    const kind = classify(req);
    b.n[kind]++;
    const limit = L[kind];
    if (b.n[kind] > limit) {
      // Tell a well-behaved caller when to come back: without it a prober has nothing to back off on and reads the 429 as a
      // verdict about the endpoint rather than about its own pace.
      const retryAfter = Math.max(1, Math.ceil((b.windowStart + WINDOW_MS - t) / 1000));
      res.set('Retry-After', String(retryAfter));
      if (!b.logged[kind]) {
        b.logged[kind] = true;
        logCall({
          tool: 'rate_limited', status: 'bad_request', ip,
          error_msg: `rate limit: ${limit} req/min exceeded on the ${LABELS[kind]} bucket (retry after ${retryAfter}s)`,
          req_path: req.path, user_agent: req.headers['user-agent'], method: req.method,
        });
      }
      return res.status(429).json({ error: `rate limit: ${limit} req/min`, retry_after: retryAfter });
    }
    return next();
  }

  const sweep = () => { const t = now(); for (const [ip, b] of buckets) if (t - b.windowStart > WINDOW_MS * 2) buckets.delete(ip); };
  return { middleware, sweep, classify, buckets, limits: L };
}

module.exports = { makeRateLimiter, DOC_PATH, LIMITS, WINDOW_MS };
