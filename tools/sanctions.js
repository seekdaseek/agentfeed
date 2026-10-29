// tools/sanctions.js — /api/sanctions-check/:address (R11 A1): exact match of a crypto address
// against the digital-currency addresses on the OFAC Specially Designated Nationals (SDN) list.
//
// Source: OFAC Sanctions List Service, sdn.xml (legacy XML; the Advanced format carries the same
// addresses as features). A US federal government work, so it carries no copyright (17 U.S.C. 105);
// the Treasury "Site Policies and Notices" page holds no reuse clause either way (read 13 Oct 2026,
// docs/SOURCES.md). The route serves the list's own data and says it is not legal advice.
//
// The route never downloads anything. refresh() (run daily from cron: node tools/sanctions.js
// --refresh) streams sdn.xml to disk, parses it line by line (the file is ~29 MB; a DOM parse would
// cost hundreds of MB the box does not have), checks the result against the last good copy and
// swaps the file in atomically. A failed or implausible refresh leaves the last good copy alone; a
// copy fetched more than 48 h ago answers 503 and is never billed.
//
// UK OFSI and EU consolidated lists are NOT checked: the OFSI file has no crypto-address column and
// the EU file no address field (docs/SOURCES.md). checked_lists says exactly what was read.
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');

const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const unavailable = (msg) => Object.assign(new Error(msg), { status: 503 });
const SDN_URL = 'https://sanctionslistservice.ofac.treas.gov/api/download/sdn.xml';
const MAX_AGE_MS = 48 * 3600e3;
const NOTICE = 'Exact-string match against the digital currency addresses on the OFAC SDN list as published on the date shown. A no-match is not a clearance: an address can be controlled by a listed party without being listed, and other lists exist. Informational, not legal advice.';
const file = () => process.env.SANCTIONS_FILE || path.join(__dirname, '..', 'data', 'sanctions-ofac.json');

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const unxml = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENT[m]).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));

// the shape a request must have before the list is read; lib/param-guard.js applies the same regex before anyone is asked to pay
const ADDRESS_SHAPE = /^[A-Za-z0-9:]{14,120}$/;

// ---- address normal form ----
// EVM addresses are case-insensitive (checksum casing is a typo guard); bech32 is case-insensitive by
// spec. Everything else (base58 families) is case-sensitive and compared exactly.
function normalize(raw) {
  let a = String(raw).trim();
  a = a.replace(/^bitcoincash:/i, '');
  if (/^0x[0-9a-f]{40}$/i.test(a)) return a.toLowerCase();
  if (/^(bc1|ltc1|tb1)[0-9a-z]{8,90}$/i.test(a)) return a.toLowerCase();
  return a;
}
function family(a) {
  if (/^0x[0-9a-f]{40}$/.test(a)) return 'evm';
  if (/^(bc1|tb1)/.test(a)) return 'bitcoin-bech32';
  if (/^ltc1/.test(a)) return 'litecoin-bech32';
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return 'tron';
  if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a)) return 'xrp';
  if (/^[48][1-9A-HJ-NP-Za-km-z]{94}$/.test(a)) return 'monero';
  if (/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return 'bitcoin-base58';
  if (/^[LM][1-9A-HJ-NP-Za-km-z]{26,33}$/.test(a)) return 'litecoin-base58';
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return 'solana-or-other-base58';
  return 'other';
}

// ---- SDN parsing (line state machine over the pretty-printed XML) ----
async function parseSdn(lines) {
  const entries = []; // { addr, ticker, name, programs, type, uid }
  let published = null; let records = null;
  let cur = null; let inId = false; let inProg = false; let idType = null; let idNum = null;
  for await (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let m;
    if (!cur) {
      if ((m = t.match(/^<Publish_Date>([^<]*)<\/Publish_Date>/))) published = m[1];
      else if ((m = t.match(/^<Record_Count>(\d+)<\/Record_Count>/))) records = Number(m[1]);
      else if (t === '<sdnEntry>') cur = { uid: null, first: '', last: '', type: null, programs: [], ids: [] };
      continue;
    }
    if (t === '</sdnEntry>') {
      const name = [cur.first, cur.last].filter(Boolean).join(' ').trim();
      for (const [ticker, addr] of cur.ids) entries.push({ addr: normalize(addr), ticker, name, programs: cur.programs, type: cur.type, uid: cur.uid });
      cur = null; inId = false; inProg = false;
      continue;
    }
    if (t === '<idList>') { inId = true; continue; }
    if (t === '</idList>') { inId = false; continue; }
    if (t === '<programList>') { inProg = true; continue; }
    if (t === '</programList>') { inProg = false; continue; }
    if (inId) {
      if (t === '<id>') { idType = null; idNum = null; }
      else if ((m = t.match(/^<idType>([^<]*)<\/idType>/))) idType = unxml(m[1]);
      else if ((m = t.match(/^<idNumber>([^<]*)<\/idNumber>/))) idNum = unxml(m[1]);
      else if (t === '</id>') {
        const k = idType && idType.match(/^Digital Currency Address - (.+)$/);
        if (k && idNum) cur.ids.push([k[1].trim(), idNum.trim()]);
      }
      continue;
    }
    if (inProg) { if ((m = t.match(/^<program>([^<]*)<\/program>/))) cur.programs.push(unxml(m[1])); continue; }
    if (cur.uid == null && (m = t.match(/^<uid>(\d+)<\/uid>/))) cur.uid = Number(m[1]);
    else if ((m = t.match(/^<firstName>([^<]*)<\/firstName>/))) cur.first = unxml(m[1]);
    else if ((m = t.match(/^<lastName>([^<]*)<\/lastName>/))) cur.last = unxml(m[1]);
    else if ((m = t.match(/^<sdnType>([^<]*)<\/sdnType>/))) cur.type = unxml(m[1]);
  }
  return { published, records, entries };
}

// OFAC writes Publish_Date as MM/DD/YYYY
const isoDate = (d) => { const m = String(d).match(/^(\d{2})\/(\d{2})\/(\d{4})$/); if (!m) throw new Error(`unreadable publish date ${d}`); return `${m[3]}-${m[1]}-${m[2]}`; };

// ---- the stored copy ----
let loaded = null; // { mtimeMs, doc, index }
function load() {
  const f = file();
  let st;
  try { st = fs.statSync(f); } catch { throw unavailable('the sanctions list has not been downloaded yet. Not charged.'); }
  if (loaded && loaded.mtimeMs === st.mtimeMs && loaded.f === f) return loaded;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { throw unavailable('the sanctions list copy is unreadable. Not charged.'); }
  const index = new Map();
  for (const e of doc.entries) { const l = index.get(e.addr); if (l) l.push(e); else index.set(e.addr, [e]); }
  loaded = { f, mtimeMs: st.mtimeMs, doc, index };
  return loaded;
}

function sanctionsCheck(p = {}, { now = Date.now() } = {}) {
  const raw = p.address;
  if (raw == null || String(raw).trim() === '') throw bad('missing required parameter: address');
  const s = String(raw).trim();
  if (s.length > 120 || !ADDRESS_SHAPE.test(s)) throw bad('address must be 14-120 letters and digits (a Bitcoin, Ethereum, Tron, Solana, XRP, Litecoin or similar address)');
  const { doc, index } = load();
  const age = now - Date.parse(doc.fetched_at);
  if (!Number.isFinite(age) || age > MAX_AGE_MS) throw unavailable(`the sanctions list copy is older than 48 hours (fetched ${doc.fetched_at}). Not charged.`);
  const addr = normalize(s);
  const hits = index.get(addr) || [];
  return {
    address: addr,
    address_family: family(addr),
    match: hits.length > 0,
    lists: hits.map((h) => ({ list: 'OFAC SDN', entry_name: h.name, program: h.programs.join(', '), published: doc.published, sdn_type: h.type, chain_ticker: h.ticker, entry_uid: h.uid })),
    checked_lists: [{ list: 'OFAC SDN (Specially Designated Nationals and Blocked Persons)', version_date: doc.published, copy_fetched_at: doc.fetched_at, addresses_on_list: doc.entries.length }],
    not_checked: ['UK OFSI consolidated list (no crypto address data in the published file)', 'EU consolidated list (no crypto address data in the published file)', 'OFAC Consolidated (non-SDN) list'],
    notice: NOTICE,
    source: 'U.S. Treasury OFAC Sanctions List Service (sanctionslistservice.ofac.treas.gov), SDN list',
  };
}

// ---- refresh (cron) ----
// The Sanctions List Service answers the download URL with a 302 to a short-lived signed link on the Treasury's own S3 bucket;
// follow at most 3 redirects, https only, and only to treas.gov or amazonaws.com hosts.
const REDIRECT_OK = /(^|\.)(treas\.gov|amazonaws\.com)$/;
function download(url, dest, { fetchImpl, get = https.get } = {}) {
  if (fetchImpl) return fetchImpl(url, dest);
  return new Promise((resolve, reject) => {
    const hop = (u, left) => {
      const req = get(u, { headers: { 'user-agent': 'AgentFeed/1.0 (+https://x402.ochinimus.app)' }, timeout: 120000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (left <= 0) return reject(new Error('too many redirects'));
          let next; try { next = new URL(res.headers.location, u); } catch { return reject(new Error('bad redirect')); }
          if (next.protocol !== 'https:' || !REDIRECT_OK.test(next.hostname)) return reject(new Error(`refusing redirect to ${next.hostname}`));
          return hop(next.href, left - 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        const out = fs.createWriteStream(dest);
        res.pipe(out); out.on('finish', () => resolve()); out.on('error', reject); res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    };
    hop(url, 3);
  });
}

async function refresh({ url = SDN_URL, fetchImpl, get, now = Date.now() } = {}) {
  const f = file(); const tmpXml = `${f}.xml.tmp`; const tmpJson = `${f}.tmp`;
  try {
    await download(url, tmpXml, { fetchImpl, get });
    const r = await parseSdn(readline.createInterface({ input: fs.createReadStream(tmpXml), crlfDelay: Infinity }));
    // sanity: the real file has ~19k records and ~1,000 addresses; a truncated or re-formatted one must not replace a good copy
    if (!r.published || !r.records || r.records < 10000) throw new Error(`implausible file: records=${r.records} published=${r.published}`);
    if (r.entries.length < 300) throw new Error(`implausible file: only ${r.entries.length} addresses`);
    let prev = null; try { prev = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* first run */ }
    if (prev && r.entries.length < prev.entries.length * 0.5) throw new Error(`refusing to replace ${prev.entries.length} addresses with ${r.entries.length}`);
    fs.writeFileSync(tmpJson, JSON.stringify({ source: url, published: isoDate(r.published), records: r.records, fetched_at: new Date(now).toISOString(), entries: r.entries }));
    fs.renameSync(tmpJson, f);
    return { ok: true, published: isoDate(r.published), records: r.records, addresses: r.entries.length };
  } finally {
    for (const t of [tmpXml, tmpJson]) { try { fs.unlinkSync(t); } catch { /* absent */ } }
  }
}

module.exports = { sanctionsCheck, refresh, parseSdn, normalize, family, NOTICE, MAX_AGE_MS, ADDRESS_SHAPE };

if (require.main === module && process.argv.includes('--refresh')) {
  refresh().then((r) => { console.log(JSON.stringify(r)); }, (e) => { console.error(`sanctions refresh failed, last good copy kept: ${e.message}`); process.exit(1); });
}
