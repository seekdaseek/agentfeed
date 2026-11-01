// test/fixtures/r24/company-check/wire-preload.js: preloaded (NODE_OPTIONS=--require) into the REAL server.js that test/helpers/real-server.js boots, so that company-check is registered in it the way the
// lead will register it in expansion.js (tools/r24/index.js): pushed onto EXP and added to PRICES_ADD, TAGS_ADD and MCP_DEFS_ADD, which payments.js, mcp.js and register() read when server.js loads them,
// and the title and the question into tools/titles.js and tools/questions.js (payments.js reads them for the 402 challenge). The route's handler is the real companyCheck() with its network replaced by the
// synthetic EDGAR of world.js (no connection at all), a scripted insider function and a scripted site-signals; the clock is fixed at the world's date. Every EDGAR read, insider call and site read is
// appended to $AF_CC_LOG, so a test can assert that a refused or unpaid request started none of them.
// The filing list of INDV (Indigo Ventures) is slow (2.3 s), which is how the in-flight limit is held open for longer than its 2 s wait.
// Idempotent: when expansion.js already has get_company_check (the lead has wired it) the entry is kept and only its `run` is given these dependencies.
'use strict';
const Module = require('module');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.AF_ROOT;
const LOG = process.env.AF_CC_LOG;
const note = (line) => { if (LOG) { try { fs.appendFileSync(LOG, line + '\n'); } catch { /* best effort */ } } };
const load = Module._load;
let wired = false;

Module._load = function (request) {
  const m = load.apply(this, arguments);
  if (!wired && typeof request === 'string' && /(^|\/)expansion$/.test(request) && m && Array.isArray(m.EXP)) {
    wired = true;
    const CC = load.call(this, path.join(ROOT, 'tools/r24/company-check'), module);
    const W = load.call(this, path.join(ROOT, 'test/fixtures/r24/company-check/world'), module);
    const world = W.makeWorld({ status: (u) => (/outg-/.test(u) ? 503 : null), delay: (u) => (/submissions\/CIK0001000012/.test(u) ? 2300 : 0), onCall: (u) => note(`edgar ${u.replace(/^https:\/\/(www|data)\.sec\.gov/, '')}`) });
    const deps = {
      fetch: world.fetch, stream: world.stream, now: () => W.NOW, gate: CC.makeGate(), lane: CC.makeLane(), cache: CC.makeCache(),
      getInsiderTrades: async (a) => { note(`insider ${a.ticker}`); return { window_days: a.days, filings_capped: false, form4_filings: 2, transactions: 2, open_market_buys_usd: 0, open_market_sales_usd: 500, trades: [{ code: 'S', filed: '2026-10-02' }, { code: 'A', filed: '2026-10-01' }] }; },
      getSiteSignals: async (a) => { note(`site ${a.url}`); return { host: new URL(a.url).hostname, url: a.url, fetched_at: '2026-11-01T12:00:00.000Z', page: { ok: true, status: 200, final_url: a.url, redirected: false }, tls: { ok: true, protocol: 'TLSv1.3', issuer: { organization: 'Example CA' }, valid_to: '2027-01-01T00:00:00.000Z', days_left: 60, expired: false }, dns: { ok: true, counts: { a: 1, aaaa: 0, mx: 1, caa: 0 }, spf: { present: true }, dmarc: { present: false } }, headers: { ok: true, grade: 'B', score: 70, max: 100 } }; },
    };
    const e = CC.entries[0];
    const have = m.EXP.find((x) => x.name === e.name);
    if (have) have.run = (args) => CC.companyCheck(args || {}, deps);       // the lead has wired the real entry in expansion.js: only its dependencies are swapped
    else {
      const wired1 = { ...e, run: (args) => CC.companyCheck(args || {}, deps) };
      m.EXP.push(wired1);
      m.PRICES_ADD[wired1.route] = { usd: wired1.usd, tool: wired1.name, desc: wired1.desc };
      m.TAGS_ADD[wired1.name] = wired1.tags;
      m.MCP_DEFS_ADD.push({ name: wired1.name, usd: wired1.usd, desc: wired1.desc, schema: wired1.schema, mcpGate: false, run: (a, ctx) => wired1.run(a || {}, ctx) });
    }
    load.call(this, path.join(ROOT, 'tools/titles'), module).TOOL_TITLES[e.name] = e.title;
    load.call(this, path.join(ROOT, 'tools/questions'), module).QUESTIONS[e.name] = e.question;
  }
  return m;
};
