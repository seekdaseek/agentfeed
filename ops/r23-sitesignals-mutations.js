#!/usr/bin/env node
// ops/r23-sitesignals-mutations.js: negative controls by mutation for T6. For each check the tool relies on, it removes or breaks that one check in the source (a temporary edit
// of this tool's OWN files, restored afterwards and verified by hash), runs the test files, and reports whether a test failed (KILLED) or none did (SURVIVED = the check has no
// test behind it). First every test file is run unmutated and must pass, and every `find` text must exist exactly once (a mutation that matched nothing proves nothing).
//   node ops/r23-sitesignals-mutations.js [--only id[,id...]]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const D = 'tools/r23/site-signals';
const PARSE = 'test/r23-sitesignals-parse.test.js';
const ROUTE = 'test/r23-sitesignals-route.test.js';
const REAL = 'test/r23-sitesignals-real-server.test.js';
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > -1 ? process.argv[i + 1] : null; })();

const M = [
  // ---- the url
  { id: 'url-https-only', file: `${D}/index.js`, find: "checkUrl(s, { httpsOnly: true })", to: 'checkUrl(s, {})', tests: [ROUTE], why: 'http URLs are accepted' },
  { id: 'url-port-rule', file: `${D}/index.js`, find: "if (u.port && u.port !== '443') throw bad('only the standard https port (443) is used');", to: '', tests: [ROUTE], why: 'port 80 on https is accepted' },
  // an IP literal is also stopped by "at least two labels" (IPv6) and "alphabetic TLD" (IPv4): the pair of overlapping rules is mutated together
  { id: 'url-ip-literal', file: `${D}/index.js`, find: "if (net.isIP(host.replace(/^\\[|\\]$/g, ''))) throw bad('url must name a host, not an IP address');", to: '', and: [{ find: "|| !TLD_OK.test(labels[labels.length - 1])", to: '' }, { find: "labels.length < 2 || ", to: '' }], tests: [ROUTE], why: 'public IP literals are accepted (the three overlapping rules removed)' },
  { id: 'url-reserved-names', file: `${D}/index.js`, find: "if (RESERVED.test(host) || !TLD_OK.test(labels[labels.length - 1]))", to: 'if (false)', tests: [ROUTE], why: 'reserved and numeric names are accepted' },
  { id: 'url-single-label', file: `${D}/index.js`, find: "labels.length < 2 || ", to: '', tests: [ROUTE], why: 'single-label names are accepted' },
  { id: 'url-numeric-tld', file: `${D}/index.js`, find: "|| !TLD_OK.test(labels[labels.length - 1])", to: '', tests: [ROUTE], why: 'a numeric last label is accepted' },
  { id: 'preflight-private', file: `${D}/index.js`, find: "if (addrs.some((a) => isPrivate(a.address))) throw bad(", to: 'if (false) throw bad(', tests: [ROUTE, REAL], why: 'a name resolving to a private address is fetched' },
  { id: 'preflight-no-resolve', file: `${D}/index.js`, find: "if (code === 'ENOTFOUND' || code === 'ENODATA') throw unavailable(`${host} does not resolve`, 300);", to: "if (code === 'ENOTFOUND' || code === 'ENODATA') return;", tests: [ROUTE, REAL], why: 'a host that does not resolve gets a charged answer' },
  { id: 'all-failed-503', file: `${D}/index.js`, find: "if (!tlsR.ok && pageFailed) {", to: 'if (false) {', tests: [ROUTE, REAL], why: 'TLS and page both down still gives a (charged) answer' },
  { id: 'rebinding-400', file: `${D}/index.js`, find: "if (tlsR._code === 'EPRIVATE' ||", to: 'if (false ||', tests: [ROUTE], why: 'a host turning private after the first check is not refused' },
  { id: 'strip-internal', file: `${D}/index.js`, find: "if (!k.startsWith('_')) out[k] = v;", to: 'out[k] = v;', tests: [ROUTE], why: 'internal fields leak into the answer' },
  { id: 'clean-url', file: `${D}/index.js`, find: "return `${x.origin}${x.pathname}`;", to: 'return x.href;', tests: [ROUTE], why: 'query strings are echoed in the answer' },
  { id: 'inflight-release', file: `${D}/index.js`, find: "} finally { inflight--; }", to: '} finally { }', tests: [ROUTE], why: 'the concurrency slot is never given back' },
  { id: 'concurrency-limit', file: `${D}/index.js`, find: "if (inflight >= envNum('R23_SITESIGNALS_CONCURRENCY', 3, d.env)) throw", to: 'if (false) throw', tests: [ROUTE], why: 'no concurrency limit' },
  { id: 'section-timeout', file: `${D}/index.js`, find: "const t = setTimeout(() => resolve(onTimeout), ms);", to: 'const t = setTimeout(() => {}, ms);', tests: [ROUTE], why: 'a hanging section holds the answer forever' },
  // ---- the page fetch options
  { id: 'fetch-https-only', file: `${D}/index.js`, find: "accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', httpsOnly: true,", to: "accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',", tests: [ROUTE], why: 'a redirect to http is followed' },
  { id: 'fetch-redirects', file: `${D}/index.js`, find: "maxRedirects: MAX_REDIRECTS,", to: 'maxRedirects: 50,', tests: [ROUTE], why: 'more than 3 redirects are followed' },
  { id: 'fetch-max-bytes', file: `${D}/index.js`, find: "maxBytes: MAX_BYTES, timeoutMs: FETCH_MS,", to: 'maxBytes: 1e12, timeoutMs: FETCH_MS,', tests: [ROUTE], why: 'oversize pages are read' },
  { id: 'fetch-accept-status', file: `${D}/index.js`, find: "acceptStatus: () => true", to: 'acceptStatus: undefined', tests: [ROUTE], why: '4xx/5xx pages lose their headers (page failure)' },
  // ---- TLS
  { id: 'tls-guarded-lookup', file: `${D}/tls.js`, find: "const { connect = tls.connect, lookup = guardedLookup,", to: 'const { connect = tls.connect, lookup = undefined,', tests: [ROUTE], why: 'the TLS socket uses the plain DNS lookup (loopback is reachable)' },
  { id: 'tls-reject-unauthorized', file: `${D}/tls.js`, find: "rejectUnauthorized: false, timeout: timeoutMs", to: 'rejectUnauthorized: true, timeout: timeoutMs', tests: [ROUTE], why: 'a bad certificate cannot be read' },
  { id: 'tls-no-write', file: `${D}/tls.js`, find: "const cert = sock.getPeerCertificate(true);", to: "sock.write('GET / HTTP/1.1\\r\\n\\r\\n'); const cert = sock.getPeerCertificate(true);", tests: [ROUTE, REAL], why: 'an HTTP request is sent over the TLS socket' },
  { id: 'tls-timeout', file: `${D}/tls.js`, find: "const timer = setTimeout(() => finish({ ok: false, reason: 'TLS handshake timed out', _code: 'ETIMEDOUT' }), timeoutMs);", to: 'const timer = setTimeout(() => {}, timeoutMs);', tests: [ROUTE], why: 'a silent server holds the probe' },
  { id: 'tls-private-code', file: `${D}/tls.js`, find: "if (code === 'EPRIVATE') return finish({", to: "if (code === 'NEVER') return finish({", tests: [ROUTE], why: 'a private refusal is not recognised' },
  { id: 'tls-chain-root', file: `${D}/tls.js`, find: "rooted = Boolean(next); break;", to: 'rooted = true; break;', tests: [PARSE], why: 'a chain without its issuer is claimed to end in a root' },
  // ---- header rubric
  { id: 'rubric-hsts-floor', file: `${D}/headers.js`, find: "if (age >= HSTS_MIN_SECONDS) return", to: 'if (age >= 1) return', tests: [PARSE], why: 'any HSTS max-age is full' },
  { id: 'rubric-csp-inline', file: `${D}/headers.js`, find: "if (toks.includes(\"'unsafe-inline'\") && !neutral) problems.push", to: 'if (false) problems.push', tests: [PARSE], why: "'unsafe-inline' is not noticed" },
  { id: 'rubric-csp-neutral', file: `${D}/headers.js`, find: "const NEUTRALISERS = [\"'strict-dynamic'\"];", to: 'const NEUTRALISERS = [];', tests: [PARSE], why: "'strict-dynamic' no longer neutralises 'unsafe-inline'" },
  { id: 'rubric-csp-report-only', file: `${D}/headers.js`, find: "const v = val(h, 'content-security-policy');\n    if (v == null) return { level: 'none'", to: "const v = val(h, 'content-security-policy') || val(h, 'content-security-policy-report-only');\n    if (v == null) return { level: 'none'", tests: [PARSE], why: 'a Report-Only policy counts' },
  { id: 'rubric-nosniff', file: `${D}/headers.js`, find: "t.trim().toLowerCase() === 'nosniff') ? { level: 'full'", to: "t.trim().toLowerCase() !== '') ? { level: 'full'", tests: [PARSE], why: 'any X-Content-Type-Options value is full' },
  { id: 'rubric-framing-star', file: `${D}/headers.js`, find: "!(fa.length === 1 && fa[0] === '*')", to: 'true', tests: [PARSE], why: 'frame-ancestors * counts as protection' },
  { id: 'rubric-referrer-last', file: `${D}/headers.js`, find: "for (let i = toks.length - 1; i >= 0; i--)", to: 'for (let i = 0; i < toks.length; i++)', tests: [PARSE], why: 'the first Referrer-Policy token wins instead of the last' },
  { id: 'rubric-coop', file: `${D}/headers.js`, find: "['same-origin', 'same-origin-allow-popups', 'noopener-allow-popups'].includes(t) ? { level: 'full'", to: "t ? { level: 'full'", tests: [PARSE], why: 'any COOP value is full' },
  { id: 'rubric-weight', file: `${D}/rubric.js`, find: "{ id: 'permissions', header: 'permissions-policy', points: 5, levels: {\n      full: { points: 5,", to: "{ id: 'permissions', header: 'permissions-policy', points: 6, levels: {\n      full: { points: 6,", tests: [PARSE], why: 'the rubric no longer adds up (load-time check)' },
  { id: 'rubric-cutoff', file: `${D}/rubric.js`, find: "{ min: 85, grade: 'A' },", to: "{ min: 80, grade: 'A' },", tests: [PARSE], why: 'the A cut-off moves and the best set is no longer exactly at it' },
  // ---- html, stack, links
  { id: 'html-comments', file: `${D}/html.js`, find: "if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e === -1 ? n : e + 3; continue; }", to: '', tests: [PARSE], why: 'links inside HTML comments are read' },
  { id: 'html-script-body', file: `${D}/html.js`, find: "if (name === 'script' || name === 'style') {", to: 'if (false) {', tests: [PARSE], why: 'links inside script bodies are read' },
  { id: 'html-budget', file: `${D}/html.js`, find: "if (budget < 0) { truncated = true; break; }", to: '', tests: [PARSE], why: 'no step budget on hostile input' },
  { id: 'html-tag-cap', file: `${D}/html.js`, find: "if (kept >= MAX_KEPT) { truncated = true; break; }", to: '', tests: [PARSE], why: 'no cap on the tags kept' },
  { id: 'stack-apache-coyote', file: `${D}/stack-table.js`, find: "^Apache(?:\\/([\\d.]+))?(?!-Coyote)", to: '^Apache(?:\\/([\\d.]+))?', tests: [PARSE], why: 'Apache-Coyote is read as Apache HTTP Server' },
  { id: 'stack-version-cap', file: `${D}/stack.js`, find: "const VERSION_OK = /^[\\w.+\\-]{1,30}$/;", to: 'const VERSION_OK = /./;', tests: [PARSE], why: 'an over-long version is kept' },
  { id: 'links-share-skip', file: `${D}/links.js`, find: "skip: ['intent', 'share',", to: "skip: ['share',", tests: [PARSE], why: 'a tweet-intent link is reported as a profile' },
  { id: 'links-dedupe', file: `${D}/links.js`, find: "if (list.length < CAP && !list.includes(v)) list.push(v);", to: 'if (list.length < CAP) list.push(v);', tests: [PARSE], why: 'duplicates are kept' },
  { id: 'links-cap', file: `${D}/links.js`, find: "if (list.length < CAP && !list.includes(v)) list.push(v);", to: 'if (!list.includes(v)) list.push(v);', tests: [PARSE], why: 'no cap on a list' },
  { id: 'links-host-boundary', file: `${D}/links.js`, find: "host === h || host.endsWith(`.${h}`)", to: 'host === h || host.endsWith(h)', tests: [PARSE], why: 'evilgithub.com counts as github.com' },
  { id: 'links-relative', file: `${D}/links.js`, find: "if (href.length > 600 || !SOCIAL_HREF.test(href)) return;", to: 'if (href.length > 600) return;', tests: [PARSE], why: 'relative links are resolved against the page' },
  // ---- dns, rdap
  { id: 'dns-unknown-not-absent', file: `${D}/dns.js`, find: "present: txt === null ? null : Boolean(spfRec)", to: 'present: Boolean(spfRec)', tests: [PARSE], why: 'a failed TXT query reads as "no SPF"' },
  { id: 'dns-null-count', file: `${D}/dns.js`, find: "const n = (x) => (x === null || x === undefined ? null : x.length);", to: 'const n = (x) => (x || []).length;', tests: [PARSE], why: 'a failed query counts as zero records' },
  { id: 'dns-retry', file: `${D}/dns.js`, find: "if (RETRY.has(err && err.code)) {", to: 'if (false) {', tests: [PARSE], why: 'no retry on a timeout' },
  { id: 'dns-query-timeout', file: `${D}/dns.js`, find: "const t = setTimeout(() => reject(Object.assign(new Error(`${what} timed out`), { code: 'ETIMEOUT' })), ms);", to: 'const t = setTimeout(() => {}, ms);', tests: [PARSE], why: 'a hanging query holds the section' },
  { id: 'dns-registered-domain', file: `${D}/dns.js`, find: "return tld.length === 2 && CC_SECOND_LEVEL.has(sld) ? l.slice(-3).join('.') : l.slice(-2).join('.');", to: "return l.slice(-2).join('.');", tests: [PARSE], why: 'bbc.co.uk is read as co.uk' },
  // ---- the registration-data switch (R23_SITESIGNALS_RDAP, default off)
  { id: 'flag-exact-on', file: `${D}/index.js`, find: "Boolean(env) && env.R23_SITESIGNALS_RDAP === 'on'", to: "!Boolean(env) || env.R23_SITESIGNALS_RDAP !== 'off'", tests: [ROUTE], why: 'registration data is ON by default' },
  { id: 'flag-lenient', file: `${D}/index.js`, find: "Boolean(env) && env.R23_SITESIGNALS_RDAP === 'on'", to: "Boolean(env) && String(env.R23_SITESIGNALS_RDAP).trim().toLowerCase() === 'on'", tests: [ROUTE], why: 'ON, " on" and other spellings switch it on' },
  { id: 'off-asks-registry', file: `${D}/index.js`, find: "if (!rdapEnabled) return { ok: true, dn, dom: null };", to: '', tests: [ROUTE, REAL], why: 'the registry client is asked (and IANA requested) with the switch off' },
  { id: 'off-domain-key', file: `${D}/index.js`, find: "const domainSection = !rdapEnabled ? undefined", to: 'const domainSection = false ? undefined', and: [{ find: 'if (rdapEnabled && domain) out.domain = strip(domain);', to: 'if (domain) out.domain = strip(domain);' }], tests: [ROUTE], why: 'a domain section appears with the switch off (the two overlapping guards removed together)' },
  { id: 'off-text-desc', file: `${D}/index.js`, find: "${on ? 'domain age and expiry, ' : ''}", to: 'domain age and expiry, ', tests: [ROUTE, REAL], why: 'the description speaks of domain age with the switch off' },
  { id: 'off-text-question', file: `${D}/index.js`, find: "${on ? 'domain registration, ' : ''}", to: 'domain registration, ', tests: [ROUTE], why: 'the question speaks of registration with the switch off' },
  { id: 'off-text-tags', file: `${D}/index.js`, find: "...(on ? ['rdap', 'domain-age'] : [])", to: "'rdap', 'domain-age'", tests: [ROUTE], why: 'the tags name RDAP with the switch off' },
  { id: 'off-text-method', file: `${D}/index.js`, find: "(on ? 'Domain: RDAP from the registry the IANA bootstrap lists for the TLD. ' : '')", to: "'Domain: RDAP from the registry the IANA bootstrap lists for the TLD. '", tests: [ROUTE], why: 'the method string describes RDAP with the switch off' },
  { id: 'off-text-method-registered', file: `${D}/index.js`, find: "from its ${on ? 'registered' : 'apex'} domain", to: "from its registered domain", tests: [ROUTE], why: 'the method string says "registered domain" with the switch off' },
  { id: 'on-text-method', file: `${D}/index.js`, find: "(on ? 'Domain: RDAP from the registry the IANA bootstrap lists for the TLD. ' : '')", to: "''", tests: [ROUTE], why: 'the ON method string loses its Domain sentence' },
  { id: 'off-example-domain', file: `${D}/index.js`, find: "domain: rdapEnabled ? describeDomain(", to: 'domain: true ? describeDomain(', and: [{ find: 'if (rdapEnabled && domain) out.domain = strip(domain);', to: 'if (domain) out.domain = strip(domain);' }], tests: [ROUTE], why: 'the example carries a domain section with the switch off' },
  { id: 'server-off-text', file: `${D}/index.js`, find: "const DESC = descText(rdapEnabled);", to: "const DESC = descText(true);", tests: [REAL], why: 'the served description is the ON text on an OFF server' },
  // ---- the real-server preload (a fixture file of this tool): its stubs must answer fixture hosts only
  { id: 'preload-lookup-leak', file: 'test/fixtures/r23/sitesignals/preload.cjs', find: "if (!sc) return realLookup.apply(this, arguments);", to: '', tests: [REAL], why: 'the DNS stub answers a real host (the harness no longer refuses it)' },
  { id: 'preload-tls-leak', file: 'test/fixtures/r23/sitesignals/preload.cjs', find: "if (!sc) return realConnect.apply(this, arguments);", to: '', tests: [REAL], why: 'the TLS stub answers a real host' },
  { id: 'preload-request-leak', file: 'test/fixtures/r23/sitesignals/preload.cjs', find: "if (!reg && !sc) return realRequest.apply(this, arguments);", to: '', tests: [REAL], why: 'the page stub answers a real host' },
  { id: 'preload-resolver-leak', file: 'test/fixtures/r23/sitesignals/preload.cjs', find: "if (!(scenario(n) || n === 'example.com' || n === '_dmarc.example.com')) {", to: 'if (false) {', tests: [REAL], why: 'the Resolver stub answers a real name' },
  { id: 'rdap-https-only', file: `${D}/rdap.js`, find: "const https = svc[1].find((u) => /^https:\\/\\//i.test(String(u)));", to: 'const https = svc[1][0];', tests: [PARSE], why: 'a plain-http registry is used' },
  { id: 'rdap-pace', file: `${D}/rdap.js`, find: "if (free > t) await sleep(free - t);", to: '', tests: [PARSE], why: 'registry queries are not spaced' },
  { id: 'rdap-queue-limit', file: `${D}/rdap.js`, find: "if (free - t > MAX_WAIT_MS) throw", to: 'if (false) throw', tests: [PARSE], why: 'the registry queue is unbounded' },
  { id: 'rdap-name-check', file: `${D}/rdap.js`, find: "if (ldh && ldh !== cand) return", to: 'if (false) return', tests: [PARSE], why: 'a record for another name is accepted' },
  { id: 'rdap-registrant', file: `${D}/rdap.js`, find: "e.roles.map((r) => String(r).toLowerCase()).includes('registrar')", to: "e.roles.map((r) => String(r).toLowerCase()).includes('registrant')", tests: [PARSE], why: 'the registrant is read instead of the registrar' },
  { id: 'rdap-switch', file: `${D}/rdap.js`, find: "if (env.R23_SITESIGNALS_RDAP !== 'on') return emptyDomain(", to: "if (env.R23_SITESIGNALS_RDAP === 'off') return emptyDomain(", tests: [PARSE, ROUTE], why: 'the registry client is ON unless switched off (the old default)' },
  { id: 'rdap-suffix-guard', file: `${D}/rdap.js`, find: "if (parent.length === 2 && parent[1].length === 2 && CC_SECOND_LEVEL.has(parent[0])) return null;", to: '', tests: [PARSE], why: 'the registry is asked about co.uk' },
  { id: 'rdap-404-parent', file: `${D}/rdap.js`, find: "if (r.status === 404) { remember(cand, null); continue; }", to: "if (r.status === 404) { remember(cand, null); return emptyDomain(cand, 'the registry has no record for this name'); }", tests: [PARSE], why: 'a host name below the domain is not retried at its parent' },
];

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const run = (tests) => {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...tests], { cwd: ROOT, encoding: 'utf8', timeout: 90000,
    env: { ...process.env, OVERHANG_DB_PATH: '/Volumes/D/pensio/scratch/overhang.db', AGENTFEED_DB: ':memory:' } });
  const out = (r.stdout || '') + (r.stderr || '');
  const failing = [...new Set((out.match(/^✖ .*$/gm) || []).filter((l) => !/failing tests/.test(l)).map((l) => l.replace(/ \(\d+(\.\d+)?ms\)$/, '').slice(0, 110)))];
  return { code: r.status, failing };
};

const touched = new Map();
const restoreAll = () => { for (const [f, original] of touched) fs.writeFileSync(f, original); touched.clear(); };
process.on('exit', restoreAll);
process.on('SIGINT', () => { restoreAll(); process.exit(130); });

const list = ONLY ? M.filter((m) => ONLY.split(',').includes(m.id)) : M;
console.log(`baseline (unmutated):`);
const baseTests = [...new Set(list.flatMap((m) => m.tests))];
for (const t of baseTests) { const b = run([t]); console.log(`  ${t}: ${b.code === 0 ? 'pass' : 'FAIL'}`); if (b.code !== 0) { console.log(b.failing); process.exit(2); } }
const before = new Map([...new Set(list.map((m) => path.join(ROOT, m.file)))].map((f) => [f, sha(f)]));
const results = [];
for (const m of list) {
  const f = path.join(ROOT, m.file);
  const text = fs.readFileSync(f, 'utf8');
  const count = text.split(m.find).length - 1;
  if (count !== 1) { results.push({ ...m, status: `BAD MUTATION (find text occurs ${count} times)`, failing: [] }); continue; }
  let mutated = text.replace(m.find, () => m.to);
  let bad = false;
  for (const e of m.and || []) { if (mutated.split(e.find).length - 1 !== 1) bad = true; mutated = mutated.replace(e.find, () => e.to); }
  if (bad) { results.push({ ...m, status: 'BAD MUTATION (a second find text is not unique)', failing: [] }); continue; }
  touched.set(f, text);
  fs.writeFileSync(f, mutated);
  const r = run(m.tests);
  restoreAll();
  results.push({ ...m, status: r.code !== 0 ? 'KILLED' : 'SURVIVED', failing: r.failing });
  console.log(`${r.code !== 0 ? 'KILLED  ' : 'SURVIVED'} ${m.id.padEnd(26)} ${m.why}${r.failing.length ? `\n           -> ${r.failing[0]}${r.failing.length > 1 ? ` (+${r.failing.length - 1} more)` : ''}` : ''}`);
}
for (const [f, h] of before) if (sha(f) !== h) { console.error(`NOT RESTORED: ${f}`); process.exit(3); }
const survived = results.filter((r) => r.status !== 'KILLED');
console.log(`\n${results.length - survived.length} of ${results.length} mutations killed; files restored (sha256 verified)`);
for (const s of survived) console.log(`  ${s.status}: ${s.id} (${s.why})`);
process.exit(survived.length ? 1 : 0);
