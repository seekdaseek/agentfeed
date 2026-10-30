// R22: ops/discovery-check.mjs reads the route and tool counts it expects from this checkout's PRICES and TOOL_DEFS, never from literals.
// It carried "expected 91" and "expected 90" from R15b, and failed on the box the day R21 added routes (96 routes, 93 tools).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./helpers/real-server');
const { expectedCounts, loadExpected, REGISTERED_OUTSIDE_TOOL_DEFS } = require('../ops/discovery-expect.cjs');

const CHECK = path.join(__dirname, '..', 'ops', 'discovery-check.mjs');

test('expectedCounts: one route per PRICES entry, one tool per TOOL_DEFS entry plus the free pricing tool', () => {
  assert.deepEqual(expectedCounts({ PRICES: { 'GET /a': {}, 'GET /b': {}, 'GET /c': {} }, TOOL_DEFS: [{ name: 'x' }, { name: 'y' }] }), { routes: 3, tools: 2 + REGISTERED_OUTSIDE_TOOL_DEFS });
  assert.deepEqual(expectedCounts({ PRICES: {}, TOOL_DEFS: [] }), { routes: 0, tools: REGISTERED_OUTSIDE_TOOL_DEFS });
});

test('the "+ pricing" in the tool count is the one registerTool call outside the TOOL_DEFS loop in mcp.js: a third registered tool breaks this test', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'mcp.js'), 'utf8');
  assert.equal((src.match(/\.registerTool\(/g) || []).length, 2, 'the TOOL_DEFS loop and the pricing tool, nothing else');
  assert.match(src, /s\.registerTool\('pricing'/);
  assert.equal(REGISTERED_OUTSIDE_TOOL_DEFS, 1);
});

test('discovery-check.mjs holds no literal route or tool count', () => {
  const src = fs.readFileSync(CHECK, 'utf8');
  assert.ok(!/expected (91|90)\b/.test(src) && !/length === (9\d|8\d)\b/.test(src), 'no hard-coded 8x/9x count');
  assert.ok(!/(nRoutes|tools\.length)\s*===\s*\d/.test(src), 'neither count is compared with a number written in the script');
  assert.match(src, /want\.routes/);
  assert.match(src, /want\.tools/);
});

test('discovery-check against the real server: the two count lines compare with this checkout\'s own tables (or say plainly that they cannot be read here)', async (t) => {
  const s = await H.boot();
  t.after(() => s.close());
  const r = spawnSync(process.execPath, [...process.execArgv, CHECK, `http://127.0.0.1:${s.port}`], { encoding: 'utf8', timeout: 120000 });   // same preloads as this process (the Mac box shim), so both ends see the same tables
  const lines = String(r.stdout).split('\n');
  const here = loadExpected();
  const routesLine = lines.find((l) => /^(OK   |FAIL )manifest: \d|^SKIP manifest route count/.test(l));
  const toolsLine = lines.find((l) => /^(OK   |FAIL )MCP tools\/list: \d+ tools/.test(l));
  if (here.error) {
    assert.match(routesLine, /^SKIP manifest route count and MCP tool count: .*cannot be loaded here/, routesLine);
    assert.equal(toolsLine, undefined, 'one SKIP line covers both; no count line pretends to have run');
    assert.ok(!lines.some((l) => /^FAIL (manifest|MCP tools)/.test(l)));
    assert.match(String(r.stdout), /\(1 skipped\)|FAILED/);
  } else {
    assert.equal(routesLine, `OK   manifest: ${here.routes} routes (PRICES: ${here.routes})`);
    assert.equal(toolsLine, `OK   MCP tools/list: ${here.tools} tools (TOOL_DEFS + the pricing tool: ${here.tools})`);
  }
});

// server.json is what the MCP Registry publishes and what the server card is built from (the registry's description limit is 100 characters).
const sj = require('../server.json');
const live = loadExpected();

test('server.json: the description fits the registry\'s 100 characters, names the briefs and the 20 chains, and the version is above the registry\'s live latest (2.9.0)', () => {
  assert.ok(sj.description.length >= 1 && sj.description.length <= 100, `${sj.description.length} characters: ${sj.description}`);
  assert.match(sj.description, /briefs/);
  assert.match(sj.description, /\b20 chains\b/);
  const v = sj.version.split('.').map(Number);
  assert.ok(v.length === 3 && v.every(Number.isInteger));
  assert.ok(v[0] > 2 || (v[0] === 2 && v[1] > 9), `version ${sj.version} must be above 2.9.0, the latest the registry holds (read 30 Oct 2026)`);
});

test('server.json: the description\'s tool count is the live tools/list count, derived from TOOL_DEFS', { skip: live.error ? 'this checkout\'s tables cannot be loaded here (run under the box shim, or on the box)' : false }, () => {
  assert.match(sj.description, new RegExp(`\\b${live.tools} tools\\b`), `${sj.description} vs ${live.tools}`);
});
