// agentfeed server.js — Session 2: x402 PAYMENTS ACTIVE on all /api routes.
// /health and / stay free. X402_MODE=off in .env reverts to free mode.
require('dotenv').config();
const express = require('express');
const { logCall } = require('./db');
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

// ---- x402 payment layer (mounted BEFORE the /api routes)
const paymentsOn = (process.env.X402_MODE || 'on').toLowerCase() !== 'off';
let x402Network = 'off';
if (paymentsOn) {
  const layer = buildPaymentLayer();
  x402Network = layer.network;
  app.use(layer.middleware);
}

// ---- route wrapper: timing + audit (captures payer + tx sig from settlement header)
function tool(name, priceUsd, handler) {
  return async (req, res) => {
    const t0 = Date.now();
    res.on('finish', () => {
      if (res.statusCode !== 200) return; // 402s/errors logged elsewhere or not billed
      const s = paymentsOn ? decodeSettlement(res) : null;
      logCall({
        tool: name,
        status: s ? 'paid' : 'free',
        payer_wallet: s?.payer || null,
        tx_sig: s?.transaction || null,
        amount_usdc: s ? priceUsd : null,
        latency_ms: Date.now() - t0,
        ip: req.callerIp,
      });
    });
    try {
      const data = await handler(req);
      res.json({ tool: name, data, paid: paymentsOn });
    } catch (e) {
      // e.kind === 'bad_request' is set at the throw site by the tools' own
      // input validation (missing/malformed caller parameter, thrown before any
      // upstream call); an unmarked throw is a genuine service failure. Never
      // classify by matching message text. /opt/afwatch/afwatch.js and the
      // solwatch MCP x402_revenue tool both read this table, so the
      // error/bad_request split changes what they report — by design.
      logCall({
        tool: name,
        status: e.kind === 'bad_request' ? 'bad_request' : 'error',
        latency_ms: Date.now() - t0,
        ip: req.callerIp,
        error_msg: e.message,
        req_path: req.path,
        user_agent: req.headers['user-agent'],
        method: req.method,
      });
      res.status(400).json({ tool: name, error: e.message });
    }
  };
}

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
// full universe (~600 perps). same detector, scope forced to 'all'.
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
    return res.type('html').send(renderLanding(PRICES, x402Network));
  }
  next();
});

app.get('/', (_req, res) => res.json({
  service: 'agentfeed',
  description: 'Live crypto market data for AI agents - liquidations, positioning, funding, prices, token risk. Paid per-call in USDC via x402 on Solana or Base. No API keys.',
  x402: { active: paymentsOn, network: x402Network, chains: ['solana:mainnet', 'eip155:8453'] },
  free_tools: ['get_fear_greed', 'pricing'],
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
  description: 'Crypto market, liquidations, and Solana on-chain data for AI agents. Pay per call in USDC via x402 on Solana or Base. No API keys.',
  website: 'https://x402.ochinimus.app',
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
