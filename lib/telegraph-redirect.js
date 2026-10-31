// lib/telegraph-redirect.js: /telegraph/api/<route> answers 308 to /api/<route> (R23 F1, 31 Oct 2026).
// The old path was asked for 130 times in October (78 token-risk, 52 trade-context) by 10 addresses. A 308 keeps the method and the query, so a client that follows it
// reaches the same paywall as one that asked for /api/<route>. It is a redirect only when /api/<route> is a route this service mounts (GET, as the request is): a path with
// no such route, a dot segment, or any method but GET and HEAD falls through to whatever the request would have got anyway. Nothing is answered or priced here.
'use strict';

const PREFIX = /^\/telegraph(\/api\/.*)$/i;
const DOT_SEGMENT = /(^|\/)(\.|%2e|\.%2e|%2e\.|%2e%2e)(\/|$)/i;

/** does this Express app mount a route (not a middleware) that answers `method` for `path`? Reads the router's own layers, so priced, free and parameter routes are all seen. */
function routeExists(app, method, path) {
  const stack = app && app._router && app._router.stack;
  if (!Array.isArray(stack)) return false;
  const m = String(method).toLowerCase();
  for (const layer of stack) {
    if (!layer.route || !layer.route.methods) continue;
    if (!layer.route.methods[m] && !(m === 'head' && layer.route.methods.get)) continue;
    if (layer.match(path)) return true;
  }
  return false;
}

function telegraphRedirect() {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const hit = PREFIX.exec(req.path);
    if (!hit) return next();
    const target = hit[1];                                   // '/api/<route>' as written
    if (DOT_SEGMENT.test(target) || target.includes('\\')) return next();
    let exists = false;
    try { exists = routeExists(req.app, req.method, target); } catch { exists = false; }
    if (!exists) return next();
    const q = req.originalUrl.indexOf('?');
    res.set('Cache-Control', 'public, max-age=300');
    return res.redirect(308, target + (q === -1 ? '' : req.originalUrl.slice(q)));
  };
}

module.exports = { telegraphRedirect, routeExists };
