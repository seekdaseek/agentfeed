// tools/r23/x402-lint.js: GET /api/x402-lint, the lint of an x402 endpoint's payment challenge (R23 T3, 31 Oct 2026). $0.05. It never pays and has no wallet.
// The logic is tools/r23/x402/lint.js and the rubric tools/r23/x402/rubric.js; this file is the route entry the lead wires into expansion.js.
'use strict';
const { z } = require('zod');
const { bad } = require('./common');
const R = require('./x402/rubric');
const { lintEndpoint } = require('./x402/lint');
const EX = require('./x402/example');

const USD = 0.05;
const NAME = 'get_x402_lint';
const ROUTE = 'GET /api/x402-lint';

/** the query -> { url, method }; every value arrives as a string, and a repeated parameter as an array */
function argsOf(a) {
  const q = a && typeof a === 'object' ? a : {};
  const stray = Object.keys(q).find((k) => k !== 'url' && k !== 'method');
  if (stray !== undefined) throw bad(`unknown parameter ${String(stray).slice(0, 40)}: the url value must be URL-encoded as a whole (a ? inside it is %3F and a & is %26)`);
  if (Array.isArray(q.url) || Array.isArray(q.method)) throw bad('url and method must each be given once');
  if (typeof q.url !== 'string' || q.url.trim() === '') throw bad('url is required: the x402 endpoint to check, URL-encoded');
  if (q.url.length > 2048) throw bad('url is longer than 2048 characters');
  const m = String(q.method == null || q.method === '' ? 'GET' : q.method).toUpperCase();
  if (m !== 'GET' && m !== 'POST') throw bad('method must be GET or POST');
  return { url: q.url.trim(), method: m };
}

const DESC = `Use when an agent needs to check an x402 endpoint's payment challenge before paying it. Returns a verdict, a 0 to 100 score and ${R.CHECKS.length} checks, paywall bypass included. Never pays. An unreachable endpoint answers 503 and a refused URL 400, neither charged.`;

/** the route entry; `deps` (fetch, now, ...) lets a test inject fakes, the real server passes none */
function makeEntries(deps = {}) {
  return [{
    name: NAME, route: ROUTE, usd: USD,
    tags: ['x402', 'lint', 'validation', 'developer', 'payments'],
    desc: DESC,
    schema: {
      url: z.string().describe('the x402 endpoint to check, URL-encoded: http or https, a public host, port 80 or 443'),
      method: z.enum(['GET', 'POST']).optional().describe('HTTP method to check, default GET (a POST is sent with an empty body)'),
    },
    title: 'x402 challenge lint',
    question: 'Is the payment challenge of this x402 endpoint well formed, and is its paywall closed to unpaid requests?',
    example: EX.lintExample(),
    run: async (args) => lintEndpoint(argsOf(args), deps),
  }];
}

module.exports = { entries: makeEntries(), makeEntries, argsOf, NAME, ROUTE, USD, DESC };
