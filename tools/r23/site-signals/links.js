// tools/r23/site-signals/links.js: the contact and social links a page itself links to (R23 T6). Pure: extractLinks(tags, baseUrl) reads the href of <a> tags only:
// mailto: and tel: targets, and profile-style links to X / Twitter, GitHub, LinkedIn, Discord, Telegram, YouTube, Instagram and Facebook. No text of the page is searched for
// addresses, share buttons (intent, sharer and sharing URLs) are not profile links and are left out, query strings and fragments are dropped, each list is de-duplicated
// and capped.
'use strict';

const CAP = 10;
const EMAIL_RE = /^[a-z0-9._%+\-]{1,64}@[a-z0-9.\-]{1,190}\.[a-z]{2,24}$/;

// id, hosts (a subdomain such as www. or m. also matches), how many path segments make the link, first segments that are not profiles, required first segments
const SOCIAL = [
  { id: 'x', hosts: ['x.com', 'twitter.com'], canon: 'x.com', segs: 1, skip: ['intent', 'share', 'home', 'i', 'search', 'hashtag', 'explore', 'settings', 'login', 'signup', 'tos', 'privacy', 'compose', 'messages', 'notifications'] },
  { id: 'github', hosts: ['github.com'], canon: 'github.com', segs: 2, skip: ['login', 'join', 'features', 'pricing', 'about', 'contact', 'topics', 'marketplace', 'settings', 'sponsors', 'search', 'notifications', 'pulls', 'issues', 'new', 'explore', 'collections', 'trending', 'enterprise', 'customer-stories', 'security', 'orgs'] },
  { id: 'linkedin', hosts: ['linkedin.com'], canon: 'www.linkedin.com', segs: 2, only: ['company', 'in', 'school', 'showcase'] },
  { id: 'discord', hosts: ['discord.gg', 'discord.com'], canon: null, segs: 1 },
  { id: 'telegram', hosts: ['t.me', 'telegram.me'], canon: 't.me', segs: 1, skip: ['share'] },
  { id: 'youtube', hosts: ['youtube.com'], canon: 'www.youtube.com', segs: 1, only: ['channel', 'c', 'user'], atHandle: true },
  { id: 'instagram', hosts: ['instagram.com'], canon: 'www.instagram.com', segs: 1, skip: ['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'tv', 'direct'] },
  { id: 'facebook', hosts: ['facebook.com'], canon: 'www.facebook.com', segs: 1, skip: ['sharer', 'sharer.php', 'share', 'share.php', 'dialog', 'plugins', 'tr', 'login', 'l.php', 'policy', 'policies', 'help', 'privacy', 'v2.0', 'v3.0'] },
];
const IDS = SOCIAL.map((s) => s.id);
// a cheap test before any URL is built: an absolute or protocol-relative link whose host is, or is under, one of the social hosts. Relative links point at the page's own site
// and are not profile links, so they are skipped without parsing. Linear: one alternation over a href of at most 600 characters.
const HOST_ALT = [...new Set(SOCIAL.flatMap((x) => x.hosts))].map((h) => h.replace(/\./g, '\\.')).join('|');
const SOCIAL_HREF = new RegExp(`^(?:https?:)?//(?:[^/?#@]*\\.)?(?:${HOST_ALT})(?:[/?#:]|$)`, 'i');

const hostMatches = (host, hosts) => hosts.find((h) => host === h || host.endsWith(`.${h}`)) || null;

/** one social link -> { id, url } or null */
function socialOf(u) {
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean).map((s) => s.slice(0, 100));
  for (const s of SOCIAL) {
    const matched = hostMatches(host, s.hosts);
    if (!matched) continue;
    if (s.id === 'discord') {
      // discord.gg/<code> or discord.com/invite/<code>
      if (matched === 'discord.gg' && segs.length >= 1) return { id: s.id, url: `https://discord.gg/${segs[0]}` };
      if (matched === 'discord.com' && segs[0] === 'invite' && segs[1]) return { id: s.id, url: `https://discord.com/invite/${segs[1]}` };
      return null;
    }
    if (!segs.length) return null;
    const first = segs[0].toLowerCase();
    if (s.skip && s.skip.includes(first)) return null;
    if (s.id === 'youtube') {
      if (segs[0].startsWith('@') && segs[0].length > 1) return { id: s.id, url: `https://${s.canon}/${segs[0]}` };
      return s.only.includes(first) && segs[1] ? { id: s.id, url: `https://${s.canon}/${segs[0]}/${segs[1]}` } : null;
    }
    if (s.only) return s.only.includes(first) && segs[1] ? { id: s.id, url: `https://${s.canon}/${segs[0]}/${segs[1]}` } : null;
    const use = segs.slice(0, s.segs);
    return { id: s.id, url: `https://${s.canon}/${use.join('/')}` };
  }
  return null;
}

function add(list, v) { if (list.length < CAP && !list.includes(v)) list.push(v); }

/** a reader that takes anchor hrefs one at a time and keeps only the lists: read(href) per <a>, then result(). Nothing about the page is retained. */
function makeLinkReader(baseUrl) {
  const emails = []; const phones = []; const social = {};
  for (const id of IDS) social[id] = [];
  let truncated = false;
  return {
    read(hrefRaw) {
      const href = String(hrefRaw || '').trim();
      if (!href) return;
      const lower = href.slice(0, 7).toLowerCase();
      if (lower === 'mailto:') {
        const addr = href.slice(7).split(/[?#]/)[0].split(',')[0].trim().toLowerCase();
        let dec = addr; try { dec = decodeURIComponent(addr); } catch { /* keep the raw text */ }
        if (EMAIL_RE.test(dec)) { if (emails.length >= CAP && !emails.includes(dec)) truncated = true; add(emails, dec); }
        return;
      }
      if (lower.slice(0, 4) === 'tel:') {
        const num = href.slice(4).split(/[?#;]/)[0].replace(/[\s().\-]/g, '');
        if (/^\+?\d{5,16}$/.test(num)) { if (phones.length >= CAP && !phones.includes(num)) truncated = true; add(phones, num); }
        return;
      }
      if (href.length > 600 || !SOCIAL_HREF.test(href)) return;      // relative, another site, or a long tracking link: not a profile link, and no URL is built for it
      let u;
      try { u = new URL(href, baseUrl); } catch { return; }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
      const s = socialOf(u);
      if (!s) return;
      if (social[s.id].length >= CAP && !social[s.id].includes(s.url)) truncated = true;
      add(social[s.id], s.url);
    },
    result() { return { ok: true, emails, phones, social, truncated }; },
  };
}

/** -> { ok: true, emails[], phones[], social: { x[], github[], ... }, truncated } from a list of scanned tags (tests; the route feeds the reader straight from the scan) */
function extractLinks(tags, baseUrl) {
  const reader = makeLinkReader(baseUrl);
  for (const t of tags) if (t.name === 'a') reader.read(t.attrs.href);
  return reader.result();
}

module.exports = { extractLinks, makeLinkReader, socialOf, SOCIAL, CAP };
