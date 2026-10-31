// agentfeed server.js — Session 2: x402 PAYMENTS ACTIVE on all /api routes.
// /health and / stay free. X402_MODE=off in .env reverts to free mode.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { db, logCall } = require('./db');
const { buildPaymentLayer, decodeSettlement, PRICES, BAZAAR_META } = require('./payments');
const { makeRefusalRecorder, sanitizeChallengeErrors, aliasXPayment, aliasAuthorizationPayment, makeMppOnX402Only, _headerShape } = require('./lib/refusals');
const { makeDemand } = require('./lib/demand');
const { makeV1 } = require('./lib/x402v1');
const x402v1 = makeV1({ shapeOf: _headerShape });
const { railNames } = require('./lib/rails');
const { getPrice } = require('./tools/prices');
const { getFunding, getFundingRate } = require('./tools/funding');
const { getFearGreed } = require('./tools/feargreed');
const { getWalletHoldings, getTokenMetadata } = require('./tools/onchain');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
// /api/<route>|eip155:<id> (raw or %7C) is served as /api/<route>; see lib/compat.js.
const compat = require('./lib/compat');
const { canonPath, isApiPath, pricedMatcher } = require('./lib/canon-path');
app.use(compat.stripNetworkSuffix);
// R23 F1: the old /telegraph/api/<route> path (130 requests in October) is a 308 to /api/<route> when that route exists (lib/telegraph-redirect.js)
app.use(require('./lib/telegraph-redirect').telegraphRedirect());
// R17: /api/paper/10.1038/nature14539 (a literal slash in the DOI) is the same route as /api/paper/10.1038%2Fnature14539: rewritten to the
// canonical one-segment form before the rate limiter, the key rail and the paywall (lib/slash-path.js).
app.use(require('./lib/slash-path').slashPathCanonical());
// R11: the seven language-model routes (Gemini) only serve callers inside Google's available regions (Gemini API Additional
// Terms). tools/llm/region-gate.js answers 451 {error, country} when CF-IPCountry is present and off that list (T1 and XX
// included), here, before the key, the rate limiter and every payment middleware, so a refusal is never charged; it also refuses
// POST /mcp calls to those seven tools. Every other route, and any request without the header, passes untouched.
app.use(require('./tools/llm/region-gate').regionGate);

// ---- prepaid API keys (R9, lib/keys.js): bought with one x402 payment, spent per call at the high-frequency price.
// identify() runs FIRST: it reads and removes the key header (so nothing downstream can log it), looks the hash up (no
// reserve) and applies the key's own per-minute bucket. charge() sits further down, after the HEAD guard, GET-only, the
// https fix and the query canonicalisation, and BEFORE the refusal recorder, the alias middlewares, x402 v1, tempo, MPP and
// the x402 gate, all of which skip a request with req.keyPaid.
const paymentsOn = (process.env.X402_MODE || 'on').toLowerCase() !== 'off';
const keys = require('./lib/keys').makeKeys({ db, PRICES, logCall, hfUsd: require('./lib/hf').hfUsd, paymentsOn });
require('./expansion').setKeys(keys);
app.use(keys.identify);
const skipForKey = (mw) => (req, res, next) => (req.keyPaid ? next() : mw(req, res, next));
const PORT = process.env.PORT || 3006;

if (!process.env.HELIUS_API_KEY) {
  console.error('FATAL: HELIUS_API_KEY missing from .env');
  process.exit(1);
}

// ---- rate limit: lib/ratelimit.js. Fixed one-minute window per Cloudflare-observed address, four buckets: GET + POST /mcp (240),
// other verbs (2400), discovery documents (120) and unpaid challenges on priced paths (1200); the reasons and the numbers are
// there. isPricedPath is defined below, and read at request time.
const { makeRateLimiter } = require('./lib/ratelimit');
const rateLimiter = makeRateLimiter({ logCall, isPricedPath: (p) => isPricedPath(p), presentsPayment: require('./lib/keys').presentsPayment });
app.use(rateLimiter.middleware);
setInterval(rateLimiter.sweep, 120_000).unref();

// ---- HEAD guard (must sit BEFORE the x402 layer)
// @x402 route matching is verb-exact: a pattern 'GET /api/x' never matches a
// HEAD request, while app.get() answers HEAD as well as GET — so a HEAD reached
// every paid handler unmetered (856 crawler probes since 2026-07-21, all one
// GCP IP). Still verb-exact in @x402/core 2.21.0 (checked 2026-09-15), so a
// dependency bump alone would not close it.
//
// A HEAD on a PAID route is answered with the 402 challenge (since 2026-10-08;
// 405 before). x402 v2 carries the whole challenge in the PAYMENT-REQUIRED
// header, so a bodiless answer still quotes, and a crawler that probes with
// HEAD sees a priced route instead of a dead one. It is done by handing the
// request to the x402 layer as a GET with every payment header removed: with
// nothing presented the layer can only answer its plain challenge, so a HEAD
// can never settle and never reach a handler. Node drops the body by itself,
// because it decided the response has none when the request arrived as HEAD.
// A HEAD on a free /api route is answered like a GET with no body (R10 F7):
// Express runs the app.get handler for HEAD and Node drops the body, so the
// status and headers are the GET's. It answered 405 until 2026-10-14, and 56
// HEADs from directory and liveness checkers (agentexchange-bazaar,
// hermes-contact-discovery, browsers) read that as a dead route. Such a HEAD is
// metered with GET (the limiter above), because it does run the handler.
// Matches /api/* only: /health, / and /.well-known are untouched.
// R19a (21 Oct 2026): "priced" and "under /api/" are decided on the CANONICAL path (lib/canon-path.js: case-insensitive, // collapsed, trailing / stripped,
// the rules @x402/core routes by), never on the spelling. This guard used an exact, case-sensitive regex while Express routes case-insensitively and
// with an optional trailing slash and the x402 gate only matches GET, so HEAD /API/<route> and HEAD /api/<route>/ reached the PAID handler with no
// payment: Content-Length and ETag of the paid answer went out (the paid answer for a route with few possible answers), the handler's upstream calls ran
// on our money, and a `free` row was written for a priced tool. Now EVERY HEAD under /api/ is handed on as a GET with the payment headers removed,
// whether or not it looks priced: a priced route can only answer its plain 402 challenge, a free route still answers like a GET with no body.
const PRICED = pricedMatcher(Object.keys(PRICES));
const isPricedPath = (p) => PRICED.test(p) || QUERY_ALIASABLE.some((r) => canonPath(p) === r.base.toLowerCase());
app.use((req, res, next) => {
  if (req.method !== 'HEAD' || !isApiPath(req.path)) return next();
  for (const h of ['payment-signature', 'x-payment', 'payment-authorization']) delete req.headers[h];
  if (/^payment\s/i.test(String(req.headers.authorization || '').trim())) delete req.headers.authorization;
  req.method = 'GET';
  req.headOnly = true;
  return next();
});

// Paid routes are GET-only: any other verb on a priced path is a JSON 405 (lib/compat.js).
app.use(compat.makeGetOnly({ PRICES }));

// ---- the 402 challenge must always advertise https
//
// @x402/express builds the challenge's resource.url as
// `${req.protocol}://${req.headers.host}${req.originalUrl}`
// (node_modules/@x402/express/dist/cjs/index.js), and with `trust proxy` set,
// req.protocol is whatever X-Forwarded-Proto says. A request that reaches this
// process over plain http therefore gets a challenge whose resource.url is
// http://, so payTo is quoted in a document naming an unauthenticated URL.
//
// Note what this does and does not fix. Through the edge it is belt and
// braces: the zone 308s http to https, so X-Forwarded-Proto is already https.
// It matters on the path that bypasses the edge entirely -- the origin answers
// on :3006 directly -- and there it makes the challenge name https. That port
// being reachable at all is the real exposure and is an infrastructure fix,
// not this one.
app.use((req, _res, next) => {
  req.headers['x-forwarded-proto'] = 'https';
  next();
});

// ---- query-form canonicalisation for path-parameter routes
//
// Five paid routes take their argument as a path segment
// (GET /api/token-risk/:mint). The x402 layer matches that exact pattern, so
// /api/token-risk?mint=... matched nothing, sailed past the paywall and then
// 404'd -- an agent following the published spec got "does not exist" where a
// 402 belonged. That is lost revenue and it reads as a broken provider.
//
// Rewriting to the canonical path form BEFORE the paywall means the paywall,
// the handler, the manifest and the audit row all still see one route. The
// alternative -- registering a second route per shape -- would have grown the
// advertised catalogue from 48 to 53 and listed the same product twice.
//
// The map is derived from PRICES, never hand-written, so it cannot drift from
// the routes that are actually registered and priced.
const QUERY_ALIASABLE = Object.keys(PRICES)
  .filter((r) => r.startsWith('GET ') && r.includes('/:'))
  .map((r) => {
    const p = r.slice(4);
    const i = p.indexOf('/:');
    return { base: p.slice(0, i), param: p.slice(i + 2) };
  });

app.use((req, _res, next) => {
  if (req.method !== 'GET') return next();
  const hit = QUERY_ALIASABLE.find((r) => canonPath(req.path) === r.base.toLowerCase());
  if (hit) {
    const value = req.query[hit.param];
    if (typeof value === 'string' && value.length > 0) {
      const rest = { ...req.query };
      delete rest[hit.param];
      const qs = new URLSearchParams(rest).toString();
      // Express re-derives req.path from req.url, so everything downstream --
      // including the x402 matcher -- sees the canonical form.
      req.url = `${hit.base}/${encodeURIComponent(value)}${qs ? `?${qs}` : ''}`;
    }
  }
  next();
});

// ---- an impossible path parameter is refused before anyone is asked to pay (R20e, lib/param-guard.js)
// GET /api/wallet-activity/:wallet, .../notawallet and a real address used to answer the same 402; the handler judged the value only after the
// payer had signed. Here, after every path rewrite (so the guard sees the canonical form of /api/x?wallet=..., of a DOI with a literal slash and
// of /api/x|network) and BEFORE the key reserve, the refusal recorder, x402 v1 and v2, tempo and MPP, a value the handler would reject is a 400:
// no challenge, no price, no reserve, nothing to sign. Shape only, with the handler's own validator; existence is still the handler's answer.
const routeUrls = require('./lib/route-urls').makeRouteUrls({ ORIGIN: require('./tools/discovery').ORIGIN, meta: BAZAAR_META });
// R20f: AF_QUERY_GUARD=off turns the QUERY rules (lib/query-rules.js) off and leaves the path rules on: the operator's way back if a rule ever refuses a value the
// handler would have served, and how test/query-guard-real-server.test.js reads the handler's own answer to the same request.
const queryGuardOn = (process.env.AF_QUERY_GUARD || 'on').toLowerCase() !== 'off';
const paramGuard = require('./lib/param-guard').makeParamGuard({ PRICES, routeUrls, db, ...(queryGuardOn ? {} : { queryRules: {} }) });
app.use(paramGuard.middleware);
console.log(`[param-guard] ${paramGuard.rules.length} path-parameter routes refuse an impossible value before the paywall${paramGuard.unguarded.length ? ` (${paramGuard.unguarded.length} unguarded)` : ''}; query rules: ${queryGuardOn ? `${paramGuard.queryRoutes.reduce((n, r) => n + r.rules.length, 0)} on ${paramGuard.queryRoutes.length} routes` : 'OFF (AF_QUERY_GUARD=off)'}`);

// ---- prepaid keys: refusals that must come before anyone pays (a duplicate key_hash is a 409, a top-up needs its key),
// then the atomic reserve for a call that carries a valid key. A key never reaches x402: an unknown, pending or revoked
// key is a 401 here. The key routes themselves are excluded from charge (credit cannot buy credit).
app.use(keys.purchaseGuard);
app.use(keys.charge);

// ---- refused payments (mounted BEFORE both payment layers)
// A request that presents a payment and still ends in 402 writes one calls row,
// status payment_refused, with the facilitator's or the middleware's reason.
// A plain unpaid challenge writes nothing. See lib/refusals.js. `mpp` is read
// at request time, after the MPP block below has set it.
app.use(skipForKey(makeRefusalRecorder({ logCall, PRICES, mppPayer: (req) => (mpp && mpp.credentialSource ? mpp.credentialSource(req) : null) })));
// Demand telemetry (lib/demand.js): unknown GET paths and unpaid 402s, observed on 'finish'.
app.use(skipForKey(makeDemand({ db, logCall, PRICES })));
// An x402 payment sent as "Authorization: Payment <base64 JSON>" is read as X-PAYMENT and
// the MPP header dropped for that request. Before the sanitizer, which then sees it.
app.use(skipForKey(aliasAuthorizationPayment));
// Rewrites at setHeader time, so the recorder above -- which reads the header
// when the response finishes -- records the reason the buyer was actually sent.
app.use(skipForKey(sanitizeChallengeErrors));
// X-PAYMENT with a v2 payload counts as PAYMENT-SIGNATURE; see lib/refusals.js.
// After the recorder (which already counts either header as presented) and the
// sanitizer (which explains a refused v1 payload), before both payment layers.
app.use(skipForKey(aliasXPayment));
// x402 v1 buyers (lib/x402v1.js): the v1 body on every 402, and X-PAYMENT v1 paid on
// base and solana. Here, before the MPP gates and the x402 layer; bound to that layer
// once it is built below, and inert until then.
app.use(skipForKey(x402v1.challengeBody));
app.use(skipForKey(x402v1.payments));
// An MPP credential on a route with no MPP gate gets that said in the challenge's error.
// mppOn and MPP_ROUTES are read at request time, after the MPP block below has set them.
// MPP tempo/charge (mpp/tempo.js): adds its challenge to every paid 402 and takes pull credentials.
// Here, before the solana gates and the x402 layer; inert until the MPP block below loads it.
app.use((req, res, next) => (!req.keyPaid && tempo && tempo.isReady() ? tempo.gate(req, res, next).catch(next) : next()));
app.use(skipForKey(makeMppOnX402Only({ mppPaths: () => (mppOn ? MPP_ROUTES.map((r) => r.replace(/^GET /, '')) : []), isTempo: (req) => !!(tempo && tempo.isReady() && tempo.isTempoCredential(req)) })));

// ---- MPP solana/charge layer (additive, MPP_ENABLED-gated)
// Mounted BEFORE the x402 layer so that a 402 can carry both challenges: MPP's
// in WWW-Authenticate, x402's in PAYMENT-REQUIRED. The reference payer reads
// the two from disjoint header namespaces (solana-foundation/pay,
// crates/core/src/client/mpp.rs:36-44 vs runner.rs:565-582), so existing x402
// clients never see the new header. With MPP_ENABLED unset, mppOn is false:
// no gate is mounted and wrapX402() returns the middleware unchanged.
//
// The module ships as a separate directory with its own node_modules, because
// mppx pins express>=5 as a peerOptional and this service runs express 4. So
// "mpp/ is not there yet" is a real deploy state, not a hypothetical, and a
// bare require would turn it into a dead service. Load it defensively: absent
// and unwanted is a logged no-op, absent but asked for is fatal and says so.
let mpp = null;
let mppLoadError = null;
try {
  mpp = require('./mpp');
} catch (e) {
  mppLoadError = e;
}
const mppWanted = (process.env.MPP_ENABLED || '').toLowerCase() === 'true';
// FAIL SOFT. MPP is an additive second payment protocol; x402 is the revenue
// rail. A broken MPP must never take x402 down with it. On 2026-09-19 a missing
// MPP_SECRET_KEY made init throw, this exited 1, and pm2 looped to `errored`
// with the paid surface dead. It is a loud no-op now instead: the service keeps
// serving x402 on every route, and the cause is named on one line.
if (mppWanted && !mpp) {
  console.error('[mpp] DISABLED: MPP_ENABLED=true but ./mpp could not be loaded:', mppLoadError.message);
  console.error('[mpp] DISABLED: continuing with x402 only; the paid surface is unaffected.');
}
if (!mppWanted && mppLoadError) {
  console.log('[mpp] not loaded (MPP disabled):', mppLoadError.message);
}
const mppOn = Boolean(mpp && mpp.isEnabled());
// solana/charge stays on these two routes, on purpose (R10 F9, 2026-10-14). mpp/index.js is route-generic, but @solana/mpp
// 0.7.0 fetches a fresh blockhash for EVERY unpaid challenge it builds (dist/server/Charge.js request(): getLatestBlockhash
// on rpcUrl, which is the shared Helius key, with no timeout and no cache). This service answers 20,000-42,000 unpaid 402s a
// day (unpaid_402, Oct 11-14; one health checker alone sent 10,593 on Oct 13), so every paid route would turn that into as
// many Helius calls and tie each 402's latency to Helius. Since Sep 23 the rail has settled 3 payments (mpp_claim). Tempo
// has no such cost and is on every paid route. To widen it: give the challenge a cached blockhash (or none: it is optional,
// the client fetches its own), then extend this list.
const MPP_ROUTES = ['GET /api/sol-price', 'GET /api/btc-price'];
let mppReady = null;
// MPP tempo/charge on every paid route (mpp/tempo.js), same flag and secret as solana/charge.
let tempo = null;
let tempoReady = null;
if (mppOn) {
  mppReady = mpp.init({ db, prices: PRICES, routes: MPP_ROUTES });
  try {
    tempo = require('./mpp/tempo');
    tempoReady = tempo.init({ prices: PRICES, recipient: process.env.PAY_TO_EVM, secretKey: process.env.MPP_SECRET_KEY, realm: process.env.MPP_REALM || 'x402.ochinimus.app', db })
      .then(() => { _docs = null; }) // the catalog documents tempo once it is up
      .catch((e) => { console.error('[mpp] tempo DISABLED:', e.message); tempo = null; _docs = null; });
  } catch (e) { console.error('[mpp] tempo DISABLED (load):', e.message); tempo = null; }
  app.get('/api/sol-price', skipForKey(mpp.gate('GET /api/sol-price')));
  app.get('/api/btc-price', skipForKey(mpp.gate('GET /api/btc-price')));
}

// ---- free discovery surface (mounted BEFORE the payment layer)
//
// /openapi.json, /.well-known/x402, /llms.txt and /SKILL.md. Measured
// 2026-09-25: `npx @agentcash/discovery x402.ochinimus.app -v` reported
// OPENAPI_NOT_FOUND, and x402scan treats a route with no input schema as
// non-invocable -- 48 paid routes were unreadable to both.
//
// Mounted HERE, above app.use(paymentMiddleware), so these can never be
// paywalled by accident: the middleware is not on the stack yet when they
// match. They are also deliberately absent from PRICES, like /api/fear-greed.
//
// The documents are DERIVED from PRICES, TAGS and bazaar-examples.json, so a
// route added or repriced cannot show up in one surface and not another. They
// are built once, on the first request that needs them, rather than at module
// load: x402Network and mppOn are only settled below, and a per-request rebuild
// would burn CPU on every crawl.
//
// FREE_TOOLS is the single list of unpriced HTTP routes. `/` publishes it and
// the discovery documents consume it, so the two cannot disagree -- this used
// to be a literal inside the `/` handler that had already gone wrong once.
const FREE_TOOLS = ['get_fear_greed', 'get_last_liquidation', 'get_exit_method', 'get_forecast_record'];
const discovery = require('./tools/discovery');
const { TAGS } = require('./payments');

let _docs = null;
function docs() {
  if (_docs) return _docs;
  const ctx = {
    PRICES,
    TAGS,
    META: BAZAAR_META,
    FREE_TOOLS,
    mpp: { active: mppOn, routes: mppOn ? MPP_ROUTES : [] },
    tempo: { active: !!(tempo && tempo.isReady()) },
    network: x402Network,
  };
  _docs = {
    openapi: discovery.buildOpenApi(ctx),
    wellKnown: discovery.buildWellKnown(ctx),
    llms: discovery.buildLlmsTxt(ctx),
    skill: discovery.buildSkillMd(ctx),
  };
  return _docs;
}

// ---- free sample responses (conversion surface)
//
// A buyer cannot see what a paid route returns before paying, which is the
// single biggest reason a listing is skipped. Kronos publishes a sample per
// route and is the best-selling seller in this niche that does. These are the
// SAME stored examples the Bazaar listing carries -- served from
// bazaar-examples.json, not a second hand-written copy that could drift.
//
// One templated path rather than 52 separate ones: the catalogue is already at
// the size where a crawler warns about agent token budgets, and 52 more
// near-identical operations would make that worse for no information gained.
const SAMPLE_META = (() => { try { return require('./bazaar-examples.json').routes || {}; } catch { return {}; } })();
const sampleIndex = new Map();
for (const [pattern, m] of Object.entries(SAMPLE_META)) {
  const path = pattern.replace('GET ', '');
  const slug = path.replace(/^\/api\//, '').replace(/\/:.*$/, '');
  sampleIndex.set(slug, { pattern, path, meta: m });
  if (m.tool) sampleIndex.set(m.tool, { pattern, path, meta: m });
}
app.get('/api/sample', (_req, res) => res.json({
  service: 'agentfeed',
  what: 'A real captured response for any paid route, free. The same example the Bazaar listing carries.',
  usage: 'GET /api/sample/<route>  e.g. /api/sample/liq-pulse or /api/sample/get_liq_pulse',
  routes: [...new Set([...sampleIndex.values()].map((v) => routeUrls.template(v.pattern)))].sort(),
}));
app.get('/api/sample/:route', (req, res) => {
  const hit = sampleIndex.get(String(req.params.route || '').toLowerCase()) || sampleIndex.get(String(req.params.route || ''));
  if (!hit) {
    return res.status(404).json({ error: 'no such paid route',
      requested: req.params.route,
      hint: 'GET /api/sample lists every route that has a sample' });
  }
  const m = hit.meta;
  res.json({
    route: routeUrls.template(hit.pattern),
    tool: m.tool,
    price_usd: m.price_usd,
    paid_url: routeUrls.concrete(hit.pattern),
    how_to_pay: `GET the paid_url${routeUrls.isTemplated(hit.pattern) ? ` (it is an example: replace ${routeUrls.names(hit.pattern).map((n) => `{${n}}`).join(', ')} with your own value, see path_params_example and input_schema)` : ''}; the 402 carries the challenge in the PAYMENT-REQUIRED response header (x402 v2).`,
    input_example: m.input || {},
    ...(m.pathParams ? { path_params_example: m.pathParams } : {}),
    input_schema: m.inputSchema || { properties: {} },
    sample_response: m.output ? m.output.example : null,
    captured: m.synthetic
      ? 'built by the real brief code over a seeded synthetic market: field names, types and the wording of the sentences are exactly what the paid route returns, but every number in it is generated and none is a market reading'
      : m.static
      ? 'built by the same code that builds the real response, with a placeholder key (a capture would create a key); field names and types are exactly what the paid route returns'
      : 'a real response from this service, trimmed; field names and types are exactly what the paid route returns',
    ...(m.redacted ? { redacted: 'values from OKX and Binance (the liquidation tape\'s prints) are null in this stored sample: their terms forbid redistributing that data' } : {}),
  });
});

// ---- free public track record
//
// "Verifiable accuracy is the moat" is the line the best-selling forecaster in
// this niche sells on. This is the SAME function the free MCP tool
// get_forecast_record serves, not a second implementation: every row was
// written before its window opened and settled afterwards from the exchange
// public feed. caliper owns record.db and this only ever reads it.
const { getForecastRecord } = require('./tools/cascade-forecast');
app.get('/api/forecast-record', async (req, res) => {
  try {
    res.json({ tool: 'get_forecast_record', data: await getForecastRecord({ query: req.query || {} }), paid: false });
  } catch (e) {
    res.status(502).json({ tool: 'get_forecast_record', error: e.message });
  }
});

// ---- prepaid keys: the balance check is free, and /keys is a static buy page (tools/keys-page.js: no library, no CDN,
// a strict CSP). Both are mounted above the payment layer; neither is in PRICES.
app.get('/api/keys/balance', keys.balance);
app.get('/keys', require('./tools/keys-page').keysPage);

// R15d: the five documents that change with every deploy say `no-cache` (the ETag keeps a revalidation a 304); lib/discovery-aliases.js
{ const A = require('./lib/discovery-aliases'); app.get(A.NO_CACHE_DOC_PATHS, A.docNoCache); }
app.get('/openapi.json', (_req, res) => res.json(docs().openapi));
app.get('/.well-known/x402', (_req, res) => res.json(docs().wellKnown));
app.get('/llms.txt', (_req, res) => res.type('text/plain; charset=utf-8').send(docs().llms));
app.get('/SKILL.md', (_req, res) => res.type('text/markdown; charset=utf-8').send(docs().skill));
// R15b: the discovery paths crawlers asked for and got a 404 on (lib/discovery-aliases.js); all in the 'docs' rate bucket
require('./lib/discovery-aliases').mountDiscoveryAliases(app, { docs, PRICES, ORIGIN: discovery.ORIGIN, version: require('./server.json').version });
// R17: what the agent-readiness scan and the agent registries read (lib/agent-ready.js): ard.json, api-catalog, the skills index, auth.md
require('./lib/agent-ready').mountAgentReady(app, { docs, PRICES, ORIGIN: discovery.ORIGIN });
// Directory domain claims (402index, nohumans): inert 404s until a claim writes a value.
require('./lib/well-known-claims').mountWellKnownClaims(app);

// The Bazaar reads iconUrl off each route's resource object; payments.js points
// every route at this path. Read once at boot -- a 256x256 PNG is 8 KB and
// re-reading it per crawl is pointless. A missing file 404s rather than
// throwing, because no icon must never take the paid surface down.
let ICON = null;
try {
  ICON = fs.readFileSync(path.join(__dirname, 'icon.png'));
} catch (e) {
  console.warn('[discovery] icon.png not readable, /icon.png will 404:', e.message);
}
function sendIcon(res, type) {
  if (!ICON) return res.status(404).json({ error: 'icon not available' });
  res.type(type).set('Cache-Control', 'public, max-age=86400').send(ICON);
}
app.get('/icon.png', (_req, res) => sendIcon(res, 'image/png'));

// Same buffer at /favicon.ico. Measured 2026-09-25: `npx @agentcash/discovery
// x402.ochinimus.app -v` reported FAVICON_MISSING alongside OPENAPI_NOT_FOUND,
// and its hint is "serve /favicon.ico, .png, or .svg at your root". The bytes
// are PNG, not ICO, so the declared type is image/png rather than a lie about
// the container -- every browser and the crawler accept a PNG served here, and
// /favicon.ico is the path they both request without being told to.
app.get('/favicon.ico', (_req, res) => sendIcon(res, 'image/png'));
app.get('/favicon.png', (_req, res) => sendIcon(res, 'image/png'));

// ---- x402 payment layer (mounted BEFORE the /api routes)
let paymentLayer = null; // read by the discovery routes (lib/compat.js)
let x402Network = 'off';
if (paymentsOn) {
  const layer = buildPaymentLayer();
  paymentLayer = layer;
  x402Network = layer.network;
  const gate = mppOn ? mpp.wrapX402(layer.middleware) : layer.middleware;
  // R10 Phase A: which accepts this request's 402 carries (lib/rail-ctx.js): the default list, or one network asked for with
  // /api/<route>|<network> or chosen by the payer. After every alias middleware, so the payment header is the one core reads.
  app.use(require('./lib/rail-ctx').railContext);
  // A request lib/x402v1.js has verified is paid for; it settles after the handler.
  app.use((req, res, next) => (req.x402v1 || req.tempoPending || req.keyPaid ? next() : gate(req, res, next)));
  x402v1.bind(layer)
    .then((nets) => console.log(`[x402v1] active on ${nets.join(', ') || 'no network (facilitator lists no v1 kind)'}`))
    .catch((e) => console.error('[x402v1] DISABLED: facilitator /supported failed:', e.message));
}

// ---- route wrapper: timing + audit, and the paid flag.
// Lives in lib/tool.js so it can be unit-tested without booting this file.
const { makeTool } = require('./lib/tool');
const { tool } = makeTool({ paymentsOn, PRICES, decodeSettlement, logCall });

// ---- routes (patterns must match PRICES keys in payments.js exactly)
app.get('/api/sol-price', tool('get_sol_price', 0.001, () => getPrice('SOL')));
app.get('/api/btc-price', tool('get_btc_price', 0.001, () => getPrice('BTC')));

app.get('/api/funding-rate', tool('get_funding_rate', 0.005, (req) => getFundingRate({ symbol: req.query.symbol })));

// R15b: the three free routes carry `related`, the closest paid route as plain data (lib/related.js)
const { relatedFor } = require('./lib/related');
app.get('/api/fear-greed', tool('get_fear_greed', 0.001, async () => ({ ...(await getFearGreed()), related: relatedFor('get_fear_greed', PRICES) })));

app.get('/api/market-snapshot', tool('get_market_snapshot', 0.005, async () => {
  const [sol, btc, fundingSol, fundingBtc, fg] = await Promise.all([
    getPrice('SOL'), getPrice('BTC'), getFunding('SOL'), getFunding('BTC'), getFearGreed(),
  ]);
  return { sol, btc, funding: { sol: fundingSol, btc: fundingBtc }, fear_greed: fg };
}));

app.get('/api/wallet-holdings/:wallet', tool('get_wallet_holdings', 0.008,
  (req) => getWalletHoldings(req.params.wallet)));

app.get('/api/token-metadata/:mint', tool('get_token_metadata', 0.005,
  (req) => getTokenMetadata(req.params.mint)));

const { getRecentLiquidations, getLiquidationStats, getLastLiquidation, getLiquidationLeaders } = require('./tools/liquidations');
app.get('/api/liquidations', tool('get_recent_liquidations', 0.005,
  (req) => getRecentLiquidations(req)));
app.get('/api/liquidation-leaders', tool('get_liquidation_leaders', 0.02,
  (req) => getLiquidationLeaders(req)));
app.get('/api/liquidation-stats', tool('get_liquidation_stats', 0.01,
  () => getLiquidationStats()));
app.get('/api/last-liquidation', tool('get_last_liquidation', 0,
  async () => ({ ...(await getLastLiquidation()), related: relatedFor('get_last_liquidation', PRICES) })));

// overhang method disclosure. FREE, and deliberately absent from PRICES in payments.js
// so the x402 middleware never sees a $0 route (same treatment as /api/last-liquidation).
const { getExitMethod } = require('./tools/overhang');
app.get('/api/exit-method', tool('get_exit_method', 0,
  async () => ({ ...(await getExitMethod()), related: relatedFor('get_exit_method', PRICES) })));

const { getCascadeAlert } = require('./tools/cascade');
app.get('/api/cascade', tool('get_cascade_alert', 0.01,
  (req) => getCascadeAlert(req)));
// full universe (every perp in the tape). same detector, scope forced to 'all'.
app.get('/api/cascade-scan', tool('get_cascade_scan', 0.05,
  (req) => getCascadeAlert({ query: { ...(req.query || {}), scope: 'all' } })));


const { getPositioning } = require('./tools/positioning');
app.get('/api/positioning', tool('get_positioning', 0.005,
  () => getPositioning()));

const { getTradeContext } = require('./tools/tradecontext');
app.get('/api/trade-context', tool('get_trade_context', 0.01,
  () => getTradeContext()));

const { getTokenRisk } = require('./tools/tokenrisk');
app.get('/api/token-risk/:mint', tool('get_token_risk', 0.01,
  (req) => getTokenRisk(req.params.mint)));

require('./expansion').register(app, tool);

// ---- free meta routes
app.get('/health', (_req, res) => res.json({ ok: true, service: 'agentfeed', x402: x402Network }));

const { renderLanding } = require('./tools/landing');
// R17: GET / sends the Link header (api-catalog, service-desc, service-doc) and Vary: Accept on every representation; Accept: text/markdown gets the llms.txt text
app.get('/', require('./lib/agent-ready').rootNegotiation({ ORIGIN: discovery.ORIGIN, llmsText: () => docs().llms }));
app.get('/', (req, res, next) => {
  if ((req.headers.accept || '').includes('text/html')) {
    // Same measurement `/` publishes as JSON, so the HTML and the JSON
    // answer of one URL can never disagree. Cached an hour inside liqdb.
    let coverage = null;
    try { coverage = require('./tools/liqdb').getPerpCoverage(); } catch { coverage = null; }
    return res.type('html').send(renderLanding(PRICES, x402Network, coverage));
  }
  next();
});

// One derived sentence about prepaid keys for every text surface (lib/keys.js keysSentence reads the price table).
const keySentence = () => { const t = require('./lib/keys').keysSentence(PRICES); return t ? ` ${t}` : ''; };

// MPP tempo/charge as mounted right now (mpp/tempo.js): every paid route, or nothing.
function tempoInfo() {
  const on = !!(tempo && tempo.isReady());
  return { active: on, intent: 'tempo/charge', chainId: 4217, currencies: on ? tempo.TOKENS.map((t) => t.symbol) : [], modes: ['pull'], routes: on ? 'every paid route' : [] };
}

app.get('/', (_req, res) => res.json({
  service: 'agentfeed',
  description: `${require('./tools/scope').SCOPE} Paid per-call in USDC via x402 on ${require('./lib/rails').httpRailNames()}.${require('./lib/rails').onRequestSentence() ? ` ${require('./lib/rails').onRequestSentence()}` : ''}${require('./lib/hf').hfSentence()} Every paid route also carries MPP tempo/charge challenges (Tempo mainnet, OUSD or USDC.e, pull mode) and /api/sol-price and /api/btc-price MPP solana/charge, on the same 402. No API key is needed to pay per call.${keySentence()} Copy payTo only from a fresh 402 response, never from transaction history.`,
  x402: { active: paymentsOn, network: x402Network, chains: require('./lib/rails').httpRails().map((r) => r.network), chains_on_request: require('./lib/rails').onRequestRails().map((r) => r.network) },
  // DERIVED, not restated: whatever is actually mounted is what is advertised.
  mpp: { active: mppOn, intent: 'solana/charge', routes: mppOn ? MPP_ROUTES : [], tempo: tempoInfo() },
  // The three routes that are genuinely unpriced over HTTP. This used to read
  // ['get_fear_greed','pricing'], which missed two of them and listed `pricing`,
  // an MCP-only tool with no HTTP route — so `/` told callers the wrong thing
  // about what they could have for nothing. Nothing in this process models
  // "free HTTP route", so the guard is tools/check-paymd-live.mjs, which probes
  // every route on `/` against the live service.
  free_tools: FREE_TOOLS,
  // Derived from the live liquidation tape, not restated. The studio card said
  // 880+ while PAY.md and the README said ~600; publishing the measurement is
  // what lets a checker settle that instead of a human guessing.
  coverage: (() => { try { return require('./tools/liqdb').getPerpCoverage(); } catch { return null; } })(),
  discovery: {
    openapi: 'https://x402.ochinimus.app/openapi.json',
    well_known: 'https://x402.ochinimus.app/.well-known/x402',
    manifest: 'https://x402.ochinimus.app/.well-known/x402.json',
    llms_txt: 'https://x402.ochinimus.app/llms.txt',
    skill_md: 'https://x402.ochinimus.app/SKILL.md',
    icon: 'https://x402.ochinimus.app/icon.png',
    samples: 'https://x402.ochinimus.app/api/sample',
    forecast_record: 'https://x402.ochinimus.app/api/forecast-record',
  },
  links: {
    github: 'https://github.com/seekdaseek/agentfeed',
    elizaos_plugin: 'https://www.npmjs.com/package/@seekdaseek/plugin-agentfeed',
    smithery: 'https://smithery.ai/servers/ochinimus/agentfeed',
    dataset: 'https://ochinimuse.gumroad.com/l/liqdata',
    studio: 'https://ochinimus.app',
  },
  tools: Object.entries(PRICES).map(([route, p]) => ({
    name: p.tool, route: routeUrls.isTemplated(route) ? `GET ${routeUrls.template(route)}` : route, ...(routeUrls.isTemplated(route) ? { example_url: routeUrls.concrete(route) } : {}), price_usdc: p.usd, description: p.desc,
  })),
}));

// Glama connector ownership claim (checked automatically by glama.ai)
app.get('/.well-known/glama.json', (_req, res) => res.json({
  $schema: 'https://glama.ai/mcp/schemas/connector.json',
  maintainers: [{ email: 'ochinimus@gmail.com' }],
}));

// discovery manifest (x402 convention: /.well-known/x402.json). Each resource's accepts are the 402's own (lib/manifest.js,
// R10 F1): built by the payment layer from the same route config, so a rail in the 402 is in the manifest.
const manifestAccepts = require('./lib/manifest').makeManifestAccepts({ getLayer: () => paymentLayer });
app.get('/.well-known/x402.json', async (_req, res) => {
  let acc;
  try {
    acc = await manifestAccepts();
  } catch {
    return res.set('Retry-After', '30').status(503).json({ error: 'catalog not ready yet', retry_after: 30 });
  }
  res.json({
  x402Version: 2,
  service: 'agentfeed',
  description: `${require('./tools/scope').SCOPE} Pay per call in USDC via x402 on ${require('./lib/rails').httpRailNames()}.${require('./lib/rails').onRequestSentence() ? ` ${require('./lib/rails').onRequestSentence()}` : ''}${require('./lib/hf').hfSentence()} Every paid route also carries MPP tempo/charge challenges (Tempo mainnet, OUSD or USDC.e, pull mode) and /api/sol-price and /api/btc-price MPP solana/charge, on the same 402. No API key is needed to pay per call.${keySentence()} Copy payTo only from a fresh 402 response, never from transaction history.`,
  website: 'https://x402.ochinimus.app',
  // Derived from what is mounted, so the manifest cannot advertise a protocol
  // the service is not actually speaking.
  mpp: { active: mppOn, intent: 'solana/charge', routes: mppOn ? MPP_ROUTES : [], tempo: tempoInfo() },
  mcp: 'https://x402.ochinimus.app/mcp',
  resources: Object.entries(PRICES).map(([route, p]) => ({
    resource: routeUrls.concrete(route),
    ...(routeUrls.isTemplated(route) ? { resource_template: routeUrls.templateUrl(route), path_params_example: Object.fromEntries(routeUrls.params(route).map((q) => [q.name, q.example])) } : {}),
    method: 'GET',
    name: p.tool,
    description: p.desc,
    price_usd: p.usd,
    asset: 'USDC',
    accepts: acc.get(route) || [],
  })),
  });
});

// ---- what the 404 log showed clients asking for (lib/compat.js, R2)
// GET /mcp: no SSE stream here, so 405 per MCP Streamable HTTP. POST /mcp is mounted by initMcp.
app.get('/mcp', compat.mcpGet405);
// The CDP Bazaar discovery shape at the paths crawlers probe, from the payment layer itself.
{
  const concreteUrl = (pattern) => routeUrls.concrete(pattern);
  const handler = compat.makeDiscovery({ getLayer: () => paymentLayer, concreteUrl });
  for (const p of compat.DISCOVERY_PATHS) app.get(p, handler);
}
const agentCard = compat.makeAgentCard({
  PRICES, TAGS, routeUrls, TITLES: require('./tools/titles').TOOL_TITLES, questionFor: require('./tools/questions').questionFor,
  version: (() => { try { return require('./server.json').version; } catch { return '1.0.0'; } })(),
  ORIGIN: discovery.ORIGIN, railNames: () => require('./lib/rails').httpRailNames(), mpp: { get active() { return mppOn; }, get routes() { return mppOn ? MPP_ROUTES : []; } }, tempo: { get active() { return !!(tempo && tempo.isReady()); } },
});
app.get('/.well-known/agent-card.json', agentCard);
// R10 F8: the older A2A path crawlers still ask for (24 requests from 11 IPs since Oct 13): the same card.
app.get('/.well-known/agent.json', agentCard);
// R10 F8: robots.txt, sitemap.xml and the MCP server card (lib/compat.js), all built from what is mounted.
app.get('/robots.txt', compat.robotsTxt);
app.get('/sitemap.xml', compat.sitemapXml);
{
  const card = compat.makeMcpServerCard({ serverJson: (() => { try { return require('./server.json'); } catch { return null; } })(), protocolVersions: require('@modelcontextprotocol/sdk/types.js').SUPPORTED_PROTOCOL_VERSIONS });
  for (const p of compat.MCP_CARD_PATHS) app.get(p, card);
  app.get('/.well-known/ai-catalog.json', compat.makeAiCatalog({ ORIGIN: discovery.ORIGIN }));
}
app.get('/api/sharp-move', compat.makeSharpMoveGone({ PRICES, ORIGIN: discovery.ORIGIN }));
for (const p of compat.WITHDRAWN) app.all(p, compat.makeWithdrawn({ ORIGIN: discovery.ORIGIN }));
app.get('/pricing', compat.makePricing({ PRICES, FREE_TOOLS, routeUrls, ORIGIN: discovery.ORIGIN, railNames, mpp: { get active() { return mppOn; }, get routes() { return mppOn ? MPP_ROUTES : []; } }, tempo: { get active() { return !!(tempo && tempo.isReady()); } } }));
app.get('/terms', compat.termsHandler);

// ---- MCP rail (Session 3): same tools at POST /mcp for agents in Claude/Cursor/frameworks
const { initMcp } = require('./mcp');

(async () => {
  if (mppReady) {
    try {
      await mppReady;
    } catch (e) {
      // Same reasoning as the load guard above. The gate itself already falls
      // through on a rejected init (mpp/index.js: `catch { return next(); }`),
      // so the two gated routes keep answering the ordinary x402 challenge.
      console.error('[mpp] DISABLED: layer init failed:', e.message);
      console.error('[mpp] DISABLED: continuing with x402 only; the paid surface is unaffected.');
    }
  }
  if (paymentsOn) {
    try {
      await initMcp(app, keys);
    } catch (e) {
      console.error('FATAL: MCP rail init failed:', e.message);
      process.exit(1);
    }
  } else {
    console.log('[mcp] skipped (X402_MODE=off)');
  }
  app.listen(PORT, () => {
    console.log(`agentfeed up on :${PORT} (x402: ${x402Network})`);
    // R20: every Solana read of this process is counted per method and host and fails over (lib/solrpc.js); one `rpc_usage` line every 10 minutes
    require('./lib/solrpc').startUsageLog(Number(process.env.SOLRPC_USAGE_EVERY_MS) || undefined);
    // build the manifest's accepts (R10 F1) before the first crawler asks, once every facilitator has reported its /supported
    // (lib/manifest.js startupManifest: polls the resource server, never calls initialize() again, 60 s cap). Not reporting only
    // means the first discovery request builds it.
    require('./lib/manifest').startupManifest({ getLayer: () => paymentLayer, manifestAccepts }).catch((e) => console.log(`[manifest] startup build crashed: ${e.message}`));
    // the first signal-board call per process scans seven days of the liquidation tape (~1 s, once); do it now, not on a paid call
    setTimeout(() => { require('./tools/signals').getSignalBoard({ n: 1 }).then(() => console.log('[signals] baseline warm')).catch((e) => console.log(`[signals] baseline not warm yet: ${e.message}`)); }, 3000).unref();
  });
})();
