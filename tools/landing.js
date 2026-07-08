// Landing page for humans; agents on the same URL keep getting JSON.
function renderLanding(PRICES, network) {
  const rows = Object.entries(PRICES).map(([route, p]) => `
    <tr><td class="t">${p.tool}</td><td class="r">${route}</td>
    <td class="p">$${p.usd}</td><td>${p.desc}</td></tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentFeed — crypto trading data for AI agents, paid in USDC via x402</title>
<meta name="description" content="SOL+BTC prices, funding, real-time liquidations, long/short positioning, open interest. Pay per call in USDC on Solana via x402. No API keys.">
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
<p class="tag">Crypto trading data for AI agents. Pay per call in USDC on Solana via x402 — no API keys, no accounts, no subscriptions.</p>
<span class="badge">x402 ${network}</span><span class="badge">MCP + REST</span><span class="badge">real-time liquidations</span><span class="badge">positioning</span>

<h2>MCP endpoint (Claude, Cursor, agent frameworks)</h2>
<pre>https://x402.ochinimus.app/mcp</pre>

<h2>Tools</h2>
<table><tr><th>tool</th><th>route</th><th>price</th><th>what you get</th></tr>${rows}</table>

<h2>Try it (returns 402 with payment terms; x402 clients pay + retry automatically)</h2>
<pre>curl https://x402.ochinimus.app/api/trade-context</pre>

<div class="links">
  <a href="https://github.com/seekdaseek/agentfeed">GitHub</a> ·
  <a href="https://registry.modelcontextprotocol.io/v0/servers?search=agentfeed">MCP Registry</a> ·
  <a href="/.well-known/x402.json">x402 manifest</a> ·
  <a href="/health">health</a>
</div>
<div class="foot">Built by <a href="https://ochinimus.app">ochinimus</a> · Solana mainnet settlement · agents hitting this URL get JSON</div>
</body></html>`;
}
module.exports = { renderLanding };
