// test/fixtures/r23/pkgcheck/inject.cjs: preloaded (NODE_OPTIONS=--require) into the REAL server.js that test/helpers/real-server.js boots, for r23-pkgcheck-real-server.test.js.
// expansion.js is the file the lead edits to add the route; a test may not edit it, so this puts the route in the same four places expansion.js's own loop does
// (EXP for register(), PRICES_ADD for the paywall, TAGS_ADD, MCP_DEFS_ADD for POST /mcp) BEFORE payments.js, server.js and mcp.js read them, plus its title and question.
// The upstream is the fake world of world.js: no network (af-test-preload refuses any non-loopback connection anyway). Every fake upstream call is appended to $AF_PKG_LOG.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = process.env.AF_ROOT;
require(path.join(ROOT, 'test', 'helpers', 'af-test-preload.js'));        // the network refusal, db redirect and handler counter must be in place before expansion.js loads
const expansion = require(path.join(ROOT, 'expansion'));
const W = require(path.join(ROOT, 'test', 'fixtures', 'r23', 'pkgcheck', 'world'));
const P = require(path.join(ROOT, 'tools', 'r23', 'pkg-check'));

const down = { status: 503, body: {} };
const world = W.makeWorld({
  extraGet: { 'https://registry.npmjs.org/example-osvdown': 'npm-widget.json' },
  getOverrides: { 'https://registry.npmjs.org/example-down': down, 'https://registry.npmjs.org/example-down/latest': down },
  osvOverride: (body) => (body.package.name === 'example-osvdown' ? { status: 500, body: {} } : undefined),
});
const log = (line) => { if (process.env.AF_PKG_LOG) { try { fs.appendFileSync(process.env.AF_PKG_LOG, line + '\n'); } catch { /* best effort */ } } };
const deps = {
  ...world.deps,
  get: (url, o) => { log(`GET ${url}`); return world.deps.get(url, o); },
  post: (url, body, o) => { log(`POST ${url} ${body.package.name}@${body.version}`); return world.deps.post(url, body, o); },
  lists: W.lists(),
};

for (const e of P.makeEntries(deps)) {
  expansion.EXP.push(e);
  expansion.PRICES_ADD[e.route] = { usd: e.usd, tool: e.name, desc: e.desc };
  expansion.TAGS_ADD[e.name] = e.tags;
  expansion.MCP_DEFS_ADD.push({ name: e.name, usd: e.usd, desc: e.desc, schema: e.schema, mcpGate: false, run: (a, ctx) => e.run(a || {}, ctx) });
  require(path.join(ROOT, 'tools', 'titles')).TOOL_TITLES[e.name] = e.title;
  require(path.join(ROOT, 'tools', 'questions')).QUESTIONS[e.name] = e.question;
}
