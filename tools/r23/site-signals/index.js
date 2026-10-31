// tools/r23/site-signals/index.js: GET /api/site-signals?url=<https URL> (R23 T6, 31 Oct 2026): the technical facts of one website in one answer.
//   tls      the certificate one handshake to port 443 shows (tls.js)
//   domain   registration, last change, expiry, registrar, status flags and name servers from the registry's RDAP service (rdap.js)
//   dns      A, AAAA, CNAME of the host; NS, MX, TXT (SPF and DMARC named) and CAA of its zone (dns.js)
//   headers  a letter grade for the security headers of the page's response, by the rubric in rubric.js (headers.js)
//   stack    technologies the headers and the markup point to, from the data table in stack-table.js (stack.js)
//   links    the mailto, tel and social-profile links the page links to (links.js)
// Facts only: no verdict on the site. A section that failed while others worked says `ok: false` and why; an answer needs at least the TLS handshake or the page fetch to have
// worked. A bad URL is a 400 thrown before any network call; a site that does not resolve or cannot be reached at all is a 503 "Not charged" (tools/r23/common.js).
// Every URL fetched is the caller's or derived from it, so every fetch goes through lib/safe-fetch.js (https only; 3 redirects, 5 MB, 10 s), and the TLS socket uses its
// guardedLookup. Dependencies come in through the optional second argument so tests inject fakes; the real path needs none.
'use strict';
const dns = require('dns');
const net = require('net');
const { z } = require('zod');
const { safeFetch, checkUrl, isPrivate } = require('../../../lib/safe-fetch');
const { unavailable, bad, envNum } = require('../common');
const { RUBRIC } = require('./rubric');
const { gradeHeaders } = require('./headers');
const { visitTags, attrValue } = require('./html');
const { detectStack, cookieNamesOf, ASSET_CAP, MAX_ASSETS, MAX_GENERATORS } = require('./stack');
const { makeLinkReader } = require('./links');
const { probeTls, describeCert } = require('./tls');
const { dnsSignals, describeDns, QUERY_MS } = require('./dns');
const { makeRdap, describeDomain } = require('./rdap');
const EX = require('./example');

const UA = 'AgentFeed/1.0 (+https://x402.ochinimus.app; fetches one URL on a caller\'s request)';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SCAN = 2 * 1024 * 1024;      // the first 2 MB of a page are read for stack and links (a page is a few hundred KB; this bounds the work on a hostile one)
const FETCH_MS = 10000;
const MAX_REDIRECTS = 3;
const SECTION_MS = 12000;        // no section may hold the answer longer than this
const LOOKUP_MS = 5000;
const MAX_URL = 2048;
const RESERVED = /(?:^|\.)(?:localhost|local|internal|lan|home|corp|invalid|test|example|onion|arpa|intranet|private)$/;
const TLD_OK = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

const withTimeout = (p, ms, onTimeout) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(onTimeout), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); resolve({ ok: false, reason: String((e && e.message) || e).slice(0, 200), _error: e }); });
});

// ---- the URL --------------------------------------------------------------------------------------------------------------------------------------------------------------
/** -> the parsed URL; throws bad() before any network call */
function parseSiteUrl(raw) {
  if (Array.isArray(raw)) throw bad('give one url');
  const s = raw == null ? '' : String(raw).trim();
  if (!s) throw bad('missing required parameter: url (an absolute https URL)');
  if (s.length > MAX_URL) throw bad(`url is longer than ${MAX_URL} characters`);
  const u = checkUrl(s, { httpsOnly: true });                    // http, credentials, ports other than 80/443, private IP literals, localhost-style names
  if (u.port && u.port !== '443') throw bad('only the standard https port (443) is used');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) throw bad('url must name a host, not an IP address');
  const labels = host.split('.');
  if (host.length > 253 || labels.length < 2 || labels.some((l) => !l || l.length > 63)) throw bad('url must name a fully qualified host name such as www.example.com');
  if (RESERVED.test(host) || !TLD_OK.test(labels[labels.length - 1])) throw bad('local, reserved and numeric host names are refused');
  return u;
}
const hostOf = (u) => u.hostname.toLowerCase().replace(/\.$/, '');
const cleanUrl = (href) => { try { const x = new URL(href); return `${x.origin}${x.pathname}`; } catch { return null; } };

// ---- the host must resolve to public addresses ---------------------------------------------------------------------------------------------------------------------------
function defaultLookup(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)));       // dns.lookup: the call guardedLookup makes, so a stub of it reaches both
  });
}
async function preflight(host, lookup) {
  let addrs; let timer;
  try {
    addrs = await Promise.race([lookup(host), new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('lookup timed out'), { code: 'ETIMEDOUT' })), LOOKUP_MS); })]);
    clearTimeout(timer);
  } catch (e) {
    clearTimeout(timer);
    const code = e && e.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') throw unavailable(`${host} does not resolve`, 300);
    throw unavailable(`${host} could not be resolved (${String(code || (e && e.message) || 'error').slice(0, 60)})`, 60);
  }
  if (!Array.isArray(addrs) || !addrs.length) throw unavailable(`${host} does not resolve`, 300);
  if (addrs.some((a) => isPrivate(a.address))) throw bad(`${host} resolves to a private or reserved address`);
}

// ---- the page ------------------------------------------------------------------------------------------------------------------------------------------------------------
function defaultFetchPage(url) {
  return safeFetch(url, { maxBytes: MAX_BYTES, timeoutMs: FETCH_MS, maxRedirects: MAX_REDIRECTS, userAgent: UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', httpsOnly: true, acceptStatus: () => true });
}
const looksHtml = (type, body) => type === 'text/html' || type === 'application/xhtml+xml' || (!type && /<(?:!doctype html|html)\b/i.test(body.subarray(0, 1024).toString('latin1')));

/**
 * pure: one fetched response -> { page, headers, stack, links }. The page is decoded as latin1 (one byte per character, so a 5 MB page is a 5 MB string whatever its language;
 * every attribute this reads is ASCII) and scanned once; the scan keeps only the link lists, up to MAX_ASSETS script and stylesheet URLs and a few generator names.
 */
function analysePage(r, host, requestedClean) {
  const finalClean = cleanUrl(r.url);
  const html = looksHtml(r.contentType, r.body);
  const text = html ? r.body.toString('latin1', 0, Math.min(r.body.length, MAX_SCAN)) : '';
  const reader = makeLinkReader(r.url);
  const facts = { generators: [], assets: [] };
  const clip = (v) => (v.length > ASSET_CAP ? v.slice(0, ASSET_CAP) : v);
  const scan = html ? visitTags(text, (name, raw) => {
    if (name === 'a') reader.read(attrValue(raw, 'href'));
    else if (name === 'script' || name === 'link') {
      if (facts.assets.length < MAX_ASSETS) { const v = attrValue(raw, name === 'script' ? 'src' : 'href'); if (v) facts.assets.push(clip(v)); }
    } else if (name === 'meta' && facts.generators.length < MAX_GENERATORS && String(attrValue(raw, 'name') || '').toLowerCase() === 'generator') {
      const c = attrValue(raw, 'content');
      if (c) facts.generators.push(c.length > 200 ? c.slice(0, 200) : c);
    }
  }) : { truncated: false };
  const server = r.headers && r.headers.server != null ? String(Array.isArray(r.headers.server) ? r.headers.server[0] : r.headers.server).slice(0, 100) : null;
  let finalHost = host; try { finalHost = new URL(r.url).hostname.toLowerCase(); } catch { /* keep the requested host */ }
  return {
    page: {
      ok: true, status: r.status, final_url: finalClean, redirected: finalClean !== requestedClean, host_changed: finalHost !== host,
      content_type: r.contentType || null, bytes: r.body.length, html, server, cookie_names: cookieNamesOf(r.headers), scan_truncated: scan.truncated || (html && r.body.length > MAX_SCAN),
    },
    headers: gradeHeaders(r.headers),
    stack: detectStack({ headers: r.headers, html: text, facts }),
    links: html ? reader.result() : { ok: false, reason: 'the response is not HTML, so there are no links to read' },
  };
}

const strip = (o) => { if (!o || typeof o !== 'object' || Array.isArray(o)) return o; const out = {}; for (const [k, v] of Object.entries(o)) if (!k.startsWith('_')) out[k] = v; return out; };

// ---- registration data (RDAP) is a switch: R23_SITESIGNALS_RDAP=on, read once when the module is loaded -------------------------------------------------------------------
// Off (the default, and any value but exactly "on") the module never calls rdap.js, so no request goes to IANA or to a registry; the answer has no `domain` section; and every
// piece of public text (description, question, tags, the `method` string, the example) is built WITHOUT a word about registration data. The text is derived from the flag here, never
// edited by hand. `create(env)` builds the flag-dependent parts, so a test can build both states; the module's own exports are create(process.env).
const rdapOn = (env) => Boolean(env) && env.R23_SITESIGNALS_RDAP === 'on';

const methodText = (on) => `TLS: one handshake to port 443, the certificate is read without validating it and nothing is sent over that socket. DNS: the system resolver, ${QUERY_MS / 1000} s per query, host records from the host, name-server, mail, text and CAA records from its ${on ? 'registered' : 'apex'} domain. `
  + (on ? 'Domain: RDAP from the registry the IANA bootstrap lists for the TLD. ' : '')
  + `Page: one GET of the URL over https (at most ${MAX_REDIRECTS} redirects, ${MAX_BYTES / 1048576} MB, ${FETCH_MS / 1000} s; robots.txt is not read); the first ${MAX_SCAN / 1048576} MB of the page are read for stack and links. `
  + `Header grade: rubric ${RUBRIC.id}, ${RUBRIC.rules.length} checks, ${RUBRIC.max} points. Stack and links: markers in the response headers and the markup, hints and not proof. Facts only; the answer judges nothing.`;

const descText = (on) => `Use when an agent needs the technical facts of one website. Returns its TLS certificate, ${on ? 'domain age and expiry, ' : ''}DNS records, a security-header grade over ${RUBRIC.rules.length} checks, tech stack and social links. A bad URL (400) or unreachable site (503) is not charged.`;
const questionText = (on) => `What do one website's TLS certificate, ${on ? 'domain registration, ' : ''}DNS records, security headers, technology markers and contact links show?`;
const tagList = (on) => ['website', 'tls', 'certificate', 'dns', ...(on ? ['rdap', 'domain-age'] : []), 'security-headers', 'tech-stack', 'infrastructure'];

let inflight = 0;     // shared by every instance made by create(): the limit is on the process, not on a test's copy

function create(env = process.env) {
  const rdapEnabled = rdapOn(env);
  const METHOD = methodText(rdapEnabled);
  const DESC = descText(rdapEnabled);
  let rdapInstance = null;
  const rdapDefault = () => rdapInstance || (rdapInstance = makeRdap({ env }));

  /** the answer object from the sections; the same function builds the constructed example. `domain` is undefined when registration data is off, and then there is no such key */
  function assemble({ u, host, now, page, tls, domain, dns: dnsSection, headers, stack, links }) {
    const out = { url: cleanUrl(u.href || u), host, page, tls: strip(tls) };
    if (rdapEnabled && domain) out.domain = strip(domain);
    return Object.assign(out, { dns: strip(dnsSection), headers, stack, links, fetched_at: new Date(now).toISOString(), method: METHOD });
  }

  /**
   * @param {{url?: string}} args  the merged query
   * @param {object} [deps]  now, lookup(host) -> addresses, probeTls(host, opts), fetchPage(url), dnsSignals(host), rdap { lookup(zone) } (used only when the switch is on), sectionMs, env (concurrency)
   */
  async function getSiteSignals(args, deps = {}) {
    const d = { now: Date.now, lookup: defaultLookup, probeTls, fetchPage: defaultFetchPage, dnsSignals, rdap: null, env: process.env, ...deps };
    const u = parseSiteUrl(args && args.url);                       // 400 before anything else
    const host = hostOf(u);
    const requestedClean = cleanUrl(u.href);
    if (inflight >= envNum('R23_SITESIGNALS_CONCURRENCY', 3, d.env)) throw unavailable('too many site checks are running at once', 5);
    inflight++;
    try {
      await preflight(host, d.lookup);                              // 400 for a private address, 503 for a name that does not resolve
      const sectionMs = d.sectionMs || SECTION_MS;
      let [tlsR, pageR, dnsR] = await Promise.all([
        withTimeout(Promise.resolve().then(() => d.probeTls(host, { now: d.now })), sectionMs, { ok: false, reason: 'TLS handshake timed out', _code: 'ETIMEDOUT' }),
        withTimeout(Promise.resolve().then(() => d.fetchPage(u.href)).then((r) => ({ ok: true, r })), sectionMs, { ok: false, reason: 'the page fetch timed out' }),
        withTimeout((async () => {
          const dn = await d.dnsSignals(host);
          if (!rdapEnabled) return { ok: true, dn, dom: null };
          const zone = dn.ok ? (dn.zone || dn.zone_queried) : host.split('.').slice(-2).join('.');
          const dom = await (d.rdap || rdapDefault()).lookup(zone);
          return { ok: true, dn, dom };
        })(), sectionMs, { ok: false, reason: rdapEnabled ? 'the DNS and registry lookups timed out' : 'the DNS lookups timed out' }),
      ]);

      // the host the caller named turned out private after the first check (rebinding): refuse, as the up-front check would have
      const privateRefusal = (e) => e && typeof e.message === 'string' && e.message.startsWith(`refused: ${host} `);
      if (tlsR._code === 'EPRIVATE' || (pageR._error && privateRefusal(pageR._error))) throw bad(`${host} resolves to a private or reserved address`);

      let analysed = null;
      if (pageR.ok) {
        try { analysed = analysePage(pageR.r, host, requestedClean); } catch (e) { pageR = { ok: false, reason: `the page could not be read (${String((e && e.message) || e).slice(0, 100)})` }; }
      }
      const pageFailed = !pageR.ok;
      if (!tlsR.ok && pageFailed) {
        throw unavailable(`could not reach ${host} (TLS: ${tlsR.reason}; page: ${pageR.reason})`.slice(0, 300), 120);
      }
      const why = pageFailed ? `the page could not be fetched (${pageR.reason})` : null;
      const dnsSection = dnsR.ok ? dnsR.dn : { ok: false, reason: dnsR.reason };
      const domainSection = !rdapEnabled ? undefined
        : dnsR.ok ? dnsR.dom : { ok: false, reason: dnsR.reason, name: null, registration: null, last_changed: null, expiry: null, age_days: null, days_to_expiry: null, registrar: null, registrar_iana_id: null, status: [], nameservers: [], rdap_server: null, source: 'rdap' };
      return assemble({
        u, host, now: d.now(),
        page: analysed ? analysed.page : { ok: false, reason: pageR.reason },
        tls: tlsR, domain: domainSection, dns: dnsSection,
        headers: analysed ? analysed.headers : { ok: false, reason: why },
        stack: analysed ? analysed.stack : [],
        links: analysed ? analysed.links : { ok: false, reason: why },
      });
    } finally { inflight--; }
  }

  // ---- the constructed example: the same builders, over synthetic inputs, in the same state as the route ---------------------------------------------------------------------
  function buildExample() {
    const u = new URL(EX.URL);
    const host = hostOf(u);
    const r = { url: EX.URL, status: 200, contentType: 'text/html', headers: EX.HEADERS, body: Buffer.from(EX.HTML) };
    const a = analysePage(r, host, cleanUrl(EX.URL));
    return assemble({
      u, host, now: EX.NOW, page: a.page,
      tls: describeCert({ cert: EX.CERT, ...EX.SOCKET, now: EX.NOW }),
      domain: rdapEnabled ? describeDomain(EX.RDAP, 'example.com', { server: 'rdap.registry.example', now: EX.NOW, checkedAt: EX.NOW }) : undefined,
      dns: describeDns(EX.DNS_RAW), headers: a.headers, stack: a.stack, links: a.links,
    });
  }

  // ---- the route entry ------------------------------------------------------------------------------------------------------------------------------------------------------
  const entries = [
    { name: 'get_site_signals', route: 'GET /api/site-signals', usd: 0.02,
      tags: tagList(rdapEnabled),
      desc: DESC,
      schema: { url: z.string().describe('the site: an absolute https URL on the standard port, for example https://www.example.com/ (a host name, not an IP address)') },
      title: 'Site signals',
      question: questionText(rdapEnabled),
      example: buildExample(),
      run: async (args) => getSiteSignals(args) },
  ];

  return { entries, getSiteSignals, assemble, buildExample, METHOD, DESC, rdapEnabled };
}

module.exports = { ...create(process.env), create, rdapOn, parseSiteUrl, analysePage, preflight, defaultFetchPage, UA, MAX_BYTES, FETCH_MS, _inflight: () => inflight };
