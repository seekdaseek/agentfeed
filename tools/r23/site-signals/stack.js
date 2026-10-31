// tools/r23/site-signals/stack.js: which technologies the response headers and the page markup point to (R23 T6). Pure: detectStack({ headers, html, tags }) -> [{ name,
// category, version, evidence[] }]. The patterns are the data table in stack-table.js. A hit says a marker is present; it does not say what the whole site runs on.
'use strict';
const { TABLE } = require('./stack-table');

const MAX_FOUND = 60;
const VERSION_OK = /^[\w.+\-]{1,30}$/;
const ASSET_CAP = 512;           // characters of a script / stylesheet URL that are read
const MAX_ASSETS = 600;          // URLs read per page (a page has a few dozen; the cap bounds memory on a hostile one)
const MAX_GENERATORS = 6;
const cap = (s, n) => (String(s).length > n ? String(s).slice(0, n) : String(s));

function headerValue(h, name) {
  const v = h[name];
  if (v == null) return null;
  return cap(Array.isArray(v) ? v.join(', ') : v, 300);
}

/** cookie names from the Set-Cookie header(s) */
function cookieNames(h) {
  const raw = h['set-cookie'];
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const c of list.slice(0, 40)) {
    const eq = String(c).indexOf('=');
    if (eq > 0) out.push(String(c).slice(0, eq).trim().slice(0, 80));
  }
  return out;
}

/** the names of the cookies a response sets (names only, never values), de-duplicated, for the page section */
const cookieNamesOf = (headers) => [...new Set(cookieNames(headers || {}))].slice(0, 20);

/** the generator names and the script / stylesheet URLs of a list of scanned tags (tests; the route collects them straight from the scan with the same caps) */
function factsOf(tags) {
  const generators = []; const assets = [];
  for (const t of tags) {
    if (t.name === 'meta' && String(t.attrs.name || '').toLowerCase() === 'generator' && t.attrs.content) generators.push(cap(t.attrs.content, 200));
    else if (t.name === 'script' && t.attrs.src) assets.push(cap(t.attrs.src, ASSET_CAP));
    else if (t.name === 'link' && t.attrs.href) assets.push(cap(t.attrs.href, ASSET_CAP));
  }
  return { generators, assets };
}

/** @param {{headers?: object, html?: string|null, tags?: object[], facts?: {generators: string[], assets: string[]}}} i  `facts` (collected during the scan) or `tags` (a scanned list) */
function detectStack({ headers = {}, html = null, tags = [], facts = null } = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = v;
  const cookies = cookieNames(h);
  const { generators, assets } = facts || factsOf(tags);
  const found = [];
  for (const entry of TABLE) {
    let version = null;
    const evidence = new Set();
    const take = (m, label) => { evidence.add(label); if (!version && m && m[1] && VERSION_OK.test(m[1])) version = m[1]; };
    for (const r of entry.rules) {
      if (r.in === 'header') {
        const v = headerValue(h, r.name);
        const m = v == null ? null : r.re.exec(v);
        if (m) take(m, `header:${r.name}`);
      } else if (r.in === 'cookie') {
        for (const c of cookies) { const m = r.re.exec(c); if (m) { take(m, 'cookie'); break; } }
      } else if (r.in === 'generator') {
        for (const g of generators) { const m = r.re.exec(g); if (m) { take(m, 'meta:generator'); break; } }
      } else if (r.in === 'asset') {
        for (const a of assets) { const m = r.re.exec(a); if (m) { take(m, 'script-or-link-url'); break; } }
      } else if (r.in === 'html' && html) {
        const at = html.indexOf(r.text);
        if (at !== -1) take(r.re ? r.re.exec(html.slice(at, at + 80)) : null, 'page-markup');
      }
    }
    if (evidence.size) found.push({ name: entry.name, category: entry.category, version, evidence: [...evidence] });
  }
  found.sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : a.name < b.name ? -1 : 1));
  return found.slice(0, MAX_FOUND);
}

module.exports = { detectStack, factsOf, cookieNamesOf, ASSET_CAP, MAX_ASSETS, MAX_GENERATORS };
