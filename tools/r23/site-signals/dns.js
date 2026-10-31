// tools/r23/site-signals/dns.js: the DNS records of a site's host name and of its zone (R23 T6).
// A, AAAA and CNAME are the HOST's (www.example.com); NS, MX, TXT (with the SPF and DMARC records named) and CAA are those of its REGISTERED DOMAIN (example.com), because
// that is where a domain's mail and name-server records live. The registered domain is the last two labels, or the last three under a two-letter country domain's usual
// second level (co.uk, com.au): a short built-in list, not the public-suffix list. If that name has no NS records the closest enclosing zone is found by asking for NS
// up the host name instead (at most 3 names, never a bare TLD). Every query has its own timeout; a query that fails on the network is listed in `errors` and does not hide
// the others. TXT values are capped.
'use strict';
const dns = require('dns');

const QUERY_MS = 2500;
const LIST_CAP = 20;
const TXT_CAP = 20;
const TXT_LEN = 200;
const NOT_THERE = new Set(['ENODATA', 'ENOTFOUND', 'NODATA', 'NXDOMAIN']);
const RETRY = new Set(['ETIMEOUT', 'ETIMEDOUT', 'ESERVFAIL']);

let sharedResolver = null;
// R23_SITESIGNALS_DNS_SERVERS (comma-separated IPs) points the queries at named servers; unset, the system's resolvers are used. c-ares asks without EDNS, so an answer over
// 512 bytes (a long TXT set) needs a TCP retry, and a resolver that refuses TCP (some home routers) makes that query time out: it then shows in `errors`, never as "absent".
function defaultResolver(env = process.env) {
  if (!sharedResolver) {
    sharedResolver = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
    const list = String(env.R23_SITESIGNALS_DNS_SERVERS || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (list.length) { try { sharedResolver.setServers(list); } catch { /* an invalid list: keep the system servers */ } }
  }
  return sharedResolver;
}

const withTimeout = (p, ms, what) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(Object.assign(new Error(`${what} timed out`), { code: 'ETIMEOUT' })), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

// the second-level labels under which two-letter country domains take registrations (co.uk, com.au, ac.jp ...); a registered domain is then three labels
const CC_SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'mil', 'nom', 'sch', 'ltd', 'plc', 'nhs', 'police']);

/** the registered domain of a host name: bbc.co.uk for www.bbc.co.uk, cloudflare.com for www.cloudflare.com */
function registeredDomain(host) {
  const l = host.split('.');
  if (l.length <= 2) return host;
  const tld = l[l.length - 1]; const sld = l[l.length - 2];
  return tld.length === 2 && CC_SECOND_LEVEL.has(sld) ? l.slice(-3).join('.') : l.slice(-2).join('.');
}

/** the candidate zone apexes of a host, longest first, at most 3, never fewer than two labels: www.shop.example.com -> www.shop.example.com, shop.example.com, example.com */
function zoneCandidates(host) {
  const labels = host.split('.');
  const out = [];
  for (let i = 0; i <= labels.length - 2 && out.length < 3; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/** -> { ok, host, zone, a, aaaa, cname, ns, mx, txt, spf, dmarc, caa, caa_at, counts, errors } or { ok: false, reason } */
async function dnsSignals(host, { resolver = defaultResolver(), timeoutMs = QUERY_MS } = {}) {
  const errors = [];
  // one query: its records, [] when the name has none, null (and an entry in errors) when the query itself failed
  const attempt = (label, fn, name) => withTimeout(Promise.resolve().then(() => fn.call(resolver, name)), timeoutMs, label);
  const q = async (label, fn, name) => {
    let err;
    try { return await attempt(label, fn, name); } catch (e) { err = e; }
    // a timeout or SERVFAIL is often a moment's slowness (a CDN name with a 2 second TTL): one more try, then the query is reported as failed
    if (RETRY.has(err && err.code)) { try { return await attempt(label, fn, name); } catch (e) { err = e; } }
    if (NOT_THERE.has(err && err.code)) return [];
    errors.push(`${label} ${name}: ${(err && err.code) || (err && err.message) || 'error'}`);
    return null;
  };
  // the registered domain and its NS records; if it has none, the closest enclosing zone found by walking up the host name
  const reg = registeredDomain(host);
  let zone = null; let ns = [];
  const first = await q('NS', resolver.resolveNs, reg);
  if (first && first.length) { zone = reg; ns = first; }
  else if (first !== null) {
    for (const cand of zoneCandidates(host)) {
      if (cand === reg) continue;
      const r = await q('NS', resolver.resolveNs, cand);
      if (r && r.length) { zone = cand; ns = r; break; }
    }
  }
  const zoneName = zone || reg;
  const [a, aaaa, cname, mx, txt, dmarcTxt, caaHost, caaZone] = await Promise.all([
    q('A', resolver.resolve4, host), q('AAAA', resolver.resolve6, host), q('CNAME', resolver.resolveCname, host),
    q('MX', resolver.resolveMx, zoneName), q('TXT', resolver.resolveTxt, zoneName), q('TXT', resolver.resolveTxt, `_dmarc.${zoneName}`),
    zoneName !== host ? q('CAA', resolver.resolveCaa, host) : Promise.resolve(undefined),
    q('CAA', resolver.resolveCaa, zoneName),
  ]);
  return describeDns({ host, zone, zoneName, a, aaaa, cname, ns: first === null ? null : ns, mx, txt, dmarcTxt, caaHost, caaZone, errors });
}

/** pure: the raw answers of the queries (null = the query failed, [] = the name has none) -> the `dns` section */
function describeDns({ host, zone, zoneName, a, aaaa, cname, ns, mx, txt, dmarcTxt, caaHost, caaZone, errors = [] }) {
  const all = [a, aaaa, cname, ns, mx, txt];
  const nothingLearned = all.every((x) => !x || !x.length);
  if (nothingLearned && errors.length) return { ok: false, reason: `DNS queries failed (${errors.slice(0, 3).join('; ')})` };
  if (nothingLearned) return { ok: false, reason: 'no A, AAAA, CNAME, NS, MX or TXT records were found' };

  const txtStrings = (txt || []).map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));
  // null = that query failed (not "the name has none"): SPF and DMARC are then unknown, never reported absent
  const spfRec = txtStrings.find((t) => /^v=spf1(\s|$)/i.test(t)) || null;
  const dmarcRec = (dmarcTxt || []).map((c) => (Array.isArray(c) ? c.join('') : String(c))).find((t) => /^v=DMARC1\b/i.test(t)) || null;
  const dmarcPolicy = dmarcRec ? (((/(?:^|;)\s*p\s*=\s*(none|quarantine|reject)\b/i.exec(dmarcRec) || [])[1] || '').toLowerCase() || null) : null;
  const caaList = caaHost && caaHost.length ? caaHost : (caaZone || []);
  const caaAt = caaHost && caaHost.length ? host : (caaZone && caaZone.length ? zoneName : null);
  const mxList = (mx || []).slice().sort((x, y) => x.priority - y.priority);
  const n = (x) => (x === null || x === undefined ? null : x.length);
  const lower = (list) => (list || []).map((s) => String(s).toLowerCase());
  return {
    ok: true,
    host,
    zone: zone || null,
    zone_queried: zoneName,
    a: (a || []).slice(0, LIST_CAP),
    aaaa: (aaaa || []).slice(0, LIST_CAP),
    cname: lower(cname).slice(0, 5),
    ns: lower(ns).slice(0, LIST_CAP),
    mx: mxList.slice(0, 10).map((m) => ({ exchange: String(m.exchange).toLowerCase(), priority: m.priority })),
    txt: txtStrings.slice(0, TXT_CAP).map((t) => (t.length > TXT_LEN ? `${t.slice(0, TXT_LEN)}…` : t)),
    spf: { present: txt === null ? null : Boolean(spfRec), record: spfRec ? (spfRec.length > 255 ? `${spfRec.slice(0, 255)}…` : spfRec) : null },
    dmarc: { present: dmarcTxt === null ? null : Boolean(dmarcRec), policy: dmarcPolicy },
    caa: caaList.slice(0, 10).map((r) => {
      const tag = ['issue', 'issuewild', 'iodef', 'contactemail', 'contactphone'].find((t) => r && r[t] != null) || 'other';
      return { critical: Boolean(r && r.critical), tag, value: String(r && r[tag] != null ? r[tag] : '').slice(0, 120) };
    }),
    caa_at: caaAt,
    // a count is null when that query failed
    counts: { a: n(a), aaaa: n(aaaa), cname: n(cname), ns: n(ns), mx: n(mx), txt: n(txt), caa: !caaList.length && (caaHost === null || caaZone === null) ? null : caaList.length },
    txt_truncated: txtStrings.length > TXT_CAP,
    errors: errors.slice(0, 8),
  };
}

module.exports = { dnsSignals, describeDns, zoneCandidates, registeredDomain, CC_SECOND_LEVEL, QUERY_MS };
