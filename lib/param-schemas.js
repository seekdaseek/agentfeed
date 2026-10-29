// lib/param-schemas.js — the zod schema of every path parameter, in one place (R20e, 29 Oct 2026).
//
// These are the INPUT schemas of the MCP tools, and gen-bazaar-meta.js turns them into the JSON Schema that the OpenAPI document, the Bazaar
// declaration and /api/sample publish (pattern, minLength, maxLength). The MCP SDK validates tool arguments against them BEFORE the payment
// wrapper runs, so an impossible value over MCP is refused with no payment prompt, the same as lib/param-guard.js does over REST.
//
// They are deliberately a SUPERSET of what the handler accepts (the handler stays the authority): lib/param-guard.js holds the exact check for REST,
// and test/param-guard.test.js proves every value the guard lets through is also accepted here, and that every published example passes both.
'use strict';

const { z } = require('zod');
const { BASE58_RE } = require('./solrpc');

const base58 = (desc) => z.string().min(32).max(44).regex(BASE58_RE, '32 to 44 base58 characters').describe(desc);

/**
 * The zod schema of a QUERY parameter whose bounds live in lib/query-rules.js (R20f, 29 Oct 2026): the same range the REST guard enforces, so the MCP
 * SDK refuses ?swaps=5 before the payment wrapper runs. An integer rule becomes z.number().int().min().max(); a rule whose maximum depends on the clock
 * (papers year_from) publishes a fixed upper bound (9999: four digits), the guard and the handler check the live maximum. Optional, as the parameters are.
 */
function q(pattern, name, desc) {
  const rule = (require('./query-rules').QUERY_RULES[pattern] || []).find((r) => r.name === name);
  if (!rule || (rule.kind !== 'int' && rule.kind !== 'num')) throw new Error(`param-schemas.q: no int/num query rule ${name} on ${pattern}`);
  let t = z.number();
  if (rule.kind === 'int') t = t.int();
  t = t.min(rule.min);
  const hi = typeof rule.max === 'number' ? rule.max : rule.schemaMax;
  if (hi != null) t = t.max(hi);
  return t.optional().describe(desc);
}

module.exports = {
  q,
  wallet: (desc = 'Solana wallet address (base58)') => base58(desc),
  mint: (desc = 'SPL token mint address (base58)') => base58(desc),
  // tools/signals.js coinShape: upper-cased, an optional USDT / -PERP / PERP suffix, 1 to 20 letters or digits
  coin: (desc) => z.string().min(1).max(30).regex(/^[A-Za-z0-9-]+$/, 'letters and digits, optionally with a -PERP suffix').describe(desc),
  // tools/sanctions.js ADDRESS_SHAPE after the handler's trim()
  address: (desc) => z.string().min(14).max(130).regex(/^\s*[A-Za-z0-9:]{14,120}\s*$/, '14 to 120 letters and digits').describe(desc),
  // tools/domain.js parseDomain: a hostname with at least two labels; IDN and a trailing dot are accepted, the handler does the rest
  domain: (desc) => z.string().min(3).max(253).describe(desc),
  // tools/papers.js normDoi: a DOI, optionally prefixed with doi: or https://doi.org/, its slash as written or as %2F
  doi: (desc) => z.string().min(7).max(300).regex(/10\.\d{4,9}(?:\/|%2[Ff])\S+/, 'a DOI such as 10.1038/nature14539').describe(desc),
};
