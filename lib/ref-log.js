// lib/ref-log.js: which listing sent a caller (R29, 13 Nov 2026). A request with ?ref=<slug> (lower-case letters, digits and "-", 1 to 40) is counted once per (day, slug, caller, route kind, status class) in the
// ref_hits table when the response finishes. It only OBSERVES: it never changes a response, a header, a price or a body, runs after the rate limiter has set req.callerIp, and a failure to write is swallowed.
// Read it with ops/ref-stats.js (unique callers per ref per day). kind: 'free' for an answered 2xx, 'unpaid402' for the first-contact 402 on a paid route, 'paid' not counted here (the calls table has it).
'use strict';
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
function makeRefLog({ db, now = Date.now }) {
  db.exec(`CREATE TABLE IF NOT EXISTS ref_hits (day TEXT NOT NULL, ref TEXT NOT NULL, caller TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (day, ref, caller, kind))`);
  const bump = db.prepare(`INSERT INTO ref_hits (day, ref, caller, kind, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT (day, ref, caller, kind) DO UPDATE SET n = n + 1`);
  return function refLog(req, res, next) {
    const ref = req.query && typeof req.query.ref === 'string' ? req.query.ref : null;
    if (ref && SLUG.test(ref)) {
      res.on('finish', () => {
        try {
          const kind = res.statusCode === 402 ? 'unpaid402' : (res.statusCode >= 200 && res.statusCode < 300 ? 'free' : null);
          if (kind) bump.run(new Date(now()).toISOString().slice(0, 10), ref, String(req.callerIp || req.ip || 'unknown'), kind);
        } catch { /* observation only */ }
      });
    }
    next();
  };
}
module.exports = { makeRefLog, SLUG };
