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
  // every value is one percent-encoded path segment, a DOI's slash included (10.1038%2Fnature14539). CDP's validate compares the resource URL with the
  // route template segment by segment (bazaar.routeTemplate.matches_resource) and behaves as if it decodes the path first: measured 29 Oct 2026,
  // /api/paper/10.1038/nature14539 AND /api/paper/10.1038%2Fnature14539 both fail it against /api/paper/:doi, while a %72 (an "r") inside another route's
  // segment passes. So no spelling of a DOI passes that one lint. This spelling is published because it is a single segment (a matcher that does not
  // decode accepts it), it is the URL CDP's own index already holds for the route (indexed 12-14 Oct), and the literal-slash spelling is still served
  // (lib/slash-path.js rewrites it to this form).
  const segment = (v) => encodeURIComponent(v);
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
