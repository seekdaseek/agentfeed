// lib/query-rules.js — which query-parameter values are IMPOSSIBLE, per priced route (R20f, 29 Oct 2026).
//
// A rule here is a copy of a check the route's handler already makes and answers with a 400 (kind 'bad_request'): an integer outside its range,
// a word outside its list, a code that is not the shape the handler requires. lib/param-guard.js runs the rules BEFORE the paywall, so
// ?swaps=5 on /api/sol-token-flow/<mint> is a 400 with no 402, no challenge and nothing to sign, instead of a price followed, after the payer has
// signed, by the same 400 (which settles nothing on any rail, test/param-guard-real-server.test.js).
//
// WHAT A RULE MAY NOT DO: refuse anything the handler serves. Each check below reads the value the way the handler does (`p.x == null || p.x === ''`
// means "not given, use the default", Number() on the raw value, String().toLowerCase() on a word) and is only a rule where the handler's own check
// is deterministic and needs no upstream. test/query-guard-real-server.test.js proves the equivalence on the real server: it boots it twice (guard
// on, guard off with AF_QUERY_GUARD=off) and sends every boundary value of every rule to both; a value the guard refuses must be a handler
// bad_request with the guard off, and a value the guard lets through must reach the handler.
//
// WHAT IS NOT HERE, and why:
//   - a MISSING required parameter: the query-less URL of a route is what /.well-known/x402, the OpenAPI document and every catalogue list, and
//     it answers 402 (CDP validate, x402scan and the Bazaar crawler all read that 402); turning it into a 400 would break every listed entry.
//   - symbols, tickers' existence, mints, URLs, JSON or text bodies: they need an upstream (Hyperliquid's universe, the SEC list, DNS) or are free text.
//   - limits the handler CLAMPS (liquidations limit, cascade window, funding-extremes limit ...): they never answer 400, so nothing to refuse.
//   - /api/time tz and at: several accepted spellings, the regex alone is not the whole rule.
// A route or parameter with no rule here is simply not guarded: the guard narrows, it never takes a route down.
'use strict';

const given = (v) => v != null && v !== '';             // the handlers' "not given" test: p.x == null || p.x === ''
const nonBlank = (v) => v != null && String(v).trim() !== '';

/** an integer between min and max (max may be a function of the context, e.g. the current year); not given = the default. `message` is the handler's own sentence when it is not the usual one */
function int(name, min, max, expected, { schemaMax, message } = {}) {
  return {
    name, kind: 'int', min, max, schemaMax, expected,
    check(q, ctx) {
      const v = q[name];
      if (!given(v)) return null;
      const hi = typeof max === 'function' ? max(ctx) : max;
      const n = Number(v);
      return Number.isInteger(n) && n >= min && n <= hi ? null : (message || `${name} must be an integer from ${min} to ${hi}`);
    },
  };
}

/** a finite number between min and max (fractions allowed) */
function num(name, min, max, expected) {
  return {
    name, kind: 'num', min, max, expected,
    check(q) {
      const v = q[name];
      if (!given(v)) return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= min && n <= max ? null : `${name} must be a number from ${min} to ${max}`;
    },
  };
}

/** one of a list of words, compared lower-cased; not given = the default */
function words(name, list, expected, { when = () => true } = {}) {
  return {
    name, kind: 'enum', values: list, expected,
    check(q) {
      const v = q[name];
      if (!given(v) || !when(q)) return null;
      return list.includes(String(v).toLowerCase()) ? null : `${name} must be ${list.length === 2 ? list.join(' or ') : list.slice(0, -1).join(', ') + ' or ' + list[list.length - 1]}`;
    },
  };
}

/** any other check: fn(q, ctx) -> null | message. `kind: 'custom'` rules carry their own boundary values for the tests (samples: { ok: [...], bad: [...], unitOnly?: { ok, bad } }; unitOnly values are too large for a URL) */
function custom(name, expected, fn, samples) {
  return { name, kind: 'custom', expected, check: fn, samples };
}

const TICKER_MSG = 'ticker must be a US-listed symbol such as AAPL, MSFT or BRK-B';
const tickerRule = custom('ticker', 'a US-listed ticker: 1 to 10 letters, digits, dots or hyphens, e.g. AAPL, MSFT, BRK-B', (q) => {
  if (!nonBlank(q.ticker)) return null;                  // missing is the handler's own "missing" answer and the catalogue's query-less 402 stays
  return /^[A-Z0-9.\-]{1,10}$/.test(String(q.ticker).trim().toUpperCase()) ? null : TICKER_MSG;
}, { ok: ['AAPL', ' brk-b ', 'BRK.B', 'A'], bad: ['AAPL!', 'TOOLONGTICKER1', 'a b', '$AAPL'] });


/** free text of at most `max` characters (counted in code points, as the handler does); an empty text is the handler's own "missing" answer */
const textCap = (name, max) => custom(name, `at most ${max} characters`, (q) => {
  const text = q[name] == null ? '' : String(q[name]);
  if (!text.trim()) return null;
  return [...text].length > max ? `${name} is over the ${max}-character limit` : null;
}, { ok: ['hello', 'x'.repeat(max)], bad: ['x'.repeat(max + 1)],
  // code points, not UTF-16 units: too long to send in a URL (12 bytes each percent-encoded), so the unit test checks them and the real-server test does not
  unitOnly: { ok: ['😀'.repeat(Math.floor(max / 2) + 1), '😀'.repeat(max)], bad: ['😀'.repeat(max + 1)] } });

/** the 2 KB cap of tools/utils.js `capped()`: bytes, UTF-8, counted before any trim */
const byteCap = (name) => custom(name, 'at most 2048 bytes', (q) => (q[name] != null && Buffer.byteLength(String(q[name]), 'utf8') > 2048 ? `${name} is over the 2048-byte limit` : null),
  { ok: ['hello', 'x'.repeat(2048)], bad: ['x'.repeat(2049), 'é'.repeat(1025)] });

/** a url parameter: it must parse as an absolute URL (the handlers trim first); `protoMsg` is the sentence the route's own fetch layer uses for another scheme; `max` is the media routes' length cap */
const urlRule = ({ protoMsg, max = 0 } = {}) => custom('url', `an absolute http or https URL${max ? ` of at most ${max.toLocaleString('en-US')} characters` : ''}`, (q) => {
  if (!nonBlank(q.url)) return null;
  const s = String(q.url).trim();
  if (max && s.length > max) return `url is longer than ${max.toLocaleString('en-US')} characters`;
  let u;
  try { u = new URL(s); } catch { return 'url must be an absolute http or https URL'; }
  return u.protocol === 'http:' || u.protocol === 'https:' ? null : protoMsg;
}, { ok: ['https://example.com/a?b=1', ' http://example.com ', 'HTTPS://EXAMPLE.COM'], bad: ['example.com', 'www.example.com/page', '//example.com', 'not a url', 'ftp://example.com/x', 'javascript:alert(1)', ...(max ? ['https://example.com/' + 'a'.repeat(max)] : [])] });
const WEB_PROTO = 'only http and https URLs are fetched';          // lib/safe-fetch.js checkUrl, behind tools/webmd.js
const MEDIA_PROTO = 'url must be an absolute http or https URL';   // tools/llm/media.js parseUrl

const YEAR_NOW = (ctx) => new Date(ctx.now).getUTCFullYear() + 1;

/** route pattern (the PRICES key) -> [rule] */
const QUERY_RULES = {
  'GET /api/sec-filings': [
    tickerRule,
    int('limit', 1, 50, 'an integer from 1 to 50 (default 10)'),
    custom('form', 'one EDGAR form type: letters, digits, hyphens, slashes and spaces, up to 14 characters, e.g. 10-K, 10-Q, 8-K, 4, DEF 14A', (q) => {
      if (!q.form) return null;                            // the handler: p.form ? ... : null
      const form = String(q.form).trim().toUpperCase().replace(/\s+/g, ' ');
      return !form || /^[A-Z0-9][A-Z0-9\-/ ]{0,13}$/.test(form) ? null : 'form must be an EDGAR form type such as 10-K, 10-Q, 8-K, 4, S-1, DEF 14A or 13F-HR';
    }, { ok: ['10-K', ' def  14a ', '4'], bad: ['!', '-10K', 'A'.repeat(15)] }),
  ],
  'GET /api/insider-trades': [
    tickerRule,
    int('days', 1, 180, 'an integer from 1 to 180 (default 30)'),
  ],
  'GET /api/sec-8k': [
    int('hours', 1, 72, 'an integer from 1 to 72 (default 24)'),
  ],
  'GET /api/signal-board': [
    int('n', 1, 60, 'an integer from 1 to 60 (default 30)'),
    custom('coins', 'a comma list of at most 20 coins, e.g. BTC,ETH,SOL', (q) => {
      if (!nonBlank(q.coins)) return null;
      const want = [...new Set(String(q.coins).split(',').map((s) => s.trim()).filter(Boolean))];
      return want.length > 20 ? 'coins takes at most 20 coins' : null;
    }, { ok: ['BTC', 'BTC,ETH,SOL', ' , '], bad: [Array.from({ length: 21 }, (_, i) => `C${i}`).join(',')] }),
  ],
  'GET /api/papers': [
    int('limit', 1, 25, 'an integer from 1 to 25 (default 10)'),
    int('year_from', 1000, YEAR_NOW, 'a four-digit year no later than next year, e.g. 2022', { schemaMax: 9999, message: 'year_from must be a four-digit year' }),   // the published schema says 4 digits; the live maximum moves with the clock
    custom('q', 'search text of at most 200 characters', (q) => (q.q != null && String(q.q).trim().length > 200 ? 'q is longer than 200 characters' : null),
      { ok: ['deep learning', 'x'.repeat(200), ` ${'x'.repeat(200)} `], bad: ['x'.repeat(201)] }),
  ],
  'GET /api/hl-whales': [
    int('top', 1, 50, 'an integer from 1 to 50 (default 20)'),
    custom('coin', 'a Hyperliquid perp name such as BTC, ETH, SOL or HYPE', (q) => {
      const c = q.coin == null || q.coin === '' ? null : String(q.coin).trim().toUpperCase().replace(/(USDT|-PERP|PERP)$/, '');
      return c && !/^[A-Z0-9:]{1,20}$/.test(c) ? 'coin must be a Hyperliquid perp name such as BTC, ETH, SOL or HYPE' : null;
    }, { ok: ['BTC', 'btcusdt', 'ETH-PERP', 'xyz:TSLA', 'kPEPE'], bad: ['BTC/ETH', 'a b', 'A'.repeat(21), '../x'] }),
  ],
  'GET /api/sol-token-flow/:mint': [
    int('swaps', 20, 100, 'an integer from 20 to 100 (default 50)'),
  ],
  'GET /api/base-launches': [
    num('min_liq_usd', 0, 1e12, 'a number from 0 to 1000000000000 (default 1000; 0 lists every launch)'),
    num('limit', 1, 100, 'a number from 1 to 100 (default 20)'),
  ],
  'GET /api/qr': [
    byteCap('data'),
    words('format', ['svg', 'png'], 'svg or png (default svg)'),
  ],
  'GET /api/hash': [
    words('alg', ['sha256', 'keccak256', 'blake2b'], 'sha256, keccak256 or blake2b'),
    words('as', ['utf8', 'hex'], 'utf8 or hex (default utf8)'),
    custom('data', 'at most 2048 bytes; with as=hex: an even number of hex digits, optionally 0x-prefixed', (q) => {
      if (q.data != null && Buffer.byteLength(String(q.data), 'utf8') > 2048) return 'data is over the 2048-byte limit';   // capped() runs before the hex check
      if (!given(q.as) || String(q.as).toLowerCase() !== 'hex' || q.data == null) return null;
      const h = String(q.data).replace(/^0x/i, '');
      return h.length % 2 || !/^[0-9a-f]*$/i.test(h) ? 'as=hex needs an even number of hex digits' : null;
    }, { ok: [{ as: 'hex', data: '0xdeadbeef' }, { as: 'hex', data: '' }, { as: 'utf8', data: 'zz' }, { data: 'zz' }, { data: 'x'.repeat(2048) }], bad: [{ as: 'hex', data: 'abc' }, { as: 'HEX', data: 'zz' }, { as: 'hex', data: '0xabc' }, { data: 'x'.repeat(2049) }] }),
  ],
  'GET /api/convert': [
    byteCap('from'),
    byteCap('to'),
    custom('value', 'a plain decimal number such as 12.5, -3 or 1e3', (q) => {
      if (!given(q.value)) return null;
      const raw = String(q.value).trim();
      if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(raw)) return 'value must be a plain number';
      return Number.isFinite(Number(raw)) ? null : 'value is out of range';
    }, { ok: ['12.5', '-3', ' 1e3 ', '.5', '5.', '+7'], bad: ['abc', '1,5', '0x10', '1e999', ' ', 'NaN', '--1'] }),
  ],
  'GET /api/summarize': [
    urlRule({ protoMsg: WEB_PROTO }),
    words('length', ['short', 'medium'], 'short or medium (default short)'),
  ],
  'GET /api/tradfi-radar': [
    custom('class', 'a comma list of: stock, index, commodity, fx, rates, pre_ipo, crypto_index, other, unclassified', (q) => {
      const raw = q.class || q.asset_class;
      if (!raw) return null;
      const names = require('../tools/tradfi').CLASS_NAMES;
      const cls = String(raw).toLowerCase().split(',').map((x) => x.trim());
      return cls.some((c) => !names.includes(c)) ? `class must be one of ${names.join(', ')}` : null;
    }, { ok: ['stock', 'STOCK,Index', ' fx , rates '], bad: ['stocks', 'stock,', 'stock;fx'] }),
  ],
  'GET /api/tradfi-perps': [
    custom('symbol', 'a HIP-3 ticker such as TSLA, GOLD or EUR, or a dex-qualified market such as xyz:TSLA', (q) => {
      const raw = q.symbol == null || q.symbol === '' ? null : String(q.symbol).trim();
      return raw && !/^([a-z0-9]{1,8}:)?[A-Za-z0-9._\-]{1,20}$/.test(raw) ? 'symbol must be a HIP-3 ticker such as TSLA, GOLD or EUR, or a dex-qualified market such as xyz:TSLA' : null;
    }, { ok: ['TSLA', 'xyz:TSLA', ' GOLD ', 'EUR'], bad: ['A B', 'xyz:', 'x'.repeat(21), 'TSLA/USD'] }),
  ],
  'GET /api/fx-rates': [
    custom('base', 'a 3-letter currency code such as EUR, USD or JPY (default EUR)', (q) => {
      const b = q.base == null || q.base === '' ? 'EUR' : String(q.base).trim().toUpperCase();
      return /^[A-Z]{3}$/.test(b) ? null : 'base must be a 3-letter currency code such as EUR, USD or JPY';
    }, { ok: ['EUR', 'usd', ' jpy '], bad: ['EURO', 'E1R', 'EU', '€'] }),
  ],
  'GET /api/wiki': [
    custom('title', 'a page title of at most 200 characters without control characters or any of # < > [ ] { | }', (q) => {
      const title = q.title == null ? '' : String(q.title).trim().replace(/_/g, ' ');
      if (!title) return null;
      if (title.length > 200) return 'title is longer than 200 characters';
      return /[\u0000-\u001f#<>[\]{|}]/.test(title) ? 'title has characters a Wikipedia page name cannot have' : null;
    }, { ok: ['Bitcoin', 'Satoshi_Nakamoto', 'x'.repeat(200)], bad: ['x'.repeat(201), 'a#b', 'a|b', 'a{b}', 'a\u0001b', '[x]'] }),
    custom('lang', 'a Wikipedia language code: 2 or 3 letters, optionally with a suffix of 2 to 8 letters, e.g. en, de, zh-yue (default en)', (q) => {
      const l = q.lang == null || q.lang === '' ? 'en' : String(q.lang).trim().toLowerCase();
      return /^[a-z]{2,3}(-[a-z]{2,8})?$/.test(l) ? null : 'lang must be a Wikipedia language code such as en, de or simple';
    }, // the handler's own sentence says "such as en, de or simple" but its regex refuses 'simple' (6 letters): mirrored as it is, reported (R20f report)
    { ok: ['en', 'DE', 'zh-yue', ' fr ', 'ceb'], bad: ['e', 'english', 'en_US', 'e1', 'simple'] }),
  ],
  'GET /api/honeypot-check': [
    custom('token', 'a 0x token contract address: 40 hex characters', (q) => {
      const t = String(q.token || '').trim();
      return !t || /^0x[0-9a-fA-F]{40}$/.test(t) ? null : 'token must be a 0x contract address (40 hex characters)';
    }, { ok: ['0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed'], bad: ['0x123', '4ed4E862860beD51a9570b96d89aF5E1B0Efefed00', 'not-an-address', `0x${'g'.repeat(40)}`] }),
    custom('chain', 'base, bsc or ethereum (default base)', (q) => {
      const name = String(q.chain || 'base').trim().toLowerCase();
      const chains = require('../tools/honeypot').CHAINS;
      return chains[name] ? null : `chain ${name} is not supported; supported: ${Object.keys(chains).join(', ')}`;
    }, { ok: ['base', 'BSC', ' ethereum '], bad: ['solana', 'eth', 'base2'] }),
  ],
  'GET /api/translate': [
    textCap('text', 4000),
    custom('to', 'a language code such as de, fr, ja, pt-BR or zh-Hans', (q) => {
      const to = q.to == null ? '' : String(q.to).trim();
      if (!to) return null;                                // missing is the handler's own answer
      try { require('../tools/translate').languageName(to); return null; } catch (e) { return e.message; }
    }, { ok: ['de', 'pt-BR', 'zh-Hans', ' fr '], bad: ['german', 'd', 'de_DE', 'xx-yy-zz-ww'] }),
  ],
  'GET /api/liq-feed': [
    custom('since', 'a time in milliseconds since the epoch, e.g. since=1792064900000 (ignored when next is sent)', (q) => {
      if (nonBlank(q.next) || !nonBlank(q.since)) return null;   // the handler reads since only when next is not given
      return /^\d{1,15}$/.test(String(q.since).trim()) ? null : 'since must be a time in milliseconds since the epoch, e.g. since=1792064900000';
    }, { ok: ['1792064900000', ' 1792064900000 ', { next: '1.2', since: 'abc' }], bad: ['abc', '-5', '1.5', '1'.repeat(16)] }),
    custom('next', 'the `next` value a previous answer returned: digits, a dot, digits', (q) => {
      if (!nonBlank(q.next)) return null;
      return /^(\d{1,15})\.(\d{1,12})$/.test(String(q.next).trim()) ? null : 'next must be the `next` value a previous answer returned';
    }, { ok: ['1792064900000.123', ' 12.3 '], bad: ['abc', '123', '1.2.3', '.5', '1'.repeat(16) + '.1'] }),
  ],
  'GET /api/funding-radar': [
    custom('min_oi_usd', 'a number of 0 or more', (q) => {
      if (!given(q.min_oi_usd)) return null;
      const n = Number(q.min_oi_usd);
      return Number.isFinite(n) && n >= 0 ? null : `invalid min_oi_usd: ${q.min_oi_usd}`;
    }, { ok: ['0', '1000000', '1e6', ' 5 ', '-0', '0.5'], bad: ['-1', 'abc', 'Infinity', '-0.5', '1e999'] }),
  ],
  'GET /api/base-balance': [
    custom('chain', 'base or ethereum (default base); aliases base-mainnet, 8453, eth, mainnet, eth-mainnet, 1', (q) => {
      const b = require('../tools/base');
      return b.CHAIN_ALIAS[String(q.chain || q.network || 'base').trim().toLowerCase()] ? null
        : `unsupported chain: ${q.chain || q.network}. This endpoint serves ${Object.values(b.CHAINS).map((c) => c.name).join(' and ')}.`;
    }, { ok: ['base', 'ETHEREUM', ' eth ', '8453', 'mainnet'], bad: ['solana', 'bsc', '137', 'base2'] }),
    custom('address', 'a 0x address (40 hex characters) or an ENS name ending .eth', (q) => {
      const a = String(q.address || q.wallet || '').trim();
      if (!a) return null;
      return /^0x[0-9a-fA-F]{40}$/.test(a) || /^[a-z0-9-]([a-z0-9-]*\.)+eth$/i.test(a) ? null
        : `not a valid address: ${a}. Expected 0x followed by 40 hex characters, or an ENS name ending .eth.`;
    }, { ok: ['0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', 'vitalik.eth', ' Vitalik.ETH '], bad: ['0x123', 'vitalik', 'vitalik.com', `0x${'g'.repeat(40)}`] }),
    custom('token', 'a 0x contract address or a token symbol the endpoint knows', (q) => {
      const token = q.token ? String(q.token).trim() : null;
      if (!token || /^0x[0-9a-fA-F]{40}$/.test(token)) return null;
      const known = require('../tools/base').BASE_TOKENS;
      return known[token.toUpperCase()] ? null : `unknown token: ${token}. Pass an ERC20 contract address (0x + 40 hex) or one of ${Object.keys(known).join(', ')}.`;
    }, { ok: ['USDC', 'usdc', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'], bad: ['NOTATOKEN', '0x123', 'US DC'] }),
  ],
  'GET /api/email-verify': [
    custom('email', 'an email address of at most 254 characters', (q) => (nonBlank(q.email) && String(q.email).length > 254 ? 'email is longer than 254 characters' : null),
      { ok: ['a@b.co', `${'x'.repeat(240)}@example.com`.slice(0, 254)], bad: ['x'.repeat(255)] }),
  ],
  'GET /api/injection-check': [textCap('text', 4000)],
  'GET /api/classify': [
    textCap('text', 4000),
    custom('labels', '2 to 20 labels, comma separated (or a JSON array), each 1 to 50 characters', (q) => {
      if (!nonBlank(q.labels)) return null;
      try { require('../tools/classify').parseLabels(q.labels); return null; } catch (e) { return e.message; }
    }, { ok: ['a,b', 'positive, negative, neutral', '["a","b"]'], bad: ['a', 'a,', '[1,2]', '["a"]', Array.from({ length: 21 }, (_, i) => `l${i}`).join(',')] }),
  ],
  'GET /api/extract': [
    urlRule({ protoMsg: WEB_PROTO }),
    custom('schema', 'a JSON object of 1 to 20 field names to types (string, number, boolean, date, string[]), up to 2 KB', (q) => {
      if (!nonBlank(q.schema)) return null;
      try { require('../tools/extract').parseSchema(q.schema); return null; } catch (e) { return e.message; }
    }, { ok: ['{"title":"string","price":"number"}'], bad: ['not json', '[]', '{}', '{"a":"blob"}', '{"1a":"string"}'] }),
  ],
  'GET /api/web-markdown': [urlRule({ protoMsg: WEB_PROTO })],
  'GET /api/pdf-markdown': [urlRule({ protoMsg: WEB_PROTO })],
  'GET /api/ocr': [urlRule({ protoMsg: MEDIA_PROTO, max: 2048 })],
  'GET /api/transcribe': [urlRule({ protoMsg: MEDIA_PROTO, max: 2048 })],
  // R23 (31 Oct 2026): the handlers' own range checks (tools/r23/cascade-backtest, claim-check), read the way they read them
  'GET /api/cascade-backtest': [
    words('side', ['long', 'short', 'both'], 'long, short or both (default both)'),
    num('min_usd', 10000, 1e9, 'a number from 10000 to 1000000000 (default 100000)'),
    int('window_min', 1, 60, 'an integer from 1 to 60 (default 5)'),
    int('cooldown_min', 15, 1440, 'an integer from 15 to 1440 (default 60)'),
    int('limit', 1, 100, 'an integer from 1 to 100 (default 20)'),
  ],
  'GET /api/claim-check': [textCap('claim', 300)],
  'GET /api/equity-24h': [
    custom('symbol', 'a US stock or index ticker: 1 to 12 letters, digits or dots, e.g. TSLA, NVDA, SP500', (q) => {
      if (!nonBlank(q.symbol)) return null;
      const sym = String(q.symbol || '').toUpperCase().replace(/X$/, '').trim();
      return /^[A-Z0-9.]{1,12}$/.test(sym) ? null : 'symbol required: a US stock or index ticker, e.g. TSLA, NVDA, SP500';
    }, { ok: ['TSLA', 'tslax', 'SP500', 'BRK.B'], bad: ['TS LA', 'TSLA!', 'TOOLONGTICKERSYMBOL', '$TSLA'] }),
  ],
};

/** the rules of one route, or [] */
const rulesFor = (pattern) => QUERY_RULES[pattern] || [];

/** -> null (every rule passes) | { rule, message } for the first rule the query breaks */
function checkQuery(pattern, query, ctx = { now: Date.now() }) {
  const q = query || {};
  for (const rule of rulesFor(pattern)) {
    const message = rule.check(q, ctx);
    if (message) return { rule, message };
  }
  return null;
}

module.exports = { QUERY_RULES, rulesFor, checkQuery, int, num, words, custom };
