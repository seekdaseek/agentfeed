// lib/discovery-r34.js: three static discovery documents crawlers asked for and got a 404 on (R34, 14 Nov 2026; calls table, status not_found, 7 days to 14 Nov).
//
//   /llms-full.txt                    llms.txt (the same text, so the two cannot disagree) plus the route catalog: every route, its price, its tool name and an example URL
//   /apis.json                        APIs.json 0.14 (apisjson.org): one API, its base URL, a Swagger/OpenAPI property pointing at /openapi.json
//   /.well-known/x402-payto.json      the payTo address per network, taken from the same accept entries the 402 challenges and /.well-known/x402.json carry
//
// All plain data derived from PRICES, routeUrls and the payment layer; no secret, no personal information (no e-mail address, no contact field). Not published, on purpose, because no
// published specification we could meet exists or it asks for data we will not give: /.well-known/did.json (a DID document needs a signing key; none exists for this service),
// /.well-known/x402.sig (no published specification found), /.well-known/owners.json (VerifyMCP's format is a list of owner e-mail addresses).
'use strict';

function buildLlmsFull({ llms, PRICES, routeUrls, ORIGIN }) {
  const rows = Object.entries(PRICES).map(([pattern, p]) => ({ pattern, p }))
    .sort((a, b) => a.p.usd - b.p.usd || String(a.p.tool).localeCompare(String(b.p.tool)));
  const lines = [
    String(llms).replace(/\s+$/, ''),
    '',
    '## Route catalog',
    '',
    `${rows.length} priced routes, cheapest first. Prices are USD per call, paid in USDC; the live 402 challenge of each route is the authority. Catalog with parameters: ${ORIGIN}/openapi.json`,
    '',
  ];
  for (const { pattern, p } of rows) {
    const templated = routeUrls.isTemplated(pattern);
    lines.push(`### GET ${templated ? routeUrls.template(pattern) : pattern.replace(/^GET /, '')}`);
    lines.push(`- tool: ${p.tool}`);
    lines.push(`- price: $${p.usd} per call`);
    lines.push(`- example: ${routeUrls.concrete(pattern)}${templated ? ' (a placeholder value: the path parameter is yours to replace)' : ''}`);
    lines.push(`- what it answers: ${String(p.desc || '').replace(/\s+/g, ' ').trim()}`);
    lines.push('');
  }
  return lines.join('\n');
}

function buildApisJson({ ORIGIN, version, now = Date.now }) {
  const day = new Date(now()).toISOString().slice(0, 10);
  return {
    name: 'AgentFeed',
    description: require('../tools/scope').SCOPE_SHORT,
    url: `${ORIGIN}/apis.json`,
    specificationVersion: '0.14',
    created: '2026-11-14',
    modified: day,
    tags: ['crypto', 'market-data', 'x402', 'mcp', 'solana', 'ai-agents'],
    apis: [{
      name: 'AgentFeed API',
      description: require('../tools/scope').SCOPE_SHORT,
      image: `${ORIGIN}/icon.png`,
      humanURL: `${ORIGIN}/`,
      baseURL: ORIGIN,
      version,
      tags: ['x402', 'paid-per-call', 'usdc'],
      properties: [
        { type: 'Swagger', url: `${ORIGIN}/openapi.json` },
        { type: 'x-x402-manifest', url: `${ORIGIN}/.well-known/x402.json` },
        { type: 'x-llms-txt', url: `${ORIGIN}/llms.txt` },
        { type: 'x-mcp', url: `${ORIGIN}/mcp` },
        { type: 'Pricing', url: `${ORIGIN}/pricing` },
        { type: 'TermsOfService', url: `${ORIGIN}/terms` },
      ],
    }],
  };
}

/** accepts: Map(route pattern -> accept entries[]) as lib/manifest.js builds it. One row per (network, payTo, asset, scheme), in first-seen order. */
function buildPayTo({ ORIGIN, accepts }) {
  const seen = new Map();
  for (const list of accepts.values()) {
    for (const a of list || []) {
      if (!a || !a.network || !a.payTo) continue;
      const k = `${a.scheme}|${a.network}|${String(a.payTo).toLowerCase()}|${String(a.asset).toLowerCase()}`;
      if (!seen.has(k)) seen.set(k, { network: a.network, scheme: a.scheme || 'exact', payTo: a.payTo, asset: a.asset || null });
    }
  }
  return {
    service: 'agentfeed',
    origin: ORIGIN,
    note: 'The payTo of every network offered in a 402 challenge from this service. The live 402 is authoritative; this lists the same addresses, one row per network.',
    payTo: [...seen.values()],
  };
}

function mountDiscoveryR34(app, { docs, PRICES, routeUrls, ORIGIN, version, manifestAccepts }) {
  const doc = (res) => res.set('Cache-Control', 'no-cache');
  app.get('/llms-full.txt', (_req, res) => doc(res).type('text/plain; charset=utf-8').send(buildLlmsFull({ llms: docs().llms, PRICES, routeUrls, ORIGIN })));
  app.get('/apis.json', (_req, res) => doc(res).json(buildApisJson({ ORIGIN, version })));
  app.get('/.well-known/x402-payto.json', async (_req, res) => {
    let acc;
    try { acc = await manifestAccepts(); } catch { return res.set('Retry-After', '30').status(503).json({ error: 'catalog not ready yet', retry_after: 30 }); }
    return doc(res).json(buildPayTo({ ORIGIN, accepts: acc }));
  });
}

module.exports = { mountDiscoveryR34, buildLlmsFull, buildApisJson, buildPayTo };
