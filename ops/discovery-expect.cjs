// ops/discovery-expect.cjs: how many priced routes and MCP tools this checkout must serve, read from its own tables (R22).
// ops/discovery-check.mjs compared the live manifest and tools/list with two literals (91 routes, 90 tools) that went stale the day a route was added;
// the expected numbers are now PRICES (one priced route each) and TOOL_DEFS (one MCP tool each: expansion.js leaves the `mcp: false` routes out of MCP_DEFS_ADD, so
// the purchase routes are routes but not tools), plus the one tool initMcp registers outside TOOL_DEFS, the free `pricing` listing (mcp.js, the second registerTool call).
'use strict';

const REGISTERED_OUTSIDE_TOOL_DEFS = 1;

const expectedCounts = ({ PRICES, TOOL_DEFS }) => ({
  routes: Object.keys(PRICES).length,
  tools: TOOL_DEFS.length + REGISTERED_OUTSIDE_TOOL_DEFS,
});

/**
 * { routes, tools } of the checkout this file sits in, or { error } when its modules cannot be loaded here (a machine without the box's databases).
 * payments.js and mcp.js open the audit database on import, so an in-memory one is used unless the caller named a scratch copy: this never touches agentfeed.db.
 */
function loadExpected() {
  if (!process.env.AGENTFEED_DB) process.env.AGENTFEED_DB = ':memory:';
  try {
    return expectedCounts({ PRICES: require('../payments').PRICES, TOOL_DEFS: require('../mcp').TOOL_DEFS });
  } catch (e) {
    return { error: String((e && e.message) || e).split('\n')[0] };
  }
}

module.exports = { expectedCounts, loadExpected, REGISTERED_OUTSIDE_TOOL_DEFS };
