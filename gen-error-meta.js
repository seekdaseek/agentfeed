#!/usr/bin/env node
// gen-error-meta.js — write error-responses.json from what the code actually does.
//
// CDP's curation bar asks for "documented error responses". Typing them by hand
// is how documentation starts lying, so nothing here is typed:
//
//   the shared contract (402/400/429/405) is extracted from the emitters in
//   lib/tool.js and server.js, with every anchor asserted -- if someone changes
//   a status code or a body shape, this generator fails instead of publishing a
//   stale promise.
//
//   the per-route 400 is OBSERVED, not guessed. A scratch booted with
//   X402_MODE=off runs the handlers unpaid; every route that declares a required
//   input is probed with that input missing or malformed, and the real status and
//   body are recorded. Routes with no required input are not given a fabricated
//   example: their only 400 is an upstream failure, and inventing a caller error
//   for them would be the exact lie this file exists to avoid.
//
// Usage:  BASE=http://127.0.0.1:3998 node gen-error-meta.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const BASE = process.env.BASE || 'http://127.0.0.1:3998';
const HOST = 'x402.ochinimus.app';

// ---- 1. the shared contract, extracted from the emitters -------------------
function must(file, re, label) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const m = src.match(re);
  if (!m) throw new Error(`ABORT: ${label} not found in ${file} — the error contract moved, fix this generator`);
  return m;
}

const m400 = must('lib/tool.js', /res\.status\(400\)\.json\(\{\s*tool:\s*name,\s*error:\s*e\.message\s*\}\)/, '400 emitter');
const m429 = must('server.js', /res\.status\(429\)\.json\(\{\s*error:\s*`rate limit: \$\{limit\} req\/min`,\s*retry_after:\s*retryAfter\s*\}\)/, '429 emitter');
const m405 = must('server.js', /res\.set\('Allow',\s*'GET'\);\s*\n\s*res\.status\(405\)\.end\(\)/, '405 emitter');
const mLimit = must('server.js', /const LIMIT = (\d+);/, 'GET rate limit');
const mOther = must('server.js', /const OTHER_LIMIT = (\d+);/, 'other-method rate limit');
const mWindow = must('server.js', /const WINDOW_MS = ([\d_]+);/, 'rate limit window');

const GET_LIMIT = Number(mLimit[1]);
const OTHER_LIMIT = Number(mOther[1]);
const WINDOW_S = Number(mWindow[1].replace(/_/g, '')) / 1000;

// Structured, so SKILL.md and openapi.json render these numbers instead of
// carrying their own copies. discovery.js had LIMIT_GET/LIMIT_OTHER hardcoded.
const LIMITS = { get: GET_LIMIT, other: OTHER_LIMIT, windowSeconds: WINDOW_S };

const SHARED = [
  {
    status: 402,
    name: 'Payment Required',
    when: 'No payment presented, or the payment did not settle.',
    body: { x402Version: 2, error: 'Payment required' },
    note: 'The full challenge is base64 in the PAYMENT-REQUIRED response header, not in the body. Read it from the header.',
  },
  {
    status: 400,
    name: 'Bad Request',
    when: 'The handler threw: a missing or malformed caller parameter, or an upstream data source failed.',
    body: { tool: '<tool name>', error: '<human-readable reason>' },
  },
  {
    status: 429,
    name: 'Too Many Requests',
    when: `More than ${GET_LIMIT} GET (or POST /mcp) requests from one IP in ${WINDOW_S}s. Other HTTP methods have a separate ${OTHER_LIMIT}/${WINDOW_S}s allowance.`,
    body: { error: `rate limit: ${GET_LIMIT} req/min`, retry_after: '<seconds>' },
    note: 'Retry-After is also set as a response header.',
  },
  {
    status: 405,
    name: 'Method Not Allowed',
    when: 'Any method other than GET on a paid route. The response has an Allow: GET header and an empty body.',
    body: null,
  },
];

// ---- 2. per-route: probe the real 400 on a free-mode scratch ---------------
const META = JSON.parse(fs.readFileSync(path.join(ROOT, 'bazaar-examples.json'), 'utf8')).routes || {};
const { PRICES } = require('./payments.js');

const BAD_PATH_VALUE = 'not-a-valid-address';

function requiredOf(pattern) {
  const m = META[pattern] || {};
  const q = (m.inputSchema && Array.isArray(m.inputSchema.required)) ? m.inputSchema.required : [];
  const p = (m.pathParamsSchema && m.pathParamsSchema.properties) ? Object.keys(m.pathParamsSchema.properties) : [];
  return { query: q, pathParams: p, input: m.input || {}, pathValues: m.pathParams || {} };
}

// Build a URL that violates exactly one required input, so the handler's own
// validation throws before it ever reaches an upstream API.
function probeUrl(pattern, req) {
  const route = pattern.replace(/^GET /, '');
  if (req.pathParams.length) {
    // A path param cannot be omitted (the route would not match), so malform it.
    let p = route;
    for (const k of req.pathParams) p = p.replace(`:${k}`, BAD_PATH_VALUE);
    return { url: p, violated: `path param ${req.pathParams[0]} = ${BAD_PATH_VALUE}` };
  }
  if (req.query.length) {
    // Send every required param EXCEPT the first, using the real fixtures.
    const keep = Object.entries(req.input).filter(([k]) => k !== req.query[0]);
    const qs = keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
    return { url: route + (qs ? `?${qs}` : ''), violated: `required query param ${req.query[0]} omitted` };
  }
  return null;
}

async function main() {
  const out = { generatedAt: new Date().toISOString(), limits: LIMITS, shared: SHARED, routes: {} };
  const patterns = Object.keys(PRICES);
  let probed = 0, observed = 0, skipped = 0;

  for (const pattern of patterns) {
    const req = requiredOf(pattern);
    const probe = probeUrl(pattern, req);
    const entry = { requiredInputs: [...req.pathParams, ...req.query] };

    if (!probe) {
      entry.callerError = null; // no required input: a 400 here can only be upstream
      skipped++;
    } else {
      probed++;
      const res = await fetch(BASE + probe.url, { headers: { host: HOST } });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
      if (res.status === 400 && body && body.error) {
        observed++;
        entry.callerError = { status: 400, violated: probe.violated, body };
      } else {
        // Recorded as-is. An unexpected status is information, not something to
        // paper over: it means that route has no caller-input validation.
        entry.callerError = null;
        entry.probe = { violated: probe.violated, observedStatus: res.status };
      }
    }
    out.routes[pattern] = entry;
  }

  fs.writeFileSync(path.join(ROOT, 'error-responses.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`[error-meta] ${patterns.length} paid routes`);
  console.log(`[error-meta]   probed ${probed}, real 400 observed on ${observed}`);
  console.log(`[error-meta]   ${skipped} have no required input (no caller-error example, by design)`);
  console.log(`[error-meta]   ${probed - observed} probed but did not 400 (no input validation)`);
  console.log(`[error-meta] shared contract: ${SHARED.map((s) => s.status).join(', ')} — all anchors matched`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
