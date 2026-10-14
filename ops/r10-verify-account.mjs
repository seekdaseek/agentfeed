// ops/r10-verify-account.mjs <network> <account> | --selftest — R10 Phase B: read a receiving account ON-CHAIN before its rail
// goes live. Public endpoints only, no keys, no SDK, read-only. Prints PASS or FAIL per check and, on PASS, the one .env line
// that turns the rail on (lib/nonevm-rails.js). --selftest runs every check against an account that is known to hold the token
// (found on-chain, then checked), so a check that cannot pass is caught before it is trusted.
//
//   xrpl:0          account_info (exists, XRP above reserve) + account_lines (a USDC trustline to Circle's issuer)
//   stellar:pubnet  Horizon account (exists) + a USDC trustline to Circle's issuer (the facilitator pays through its SAC)
//   sui:mainnet     a well-formed address (Sui creates the coin object on receipt; nothing to set up) + GraphQL reads its balance
//   near:mainnet    view_account (exists) + storage_balance_of on the USDC contract (registered, or a transfer to it fails)
//   hedera:mainnet  mirror node account (exists, not deleted) + a USDC (0.0.456858) association, or free auto-association slots
//   fogo:mainnet    a well-formed SVM address + its USDC token account (getTokenAccountsByOwner on the USDC mint)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NONEVM_RAILS, PAYTO_SHAPE } = require('../lib/nonevm-rails.js');

const XRPL_RPC = 'https://xrplcluster.com/';
const HORIZON = 'https://horizon.stellar.org';
const STELLAR_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'; // Circle; the SAC CCW67T… wraps USDC:this issuer
const SUI_GRAPHQL = 'https://graphql.mainnet.sui.io/graphql'; // the public JSON-RPC answered "deprecated" on 2026-10-14
const NEAR_RPC = 'https://rpc.mainnet.near.org';
const HEDERA_MIRROR = 'https://mainnet-public.mirrornode.hedera.com/api/v1';
const FOGO_RPC = 'https://mainnet.fogo.io';
const rail = (n) => NONEVM_RAILS.find((r) => r.network === n);
const post = async (url, body) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })).json();
const get = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(20000) }); return { status: r.status, body: await r.json().catch(() => null) }; };

const CHECKS = {
  async 'xrpl:0'(acct) {
    const t = rail('xrpl:0').token; const out = [];
    const state = await post(XRPL_RPC, { method: 'server_state', params: [{}] });
    const v = state.result && state.result.state && state.result.state.validated_ledger;
    const base = v ? v.reserve_base / 1e6 : null, inc = v ? v.reserve_inc / 1e6 : null;
    const info = await post(XRPL_RPC, { method: 'account_info', params: [{ account: acct, ledger_index: 'validated' }] });
    const ad = info.result && info.result.account_data;
    out.push(['account exists', !!ad, ad ? `balance ${Number(ad.Balance) / 1e6} XRP, owner objects ${ad.OwnerCount}` : (info.result && info.result.error)]);
    if (ad && base != null) { const need = base + inc * ad.OwnerCount; out.push(['XRP above the reserve', Number(ad.Balance) / 1e6 >= need, `reserve ${need} XRP (base ${base} + ${inc} per object)`]); }
    // with a peer filter account_lines still pages over every owner object: follow the marker
    let usdc = null; let marker; let pages = 0;
    do {
      const lines = await post(XRPL_RPC, { method: 'account_lines', params: [{ account: acct, peer: t.issuer, ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) }] });
      usdc = ((lines.result && lines.result.lines) || []).find((l) => l.currency === t.currency) || null;
      marker = lines.result && lines.result.marker;
    } while (!usdc && marker && ++pages < 50);
    out.push(['USDC trustline to ' + t.issuer, !!usdc, usdc ? `limit ${usdc.limit}, balance ${usdc.balance}` : 'none']);
    return out;
  },
  async 'stellar:pubnet'(acct) {
    const r = await get(`${HORIZON}/accounts/${acct}`);
    const out = [['account exists', r.status === 200, r.status === 200 ? `subentries ${r.body.subentry_count}` : `HTTP ${r.status}`]];
    if (r.status === 200) {
      const xlm = Number((r.body.balances.find((b) => b.asset_type === 'native') || {}).balance || 0);
      // sponsorship moves reserves between accounts: (2 + subentries + sponsoring - sponsored) x 0.5 XLM
      const sp = Number(r.body.num_sponsoring || 0), sd = Number(r.body.num_sponsored || 0);
      const need = (2 + r.body.subentry_count + sp - sd) * 0.5;
      out.push(['XLM covers the minimum balance', xlm >= need, `${xlm} XLM, minimum ${need} (0.5 x (2 + ${r.body.subentry_count} + ${sp} sponsoring - ${sd} sponsored))`]);
      const u = r.body.balances.find((b) => b.asset_code === 'USDC' && b.asset_issuer === STELLAR_USDC_ISSUER);
      out.push(['USDC trustline to Circle', !!u, u ? `limit ${u.limit}, balance ${u.balance}, authorized ${u.is_authorized !== false}` : 'none']);
    }
    return out;
  },
  async 'sui:mainnet'(acct) {
    const t = rail('sui:mainnet').token;
    const b = await post(SUI_GRAPHQL, { query: 'query($a:SuiAddress!,$t:String!){ address(address:$a){ balance(coinType:$t){ totalBalance } } }', variables: { a: acct, t: t.address } });
    const bal = b.data && b.data.address && b.data.address.balance;
    return [['well-formed address', PAYTO_SHAPE.sui.test(acct), acct.length + ' chars'], ['the chain reads its USDC balance', !!bal, bal ? `USDC ${bal.totalBalance}` : JSON.stringify(b.errors || b).slice(0, 100)]];
  },
  async 'near:mainnet'(acct) {
    const t = rail('near:mainnet').token;
    const va = await post(NEAR_RPC, { jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: acct } });
    const out = [['account exists', !!va.result, va.result ? `${(Number(va.result.amount) / 1e24).toFixed(4)} NEAR` : (va.error && va.error.cause && va.error.cause.name)]];
    const args = Buffer.from(JSON.stringify({ account_id: acct })).toString('base64');
    const sb = await post(NEAR_RPC, { jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: t.address, method_name: 'storage_balance_of', args_base64: args } });
    const val = sb.result && sb.result.result ? JSON.parse(Buffer.from(sb.result.result).toString() || 'null') : undefined;
    out.push(['registered on the USDC contract (storage deposit)', !!val, val ? `storage ${val.total}` : (sb.error ? JSON.stringify(sb.error).slice(0, 80) : 'not registered')]);
    return out;
  },
  async 'hedera:mainnet'(acct) {
    const t = rail('hedera:mainnet').token;
    const a = await get(`${HEDERA_MIRROR}/accounts/${acct}`);
    const out = [['account exists', a.status === 200 && !a.body.deleted, a.status === 200 ? `${a.body.balance.balance / 1e8} HBAR, auto-association slots ${a.body.max_automatic_token_associations}` : `HTTP ${a.status}`]];
    const tk = await get(`${HEDERA_MIRROR}/accounts/${acct}/tokens?token.id=${t.address}`);
    const assoc = tk.body && (tk.body.tokens || []).find((x) => x.token_id === t.address);
    out.push(['USDC 0.0.456858 associated', !!assoc, assoc ? `balance ${assoc.balance}, automatic ${assoc.automatic_association}` : 'not associated']);
    return out;
  },
  async 'fogo:mainnet'(acct) {
    const t = rail('fogo:mainnet').token;
    const r = await post(FOGO_RPC, { jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [acct, { mint: t.address }, { encoding: 'jsonParsed' }] });
    const accts = (r.result && r.result.value) || [];
    return [['well-formed address', PAYTO_SHAPE.svm.test(acct), acct], ['a USDC token account exists', accts.length > 0, accts.length ? `${accts[0].pubkey} balance ${accts[0].account.data.parsed.info.tokenAmount.uiAmountString}` : (r.error ? JSON.stringify(r.error).slice(0, 80) : 'none')]];
  },
};

// known holders, found on-chain at run time (never typed): the selftest's positive controls
const HOLDERS = {
  async 'xrpl:0'() { const t = rail('xrpl:0').token; const r = await post(XRPL_RPC, { method: 'account_lines', params: [{ account: t.issuer, limit: 50, ledger_index: 'validated' }] }); return r.result.lines.find((l) => Number(l.balance) < 0).account; },
  async 'stellar:pubnet'() { const r = await get(`${HORIZON}/accounts?asset=USDC:${STELLAR_USDC_ISSUER}&limit=1`); return r.body._embedded.records[0].account_id; },
  async 'sui:mainnet'() { return '0x' + '0'.repeat(63) + '5'; },
  async 'near:mainnet'() { return 'v2.ref-finance.near'; }, // Ref Finance: registered on the USDC contract (storage_balance_of answered on 2026-10-14)
  async 'hedera:mainnet'() { const r = await get(`${HEDERA_MIRROR}/tokens/${rail('hedera:mainnet').token.address}/balances?limit=5&account.balance=gt:0`); return r.body.balances[0].account; },
  // getTokenLargestAccounts aborts on Fogo (scan limit): take the owner of a token account a recent USDC transfer touched
  async 'fogo:mainnet'() {
    const mint = rail('fogo:mainnet').token.address;
    const sigs = await post(FOGO_RPC, { jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [mint, { limit: 10 }] });
    for (const s of sigs.result || []) {
      const tx = await post(FOGO_RPC, { jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] });
      const tb = ((tx.result && tx.result.meta && tx.result.meta.postTokenBalances) || []).find((b) => b.mint === mint && b.owner);
      if (tb) return tb.owner;
    }
    throw new Error('no recent USDC transfer found on Fogo');
  },
};

async function check(network, acct) {
  const r = rail(network);
  if (!r) throw new Error(`unknown network ${network}; one of ${NONEVM_RAILS.map((x) => x.network).join(', ')}`);
  if (!PAYTO_SHAPE[r.family].test(acct)) return { network, acct, pass: false, rows: [['account format', false, `not a ${r.name} account`]] };
  const rows = await CHECKS[network](acct);
  return { network, acct, pass: rows.every((x) => x[1]), rows };
}
const show = (res) => { console.log(`${res.pass ? 'PASS' : 'FAIL'} ${res.network} ${res.acct}`); for (const [k, ok, d] of res.rows) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${k}: ${d}`); };

const [a, b] = process.argv.slice(2);
if (a === '--selftest') {
  for (const net of Object.keys(CHECKS)) {
    try { const h = await HOLDERS[net](); show(await check(net, h)); } catch (e) { console.log(`ERROR ${net}: ${e.message}`); }
  }
  // negative controls: accounts that cannot receive the token
  show(await check('xrpl:0', rail('xrpl:0').token.issuer)); // the issuer has no trustline to itself
  show(await check('near:mainnet', 'uvd-facilitator.near')); // exists, not registered on USDC
  show(await check('hedera:mainnet', '0.0.2')); // a system account, not associated
} else {
  if (!a || !b) { console.error('usage: node ops/r10-verify-account.mjs <network> <account> | --selftest'); process.exit(2); }
  const res = await check(a, b);
  show(res);
  if (res.pass) console.log(`\n.env line (VPS, /opt/agentfeed/.env), then the restart that turns it on:\n${rail(a).env}=${b}`);
  process.exit(res.pass ? 0 : 1);
}
