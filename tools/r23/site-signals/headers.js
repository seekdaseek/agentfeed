// tools/r23/site-signals/headers.js: grade one HTTP response's security headers against the rubric in rubric.js (R23 T6).
// Pure: gradeHeaders(headers) -> { ok, grade, score, max, rubric, findings[] }. `headers` is Node's lower-cased header object. Each rule returns the LEVEL it reaches
// ('full', 'partial' or 'none') and a plain detail; the points come from the rubric table. Nothing here says a site is good or bad: it reports which headers are there.
'use strict';
const { RUBRIC, HSTS_MIN_SECONDS, gradeOf } = require('./rubric');

const cap = (s, n = 300) => { const t = String(s); return t.length > n ? `${t.slice(0, n)}…` : t; };
const first = (v) => String(v).split(',')[0].trim().toLowerCase();

/** a header's value as one string (Node joins repeated headers with ", " except set-cookie), or null */
function val(h, name) {
  const v = h[name];
  if (v == null) return null;
  return Array.isArray(v) ? v.join(', ') : String(v);
}

/** a Content-Security-Policy value -> one Map(directive -> tokens) per policy (commas separate policies; every policy is enforced) */
function parseCsp(raw) {
  return String(raw).split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = new Map();
    for (const d of p.split(';')) {
      const t = d.trim().split(/\s+/).filter(Boolean);
      if (!t.length) continue;
      const name = t[0].toLowerCase();
      if (!m.has(name)) m.set(name, t.slice(1));
    }
    return m;
  }).filter((m) => m.size);
}

const NEUTRALISERS = ["'strict-dynamic'"];
const isNeutraliser = (t) => NEUTRALISERS.includes(t) || t.startsWith("'nonce-") || t.startsWith("'sha256-") || t.startsWith("'sha384-") || t.startsWith("'sha512-");

/** the level one CSP policy reaches for scripts */
function cspPolicyLevel(policy) {
  const src = policy.get('script-src') || policy.get('default-src');
  if (!src) return { level: 'partial', why: 'no script-src or default-src, so scripts are not restricted' };
  const toks = src.map((t) => t.toLowerCase());
  const neutral = toks.some(isNeutraliser);
  const problems = [];
  if (toks.includes("'unsafe-eval'")) problems.push("'unsafe-eval'");
  if (toks.includes('*')) problems.push('a bare *');
  if (toks.includes("'unsafe-inline'") && !neutral) problems.push("'unsafe-inline' without a nonce, hash or 'strict-dynamic'");
  return problems.length ? { level: 'partial', why: `script sources allow ${problems.join(', ')}` } : { level: 'full', why: 'scripts are restricted to listed sources' };
}

const RANK = { none: 0, partial: 1, full: 2 };
const RULES = {
  hsts(h) {
    const v = val(h, 'strict-transport-security');
    if (v == null) return { level: 'none', value: null, detail: 'header absent' };
    const m = /(?:^|;)\s*max-age\s*=\s*"?(\d+)"?/i.exec(v);
    if (!m) return { level: 'none', value: v, detail: 'no max-age in the header' };
    const age = Number(m[1]);
    const flags = [/(?:^|;)\s*includesubdomains\s*(?:;|$)/i.test(v) ? 'includeSubDomains' : null, /(?:^|;)\s*preload\s*(?:;|$)/i.test(v) ? 'preload' : null].filter(Boolean);
    const detail = `max-age ${age} s (${Math.floor(age / 86400)} days)${flags.length ? `; ${flags.join(', ')}` : ''}`;
    if (age >= HSTS_MIN_SECONDS) return { level: 'full', value: v, detail };
    return { level: age > 0 ? 'partial' : 'none', value: v, detail };
  },
  csp(h) {
    const v = val(h, 'content-security-policy');
    if (v == null) return { level: 'none', value: null, detail: val(h, 'content-security-policy-report-only') != null ? 'only a Report-Only policy is sent, which does not block anything' : 'header absent' };
    const policies = parseCsp(v);
    if (!policies.length) return { level: 'none', value: v, detail: 'the header holds no directive' };
    let best = null;
    for (const p of policies) { const r = cspPolicyLevel(p); if (!best || RANK[r.level] > RANK[best.level]) best = r; }
    return { level: best.level, value: v, detail: best.why };
  },
  nosniff(h) {
    const v = val(h, 'x-content-type-options');
    if (v == null) return { level: 'none', value: null, detail: 'header absent' };
    return v.split(',').some((t) => t.trim().toLowerCase() === 'nosniff') ? { level: 'full', value: v, detail: 'nosniff' } : { level: 'none', value: v, detail: 'value is not nosniff' };
  },
  framing(h) {
    const xfo = val(h, 'x-frame-options');
    const csp = val(h, 'content-security-policy');
    if (xfo != null && ['deny', 'sameorigin'].includes(first(xfo))) return { level: 'full', value: xfo, detail: `X-Frame-Options ${first(xfo).toUpperCase()}` };
    if (csp != null) {
      for (const p of parseCsp(csp)) {
        const fa = p.get('frame-ancestors');
        if (fa && fa.length && !(fa.length === 1 && fa[0] === '*')) return { level: 'full', value: `frame-ancestors ${cap(fa.join(' '), 120)}`, detail: 'CSP frame-ancestors directive' };
      }
    }
    if (xfo != null) return { level: 'none', value: xfo, detail: 'X-Frame-Options is not DENY or SAMEORIGIN' };
    return { level: 'none', value: null, detail: csp != null ? 'no X-Frame-Options and no useful frame-ancestors in the CSP' : 'header absent' };
  },
  referrer(h) {
    const v = val(h, 'referrer-policy');
    if (v == null) return { level: 'none', value: null, detail: 'header absent' };
    const known = ['no-referrer', 'no-referrer-when-downgrade', 'same-origin', 'origin', 'strict-origin', 'origin-when-cross-origin', 'strict-origin-when-cross-origin', 'unsafe-url'];
    // the last token a browser recognises wins
    const toks = v.split(',').map((t) => t.trim().toLowerCase());
    let pick = null;
    for (let i = toks.length - 1; i >= 0; i--) if (known.includes(toks[i])) { pick = toks[i]; break; }
    if (!pick) return { level: 'none', value: v, detail: 'no recognised value' };
    const level = ['no-referrer', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin'].includes(pick) ? 'full'
      : ['origin', 'origin-when-cross-origin', 'no-referrer-when-downgrade'].includes(pick) ? 'partial' : 'none';
    return { level, value: v, detail: pick };
  },
  permissions(h) {
    const v = val(h, 'permissions-policy');
    if (v == null) return { level: 'none', value: null, detail: 'header absent' };
    return v.trim() ? { level: 'full', value: v, detail: 'present' } : { level: 'none', value: v, detail: 'empty' };
  },
  coop(h) {
    const v = val(h, 'cross-origin-opener-policy');
    if (v == null) return { level: 'none', value: null, detail: 'header absent' };
    const t = first(v);
    return ['same-origin', 'same-origin-allow-popups', 'noopener-allow-popups'].includes(t) ? { level: 'full', value: v, detail: t } : { level: 'none', value: v, detail: t || 'empty' };
  },
  coep(h) {
    const v = val(h, 'cross-origin-embedder-policy');
    if (v == null) return { level: 'none', value: null, detail: 'header absent' };
    const t = first(v);
    return ['require-corp', 'credentialless'].includes(t) ? { level: 'full', value: v, detail: t } : { level: 'none', value: v, detail: t || 'empty' };
  },
};

/** lower-case the names of a header object (a crafted test set may not) */
function lowerKeys(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[k.toLowerCase()] = v;
  return out;
}

function gradeHeaders(headers) {
  const h = lowerKeys(headers);
  const findings = [];
  let score = 0;
  for (const rule of RUBRIC.rules) {
    const r = RULES[rule.id](h);
    const points = rule.levels[r.level].points;
    score += points;
    findings.push({ id: rule.id, header: rule.header, level: r.level, points, max: rule.points, value: r.value == null ? null : cap(r.value), detail: r.detail });
  }
  return { ok: true, grade: gradeOf(score), score, max: RUBRIC.max, rubric: RUBRIC.id, findings };
}

module.exports = { gradeHeaders, parseCsp, cspPolicyLevel, RULES };
