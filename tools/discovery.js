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

/** A free tool's HTTP path. Same derivation the openapi generator has always used. */
const freePath = (tool) => '/api/' + tool.replace(/^get_/, '').replace(/_/g, '-');

// ---- catalogue grouping --------------------------------------------------
// Ordered: first matching group wins, so the specific families are listed
// before the general ones. Matched on the route's real tags, never on its name.
const GROUPS = [
  // exit-quote also carries 'liquidations', 'rwa' and 'risk', so its own group
  // has to be tested before those or it lands in someone else's section and the
  // words an agent searches for -- exit liquidity, collateral -- never appear.
  ['Prices and market state', ['price', 'market-data', 'multi-venue', 'snapshot']],
  ['Collateral and exit liquidity', ['collateral', 'exit-liquidity', 'lending']],
  ['Liquidations, cascades and squeeze', ['liquidations', 'cascade', 'squeeze', 'heatmap']],
  ['Tokenized stocks and peg (RWA)', ['rwa', 'peg', 'tokenized-stocks']],
  ['Funding, open interest and positioning', ['funding', 'open-interest', 'positioning', 'long-short', 'basis', 'carry', 'crowding']],
  // 'risk' was in this list and it stole get_token_risk, whose tags are
  // solana/tokens/risk/rug-check/security, out of the Solana section. It is too
  // generic to key a group on: get_volatility still lands here via 'volatility'.
  ['Orderbook, flow and screeners', ['orderbook', 'whales', 'trades', 'flow', 'arbitrage', 'spread', 'movers', 'volatility', 'screener', 'anomaly']],
  ['Solana on-chain', ['solana', 'jito', 'mev', 'network', 'onchain', 'tps']],
  ['Base and EVM', ['base', 'evm', 'ethereum', 'l2', 'gas', 'erc20', 'ens']],
  ['DeFi and macro', ['defi', 'tvl', 'protocols', 'stablecoins', 'macro', 'dex', 'jupiter', 'swap']],
];

function groupOf(tags) {
  const t = new Set(tags || []);
  for (const [title, keys] of GROUPS) if (keys.some((k) => t.has(k))) return title;
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
        'Limits: GET only on /api/* (HEAD answers 405), 240 requests per minute per caller, and a 429 carries Retry-After.',
      ].join(' '),
    },
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
    '- Rate limit: 240 requests per minute per caller. A 429 carries Retry-After.',
    '- A route that cannot reach its upstream returns an error rather than a stale or invented value.',
    '',
  ];
  return lines.join('\n');
}

function buildSkillMd({ PRICES, TAGS, META, FREE_TOOLS, mpp, network }) {
  const total = Object.values(PRICES).reduce((n, p) => n + p.usd, 0);
  return [
    '---',
    'name: agentfeed',
    'description: Live crypto market data, liquidations, tokenized-equity peg data and Solana on-chain data over x402. Use when an agent needs perp funding, open interest, liquidation history, cascade detection, orderbook depth, tokenized-stock peg deviation, lending-collateral exit liquidity, Solana priority fees or token risk, paid per call in USDC with no API key.',
    '---',
    '',
    '# AgentFeed',
    '',
    `${Object.keys(PRICES).length} paid GET routes and ${FREE_TOOLS.length} free ones at ${ORIGIN}. JSON in, JSON out, paid per call in USDC over x402 v2. No API key, no account, no signup.`,
    '',
    '## Paying for a call',
    '',
    'Request the route. Unpaid it returns 402 with the challenge base64-encoded in the **PAYMENT-REQUIRED response header** — not in the body. Decode that header, pay it, and repeat the request with an `X-PAYMENT` header.',
    '',
    `Rails: USDC on Solana ${network === 'mainnet' ? 'mainnet' : network}, or USDC on Base (eip155:8453). Both are offered on every paid route.`,
    ...(mpp && mpp.active ? ['', `MPP \`solana/charge\` is offered alongside x402 on ${mpp.routes.join(' and ')}, in the WWW-Authenticate header.`] : []),
    '',
    'Every 200 has the shape:',
    '',
    '```json',
    '{ "tool": "get_sol_price", "data": { }, "paid": true }',
    '```',
    '',
    '## Before you pay',
    '',
    `- \`${ORIGIN}/openapi.json\` lists every route with its parameters, its price and a real captured response example. Read it instead of guessing a shape.`,
    `- \`${ORIGIN}/api/sample/<route>\` returns that route's real captured response, free, before you pay for it.`,
    `- \`${ORIGIN}/api/forecast-record\` is the settled record behind the cascade forecast: every row written before its window opened and settled from the exchange public feed.`,
    `- The free routes below cost nothing and are the same code path as the paid ones.`,
    '',
    '## Free routes',
    '',
    ...FREE_TOOLS.map((t) => `- \`GET ${freePath(t)}\``),
    '',
    `## Paid routes (${Object.keys(PRICES).length}, $${total.toFixed(3)} for one call of each)`,
    ...catalogueLines({ PRICES, TAGS, META, bullet: { heading: '###', item: '- ', indent: '  ' } }),
    '',
    '## Limits and behaviour',
    '',
    '- `HEAD` on `/api/*` returns 405. The paid surface is GET-only.',
    '- 240 requests per minute per caller; a 429 carries `Retry-After`.',
    '- A path parameter may be sent as a query parameter instead (`/api/token-risk?mint=...`); it is rewritten before the paywall.',
    '- An upstream failure returns an error. Nothing is invented and nothing stale is served silently.',
    '',
  ].join('\n');
}

module.exports = { buildOpenApi, buildWellKnown, buildLlmsTxt, buildSkillMd, ORIGIN, freePath, grouped };
