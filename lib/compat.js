// lib/compat.js — answers for what the 404 log showed clients asking for (R2, 2026-10-11).
//
//   stripNetworkSuffix  /api/<route>|eip155:<id> or |solana:<id> (raw or %7C) is served as
//                       /api/<route>; a crawler asked for ~55 of these in two minutes. url
//                       AND originalUrl are rewritten, so the challenge's resource URL is the
//                       clean one; the original stays on req.x402OriginalPath for the rows.
//   mcpGet405           GET /mcp: MCP Streamable HTTP says a server with no GET stream
//                       answers 405 (Allow: POST). POST /mcp is unchanged.
//   makeDiscovery       the CDP Bazaar discovery response shape ({x402Version, items,
//                       pagination}) at the paths crawlers probe, built from the payment
//                       layer's own route configs and requirements: the same source as
//                       /.well-known/x402.json and every 402.
//   makeAgentCard       an A2A agent card: skills = the paid tools, x402 pointer.
//   sharpMoveGone       /api/sharp-move was removed Aug 19: 410 with the closest live routes.
//   makeWithdrawn       routes withdrawn on 2026-10-12 over source terms: a short neutral 410.

const NET_SUFFIX = /^(\/api\/[^?]*?)(?:\||%7[cC])(?:eip155:\d+|solana:[A-Za-z0-9]{1,64})$/;

function stripNetworkSuffix(req, _res, next) {
  const q = req.url.indexOf('?');
  const path = q < 0 ? req.url : req.url.slice(0, q);
  const m = NET_SUFFIX.exec(path);
  if (m) {
    req.x402OriginalPath = path;
    req.url = m[1] + (q < 0 ? '' : req.url.slice(q));
    req.originalUrl = String(req.originalUrl).replace(path, m[1]);
  }
  next();
}

function mcpGet405(_req, res) {
  res.set('Allow', 'POST').status(405).json({ error: 'GET /mcp is not supported: this MCP server offers no SSE stream. Use POST /mcp (Streamable HTTP).' });
}

const DISCOVERY_PATHS = ['/discovery/resources', '/x402/discovery/resources', '/v1/x402/discovery/resources', '/v2/x402/discovery/resources', '/.well-known/x402/discovery/resources'];

/** deps: getLayer() -> payments.js layer {routes, resourceServer} or null; concreteUrl(pattern) */
function makeDiscovery({ getLayer, concreteUrl }) {
  let cache = null;
  const lastUpdated = new Date().toISOString();
  async function build() {
    const layer = getLayer();
    if (!layer) throw new Error('payment layer not built');
    const items = [];
    for (const [pattern, rc] of Object.entries(layer.routes)) {
      const accepts = [];
      for (const a of rc.accepts) {
        const [r] = await layer.resourceServer.buildPaymentRequirements(a);
        if (r) accepts.push(r);
      }
      items.push({
        resource: concreteUrl(pattern), type: 'http', x402Version: 2, accepts,
        description: rc.description, serviceName: rc.serviceName, tags: rc.tags, iconUrl: rc.iconUrl,
        mimeType: rc.mimeType, extensions: rc.extensions, lastUpdated,
      });
    }
    return items;
  }
  return async function discovery(req, res) {
    try {
      if (!cache) cache = await build();
    } catch {
      return res.set('Retry-After', '30').status(503).json({ error: 'catalog not ready yet', retry_after: 30 });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    res.json({ x402Version: 2, items: cache.slice(offset, offset + limit), pagination: { limit, offset, total: cache.length } });
  };
}

/** deps: PRICES, TAGS, TITLES, questionFor, version, ORIGIN, rails (names), mpp ({active, routes}) */
function makeAgentCard({ PRICES, TAGS, TITLES, questionFor, version, ORIGIN, railNames, mpp, tempo, routeUrls }) {
  const urlOf = (pattern) => (routeUrls ? routeUrls.concrete(pattern) : `${ORIGIN}${pattern.replace(/^GET /, '')}`);
  return function agentCard(_req, res) {
    res.json({
      protocolVersion: '0.3.0',
      name: 'AgentFeed',
      description: `${require('../tools/scope').SCOPE} Each skill is a paid HTTP GET (x402, USDC on ${railNames()}); this is not an A2A message endpoint. Full catalog with prices: ${ORIGIN}/.well-known/x402.json`,
      url: ORIGIN,
      preferredTransport: 'HTTP+JSON',
      version,
      provider: { organization: 'ochinimus', url: 'https://ochinimus.app' },
      documentationUrl: `${ORIGIN}/llms.txt`,
      iconUrl: `${ORIGIN}/icon.png`,
      capabilities: {
        streaming: false, pushNotifications: false,
        extensions: [{
          uri: 'https://x402.org',
          description: 'Every skill is paid per call over x402: GET the route, read the 402 challenge (PAYMENT-REQUIRED header, v2; the JSON body is the v1 challenge), pay and repeat.',
          required: true,
          params: { discovery: `${ORIGIN}/.well-known/x402.json`, openapi: `${ORIGIN}/openapi.json`, mcp: `${ORIGIN}/mcp`, mpp: mpp && mpp.active ? mpp.routes : [], mpp_tempo: !!(tempo && tempo.active) },
        }],
      },
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      skills: Object.entries(PRICES).map(([pattern, p]) => ({
        id: p.tool,
        name: TITLES[p.tool] || p.tool,
        description: `${p.desc} Price: $${p.usd} per call. GET ${urlOf(pattern)}${routeUrls && routeUrls.isTemplated(pattern) ? ` (an example: replace ${routeUrls.names(pattern).map((n) => `{${n}}`).join(', ')} with your own value)` : ''}`,
        tags: TAGS[p.tool] || [],
        examples: [questionFor(p.tool)].filter(Boolean),
      })),
    });
  };
}

const SHARP_MOVE_CLOSEST = ['GET /api/oi-spike-scan', 'GET /api/funding-radar', 'GET /api/cascade-scan', 'GET /api/top-movers'];
function makeSharpMoveGone({ PRICES, ORIGIN }) {
  return function sharpMoveGone(_req, res) {
    res.status(410).json({
      error: 'gone',
      route: '/api/sharp-move',
      removed: '2026-08-19',
      was: 'get_sharp_move: a World Cup betting sharp-money detector. AgentFeed no longer sells sports odds.',
      closest_live: SHARP_MOVE_CLOSEST.filter((k) => PRICES[k]).map((k) => ({
        route: `${ORIGIN}${k.replace(/^GET /, '')}`, tool: PRICES[k].tool, price_usd: PRICES[k].usd,
        what: String(PRICES[k].desc).split(/(?<=\.)\s/)[0].slice(0, 200),
      })),
    });
  };
}

// Paid routes are GET-only. Any other verb on a priced path used to fall through to
// Express's HTML "Cannot POST" 404, which a directory probing the verb a catalogue declared
// (10x402: POST for /api/equity-24h) recorded as "no challenge". Now: 405, Allow: GET, JSON.
function makeGetOnly({ PRICES }) {
  const priced = require('./canon-path').pricedMatcher(Object.keys(PRICES));   // any spelling x402 routes to a priced route (R19a)
  return function getOnly(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (!priced.test(req.path)) return next();
    res.set('Allow', 'GET').status(405).json({ error: `${req.method} is not supported on ${req.path}: paid routes are GET. GET it unpaid for the 402 challenge.`, allow: 'GET' });
  };
}

// /pricing and /terms: x402-list counts both as site signals; both were 404.
function makePricing({ PRICES, FREE_TOOLS, ORIGIN, railNames, mpp, tempo, routeUrls }) {
  return function pricing(req, res) {
    const routes = Object.entries(PRICES).map(([k, p]) => ({ route: routeUrls ? routeUrls.concrete(k) : `${ORIGIN}${k.replace(/^GET /, '')}`, ...(routeUrls && routeUrls.isTemplated(k) ? { route_template: routeUrls.templateUrl(k) } : {}), tool: p.tool, price_usd: p.usd })).sort((x, y) => x.price_usd - y.price_usd || x.tool.localeCompare(y.tool));
    const body = {
      service: 'AgentFeed', currency: 'USDC', billing: 'per call, x402 (no subscription; no API key needed, prepaid keys optional)', rails: require('./rails').httpRailNames(),
      rails_on_request: require('./rails').onRequestRails().map((r) => ({ network: r.network, name: r.name, token: r.symbol, ...(r.minUsd ? { min_route_price_usd: r.minUsd } : {}), ask: `GET /api/<route>|${r.network}` })),
      high_frequency: require('./hf').hfSentence().trim() || null,
      mpp_routes: mpp && mpp.active ? mpp.routes : [],
      mpp_tempo: tempo && tempo.active ? 'tempo/charge on every paid route: Tempo mainnet (chain 4217), OUSD or USDC.e, pull mode' : null,
      note: 'The live 402 challenge of each route is authoritative. A response with status 400 or more is never settled, so a failed call is not charged.',
      paid: routes, free: (FREE_TOOLS || []).map((t) => t),
      machine_readable: { manifest: `${ORIGIN}/.well-known/x402.json`, openapi: `${ORIGIN}/openapi.json` },
    };
    if (!/text\/html/.test(String(req.headers.accept || ''))) return res.json(body);
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>AgentFeed pricing</title><h1>AgentFeed pricing</h1><p>${esc(body.billing)}. USDC on ${esc(body.rails)}. ${esc(body.note)}</p><table border="1" cellpadding="4"><tr><th>tool</th><th>price (USD)</th><th>route</th></tr>${routes.map((r) => `<tr><td>${esc(r.tool)}</td><td>${r.price_usd}</td><td>${esc(r.route)}</td></tr>`).join('')}</table><p>Free: ${esc(body.free.join(', '))}. Machine-readable: <a href="${esc(body.machine_readable.manifest)}">x402 manifest</a>, <a href="${esc(body.machine_readable.openapi)}">OpenAPI</a>.</p>`);
  };
}

const TERMS = `AgentFeed terms of use (x402.ochinimus.app). Last updated 2026-10-14.

1. Service. AgentFeed is a read-only crypto market-data API. Paid routes are paid per call in USDC over x402, or over MPP (tempo/charge on every paid route, solana/charge on /api/sol-price and /api/btc-price). There are no accounts; no API key is needed to pay per call. A client that cannot pay x402 may instead buy a prepaid key (see /keys and /api/keys/buy-*): the key is a bearer secret, anyone holding it spends its balance, and abuse of it means revocation.
2. Payment. Each paid call is settled once, for the price in its 402 challenge. A response with status 400 or more is never settled, so a failed call is not charged. A settled payment is final. A prepaid balance is usage credit: non-refundable, with no expiry; each call made with a key draws half the route's x402 price (minimum $0.0005), and a call that fails (status 400 or more) is not drawn. A bot pass (/api/keys/buy-pass) is different: a flat price, non-refundable, valid for 30 days from the moment its payment settles, good only on /api/liq-feed, with nothing drawn per call, and it cannot be topped up. The day pass (/api/keys/buy-day-pass) is the same for 24 hours at $1, good only on /api/liq-feed and /api/liquidations, each one call every 10 seconds per key.
3. Data. Data is provided as is, for information only. It is not financial, investment or trading advice. There is no warranty of accuracy, completeness or availability; each response states its sources and age.
4. Use. Do not attack or overload the service. Rate limits apply: 240 GET requests per minute per IP, and 120 per minute per prepaid key unless raised.
5. Records. Per request we log the route, status, IP address and user agent, and for a settled payment the payer address and transaction. These records are used to run and account for the service. No other personal data is collected.
6. Changes. Prices and routes can change; the live 402 challenge is authoritative.

Contact: ochinimus@gmail.com
`;
function termsHandler(_req, res) { res.type('text/plain').send(TERMS); }

// Withdrawn because an upstream's terms do not allow reselling its data
// (docs/SOURCES.md). Any method answers 410, never charged; the route is in no
// manifest, catalogue or tool list any more. WITHDRAWN_INFO carries the date and, where one exists, the live
// routes that come closest to what the withdrawn one answered.
//   2026-10-12  tvl, stablecoin-flows, launch-odds, rwa-yields, dex-quote
//   2026-10-13  long-short, whale-trades, options-summary, options-gex (their sources forbid resale or derived
//               data), funding-cross, spread-arb (cross-venue products, and one clean venue is left)
const WITHDRAWN_INFO = {
  '/api/tvl': { withdrawn: '2026-10-12' },
  '/api/stablecoin-flows': { withdrawn: '2026-10-12' },
  '/api/launch-odds': { withdrawn: '2026-10-12' },
  '/api/rwa-yields': { withdrawn: '2026-10-12' },
  '/api/dex-quote': { withdrawn: '2026-10-12' },
  '/api/long-short': { withdrawn: '2026-10-13', closest_live: ['/api/hl-whales', '/api/liquidations'] },
  '/api/whale-trades': { withdrawn: '2026-10-13', closest_live: ['/api/hl-whales', '/api/liquidations'] },
  '/api/options-summary': { withdrawn: '2026-10-13', closest_live: ['/api/volatility'] },
  '/api/options-gex': { withdrawn: '2026-10-13', closest_live: ['/api/volatility'] },
  '/api/funding-cross': { withdrawn: '2026-10-13', closest_live: ['/api/funding-radar'] },
  '/api/spread-arb': { withdrawn: '2026-10-13', closest_live: ['/api/basis'] },
};
const WITHDRAWN = Object.keys(WITHDRAWN_INFO);
function makeWithdrawn({ ORIGIN }) {
  return function withdrawn(req, res) {
    const i = WITHDRAWN_INFO[req.path] || { withdrawn: '2026-10-12' };
    res.status(410).json({ error: 'gone', status: 'withdrawn', route: req.path, withdrawn: i.withdrawn, ...(i.closest_live ? { closest_live: i.closest_live } : {}), pricing: `${ORIGIN}/pricing` });
  };
}

// ---- R10 F8: the discovery files crawlers asked for and got 404 (calls table, Oct 13 00:00 UTC to Oct 14):
// /robots.txt 156 hits from 106 IPs, /.well-known/agent.json 24 from 11, /sitemap.xml 18,
// /.well-known/mcp/server-card.json 10, /.well-known/mcp.json 4.
const ORIGIN_ = 'https://x402.ochinimus.app';
// Allow everything. The Sitemap line is the robots.txt standard (RFC 9309 leaves other keys to crawlers); the machine-readable
// documents are named in comments, where a crawler that reads robots.txt for hints finds them. Cloudflare's managed robots.txt
// prepends its content-signal block to this at the edge.
// R17: Content-Signal (contentsignals.org, inside the User-agent group): the catalogue is meant to be read, quoted and trained on. Agentmap is the
// robots.txt directive of the ARD spec (ards-project/ard-spec v0.91 s5.1) that names the entry source.
const ROBOTS = `User-agent: *
Content-Signal: search=yes, ai-input=yes, ai-train=yes
Allow: /

# AgentFeed: paid crypto market-data API for AI agents (x402, MPP). Machine-readable:
# ${ORIGIN_}/llms.txt
# ${ORIGIN_}/openapi.json
# ${ORIGIN_}/.well-known/x402.json
# ${ORIGIN_}/sitemap.xml
Sitemap: ${ORIGIN_}/sitemap.xml
Agentmap: ${ORIGIN_}/.well-known/ard.json
`;
// R18: no-cache + the ETag Express adds, like the other discovery documents. It was `public, max-age=3600`; Cloudflare cached the file at each edge
// (HIT) and kept serving the pre-R17 copy for 35 minutes after R17 went live (and showed browsers max-age=14400).
function robotsTxt(_req, res) { res.type('text/plain; charset=utf-8').set('Cache-Control', 'no-cache').send(ROBOTS); }

// The public pages: landing, /keys, /pricing, /terms, /llms.txt, /openapi.json.
const SITEMAP_PATHS = ['/', '/keys', '/pricing', '/terms', '/llms.txt', '/openapi.json'];
const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${SITEMAP_PATHS.map((p) => `  <url><loc>${ORIGIN_}${p}</loc></url>`).join('\n')}
</urlset>
`;
function sitemapXml(_req, res) { res.type('application/xml; charset=utf-8').set('Cache-Control', 'public, max-age=3600').send(SITEMAP); }

// MCP Server Card (SEP-2127, Final; the schema is modelcontextprotocol/experimental-ext-server-card schema.ts, read
// 2026-10-14). Built from server.json, the MCP Registry record: name, title, version, websiteUrl, repository, remotes.
// The spec caps description at 100 characters (server.json's is shorter) and reserves <streamable-http-url>/server-card,
// so the card is served there and at the two .well-known paths crawlers asked for. No tools: the spec leaves primitives
// to tools/list.
const MCP_CARD_PATHS = ['/mcp/server-card', '/.well-known/mcp/server-card.json', '/.well-known/mcp.json'];
const CARD_TYPE = 'application/mcp-server-card+json';
function makeMcpServerCard({ serverJson, protocolVersions }) {
  const sj = serverJson || {};
  const cut = (t, n) => (String(t).length <= n ? String(t) : String(t).slice(0, n - 1).replace(/\s+\S*$/, '') + '\u2026');
  const card = {
    $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    name: sj.name || 'io.github.seekdaseek/agentfeed',
    version: sj.version || '1.0.0',
    description: cut(sj.description || 'Paid crypto market-data API for AI agents.', 100),
    ...(sj.title ? { title: sj.title } : {}),
    websiteUrl: sj.websiteUrl || ORIGIN_,
    ...(sj.repository ? { repository: sj.repository } : {}),
    icons: [{ src: `${ORIGIN_}/icon.png`, mimeType: 'image/png', sizes: ['256x256'] }],
    remotes: (sj.remotes && sj.remotes.length ? sj.remotes : [{ type: 'streamable-http', url: `${ORIGIN_}/mcp` }]).map((r) => ({
      type: r.type,
      url: r.url,
      // optional: free tools need nothing, paid tools answer with an x402 payment request; a prepaid key pays them instead
      headers: [{ name: 'X-AgentFeed-Key', description: 'Optional prepaid key (afk_...) for clients that cannot pay x402; buy one at ' + ORIGIN_ + '/keys', isRequired: false, isSecret: true }],
      supportedProtocolVersions: [...(protocolVersions || [])],
    })),
  };
  return function mcpServerCard(req, res) {
    const wantsCard = String(req.headers.accept || '').includes(CARD_TYPE);
    res.set('Access-Control-Allow-Origin', '*').set('Cache-Control', 'public, max-age=3600');
    res.type(wantsCard ? CARD_TYPE : 'application/json').send(JSON.stringify(card));
  };
}

// AI Catalog (/.well-known/ai-catalog.json, the predecessor path of ARD's /.well-known/ard.json): since R17 the full ARD manifest (lib/agent-ready.js),
// four entries (MCP server card, OpenAPI, A2A agent card, llms.txt) with a host object, representativeQueries and the schema-required fields. It was
// served with entry 0 missing displayName, which the Agent Readiness scan reported as invalid. no-cache + ETag, CORS open.
function makeAiCatalog({ ORIGIN }) {
  const body = JSON.stringify(require('./agent-ready').buildArdCatalog({ ORIGIN }));
  return function aiCatalog(_req, res) {
    res.set('Access-Control-Allow-Origin', '*').set('Cache-Control', 'no-cache').type('application/ai-catalog+json').send(body);
  };
}

module.exports = { WITHDRAWN, WITHDRAWN_INFO, makeWithdrawn, stripNetworkSuffix, mcpGet405, DISCOVERY_PATHS, makeDiscovery, makeAgentCard, makeSharpMoveGone, makeGetOnly, makePricing, termsHandler, NET_SUFFIX, robotsTxt, sitemapXml, ROBOTS, SITEMAP_PATHS, makeMcpServerCard, MCP_CARD_PATHS, makeAiCatalog };
