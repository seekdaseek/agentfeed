#!/usr/bin/env node
// gen-bazaar-meta.js — build bazaar-examples.json: the Bazaar discovery
// declaration for every paid route, with a REAL output example.
//
//   run:  cd /opt/agentfeed && node --env-file=.env gen-bazaar-meta.js
//
// Nothing here is hand-written per route. Three existing tables are the source:
//
//   payments.PRICES        the route list, tool name and price (48 paid routes)
//   expansion.EXP          the zod schema and run() for its 34 routes
//   mcp.TOOL_DEFS          the zod schema for the 14 routes wired in server.js
//
// The output example is captured by calling the SAME function the route calls,
// with the SAME arguments the input example advertises, and wrapping it in the
// envelope lib/tool.js actually returns ({ tool, data, paid }). An example that
// showed the bare tool return would be a response shape this service has never
// sent, so it is built from the envelope, not from the helper's return value.
//
// The examples are trimmed, never faked: arrays are cut to the first few items
// and long prose strings are ellipsed, but every field name and every type is
// what the route really returned at capture time. Trimming exists because the
// declaration travels inside the 402 challenge header on every single request.
'use strict';

const fs = require('fs');
const path = require('path');
const { z } = require('zod');

const OUT_FILE = path.join(__dirname, 'bazaar-examples.json');
// A tool whose real answer cannot be captured inside one short-lived process
// leaves its response here instead; see warm-oi-example.js. The file is a real
// captured response, written by a real call, not a hand-written fixture.
const CAPTURE_DIR = path.join(__dirname, 'captures');

// TARGET bytes of JSON for one output example. The declaration rides in the
// PAYMENT-REQUIRED header of every 402 and in the paymentPayload the client
// sends to the facilitator, so this is a live-traffic cost, not a docs cost.
//
// It is a target, not a cap: the trimmer reports OVER BUDGET rather than
// hollowing a response out to hit a number. Three composites cannot reach it
// and say so -- liquidation-stats, trade-context and exit-quote.
//
// MEASURED consequence on the 402 challenge header, base64:
//   before this change   max 2028 B
//   after                max 5904 B (trade-context), median 3480 B, min 2560 B
// That is inside Cloudflare's 32 KB response-header allowance and inside node's
// 16 KB default max-http-header-size for the X-PAYMENT header coming back.
// Lower this number and re-run the generator to shrink every example at once.
const EXAMPLE_BUDGET = 1200;

// ---- fixtures ------------------------------------------------------------
// One value per caller-supplied parameter. These are the values that go into
// the published input example AND the values used to make the real call, so
// the two can never disagree.
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_WALLET = 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu';   // the x402 payer wallet
// NOT the cj7 treasury. A published wallet example advertises whatever that
// wallet is holding, and on 2026-09-25 a drainer left 2,462 PHOTON scam tokens
// in cj7. Array trimming happened to cut them from the example -- PHOTON sat
// sixth in a 13-token list and only three survive -- so the leak was one
// re-run away from being published, not absent by design. Gack9 is the wallet
// that pays for these calls: it holds USDC and nothing a stranger can push.
const EVM_ADDRESS = '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6';     // Base treasury (public)

// symbol means a different universe per suite, so it is resolved per tool.
const SYMBOL_FOR = {
  get_peg_deviation: 'CRCLx',
  get_peg_sessions: 'CRCLx',
  get_exit_quote: 'SPYx',        // a covered Kamino reserve with a `partial` verdict
  get_cascade_forecast: 'SOL',   // this tool takes the bare asset, not the perp
};

// Extra call arguments for routes whose default parameters return a real but
// empty answer right now. They are merged into the published input example as
// well, so the example call and the example response stay the same call.
// Values must be inside the range the route's own schema documents.
const EXTRA_ARGS = {
  // default window is 90s and the majors were quiet at capture time; 300 is the
  // documented maximum and surfaces the live cascade shape rather than an empty array
  get_cascade_alert: { window: 300 },
  get_cascade_scan: { window: 300 },
  // the default 100k threshold matched nothing on the live tape at capture time,
  // so the example published an empty trades array and taught a caller nothing
  // about the shape of a print. 50k is inside the documented range and returns
  // real prints.
  get_whale_trades: { min_usd: 50000 },
};

function fixture(key, tool) {
  switch (key) {
    case 'mint': return BONK;                  // never USDC: a stablecoin has no interesting holder concentration
    case 'wallet': return SOL_WALLET;
    case 'address': return EVM_ADDRESS;
    case 'input_mint': return WSOL;
    case 'output_mint': return USDC;
    case 'amount': return '1000000000';        // 1 SOL in raw base units
    case 'target': return 'jito';
    case 'symbol': return SYMBOL_FOR[tool] || 'SOLUSDT';
    default: return undefined;                 // numeric/enum knobs stay out of the example
  }
}

// ---- example trimming ----------------------------------------------------
function bytes(v) { return Buffer.byteLength(JSON.stringify(v), 'utf8'); }

/**
 * Find the MAP GROUP inside an object: the set of keys whose values are objects
 * sharing one shape, like the sol/btc/eth/xrp/doge of get_liquidation_stats.
 * Those keys are interchangeable, so dropping some of them leaves the published
 * shape intact and every surviving entry complete. Every other key -- scalars,
 * one-off records -- is always kept, because dropping one of those would hide a
 * field the route really returns.
 *
 * The group must have more than three members to count, so a two-field record
 * like { bid: {...}, ask: {...} } is never mistaken for a map.
 */
function mapGroup(v) {
  const sig = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().join('|') : null);
  const bySig = new Map();
  for (const [k, val] of Object.entries(v)) {
    const g = sig(val);
    if (!g) continue;
    if (!bySig.has(g)) bySig.set(g, []);
    bySig.get(g).push(k);
  }
  let best = [];
  for (const keys of bySig.values()) if (keys.length > best.length) best = keys;
  return best.length > 3 ? new Set(best) : new Set();
}

function trim(v, p, depth = 0) {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === 'string') return v.length > p.str ? v.slice(0, p.str).trimEnd() + '…' : v;
  if (typeof v !== 'object') return v;
  // NOTE: no depth truncation. Emptying a container that really had content
  // publishes a response shape the route never returns -- measured: the first
  // version of this file turned get_liquidation_stats into
  // {"1h":{},"24h":{}}, which reads as "this endpoint returns nothing".
  // Breadth is reduced instead, and hollowPaths() below fails the route loudly
  // if anything still comes out empty.
  if (Array.isArray(v)) return v.slice(0, p.arr).map((x) => trim(x, p, depth + 1));
  const group = mapGroup(v);
  let seen = 0;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (group.has(k)) { seen++; if (seen > p.obj) continue; }
    out[k] = trim(val, p, depth + 1);
  }
  return out;
}

/**
 * Walk the captured response and its trimmed example together and report every
 * container the trim emptied. A hollow example is a correctness bug, not a size
 * win, so the generator must not be able to emit one unnoticed.
 */
function hollowPaths(src, ex, path = '') {
  const out = [];
  if (src && typeof src === 'object' && ex && typeof ex === 'object') {
    const se = Array.isArray(src) ? src.length === 0 : Object.keys(src).length === 0;
    const ee = Array.isArray(ex) ? ex.length === 0 : Object.keys(ex).length === 0;
    if (!se && ee) return [path || '(root)'];
    if (Array.isArray(src) && Array.isArray(ex)) {
      for (let i = 0; i < ex.length; i++) out.push(...hollowPaths(src[i], ex[i], `${path}[${i}]`));
    } else if (!Array.isArray(src) && !Array.isArray(ex)) {
      for (const k of Object.keys(ex)) out.push(...hollowPaths(src[k], ex[k], path ? `${path}.${k}` : k));
    }
  }
  return out;
}

// Loosest to tightest. `arr` caps array length, `obj` caps how many entries of
// a map-like object survive, `str` caps string length.
const PLANS = [
  { arr: 3, obj: 8, str: 260 },
  { arr: 3, obj: 5, str: 180 },
  { arr: 2, obj: 4, str: 140 },
  { arr: 2, obj: 3, str: 100 },
  { arr: 2, obj: 2, str: 70 },
  { arr: 1, obj: 2, str: 60 },
  { arr: 1, obj: 2, str: 45 },
  { arr: 1, obj: 1, str: 30 },
  { arr: 1, obj: 1, str: 20 },
];

function fitExample(data, budget) {
  for (const p of PLANS) {
    const t = trim(data, p);
    if (bytes(t) <= budget) return { example: t, plan: p, over: false };
  }
  const last = PLANS[PLANS.length - 1];
  return { example: trim(data, last), plan: last, over: true };
}

// ---- schema of an example ------------------------------------------------
// A shallow JSON Schema for the envelope. Deep enough to tell an agent whether
// `data` is an object or an array and what its immediate fields are; shallow
// enough that it does not double the size of the declaration.
function schemaOf(v, depth = 0) {
  if (v === null) return {};
  if (Array.isArray(v)) {
    const s = { type: 'array' };
    if (depth < 2 && v.length) s.items = schemaOf(v[0], depth + 1);
    return s;
  }
  switch (typeof v) {
    case 'string': return { type: 'string' };
    case 'number': return { type: 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'object': {
      const s = { type: 'object' };
      if (depth < 2) {
        s.properties = {};
        for (const [k, val] of Object.entries(v)) s.properties[k] = schemaOf(val, depth + 1);
      }
      return s;
    }
    default: return {};
  }
}

// ---- route table ---------------------------------------------------------
const { PRICES } = require('./payments');
const { EXP } = require('./expansion');
const { TOOL_DEFS } = require('./mcp');

const { getPrice } = require('./tools/prices');
const { getFunding } = require('./tools/funding');
const { getFearGreed } = require('./tools/feargreed');
const { getWalletHoldings, getTokenMetadata } = require('./tools/onchain');
const { getRecentLiquidations, getLiquidationStats, getLiquidationLeaders } = require('./tools/liquidations');
const { getCascadeAlert } = require('./tools/cascade');
const { getPositioning } = require('./tools/positioning');
const { getTradeContext } = require('./tools/tradecontext');
const { getTokenRisk } = require('./tools/tokenrisk');

// The 14 routes wired directly in server.js. Each entry reproduces that file's
// handler body exactly -- same function, same argument shape -- so the captured
// example is the response the route serves, not an approximation of it.
// get_market_snapshot has no exported function at all: server.js composes it
// inline from five calls, and so does this.
const BASE_RUN = {
  get_sol_price: () => getPrice('SOL'),
  get_btc_price: () => getPrice('BTC'),
  get_funding_rate: async () => ({ sol: await getFunding('SOL'), btc: await getFunding('BTC') }),
  get_market_snapshot: async () => {
    const [sol, btc, fundingSol, fundingBtc, fg] = await Promise.all([
      getPrice('SOL'), getPrice('BTC'), getFunding('SOL'), getFunding('BTC'), getFearGreed(),
    ]);
    return { sol, btc, funding: { sol: fundingSol, btc: fundingBtc }, fear_greed: fg };
  },
  get_wallet_holdings: (a) => getWalletHoldings(a.wallet),
  get_token_metadata: (a) => getTokenMetadata(a.mint),
  get_recent_liquidations: (a) => getRecentLiquidations({ query: a }),
  get_liquidation_leaders: (a) => getLiquidationLeaders({ query: a }),
  get_liquidation_stats: () => getLiquidationStats(),
  get_cascade_alert: (a) => getCascadeAlert({ query: a }),
  get_cascade_scan: (a) => getCascadeAlert({ query: { ...a, scope: 'all' } }),
  get_positioning: () => getPositioning(),
  get_trade_context: () => getTradeContext(),
  get_token_risk: (a) => getTokenRisk(a.mint),
};

const expByRoute = new Map(EXP.map((t) => [t.route, t]));
const defByName = new Map(TOOL_DEFS.map((d) => [d.name, d]));

function buildRoutes() {
  const rows = [];
  for (const [pattern, p] of Object.entries(PRICES)) {
    const httpPath = pattern.replace('GET ', '');
    const pathParamKeys = (httpPath.match(/:([A-Za-z0-9_]+)/g) || []).map((s) => s.slice(1));
    const exp = expByRoute.get(pattern);
    const zodSchema = exp ? exp.schema : (defByName.get(p.tool) || {}).schema;
    const run = exp ? (a) => exp.run(a) : BASE_RUN[p.tool];
    rows.push({ pattern, httpPath, tool: p.tool, usd: p.usd, pathParamKeys, zodSchema: zodSchema || {}, run, source: exp ? 'expansion' : 'server' });
  }
  return rows;
}

function stripMeta(s) { const { $schema, ...rest } = s || {}; return rest; }

function splitSchema(zodSchema, pathParamKeys, tool) {
  const full = stripMeta(z.toJSONSchema(z.object(zodSchema || {})));
  const props = full.properties || {};
  const required = new Set(full.required || []);

  const query = { properties: {}, required: [] };
  const pathP = { properties: {}, required: [] };
  for (const [k, v] of Object.entries(props)) {
    const target = pathParamKeys.includes(k) ? pathP : query;
    target.properties[k] = v;
    if (required.has(k) || pathParamKeys.includes(k)) target.required.push(k);
  }
  // A path parameter is structurally required even when its zod field was
  // optional: the route does not exist without the segment.
  for (const k of pathParamKeys) {
    if (!pathP.properties[k]) pathP.properties[k] = { type: 'string', description: `${k} (path segment)` };
  }

  const input = {};
  const pathParams = {};
  for (const k of Object.keys(props)) {
    const v = fixture(k, tool);
    if (v === undefined) continue;
    if (pathParamKeys.includes(k)) pathParams[k] = v; else input[k] = v;
  }
  for (const k of pathParamKeys) if (pathParams[k] === undefined) pathParams[k] = fixture(k, tool) || 'REPLACE_ME';
  for (const [k, v] of Object.entries(EXTRA_ARGS[tool] || {})) if (k in props) input[k] = v;

  return { query, pathP, input, pathParams };
}

async function main() {
  const rows = buildRoutes();
  const missing = rows.filter((r) => typeof r.run !== 'function');
  if (missing.length) {
    console.error('FATAL: no run() for:', missing.map((r) => r.tool).join(', '));
    process.exit(1);
  }
  console.log(`generating metadata for ${rows.length} paid routes (budget ${EXAMPLE_BUDGET} B/example)\n`);

  const meta = {};
  const report = [];
  for (const r of rows) {
    const { query, pathP, input, pathParams } = splitSchema(r.zodSchema, r.pathParamKeys, r.tool);
    const callArgs = { ...input, ...pathParams };
    const capture = path.join(CAPTURE_DIR, `${r.tool}.json`);
    let status = 'OK';
    let note = '';
    let example = null;
    let plan = null;
    const t0 = Date.now();
    try {
      let data;
      if (fs.existsSync(capture)) {
        data = JSON.parse(fs.readFileSync(capture, 'utf8'));
        note = 'from captures/';
      } else {
        data = await Promise.race([
          Promise.resolve(r.run(callArgs)),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 30000ms')), 30000)),
        ]);
      }
      if (data === null || data === undefined) { status = 'EMPTY'; note = 'null'; }
      else if (Array.isArray(data) && data.length === 0) { status = 'EMPTY'; note = 'array[0]'; }
      else if (typeof data === 'object' && Object.keys(data).length === 0) { status = 'EMPTY'; note = '{}'; }
      if (data && data.error) { status = 'ERROR'; note = String(data.error).slice(0, 60); }
      const envelope = { tool: r.tool, data, paid: true };
      const fit = fitExample(envelope, EXAMPLE_BUDGET);
      example = fit.example;
      plan = fit.plan;
      if (fit.over) note = (note ? note + '; ' : '') + `OVER BUDGET (${bytes(example)}B)`;
      const hollow = hollowPaths(envelope, example);
      if (hollow.length) { status = 'HOLLOW'; note = (note ? note + '; ' : '') + `emptied: ${hollow.slice(0, 4).join(', ')}`; }
    } catch (e) {
      status = String(e.message).includes('timeout') ? 'SLOW' : 'ERROR';
      note = String(e.message).slice(0, 70);
    }

    const entry = {
      tool: r.tool,
      price_usd: r.usd,
      input,
      inputSchema: query,
    };
    if (r.pathParamKeys.length) {
      entry.pathParamsSchema = pathP;
      // The concrete values the example call used. enrichDeclaration overwrites
      // info.input.pathParams with the real request's segments at serve time, so
      // these never reach the 402 -- they are what tools/discovery.js turns into
      // one real invocable URL per route in /.well-known/x402.
      entry.pathParams = pathParams;
    }
    if (example) entry.output = { example, schema: schemaOf(example) };

    meta[r.pattern] = entry;
    report.push({
      route: r.httpPath, tool: r.tool, status, note,
      ms: Date.now() - t0,
      exBytes: example ? bytes(example) : 0,
      entryBytes: bytes(entry),
      qp: Object.keys(query.properties).length,
      pp: r.pathParamKeys.length,
      inputEx: Object.keys(input).length,
      plan: plan ? `arr${plan.arr}/str${plan.str}` : '-',
      src: r.source,
    });
    process.stdout.write(`  ${status.padEnd(5)} ${r.httpPath.padEnd(30)} ex=${String(example ? bytes(example) : 0).padStart(4)}B  ${note}\n`);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    _generated_at: new Date().toISOString(),
    _note: 'Generated by gen-bazaar-meta.js from payments.PRICES + expansion.EXP + mcp.TOOL_DEFS. Output examples are real captured responses, trimmed. Do not hand-edit; re-run the generator.',
    _example_budget_bytes: EXAMPLE_BUDGET,
    routes: meta,
  }, null, 1) + '\n');

  console.log(`\nwrote ${OUT_FILE} (${fs.statSync(OUT_FILE).size} B)`);
  const tally = report.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  console.log('tally:', Object.entries(tally).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log(`largest entry: ${Math.max(...report.map((r) => r.entryBytes))} B`);
  console.log(`routes with query params: ${report.filter((r) => r.qp).length}   with path params: ${report.filter((r) => r.pp).length}   with a non-empty input example: ${report.filter((r) => r.inputEx).length}`);
  const bad = report.filter((r) => r.status !== 'OK');
  if (bad.length) {
    console.log('\nNOT CLEAN:');
    for (const r of bad) console.log(`  ${r.status}  ${r.route} (${r.tool}) — ${r.note}`);
  }
  fs.writeFileSync('/root/gen-bazaar-report.json', JSON.stringify(report, null, 1));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
