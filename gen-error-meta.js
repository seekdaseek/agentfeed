#!/usr/bin/env node
// gen-error-meta.js — write error-responses.json from what the code actually does.
//
// CDP's curation bar asks for "documented error responses". Typing them by hand
// is how documentation starts lying, so nothing here is typed:
//
//   the shared contract (402/400/429/405) is extracted from the emitters in
//   lib/tool.js, lib/ratelimit.js, lib/x402v1.js and lib/compat.js, with every anchor asserted -- if someone changes
//   a status code or a body shape, this generator fails instead of publishing a
//   stale promise.
//
//   the per-route 400 is OBSERVED, not guessed. A scratch booted with
//   X402_MODE=off runs the handlers unpaid; every route that declares a required
//   input is probed with that input missing or malformed, and the real status and
//   body are recorded. A route whose only caller input is an optional symbol is
//   probed with that symbol malformed: a 400 for "no required input" would
//   otherwise be documented as an upstream failure, which stopped being true
//   when those symbols became optional. Routes with no input a caller can get
//   wrong are not given a fabricated example: their only 400 is an upstream
//   failure, and inventing a caller error for them would be the exact lie this
//   file exists to avoid.
//
// Usage:  BASE=http://127.0.0.1:3998 node gen-error-meta.js
//         ERROR_META_OUT=/some/file.json node gen-error-meta.js     (writes there instead of error-responses.json; the test uses it)
//         node gen-error-meta.js --anchors     (checks every anchor above and exits; needs no server, writes nothing)
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const BASE = process.env.BASE || 'http://127.0.0.1:3998';
const HOST = 'x402.ochinimus.app';
const OUT = process.env.ERROR_META_OUT || path.join(ROOT, 'error-responses.json');

// ---- 1. the shared contract, extracted from the emitters -------------------
function must(file, re, label) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const m = src.match(re);
  if (!m) throw new Error(`ABORT: ${label} not found in ${file} — the error contract moved, fix this generator`);
  return m;
}

const m400 = must('lib/tool.js', /res\.status\(400\)\.json\(\{\s*tool:\s*name,\s*error:\s*e\.message,\s*\.\.\.\(Array\.isArray\(e\.supported\) \? \{ supported: e\.supported \} : \{\}\)\s*\}\)/, '400 emitter');
const m429 = must('lib/ratelimit.js', /res\.status\(429\)\.json\(\{\s*error:\s*`rate limit: \$\{limit\} req\/min`,\s*retry_after:\s*retryAfter\s*\}\)/, '429 emitter');
// R10 F7: HEAD on a free /api route is answered like GET now; the bare 405 emitter is gone, and must stay gone.
if (/res\.set\('Allow',\s*'GET'\);\s*\n\s*res\.status\(405\)\.end\(\)/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'))) throw new Error('ABORT: server.js answers HEAD on a free route with a bare 405 again; update the 405 entry below');
const m402v1 = must('lib/x402v1.js', /x402Version: 1,\s*error: pr\.error \|\| 'Payment required',\s*accepts:/, 'x402 v1 402 body');
const m405json = must('lib/compat.js', /res\.set\('Allow', 'GET'\)\.status\(405\)\.json\(\{ error: `\$\{req\.method\} is not supported on \$\{req\.path\}: paid routes are GET/, '405 JSON emitter (non-GET on a paid route)');
const m410 = must('lib/compat.js', /res\.status\(410\)\.json\(\{\s*error: 'gone',/, '410 emitter');
const m410w = must('lib/compat.js', /res\.status\(410\)\.json\(\{ error: 'gone', status: 'withdrawn',/, '410 emitter (withdrawn routes)');
const m503 = must('lib/tool.js', /res\.status\(503\)\.json\(\{\s*tool:\s*name,\s*error:\s*e\.message,\s*retry_after:\s*ra,\s*\.\.\.\(e\.warming \? \{ warming: e\.warming \} : \{\}\)\s*\}\)/, '503 emitter');
// The limiter lives in lib/ratelimit.js (one object of named buckets, whatever their order). 'metered' is what this file has always
// called the GET limit (GET and POST /mcp) and 'other' the other-method limit; since R22 the shared 429 entry names the docs and
// unpaid buckets too, each number read from LIMITS (QUESTIONS 15).
const mLimits = must('lib/ratelimit.js', /const LIMITS = \{([^}]*)\};/, 'rate limit buckets');
const bucket = (name) => {
  const m = mLimits[1].match(new RegExp(`\\b${name}:\\s*(\\d+)`));
  if (!m) throw new Error(`ABORT: the ${name} bucket is not in LIMITS in lib/ratelimit.js — the error contract moved, fix this generator`);
  return Number(m[1]);
};
const mWindow = must('lib/ratelimit.js', /const WINDOW_MS = ([\d_]+);/, 'rate limit window');

const GET_LIMIT = bucket('metered');
const OTHER_LIMIT = bucket('other');
const DOCS_LIMIT = bucket('docs');
const UNPAID_LIMIT = bucket('unpaid');
const WINDOW_S = Number(mWindow[1].replace(/_/g, '')) / 1000;

// Structured, so SKILL.md and openapi.json render these numbers instead of
// carrying their own copies. discovery.js had LIMIT_GET/LIMIT_OTHER hardcoded.
const LIMITS = { get: GET_LIMIT, other: OTHER_LIMIT, docs: DOCS_LIMIT, unpaid: UNPAID_LIMIT, windowSeconds: WINDOW_S };

const SHARED = [
  {
    status: 402,
    name: 'Payment Required',
    when: 'No payment presented, or the payment did not settle.',
    body: { x402Version: 1, error: 'Payment required', accepts: ['<x402 v1 PaymentRequirements, one per v1 rail: base, solana>'] },
    note: 'x402 v2: the full challenge is base64 in the PAYMENT-REQUIRED response header, for every rail; read it first. x402 v1: the body above, for Base and Solana; pay it with X-PAYMENT.',
  },
  {
    status: 400,
    name: 'Bad Request',
    when: 'The handler threw: a missing or malformed caller parameter, or a symbol the route does not serve. Never charged: a status of 400 or more cancels the x402 settlement.',
    body: { tool: '<tool name>', error: '<human-readable reason>', supported: ['<only when the symbol is unsupported: the symbols this route serves>'] },
  },
  {
    status: 429,
    name: 'Too Many Requests',
    when: `More than ${GET_LIMIT} GET (or POST /mcp) requests from one IP in ${WINDOW_S}s. Three further allowances are counted separately, per IP and per ${WINDOW_S}s: ${OTHER_LIMIT} for other HTTP methods, ${DOCS_LIMIT} for the discovery documents (/openapi.json, /llms.txt, /SKILL.md, /auth.md and the /.well-known discovery files), and ${UNPAID_LIMIT} for GETs on a priced route that carry no payment, key or credential (the plain 402 challenge).`,
    body: { error: `rate limit: ${GET_LIMIT} req/min`, retry_after: '<seconds>' },
    note: 'Retry-After is also set as a response header. The number in the error text is the limit of the bucket that tripped.',
  },
  {
    status: 503,
    name: 'Service Unavailable',
    when: 'Our source failed or is stale: Hyperliquid could not be asked, a precomputed snapshot or our liquidation tape is past its staleness limit, or a history we record is not deep enough yet (open-interest spikes and the squeeze score need 24 hours of it). Never charged: a status of 400 or more cancels the x402 settlement.',
    body: { tool: '<tool name>', error: '<reason, including the snapshot age>', retry_after: 60, warming: '<only while a history is still building: warm_at, needs_hours>' },
    note: 'Retry-After is also set as a response header: 60 seconds by default, and for a history that is still building the time until it is ready, up to one hour.',
  },
  {
    status: 405,
    name: 'Method Not Allowed',
    when: 'A method other than GET or HEAD on a paid route (JSON body below, Allow: GET). HEAD on a paid route answers 402 with the challenge in PAYMENT-REQUIRED and no body; HEAD on a free route answers like GET, with no body.',
    body: { error: 'POST is not supported on /api/<route>: paid routes are GET. GET it unpaid for the 402 challenge.', allow: 'GET' },
  },
  {
    status: 410,
    name: 'Gone',
    when: 'The route was retired. Routes withdrawn on 2026-10-12 and 2026-10-13 because an upstream does not allow reselling its data (or, for two cross-venue products, because one clean venue is left) answer the body below, with a pointer to /pricing and, from 2026-10-13, the live routes that come closest; /api/sharp-move (retired Aug 19) names the closest live routes and their prices instead. Never charged.',
    body: { error: 'gone', status: 'withdrawn', route: '/api/<withdrawn route>', withdrawn: '2026-10-13', closest_live: ['/api/<live route>'], pricing: 'https://x402.ochinimus.app/pricing' },
  },
];

if (process.argv.includes('--anchors')) {
  console.log(`[error-meta] shared contract: ${SHARED.map((s) => s.status).join(', ')} — all anchors matched; limits ${JSON.stringify(LIMITS)}`);
  process.exit(0);
}

// ---- 2. per-route: probe the real 400 on a free-mode scratch ---------------
const META = JSON.parse(fs.readFileSync(path.join(ROOT, 'bazaar-examples.json'), 'utf8')).routes || {};
const { PRICES } = require('./payments.js');

const BAD_PATH_VALUE = 'not-a-valid-address';
// What a scratch missing a table, a file or a socket says (R2 step 4: an empty tape recorded "no such table: liquidations" as /api/liquidations' caller error).
const ENV_FAULT = /no such table|no such column|SQLITE_|ENOENT|ECONNREFUSED|unable to open database|readonly database/i;
// Optional inputs worth probing, with a value no validator accepts. Whatever the
// route really answers is recorded; only a 400 with an error body becomes the
// documented caller error.
const BAD_OPTIONAL_VALUE = { symbol: 'not-a-symbol' };
// Per tool, for routes whose only inputs are optional and validated (R3): probed with
// that one input malformed, so the documented 400 is the caller error it really is.
const BAD_OPTIONAL_BY_TOOL = { get_base_launches: { limit: '0' }, get_hl_whales: { top: '0' }, get_sec_8k: { hours: '0' }, get_fx_rates: { base: 'XX' }, get_tradfi_perps: { symbol: 'not a symbol!' } };

function requiredOf(pattern) {
  const m = META[pattern] || {};
  const q = (m.inputSchema && Array.isArray(m.inputSchema.required)) ? m.inputSchema.required : [];
  const p = (m.pathParamsSchema && m.pathParamsSchema.properties) ? Object.keys(m.pathParamsSchema.properties) : [];
  const props = (m.inputSchema && m.inputSchema.properties) ? Object.keys(m.inputSchema.properties) : [];
  return { tool: m.tool, query: q, pathParams: p, optional: props.filter((k) => !q.includes(k)), input: m.input || {}, pathValues: m.pathParams || {} };
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
  const bad = { ...BAD_OPTIONAL_VALUE, ...(BAD_OPTIONAL_BY_TOOL[req.tool] || {}) };
  const opt = (BAD_OPTIONAL_BY_TOOL[req.tool] ? Object.keys(BAD_OPTIONAL_BY_TOOL[req.tool]) : []).find((k) => req.optional.includes(k)) || req.optional.find((k) => k in BAD_OPTIONAL_VALUE);
  if (opt) {
    // Sent alone and malformed, so the handler's own validation meets it first.
    return { url: `${route}?${opt}=${encodeURIComponent(bad[opt])}`, violated: `optional query param ${opt} = ${bad[opt]}` };
  }
  return null;
}

async function main() {
  const out = { generatedAt: new Date().toISOString(), limits: LIMITS, shared: SHARED, routes: {} };
  const patterns = Object.keys(PRICES);
  let probed = 0, observed = 0, skipped = 0;
  const envFaults = [];

  for (const pattern of patterns) {
    const req = requiredOf(pattern);
    const probe = probeUrl(pattern, req);
    const entry = { requiredInputs: [...req.pathParams, ...req.query] };

    if (!probe) {
      entry.callerError = null; // no input a caller can get wrong: a 400 here can only be upstream
      skipped++;
    } else {
      probed++;
      const res = await fetch(BASE + probe.url, { headers: { host: HOST } });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
      if (res.status === 400 && body && body.error) {
        // A scratch with a missing table or file answers a 400 that is not a caller error at all; recorded, it would be published as one.
        if (ENV_FAULT.test(String(body.error))) envFaults.push(`${pattern}: ${body.error}`);
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

  if (envFaults.length) throw new Error(`ABORT: ${envFaults.length} probe(s) hit the scratch's own fault, not a caller error (seed or fix the scratch, nothing was written):\n  ${envFaults.join('\n  ')}`);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`[error-meta] ${patterns.length} paid routes`);
  console.log(`[error-meta]   probed ${probed}, real 400 observed on ${observed}`);
  console.log(`[error-meta]   ${skipped} have no input a caller can get wrong (no caller-error example, by design)`);
  console.log(`[error-meta]   ${probed - observed} probed but did not 400 (no input validation)`);
  console.log(`[error-meta] shared contract: ${SHARED.map((s) => s.status).join(', ')} — all anchors matched`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
