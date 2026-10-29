#!/usr/bin/env node
// bin/news-collect.js: the news brief's collector. Reads the official RSS feeds of three US federal agencies and writes a small snapshot, news.json,
// atomically, the same pattern as bin/macro-collect.js. IT IS NOT INSTALLED ANYWHERE: cron is the owner's step, after PENSIO_NEWS is switched on.
//
//   */30 * * * * cd /opt/agentfeed && /usr/bin/flock -n /var/lock/news.lock /usr/bin/timeout 120 /usr/bin/node bin/news-collect.js >> /opt/agentfeed/news.log 2>&1
//
// SOURCES (docs/SOURCES.md and the pensio NOTES.md quote each reuse clause): SEC press releases, CFTC press releases, Federal Reserve Board press releases.
// These are US federal government releases that each agency says may be copied and distributed; every item keeps its source, link and publication time.
// Exchange announcements and news aggregators are NOT read: their terms were not checked, so they are out (QUESTIONS.md).
//
// One GET per feed per run, a User-Agent that names the service (the SEC asks for one), 20 s timeout. A feed that cannot be read keeps its previous items and
// its previous fetched_at, so the route sees that source going stale instead of a fresh-looking empty list.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');

const SNAP = () => process.env.NEWS_SNAPSHOT || path.join(__dirname, '..', 'news.json');
const UA = 'agentfeed-news/1.0 (+https://x402.ochinimus.app)';
const RETAIN_MS = 7 * 86_400_000;
const MAX_ITEMS_PER_SOURCE = 60;
const SOURCES = [
  { id: 'sec', name: 'SEC press release', url: 'https://www.sec.gov/news/pressreleases.rss', terms: 'https://www.sec.gov/about/privacy-information', agency: 'U.S. Securities and Exchange Commission' },
  { id: 'cftc', name: 'CFTC press release', url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml', terms: 'https://www.cftc.gov/webpolicy/index.htm', agency: 'U.S. Commodity Futures Trading Commission' },
  { id: 'fed', name: 'Federal Reserve Board press release', url: 'https://www.federalreserve.gov/feeds/press_all.xml', terms: 'https://www.federalreserve.gov/disclaimer.htm', agency: 'Board of Governors of the Federal Reserve System' },
];

const text = (v) => {
  if (v == null) return '';
  const s = typeof v === 'object' ? (v['#text'] != null ? v['#text'] : '') : v;
  return String(s);
};
const clean = (s, max) => text(s).replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Pure: an RSS 2.0 document -> { items: [{ id, source, title, link, published_ms, summary }], skipped } */
function parseFeed(xml, source) {
  const doc = new XMLParser({ ignoreAttributes: true, trimValues: true, processEntities: true }).parse(String(xml).replace(/^﻿/, ''));
  const raw = doc && doc.rss && doc.rss.channel && doc.rss.channel.item;
  if (!raw) throw new Error('no RSS items');
  const list = Array.isArray(raw) ? raw : [raw];
  const items = []; let skipped = 0;
  for (const it of list) {
    const title = clean(it.title, 240), link = clean(it.link, 400), ms = Date.parse(text(it.pubDate));
    if (!title || !/^https:\/\//.test(link) || !Number.isFinite(ms)) { skipped++; continue; }
    items.push({ id: crypto.createHash('sha256').update(`${source.id}|${link}`).digest('hex').slice(0, 16), source: source.id, title, link, published_ms: ms, summary: clean(it.description, 400) });
  }
  return { items, skipped };
}

async function collect({ now = Date.now(), fetchImpl = fetch, previous = null, sources = SOURCES } = {}) {
  const prev = new Map(((previous && previous.sources) || []).map((s) => [s.id, s]));
  const prevItems = (previous && previous.items) || [];
  const out = { sources: [], items: [] };
  for (const src of sources) {
    const info = { id: src.id, name: src.name, agency: src.agency, url: src.url, terms: src.terms, ok: false, count: 0, fetched_at_ms: (prev.get(src.id) || {}).fetched_at_ms || null, error: null };
    let got = null;
    try {
      const res = await fetchImpl(src.url, { headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      got = parseFeed(await res.text(), src);
      if (!got.items.length) throw new Error('no usable items');
      info.ok = true; info.fetched_at_ms = now; info.skipped = got.skipped;
    } catch (e) { info.error = String(e.message || e).slice(0, 120); }
    const keep = got ? got.items : prevItems.filter((i) => i.source === src.id);
    const merged = new Map();
    for (const i of [...prevItems.filter((x) => x.source === src.id), ...keep]) merged.set(i.id, i);
    const items = [...merged.values()].filter((i) => now - i.published_ms <= RETAIN_MS).sort((a, b) => b.published_ms - a.published_ms).slice(0, MAX_ITEMS_PER_SOURCE);
    info.count = items.length;
    out.sources.push(info); out.items.push(...items);
  }
  return { version: 1, written_at: new Date(now).toISOString(), written_at_ms: now, sources: out.sources, items: out.items };
}

function readSnapshot(file = SNAP()) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeSnapshot(snap, file = SNAP()) { fs.writeFileSync(file + '.tmp', JSON.stringify(snap)); fs.renameSync(file + '.tmp', file); }

if (require.main === module) {
  collect({ previous: readSnapshot() }).then((snap) => {
    if (!snap.sources.some((s) => s.ok)) { console.error('news-collect: no source could be read:', snap.sources.map((s) => `${s.id} ${s.error}`).join('; ')); process.exit(1); }
    writeSnapshot(snap);
    console.log(`news-collect: ${snap.sources.map((s) => `${s.id} ${s.ok ? 'ok' : 'FAILED ' + s.error} (${s.count})`).join(', ')}`);
  }).catch((e) => { console.error('news-collect failed:', e.message); process.exit(1); });
}
module.exports = { collect, parseFeed, readSnapshot, writeSnapshot, SOURCES, UA, RETAIN_MS, clean };
