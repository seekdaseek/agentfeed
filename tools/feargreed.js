// tools/feargreed.js — alternative.me Fear & Greed index. 30 min cache (spec §2).
const API = 'https://api.alternative.me/fng/?limit=1';

let cached = null; // { at, data }
const CACHE_MS = 30 * 60_000;

async function getFearGreed() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;

  const res = await fetch(API, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`alternative.me ${res.status}`);
  const j = await res.json();

  const d = j?.data?.[0];
  if (!d) throw new Error('alternative.me: empty payload');

  const data = {
    value: Number(d.value),
    classification: d.value_classification,
    timestamp: Number(d.timestamp),
    source: 'alternative.me',
  };
  cached = { at: Date.now(), data };
  return data;
}

module.exports = { getFearGreed };
