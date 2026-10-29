// lib/keys.js — prepaid API keys (R9 K1, K2): bought with one x402 payment, spent per call at the high-frequency price.
//
// WHY. Bots that can set a header but cannot pay x402 (NOFX External Data Sources, Freqtrade, n8n, plain scripts, a
// gateway such as claw402 that lists `upstream_type: api_key` providers) could not use AgentFeed. A key is a balance
// bought once, on any exact rail, and drawn down per call at hfUsd(route price): half the list price, minimum $0.0005.
//
// THE KEY. `afk_` + base58 of 32 random bytes. Only sha256(key) is stored (api_keys.key_hash); the key itself is in
// exactly one place, the body of the purchase response, and never in a calls row, a log line or an error message.
// The header is deleted from the request as soon as it is read, so no later middleware can log it either.
// A buyer may instead generate the key locally and buy with `key_hash` = sha256 hex of it: the server registers the
// hash and never sees the key before its first use, and a connection that drops after settlement loses nothing.
//
// PURCHASE ORDERING, measured against @x402/express 2.28 (dist/cjs/index.js, payment-verified branch), lib/x402v1.js
// hold() and mpp/tempo.js hold(): all three BUFFER the handler's response, settle only when it is < 400, and release
// the body only after settlement succeeded. A failed settlement discards the body (the buyer never sees the key); a
// handler >= 400 cancels the settlement (the buyer is never charged). So:
//   - the handler inserts the row as 'pending' and returns the key (buffered, not yet sent);
//   - the row turns 'active' at the moment the settlement is PRESENT: a PAYMENT-RESPONSE header with success:true
//     being set on this response (x402 v2 and v1), or req.mppSettlement being assigned (MPP tempo). Hooked at the
//     source rather than on 'finish', so a client that disconnects while settlement runs still gets its credit;
//   - on 'finish' a row that never saw its settlement is deleted at once (settlement failed or the handler failed);
//     a pending row older than 10 minutes is deleted by the sweep (a connection that closed mid-settlement).
// A top-up changes nothing until its settlement is present, then adds its credit in one UPDATE.
//
// THE BOT PASS (15 Oct 2026, task #90). A second kind of key, bought on /api/keys/buy-pass for a flat price: valid for a number of days
// from the moment its settlement is present, good only on the routes named in `allow` (today /api/liq-feed and the MCP tool of the same
// name), and not drawn down per call. The sale is the revenue (sold_micro; one 'paid' row of the purchase tool, like a pack); its calls
// are 'key' rows of amount 0, consumption of a payment already counted. Every other rule of a key still holds: header only, hash only,
// the per-key rate limit, a 4xx or 503 is never counted, revocation. A pass cannot be topped up; an expired or revoked pass is refused
// and is never billed anywhere else.
//
// CHARGING A CALL (makeCharge). Atomic reserve before the handler:
//   UPDATE api_keys SET balance_micro = balance_micro - ? WHERE key_hash = ? AND status = 'active' AND balance_micro >= ?
// no row changed = 402 JSON. On 'finish': status >= 400 refunds the reserve (a 400, 404 or 503 is never billed, the
// same rule as x402); < 400 counts the call and writes one calls row, status 'key'. A response that never finished
// (the caller hung up) is refunded. Revenue is unchanged: settled payments, status 'paid', which includes the key
// purchases themselves; a 'key' row is consumption of credit already counted.
'use strict';
const { canonPath, pricedMatcher } = require('./canon-path');
const crypto = require('crypto');

const PREFIX = 'afk_';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const KEY_RE = /^afk_[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const PREFIX_RE = /^[1-9A-HJ-NP-Za-km-z]{8}$/;
const PENDING_TTL_MS = 10 * 60_000;
const DEFAULT_RATE = 120;
const BUY_PATH = '/api/keys/buy-5';
const TOPUP_PATH = '/api/keys/topup-5';
// the six purchase routes (expansion.js builds its EXP entries from these): pack -> USD credit
const PACKS = { trial: 0.25, 1: 1, 5: 5, 20: 20 };
const TOPUPS = { 5: 5, 20: 20 };
// the bot pass: flat price in USD, days of validity from settlement, the routes it is good on
const PASS = { id: 'pass', usd: 25, days: 30, allow: ['/api/liq-feed'], label: 'bot pass', path: '/api/keys/buy-pass', tool: 'buy_key_pass' };
const PASS_PATH = PASS.path;
// R15 (19 Oct 2026): the day pass, the same mechanism at $1.00 for 24 hours on two routes. $1.00 is the most a stock @x402/fetch 2.28 client
// pays with its default spend cap (it refuses 1,000,001 atomic units and accepts 1,000,000, measured), so it is the pass that default
// clients can buy; the $25 bot pass and the $5 and $20 packs need the cap raised.
// R15c: `pace` is the least time between two calls of a route with ONE key: /api/liquidations answers one call every 10 s (6 a minute) to a
// day-pass key, the cadence of /api/liq-feed. The route caps at 100 rows with no paging, so a poller loses nothing at that pace, and a $1 pass
// cannot mirror the live tape at the 120 requests a minute a key is otherwise allowed. Only a pass key is paced: x402 callers and prepaid packs are not.
const DAY_PASS = { id: 'day', usd: 1, days: 1, allow: ['/api/liq-feed', '/api/liquidations'], pace: { '/api/liquidations': 10_000 }, label: 'day pass', path: '/api/keys/buy-day-pass', tool: 'buy_key_day_pass' };
const DAY_PASS_PATH = DAY_PASS.path;
// pensio (30 Oct 2026): the BRIEF passes, the same mechanism for the composed briefs (tools/briefs). PROPOSED terms live in tools/briefs/config.js (the price
// is the owner's decision): 30 days for the proposed $25 and 24 hours for $1.00 (the most a stock @x402/fetch client pays with its default cap), good only on
// the brief routes this instance sells, nothing drawn per call, each route one call per `paceMs` per key (a brief changes slowly; a pass is not an invitation
// to poll). The pace map names every brief route so a route that is switched on later (the news brief) is paced from its first call.
const BRIEFS = require('../tools/briefs/config');
const briefPace = (ms) => Object.fromEntries(BRIEFS.ALL_ROUTES.map((r) => [r, ms]));
const BRIEF_PASS = { id: 'brief', usd: BRIEFS.PASS_PROPOSED.usd, days: BRIEFS.PASS_PROPOSED.days, allow: BRIEFS.soldRoutes(), pace: briefPace(BRIEFS.PASS_PROPOSED.paceMs), label: 'brief pass', path: '/api/keys/buy-brief-pass', tool: 'buy_key_brief_pass' };
const BRIEF_DAY_PASS = { id: 'brief-day', usd: BRIEFS.DAY_PASS_PROPOSED.usd, days: BRIEFS.DAY_PASS_PROPOSED.days, allow: BRIEFS.soldRoutes(), pace: briefPace(BRIEFS.DAY_PASS_PROPOSED.paceMs), label: 'brief day pass', path: '/api/keys/buy-brief-day-pass', tool: 'buy_key_brief_day_pass' };
const BRIEF_KINDS = [BRIEF_PASS, BRIEF_DAY_PASS];
const PASSES = [PASS, DAY_PASS, ...BRIEF_KINDS];
const DAY_MS = 86_400_000;
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
/** the kind of pass (PASS, DAY_PASS or a brief pass) a purchase or a stored row is; a comp grant of another length reads as the 30-day bot pass */
// A row whose routes are all brief routes is a brief pass whatever subset it was sold with (the news brief may be switched on or off after the sale).
const isBriefSet = (routes) => !!routes && routes.length > 0 && routes.every((r) => BRIEFS.ALL_ROUTES.includes(r));
const kindOf = (days, routes) => (isBriefSet(routes)
  ? (BRIEF_KINDS.find((k) => k.days === days) || (days === 1 ? BRIEF_DAY_PASS : BRIEF_PASS))
  : PASSES.find((k) => k.days === days && sameSet(k.allow, routes || [])) || (days === 1 ? DAY_PASS : PASS));
const passOf = (row) => kindOf(row && row.pass_days, routesOf(row));
const spanOf = (days) => (days === 1 ? '24-hour' : `${days}-day`);
/** "6 a minute" for a pace of 10,000 ms */
const perMinute = (ms) => Math.floor(60_000 / ms);
/** the 429 text for a paced route */
const paceMsg = (kind, route, wait) => `this ${kind.label} answers ${route} one call every ${kind.pace[route] / 1000} s per key (${perMinute(kind.pace[route])} a minute). Retry in ${wait} s.`;
/** the 401 text for an expired pass: the date for the 30-day pass, the minute for the 24-hour one */
function expiredMsg(row) {
  const kind = passOf(row), at = new Date(row.expires_at).toISOString();
  return `this ${kind.label} expired on ${kind.days === 1 ? at.slice(0, 16).replace('T', ' ') + ' UTC' : at.slice(0, 10)}`;
}
/** the routes a pass key is limited to, or null for an ordinary key */
const routesOf = (row) => (row && row.allow ? String(row.allow).split(',').map((x) => x.trim()).filter(Boolean) : null);
const isExpired = (row, t) => !!(row && row.expires_at && row.expires_at <= t);

const SCHEMA = `CREATE TABLE IF NOT EXISTS api_keys (
  key_hash TEXT PRIMARY KEY,
  prefix TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
  balance_micro INTEGER NOT NULL DEFAULT 0,
  sold_micro INTEGER NOT NULL DEFAULT 0,
  spent_micro INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  last_used INTEGER,
  buyer TEXT,
  purchase_tx TEXT,
  rate_per_min INTEGER NOT NULL DEFAULT ${DEFAULT_RATE},
  label TEXT
);
CREATE INDEX IF NOT EXISTS api_keys_prefix ON api_keys(prefix);
CREATE INDEX IF NOT EXISTS api_keys_status_created ON api_keys(status, created);`;

function base58(buf) {
  let x = BigInt('0x' + (buf.toString('hex') || '0'));
  let out = '';
  while (x > 0n) { out = B58[Number(x % 58n)] + out; x /= 58n; }
  for (const b of buf) { if (b !== 0) break; out = '1' + out; }
  return out;
}
const newKey = () => PREFIX + base58(crypto.randomBytes(32));
const hashKey = (key) => crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
const prefixOf = (key) => String(key).slice(PREFIX.length, PREFIX.length + 8);
const toMicro = (usd) => Math.round(Number(usd) * 1e6);
const toUsd = (micro) => (micro == null ? null : Math.round(Number(micro)) / 1e6);

/** Does this request carry a payment (x402 v2 or v1, or an MPP credential)? Read from the raw headers, before any alias middleware. */
function presentsPayment(req) {
  const h = req.headers || {};
  return h['payment-signature'] != null || h['x-payment'] != null || h['payment-authorization'] != null || /^\s*payment\s+\S/i.test(String(h.authorization || ''));
}

/** The key a request presents, or null; { malformed: true } for a header that names our scheme but is not a key. */
function presentedKey(req) {
  const h = req.headers || {};
  let raw = h['x-agentfeed-key'];
  if (Array.isArray(raw)) raw = raw[0];
  let from = 'x-agentfeed-key';
  if (raw == null || String(raw).trim() === '') {
    const m = /^\s*bearer\s+(\S+)\s*$/i.exec(String(h.authorization || ''));
    if (!m || !m[1].startsWith(PREFIX)) return null; // a Bearer token that is not ours is not our business
    raw = m[1];
    from = 'authorization';
  }
  const key = String(raw).trim();
  return KEY_RE.test(key) ? { key, from } : { malformed: true, from };
}

function makeKeyStore(db, { now = () => Date.now() } = {}) {
  db.exec(SCHEMA);
  // the bot pass: three nullable columns, added to a table that predates them (additive; existing rows read NULL and behave as before)
  const have = new Set(db.prepare('PRAGMA table_info(api_keys)').all().map((c) => c.name));
  for (const [col, type] of [['pass_days', 'INTEGER'], ['expires_at', 'INTEGER'], ['allow', 'TEXT']]) if (!have.has(col)) db.exec(`ALTER TABLE api_keys ADD COLUMN ${col} ${type}`);
  const q = {
    get: db.prepare('SELECT * FROM api_keys WHERE key_hash = ?'),
    insert: db.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, created, rate_per_min, label, buyer, pass_days, expires_at, allow)
                        VALUES (@key_hash, @prefix, @status, @balance_micro, @sold_micro, @created, @rate_per_min, @label, @buyer, @pass_days, @expires_at, @allow)`),
    activate: db.prepare("UPDATE api_keys SET status = 'active', buyer = ?, purchase_tx = ?, expires_at = CASE WHEN pass_days IS NOT NULL THEN ? + pass_days * 86400000 ELSE expires_at END WHERE key_hash = ? AND status = 'pending'"),
    dropPending: db.prepare("DELETE FROM api_keys WHERE key_hash = ? AND status = 'pending'"),
    sweep: db.prepare("DELETE FROM api_keys WHERE status = 'pending' AND created < ?"),
    credit: db.prepare("UPDATE api_keys SET balance_micro = balance_micro + ?, sold_micro = sold_micro + ? WHERE key_hash = ? AND status IN ('active', 'revoked')"),
    reserve: db.prepare("UPDATE api_keys SET balance_micro = balance_micro - ? WHERE key_hash = ? AND status = 'active' AND balance_micro >= ?"),
    refund: db.prepare('UPDATE api_keys SET balance_micro = balance_micro + ? WHERE key_hash = ?'),
    commit: db.prepare('UPDATE api_keys SET calls = calls + 1, spent_micro = spent_micro + ?, last_used = ? WHERE key_hash = ?'),
    learnPrefix: db.prepare('UPDATE api_keys SET prefix = ? WHERE key_hash = ? AND (prefix IS NULL OR prefix <> ?)'),
    byPrefix: db.prepare("SELECT * FROM api_keys WHERE prefix = ? OR key_hash LIKE ? || '%' ORDER BY created"),
    list: db.prepare('SELECT * FROM api_keys ORDER BY created'),
    setStatus: db.prepare('UPDATE api_keys SET status = ? WHERE key_hash = ?'),
    setRate: db.prepare('UPDATE api_keys SET rate_per_min = ? WHERE key_hash = ?'),
  };
  return {
    db,
    get: (hash) => q.get.get(hash) || null,
    /** a pending row; throws on a duplicate hash (the handler turns that into a 400, which cancels the settlement) */
    createPending({ hash, prefix, creditMicro, soldMicro, passDays, allow }) {
      q.insert.run({ key_hash: hash, prefix: prefix || null, status: 'pending', balance_micro: creditMicro, sold_micro: soldMicro == null ? creditMicro : soldMicro, created: now(), rate_per_min: DEFAULT_RATE, label: null, buyer: null,
        pass_days: passDays || null, expires_at: null, allow: allow && allow.length ? allow.join(',') : null });
    },
    activate: (hash, buyer, tx) => q.activate.run(buyer || null, tx || null, now(), hash).changes === 1,
    dropPending: (hash) => q.dropPending.run(hash).changes,
    sweep: (at = now()) => q.sweep.run(at - PENDING_TTL_MS).changes,
    credit: (hash, micro) => q.credit.run(micro, micro, hash).changes === 1,
    reserve: (hash, micro) => q.reserve.run(micro, hash, micro).changes === 1,
    refund: (hash, micro) => q.refund.run(micro, hash).changes,
    commit: (hash, micro) => q.commit.run(micro, now(), hash).changes,
    learnPrefix: (hash, prefix) => q.learnPrefix.run(prefix, hash, prefix).changes,
    find: (p) => q.byPrefix.all(String(p), String(p).toLowerCase()),
    list: () => q.list.all(),
    setStatus: (hash, s) => q.setStatus.run(s, hash).changes,
    setRate: (hash, n) => q.setRate.run(n, hash).changes,
    /** a comp or partner key, active at once; returns the key (the caller prints it once and keeps nothing) */
    grant(usd, label) {
      const key = newKey();
      q.insert.run({ key_hash: hashKey(key), prefix: prefixOf(key), status: 'active', balance_micro: toMicro(usd), sold_micro: 0, created: now(), rate_per_min: DEFAULT_RATE, label: label || null, buyer: 'grant', pass_days: null, expires_at: null, allow: null });
      return key;
    },
    /** a comp bot pass, active at once for `days` days on `allow` (sold 0: never revenue); returns the key */
    grantPass({ days = PASS.days, allow = PASS.allow, label } = {}) {
      const key = newKey();
      q.insert.run({ key_hash: hashKey(key), prefix: prefixOf(key), status: 'active', balance_micro: 0, sold_micro: 0, created: now(), rate_per_min: DEFAULT_RATE, label: label || null, buyer: 'grant', pass_days: days, expires_at: now() + days * DAY_MS, allow: allow.join(',') });
      return key;
    },
  };
}

/**
 * The body of a purchase response. ONE function builds it for the handler and for the static Bazaar example
 * (a capture would create a key), so the example cannot drift from what a buyer receives.
 */
function purchaseBody({ key, hash, prefix, creditMicro }) {
  const base = {
    prefix,
    credit_usd: toUsd(creditMicro),
    balance_usd: toUsd(creditMicro),
    status: 'active',
    rate_per_min: DEFAULT_RATE,
    use: 'send it on every call as the header X-AgentFeed-Key: <key> (or Authorization: Bearer <key>); each call costs half the route\'s x402 price, minimum $0.0005',
    balance: 'GET /api/keys/balance with the same header (free)',
    topup: 'GET /api/keys/topup-5 or /api/keys/topup-20 with the same header',
    terms: 'usage credit, non-refundable, no expiry; the key is a bearer secret: anyone holding it spends the balance; abuse means revocation',
  };
  if (key) return { key, ...base, note: 'this is the only time the key is shown; it is not stored anywhere on our side, only its sha256' };
  return { ...base, key_hash_prefix: hash.slice(0, 12), note: 'registered by its hash: we never saw your key; it works as soon as this response arrives' };
}

/** The body of a pass purchase response, the 30-day bot pass or the 24-hour day pass (the pass counterpart of purchaseBody; one function for the handler and the static example). */
function passBody({ key, hash, prefix, priceMicro = toMicro(PASS.usd), days = PASS.days, routes = PASS.allow }) {
  const kind = kindOf(days, routes);
  const base = {
    prefix,
    pass: { price_usd: toUsd(priceMicro), days, routes, starts: 'when this payment settles', expires: days === 1 ? '24 hours after that' : `${days} days after that` },
    status: 'active',
    rate_per_min: DEFAULT_RATE,
    use: `send it on every call to ${routes.join(', ')} as the header X-AgentFeed-Key: <key> (or Authorization: Bearer <key>); a call costs nothing more while the pass is valid; ${kind.pace ? `each route answers one call every ${Object.values(kind.pace)[0] / 1000} seconds per key (${perMinute(Object.values(kind.pace)[0])} a minute)` : '/api/liq-feed answers one call per 10 seconds per key'}`,
    balance: 'GET /api/keys/balance with the same header (free) shows the expiry',
    terms: `a ${spanOf(days)} ${kind.label} for ${toUsd(priceMicro) === kind.usd ? 'a flat $' + kind.usd : '$' + toUsd(priceMicro)}, good only on ${routes.join(', ')}, non-refundable, cannot be topped up (buy another when it ends); the key is a bearer secret: anyone holding it uses the pass; abuse means revocation`,
  };
  if (key) return { key, ...base, note: 'this is the only time the key is shown; it is not stored anywhere on our side, only its sha256' };
  return { ...base, key_hash_prefix: hash.slice(0, 12), note: 'registered by its hash: we never saw your key; it works as soon as this response arrives' };
}

function topupBody({ prefix, creditMicro, balanceMicro, status }) {
  return {
    prefix,
    credit_usd: toUsd(creditMicro),
    balance_usd: toUsd(balanceMicro),
    status,
    note: 'credited when this payment settled; this response is only delivered after it did',
  };
}

/** What a route's response looks like, for the Bazaar entry and the docs: a placeholder key, never a real one. */
function exampleBody(tool) {
  if (tool === 'buy_key_pass') return passBody({ key: 'afk_' + 'x'.repeat(43), prefix: 'xxxxxxxx' });
  if (tool === 'buy_key_day_pass') return passBody({ key: 'afk_' + 'x'.repeat(43), prefix: 'xxxxxxxx', priceMicro: toMicro(DAY_PASS.usd), days: DAY_PASS.days, routes: DAY_PASS.allow });
  if (tool === 'buy_key_brief_pass') return passBody({ key: 'afk_' + 'x'.repeat(43), prefix: 'xxxxxxxx', priceMicro: toMicro(BRIEF_PASS.usd), days: BRIEF_PASS.days, routes: BRIEF_PASS.allow });
  if (tool === 'buy_key_brief_day_pass') return passBody({ key: 'afk_' + 'x'.repeat(43), prefix: 'xxxxxxxx', priceMicro: toMicro(BRIEF_DAY_PASS.usd), days: BRIEF_DAY_PASS.days, routes: BRIEF_DAY_PASS.allow });
  const m = /^(buy|topup)_key_(trial|\d+)$/.exec(String(tool));
  if (!m) return null;
  const usd = m[2] === 'trial' ? PACKS.trial : Number(m[2]);
  if (m[1] === 'topup') return topupBody({ prefix: 'Hk3mQ9xZ', creditMicro: toMicro(usd), balanceMicro: toMicro(usd + 0.043), status: 'active' });
  return purchaseBody({ key: 'afk_' + 'x'.repeat(43), prefix: 'xxxxxxxx', creditMicro: toMicro(usd) });
}

/** One line for openapi, llms.txt, SKILL.md and the landing page, derived from the pricing table so it cannot go stale. */
function keysSentence(PRICES = {}) {
  const packs = Object.entries(PRICES).filter(([r]) => /^GET \/api\/keys\/buy-(?!pass|day-pass|brief-)/.test(r)).map(([, p]) => p.usd).sort((a, b) => a - b);
  const money = (n) => `$${Number(n)}`;
  const pass = PRICES['GET /api/keys/buy-pass'];
  const day = PRICES['GET /api/keys/buy-day-pass'];
  const bpass = PRICES['GET /api/keys/buy-brief-pass'];
  const bday = PRICES['GET /api/keys/buy-brief-day-pass'];
  // @x402/core 2.28 clients refuse any payment over $1 by default (spendControls.maxAmountPerPayment), so the dearer purchases need the cap raised
  const dear = [...packs, ...(pass ? [pass.usd] : []), ...(bpass ? [bpass.usd] : [])].filter((n) => n > 1).sort((a, b) => a - b);
  const cap = dear.length ? ` A stock x402 client (@x402/fetch) refuses a payment over $1 until its spend cap is raised (spendControls.maxAmountPerPayment), which the ${dear.map(money).join(', ')} purchase${dear.length > 1 ? 's need' : ' needs'}.` : '';
  return packs.length
    ? `Bots that cannot pay x402 can buy a prepaid key once (${packs.map(money).join(', ')}; page at /keys) and send it as X-AgentFeed-Key: each call then costs half the route price, minimum $0.0005, drawn from the balance (GET /api/keys/balance, free).${pass ? ` A ${PASS.days}-day bot pass for ${PASS.allow.join(', ')} is ${money(pass.usd)} flat, with nothing drawn per call (/api/keys/buy-pass).` : ''}${day ? ` A ${spanOf(DAY_PASS.days)} day pass for ${DAY_PASS.allow.join(' and ')} is ${money(day.usd)} flat (/api/keys/buy-day-pass), each route one call every ${Object.values(DAY_PASS.pace)[0] / 1000} seconds per key (${perMinute(Object.values(DAY_PASS.pace)[0])} a minute): at that price a default x402 client buys it as is.` : ''}${bpass ? ` A ${BRIEF_PASS.days}-day brief pass for the brief routes (${BRIEF_PASS.allow.join(', ')}) is ${money(bpass.usd)} flat (/api/keys/buy-brief-pass)${bday ? `, or ${money(bday.usd)} for 24 hours (/api/keys/buy-brief-day-pass)` : ''}, each route one call every ${Object.values(BRIEF_PASS.pace)[0] / 1000} seconds per key, nothing drawn per call.` : ''}${cap}`
    : '';
}

/** Public view of a row; never the hash in full, never the key. */
function publicView(row, at = Date.now()) {
  const routes = routesOf(row);
  const expired = isExpired(row, at);
  return {
    prefix: row.prefix || null,
    balance_usd: toUsd(row.balance_micro),
    calls: row.calls,
    spent_usd: toUsd(row.spent_micro),
    last_used: row.last_used ? new Date(row.last_used).toISOString() : null,
    rate_per_min: row.rate_per_min,
    status: expired && row.status === 'active' ? 'expired' : row.status,
    ...(routes ? { pass: { kind: passOf(row).id, routes, expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null, days_left: row.expires_at ? Math.max(0, Math.ceil((row.expires_at - at) / DAY_MS)) : null, hours_left: row.expires_at ? Math.max(0, Math.ceil((row.expires_at - at) / 3_600_000)) : null, note: `a flat-price ${passOf(row).label}: no balance is drawn` } } : {}),
  };
}

/**
 * Calls cb({ payer, transaction, network }) once, at the moment a successful settlement becomes present on this
 * response: a PAYMENT-RESPONSE / X-PAYMENT-RESPONSE header carrying success:true (x402 v2 and v1), or an assignment
 * to req.mppSettlement (MPP tempo, mpp/tempo.js). Install it inside the handler: every payment layer sets these
 * after the handler returned and before the buffered body is released.
 */
function onSettled(req, res, cb) {
  let fired = false;
  const fire = (s) => { if (fired) return; fired = true; try { cb(s || {}); } catch (e) { console.error('[keys] settlement hook failed:', e.message); } };
  const set = res.setHeader;
  res.setHeader = function (name, value) {
    const r = set.apply(this, arguments);
    const n = String(name).toLowerCase();
    if (n === 'payment-response' || n === 'x-payment-response') {
      try {
        const s = JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));
        if (s && s.success === true) fire({ payer: s.payer || null, transaction: s.transaction || null, network: s.network || null });
      } catch { /* not a settlement header we can read: no activation */ }
    }
    return r;
  };
  let mpp = req.mppSettlement;
  if (mpp) fire({ payer: mpp.payer, transaction: mpp.transaction });
  Object.defineProperty(req, 'mppSettlement', {
    configurable: true, enumerable: true,
    get: () => mpp,
    set: (v) => { mpp = v; if (v) fire({ payer: v.payer || null, transaction: v.transaction || null, network: v.method || null }); },
  });
  return { get fired() { return fired; } };
}

/**
 * Everything server.js and expansion.js wire in Phase 2.
 * deps: { db, PRICES, logCall, hfUsd, paymentsOn, now? }
 */
function makeKeys({ db, PRICES, logCall, hfUsd, paymentsOn = true, now = () => Date.now() }) {
  const store = makeKeyStore(db, { now });
  const KEY_ROUTE = /^\/api\/keys\//;
  // path -> { pattern, tool, usd } on the CANONICAL path (lib/canon-path.js, R19a): the same spellings x402 routes to a priced route
  const PRICED = pricedMatcher(Object.entries(PRICES)
    .filter(([pattern]) => pattern.startsWith('GET ') && !KEY_ROUTE.test(pattern.slice(4)))
    .map(([pattern, p]) => ({ pattern, tool: p.tool, usd: p.usd })));
  const pricedFor = (path) => PRICED.find(path);

  const sweepTimer = setInterval(() => { try { store.sweep(); } catch (e) { console.error('[keys] sweep failed:', e.message); } }, 60_000);
  if (sweepTimer.unref) sweepTimer.unref();

  // ---- 1. identify: before the IP limiter. Reads and REMOVES the key header, looks the hash up (no reserve).
  // A valid active key gets its own per-key bucket instead of the IP bucket (server.js skips req.afKey.active).
  const buckets = new Map();
  // R15c: the last admitted call of a paced route per pass key ("<hash>|<route>" -> ms). In memory: a restart forgets it, which costs one early call.
  const paced = new Map();
  const bucketTimer = setInterval(() => { const t = now(); for (const [k, b] of buckets) if (t - b.windowStart > 120_000) buckets.delete(k); for (const [k, at] of paced) if (t - at > 600_000) paced.delete(k); }, 120_000);
  if (bucketTimer.unref) bucketTimer.unref();
  function identify(req, res, next) {
    const p = presentedKey(req);
    if (!p) return next();
    delete req.headers['x-agentfeed-key'];
    if (p.from === 'authorization') delete req.headers.authorization; // a Bearer key never reaches the Payment-alias middlewares
    if (p.malformed) { req.afKey = { presented: true, active: false, row: null, hash: null }; return next(); }
    const hash = hashKey(p.key);
    const row = store.get(hash);
    if (row && row.prefix !== prefixOf(p.key)) store.learnPrefix(hash, prefixOf(p.key)); // a key_hash purchase meets its key
    const expired = isExpired(row, now());
    const active = !!row && row.status === 'active' && !expired;
    req.afKey = { presented: true, active, expired, row: row ? { ...row, prefix: prefixOf(p.key) } : null, hash };
    if (!active) return next();
    const metered = req.method === 'GET' || (req.method === 'POST' && req.path === '/mcp');
    if (!metered) return next();
    const t = now();
    let b = buckets.get(hash);
    if (!b || t - b.windowStart > 60_000) { b = { windowStart: t, n: 0, logged: false }; buckets.set(hash, b); }
    b.n++;
    const limit = row.rate_per_min || DEFAULT_RATE;
    if (b.n > limit) {
      const retryAfter = Math.max(1, Math.ceil((b.windowStart + 60_000 - t) / 1000));
      res.set('Retry-After', String(retryAfter));
      if (!b.logged) {
        b.logged = true;
        logCall({ tool: 'rate_limited', status: 'bad_request', ip: req.callerIp || req.headers['cf-connecting-ip'] || null, payer_wallet: `key:${req.afKey.row.prefix}`,
          error_msg: `key rate limit: ${limit} req/min exceeded (retry after ${retryAfter}s)`, req_path: req.path, user_agent: req.headers['user-agent'], method: req.method });
      }
      return res.status(429).json({ error: `key rate limit: ${limit} req/min`, retry_after: retryAfter });
    }
    return next();
  }

  /** seconds to wait before this pass key may call this route again, or 0 and the call is admitted (and remembered) */
  function paceWait(row, hash, route) {
    const gap = passOf(row).pace && passOf(row).pace[route];
    if (!gap) return 0;
    const k = `${hash}|${route}`, t = now(), prev = paced.get(k);
    if (prev != null && t - prev < gap) return Math.ceil((gap - (t - prev)) / 1000);
    paced.set(k, t);
    return 0;
  }

  /** R15d/R15e: who a key request is, for tools/liqfeed.js over MCP: { key: 'key:<prefix>', pass } for an active key, a pass or a prepaid pack; null for
   *  anything else (no key, a pending/revoked/expired key). `key` is the string the REST rail gates on (req.keyPaid.prefix), so one key has one clock
   *  across REST and MCP; `pass` picks the interval (10 s for a pass key, 5 s for a pack). */
  function gateCaller(req) {
    const k = req && req.afKey;
    return k && k.active && k.row ? { key: `key:${k.row.prefix}`, pass: !!routesOf(k.row) } : null;
  }

  // ---- 2. purchase guard: before every payment layer. Refusals that must come BEFORE anyone pays.
  function purchaseGuard(req, res, next) {
    const cp = canonPath(req.path);   // a refusal that must come BEFORE anyone pays holds for every spelling x402 would take payment on (R19a)
    if (req.method !== 'GET' || !KEY_ROUTE.test(cp) || cp === '/api/keys/balance') return next();
    if (!paymentsOn) return res.status(503).json({ error: 'key sales need the payment layer, which is off on this instance' });
    if (/^\/api\/keys\/buy-/.test(cp)) {
      const kh = req.query && req.query.key_hash;
      if (kh != null && kh !== '') {
        if (typeof kh !== 'string' || !HASH_RE.test(kh.toLowerCase())) return res.status(400).json({ error: 'key_hash must be 64 hex characters: the sha256 of a key you generated as afk_ + base58 of 32 random bytes' });
        if (store.get(kh.toLowerCase())) return res.status(409).json({ error: 'this key_hash is already registered; generate a new key' });
      }
      const pf = req.query && req.query.prefix;
      if (pf != null && pf !== '' && (typeof pf !== 'string' || !PREFIX_RE.test(pf))) return res.status(400).json({ error: 'prefix must be the 8 characters after afk_ in your key' });
      return next();
    }
    if (/^\/api\/keys\/topup-/.test(cp)) {
      const k = req.afKey;
      if (k && k.presented) {
        // a key was sent: it must be usable, whether or not a payment came with it
        if (k.row && routesOf(k.row)) return res.status(400).json({ error: `a ${passOf(k.row).label} cannot be topped up: buy another pass when it ends`, buy: passOf(k.row).path });
        if (k.row && k.row.status === 'active') return next();
        return res.status(401).json({ error: k.row && k.row.status === 'revoked' ? 'this key is revoked' : 'a top-up needs the key it credits: this key is unknown or its purchase has not settled', buy: BUY_PATH });
      }
      // No key header. A request that presents a payment is refused now, before anything can settle. One that presents none gets the
      // plain 402 challenge like every other priced route: crawlers, validators (CDP, x402scan) and x402 clients all start there, and a
      // route that answers 401 to them is read as broken and dropped from the catalogues.
      if (presentsPayment(req)) return res.status(401).json({ error: 'a top-up needs the key it credits: send X-AgentFeed-Key: afk_... with the payment', buy: BUY_PATH });
      return next();
    }
    return next();
  }

  // ---- 3. charge: after the HEAD guard, GET-only, the https fix and query canonicalisation; before the refusal
  // recorder, demand, the alias middlewares, x402 v1, tempo, MPP and the x402 gate (all of which skip req.keyPaid).
  function charge(req, res, next) {
    if (!req.afKey || !req.afKey.presented) return next();
    if (req.method !== 'GET' || KEY_ROUTE.test(req.path)) return next();
    const priced = pricedFor(req.path);
    if (!priced) return next(); // a key on a free route is ignored
    if (req.headOnly) return next(); // HEAD: no body, no charge; the x402 layer answers its plain challenge
    if (!req.afKey.active) {
      const st = req.afKey.row ? req.afKey.row.status : null;
      if (req.afKey.expired) return res.status(401).json({ error: expiredMsg(req.afKey.row), buy: passOf(req.afKey.row).path });
      return res.status(401).json({ error: st === 'revoked' ? 'this key is revoked' : st === 'pending' ? 'this key\'s purchase has not settled' : 'unknown key', buy: BUY_PATH });
    }
    const passRoutes = routesOf(req.afKey.row);
    if (passRoutes && !passRoutes.includes(priced.pattern.slice(4))) {
      return res.status(403).json({ error: `this key is a ${passOf(req.afKey.row).label}, good only on ${passRoutes.join(', ')}`, routes: passRoutes, buy: BUY_PATH });
    }
    const wait = passRoutes ? paceWait(req.afKey.row, req.afKey.hash, priced.pattern.slice(4)) : 0;
    if (wait) {
      res.set('Retry-After', String(wait));
      return res.status(429).json({ error: paceMsg(passOf(req.afKey.row), priced.pattern.slice(4), wait), retry_after: wait });
    }
    const usd = passRoutes ? 0 : hfUsd(priced.usd);          // a pass is paid for already: no draw, and a 0 amount on its 'key' row
    const micro = toMicro(usd);
    const hash = req.afKey.hash;
    if (!passRoutes && !store.reserve(hash, micro)) {
      const row = store.get(hash);
      return res.status(402).json({ error: 'key balance too low', balance_usd: toUsd(row ? row.balance_micro : 0), price_usd: usd, topup: TOPUP_PATH });
    }
    for (const h of ['payment-signature', 'x-payment', 'payment-authorization']) delete req.headers[h]; // one payment per call
    req.keyPaid = { prefix: req.afKey.row.prefix, micro, usd, hash, tool: priced.tool, pass: !!passRoutes };
    const t0 = now();
    const reqPath = req.path; // read now: the alias middlewares after this one may rewrite it
    const userAgent = req.headers['user-agent'];
    let done = false;
    const settle = (finished) => {
      if (done) return;
      done = true;
      if (!finished || res.statusCode >= 400) { if (micro) store.refund(hash, micro); return; }
      store.commit(hash, micro);
      logCall({ tool: priced.tool, status: 'key', payer_wallet: `key:${req.keyPaid.prefix}`, tx_sig: null, amount_usdc: usd, latency_ms: now() - t0, ip: req.callerIp,
        req_path: req.x402OriginalPath || reqPath, user_agent: userAgent });
    };
    res.on('finish', () => settle(true));
    res.on('close', () => settle(res.writableFinished));
    return next();
  }

  // ---- 4. the purchase and top-up handlers (EXP run functions; Phase 2 passes req as the second argument)
  function buy(args, req, creditUsd, opts = {}) {
    if (!paymentsOn) throw Object.assign(new Error('key sales need the payment layer'), { status: 503 });
    const res = req && req.res;
    if (!res) throw new Error('keys: buy needs the HTTP response (REST only)');
    const pass = opts.pass ? { days: opts.pass.days || PASS.days, allow: opts.pass.allow || PASS.allow } : null;
    const creditMicro = pass ? 0 : toMicro(creditUsd);          // a pass carries no balance; what was paid is its sold amount
    const soldMicro = toMicro(creditUsd);
    let key = null;
    let hash;
    let prefix;
    const kh = args.key_hash == null || args.key_hash === '' ? null : String(args.key_hash).toLowerCase();
    if (kh) {
      if (!HASH_RE.test(kh)) throw Object.assign(new Error('key_hash must be 64 hex characters'), { kind: 'bad_request' });
      hash = kh;
      prefix = args.prefix && PREFIX_RE.test(String(args.prefix)) ? String(args.prefix) : null;
    } else {
      key = newKey();
      hash = hashKey(key);
      prefix = prefixOf(key);
    }
    try {
      store.createPending({ hash, prefix, creditMicro, soldMicro, passDays: pass && pass.days, allow: pass && pass.allow });
    } catch (e) {
      // a duplicate that raced past the guard: 400 cancels the settlement, so nobody is charged
      throw Object.assign(new Error(/UNIQUE|PRIMARY/i.test(e.message) ? 'this key_hash is already registered; generate a new key' : 'the key could not be created'), { kind: 'bad_request' });
    }
    const hook = onSettled(req, res, (s) => { store.activate(hash, s.payer, s.transaction); });
    res.on('finish', () => { if (!hook.fired) store.dropPending(hash); });
    return pass ? passBody({ key, hash, prefix, priceMicro: soldMicro, days: pass.days, routes: pass.allow }) : purchaseBody({ key, hash, prefix, creditMicro });
  }

  function topup(args, req, creditUsd) {
    if (!paymentsOn) throw Object.assign(new Error('key sales need the payment layer'), { status: 503 });
    const res = req && req.res;
    const k = req && req.afKey;
    if (!res || !k || !k.row) throw Object.assign(new Error('a top-up needs the key it credits'), { kind: 'bad_request' });
    const creditMicro = toMicro(creditUsd);
    const hash = k.hash;
    onSettled(req, res, () => { store.credit(hash, creditMicro); });
    return topupBody({ prefix: k.row.prefix, creditMicro, balanceMicro: (store.get(hash) || k.row).balance_micro + creditMicro, status: k.row.status });
  }

  // ---- 4b. POST /mcp (R9 2a). A key reaches MCP the same way as REST: the X-AgentFeed-Key or Authorization: Bearer
  // header, read and removed by identify() (headers only; a key in a URL or in the JSON-RPC body is never read).
  // mcpWrap(req, def) returns the tool handler wrapper for a request that presented a key, or null when it did not
  // (mcp.js then uses its x402 wrapper). Same rules as charge(): unknown, pending or revoked is refused and never falls
  // through to x402; the price is hfUsd(def.usd), reserved atomically; a tool that throws or answers isError is
  // refunded; a served call counts and writes one calls row, status 'key'. Answers are MCP tool results, so a refusal
  // is an isError result carrying the same JSON the REST rail sends.
  function mcpWrap(req, def) {
    const k = req && req.afKey;
    if (!k || !k.presented || !def.usd) return null;
    const refuse = (body) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] });
    return (handler) => async (args, extra) => {
      if (!k.active) {
        const st = k.row ? k.row.status : null;
        if (k.expired) return refuse({ error: expiredMsg(k.row), status: 401, buy: passOf(k.row).path });
        return refuse({ error: st === 'revoked' ? 'this key is revoked' : st === 'pending' ? 'this key\'s purchase has not settled' : 'unknown key', status: 401, buy: BUY_PATH });
      }
      const passRoutes = routesOf(k.row);
      if (passRoutes) {
        const entry = PRICED.entries.find((r) => r.tool === def.name);
        if (!entry || !passRoutes.includes(entry.pattern.slice(4))) return refuse({ error: `this key is a ${passOf(k.row).label}, good only on ${passRoutes.join(', ')}`, status: 403, routes: passRoutes });
      }
      if (passRoutes) {
        const route = PRICED.entries.find((r) => r.tool === def.name).pattern.slice(4);
        const wait = paceWait(k.row, k.hash, route);
        if (wait) return refuse({ error: paceMsg(passOf(k.row), route, wait), status: 429, retry_after: wait });
      }
      const usd = passRoutes ? 0 : hfUsd(def.usd);
      const micro = toMicro(usd);
      if (!passRoutes && !store.reserve(k.hash, micro)) {
        const row = store.get(k.hash);
        return refuse({ error: 'key balance too low', status: 402, balance_usd: toUsd(row ? row.balance_micro : 0), price_usd: usd, topup: TOPUP_PATH });
      }
      const t0 = now();
      let out;
      try {
        out = await handler(args, extra);
      } catch (e) {
        if (micro) store.refund(k.hash, micro);
        throw e;
      }
      if (out && out.isError) { if (micro) store.refund(k.hash, micro); return out; }
      store.commit(k.hash, micro);
      logCall({ tool: def.name, status: 'key', payer_wallet: `key:${k.row.prefix}`, tx_sig: null, amount_usdc: usd, latency_ms: now() - t0, ip: req.callerIp, req_path: '/mcp', user_agent: req.headers['user-agent'], method: 'POST' });
      return out;
    };
  }

  // ---- 5. GET /api/keys/balance (free)
  function balance(req, res) {
    res.set('Cache-Control', 'no-store'); // an account answer: never cached by a CDN or a proxy
    const k = req.afKey;
    if (!k || !k.row) return res.status(401).json({ error: k && k.presented ? 'unknown key' : 'send X-AgentFeed-Key: afk_... (or Authorization: Bearer afk_...)', buy: BUY_PATH });
    const row = store.get(k.hash);
    if (!row) return res.status(401).json({ error: 'unknown key', buy: BUY_PATH });
    return res.json(publicView({ ...row, prefix: k.row.prefix }, now()));
  }

  return { store, identify, purchaseGuard, charge, buy, topup, balance, mcpWrap, gateCaller, pricedFor, stop: () => { clearInterval(sweepTimer); clearInterval(bucketTimer); } };
}

module.exports = { makeKeys, makeKeyStore, onSettled, presentedKey, presentsPayment, publicView, purchaseBody, passBody, topupBody, exampleBody, PASS, PASS_PATH, DAY_PASS, DAY_PASS_PATH, BRIEF_PASS, BRIEF_DAY_PASS, BRIEF_KINDS, PASSES, passOf, kindOf, routesOf, isExpired, keysSentence, newKey, hashKey, prefixOf, base58, toMicro, toUsd, KEY_RE, HASH_RE, PENDING_TTL_MS, DEFAULT_RATE, PACKS, TOPUPS, SCHEMA };
