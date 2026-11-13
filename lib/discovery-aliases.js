// lib/discovery-aliases.js — the discovery paths crawlers ask for and used to get a 404 on (R15b, 19 Oct 2026).
//
// Measured in the audit table, status not_found, the 72 hours to 19 Oct 01:00Z: /.well-known/agent-registration.json 36 (TaifoonHarvester),
// /.well-known/x402-services.json 12 (mpp32-indexer), /api 9 (x402-network-mapper, AgentIndexBot) and 16 more over 30 days as /api/,
// /x402-resources 7 (axios), /swagger.json 6, /.well-known/ai-plugin.json 6, /.well-known/agents.json 5, /x402 5, /.well-known/x402-resources 4
// (axios), /.well-known/security.txt 3. Each is served from a document this service already builds, or is a few lines of plain data:
//
//   /x402-resources, /.well-known/x402-resources, /.well-known/x402-services.json, /x402   the /.well-known/x402 resource list
//   /swagger.json                                                                            openapi.json
//   /api, /api/                      a small JSON index: name, scope, links, the ten trading-loop routes with their prices
//   /.well-known/ai-plugin.json      the legacy plugin manifest (auth none, api -> openapi.json)
//   /.well-known/agents.json         agents.json 0.1.0 (wild-card-ai/agents-json), one source: openapi.json, no flows
//   /.well-known/agent-registration.json   an ERC-8004 registration file with no on-chain registration yet
//   /.well-known/security.txt        RFC 9116 (Expires = process start + 364 days)
//
// Left as they are, on purpose: /.well-known/oauth-* (a 404 is the correct answer for a /mcp without OAuth), /telegraph/api/* (removed
// 19 Sep), the facilitator paths /supported, /x402/supported, /api/supported, /facilitator/supported (we are not a facilitator), the
// fuzz noise, and did.json, ard.json, x402.sig and owners.json (no specification we meet).
//
// All of these are in lib/ratelimit.js' 'docs' bucket (120 a minute per address), never in the 240 that data routes share. Every value
// below is plain data: no imperative wording, because the CDP index screens published text for instructions.
'use strict';

const { SCOPE, SCOPE_SHORT } = require('../tools/scope');

// R15d: the five documents server.js serves itself change with every deploy as well; they get the same `no-cache` (the ETag Express adds keeps a
// revalidation a 304). One middleware, mounted by server.js ahead of their routes: /.well-known/x402.json is registered much further down.
const NO_CACHE_DOC_PATHS = ['/openapi.json', '/.well-known/x402', '/.well-known/x402.json', '/llms.txt', '/SKILL.md'];
const docNoCache = (_req, res, next) => { res.set('Cache-Control', 'no-cache'); next(); };

const WELLKNOWN_ALIASES = ['/x402-resources', '/.well-known/x402-resources', '/.well-known/x402-services.json', '/x402'];

// the ten routes a trading loop polls, in the order of the question they answer: the one-call market bundle (R15c: the best seller of these,
// in place of /api/price), the perp, what is being liquidated, funding, the liquidation feed and tape, the signal table and one coin's
// signal, cascades, positioning. Prices are read from the price table.
const TRADING_LOOP = [
  'GET /api/market-state', 'GET /api/perp', 'GET /api/liq-pulse', 'GET /api/funding-pulse', 'GET /api/liq-feed',
  'GET /api/liquidations', 'GET /api/signal-board', 'GET /api/coin-signal/:coin', 'GET /api/cascade', 'GET /api/positioning',
];

const MCP_PROTOCOL = '2025-06-18';   // what POST /mcp negotiates for a client that asks for it (measured 18 Oct 2026)
const A2A_PROTOCOL = '0.3.0';        // protocolVersion of /.well-known/agent-card.json (lib/compat.js makeAgentCard)
const ERC8004_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
const SECURITY_CONTACT = 'https://github.com/seekdaseek/agentfeed/security';
// RFC 9116 wants an Expires and asks for less than a year ahead. R15c: it is computed when the process starts, as the start time plus 364 days
// (whole seconds, UTC), so the file is never stale and never more than a year out. It moves at each restart.
const SECURITY_TTL_DAYS = 364;
const expiresFor = (startedAt) => new Date(Math.floor(startedAt / 1000) * 1000 + SECURITY_TTL_DAYS * 86_400_000).toISOString().replace('.000Z', 'Z');

const pathOf = (route) => route.replace(/^GET /, '').replace(/:([A-Za-z0-9_]+)/g, '{$1}');

function buildApiIndex({ PRICES, ORIGIN }) {
  const trading = TRADING_LOOP.filter((r) => PRICES[r]).map((r) => ({ path: pathOf(r), tool: PRICES[r].tool, price_usd: PRICES[r].usd }));
  return {
    name: 'AgentFeed',
    scope: SCOPE_SHORT,
    links: {
      manifest: `${ORIGIN}/.well-known/x402.json`,
      resources: `${ORIGIN}/.well-known/x402`,
      openapi: `${ORIGIN}/openapi.json`,
      llms_txt: `${ORIGIN}/llms.txt`,
      skill_md: `${ORIGIN}/SKILL.md`,
      mcp: `${ORIGIN}/mcp`,
      keys: `${ORIGIN}/keys`,
      status: `${ORIGIN}/api/status`,
    },
    trading_loop: trading,
  };
}

function buildAiPlugin({ ORIGIN }) {
  // The legacy schema also has a contact_email field; no address is published here, so the field is left out.
  return {
    schema_version: 'v1',
    name_for_human: 'AgentFeed',
    name_for_model: 'agentfeed',
    description_for_human: 'Crypto market data and checks for AI agents, paid per call in USDC over x402.',
    description_for_model: `${SCOPE_SHORT} Every route is a GET that returns JSON. Paid routes answer 402 with an x402 challenge and take USDC per call. Routes, parameters and prices are in the OpenAPI document.`,
    auth: { type: 'none' },
    api: { type: 'openapi', url: `${ORIGIN}/openapi.json` },
    logo_url: `${ORIGIN}/icon.png`,
    legal_info_url: `${ORIGIN}/terms`,
  };
}

function buildAgentsJson({ ORIGIN, version }) {
  return {
    agentsJson: '0.1.0',
    info: { title: 'AgentFeed', version, description: SCOPE_SHORT },
    sources: [{ id: 'agentfeed', path: `${ORIGIN}/openapi.json` }],
    flows: [],
  };
}

function buildAgentRegistration({ ORIGIN }) {
  return {
    type: ERC8004_TYPE,
    name: 'AgentFeed',
    description: SCOPE,
    image: `${ORIGIN}/icon.png`,
    services: [
      { name: 'web', endpoint: `${ORIGIN}/` },
      { name: 'MCP', endpoint: `${ORIGIN}/mcp`, version: MCP_PROTOCOL },
      { name: 'A2A', endpoint: `${ORIGIN}/.well-known/agent-card.json`, version: A2A_PROTOCOL },
      { name: 'x402', endpoint: `${ORIGIN}/.well-known/x402.json` },
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: [],
  };
}

const buildSecurityTxt = ({ ORIGIN, startedAt = Date.now() }) => [
  `Contact: ${SECURITY_CONTACT}`,
  `Expires: ${expiresFor(startedAt)}`,
  `Canonical: ${ORIGIN}/.well-known/security.txt`,
  '',
].join('\n');

/**
 * Mount every alias on `app`. deps: docs() -> { openapi, wellKnown } (server.js builds them once), PRICES, ORIGIN, version.
 * Static documents are built per request from constants: they are a few hundred bytes.
 */
function mountDiscoveryAliases(app, { docs, PRICES, ORIGIN, version, startedAt = Date.now() }) {
  // R15d: these documents change with every deploy (the /api trading loop, the resource list, Expires), so they say so: `no-cache` makes any
  // HTTP cache revalidate (the ETag makes that a 304 when nothing changed). 19 Oct 2026, 06:25Z: a client reported the pre-deploy /api
  // 30 minutes after the restart while /api/?cb=<n> was current. Not reproduced: the origin and Cloudflare (cf-cache-status DYNAMIC, one tunnel
  // connector) served the new one every time, so a cache on the requester side is the likely holder, which a header can only ask, not force.
  const doc = (res) => res.set('Cache-Control', 'no-cache');
  for (const p of WELLKNOWN_ALIASES) app.get(p, (_req, res) => doc(res).json(docs().wellKnown));
  app.get('/swagger.json', (_req, res) => doc(res).json(docs().openapi));
  // R17: RFC 8288 Link header (api-catalog, service-desc, service-doc), the same one GET / sends
  const link = require('./agent-ready').linkHeader(ORIGIN);
  app.get(['/api', '/api/'], (_req, res) => doc(res).set('Link', link).json(buildApiIndex({ PRICES, ORIGIN })));
  app.get('/.well-known/ai-plugin.json', (_req, res) => doc(res).json(buildAiPlugin({ ORIGIN })));
  app.get('/.well-known/agents.json', (_req, res) => doc(res).json(buildAgentsJson({ ORIGIN, version })));
  app.get('/.well-known/agent-registration.json', (_req, res) => doc(res).json(buildAgentRegistration({ ORIGIN })));
  app.get('/.well-known/security.txt', (_req, res) => doc(res).type('text/plain; charset=utf-8').send(buildSecurityTxt({ ORIGIN, startedAt })));
}

module.exports = {
  mountDiscoveryAliases, buildApiIndex, buildAiPlugin, buildAgentsJson, buildAgentRegistration, buildSecurityTxt,
  NO_CACHE_DOC_PATHS, docNoCache, WELLKNOWN_ALIASES, TRADING_LOOP, MCP_PROTOCOL, A2A_PROTOCOL, ERC8004_TYPE, SECURITY_CONTACT, SECURITY_TTL_DAYS, expiresFor, pathOf,
};
