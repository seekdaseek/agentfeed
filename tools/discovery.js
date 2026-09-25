// tools/discovery.js — the machine-readable discovery surface: /openapi.json,
// /.well-known/x402, /llms.txt and /SKILL.md.
//
// EVERYTHING HERE IS DERIVED. The route list, prices, descriptions, tags and
// parameter schemas all come from the same three tables the paywall and the
// 402 challenge are built from -- payments.PRICES, payments.TAGS and the
// generated bazaar-examples.json -- so a route added, repriced or renamed
// cannot appear in one surface and not another. Nothing below hardcodes a
// route, a price or a count.
//
// WHY THESE FILES EXIST. Measured 2026-09-25: `npx @agentcash/discovery
// x402.ochinimus.app -v` reported OPENAPI_NOT_FOUND, and x402scan's spec
// (github.com/Merit-Systems/x402scan, docs/DISCOVERY.md) says a route with no
// input schema is "strict non-invocable, marked skipped". The service had 48
// paid routes and served neither /openapi.json nor /.well-known/x402.
//
// These routes are FREE and are mounted BEFORE the x402 layer in server.js, so
// a request for them never reaches the payment middleware at all.
'use strict';

const ORIGIN = 'https://x402.ochinimus.app';

// Mirrors server.js. Named here so llms.txt, SKILL.md and openapi.json all
// state the same two numbers, and so a change there is a one-line change here.
const LIMIT_GET = 240;
const LIMIT_OTHER = 2400;

// ---- shared helpers ------------------------------------------------------

/** `/api/token-risk/:mint` -> `{ template: '/api/token-risk/{mint}', names: ['mint'] }` */
function toTemplate(p) {
  const names = [];
  const template = p.replace(/:([A-Za-z0-9_]+)/g, (_m, name) => { names.push(name); return `{${name}}`; });
  return { names, template };
}

function humanize(tool) {
  return tool.replace(/^get_/, '').split('_').filter(Boolean)
    .map((w) => (/^(sol|btc|eth|usd|oi|tvl|dex|api)$/i.test(w) ? w.toUpperCase() : w)).join(' ');
}

function cutAtWord(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,:;.\-]+$/, '');
}

// `pay catalog check` renders the summary inside the OS biometric prompt, which
// truncates at 64, and rejects superlatives and cost claims in it. Derived from
// the tool name plus the opening gist so a new route gets one for free.
const SUMMARY_MAX = 63;
const SUMMARY_MIN = 24;
function summaryFor(tool, description) {
  const subject = humanize(tool);
  const gist = String(description || '')
    .replace(/^[A-Z][A-Z\s-]{3,}:\s*/, '').split(/[.:(]/)[0].trim().toLowerCase()
    .replace(/\b(best|fastest|cheapest|largest|biggest|leading|premium|only|complete|flagship)\b\s*/g, '')
    .replace(/\s{2,}/g, ' ').trim();
  let summary = gist ? cutAtWord(`Fetch ${subject}: ${gist}`, SUMMARY_MAX) : `Fetch ${subject}`;
  if (summary.length < SUMMARY_MIN) summary = `Fetch ${subject} from the AgentFeed API`;
  if (summary.length > SUMMARY_MAX) summary = cutAtWord(summary, SUMMARY_MAX);
  return summary;
}

function schemaFor(prop) {
  const out = {};
  if (prop.type) out.type = prop.type;
  if (prop.enum) out.enum = prop.enum;
  if (prop.description) out.description = prop.description;
  if (prop.default !== undefined) out.default = prop.default;
  if (!Object.keys(out).length) out.type = 'string';
  return out;
}

// The question a caller actually has, per route. Prose, not numbers: nothing
// here can go stale when a price or a count changes. A route missing from this
// map falls back to its own description, so a new route is never dropped from
// the table -- it just gets a rougher question until someone writes one.
const QUESTIONS = {
  get_exit_quote: 'What can this seized collateral actually be sold for, at size?',
  get_peg_deviation: 'How far is a tokenized stock trading from its underlying?',
  get_peg_sessions: 'When in the trading day does the peg break worst?',
  get_peg_universe: 'Which tokenized stocks carry the worst off-hours peg risk?',
  get_liq_pulse: 'What is being liquidated right now?',
  get_liq_history: 'How much was liquidated, bucketed over time?',
  get_liq_heatmap: 'At which price levels did leverage actually get flushed?',
  get_cascade_history: 'Which liquidation cascades already happened?',
  get_cascade_forecast: 'How likely is a liquidation spike in the next 15 minutes?',
  get_squeeze_score: 'Is this trade crowded and about to hurt someone?',
  get_recent_liquidations: 'Which liquidations just printed?',
  get_cascade_alert: 'Is a cascade running on the majors right now?',
  get_cascade_scan: 'Is a cascade running on any perp right now?',
  get_liquidation_leaders: 'Which symbols are blowing up right now?',
  get_liquidation_stats: 'How much was liquidated in the last 1h and 24h?',
  get_venue_liq_share: 'Which exchange is doing the liquidating?',
  get_perp: 'What is this perp doing right now, in one call?',
  get_funding_pulse: 'Where is funding most extreme right now?',
  get_funding_cross: 'What is funding for this perp across venues?',
  get_funding_extremes: 'Which trades are most crowded by funding?',
  get_funding_history: 'What has the carry on this perp actually been?',
  get_funding_rate: 'What is funding on SOL and BTC?',
  get_open_interest: 'How much open interest sits on this perp?',
  get_oi_spike_scan: 'Where is new leverage piling in?',
  get_long_short: 'How crowded is retail on this perp?',
  get_basis: 'Is this perp trading above or below spot?',
  get_volatility: 'How volatile has this perp been?',
  get_top_movers: 'What moved most in the last 24 hours?',
  get_orderbook_imbalance: 'Which side of the book holds more resting liquidity?',
  get_orderbook_walls: 'Where are the big resting orders?',
  get_whale_trades: 'Are whales buying or selling this perp?',
  get_spread_arb: 'Is there a cross-exchange spread worth arbing?',
  get_spot: 'What is the spot price, without picking a venue?',
  get_sol_price: 'What is SOL worth?',
  get_btc_price: 'What is BTC worth?',
  get_eth_price: 'What is ETH worth?',
  get_market_snapshot: 'What is the market doing, in one call?',
  get_positioning: 'How is the market positioned on SOL and BTC?',
  get_trade_context: 'What do I need to know before placing a trade?',
  get_wallet_holdings: 'What does this Solana wallet hold?',
  get_wallet_activity: 'What has this Solana wallet been doing?',
  get_token_metadata: 'What is this SPL token?',
  get_token_risk: 'Is this SPL token a rug?',
  get_token_holders: 'Who holds this SPL token?',
  get_priority_fees: 'What priority fee will land my Solana transaction?',
  get_jito_tips: 'What tip will land my Jito bundle?',
  get_sol_network: 'Is the Solana network healthy right now?',
  get_dex_quote: 'What will this swap actually execute at?',
  get_base_gas: 'What is gas on Base?',
  get_base_balance: 'What does this EVM address hold?',
  get_tvl: 'How much TVL does this protocol have?',
  get_stablecoin_flows: 'Is stablecoin supply growing or shrinking?',
  get_fear_greed: 'What is the crypto Fear and Greed index?',
  get_last_liquidation: 'What was the last liquidation on each major?',
  get_exit_method: 'How is exit liquidity measured, and on how many rows?',
  get_forecast_record: 'How accurate has the cascade forecast actually been?',
};

/** The question for a route, or one derived from its own description. */
function questionFor(tool, desc) {
  if (QUESTIONS[tool]) return QUESTIONS[tool];
  const d = String(desc || '');
  const m = d.match(/^Use when an agent needs ([^.]+)\./);
  if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1) + '?';
  return d.split(/[.:(]/)[0].trim() + '?';
}

/** A free tool's HTTP path. Same derivation the openapi generator has always used. */
const freePath = (tool) => '/api/' + tool.replace(/^get_/, '').replace(/_/g, '-');

// ---- catalogue grouping --------------------------------------------------
// Ordered: first matching group wins, so the specific families are listed
// before the general ones. Matched on the route's real tags, never on its name.
// Ordered: first match wins. Each entry is [title, anyOfTheseTags, requiredTag?].
//
// The three "our own tape" sections are what a curation reviewer is looking
// for, so they lead. They are derived, not hand-listed: every tool built on a
// tape we record carries the `exclusive` tag, and the topical tag then says
// which tape. exit-quote has to be tested before the liquidation tape because
// it carries `liquidations` too.
const GROUPS = [
  ['Our own collateral exit-liquidity tape', ['collateral', 'exit-liquidity'], 'exclusive'],
  ['Our own tokenized-equity peg tape', ['rwa', 'peg', 'tokenized-stocks'], 'exclusive'],
  ['Our own liquidation tape', ['liquidations', 'cascade', 'squeeze', 'heatmap'], 'exclusive'],
  // Prices before liquidations: get_trade_context is a whole-market composite
  // tagged `liquidations` as well, and it belongs with market state.
  ['Market and positioning', ['price', 'market-data', 'multi-venue', 'snapshot', 'positioning']],
  ['Collateral and lending', ['collateral', 'exit-liquidity', 'lending']],
  ['Live liquidations and cascades', ['liquidations', 'cascade', 'squeeze', 'heatmap']],
  ['Tokenized stocks and peg', ['rwa', 'peg', 'tokenized-stocks']],
  ['Derivatives', ['funding', 'open-interest', 'long-short', 'basis', 'carry', 'crowding', 'perps']],
  // 'risk' was in this list and it stole get_token_risk, whose tags are
  // solana/tokens/risk/rug-check/security, out of the Solana section. It is too
  // generic to key a group on: get_volatility still lands here via 'volatility'.
  ['Microstructure and screeners', ['orderbook', 'whales', 'trades', 'flow', 'arbitrage', 'spread', 'movers', 'volatility', 'screener', 'anomaly']],
  ['Solana on-chain', ['solana', 'jito', 'mev', 'network', 'onchain', 'tps', 'dex', 'jupiter', 'swap']],
  ['Base and EVM', ['base', 'evm', 'ethereum', 'l2', 'gas', 'erc20', 'ens']],
  ['DeFi and macro', ['defi', 'tvl', 'protocols', 'stablecoins', 'macro']],
];

function groupOf(tags) {
  const t = new Set(tags || []);
  for (const [title, keys, requires] of GROUPS) {
    if (requires && !t.has(requires)) continue;
    if (keys.some((k) => t.has(k))) return title;
  }
  return 'Other';
}

/** Routes bucketed by group, in GROUPS order, with 'Other' last. */
function grouped({ PRICES, TAGS }) {
  const buckets = new Map();
  for (const [pattern, p] of Object.entries(PRICES)) {
    const g = groupOf(TAGS[p.tool]);
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g).push({ pattern, path: pattern.replace('GET ', ''), ...p });
  }
  const order = GROUPS.map(([t]) => t).concat('Other');
  return order.filter((g) => buckets.has(g)).map((g) => [g, buckets.get(g).sort((a, b) => a.path.localeCompare(b.path))]);
}

/**
 * Payment protocols for one route, in the object form both readers accept.
 * MPP's method/intent are copied from the WWW-Authenticate header this service
 * actually sends (method="solana", intent="charge"), and its currency is the
 * USDC mint carried in that challenge -- read off the wire, not assumed.
 */
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
function protocolsFor(pattern, mpp) {
  const out = [{ x402: {} }];
  if (mpp && mpp.active && (mpp.routes || []).includes(pattern)) {
    out.push({ mpp: { method: 'solana', intent: 'charge', currency: USDC_MINT } });
  }
  return out;
}

// ---- /openapi.json -------------------------------------------------------
function buildOpenApi({ PRICES, META, FREE_TOOLS, mpp }) {
  const paths = {};

  for (const [pattern, p] of Object.entries(PRICES)) {
    const raw = pattern.replace('GET ', '');
    const { names, template } = toTemplate(raw);
    const m = META[pattern] || {};
    const qProps = (m.inputSchema && m.inputSchema.properties) || {};
    const qRequired = new Set((m.inputSchema && m.inputSchema.required) || []);
    const pProps = (m.pathParamsSchema && m.pathParamsSchema.properties) || {};

    const parameters = [];
    for (const name of names) {
      parameters.push({
        description: (pProps[name] && pProps[name].description) || `${name} (required)`,
        in: 'path', name, required: true, schema: schemaFor(pProps[name] || {}),
      });
    }
    for (const [name, prop] of Object.entries(qProps)) {
      if (names.includes(name)) continue;
      parameters.push({ in: 'query', name, required: qRequired.has(name), schema: schemaFor(prop) });
    }

    const okContent = { schema: { type: 'object' } };
    if (m.output && m.output.example) okContent.example = m.output.example;
    if (m.output && m.output.schema) okContent.schema = m.output.schema;

    paths[template] = {
      get: {
        description: p.desc,
        operationId: p.tool,
        ...(parameters.length ? { parameters } : {}),
        ...(Object.keys(m.input || {}).length ? { 'x-example-query': m.input } : {}),
        ...(Object.keys(m.pathParams || {}).length ? { 'x-example-path': m.pathParams } : {}),
        responses: {
          200: { content: { 'application/json': okContent }, description: 'Paid response.' },
          400: { description: 'Malformed or missing caller parameter.' },
          402: {
            description: 'Payment required. The challenge is carried in the PAYMENT-REQUIRED response header (x402 v2)'
              + (mpp && mpp.active && mpp.routes.includes(pattern) ? ' and in WWW-Authenticate (MPP solana/charge)' : '')
              + '. USDC on Solana mainnet or Base.',
          },
          429: { description: 'Rate limited. Retry-After is set.' },
        },
        summary: summaryFor(p.tool, p.desc),
        tags: ['agentfeed'],
        'x-price-usd': p.usd,
        // x402scan format (docs/DISCOVERY.md): a paid operation must declare
        // x-payment-info with protocols and valid pricing metadata.
        // x402scan's DISCOVERY.md asks for x-payment-info.protocols and a
        // fixed price object. @agentcash/discovery reads the same field with a
        // schema, and its PaymentProtocolSchema is `record(string, unknown)`
        // (checked against @agentcash/discovery@1.7.5 dist): a bare "x402"
        // STRING fails the parse, the whole block falls through to the legacy
        // path where an object price cannot be read either, and BOTH the price
        // and the protocols come out empty -- which is exactly why the CLI
        // reported L2_PRICE_MISSING_ON_PAID and L2_PROTOCOLS_MISSING_ON_PAID on
        // all 48 routes while the price sat right there in the document.
        // The object form satisfies both: the key is present and names x402.
        'x-payment-info': {
          protocols: protocolsFor(pattern, mpp),
          price: { mode: 'fixed', currency: 'USD', amount: String(p.usd) },
        },
      },
    };
  }

  // The free sample surface. One templated operation, not one per route: the
  // catalogue already trips the crawler's route-count warning and 50 more
  // near-identical paths would cost agents tokens for no new information.
  paths['/api/sample'] = {
    get: {
      description: 'Free. Lists every paid route that has a stored sample response.',
      operationId: 'list_samples',
      responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } }, description: 'Free response. This endpoint is not payment-gated.' } },
      security: [],
      summary: 'List the free sample responses',
      tags: ['agentfeed', 'free'],
    },
  };
  paths['/api/sample/{route}'] = {
    get: {
      description: 'Free. Returns the real captured response for one paid route, with its price, input schema and paid URL. The same example the Bazaar listing carries.',
      operationId: 'get_sample',
      parameters: [{
        in: 'path', name: 'route', required: true,
        description: 'A paid route slug or tool name, e.g. liq-pulse, perp, or get_liq_pulse. GET /api/sample lists them.',
        schema: { type: 'string', enum: [...new Set(Object.keys(PRICES).map((k) => k.replace('GET /api/', '').replace(/\/:.*$/, '')))].sort() },
      }],
      responses: {
        200: { content: { 'application/json': { schema: { type: 'object' } } }, description: 'Free response. This endpoint is not payment-gated.' },
        404: { description: 'No such paid route.' },
      },
      security: [],
      summary: 'Fetch a free sample response',
      tags: ['agentfeed', 'free'],
    },
  };

  // The paid manifest cannot see the free routes, and a catalogue that omits
  // them tells an agent to pay for something it can have for nothing.
  for (const tool of FREE_TOOLS) {
    const path = freePath(tool);
    if (paths[path]) continue;
    paths[path] = {
      get: {
        description: `Free. ${humanize(tool)}.`,
        operationId: tool,
        responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } }, description: 'Free response. This endpoint is not payment-gated.' } },
        security: [],
        summary: summaryFor(tool, `${humanize(tool)} from the AgentFeed API`),
        tags: ['agentfeed', 'free'],
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'AgentFeed',
      version: '1.0.0',
      description: 'Live crypto market, liquidation, tokenized-equity and Solana on-chain data for AI agents. Paid per call in USDC over x402 on Solana or Base. No API keys, no accounts.',
      'x-generated-from': 'payments.PRICES + bazaar-examples.json, at boot',
      contact: { name: 'seekdaseek', url: 'https://github.com/seekdaseek/agentfeed' },
      'x-guidance': [
        'Every route is a GET that returns JSON. There are no API keys and no accounts.',
        'Paid routes answer 402 with the challenge base64-encoded in the PAYMENT-REQUIRED response header (x402 v2, not the body). Pay it and repeat the request with an X-PAYMENT header. USDC on Solana mainnet or Base.',
        'Response shape is always { "tool": "<name>", "data": { ... }, "paid": true }.',
        'Before paying, GET /api/sample/<route> for that route\'s real captured response, free. GET /api/sample lists them.',
        'Start cheap: /api/perp, /api/liq-pulse, /api/funding-pulse and /api/price are $0.001 each and cover most questions. The premium routes are the liquidation tape, cascade detection and the tokenized-equity peg tape.',
        'A route that cannot answer returns 200 with a decline field naming the reason; it never returns fabricated or zero-filled data.',
        `Limits: GET only on /api/* (HEAD answers 405); per caller per minute ${LIMIT_GET} GET or POST /mcp and ${LIMIT_OTHER} of any other method; a 429 carries Retry-After.`,
      ].join(' '),
    },
    externalDocs: { description: 'AgentFeed agent skill: when to use each route, what it answers and what it costs', url: `${ORIGIN}/SKILL.md` },
    servers: [{ url: ORIGIN }],
    paths,
    components: {},
  };
}

// ---- /.well-known/x402 ---------------------------------------------------
// x402scan's spec lists resources as CONCRETE URLs, not templates, so a
// path-parameter route is published with the same fixture value its Bazaar
// input example advertises -- one real, invocable URL per route.
function buildWellKnown({ PRICES, META }) {
  const resources = [];
  const skipped = [];
  for (const pattern of Object.keys(PRICES)) {
    let p = pattern.replace('GET ', '');
    const m = META[pattern];
    const examples = (m && m.pathParams) || {};
    for (const [name, value] of Object.entries(examples)) {
      p = p.replace(`:${name}`, encodeURIComponent(String(value)));
    }
    // A route whose path parameter could not be filled in is OMITTED rather than
    // published as a template. The spec asks for concrete URLs, and a listing
    // containing a literal ":mint" is an uninvocable URL presented as invocable
    // -- worse than an absent one. This only happens when the generated
    // metadata is missing, in which case the boot log has already said so.
    if (/\/:[A-Za-z0-9_]+/.test(p)) { skipped.push(p); continue; }
    resources.push(ORIGIN + p);
  }
  if (skipped.length) {
    console.warn(`[discovery] ${skipped.length} route(s) left out of /.well-known/x402, no path-parameter example: ${skipped.join(', ')}`);
  }
  return { version: 1, resources, instructions: `${ORIGIN}/llms.txt` };
}

// ---- /llms.txt and /SKILL.md --------------------------------------------
function catalogueLines({ PRICES, TAGS, META, bullet }) {
  const out = [];
  for (const [group, routes] of grouped({ PRICES, TAGS })) {
    out.push('', `${bullet.heading} ${group}`, '');
    for (const r of routes) {
      const m = META[r.pattern];
      const params = m && m.inputSchema && Object.keys(m.inputSchema.properties || {});
      const pp = m && m.pathParamsSchema && Object.keys(m.pathParamsSchema.properties || {});
      const args = [...(pp || []).map((k) => `:${k}`), ...(params || [])].join(', ');
      out.push(`${bullet.item}GET ${r.path} — $${r.usd}${args ? ` — params: ${args}` : ''}`);
      out.push(`${bullet.indent}${r.desc}`);
    }
  }
  return out;
}

function buildLlmsTxt({ PRICES, TAGS, META, FREE_TOOLS, mpp, network }) {
  const total = Object.values(PRICES).reduce((n, p) => n + p.usd, 0);
  const lines = [
    '# AgentFeed',
    '',
    'Live crypto market data, a liquidation tape, tokenized-equity peg data and Solana on-chain data, served to AI agents over HTTP.',
    `${Object.keys(PRICES).length} paid routes and ${FREE_TOOLS.length} free routes. Every route is a GET that returns JSON.`,
    '',
    '## How to pay',
    '',
    'There are no API keys and no accounts. Payment is per call, in USDC, over x402 v2.',
    '',
    '1. GET the route. Unpaid, it answers 402 and carries the payment challenge in the PAYMENT-REQUIRED response header, base64-encoded JSON. The challenge is in the HEADER, not the body.',
    '2. Pay the challenge and repeat the request with the X-PAYMENT header.',
    '3. The response body is `{ "tool": "<name>", "data": { ... }, "paid": true }`.',
    '',
    'Two rails are accepted on every paid route:',
    '',
    `- Solana ${network === 'mainnet' ? 'mainnet' : network} — USDC`,
    '- Base (eip155:8453) — USDC',
    '',
    ...(mpp && mpp.active ? [`MPP (solana/charge) is also offered on the same 402, in WWW-Authenticate, for: ${mpp.routes.join(', ')}.`, ''] : []),
    'Machine-readable:',
    '',
    `- ${ORIGIN}/openapi.json — OpenAPI 3.1, every route with parameters, prices and a real response example`,
    `- ${ORIGIN}/.well-known/x402 — the resource list`,
    `- ${ORIGIN}/.well-known/x402.json — the full manifest with prices and accepted rails`,
    `- ${ORIGIN}/mcp — the same tools over MCP (POST, streamable HTTP)`,
    `- ${ORIGIN}/api/sample/<route> — a real captured response for any paid route, free`,
    `- ${ORIGIN}/api/forecast-record — the settled cascade-forecast track record, free`,
    `- ${ORIGIN}/SKILL.md — the agent skill: when to use each route, what it answers, what it costs`,
    '',
    '## Free routes',
    '',
    ...FREE_TOOLS.map((t) => `- GET ${freePath(t)} — free, not payment-gated`),
    '',
    `## Paid routes (${Object.keys(PRICES).length}, $${total.toFixed(3)} for one call of each)`,
    ...catalogueLines({ PRICES, TAGS, META, bullet: { heading: '###', item: '- ', indent: '  ' } }),
    '',
    '## Notes',
    '',
    '- Path-parameter routes also accept the parameter as a query string: /api/token-risk?mint=<mint> is rewritten to the canonical path form before the paywall.',
    '- HEAD is not served on /api/*; it answers 405. The paid surface is GET-only.',
    `- Rate limit, per caller per minute: ${LIMIT_GET} for GET and POST /mcp, ${LIMIT_OTHER} for every other method. A 429 carries Retry-After.`,
    '- A route that cannot reach its upstream returns an error rather than a stale or invented value.',
    '',
  ];
  return lines.join('\n');
}

function buildSkillMd({ PRICES, TAGS, META, FREE_TOOLS, mpp, network }) {
  const routes = Object.entries(PRICES);
  const total = routes.reduce((n, [, p]) => n + p.usd, 0);
  const cheapest = Math.min(...routes.map(([, p]) => p.usd));
  const entry = routes.filter(([, p]) => p.usd === cheapest).map(([r]) => r.replace('GET ', ''));
  const solana = network === 'mainnet' ? 'Solana mainnet' : `Solana ${network}`;
  const freeCount = FREE_TOOLS.length + 2;

  const table = [];
  for (const [group, rs] of grouped({ PRICES, TAGS })) {
    table.push('', `### ${group}`, '', '| Question | Route | Price |', '|---|---|---|');
    for (const r of rs) {
      const m = META[r.pattern] || {};
      const args = [
        ...Object.keys((m.pathParamsSchema && m.pathParamsSchema.properties) || {}).map((k) => `:${k}`),
        ...Object.keys((m.inputSchema && m.inputSchema.properties) || {}),
      ];
      const q = questionFor(r.tool, r.desc).replace(/\|/g, '\\|');
      table.push(`| ${q} | \`GET ${r.path}\`${args.length ? ` <br>params: ${args.join(', ')}` : ''} | $${r.usd} |`);
    }
  }

  return [
    '---',
    'name: agentfeed',
    `description: Live crypto market data paid per call in USDC over x402, no API key. Use when an agent needs perp funding, open interest, a liquidation tape, cascade detection or forecasting, orderbook depth, tokenized-stock peg deviation, lending-collateral exit liquidity, Solana on-chain reads or a spot price. ${routes.length} paid routes and ${freeCount} free ones at ${ORIGIN}.`,
    '---',
    '',
    '# AgentFeed',
    '',
    `${routes.length} paid GET routes and ${freeCount} free ones at ${ORIGIN}. JSON in, JSON out. No API key, no account, no signup: payment happens per request.`,
    '',
    '## When to use AgentFeed',
    '',
    'Reach for it when the answer has to come from live market state rather than from memory or a web page:',
    '',
    '- A perp\'s funding, open interest, long/short crowding or realised volatility.',
    '- What is being liquidated right now, what was liquidated earlier, and at which price levels.',
    '- Whether a liquidation cascade is running, and how likely one is in the next 15 minutes.',
    '- How far a tokenized US equity has drifted from its underlying, and when in the day it drifts worst.',
    '- What seized lending collateral would actually realise if it had to be sold at size.',
    '- Solana reads: wallet holdings and activity, SPL token metadata and rug signals, priority fees, Jito tips, a Jupiter quote.',
    '- Base reads: gas, and any ERC20 or native balance.',
    '',
    `Do not reach for it for anything a free source answers well. Start with the free routes below, and with the ${entry.length} routes at $${cheapest} (${entry.join(', ')}) before paying for the premium tapes.`,
    '',
    '## How to pay',
    '',
    'Call the route. Unpaid, it answers **402** with the challenge base64-encoded in the **`PAYMENT-REQUIRED` response header** — not in the body. Decode it, pay it, and repeat the request with an `X-PAYMENT` header.',
    '',
    `Two rails are accepted on every paid route: **USDC on ${solana}** and **USDC on Base** (\`eip155:8453\`).`,
    ...(mpp && mpp.active
      ? ['', `**MPP** (\`solana/charge\`) is offered alongside x402 on ${mpp.routes.map((r) => `\`${r.replace('GET ', '')}\``).join(' and ')}, carried in the \`WWW-Authenticate\` header of the same 402. Clients that speak only x402 never see it.`]
      : []),
    '',
    'Every 200 has the same envelope:',
    '',
    '```json',
    '{ "tool": "get_sol_price", "data": { }, "paid": true }',
    '```',
    '',
    '## Read the spec before you guess',
    '',
    '| Endpoint | What it gives you |',
    '|---|---|',
    `| \`GET ${ORIGIN}/openapi.json\` | Every route with its parameters, price and a real captured response example |`,
    `| \`GET ${ORIGIN}/.well-known/x402.json\` | The manifest every number on this page is generated from |`,
    `| \`GET ${ORIGIN}/.well-known/x402\` | The resource list, one concrete URL per route |`,
    `| \`GET ${ORIGIN}/api/sample/<route>\` | A real response for one route, free, before you pay for it |`,
    '',
    `## Free routes (${freeCount})`,
    '',
    'No payment, no key. Same code path as the paid routes.',
    '',
    '| Route | What you get |',
    '|---|---|',
    ...FREE_TOOLS.map((t) => `| \`GET ${freePath(t)}\` | ${questionFor(t, '')} |`),
    `| \`GET /api/sample\` | Which paid routes have a stored sample response |`,
    `| \`GET /api/sample/<route>\` | One paid route's real captured response, with its price and input schema |`,
    '',
    `## Paid routes (${routes.length})`,
    '',
    `One call of every paid route costs $${total.toFixed(3)}. Prices are per call; there are no bundles, minimums or subscriptions.`,
    ...table,
    '',
    '## Limits and error codes',
    '',
    '| Code | Means | What to do |',
    '|---|---|---|',
    '| `200` | Paid and served | Read `data`; `paid` tells you whether the route was priced |',
    '| `402` | Payment required | Decode the `PAYMENT-REQUIRED` header, pay, retry with `X-PAYMENT` |',
    '| `400` | Your parameter is missing or malformed | The body names the parameter; fix and retry. Nothing was charged |',
    '| `405` | You used `HEAD` on `/api/*` | The paid surface is GET-only |',
    '| `429` | Rate limited | Wait the seconds in `Retry-After` |',
    '| `502` | An upstream failed | Retry later. Nothing is invented and nothing stale is served silently |',
    '',
    `- **Rate limit**, per caller per minute: ${LIMIT_GET} for \`GET\` and \`POST /mcp\`, ${LIMIT_OTHER} for every other method. A 429 carries \`Retry-After\`.`,
    '- A path parameter may also be sent as a query parameter (`/api/token-risk?mint=...`); it is rewritten to the canonical form before the paywall.',
    '- A route that cannot answer returns 200 with a `decline` field naming the reason. It never returns fabricated or zero-filled data.',
    '',
    '## Also available over MCP',
    '',
    `The same tools are an MCP server at \`${ORIGIN}/mcp\` (Streamable HTTP). Paid tools answer with an x402 payment request; the free ones just answer.`,
    '',
  ].join('\n');
}

module.exports = { buildOpenApi, buildWellKnown, buildLlmsTxt, buildSkillMd, ORIGIN, freePath, grouped };
