// tools/r24/txprecheck/evm-assess.js: what a simulated Base transaction did, as the answer of GET /api/tx-precheck (R24 item 4).
// PURE, like sol-assess.js: it takes the facts the I/O layer gathered (the request, the simulation result and its logs, balances before and after, code and nonce of the recipients, the token-risk reads)
// and returns the answer object. No network, no clock, no signing.
//
// Where the facts come from (evm.js): eth_simulateV1 with traceTransfers (our own RPC; ERC-20 events plus ETH transfers as logs), run twice at ONE pinned block: once to learn which tokens and accounts the
// transaction touches, once as [balances before, the transaction, balances after] so before and after are read in the same block.
// Honest limits: the contracts listed are the target and every contract that emitted a log; a contract called internally that emits nothing is not listed unless a trace endpoint is configured.
'use strict';
const Kn = require('./known');
const L = require('./limits');
const W = require('./warn');
const D = require('./evm-decode');

const ETH_DECIMALS = 18;
const HIGH_VERDICTS = new Set(['not_sellable', 'extreme_tax', 'high_tax']);
const bal = (m, k) => (m ? m.get(k) : undefined);
const ethKey = (a) => `eth:${a}`;
const tokKey = (t, a) => `${t}:${a}`;

/**
 * what the second simulation must read: metadata and the sender's balance for every contract that touched the transaction (a wrapper such as WETH9 emits Deposit, not Transfer, so
 * the events alone would miss the sender's new balance), (token, address) pairs for every ERC-20 transfer, and ETH balances. `definite` are the tokens proven by ERC-20 events or a token call:
 * only those get the token-risk read. Derived from the first simulation's logs.
 */
function probePlan(input, sender, call, ev) {
  const target = D.norm(input.to);
  const definite = new Set(ev.erc20Transfers.map((t) => t.token).concat(ev.erc20Approvals.map((a) => a.token)));
  if (call.is_token_call) definite.add(target);
  const tokens = [...new Set([...definite, ...ev.emitters, target])].slice(0, L.MAX_EVM_CANDIDATES);
  const pairs = []; const seen = new Set();
  const add = (token, addr) => { const k = tokKey(token, addr); if (addr === D.ZERO || seen.has(k) || pairs.length >= L.MAX_EVM_PAIRS) return; seen.add(k); pairs.push({ token, addr }); };
  for (const t of ev.erc20Transfers) { add(t.token, t.from); add(t.token, t.to); }
  for (const t of tokens) add(t, sender);
  const eth = new Set([sender]);
  if (input.value > 0n) eth.add(target);
  for (const t of ev.ethTransfers) { eth.add(t.from); eth.add(t.to); }
  eth.delete(D.ZERO);
  // recipients whose "never used" status matters: where the sender's value goes, and the target
  const recipients = new Set([target]);
  for (const t of ev.ethTransfers) if (t.from === sender) recipients.add(t.to);
  for (const t of ev.erc20Transfers) if (t.from === sender) recipients.add(t.to);
  recipients.delete(sender); recipients.delete(D.ZERO);
  for (const r of recipients) eth.add(r);                 // a recipient is "never used" only if it also holds no ETH, so its balance is read too
  return { tokens, definite: [...definite], pairs, ethAddrs: [...eth].slice(0, L.MAX_EVM_PAIRS), recipients: [...recipients].slice(0, L.MAX_FRESH_CHECKS) };
}

/**
 * f = { input, sender, senderAssumed, call, block:{number,timestamp}, sim:{ok,error,returnData,gasUsed}, ev, meta: Map token -> {symbol,name,decimals},
 *       pre: Map key -> BigInt, post: Map key -> BigInt | null, code: Map addr -> bool, nonce: Map addr -> number, risk: Map token -> {available, read|reason}, at, method }
 */
function assessBase(f) {
  const { input, sender, ev } = f;
  const warnings = []; const seen = new Set();
  const warn = (key, w) => { if (seen.has(key)) return; seen.add(key); warnings.push(w); };
  const target = D.norm(input.to);
  const fresh = (a) => f.code.has(a) && f.nonce.has(a) && f.pre.has(ethKey(a)) && f.code.get(a) === false && f.nonce.get(a) === 0 && f.pre.get(ethKey(a)) === 0n;
  const metaOf = (t) => f.meta.get(t) || {};
  const symOf = (t) => { const k = Kn.baseContract(t); return (k && k.symbol) || metaOf(t).symbol || (f.risk.get(t) && f.risk.get(t).read && f.risk.get(t).read.symbol) || null; };
  const decOf = (t) => { const k = Kn.baseContract(t); return Number.isInteger(metaOf(t).decimals) ? metaOf(t).decimals : (k && k.decimals != null ? k.decimals : null); };
  const fmtTok = (t, amt) => { const d = decOf(t); return d == null ? `${amt} raw units` : `${W.fmtUnits(amt, d)} ${symOf(t) || 'tokens'}`; };

  // ---- value leaving the sender, from the events (or from the request when the simulation produced none)
  let ethTransfers = ev.ethTransfers;
  if (!f.sim.ok && input.value > 0n) ethTransfers = [{ token: 'eth', from: sender, to: target, amount: input.value }];
  const ethOut = ethTransfers.filter((t) => t.from === sender && t.to !== sender).reduce((s, t) => s + t.amount, 0n);
  const tokOut = new Map();
  for (const t of ev.erc20Transfers) if (t.from === sender && t.to !== sender) tokOut.set(t.token, (tokOut.get(t.token) || 0n) + t.amount);

  // ---- transfer_to_fresh_account
  for (const t of ethTransfers) {
    if (t.from !== sender || t.amount <= 0n || t.to === sender || !fresh(t.to)) continue;
    const share = f.pre.has(ethKey(sender)) ? W.pct(t.amount, f.pre.get(ethKey(sender))) : null;
    const big = f.pre.has(ethKey(sender)) && W.isLargeShare(t.amount, f.pre.get(ethKey(sender)));
    warn(`fresh:eth:${t.to}`, W.warning('transfer_to_fresh_account', big ? 'high' : 'low', `This transaction sends ${W.fmtUnits(t.amount, ETH_DECIMALS)} ETH from ${D.cs(sender)} to ${D.cs(t.to)}, an address with no code, no ETH and no transactions sent before this transaction.`,
      { account: D.cs(t.to), from: D.cs(sender), asset: 'ETH', amount: t.amount.toString(), amount_ui: W.fmtUnits(t.amount, ETH_DECIMALS), share_of_source_balance_pct: share }));
  }
  for (const t of ev.erc20Transfers) {
    if (t.from !== sender || t.amount <= 0n || t.to === sender || !fresh(t.to)) continue;
    const pre = f.pre.get(tokKey(t.token, sender));
    warn(`fresh:${t.token}:${t.to}`, W.warning('transfer_to_fresh_account', pre != null && W.isLargeShare(t.amount, pre) ? 'high' : 'low', `This transaction sends ${fmtTok(t.token, t.amount)} (token ${D.cs(t.token)}) from ${D.cs(sender)} to ${D.cs(t.to)}, an address with no code, no ETH and no transactions sent before this transaction.`,
      { account: D.cs(t.to), from: D.cs(sender), asset: D.cs(t.token), amount: t.amount.toString(), amount_ui: decOf(t.token) != null ? W.fmtUnits(t.amount, decOf(t.token)) : null, share_of_source_balance_pct: pre != null ? W.pct(t.amount, pre) : null }));
  }

  // ---- large_balance_outflow
  const ethPre = f.pre.get(ethKey(sender));
  if (ethPre != null && ethOut > 0n && ethPre >= W.ETH_OUTFLOW_FLOOR_WEI && W.isLargeShare(ethOut, ethPre)) {
    warn('out:eth', W.warning('large_balance_outflow', 'high', `This transaction moves ${W.pct(ethOut, ethPre)}% of the ETH balance of ${D.cs(sender)} (${W.fmtUnits(ethOut, ETH_DECIMALS)} of ${W.fmtUnits(ethPre, ETH_DECIMALS)} ETH) out of that account.`,
      { account: D.cs(sender), asset: 'ETH', amount: ethOut.toString(), balance_before: ethPre.toString(), share_pct: W.pct(ethOut, ethPre) }));
  }
  for (const [token, out] of tokOut) {
    const pre = f.pre.get(tokKey(token, sender));
    if (pre == null || pre <= 0n || !W.isLargeShare(out, pre)) continue;
    warn(`out:${token}`, W.warning('large_balance_outflow', 'high', `This transaction moves ${W.pct(out, pre)}% of the balance of ${D.cs(sender)} in token ${D.cs(token)} (${fmtTok(token, out)} of ${fmtTok(token, pre)}) out of that account.`,
      { account: D.cs(sender), asset: D.cs(token), amount: out.toString(), balance_before: pre.toString(), share_pct: W.pct(out, pre) }));
  }

  // ---- approvals and delegations
  const approvals = []; const delegations = [];
  const spenderInfo = (a) => { const k = Kn.baseContract(a); return { spender_known: !!k, spender_name: k ? k.name : null }; };
  for (const a of ev.erc20Approvals) {
    const unlimited = a.amount >= W.UNLIMITED_EVM; const bySender = a.owner === sender;
    approvals.push({ kind: 'erc20_allowance', token: D.cs(a.token), symbol: symOf(a.token), owner: D.cs(a.owner), spender: D.cs(a.spender), amount: a.amount.toString(), amount_ui: !unlimited && decOf(a.token) != null ? W.fmtUnits(a.amount, decOf(a.token)) : null, unlimited, by_sender: bySender, ...spenderInfo(a.spender) });
  }
  for (const a of ev.permit2Approvals) {
    const unlimited = a.amount >= W.UNLIMITED_EVM; const bySender = a.owner === sender;
    approvals.push({ kind: 'permit2_allowance', token: D.cs(a.token), symbol: symOf(a.token), owner: D.cs(a.owner), spender: D.cs(a.spender), amount: a.amount.toString(), amount_ui: !unlimited && decOf(a.token) != null ? W.fmtUnits(a.amount, decOf(a.token)) : null, unlimited, expires_at_unix: a.expiration, by_sender: bySender, ...spenderInfo(a.spender) });
  }
  for (const a of approvals) {
    if (!a.by_sender || a.amount === '0') continue;
    const tok = `${a.symbol ? `${a.symbol} (${a.token})` : a.token}`;
    if (a.unlimited) warn(`unl:${a.kind}:${a.token}:${a.spender}`, W.warning('unlimited_approval', 'high', `This transaction grants spender ${a.spender}${a.spender_name ? ` (${a.spender_name})` : ''} an unlimited allowance of token ${tok} from ${a.owner}${a.kind === 'permit2_allowance' ? ' through Permit2' : ''}.`, { token: a.token, owner: a.owner, spender: a.spender, amount: a.amount, unlimited: true, kind: a.kind }));
    if (!a.spender_known) warn(`unk:${a.kind}:${a.token}:${a.spender}`, W.warning('approval_to_unknown_spender', 'medium', `This transaction grants ${a.spender}, which is not in this service's table of well-known Base contracts, an allowance of ${a.unlimited ? 'an unlimited amount' : `${a.amount_ui ?? a.amount} ${a.symbol || 'raw units of'}`} of token ${tok}.`, { token: a.token, owner: a.owner, spender: a.spender, amount: a.amount, unlimited: a.unlimited, kind: a.kind }));
  }
  for (const a of ev.approvalsForAll) {
    const bySender = a.owner === sender;
    delegations.push({ kind: 'operator_for_all', collection: D.cs(a.collection), owner: D.cs(a.owner), operator: D.cs(a.operator), approved: a.approved, by_sender: bySender, ...(() => { const k = Kn.baseContract(a.operator); return { operator_known: !!k, operator_name: k ? k.name : null }; })() });
    if (bySender && a.approved) warn(`all:${a.collection}:${a.operator}`, W.warning('delegate_granted', 'high', `This transaction lets ${D.cs(a.operator)} move every token ${D.cs(a.owner)} holds in the collection ${D.cs(a.collection)} (setApprovalForAll), without a new signature for each one.`, { collection: D.cs(a.collection), owner: D.cs(a.owner), delegate: D.cs(a.operator), unlimited: true, kind: 'operator_for_all' }));
  }

  // ---- authority_change
  for (const o of ev.ownership) if (o.previous === sender) warn(`own:${o.contract}`, W.warning('authority_change', 'high', `This transaction changes the owner of contract ${D.cs(o.contract)} from ${D.cs(o.previous)} to ${o.next === D.ZERO ? 'nobody (ownership is renounced)' : D.cs(o.next)}.`, { subject: D.cs(o.contract), what: 'owner', from: D.cs(o.previous), to: D.cs(o.next) }));
  for (const o of ev.admin) if (o.previous === sender) warn(`adm:${o.contract}`, W.warning('authority_change', 'high', `This transaction changes the proxy admin of contract ${D.cs(o.contract)} from ${D.cs(o.previous)} to ${D.cs(o.next)}.`, { subject: D.cs(o.contract), what: 'proxy admin', from: D.cs(o.previous), to: D.cs(o.next) }));

  // ---- contracts touched and unknown_program
  const contracts = []; const listed = new Set();
  const addContract = (a, role) => { if (listed.has(a) || contracts.length >= L.MAX_PROGRAMS) return; listed.add(a); const k = Kn.baseContract(a); contracts.push({ address: D.cs(a), name: k ? k.name : null, known: !!k, role, ...(k ? { source: k.source } : {}) }); };
  if (f.code.get(target) !== false) addContract(target, 'target of the transaction');
  for (const e of ev.emitters) addContract(e, 'emitted an event');
  if (f.code.get(target) === true && !Kn.baseContract(target)) warn(`prog:${target}`, W.warning('unknown_program', 'medium', `This transaction calls contract ${D.cs(target)}, which is not in this service's table of well-known Base contracts.`, { program: D.cs(target), invoked_by: 'transaction' }));

  // ---- tokens and the token-risk reads
  const tokens = [];
  for (const t of [...new Set([...ev.erc20Transfers.map((x) => x.token), ...ev.erc20Approvals.map((x) => x.token), ...(f.call.is_token_call ? [target] : [])])]) {
    const known = Kn.baseContract(t); const isKnownToken = known && known.kind === 'token'; const r = f.risk.get(t);
    const base = { address: D.cs(t), symbol: symOf(t), name: (known && known.name) || metaOf(t).name || null, decimals: decOf(t), known: !!isKnownToken };
    if (isKnownToken) { tokens.push({ ...base, token_risk: { skipped: 'well-known token (issuer or protocol address from the official table)', source: known.source } }); continue; }
    if (!r) { tokens.push({ ...base, token_risk: { available: false, reason: 'not read: the per-call limit of token-risk reads was reached' } }); continue; }
    if (!r.available) { tokens.push({ ...base, token_risk: { available: false, reason: r.reason || 'the token-risk read did not finish' } }); continue; }
    const h = r.read; const high = HIGH_VERDICTS.has(h.verdict);
    tokens.push({ ...base, token_risk: { available: true, high_risk: high, read: summarizeHoneypot(h) } });
    if (high) warn(`risk:${t}`, W.warning('high_risk_token', 'high', `Token ${base.symbol || D.cs(t)} (${D.cs(t)}) is involved, and its token-risk read is high-risk: ${h.verdict.replace(/_/g, ' ')}${h.sell_tax_pct != null ? ` (simulated sell tax ${h.sell_tax_pct}%)` : ''}.`, { token: D.cs(t), symbol: base.symbol, verdict: h.verdict, sellable: h.sellable ?? null, sell_tax_pct: h.sell_tax_pct ?? null, buy_tax_pct: h.buy_tax_pct ?? null }));
  }

  // ---- balance changes (needs the state after)
  const balanceChanges = []; const cut = [];
  if (f.post) {
    for (const k of f.pre.keys()) {
      if (!f.post.has(k)) continue;
      const b = f.pre.get(k); const p = f.post.get(k);
      if (b == null || p == null || b === p) continue;
      if (k.startsWith('eth:')) { const a = k.slice(4); balanceChanges.push({ account: D.cs(a), asset: 'ETH', symbol: 'ETH', name: 'Ether', decimals: ETH_DECIMALS, before: b.toString(), after: p.toString(), delta: (p - b).toString(), before_ui: W.fmtUnits(b, ETH_DECIMALS), after_ui: W.fmtUnits(p, ETH_DECIMALS), delta_ui: W.fmtUnits(p - b, ETH_DECIMALS), is_sender: a === sender }); }
      else { const [t, a] = k.split(':'); const d = decOf(t); if (d == null && !Kn.baseContract(t)) continue; balanceChanges.push({ account: D.cs(a), asset: D.cs(t), symbol: symOf(t), name: (Kn.baseContract(t) && Kn.baseContract(t).name) || metaOf(t).name || null, decimals: d, before: b.toString(), after: p.toString(), delta: (p - b).toString(), ...(d != null ? { before_ui: W.fmtUnits(b, d), after_ui: W.fmtUnits(p, d), delta_ui: W.fmtUnits(p - b, d) } : {}), is_sender: a === sender }); }
    }
    balanceChanges.sort((x, y) => Number(y.is_sender) - Number(x.is_sender));
    if (balanceChanges.length > L.MAX_BALANCE_CHANGES) cut.push(true);
  }

  const sorted = W.sortWarnings(warnings);
  return {
    chain: 'base',
    request: { from: D.cs(sender), from_assumed: !!f.senderAssumed, to: D.cs(target), value_wei: input.value.toString(), data_bytes: (input.data.length - 2) / 2, call: f.call.selector ? { selector: f.call.selector, name: f.call.name, args: f.call.args } : null },
    simulation: { ok: !!f.sim.ok, error: f.sim.error || null, method: f.method, block: f.block.number, block_time: new Date(f.block.timestamp * 1000).toISOString(), gas_used: f.sim.gasUsed ?? null, return_data: f.sim.returnData ? String(f.sim.returnData).slice(0, 130) : null, log_count: f.logCount ?? 0 },
    balance_changes: balanceChanges.slice(0, L.MAX_BALANCE_CHANGES),
    ...(cut.length ? { balance_changes_truncated: true } : {}),
    ...(!f.post ? { balance_changes_note: 'the simulation did not succeed, so there is no state after the transaction to compare with; warnings below come from the request and the state before' } : {}),
    contracts,
    approvals,
    delegations,
    new_accounts: [],
    nft_transfers: ev.nftTransfers.slice(0, 20).map((n) => ({ collection: D.cs(n.collection), from: D.cs(n.from), to: D.cs(n.to), token_id: n.token_id })),
    tokens,
    warnings: sorted,
    summary: { warning_count: sorted.length, highest_severity: sorted.length ? sorted[0].severity : null, note: sorted.length ? 'each warning states a fact about the simulated transaction' : 'no warning rule matched this transaction; that is not a statement that it is safe' },
    as_of: { block: f.block.number, at: f.at },
  };
}

/** the part of tools/honeypot.js's answer that a transaction answer needs */
function summarizeHoneypot(h) {
  const c = h.contract || {};
  return {
    verdict: h.verdict, sellable: h.sellable ?? null, buy_tax_pct: h.buy_tax_pct ?? null, sell_tax_pct: h.sell_tax_pct ?? null, transfer_ok: h.transfer_ok ?? null, round_trip_loss_pct: h.round_trip_loss_pct ?? null,
    pool: h.pool && h.pool.address ? { address: h.pool.address, venue: h.pool.venue, quote: h.pool.quote, quote_liquidity_usd: h.pool.quote_liquidity_usd ?? null } : null,
    contract: { owner_renounced: c.owner_renounced ?? null, mintable: c.mintable ?? null, blacklist: c.blacklist ?? null, pausable: c.pausable ?? null, tax_changeable: c.tax_changeable ?? null, upgradeable: c.upgradeable ?? null },
    disagreements: (h.disagreements || []).slice(0, 4), block: h.as_of ? h.as_of.simulation && h.as_of.simulation.block : null,
  };
}

module.exports = { assessBase, probePlan, summarizeHoneypot, HIGH_VERDICTS, ethKey, tokKey };
