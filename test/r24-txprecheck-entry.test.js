// R24 item 4: the route entry (shape the lead wires), the public text, and the tables behind every `known` flag.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const K = require('@solana/kit');
const V = require('viem');
const T = require('../tools/r24/txprecheck');
const Kn = require('../tools/r24/txprecheck/known');
const L = require('../tools/r24/txprecheck/limits');
const W = require('../tools/r24/txprecheck/warn');

const DIR = path.join(__dirname, '..', 'tools', 'r24', 'txprecheck');
const entry = T.entries[0];

test('the entry is shaped like the EXP entries of expansion.js, with title, question and example', () => {
  assert.equal(T.entries.length, 1);
  assert.deepEqual([entry.name, entry.route, entry.usd], ['get_tx_precheck', 'GET /api/tx-precheck', 0.05]);
  assert.ok(entry.desc.startsWith('Use when an agent needs'));
  assert.ok(entry.desc.length >= 180 && entry.desc.length <= 255, `desc is ${entry.desc.length} characters`);
  assert.match(entry.desc, /503/); assert.match(entry.desc, /not charged/i);
  assert.ok(Array.isArray(entry.tags) && entry.tags.every((t) => t === t.toLowerCase() && /^[a-z0-9-]+$/.test(t)));
  assert.deepEqual(Object.keys(entry.schema).sort(), ['chain', 'data', 'from', 'to', 'tx', 'value']);
  assert.ok(entry.schema.chain.safeParse('solana').success && entry.schema.chain.safeParse('base').success && !entry.schema.chain.safeParse('ethereum').success);
  assert.ok(!entry.schema.chain.isOptional()); for (const k of ['tx', 'to', 'data', 'value', 'from']) assert.ok(entry.schema[k].isOptional(), k);
  assert.ok(!entry.route.includes(':'), 'no path parameter');
  assert.equal(typeof entry.title, 'string'); assert.match(entry.question, /\?$/); assert.equal(typeof entry.run, 'function');
  assert.equal(entry.example.chain, 'solana');
});

test('the schema caps are the handler caps: an impossible value is refused by the MCP schema before payment', () => {
  assert.ok(entry.schema.tx.safeParse('A'.repeat(L.MAX_SOL_TX_B64)).success); assert.ok(!entry.schema.tx.safeParse('A'.repeat(L.MAX_SOL_TX_B64 + 1)).success);
  assert.ok(entry.schema.data.safeParse('0x' + 'a'.repeat(L.MAX_EVM_DATA_HEX)).success); assert.ok(!entry.schema.data.safeParse('0x' + 'a'.repeat(L.MAX_EVM_DATA_HEX + 1)).success);
  assert.ok(!entry.schema.to.safeParse('0x' + '1'.repeat(41)).success);
});

test('public text: nothing a customer reads names a person, dates a start, advises, promises or uses the word that is kept out; every warning id is stable and listed', () => {
  const ex = JSON.stringify(entry.example);
  const sources = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(DIR, f), 'utf8'));
  const literals = sources.flatMap((s) => [...s.matchAll(/`([^`$]{25,})`|'([^'\n]{25,})'|"([^"\n]{25,})"/g)].map((m) => m[1] || m[2] || m[3]));
  const text = [entry.desc, entry.title, entry.question, ex, ...Object.values(entry.schema).map((z) => z.description || ''), ...literals].join('\n');
  const BANNED = [/\brug/i, /guarantee/i, /\bsince\b/i, /\byou should\b/i, /\bwe recommend\b/i, /\badvice\b/i, /\bbuy now\b/i, /\bdo not (sign|send|trade|buy|sell)\b/i, /\bsergiu\b/i, /\bochinca\b/i, /(?<!not a statement that it )\bis (completely |totally )?safe\b/i, /\bscam\b/i, /\bmalicious\b/i];
  for (const re of BANNED) assert.ok(!re.test(text), `public text must not match ${re}: ${(text.match(re) || [''])[0]}`);
  assert.ok(/not a statement that it is safe/.test(text), 'the only use of "safe" is the disclaimer');
  assert.ok(/(?<!not a statement that it )\bis (completely |totally )?safe\b/i.test('this is safe') && !/(?<!not a statement that it )\bis (completely |totally )?safe\b/i.test('that is not a statement that it is safe'), 'the ban matches a planted claim and spares the disclaimer');
  assert.deepEqual([...W.IDS].sort(), ['approval_to_unknown_spender', 'authority_change', 'close_account_to_other', 'delegate_granted', 'high_risk_token', 'large_balance_outflow', 'transfer_to_fresh_account', 'unknown_program', 'unlimited_approval']);
  assert.throws(() => W.warning('made_up', 'high', 'x'), /unknown warning id/);
});

test('warning helpers: units without floats, percentages in integers, the 90 percent line, the ordering by severity', () => {
  assert.equal(W.fmtUnits(1500000n, 6), '1.5'); assert.equal(W.fmtUnits(1000000n, 6), '1'); assert.equal(W.fmtUnits(1n, 9), '0.000000001'); assert.equal(W.fmtUnits(-5000n, 9), '-0.000005'); assert.equal(W.fmtUnits(12n, 0), '12');
  assert.equal(W.fmtUnits(18446744073709551615n, 6), '18446744073709.551615');
  assert.equal(W.pct(9n, 10n), 90); assert.equal(W.pct(1n, 3n), 33.33); assert.equal(W.pct(1n, 0n), null);
  assert.equal(W.isLargeShare(90n, 100n), true); assert.equal(W.isLargeShare(89n, 100n), false); assert.equal(W.isLargeShare(1n, 0n), false);
  const sorted = W.sortWarnings([W.warning('unknown_program', 'medium', 'a'), W.warning('transfer_to_fresh_account', 'low', 'b'), W.warning('authority_change', 'high', 'c'), W.warning('high_risk_token', 'high', 'd')]);
  assert.deepEqual(sorted.map((w) => w.id), ['high_risk_token', 'authority_change', 'unknown_program', 'transfer_to_fresh_account']);
});

test('the known tables: every Solana id is a 32-byte address with an https source; every Base address is a lower-case 20-byte address with a name, a kind and an https source; no id twice', () => {
  const enc = K.getAddressEncoder();
  for (const [id, v] of Object.entries(Kn.SOLANA_PROGRAMS)) { assert.equal(enc.encode(K.address(id)).length, 32, id); assert.ok(v.name && /^https:\/\//.test(v.source), id); }
  for (const [id, v] of Object.entries(Kn.SOLANA_MINTS)) { assert.equal(enc.encode(K.address(id)).length, 32, id); assert.ok(v.symbol && Number.isInteger(v.decimals) && /^https:\/\//.test(v.source), id); }
  for (const [a, v] of Object.entries(Kn.BASE_CONTRACTS)) { assert.match(a, /^0x[0-9a-f]{40}$/); assert.ok(V.isAddress(a, { strict: false })); assert.ok(v.name && ['token', 'router', 'factory', 'utility'].includes(v.kind) && /^https:\/\//.test(v.source), a); if (v.kind === 'token') assert.ok(v.symbol && Number.isInteger(v.decimals), a); }
  assert.equal(new Set(Object.keys(Kn.SOLANA_PROGRAMS)).size, Object.keys(Kn.SOLANA_PROGRAMS).length);
  assert.equal(Object.keys(Kn.SOLANA_PROGRAMS).length, 21); assert.equal(Object.keys(Kn.BASE_CONTRACTS).length, 11);
  // lookups are exact, case-insensitive for Base, and cannot be fooled by an object property name
  assert.equal(Kn.baseContract('0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913').symbol, 'USDC');
  assert.equal(Kn.solProgram('constructor'), null); assert.equal(Kn.solProgram('__proto__'), null); assert.equal(Kn.solMint('toString'), null); assert.equal(Kn.baseContract('constructor'), null);
  assert.equal(Kn.solProgram('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').name, 'spl-token');
  // the ids the repo already verified on chain on 12 Oct 2026 (lib/solrpc.js) are in the table under the same program
  const { PROGRAM_NAMES } = require('../lib/solrpc');
  for (const id of Object.keys(PROGRAM_NAMES)) assert.ok(Kn.solProgram(id), `${id} (${PROGRAM_NAMES[id]}) is in the table`);
});
