// lib/example-cap.js (R32): cap the Bazaar output example that rides in every 402 PAYMENT-REQUIRED header.
//
// Why: the example is base64-encoded into a response HEADER. aiohttp (and other strict HTTP stacks) reject a header value over 8,190 bytes, so a Python agent
// got a client error instead of our 402 (Pitcrew, 24 Nov 2026: /api/oi-spike-scan, 8,312 B). The offers (payTo, amount, network, asset) are the contract and are
// never touched here; the example is documentation, so it is the thing that shrinks.
//
// capExample(example, maxBytes) returns a structurally similar value whose JSON serialization is <= maxBytes: arrays keep their first 2 items, then 1, strings are
// shortened with an ellipsis, objects lose trailing keys only as a last resort, and anything past a depth limit is reduced to an empty container. Numbers, booleans and
// null are kept as they are. It is pure and never mutates its input. A value already within the cap is returned unchanged (same reference).
'use strict';

const MAX_EXAMPLE_BYTES = 600;
const size = (v) => Buffer.byteLength(JSON.stringify(v));

function shrink(v, o, depth) {
  if (typeof v === 'string') return v.length > o.str ? v.slice(0, Math.max(1, o.str - 1)) + '…' : v;
  if (v === null || typeof v !== 'object') return v;
  if (depth >= o.depth) return Array.isArray(v) ? [] : {};
  if (Array.isArray(v)) return v.slice(0, o.arr).map((x) => shrink(x, o, depth + 1));
  const out = {};
  let n = 0;
  for (const k of Object.keys(v)) { if (n >= o.keys) break; out[k] = shrink(v[k], o, depth + 1); n++; }
  return out;
}

// Ordered from gentlest to harshest; the first level that fits wins, so a small example is never degraded more than it has to be.
const LEVELS = [
  { arr: 2, str: 120, depth: 6, keys: 99 },
  { arr: 2, str: 60, depth: 5, keys: 99 },
  { arr: 1, str: 40, depth: 5, keys: 99 },
  { arr: 1, str: 24, depth: 4, keys: 99 },
  { arr: 1, str: 16, depth: 4, keys: 12 },
  { arr: 1, str: 12, depth: 3, keys: 8 },
  { arr: 1, str: 8, depth: 3, keys: 5 },
  { arr: 1, str: 6, depth: 2, keys: 3 },
  { arr: 0, str: 4, depth: 2, keys: 2 },
  { arr: 0, str: 1, depth: 1, keys: 1 },
];

function capExample(example, maxBytes = MAX_EXAMPLE_BYTES) {
  if (example === undefined || example === null) return example;
  if (size(example) <= maxBytes) return example;
  for (const o of LEVELS) { const c = shrink(example, o, 0); if (size(c) <= maxBytes) return c; }
  return {};
}

module.exports = { capExample, MAX_EXAMPLE_BYTES };
