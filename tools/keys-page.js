// tools/keys-page.js — GET /keys: buy a prepaid key in the browser (R9 2b).
//
// The browser generates the key (afk_ + base58 of 32 random bytes, crypto.getRandomValues), sends AgentFeed only its
// sha256 (key_hash), and pays buy-trial / buy-1 / buy-5 / buy-20 / buy-pass / buy-day-pass from an injected EVM wallet on Base. The payment is
// the x402 v2 `exact` EIP-3009 payload @x402/evm 2.28 builds (dist/cjs/exact/client createEIP3009Payload):
// authorization { from, to: payTo, value: amount, validAfter: "0", validBefore: now + maxTimeoutSeconds, nonce: 32
// random bytes }, signed as EIP-712 TransferWithAuthorization over the domain { name, version } from the accept's extra,
// chainId 8453 and verifyingContract = asset; wrapped as { x402Version: 2, payload, extensions, resource, accepted }
// and sent base64 in PAYMENT-SIGNATURE. The wallet signs with eth_signTypedData_v4, so the page loads no library.
// The key is shown once, after the 200, with a copy button; it is never sent anywhere.
// No CDN, no analytics, no third-party request: the CSP below allows same-origin fetches only, and the one inline
// script and style are allowed by hash.
'use strict';
const crypto = require('crypto');

const STYLE = `
:root{--bg:#0a0e14;--card:#111722;--txt:#d7dde7;--dim:#7d8899;--gold:#ffd84d;--line:#1e2635;--ok:#3ddc97;--bad:#ff6b6b}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--txt);font:15px/1.6 ui-monospace,'SF Mono',Menlo,monospace;padding:32px 16px;max-width:720px;margin:0 auto}
h1{font-size:24px;color:var(--gold);margin:0 0 8px}
p{margin:8px 0}.dim{color:var(--dim);font-size:13px}
.packs{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:20px 0}
.packs label{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;cursor:pointer;display:block}
.packs input{margin-right:8px}.packs label:has(input:checked){border-color:var(--gold)}
button{background:var(--gold);color:#111;border:0;border-radius:6px;padding:10px 18px;font:inherit;font-weight:bold;cursor:pointer}
button:disabled{opacity:.5;cursor:wait}
#status{margin:16px 0;min-height:24px}.err{color:var(--bad)}.ok{color:var(--ok)}
#result{display:none;background:var(--card);border:1px solid var(--ok);border-radius:8px;padding:16px;margin:16px 0}
#key{display:block;word-break:break-all;background:#000;padding:10px;border-radius:6px;margin:10px 0;color:var(--gold)}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto;font-size:12px}
a{color:var(--gold)}`;

const SCRIPT = `
(function(){
const PACKS={trial:0.25,'1':1,'5':5,'20':20,pass:25,'day-pass':1};
const BASE='eip155:8453', CHAIN_HEX='0x2105', CHAIN_ID=8453;
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const $=(id)=>document.getElementById(id);
const say=(t,c)=>{const s=$('status');s.textContent=t;s.className=c||'';};
const hex=(u8)=>Array.from(u8,(b)=>b.toString(16).padStart(2,'0')).join('');
function b58(u8){let x=BigInt('0x'+hex(u8)),o='';while(x>0n){o=B58[Number(x%58n)]+o;x/=58n;}for(const b of u8){if(b)break;o='1'+o;}return o;}
async function sha256hex(s){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))));}
function b64(obj){const by=new TextEncoder().encode(JSON.stringify(obj));let s='';for(const b of by)s+=String.fromCharCode(b);return btoa(s);}
function unb64(s){const bin=atob(s);const by=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)by[i]=bin.charCodeAt(i);return JSON.parse(new TextDecoder().decode(by));}
async function buy(){
  const pack=(document.querySelector('input[name=pack]:checked')||{}).value;
  const usd=PACKS[pack]; if(!usd) return say('choose a pack','err');
  const eth=window.ethereum; if(!eth) return say('No browser wallet found. Install or unlock an EVM wallet (MetaMask, Coinbase Wallet, Rabby) holding USDC on Base.','err');
  $('buy').disabled=true;
  try{
    say('connecting the wallet...');
    const [from]=await eth.request({method:'eth_requestAccounts'});
    if((await eth.request({method:'eth_chainId'}))!==CHAIN_HEX){say('switching the wallet to Base...');await eth.request({method:'wallet_switchEthereumChain',params:[{chainId:CHAIN_HEX}]});}
    const key='afk_'+b58(crypto.getRandomValues(new Uint8Array(32)));
    const url='/api/keys/buy-'+pack+'?key_hash='+(await sha256hex(key))+'&prefix='+key.slice(4,12);
    say('reading the price...');
    const ch=await fetch(url,{cache:'no-store'});
    if(ch.status!==402) throw new Error('expected a 402 challenge, got '+ch.status+': '+(await ch.text()).slice(0,200));
    const pr=unb64(ch.headers.get('payment-required'));
    const acc=pr.accepts.find((a)=>a.network===BASE&&a.scheme==='exact'&&a.extra&&a.extra.name&&a.extra.version&&!a.extra.assetTransferMethod&&a.extra.name!=='GatewayWalletBatched');
    if(!acc) throw new Error('this route offers no Base USDC exact payment');
    if(String(acc.amount)!==String(Math.round(usd*1e6))) throw new Error('the challenge asks '+acc.amount+' atomic USDC, expected '+Math.round(usd*1e6)+'; not signing');
    const auth={from:from,to:acc.payTo,value:String(acc.amount),validAfter:'0',validBefore:String(Math.floor(Date.now()/1000)+acc.maxTimeoutSeconds),nonce:'0x'+hex(crypto.getRandomValues(new Uint8Array(32)))};
    const typed={types:{EIP712Domain:[{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}],
      TransferWithAuthorization:[{name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}]},
      domain:{name:acc.extra.name,version:acc.extra.version,chainId:CHAIN_ID,verifyingContract:acc.asset},primaryType:'TransferWithAuthorization',message:auth};
    say('sign the USDC authorization in your wallet: $'+usd+' to '+acc.payTo+' on Base');
    const signature=await eth.request({method:'eth_signTypedData_v4',params:[from,JSON.stringify(typed)]});
    const env={x402Version:2,payload:{authorization:auth,signature:signature},resource:pr.resource,accepted:acc};
    if(pr.extensions) env.extensions=pr.extensions;
    say('settling the payment...');
    const r=await fetch(url,{cache:'no-store',headers:{'PAYMENT-SIGNATURE':b64(env)}});
    const body=await r.json().catch(()=>({}));
    if(r.status!==200){const h=r.headers.get('payment-response');let why=body.error||'';if(h){try{why=unb64(h).errorReason||why;}catch(e){}}throw new Error('not paid ('+r.status+')'+(why?': '+why:''));}
    $('key').textContent=key;
    const ps=body.data.pass;
    const day=!!ps&&ps.days===1, until=ps&&new Date(Date.now()+ps.days*864e5).toISOString();
    $('meta').textContent=ps?'prefix '+body.data.prefix+', '+(day?'day pass':'bot pass')+' for '+ps.routes.join(', ')+' only, valid until about '+(day?until.slice(0,16).replace('T',' ')+' UTC':until.slice(0,10))+' ('+(day?'24 hours':ps.days+' days')+' from this payment), '+(ps.routes.length>1?'/api/liq-feed and /api/liquidations each answer one call every 10 seconds (6 a minute)':'one call every 10 seconds')+', nothing drawn per call':'prefix '+body.data.prefix+', balance $'+body.data.balance_usd+', '+body.data.rate_per_min+' requests a minute';
    if(ps) $('examples').textContent='curl "https://x402.ochinimus.app'+ps.routes[0]+'?symbols=BTCUSDT,ETHUSDT" -H "X-AgentFeed-Key: afk_..."'+(ps.routes.indexOf('/api/liquidations')>=0?'\\ncurl "https://x402.ochinimus.app/api/liquidations?symbol=SOLUSDT" -H "X-AgentFeed-Key: afk_..."':'')+'\\ncurl https://x402.ochinimus.app/api/keys/balance -H "X-AgentFeed-Key: afk_..."   # shows the expiry';
    $('result').style.display='block';
    say('paid and active. Copy the key now: this page is the only place it exists.','ok');
  }catch(e){say(String(e&&e.message||e),'err');}
  finally{$('buy').disabled=false;}
}
$('buy').addEventListener('click',buy);
$('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('key').textContent);$('copy').textContent='copied';}catch(e){say('copy failed: select the key and copy it by hand','err');}});
})();`;

const sha = (s) => "'sha256-" + crypto.createHash('sha256').update(s, 'utf8').digest('base64') + "'";
const CSP = ["default-src 'none'", `script-src ${sha(SCRIPT)}`, `style-src ${sha(STYLE)}`, "connect-src 'self'", "img-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentFeed prepaid keys</title><link rel="icon" href="/icon.png"><style>${STYLE}</style></head>
<body>
<h1>AgentFeed prepaid key</h1>
<p>For bots that can send a header but cannot pay x402. Send the key as <code>X-AgentFeed-Key</code>. A prepaid pack: each call costs half the route's x402 price (minimum $0.0005). The bot pass: a flat $25 for 30 days of <code>/api/liq-feed</code> only, nothing drawn per call. The day pass: a flat $1 for 24 hours of <code>/api/liq-feed</code> and <code>/api/liquidations</code>, nothing drawn per call, each route one call every 10 seconds per key (6 a minute).</p>
<div class="packs">
<label><input type="radio" name="pack" value="trial" checked>trial $0.25</label>
<label><input type="radio" name="pack" value="1">$1</label>
<label><input type="radio" name="pack" value="5">$5</label>
<label><input type="radio" name="pack" value="20">$20</label>
<label><input type="radio" name="pack" value="pass">bot pass $25: 30 days, /api/liq-feed only, no per-call charge</label>
<label><input type="radio" name="pack" value="day-pass">day pass $1: 24 hours, /api/liq-feed and /api/liquidations, one call every 10 s each, no per-call charge</label>
</div>
<button id="buy">Buy with USDC on Base</button>
<div id="status"></div>
<div id="result"><b>Your key, shown once:</b><code id="key"></code><button id="copy">Copy</button><p id="meta" class="dim"></p>
<pre id="examples">curl https://x402.ochinimus.app/api/signal-board -H "X-AgentFeed-Key: afk_..."
curl https://x402.ochinimus.app/api/keys/balance -H "X-AgentFeed-Key: afk_..."</pre></div>
<p class="dim">This page runs only in your browser. It creates the key here, sends AgentFeed only the key's sha256, and asks your wallet to sign one USDC transfer authorization on Base for exactly the pack price, payable to the address in AgentFeed's fresh 402 answer. Nothing else is loaded or contacted. A prepaid balance is a usage credit: non-refundable, no expiry. The bot pass is a flat price: non-refundable, valid 30 days from the payment, <code>/api/liq-feed</code> only, and it cannot be topped up (buy another when it ends). The day pass is the same for 24 hours on <code>/api/liq-feed</code> and <code>/api/liquidations</code>. The key is a bearer secret: anyone holding it spends the balance or uses the pass; abuse means revocation. This page pays from an EVM wallet on Base. No EVM wallet, or a Solana wallet: the same routes take USDC on Solana, Polygon, Arbitrum, Arc, Optimism, Monad and Avalanche from any x402 client, and the key comes back in the response; script: <a href="https://github.com/seekdaseek/agentfeed/blob/main/docs/nofx.md#c-from-a-solana-wallet-or-another-rail">docs</a>.</p>
<script>${SCRIPT}</script>
</body></html>`;

function keysPage(_req, res) {
  res.set('Content-Security-Policy', CSP);
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send(HTML);
}

module.exports = { keysPage, HTML, CSP, _SCRIPT: SCRIPT };
