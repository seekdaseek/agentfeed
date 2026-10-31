// tools/r23/site-signals/rdap.js: when a domain was registered, when it changes and expires, and who the registrar is, from the registry's own RDAP service (R23 T6).
// The registry for a TLD comes from the IANA RDAP bootstrap (https://data.iana.org/rdap/dns.json, kept 24 hours); the domain record from `<registry>/domain/<name>`. Both
// fetches go through lib/safe-fetch.js (https only). A TLD the bootstrap does not list, or lists only over plain http, has no answer here and says so: every data field is
// null and `reason` names why. Only the registration, last-changed and expiry events, the registrar's organisation name and IANA id, the EPP status flags and the name
// servers are kept; registrant and contact records are never read. Registry queries are paced per registry host and answered from a bounded cache.
// docs/SOURCES.md records RDAP as dropped on 13 Oct 2026 (Verisign and PIR terms bar high-volume automated querying), so it is OFF unless R23_SITESIGNALS_RDAP is exactly "on".
// index.js does not call this module at all when it is off; lookup() also refuses on its own, so no request can leave from here without the switch.
'use strict';
const { safeFetch } = require('../../../lib/safe-fetch');
const { CC_SECOND_LEVEL } = require('./dns');

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const UA = 'AgentFeed/1.0 (+https://x402.ochinimus.app; fetches one URL on a caller\'s request)';
const DAY = 86400e3;
const BOOT_TTL_MS = 24 * 3600e3;
const HIT_TTL_MS = 6 * 3600e3;
const MISS_TTL_MS = 3600e3;
const CACHE_CAP = 300;
const RDAP_MAX_BYTES = 1024 * 1024;
const RDAP_TIMEOUT_MS = 8000;
const MAX_WAIT_MS = 5000;

const iso = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

async function defaultFetchJson(url) {
  const r = await safeFetch(url, { maxBytes: RDAP_MAX_BYTES, timeoutMs: RDAP_TIMEOUT_MS, userAgent: UA, accept: 'application/rdap+json, application/json;q=0.9',
    okTypes: ['application/rdap+json', 'application/json'], httpsOnly: true, acceptStatus: (c) => c === 404 || c === 429 });
  let json = null;
  try { json = JSON.parse(r.body.toString('utf8')); } catch { /* an error page that is not JSON */ }
  return { status: r.status, json };
}

/** the IANA bootstrap file -> Map(tld -> https base URL ending in /, or null when only plain http is listed) */
function parseBootstrap(json) {
  if (!json || !Array.isArray(json.services)) throw new Error('the bootstrap file has no services list');
  const m = new Map();
  for (const svc of json.services.slice(0, 5000)) {
    if (!Array.isArray(svc) || !Array.isArray(svc[0]) || !Array.isArray(svc[1])) continue;
    const https = svc[1].find((u) => /^https:\/\//i.test(String(u)));
    const base = https ? (String(https).endsWith('/') ? String(https) : `${https}/`) : null;
    for (const t of svc[0]) m.set(String(t).toLowerCase(), base);
  }
  return m;
}

const emptyDomain = (name, reason, extra = {}) => ({
  ok: false, reason, name, registration: null, last_changed: null, expiry: null, age_days: null, days_to_expiry: null,
  registrar: null, registrar_iana_id: null, status: [], nameservers: [], rdap_server: null, source: 'rdap', ...extra,
});

/** pure: one RDAP domain object -> the `domain` section */
function describeDomain(json, name, { server = null, now = Date.now(), checkedAt = now } = {}) {
  const events = Array.isArray(json.events) ? json.events : [];
  const ev = (...actions) => { const e = events.find((x) => actions.includes(String(x && x.eventAction).toLowerCase())); return e ? iso(e.eventDate) : null; };
  const registration = ev('registration', 'registered');
  const expiry = ev('expiration', 'expiry', 'expires');
  const entities = Array.isArray(json.entities) ? json.entities : [];
  const flat = entities.flatMap((e) => [e, ...(Array.isArray(e && e.entities) ? e.entities : [])]);
  const reg = flat.find((e) => e && Array.isArray(e.roles) && e.roles.map((r) => String(r).toLowerCase()).includes('registrar'));
  let registrar = null; let ianaId = null;
  if (reg) {
    const vc = Array.isArray(reg.vcardArray) && Array.isArray(reg.vcardArray[1]) ? reg.vcardArray[1] : [];
    const fn = vc.find((p) => Array.isArray(p) && p[0] === 'fn');
    if (fn && fn[3]) registrar = String(fn[3]).slice(0, 120);
    const pid = (Array.isArray(reg.publicIds) ? reg.publicIds : []).find((p) => /IANA Registrar ID/i.test(String(p && p.type)));
    if (pid && pid.identifier != null) ianaId = String(pid.identifier).slice(0, 12);
  }
  const ns = [...new Set((Array.isArray(json.nameservers) ? json.nameservers : []).map((n) => String((n && (n.ldhName || n.unicodeName)) || '').toLowerCase()).filter(Boolean))].slice(0, 10);
  const regMs = registration ? Date.parse(registration) : NaN; const expMs = expiry ? Date.parse(expiry) : NaN;
  return {
    ok: true, name,
    registration,
    last_changed: ev('last changed'),
    expiry,
    age_days: Number.isFinite(regMs) ? Math.floor((now - regMs) / DAY) : null,
    days_to_expiry: Number.isFinite(expMs) ? Math.floor((expMs - now) / DAY) : null,
    registrar, registrar_iana_id: ianaId,
    status: (Array.isArray(json.status) ? json.status : []).map((s) => String(s).slice(0, 60)).slice(0, 12),
    nameservers: ns,
    rdap_server: server,
    source: 'rdap',
    checked_at: new Date(checkedAt).toISOString(),
  };
}

/** a cached section with its two day counts worked out again at `t` (the cache keeps the dates, not a count that goes stale) */
function withAges(section, t) {
  const reg = section.registration ? Date.parse(section.registration) : NaN; const exp = section.expiry ? Date.parse(section.expiry) : NaN;
  return { ...section, age_days: Number.isFinite(reg) ? Math.floor((t - reg) / DAY) : null, days_to_expiry: Number.isFinite(exp) ? Math.floor((exp - t) / DAY) : null };
}

/** a parent name to try when `name` has no record of its own (a host name below the registered domain); null at two labels and at a country second level (co.uk) */
const parentOf = (name) => {
  const parent = name.split('.').slice(1);
  if (parent.length < 2) return null;
  // never a public suffix such as co.uk: the registry's answer for it would describe the suffix, not the name asked about
  if (parent.length === 2 && parent[1].length === 2 && CC_SECOND_LEVEL.has(parent[0])) return null;
  return parent.join('.');
};

function makeRdap(opts = {}) {
  const fetchJson = opts.fetchJson || defaultFetchJson;
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const spacingMs = opts.spacingMs == null ? 1000 : opts.spacingMs;
  const env = opts.env || process.env;
  let boot = null; let bootInflight = null;
  const cache = new Map();          // name -> { at, value }  (value: the section, or null for "the registry has no such domain")
  const slots = new Map();          // registry host -> next time a query may go out

  async function bootstrap() {
    if (boot && now() - boot.at < BOOT_TTL_MS) return boot.map;
    if (!bootInflight) {
      bootInflight = (async () => {
        try {
          const r = await fetchJson(BOOTSTRAP_URL);
          if (r.status !== 200) throw new Error(`the IANA bootstrap answered HTTP ${r.status}`);
          boot = { at: now(), map: parseBootstrap(r.json) };
          return boot.map;
        } finally { bootInflight = null; }
      })();
    }
    try { return await bootInflight; } catch (e) {
      if (boot) return boot.map;      // an older copy is better than none
      throw e;
    }
  }

  async function pace(host) {
    const t = now(); const free = Math.max(t, slots.get(host) || 0);
    if (free - t > MAX_WAIT_MS) throw Object.assign(new Error('registry queries are queued; try again shortly'), { code: 'RDAP_BUSY' });
    slots.set(host, free + spacingMs);
    if (slots.size > 64) slots.delete(slots.keys().next().value);
    if (free > t) await sleep(free - t);
  }

  const remember = (name, value) => {
    cache.set(name, { at: now(), value });
    if (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value);
  };

  /** -> the `domain` section for the zone (or the nearest parent the registry knows) */
  async function lookup(zoneName) {
    const name = String(zoneName || '').toLowerCase();
    if (env.R23_SITESIGNALS_RDAP !== 'on') return emptyDomain(name, 'RDAP lookups are not enabled on this instance');
    if (!name || !name.includes('.')) return emptyDomain(name, 'there is no registered domain name to look up');
    let map;
    try { map = await bootstrap(); } catch (e) { return emptyDomain(name, `the IANA RDAP bootstrap could not be read (${String(e.message).slice(0, 100)})`); }
    const tld = name.split('.').pop();
    if (!map.has(tld)) return emptyDomain(name, `no RDAP service is listed for .${tld} in the IANA bootstrap`);
    const base = map.get(tld);
    if (!base) return emptyDomain(name, `only a plain-http RDAP service is listed for .${tld}, and only https is used`);
    const server = new URL(base).host;
    for (let cand = name, tries = 0; cand && tries < 3; cand = parentOf(cand), tries++) {
      const hit = cache.get(cand);
      if (hit && now() - hit.at < (hit.value ? HIT_TTL_MS : MISS_TTL_MS)) { if (hit.value) return withAges(hit.value, now()); continue; }
      try { await pace(server); } catch (e) { return emptyDomain(cand, e.message, { rdap_server: server }); }
      let r;
      try { r = await fetchJson(`${base}domain/${encodeURIComponent(cand)}`); } catch (e) {
        return emptyDomain(cand, `the registry could not be reached (${String(e.message).slice(0, 100)})`, { rdap_server: server });
      }
      if (r.status === 404) { remember(cand, null); continue; }
      if (r.status === 429) return emptyDomain(cand, 'the registry answered HTTP 429 (rate limited)', { rdap_server: server });
      if (r.status !== 200 || !r.json || typeof r.json !== 'object') return emptyDomain(cand, `the registry answered HTTP ${r.status} without a domain record`, { rdap_server: server });
      const ldh = String(r.json.ldhName || '').toLowerCase();
      if (ldh && ldh !== cand) return emptyDomain(cand, 'the registry answered with a record for a different name', { rdap_server: server });
      const section = describeDomain(r.json, cand, { server, now: now(), checkedAt: now() });
      remember(cand, section);
      return section;
    }
    return emptyDomain(name, 'the registry has no record for this name');
  }

  return { lookup, bootstrap, _cache: cache, _slots: slots };
}

module.exports = { makeRdap, describeDomain, parseBootstrap, emptyDomain, BOOTSTRAP_URL };
