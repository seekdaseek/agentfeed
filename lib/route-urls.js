// lib/route-urls.js — the spellings of a path-parameter route, derived from the PRICES key and the Bazaar example values, nowhere else.
//
// A priced route such as 'GET /api/wallet-activity/:wallet' has three spellings and each has one job:
//   pattern   /api/wallet-activity/:wallet            the key in PRICES and the Express route. NEVER published: an agent that copies it calls
//                                                    the literal ":wallet" (R20e, 29 Oct 2026: 11 of the 84 live Bazaar entries were exactly that).
//   template  /api/wallet-activity/{wallet}           the OpenAPI spelling, for documents that describe a family of URLs and say which part varies.
//   concrete  https://x402.ochinimus.app/api/wallet-activity/Gack9Utq...   a URL that works, built from the route's example values
//                                                    (bazaar-examples.json pathParams, the same values the Bazaar listing and /api/sample carry).
// Every document that prints a URL for a caller to GET prints the concrete one; the template appears next to it, labelled as a template.
'use strict';

const PARAM_RE = /:([A-Za-z0-9_]+)/g;
const strip = (pattern) => String(pattern).replace(/^[A-Za-z]+\s+/, '');

/** meta = bazaar-examples.json `routes` (pattern -> { pathParams, pathParamsSchema, ... }). */
function makeRouteUrls({ ORIGIN, meta = {} }) {
  const names = (pattern) => [...strip(pattern).matchAll(PARAM_RE)].map((m) => m[1]);
  const isTemplated = (pattern) => names(pattern).length > 0;
  const template = (pattern) => strip(pattern).replace(PARAM_RE, '{$1}');
  const example = (pattern, name) => {
    const v = meta[pattern] && meta[pattern].pathParams && meta[pattern].pathParams[name];
    return v == null || v === '' ? null : String(v);
  };
  // a DOI's slash stays a literal slash (R17, lib/slash-path.js rewrites it to the one-segment form); everything else is percent-encoded
  const segment = (v) => encodeURIComponent(v).replace(/%2F/gi, '/');
  /** the path with every :param replaced by its example value; null when a param has no example (a test fails on that, never a boot) */
  const concretePath = (pattern) => {
    let missing = false;
    const out = strip(pattern).replace(PARAM_RE, (_m, n) => { const v = example(pattern, n); if (v == null) { missing = true; return `{${n}}`; } return segment(v); });
    return missing ? null : out;
  };
  return {
    isTemplated,
    names,
    template,
    templateUrl: (pattern) => ORIGIN + template(pattern),
    example,
    concretePath,
    /** the URL to publish for a route: the concrete example when it has parameters, the plain URL when it has none. Falls back to the template only if an example is missing. */
    concrete: (pattern) => ORIGIN + (concretePath(pattern) || template(pattern)),
    params: (pattern) => names(pattern).map((name) => ({ name, example: example(pattern, name) })),
  };
}

module.exports = { makeRouteUrls, PARAM_RE };
