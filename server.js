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
app.disable('x-powered-by');
const PORT = process.env.PORT || 3006;

if (!process.env.HELIUS_API_KEY) {
  console.error('FATAL: HELIUS_API_KEY missing from .env');
  process.exit(1);
}

// ---- rate limit: 10 req/min per IP (wallet-based in Session 4)
const buckets = new Map();
const LIMIT = 10;
const WINDOW_MS = 60_000;
app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  req.callerIp = ip;
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.windowStart > WINDOW_MS) {
    b = { windowStart: now, count: 0 };
    buckets.set(ip, b);
  }
  b.count++;
  if (b.count > LIMIT) return res.status(429).json({ error: 'rate limit: 10 req/min' });
  next();
});
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now - b.windowStart > WINDOW_MS * 2) buckets.delete(ip);
}, 120_000).unref();

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
      logCall({ tool: name, status: 'error', latency_ms: Date.now() - t0, ip: req.callerIp });
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

const { getRecentLiquidations, getLiquidationStats } = require('./tools/liquidations');
app.get('/api/liquidations', tool('get_recent_liquidations', 0.003,
  (req) => getRecentLiquidations(req)));
app.get('/api/liquidation-stats', tool('get_liquidation_stats', 0.004,
  () => getLiquidationStats()));

// ---- free meta routes
app.get('/health', (_req, res) => res.json({ ok: true, service: 'agentfeed', x402: x402Network }));

app.get('/', (_req, res) => res.json({
  service: 'agentfeed',
  description: 'Market + Solana on-chain data for AI agents, paid per-call in USDC via x402.',
  x402: { active: paymentsOn, network: x402Network },
  tools: Object.entries(PRICES).map(([route, p]) => ({
    name: p.tool, route, price_usdc: p.usd, description: p.desc,
  })),
}));

// discovery manifest (x402 convention: /.well-known/x402.json)
app.get('/.well-known/x402.json', (_req, res) => res.json({
  x402Version: 2,
  service: 'agentfeed',
  description: 'Crypto market, liquidations, and Solana on-chain data for AI agents. Pay per call in USDC on Solana via x402. No API keys.',
  website: 'https://x402.ochinimus.app',
  mcp: 'https://x402.ochinimus.app/mcp',
  network: x402Network === 'mainnet' ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' : 'solana:devnet',
  payTo: process.env.PAY_TO,
  resources: Object.entries(PRICES).map(([route, p]) => ({
    resource: 'https://x402.ochinimus.app' + route.replace('GET ', ''),
    method: 'GET',
    name: p.tool,
    description: p.desc,
    price_usd: p.usd,
    asset: 'USDC',
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
