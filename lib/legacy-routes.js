// lib/legacy-routes.js: the paths clients ask for that are one step away from a real route (R34, 14 Nov 2026). Nothing here is priced or paid: a redirect, or a 400 with an example.
//
//   /api/funding, /api/funding-rates            308 -> /api/funding-rate (the query string is kept)
//   /api/<route>/openapi.json                   308 -> /openapi.json          } a crawler that reads the path it was given as a BASE URL and appends the
//   /api/<route>/.well-known/x402               308 -> /.well-known/x402      } discovery files to it (31 addresses asked /api/tvl/ this way in 7 days)
//   /api/wallet-holdings, /api/wallet-activity  400 JSON with an example path, when no wallet is given (mounted AFTER the ?wallet= canonicalisation, so a query form never gets here)
//
// /telegraph/api/<name> is lib/telegraph-redirect.js (R23), unchanged.
// A 308 keeps the method and the query, and a status of 400 or more is never settled, so none of this can charge anybody or skip a payment.
'use strict';

const FUNDING = /^\/api\/funding(?:-rates)?\/?$/i;
const WRONG_BASE = /^\/api\/[A-Za-z0-9][A-Za-z0-9-]*\/(openapi\.json|\.well-known\/x402)$/i;
const BARE = /^\/api\/(wallet-holdings|wallet-activity)\/?$/i;

function legacyRedirects() {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const q = req.originalUrl.indexOf('?');
    const query = q === -1 ? '' : req.originalUrl.slice(q);
    if (FUNDING.test(req.path)) { res.set('Cache-Control', 'public, max-age=300'); return res.redirect(308, '/api/funding-rate' + query); }
    const m = WRONG_BASE.exec(req.path);
    if (m) { res.set('Cache-Control', 'public, max-age=300'); return res.redirect(308, m[1].toLowerCase() === 'openapi.json' ? '/openapi.json' : '/.well-known/x402'); }
    return next();
  };
}

/** deps: example(pattern) -> a concrete example URL for a route pattern ('GET /api/wallet-holdings/:wallet') */
function bareParamHelp({ example }) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const m = BARE.exec(req.path);
    if (!m) return next();
    const name = m[1].toLowerCase();
    let url = null; try { url = example(`GET /api/${name}/:wallet`); } catch { url = null; }
    return res.status(400).json({
      error: `${name}: a wallet address is required, as a path segment or as ?wallet=<address>`,
      example_path: `/api/${name}/<wallet-address>`,
      ...(url ? { example_url: url } : {}),
      note: 'A status of 400 is never charged.',
    });
  };
}

module.exports = { legacyRedirects, bareParamHelp, FUNDING, WRONG_BASE, BARE };
