// R23 T3 (4 Nov 2026): the x402-test wallet's key files cannot be committed by accident.
// (a) the repository's .gitignore ignores x402-test-wallet/base.key and x402-test-wallet/solana.json;
// (b) ops/r23-x402-wallet-gen.mjs refuses, and writes nothing, when the target directory is inside a git work tree that does not ignore those two paths;
// (c) outside any work tree it still writes both files, directory 700, files 600.
// Only fresh random keys in temp directories are used, the keys are never printed or logged, and every temp directory is deleted.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GEN = path.join(ROOT, 'ops', 'r23-x402-wallet-gen.mjs');
const tmpDirs = [];
const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'x402gi-')); tmpDirs.push(d); return d; };
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const mode = (p) => fs.statSync(p).mode & 0o777;
const gen = (dir) => spawnSync(process.execPath, [GEN], { env: { PATH: process.env.PATH, HOME: os.tmpdir(), X402TEST_WALLET_DIR: dir }, encoding: 'utf8', cwd: ROOT });
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, HOME: os.tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
// a repository with no .gitignore line for the wallet, deep enough to prove the walk up to the work tree
const mkRepo = (gitignore) => {
  const root = path.join(mkTmp(), 'repo');
  fs.mkdirSync(root, { recursive: true });
  assert.equal(git(root, 'init', '-q').status, 0, 'git init');
  if (gitignore !== undefined) fs.writeFileSync(path.join(root, '.gitignore'), gitignore);
  return root;
};

test('(a) the repository .gitignore ignores the wallet directory wherever it sits', () => {
  const rel = ['x402-test-wallet/base.key', 'x402-test-wallet/solana.json', 'x402-test-wallet/', 'opt/agentfeed/x402-test-wallet/base.key', 'opt/agentfeed/x402-test-wallet/solana.json'];
  for (const p of rel) {
    const r = git(ROOT, 'check-ignore', '-q', '--no-index', '--', p);
    assert.equal(r.status, 0, `${p} is ignored by .gitignore (git check-ignore said ${r.status}: ${r.stderr})`);
  }
  // negative control: a path the file must NOT ignore, so the check above is not vacuous
  assert.equal(git(ROOT, 'check-ignore', '-q', '--no-index', '--', 'tools/r23/x402/wallet.js').status, 1, 'a tracked source file is not ignored');
  // the line is in the committed file, not only in .git/info/exclude or a global config
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^x402-test-wallet\/$/m);
});

test('(b) inside a git work tree whose .gitignore lacks the line the generator refuses, exits non-zero and writes nothing', () => {
  const root = mkRepo('*.log\n');
  const dir = path.join(root, 'deep', 'x402-test-wallet');       // the directory does not exist yet: the check has to walk up to find one that does
  const r = gen(dir);
  assert.notEqual(r.status, 0, 'refused');
  assert.equal(r.stdout, '', 'nothing on stdout');
  assert.match(r.stderr, /refusing to run/);
  assert.match(r.stderr, /inside a git work tree/);
  assert.match(r.stderr, /solana\.json/, 'the file that would not be ignored is named');
  assert.match(r.stderr, /Nothing was written or changed/);
  assert.match(r.stderr, /x402-test-wallet\//, 'the message says what to add to .gitignore');
  assert.equal(fs.existsSync(dir), false, 'not even the directory was created');
  assert.deepEqual(fs.readdirSync(root).sort(), ['.git', '.gitignore'], 'nothing was added to the repository');
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all').stdout, '?? .gitignore\n', 'git sees no new file but the .gitignore of this temp repo');

  // a .gitignore that covers only base.key (via *.key, as the real repository did before this change) is still a refusal, and solana.json is the reason
  const half = mkRepo('*.key\n');
  const r2 = gen(path.join(half, 'x402-test-wallet'));
  assert.notEqual(r2.status, 0); assert.equal(r2.stdout, '');
  assert.match(r2.stderr, /solana\.json would not be ignored/); assert.ok(!/base\.key would not be ignored/.test(r2.stderr), 'base.key is ignored by *.key, so it is not named');
  assert.equal(fs.existsSync(path.join(half, 'x402-test-wallet')), false);

  // a repository with no .gitignore at all: refused, and both files are named
  const bare = mkRepo();
  const r3 = gen(path.join(bare, 'w'));
  assert.notEqual(r3.status, 0); assert.match(r3.stderr, /base\.key and solana\.json would not be ignored/);
  assert.deepEqual(fs.readdirSync(bare), ['.git']);

  // positive control: the SAME repository with the line added writes the wallet, which proves the refusals above came from the ignore rules and not from "inside a repository" alone
  fs.writeFileSync(path.join(root, '.gitignore'), '*.log\nx402-test-wallet/\n');
  const ok = gen(dir);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['base.key', 'solana.json']);
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all').stdout, '?? .gitignore\n', 'and git still sees no key file');
  for (const f of ['base.key', 'solana.json']) assert.equal(git(root, 'check-ignore', '-q', '--', path.join(dir, f)).status, 0, `${f} is ignored`);
  assert.ok(!/[0-9a-fA-F]{64}/.test(ok.stdout + ok.stderr), 'no 64-hex run in the output'); // the key file holds one, so a leak would match
  assert.match(fs.readFileSync(path.join(dir, 'base.key'), 'utf8'), /^0x[0-9a-f]{64}\n$/, 'the regex above matches a known positive');
});

test('(c) outside any git work tree the generator behaves as before: both files written, directory 700, files 600', () => {
  const outside = mkTmp();
  assert.equal(git(outside, 'rev-parse', '--is-inside-work-tree').status !== 0, true, `${outside} must not be inside a work tree for this test to mean anything`);
  const dir = path.join(outside, 'x402-test-wallet');
  const r = gen(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['base.key', 'solana.json']);
  assert.equal(mode(dir).toString(8), '700');
  assert.equal(mode(path.join(dir, 'base.key')).toString(8), '600');
  assert.equal(mode(path.join(dir, 'solana.json')).toString(8), '600');
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 4, 'the header, the two addresses and the committable JSON');
  assert.match(lines[0], /^x402-test wallet created in /);
  assert.match(lines[1], /^ {2}base {3}0x[0-9a-fA-F]{40}$/);
  assert.match(lines[3], /^tools\/r23\/x402\/test-wallet\.json: \{"base":"0x[0-9a-fA-F]{40}","solana":"[1-9A-HJ-NP-Za-km-z]{32,44}"\}$/);
  // the existing refusal still works out here, and still exits 2
  const again = gen(dir);
  assert.equal(again.status, 2); assert.equal(again.stdout, ''); assert.match(again.stderr, /already exist/);
  // no key material in any output of either run
  const out = r.stdout + r.stderr + again.stdout + again.stderr;
  const hex = fs.readFileSync(path.join(dir, 'base.key'), 'utf8').trim();
  const arr = JSON.parse(fs.readFileSync(path.join(dir, 'solana.json'), 'utf8'));
  for (const [what, needle] of [['base hex', hex.slice(2)], ['solana bytes', JSON.stringify(arr)], ['solana seed hex', Buffer.from(arr.slice(0, 32)).toString('hex')]]) {
    assert.ok(`x${needle}x`.includes(needle), `${what}: the search matches a known positive`);
    assert.ok(!out.toLowerCase().includes(needle.toLowerCase()), `${what} is not in any output`);
  }
});
