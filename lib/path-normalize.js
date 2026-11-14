// lib/path-normalize.js: a request path that matches no route, with a client's trailing debris on it, is served as the route it names (R34, 14 Nov 2026).
//
// The calls table (status not_found, 7 days to 14 Nov) shows clients asking for /api/<route> plus a tail they copied from somewhere: |<network> in a network name this service
// does not enumerate (lib/compat.js only knows eip155 and solana), -<network>:<payTo>:<asset> glued on with a hyphen, :<digits>, a lone ":", and a quote written as &quot or %22.
// Each of them used to be a 404 where a 402 offer belonged.
//
// The rule, in order, and nothing else:
//   1. A path that already matches (a mounted route, a priced route in any spelling, a withdrawn route) is NEVER touched.
//   2. Otherwise ONE normalised candidate is built by applying the five strippers below in a fixed order, once each. If that candidate matches, the request is rewritten to it
//      (req.url AND req.originalUrl, so the paywall quotes the clean resource, like lib/compat.js stripNetworkSuffix); if it does not match, the request is left as it was and 404s as before.
//   3. Only GET and HEAD, only under /api/. The rewrite happens before the rate limiter, the key rail and every payment layer, so a rewritten path is paid for like the clean one:
//      it answers the same 402 unpaid, and a payment is verified and settled against the clean route. Nothing here answers, prices or settles anything.
// Every rewrite is counted in path_normalized (day, original, normalized, n) for 7 days: read it with  sqlite3 agentfeed.db "SELECT * FROM path_normalized ORDER BY day DESC, n DESC".
'use strict';

const CAIP_NS = '(?:eip155|solana|algorand|stellar|aptos|near|hedera|tron|ton|sui|bip122|cosmos|xrpl)';
const STEPS = [
  // a quote copied with the URL: &quot, &quot; or %22 (also %27 / a literal " ')
  (p) => p.replace(/(?:&quot;?|%22|%27|["'])+$/i, ''),
  // |<network> (raw or %7C), any CAIP-2 namespace: |eip155:8453, |algorand:wGHE2...=, |solana:5eyk...
  (p) => p.replace(new RegExp(`(?:\\||%7[cC])${CAIP_NS}:[A-Za-z0-9_=%-]{1,90}$`, 'i'), ''),
  // -<network>:<payTo>-<asset> glued on with a hyphen (a crawler building a key from an accept entry)
  (p) => p.replace(new RegExp(`-${CAIP_NS}:[A-Za-z0-9_=:%-]{1,200}$`, 'i'), ''),
  // :<digits>, as in /api/cascade-forecast:12
  (p) => p.replace(/:\d+$/, ''),
  // a lone trailing colon
  (p) => p.replace(/:$/, ''),
];

/** the one normalised candidate for `p` (a path, no query), or null when no stripper changed it */
function normalize(p) {
  let q = String(p == null ? '' : p);
  for (const s of STEPS) q = s(q);
  return q !== p && q.length > 0 ? q : null;
}

/**
 * deps: isKnown(path) -> boolean (does a route, priced or free or withdrawn, answer this path as it is spelled?),
 *       db (better-sqlite3, optional), now (ms clock, for tests)
 */
function makePathNormalizer({ isKnown, db = null, now = Date.now }) {
  let bump = null; let prune = null;
  const seen = new Set(); let seenDay = '';
  if (db) {
    try {
      db.exec('CREATE TABLE IF NOT EXISTS path_normalized (day TEXT NOT NULL, original TEXT NOT NULL, normalized TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (day, original)) WITHOUT ROWID');
      bump = db.prepare('INSERT INTO path_normalized (day, original, normalized, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, original) DO UPDATE SET n = n + 1');
      prune = db.prepare("DELETE FROM path_normalized WHERE day < date('now', '-7 days')");
      prune.run();
    } catch { bump = null; }
  }
  const record = (orig, norm) => {
    if (!bump) return;
    try {
      const day = new Date(now()).toISOString().slice(0, 10);
      if (day !== seenDay) { seenDay = day; seen.clear(); try { prune.run(); } catch { /* best effort */ } }
      const k = orig.slice(0, 300);
      if (!seen.has(k)) { if (seen.size >= 5000) return; seen.add(k); }   // at most 5000 distinct originals a day
      bump.run(day, k, norm.slice(0, 300));
    } catch { /* the log must never fail a request */ }
  };
  return function pathNormalizer(req, _res, next) {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !/^\/api\//i.test(req.url)) return next();
    const q = req.url.indexOf('?');
    const path = q < 0 ? req.url : req.url.slice(0, q);
    let known = false;
    try { known = isKnown(path); } catch { known = true; }          // on doubt, leave the request alone
    if (known) return next();                                       // rule 1: a matching path is never touched
    const cand = normalize(path);
    if (!cand) return next();
    let ok = false;
    try { ok = isKnown(cand); } catch { ok = false; }
    if (!ok) return next();                                         // rule 2: still no route, so it stays the 404 it was
    req.pathNormalizedFrom = path;
    req.url = cand + (q < 0 ? '' : req.url.slice(q));
    req.originalUrl = String(req.originalUrl).replace(path, cand);
    record(path, cand);
    return next();
  };
}

module.exports = { normalize, makePathNormalizer, STEPS };
