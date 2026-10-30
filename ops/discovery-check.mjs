#!/usr/bin/env node
// ops/discovery-check.mjs <base-url> [--against <other-url>] — R15b: the new discovery paths answer, the paths left alone still 404,
// the three free routes carry `related`, and (with --against) no paid route changed: the manifest of <base-url> and <other-url> agree on
// every route's price and accepts. Read-only GETs; nothing is paid. Exit 0 only if everything holds.
//
//   node ops/discovery-check.mjs http://127.0.0.1:3998 --against https://x402.ochinimus.app     the staged server against live
//   node ops/discovery-check.mjs https://x402.ochinimus.app                                      live, after the deploy
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { robotsVerdict } from './fresh-verdict.mjs';
// the route and tool counts are what this checkout's own PRICES and TOOL_DEFS say (R22), not literals: run it where the checkout can load (the box: `cd /opt/agentfeed && node --env-file=.env ops/discovery-check.mjs <url>`)
const want = createRequire(import.meta.url)('./discovery-expect.cjs').loadExpected();
const ORIGIN_OF = (base) => (base.startsWith('http://') ? 'https://x402.ochinimus.app' : base);   // the documents name the public origin, also when read from a local server

const BASE = (process.argv[2] || '').replace(/\/$/, '');
if (!/^https?:\/\//.test(BASE)) { console.error('usage: node ops/discovery-check.mjs <base-url> [--against <other-url>]'); process.exit(2); }
const i = process.argv.indexOf('--against');
const OTHER = i > 0 ? process.argv[i + 1].replace(/\/$/, '') : null;
// a distinct address per run, so a rate bucket of an earlier check cannot answer 429 here (the server reads CF-Connecting-IP)
const IP = `198.51.100.${1 + (crypto.randomBytes(1)[0] % 250)}`;
const HDR = { 'cf-connecting-ip': IP };   // only sent to a local server: Cloudflare answers 403 to a request that carries this header itself
let failed = 0;
let skipped = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) failed++; };
const skip = (msg) => { console.log(`SKIP ${msg}`); skipped++; };
const get = async (base, p) => { const r = await fetch(base + p, { headers: base.startsWith('http://') ? HDR : {} }); const body = await r.text(); return { r, body, type: r.headers.get('content-type') || '' }; };
const json = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

const JSON_PATHS = ['/x402-resources', '/.well-known/x402-resources', '/.well-known/x402-services.json', '/x402', '/swagger.json', '/api', '/api/',
  '/.well-known/ai-plugin.json', '/.well-known/agents.json', '/.well-known/agent-registration.json'];
const bodies = {};
for (const p of JSON_PATHS) {
  const g = await get(BASE, p);
  bodies[p] = json(g.body);
  ok(g.r.status === 200 && /^application\/json/.test(g.type) && bodies[p] !== undefined, `${p}: 200, ${g.type.split(';')[0]}, ${g.body.length} bytes, parses`);
}
const sec = await get(BASE, '/.well-known/security.txt');
ok(sec.r.status === 200 && sec.type === 'text/plain; charset=utf-8' && /^Contact: https:\/\/github\.com\/seekdaseek\/agentfeed\/security\nExpires: \d{4}-\d\d-\d\dT[\d:]+Z\nCanonical: /.test(sec.body), '/.well-known/security.txt: 200, text/plain; charset=utf-8, Contact, Expires, Canonical');

// the aliases are the documents they alias
const wk = await get(BASE, '/.well-known/x402'); const oa = await get(BASE, '/openapi.json');
for (const p of ['/x402-resources', '/.well-known/x402-resources', '/.well-known/x402-services.json', '/x402']) ok(JSON.stringify(bodies[p]) === JSON.stringify(json(wk.body)) && bodies[p] && bodies[p].resources, `${p} equals /.well-known/x402 (${(bodies[p] && bodies[p].resources || []).length} resources)`);
ok(JSON.stringify(bodies['/swagger.json']) === JSON.stringify(json(oa.body)), '/swagger.json equals /openapi.json');
const api = bodies['/api'];
ok(api && api.name === 'AgentFeed' && api.trading_loop && api.trading_loop.length === 10 && Object.keys(api.links).length === 7, '/api: name, 7 links, 10 trading-loop routes');
ok(JSON.stringify(bodies['/api']) === JSON.stringify(bodies['/api/']), '/api/ is the same document');
// R15c: /api/market-state heads the trading loop in place of /api/price; security.txt Expires is process start + 364 days, so it lies between 300 and 364 days ahead of now
ok(api && api.trading_loop[0].path === '/api/market-state' && !api.trading_loop.some((r) => r.path === '/api/price'), '/api: the trading loop starts with /api/market-state and no longer lists /api/price');
const exp = Date.parse((/^Expires: (.+)$/m.exec(sec.body) || [])[1]);
ok(exp > Date.now() + 300 * 86_400_000 && exp <= Date.now() + 364 * 86_400_000 + 60_000, `security.txt Expires ${new Date(exp).toISOString()} is the process start plus 364 days (${((exp - Date.now()) / 86_400_000).toFixed(1)} days ahead)`);

// left alone: these must keep answering 404 (or whatever they answered before), not be turned into documents
for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/supported', '/x402/supported', '/api/supported', '/facilitator/supported',
  '/.well-known/did.json', '/ard.json', '/.well-known/x402.sig', '/owners.json']) {
  const g = await get(BASE, p);
  ok(g.r.status === 404, `${p}: still ${g.r.status} (left alone)`);
}
const tg = await get(BASE, '/telegraph/api/token-risk');
ok(tg.r.status === 404, `/telegraph/api/token-risk: still ${tg.r.status} (removed 19 Sep, left alone)`);

// the free routes carry related
for (const [p, tool, max] of [['/api/fear-greed', 'get_fear_greed', 2], ['/api/last-liquidation', 'get_last_liquidation', 2], ['/api/exit-method', 'get_exit_method', 2]]) {
  const g = await get(BASE, p); const j = json(g.body);
  const rel = j && j.data && j.data.related;
  ok(g.r.status === 200 && j.tool === tool && j.paid === false && Array.isArray(rel) && rel.length >= 1 && rel.length <= max
    && rel.every((x) => JSON.stringify(Object.keys(x)) === '["tool","path","price_usd","adds"]' && typeof x.price_usd === 'number'), `${p}: 200, free, related has ${rel ? rel.length : '-'} item(s) of tool/path/price_usd/adds`);
  if (rel) console.log('     ' + rel.map((x) => `${x.path} $${x.price_usd}`).join(', '));
}
// and a paid route's answer carries none
const mk = await get(BASE, '/api/market-snapshot');
ok(mk.r.status === 402, '/api/market-snapshot (paid) still answers 402');

if (OTHER) {
  // per route: price, name and every accept, with extra.feePayer (the facilitator's signer, which rotates per boot) left out
  const norm = (r) => ({ resource: r.resource, price_usd: r.price_usd, name: r.name, accepts: (r.accepts || []).map((a) => { const { extra, ...rest } = a; const { feePayer, ...ex } = extra || {}; return { ...rest, extra: ex }; }) });
  const fetchManifest = async (base) => { for (let n = 0; n < 4; n++) { const g = await get(base, '/.well-known/x402.json'); const j = json(g.body); if (g.r.status === 200 && j && Array.isArray(j.resources)) return j; await new Promise((r) => setTimeout(r, 1500)); } return null; };
  const a = await fetchManifest(BASE), b = await fetchManifest(OTHER);
  if (!a || !b) ok(false, `no paid route changed: a manifest did not load (${BASE}: ${a ? 'ok' : 'no'}, ${OTHER}: ${b ? 'ok' : 'no'})`);
  else {
    const byUrl = (m) => new Map(m.resources.map((r) => [r.resource, JSON.stringify(norm(r))]));
    const ma = byUrl(a), mb = byUrl(b);
    const diff = [...new Set([...ma.keys(), ...mb.keys()])].filter((u) => ma.get(u) !== mb.get(u));
    ok(diff.length === 0 && ma.size === mb.size, `no paid route changed: ${ma.size} routes against ${mb.size} on ${OTHER}, prices and accepts equal (extra.feePayer ignored)${diff.length ? '; differ: ' + diff.slice(0, 5).join(', ') : ''}`);
  }
}
// R15d: every document that changes with a deploy says no-cache and carries an ETag, and a conditional GET with that ETag is a 304.
// (cache-control: max-age=0 is sent because fetch() otherwise adds `no-cache` to a conditional request, which makes the server answer 200.)
const NOCACHE_PATHS = ['/openapi.json', '/.well-known/x402', '/.well-known/x402.json', '/llms.txt', '/SKILL.md', ...JSON_PATHS, '/.well-known/security.txt',
  '/.well-known/ai-catalog.json', '/.well-known/ard.json', '/.well-known/api-catalog', '/.well-known/agent-skills/index.json', '/auth.md'];   // R17 added these five
// /robots.txt (R18) is judged separately below: Cloudflare overrides our Cache-Control on that path, so the header cannot be the test.
for (const p of NOCACHE_PATHS) {
  const hdr = BASE.startsWith('http://') ? HDR : {};
  const r1 = await fetch(BASE + p, { headers: hdr }); await r1.arrayBuffer();
  const etag = r1.headers.get('etag');
  const r2 = etag ? await fetch(BASE + p, { headers: { ...hdr, 'if-none-match': etag, 'cache-control': 'max-age=0' } }) : null;
  if (r2) await r2.arrayBuffer();
  ok(r1.status === 200 && r1.headers.get('cache-control') === 'no-cache' && !!etag && r2 && r2.status === 304, `${p}: 200, Cache-Control no-cache, ETag, conditional GET ${r2 ? r2.status : 'not sent'} (want 304)`);
}
// R19: /robots.txt must be a body the edge asked the origin for (cf-cache-status REVALIDATED) with an ETag that a conditional GET turns into a 304;
// straight to a local origin it is our own no-cache. The verdict logic is ops/fresh-verdict.mjs, pinned by test/r19-discovery.test.js.
{
  const hdr = BASE.startsWith('http://') ? HDR : {};
  const r1 = await fetch(BASE + '/robots.txt', { headers: hdr }); await r1.arrayBuffer();
  const etag = r1.headers.get('etag');
  const r2 = etag ? await fetch(BASE + '/robots.txt', { headers: { ...hdr, 'if-none-match': etag, 'cache-control': 'max-age=0' } }) : null;
  if (r2) await r2.arrayBuffer();
  const v = robotsVerdict({ status: r1.status, cacheControl: r1.headers.get('cache-control'), etag, cfCacheStatus: r1.headers.get('cf-cache-status'), conditionalStatus: r2 ? r2.status : null });
  ok(v.ok, `/robots.txt: a fresh body (cf-cache-status ${r1.headers.get('cf-cache-status') || 'none, origin direct'}, ETag ${etag ? 'present' : 'absent'}, conditional GET ${r2 ? r2.status : 'not sent'})${v.ok ? '' : ': ' + v.why}`);
}
// R15e: every doc that states the liq-feed pace states both intervals (5 s for an x402 payer or a prepaid pack key, 10 s for a pass key).
{
  const hdr = BASE.startsWith('http://') ? HDR : {};
  const both = (t) => /\b5 seconds\b/.test(t) && /\b10 seconds\b/.test(t);
  const oa = JSON.parse(await (await fetch(BASE + '/openapi.json', { headers: hdr })).text());
  ok(both(oa.paths['/api/liq-feed'].get.description), '/openapi.json: /api/liq-feed states 5 seconds and 10 seconds');
  for (const p of ['/llms.txt', '/SKILL.md']) { const t = await (await fetch(BASE + p, { headers: hdr })).text(); const i = t.indexOf('Calls are paced per caller'); ok(i > 0 && both(t.slice(i, i + 400)), `${p}: the liq-feed pace sentence states 5 seconds and 10 seconds`); }
  const mcp = await fetch(BASE + '/mcp', { method: 'POST', headers: { ...hdr, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const raw = await mcp.text();
  const j = json(raw.split('\n').map((l) => l.replace(/^data: /, '')).find((l) => l.startsWith('{')) || '');
  const tool = j && j.result && j.result.tools.find((t) => t.name === 'get_liq_feed');
  ok(tool && both(tool.description), 'MCP tools/list: get_liq_feed states 5 seconds and 10 seconds');
}
// ---- R17: agent readiness (lib/agent-ready.js)
{
  const hdr = BASE.startsWith('http://') ? HDR : {};
  const raw = async (p, headers = {}) => { const r = await fetch(BASE + p, { headers: { ...hdr, ...headers } }); const buf = Buffer.from(await r.arrayBuffer()); return { r, buf, text: buf.toString('utf8') }; };
  // the ARD manifest: the same document at both paths, with the fields the schema requires
  const ai = await raw('/.well-known/ai-catalog.json'), ard = await raw('/.well-known/ard.json');
  const doc = json(ard.text);
  ok(ai.text === ard.text && doc, '/.well-known/ai-catalog.json and /.well-known/ard.json are one document');
  const entryOk = (e) => e && /^urn:air:[a-zA-Z0-9.-]+(:[a-zA-Z0-9._-]+)+$/.test(e.identifier) && e.displayName && /^[a-z]+\/[a-z0-9.+-]+$/.test(e.type) && (('url' in e) !== ('data' in e)) && Array.isArray(e.representativeQueries) && e.representativeQueries.length >= 2 && e.representativeQueries.length <= 5;
  ok(doc && doc.specVersion === '1.0' && doc.host && doc.host.displayName && Array.isArray(doc.entries) && doc.entries.length === 4 && doc.entries.every(entryOk), 'ARD manifest: specVersion, host.displayName, 4 entries each with identifier, displayName, type, one of url/data, 2-5 queries');
  ok(ai.r.headers.get('access-control-allow-origin') === '*' && ard.r.headers.get('access-control-allow-origin') === '*' && /^application\/ai-catalog\+json/.test(ai.r.headers.get('content-type') || ''), 'ARD manifest: CORS *, application/ai-catalog+json on the predecessor path');
  const urls = doc ? await Promise.all(doc.entries.map(async (e) => (await fetch(e.url, { headers: e.url.startsWith(BASE) ? hdr : {} })).status)) : [];
  ok(urls.length === 4 && urls.every((c) => c === 200), `ARD manifest: every entry url answers 200 (${urls.join(', ')})`);
  // RFC 9727
  const ac = await raw('/.well-known/api-catalog');
  const acj = json(ac.text);
  ok(/^application\/linkset\+json/.test(ac.r.headers.get('content-type') || '') && acj && acj.linkset[0].anchor === `${ORIGIN_OF(BASE)}/api` && acj.linkset[0]['service-desc'] && acj.linkset[0]['service-doc'] && acj.linkset[0].status, '/.well-known/api-catalog: application/linkset+json, anchor /api, service-desc, service-doc, status');
  // Link headers on / and /api
  for (const p of ['/', '/api']) {
    const l = (await raw(p)).r.headers.get('link') || '';
    ok(/rel="api-catalog"/.test(l) && /rel="service-desc"/.test(l) && /rel="service-doc"/.test(l) && !/rel="(?!api-catalog|service-desc|service-doc)/.test(l), `${p}: Link header names api-catalog, service-desc, service-doc and nothing else`);
  }
  // markdown negotiation, both ways
  const md = await raw('/', { accept: 'text/markdown' }), llms = await raw('/llms.txt'), dflt = await raw('/'), html = await raw('/', { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' });
  ok(md.r.status === 200 && md.r.headers.get('content-type') === 'text/markdown; charset=utf-8' && /Accept/i.test(md.r.headers.get('vary') || '') && md.text === llms.text, 'GET / with Accept: text/markdown: text/markdown; charset=utf-8, Vary: Accept, the llms.txt text');
  ok(/^application\/json/.test(dflt.r.headers.get('content-type') || '') && json(dflt.text) && /^text\/html/.test(html.r.headers.get('content-type') || '') && /Accept/i.test(dflt.r.headers.get('vary') || '') && /Accept/i.test(html.r.headers.get('vary') || ''), 'GET / default is JSON and a browser Accept is HTML, both with Vary: Accept');
  // robots.txt
  const robots = (await raw('/robots.txt')).text.split('\n');
  ok(robots[0] === 'User-agent: *' && robots[1] === 'Content-Signal: search=yes, ai-input=yes, ai-train=yes' && robots.includes(`Agentmap: ${ORIGIN_OF(BASE)}/.well-known/ard.json`), 'robots.txt: Content-Signal under User-agent, Agentmap names ard.json');
  // the skills index: the digest is of the bytes /SKILL.md serves
  const skills = json((await raw('/.well-known/agent-skills/index.json')).text);
  const skillBytes = (await raw('/SKILL.md')).buf;
  const k = skills && skills.skills && skills.skills[0];
  ok(k && skills.$schema === 'https://schemas.agentskills.io/discovery/0.2.0/schema.json' && k.type === 'skill-md' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(k.name) && k.description.length <= 1024 && k.url === `${ORIGIN_OF(BASE)}/SKILL.md` && k.digest === `sha256:${crypto.createHash('sha256').update(skillBytes).digest('hex')}`, 'agent-skills index: $schema, name, type, description, url, and digest = sha256 of the served /SKILL.md');
  // /auth.md
  const auth = await raw('/auth.md');
  ok(auth.r.status === 200 && auth.r.headers.get('content-type') === 'text/markdown; charset=utf-8' && auth.text.split('\n')[0] === '# auth.md' && /llms\.txt/.test(auth.text) && /openapi\.json/.test(auth.text) && /\/api\/keys\//.test(auth.text), '/auth.md: text/markdown, first line "# auth.md", links llms.txt and openapi.json, names /api/keys/*');
  // the paper route: the slash form and the %2F form are the same route unpaid
  const accepts = async (p) => { const r = await fetch(BASE + p, { headers: hdr }); const h = r.headers.get('payment-required'); await r.arrayBuffer(); return { status: r.status, accepts: h ? JSON.stringify(JSON.parse(Buffer.from(h, 'base64').toString('utf8')).accepts.map((a) => { const { extra, ...rest } = a; return rest; })) : null }; };
  const sl = await accepts('/api/paper/10.1038/nature14539'), en = await accepts('/api/paper/10.1038%2Fnature14539');
  ok(sl.status === 402 && en.status === 402 && sl.accepts && sl.accepts === en.accepts, '/api/paper: the slash form and the %2F form both answer 402 with the same accepts');
  // counts
  const man = json((await raw('/.well-known/x402.json')).text);
  const nRoutes = man && man.resources.length;
  if (want.error) skip(`manifest route count and MCP tool count: this checkout's PRICES and TOOL_DEFS cannot be loaded here (${want.error}); run it on the box`);
  else ok(man && nRoutes === want.routes, `manifest: ${nRoutes} routes (PRICES: ${want.routes})`);
  const tl = await fetch(BASE + '/mcp', { method: 'POST', headers: { ...hdr, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const tj = json((await tl.text()).split('\n').map((l) => l.replace(/^data: /, '')).find((l) => l.startsWith('{')) || '');
  if (!want.error) ok(tj && tj.result.tools.length === want.tools, `MCP tools/list: ${tj && tj.result.tools.length} tools (TOOL_DEFS + the pricing tool: ${want.tools})`);
}
console.log(failed ? `\n${failed} check(s) FAILED` : `\nall checks passed${skipped ? ` (${skipped} skipped)` : ''}; nothing was paid`);
process.exit(failed ? 1 : 0);
