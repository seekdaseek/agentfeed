// ops/r24-txprecheck-mutate.mjs: the NEGATIVE CONTROLS of GET /api/tx-precheck (R24 item 4). For each mutation it copies the module and its tests to a scratch tree, breaks ONE check in the copy
// (a text replacement that must match exactly once), runs the unit tests and requires them to FAIL; a baseline run with no mutation must pass first. The repository is never modified.
//   node ops/r24-txprecheck-mutate.mjs [scratch-dir]      (default /Volumes/D/r24/scratch/txprecheck/mut)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = process.argv[2] || '/Volumes/D/r24/scratch/txprecheck/mut';
const TESTS = ['test/r24-txprecheck-solana.test.js', 'test/r24-txprecheck-base.test.js', 'test/r24-txprecheck-entry.test.js', 'test/r24-txprecheck-nosend.test.js'];
const MOD = 'tools/r24/txprecheck';

// [id, file in the module, text that must appear exactly once, its replacement, what check this removes]
const M = [
  ['sol-fresh-sol', 'sol-assess.js', "if (op.lamports > 0n && absent(op.to) && !selfNew.has(op.to)) {", "if (false) {", 'a SOL transfer to an account that does not exist is no longer flagged'],
  ['sol-fresh-token', 'sol-assess.js', "if (op.amount > 0n && absent(op.destination) && !selfNew.has(op.destination)) {", "if (false) {", 'a token transfer to a token account that does not exist is no longer flagged'],
  ['sol-self-new', 'sol-assess.js', "for (const [a, w] of ataOwner) if (signers.has(w)) selfNew.add(a);", "", 'accounts created for the signer are no longer recognised as its own (a wrap and a new account for oneself are flagged)'],
  ['sol-close', 'sol-assess.js', "if (!owner || op.destination === owner) continue;", "continue;", 'close-account to a stranger is no longer flagged'],
  ['sol-delegate', 'sol-assess.js', "warn(`del:${d.token_account}:${d.delegate}`,", "void (`del:${d.token_account}:${d.delegate}`,", 'a delegate grant is no longer flagged'],
  ['sol-unlimited-threshold', 'warn.js', "const UNLIMITED_U64 = 1n << 63n;", "const UNLIMITED_U64 = 1n << 65n;", 'the unlimited line for a delegated amount moves out of range'],
  ['sol-unknown-program', 'sol-assess.js', "for (const p of invoked) if (!Kn.solProgram(p.id)) warn(", "for (const p of invoked) if (false) warn(", 'an unknown program is no longer flagged'],
  ['sol-high-risk', 'sol-assess.js', "const high = flags.length >= 2;", "const high = flags.length >= 99;", 'a high-risk token read no longer raises the warning'],
  ['sol-authority-token', 'sol-assess.js', "warn(`auth:${op.authorityType}:${op.account}`,", "void (`auth:${op.authorityType}:${op.account}`,", 'SetAuthority is no longer flagged'],
  ['sol-authority-state', 'sol-assess.js', "if (after.token && before.token && after.token.owner !== before.token.owner) warn(", "if (false) warn(", 'an owner change seen only in the state is no longer flagged'],
  ['sol-delegate-state', 'sol-assess.js', "if (!grew || delegKey.has(`${a}:${after.token.delegate}`) || after.token.delegate === after.token.owner) continue;", "continue;", 'a delegate seen only in the state is no longer found'],
  ['sol-outflow-line', 'warn.js', "const OUTFLOW_FRACTION_BPS = 9000n;", "const OUTFLOW_FRACTION_BPS = 9900n;", 'the 90 percent line moves to 99 percent'],
  ['sol-outflow-internal', 'sol-assess.js', "const internal = srcOwner && dstOwner && srcOwner === dstOwner;", "const internal = false;", 'a move between two accounts of the same owner counts as an outflow'],
  ['sol-known-skip', 'sol-assess.js', "if (known) { tokens.push({ ...base, token_risk: { skipped:", "if (false) { tokens.push({ ...base, token_risk: { skipped:", 'a well-known token is no longer exempt from the high-risk rule'],
  ['sol-sim-failure-is-503', 'solana.js', "const ok = value.err == null;", "const ok = value.err == null; if (!ok) throw unavailable('x');", 'a transaction that fails in the simulation becomes an error instead of an answer'],
  ['sol-timeout', 'solana.js', "const simMs = deps.simTimeoutMs || L.SIM_TIMEOUT_MS;", "const simMs = 3000;", 'the simulation time cap no longer applies'],
  ['sol-sigverify', 'solana.js', "sigVerify: false,", "sigVerify: true,", 'the simulation verifies signatures (an unsigned transaction could not run)'],
  ['sol-cap-b64', 'limits.js', "MAX_SOL_TX_B64: 1644,", "MAX_SOL_TX_B64: 1700,", 'the base64 cap moves'],
  ['sol-cap-bytes', 'limits.js', "MAX_SOL_TX_BYTES: 1232,", "MAX_SOL_TX_BYTES: 1300,", 'the byte cap moves'],
  ['evm-cap-data', 'limits.js', "MAX_EVM_DATA_HEX: 20000,", "MAX_EVM_DATA_HEX: 30000,", 'the calldata cap moves'],
  ['evm-unlimited', 'warn.js', "const UNLIMITED_EVM = (1n << 96n) - 1n;", "const UNLIMITED_EVM = (1n << 255n);", 'the unlimited line for an allowance moves out of range of a uint160 maximum'],
  ['evm-fresh-nonce', 'evm-assess.js', "f.code.get(a) === false && f.nonce.get(a) === 0 && f.pre.get(ethKey(a)) === 0n", "f.code.get(a) === false && f.pre.get(ethKey(a)) === 0n", 'the nonce is no longer part of "never used"'],
  ['evm-fresh-balance', 'evm-assess.js', "f.code.get(a) === false && f.nonce.get(a) === 0 && f.pre.get(ethKey(a)) === 0n", "f.code.get(a) === false && f.nonce.get(a) === 0", 'the balance is no longer part of "never used"'],
  ['evm-fresh-code', 'evm-assess.js', "f.code.get(a) === false && f.nonce.get(a) === 0 && f.pre.get(ethKey(a)) === 0n", "f.nonce.get(a) === 0 && f.pre.get(ethKey(a)) === 0n", 'the code check is no longer part of "never used"'],
  ['evm-unknown-spender', 'evm-assess.js', "if (!a.spender_known) warn(", "if (false) warn(", 'an allowance to an unknown spender is no longer flagged'],
  ['evm-unknown-program', 'evm-assess.js', "if (f.code.get(target) === true && !Kn.baseContract(target)) warn(", "if (false) warn(", 'a call to an unknown contract is no longer flagged'],
  ['evm-high-risk', 'evm-assess.js', "const HIGH_VERDICTS = new Set(['not_sellable', 'extreme_tax', 'high_tax']);", "const HIGH_VERDICTS = new Set(['extreme_tax', 'high_tax']);", 'not_sellable is no longer a high-risk verdict'],
  ['evm-by-sender', 'evm-assess.js', "if (!a.by_sender || a.amount === '0') continue;", "if (a.amount === '0') continue;", 'an approval made by a contract other than the sender is flagged as the sender\'s'],
  ['evm-operator-for-all', 'evm-assess.js', "if (bySender && a.approved) warn(", "if (false) warn(", 'setApprovalForAll is no longer flagged'],
  ['evm-authority', 'evm-assess.js', "for (const o of ev.ownership) if (o.previous === sender) warn(", "for (const o of ev.ownership) if (false) warn(", 'an ownership change is no longer flagged'],
  ['evm-outflow-eth', 'evm-assess.js', "if (ethPre != null && ethOut > 0n && ethPre >= W.ETH_OUTFLOW_FLOOR_WEI && W.isLargeShare(ethOut, ethPre)) {", "if (false) {", 'an ETH outflow is no longer flagged'],
  ['evm-pinned-block', 'evm.js', "const at = hex(block.number);", "const at = 'latest';", 'the reads are no longer pinned to one block'],
  ['evm-timeout', 'evm.js', "const simMs = deps.simTimeoutMs || L.SIM_TIMEOUT_MS;", "const simMs = 3000;", 'the simulation time cap no longer applies'],
  ['evm-revert-is-503', 'evm.js', "const c = callOf(s1, 0, 1); const ok = c.status === '0x1';", "const c = callOf(s1, 0, 1); const ok = c.status === '0x1'; if (!ok) throw unavailable('x');", 'a reverting call becomes an error instead of an answer'],
  ['evm-recipient-eth', 'evm-assess.js', "  for (const r of recipients) eth.add(r);", "", 'a recipient\'s ETH balance is not read (found by the first run of the tests)'],
  ['evm-trace-transfers', 'evm.js', "traceTransfers: true, validation: false", "traceTransfers: false, validation: false", 'ETH transfers are no longer returned as logs'],
  ['nosend-planted', 'index.js', "const { precheckBase } = require('./evm');", "const { precheckBase } = require('./evm'); const unused = (tx) => rpc.sendTransaction(tx);", 'a send call is planted in the module (the scan must catch it)'],
];

const cp = (from, to) => fs.cpSync(from, to, { recursive: true });
function tree(name, mutation) {
  const dir = path.join(SCRATCH, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'tools', 'r24'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  for (const d of ['lib', 'contracts', 'data']) if (fs.existsSync(path.join(ROOT, d))) fs.symlinkSync(path.join(ROOT, d), path.join(dir, d));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  for (const f of fs.readdirSync(path.join(ROOT, 'tools'))) if (f !== 'r24') fs.symlinkSync(path.join(ROOT, 'tools', f), path.join(dir, 'tools', f));
  cp(path.join(ROOT, MOD), path.join(dir, MOD));
  cp(path.join(ROOT, 'test', 'fixtures', 'r24'), path.join(dir, 'test', 'fixtures', 'r24'));
  for (const t of TESTS) fs.copyFileSync(path.join(ROOT, t), path.join(dir, t));
  if (mutation) {
    const [, file, find, repl] = mutation;
    const p = path.join(dir, MOD, file);
    const src = fs.readFileSync(p, 'utf8');
    const n = src.split(find).length - 1;
    if (n !== 1) throw new Error(`mutation ${mutation[0]}: the text must appear exactly once in ${file}, found ${n}`);
    fs.writeFileSync(p, src.replace(find, () => repl));
  }
  return dir;
}
function runTests(dir) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...TESTS], { cwd: dir, encoding: 'utf8', timeout: 120000, env: { PATH: process.env.PATH, AGENTFEED_DB: ':memory:' } });
  const out = `${r.stdout}\n${r.stderr}`;
  const failing = [...new Set([...out.matchAll(/^✖ (.+?) \(\d+(?:\.\d+)?ms\)$/gm)].map((m) => m[1]))].filter((n) => !/^failing tests/.test(n));
  const pass = /ℹ pass (\d+)/.exec(out); const fail = /ℹ fail (\d+)/.exec(out);
  return { status: r.status, pass: pass ? Number(pass[1]) : null, fail: fail ? Number(fail[1]) : null, failing };
}

fs.mkdirSync(SCRATCH, { recursive: true });
const base = runTests(tree('baseline', null));
console.log(`baseline (no mutation): exit ${base.status}, pass ${base.pass}, fail ${base.fail}`);
if (base.status !== 0 || base.fail !== 0) { console.log('the baseline must pass; stopping'); process.exit(2); }
let survived = 0;
for (const m of M) {
  const r = runTests(tree(m[0], m));
  const killed = r.status !== 0 && r.fail > 0;
  if (!killed) survived++;
  console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${m[0].padEnd(24)} ${m[4]}${killed ? `  [${r.fail} failing: ${r.failing.slice(0, 2).map((x) => x.slice(0, 60)).join(' | ')}]` : ''}`);
}
console.log(`${M.length} mutations, ${M.length - survived} killed, ${survived} survived`);
process.exit(survived ? 1 : 0);
