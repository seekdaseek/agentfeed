#!/usr/bin/env node
// ops/r23-sitesignals-gate.js: the T6 gate. Runs get_site_signals (the real code, the real network) on 10 fixed public sites and compares what it says with a MANUAL check made
// by other programs: openssl s_client / x509, dig, curl and jq against the registry's RDAP service. Prints a PASS/FAIL table per cell and the commands used.
//
//   node ops/r23-sitesignals-gate.js [--fresh] [--only host]      (from the repo root; exit code 1 if any cell fails)
//
// The domain (RDAP) cells need R23_SITESIGNALS_RDAP=on, which this script sets for itself; the shipped default is off and then those cells are not served (the other cells are unaffected).
// Everything fetched is cached in /Volumes/D/r23/cache/sitesignals/ (the tool's answer per site in tool/, each manual command's output in manual/): a re-run reads the cache and
// makes 0 calls; --fresh deletes nothing and re-fetches into new files. DNS goes to one resolver, 1.1.1.1, for BOTH the tool and dig: this Mac's router (a Resolver on 192.168.0.1)
// cannot do the TCP retry c-ares needs for an answer over 512 bytes, so a long TXT set times out there and is reported by the tool as unknown (see the notes).
'use strict';
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { spawnSync } = require('child_process');
const SSM = require('../tools/r23/site-signals');
const SS = SSM.create({ R23_SITESIGNALS_RDAP: 'on' });          // the registration (domain) cells are checked with the switch ON; the shipped default is off, which serves none of them
const UA_TOOL = SSM.UA;
const { dnsSignals } = require('../tools/r23/site-signals/dns');
const { RUBRIC } = require('../tools/r23/site-signals/rubric');

const CACHE = process.env.R23_SITESIGNALS_CACHE || '/Volumes/D/r23/cache/sitesignals';
const FRESH = process.argv.includes('--fresh');
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > -1 ? process.argv[i + 1] : null; })();
const RESOLVER = '1.1.1.1';
const UA = UA_TOOL;
const OSSL_DEFAULT = 'openssl';                                                                // the brief's command: /usr/bin/openssl (LibreSSL on this Mac)
const OSSL_NEW = fs.existsSync('/opt/homebrew/bin/openssl') ? '/opt/homebrew/bin/openssl' : 'openssl';   // for -ext, the negotiated protocol and standard cipher names

const SITES = [
  { url: 'https://github.com/', zone: 'github.com' },
  { url: 'https://www.cloudflare.com/', zone: 'cloudflare.com' },
  { url: 'https://www.wikipedia.org/', zone: 'wikipedia.org' },
  { url: 'https://www.python.org/', zone: 'python.org' },
  { url: 'https://nginx.org/', zone: 'nginx.org' },
  { url: 'https://example.com/', zone: 'example.com' },
  { url: 'https://www.mozilla.org/', zone: 'mozilla.org' },
  { url: 'https://www.bbc.co.uk/', zone: 'bbc.co.uk' },
  { url: 'https://istio.io/', zone: 'istio.io' },
  { url: 'https://web.dev/', zone: 'web.dev' },
].map((s) => ({ ...s, host: new URL(s.url).hostname, tld: s.zone.split('.').pop() }));

for (const d of ['tool', 'manual']) fs.mkdirSync(path.join(CACHE, d), { recursive: true });
const COMMANDS = [];       // the command templates actually used, for the report
let calls = 0;

/** run a shell command (cached by name); returns stdout. The command text is recorded once per template. */
function manual(host, name, cmd, template) {
  const file = path.join(CACHE, 'manual', `${host}.${name}.txt`);
  if (template && !COMMANDS.some((c) => c.name === name)) COMMANDS.push({ name, cmd: template });
  if (!FRESH && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  calls++;
  const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const out = r.stdout || '';
  fs.writeFileSync(file, out);
  return out;
}
const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const ms = (s) => Date.parse(String(s).replace(/\s+/g, ' ').trim());

// ---- the tool, cached ----------------------------------------------------------------------------------------------------------------------------------------------------
async function runTool(site) {
  const file = path.join(CACHE, 'tool', `${site.host}.json`);
  if (!FRESH && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  calls++;
  const r = new dns.promises.Resolver({ timeout: 2500, tries: 2 });
  r.setServers([RESOLVER]);
  const out = await SS.getSiteSignals({ url: site.url }, { dnsSignals: (h) => dnsSignals(h, { resolver: r }) });
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  return out;
}

// ---- the independent header scorer: raw curl text -> the level of each rule. Written from the rubric TABLE, not from headers.js ------------------------------------------------
function curlHeaders(raw) {
  // the last response block (after any redirects); name -> value, repeated names joined with ", "
  const blocks = raw.replace(/\r/g, '').split(/\n\n+/).filter((b) => /^HTTP\//.test(b.trim()));
  const last = blocks[blocks.length - 1] || '';
  const h = {};
  for (const ln of last.split('\n').slice(1)) { const i = ln.indexOf(':'); if (i > 0) { const k = ln.slice(0, i).trim().toLowerCase(); h[k] = h[k] ? `${h[k]}, ${ln.slice(i + 1).trim()}` : ln.slice(i + 1).trim(); } }
  return { status: Number((/^HTTP\/\S+\s+(\d+)/.exec(last) || [])[1]) || null, h };
}
function manualLevels(h) {
  const L = {};
  const hsts = (h['strict-transport-security'] || '').match(/max-age=\W*(\d+)/i);
  L.hsts = !hsts ? 'none' : Number(hsts[1]) >= 15552000 ? 'full' : Number(hsts[1]) > 0 ? 'partial' : 'none';
  const cspRaw = h['content-security-policy'];
  if (!cspRaw || !cspRaw.trim()) L.csp = 'none';
  else {
    const levels = cspRaw.split(',').map((pol) => {
      const dirs = pol.split(';').map((x) => x.trim().split(/\s+/));
      const script = dirs.find((d) => d[0].toLowerCase() === 'script-src') || dirs.find((d) => d[0].toLowerCase() === 'default-src');
      if (!script) return 'partial';
      const t = script.slice(1).join(' ').toLowerCase();
      const neutral = /'strict-dynamic'|'nonce-|'sha(256|384|512)-/.test(t);
      const weak = t.includes("'unsafe-eval'") || /(^|\s)\*(\s|$)/.test(t) || (t.includes("'unsafe-inline'") && !neutral);
      return weak ? 'partial' : 'full';
    });
    L.csp = levels.includes('full') ? 'full' : 'partial';
  }
  L.nosniff = /nosniff/i.test(h['x-content-type-options'] || '') ? 'full' : 'none';
  const xfo = (h['x-frame-options'] || '').trim().toLowerCase().split(',')[0].trim();
  const fa = /frame-ancestors\s+([^;,]+)/i.exec(cspRaw || '');
  L.framing = (xfo === 'deny' || xfo === 'sameorigin') || (fa && fa[1].trim() !== '*') ? 'full' : 'none';
  const rp = (h['referrer-policy'] || '').toLowerCase().split(',').map((x) => x.trim()).filter((x) => ['no-referrer', 'no-referrer-when-downgrade', 'same-origin', 'origin', 'strict-origin', 'origin-when-cross-origin', 'strict-origin-when-cross-origin', 'unsafe-url'].includes(x)).pop();
  L.referrer = ['no-referrer', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin'].includes(rp) ? 'full' : ['origin', 'origin-when-cross-origin', 'no-referrer-when-downgrade'].includes(rp) ? 'partial' : 'none';
  L.permissions = (h['permissions-policy'] || '').trim() ? 'full' : 'none';
  L.coop = ['same-origin', 'same-origin-allow-popups', 'noopener-allow-popups'].includes((h['cross-origin-opener-policy'] || '').trim().toLowerCase().split(',')[0].trim()) ? 'full' : 'none';
  L.coep = ['require-corp', 'credentialless'].includes((h['cross-origin-embedder-policy'] || '').trim().toLowerCase().split(',')[0].trim()) ? 'full' : 'none';
  return L;
}
const POINTS = { hsts: [30, 15], csp: [25, 12], nosniff: [10], framing: [10], referrer: [10, 5], permissions: [5], coop: [5], coep: [5] };   // typed here from the rubric table in the notes, not imported
const scoreOf = (L) => Object.entries(L).reduce((a, [k, lv]) => a + (lv === 'full' ? POINTS[k][0] : lv === 'partial' ? POINTS[k][1] : 0), 0);
const gradeOfScore = (n) => (n >= 85 ? 'A' : n >= 70 ? 'B' : n >= 50 ? 'C' : n >= 30 ? 'D' : 'F');

// ---- the comparison --------------------------------------------------------------------------------------------------------------------------------------------------------
const rows = [];       // { site, group, check, tool, manual, pass }
const cell = (site, group, check, tool, man, pass) => rows.push({ site, group, check, tool: String(tool), manual: String(man), pass: Boolean(pass) });
const fieldOf = (text, key) => { const m = new RegExp(`(?:^|[/,\\s])${key}\\s*=\\s*([^/,\\n]+)`).exec(text); return m ? m[1].trim() : null; };

async function check(site) {
  const t = await runTool(site);
  const H = site.host; const Z = site.zone;
  // ---- TLS
  const x509 = manual(H, 'x509', `${OSSL_DEFAULT} s_client -connect ${H}:443 -servername ${H} </dev/null 2>/dev/null | ${OSSL_DEFAULT} x509 -noout -issuer -subject -dates -serial -fingerprint -sha256`,
    `openssl s_client -connect HOST:443 -servername HOST </dev/null 2>/dev/null | openssl x509 -noout -issuer -subject -dates -serial -fingerprint -sha256`);
  const issuer = (/^issuer=?(.*)$/m.exec(x509) || [])[1] || '';
  const subject = (/^subject=?(.*)$/m.exec(x509) || [])[1] || '';
  const nb = (/^notBefore=(.*)$/m.exec(x509) || [])[1]; const na = (/^notAfter=(.*)$/m.exec(x509) || [])[1];
  const tls = t.tls;
  cell(H, 'tls', 'issuer organization', tls.issuer.organization, issuer.trim(), tls.ok && issuer.includes(tls.issuer.organization));
  cell(H, 'tls', 'issuer common name', tls.issuer.common_name, issuer.trim(), tls.ok && issuer.includes(tls.issuer.common_name));
  cell(H, 'tls', 'subject CN', tls.subject.common_name, subject.trim(), tls.ok && subject.includes(tls.subject.common_name));
  cell(H, 'tls', 'notBefore', tls.valid_from, nb, tls.ok && Date.parse(tls.valid_from) === ms(nb));
  cell(H, 'tls', 'notAfter', tls.valid_to, na, tls.ok && Date.parse(tls.valid_to) === ms(na));
  const serialM = ((/^serial=(.*)$/m.exec(x509) || [])[1] || '').trim().toUpperCase();
  cell(H, 'tls', 'serial', tls.serial_number, serialM, tls.ok && String(tls.serial_number).toUpperCase().replace(/^0+/, '') === serialM.replace(/^0+/, ''));
  const fp = ((/Fingerprint=(.*)$/m.exec(x509) || [])[1] || '').trim().toUpperCase();
  cell(H, 'tls', 'sha256 fingerprint', String(tls.fingerprint_sha256).slice(0, 23) + '…', fp.slice(0, 23) + '…', tls.ok && tls.fingerprint_sha256.toUpperCase() === fp);
  const ext = manual(H, 'san', `${OSSL_DEFAULT} s_client -connect ${H}:443 -servername ${H} </dev/null 2>/dev/null | ${OSSL_NEW} x509 -noout -ext subjectAltName`,
    `openssl s_client -connect HOST:443 -servername HOST </dev/null 2>/dev/null | $OPENSSL_4 x509 -noout -ext subjectAltName`);
  const sanCount = (ext.match(/(DNS|IP Address|email|URI):/g) || []).length;
  cell(H, 'tls', 'SAN count', tls.sans.count, sanCount, tls.ok && tls.sans.count === sanCount);
  const sent = manual(H, 'chain', `${OSSL_DEFAULT} s_client -connect ${H}:443 -servername ${H} -showcerts </dev/null 2>/dev/null | grep -c 'BEGIN CERTIFICATE'`,
    `openssl s_client -connect HOST:443 -servername HOST -showcerts </dev/null 2>/dev/null | grep -c 'BEGIN CERTIFICATE'   (certificates the server SENT)`);
  const sentN = Number(sent.trim());
  // the tool's chain is what Node can link, which includes the root from Node's own store when the server did not send it: sent, or sent + 1 when the last sent one is not self-signed
  const chainSubj = manual(H, 'chain-self', `${OSSL_DEFAULT} s_client -connect ${H}:443 -servername ${H} -showcerts </dev/null 2>/dev/null | grep -E '^ *[0-9]+ s:|^ *i:'`,
    `openssl s_client -connect HOST:443 -servername HOST -showcerts </dev/null 2>/dev/null | grep -E '^ *[0-9]+ s:|^ *i:'   (is the last SENT certificate self-signed?)`);
  const cl = lines(chainSubj); const lastS = (cl[cl.length - 2] || '').replace(/^\s*\d+\s+s:/, '').trim(); const lastI = (cl[cl.length - 1] || '').replace(/^i:/, '').trim();
  const lastSelf = lastS !== '' && lastS === lastI;
  // the tool counts the certificates Node could link: those the server sent, plus the root from Node's own store when the tool says the chain ends in a self-signed root the server did not send
  const expectChain = tls.ok && tls.chain.ends_in_self_signed_root && !lastSelf ? sentN + 1 : sentN;
  cell(H, 'tls', 'chain length (sent; +1 only if the tool says its chain ends in a root the server did not send)', tls.chain.length, `${sentN} sent, last sent ${lastSelf ? 'is' : 'is not'} self-signed, tool says rooted=${tls.chain.ends_in_self_signed_root} -> ${expectChain}`, tls.ok && tls.chain.length === expectChain);
  cell(H, 'tls', 'a chain that ends self-signed is not claimed when the server\'s last cert is a cross-signed root', tls.chain.ends_in_self_signed_root, `last sent cert self-signed: ${lastSelf}`, tls.ok && (lastSelf ? tls.chain.ends_in_self_signed_root === true : true));
  const proto = manual(H, 'proto', `${OSSL_NEW} s_client -connect ${H}:443 -servername ${H} </dev/null 2>&1 | grep -E 'Protocol|Cipher'`, `$OPENSSL_4 s_client -connect HOST:443 -servername HOST </dev/null 2>&1 | grep -E 'Protocol|Cipher'`);
  const pm = (/Protocol\s*:?\s*(TLSv[\d.]+)/.exec(proto) || [])[1];
  cell(H, 'tls', 'protocol', tls.protocol, pm, tls.ok && tls.protocol === pm);
  const flag = tls.protocol === 'TLSv1.3' ? `-tls1_3 -ciphersuites ${tls.cipher}` : `-tls1_2 -cipher ${tls.cipher}`;
  const acc = manual(H, 'cipher', `${OSSL_NEW} s_client ${flag} -connect ${H}:443 -servername ${H} </dev/null 2>&1 | grep -E 'Cipher is|Cipher    :'`,
    `$OPENSSL_4 s_client -tls1_3 -ciphersuites <the cipher the tool reported> -connect HOST:443 -servername HOST </dev/null 2>&1 | grep 'Cipher is'   (the server accepts that cipher)`);
  cell(H, 'tls', 'cipher accepted by the server', tls.cipher, acc.trim().split('\n')[0], tls.ok && acc.includes(tls.cipher));
  const ver = manual(H, 'verify', `${OSSL_DEFAULT} s_client -connect ${H}:443 -servername ${H} -CAfile /etc/ssl/cert.pem </dev/null 2>&1 | grep 'Verify return code'`,
    `openssl s_client -connect HOST:443 -servername HOST -CAfile /etc/ssl/cert.pem </dev/null 2>&1 | grep 'Verify return code'`);
  cell(H, 'tls', 'authorized (Node roots) = openssl verify against /etc/ssl/cert.pem', tls.authorized, ver.trim(), tls.ok && tls.authorized === /return code: 0 \(ok\)/.test(ver));

  // ---- DNS
  const dig = (name, type, rec) => lines(manual(H, `dig-${rec}`, `dig +short ${type} ${name} @${RESOLVER}`, `dig +short ${type} NAME @${RESOLVER}`));
  const aAll = dig(H, 'A', 'a'); const cnameM = dig(H, 'CNAME', 'cname'); const aaaaAll = dig(H, 'AAAA', 'aaaa');
  const ipv4 = (x) => /^\d+\.\d+\.\d+\.\d+$/.test(x);
  const aM = aAll.filter(ipv4);
  const aaaaM = aaaaAll.filter((x) => x.includes(':'));
  const nsM = dig(Z, 'NS', 'ns'); const mxM = dig(Z, 'MX', 'mx'); const txtM = dig(Z, 'TXT', 'txt'); const caaM = dig(Z, 'CAA', 'caa'); const dmarcM = dig(`_dmarc.${Z}`, 'TXT', 'dmarc');
  const D = t.dns;
  cell(H, 'dns', 'zone found', D.zone, Z, D.ok && D.zone === Z);
  cell(H, 'dns', 'A count (host)', D.counts && D.counts.a, aM.length, D.ok && D.counts.a === aM.length);
  cell(H, 'dns', 'A set overlaps', D.a && D.a.join(' '), aM.join(' '), D.ok && (aM.length === 0 || D.a.some((x) => aM.includes(x))));
  cell(H, 'dns', 'AAAA count (host)', D.counts && D.counts.aaaa, aaaaM.length, D.ok && D.counts.aaaa === aaaaM.length);
  cell(H, 'dns', 'CNAME count (host)', D.counts && D.counts.cname, cnameM.length, D.ok && D.counts.cname === cnameM.length);
  cell(H, 'dns', 'NS count (zone)', D.counts && D.counts.ns, nsM.length, D.ok && D.counts.ns === nsM.length);
  cell(H, 'dns', 'MX count (zone)', D.counts && D.counts.mx, mxM.length, D.ok && D.counts.mx === mxM.length);
  cell(H, 'dns', 'TXT count (zone)', D.counts && D.counts.txt, txtM.length, D.ok && D.counts.txt === txtM.length);
  cell(H, 'dns', 'SPF present', D.spf && D.spf.present, txtM.some((x) => /v=spf1/i.test(x)), D.ok && D.spf.present === txtM.some((x) => /v=spf1/i.test(x)));
  cell(H, 'dns', 'DMARC present', D.dmarc && D.dmarc.present, dmarcM.some((x) => /v=DMARC1/i.test(x)), D.ok && D.dmarc.present === dmarcM.some((x) => /v=DMARC1/i.test(x)));
  cell(H, 'dns', 'CAA count (zone)', D.counts && D.counts.caa, caaM.length, D.ok && D.counts.caa === caaM.length);

  // ---- headers
  const UAq = UA.replace(/'/g, "'\\''");
  const get = manual(H, 'curl-get', `curl -sS -L -m 25 -D - -o /dev/null -A '${UAq}' ${site.url}`, `curl -sS -L -m 25 -D - -o /dev/null -A '<the tool's User-Agent>' URL   (GET, response headers of the last hop)`);
  const head = manual(H, 'curl-head', `curl -sIL -m 25 -A '${UAq}' ${site.url}`, `curl -sIL -m 25 -A '<the tool's User-Agent>' URL   (HEAD, as the brief says)`);
  const G = curlHeaders(get); const HD = curlHeaders(head);
  const Lm = manualLevels(G.h);
  const Lh = manualLevels(HD.h);
  const hd = t.headers;
  cell(H, 'headers', 'HTTP status', t.page.status, G.status, t.page.ok && t.page.status === G.status);
  // Wikimedia's Server header is the name of the pod that answered ("mw-web.codfw.main-<replicaset>-<pod>"), different on every request: compared up to the replica-set hash
  const podName = (v) => (v && /^(.*-[0-9a-f]{8,12})-[a-z0-9]{5}$/.exec(v)) ? /^(.*-[0-9a-f]{8,12})-[a-z0-9]{5}$/.exec(v)[1] : null;
  const srvT = t.page.server || null; const srvM = G.h.server ? G.h.server.slice(0, 100) : null;
  cell(H, 'headers', 'Server header', srvT, srvM, t.page.ok && (srvT === srvM || (podName(srvT) !== null && podName(srvT) === podName(srvM))));
  const toolLv = {}; for (const f of hd.findings || []) toolLv[f.id] = f.level;
  for (const r of RUBRIC.rules) cell(H, 'headers', `rule ${r.id}`, toolLv[r.id], Lm[r.id], hd.ok && toolLv[r.id] === Lm[r.id]);
  const sc = scoreOf(Lm);
  cell(H, 'headers', 'score', hd.score, sc, hd.ok && hd.score === sc);
  cell(H, 'headers', 'grade', hd.grade, gradeOfScore(sc), hd.ok && hd.grade === gradeOfScore(sc));
  const headAgrees = JSON.stringify(Lm) === JSON.stringify(Lh);
  rows.push({ site: H, group: 'info', check: 'HEAD (curl -sI) gives the same rule levels as GET', tool: '-', manual: String(headAgrees), pass: true });
  // header-derived stack entries must be backed by a header in the curl dump
  const bad = [];
  for (const s of t.stack || []) for (const ev of s.evidence) if (ev.startsWith('header:') && !(ev.slice(7) in G.h)) bad.push(`${s.name}:${ev}`);
  cell(H, 'stack', 'header-evidence entries have that header in curl', `${(t.stack || []).filter((s) => s.evidence.some((e) => e.startsWith('header:'))).length} entries`, bad.length ? bad.join(',') : 'all present', bad.length === 0);

  // ---- RDAP, by curl and jq against the registry
  const boot = path.join(CACHE, 'iana-dns.json');
  if (FRESH || !fs.existsSync(boot)) { calls++; spawnSync('sh', ['-c', `curl -sS -m 30 -o '${boot}' https://data.iana.org/rdap/dns.json`]); if (!COMMANDS.some((c) => c.name === 'iana')) COMMANDS.push({ name: 'iana', cmd: 'curl -sS https://data.iana.org/rdap/dns.json -o iana-dns.json' }); }
  const base = manual(H, 'rdap-base', `jq -r --arg t ${site.tld} '[.services[] | select(.[0][] == $t) | .[1][] | select(startswith("https"))][0] // empty' '${boot}'`,
    `jq -r --arg t TLD '[.services[] | select(.[0][] == $t) | .[1][] | select(startswith("https"))][0] // empty' iana-dns.json`).trim();
  const Dm = t.domain;
  if (!base) {
    cell(H, 'domain', 'RDAP service for the TLD', Dm.ok ? 'answered' : Dm.reason, 'none in the IANA bootstrap', Dm.ok === false && /no RDAP service is listed/.test(Dm.reason) && Dm.registration === null);
  } else {
    const b = base.endsWith('/') ? base : `${base}/`;
    const body = manual(H, 'rdap', `curl -sS -m 30 -H 'accept: application/rdap+json' -A '${UAq}' '${b}domain/${Z}'`, `curl -sS -H 'accept: application/rdap+json' '<registry base from the IANA file>domain/ZONE'`);
    let J = null; try { J = JSON.parse(body); } catch { /* not JSON */ }
    const jq = (expr) => { const f = path.join(CACHE, 'manual', `${H}.rdap.txt`); const r = spawnSync('jq', ['-r', expr, f], { encoding: 'utf8' }); return (r.stdout || '').trim(); };
    if (!COMMANDS.some((c) => c.name === 'rdap-jq')) COMMANDS.push({ name: 'rdap-jq', cmd: `jq -r '.events[] | select(.eventAction=="registration" or .eventAction=="registered") | .eventDate' | head -1   (also expiration, last changed; registrar: .entities[] | select(.roles[]=="registrar") | .vcardArray[1][] | select(.[0]=="fn") | .[3]; .nameservers | length)` });
    const reg = jq('[.events[] | select(.eventAction=="registration" or .eventAction=="registered") | .eventDate][0] // empty');
    const exp = jq('[.events[] | select(.eventAction=="expiration") | .eventDate][0] // empty');
    const chg = jq('[.events[] | select(.eventAction=="last changed") | .eventDate][0] // empty');
    const rar = jq('[.. | objects | select(has("roles")) | select(.roles | index("registrar")) | .vcardArray[1][]? | select(.[0]=="fn") | .[3]][0] // empty');
    const nsN = jq('(.nameservers // []) | length');
    const stN = jq('(.status // []) | length');
    cell(H, 'domain', 'registration date', Dm.registration, reg, Dm.ok && J && Date.parse(Dm.registration) === Date.parse(reg));
    cell(H, 'domain', 'expiry date', Dm.expiry, exp, Dm.ok && J && Date.parse(Dm.expiry) === Date.parse(exp));
    cell(H, 'domain', 'last changed', Dm.last_changed, chg || '(none)', Dm.ok && J && (chg ? Date.parse(Dm.last_changed) === Date.parse(chg) : Dm.last_changed === null));
    cell(H, 'domain', 'registrar', Dm.registrar, rar || '(none)', Dm.ok && J && (rar ? Dm.registrar === rar : Dm.registrar === null));
    cell(H, 'domain', 'name server count', Dm.nameservers && Dm.nameservers.length, Math.min(Number(nsN), 10), Dm.ok && J && Dm.nameservers.length === Math.min(Number(nsN), 10));
    cell(H, 'domain', 'status count', Dm.status && Dm.status.length, Math.min(Number(stN), 12), Dm.ok && J && Dm.status.length === Math.min(Number(stN), 12));
  }
}

(async () => {
  const sites = ONLY ? SITES.filter((s) => s.host === ONLY) : SITES;
  for (const s of sites) { await check(s); }
  const failed = rows.filter((r) => !r.pass);
  const md = [];
  md.push(`# T6 gate: ${sites.length} sites, ${rows.filter((r) => r.group !== 'info').length} cells, ${failed.length} FAIL (network calls this run: ${calls})\n`);
  md.push(`DNS resolver for tool and dig: ${RESOLVER}. openssl (brief's command): \`${OSSL_DEFAULT}\`; openssl 4 (ext, protocol, cipher): \`${OSSL_NEW}\`.\n`);
  md.push('## Commands used (manual side)\n');
  for (const c of COMMANDS) md.push(`- ${c.name}: \`${c.cmd}\``);
  md.push('');
  for (const group of ['tls', 'domain', 'dns', 'headers', 'stack']) {
    md.push(`\n## ${group}\n\n| site | check | tool | manual | |\n|---|---|---|---|---|`);
    for (const r of rows.filter((x) => x.group === group)) md.push(`| ${r.site} | ${r.check} | ${r.tool.replace(/\|/g, '/').slice(0, 70)} | ${r.manual.replace(/\|/g, '/').slice(0, 70)} | ${r.pass ? 'PASS' : 'FAIL'} |`);
  }
  // the one-table summary the brief asks for: per site, the value the tool gave and whether every cell behind it passed
  const ok = (site, ...checks) => checks.every((c) => rows.some((r) => r.site === site && r.check === c) && rows.filter((r) => r.site === site && r.check === c).every((r) => r.pass)) ? 'PASS' : 'FAIL';
  const get1 = (site, check, f = 'tool') => { const r = rows.find((x) => x.site === site && x.check === check); return r ? r[f] : '-'; };
  const day = (v) => String(v).slice(0, 10);
  const L = { full: 'F', partial: 'P', none: '-' };
  md.push('\n## Summary: 10 sites x the gate\'s columns (value from the tool; PASS = every cell behind it agrees with the manual check)\n');
  md.push('| site | cert issuer (O / CN) | notBefore | notAfter | domain created | A | NS | MX | header rules hsts csp nosniff framing referrer perms coop coep | score | grade |\n|---|---|---|---|---|---|---|---|---|---|---|');
  for (const st of sites) {
    const H = st.host;
    const lv = RUBRIC.rules.map((r) => L[get1(H, `rule ${r.id}`)] || '?').join(' ');
    const dom = get1(H, 'registration date') !== '-' ? `${day(get1(H, 'registration date'))} ${ok(H, 'registration date')}` : `none (${get1(H, 'RDAP service for the TLD') === 'answered' ? '' : 'no RDAP for .' + st.tld}) ${ok(H, 'RDAP service for the TLD')}`;
    md.push(`| ${H} | ${get1(H, 'issuer organization')} / ${get1(H, 'issuer common name')} ${ok(H, 'issuer organization', 'issuer common name')} | ${day(get1(H, 'notBefore'))} ${ok(H, 'notBefore')} | ${day(get1(H, 'notAfter'))} ${ok(H, 'notAfter')} | ${dom} | ${get1(H, 'A count (host)')}=${get1(H, 'A count (host)', 'manual')} ${ok(H, 'A count (host)')} | ${get1(H, 'NS count (zone)')}=${get1(H, 'NS count (zone)', 'manual')} ${ok(H, 'NS count (zone)')} | ${get1(H, 'MX count (zone)')}=${get1(H, 'MX count (zone)', 'manual')} ${ok(H, 'MX count (zone)')} | ${lv} ${ok(H, ...RUBRIC.rules.map((r) => `rule ${r.id}`))} | ${get1(H, 'score')} | ${get1(H, 'grade')} ${ok(H, 'score', 'grade')} |`);
  }
  md.push('\n## info\n');
  for (const r of rows.filter((x) => x.group === 'info')) md.push(`- ${r.site}: ${r.check}: ${r.manual}`);
  md.push(`\n## Result: ${rows.filter((r) => r.group !== 'info').length - failed.length} PASS, ${failed.length} FAIL`);
  for (const f of failed) md.push(`- FAIL ${f.site} / ${f.group} / ${f.check}: tool=${f.tool} manual=${f.manual}`);
  const out = md.join('\n');
  fs.writeFileSync(path.join(CACHE, 'gate-report.md'), out);
  console.log(out);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('gate script error:', e); process.exit(2); });
