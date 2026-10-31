// tools/r23/site-signals/example.js: the inputs of the CONSTRUCTED example answer for /api/site-signals (R23 T6), as plain data. index.js runs the same pure builders the live
// route uses over these (a certificate as Node reports it, an RDAP domain object, DNS answers, a header set, a small page), so the published example has exactly the shape of a
// real answer. Every name and address is synthetic: example.com is a reserved name, 203.0.113.0/24 and 2001:db8::/32 are documentation ranges, and no real certificate,
// registrar or person is described. Kept inline (not read from test/) so the module loads wherever it is installed.
'use strict';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');

const ROOT = { subject: { O: 'Example Trust Services', CN: 'Example Root CA' }, issuer: { O: 'Example Trust Services', CN: 'Example Root CA' }, fingerprint256: 'C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1:C1' };
ROOT.issuerCertificate = ROOT;
const INTERMEDIATE = { subject: { O: 'Example Trust Services', CN: 'Example TLS CA 1' }, issuer: ROOT.subject, fingerprint256: 'B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2:B2', issuerCertificate: ROOT };
const CERT = {
  subject: { CN: 'www.example.com' }, issuer: { C: 'US', O: 'Example Trust Services', CN: 'Example TLS CA 1' },
  subjectaltname: 'DNS:example.com, DNS:www.example.com', bits: 256, asn1Curve: 'prime256v1', nistCurve: 'P-256',
  valid_from: 'Oct  1 00:00:00 2026 GMT', valid_to: 'Dec 30 23:59:59 2026 GMT', serialNumber: '0A1B2C3D4E5F60718293A4B5C6D7E8F9',
  fingerprint256: 'A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3:A3', issuerCertificate: INTERMEDIATE,
};
const SOCKET = { protocol: 'TLSv1.3', cipher: { name: 'TLS_AES_128_GCM_SHA256' }, authorized: true, authorizationError: null };

const RDAP = {
  ldhName: 'EXAMPLE.COM',
  status: ['client delete prohibited', 'client transfer prohibited', 'client update prohibited'],
  events: [
    { eventAction: 'registration', eventDate: '2009-03-14T10:00:00Z' },
    { eventAction: 'last changed', eventDate: '2026-02-20T08:30:00Z' },
    { eventAction: 'expiration', eventDate: '2027-03-14T10:00:00Z' },
    { eventAction: 'last update of RDAP database', eventDate: '2026-10-31T11:55:00Z' },
  ],
  nameservers: [{ ldhName: 'NS1.EXAMPLE.COM' }, { ldhName: 'NS2.EXAMPLE.COM' }],
  entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Example Registrar, Inc.']]], publicIds: [{ type: 'IANA Registrar ID', identifier: '9999' }] }],
};

const DNS_RAW = {
  host: 'www.example.com', zone: 'example.com', zoneName: 'example.com',
  a: ['203.0.113.10', '203.0.113.11'], aaaa: ['2001:db8::10'], cname: [],
  ns: ['ns1.example.com', 'ns2.example.com'], mx: [{ exchange: 'mail.example.com', priority: 10 }],
  txt: [['v=spf1 include:_spf.example.com ~all'], ['example-site-verification=abc123']], dmarcTxt: [['v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com']],
  caaHost: [], caaZone: [{ critical: 0, issue: 'ca.example.net' }], errors: [],
};

const HEADERS = {
  'content-type': 'text/html; charset=utf-8', server: 'nginx/1.25.3', 'x-powered-by': 'Express',
  'strict-transport-security': 'max-age=31536000; includeSubDomains', 'content-security-policy': "default-src 'self'; script-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'set-cookie': ['sid=redacted; Path=/; HttpOnly; Secure'],
};

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Example</title>
<meta name="generator" content="Hugo 0.120.4"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
<script src="https://www.googletagmanager.com/gtag/js?id=G-EXAMPLE"></script></head><body>
<a href="mailto:hello@example.com">Contact</a> <a href="tel:+15550100">Call</a>
<a href="https://github.com/example-org">GitHub</a> <a href="https://x.com/example_org">X</a> <a href="https://www.linkedin.com/company/example-org">LinkedIn</a>
</body></html>`;

module.exports = { NOW, CERT, SOCKET, RDAP, DNS_RAW, HEADERS, HTML, URL: 'https://www.example.com/' };
