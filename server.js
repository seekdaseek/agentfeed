// agentfeed server.js — Session 2: x402 PAYMENTS ACTIVE on all /api routes.
// /health and / stay free. X402_MODE=off in .env reverts to free mode.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { db, logCall } = require('./db');
const { buildPaymentLayer, decodeSettlement, PRICES } = require('./payments');
const { getPrice } = require('./tools/prices');
const { getFunding } = require('./tools/funding');
const { getFearGreed } = require('./tools/feargreed');
const { getWalletHoldings, getTokenMetadata } = require('./tools/onchain');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
const PORT = process.env.PORT || 3006;

if (!process.env.HELIUS_API_KEY) {
  console.error('FATAL: HELIUS_API_KEY missing from .env');
  process.exit(1);
}

// ---- rate limit: fixed window, keyed on the Cloudflare-observed client
//
// NOT per-IP, despite what this comment used to say. The key below is the
// LEFTMOST element of X-Forwarded-For, which is whatever the caller sent:
// Cloudflare appends the observed client address rather than replacing the
// header, so the leftmost value is attacker-controlled. Measured: rotating
// that header returns 200 for every request at any limit, while a fixed value
// throttles normally. A caller who rotates it is unthrottled today, and that
// is true at 60 as it is at 240 -- this raise does not widen that hole, and
// does not close it either. Fixing the key needs to know which of
// CF-Connecting-IP / X-Forwarded-For / X-Real-IP actually survives the
// cloudflared tunnel; guessing risks collapsing every caller into one bucket
// and throttling the world together. That measurement ships first, then the
// fix, as a separate deploy.
//
// Why 240: one `pay catalog check` probe is 45 requests (45 routes in the
// manifest), and pay-skills CI probes on PR and again on merge. Two probes in
// one minute exceeded 60, and the second came back 429 -- which their prober
// classifies as `not_paywalled`, so the endpoint reads as broken rather than
// busy.
//
// The /telegraph mirror was removed on 2026-09-19, so there is no longer a
// second, unmetered surface to meter separately: one limit, one bucket per
// caller. telegraph.js stays on disk; only its mount is gone.
const buckets = new Map();
const LIMIT = 240;
const WINDOW_MS = 60_000;
app.use((req, res, next) => {
  // Key on CF-Connecting-IP. Cloudflare sets it from the connection it
  // terminated, a caller cannot forge it through the edge, and it is the only
  // address header that survives the tunnel -- measured on this box:
  //
  //   cf-connecting-ip : present
  //   x-forwarded-for  : present, but APPENDED to whatever the caller sent, so
  //                      its leftmost element is attacker-controlled
  //   x-real-ip        : absent
  //
  // Fallback is the raw socket peer, NOT req.ip: `trust proxy` makes req.ip
  // derive from X-Forwarded-For, so req.ip is spoofable by exactly the header
  // this stops trusting. Measured -- with a req.ip fallback, rotating
  // X-Forwarded-For still won a fresh bucket every request.
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || req.ip;
  // Assigned before any early return: the HEAD guard and every logCall read
  // req.callerIp, including on the throttled path.
  req.callerIp = ip;
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.windowStart > WINDOW_MS) {
    b = { windowStart: now, count: 0, throttleLogged: false };
    buckets.set(ip, b);
  }
  b.count++;
  if (b.count > LIMIT) {
    // Tell a well-behaved caller when to come back. Without this a prober has
    // nothing to back off on and reads the 429 as a verdict about the endpoint
    // rather than about its own pace.
    const retryAfter = Math.max(1, Math.ceil((b.windowStart + WINDOW_MS - now) / 1000));
    res.set('Retry-After', String(retryAfter));
    // Throttling was invisible: the 429 returned before anything reached the
    // database, so there was no record of how often callers get refused. Log
    // ONCE per key per window -- a flood must not become a write storm. Same
    // shape as the head_probe entry below, and it reuses the existing
    // `bad_request` status rather than inventing a value this table's readers
    // (afwatch, the solwatch MCP x402_revenue tool) do not know.
    if (!b.throttleLogged) {
      b.throttleLogged = true;
      logCall({
        tool: 'rate_limited', status: 'bad_request', ip,
        error_msg: `rate limit: ${LIMIT} req/min exceeded (retry after ${retryAfter}s)`,
        req_path: req.path, user_agent: req.headers['user-agent'], method: req.method,
      });
    }
    return res.status(429).json({ error: `rate limit: ${LIMIT} req/min`, retry_after: retryAfter });
  }
  next();
});

setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now - b.windowStart > WINDOW_MS * 2) buckets.delete(ip);
}, 120_000).unref();

// ---- HEAD guard (must sit BEFORE the x402 layer)
// @x402 route matching is verb-exact: a pattern 'GET /api/x' never matches a
// HEAD request, while app.get() answers HEAD as well as GET — so a HEAD reached
// every paid handler unmetered (856 crawler probes since 2026-07-21, all one
// GCP IP). Still verb-exact in @x402/core 2.21.0 (checked 2026-09-15), so a
// dependency bump alone would not close it. Protocol-correct alternative for
// later: answer HEAD with the 402 challenge — x402 v2 carries it entirely in
// the PAYMENT-REQUIRED response header, so a bodiless response can still quote.
// 405 is the safe move today. Matches /api/* only: /health, / and /.well-known
// are untouched.
app.use((req, res, next) => {
  if (req.method !== 'HEAD' || !req.path.startsWith('/api/')) return next();
  logCall({
    tool: 'head_probe', status: 'bad_request', ip: req.callerIp,
    error_msg: 'HEAD rejected: paid surface is GET-only',
    req_path: req.path, user_agent: req.headers['user-agent'], method: req.method,
  });
  res.set('Allow', 'GET');
  res.status(405).end();
});

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
  const hit = QUERY_ALIASABLE.find((r) => req.path === r.base);
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
const MPP_ROUTES = ['GET /api/sol-price', 'GET /api/btc-price'];
let mppReady = null;
if (mppOn) {
  mppReady = mpp.init({ db, prices: PRICES, routes: MPP_ROUTES });
  app.get('/api/sol-price', mpp.gate('GET /api/sol-price'));
  app.get('/api/btc-price', mpp.gate('GET /api/btc-price'));
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
const { TAGS, BAZAAR_META } = require('./payments');

let _docs = null;
function docs() {
  if (_docs) return _docs;
  const ctx = {
    PRICES,
    TAGS,
    META: BAZAAR_META,
    FREE_TOOLS,
    mpp: { active: mppOn, routes: mppOn ? MPP_ROUTES : [] },
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
  routes: [...new Set([...sampleIndex.values()].map((v) => v.path))].sort(),
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
    route: hit.path,
    tool: m.tool,
    price_usd: m.price_usd,
    paid_url: 'https://x402.ochinimus.app' + hit.path,
    how_to_pay: 'GET the paid_url; the 402 carries the challenge in the PAYMENT-REQUIRED response header (x402 v2).',
    input_example: m.input || {},
    ...(m.pathParams ? { path_params_example: m.pathParams } : {}),
    input_schema: m.inputSchema || { properties: {} },
    sample_response: m.output ? m.output.example : null,
    captured: 'a real response from this service, trimmed; field names and types are exactly what the paid route returns',
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

app.get('/openapi.json', (_req, res) => res.json(docs().openapi));
app.get('/.well-known/x402', (_req, res) => res.json(docs().wellKnown));
app.get('/llms.txt', (_req, res) => res.type('text/plain; charset=utf-8').send(docs().llms));
app.get('/SKILL.md', (_req, res) => res.type('text/markdown; charset=utf-8').send(docs().skill));

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
const paymentsOn = (process.env.X402_MODE || 'on').toLowerCase() !== 'off';
let x402Network = 'off';
if (paymentsOn) {
  const layer = buildPaymentLayer();
  x402Network = layer.network;
  app.use(mppOn ? mpp.wrapX402(layer.middleware) : layer.middleware);
}

// ---- route wrapper: timing + audit, and the paid flag.
// Lives in lib/tool.js so it can be unit-tested without booting this file.
const { makeTool } = require('./lib/tool');
const { tool } = makeTool({ paymentsOn, PRICES, decodeSettlement, logCall });

// ---- routes (patterns must match PRICES keys in payments.js exactly)
app.get('/api/sol-price', tool('get_sol_price', 0.001, () => getPrice('SOL')));
app.get('/api/btc-price', tool('get_btc_price', 0.001, () => getPrice('BTC')));

app.get('/api/funding-rate', tool('get_funding_rate', 0.002, async () => ({
  sol: await getFunding('SOL'),
  btc: await getFunding('BTC'),
})));

app.get('/api/fear-greed', tool('get_fear_greed', 0.001, () => getFearGreed()));

app.get('/api/market-snapshot', tool('get_market_snapshot', 0.003, async () => {
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
app.get('/api/liquidations', tool('get_recent_liquidations', 0.003,
  (req) => getRecentLiquidations(req)));
app.get('/api/liquidation-leaders', tool('get_liquidation_leaders', 0.02,
  (req) => getLiquidationLeaders(req)));
app.get('/api/liquidation-stats', tool('get_liquidation_stats', 0.004,
  () => getLiquidationStats()));
app.get('/api/last-liquidation', tool('get_last_liquidation', 0,
  () => getLastLiquidation()));

// overhang method disclosure. FREE, and deliberately absent from PRICES in payments.js
// so the x402 middleware never sees a $0 route (same treatment as /api/last-liquidation).
const { getExitMethod } = require('./tools/overhang');
app.get('/api/exit-method', tool('get_exit_method', 0,
  () => getExitMethod()));

const { getCascadeAlert } = require('./tools/cascade');
app.get('/api/cascade', tool('get_cascade_alert', 0.01,
  (req) => getCascadeAlert(req)));
// full universe (every perp in the tape). same detector, scope forced to 'all'.
app.get('/api/cascade-scan', tool('get_cascade_scan', 0.05,
  (req) => getCascadeAlert({ query: { ...(req.query || {}), scope: 'all' } })));


const { getPositioning } = require('./tools/positioning');
app.get('/api/positioning', tool('get_positioning', 0.004,
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

app.get('/', (_req, res) => res.json({
  service: 'agentfeed',
  description: 'Live crypto market data for AI agents - liquidations, positioning, funding, prices, token risk. Paid per-call in USDC via x402 on Solana or Base; /api/sol-price and /api/btc-price also carry an MPP solana/charge challenge on the same 402. No API keys.',
  x402: { active: paymentsOn, network: x402Network, chains: ['solana:mainnet', 'eip155:8453'] },
  // DERIVED, not restated: whatever is actually mounted is what is advertised.
  mpp: { active: mppOn, intent: 'solana/charge', routes: mppOn ? MPP_ROUTES : [] },
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
    smithery: 'https://smithery.ai/server/ochinimus/agentfeed',
    dataset: 'https://ochinimuse.gumroad.com/l/liqdata',
    studio: 'https://ochinimus.app',
  },
  tools: Object.entries(PRICES).map(([route, p]) => ({
    name: p.tool, route, price_usdc: p.usd, description: p.desc,
  })),
}));

// Glama connector ownership claim (checked automatically by glama.ai)
app.get('/.well-known/glama.json', (_req, res) => res.json({
  $schema: 'https://glama.ai/mcp/schemas/connector.json',
  maintainers: [{ email: 'ochinimus@gmail.com' }],
}));

// discovery manifest (x402 convention: /.well-known/x402.json)
app.get('/.well-known/x402.json', (_req, res) => res.json({
  x402Version: 2,
  service: 'agentfeed',
  description: 'Crypto market, liquidations, and Solana on-chain data for AI agents. Pay per call in USDC via x402 on Solana or Base. /api/sol-price and /api/btc-price also carry an MPP solana/charge challenge on the same 402. No API keys.',
  website: 'https://x402.ochinimus.app',
  // Derived from what is mounted, so the manifest cannot advertise a protocol
  // the service is not actually speaking.
  mpp: { active: mppOn, intent: 'solana/charge', routes: mppOn ? MPP_ROUTES : [] },
  mcp: 'https://x402.ochinimus.app/mcp',
  resources: Object.entries(PRICES).map(([route, p]) => ({
    resource: 'https://x402.ochinimus.app' + route.replace('GET ', ''),
    method: 'GET',
    name: p.tool,
    description: p.desc,
    price_usd: p.usd,
    asset: 'USDC',
    accepts: [
      { scheme: 'exact', network: x402Network === 'mainnet' ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' : 'solana:devnet', payTo: process.env.PAY_TO, asset: 'USDC', price_usd: p.usd },
      ...(process.env.PAY_TO_EVM ? [{ scheme: 'exact', network: 'eip155:8453', payTo: process.env.PAY_TO_EVM, asset: 'USDC', price_usd: p.usd }] : []),
    ],
  })),
}));

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
      await initMcp(app);
    } catch (e) {
      console.error('FATAL: MCP rail init failed:', e.message);
      process.exit(1);
    }
  } else {
    console.log('[mcp] skipped (X402_MODE=off)');
  }
  app.listen(PORT, () => console.log(`agentfeed up on :${PORT} (x402: ${x402Network})`));
})();
