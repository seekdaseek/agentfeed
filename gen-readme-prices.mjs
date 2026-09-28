#!/usr/bin/env node
// gen-readme-prices.mjs — rebuild the README's "Price index" from the live manifest.
//
// The table claims to be "Generated from /.well-known/x402.json", so it has to
// be. On Sep 25 it was not: the four $0.001 entry routes went into the "59
// tools" table, but the Price index only had its "read" date bumped from Sep 23
// to Sep 25 -- 48 rows summing to $0.765 under a label promising the manifest
// of a day that had 52 routes and $0.769. A date on a table must come from the
// read that produced its rows, so this script writes both in one pass.
//
// Idempotent: the same manifest yields the same README. It fails loudly if the
// section or the table it owns cannot be found, rather than appending a copy.
//
// usage: node gen-readme-prices.mjs [README.md]
import fs from 'node:fs';

const MANIFEST = 'https://x402.ochinimus.app/.well-known/x402.json';
const FILE = process.argv[2] || 'README.md';

const res = await fetch(MANIFEST, { signal: AbortSignal.timeout(20000) });
if (!res.ok) throw new Error(`manifest ${res.status}`);
const manifest = await res.json();
const readDay = new Date().toISOString().slice(0, 10);

const rows = (manifest.resources || []).map((r) => ({
  name: r.name,
  usd: Number(r.price_usd),
  route: new URL(r.resource).pathname,
}));
if (!rows.length || rows.some((r) => !r.name || !Number.isFinite(r.usd) || !r.route.startsWith('/api/'))) {
  throw new Error('manifest resources are missing a name, a price_usd or an /api/ route');
}
// Cheapest question last: price descending, then name ascending.
rows.sort((a, b) => b.usd - a.usd || a.name.localeCompare(b.name));

let md = fs.readFileSync(FILE, 'utf8');
const start = md.indexOf('\n## Price index\n');
if (start < 0) throw new Error('no "## Price index" section');
const end = md.indexOf('\n## ', start + 1);
let section = md.slice(start, end < 0 ? md.length : end);

const HEAD = '| Tool | Price | Route |\n|---|---|---|\n';
const t0 = section.indexOf(HEAD);
if (t0 < 0) throw new Error('the Price index table header was not found');
let t1 = t0 + HEAD.length;
while (section.startsWith('| `', t1)) t1 = section.indexOf('\n', t1) + 1;
const table = HEAD + rows.map((r) => `| \`${r.name}\` | $${r.usd} | \`${r.route}\` |`).join('\n') + '\n';
section = section.slice(0, t0) + table + section.slice(t1);

const dated = /read \d{4}-\d{2}-\d{2}( — names, prices and routes are the manifest)/;
if (!dated.test(section)) throw new Error('the "read <date>" line was not found');
section = section.replace(dated, `read ${readDay}$1`);

md = md.slice(0, start) + section + (end < 0 ? '' : md.slice(end));
fs.writeFileSync(FILE, md);

const sum = rows.reduce((n, r) => n + r.usd, 0);
console.log(`price index: ${rows.length} rows from ${MANIFEST}, read ${readDay}, sum $${sum.toFixed(3)}`);
