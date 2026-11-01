// tools/r24/txprecheck/sol-assess.js: what a simulated Solana transaction did, as the answer of GET /api/tx-precheck (R24 item 4).
// PURE: it takes the facts the I/O layer gathered (decoded transaction, account state before and after, the simulation result, the token-risk reads) and returns the answer object.
// No network, no clock, no signing. test/r24-txprecheck-solana.test.js feeds it hand-built facts; tools/r24/txprecheck/example.js feeds it a constructed transaction.
//
// Where each warning comes from:
//   instructions (top level, and the inner ones the simulation reports): approve, set-authority, close-account, transfers, assign, create-ATA, nonce/loader/stake authority changes. They are
//     read even when the simulation FAILS, so a transaction that errors still shows what it was built to do.
//   account state before and after (only when the simulation ran): a delegate or owner that changed on a token account, a mint or freeze authority that changed, balance changes, new and closed accounts.
// Amounts are decimal strings (raw units); `*_ui` fields divide by the token's decimals in integer arithmetic.
'use strict';
const O = require('./sol-ops');
const Kn = require('./known');
const L = require('./limits');
const W = require('./warn');

const LAMPORTS_DECIMALS = 9;

/** a raw RPC account (jsonParsed) as { lamports, owner, executable, space, token?, mintInfo? } with BigInt amounts, or null. An account with no lamports does not exist (the runtime purges it), and a closed account comes back that way. */
function view(a) {
  if (!a || BigInt(a.lamports ?? 0) === 0n) return null;
  const out = { lamports: BigInt(a.lamports ?? 0), owner: a.owner, executable: !!a.executable, space: Number(a.space ?? 0) };
  const p = a.data && !Array.isArray(a.data) ? a.data.parsed : null;
  const prog = a.data && !Array.isArray(a.data) ? String(a.data.program || '') : '';
  if (p && prog.startsWith('spl-token') && p.type === 'account' && p.info) {
    const i = p.info;
    out.token = { mint: i.mint, owner: i.owner, amount: BigInt(i.tokenAmount ? i.tokenAmount.amount : 0), decimals: i.tokenAmount ? Number(i.tokenAmount.decimals) : 0, delegate: i.delegate || null, delegatedAmount: BigInt(i.delegatedAmount ? i.delegatedAmount.amount : 0), state: i.state, isNative: !!i.isNative };
  } else if (p && prog.startsWith('spl-token') && p.type === 'mint' && p.info) {
    out.mintInfo = { decimals: Number(p.info.decimals), mintAuthority: p.info.mintAuthority || null, freezeAuthority: p.info.freezeAuthority || null };
  }
  return out;
}

const kindOf = (v) => (!v ? null : v.token ? 'token_account' : v.mintInfo ? 'mint' : v.executable ? 'program' : v.owner === O.SYSTEM ? 'system_account' : 'account');

/** the error of a failed simulation as one sentence */
function errorSummary(err) {
  if (err == null) return null;
  if (typeof err === 'string') return err;
  if (err && Array.isArray(err.InstructionError)) {
    const [idx, e] = err.InstructionError;
    const what = typeof e === 'string' ? e : (e && e.Custom != null ? `custom program error ${e.Custom}` : JSON.stringify(e));
    return `instruction ${idx} failed: ${what}`;
  }
  try { return JSON.stringify(err).slice(0, 200); } catch { return 'the simulation failed'; }
}

const trimLogs = (logs) => {
  const all = Array.isArray(logs) ? logs.map((l) => String(l).slice(0, L.LOG_LINE_CHARS)) : [];
  return { logs: all.slice(-L.LOG_LINES), truncated: all.length > L.LOG_LINES };
};

/** the addresses whose state before the transaction the assessment needs but the first read did not include (new token accounts' owner wallets) */
function needsPre(f) {
  const want = new Set();
  const ops = [...f.topOps, ...(f.innerOps || [])];
  const have = (a) => f.pre.has(a);
  for (const op of ops) if (op.op === 'ata_create' && op.wallet && !have(op.wallet)) want.add(op.wallet);
  if (f.post) for (const [a, p] of f.post) { const v = view(p); if (v && v.token && !have(v.token.owner) && f.pre.has(a) && view(f.pre.get(a)) === null) want.add(v.token.owner); }
  return [...want];
}

/** the mints of every token the transaction touches: token accounts it writes, token operations, accounts it creates; first-seen order */
function involvedMints(f) {
  const out = new Set();
  const preV = (a) => (f.pre.has(a) ? view(f.pre.get(a)) : null);
  const postV = (a) => (f.post && f.post.has(a) ? view(f.post.get(a)) : null);
  const mintOf = (a) => { const v = preV(a); if (v && v.token) return v.token.mint; const p = postV(a); return p && p.token ? p.token.mint : null; };
  for (const op of [...f.topOps, ...(f.innerOps || [])]) {
    if (op.mint) out.add(op.mint);
    for (const a of [op.source, op.destination, op.account]) { const m = a ? mintOf(a) : null; if (m) out.add(m); }
  }
  for (const k of f.keys) if (k.writable) { const v = preV(k.address) || postV(k.address); if (v && v.token) out.add(v.token.mint); }
  return [...out];
}

/**
 * f = {
 *   d: decodeTx result, keys: [{address, signer, writable, loaded}], instructions: resolved top-level instructions,
 *   topOps, innerOps: op lists, inner: the simulation's innerInstructions (for the program list),
 *   pre: Map address -> raw account | null (null = does not exist; an address that is absent from the map was not read),
 *   post: Map address -> raw account | null, or null when the simulation did not succeed,
 *   sim: { ok, err, logs, unitsConsumed, fee, slot }, preSlot, risk: Map mint -> { available, read?, reason? },
 *   at: ISO time string of the answer
 * }
 */
function assessSolana(f) {
  const keys = f.keys; const signers = new Set(keys.filter((k) => k.signer).map((k) => k.address));
  const feePayer = keys[0].address;
  const ops = [...f.topOps, ...(f.innerOps || [])];
  const pre = (a) => (f.pre.has(a) ? view(f.pre.get(a)) : undefined);          // undefined: not read; null: absent
  const post = (a) => (f.post && f.post.has(a) ? view(f.post.get(a)) : undefined);
  const absent = (a) => f.pre.has(a) && view(f.pre.get(a)) === null;
  const warnings = []; const seen = new Set();
  const warn = (key, w) => { if (seen.has(key)) return; seen.add(key); warnings.push(w); };

  // ---- accounts the transaction creates for a signer: a transfer into them is the signer's own money moving
  const ataOwner = new Map();                                                   // new token account -> the wallet that will own it
  for (const op of ops) if (op.op === 'ata_create' && op.account && op.wallet) ataOwner.set(op.account, op.wallet);
  if (f.post) for (const [a, p] of f.post) { const v = view(p); if (v && v.token && absent(a)) ataOwner.set(a, v.token.owner); }
  const selfNew = new Set();
  for (const [a, w] of ataOwner) if (signers.has(w)) selfNew.add(a);
  for (const op of ops) if (op.op === 'sys_create' && signers.has(op.from) && absent(op.to) && (signers.has(op.to) || ataOwner.has(op.to))) selfNew.add(op.to);

  const ownerOfToken = (acct) => { const v = pre(acct); if (v && v.token) return v.token.owner; const p = post(acct); if (p && p.token) return p.token.owner; return ataOwner.get(acct) || null; };
  const mintOfToken = (acct) => { const v = pre(acct); if (v && v.token) return v.token.mint; const p = post(acct); return p && p.token ? p.token.mint : null; };
  const decimalsOfToken = (acct) => { const v = pre(acct); if (v && v.token) return v.token.decimals; const p = post(acct); return p && p.token ? p.token.decimals : undefined; };

  const mints = involvedMints(f);

  // ---- movements: who sends what to whom
  const solOut = new Map(); const tokOut = new Map();
  const addTo = (m, k, v) => m.set(k, (m.get(k) || 0n) + v);
  for (const op of ops) {
    if (op.op === 'sol_transfer') {
      const internal = signers.has(op.to) || selfNew.has(op.to);
      if (!internal) addTo(solOut, op.from, op.lamports);
      if (op.lamports > 0n && absent(op.to) && !selfNew.has(op.to)) {
        const fromV = pre(op.from);
        const big = fromV && signers.has(op.from) && W.isLargeShare(op.lamports, fromV.lamports) && fromV.lamports >= W.SOL_OUTFLOW_FLOOR_LAMPORTS;
        warn(`fresh:${op.to}`, W.warning('transfer_to_fresh_account', big ? 'high' : 'low',
          `This transaction sends ${W.fmtUnits(op.lamports, LAMPORTS_DECIMALS)} SOL from ${op.from} to ${op.to}, an account that has no lamports and does not exist on chain before this transaction.`,
          { account: op.to, from: op.from, asset: 'SOL', amount: op.lamports.toString(), amount_ui: W.fmtUnits(op.lamports, LAMPORTS_DECIMALS), share_of_source_balance_pct: fromV ? W.pct(op.lamports, fromV.lamports) : null }));
      }
    } else if (op.op === 'sys_create') {
      if (!signers.has(op.to)) addTo(solOut, op.from, op.lamports);
    } else if (op.op === 'tok_transfer') {
      const srcOwner = ownerOfToken(op.source); const dstOwner = ownerOfToken(op.destination);
      const internal = srcOwner && dstOwner && srcOwner === dstOwner;
      if (!internal) addTo(tokOut, op.source, op.amount);
      if (op.amount > 0n && absent(op.destination) && !selfNew.has(op.destination)) {
        const walletKnownAbsent = dstOwner ? absent(dstOwner) : true;            // an unknown owner of a token account that does not exist: the account itself is the finding
        if (walletKnownAbsent && !(dstOwner && signers.has(dstOwner))) {
          const mint = op.mint || mintOfToken(op.source); const dec = op.decimals ?? decimalsOfToken(op.source);
          const sv = pre(op.source);
          warn(`fresh:${op.destination}`, W.warning('transfer_to_fresh_account', sv && sv.token && W.isLargeShare(op.amount, sv.token.amount) ? 'high' : 'low',
            `This transaction sends ${dec != null ? W.fmtUnits(op.amount, dec) : op.amount.toString()} of token ${mint || 'unknown'} to ${op.destination}, a token account that does not exist before this transaction${dstOwner ? `, owned by ${dstOwner}, a wallet with no lamports` : ''}.`,
            { account: op.destination, owner: dstOwner, from: op.source, asset: mint, amount: op.amount.toString(), amount_ui: dec != null ? W.fmtUnits(op.amount, dec) : null, share_of_source_balance_pct: sv && sv.token ? W.pct(op.amount, sv.token.amount) : null }));
        }
      }
    } else if (op.op === 'tok_burn') addTo(tokOut, op.account, op.amount);
  }

  // ---- large_balance_outflow
  for (const [a, out] of solOut) {
    const v = pre(a);
    if (!v || !signers.has(a) || v.owner !== O.SYSTEM || v.lamports < W.SOL_OUTFLOW_FLOOR_LAMPORTS || !W.isLargeShare(out, v.lamports)) continue;
    warn(`out:sol:${a}`, W.warning('large_balance_outflow', 'high', `This transaction moves ${W.pct(out, v.lamports)}% of the SOL balance of ${a} (${W.fmtUnits(out, LAMPORTS_DECIMALS)} of ${W.fmtUnits(v.lamports, LAMPORTS_DECIMALS)} SOL) out of that account.`,
      { account: a, asset: 'SOL', amount: out.toString(), balance_before: v.lamports.toString(), share_pct: W.pct(out, v.lamports) }));
  }
  for (const [a, out] of tokOut) {
    const v = pre(a);
    if (!v || !v.token || v.token.amount <= 0n || !W.isLargeShare(out, v.token.amount)) continue;
    const ownedByUser = signers.has(v.token.owner) || (v.token.delegate && signers.has(v.token.delegate));
    if (!ownedByUser) continue;
    warn(`out:tok:${a}`, W.warning('large_balance_outflow', 'high', `This transaction moves ${W.pct(out, v.token.amount)}% of the balance of token account ${a} (token ${v.token.mint}, ${W.fmtUnits(out, v.token.decimals)} of ${W.fmtUnits(v.token.amount, v.token.decimals)}) out of that account.`,
      { account: a, owner: v.token.owner, asset: v.token.mint, amount: out.toString(), balance_before: v.token.amount.toString(), share_pct: W.pct(out, v.token.amount) }));
  }

  // ---- delegations (approve) from the instructions, then from the state
  const delegations = []; const delegKey = new Set();
  for (const op of ops) {
    if (op.op !== 'tok_approve') continue;
    const v = pre(op.account); const owner = v && v.token ? v.token.owner : null;
    if (owner && owner === op.delegate) continue;
    const mint = op.mint || (v && v.token ? v.token.mint : null); const dec = op.decimals ?? (v && v.token ? v.token.decimals : undefined);
    delegKey.add(`${op.account}:${op.delegate}`);
    delegations.push({ kind: 'spl_delegate', token_account: op.account, owner, mint, delegate: op.delegate, delegate_known: !!Kn.solProgram(op.delegate), amount: op.amount.toString(), amount_ui: dec != null ? W.fmtUnits(op.amount, dec) : null, unlimited: op.amount >= W.UNLIMITED_U64, source: 'instruction' });
  }
  if (f.post) for (const [a, p] of f.post) {
    const after = view(p); const before = pre(a);
    if (!after || !after.token || !after.token.delegate) continue;
    const grew = !before || !before.token || before.token.delegate !== after.token.delegate || after.token.delegatedAmount > before.token.delegatedAmount;
    if (!grew || delegKey.has(`${a}:${after.token.delegate}`) || after.token.delegate === after.token.owner) continue;
    delegKey.add(`${a}:${after.token.delegate}`);
    delegations.push({ kind: 'spl_delegate', token_account: a, owner: after.token.owner, mint: after.token.mint, delegate: after.token.delegate, delegate_known: !!Kn.solProgram(after.token.delegate), amount: after.token.delegatedAmount.toString(), amount_ui: W.fmtUnits(after.token.delegatedAmount, after.token.decimals), unlimited: after.token.delegatedAmount >= W.UNLIMITED_U64, source: 'state' });
  }
  for (const d of delegations) {
    const tokenText = d.mint ? ` of token ${d.mint}` : '';
    if (d.unlimited) warn(`unl:${d.token_account}:${d.delegate}`, W.warning('unlimited_approval', 'high', `This transaction grants ${d.delegate} an unlimited allowance${tokenText}: it sets ${d.delegate} as delegate of token account ${d.token_account} for ${d.amount} raw units.`, { token_account: d.token_account, owner: d.owner, spender: d.delegate, asset: d.mint, amount: d.amount, unlimited: true }));
    warn(`del:${d.token_account}:${d.delegate}`, W.warning('delegate_granted', d.unlimited ? 'high' : 'medium', `This transaction sets ${d.delegate} as delegate of token account ${d.token_account}${tokenText} for ${d.unlimited ? `an unlimited amount (${d.amount} raw units)` : (d.amount_ui != null ? d.amount_ui : `${d.amount} raw units`)}; a delegate can move up to that amount out of the account without the owner signing again.`, { token_account: d.token_account, owner: d.owner, delegate: d.delegate, asset: d.mint, amount: d.amount, amount_ui: d.amount_ui, unlimited: d.unlimited }));
  }

  // ---- close_account_to_other
  for (const op of ops) {
    if (op.op !== 'tok_close') continue;
    const v = pre(op.account); const owner = (v && v.token ? v.token.owner : null) || op.authority;
    if (!owner || op.destination === owner) continue;
    warn(`close:${op.account}`, W.warning('close_account_to_other', 'high', `This transaction closes token account ${op.account} (owner ${owner}) and sends its ${v ? `${W.fmtUnits(v.lamports, LAMPORTS_DECIMALS)} SOL of lamports` : 'lamports'} to ${op.destination}, which is not the account owner.`,
      { account: op.account, owner, destination: op.destination, lamports: v ? v.lamports.toString() : null, mint: v && v.token ? v.token.mint : null, token_amount_before: v && v.token ? v.token.amount.toString() : null }));
  }

  // ---- authority_change
  const authorityText = (what, subject, from, to) => `This transaction changes the ${what} of ${subject}${from ? ` from ${from}` : ''} to ${to || 'nobody (the authority is removed)'}.`;
  for (const op of ops) {
    if (op.op === 'tok_set_authority') {
      const v = pre(op.account); const cur = (v && v.token && /owner/.test(op.authorityType) ? v.token.owner : v && v.mintInfo ? (/freeze/.test(op.authorityType) ? v.mintInfo.freezeAuthority : v.mintInfo.mintAuthority) : null) || op.authority;
      warn(`auth:${op.authorityType}:${op.account}`, W.warning('authority_change', 'high', authorityText(op.authorityType, op.account, cur, op.newAuthority), { subject: op.account, what: op.authorityType, from: cur || null, to: op.newAuthority }));
    } else if (op.op === 'sys_assign') {
      const v = pre(op.account);
      if (!signers.has(op.account) || !v || v.owner !== O.SYSTEM || op.owner === O.SYSTEM) continue;
      warn(`auth:assign:${op.account}`, W.warning('authority_change', 'high', `This transaction assigns the account ${op.account}, which signs it, to program ${op.owner}: the System program stops being its owner.`, { subject: op.account, what: 'owning program', from: O.SYSTEM, to: op.owner }));
    } else if (op.op === 'authority_change') {
      warn(`auth:${op.what}:${op.subject}`, W.warning('authority_change', 'high', authorityText(op.what, op.subject, null, op.to), { subject: op.subject, what: op.what, from: null, to: op.to }));
    }
  }
  if (f.post) for (const [a, p] of f.post) {
    const after = view(p); const before = pre(a);
    if (!after || !before) continue;
    if (after.token && before.token && after.token.owner !== before.token.owner) warn(`auth:account owner:${a}`, W.warning('authority_change', 'high', authorityText('account owner', a, before.token.owner, after.token.owner), { subject: a, what: 'account owner', from: before.token.owner, to: after.token.owner }));
    if (after.mintInfo && before.mintInfo) {
      if (after.mintInfo.mintAuthority !== before.mintInfo.mintAuthority) warn(`auth:mint authority:${a}`, W.warning('authority_change', 'high', authorityText('mint authority', a, before.mintInfo.mintAuthority, after.mintInfo.mintAuthority), { subject: a, what: 'mint authority', from: before.mintInfo.mintAuthority, to: after.mintInfo.mintAuthority }));
      if (after.mintInfo.freezeAuthority !== before.mintInfo.freezeAuthority) warn(`auth:freeze authority:${a}`, W.warning('authority_change', 'high', authorityText('freeze authority', a, before.mintInfo.freezeAuthority, after.mintInfo.freezeAuthority), { subject: a, what: 'freeze authority', from: before.mintInfo.freezeAuthority, to: after.mintInfo.freezeAuthority }));
    }
    if (before.owner !== after.owner && signers.has(a) && before.owner === O.SYSTEM) warn(`auth:assign:${a}`, W.warning('authority_change', 'high', `This transaction assigns the account ${a}, which signs it, to program ${after.owner}: the System program stops being its owner.`, { subject: a, what: 'owning program', from: before.owner, to: after.owner }));
  }

  // ---- programs
  const invoked = O.invokedPrograms(f.instructions, f.inner);
  const programs = invoked.slice(0, L.MAX_PROGRAMS).map((p) => { const k = Kn.solProgram(p.id); return { address: p.id, name: k ? k.name : null, known: !!k, invoked_by: p.top ? 'instruction' : 'cpi', ...(k ? { source: k.source } : {}) }; });
  for (const p of invoked) if (!Kn.solProgram(p.id)) warn(`prog:${p.id}`, W.warning('unknown_program', 'medium', `This transaction invokes program ${p.id}${p.top ? '' : ' (through another program)'}, which is not in this service's table of well-known Solana programs.`, { program: p.id, invoked_by: p.top ? 'instruction' : 'cpi' }));

  // ---- tokens and the token-risk reads
  const tokens = [];
  for (const mint of mints.slice(0, 30)) {
    const known = Kn.solMint(mint); const r = f.risk.get(mint);
    const base = { mint, symbol: known ? known.symbol : (r && r.read ? r.read.symbol : null), name: known ? known.name : (r && r.read ? r.read.name : null), known: !!known };
    if (known) { tokens.push({ ...base, token_risk: { skipped: 'well-known token (issuer or protocol address from the official table)', source: known.source } }); continue; }
    if (!r) { tokens.push({ ...base, token_risk: { available: false, reason: 'not read: the per-call limit of token-risk reads was reached' } }); continue; }
    if (!r.available) { tokens.push({ ...base, token_risk: { available: false, reason: r.reason || 'the token-risk read did not finish' } }); continue; }
    const t = r.read; const flags = t.risk_flags || [];
    const high = flags.length >= 2;
    tokens.push({ ...base, token_risk: { available: true, high_risk: high, read: { ...t, concentration: { ...t.concentration, top_accounts: (t.concentration.top_accounts || []).slice(0, 3) } } } });
    if (high) warn(`risk:${mint}`, W.warning('high_risk_token', 'high', `Token ${t.symbol || mint} (${mint}) is involved, and its token-risk read is high-risk: ${flags.map((x) => String(x).split(':')[0]).join(', ')}.`, { token: mint, symbol: t.symbol || null, risk_flags: flags }));
  }

  // ---- balance changes, new and closed accounts (state before and after)
  const balanceChanges = []; const newAccounts = []; const closedAccounts = [];
  if (f.post) {
    for (const k of keys) {
      if (!k.writable || !f.post.has(k.address) || !f.pre.has(k.address)) continue;
      const a = k.address; const b = pre(a); const p = post(a);
      const bl = b ? b.lamports : 0n; const pl = p ? p.lamports : 0n;
      if (bl !== pl) balanceChanges.push({ account: a, asset: 'SOL', symbol: 'SOL', name: 'Solana', decimals: LAMPORTS_DECIMALS, before: bl.toString(), after: pl.toString(), delta: (pl - bl).toString(), before_ui: W.fmtUnits(bl, LAMPORTS_DECIMALS), after_ui: W.fmtUnits(pl, LAMPORTS_DECIMALS), delta_ui: W.fmtUnits(pl - bl, LAMPORTS_DECIMALS), is_signer: signers.has(a), ...(a === feePayer ? { includes_fee: true } : {}) });
      const bt = b && b.token ? b.token : null; const pt = p && p.token ? p.token : null;
      if (bt || pt) {
        const t = pt || bt; const ba = bt ? bt.amount : 0n; const pa = pt ? pt.amount : 0n;
        if (ba !== pa) {
          const known = Kn.solMint(t.mint); const r = f.risk.get(t.mint);
          balanceChanges.push({ account: t.owner, owner: t.owner, token_account: a, asset: t.mint, symbol: known ? known.symbol : (r && r.read ? r.read.symbol : null), name: known ? known.name : (r && r.read ? r.read.name : null), decimals: t.decimals, before: ba.toString(), after: pa.toString(), delta: (pa - ba).toString(), before_ui: W.fmtUnits(ba, t.decimals), after_ui: W.fmtUnits(pa, t.decimals), delta_ui: W.fmtUnits(pa - ba, t.decimals), is_signer: signers.has(t.owner) });
        }
      }
      if (b === null && p) newAccounts.push({ address: a, kind: kindOf(p), program_owner: p.owner, lamports: p.lamports.toString(), space: p.space, ...(p.token ? { token_owner: p.token.owner, mint: p.token.mint } : {}), ...(selfNew.has(a) ? { for_signer: true } : {}) });
      if (b && p === null) closedAccounts.push({ address: a, kind: kindOf(b), lamports_returned: b.lamports.toString(), ...(b.token ? { token_owner: b.token.owner, mint: b.token.mint } : {}) });
    }
    balanceChanges.sort((x, y) => Number(y.is_signer) - Number(x.is_signer));
  }
  const cut = balanceChanges.length > L.MAX_BALANCE_CHANGES;

  const lg = trimLogs(f.sim.logs);
  const sorted = W.sortWarnings(warnings);
  const high = sorted.length ? sorted[0].severity : null;
  return {
    chain: 'solana',
    request: { transaction_version: f.d.version === 'legacy' ? 'legacy' : String(f.d.version), size_bytes: f.d.sizeBytes, fee_payer: feePayer, signers: [...signers], signatures_in_transaction: f.d.signatureCount, instruction_count: f.instructions.length, account_count: keys.length, lookup_tables: f.d.lookups.map((l) => l.table) },
    simulation: { ok: !!f.sim.ok, error: errorSummary(f.sim.err), error_raw: f.sim.err ?? null, method: 'simulateTransaction (sigVerify false, replaceRecentBlockhash true, accounts returned for every writable account, innerInstructions true)', units_consumed: f.sim.unitsConsumed ?? null, fee_lamports: f.sim.fee ?? null, slot: f.sim.slot ?? null, logs: lg.logs, logs_truncated: lg.truncated },
    balance_changes: balanceChanges.slice(0, L.MAX_BALANCE_CHANGES),
    ...(cut ? { balance_changes_truncated: true } : {}),
    ...(!f.post ? { balance_changes_note: 'the simulation did not succeed, so there is no state after the transaction to compare with; warnings below come from the instructions and the state before' } : {}),
    programs,
    approvals: [],
    delegations,
    new_accounts: newAccounts,
    closed_accounts: closedAccounts,
    tokens,
    warnings: sorted,
    summary: { warning_count: sorted.length, highest_severity: high, note: sorted.length ? 'each warning states a fact about the simulated transaction' : 'no warning rule matched this transaction; that is not a statement that it is safe' },
    as_of: { simulation_slot: f.sim.slot ?? null, state_before_slot: f.preSlot ?? null, at: f.at },
  };
}

module.exports = { assessSolana, needsPre, involvedMints, view, errorSummary };
