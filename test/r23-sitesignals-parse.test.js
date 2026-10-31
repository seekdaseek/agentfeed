// R23 T6, /api/site-signals: the pure parts, offline. The header rubric (every rule with a negative control), the stack table and the link reader on HTML fixtures, the bounded
// tag scanner, DNS and RDAP and TLS section builders. Nothing here opens a socket. The live comparison with openssl, dig and curl is ops/r23-sitesignals-gate.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RUBRIC, gradeOf } = require('../tools/r23/site-signals/rubric');
const { gradeHeaders, parseCsp } = require('../tools/r23/site-signals/headers');
const { scanTags, MAX_KEPT } = require('../tools/r23/site-signals/html');
const { detectStack } = require('../tools/r23/site-signals/stack');
const { TABLE } = require('../tools/r23/site-signals/stack-table');
const { extractLinks, socialOf, CAP } = require('../tools/r23/site-signals/links');
const { dnsSignals, describeDns, zoneCandidates, registeredDomain } = require('../tools/r23/site-signals/dns');
const { makeRdap, describeDomain, parseBootstrap } = require('../tools/r23/site-signals/rdap');
const { describeCert, splitSans } = require('../tools/r23/site-signals/tls');
const EX = require('../tools/r23/site-signals/example');

const FX = path.join(__dirname, 'fixtures', 'r23', 'sitesignals');
const text = (f) => fs.readFileSync(path.join(FX, f), 'utf8');
const json = (f) => JSON.parse(text(f));

// ======================================================================================================== the header rubric
const BEST = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'content-security-policy': "default-src 'none'; script-src 'self' 'nonce-abc'; frame-ancestors 'self'",
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=()',
  'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp',
};
const without = (h, ...names) => { const o = { ...h }; for (const n of names) delete o[n]; return o; };
const level = (headers, id) => gradeHeaders(headers).findings.find((f) => f.id === id).level;

test('rubric: control, the best header set scores every point and the empty set none; the table adds up and every rule appears once, in order', () => {
  const best = gradeHeaders(BEST);
  assert.equal(best.score, RUBRIC.max);
  assert.equal(best.grade, 'A');
  assert.ok(best.findings.every((f) => f.level === 'full' && f.points === f.max));
  assert.deepEqual(best.findings.map((f) => f.id), RUBRIC.rules.map((r) => r.id));
  assert.equal(RUBRIC.rules.reduce((a, r) => a + r.points, 0), RUBRIC.max);
  const none = gradeHeaders({});
  assert.equal(none.score, 0);
  assert.equal(none.grade, 'F');
  assert.ok(none.findings.every((f) => f.level === 'none' && f.points === 0));
});

// negative control per rule: take the best set away one rule at a time; the score falls by exactly that rule's points and its finding says none
const REMOVE = {
  hsts: (h) => without(h, 'strict-transport-security'),
  csp: (h) => without(h, 'content-security-policy'),
  nosniff: (h) => without(h, 'x-content-type-options'),
  framing: (h) => ({ ...without(h, 'x-frame-options'), 'content-security-policy': "default-src 'none'; script-src 'self' 'nonce-abc'" }),
  referrer: (h) => without(h, 'referrer-policy'),
  permissions: (h) => without(h, 'permissions-policy'),
  coop: (h) => without(h, 'cross-origin-opener-policy'),
  coep: (h) => without(h, 'cross-origin-embedder-policy'),
};
for (const rule of RUBRIC.rules) {
  test(`rubric negative control: without ${rule.id} the score falls by exactly ${rule.points} and only that finding changes`, () => {
    assert.ok(REMOVE[rule.id], `a remover exists for ${rule.id}`);
    const g = gradeHeaders(REMOVE[rule.id](BEST));
    assert.equal(g.score, RUBRIC.max - rule.points);
    for (const f of g.findings) assert.equal(f.level, f.id === rule.id ? 'none' : 'full', `${rule.id} removed: ${f.id}`);
  });
}

test('rubric levels, rule by rule (each row is a header value and the level it must reach)', () => {
  const cases = [
    // [rule, headers, level]
    ['hsts', { 'strict-transport-security': 'max-age=15552000' }, 'full'],
    ['hsts', { 'strict-transport-security': 'max-age=15551999' }, 'partial'],
    ['hsts', { 'strict-transport-security': 'max-age=1' }, 'partial'],
    ['hsts', { 'strict-transport-security': 'max-age=0' }, 'none'],
    ['hsts', { 'strict-transport-security': 'includeSubDomains; preload' }, 'none'],
    ['hsts', { 'strict-transport-security': 'MAX-AGE="31536000"; includesubdomains' }, 'full'],
    ['csp', { 'content-security-policy': "default-src 'self'" }, 'full'],
    ['csp', { 'content-security-policy': "default-src 'self' 'unsafe-inline'" }, 'partial'],
    ['csp', { 'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-eval'" }, 'partial'],
    ['csp', { 'content-security-policy': 'script-src *' }, 'partial'],
    ['csp', { 'content-security-policy': "script-src 'unsafe-inline' 'nonce-r4nd0m'" }, 'full'],
    ['csp', { 'content-security-policy': "script-src 'unsafe-inline' 'strict-dynamic' https:" }, 'full'],
    ['csp', { 'content-security-policy': "script-src 'unsafe-inline' 'sha256-abc='" }, 'full'],
    ['csp', { 'content-security-policy': "img-src 'self'" }, 'partial'],
    ['csp', { 'content-security-policy': '' }, 'none'],
    ['csp', { 'content-security-policy-report-only': "default-src 'self'" }, 'none'],
    ['csp', { 'content-security-policy': "default-src * 'unsafe-inline', default-src 'self'" }, 'full'],      // two policies are both enforced: the strict one is what restricts scripts
    ['csp', { 'content-security-policy': ["default-src 'self'", "script-src 'self'"] }, 'full'],              // a repeated header arrives as an array
    ['nosniff', { 'x-content-type-options': 'nosniff' }, 'full'],
    ['nosniff', { 'x-content-type-options': 'NoSniff' }, 'full'],
    ['nosniff', { 'x-content-type-options': 'sniff' }, 'none'],
    ['framing', { 'x-frame-options': 'DENY' }, 'full'],
    ['framing', { 'x-frame-options': 'sameorigin' }, 'full'],
    ['framing', { 'x-frame-options': 'ALLOW-FROM https://a.example' }, 'none'],
    ['framing', { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }, 'full'],
    ['framing', { 'content-security-policy': "default-src 'self'; frame-ancestors https://a.example" }, 'full'],
    ['framing', { 'content-security-policy': "default-src 'self'; frame-ancestors *" }, 'none'],
    ['framing', { 'content-security-policy': "default-src 'self'" }, 'none'],
    ['referrer', { 'referrer-policy': 'no-referrer' }, 'full'],
    ['referrer', { 'referrer-policy': 'same-origin' }, 'full'],
    ['referrer', { 'referrer-policy': 'strict-origin' }, 'full'],
    ['referrer', { 'referrer-policy': 'strict-origin-when-cross-origin' }, 'full'],
    ['referrer', { 'referrer-policy': 'origin' }, 'partial'],
    ['referrer', { 'referrer-policy': 'origin-when-cross-origin' }, 'partial'],
    ['referrer', { 'referrer-policy': 'no-referrer-when-downgrade' }, 'partial'],
    ['referrer', { 'referrer-policy': 'unsafe-url' }, 'none'],
    ['referrer', { 'referrer-policy': 'sometimes' }, 'none'],
    ['referrer', { 'referrer-policy': 'unsafe-url, strict-origin' }, 'full'],                     // the last recognised token wins
    ['referrer', { 'referrer-policy': 'strict-origin, not-a-policy' }, 'full'],
    ['referrer', { 'referrer-policy': 'strict-origin, unsafe-url' }, 'none'],
    ['permissions', { 'permissions-policy': 'geolocation=()' }, 'full'],
    ['permissions', { 'permissions-policy': '   ' }, 'none'],
    ['coop', { 'cross-origin-opener-policy': 'same-origin' }, 'full'],
    ['coop', { 'cross-origin-opener-policy': 'same-origin-allow-popups' }, 'full'],
    ['coop', { 'cross-origin-opener-policy': 'unsafe-none' }, 'none'],
    ['coep', { 'cross-origin-embedder-policy': 'require-corp' }, 'full'],
    ['coep', { 'cross-origin-embedder-policy': 'credentialless' }, 'full'],
    ['coep', { 'cross-origin-embedder-policy': 'unsafe-none' }, 'none'],
  ];
  const bad = [];
  for (const [rule, h, want] of cases) { const got = level(h, rule); if (got !== want) bad.push(`${rule} ${JSON.stringify(h)} -> ${got}, want ${want}`); }
  assert.deepEqual(bad, []);
  // the partial points are the table's, not a constant in the code
  const hstsRule = RUBRIC.rules.find((r) => r.id === 'hsts');
  assert.equal(gradeHeaders({ 'strict-transport-security': 'max-age=100' }).findings[0].points, hstsRule.levels.partial.points);
});

test('rubric: header names are matched in any case; a header set is not mutated', () => {
  const mixed = { 'Strict-Transport-Security': 'max-age=31536000', 'X-Content-Type-Options': 'nosniff' };
  const copy = JSON.stringify(mixed);
  const g = gradeHeaders(mixed);
  assert.equal(g.score, 40);
  assert.equal(JSON.stringify(mixed), copy);
  assert.equal(gradeHeaders({}).score, 0, 'control: the same two headers are what earned the 40');
});

test('rubric: the documented grade cut-offs are A 85, B 70, C 50, D 30 (typed here from the rubric table in the notes, not read from the code)', () => {
  const documented = [[100, 'A'], [85, 'A'], [84, 'B'], [70, 'B'], [69, 'C'], [50, 'C'], [49, 'D'], [30, 'D'], [29, 'F'], [0, 'F']];
  for (const [score, grade] of documented) assert.equal(gradeOf(score), grade, `${score} -> ${grade}`);
  assert.deepEqual(RUBRIC.grades.map((g) => [g.min, g.grade]), [[85, 'A'], [70, 'B'], [50, 'C'], [30, 'D'], [0, 'F']]);
  assert.deepEqual(RUBRIC.rules.map((r) => [r.id, r.points]), [['hsts', 30], ['csp', 25], ['nosniff', 10], ['framing', 10], ['referrer', 10], ['permissions', 5], ['coop', 5], ['coep', 5]]);
});

test('rubric: the grade cut-offs come from the table, checked at and one below each', () => {
  for (const g of RUBRIC.grades) {
    assert.equal(gradeOf(g.min), g.grade, `${g.min} -> ${g.grade}`);
    if (g.min > 0) assert.notEqual(gradeOf(g.min - 1), g.grade, `${g.min - 1} is below ${g.grade}`);
  }
  assert.equal(gradeOf(RUBRIC.max), 'A');
  assert.equal(gradeOf(0), 'F');
});

test('parseCsp: commas separate policies, semicolons directives; a repeated directive keeps its first value', () => {
  const p = parseCsp("default-src 'self'; script-src a b; script-src c, img-src d");
  assert.equal(p.length, 2);
  assert.deepEqual(p[0].get('script-src'), ['a', 'b']);
  assert.deepEqual(p[1].get('img-src'), ['d']);
  assert.deepEqual(parseCsp(' ; ,, '), []);
});

test('the findings carry no judgement words and cap long header values', () => {
  const long = `default-src 'self'; ${'x'.repeat(2000)}`;
  const g = gradeHeaders({ 'content-security-policy': long });
  assert.ok(g.findings.find((f) => f.id === 'csp').value.length <= 301);
  assert.doesNotMatch(JSON.stringify(g), /\b(safe|secure site|trusted|scam|phishing|malicious|dangerous)\b/i);
});

// ======================================================================================================== the tag scanner
test('scanTags: finds the wanted tags with their attributes, skips comments, script and style bodies, reads a > inside a quoted value, decodes entities', () => {
  const html = `<!doctype html><!-- <a href="https://hidden.example/c"> --><a href="https://x.example/?a=1&amp;b=2" title="a > b" data-x='single "quoted"'>t</a>
    <script>var s = '<a href="https://hidden.example/s">';</script><SCRIPT SRC="https://cdn.example/a.js"></SCRIPT><style>a{}</style><META NAME="Generator" content=Hugo>
    <link rel=stylesheet href=/s.css><p>text</p><a>no href</a>`;
  const { tags, truncated } = scanTags(html);
  assert.equal(truncated, false);
  const hrefs = tags.filter((t) => t.name === 'a').map((t) => t.attrs.href);
  assert.deepEqual(hrefs, ['https://x.example/?a=1&b=2', undefined]);
  assert.equal(tags[0].attrs.title, 'a > b');
  assert.equal(tags[0].attrs['data-x'], 'single "quoted"');
  assert.equal(tags.filter((t) => t.name === 'script')[1].attrs.src, 'https://cdn.example/a.js');
  assert.equal(tags.find((t) => t.name === 'meta').attrs.name, 'Generator');
  assert.equal(tags.find((t) => t.name === 'meta').attrs.content, 'Hugo');
  assert.equal(tags.find((t) => t.name === 'link').attrs.href, '/s.css');
  assert.ok(!JSON.stringify(tags).includes('hidden.example'), 'comment and script body are not read');
  // control: the same anchor outside a comment and a script IS read
  assert.ok(scanTags('<a href="https://hidden.example/c">x</a>').tags.some((t) => t.attrs.href === 'https://hidden.example/c'));
});

test('scanTags: an unterminated quote does not swallow the rest of the page, and hostile input stays linear (a 3 MB page of broken tags is scanned in well under a second)', () => {
  const broken = '<a href="foo>junk <a href="https://github.com/ok/ok">after</a>';
  assert.ok(scanTags(broken).tags.some((t) => t.attrs.href === 'https://github.com/ok/ok'));
  for (const unit of ['<a "', '<a href="x', '<script ', '<<<<<<<<', '<a href=\'', '<!-- ', '<scrip', `<a ${'b'.repeat(5000)}`]) {
    const doc = unit.repeat(Math.ceil((3 * 1024 * 1024) / unit.length));
    const t0 = process.hrtime.bigint();
    const r = scanTags(doc);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1500, `${JSON.stringify(unit.slice(0, 12))} x ${doc.length}: ${ms.toFixed(0)} ms`);
    assert.ok(Array.isArray(r.tags));
  }
});

test('scanTags: the kept-tag cap holds and says it truncated; a close tag in any case ends a script body', () => {
  const many = '<a href="https://github.com/o/r">x</a>'.repeat(MAX_KEPT + 50);
  const r = scanTags(many);
  assert.equal(r.tags.length, MAX_KEPT);
  assert.equal(r.truncated, true);
  assert.equal(scanTags('<script>x</ScRiPt><a href="https://github.com/o/r">x</a>').tags.filter((t) => t.name === 'a').length, 1);
  assert.equal(scanTags('<script>never closed <a href="https://github.com/o/r">').tags.filter((t) => t.name === 'a').length, 0);
});

// ======================================================================================================== the stack table
const names = (s) => s.map((x) => x.name);
const find = (s, name) => s.find((x) => x.name === name);

test('stack from headers: nginx with its version, PHP from X-Powered-By and a cookie name, no Apache (known positives and a control)', () => {
  const s = detectStack({ headers: json('headers-nginx-php.json') });
  assert.equal(find(s, 'nginx').version, '1.18.0');
  assert.deepEqual(find(s, 'nginx').evidence, ['header:server']);
  assert.equal(find(s, 'PHP').version, '8.1.2');
  assert.deepEqual(find(s, 'PHP').evidence.sort(), ['cookie', 'header:x-powered-by']);
  assert.ok(!names(s).includes('Apache HTTP Server'));
  // negative control: without the headers and cookie there is no PHP and no nginx
  const bare = detectStack({ headers: { 'content-type': 'text/html' } });
  assert.deepEqual(bare, []);
  // the cookie alone is enough for PHP, and its VALUE is never read (only names)
  const ck = detectStack({ headers: { 'set-cookie': ['PHPSESSID=secret-value; path=/'] } });
  assert.deepEqual(names(ck), ['PHP']);
  assert.ok(!JSON.stringify(ck).includes('secret-value'));
});

test('stack from headers: Cloudflare, Varnish and CloudFront markers; IIS and ASP.NET with the version header', () => {
  const cf = detectStack({ headers: json('headers-cloudflare.json') });
  assert.deepEqual(names(cf).sort(), ['Amazon CloudFront', 'Cloudflare', 'Varnish']);
  assert.ok(find(cf, 'Cloudflare').evidence.includes('header:cf-ray') && find(cf, 'Cloudflare').evidence.includes('header:server'));
  const iis = detectStack({ headers: json('headers-iis.json') });
  assert.equal(find(iis, 'Microsoft IIS').version, '10.0');
  assert.equal(find(iis, 'ASP.NET').version, '4.0.30319');
  assert.ok(find(iis, 'ASP.NET').evidence.includes('cookie'));
});

test('stack: the Server token patterns tell Apache from Tomcat (Apache-Coyote) and read versions', () => {
  assert.equal(find(detectStack({ headers: { server: 'Apache/2.4.52 (Ubuntu)' } }), 'Apache HTTP Server').version, '2.4.52');
  const tc = detectStack({ headers: { server: 'Apache-Coyote/1.1' } });
  assert.deepEqual(names(tc), ['Apache Tomcat'], 'Apache-Coyote is Tomcat, not Apache HTTP Server');
  assert.deepEqual(names(detectStack({ headers: { server: 'Microsoft-IIS/8.5' } })), ['Microsoft IIS']);
  assert.equal(find(detectStack({ headers: { server: 'nginx/1.2<script>' } }), 'nginx').version, '1.2', 'the version stops at the first odd character');
  assert.equal(find(detectStack({ headers: { server: `nginx/${'9'.repeat(40)}` } }), 'nginx').version, null, 'an over-long version is dropped');
});

test('stack from HTML: a WordPress page (generator, wp-content, jquery), with jquery-ui alone being no jQuery and a stripped page no WordPress', () => {
  const html = text('page-wordpress.html');
  const { tags } = scanTags(html);
  const s = detectStack({ headers: {}, html, tags });
  assert.equal(find(s, 'WordPress').version, '6.4.2');
  assert.deepEqual(find(s, 'WordPress').evidence.sort(), ['meta:generator', 'script-or-link-url']);
  assert.ok(find(s, 'jQuery'));
  assert.ok(find(s, 'Google Fonts'), 'the fonts.gstatic.com preconnect link');
  // negative controls
  const stripped = html.replace(/wp-(content|includes)/g, 'zz-$1').replace(/WordPress/g, 'Blogware');
  const s2 = detectStack({ headers: {}, html: stripped, tags: scanTags(stripped).tags });
  assert.ok(!names(s2).includes('WordPress'));
  const uiOnly = '<script src="/js/jquery-ui.min.js"></script><script src="/js/jquery.ui.core.js"></script>';
  assert.ok(!names(detectStack({ html: uiOnly, tags: scanTags(uiOnly).tags })).includes('jQuery'));
  const plainJq = '<script src="/js/jquery-3.6.0.min.js"></script>';
  assert.equal(find(detectStack({ html: plainJq, tags: scanTags(plainJq).tags }), 'jQuery').version, '3.6.0');
  const cdnJq = '<script src="https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js"></script>';
  assert.equal(find(detectStack({ html: cdnJq, tags: scanTags(cdnJq).tags }), 'jQuery').version, '3.7.1');
});

test('stack from HTML: Next.js, React, Google Tag Manager and Stripe.js on one page; the page markup and the asset path are both evidence', () => {
  const html = text('page-nextjs.html');
  const s = detectStack({ headers: { 'x-powered-by': 'Next.js' }, html, tags: scanTags(html).tags });
  assert.deepEqual(find(s, 'Next.js').evidence.sort(), ['header:x-powered-by', 'page-markup', 'script-or-link-url']);
  for (const n of ['React', 'Google Tag Manager', 'Stripe.js']) assert.ok(find(s, n), n);
  const noNext = html.replace(/_next/g, '_n3xt').replace('__NEXT_DATA__', '__N3XT_DATA__');
  assert.ok(!names(detectStack({ html: noNext, tags: scanTags(noNext).tags })).includes('Next.js'));
});

test('stack from HTML: MkDocs with its version, Sphinx, Bootstrap with its version, Tailwind and Angular, from upper-case tags and attributes too', () => {
  const html = text('page-docs.html');
  const s = detectStack({ headers: {}, html, tags: scanTags(html).tags });
  assert.equal(find(s, 'MkDocs').version, '1.5.3');
  assert.ok(find(s, 'Sphinx'));
  assert.equal(find(s, 'Bootstrap').version, '5.3.2');
  assert.ok(find(s, 'Tailwind CSS'));
  assert.equal(find(s, 'Angular').version, '17.0.8');
});

test('stack: a page with no markers detects nothing, and the table has unique names and valid rules', () => {
  const html = text('page-plain.html');
  assert.deepEqual(detectStack({ headers: { 'content-type': 'text/html' }, html, tags: scanTags(html).tags }), []);
  assert.equal(new Set(TABLE.map((e) => e.name)).size, TABLE.length);
  for (const e of TABLE) {
    assert.ok(e.rules.length >= 1, e.name);
    for (const r of e.rules) assert.ok(['header', 'cookie', 'generator', 'asset', 'html'].includes(r.in), `${e.name}: ${r.in}`);
  }
  // every entry is reachable: a synthetic page built from one rule of each entry detects that entry (so no pattern is dead)
  const dead = [];
  const sample = { 'Next.js': null };
  void sample;
  for (const e of TABLE) {
    const r = e.rules[0];
    let input = null;
    if (r.in === 'header') input = { headers: { [r.name]: headerSample(e.name, r) } };
    else if (r.in === 'cookie') input = { headers: { 'set-cookie': [`${cookieSample(e.name)}=v`] } };
    else if (r.in === 'generator') input = { tags: [{ name: 'meta', attrs: { name: 'generator', content: generatorSample(e.name) } }] };
    else if (r.in === 'asset') input = { tags: [{ name: 'script', attrs: { src: assetSample(e.name) } }] };
    else input = { html: r.text };
    if (!names(detectStack(input)).includes(e.name)) dead.push(e.name);
  }
  assert.deepEqual(dead, []);
});

// samples that match each entry's FIRST rule (written by hand from the pattern's intent, not derived from the regex source)
function headerSample(name, r) {
  const m = { nginx: 'nginx/1.0', 'Apache HTTP Server': 'Apache/2.4.1', 'Apache Tomcat': 'Apache-Coyote/1.1', 'Microsoft IIS': 'Microsoft-IIS/10.0', LiteSpeed: 'LiteSpeed', Caddy: 'Caddy', OpenResty: 'openresty/1.2', Envoy: 'envoy',
    Kestrel: 'Kestrel', Jetty: 'Jetty(9.4.1)', gunicorn: 'gunicorn/20.1', Granian: 'granian', uvicorn: 'uvicorn', 'Phusion Passenger': 'Phusion Passenger 6.0', Cloudflare: 'cloudflare', Fastly: 'cache-fra1234-FRA',
    Akamai: 'AkamaiGHost', 'Amazon CloudFront': 'abc', Varnish: 'abc', 'Azure Front Door': 'abc', Netlify: 'Netlify', Vercel: 'Vercel', GitHub: 'GitHub.com', 'Google Frontend': 'Google Frontend', 'Google Web Server': 'gws',
    'Amazon S3': 'AmazonS3', Heroku: '1.1 vegur', PHP: 'PHP/8.0', 'ASP.NET': 'ASP.NET', Express: 'Express', 'Next.js': 'Next.js 14.0.0' };
  return m[name] || (r.re.source === '.' ? 'x' : 'sample');
}
const cookieSample = (n) => ({ PHP: 'PHPSESSID', 'ASP.NET': 'ASP.NET_SessionId', Express: 'connect.sid', Laravel: 'laravel_session', 'Java servlet container': 'JSESSIONID' })[n] || 'x';
const generatorSample = (n) => ({ WordPress: 'WordPress 6', Drupal: 'Drupal 10', Joomla: 'Joomla! 4', Ghost: 'Ghost 5.0', TYPO3: 'TYPO3 CMS', MediaWiki: 'MediaWiki 1.4', PrestaShop: 'PrestaShop', Squarespace: 'Squarespace', Wix: 'Wix.com Website Builder',
  Webflow: 'Webflow', Hugo: 'Hugo 0.1', Jekyll: 'Jekyll v4', Gatsby: 'Gatsby 5', Docusaurus: 'Docusaurus v3', MkDocs: 'mkdocs-1.5', Astro: 'Astro v4', Hexo: 'Hexo 7', Eleventy: 'Eleventy v2' })[n] || 'x';
const assetSample = (n) => ({ 'Next.js': '/_next/static/a.js', Nuxt: '/_nuxt/a.js', SvelteKit: '/_app/immutable/a.js', WordPress: '/wp-content/a.js', Drupal: '/sites/default/files/a.js', Shopify: 'https://cdn.shopify.com/a.js',
  Squarespace: 'https://static1.squarespace.com/a.js', Wix: 'https://static.parastorage.com/a.js', Sphinx: '_static/documentation_options.js', React: '/react.production.min.js', 'Vue.js': '/vue.global.prod.js', jQuery: '/jquery.min.js',
  Bootstrap: '/bootstrap.min.css', 'Tailwind CSS': 'https://cdn.tailwindcss.com', 'Alpine.js': '/alpine.min.js', htmx: '/htmx.min.js', 'Font Awesome': '/fontawesome.css', 'Google Fonts': 'https://fonts.googleapis.com/css',
  'Google Tag Manager': 'https://www.googletagmanager.com/gtm.js', 'Google Analytics': 'https://www.google-analytics.com/analytics.js', 'Cloudflare Web Analytics': 'https://static.cloudflareinsights.com/beacon.min.js',
  Plausible: 'https://plausible.io/js/script.js', Matomo: '/matomo.js', Hotjar: 'https://static.hotjar.com/c/hotjar.js', Segment: 'https://cdn.segment.com/analytics.js', 'Meta Pixel': 'https://connect.facebook.net/en_US/fbevents.js',
  HubSpot: 'https://js.hs-scripts.com/1.js', Sentry: 'https://browser.sentry-cdn.com/7/bundle.js', reCAPTCHA: 'https://www.google.com/recaptcha/api.js', hCaptcha: 'https://js.hcaptcha.com/1/api.js',
  'Cloudflare Turnstile': 'https://challenges.cloudflare.com/turnstile/v0/api.js', 'Stripe.js': 'https://js.stripe.com/v3/' })[n] || 'x';

// ======================================================================================================== links
test('links: the WordPress fixture gives exactly the mailto, tel and profile links on the page, de-duplicated and normalised; nothing from comments, scripts, styles or prose', () => {
  const html = text('page-wordpress.html');
  const L = extractLinks(scanTags(html).tags, 'https://fixture.example/');
  assert.deepEqual(L.emails, ['hello@fixture.example']);
  assert.deepEqual(L.phones, ['+15550100199']);
  assert.deepEqual(L.social.x, ['https://x.com/fixtureorg']);
  assert.deepEqual(L.social.facebook, ['https://www.facebook.com/fixtureorg']);
  assert.deepEqual(L.social.github, ['https://github.com/fixtureorg/fixture-repo']);
  assert.deepEqual(L.social.linkedin, ['https://www.linkedin.com/company/fixtureorg']);
  assert.deepEqual(L.social.instagram, ['https://www.instagram.com/fixtureorg']);
  for (const k of ['discord', 'telegram', 'youtube']) assert.deepEqual(L.social[k], [], k);
  assert.equal(L.truncated, false);
  const all = JSON.stringify(L);
  for (const hidden of ['plain-text@example.com', 'css@example.com', 'commented-out', 'inside-script', 'not an address', 'intent', 'sharer', 'sharing', '/login', 'ABC123']) assert.ok(!all.includes(hidden), `${hidden} is not reported`);
});

test('links: YouTube handles and channels (not videos), Discord invites (not channels), Telegram names (not share links)', () => {
  const html = text('page-nextjs.html');
  const L = extractLinks(scanTags(html).tags, 'https://fixture.example/');
  assert.deepEqual(L.social.youtube, ['https://www.youtube.com/@fixturechannel', 'https://www.youtube.com/channel/UCfixture123']);
  assert.deepEqual(L.social.discord, ['https://discord.gg/fixtureinvite', 'https://discord.com/invite/otherinvite']);
  assert.deepEqual(L.social.telegram, ['https://t.me/fixturechat']);
  assert.deepEqual(extractLinks(scanTags(text('page-docs.html')).tags, 'https://fixture.example/').social.github, ['https://github.com/fixtureorg'], 'upper-case A HREF');
  assert.deepEqual(extractLinks(scanTags(text('page-plain.html')).tags, 'https://fixture.example/').social, Object.fromEntries(['x', 'github', 'linkedin', 'discord', 'telegram', 'youtube', 'instagram', 'facebook'].map((k) => [k, []])));
});

test('links: each list is capped and says so; host matching needs a real subdomain boundary; relative links and other schemes are ignored', () => {
  const many = Array.from({ length: 30 }, (_, i) => `<a href="mailto:user${i}@example.com">m</a><a href="tel:+1555010${String(i).padStart(4, '0')}">t</a><a href="https://github.com/org${i}">g</a>`).join('');
  const L = extractLinks(scanTags(many).tags, 'https://x.example/');
  assert.equal(L.emails.length, CAP);
  assert.equal(L.phones.length, CAP);
  assert.equal(L.social.github.length, CAP);
  assert.equal(L.truncated, true);
  assert.equal(extractLinks(scanTags('<a href="mailto:a@example.com">x</a><a href="mailto:a@example.com">y</a>').tags, 'https://x.example/').truncated, false, 'a duplicate beyond the cap is not truncation');
  assert.equal(socialOf(new URL('https://m.facebook.com/fixtureorg')).id, 'facebook');
  assert.equal(socialOf(new URL('https://evilfacebook.com/fixtureorg')), null);
  assert.equal(socialOf(new URL('https://facebook.com.evil.example/fixtureorg')), null);
  assert.equal(socialOf(new URL('https://github.com/')), null);
  // a relative link points at the page's own site: on a github.com page "/org/repo" is not a profile link, while the absolute form is
  const onGithub = extractLinks(scanTags('<a href="/features">f</a><a href="/relorg/relrepo">r</a><a href="relative-org/repo">r2</a><a href="?tab=x">q</a><a href="https://github.com/org/repo">abs</a><a href="//github.com/org2/repo2">proto</a>').tags, 'https://github.com/');
  assert.deepEqual(onGithub.social.github, ['https://github.com/org/repo', 'https://github.com/org2/repo2']);
  const odd = extractLinks(scanTags('<a href="/team">t</a><a href="ftp://github.com/o/r">f</a><a href="//github.com/o/r">proto-relative</a>').tags, 'https://x.example/');
  assert.deepEqual(odd.social.github, ['https://github.com/o/r'], 'a protocol-relative link resolves against the page and is a link');
});

// ======================================================================================================== dns
test('dns: zone candidates are the host and its parents, never one label, at most three; the registered domain is the last two labels, three under a country second level', () => {
  assert.deepEqual(zoneCandidates('github.com'), ['github.com']);
  assert.deepEqual(zoneCandidates('www.python.org'), ['www.python.org', 'python.org']);
  assert.deepEqual(zoneCandidates('www.bbc.co.uk'), ['www.bbc.co.uk', 'bbc.co.uk', 'co.uk']);
  assert.equal(zoneCandidates('a.b.c.d.example.com').length, 3);
  const cases = { 'github.com': 'github.com', 'www.cloudflare.com': 'cloudflare.com', 'www.bbc.co.uk': 'bbc.co.uk', 'bbc.co.uk': 'bbc.co.uk', 'co.uk': 'co.uk', 'a.b.c.example.com.au': 'example.com.au',
    'x.co.com': 'co.com', 'foo.github.io': 'github.io', 'www.python.org': 'python.org', 'shop.example.co.jp': 'example.co.jp', 'a.b.example.xyz': 'example.xyz', 'www.example.com.br': 'example.com.br' };
  for (const [h, want] of Object.entries(cases)) assert.equal(registeredDomain(h), want, h);
  // negative control: a three-letter TLD does not get the three-label rule (co.com is a registered domain of its own)
  assert.notEqual(registeredDomain('x.y.co.com'), 'y.co.com');
});

/** a scripted resolver: answers[type][name] is an array (records), 'ENODATA'/'ENOTFOUND'/'ETIMEOUT' (an error code) or 'hang' */
function fakeResolver(answers, calls = []) {
  const one = (type) => async (name) => {
    calls.push(`${type} ${name}`);
    const a = (answers[type] || {})[name];
    if (a === 'hang') return new Promise(() => {});
    if (typeof a === 'string') throw Object.assign(new Error(a), { code: a });
    if (a === undefined) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
    return a;
  };
  return { resolveNs: one('NS'), resolve4: one('A'), resolve6: one('AAAA'), resolveCname: one('CNAME'), resolveMx: one('MX'), resolveTxt: one('TXT'), resolveCaa: one('CAA') };
}
const WWW = {
  NS: { 'example.com': ['NS1.Example.com', 'ns2.example.com'] },
  A: { 'www.example.com': ['203.0.113.1', '203.0.113.2'] }, AAAA: { 'www.example.com': ['2001:db8::1'] }, CNAME: { 'www.example.com': ['edge.cdn.example.net'] },
  MX: { 'example.com': [{ exchange: 'mx2.example.com', priority: 20 }, { exchange: 'MX1.example.com', priority: 10 }] },
  TXT: { 'example.com': [['v=spf1 ', 'include:_spf.example.com ~all'], ['site-verification=abc']], '_dmarc.example.com': [['v=DMARC1; p=Reject; rua=mailto:x@example.com']] },
  CAA: { 'example.com': [{ critical: 0, issue: 'ca.example.net' }, { critical: 128, iodef: 'mailto:sec@example.com' }] },
};

test('dns: host records from the host, name-server, mail, text and CAA records from the registered domain; SPF and DMARC named; MX sorted', async () => {
  const calls = [];
  const d = await dnsSignals('www.example.com', { resolver: fakeResolver(WWW, calls) });
  assert.equal(d.ok, true);
  assert.equal(d.zone, 'example.com');
  assert.deepEqual(d.a, ['203.0.113.1', '203.0.113.2']);
  assert.deepEqual(d.aaaa, ['2001:db8::1']);
  assert.deepEqual(d.cname, ['edge.cdn.example.net']);
  assert.deepEqual(d.ns, ['ns1.example.com', 'ns2.example.com']);
  assert.deepEqual(d.mx, [{ exchange: 'mx1.example.com', priority: 10 }, { exchange: 'mx2.example.com', priority: 20 }]);
  assert.deepEqual(d.spf, { present: true, record: 'v=spf1 include:_spf.example.com ~all' });
  assert.deepEqual(d.dmarc, { present: true, policy: 'reject' }, 'the policy is lower-cased');
  assert.deepEqual(d.caa, [{ critical: false, tag: 'issue', value: 'ca.example.net' }, { critical: true, tag: 'iodef', value: 'mailto:sec@example.com' }]);
  assert.equal(d.caa_at, 'example.com');
  assert.deepEqual(d.counts, { a: 2, aaaa: 1, cname: 1, ns: 2, mx: 2, txt: 2, caa: 2 });
  assert.deepEqual(d.errors, []);
  assert.deepEqual(calls.filter((c) => c.startsWith('NS')), ['NS example.com'], 'the registered domain has NS records, so nothing else was asked');
  assert.ok(calls.includes('MX example.com') && !calls.includes('MX www.example.com'), 'MX is the zone\'s');
  assert.ok(calls.includes('A www.example.com') && !calls.includes('A example.com'), 'A is the host\'s');
});

test('dns negative controls: no SPF/DMARC record reads as absent (control), and a TXT query that FAILS reads as unknown, never absent', async () => {
  const noMail = { ...WWW, TXT: { 'example.com': [['just-a-verification-string']] } };
  const a = await dnsSignals('www.example.com', { resolver: fakeResolver(noMail) });
  assert.deepEqual(a.spf, { present: false, record: null });
  assert.deepEqual(a.dmarc, { present: false, policy: null });
  const failed = { ...WWW, TXT: { 'example.com': 'ETIMEOUT', '_dmarc.example.com': 'ETIMEOUT' } };
  const b = await dnsSignals('www.example.com', { resolver: fakeResolver(failed) });
  assert.equal(b.ok, true, 'other records still answer');
  assert.equal(b.spf.present, null);
  assert.equal(b.dmarc.present, null);
  assert.equal(b.counts.txt, null);
  assert.ok(b.errors.some((e) => /TXT example\.com: ETIMEOUT/.test(e)));
});

test('dns: a timeout is retried once (a slow answer on the second try is an answer), and a query that times out twice is reported as failed after exactly two tries', async () => {
  let n = 0;
  const flaky = fakeResolver(WWW);
  const real4 = flaky.resolve4;
  flaky.resolve4 = async (name) => { n++; if (n === 1) throw Object.assign(new Error('ETIMEOUT'), { code: 'ETIMEOUT' }); return real4(name); };
  const d = await dnsSignals('www.example.com', { resolver: flaky });
  assert.deepEqual(d.a, ['203.0.113.1', '203.0.113.2']);
  assert.equal(n, 2);
  assert.ok(!d.errors.some((e) => /^A /.test(e)));
  let m = 0;
  const dead = fakeResolver(WWW);
  dead.resolve4 = async () => { m++; throw Object.assign(new Error('ETIMEOUT'), { code: 'ETIMEOUT' }); };
  const e = await dnsSignals('www.example.com', { resolver: dead });
  assert.equal(m, 2, 'two tries, no more');
  assert.equal(e.counts.a, null);
  assert.ok(e.errors.includes('A www.example.com: ETIMEOUT'));
  let k = 0;
  const nx = fakeResolver(WWW);
  nx.resolve6 = async () => { k++; throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); };
  assert.deepEqual((await dnsSignals('www.example.com', { resolver: nx })).aaaa, []);
  assert.equal(k, 1, 'a definite "no such record" is not retried');
});

test('dns: a query that hangs is cut at the per-query timeout and the other records still arrive', async () => {
  const hang = { ...WWW, TXT: { 'example.com': 'hang', '_dmarc.example.com': 'hang' }, MX: { 'example.com': 'hang' } };
  const t0 = Date.now();
  const d = await dnsSignals('www.example.com', { resolver: fakeResolver(hang), timeoutMs: 60 });
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(d.ok, true);
  assert.deepEqual(d.a, ['203.0.113.1', '203.0.113.2']);
  assert.equal(d.counts.mx, null);
  assert.equal(d.counts.txt, null);
  assert.ok(d.errors.length >= 2 && d.errors.every((e) => /ETIMEOUT|timed out/.test(e)), JSON.stringify(d.errors));
});

test('dns: nothing found is ok: false with a reason; all queries failing says the queries failed; TXT values and lists are capped', async () => {
  const empty = await dnsSignals('nothing.example.com', { resolver: fakeResolver({}) });
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /no A, AAAA/);
  const allFail = await dnsSignals('nothing.example.com', { resolver: fakeResolver({ NS: { 'nothing.example.com': 'ETIMEOUT', 'example.com': 'ETIMEOUT' }, A: { 'nothing.example.com': 'ETIMEOUT' } }) });
  assert.equal(allFail.ok, false);
  assert.match(allFail.reason, /DNS queries failed/);
  const big = { NS: { 'example.com': ['ns1.example.com'] }, A: { 'example.com': Array.from({ length: 30 }, (_, i) => `203.0.113.${i}`) },
    TXT: { 'example.com': Array.from({ length: 25 }, (_, i) => [i === 0 ? 'x'.repeat(500) : `t${i}`]) } };
  const d = await dnsSignals('example.com', { resolver: fakeResolver(big) });
  assert.equal(d.a.length, 20);
  assert.equal(d.counts.a, 30, 'the count is the real count, the list is capped');
  assert.equal(d.txt.length, 20);
  assert.equal(d.counts.txt, 25);
  assert.equal(d.txt_truncated, true);
  assert.ok(d.txt[0].length <= 201);
});

test('dns: a delegated sub-zone of the host (www has its own NS records) does not replace the registered domain: MX, TXT and CAA are the domain\'s', async () => {
  const calls = [];
  const sub = { ...WWW, NS: { 'example.com': ['ns1.example.com'], 'www.example.com': ['vin.ns.example.net', 'jule.ns.example.net'] } };
  const d = await dnsSignals('www.example.com', { resolver: fakeResolver(sub, calls) });
  assert.equal(d.zone, 'example.com');
  assert.deepEqual(d.ns, ['ns1.example.com']);
  assert.equal(d.counts.mx, 2);
  assert.ok(calls.includes('MX example.com') && !calls.includes('MX www.example.com'));
});

test('dns: when the registered domain has no NS records the closest enclosing zone is found by walking up the host; a failed NS query is not walked around; a deep host uses its last two labels', async () => {
  const calls = [];
  const odd = { NS: { 'shop.example.com': ['ns.shop.example.net'] }, A: { 'www.shop.example.com': ['203.0.113.9'] }, MX: { 'shop.example.com': [{ exchange: 'm.shop.example.com', priority: 1 }] } };
  const d = await dnsSignals('www.shop.example.com', { resolver: fakeResolver(odd, calls) });
  assert.equal(d.zone, 'shop.example.com');
  assert.deepEqual(calls.filter((c) => c.startsWith('NS')), ['NS example.com', 'NS www.shop.example.com', 'NS shop.example.com']);
  assert.equal(d.counts.mx, 1);
  const calls2 = [];
  const down = await dnsSignals('www.shop.example.com', { resolver: fakeResolver({ NS: { 'example.com': 'ETIMEOUT' }, A: { 'www.shop.example.com': ['203.0.113.9'] } }, calls2) });
  assert.equal(down.zone, null);
  assert.equal(down.counts.ns, null, 'a failed NS query is unknown, not zero');
  assert.deepEqual(calls2.filter((c) => c.startsWith('NS')), ['NS example.com', 'NS example.com'], 'the one retry, and no walk to other names after a network failure');
  const calls3 = [];
  const deep = { NS: { 'example.com': ['ns1.example.com'] }, A: { 'a.b.c.d.example.com': ['203.0.113.9'] } };
  const dd = await dnsSignals('a.b.c.d.example.com', { resolver: fakeResolver(deep, calls3) });
  assert.equal(dd.zone, 'example.com');
  assert.deepEqual(calls3.filter((c) => c.startsWith('NS')), ['NS example.com']);
});

// ======================================================================================================== rdap
test('rdap bootstrap: tld -> https base with a trailing slash; a plain-http-only service is null; an https entry is preferred over http', () => {
  const m = parseBootstrap(json('bootstrap.json'));
  assert.equal(m.get('com'), 'https://rdap.registry.example/com/v1/');
  assert.equal(m.get('net'), 'https://rdap.registry.example/com/v1/');
  assert.equal(m.get('uk'), 'https://rdap.uk.example/uk/');
  assert.equal(m.get('dev'), 'https://rdap.dev.example/rdap/');
  assert.equal(m.get('xx'), null);
  assert.equal(m.has('io'), false);
  assert.throws(() => parseBootstrap({}), /no services/);
});

test('rdap domain record: dates, age, registrar, status and name servers; the registrant is never read; the RDAP database timestamp is not the last change', () => {
  const now = Date.parse('2026-10-31T00:00:00Z');
  const d = describeDomain(json('rdap-com.json'), 'fixture.com', { server: 'rdap.registry.example', now });
  assert.equal(d.ok, true);
  assert.equal(d.registration, '2001-05-17T04:00:00.000Z');
  assert.equal(d.last_changed, '2026-04-02T13:20:44.000Z');
  assert.equal(d.expiry, '2027-05-17T04:00:00.000Z');
  assert.equal(d.age_days, Math.floor((now - Date.parse('2001-05-17T04:00:00Z')) / 86400e3));
  assert.equal(d.days_to_expiry, Math.floor((Date.parse('2027-05-17T04:00:00Z') - now) / 86400e3));
  assert.equal(d.registrar, 'Fixture Registrar LLC');
  assert.equal(d.registrar_iana_id, '4242');
  assert.deepEqual(d.nameservers, ['ns1.fixture.com', 'ns2.fixture.com']);
  assert.deepEqual(d.status, ['client transfer prohibited', 'server delete prohibited']);
  assert.ok(!JSON.stringify(d).includes('Private Person'), 'registrant data is not in the answer');
  const uk = describeDomain(json('rdap-uk.json'), 'fixture.co.uk', { now });
  assert.equal(uk.registration, '1999-12-01T00:00:00.000Z', "the 'registered' spelling");
  assert.equal(uk.registrar, 'Nested Registrar Ltd', 'a registrar entity nested in another entity');
  assert.equal(uk.last_changed, null);
  assert.equal(describeDomain({}, 'x.com', { now }).registration, null, 'a record with no events does not throw');
});

function rdapWorld({ boot = json('bootstrap.json'), answers = {}, log = [], now = () => Date.parse('2026-10-31T00:00:00Z'), env = { R23_SITESIGNALS_RDAP: 'on' }, sleeps = [], spacingMs = 0 } = {}) {
  const fetchJson = async (url) => {
    log.push(url);
    if (url === 'https://data.iana.org/rdap/dns.json') { if (boot instanceof Error) throw boot; return { status: 200, json: boot }; }
    const a = answers[url];
    if (a instanceof Error) throw a;
    if (!a) return { status: 404, json: json('rdap-404.json') };
    return a;
  };
  return makeRdap({ fetchJson, now, env, spacingMs, sleep: async (ms) => { sleeps.push(ms); } });
}

test('rdap lookup: the registry for the TLD is asked at <base>domain/<name> over https; a TLD with no service (or http only) answers null fields and a reason; a known TLD answers (control)', async () => {
  const log = [];
  const rdap = rdapWorld({ log, answers: { 'https://rdap.registry.example/com/v1/domain/fixture.com': { status: 200, json: json('rdap-com.json') } } });
  const ok = await rdap.lookup('fixture.com');
  assert.equal(ok.ok, true);
  assert.equal(ok.rdap_server, 'rdap.registry.example');
  assert.deepEqual(log, ['https://data.iana.org/rdap/dns.json', 'https://rdap.registry.example/com/v1/domain/fixture.com']);
  assert.ok(log.every((u) => u.startsWith('https://')));
  // a TLD the bootstrap does not list (this is the case of .io in the live file)
  const none = await rdap.lookup('fixture.io');
  assert.equal(none.ok, false);
  assert.match(none.reason, /no RDAP service is listed for \.io/);
  for (const k of ['registration', 'last_changed', 'expiry', 'age_days', 'days_to_expiry', 'registrar', 'registrar_iana_id', 'rdap_server']) assert.equal(none[k], null, k);
  assert.deepEqual([none.status, none.nameservers], [[], []]);
  assert.ok(!log.some((u) => u.includes('fixture.io')), 'no registry was asked about a TLD without a service');
  const httpOnly = await rdap.lookup('fixture.xx');
  assert.equal(httpOnly.ok, false);
  assert.match(httpOnly.reason, /plain-http/);
  assert.ok(!log.some((u) => u.startsWith('http://')), 'no plain-http request was made');
});

test('rdap lookup: a host name below the registered domain falls back to the parent on a 404; a name with no record anywhere says so; 429, a transport error and a name mismatch are not answers', async () => {
  const rdap = rdapWorld({ answers: {
    'https://rdap.registry.example/com/v1/domain/fixture.com': { status: 200, json: json('rdap-com.json') },
    'https://rdap.registry.example/com/v1/domain/limited.com': { status: 429, json: null },
    'https://rdap.registry.example/com/v1/domain/broken.com': new Error('could not fetch rdap.registry.example: ECONNREFUSED'),
    'https://rdap.registry.example/com/v1/domain/other.com': { status: 200, json: json('rdap-com.json') },   // answers with FIXTURE.COM for other.com
    'https://rdap.registry.example/com/v1/domain/html.com': { status: 200, json: null },
  } });
  const up = await rdap.lookup('www.fixture.com');
  assert.equal(up.ok, true);
  assert.equal(up.name, 'fixture.com');
  const missing = await rdap.lookup('www.nowhere.com');
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /no record/);
  assert.match((await rdap.lookup('limited.com')).reason, /429/);
  assert.match((await rdap.lookup('broken.com')).reason, /could not be reached/);
  assert.match((await rdap.lookup('other.com')).reason, /different name/);
  assert.match((await rdap.lookup('html.com')).reason, /without a domain record/);
});

test('rdap lookup: the parent fallback never asks about a public suffix (co.uk), and still reaches the registered domain of a host name below it', async () => {
  const log = [];
  const rdap = rdapWorld({ log, answers: { 'https://rdap.uk.example/uk/domain/fixture.co.uk': { status: 200, json: json('rdap-uk.json') } } });
  const found = await rdap.lookup('www.fixture.co.uk');
  assert.equal(found.ok, true);
  assert.equal(found.name, 'fixture.co.uk');
  const none = await rdap.lookup('www.nowhere.co.uk');
  assert.equal(none.ok, false);
  assert.match(none.reason, /no record/);
  assert.ok(log.some((u) => u.endsWith('/domain/nowhere.co.uk')), 'the registered domain was asked');
  assert.ok(!log.some((u) => u.endsWith('/domain/co.uk')), 'the suffix was not');
  // control: under a three-letter TLD the same walk does reach a two-label parent
  const log2 = [];
  await rdapWorld({ log: log2 }).lookup('www.shop.nowhere.com');
  assert.ok(log2.some((u) => u.endsWith('/domain/nowhere.com')));
});

test('rdap lookup: answers are cached (hit and miss) and the day counts are recomputed on a hit; the bootstrap is fetched once even for concurrent lookups; the bootstrap failing is a reason, not a throw', async () => {
  let t = Date.parse('2026-10-31T23:00:00Z');
  const log = [];
  const rdap = rdapWorld({ log, now: () => t, answers: { 'https://rdap.registry.example/com/v1/domain/fixture.com': { status: 200, json: json('rdap-com.json') } } });
  const [a, b] = await Promise.all([rdap.lookup('fixture.com'), rdap.lookup('fixture.com')]);
  assert.equal(log.filter((u) => u.includes('dns.json')).length, 1, 'one bootstrap fetch for two concurrent lookups');
  assert.equal(a.ok && b.ok, true);
  const before = log.length;
  t += 5 * 3600e3;          // 04:00 the next day: inside the 6 hour cache life, past the registration's time of day
  const c = await rdap.lookup('fixture.com');
  assert.equal(log.length, before, 'the third lookup was answered from the cache');
  assert.equal(c.age_days, a.age_days + 1, 'age is worked out again, not frozen');
  await rdap.lookup('missing.com'); const n = log.length; await rdap.lookup('missing.com');
  assert.equal(log.length, n, 'a 404 is remembered');
  t += 7 * 3600e3;
  await rdap.lookup('fixture.com');
  assert.ok(log.length > n, 'after the TTL the registry is asked again');
  const down = rdapWorld({ boot: new Error('bootstrap down') });
  const r = await down.lookup('fixture.com');
  assert.equal(r.ok, false);
  assert.match(r.reason, /bootstrap could not be read/);
});

test('rdap lookup: queries to one registry are spaced; a queue longer than the wait limit is refused', async () => {
  const sleeps = [];
  let t = 1_000_000;
  const log = [];
  const rdap = rdapWorld({ log, sleeps, spacingMs: 1000, now: () => t, answers: { 'https://rdap.registry.example/com/v1/domain/a.com': { status: 200, json: json('rdap-com.json') } } });
  await rdap.lookup('a.com'); await rdap.lookup('b.com'); await rdap.lookup('c.com');
  assert.deepEqual(sleeps.slice(0, 2), [1000, 2000], 'the second and third query to the same registry waited for its slot');
  const burst = Array.from({ length: 10 }, (_, i) => rdap.lookup(`burst${i}.com`));
  const results = await Promise.all(burst);
  assert.ok(results.some((r) => /queued/.test(r.reason || '')), 'beyond the wait limit a lookup is refused rather than parked');
});

test('rdap lookup: it runs only when R23_SITESIGNALS_RDAP is exactly "on"; unset, empty, "off", "ON", "true", "1" and " on" all answer without one request (control: "on" asks)', async () => {
  for (const v of [undefined, '', 'off', 'ON', 'On', 'true', '1', ' on', 'yes', 'on ']) {
    const log = [];
    const r = await rdapWorld({ log, env: v === undefined ? {} : { R23_SITESIGNALS_RDAP: v } }).lookup('fixture.com');
    assert.equal(r.ok, false, JSON.stringify(v));
    assert.match(r.reason, /not enabled/);
    assert.equal(r.registration, null);
    assert.deepEqual(log, [], `${JSON.stringify(v)}: no request at all`);
  }
  const log = [];
  await rdapWorld({ log, env: { R23_SITESIGNALS_RDAP: 'on' }, answers: { 'https://rdap.registry.example/com/v1/domain/fixture.com': { status: 200, json: json('rdap-com.json') } } }).lookup('fixture.com');
  assert.ok(log.length >= 2, 'with the switch on the same lookup does request');
});

// ======================================================================================================== tls
const NOW = Date.parse('2026-10-31T12:00:00Z');
test('tls section: issuer, subject, SANs, dates, age and days left, chain, key, protocol and cipher from a certificate as Node reports it', () => {
  const t = describeCert({ cert: EX.CERT, ...EX.SOCKET, now: NOW });
  assert.equal(t.ok, true);
  assert.deepEqual(t.issuer, { organization: 'Example Trust Services', common_name: 'Example TLS CA 1', country: 'US' });
  assert.equal(t.subject.common_name, 'www.example.com');
  assert.deepEqual(t.sans, { count: 2, names: ['example.com', 'www.example.com'], truncated: false });
  assert.equal(t.valid_from, '2026-10-01T00:00:00.000Z');
  assert.equal(t.valid_to, '2026-12-30T23:59:59.000Z');
  assert.equal(t.age_days, 30);
  assert.equal(t.days_left, 60);
  assert.equal(t.expired, false);
  assert.deepEqual(t.chain, { length: 3, subjects: ['www.example.com', 'Example TLS CA 1', 'Example Root CA'], ends_in_self_signed_root: true, self_signed: false });
  assert.deepEqual(t.key, { type: 'EC', bits: 256, curve: 'P-256' });
  assert.equal(t.protocol, 'TLSv1.3');
  assert.equal(t.cipher, 'TLS_AES_128_GCM_SHA256');
  assert.equal(t.authorized, true);
  assert.equal(t.authorization_error, null);
});

test('tls section: an expired certificate has negative days left and expired true (control: the same certificate earlier is not expired); not-yet-valid has negative age; a failed verification is reported, not hidden', () => {
  const late = describeCert({ cert: EX.CERT, ...EX.SOCKET, now: Date.parse('2027-01-10T00:00:00Z') });
  assert.equal(late.expired, true);
  assert.ok(late.days_left < 0);
  assert.equal(describeCert({ cert: EX.CERT, ...EX.SOCKET, now: Date.parse('2026-12-01T00:00:00Z') }).expired, false);
  const early = describeCert({ cert: EX.CERT, ...EX.SOCKET, now: Date.parse('2026-09-20T00:00:00Z') });
  assert.ok(early.age_days < 0);
  const bad = describeCert({ cert: EX.CERT, ...EX.SOCKET, authorized: false, authorizationError: 'CERT_HAS_EXPIRED', now: NOW });
  assert.equal(bad.authorized, false);
  assert.equal(bad.authorization_error, 'CERT_HAS_EXPIRED');
});

test('tls section: a self-signed leaf is a chain of one that ends in itself; SAN splitting keeps IP entries; more than 20 SANs are capped with the real count; missing fields do not throw', () => {
  const leaf = { subject: { CN: 'selfie.example' }, issuer: { CN: 'selfie.example' }, valid_from: 'Jan  1 00:00:00 2026 GMT', valid_to: 'Jan  1 00:00:00 2036 GMT', fingerprint256: 'AA', bits: 2048, modulus: 'ABCD' };
  leaf.issuerCertificate = leaf;
  const t = describeCert({ cert: leaf, protocol: 'TLSv1.2', cipher: { name: 'ECDHE-RSA-AES128-GCM-SHA256' }, authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT', now: NOW });
  assert.deepEqual(t.chain, { length: 1, subjects: ['selfie.example'], ends_in_self_signed_root: true, self_signed: true });
  assert.equal(t.key.type, 'RSA');
  assert.deepEqual(splitSans('DNS:a.example, IP Address:192.0.2.1, DNS:b.example'), ['a.example', 'IP Address:192.0.2.1', 'b.example']);
  assert.deepEqual(splitSans(undefined), []);
  const sans = Array.from({ length: 45 }, (_, i) => `DNS:h${i}.example`).join(', ');
  const many = describeCert({ cert: { ...leaf, subjectaltname: sans }, authorized: true, now: NOW });
  assert.equal(many.sans.count, 45);
  assert.equal(many.sans.names.length, 20);
  assert.equal(many.sans.truncated, true);
  const bare = describeCert({ cert: { valid_from: 'x', valid_to: 'y' }, now: NOW });
  assert.equal(bare.age_days, null);
  assert.equal(bare.issuer.common_name, null);
  // a leaf whose issuer is not in the chain (and not self-signed) is a chain of one that does NOT end in a self-signed root
  const orphan = describeCert({ cert: { ...EX.CERT, issuerCertificate: undefined }, ...EX.SOCKET, now: NOW });
  assert.deepEqual([orphan.chain.length, orphan.chain.ends_in_self_signed_root, orphan.chain.self_signed], [1, false, false]);
});
