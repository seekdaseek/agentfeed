// tools/briefs/engine.js: the shared parts of the pensio briefs. A brief is deterministic text: every sentence is a template filled from numbers
// AgentFeed already holds, so it cannot invent anything and costs nothing per call (no language model).
//
// ONE ENVELOPE (every brief): { brief, as_of, window, headline, items[], sources[], stale_parts[], method }.
//   items[]       { what, why_it_matters, level_to_watch?, numbers, source, as_of, abnormality }, most abnormal first
//   sources[]     { name, as_of, age_s } of every part that was used
//   stale_parts[] { part, reason } of every part that was too old or missing: its value is null in the items and is never served as fresh
// A brief whose core cannot be built answers 503 + Retry-After ("Not charged."): x402 (all rails) and the key rail cancel on >= 400.
'use strict';

const iso = (ms) => new Date(ms).toISOString();

/** 503 with Retry-After, the contract signals.js / lib/tool.js use */
const unavailable = (msg, retryAfter = 60) => Object.assign(new Error(`${msg} Not charged.`), { status: 503, retryAfter });

const finite = (x, what) => { if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`brief template: ${what || 'value'} is not a finite number (${x})`); return x; };

// ---- number formatting for templates (pure; a non-finite input throws, so a template bug is a 500 and never a sentence with "NaN" in it) ----
function usd(n) {
  finite(n, 'usd');
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${s}$${Math.round(a / 1e3)}k`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}k`;
  return `${s}$${Math.round(a)}`;
}
const pct = (n, d = 1) => { finite(n, 'pct'); const v = Number(n.toFixed(d)); return `${v > 0 ? '+' : ''}${v.toFixed(d)}%`; };
const pctAbs = (n, d = 1) => `${Math.abs(finite(n, 'pct')).toFixed(d)}%`;
/** a price to 5 significant figures, with thousands separators when large */
function px(n) {
  finite(n, 'price');
  if (n === 0) return '0';
  const dec = Math.max(0, 4 - Math.floor(Math.log10(Math.abs(n))));
  return Number(n.toFixed(Math.min(dec, 8))).toLocaleString('en-US', { maximumFractionDigits: Math.min(dec, 8) });
}
const num = (n, d = 1) => finite(n, 'number').toFixed(d);
const clock = (ms) => `${iso(ms).slice(11, 16)} UTC`;
const r = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : Number(n.toFixed(d)));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const k = s.length; return k ? (k % 2 ? s[(k - 1) / 2] : (s[k / 2 - 1] + s[k / 2]) / 2) : null; };
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs) => { if (xs.length < 2) return null; const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)); };

/**
 * Changes over `secs` of one numeric series [{ ts (s), ...key }], stepping `stepS` through the series; the window ending at the newest sample
 * is left out (it is the thing being judged). -> array of fractional changes. A baseline sample more than `tolS` behind the target is a gap and skipped.
 */
function windowChanges(rows, key, secs, { stepS = 3600, tolS = 600 } = {}) {
  const out = [];
  if (!rows || rows.length < 2) return out;
  const last = rows[rows.length - 1].ts;
  let j = 0;
  let nextTs = rows[0].ts + secs;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].ts > last - secs) break;
    if (rows[i].ts < nextTs) continue;
    nextTs = rows[i].ts + stepS;
    const want = rows[i].ts - secs;
    while (j + 1 < rows.length && rows[j + 1].ts <= want) j++;
    if (rows[j].ts <= want && want - rows[j].ts <= tolS && rows[j][key] > 0 && rows[i][key] != null) out.push(rows[i][key] / rows[j][key] - 1);
  }
  return out;
}

/** A template result must read as a sentence: no NaN, undefined, null or object leaks. Throws (a 500, never billed) when one does. */
function clean(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('brief template: empty text');
  if (/NaN|undefined|Infinity|\[object|\bnull\b/.test(text)) throw new Error(`brief template: leaked a non-value into "${text.slice(0, 120)}"`);
  return text;
}

/** The parts of one brief: what was read, what was stale. take() never throws; the part is simply absent and named in stale_parts. */
function collector(nowMs) {
  const sources = [];
  const stale = [];
  return {
    sources, stale,
    /** a part the caller read itself (a core that throws on its own): record it as used */
    use(name, asOfMs) { sources.push({ name, as_of: iso(asOfMs), age_s: Math.max(0, Math.round((nowMs - asOfMs) / 1000)) }); },
    /** fn() -> { value, as_of_ms, name? }; maxAgeS = this part's own limit. Returns the value, or null (and records why). */
    async take(part, maxAgeS, fn) {
      let got;
      try { got = await fn(); } catch (e) { stale.push({ part, reason: String((e && e.message) || e).replace(/\s*Not charged\.?$/, '').slice(0, 200) }); return null; }
      if (!got || got.value == null) { stale.push({ part, reason: 'no data' }); return null; }
      const age = Math.max(0, Math.round((nowMs - got.as_of_ms) / 1000));
      if (maxAgeS != null && age > maxAgeS) { stale.push({ part, reason: `${age}s old (limit ${maxAgeS}s)` }); return null; }
      sources.push({ name: got.name || part, as_of: iso(got.as_of_ms), age_s: age });
      return got.value;
    },
  };
}

/** Compose the envelope. Items are ordered by abnormality, most abnormal first (ties by text, so the order is stable). */
function envelope({ brief, now, window, items, col, method, emptyHeadline, extra = {} }) {
  const ordered = items.map((it) => {
    const o = {
      // `what_template` is the part of `what` that is OUR template; the rest is a third party's own text (a release title), which is data and is not leak-checked
      what: it.what_template ? (clean(it.what_template), String(it.what)) : clean(it.what), why_it_matters: clean(it.why_it_matters),
      ...(it.level_to_watch ? { level_to_watch: it.level_to_watch } : {}),
      numbers: it.numbers, source: it.source, as_of: it.as_of, abnormality: r(it.abnormality, 2),
    };
    if (o.abnormality == null) throw new Error('brief template: item without an abnormality score');
    return o;
  }).sort((a, b) => b.abnormality - a.abnormality || a.what.localeCompare(b.what));
  return {
    brief, as_of: iso(now), window,
    headline: ordered.length ? ordered[0].what : clean(emptyHeadline),
    items: ordered,
    sources: col.sources, stale_parts: col.stale,
    method,
    ...extra,
  };
}

/** The level to watch from signals.js clusters ({ above, below }): the nearer band, with its sentence. null when neither exists. */
function levelOf(cl, mark) {
  const cands = [['above', cl && cl.above], ['below', cl && cl.below]].filter(([, c]) => c && Number.isFinite(c.distance_pct));
  if (!cands.length) return null;
  const [side, c] = cands.sort((a, b) => Math.abs(a[1].distance_pct) - Math.abs(b[1].distance_pct))[0];
  return {
    kind: 'liquidation_cluster', side_of_price: side, price_low: c.price_low, price_high: c.price_high, distance_pct: c.distance_pct, usd_24h: c.usd,
    text: clean(`Nearest liquidation cluster ${side} the mark of ${px(mark)}: ${px(c.price_low)} to ${px(c.price_high)} (${pct(c.distance_pct)} away), where ${usd(c.usd)} was liquidated in the last 24 hours.`),
  };
}

/** words a brief must never contain: it describes what moved, never what to trade (tested over every template) */
const TRADE_CALL = /\b(buy|sell|bought|sold|accumulate|go long|go short|should (long|short)|enter (a )?(long|short)|take profit|stop[- ]loss|bullish|bearish|recommend)/i;

module.exports = { iso, unavailable, finite, usd, pct, pctAbs, px, num, clock, r, median, mean, sd, windowChanges, levelOf, clean, collector, envelope, TRADE_CALL };
