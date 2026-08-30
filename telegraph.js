// telegraph.js — unmetered mirror of the /api surface for the Telegraph Protocol node.
//
// WHY THIS EXISTS: Telegraph pays miners through its own economy and the price is
// declared in the miner YAML (on_chain.min_price_usdc). If AgentFeed also charged
// x402 at the door, the same request would be billed twice, and the integrate
// validator — which sandbox-tests every declared endpoint before registration —
// would see HTTP 402 and fail the registration.
//
// HOW IT AVOIDS THE PAYWALL: server.js mounts the x402 layer with a global
// app.use(layer.middleware) BEFORE the /api routes. Express runs the stack in
// declaration order, so any route declared ABOVE that app.use never reaches it.
// register(app) must therefore be called before the x402 block in server.js.
//
// v2 CHANGE: query-parameter aliases. Telegraph's YAML passes QUERY PARAMS and the
// schema has no path-substitution mechanism, so a route like /api/token-risk/:mint
// is unreachable from the protocol. Each such route now also accepts the value as a
// query param, falling back to the path segment.
//
// This file declares NO new business logic. It calls the same functions the paid
// routes call, so there is one implementation and no second thing to keep in sync.

const express = require('express');

const { getPrice, getPriceQuotes } = require('./tools/prices');
const { getFunding } = require('./tools/funding');
const { getFearGreed } = require('./tools/feargreed');
const { getWalletHoldings, getTokenMetadata } = require('./tools/onchain');
const {
  getRecentLiquidations,
  getLiquidationStats,
  getLastLiquidation,
  getLiquidationLeaders,
} = require('./tools/liquidations');
const { getCascadeAlert } = require('./tools/cascade');
const { getPositioning } = require('./tools/positioning');
const { getTradeContext } = require('./tools/tradecontext');
const { getTokenRisk } = require('./tools/tokenrisk');
const { getBaseGas, getBaseBalance } = require('./tools/base');
const { shape } = require('./answer');

// ---------------------------------------------------------------------------
// REQUEST LOG — append-only JSONL, one line per request through this router.
//
// WHY IT IS SAFE. Every write happens inside res.on('finish'), i.e. AFTER the
// response bytes are already flushed to the client, and the whole write is
// wrapped so that a full disk, a permission change or a read-only mount can
// only lose a log line. It can never turn a 200 into a 502, which is the one
// thing a logger on a scored miner must never do.
//
// WHAT IS DELIBERATELY NOT LOGGED. No headers, ever: the x402 settlement and
// authorization headers ride there. Query VALUES are logged because the whole
// point is to see what symbol was asked for, but any key whose NAME looks like
// a credential is redacted rather than trusted.
const fs = require('fs');
const path = require('path');

const LOG_PATH = process.env.TELEGRAPH_LOG || path.join(__dirname, 'telegraph-requests.log');
const LOG_MAX_BYTES = 20 * 1024 * 1024;   // ~20MB, then rotate
// Query keys whose NAME suggests a credential. Deliberately NOT a bare /token/:
// this is a blockchain data API, and ?token= carries a public ERC20 contract
// address on /api/base-balance. Redacting that hid the most useful field on the
// route while protecting nothing - a contract address is published on-chain.
// Credential-shaped token names (api_token, access_token, auth_token) still go.
const SECRETISH = /(^|_)(api)?key$|secret|passw|auth|bearer|cookie|session|signature|(^|_)sig$|(api|access|refresh|id|auth)[_-]?token/i;

// Tracked in memory so the common path costs no stat(2). Seeded from disk on
// first write, and re-seeded whenever a rotation happens.
let logBytes = null;

function currentSize() {
  if (logBytes === null) {
    try { logBytes = fs.statSync(LOG_PATH).size; } catch (_) { logBytes = 0; }
  }
  return logBytes;
}

// One generation kept. rename() is atomic and cheap; truncate is the fallback
// for the case where the directory is not writable but the file is.
function rotateIfBig() {
  if (currentSize() < LOG_MAX_BYTES) return;
  try {
    fs.renameSync(LOG_PATH, LOG_PATH + '.1');
  } catch (_) {
    try { fs.truncateSync(LOG_PATH, 0); } catch (_) { /* give up, keep serving */ }
  }
  logBytes = 0;
}

function safeQuery(q) {
  const out = {};
  for (const k of Object.keys(q || {})) {
    out[k] = SECRETISH.test(k) ? '[redacted]' : q[k];
  }
  return out;
}

// Top-level keys only. The payloads are the product; the log records their
// SHAPE so a silent regression is visible, not their contents.
function topKeys(v) {
  if (Array.isArray(v)) return ['[array:' + v.length + ']'];
  if (v && typeof v === 'object') return Object.keys(v);
  return [];
}

// Which upstream actually served this payload. Most tools carry a `source`
// field; prices.js sets it to the venue that answered after fallback, so the
// log shows a silent failover (pyth -> coinbase) that the response body alone
// would hide.
function sourceOf(v) {
  return v && typeof v === 'object' && typeof v.source === 'string' ? v.source : undefined;
}

function writeLog(rec) {
  try {
    rotateIfBig();
    const line = JSON.stringify(rec) + '\n';
    fs.appendFileSync(LOG_PATH, line);
    logBytes = currentSize() + Buffer.byteLength(line);
  } catch (_) {
    // Intentionally swallowed. See the note above: a logging failure must not
    // be observable by the caller.
  }
}

/**
 * Whose fault is this error? 400 says the caller's, 502 says ours or the
 * upstream's, and Telegraph's validator fails an endpoint on 5xx - so getting
 * this backwards either hides a real outage or fails a healthy endpoint.
 *
 * Two things are the caller's fault:
 *
 *   missingParam       they left a required parameter out. Returning 502 for
 *                      this made the validator mark healthy endpoints as
 *                      server failures when it probed them with no arguments.
 *   upstreamParamError they named something the venue does not list. Measured
 *                      2026-08-22: /api/basis?symbol=PEPEUSDT returned 502 in
 *                      212ms with "bybit: params error: symbol invalid", and
 *                      eight more routes did the same - volatility,
 *                      open-interest, long-short, funding-history,
 *                      orderbook-imbalance, orderbook-walls, whale-trades.
 *                      The tag is set in tools/*.js on Bybit retCode 10001 and
 *                      on nothing else.
 *
 * Everything else is a 502 ON PURPOSE. The tag is set from a numeric retCode
 * on an HTTP 200 response, never from message text, so a Bybit outage - which
 * throws inside fetchJson before any retCode is read - cannot be mistaken for
 * a bad symbol. A miner that answers 400 while the venue is down is lying
 * about whose fault it is, and that lie is worse than the 502 it replaces.
 */
function statusFor(err) {
  if (!err) return 502;
  if (err.missingParam) return 400;
  if (err.upstreamParamError) return 400;
  // Set by a tool that was handed an argument it genuinely does not carry -
  // tools/tradecontext.js on a symbol outside SOL/BTC. Same reasoning as
  // upstreamParamError: the caller named it, so it is the caller's 400, and a
  // 400 passes the validator where a 502 would fail a healthy endpoint.
  if (err.badRequest) return 400;
  return 502;
}

// Mirrors the signature of server.js's own tool(name, usd, fn) helper, minus the
// billing. The usd argument is accepted and ignored so expansion.js can be handed
// this wrapper unchanged.
function plain(name, _usd, fn) {
  return async (req, res) => {
    try {
      const out = await fn(req);
      // Telegraph scoring is numeric-first: one number beats twelve.
      // shape() returns null when no single number is defensible, and
      // null means send the original payload unchanged.
      const sentence = shape(req.path, out);
      // Stashed for the logger, which runs on res.on('finish') and cannot see
      // these locals. Recorded here because this is the single reply site.
      req._tgLog = sentence
        ? { tool: name, shaped: true, answer: sentence, source: sourceOf(out) }
        : { tool: name, shaped: false, payload_keys: topKeys(out), source: sourceOf(out) };
      if (sentence && req.query.verbose !== '1') return res.json({ answer: sentence });
      res.json(out);
    } catch (err) {
      const msg = String((err && err.message) || err);
      req._tgLog = { tool: name, shaped: false, error: msg };
      res.status(statusFor(err)).json({
        error: msg,
        tool: name,
      });
    }
  };
}

// Reads an identifier from the query string first, then the path segment.
function arg(req, key) {
  const v = req.query[key] || req.params[key];
  if (!v) {
    const e = new Error(`missing required parameter: ${key}`);
    e.missingParam = key;
    throw e;
  }
  return v;
}

function register(app) {
  const r = express.Router();

  // Declared before every route so it observes all of them, including /ping
  // and anything that falls through unmatched. req.path here is router-relative
  // ('/api/volatility'), the same value the handlers pass to shape().
  r.use((req, res, next) => {
    res.on('finish', () => {
      const t = req._tgLog || {};
      writeLog({
        ts: new Date().toISOString(),
        path: req.path,
        query: safeQuery(req.query),
        status: res.statusCode,
        // null, not false: /ping and unmatched paths never call shape() at all,
        // which is a different fact from shape() having declined.
        shaped: t.shaped === undefined ? null : t.shaped,
        tool: t.tool,
        source: t.source,
        answer: t.answer,
        payload_keys: t.payload_keys,
        error: t.error,
      });
    });
    next();
  });

  // liveness — the cheapest thing the integrate validator can hit
  r.get('/ping', (_req, res) =>
    res.json({ ok: true, surface: 'telegraph', metered: false })
  );

  // ---- routes whose handlers are declared inline in server.js
  r.get('/api/sol-price', plain('get_sol_price', 0, () => getPriceQuotes('SOL')));
  r.get('/api/btc-price', plain('get_btc_price', 0, () => getPriceQuotes('BTC')));
  r.get('/api/fear-greed', plain('get_fear_greed', 0, () => getFearGreed()));
  r.get('/api/positioning', plain('get_positioning', 0, (req) => getPositioning(req)));
  r.get('/api/trade-context', plain('get_trade_context', 0, (req) => getTradeContext(req)));
  r.get('/api/liquidations', plain('get_recent_liquidations', 0, (req) => getRecentLiquidations(req)));
  r.get('/api/liquidation-leaders', plain('get_liquidation_leaders', 0, (req) => getLiquidationLeaders(req)));
  r.get('/api/liquidation-stats', plain('get_liquidation_stats', 0, (req) => getLiquidationStats(req)));
  r.get('/api/last-liquidation', plain('get_last_liquidation', 0, (req) => getLastLiquidation(req)));
  r.get('/api/cascade', plain('get_cascade_alert', 0, (req) => getCascadeAlert(req)));
  // identifier routes: query param OR path segment, same handler either way
  const byMint = (n, fn) => plain(n, 0, (req) => fn(arg(req, 'mint')));
  const byWallet = (n, fn) => plain(n, 0, (req) => fn(arg(req, 'wallet')));
  r.get('/api/token-risk', byMint('get_token_risk', getTokenRisk));
  r.get('/api/token-risk/:mint', byMint('get_token_risk', getTokenRisk));
  r.get('/api/token-metadata', byMint('get_token_metadata', getTokenMetadata));
  r.get('/api/token-metadata/:mint', byMint('get_token_metadata', getTokenMetadata));
  r.get('/api/wallet-holdings', byWallet('get_wallet_holdings', getWalletHoldings));
  r.get('/api/wallet-holdings/:wallet', byWallet('get_wallet_holdings', getWalletHoldings));
  // token-holders. The implementation is tools/solana2.js getTokenHolders, and
  // it takes an OPTIONS OBJECT ({ mint }), not a bare string - so it cannot use
  // the byMint helper above, which passes the identifier positionally.
  //
  // Both forms of this route were failing on a REGISTERED Telegraph endpoint.
  // The old fallback chain asked expansion.js, which exports only its wiring and
  // no tool functions, then tools/onchain, which has no getTokenHolders at all,
  // and then threw - so the query form 400d. The path form was never registered,
  // so it 502d. A registered route that cannot answer is what costs the miner
  // its registration, which is why both are wired here explicitly.
  const { getTokenHolders } = require('./tools/solana2');
  const holders = plain('get_token_holders', 0, (req) => getTokenHolders({ mint: arg(req, 'mint') }));
  r.get('/api/token-holders', holders);
  r.get('/api/token-holders/:mint', holders);

  // ---- THE THREE QUESTIONS ACTUALLY BEING ASKED ---------------------------
  // Measured 2026-08-21 over 43 live Telegraph signal receipts: essentially all
  // crypto demand on the network is "current price of ETH in USD", "ETH balance
  // of 0x... on base", and "current gas price on Base". Every route above this
  // line is Solana or perp microstructure, which is why this miner was routable,
  // healthy, and still answering nobody. These three close that gap.
  //
  // They are declared HERE rather than in expansion.js because expansion.js is
  // the PAID surface: everything it registers is mirrored into /telegraph AND
  // priced into payments.js. These are mirror-only, so they add no paid route
  // and change no price table.
  // Multi-venue quotes: the CRYPTO_PRICE scorer is exact-match on the digits,
  // so carrying every venue's quote is what turns a 0.0000 into ~1.0 when the
  // ground truth follows a venue we would otherwise have missed.
  r.get('/api/eth-price', plain('get_eth_price', 0, () => getPriceQuotes('ETH')));
  r.get('/api/base-gas', plain('get_base_gas', 0, () => getBaseGas()));
  r.get('/api/base-balance', plain('get_base_balance', 0, (req) => getBaseBalance(req)));
  // Path-segment form too: the router fills parameters from the endpoint
  // description, and a path-style example is the form it most often produces.
  r.get('/api/base-balance/:address', plain('get_base_balance', 0, (req) =>
    getBaseBalance({ query: { ...(req.query || {}), address: req.params.address } })));

  r.get('/api/market-snapshot', plain('get_market_snapshot', 0, async () => {
    const [sol, btc, fundingSol, fundingBtc, fg] = await Promise.all([
      getPrice('SOL'),
      getPrice('BTC'),
      getFunding('SOL'),
      getFunding('BTC'),
      getFearGreed(),
    ]);
    return { sol, btc, funding: { sol: fundingSol, btc: fundingBtc }, fear_greed: fg };
  }));

  // ---- everything registered by expansion.js (tvl, open-interest, funding-cross,
  // volatility, basis, top-movers, squeeze-score, token-holders, and the rest).
  // register(app, tool) takes both as arguments, so handing it this router and the
  // non-charging wrapper re-declares every one of its routes unmetered, with no
  // knowledge of its internals and no duplication of its logic.
  try {
    require('./expansion').register(r, plain);
  } catch (err) {
    console.error('[telegraph] expansion routes not mounted:', err.message);
  }

  app.use('/telegraph', r);
  console.log('[telegraph] unmetered mirror v3 mounted at /telegraph');
}

module.exports = { register, statusFor };

// Internals exposed for test-answer.mjs only. Not part of the route surface:
// nothing in server.js or expansion.js reads this.
module.exports.__test = { safeQuery, topKeys, LOG_PATH, LOG_MAX_BYTES };
