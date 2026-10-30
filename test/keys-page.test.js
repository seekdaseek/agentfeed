// R9 2b: GET /keys. The page must load nothing from anywhere, call nothing but this origin, and its CSP hashes must
// match the inline script and style it ships (a mismatch would leave a page whose Buy button silently does nothing).
// The browser flow itself (mock EIP-1193 wallet, real @x402/express, a facilitator stub verifying the EIP-712
// signature with viem) was run in the browser pane; see the R9 report.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { HTML, CSP, keysPage } = require('../tools/keys-page');

const hashOf = (s) => "'sha256-" + crypto.createHash('sha256').update(s, 'utf8').digest('base64') + "'";

test('keys page: the CSP allows exactly its inline script and style, same-origin fetches, nothing else', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(HTML)[1];
  const style = /<style>([\s\S]*?)<\/style>/.exec(HTML)[1];
  assert.match(CSP, new RegExp(`script-src ${hashOf(script).replace(/[+/]/g, '\\$&')}(;|$)`));
  assert.match(CSP, new RegExp(`style-src ${hashOf(style).replace(/[+/]/g, '\\$&')}(;|$)`));
  assert.match(CSP, /default-src 'none'/);
  assert.match(CSP, /connect-src 'self'/);
  assert.equal((HTML.match(/<script/g) || []).length, 1, 'one inline script, no <script src>');
  assert.ok(!/<link[^>]+stylesheet/.test(HTML) && !/@import|url\(/.test(style), 'no external stylesheet or font');
  const urls = HTML.match(/https?:\/\/[^\s"'<]+/g) || [];
  assert.deepEqual([...new Set(urls.map((u) => new URL(u).host))].sort(), ['github.com', 'x402.ochinimus.app'], 'only a docs link and the curl example');
  assert.ok(!/fetch\(['"`]https?:/.test(script), 'every fetch is relative');
});

test('keys page: sends key_hash and never the key; signs EIP-3009 on Base only; shows the key after the 200', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(HTML)[1];
  assert.match(script, /key_hash='\+\(await sha256hex\(key\)\)/);
  assert.ok(!/[?&]key=/.test(script), 'no key in a URL');
  assert.match(script, /primaryType:'TransferWithAuthorization'/);
  assert.match(script, /a\.network===BASE&&a\.scheme==='exact'/);
  assert.match(script, /a\.extra\.name!=='GatewayWalletBatched'/);
  assert.ok(script.indexOf("$('key').textContent=key") > script.indexOf('if(r.status!==200)'), 'the key is shown only after a 200');
});

test('keys page: served with its CSP and no-referrer', () => {
  const h = {};
  let sent = null;
  const res = { set: (k, v) => { h[k] = v; }, type() { return this; }, send: (b) => { sent = b; } };
  keysPage({}, res);
  assert.equal(h['Content-Security-Policy'], CSP);
  assert.equal(h['Referrer-Policy'], 'no-referrer');
  assert.equal(sent, HTML);
});

// ---- R13 item 1 (15 Oct 2026): the page's script, run for real against a stub wallet and a stub server. A stranger buying the bot pass
// must see the pass's price, scope and term, get the key once with a header example that works for a pass (liq-feed, not signal-board),
// and the fine print must not say a pass has "no expiry".
const { _SCRIPT } = require('../tools/keys-page');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

async function runPage({ pack, price, data }) {
  const els = {};
  const el = (id) => (els[id] ||= { id, textContent: '', style: {}, className: '', disabled: false, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } });
  const accept = { scheme: 'exact', network: 'eip155:8453', amount: String(price * 1e6), asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6', maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } };
  const seen = { urls: [], typed: null };
  const fetchStub = async (url, init = {}) => {
    seen.urls.push(url);
    const paid = init.headers && init.headers['PAYMENT-SIGNATURE'];
    if (!paid) return { status: 402, headers: { get: (k) => (k.toLowerCase() === 'payment-required' ? b64({ x402Version: 2, resource: { url: 'https://x402.ochinimus.app' + url.split('?')[0] }, accepts: [accept] }) : null) }, text: async () => '' };
    return { status: 200, headers: { get: () => null }, json: async () => ({ data }) };
  };
  const window = { ethereum: { request: async ({ method, params }) => {
    if (method === 'eth_requestAccounts') return ['0x' + 'ab'.repeat(20)];
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_signTypedData_v4') { seen.typed = JSON.parse(params[1]); return '0x' + '11'.repeat(65); }
    throw new Error('unexpected wallet call ' + method);
  } } };
  const document = { getElementById: el, querySelector: () => ({ value: pack }) };
  new Function('document', 'window', 'crypto', 'fetch', 'navigator', _SCRIPT)(document, window, globalThis.crypto, fetchStub, {});
  await els.buy.listeners.click();
  return { els, seen };
}

test('keys page: the generated script parses', () => { new Function(_SCRIPT); });

test('keys page: buying the bot pass signs $25, shows the key once, and gives a header example that works for a pass', async () => {
  const data = { prefix: 'abcd1234', pass: { price_usd: 25, days: 30, routes: ['/api/liq-feed'], starts: 'when this payment settles', expires: '30 days after that' }, status: 'active', rate_per_min: 120 };
  const { els, seen } = await runPage({ pack: 'pass', price: 25, data });
  assert.equal(els.status.className, 'ok', els.status.textContent);
  assert.match(els.key.textContent, /^afk_[1-9A-HJ-NP-Za-km-z]{32,64}$/);
  assert.equal(els.result.style.display, 'block');
  assert.ok(seen.urls[0].startsWith('/api/keys/buy-pass?key_hash='));
  assert.equal(seen.typed.message.value, '25000000');
  assert.equal(seen.typed.message.to, '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6');
  assert.match(els.meta.textContent, /bot pass for \/api\/liq-feed only, valid until about 20\d\d-\d\d-\d\d \(30 days from this payment\), one call every 10 seconds, nothing drawn per call/);
  assert.match(els.examples.textContent, /^curl "https:\/\/x402\.ochinimus\.app\/api\/liq-feed\?symbols=BTCUSDT,ETHUSDT" -H "X-AgentFeed-Key: afk_\.\.\."\ncurl https:\/\/x402\.ochinimus\.app\/api\/keys\/balance .*expiry$/);
  assert.ok(!/signal-board/.test(els.examples.textContent), 'a pass key is refused on every other route (403)');
});

test('keys page: a pack still shows its balance and keeps the signal-board example', async () => {
  const { els } = await runPage({ pack: '5', price: 5, data: { prefix: 'abcd1234', balance_usd: 5, rate_per_min: 120, status: 'active' } });
  assert.equal(els.status.className, 'ok', els.status.textContent);
  assert.match(els.meta.textContent, /balance \$5, 120 requests a minute/);
  assert.equal(els.examples, undefined, 'the static example in the HTML is left alone');
});

test('keys page: the fine print states the pass term and does not say a pass has no expiry', () => {
  assert.match(HTML, /A prepaid balance is a usage credit: non-refundable, no expiry\. The bot pass is a flat price: non-refundable, valid 30 days from the payment, <code>\/api\/liq-feed<\/code> only, and it cannot be topped up/);
  assert.match(HTML, /a flat \$25 for 30 days of <code>\/api\/liq-feed<\/code> only, nothing drawn per call/);
  assert.match(HTML, /bot pass \$25: 30 days, \/api\/liq-feed only, no per-call charge/);
});

test('keys page: a Solana-only buyer is pointed at a docs section that exists', () => {
  const m = /docs\/nofx\.md#([a-z0-9-]+)/.exec(HTML);
  assert.ok(m, 'the page links a docs anchor');
  const slug = (h) => h.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-');
  const heads = require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', 'nofx.md'), 'utf8').split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, '')));
  assert.ok(heads.includes(m[1]), `docs/nofx.md has a heading for #${m[1]}`);
  assert.match(require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', 'nofx.md'), 'utf8'), /spendControls: \{ maxAmountPerPayment: '\$25' \}/);
});

// ---- R15: the day pass in the page
test('keys page: buying the $1 day pass signs $1.00 to /api/keys/buy-day-pass and shows both routes and the 24 hours', async () => {
  const data = { prefix: 'abcd1234', pass: { price_usd: 1, days: 1, routes: ['/api/liq-feed', '/api/liquidations'], starts: 'when this payment settles', expires: '24 hours after that' }, status: 'active', rate_per_min: 120 };
  const { els, seen } = await runPage({ pack: 'day-pass', price: 1, data });
  assert.equal(els.status.className, 'ok', els.status.textContent);
  assert.ok(seen.urls[0].startsWith('/api/keys/buy-day-pass?key_hash='));
  assert.equal(seen.typed.message.value, '1000000');
  assert.match(els.meta.textContent, /^prefix abcd1234, day pass for \/api\/liq-feed, \/api\/liquidations only, valid until about 20\d\d-\d\d-\d\d \d\d:\d\d UTC \(24 hours from this payment\), \/api\/liq-feed and \/api\/liquidations each answer one call every 10 seconds \(6 a minute\), nothing drawn per call$/);
  assert.match(els.examples.textContent, /^curl "https:\/\/x402\.ochinimus\.app\/api\/liq-feed\?symbols=BTCUSDT,ETHUSDT" -H "X-AgentFeed-Key: afk_\.\.\."\ncurl "https:\/\/x402\.ochinimus\.app\/api\/liquidations\?symbol=SOLUSDT" -H "X-AgentFeed-Key: afk_\.\.\."\ncurl https:\/\/x402\.ochinimus\.app\/api\/keys\/balance /);
});

test('keys page: the day pass is offered with its price, term and routes, and the fine print says so', () => {
  assert.match(HTML, /day pass \$1: 24 hours, \/api\/liq-feed and \/api\/liquidations, one call every 10 s each, no per-call charge/);
  assert.match(HTML, /The day pass is the same for 24 hours on <code>\/api\/liq-feed<\/code> and <code>\/api\/liquidations<\/code>\./);
  assert.match(HTML, /The day pass: a flat \$1 for 24 hours of <code>\/api\/liq-feed<\/code> and <code>\/api\/liquidations<\/code>, nothing drawn per call, each route one call every 10 seconds per key \(6 a minute\)\.<\/p>/);   // R15c: the cadence is on the page
});

// ---- 30 Oct 2026: the owner bought the "$1" prepaid balance when he meant the "signals day pass $1" (two options both read "$1").
// The passes are listed first and every prepaid pack says what it is. The checker below is run on the page's options, and on the OLD option list as a negative control.
const optionsOf = (html) => [...html.matchAll(/<label><input type="radio" name="pack" value="([^"]+)"( checked)?>([\s\S]*?)<\/label>/g)]
  .map((m) => ({ value: m[1], checked: !!m[2], text: m[3].replace(/<[^>]+>/g, '').trim() }));
/** violations of: every option leads with what it is; no two options share a leading label (text up to and including the first price); a label that starts with a price goes on to say "prepaid balance" */
function labelProblems(opts) {
  const out = [];
  const leads = new Map();
  for (const o of opts) {
    const m = /\$\d+(?:\.\d+)?/.exec(o.text);
    if (!m) { out.push(`${o.value}: no price in "${o.text}"`); continue; }
    const lead = o.text.slice(0, m.index + m[0].length);
    if (leads.has(lead)) out.push(`${o.value} and ${leads.get(lead)} share the leading label "${lead}"`);
    leads.set(lead, o.value);
    if (m.index === 0 && !/^\$\d+(?:\.\d+)? (?:trial )?prepaid balance \(/.test(o.text)) out.push(`${o.value}: a bare price "${o.text}"`);
  }
  return out;
}

test('keys page: no two options share a leading price label and none is a bare price (the "$1" mix-up of 30 Oct 2026)', () => {
  const opts = optionsOf(HTML);
  assert.equal(opts.length, 8, 'four passes and four prepaid packs');
  assert.deepEqual(labelProblems(opts), []);
  assert.equal(new Set(opts.map((o) => o.value)).size, 8, 'values are unique');
});

test('keys page: the labels name the prepaid packs and list the passes first, in the order signals pass, signals day pass, bot pass, day pass', () => {
  const opts = optionsOf(HTML);
  assert.deepEqual(opts.map((o) => o.value), ['signals-pass', 'signals-day-pass', 'pass', 'day-pass', 'trial', '1', '5', '20']);
  assert.deepEqual(opts.slice(4).map((o) => o.text), [
    '$0.25 trial prepaid balance (all routes, half price per call)',
    '$1 prepaid balance (all routes, half price per call)',
    '$5 prepaid balance (all routes, half price per call)',
    '$20 prepaid balance (all routes, half price per call)',
  ]);
  assert.match(opts[1].text, /^signals day pass \$1: 24 hours/);
  assert.deepEqual(opts.filter((o) => o.checked).map((o) => o.value), ['trial'], 'exactly one option is preselected: the cheapest prepaid pack, never a pass');
});

test('keys page: the labels agree with the script (same ids, same prices as lib/keys PACKS and the pass terms)', () => {
  const m = /const PACKS=(\{[^\n]*\});/.exec(_SCRIPT);
  const packs = new Function(`return ${m[1]}`)();
  const KEYLIB = require('../lib/keys');
  for (const [id, usd] of Object.entries(KEYLIB.PACKS)) assert.equal(packs[id], usd, `script price of ${id}`);
  assert.equal(packs['signals-pass'], KEYLIB.SIGNALS_PASS.usd);
  assert.equal(packs['signals-day-pass'], KEYLIB.SIGNALS_DAY_PASS.usd);
  const opts = optionsOf(HTML);
  for (const o of opts) assert.ok(o.value in packs, `${o.value} is a pack the script can buy`);
  for (const o of opts) assert.ok(o.text.includes(`$${packs[o.value]}`), `${o.value}: the label shows the price the script signs ($${packs[o.value]})`);
});

test('negative control: the checker flags the page as it was before (bare "$1", "$5", "$20" next to "day pass $1")', () => {
  const old = [
    ['trial', 'trial $0.25'], ['1', '$1'], ['5', '$5'], ['20', '$20'],
    ['pass', 'bot pass $25: 30 days'], ['day-pass', 'day pass $1: 24 hours'], ['signals-pass', 'signals pass $25: 30 days'], ['signals-day-pass', 'signals day pass $1: 24 hours'],
  ].map(([value, text]) => ({ value, text }));
  const problems = labelProblems(old);
  assert.ok(problems.some((p) => /1: a bare price "\$1"/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /20: a bare price/.test(p)));
  const dup = labelProblems([{ value: 'a', text: '$1 prepaid balance (x)' }, { value: 'b', text: '$1 prepaid balance (y)' }]);
  assert.ok(dup.some((p) => /^b and a share the leading label "\$1"$/.test(p)), `two options with the same leading label are reported: ${dup.join(' | ')}`);
});
