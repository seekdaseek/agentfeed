// tools/r24/company-check/resolve.js: from the caller's `q` (a ticker, a company name or a website) to one company on EDGAR (R24 item 5).
//   ticker   an exact match in SEC's company_tickers.json (the list tools/sec.js uses), upper-cased; BRK.B and BRK-B are the same
//   name     the same list, normalised (case, punctuation, "Inc", "Corp", "/DE/" and the like dropped); an exact match first, then the query as the start of the name, then every word of the query in the name.
//            Two or more different companies at the first tier that matches is a 400 that names them: the caller picks a ticker. Nothing is guessed.
//   website  the registrable name of the host (www.apple.com -> apple) picks up to 4 listed companies whose name or ticker starts with it; each one's EDGAR `website` or `investorWebsite` field
//            is compared with the host (EDGAR's own mapping; the field is empty for almost every company). v2: a website EDGAR does not map is matched by its registrable domain against company names,
//            strongest first (name equals the domain, ticker equals it, first word of the name equals it, name starts with it); one company resolves and the answer says which kind of match it was,
//            several are a 400 that names them, none is a 404 "not covered".
// The list is held for 24 hours (about 10,000 short rows, a few MB); a refresh that fails keeps serving the old one for up to 7 days rather than refusing every call.
'use strict';
const { bad, unavailable, notCovered } = require('../../r23/common');
const { fetchSubmissions } = require('./edgar');

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const TTL_MS = 24 * 3600e3;
const STALE_MAX_MS = 7 * 24 * 3600e3;
const MAX_Q = 200;
const MAX_CANDIDATES = 8;

const SUFFIX = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'plc', 'llc', 'lp', 'nv', 'sa', 'ag', 'de']);
/** a company name as EDGAR writes it -> lower-case words, punctuation gone, state suffixes ("/DE/", "/NEW") and the trailing Inc/Corp/Co words dropped */
function normName(s) {
  let t = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  while (/\b[a-z]\.[a-z]\b/.test(t)) t = t.replace(/\b([a-z])\.([a-z])\b/g, '$1$2');        // S.A. -> sa., U.S. -> us.
  t = t.replace(/\s*\/[a-z]{2,6}\/?\s*$/, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  const w = t.split(' ').filter(Boolean);
  while (w.length > 1 && SUFFIX.has(w[w.length - 1])) w.pop();
  return w.join(' ');
}

let LIST = null;      // { at, list: SecList }
/** one company of the list; the normalised name and its words are computed when a name is searched, not kept for 10,000 rows up front */
class Row {
  constructor(cik, ticker, title, rank) { this.cik = cik; this.ticker = ticker; this.title = title; this.rank = rank; this._norm = null; }
  get norm() { return this._norm === null ? (this._norm = normName(this.title)) : this._norm; }
  get words() { return this.norm.split(' '); }
}
const mkRow = (cik, ticker, title, rank) => (typeof ticker === 'string' && Number.isFinite(Number(cik)) ? new Row(String(Math.trunc(Number(cik))).padStart(10, '0'), ticker.toUpperCase().slice(0, 12), String(title || '').slice(0, 120), rank) : null);

// The SEC's file is one JSON object of rows {"cik_str":N,"ticker":"T","title":"..."} (about 10,000, 800 KB). It is HELD AS TEXT. A ticker is looked up with a text search for that row, so the commonest query builds
// no 10,000-row structure at all (the structure was the biggest single use of memory of the tool: about 10 MB resident). Only a query by name or by domain builds the rows, once, and keeps them.
// A file that is not in this layout (another key order, a spaced layout) is parsed with JSON.parse into rows and a map instead.
const ROW_RE = /"cik_str":\s*(\d+)\s*,\s*"ticker":\s*"((?:[^"\\]|\\.)*)"\s*,\s*"title":\s*"((?:[^"\\]|\\.)*)"/g;
const unesc = (x) => (x.includes('\\') ? JSON.parse(`"${x}"`) : x);
const NEEDLE_ROWS = '"cik_str":';
class SecList {
  constructor(text) {
    this.text = text; this._rows = null; this._map = null; this.canonical = false; this.count = 0;
    let n = 0; for (let i = text.indexOf(NEEDLE_ROWS); i >= 0; i = text.indexOf(NEEDLE_ROWS, i + 10)) n++;
    this.count = n;
    this.canonical = n >= 100 && text.startsWith('{"0":{"cik_str":');
    if (!this.canonical) this._parseAll();
  }
  _parseAll() {
    const rows = []; this._map = new Map();
    const add = (cik, ticker, title) => { const r = mkRow(cik, ticker, title, rows.length); if (!r) return; rows.push(r); if (!this._map.has(r.ticker)) this._map.set(r.ticker, r); };
    ROW_RE.lastIndex = 0; let m;
    while ((m = ROW_RE.exec(this.text)) !== null) { try { add(m[1], unesc(m[2]), unesc(m[3])); } catch { /* a row that does not unescape is skipped */ } }
    if (rows.length < 100) {
      rows.length = 0; this._map.clear();
      let j = null; try { j = JSON.parse(this.text); } catch { /* not JSON */ }
      for (const v of j && typeof j === 'object' ? Object.values(j) : []) if (v) add(v.cik_str, v.ticker, v.title);
    }
    this._rows = rows;
  }
  get size() { return this._rows ? this._rows.length : this.count; }
  /** every company, in file order (built on first use) */
  get rows() { if (!this._rows) this._parseAll(); return this._rows; }
  /** the company with this ticker (upper case), or null */
  find(ticker) {
    if (this._map) return this._map.get(ticker) || null;
    if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) return null;
    const needle = `"ticker":"${ticker}","title":"`;
    const at = this.text.indexOf(needle);
    if (at < 0) return null;
    const start = this.text.lastIndexOf(NEEDLE_ROWS, at);
    let end = at + needle.length; while (end < this.text.length && !(this.text[end] === '"' && this.text[end - 1] !== '\\')) end++;
    const m = /^"cik_str":\s*(\d+)\s*,$/.exec(this.text.slice(start, at));
    if (!m) return null;
    let title; try { title = unesc(this.text.slice(at + needle.length, end)); } catch { return null; }
    return mkRow(m[1], ticker, title, -1);
  }
}
const parseList = (body) => new SecList(body.toString('utf8'));
async function loadList(d) {
  if (LIST && d.now() - LIST.at < TTL_MS) return LIST.list;
  let r;
  try { r = await d.fetch(TICKERS_URL, { maxBytes: 6 * 1024 * 1024, accept: 'application/json' }); } catch (e) { if (LIST && d.now() - LIST.at < STALE_MAX_MS) return LIST.list; throw e; }
  const list = r.status === 200 ? parseList(r.body) : null;
  r.body = null;
  if (!list || !list.size) { if (LIST && d.now() - LIST.at < STALE_MAX_MS) return LIST.list; throw unavailable('the SEC company list could not be read', 300); }
  if (list.size < 100) { if (LIST && d.now() - LIST.at < STALE_MAX_MS) return LIST.list; throw unavailable('the SEC company list looked incomplete', 300); }
  LIST = { at: d.now(), list };
  return list;
}

// ---- what the query is --------------------------------------------------------------------------------------------------------------------------------------------------------
const DOMAINISH = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;
/** -> { kind: 'website', host } | { kind: 'text', text } ; throws bad() */
function classifyQuery(raw) {
  if (Array.isArray(raw)) throw bad('give one q');
  const s = raw == null ? '' : String(raw).trim();
  if (!s) throw bad('missing required parameter: q (a company name, a ticker or a website)');
  if (s.length > MAX_Q) throw bad(`q is over the ${MAX_Q}-character limit`);
  if (/[\u0000-\u001f\u007f]/.test(s)) throw bad('q contains control characters');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.includes('/')) {
    let u; try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`); } catch { throw bad('q looks like a web address but is not a valid one'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('a web address in q must be http or https');
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!DOMAINISH.test(host)) throw bad('q must name a website by host name such as www.example.com');
    return { kind: 'website', host };
  }
  if (DOMAINISH.test(s) && !/^[A-Za-z]{1,5}\.[A-Za-z]$/.test(s)) return { kind: 'website', host: s.toLowerCase().replace(/\.$/, '') };
  return { kind: 'text', text: s };
}

const tickerKeys = (t) => [t, t.replace('.', '-'), t.replace('-', '.')];
const distinct = (rows) => { const seen = new Set(); return rows.filter((r) => (seen.has(r.cik) ? false : (seen.add(r.cik), true))); };
const label = (r) => `${r.ticker} (${r.title})`;

function byText(list, text) {
  const t = text.trim().toUpperCase();
  if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(t)) {
    for (const k of tickerKeys(t)) { const hit = list.find(k); if (hit) return { rows: [hit], via: 'ticker' }; }
  }
  const q = normName(text);
  if (!q || q.length < 2) throw bad('q is too short to name a company');
  const qw = q.split(' ');
  const tiers = [
    (r) => r.norm === q,
    (r) => r.norm.startsWith(`${q} `) || r.norm === q,
    (r) => qw.every((w) => r.words.includes(w) || r.words.some((x) => x.startsWith(w) && w.length >= 4)),
  ];
  for (const f of tiers) {
    const rows = distinct(list.rows.filter(f));
    if (rows.length) return { rows, via: 'name' };
  }
  return { rows: [], via: 'name' };
}

/** the registrable label of a host: www.apple.com -> apple ; bbc.co.uk -> bbc */
function siteLabel(host) {
  const parts = host.split('.');
  while (parts.length > 2 && ['www', 'investor', 'investors', 'ir', 'corporate', 'about', 'en'].includes(parts[0])) parts.shift();
  if (parts.length >= 3 && ['co', 'com', 'org', 'net', 'ac', 'gov'].includes(parts[parts.length - 2])) return parts[parts.length - 3];
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
}
const hostOfSite = (v) => { if (!v) return null; try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''); } catch { return null; } };
const sameSite = (a, b) => Boolean(a && b) && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));

/**
 * @returns {Promise<{cik, name, ticker, via, website_input?, sub?}>}  `sub` is the submissions object when resolving already read it
 * Throws bad() (with `supported`, the candidate list) for an unknown or ambiguous q.
 */
async function resolveCompany(q, d) {
  const c = classifyQuery(q);
  const list = await loadList(d);
  if (c.kind === 'text') {
    const { rows, via } = byText(list, c.text);
    if (!rows.length) throw bad(`nothing on EDGAR's company list matches "${c.text.slice(0, 60)}": give a ticker, the company's name as filed, or its website`);
    if (rows.length > 1) {
      const shown = rows.slice(0, MAX_CANDIDATES);
      throw Object.assign(bad(`"${c.text.slice(0, 60)}" matches ${rows.length} companies (${shown.map(label).join('; ')}${rows.length > shown.length ? '; ...' : ''}): repeat the call with one ticker`), { supported: shown.map((r) => r.ticker) });
    }
    const r = rows[0];
    return { cik: r.cik, name: r.title, ticker: r.ticker, via };
  }
  // a website
  const want = c.host.replace(/^www\./, '');
  const lab = siteLabel(want).replace(/-/g, '');
  const subs = new Map();
  // 1. EDGAR's own mapping: the candidates whose name or ticker starts like the domain, each one's website / investor website compared with the host
  const cands = distinct(list.rows.filter((r) => r.words[0] === lab || r.norm.replace(/ /g, '').startsWith(lab) || r.ticker.toLowerCase() === lab)).slice(0, 4);
  for (const r of cands) {
    const sub = await fetchSubmissions(r.cik, d);
    if (!sub) continue;
    subs.set(r.cik, sub);
    if ([sub.website, sub.investor_website].map(hostOfSite).some((h) => sameSite(h, want))) return { cik: r.cik, name: sub.name || r.title, ticker: r.ticker, via: 'website', match: 'EDGAR lists this website for the company', website_input: c.host, sub };
  }
  // 2. no mapping: the registrable domain against company names
  const { rows, match } = byDomain(list, lab);
  if (!rows.length) throw notCovered(`no company name on EDGAR's company list matches the domain ${c.host}`);
  if (rows.length > 1) {
    const shown = rows.slice(0, MAX_CANDIDATES);
    throw Object.assign(bad(`${c.host} could belong to ${rows.length} companies (${shown.map(label).join('; ')}${rows.length > shown.length ? '; ...' : ''}): repeat the call with one ticker`), { supported: shown.map((r) => r.ticker) });
  }
  const r = rows[0];
  return { cik: r.cik, name: r.title, ticker: r.ticker, via: 'domain-name', match, website_input: c.host, sub: subs.get(r.cik) };
}

/** the registrable name of a domain against company names, strongest kind of match first -> { rows (distinct companies), match (what kind) } */
function byDomain(list, lab) {
  if (lab.length < 3) return { rows: [], match: null };
  const joined = (r) => r.norm.replace(/ /g, '');
  const tiers = [
    ['the company name equals the domain name', (r) => joined(r) === lab],
    ['the ticker equals the domain name', (r) => r.ticker.toLowerCase() === lab],
    ['the first word of the company name equals the domain name', (r) => lab.length >= 4 && r.words[0] === lab],
    ['the company name starts with the domain name', (r) => lab.length >= 6 && joined(r).startsWith(lab)],
  ];
  for (const [match, f] of tiers) { const rows = distinct(list.rows.filter(f)); if (rows.length) return { rows, match }; }
  return { rows: [], match: null };
}

module.exports = { resolveCompany, classifyQuery, normName, siteLabel, byText, byDomain, loadList, parseList, _reset: () => { LIST = null; }, TICKERS_URL };
