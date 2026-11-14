// Landing page for humans; agents on the same URL keep getting JSON.
//
// `coverage` is the same object `/` publishes as JSON: tools/liqdb.js
// getPerpCoverage(), distinct perp markets in the liquidation tape over the
// last 7 days. It is passed in rather than read here so the page has no
// database of its own, and it is interpolated rather than restated so the
// headline figure cannot drift from the tape again -- the page carried a
// hand-typed count for months while the same service's own / published the
// measurement.
//
// Null-safe: if the tape is unreachable getPerpCoverage() returns null and
// the page falls back to the qualitative phrase. A landing page must never
// 500 because a read-only analytics database is busy.
const { httpRails, httpRailNames } = require('../lib/rails');
const { hfSentence } = require('../lib/hf');
const { SCOPE_SHORT } = require('./scope');

const ORIGIN = 'https://x402.ochinimus.app';
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The page's head texts, derived at render time: the scope sentence (tools/scope.js), the rails every HTTP route takes
 * (lib/rails httpRailNames: Solana, the EVM rails and Algorand) and the counts from the price table. The meta description is also
 * og:description and must fit 300 characters; it keeps "No API key is needed to pay per call." (R9's guard test).
 */
function landingHead(PRICES) {
  const routes = Object.keys(PRICES);
  const keyPacks = routes.filter((r) => /^GET \/api\/keys\//.test(r)).length;
  const dataRoutes = routes.length - keyPacks;
  const title = 'AgentFeed — crypto market data, Solana pre-trade checks, sanctions screening and language tasks for AI agents, paid per call via x402';
  // Every rail by name while that fits the 300 characters; past it (R10 Phase A added three networks) the count and as many
  // leading names as fit, and the page footer still names every one.
  const full = `${SCOPE_SHORT} Pay per call in USDC via x402 on ${httpRailNames()}. No API key is needed to pay per call.`;
  const rails = httpRails();
  const counted = (k) => `${SCOPE_SHORT} Pay per call in USDC via x402 on ${rails.length} networks (${rails.slice(0, k).map((r) => r.name).join(', ')} and more). No API key is needed to pay per call.`;
  let k = Math.min(4, rails.length);
  while (k > 1 && counted(k).length > 300) k--;
  const description = full.length <= 300 ? full : counted(k);
  return { title, description, dataRoutes, keyPacks };
}

function renderLanding(PRICES, network, coverage) {
  const n = coverage && coverage.perp_markets_7d;
  const perps = n ? String(n) : 'all';
  const perpsPhrase = n ? `${n} USDT perps` : 'every USDT perp';
  const rows = Object.entries(PRICES).map(([route, p]) => `
    <tr><td class="t">${p.tool}</td><td class="r">${route}</td>
    <td class="p">$${p.usd}</td><td>${p.desc}</td></tr>`).join('');

  const head = landingHead(PRICES);
  const railList = httpRails().map((r) => r.name);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(head.title)}</title>
<meta name="description" content="${esc(head.description)}">
<meta property="og:title" content="${esc(head.title)}">
<meta property="og:description" content="${esc(head.description)}">
<meta property="og:url" content="${ORIGIN}/">
<meta property="og:type" content="website">
<meta property="og:image" content="${ORIGIN}/icon.png">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(head.title)}">
<meta name="twitter:description" content="${esc(head.description)}">
<meta name="twitter:image" content="${ORIGIN}/icon.png">
<style>
  :root{--bg:#0a0e14;--card:#111722;--txt:#d7dde7;--dim:#7d8899;--gold:#ffd84d;--line:#1e2635}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--txt);font:15px/1.6 ui-monospace,'SF Mono',Menlo,monospace;padding:40px 20px;max-width:960px;margin:0 auto}
  h1{font-size:28px;color:var(--gold)}
  .tag{color:var(--dim);margin:6px 0 28px}
  .badge{display:inline-block;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:2px 10px;font-size:12px;color:var(--gold);margin-right:8px}
  h2{font-size:16px;color:var(--gold);margin:32px 0 12px}
  pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px;overflow-x:auto;font-size:13px;margin:10px 0}
  table{width:100%;border-collapse:collapse;font-size:13px}
  td,th{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
  th{color:var(--dim);font-weight:normal}
  .t{color:var(--gold);white-space:nowrap}.r{color:var(--dim);white-space:nowrap}.p{white-space:nowrap}
  a{color:var(--gold);text-decoration:none}a:hover{text-decoration:underline}
  .links{margin-top:28px;color:var(--dim)}
  .foot{margin-top:36px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
</style></head><body>
<h1>AgentFeed</h1>
<p class="tag">${SCOPE_SHORT.replace(/ for AI agents\.$/, '')}, for AI agents: <b>${head.dataRoutes} paid data routes</b>, among them live liquidations across <b>${perpsPhrase}</b> on Bybit, OKX and Binance. Pay per call in USDC via x402 on ${httpRailNames()}. No accounts, no subscriptions, and no API key needed to pay per call.${hfSentence()}${(() => { const t = require('../lib/keys').keysSentence(PRICES); return t ? ' ' + t.replace('page at /keys', 'page at <a href="/keys">/keys</a>') : ''; })()}</p>
<span class="badge">x402 ${network}</span><span class="badge">${railList.join(" + ")}</span><span class="badge">${head.dataRoutes} paid data routes</span><span class="badge">elizaOS plugin</span><span class="badge">MCP + REST</span><span class="badge">${perps} perps, 3 exchanges</span><span class="badge">full-universe cascades</span>

<p style="color:var(--dim);font-size:13px;margin-top:18px;border-left:2px solid var(--gold);padding-left:12px">
Bybit's <code>allLiquidation</code> is the only <b>complete, unthrottled</b> public liquidation stream among the major perp venues — Binance and OKX both throttle to ~1 print/sec/symbol, a documented limitation that undercounts hardest during cascades. No exchange publishes historical liquidation data (Binance deleted theirs; Bybit never had one). We record it live. <a href="https://ochinimuse.gumroad.com/l/liqdata">Free dataset + full quality disclosure &rarr;</a>
</p>

<h2>MCP endpoint (Claude, Cursor, agent frameworks)</h2>
<pre>https://x402.ochinimus.app/mcp</pre>

<h2>Tools</h2>
<table><tr><th>tool</th><th>route</th><th>price</th><th>what you get</th></tr>${rows}</table>

<h2>Try it (returns 402 with payment terms; x402 clients pay + retry automatically)</h2>
<pre>curl https://x402.ochinimus.app/api/trade-context</pre>
<p style="color:var(--dim);font-size:13px"><b>Copy payTo only from a fresh 402 response, never from transaction history.</b> A lookalike of our treasury address has sent address-poisoning transfers to our buyers.</p>

<div class="links">
  <a href="https://github.com/seekdaseek/agentfeed">GitHub</a> ·
  <a href="https://registry.modelcontextprotocol.io/v0/servers?search=agentfeed">MCP Registry</a> ·
  <a href="/.well-known/x402.json">x402 manifest</a> ·
  <a href="/health">health</a>
</div>
<div class="foot">Built by <a href="https://ochinimus.app">ochinimus</a> · USDC settlement on ${httpRailNames()} · <a href="https://www.npmjs.com/package/@seekdaseek/plugin-agentfeed">elizaOS plugin</a> · <a href="https://ochinimuse.gumroad.com/l/liqdata">datasets</a> · agents hitting this URL get JSON</div>
</body></html>`;
}
module.exports = { renderLanding, landingHead };
